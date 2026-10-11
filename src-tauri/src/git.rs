use std::path::Path;
use std::process::Command;

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

pub fn status(path: &str) -> GitStatus {
    let output = match Command::new("git")
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
    let output = Command::new("git")
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

pub fn file_diff(path: &str, file_path: &str, staged: bool) -> Result<String, String> {
    let output = if staged {
        Command::new("git")
            .args(["-C", path, "diff", "--cached", "--", file_path])
            .output()
            .map_err(|e| e.to_string())?
    } else {
        // Try normal diff first
        let result = Command::new("git")
            .args(["-C", path, "diff", "--", file_path])
            .output()
            .map_err(|e| e.to_string())?;

        if result.status.success() && result.stdout.is_empty() {
            // Might be untracked — use diff against /dev/null
            Command::new("git")
                .args([
                    "-C",
                    path,
                    "diff",
                    "--no-index",
                    "/dev/null",
                    file_path,
                ])
                .output()
                .map_err(|e| e.to_string())?
        } else {
            result
        }
    };

    // --no-index returns exit code 1 for differences, which is normal
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ── Per-file diff stats ──────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct DiffFileStat {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
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
    let output = Command::new("git")
        .args(["-C", path, "diff", "HEAD", "--numstat"])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        let cached = Command::new("git")
            .args(["-C", path, "diff", "--cached", "--numstat"])
            .output()
            .map_err(|e| e.to_string())?;
        if !cached.status.success() {
            return Ok(vec![]);
        }
        String::from_utf8_lossy(&cached.stdout).to_string()
    };

    let mut stats: Vec<DiffFileStat> = stdout
        .lines()
        .filter_map(|line| parse_numstat_line(line, None))
        .collect();

    for file in changed_files(path)?
        .into_iter()
        .filter(|file| file.area == "untracked")
    {
        let output = Command::new("git")
            .args([
                "-C",
                path,
                "diff",
                "--no-index",
                "--numstat",
                "/dev/null",
                &file.path,
            ])
            .output()
            .map_err(|e| e.to_string())?;

        if output.stdout.is_empty() {
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        stats.extend(
            stdout
                .lines()
                .filter_map(|line| parse_numstat_line(line, Some(&file.path))),
        );
    }

    Ok(stats)
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
