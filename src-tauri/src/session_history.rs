use crate::usage::UsageDb;
use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryUpsert {
    pub provider: String,
    pub session_id: String,
    pub project_path: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub started_at: i64,
    pub last_activity_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryEntry {
    pub provider: String,
    pub session_id: String,
    pub project_path: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub started_at: i64,
    pub last_activity_at: i64,
    pub ended_at: Option<i64>,
}

fn clean_required(value: &str, field: &str) -> Result<String, String> {
    let cleaned = value.trim();
    if cleaned.is_empty() {
        return Err(format!("Session history {field} cannot be empty"));
    }
    Ok(cleaned.to_string())
}

fn clean_optional(value: Option<String>, max_chars: usize) -> Option<String> {
    let normalized = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.chars().take(max_chars).collect())
}

pub fn upsert(db: &UsageDb, record: SessionHistoryUpsert) -> Result<(), String> {
    let provider = clean_required(&record.provider, "provider")?;
    let session_id = clean_required(&record.session_id, "session ID")?;
    let project_path = clean_required(&record.project_path, "project path")?;
    if record.started_at <= 0 || record.last_activity_at <= 0 {
        return Err("Session history timestamps must be positive".to_string());
    }
    let title = clean_optional(record.title, 240);
    let model = clean_optional(record.model, 160);
    let last_activity_at = record.last_activity_at.max(record.started_at);

    let conn = db
        .conn
        .lock()
        .map_err(|_| "Session history database lock was poisoned".to_string())?;
    conn.execute(
        "INSERT INTO session_history (
            provider, session_id, project_path, title, model, started_at,
            last_activity_at, ended_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?6, ?7)
         ON CONFLICT(provider, session_id) DO UPDATE SET
            project_path = excluded.project_path,
            title = COALESCE(excluded.title, session_history.title),
            model = COALESCE(excluded.model, session_history.model),
            started_at = MIN(session_history.started_at, excluded.started_at),
            last_activity_at = MAX(session_history.last_activity_at, excluded.last_activity_at),
            ended_at = NULL,
            updated_at = MAX(session_history.updated_at, excluded.updated_at)",
        params![
            provider,
            session_id,
            project_path,
            title,
            model,
            record.started_at,
            last_activity_at,
        ],
    )
    .map_err(|error| format!("Failed to save session history: {error}"))?;
    Ok(())
}

pub fn record_activity(
    db: &UsageDb,
    provider: &str,
    session_id: &str,
    timestamp: i64,
    ended: bool,
) -> Result<(), String> {
    let provider = clean_required(provider, "provider")?;
    let session_id = clean_required(session_id, "session ID")?;
    if timestamp <= 0 {
        return Err("Session history timestamp must be positive".to_string());
    }

    let conn = db
        .conn
        .lock()
        .map_err(|_| "Session history database lock was poisoned".to_string())?;
    conn.execute(
        "UPDATE session_history SET
            last_activity_at = MAX(last_activity_at, ?3),
            ended_at = CASE WHEN ?4 THEN ?3 ELSE NULL END,
            updated_at = MAX(updated_at, ?3)
         WHERE provider = ?1 AND session_id = ?2",
        params![provider, session_id, timestamp, ended],
    )
    .map_err(|error| format!("Failed to update session history activity: {error}"))?;
    Ok(())
}

pub fn list(
    db: &UsageDb,
    project_path: Option<&str>,
    query: Option<&str>,
    limit: Option<u32>,
) -> Result<Vec<SessionHistoryEntry>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "Session history database lock was poisoned".to_string())?;
    list_from_connection(&conn, project_path, query, limit)
}

fn list_from_connection(
    conn: &Connection,
    project_path: Option<&str>,
    query: Option<&str>,
    limit: Option<u32>,
) -> Result<Vec<SessionHistoryEntry>, String> {
    let limit = i64::from(limit.unwrap_or(50).clamp(1, 200));
    let columns = "provider, session_id, project_path, title, model,
                   started_at, last_activity_at, ended_at";
    let project = project_path.map(str::trim).filter(|path| !path.is_empty());
    let query = query.map(str::trim).filter(|value| !value.is_empty());
    let mut filters = Vec::new();
    let mut values = Vec::new();

    if let Some(project) = project {
        values.push(Value::Text(project.to_string()));
        filters.push(format!("project_path = ?{}", values.len()));
    }

    if let Some(query) = query {
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        values.push(Value::Text(format!("%{escaped}%")));
        let parameter = format!("?{}", values.len());
        filters.push(format!(
            "(title LIKE {parameter} ESCAPE '\\' COLLATE NOCASE
              OR provider LIKE {parameter} ESCAPE '\\' COLLATE NOCASE
              OR project_path LIKE {parameter} ESCAPE '\\' COLLATE NOCASE
              OR model LIKE {parameter} ESCAPE '\\' COLLATE NOCASE)"
        ));
    }

    let mut sql = format!("SELECT {columns} FROM session_history");
    if !filters.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&filters.join(" AND "));
    }
    values.push(Value::Integer(limit));
    sql.push_str(&format!(
        " ORDER BY last_activity_at DESC LIMIT ?{}",
        values.len()
    ));

    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare session history query: {error}"))?;
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(SessionHistoryEntry {
            provider: row.get(0)?,
            session_id: row.get(1)?,
            project_path: row.get(2)?,
            title: row.get(3)?,
            model: row.get(4)?,
            started_at: row.get(5)?,
            last_activity_at: row.get(6)?,
            ended_at: row.get(7)?,
        })
    };
    let rows = statement
        .query_map(params_from_iter(values.iter()), map_row)
        .map_err(|error| format!("Failed to query session history: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read session history: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(
        provider: &str,
        session_id: &str,
        project_path: &str,
        title: Option<&str>,
        model: Option<&str>,
        started_at: i64,
        last_activity_at: i64,
    ) -> SessionHistoryUpsert {
        SessionHistoryUpsert {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            project_path: project_path.to_string(),
            title: title.map(ToString::to_string),
            model: model.map(ToString::to_string),
            started_at,
            last_activity_at,
        }
    }

    #[test]
    fn upserts_lists_and_ends_sessions() {
        let db = UsageDb::open_in_memory();
        upsert(
            &db,
            record("codex", "session-1", "/repo", None, None, 1_000, 1_100),
        )
        .unwrap();
        upsert(
            &db,
            record(
                "codex",
                "session-1",
                "/repo",
                Some("  Fix   auth tokens  "),
                Some("gpt-5"),
                900,
                1_200,
            ),
        )
        .unwrap();
        upsert(
            &db,
            record(
                "claude",
                "session-2",
                "/other",
                Some("Other task"),
                None,
                1_300,
                1_400,
            ),
        )
        .unwrap();
        record_activity(&db, "codex", "session-1", 1_500, true).unwrap();

        let project_rows = list(&db, Some("/repo"), None, Some(10)).unwrap();
        assert_eq!(project_rows.len(), 1);
        assert_eq!(
            project_rows[0],
            SessionHistoryEntry {
                provider: "codex".to_string(),
                session_id: "session-1".to_string(),
                project_path: "/repo".to_string(),
                title: Some("Fix auth tokens".to_string()),
                model: Some("gpt-5".to_string()),
                started_at: 900,
                last_activity_at: 1_500,
                ended_at: Some(1_500),
            }
        );

        let all_rows = list(&db, None, None, Some(10)).unwrap();
        assert_eq!(all_rows.len(), 2);
        assert_eq!(all_rows[0].session_id, "session-1");
        assert_eq!(all_rows[1].session_id, "session-2");
    }

    #[test]
    fn searches_every_saved_session_before_applying_the_limit() {
        let db = UsageDb::open_in_memory();
        upsert(
            &db,
            record(
                "claude",
                "older-match",
                "/archive",
                Some("Needle migration"),
                Some("Claude Opus"),
                1,
                1,
            ),
        )
        .unwrap();

        for index in 0..205 {
            upsert(
                &db,
                record(
                    "codex",
                    &format!("recent-{index}"),
                    "/repo",
                    Some("Routine task"),
                    Some("gpt-5"),
                    index + 2,
                    index + 2,
                ),
            )
            .unwrap();
        }

        let recent = list(&db, None, None, Some(200)).unwrap();
        assert_eq!(recent.len(), 200);
        assert!(!recent.iter().any(|entry| entry.session_id == "older-match"));

        let matches = list(&db, None, Some("needle"), Some(200)).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].session_id, "older-match");
    }

    #[test]
    fn search_respects_project_scope_and_treats_wildcards_literally() {
        let db = UsageDb::open_in_memory();
        upsert(
            &db,
            record(
                "opencode",
                "literal-match",
                "/repo",
                Some("Reach 100% coverage"),
                None,
                10,
                10,
            ),
        )
        .unwrap();
        upsert(
            &db,
            record(
                "opencode",
                "wildcard-only",
                "/repo",
                Some("Reach 100 percent coverage"),
                None,
                20,
                20,
            ),
        )
        .unwrap();
        upsert(
            &db,
            record(
                "opencode",
                "other-project",
                "/other",
                Some("Reach 100% coverage"),
                None,
                30,
                30,
            ),
        )
        .unwrap();

        let matches = list(&db, Some("/repo"), Some("100%"), Some(200)).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].session_id, "literal-match");
    }

    #[test]
    fn rejects_incomplete_records() {
        let db = UsageDb::open_in_memory();
        let error = upsert(&db, record("", "session-1", "/repo", None, None, 1, 1)).unwrap_err();
        assert!(error.contains("provider"));
    }
}
