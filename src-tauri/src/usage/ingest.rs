use rusqlite::{params, Connection};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::helpers::{as_u64, home_join, now_epoch_seconds, walk_files};

/// Maximum files to process per ingest cycle. Keep small so the DB lock is
/// released frequently and UI queries aren't starved during heavy ingestion.
const MAX_FILES_PER_CYCLE: usize = 10;

/// Run incremental ingestion for all providers.
/// Returns true if all providers are fully caught up (no remaining work).
pub fn ingest_all(conn: &Connection) -> bool {
    let mut all_done = true;

    match ingest_claude(conn, MAX_FILES_PER_CYCLE) {
        Ok(done) => { if !done { all_done = false; } }
        Err(e) => eprintln!("Claude ingest error: {e}"),
    }
    match ingest_gemini(conn, MAX_FILES_PER_CYCLE) {
        Ok(done) => { if !done { all_done = false; } }
        Err(e) => eprintln!("Gemini ingest error: {e}"),
    }
    match ingest_codex(conn, MAX_FILES_PER_CYCLE) {
        Ok(done) => { if !done { all_done = false; } }
        Err(e) => eprintln!("Codex ingest error: {e}"),
    }
    match ingest_opencode(conn, MAX_FILES_PER_CYCLE) {
        Ok(done) => { if !done { all_done = false; } }
        Err(e) => eprintln!("OpenCode ingest error: {e}"),
    }
    if let Err(e) = prune_old_messages(conn) {
        eprintln!("Prune error: {e}");
    }

    all_done
}

// ── Claude ────────────────────────────────────────────────

/// Returns Ok(true) if fully caught up, Ok(false) if more files remain.
fn ingest_claude(conn: &Connection, budget: usize) -> Result<bool, String> {
    let projects_dir = home_join(".claude/projects")?;
    if !projects_dir.exists() {
        return Ok(true);
    }

    let files = walk_files(&projects_dir);
    let jsonl_files: Vec<_> = files
        .into_iter()
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect();

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let mut processed = 0;
    let mut skipped_remaining = false;

    for path in &jsonl_files {
        if processed >= budget {
            skipped_remaining = true;
            break;
        }
        // Check if file actually needs work before counting against budget
        let path_str = path.to_string_lossy().to_string();
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let file_size = meta.len() as i64;
        let mtime = file_mtime(&meta);
        let cursor = get_cursor(conn, &path_str);
        let needs_work = match &cursor {
            Some((size, _, mt)) => *size != file_size || *mt != mtime,
            None => true,
        };
        if !needs_work {
            continue;
        }

        processed += 1;
        if let Err(e) = ingest_claude_file(conn, path) {
            eprintln!("Claude ingest error for {}: {e}", path.display());
        }
    }

    // Only clean cursors when fully caught up
    if !skipped_remaining {
        clean_cursors(conn, "claude", &jsonl_files);
    }

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(!skipped_remaining)
}

fn ingest_claude_file(conn: &Connection, path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy().to_string();
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let file_size = meta.len() as i64;
    let mtime = file_mtime(&meta);

    // Check cursor
    let cursor = get_cursor(conn, &path_str);
    let offset = match &cursor {
        Some((size, off, mt)) => {
            if *size == file_size && *mt == mtime {
                return Ok(()); // No change
            }
            *off
        }
        None => 0,
    };

    let project_name = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
    let session_id = path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();

    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    reader.seek(SeekFrom::Start(offset as u64)).map_err(|e| e.to_string())?;

    let mut new_offset = offset;
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if bytes_read == 0 {
            break;
        }
        new_offset += bytes_read as i64;

        let row: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let usage = match row.get("message").and_then(|m| m.get("usage")) {
            Some(v) if v.is_object() => v,
            _ => continue,
        };

        let input = as_u64(usage.get("input_tokens"));
        let output = as_u64(usage.get("output_tokens"));
        let cache_write = as_u64(usage.get("cache_creation_input_tokens"));
        let cache_read = as_u64(usage.get("cache_read_input_tokens"));
        let total = input + output + cache_write + cache_read;

        let model = row
            .get("message")
            .and_then(|m| m.get("model"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");

        let ts = row
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_timestamp)
            .unwrap_or(0);

        conn.execute(
            "INSERT INTO usage_messages (provider, session_id, project, model, timestamp, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, tokens_thoughts, tokens_total)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)",
            params![
                "claude", session_id, project_name, model, ts as i64,
                input as i64, output as i64, cache_write as i64, cache_read as i64, total as i64
            ],
        ).map_err(|e| e.to_string())?;
    }

    upsert_cursor(conn, &path_str, "claude", file_size, new_offset, mtime)?;
    Ok(())
}

// ── Gemini ────────────────────────────────────────────────

/// Returns Ok(true) if fully caught up, Ok(false) if more files remain.
fn ingest_gemini(conn: &Connection, budget: usize) -> Result<bool, String> {
    let tmp_dir = home_join(".gemini/tmp")?;
    if !tmp_dir.exists() {
        return Ok(true);
    }

    let files = walk_files(&tmp_dir);
    let json_files: Vec<_> = files
        .into_iter()
        .filter(|p| {
            p.extension().and_then(|e| e.to_str()) == Some("json")
                && p.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()) == Some("chats")
        })
        .collect();

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let mut processed = 0;
    let mut skipped_remaining = false;

    for path in &json_files {
        if processed >= budget {
            skipped_remaining = true;
            break;
        }
        let path_str = path.to_string_lossy().to_string();
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let file_size = meta.len() as i64;
        let mtime = file_mtime(&meta);
        let cursor = get_cursor(conn, &path_str);
        let needs_work = match &cursor {
            Some((size, _, mt)) => *size != file_size || *mt != mtime,
            None => true,
        };
        if !needs_work {
            continue;
        }

        processed += 1;
        if let Err(e) = ingest_gemini_file(conn, path) {
            eprintln!("Gemini ingest error for {}: {e}", path.display());
        }
    }

    if !skipped_remaining {
        clean_cursors(conn, "gemini", &json_files);
    }

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(!skipped_remaining)
}

fn ingest_gemini_file(conn: &Connection, path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy().to_string();
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let file_size = meta.len() as i64;
    let mtime = file_mtime(&meta);

    let cursor = get_cursor(conn, &path_str);
    if let Some((size, _, mt)) = &cursor {
        if *size == file_size && *mt == mtime {
            return Ok(()); // No change
        }
    }

    let contents = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&contents).map_err(|e| e.to_string())?;

    let session_id = json
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let project = path
        .parent()
        .and_then(Path::parent)
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    // Delete old rows for this session and re-insert
    conn.execute(
        "DELETE FROM usage_messages WHERE provider = 'gemini' AND session_id = ?1",
        params![session_id],
    ).map_err(|e| e.to_string())?;

    let updated_at_str = json
        .get("lastUpdated")
        .and_then(Value::as_str)
        .or_else(|| json.get("startTime").and_then(Value::as_str));
    let session_ts = updated_at_str.and_then(parse_iso_timestamp).unwrap_or(0);

    let messages = json.get("messages").and_then(Value::as_array);
    if let Some(messages) = messages {
        for message in messages {
            let tokens = match message.get("tokens") {
                Some(v) if v.is_object() => v,
                _ => continue,
            };

            let input = as_u64(tokens.get("input"));
            let output = as_u64(tokens.get("output"));
            let cached = as_u64(tokens.get("cached"));
            let thoughts = as_u64(tokens.get("thoughts"));
            let total = as_u64(tokens.get("total"));

            let model = message
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("unknown");

            conn.execute(
                "INSERT INTO usage_messages (provider, session_id, project, model, timestamp, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, tokens_thoughts, tokens_total)
                 VALUES ('gemini', ?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)",
                params![
                    session_id, project, model, session_ts as i64,
                    input as i64, output as i64, cached as i64, thoughts as i64, total as i64
                ],
            ).map_err(|e| e.to_string())?;
        }
    }

    upsert_cursor(conn, &path_str, "gemini", file_size, file_size, mtime)?;
    Ok(())
}

// ── Codex ─────────────────────────────────────────────────

/// Returns Ok(true) if fully caught up, Ok(false) if more files remain.
fn ingest_codex(conn: &Connection, budget: usize) -> Result<bool, String> {
    let sessions_dir = home_join(".codex/sessions")?;
    if !sessions_dir.exists() {
        return Ok(true);
    }

    let files = walk_files(&sessions_dir);
    let jsonl_files: Vec<_> = files
        .into_iter()
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect();

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let mut processed = 0;
    let mut skipped_remaining = false;

    for path in &jsonl_files {
        if processed >= budget {
            skipped_remaining = true;
            break;
        }
        let path_str = path.to_string_lossy().to_string();
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let file_size = meta.len() as i64;
        let mtime = file_mtime(&meta);
        let cursor = get_cursor(conn, &path_str);
        let needs_work = match &cursor {
            Some((size, _, mt)) => *size != file_size || *mt != mtime,
            None => true,
        };
        if !needs_work {
            continue;
        }

        processed += 1;
        if let Err(e) = ingest_codex_file(conn, path) {
            eprintln!("Codex ingest error for {}: {e}", path.display());
        }
    }

    if !skipped_remaining {
        clean_cursors(conn, "codex", &jsonl_files);
    }

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(!skipped_remaining)
}

fn ingest_codex_file(conn: &Connection, path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy().to_string();
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let file_size = meta.len() as i64;
    let mtime = file_mtime(&meta);

    let cursor = get_cursor(conn, &path_str);
    if let Some((size, _, mt)) = &cursor {
        if *size == file_size && *mt == mtime {
            return Ok(()); // No change
        }
    }

    let contents = fs::read_to_string(path).map_err(|e| e.to_string())?;

    // Extract session metadata and final token totals from JSONL events
    let mut session_id = String::new();
    let mut project = String::new();
    let mut model = "unknown".to_string();
    let mut timestamp: u64 = 0;
    let mut input: u64 = 0;
    let mut cached_input: u64 = 0;
    let mut output: u64 = 0;
    let mut reasoning: u64 = 0;
    let mut total: u64 = 0;
    let mut has_tokens = false;

    for line in contents.lines() {
        let row: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = row.get("type").and_then(Value::as_str).unwrap_or_default();

        match event_type {
            "session_meta" => {
                if let Some(payload) = row.get("payload") {
                    session_id = payload.get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    project = payload.get("cwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .split('/')
                        .rfind(|s| !s.is_empty())
                        .unwrap_or("unknown")
                        .to_string();
                }
                if let Some(ts_str) = row.get("timestamp").and_then(Value::as_str) {
                    timestamp = parse_iso_timestamp(ts_str).unwrap_or(0);
                }
            }
            "turn_context" => {
                if let Some(payload) = row.get("payload") {
                    if let Some(m) = payload.get("model").and_then(Value::as_str) {
                        model = m.to_string();
                    }
                }
            }
            "event_msg" => {
                let payload = match row.get("payload") {
                    Some(p) => p,
                    None => continue,
                };
                if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                    continue;
                }
                // Use total_token_usage (cumulative) — last one wins
                if let Some(info) = payload.get("info").and_then(|i| i.get("total_token_usage")) {
                    input = as_u64(info.get("input_tokens"));
                    cached_input = as_u64(info.get("cached_input_tokens"));
                    output = as_u64(info.get("output_tokens"));
                    reasoning = as_u64(info.get("reasoning_output_tokens"));
                    total = as_u64(info.get("total_tokens"));
                    has_tokens = true;
                }
            }
            _ => {}
        }
    }

    if !has_tokens || session_id.is_empty() {
        upsert_cursor(conn, &path_str, "codex", file_size, file_size, mtime)?;
        return Ok(());
    }

    // Non-cached input = total input minus cached portion
    let non_cached_input = input.saturating_sub(cached_input);

    // Delete old rows for this session and re-insert with full breakdown
    conn.execute(
        "DELETE FROM usage_messages WHERE provider = 'codex' AND session_id = ?1",
        params![session_id],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO usage_messages (provider, session_id, project, model, timestamp, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, tokens_thoughts, tokens_total)
         VALUES ('codex', ?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)",
        params![
            session_id, project, model, timestamp as i64,
            non_cached_input as i64, output as i64, cached_input as i64, reasoning as i64, total as i64
        ],
    ).map_err(|e| e.to_string())?;

    upsert_cursor(conn, &path_str, "codex", file_size, file_size, mtime)?;
    Ok(())
}

// ── OpenCode ───────────────────────────────────────────────

/// Ingests from OpenCode SQLite database. Returns Ok(true) when complete.
fn ingest_opencode(conn: &Connection, _budget: usize) -> Result<bool, String> {
    ingest_opencode_db(conn)?;
    Ok(true)
}

/// Ingest messages from OpenCode SQLite database (current sessions)
fn ingest_opencode_db(conn: &Connection) -> Result<(), String> {
    let db_path = home_join(".local/share/opencode/opencode.db")?;
    if !db_path.exists() {
        return Ok(());
    }

    // Open OpenCode database in read-only mode
    let opencode_conn =
        Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Failed to open OpenCode database: {e}"))?;

    // Get the max message ID we've already ingested
    let last_id: String = conn
        .query_row(
            "SELECT COALESCE(MAX(session_id), '') FROM usage_messages WHERE provider = 'opencode' AND session_id LIKE 'msg_%'",
            [],
            |row| row.get(0),
        )
        .unwrap_or_default();

    // Query messages with tokens from OpenCode database
    let mut query = opencode_conn
        .prepare(
            "SELECT id, json_extract(data, '$.modelID'),
                    json_extract(data, '$.tokens.input'),
                    json_extract(data, '$.tokens.output'),
                    json_extract(data, '$.tokens.reasoning'),
                    json_extract(data, '$.tokens.cache.read'),
                    json_extract(data, '$.tokens.cache.write'),
                    json_extract(data, '$.time.created'),
                    json_extract(data, '$.path.cwd'),
                    json_extract(data, '$.path.root'),
                    json_extract(data, '$.cost')
             FROM message
             WHERE data LIKE '%\"tokens\":{%'
               AND (? = '' OR id > ?)
              ORDER BY id ASC",
        )
        .map_err(|e| format!("Failed to prepare query: {e}"))?;

    let rows = query
        .query_map(params![last_id, last_id], |row| {
            Ok((
                row.get::<_, String>(0)?,         // id
                row.get::<_, Option<String>>(1)?, // modelID
                row.get::<_, Option<i64>>(2)?,    // input
                row.get::<_, Option<i64>>(3)?,    // output
                row.get::<_, Option<i64>>(4)?,    // reasoning
                row.get::<_, Option<i64>>(5)?,    // cache_read
                row.get::<_, Option<i64>>(6)?,    // cache_write
                row.get::<_, Option<i64>>(7)?,    // time_created
                row.get::<_, Option<String>>(8)?, // cwd
                row.get::<_, Option<String>>(9)?, // root
                row.get::<_, Option<f64>>(10)?,   // cost
            ))
        })
        .map_err(|e| format!("Failed to query messages: {e}"))?;

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    for row in rows {
        let row = row.map_err(|e| format!("Row error: {e}"))?;
        let (id, model, input, output, reasoning, cache_read, cache_write, time_created, cwd, root, cost) =
            row;

        // Skip if no tokens
        let input = input.unwrap_or(0);
        let output = output.unwrap_or(0);
        let reasoning = reasoning.unwrap_or(0);
        let cache_read = cache_read.unwrap_or(0);
        let cache_write = cache_write.unwrap_or(0);
        let total = input + output + reasoning + cache_read + cache_write;

        if total == 0 {
            continue;
        }

        // Extract project name from path
        let project = cwd
            .or(root)
            .and_then(|p| p.split('/').rfind(|s| !s.is_empty()).map(|s| s.to_string()))
            .unwrap_or_else(|| "unknown".to_string());

        let model = model.unwrap_or_else(|| "unknown".to_string());
        let timestamp = time_created.map(|ms| ms / 1000).unwrap_or(0);

        // Delete old rows for this message and re-insert
        conn.execute(
            "DELETE FROM usage_messages WHERE provider = 'opencode' AND session_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO usage_messages (provider, session_id, project, model, timestamp, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, tokens_thoughts, tokens_total, cost)
             VALUES ('opencode', ?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10)",
            params![
                id, project, model, timestamp as i64,
                input as i64, output as i64, cache_read as i64, reasoning as i64, total as i64, cost
            ],
        ).map_err(|e| e.to_string())?;
    }

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(())
}

// ── Maintenance ───────────────────────────────────────────

fn prune_old_messages(conn: &Connection) -> Result<(), String> {
    let cutoff = now_epoch_seconds() as i64 - 2_592_000; // 30 days

    // Roll up old messages into daily aggregates
    conn.execute(
        "INSERT OR REPLACE INTO usage_daily (provider, date, model, project, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, tokens_thoughts, tokens_total, message_count)
         SELECT provider, date(timestamp, 'unixepoch') as d, model, project,
                SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_write), SUM(tokens_cache_read), SUM(tokens_thoughts), SUM(tokens_total), COUNT(*)
         FROM usage_messages
         WHERE timestamp < ?1
         GROUP BY provider, d, model, project",
        params![cutoff],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM usage_messages WHERE timestamp < ?1",
        params![cutoff],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

// ── Cursor helpers ────────────────────────────────────────

fn get_cursor(conn: &Connection, file_path: &str) -> Option<(i64, i64, i64)> {
    conn.query_row(
        "SELECT file_size, byte_offset, last_modified FROM ingest_cursors WHERE file_path = ?1",
        params![file_path],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).ok()
}

fn upsert_cursor(conn: &Connection, file_path: &str, provider: &str, file_size: i64, offset: i64, mtime: i64) -> Result<(), String> {
    let now = now_epoch_seconds() as i64;
    conn.execute(
        "INSERT INTO ingest_cursors (file_path, provider, file_size, byte_offset, last_modified, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(file_path) DO UPDATE SET file_size=?3, byte_offset=?4, last_modified=?5, updated_at=?6",
        params![file_path, provider, file_size, offset, mtime, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn clean_cursors(conn: &Connection, provider: &str, valid_files: &[PathBuf]) {
    let mut stmt = match conn.prepare("SELECT file_path FROM ingest_cursors WHERE provider = ?1") {
        Ok(s) => s,
        Err(_) => return,
    };
    let paths: Vec<String> = match stmt.query_map(params![provider], |row| row.get(0)) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => return,
    };

    for path in paths {
        let still_exists = valid_files.iter().any(|f| f.to_string_lossy() == path);
        if !still_exists {
            let _ = conn.execute(
                "DELETE FROM ingest_cursors WHERE file_path = ?1",
                params![path],
            );
        }
    }
}

// ── Timestamp parsing ─────────────────────────────────────

fn parse_iso_timestamp(s: &str) -> Option<u64> {
    // Handle common ISO 8601 formats without shelling out to `date`
    // 2025-01-15T10:30:00Z
    // 2025-01-15T10:30:00.123Z
    // 2025-01-15T10:30:00+00:00
    let s = s.trim();

    // Parse the date/time components directly
    let clean = s.replace('Z', "").replace('T', " ");
    let clean = clean.split('+').next().unwrap_or(&clean);
    let clean = if clean.matches('-').count() > 2 {
        // Has timezone offset like -05:00
        let last_dash = clean.rfind('-')?;
        &clean[..last_dash]
    } else {
        clean
    };

    // Strip fractional seconds
    let clean = clean.split('.').next().unwrap_or(clean);

    let parts: Vec<&str> = clean.split(' ').collect();
    if parts.len() != 2 {
        return None;
    }

    let date_parts: Vec<u64> = parts[0].split('-').filter_map(|s| s.parse().ok()).collect();
    let time_parts: Vec<u64> = parts[1].split(':').filter_map(|s| s.parse().ok()).collect();

    if date_parts.len() != 3 || time_parts.len() < 2 {
        return None;
    }

    let (year, month, day) = (date_parts[0], date_parts[1], date_parts[2]);
    let (hour, minute) = (time_parts[0], time_parts[1]);
    let second = time_parts.get(2).copied().unwrap_or(0);

    // Simple epoch calculation (good enough for usage tracking, assumes UTC)
    let days = days_from_epoch(year, month, day)?;
    Some(days * 86400 + hour * 3600 + minute * 60 + second)
}

fn days_from_epoch(year: u64, month: u64, day: u64) -> Option<u64> {
    if year < 1970 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from 1970-01-01
    let mut y = year;
    let mut m = month as i64;
    if m <= 2 {
        y -= 1;
        m += 9;
    } else {
        m -= 3;
    }
    let era = y / 400;
    let yoe = y - era * 400;
    let doy = (153 * m as u64 + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days)
}

fn file_mtime(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
