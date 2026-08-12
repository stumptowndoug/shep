use chrono::DateTime;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use unicode_segmentation::UnicodeSegmentation;
use url::Url;

const LAUNCH_TOLERANCE_MS: i64 = 5_000;
const MAX_NATIVE_TITLE_CHARS: usize = 120;
const MAX_PROMPT_TITLE_CHARS: usize = 40;
const MAX_PROMPT_TITLE_WORDS: usize = 7;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTitleMatch {
    pub session_id: String,
    pub title: Option<String>,
}

pub fn resolve_session_title(
    assistant_id: &str,
    repo_path: &str,
    started_after_ms: i64,
    session_id: Option<&str>,
    process_id: Option<u32>,
) -> Option<SessionTitleMatch> {
    let home = dirs::home_dir()?;
    resolve_session_title_from_home(
        &home,
        assistant_id,
        repo_path,
        started_after_ms,
        session_id,
        process_id,
    )
}

fn resolve_session_title_from_home(
    home: &Path,
    assistant_id: &str,
    repo_path: &str,
    started_after_ms: i64,
    session_id: Option<&str>,
    process_id: Option<u32>,
) -> Option<SessionTitleMatch> {
    match assistant_id {
        "claude" => resolve_claude(home, repo_path, started_after_ms, session_id, process_id),
        "codex" => resolve_codex(home, repo_path, started_after_ms, session_id),
        "cursor" => resolve_cursor(home, repo_path, started_after_ms, session_id),
        "antigravity" => resolve_antigravity(home, repo_path, started_after_ms, session_id),
        "opencode" => resolve_opencode(home, repo_path, started_after_ms, session_id),
        "pi" => resolve_pi(home, repo_path, started_after_ms, session_id),
        _ => None,
    }
}

fn open_read_only(path: &Path) -> Option<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

fn table_columns(conn: &Connection, table: &str) -> HashSet<String> {
    let sql = format!("PRAGMA table_info({table})");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return HashSet::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return HashSet::new();
    };
    rows.filter_map(Result::ok).collect()
}

fn column_expression(columns: &HashSet<String>, column: &str) -> String {
    columns
        .contains(column)
        .then(|| format!("NULLIF(TRIM({column}), '')"))
        .unwrap_or_else(|| "NULL".to_string())
}

fn clean_title(value: &str) -> Option<String> {
    truncate_at_word(value, MAX_NATIVE_TITLE_CHARS)
}

fn compact_generated_title(value: &str) -> Option<String> {
    let cleaned = clean_title(value)?;
    if cleaned.chars().count() > MAX_PROMPT_TITLE_CHARS
        || cleaned.unicode_words().count() > MAX_PROMPT_TITLE_WORDS
    {
        compact_prompt_title(value).or(Some(cleaned))
    } else {
        Some(cleaned)
    }
}

fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_at_word(value: &str, max_chars: usize) -> Option<String> {
    let normalized = normalize_text(value);
    if normalized.is_empty() {
        return None;
    }
    if normalized.chars().count() <= max_chars {
        return Some(normalized);
    }

    let mut title = String::new();
    for part in normalized.split_word_bounds() {
        if title.chars().count() + part.chars().count() > max_chars {
            break;
        }
        title.push_str(part);
    }
    let title = title.trim_end_matches(|ch: char| ch.is_whitespace() || ch.is_ascii_punctuation());
    if title.is_empty() {
        let title = normalized.chars().take(max_chars).collect::<String>();
        return (!title.is_empty()).then(|| format!("{title}…"));
    }
    Some(format!("{title}…"))
}

fn strip_leading_filler(mut value: &str) -> &str {
    const FILLERS: &[&str] = &[
        "okay, ",
        "ok, ",
        "hmm, ",
        "so, ",
        "well, ",
        "please ",
        "can you ",
        "could you ",
        "would you ",
        "i'd like you to ",
        "i need you to ",
        "let's ",
        "we should ",
        "go ahead and ",
        "just ",
    ];

    loop {
        let lowercase = value.to_lowercase();
        let Some(prefix) = FILLERS
            .iter()
            .find(|prefix| lowercase.starts_with(**prefix))
        else {
            return value;
        };
        value = value[prefix.len()..].trim_start();
    }
}

fn is_generic_prompt_sentence(value: &str) -> bool {
    let lowercase = value.to_lowercase();
    let words = value.unicode_words().count();
    words < 3
        || lowercase.starts_with("help me debug this")
        || lowercase.starts_with("one item i am noticing")
        || lowercase.starts_with("one thing i noticed")
        || lowercase.starts_with("i guess i'm confused")
        || lowercase.starts_with("i have a question")
}

fn first_content_sentence(value: &str) -> Option<String> {
    let normalized = normalize_text(value);
    let mut fallback = None;

    for sentence in normalized.unicode_sentences() {
        let cleaned = strip_leading_filler(sentence)
            .trim()
            .trim_start_matches(['#', '>'])
            .trim()
            .trim_end_matches(['.', '?', '!']);
        if cleaned.is_empty() {
            continue;
        }
        fallback.get_or_insert_with(|| cleaned.to_string());
        if !is_generic_prompt_sentence(cleaned) {
            return Some(cleaned.to_string());
        }
    }

    fallback
}

fn focus_prompt_clause(value: &str) -> &str {
    const CUES: &[&str] = &[
        "more about being able to ",
        "about being able to ",
        "figure out why ",
        "is there a way to ",
        "how can i ",
        "how do i ",
        "why ",
        "more about ",
    ];

    let lowercase = value.to_lowercase();
    CUES.iter()
        .find_map(|cue| {
            lowercase
                .find(cue)
                .map(|index| value[index + cue.len()..].trim())
        })
        .filter(|candidate| candidate.unicode_words().count() >= 2)
        .unwrap_or(value)
}

fn trim_trailing_filler(mut value: &str) -> &str {
    const FILLERS: &[&str] = &[
        " a", " an", " and", " or", " the", " to", " of", " in", " for", " with", " after",
        " before", " while", " about",
    ];
    loop {
        let lowercase = value.to_lowercase();
        let Some(suffix) = FILLERS.iter().find(|suffix| lowercase.ends_with(**suffix)) else {
            return value;
        };
        value = value[..value.len() - suffix.len()].trim_end();
    }
}

fn compact_prompt_title(value: &str) -> Option<String> {
    let normalized = normalize_text(value);
    if normalized.is_empty() || normalized.starts_with('/') {
        return None;
    }

    let focused = focus_prompt_clause(&normalized);
    let content = if focused == normalized {
        first_content_sentence(&normalized)?
    } else {
        focused.to_string()
    };
    let focused = focus_prompt_clause(&content)
        .trim()
        .trim_end_matches(['.', '?', '!']);
    if focused.is_empty() {
        return None;
    }

    let word_end = focused
        .unicode_word_indices()
        .nth(MAX_PROMPT_TITLE_WORDS.saturating_sub(1))
        .map(|(index, word)| index + word.len())
        .unwrap_or(focused.len());
    let word_limited = word_end < focused.len();
    let limited = trim_trailing_filler(&focused[..word_end]);
    let title = truncate_at_word(limited, MAX_PROMPT_TITLE_CHARS)?;
    let char_limited = title.ends_with('…');
    let title = trim_trailing_filler(title.trim_end_matches('…'));
    if title.is_empty() {
        return None;
    }
    Some(if word_limited || char_limited {
        format!("{title}…")
    } else {
        title.to_string()
    })
}

fn resolve_codex(
    home: &Path,
    repo_path: &str,
    started_after_ms: i64,
    session_id: Option<&str>,
) -> Option<SessionTitleMatch> {
    let codex_dir = home.join(".codex");
    let mut databases: Vec<PathBuf> = fs::read_dir(&codex_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("state_") && name.ends_with(".sqlite"))
        })
        .collect();
    databases.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    });

    for path in databases.into_iter().rev() {
        let Some(conn) = open_read_only(&path) else {
            continue;
        };
        let columns = table_columns(&conn, "threads");
        if !columns.contains("id") || !columns.contains("cwd") {
            continue;
        }
        let name = column_expression(&columns, "name");
        let native_title = column_expression(&columns, "title");
        let first_prompt = column_expression(&columns, "first_user_message");
        let preview = column_expression(&columns, "preview");

        let row = if let Some(id) = session_id {
            let sql = format!(
                "SELECT id, {name}, {native_title}, {first_prompt}, {preview}
                 FROM threads WHERE id = ?1 AND cwd = ?2 LIMIT 1"
            );
            conn.query_row(&sql, params![id, repo_path], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .optional()
            .ok()
            .flatten()
        } else {
            let created = if columns.contains("created_at_ms") {
                "created_at_ms"
            } else if columns.contains("created_at") {
                "created_at * 1000"
            } else {
                continue;
            };
            let archived = if columns.contains("archived") {
                "AND archived = 0"
            } else {
                ""
            };
            let sql = format!(
                "SELECT id, {name}, {native_title}, {first_prompt}, {preview} FROM threads
                 WHERE cwd = ?1 AND {created} >= ?2 {archived}
                 ORDER BY ABS({created} - ?3), {created} ASC LIMIT 1"
            );
            conn.query_row(
                &sql,
                params![
                    repo_path,
                    started_after_ms.saturating_sub(LAUNCH_TOLERANCE_MS),
                    started_after_ms
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()
            .ok()
            .flatten()
        };

        if let Some((id, name, native_title, first_prompt, preview)) = row {
            return Some(SessionTitleMatch {
                session_id: id,
                title: name
                    .as_deref()
                    .and_then(clean_title)
                    .or_else(|| native_title.as_deref().and_then(compact_generated_title))
                    .or_else(|| first_prompt.as_deref().and_then(compact_prompt_title))
                    .or_else(|| preview.as_deref().and_then(compact_prompt_title)),
            });
        }
    }
    None
}

fn resolve_opencode(
    home: &Path,
    repo_path: &str,
    started_after_ms: i64,
    session_id: Option<&str>,
) -> Option<SessionTitleMatch> {
    let path = home.join(".local/share/opencode/opencode.db");
    let conn = open_read_only(&path)?;
    let columns = table_columns(&conn, "session");
    if !["id", "title", "directory", "time_created"]
        .iter()
        .all(|column| columns.contains(*column))
    {
        return None;
    }

    let row = if let Some(id) = session_id {
        conn.query_row(
            "SELECT id, title FROM session WHERE id = ?1 AND directory = ?2 LIMIT 1",
            params![id, repo_path],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .ok()
        .flatten()
    } else {
        conn.query_row(
            "SELECT id, title FROM session
             WHERE directory = ?1 AND time_created >= ?2
             ORDER BY ABS(time_created - ?3), time_created ASC LIMIT 1",
            params![
                repo_path,
                started_after_ms.saturating_sub(LAUNCH_TOLERANCE_MS),
                started_after_ms
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .ok()
        .flatten()
    }?;

    let title = compact_generated_title(&row.1)
        .filter(|title| !title.to_ascii_lowercase().starts_with("new session"))
        .or_else(|| {
            opencode_first_prompt(&conn, &row.0).and_then(|prompt| compact_prompt_title(&prompt))
        });
    Some(SessionTitleMatch {
        session_id: row.0,
        title,
    })
}

fn opencode_first_prompt(conn: &Connection, session_id: &str) -> Option<String> {
    let input_columns = table_columns(conn, "session_input");
    if ["session_id", "prompt", "time_created"]
        .iter()
        .all(|column| input_columns.contains(*column))
    {
        let prompt = conn
            .query_row(
                "SELECT prompt FROM session_input
                 WHERE session_id = ?1 AND TRIM(prompt) != ''
                 ORDER BY time_created ASC LIMIT 1",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten();
        if prompt.is_some() {
            return prompt;
        }
    }

    let message_columns = table_columns(conn, "message");
    let part_columns = table_columns(conn, "part");
    if !["id", "session_id", "time_created", "data"]
        .iter()
        .all(|column| message_columns.contains(*column))
        || !["message_id", "session_id", "time_created", "data"]
            .iter()
            .all(|column| part_columns.contains(*column))
    {
        return None;
    }

    conn.query_row(
        "SELECT CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.text') END
         FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ?1 AND p.session_id = ?1
           AND CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END = 'user'
           AND CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') END = 'text'
         ORDER BY m.time_created ASC, p.time_created ASC LIMIT 1",
        [session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn resolve_antigravity(
    home: &Path,
    repo_path: &str,
    started_after_ms: i64,
    session_id: Option<&str>,
) -> Option<SessionTitleMatch> {
    if let Some(id) = session_id {
        if let Some(prompt) = antigravity_first_prompt(home, id) {
            return Some(SessionTitleMatch {
                session_id: id.to_string(),
                title: compact_prompt_title(&prompt),
            });
        }
    } else if let Some(found) = resolve_antigravity_history(home, repo_path, started_after_ms) {
        return Some(found);
    }

    let path = home.join(".gemini/antigravity-cli/conversation_summaries.db");
    let conn = open_read_only(&path)?;
    let columns = table_columns(&conn, "conversation_summaries");
    if !columns.contains("conversation_id") {
        return None;
    }
    let native_title = column_expression(&columns, "title");
    let preview = column_expression(&columns, "preview");

    if let Some(id) = session_id {
        let sql = format!(
            "SELECT conversation_id, {native_title}, {preview} FROM conversation_summaries
             WHERE conversation_id = ?1 LIMIT 1"
        );
        let row = conn
            .query_row(&sql, [id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .optional()
            .ok()
            .flatten()?;
        return Some(SessionTitleMatch {
            title: antigravity_title(home, &row.0, row.1.as_deref(), row.2.as_deref()),
            session_id: row.0,
        });
    }

    if !columns.contains("workspace_uris") || !columns.contains("last_user_input_time") {
        return None;
    }
    let sql = format!(
        "SELECT conversation_id, {native_title}, {preview}, workspace_uris
         FROM conversation_summaries
         WHERE last_user_input_time >= datetime(?1 / 1000, 'unixepoch')
         ORDER BY last_user_input_time ASC LIMIT 50"
    );
    let mut stmt = conn.prepare(&sql).ok()?;
    let rows = stmt
        .query_map(
            [started_after_ms.saturating_sub(LAUNCH_TOLERANCE_MS)],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .ok()?;

    for row in rows.flatten() {
        if workspace_uris_include(&row.3, repo_path) {
            return Some(SessionTitleMatch {
                title: antigravity_title(home, &row.0, row.1.as_deref(), row.2.as_deref()),
                session_id: row.0,
            });
        }
    }
    None
}

fn resolve_antigravity_history(
    home: &Path,
    repo_path: &str,
    started_after_ms: i64,
) -> Option<SessionTitleMatch> {
    let file = fs::File::open(home.join(".gemini/antigravity-cli/history.jsonl")).ok()?;
    let mut prompts = Vec::new();

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if row.get("workspace").and_then(Value::as_str) != Some(repo_path) {
            continue;
        }
        let Some(timestamp) = row.get("timestamp").and_then(Value::as_i64) else {
            continue;
        };
        if timestamp < started_after_ms.saturating_sub(LAUNCH_TOLERANCE_MS) {
            continue;
        }
        let Some(prompt) = row
            .get("display")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty() && !prompt.starts_with('/'))
        else {
            continue;
        };
        prompts.push((
            timestamp.abs_diff(started_after_ms),
            timestamp,
            row.get("conversationId")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            prompt.to_string(),
        ));
    }

    prompts.sort_by_key(|candidate| candidate.0);
    for (_, timestamp, conversation_id, prompt) in prompts {
        let session_id =
            conversation_id.or_else(|| find_antigravity_transcript(home, timestamp, &prompt));
        if let Some(session_id) = session_id {
            return Some(SessionTitleMatch {
                session_id,
                title: compact_prompt_title(&prompt),
            });
        }
    }
    None
}

fn find_antigravity_transcript(home: &Path, timestamp_ms: i64, prompt: &str) -> Option<String> {
    let directory = home.join(".gemini/antigravity-cli/brain");
    let expected_prompt = normalize_text(prompt);
    let mut candidates = Vec::new();

    for entry in fs::read_dir(directory).ok()?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(session_id) = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(ToString::to_string)
        else {
            continue;
        };
        let Some((created_at_ms, transcript_prompt)) =
            antigravity_first_prompt_info(home, &session_id)
        else {
            continue;
        };
        if normalize_text(&transcript_prompt) != expected_prompt {
            continue;
        }
        let distance = created_at_ms.abs_diff(timestamp_ms);
        if distance <= LAUNCH_TOLERANCE_MS as u64 {
            candidates.push((distance, session_id));
        }
    }

    candidates.sort_by_key(|candidate| candidate.0);
    candidates.into_iter().next().map(|(_, id)| id)
}

fn antigravity_title(
    home: &Path,
    session_id: &str,
    native_title: Option<&str>,
    preview: Option<&str>,
) -> Option<String> {
    native_title
        .and_then(compact_generated_title)
        .or_else(|| {
            antigravity_first_prompt(home, session_id)
                .and_then(|prompt| compact_prompt_title(&prompt))
        })
        .or_else(|| preview.and_then(compact_prompt_title))
}

fn antigravity_first_prompt(home: &Path, session_id: &str) -> Option<String> {
    antigravity_first_prompt_row(home, session_id).map(|(_, prompt)| prompt)
}

fn antigravity_first_prompt_info(home: &Path, session_id: &str) -> Option<(i64, String)> {
    let (created_at, prompt) = antigravity_first_prompt_row(home, session_id)?;
    Some((parse_timestamp_ms(created_at.as_deref()?)?, prompt))
}

fn antigravity_first_prompt_row(home: &Path, session_id: &str) -> Option<(Option<String>, String)> {
    let logs = home
        .join(".gemini/antigravity-cli/brain")
        .join(session_id)
        .join(".system_generated/logs");
    for filename in ["transcript_full.jsonl", "transcript.jsonl"] {
        let Ok(file) = fs::File::open(logs.join(filename)) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(row) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if row.get("type").and_then(Value::as_str) != Some("USER_INPUT") {
                continue;
            }
            if let Some(prompt) = row.get("content").and_then(message_content_text) {
                let prompt = antigravity_user_request(&prompt);
                return Some((
                    row.get("created_at")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    prompt,
                ));
            }
        }
    }
    None
}

fn antigravity_user_request(value: &str) -> String {
    const START: &str = "<USER_REQUEST>";
    const END: &str = "</USER_REQUEST>";

    value
        .find(START)
        .and_then(|start| {
            let content = &value[start + START.len()..];
            content.find(END).map(|end| content[..end].trim())
        })
        .filter(|content| !content.is_empty())
        .unwrap_or(value)
        .to_string()
}

fn workspace_uris_include(raw: &str, repo_path: &str) -> bool {
    let Ok(uris) = serde_json::from_str::<Vec<String>>(raw) else {
        return false;
    };
    uris.iter().any(|uri| {
        Url::parse(uri)
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .is_some_and(|path| path == Path::new(repo_path))
    })
}

fn resolve_pi(
    home: &Path,
    repo_path: &str,
    started_after_ms: i64,
    session_id: Option<&str>,
) -> Option<SessionTitleMatch> {
    let directory = home
        .join(".pi/agent/sessions")
        .join(pi_project_directory(repo_path));
    resolve_jsonl_session_directory(
        &directory,
        repo_path,
        started_after_ms,
        session_id,
        JsonlProvider::Pi,
    )
}

fn resolve_cursor(
    home: &Path,
    repo_path: &str,
    started_after_ms: i64,
    session_id: Option<&str>,
) -> Option<SessionTitleMatch> {
    let chats = home.join(".cursor/chats");
    let mut candidates = Vec::new();

    for workspace in fs::read_dir(chats).ok()?.flatten() {
        if !workspace.path().is_dir() {
            continue;
        }
        for session in fs::read_dir(workspace.path()).ok()?.flatten() {
            let session_path = session.path();
            if !session_path.is_dir() {
                continue;
            }
            let Some(id) = session_path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if session_id.is_some_and(|expected| expected != id) {
                continue;
            }
            let Ok(text) = fs::read_to_string(session_path.join("meta.json")) else {
                continue;
            };
            let Ok(meta) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if meta.get("cwd").and_then(Value::as_str) != Some(repo_path)
                || meta.get("isSubagent").and_then(Value::as_bool) == Some(true)
            {
                continue;
            }
            let Some(created_at_ms) = meta.get("createdAtMs")
                .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
            else {
                continue;
            };
            if session_id.is_none()
                && created_at_ms < started_after_ms.saturating_sub(LAUNCH_TOLERANCE_MS)
            {
                continue;
            }
            let title = meta.get("title")
                .and_then(Value::as_str)
                .and_then(compact_generated_title);
            candidates.push((created_at_ms.abs_diff(started_after_ms), id.to_string(), title));
        }
    }

    candidates.sort_by_key(|candidate| candidate.0);
    candidates.into_iter().next().map(|(_, session_id, title)| SessionTitleMatch {
        session_id,
        title,
    })
}

fn resolve_claude(
    home: &Path,
    repo_path: &str,
    started_after_ms: i64,
    session_id: Option<&str>,
    process_id: Option<u32>,
) -> Option<SessionTitleMatch> {
    let directory = home
        .join(".claude/projects")
        .join(claude_project_directory(repo_path));
    let pid_session_id = session_id
        .map(ToString::to_string)
        .or_else(|| claude_pid_session_id(home, repo_path, process_id));
    resolve_jsonl_session_directory(
        &directory,
        repo_path,
        started_after_ms,
        pid_session_id.as_deref(),
        JsonlProvider::Claude,
    )
}

// Claude Code names each project directory by replacing every non-alphanumeric
// character in the cwd with a dash (e.g. /Users/doug.dement/dev/shep →
// -Users-doug-dement-dev-shep).
fn claude_project_directory(repo_path: &str) -> String {
    repo_path
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn claude_pid_session_id(home: &Path, repo_path: &str, process_id: Option<u32>) -> Option<String> {
    let path = home
        .join(".claude/sessions")
        .join(format!("{}.json", process_id?));
    let row: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    if row.get("cwd").and_then(Value::as_str) != Some(repo_path) {
        return None;
    }
    row.get("sessionId")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[derive(Clone, Copy)]
enum JsonlProvider {
    Claude,
    Pi,
}

fn resolve_jsonl_session_directory(
    directory: &Path,
    repo_path: &str,
    started_after_ms: i64,
    session_id: Option<&str>,
    provider: JsonlProvider,
) -> Option<SessionTitleMatch> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(directory).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(id) = jsonl_session_id(&path, provider) else {
            continue;
        };
        if session_id.is_some_and(|expected| expected != id) {
            continue;
        }
        let Some(info) = read_jsonl_session(&path, repo_path, provider) else {
            continue;
        };
        if session_id.is_none()
            && info.created_at_ms < started_after_ms.saturating_sub(LAUNCH_TOLERANCE_MS)
        {
            continue;
        }
        let distance = info.created_at_ms.abs_diff(started_after_ms);
        candidates.push((distance, id, info.title));
    }
    candidates.sort_by_key(|candidate| candidate.0);
    candidates
        .into_iter()
        .next()
        .map(|(_, session_id, title)| SessionTitleMatch { session_id, title })
}

fn jsonl_session_id(path: &Path, provider: JsonlProvider) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    match provider {
        JsonlProvider::Claude => Some(stem.to_string()),
        JsonlProvider::Pi => stem.rsplit_once('_').map(|(_, id)| id.to_string()),
    }
}

struct JsonlSessionInfo {
    created_at_ms: i64,
    title: Option<String>,
}

fn read_jsonl_session(
    path: &Path,
    repo_path: &str,
    provider: JsonlProvider,
) -> Option<JsonlSessionInfo> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut created_at_ms = None;
    let mut explicit_name = None;
    let mut first_prompt = None;

    for line in reader.lines().map_while(Result::ok) {
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match provider {
            JsonlProvider::Pi => {
                if row.get("type").and_then(Value::as_str) == Some("session") {
                    if row.get("cwd").and_then(Value::as_str) != Some(repo_path) {
                        return None;
                    }
                    created_at_ms = row
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .and_then(parse_timestamp_ms);
                } else if row.get("type").and_then(Value::as_str) == Some("session_info") {
                    explicit_name = row
                        .get("name")
                        .and_then(Value::as_str)
                        .and_then(clean_title);
                } else if first_prompt.is_none()
                    && row.get("type").and_then(Value::as_str) == Some("message")
                    && row
                        .get("message")
                        .and_then(|message| message.get("role"))
                        .and_then(Value::as_str)
                        == Some("user")
                {
                    first_prompt = row
                        .get("message")
                        .and_then(|message| message.get("content"))
                        .and_then(message_content_text)
                        .and_then(|text| compact_prompt_title(&text));
                }
            }
            JsonlProvider::Claude => {
                if row.get("type").and_then(Value::as_str) != Some("user")
                    || row.get("cwd").and_then(Value::as_str) != Some(repo_path)
                {
                    continue;
                }
                let Some(timestamp) = row
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(parse_timestamp_ms)
                else {
                    continue;
                };
                created_at_ms.get_or_insert(timestamp);
                if first_prompt.is_none() {
                    first_prompt = row
                        .get("message")
                        .and_then(|message| message.get("content"))
                        .and_then(message_content_text)
                        .and_then(|text| compact_prompt_title(&text));
                }
            }
        }
    }

    Some(JsonlSessionInfo {
        created_at_ms: created_at_ms?,
        title: explicit_name.or(first_prompt),
    })
}

fn message_content_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    if let Some(object) = content.as_object() {
        return object
            .get("text")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| object.get("content").and_then(message_content_text));
    }
    let blocks = content.as_array()?;
    let text = blocks
        .iter()
        .filter_map(message_content_text)
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty()).then_some(text)
}

fn parse_timestamp_ms(timestamp: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|date_time| date_time.timestamp_millis())
}

fn pi_project_directory(repo_path: &str) -> String {
    let without_root = repo_path.trim_start_matches(['/', '\\']);
    let safe = without_root.replace(['/', '\\', ':'], "-");
    format!("--{safe}--")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    fn temp_home() -> PathBuf {
        let unique = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "shep-session-title-{}-{nanos}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn compact_prompt_titles_fit_the_sidebar() {
        let cases = [
            (
                "Okay, one item I am noticing. Claude seems to add * in front of the title?",
                "Claude seems to add * in front…",
            ),
            (
                "Can you take a look at the authentication middleware and figure out why expired tokens aren't being rejected?",
                "expired tokens aren't being rejected",
            ),
            (
                "Please inspect src/hooks/usePty.ts and figure out why session title polling stops after switching projects. Don't change the provider resolver.",
                "session title polling stops…",
            ),
            (
                "I guess I'm confused—is this needed? I would expect sessions to stop when exiting the app. Is this more about being able to restore sessions?",
                "restore sessions",
            ),
            (
                "Can you help me debug this? The app freezes while closing a PTY after child.wait() returns, but only when two assistant tabs are open.",
                "The app freezes while closing a PTY…",
            ),
            (
                "Add dark mode to the settings panel",
                "Add dark mode to the settings panel",
            ),
        ];

        for (prompt, expected) in cases {
            let title = compact_prompt_title(prompt).unwrap();
            assert_eq!(title, expected);
            assert!(title.chars().count() <= MAX_PROMPT_TITLE_CHARS + 1);
            assert!(title.unicode_words().count() <= MAX_PROMPT_TITLE_WORDS);
        }

        let long_identifier = "x".repeat(MAX_PROMPT_TITLE_CHARS + 10);
        assert_eq!(
            compact_prompt_title(&long_identifier).unwrap(),
            format!("{}…", "x".repeat(MAX_PROMPT_TITLE_CHARS))
        );
    }

    #[test]
    fn cursor_reads_meta_sidecars_and_anchors_exact_session() {
        let home = temp_home();
        let first = home.join(".cursor/chats/workspace-a/chat-1");
        let second = home.join(".cursor/chats/workspace-b/chat-2");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(first.join("meta.json"), r#"{
            "schemaVersion":1,"createdAtMs":10000,"cwd":"/repo","title":"Implement Cursor support"
        }"#).unwrap();
        fs::write(second.join("meta.json"), r#"{
            "schemaVersion":1,"createdAtMs":11000,"cwd":"/repo","title":"Second chat"
        }"#).unwrap();

        let nearest = resolve_session_title_from_home(&home, "cursor", "/repo", 10_100, None, None).unwrap();
        assert_eq!(nearest.session_id, "chat-1");
        assert_eq!(nearest.title.as_deref(), Some("Implement Cursor support"));

        let anchored = resolve_session_title_from_home(&home, "cursor", "/repo", 10_100, Some("chat-2"), None).unwrap();
        assert_eq!(anchored.session_id, "chat-2");

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codex_prefers_explicit_name_and_anchors_session() {
        let home = temp_home();
        let dir = home.join(".codex");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("state_5.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
                archived INTEGER NOT NULL, name TEXT, title TEXT, first_user_message TEXT
             );
             INSERT INTO threads VALUES (
                'thread-1', '/repo', 10000, 0, 'Manual name', 'Generated title', 'First prompt'
             );",
        )
        .unwrap();
        drop(conn);

        let found =
            resolve_session_title_from_home(&home, "codex", "/repo", 10_000, None, None).unwrap();
        assert_eq!(found.session_id, "thread-1");
        assert_eq!(found.title.as_deref(), Some("Manual name"));

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codex_compacts_first_prompt_when_native_titles_are_missing() {
        let home = temp_home();
        let dir = home.join(".codex");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("state_5.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
                archived INTEGER NOT NULL, name TEXT, title TEXT, first_user_message TEXT
             );
             INSERT INTO threads VALUES (
                'thread-1', '/repo', 10000, 0, '', '',
                'Please inspect usePty.ts and figure out why session title polling stops after switching projects.'
             );",
        )
        .unwrap();
        drop(conn);

        let found =
            resolve_session_title_from_home(&home, "codex", "/repo", 10_000, None, None).unwrap();
        assert_eq!(found.title.as_deref(), Some("session title polling stops…"));

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codex_compacts_a_long_generated_native_title() {
        let home = temp_home();
        let dir = home.join(".codex");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("state_5.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
                archived INTEGER NOT NULL, name TEXT, title TEXT, first_user_message TEXT
             );
             INSERT INTO threads VALUES (
                'thread-1', '/repo', 10000, 0, '',
                'Please inspect usePty.ts and figure out why session title polling stops after switching projects.',
                'Please inspect usePty.ts and figure out why session title polling stops after switching projects.'
             );",
        )
        .unwrap();
        drop(conn);

        let found =
            resolve_session_title_from_home(&home, "codex", "/repo", 10_000, None, None).unwrap();
        assert_eq!(found.title.as_deref(), Some("session title polling stops…"));

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn antigravity_uses_preview_and_exact_workspace() {
        let home = temp_home();
        let dir = home.join(".gemini/antigravity-cli");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("conversation_summaries.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE conversation_summaries (
                conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT,
                workspace_uris TEXT, last_user_input_time DATETIME
             );
             INSERT INTO conversation_summaries VALUES (
                'conversation-1', '', 'Readable preview', '[\"file:///repo\"]',
                '2026-08-07 12:00:01'
             );",
        )
        .unwrap();
        drop(conn);
        let started = parse_timestamp_ms("2026-08-07T12:00:00Z").unwrap();

        let found =
            resolve_session_title_from_home(&home, "antigravity", "/repo", started, None, None)
                .unwrap();
        assert_eq!(found.session_id, "conversation-1");
        assert_eq!(found.title.as_deref(), Some("Readable preview"));

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn antigravity_prefers_and_compacts_transcript_prompt_over_preview() {
        let home = temp_home();
        let dir = home.join(".gemini/antigravity-cli");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("conversation_summaries.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE conversation_summaries (
                conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT,
                workspace_uris TEXT, last_user_input_time DATETIME
             );
             INSERT INTO conversation_summaries VALUES (
                'conversation-1', '', 'Less useful preview', '[\"file:///repo\"]',
                '2026-08-07 12:00:01'
             );",
        )
        .unwrap();
        drop(conn);
        let logs = dir.join("brain/conversation-1/.system_generated/logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(
            logs.join("transcript_full.jsonl"),
            "{\"type\":\"USER_INPUT\",\"content\":\"Is this more about being able to restore sessions?\"}\n",
        )
        .unwrap();
        let started = parse_timestamp_ms("2026-08-07T12:00:00Z").unwrap();

        let found =
            resolve_session_title_from_home(&home, "antigravity", "/repo", started, None, None)
                .unwrap();
        assert_eq!(found.title.as_deref(), Some("restore sessions"));

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn antigravity_compacts_a_long_generated_native_title() {
        let home = temp_home();
        let dir = home.join(".gemini/antigravity-cli");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("conversation_summaries.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE conversation_summaries (
                conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT,
                workspace_uris TEXT, last_user_input_time DATETIME
             );
             INSERT INTO conversation_summaries VALUES (
                'conversation-1',
                'Can you take a look at the authentication middleware and figure out why expired tokens are not being rejected?',
                '', '[\"file:///repo\"]', '2026-08-07 12:00:01'
             );",
        )
        .unwrap();
        drop(conn);
        let started = parse_timestamp_ms("2026-08-07T12:00:00Z").unwrap();

        let found =
            resolve_session_title_from_home(&home, "antigravity", "/repo", started, None, None)
                .unwrap();
        assert_eq!(
            found.title.as_deref(),
            Some("expired tokens are not being rejected")
        );

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn antigravity_matches_live_history_to_its_wrapped_transcript() {
        let home = temp_home();
        let dir = home.join(".gemini/antigravity-cli");
        fs::create_dir_all(&dir).unwrap();
        let started = parse_timestamp_ms("2026-08-07T12:00:00Z").unwrap();
        fs::write(
            dir.join("history.jsonl"),
            format!(
                "{{\"display\":\"Can you figure out why expired tokens are not being rejected?\",\"timestamp\":{},\"workspace\":\"/repo\"}}\n",
                started + 1_250
            ),
        )
        .unwrap();

        let logs = dir.join("brain/conversation-live/.system_generated/logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(
            logs.join("transcript_full.jsonl"),
            concat!(
                "{\"type\":\"USER_INPUT\",\"created_at\":\"2026-08-07T12:00:01Z\",",
                "\"content\":\"<USER_REQUEST>\\nCan you figure out why expired tokens are not being rejected?\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>\\nLocal metadata\\n</ADDITIONAL_METADATA>\"}\n"
            ),
        )
        .unwrap();

        let found =
            resolve_session_title_from_home(&home, "antigravity", "/repo", started, None, None)
                .unwrap();
        assert_eq!(found.session_id, "conversation-live");
        assert_eq!(
            found.title.as_deref(),
            Some("expired tokens are not being rejected")
        );

        let anchored = resolve_session_title_from_home(
            &home,
            "antigravity",
            "/repo",
            started,
            Some("conversation-live"),
            None,
        )
        .unwrap();
        assert_eq!(anchored, found);

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn opencode_anchors_session_before_a_useful_title_exists() {
        let home = temp_home();
        let dir = home.join(".local/share/opencode");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, directory TEXT NOT NULL,
                time_created INTEGER NOT NULL
             );
             INSERT INTO session VALUES ('session-1', 'New session - 2026-08-07', '/repo', 10000);",
        )
        .unwrap();
        drop(conn);

        let found = resolve_session_title_from_home(&home, "opencode", "/repo", 10_000, None, None)
            .unwrap();
        assert_eq!(found.session_id, "session-1");
        assert_eq!(found.title, None);

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn opencode_compacts_first_session_input_when_title_is_generic() {
        let home = temp_home();
        let dir = home.join(".local/share/opencode");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, directory TEXT NOT NULL,
                time_created INTEGER NOT NULL
             );
             CREATE TABLE session_input (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL,
                time_created INTEGER NOT NULL
             );
             INSERT INTO session VALUES ('session-1', 'New session - 2026-08-07', '/repo', 10000);
             INSERT INTO session_input VALUES (
                'input-1', 'session-1',
                'Can you figure out why expired tokens are not being rejected?', 10001
             );",
        )
        .unwrap();
        drop(conn);

        let found = resolve_session_title_from_home(&home, "opencode", "/repo", 10_000, None, None)
            .unwrap();
        assert_eq!(
            found.title.as_deref(),
            Some("expired tokens are not being rejected")
        );

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn opencode_compacts_long_generated_titles_but_preserves_short_ones() {
        let home = temp_home();
        let dir = home.join(".local/share/opencode");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, directory TEXT NOT NULL,
                time_created INTEGER NOT NULL
             );
             INSERT INTO session VALUES (
                'session-1',
                'Please inspect usePty.ts and figure out why session title polling stops after switching projects.',
                '/repo', 10000
             );
             INSERT INTO session VALUES ('session-2', 'Fix auth tokens', '/repo', 20000);",
        )
        .unwrap();
        drop(conn);

        let long = resolve_session_title_from_home(
            &home,
            "opencode",
            "/repo",
            10_000,
            Some("session-1"),
            None,
        )
        .unwrap();
        assert_eq!(long.title.as_deref(), Some("session title polling stops…"));

        let short = resolve_session_title_from_home(
            &home,
            "opencode",
            "/repo",
            20_000,
            Some("session-2"),
            None,
        )
        .unwrap();
        assert_eq!(short.title.as_deref(), Some("Fix auth tokens"));

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn opencode_falls_back_to_legacy_message_parts() {
        let home = temp_home();
        let dir = home.join(".local/share/opencode");
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, directory TEXT NOT NULL,
                time_created INTEGER NOT NULL
             );
             CREATE TABLE message (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
                data TEXT NOT NULL
             );
             CREATE TABLE part (
                id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL, data TEXT NOT NULL
             );
             INSERT INTO session VALUES ('session-1', 'New session', '/repo', 10000);
             INSERT INTO message VALUES (
                'message-1', 'session-1', 10001, '{\"role\":\"user\"}'
             );
             INSERT INTO part VALUES (
                'part-1', 'message-1', 'session-1', 10002,
                '{\"type\":\"text\",\"text\":\"Is this more about being able to restore sessions?\"}'
             );",
        )
        .unwrap();
        drop(conn);

        let found = resolve_session_title_from_home(&home, "opencode", "/repo", 10_000, None, None)
            .unwrap();
        assert_eq!(found.title.as_deref(), Some("restore sessions"));

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn pi_prefers_latest_session_info_over_first_prompt() {
        let home = temp_home();
        let repo = "/repo";
        let dir = home
            .join(".pi/agent/sessions")
            .join(pi_project_directory(repo));
        fs::create_dir_all(&dir).unwrap();
        let id = "019fda65-a9fd-75d2-9610-77b2fee348c5";
        let content = concat!(
            "{\"type\":\"session\",\"id\":\"019fda65-a9fd-75d2-9610-77b2fee348c5\",\"timestamp\":\"2026-08-07T12:00:00Z\",\"cwd\":\"/repo\"}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"First prompt title\"}}\n",
            "{\"type\":\"session_info\",\"name\":\"Named Pi session\"}\n"
        );
        fs::write(
            dir.join(format!("2026-08-07T12-00-00Z_{id}.jsonl")),
            content,
        )
        .unwrap();
        let started = parse_timestamp_ms("2026-08-07T12:00:00Z").unwrap();

        let found =
            resolve_session_title_from_home(&home, "pi", repo, started, None, None).unwrap();
        assert_eq!(found.session_id, id);
        assert_eq!(found.title.as_deref(), Some("Named Pi session"));

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn pi_compacts_first_prompt_without_an_explicit_name() {
        let home = temp_home();
        let repo = "/repo";
        let dir = home
            .join(".pi/agent/sessions")
            .join(pi_project_directory(repo));
        fs::create_dir_all(&dir).unwrap();
        let id = "019fda65-a9fd-75d2-9610-77b2fee348c5";
        let content = concat!(
            "{\"type\":\"session\",\"id\":\"019fda65-a9fd-75d2-9610-77b2fee348c5\",\"timestamp\":\"2026-08-07T12:00:00Z\",\"cwd\":\"/repo\"}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"Is this more about being able to restore sessions?\"}}\n"
        );
        fs::write(
            dir.join(format!("2026-08-07T12-00-00Z_{id}.jsonl")),
            content,
        )
        .unwrap();
        let started = parse_timestamp_ms("2026-08-07T12:00:00Z").unwrap();

        let found =
            resolve_session_title_from_home(&home, "pi", repo, started, None, None).unwrap();
        assert_eq!(found.title.as_deref(), Some("restore sessions"));

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn claude_uses_first_explicit_user_prompt() {
        let home = temp_home();
        let repo = "/repo";
        let dir = home.join(".claude/projects/-repo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("session-1.jsonl"),
            concat!(
                "{\"type\":\"mode\",\"sessionId\":\"session-1\"}\n",
                "{\"type\":\"user\",\"cwd\":\"/repo\",\"timestamp\":\"2026-08-07T12:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"Is this more about being able to restore sessions?\"}}\n"
            ),
        )
        .unwrap();
        let started = parse_timestamp_ms("2026-08-07T12:00:00Z").unwrap();

        let sessions_dir = home.join(".claude/sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        fs::write(
            sessions_dir.join("42.json"),
            "{\"sessionId\":\"session-1\",\"cwd\":\"/repo\"}",
        )
        .unwrap();

        let found = resolve_session_title_from_home(&home, "claude", repo, started, None, Some(42))
            .unwrap();
        assert_eq!(found.session_id, "session-1");
        assert_eq!(found.title.as_deref(), Some("restore sessions"));

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn claude_project_directory_replaces_every_non_alphanumeric_character() {
        assert_eq!(
            claude_project_directory("/Users/doug.dement/dev/my_repo v2"),
            "-Users-doug-dement-dev-my-repo-v2"
        );
    }

    #[test]
    fn claude_finds_transcripts_when_the_repo_path_contains_dots() {
        let home = temp_home();
        let repo = "/Users/doug.dement/dev/testing";
        let dir = home
            .join(".claude/projects")
            .join("-Users-doug-dement-dev-testing");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("session-1.jsonl"),
            concat!(
                "{\"type\":\"mode\",\"sessionId\":\"session-1\"}\n",
                "{\"type\":\"user\",\"cwd\":\"/Users/doug.dement/dev/testing\",\"timestamp\":\"2026-08-07T12:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"Is this more about being able to restore sessions?\"}}\n"
            ),
        )
        .unwrap();
        let started = parse_timestamp_ms("2026-08-07T12:00:00Z").unwrap();

        let found =
            resolve_session_title_from_home(&home, "claude", repo, started, None, None).unwrap();
        assert_eq!(found.session_id, "session-1");
        assert_eq!(found.title.as_deref(), Some("restore sessions"));

        fs::remove_dir_all(home).unwrap();
    }
}
