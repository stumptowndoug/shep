use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeStatus {
    pub status: String,
    pub status_updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionRecord {
    pid: Option<u32>,
    cwd: Option<String>,
    session_id: Option<String>,
    status: Option<String>,
    status_updated_at: Option<i64>,
}

impl ClaudeSessionRecord {
    fn runtime_status(&self) -> Option<AgentRuntimeStatus> {
        let status = self.status.as_deref()?.trim().to_ascii_lowercase();
        let status_updated_at = self.status_updated_at?;
        if status.is_empty() || status_updated_at <= 0 {
            return None;
        }
        Some(AgentRuntimeStatus {
            status,
            status_updated_at,
        })
    }

    fn matches(&self, repo_path: &str, session_id: Option<&str>) -> bool {
        if self.cwd.as_deref() != Some(repo_path) {
            return false;
        }
        session_id.is_none_or(|expected| self.session_id.as_deref() == Some(expected))
    }
}

pub fn resolve(
    assistant_id: &str,
    repo_path: &str,
    session_id: Option<&str>,
    process_id: Option<u32>,
) -> Option<AgentRuntimeStatus> {
    if assistant_id != "claude" {
        return None;
    }
    let home = dirs::home_dir()?;
    resolve_claude_from_home(&home, repo_path, session_id, process_id)
}

fn read_record(path: &Path) -> Option<ClaudeSessionRecord> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn resolve_claude_from_home(
    home: &Path,
    repo_path: &str,
    session_id: Option<&str>,
    process_id: Option<u32>,
) -> Option<AgentRuntimeStatus> {
    let sessions_dir = home.join(".claude/sessions");

    if let Some(pid) = process_id {
        if let Some(record) = read_record(&sessions_dir.join(format!("{pid}.json"))) {
            if record.pid == Some(pid) && record.matches(repo_path, session_id) {
                return record.runtime_status();
            }
        }
    }

    let mut matches = fs::read_dir(&sessions_dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                return None;
            }
            let record = read_record(&path)?;
            record.matches(repo_path, session_id).then_some(record)
        })
        .collect::<Vec<_>>();

    // A known provider session ID is an unambiguous fallback. Without one,
    // only accept a unique cwd match so parallel Claude tabs cannot inherit
    // each other's state.
    if session_id.is_none() && matches.len() != 1 {
        return None;
    }
    matches.sort_by_key(|record| record.status_updated_at.unwrap_or_default());
    matches.pop()?.runtime_status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
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
            "shep-agent-status-{}-{nanos}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(path.join(".claude/sessions")).unwrap();
        path
    }

    fn write_record(home: &Path, pid: u32, cwd: &str, session_id: &str, status: &str, at: i64) {
        let json = serde_json::json!({
            "pid": pid,
            "cwd": cwd,
            "sessionId": session_id,
            "status": status,
            "statusUpdatedAt": at,
        });
        fs::write(
            home.join(format!(".claude/sessions/{pid}.json")),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn prefers_the_exact_pty_child_pid() {
        let home = temp_home();
        write_record(&home, 101, "/repo", "session-a", "working", 1_000);
        write_record(&home, 202, "/repo", "session-b", "idle", 2_000);

        assert_eq!(
            resolve_claude_from_home(&home, "/repo", Some("session-a"), Some(101)),
            Some(AgentRuntimeStatus {
                status: "working".to_string(),
                status_updated_at: 1_000,
            })
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn falls_back_to_an_exact_session_id() {
        let home = temp_home();
        write_record(&home, 101, "/repo", "session-a", "working", 1_000);
        write_record(&home, 202, "/repo", "session-b", "idle", 2_000);

        assert_eq!(
            resolve_claude_from_home(&home, "/repo", Some("session-b"), Some(999)),
            Some(AgentRuntimeStatus {
                status: "idle".to_string(),
                status_updated_at: 2_000,
            })
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn rejects_an_ambiguous_cwd_fallback() {
        let home = temp_home();
        write_record(&home, 101, "/repo", "session-a", "working", 1_000);
        write_record(&home, 202, "/repo", "session-b", "idle", 2_000);

        assert_eq!(
            resolve_claude_from_home(&home, "/repo", None, Some(999)),
            None
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn ignores_other_providers() {
        assert_eq!(resolve("codex", "/repo", None, None), None);
    }
}
