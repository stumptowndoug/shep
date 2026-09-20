use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::Emitter;

const DEBOUNCE_MS: u64 = 500;
const FALLBACK_POLL_SECS: u64 = 60;

/// Paths inside `.git/` to allow through the filter (branch switches, new commits, worktree changes).
const GIT_PASSTHROUGH: &[&str] = &["HEAD", "refs", "worktrees"];

/// Directories to ignore entirely — high-churn build artifacts.
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".next",
    "dist",
    "output",
    "coverage",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
];

#[derive(serde::Serialize, Clone)]
pub struct FsChangedPayload {
    pub paths: Vec<String>,
    #[serde(rename = "todoPaths")]
    pub todo_paths: Vec<String>,
}

struct WatchSignal {
    repo_root: PathBuf,
    todo_changed: bool,
}

pub struct GitWatcher {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched_paths: Arc<Mutex<HashSet<PathBuf>>>,
    shutdown: Arc<AtomicBool>,
}

impl GitWatcher {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let shutdown = Arc::new(AtomicBool::new(false));
        let watched_paths = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));

        // Channel for raw FS events → debounce thread
        let (tx, rx) = std::sync::mpsc::channel::<WatchSignal>();

        // --- Debounce thread ---
        let debounce_app = app_handle.clone();
        let debounce_shutdown = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            let mut pending: HashMap<PathBuf, bool> = HashMap::new();

            loop {
                if debounce_shutdown.load(Ordering::Relaxed) {
                    break;
                }

                match rx.recv_timeout(Duration::from_millis(DEBOUNCE_MS)) {
                    Ok(signal) => {
                        pending
                            .entry(signal.repo_root)
                            .and_modify(|changed| *changed |= signal.todo_changed)
                            .or_insert(signal.todo_changed);
                        // Drain any immediately available events
                        while let Ok(signal) = rx.try_recv() {
                            pending
                                .entry(signal.repo_root)
                                .and_modify(|changed| *changed |= signal.todo_changed)
                                .or_insert(signal.todo_changed);
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if !pending.is_empty() {
                            let (paths, todo_paths) = drain_pending(&mut pending);
                            let _ = debounce_app
                                .emit("git-fs-changed", FsChangedPayload { paths, todo_paths });
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }

            // Flush any remaining
            if !pending.is_empty() {
                let (paths, todo_paths) = drain_pending(&mut pending);
                let _ = debounce_app.emit("git-fs-changed", FsChangedPayload { paths, todo_paths });
            }
        });

        // --- Fallback poll thread ---
        let poll_app = app_handle.clone();
        let poll_shutdown = Arc::clone(&shutdown);
        let poll_watched = Arc::clone(&watched_paths);
        std::thread::spawn(move || {
            loop {
                // Sleep in small increments so we can check shutdown flag
                for _ in 0..(FALLBACK_POLL_SECS * 10) {
                    if poll_shutdown.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }

                let watched = poll_watched.lock().unwrap();
                if !watched.is_empty() {
                    let paths: Vec<String> = watched
                        .iter()
                        .map(|p| p.to_string_lossy().to_string())
                        .collect();
                    let _ = poll_app.emit(
                        "git-fs-changed",
                        FsChangedPayload {
                            paths,
                            todo_paths: Vec::new(),
                        },
                    );
                }
            }
        });

        // --- Create notify watcher ---
        let watcher_watched = Arc::clone(&watched_paths);
        let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            let event = match res {
                Ok(e) => e,
                Err(_) => return,
            };

            for path in &event.paths {
                if !should_watch_path(path) {
                    continue;
                }

                // Map the event path back to a watched repo root
                let watched = watcher_watched.lock().unwrap();
                for root in watched.iter() {
                    if path.starts_with(root) {
                        let _ = tx.send(WatchSignal {
                            repo_root: root.clone(),
                            todo_changed: is_todo_path(path),
                        });
                        break;
                    }
                }
            }
        })
        .ok();

        GitWatcher {
            watcher: Mutex::new(watcher),
            watched_paths,
            shutdown,
        }
    }

    pub fn watch(&self, path: &str) -> Result<(), String> {
        let path_buf = PathBuf::from(path);
        let mut watched = self.watched_paths.lock().unwrap();

        if watched.contains(&path_buf) {
            return Ok(());
        }

        let mut watcher_guard = self.watcher.lock().unwrap();
        if let Some(ref mut watcher) = *watcher_guard {
            watcher
                .watch(&path_buf, RecursiveMode::Recursive)
                .map_err(|e| format!("Failed to watch {path}: {e}"))?;
        }

        watched.insert(path_buf);
        Ok(())
    }

    pub fn unwatch(&self, path: &str) -> Result<(), String> {
        let path_buf = PathBuf::from(path);
        let mut watched = self.watched_paths.lock().unwrap();

        if !watched.remove(&path_buf) {
            return Ok(());
        }

        let mut watcher_guard = self.watcher.lock().unwrap();
        if let Some(ref mut watcher) = *watcher_guard {
            let _ = watcher.unwatch(&path_buf);
        }

        Ok(())
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        let mut watcher_guard = self.watcher.lock().unwrap();
        *watcher_guard = None;
        self.watched_paths.lock().unwrap().clear();
    }
}

fn drain_pending(pending: &mut HashMap<PathBuf, bool>) -> (Vec<String>, Vec<String>) {
    let mut paths = Vec::with_capacity(pending.len());
    let mut todo_paths = Vec::new();
    for (path, todo_changed) in pending.drain() {
        let path = path.to_string_lossy().to_string();
        if todo_changed {
            todo_paths.push(path.clone());
        }
        paths.push(path);
    }
    (paths, todo_paths)
}

fn is_todo_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name.to_ascii_lowercase().as_str(), "todo.md" | "todos.md"))
}

/// Determine whether a filesystem event path should trigger a git refresh.
fn should_watch_path(path: &Path) -> bool {
    let components: Vec<&str> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();

    for (i, comp) in components.iter().enumerate() {
        if IGNORED_DIRS.contains(comp) {
            return false;
        }

        // Inside .git: only allow HEAD and refs through
        if *comp == ".git" {
            if i + 1 >= components.len() {
                return false;
            }
            let next = components[i + 1];
            return GIT_PASSTHROUGH.contains(&next);
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_todo_markdown_filenames() {
        assert!(is_todo_path(Path::new("/repo/TODO.md")));
        assert!(is_todo_path(Path::new("/repo/docs/todos.MD")));
        assert!(!is_todo_path(Path::new("/repo/notes.md")));
        assert!(!is_todo_path(Path::new("/repo/todo.txt")));
    }

    #[test]
    fn ignores_high_churn_generated_directories() {
        assert!(!should_watch_path(Path::new("/repo/output/run/result.json")));
        assert!(!should_watch_path(Path::new("/repo/.venv/lib/module.py")));
        assert!(should_watch_path(Path::new("/repo/src/module.rs")));
    }

    #[test]
    fn drains_todo_roots_separately_from_general_refreshes() {
        let mut pending = HashMap::from([
            (PathBuf::from("/repo/a"), false),
            (PathBuf::from("/repo/b"), true),
        ]);
        let (mut paths, todo_paths) = drain_pending(&mut pending);
        paths.sort();
        assert_eq!(paths, vec!["/repo/a", "/repo/b"]);
        assert_eq!(todo_paths, vec!["/repo/b"]);
        assert!(pending.is_empty());
    }
}
