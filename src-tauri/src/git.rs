use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(serde::Serialize, Clone, Default)]
pub struct GitStatus {
    pub is_git_repo: bool,
    pub branch: String,
    pub dirty: bool,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub ahead: u32,
    pub behind: u32,
    /// If this is a worktree, the name of the parent repo (derived from its path)
    pub worktree_parent: Option<String>,
}

/// Git for status and diff reads. Without this, those commands may rewrite the
/// index, which retriggers the watcher and races agents' `git add` on index.lock.
fn read_only_git() -> Command {
    let mut command = Command::new("git");
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command
}

pub fn status(path: &str) -> GitStatus {
    let output = match read_only_git()
        .args(["-C", path, "status", "--porcelain=v2", "--branch"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return GitStatus::default(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branch = String::new();
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;
    let mut staged: u32 = 0;
    let mut unstaged: u32 = 0;
    let mut untracked: u32 = 0;

    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Format: +N -M
            for token in rest.split_whitespace() {
                if let Some(n) = token.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = token.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // Changed entry: XY columns at index 2..4
            let xy: Vec<u8> = line.as_bytes().get(2..4).unwrap_or(b"..").to_vec();
            if xy[0] != b'.' {
                staged += 1;
            }
            if xy[1] != b'.' {
                unstaged += 1;
            }
        } else if line.starts_with("u ") {
            // Unmerged entry — count as both
            staged += 1;
            unstaged += 1;
        } else if line.starts_with("? ") {
            untracked += 1;
        }
    }

    let dirty = staged > 0 || unstaged > 0 || untracked > 0;

    // Detect if this is a worktree by checking if .git is a file (not a directory)
    let git_path = std::path::Path::new(path).join(".git");
    let worktree_parent = if git_path.is_file() {
        // This is a worktree — resolve the main repo path via git-common-dir
        Command::new("git")
            .args(["-C", path, "rev-parse", "--git-common-dir"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let common = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    // common is something like /path/to/main-repo/.git
                    // Get the parent directory name
                    std::path::Path::new(&common)
                        .parent()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().to_string())
                } else {
                    None
                }
            })
    } else {
        None
    };

    GitStatus {
        is_git_repo: true,
        branch,
        dirty,
        staged,
        unstaged,
        untracked,
        ahead,
        behind,
        worktree_parent,
    }
}

pub fn is_git_repo(path: &str) -> bool {
    Command::new("git")
        .args(["-C", path, "rev-parse", "--git-dir"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn init_repo(path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "init", "-b", "main"])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if stderr.contains("unknown switch `b'") || stderr.contains("unknown option `b'") {
        let fallback = Command::new("git")
            .args(["-C", path, "init"])
            .output()
            .map_err(|e| e.to_string())?;

        if fallback.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&fallback.stderr).to_string())
        }
    } else {
        Err(stderr)
    }
}

pub fn current_branch(path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-C", path, "branch", "--show-current"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn list_branches(path: &str) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .args(["-C", path, "branch", "--format=%(refname:short)"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    Ok(branches)
}

pub fn push_branch(path: &str, branch: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "push", "-u", "origin", branch])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

// ── Worktree listing ─────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
    pub is_main: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct CreatedWorktree {
    pub path: String,
    pub branch: String,
}

pub fn list_worktrees(path: &str) -> Result<Vec<WorktreeEntry>, String> {
    let output = Command::new("git")
        .args(["-C", path, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            let canonical_path = Path::new(rest)
                .canonicalize()
                .unwrap_or_else(|_| Path::new(rest).to_path_buf())
                .to_string_lossy()
                .to_string();
            // Flush previous entry
            if let Some(p) = current_path.take() {
                entries.push(WorktreeEntry {
                    path: p,
                    branch: current_branch.take(),
                    is_main: entries.is_empty(),
                });
            }
            current_path = Some(canonical_path);
            current_branch = None;
        } else if let Some(rest) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(rest.to_string());
        }
        // We ignore HEAD, bare, detached, etc.
    }

    // Flush last entry
    if let Some(p) = current_path.take() {
        entries.push(WorktreeEntry {
            path: p,
            branch: current_branch.take(),
            is_main: entries.is_empty(),
        });
    }

    Ok(entries)
}

pub fn create_worktree(path: &str, branch_name: &str) -> Result<CreatedWorktree, String> {
    let branch_name = branch_name.trim();
    if branch_name.is_empty() {
        return Err("Branch name is required".to_string());
    }

    let validate = Command::new("git")
        .args(["-C", path, "check-ref-format", "--branch", branch_name])
        .output()
        .map_err(|e| e.to_string())?;
    if !validate.status.success() {
        let stderr = String::from_utf8_lossy(&validate.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Invalid branch name: {branch_name}")
        } else {
            stderr
        });
    }

    // Always derive the output path from the main repo, not the calling worktree,
    // so all worktrees end up in the same .shep-worktrees/<repo>/ directory.
    let main_repo_path = {
        let out = Command::new("git")
            .args(["-C", path, "worktree", "list", "--porcelain"])
            .output()
            .map_err(|e| format!("Failed to list worktrees: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        stdout
            .lines()
            .find_map(|l| l.strip_prefix("worktree ").map(|p| std::path::PathBuf::from(p.trim())))
            .ok_or_else(|| "Could not determine main repo path".to_string())?
    };

    let repo_name = main_repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Could not determine repo name".to_string())?;
    let repo_parent = main_repo_path
        .parent()
        .ok_or_else(|| "Could not determine repo parent".to_string())?;

    let branch_slug = branch_name
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => c,
            _ => '-',
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let branch_slug = if branch_slug.is_empty() {
        "worktree".to_string()
    } else {
        branch_slug
    };

    let worktree_path = repo_parent
        .join(".shep-worktrees")
        .join(repo_name)
        .join(branch_slug);

    if worktree_path.exists() {
        return Err(format!("Worktree path already exists: {}", worktree_path.display()));
    }

    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create worktree directory: {e}"))?;
    }

    let worktree_path_string = worktree_path.to_string_lossy().to_string();
    let output = Command::new("git")
        .args(["-C", path, "worktree", "add", "-b", branch_name, &worktree_path_string])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(CreatedWorktree {
        path: worktree_path_string,
        branch: branch_name.to_string(),
    })
}

// ── Changed files (porcelain v2 parsing) ────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub area: String,
    pub old_path: Option<String>,
}

pub fn changed_files(path: &str) -> Result<Vec<ChangedFile>, String> {
    // `--untracked-files=all` expands untracked directories into their
    // individual file entries. Without this, git returns `foo/` as a
    // single directory entry when a whole folder is untracked, and that
    // trailing-slash "folder" leaks into our file list. Gitignored files
    // inside the directory are still excluded.
    let output = read_only_git()
        .args([
            "-C",
            path,
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
            "-z",
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();

    // -z uses NUL as delimiter; split on NUL
    let entries: Vec<&str> = stdout.split('\0').collect();
    let mut i = 0;

    while i < entries.len() {
        let entry = entries[i];
        if entry.is_empty() {
            i += 1;
            continue;
        }

        if entry.starts_with("1 ") {
            // Ordinary changed entry: 1 XY sub mH mI mW hH hI path
            let parts: Vec<&str> = entry.splitn(9, ' ').collect();
            if parts.len() >= 9 {
                let xy = parts[1].as_bytes();
                if xy.len() < 2 { i += 1; continue; }
                let file_path = parts[8].to_string();

                if xy[0] != b'.' {
                    files.push(ChangedFile {
                        path: file_path.clone(),
                        status: status_letter(xy[0]),
                        area: "staged".to_string(),
                        old_path: None,
                    });
                }
                if xy[1] != b'.' {
                    files.push(ChangedFile {
                        path: file_path,
                        status: status_letter(xy[1]),
                        area: "unstaged".to_string(),
                        old_path: None,
                    });
                }
            }
            i += 1;
        } else if entry.starts_with("2 ") {
            // Rename/copy entry: 2 XY sub mH mI mW hH hI Xscore path\0origPath
            let parts: Vec<&str> = entry.splitn(10, ' ').collect();
            if parts.len() >= 10 {
                let xy = parts[1].as_bytes();
                if xy.len() < 2 { i += 1; continue; }
                let file_path = parts[9].to_string();
                // The original path follows as the next NUL-delimited field
                let old_path = entries.get(i + 1).map(|s| s.to_string());

                if xy[0] != b'.' {
                    files.push(ChangedFile {
                        path: file_path.clone(),
                        status: "R".to_string(),
                        area: "staged".to_string(),
                        old_path: old_path.clone(),
                    });
                }
                if xy[1] != b'.' {
                    files.push(ChangedFile {
                        path: file_path,
                        status: "R".to_string(),
                        area: "unstaged".to_string(),
                        old_path,
                    });
                }
                i += 2; // skip the old_path entry
            } else {
                i += 1;
            }
        } else if entry.starts_with("u ") {
            // Unmerged entry: u XY sub m1 m2 m3 mW h1 h2 h3 path
            let parts: Vec<&str> = entry.splitn(11, ' ').collect();
            if parts.len() >= 11 {
                let file_path = parts[10].to_string();
                files.push(ChangedFile {
                    path: file_path.clone(),
                    status: "U".to_string(),
                    area: "unstaged".to_string(),
                    old_path: None,
                });
            }
            i += 1;
        } else if let Some(rest) = entry.strip_prefix("? ") {
            let file_path = rest.to_string();
            files.push(ChangedFile {
                path: file_path,
                status: "?".to_string(),
                area: "untracked".to_string(),
                old_path: None,
            });
            i += 1;
        } else {
            i += 1;
        }
    }

    Ok(files)
}

fn status_letter(byte: u8) -> String {
    match byte {
        b'M' => "M",
        b'A' => "A",
        b'D' => "D",
        b'R' => "R",
        b'C' => "C",
        b'T' => "T",
        _ => "M",
    }
    .to_string()
}

const MAX_DIFF_BYTES: usize = 200 * 1024;
const MAX_DIFF_LINES: usize = 4_000;
const DIFF_TIMEOUT: Duration = Duration::from_secs(5);

fn bounded_diff(path: &str, args: &[&str]) -> Result<String, String> {
    let mut child = read_only_git()
        .args(["-C", path, "diff", "--no-ext-diff", "--no-textconv", "--no-color"])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("Git output unavailable")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take((MAX_DIFF_BYTES + 1) as u64).read_to_end(&mut bytes).map(|_| bytes);
        let _ = tx.send(result);
    });
    let result = rx.recv_timeout(DIFF_TIMEOUT);
    if !matches!(&result, Ok(Ok(bytes)) if bytes.len() <= MAX_DIFF_BYTES) {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|e| e.to_string());
    let _ = reader.join();
    let bytes = result.map_err(|_| "Diff took too long. Open this file in your editor.".to_string())?
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_DIFF_BYTES {
        return Err("Diff is too large to preview. Open this file in your editor.".into());
    }
    // --no-index returns 1 for differences.
    let code = status?.code();
    if code != Some(0) && !(code == Some(1) && args.contains(&"--no-index")) {
        return Err("Git could not read this diff. Refresh Changes or open the file in your editor.".into());
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    if text.lines().count() > MAX_DIFF_LINES || text.lines().any(|line| line.len() > 4_000) {
        return Err("Diff is too large to preview. Open this file in your editor.".into());
    }
    Ok(text)
}

pub fn file_diff(path: &str, file_path: &str, staged: bool) -> Result<String, String> {
    if staged {
        return bounded_diff(path, &["--cached", "--", file_path]);
    }
    let result = bounded_diff(path, &["--", file_path])?;
    if result.starts_with("diff --cc ") || result.starts_with("diff --combined ") {
        // The renderer accepts unified patches, not Git's combined conflict format.
        return bounded_diff(path, &["--ours", "--", file_path]);
    }
    if result.is_empty() && changed_files(path)?.iter().any(|file| file.path == file_path && file.area == "untracked") {
        return bounded_diff(path, &["--no-index", "--", "/dev/null", file_path]);
    }
    Ok(result)
}

// ── Per-file diff stats ──────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct DiffFileStat {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChanges {
    pub files: Vec<ChangedFile>,
    pub stats: Vec<DiffFileStat>,
    pub stats_complete: bool,
}

fn parse_numstat_line(line: &str, fallback_path: Option<&str>) -> Option<DiffFileStat> {
    let parts: Vec<&str> = line.splitn(3, '\t').collect();
    if parts.len() != 3 {
        return None;
    }
    // Binary files report "-" instead of a count — treat as 0.
    let additions: u32 = parts[0].parse().unwrap_or(0);
    let deletions: u32 = parts[1].parse().unwrap_or(0);
    Some(DiffFileStat {
        path: fallback_path.unwrap_or(parts[2]).to_string(),
        additions,
        deletions,
    })
}

/// Returns addition/deletion line counts per changed file. Uses `git diff HEAD
/// --numstat` (all changes vs HEAD) so staged and unstaged changes are combined.
/// Falls back to `--cached` on repos with no HEAD yet (first commit pending).
pub fn diff_stats(path: &str) -> Result<Vec<DiffFileStat>, String> {
    Ok(changes(path)?.stats)
}

pub fn changes(path: &str) -> Result<GitChanges, String> {
    let files = changed_files(path)?;
    let output = read_only_git()
        .args(["-C", path, "diff", "HEAD", "--numstat"])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        let cached = read_only_git()
            .args(["-C", path, "diff", "--cached", "--numstat"])
            .output()
            .map_err(|e| e.to_string())?;
        if !cached.status.success() {
            return Err("Git could not calculate change totals".into());
        }
        String::from_utf8_lossy(&cached.stdout).to_string()
    };

    let mut stats: Vec<DiffFileStat> = stdout
        .lines()
        .filter_map(|line| parse_numstat_line(line, None))
        .collect();

    // Count untracked text directly instead of launching a process for every file.
    // Bound each scan and the aggregate work; disclose incomplete totals to the UI.
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut budget = 32 * 1024 * 1024u64;
    let mut stats_complete = true;
    for file in files.iter().filter(|file| file.area == "untracked") {
        let full_path = Path::new(path).join(&file.path);
        let count = if Instant::now() < deadline { untracked_lines(&full_path, &mut budget) } else { None };
        match count {
            Some(additions) => stats.push(DiffFileStat { path: file.path.clone(), additions, deletions: 0 }),
            None => stats_complete = false,
        }
    }

    Ok(GitChanges { files, stats, stats_complete })
}

fn untracked_lines(path: &Path, budget: &mut u64) -> Option<u32> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() { return Some(1); }
    if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 || metadata.len() > *budget { return None; }
    let mut reader = BufReader::new(std::fs::File::open(path).ok()?.take(metadata.len() + 1));
    let mut count = 0;
    let mut last = None;
    let mut read = 0;
    loop {
        let chunk = reader.fill_buf().ok()?;
        if chunk.is_empty() { break; }
        if chunk.contains(&0) { return Some(0); }
        let len = chunk.len();
        read += len as u64;
        if read > metadata.len() { return None; }
        count += chunk.iter().filter(|&&byte| byte == b'\n').count() as u32;
        last = chunk.last().copied();
        reader.consume(len);
    }
    *budget = budget.saturating_sub(read);
    Some(count + u32::from(last.is_some() && last != Some(b'\n')))
}

pub fn stage_file(path: &str, file_path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "add", "--", file_path])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

pub fn stage_all(path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "add", "-A"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

pub fn commit(path: &str, message: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "commit", "-m", message])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(())
}

pub fn unstage_file(path: &str, file_path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "restore", "--staged", "--", file_path])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

pub fn unstage_all(path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "restore", "--staged", "."])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(())
}

pub fn switch_branch(path: &str, branch_name: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "switch", branch_name])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(())
}

pub fn create_branch(path: &str, branch_name: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["-C", path, "switch", "-c", branch_name])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(())
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Repo(PathBuf);
    impl Repo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("shep-git-review-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&path).unwrap();
            let repo = Self(path);
            repo.git(&["init", "-q", "-b", "main"]);
            repo
        }
        fn path(&self) -> &str { self.0.to_str().unwrap() }
        fn git(&self, args: &[&str]) {
            assert!(Command::new("git").args(["-C", self.path(), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"])
                .args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap().status.success());
        }
        fn write(&self, file: &str, text: &[u8]) { std::fs::write(self.0.join(file), text).unwrap(); }
    }
    impl Drop for Repo { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[test]
    fn bounded_diffs_cover_tracked_staged_and_untracked_files() {
        let repo = Repo::new();
        repo.write("file.txt", b"before\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("file.txt", b"after\n");
        assert!(file_diff(repo.path(), "file.txt", false).unwrap().contains("+after"));
        repo.git(&["add", "."]);
        assert!(file_diff(repo.path(), "file.txt", true).unwrap().contains("+after"));
        assert!(file_diff(repo.path(), "file.txt", false).unwrap().is_empty());
        repo.write("new.txt", b"new\n");
        assert!(file_diff(repo.path(), "new.txt", false).unwrap().contains("+new"));
        repo.write("huge.txt", &vec![b'x'; MAX_DIFF_BYTES + 1]);
        assert!(file_diff(repo.path(), "huge.txt", false).unwrap_err().contains("too large"));
        repo.write("many-lines.txt", "x\n".repeat(MAX_DIFF_LINES + 1).as_bytes());
        assert!(file_diff(repo.path(), "many-lines.txt", false).unwrap_err().contains("too large"));
    }

    #[test]
    fn untracked_stats_count_text_and_disclose_scan_limits() {
        let repo = Repo::new();
        repo.write("new.txt", b"one\ntwo");
        repo.write("binary", b"\0binary");
        let snapshot = changes(repo.path()).unwrap();
        assert!(snapshot.stats_complete);
        assert_eq!(snapshot.stats.iter().find(|s| s.path == "new.txt").unwrap().additions, 2);
        assert_eq!(snapshot.stats.iter().find(|s| s.path == "binary").unwrap().additions, 0);
        let large = std::fs::File::create(repo.0.join("large")).unwrap();
        large.set_len(9 * 1024 * 1024).unwrap();
        assert!(!changes(repo.path()).unwrap().stats_complete);
    }

    #[test]
    fn merge_conflicts_return_unified_hunks_with_conflict_markers() {
        let repo = Repo::new();
        repo.write("conflict.txt", b"base\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-qb", "other"]);
        repo.write("conflict.txt", b"theirs\n");
        repo.git(&["commit", "-qam", "other"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("conflict.txt", b"ours\n");
        repo.git(&["commit", "-qam", "ours"]);
        let merge = Command::new("git").args(["-C", repo.path(), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "merge", "other"]).output().unwrap();
        assert!(!merge.status.success());
        let diff = file_diff(repo.path(), "conflict.txt", false).unwrap();
        assert!(diff.contains("@@ -"), "{diff}");
        assert!(diff.contains("+<<<<<<<"), "{diff}");
        assert!(!diff.contains("@@@"));
    }
}
