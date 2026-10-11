//! Folders the user has recently worked in with their agent CLIs, offered as
//! one-click projects on first run. Read-only: we only look at the session
//! logs Claude Code and Codex already keep.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::loader::load_global_config;

/// Lines read from the top of a log before giving up on finding a cwd.
const MAX_LINES: usize = 40;
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_SCAN_BYTES: u64 = 512 * 1024;
/// Codex keeps one file per session; only the newest are worth reading.
const MAX_CODEX_FILES: usize = 300;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSuggestion {
    pub path: String,
    pub name: String,
    /// Milliseconds since the Unix epoch.
    pub last_used: u64,
    pub agent: String,
}

struct Candidate {
    cwd: String,
    modified: SystemTime,
    agent: &'static str,
}

pub fn suggest_project_folders(limit: usize) -> Result<Vec<FolderSuggestion>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let mut candidates = claude_candidates(&home.join(".claude/projects"));
    candidates.extend(codex_candidates(&home.join(".codex/sessions")));
    candidates.sort_by(|a, b| b.modified.cmp(&a.modified));

    let registered: HashSet<String> = load_global_config()
        .map(|config| config.repos.into_iter().map(|repo| repo.path).collect())
        .unwrap_or_default();

    // Group sessions by repo: newest use and how many sessions ran there.
    let mut by_root: Vec<(FolderSuggestion, usize)> = Vec::new();
    for candidate in candidates {
        let Some(root) = project_root(Path::new(&candidate.cwd), &home) else {
            continue;
        };
        let path = root.to_string_lossy().to_string();
        if registered.contains(&path) {
            continue;
        }
        if let Some(entry) = by_root.iter_mut().find(|(s, _)| s.path == path) {
            entry.1 += 1;
            continue;
        }
        by_root.push((
            FolderSuggestion {
                name: root
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone()),
                path,
                last_used: candidate
                    .modified
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                agent: candidate.agent.to_string(),
            },
            1,
        ));
    }
    // Candidates arrive newest first, so a stable sort on session count keeps
    // recency as the tie-breaker; repos used once rank below repeat ones.
    by_root.sort_by(|a, b| (b.1 > 1).cmp(&(a.1 > 1)));
    Ok(by_root.into_iter().take(limit).map(|(s, _)| s).collect())
}

/// The git repository a session ran in. Only repos count: agent apps also log
/// throwaway chat folders and parent folders like ~/dev, which aren't projects.
fn project_root(cwd: &Path, home: &Path) -> Option<PathBuf> {
    let cwd = cwd.canonicalize().ok()?;
    if !cwd.is_dir() || is_temporary(&cwd) {
        return None;
    }
    let home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let root = cwd
        .ancestors()
        .take_while(|dir| *dir != home)
        .find(|dir| dir.join(".git").exists())
        .map(Path::to_path_buf)?;
    root.starts_with(&home).then_some(root)
}

fn is_temporary(path: &Path) -> bool {
    [
        "/tmp",
        "/private/tmp",
        "/var/folders",
        "/private/var/folders",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
}

/// Claude Code: one directory per working folder, holding session logs whose
/// entries carry the `cwd`. The newest log stands for the directory.
fn claude_candidates(projects_dir: &Path) -> Vec<Candidate> {
    let Ok(entries) = fs::read_dir(projects_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let newest = fs::read_dir(entry.path())
                .ok()?
                .flatten()
                .filter(|file| file.path().extension().is_some_and(|ext| ext == "jsonl"))
                .filter_map(|file| Some((file.metadata().ok()?.modified().ok()?, file.path())))
                .max_by_key(|(modified, _)| *modified)?;
            let cwd = first_cwd(&newest.1, |row| row.get("cwd"))?;
            Some(Candidate {
                cwd,
                modified: newest.0,
                agent: "claude",
            })
        })
        .collect()
}

/// Codex: dated folders of session files whose first event is `session_meta`
/// with the `cwd` in its payload.
fn codex_candidates(sessions_dir: &Path) -> Vec<Candidate> {
    let mut files = Vec::new();
    collect_jsonl(sessions_dir, &mut files, 0);
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files
        .into_iter()
        .take(MAX_CODEX_FILES)
        .filter_map(|(modified, path)| {
            let cwd = first_cwd(&path, |row| row.get("payload")?.get("cwd"))?;
            Some(Candidate {
                cwd,
                modified,
                agent: "codex",
            })
        })
        .collect()
}

fn collect_jsonl(dir: &Path, out: &mut Vec<(SystemTime, PathBuf)>, depth: usize) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out, depth + 1);
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                out.push((modified, path));
            }
        }
    }
}

fn first_cwd(path: &Path, pick: impl Fn(&Value) -> Option<&Value>) -> Option<String> {
    let reader = BufReader::new(File::open(path).ok()?);
    scan_cwd(reader, pick)
}

fn scan_cwd(reader: impl BufRead, pick: impl Fn(&Value) -> Option<&Value>) -> Option<String> {
    let mut reader = reader.take(MAX_SCAN_BYTES);
    for _ in 0..MAX_LINES {
        let mut line = Vec::new();
        let read = (&mut reader)
            .take((MAX_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
            .ok()?;
        if read == 0 || read > MAX_LINE_BYTES {
            return None;
        }
        let Ok(row) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if let Some(cwd) = pick(&row)
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.trim().is_empty())
        {
            return Some(cwd.to_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_log_lines_stop_before_allocating_the_whole_line() {
        let mut reader = std::io::Cursor::new(vec![b'x'; MAX_LINE_BYTES * 100]);
        assert!(scan_cwd(&mut reader, |row| row.get("cwd")).is_none());
        assert_eq!(reader.position(), (MAX_LINE_BYTES + 1) as u64);
    }

    #[test]
    fn project_root_requires_a_repo_and_skips_temp_and_home() {
        let home = dirs::home_dir().unwrap();
        assert!(project_root(Path::new("/tmp"), &home).is_none());
        assert!(project_root(&home, &home).is_none());
        assert!(project_root(Path::new("/definitely/not/here"), &home).is_none());
    }

    #[test]
    fn first_cwd_reads_claude_and_codex_shapes() {
        let dir = std::env::temp_dir().join(format!("shep-suggest-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let claude = dir.join("a.jsonl");
        fs::write(
            &claude,
            "{\"type\":\"summary\"}\n{\"cwd\":\"/work/app\",\"type\":\"user\"}\n",
        )
        .unwrap();
        assert_eq!(
            first_cwd(&claude, |row| row.get("cwd")).as_deref(),
            Some("/work/app")
        );
        let codex = dir.join("b.jsonl");
        fs::write(
            &codex,
            "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/work/api\"}}\n",
        )
        .unwrap();
        assert_eq!(
            first_cwd(&codex, |row| row.get("payload")?.get("cwd")).as_deref(),
            Some("/work/api")
        );
        fs::remove_dir_all(&dir).ok();
    }
}
