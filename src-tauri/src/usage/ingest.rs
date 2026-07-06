use rusqlite::{params, Connection, OpenFlags};
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
        Ok(done) => {
            if !done {
                all_done = false;
            }
        }
        Err(e) => eprintln!("Claude ingest error: {e}"),
    }
    match ingest_gemini(conn, MAX_FILES_PER_CYCLE) {
        Ok(done) => {
            if !done {
                all_done = false;
            }
        }
        Err(e) => eprintln!("Gemini ingest error: {e}"),
    }
    match ingest_antigravity(conn, MAX_FILES_PER_CYCLE) {
        Ok(done) => {
            if !done {
                all_done = false;
            }
        }
        Err(e) => eprintln!("Antigravity ingest error: {e}"),
    }
    match ingest_codex(conn, MAX_FILES_PER_CYCLE) {
        Ok(done) => {
            if !done {
                all_done = false;
            }
        }
        Err(e) => eprintln!("Codex ingest error: {e}"),
    }
    match ingest_opencode(conn) {
        Ok(done) => {
            if !done {
                all_done = false;
            }
        }
        Err(e) => eprintln!("OpenCode ingest error: {e}"),
    }
    match ingest_pi(conn, MAX_FILES_PER_CYCLE) {
        Ok(done) => {
            if !done {
                all_done = false;
            }
        }
        Err(e) => eprintln!("pi ingest error: {e}"),
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
    reader
        .seek(SeekFrom::Start(offset as u64))
        .map_err(|e| e.to_string())?;

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
            "INSERT INTO usage_messages (provider, session_id, project, model, timestamp, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, tokens_thoughts, tokens_total, pricing_provider)
             VALUES ('claude', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, 'anthropic')",
            params![
                session_id, project_name, model, ts as i64,
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
                && p.parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    == Some("chats")
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
    )
    .map_err(|e| e.to_string())?;

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
                "INSERT INTO usage_messages (provider, session_id, project, model, timestamp, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, tokens_thoughts, tokens_total, pricing_provider)
                 VALUES ('gemini', ?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, 'google')",
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

// ── Antigravity ───────────────────────────────────────────

/// Returns Ok(true) if fully caught up, Ok(false) if more files remain.
fn ingest_antigravity(conn: &Connection, budget: usize) -> Result<bool, String> {
    let brain_dir = home_join(".gemini/antigravity-cli/brain")?;
    if !brain_dir.exists() {
        return Ok(true);
    }

    let mut by_session: std::collections::BTreeMap<String, PathBuf> = std::collections::BTreeMap::new();
    for path in walk_files(&brain_dir) {
        let file_name = path.file_name().and_then(|n| n.to_str());
        if file_name != Some("transcript_full.jsonl") && file_name != Some("transcript.jsonl") {
            continue;
        }
        let Some(session_id) = antigravity_session_id(&path) else {
            continue;
        };
        let is_full = file_name == Some("transcript_full.jsonl");
        let replace = by_session
            .get(&session_id)
            .map(|existing| {
                existing.file_name().and_then(|n| n.to_str()) != Some("transcript_full.jsonl") && is_full
            })
            .unwrap_or(true);
        if replace {
            by_session.insert(session_id, path);
        }
    }
    let transcript_files: Vec<_> = by_session.into_values().collect();

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let mut processed = 0;
    let mut skipped_remaining = false;
    let history = read_antigravity_history();

    for path in &transcript_files {
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
        if let Err(e) = ingest_antigravity_file(conn, path, &history) {
            eprintln!("Antigravity ingest error for {}: {e}", path.display());
        }
    }

    if !skipped_remaining {
        clean_cursors(conn, "antigravity", &transcript_files);
    }

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(!skipped_remaining)
}

fn ingest_antigravity_file(
    conn: &Connection,
    path: &Path,
    history: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let path_str = path.to_string_lossy().to_string();
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let file_size = meta.len() as i64;
    let mtime = file_mtime(&meta);

    if let Some((size, _, mt)) = get_cursor(conn, &path_str) {
        if size == file_size && mt == mtime {
            return Ok(());
        }
    }

    let session_id = antigravity_session_id(path).unwrap_or_else(|| {
        path.parent()
            .and_then(Path::parent)
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    });
    let project = history
        .get(&session_id)
        .map(|workspace| project_name_from_path(workspace))
        .unwrap_or_else(|| "unknown".to_string());

    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut input = 0_u64;
    let mut output = 0_u64;
    let mut model = "unknown".to_string();
    let mut timestamp = 0_u64;

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        let row: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if let Some(ts) = row
            .get("created_at")
            .and_then(Value::as_str)
            .and_then(parse_iso_timestamp)
        {
            timestamp = ts;
        }

        let source = row.get("source").and_then(Value::as_str).unwrap_or_default();
        let step_type = row.get("type").and_then(Value::as_str).unwrap_or_default();
        let content = row.get("content").and_then(Value::as_str).unwrap_or_default();

        if step_type == "USER_INPUT" || source == "USER_EXPLICIT" {
            input = input.saturating_add(estimate_text_tokens(content));
            if let Some(selected) = extract_antigravity_model_selection(content) {
                model = selected;
            }
        } else if source == "MODEL" && step_type == "PLANNER_RESPONSE" {
            output = output.saturating_add(estimate_text_tokens(content));
            if let Some(thinking) = row.get("thinking").and_then(Value::as_str) {
                output = output.saturating_add(estimate_text_tokens(thinking));
            }
            if let Some(tool_calls) = row.get("tool_calls") {
                output = output.saturating_add(estimate_text_tokens(&tool_calls.to_string()));
            }
        }
    }

    let total = input + output;
    if total == 0 {
        upsert_cursor(conn, &path_str, "antigravity", file_size, file_size, mtime)?;
        return Ok(());
    }
    let pricing_provider = antigravity_pricing_provider(&model);

    conn.execute(
        "DELETE FROM usage_messages WHERE provider = 'antigravity' AND session_id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO usage_messages (
            provider, session_id, project, model, timestamp,
            tokens_input, tokens_output, tokens_cache_write, tokens_cache_read,
            tokens_thoughts, tokens_total, pricing_provider
         ) VALUES (
            'antigravity', ?1, ?2, ?3, ?4,
            ?5, ?6, 0, 0,
            0, ?7, ?8
         )",
        params![
            session_id,
            project,
            model,
            timestamp as i64,
            input as i64,
            output as i64,
            total as i64,
            pricing_provider,
        ],
    )
    .map_err(|e| e.to_string())?;

    upsert_cursor(conn, &path_str, "antigravity", file_size, file_size, mtime)?;
    Ok(())
}

fn antigravity_pricing_provider(model: &str) -> &'static str {
    let lower = model.to_ascii_lowercase();
    if lower.contains("gemini") {
        "google"
    } else if lower.contains("claude") {
        "anthropic"
    } else {
        "antigravity"
    }
}

fn antigravity_session_id(path: &Path) -> Option<String> {
    path.parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(ToString::to_string)
}

fn read_antigravity_history() -> std::collections::HashMap<String, String> {
    let mut sessions = std::collections::HashMap::new();
    let Ok(path) = home_join(".gemini/antigravity-cli/history.jsonl") else {
        return sessions;
    };
    let Ok(file) = fs::File::open(path) else {
        return sessions;
    };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(session_id) = row.get("conversationId").and_then(Value::as_str) else {
            continue;
        };
        let Some(workspace) = row.get("workspace").and_then(Value::as_str) else {
            continue;
        };
        sessions.insert(session_id.to_string(), workspace.to_string());
    }
    sessions
}

fn extract_antigravity_model_selection(content: &str) -> Option<String> {
    let marker = "Model Selection` from ";
    let start = content.find(marker)?;
    let selected = &content[start + marker.len()..];
    let (_, after_to) = selected.split_once(" to ")?;
    let model = after_to
        .split(". No need")
        .next()
        .unwrap_or(after_to)
        .split('\n')
        .next()
        .unwrap_or(after_to)
        .trim()
        .trim_matches('`')
        .trim();
    if model.is_empty() || model == "None" {
        None
    } else {
        Some(model.to_string())
    }
}

fn estimate_text_tokens(text: &str) -> u64 {
    let chars = text.chars().count() as u64;
    if chars == 0 {
        0
    } else {
        (chars + 3) / 4
    }
}

fn project_name_from_path(path: &str) -> String {
    // Provider logs record native OS paths — backslash-separated on Windows.
    path.rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or("unknown")
        .to_string()
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
                    session_id = payload
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    project = project_name_from_path(
                        payload.get("cwd").and_then(Value::as_str).unwrap_or_default(),
                    );
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
                    if let Some(ts_str) = row.get("timestamp").and_then(Value::as_str) {
                        timestamp = parse_iso_timestamp(ts_str).unwrap_or(timestamp);
                    }
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
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO usage_messages (provider, session_id, project, model, timestamp, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, tokens_thoughts, tokens_total, pricing_provider)
         VALUES ('codex', ?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, 'openai')",
        params![
            session_id, project, model, timestamp as i64,
            non_cached_input as i64, output as i64, cached_input as i64, reasoning as i64, total as i64
        ],
    ).map_err(|e| e.to_string())?;

    upsert_cursor(conn, &path_str, "codex", file_size, file_size, mtime)?;
    Ok(())
}

// ── OpenCode ──────────────────────────────────────────────

fn ingest_opencode(conn: &Connection) -> Result<bool, String> {
    // OpenCode defaults to ~/.local/share/opencode on every platform, but
    // honors XDG_DATA_HOME, and Windows installs may use %LOCALAPPDATA%.
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            candidates.push(std::path::Path::new(&xdg).join("opencode/opencode.db"));
        }
    }
    candidates.push(home_join(".local/share/opencode/opencode.db")?);
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        candidates.push(local.join("opencode/opencode.db"));
    }

    let Some(db_path) = candidates.into_iter().find(|p| p.exists()) else {
        return Ok(true);
    };

    let cursor_key = "opencode:message-db";
    let meta = fs::metadata(&db_path).map_err(|e| e.to_string())?;
    let file_size = meta.len() as i64;
    let mtime = file_mtime(&meta);
    let cursor = get_cursor(conn, cursor_key);

    if let Some((size, _, last_mtime)) = cursor {
        if size == file_size && last_mtime == mtime {
            return Ok(true);
        }
    }

    let source = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open OpenCode DB: {e}"))?;

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let (last_size, last_rowid, _) = cursor.unwrap_or((0, 0, 0));
    let should_rebuild = last_rowid > 0 && file_size < last_size;

    if should_rebuild {
        conn.execute("DELETE FROM usage_messages WHERE provider = 'opencode'", [])
            .map_err(|e| e.to_string())?;
    }

    let mut stmt = source
        .prepare(
            "SELECT
            m.rowid,
            m.session_id,
            s.directory,
            m.time_created,
            m.data
         FROM message m
         JOIN session s ON s.id = m.session_id
         WHERE json_extract(m.data, '$.role') = 'assistant'
           AND m.rowid > ?1
         ORDER BY m.rowid ASC",
        )
        .map_err(|e| format!("Failed to query OpenCode DB: {e}"))?;

    let start_rowid = if should_rebuild { 0 } else { last_rowid };
    let rows = stmt
        .query_map(params![start_rowid], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut max_rowid = start_rowid;
    for row in rows {
        let (rowid, session_id, directory, time_created, data) = match row {
            Ok(value) => value,
            Err(_) => continue,
        };
        max_rowid = rowid;
        let payload: Value = match serde_json::from_str(&data) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let model = payload
            .get("modelID")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let pricing_provider = payload
            .get("providerID")
            .and_then(Value::as_str)
            .unwrap_or("opencode");
        let tokens = payload.get("tokens");
        let input = tokens
            .and_then(|t| t.get("input"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let output = tokens
            .and_then(|t| t.get("output"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let thoughts = tokens
            .and_then(|t| t.get("reasoning"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let cache_read = tokens
            .and_then(|t| t.get("cache"))
            .and_then(|c| c.get("read"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let cache_write = tokens
            .and_then(|t| t.get("cache"))
            .and_then(|c| c.get("write"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let total = tokens
            .and_then(|t| t.get("total"))
            .and_then(Value::as_u64)
            .unwrap_or(input + output + thoughts + cache_read + cache_write);
        let recorded_cost = payload.get("cost").and_then(Value::as_f64);
        let project = project_name_from_path(&directory);
        let timestamp = payload
            .get("time")
            .and_then(|t| t.get("completed").or_else(|| t.get("created")))
            .and_then(Value::as_i64)
            .map(|ms| ms / 1000)
            .unwrap_or(time_created / 1000);

        conn.execute(
            "INSERT INTO usage_messages (
                provider, session_id, project, model, timestamp,
                tokens_input, tokens_output, tokens_cache_write, tokens_cache_read,
                tokens_thoughts, tokens_total, pricing_provider, recorded_cost
             ) VALUES (
                'opencode', ?1, ?2, ?3, ?4,
                ?5, ?6, ?7, ?8,
                ?9, ?10, ?11, ?12
             )",
            params![
                session_id,
                project,
                model,
                timestamp,
                input as i64,
                output as i64,
                cache_write as i64,
                cache_read as i64,
                thoughts as i64,
                total as i64,
                pricing_provider,
                recorded_cost,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    upsert_cursor(conn, cursor_key, "opencode", file_size, max_rowid, mtime)?;
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(true)
}

// ── pi ────────────────────────────────────────────────────

fn ingest_pi(conn: &Connection, budget: usize) -> Result<bool, String> {
    let sessions_dir = home_join(".pi/agent/sessions")?;
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
        if let Err(e) = ingest_pi_file(conn, path) {
            eprintln!("pi ingest error for {}: {e}", path.display());
        }
    }

    if !skipped_remaining {
        clean_cursors(conn, "pi", &jsonl_files);
    }

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(!skipped_remaining)
}

fn ingest_pi_file(conn: &Connection, path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy().to_string();
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let file_size = meta.len() as i64;
    let mtime = file_mtime(&meta);

    let cursor = get_cursor(conn, &path_str);
    let offset = match &cursor {
        Some((size, off, mt)) => {
            if *size == file_size && *mt == mtime {
                return Ok(());
            }
            *off
        }
        None => 0,
    };

    // Filename format: <iso-timestamp>_<uuid>.jsonl — session id is the uuid.
    let file_stem = path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let session_id = file_stem
        .rsplit_once('_')
        .map(|(_, uuid)| uuid.to_string())
        .unwrap_or_else(|| file_stem.to_string());

    let project = read_pi_project(path).unwrap_or_else(|| "unknown".to_string());

    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(offset as u64))
        .map_err(|e| e.to_string())?;

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

        if row.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let message = match row.get("message") {
            Some(m) if m.is_object() => m,
            _ => continue,
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let usage = match message.get("usage") {
            Some(u) if u.is_object() => u,
            _ => continue,
        };

        let input = as_u64(usage.get("input"));
        let output = as_u64(usage.get("output"));
        let cache_read = as_u64(usage.get("cacheRead"));
        let cache_write = as_u64(usage.get("cacheWrite"));
        let mut total = as_u64(usage.get("totalTokens"));
        if total == 0 {
            total = input + output + cache_read + cache_write;
        }

        let model = message
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let pi_provider = message
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("pi");
        let pricing_provider = map_pi_provider(pi_provider);

        let ts = row
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_timestamp)
            .unwrap_or(0);

        // PI records $0 for OAuth/subscription sessions, which would understate
        // token value when list-rate pricing is available. Preserve only
        // positive recorded costs; otherwise let the pricing table estimate.
        let recorded_cost = usage
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .filter(|cost| *cost > 0.0);

        conn.execute(
            "INSERT INTO usage_messages (
                provider, session_id, project, model, timestamp,
                tokens_input, tokens_output, tokens_cache_write, tokens_cache_read,
                tokens_thoughts, tokens_total, pricing_provider, recorded_cost
             ) VALUES (
                'pi', ?1, ?2, ?3, ?4,
                ?5, ?6, ?7, ?8,
                0, ?9, ?10, ?11
             )",
            params![
                session_id,
                project,
                model,
                ts as i64,
                input as i64,
                output as i64,
                cache_write as i64,
                cache_read as i64,
                total as i64,
                pricing_provider,
                recorded_cost
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    upsert_cursor(conn, &path_str, "pi", file_size, new_offset, mtime)?;
    Ok(())
}

/// Map pi's provider name to the pricing_provider key used in model_pricing.
/// Uses models.dev native names so pricing lookups are consistent.
fn map_pi_provider(pi_provider: &str) -> String {
    match pi_provider {
        "azure" => "openai".to_string(),
        p if p.starts_with("google") => "google".to_string(),
        other => other.to_string(),
    }
}

/// Read the first-line session event to extract the cwd, then return the
/// last path segment as project name. Falls back to None on any error.
fn read_pi_project(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let row: Value = serde_json::from_str(&line).ok()?;
    let cwd = row.get("cwd").and_then(Value::as_str)?;
    Some(project_name_from_path(cwd))
}

// ── Maintenance ───────────────────────────────────────────

fn prune_old_messages(conn: &Connection) -> Result<(), String> {
    let cutoff = now_epoch_seconds() as i64 - 2_592_000; // 30 days

    // Roll up old messages into daily aggregates
    conn.execute(
        "INSERT OR REPLACE INTO usage_daily (provider, date, pricing_provider, model, project, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, tokens_thoughts, tokens_total, message_count, recorded_cost)
         SELECT provider, date(timestamp, 'unixepoch') as d, COALESCE(pricing_provider, provider), model, project,
                SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_write), SUM(tokens_cache_read), SUM(tokens_thoughts), SUM(tokens_total), COUNT(*), SUM(recorded_cost)
         FROM usage_messages
         WHERE timestamp < ?1 AND provider != 'opencode'
         GROUP BY provider, d, COALESCE(pricing_provider, provider), model, project",
        params![cutoff],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM usage_messages WHERE timestamp < ?1 AND provider != 'opencode'",
        params![cutoff],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

// ── Cursor helpers ────────────────────────────────────────

fn get_cursor(conn: &Connection, file_path: &str) -> Option<(i64, i64, i64)> {
    conn.query_row(
        "SELECT file_size, byte_offset, last_modified FROM ingest_cursors WHERE file_path = ?1",
        params![file_path],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .ok()
}

fn upsert_cursor(
    conn: &Connection,
    file_path: &str,
    provider: &str,
    file_size: i64,
    offset: i64,
    mtime: i64,
) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_ingest_uses_latest_token_count_timestamp() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_messages (
                provider TEXT NOT NULL,
                session_id TEXT NOT NULL,
                project TEXT,
                model TEXT,
                timestamp INTEGER NOT NULL,
                tokens_input INTEGER NOT NULL DEFAULT 0,
                tokens_output INTEGER NOT NULL DEFAULT 0,
                tokens_cache_write INTEGER NOT NULL DEFAULT 0,
                tokens_cache_read INTEGER NOT NULL DEFAULT 0,
                tokens_thoughts INTEGER NOT NULL DEFAULT 0,
                tokens_total INTEGER NOT NULL DEFAULT 0,
                pricing_provider TEXT,
                recorded_cost REAL
            );
            CREATE TABLE ingest_cursors (
                file_path TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                byte_offset INTEGER NOT NULL,
                last_modified INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();

        let dir =
            std::env::temp_dir().join(format!("shep-codex-ingest-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout-test.jsonl");
        let contents = [
            r#"{"timestamp":"2026-05-01T22:33:43.601Z","type":"session_meta","payload":{"id":"session-1","cwd":"/tmp/project"}}"#,
            r#"{"timestamp":"2026-05-01T22:34:00.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}"#,
            r#"{"timestamp":"2026-05-03T17:18:49.201Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":125}}}}"#,
        ].join("\n");
        std::fs::write(&path, contents).unwrap();

        ingest_codex_file(&conn, &path).unwrap();

        let (timestamp, total): (i64, i64) = conn
            .query_row(
                "SELECT timestamp, tokens_total FROM usage_messages WHERE provider = 'codex'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(timestamp, 1_777_828_729);
        assert_eq!(total, 125);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn antigravity_pricing_provider_uses_underlying_model_vendor() {
        assert_eq!(antigravity_pricing_provider("Gemini 3.5 Flash (Medium)"), "google");
        assert_eq!(antigravity_pricing_provider("Claude Sonnet 4.6 (Thinking)"), "anthropic");
        assert_eq!(antigravity_pricing_provider("GPT-OSS 120B"), "antigravity");
    }
}
