use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{Emitter, State};
use url::Url;

use crate::agent_status::{self, AgentRuntimeStatus};
use crate::fonts::{self, FontFaceData, FontFamily};
use crate::git;
use crate::git::{ChangedFile, CreatedWorktree, DiffFileStat, GitStatus, WorktreeEntry};
use crate::pty::manager::PtyManager;
use crate::pty::session::{PtyColorTheme, PtyOutput};
use crate::session_history::{self, SessionHistoryEntry, SessionHistoryUpsert};
use crate::session_titles::{self, SessionTitleMatch};
use crate::skills;
use crate::todos::{self, TodoFile};
use crate::usage::{
    LocalUsageDetails, ProviderUsageSnapshot, UsageDb, UsageOverview, UsageProjectAliasReviewItem,
};
use crate::watcher::GitWatcher;
use crate::workspace::config::{
    normalize_terminal_settings, EditorSettings, GroupEntry, KeybindingSettings, ProjectSettings,
    RegisteredRepo, RepoInfo, TerminalSettings, UsageSettings, WorkspaceConfig,
};
use crate::workspace::manager::WorkspaceManager;

// ── Workspace commands ──────────────────────────────────────────────

#[tauri::command]
pub fn list_repos(workspace: State<'_, WorkspaceManager>) -> Result<Vec<RepoInfo>, String> {
    workspace.list_repos()
}

#[tauri::command]
pub fn register_repo(
    repo_path: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<RegisteredRepo, String> {
    workspace.register_repo(repo_path)
}

#[tauri::command]
pub fn unregister_repo(
    repo_path: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.unregister_repo(repo_path)
}

#[tauri::command]
pub fn load_workspace(
    repo_path: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<WorkspaceConfig, String> {
    workspace.load_workspace(repo_path)
}

#[tauri::command]
pub fn save_workspace(
    repo_path: &str,
    config: WorkspaceConfig,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.save_workspace(repo_path, &config)
}

#[tauri::command]
pub fn get_editor_settings(
    workspace: State<'_, WorkspaceManager>,
) -> Result<EditorSettings, String> {
    workspace.load_editor_settings()
}

#[tauri::command]
pub fn get_project_settings(
    workspace: State<'_, WorkspaceManager>,
) -> Result<ProjectSettings, String> {
    workspace.load_project_settings()
}

#[tauri::command]
pub fn save_editor_settings(
    settings: EditorSettings,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.save_editor_settings(&settings)
}

#[tauri::command]
pub fn save_project_settings(
    settings: ProjectSettings,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.save_project_settings(&settings)
}

#[tauri::command]
pub fn get_keybinding_settings(
    workspace: State<'_, WorkspaceManager>,
) -> Result<KeybindingSettings, String> {
    workspace.load_keybinding_settings()
}

#[tauri::command]
pub fn save_keybinding_settings(
    settings: KeybindingSettings,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.save_keybinding_settings(&settings)
}

#[tauri::command]
pub fn get_terminal_settings(
    workspace: State<'_, WorkspaceManager>,
) -> Result<TerminalSettings, String> {
    let mut settings = workspace.load_terminal_settings()?;
    normalize_terminal_settings(&mut settings);
    Ok(settings)
}

#[tauri::command]
pub fn save_terminal_settings(
    mut settings: TerminalSettings,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    normalize_terminal_settings(&mut settings);
    workspace.save_terminal_settings(&settings)
}

#[tauri::command]
pub fn list_monospace_families() -> Vec<FontFamily> {
    fonts::list_monospace_families()
}

#[tauri::command]
pub async fn load_font_family(family: String) -> Vec<FontFaceData> {
    // Font file reads can total 10+ MB for a large family. Run on the blocking
    // thread pool so the Tauri runtime isn't stalled.
    tauri::async_runtime::spawn_blocking(move || fonts::load_font_family(&family))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn open_in_editor(
    repo_path: &str,
    editor_override: Option<String>,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    if !Path::new(repo_path).is_dir() {
        return Err(format!("Directory does not exist: {repo_path}"));
    }

    let editor_id = match editor_override {
        Some(editor_id) => editor_id,
        None => workspace
            .load_editor_settings()?
            .preferred_editor
            .ok_or_else(|| "Set a preferred editor in Settings before launching.".to_string())?,
    };

    open_path_in_editor(repo_path, &editor_id)
}

#[tauri::command]
pub fn reveal_in_finder(path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err(format!("Path does not exist: {path}"));
    }

    let status = Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| format!("Failed to open Finder: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Finder exited with status: {status}"))
    }
}

#[tauri::command]
pub fn open_url(url: &str, workspace: State<'_, WorkspaceManager>) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|_| "Invalid URL".to_string())?;
    let scheme = parsed.scheme().to_ascii_lowercase();

    let mut settings = workspace.load_terminal_settings()?;
    normalize_terminal_settings(&mut settings);

    if !settings.url_allowlist.iter().any(|allowed| allowed == &scheme) {
        return Err(format!("URL scheme '{scheme}' is not allowed"));
    }

    let status = Command::new("open")
        .arg(url)
        .status()
        .map_err(|e| format!("Failed to open URL: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("open exited with status: {status}"))
    }
}

// ── Group commands ─────────────────────────────────────────────────

#[tauri::command]
pub fn list_groups(workspace: State<'_, WorkspaceManager>) -> Result<Vec<GroupEntry>, String> {
    workspace.list_groups()
}

#[tauri::command]
pub fn create_group(
    name: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<GroupEntry, String> {
    workspace.create_group(name)
}

#[tauri::command]
pub fn rename_group(
    group_id: &str,
    new_name: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.rename_group(group_id, new_name)
}

#[tauri::command]
pub fn delete_group(
    group_id: &str,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.delete_group(group_id)
}

#[tauri::command]
pub fn move_repo_to_group(
    repo_path: &str,
    group_id: Option<&str>,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.move_repo_to_group(repo_path, group_id)
}

// ── PTY commands ────────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn spawn_pty(
    command: &str,
    args: Option<Vec<String>>,
    cwd: &str,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
    color_theme: PtyColorTheme,
    on_data: Channel<PtyOutput>,
    pty_manager: State<'_, PtyManager>,
) -> Result<u32, String> {
    pty_manager.spawn(command, args, cwd, env, cols, rows, color_theme, on_data)
}

#[tauri::command]
pub fn write_pty(
    pty_id: u32,
    data: &str,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.write(pty_id, data.as_bytes())
}

#[tauri::command]
pub fn acknowledge_pty_output(
    pty_id: u32,
    bytes: usize,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.acknowledge_output(pty_id, bytes)
}

#[tauri::command]
pub fn update_pty_color_theme(
    color_theme: PtyColorTheme,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.set_color_theme(color_theme)
}

#[tauri::command]
pub fn resize_pty(
    pty_id: u32,
    cols: u16,
    rows: u16,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.resize(pty_id, cols, rows)
}

#[tauri::command]
pub fn kill_pty(pty_id: u32, pty_manager: State<'_, PtyManager>) -> Result<(), String> {
    pty_manager.kill(pty_id)
}

#[tauri::command]
pub async fn resolve_session_title(
    pty_id: u32,
    assistant_id: String,
    repo_path: String,
    started_after_ms: i64,
    session_id: Option<String>,
    pty_manager: State<'_, PtyManager>,
) -> Result<Option<SessionTitleMatch>, String> {
    let process_id = pty_manager.child_pid(pty_id);
    tauri::async_runtime::spawn_blocking(move || {
        session_titles::resolve_session_title(
            &assistant_id,
            &repo_path,
            started_after_ms,
            session_id.as_deref(),
            process_id,
        )
    })
    .await
    .map_err(|error| format!("Session title resolver failed: {error}"))
}

#[tauri::command]
pub async fn get_agent_runtime_status(
    pty_id: u32,
    assistant_id: String,
    repo_path: String,
    session_id: Option<String>,
    pty_manager: State<'_, PtyManager>,
) -> Result<Option<AgentRuntimeStatus>, String> {
    let process_id = pty_manager.child_pid(pty_id);
    tauri::async_runtime::spawn_blocking(move || {
        agent_status::resolve(
            &assistant_id,
            &repo_path,
            session_id.as_deref(),
            process_id,
        )
    })
    .await
    .map_err(|error| format!("Agent status resolver failed: {error}"))
}

#[tauri::command]
pub fn upsert_session_history(
    record: SessionHistoryUpsert,
    db: State<'_, UsageDb>,
) -> Result<(), String> {
    session_history::upsert(db.inner(), record)
}

#[tauri::command]
pub fn record_session_history_activity(
    provider: String,
    session_id: String,
    timestamp: i64,
    ended: bool,
    db: State<'_, UsageDb>,
) -> Result<(), String> {
    session_history::record_activity(db.inner(), &provider, &session_id, timestamp, ended)
}

#[tauri::command]
pub fn list_session_history(
    project_path: Option<String>,
    query: Option<String>,
    limit: Option<u32>,
    db: State<'_, UsageDb>,
) -> Result<Vec<SessionHistoryEntry>, String> {
    session_history::list(db.inner(), project_path.as_deref(), query.as_deref(), limit)
}

// ── App lifecycle commands ────────────────────────────────────────

#[tauri::command]
pub fn get_pty_session_count(pty_manager: State<'_, PtyManager>) -> usize {
    pty_manager.session_count()
}

#[tauri::command]
pub fn shutdown_and_quit(app: tauri::AppHandle, pty_manager: State<'_, PtyManager>, watcher: State<'_, GitWatcher>) {
    if !pty_manager.begin_shutdown() {
        return;
    }
    watcher.shutdown();
    pty_manager.kill_all();
    app.exit(0);
}

// ── File watcher commands ─────────────────────────────────────────

#[tauri::command]
pub fn watch_repo(path: &str, watcher: State<'_, GitWatcher>) -> Result<(), String> {
    watcher.watch(path)
}

#[tauri::command]
pub fn unwatch_repo(path: &str, watcher: State<'_, GitWatcher>) -> Result<(), String> {
    watcher.unwatch(path)
}

// ── Git commands (async — runs on Tauri thread pool, not main thread) ──

#[tauri::command]
pub async fn is_git_repo(path: String) -> bool {
    git::is_git_repo(&path)
}

#[tauri::command]
pub async fn git_init(path: String) -> Result<(), String> {
    git::init_repo(&path)
}

#[tauri::command]
pub async fn git_current_branch(path: String) -> Result<String, String> {
    git::current_branch(&path)
}

#[tauri::command]
pub async fn git_list_branches(path: String) -> Result<Vec<String>, String> {
    git::list_branches(&path)
}

#[tauri::command]
pub async fn git_push_branch(path: String, branch: String) -> Result<(), String> {
    git::push_branch(&path, &branch)
}

#[tauri::command]
pub async fn git_list_worktrees(path: String) -> Result<Vec<WorktreeEntry>, String> {
    git::list_worktrees(&path)
}

#[tauri::command]
pub async fn git_create_worktree(path: String, branch_name: String) -> Result<CreatedWorktree, String> {
    git::create_worktree(&path, &branch_name)
}

#[tauri::command]
pub async fn git_status(path: String) -> GitStatus {
    git::status(&path)
}

#[tauri::command]
pub async fn git_changed_files(path: String) -> Result<Vec<ChangedFile>, String> {
    git::changed_files(&path)
}

#[tauri::command]
pub async fn git_file_diff(path: String, file_path: String, staged: bool) -> Result<String, String> {
    git::file_diff(&path, &file_path, staged)
}

#[tauri::command]
pub async fn git_file_contents(path: String, file_path: String, source: String) -> Result<String, String> {
    git::file_contents(&path, &file_path, &source)
}

#[tauri::command]
pub async fn git_list_files(path: String) -> Result<Vec<String>, String> {
    git::list_files(&path)
}

#[tauri::command]
pub async fn git_stage_file(path: String, file_path: String) -> Result<(), String> {
    git::stage_file(&path, &file_path)
}

#[tauri::command]
pub async fn git_stage_all(path: String) -> Result<(), String> {
    git::stage_all(&path)
}

#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<(), String> {
    git::commit(&path, &message)
}

#[tauri::command]
pub async fn git_unstage_file(path: String, file_path: String) -> Result<(), String> {
    git::unstage_file(&path, &file_path)
}

#[tauri::command]
pub async fn git_unstage_all(path: String) -> Result<(), String> {
    git::unstage_all(&path)
}

#[tauri::command]
pub async fn git_switch_branch(path: String, branch_name: String) -> Result<(), String> {
    git::switch_branch(&path, &branch_name)
}

#[tauri::command]
pub async fn git_create_branch(path: String, branch_name: String) -> Result<(), String> {
    git::create_branch(&path, &branch_name)
}

#[tauri::command]
pub async fn git_diff_stats(path: String) -> Result<Vec<DiffFileStat>, String> {
    git::diff_stats(&path)
}

// ── System commands ────────────────────────────────────────────────

#[tauri::command]
pub fn get_username() -> String {
    std::env::var("USER").unwrap_or_default()
}

#[tauri::command]
pub fn get_home_directory() -> Result<String, String> {
    dirs::home_dir()
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| "Could not find home directory".to_string())
}

#[tauri::command]
pub fn get_default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

#[tauri::command]
pub fn get_computer_name() -> String {
    Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

// ── Todo commands ───────────────────────────────────────────────────

#[tauri::command]
pub fn read_todos(repo_path: &str) -> Result<Vec<TodoFile>, String> {
    todos::read_todos(repo_path)
}

#[tauri::command]
pub fn toggle_todo(
    file_path: &str,
    line: usize,
    expected_text: &str,
    checked: bool,
) -> Result<(), String> {
    todos::toggle_todo(file_path, line, expected_text, checked)
}

#[tauri::command]
pub fn add_todo(
    repo_path: &str,
    file_path: Option<&str>,
    text: &str,
    section_line: Option<usize>,
    kanban: bool,
) -> Result<(), String> {
    todos::add_todo(repo_path, file_path, text, section_line, kanban)
}

#[tauri::command]
pub fn move_todo(
    file_path: &str,
    line: usize,
    expected_text: &str,
    target_section_line: usize,
    set_checked: Option<bool>,
) -> Result<(), String> {
    todos::move_todo(file_path, line, expected_text, target_section_line, set_checked)
}

#[tauri::command]
pub fn list_skills(repo_path: &str) -> Vec<skills::SkillInfo> {
    skills::list_skills(repo_path)
}

#[tauri::command]
pub fn setup_skill(repo_path: &str, name: &str) -> Result<(), String> {
    skills::setup_skill(repo_path, name)
}

#[tauri::command]
pub fn remove_skill(repo_path: &str, name: &str) -> Result<(), String> {
    skills::remove_skill(repo_path, name)
}

#[tauri::command]
pub fn check_command_exists(command: &str) -> bool {
    Command::new("which")
        .arg(command)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn get_all_usage_snapshots(
    db: State<'_, UsageDb>,
    workspace: State<'_, WorkspaceManager>,
) -> Result<Vec<ProviderUsageSnapshot>, String> {
    let enabled = enabled_providers(&workspace);
    Ok(crate::usage::get_all_usage_snapshots(&db, &enabled))
}

#[tauri::command]
pub async fn get_usage_snapshot(
    db: State<'_, UsageDb>,
    workspace: State<'_, WorkspaceManager>,
    provider: String,
) -> Result<ProviderUsageSnapshot, String> {
    let enabled = enabled_providers(&workspace);
    crate::usage::get_usage_snapshot(&db, &provider, &enabled)
}

fn enabled_providers(workspace: &State<'_, WorkspaceManager>) -> crate::usage::EnabledProviders {
    let settings = workspace.load_usage_settings().unwrap_or_default();
    crate::usage::EnabledProviders {
        claude: settings.claude.show,
        codex: settings.codex.show,
        gemini: settings.gemini.show,
        antigravity: settings.antigravity.show,
        grok: settings.grok.show,
    }
}

#[tauri::command]
pub fn get_usage_settings(
    workspace: State<'_, WorkspaceManager>,
) -> Result<UsageSettings, String> {
    workspace.load_usage_settings()
}

#[tauri::command]
pub fn save_usage_settings(
    settings: UsageSettings,
    workspace: State<'_, WorkspaceManager>,
) -> Result<(), String> {
    workspace.save_usage_settings(&settings)
}

#[tauri::command]
pub async fn get_usage_details(db: State<'_, UsageDb>, provider: String, window: String) -> Result<LocalUsageDetails, String> {
    crate::usage::get_windowed_details(&db, &provider, &window)
}

#[tauri::command]
pub async fn get_usage_overview(db: State<'_, UsageDb>, window: String) -> Result<UsageOverview, String> {
    crate::usage::get_usage_overview(&db, &window)
}

#[tauri::command]
pub async fn get_project_alias_review_queue(
    db: State<'_, UsageDb>,
) -> Result<Vec<UsageProjectAliasReviewItem>, String> {
    Ok(crate::usage::get_project_alias_review_queue(&db))
}

#[tauri::command]
pub async fn get_models_for_provider(
    db: State<'_, UsageDb>,
    provider: String,
) -> Result<Vec<String>, String> {
    match provider.as_str() {
        "pi" => Ok(sort_cli_models(&db, query_cli_models("pi", &["--list-models"], parse_pi_models))),
        "opencode" => Ok(sort_cli_models(&db, query_cli_models("opencode", &["models"], parse_opencode_models))),
        _ => Ok(crate::usage::get_models_for_provider(&db, &provider)),
    }
}

fn query_cli_models(
    cmd: &str,
    args: &[&str],
    parser: fn(&str) -> Vec<String>,
) -> Vec<String> {
    let mut child = match Command::new(cmd)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return Vec::new(),
    };

    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Vec::new();
    };

    let reader = thread::spawn(move || {
        let mut text = String::new();
        stdout.read_to_string(&mut text).map(|_| text).ok()
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = reader.join().ok().flatten();
                if !status.success() {
                    return Vec::new();
                }
                return output.map(|text| parser(&text)).unwrap_or_default();
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Vec::new();
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Vec::new();
            }
        }
    }
}

fn sort_cli_models(db: &UsageDb, models: Vec<String>) -> Vec<String> {
    let conn = db.conn.lock().unwrap();
    let mut dated: Vec<(String, String)> = models
        .into_iter()
        .map(|name| {
            let date = name.split_once('/')
                .and_then(|(provider, model)| {
                    conn.query_row(
                        "SELECT COALESCE(release_date, '2000-01-01') FROM model_pricing WHERE provider = ?1 AND model_pattern = ?2",
                        rusqlite::params![provider, model],
                        |row| row.get::<_, String>(0),
                    ).ok()
                })
                .unwrap_or_else(|| "2000-01-01".to_string());
            (name, date)
        })
        .collect();
    dated.sort_by(|a, b| b.1.cmp(&a.1));
    dated.into_iter().map(|(name, _)| name).collect()
}

/// Parse `pi --list-models` table: "provider  model  context  ..."
fn parse_pi_models(text: &str) -> Vec<String> {
    text.lines()
        .skip(1) // header row
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            let provider = cols.next()?;
            let model = cols.next()?;
            Some(format!("{provider}/{model}"))
        })
        .collect()
}

/// Parse `opencode models` output: "provider/model" per line
fn parse_opencode_models(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

#[tauri::command]
pub fn refresh_usage_data(db: State<'_, UsageDb>, app: tauri::AppHandle) {
    let db = db.inner().clone();
    std::thread::spawn(move || {
        crate::usage::run_background_ingest(&db);
        let _ = app.emit("usage-ingest-complete", ());
    });
}

// ── Memory diagnostics (dev only) ──────────────────────────────────

#[derive(serde::Serialize)]
pub struct MemoryStats {
    /// Shep (Rust backend) resident memory in bytes
    pub app_rss: u64,
    /// Total resident memory of all child processes (CLI tools) in bytes
    pub children_rss: u64,
}

#[tauri::command]
pub async fn get_memory_stats(pty_manager: State<'_, PtyManager>) -> Result<MemoryStats, String> {
    let app_pid = std::process::id() as i32;
    let app_rss = rss_for_pid(app_pid);

    // Sum RSS of all child process trees
    let child_pids = pty_manager.child_pids();
    let mut children_rss: u64 = 0;
    for pid in child_pids {
        let pid = pid as i32;
        // The direct child + its descendants
        children_rss += rss_for_pid(pid);
        if let Ok(output) = Command::new("pgrep").arg("-P").arg(pid.to_string()).output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if let Ok(child) = line.trim().parse::<i32>() {
                    children_rss += rss_for_pid(child);
                }
            }
        }
    }

    Ok(MemoryStats { app_rss, children_rss })
}

/// Get resident set size (RSS) for a single PID using `ps`.
fn rss_for_pid(pid: i32) -> u64 {
    // ps -o rss= returns RSS in kilobytes
    Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|kb| kb * 1024)
        .unwrap_or(0)
}

fn open_path_in_editor(repo_path: &str, editor_id: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_name = editor_app_name(editor_id)
            .ok_or_else(|| format!("Unsupported editor: {editor_id}"))?;

        let status = Command::new("open")
            .args(["-a", app_name, repo_path])
            .status()
            .map_err(|e| format!("Failed to launch {app_name}: {e}"))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "Launching {app_name} failed with exit status {:?}",
                status.code()
            ))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = repo_path;
        let _ = editor_id;
        Err("Open in editor is currently only implemented for macOS.".to_string())
    }
}

fn editor_app_name(editor_id: &str) -> Option<&'static str> {
    match editor_id {
        "vscode" => Some("Visual Studio Code"),
        "zed" => Some("Zed"),
        "cursor" => Some("Cursor"),
        "sublime_text" => Some("Sublime Text"),
        _ => None,
    }
}

// ── Port commands ─────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct PortInfo {
    pub port: u16,
    pub pid: u32,
    pub process: String,
    pub cwd: String,
    pub project: String,
    pub framework: String,
    pub uptime: String,
    pub memory_kb: u64,
}

/// Run a command with a timeout. Returns stdout on success, empty string on
/// failure or timeout. Prevents hangs from stalling the app (e.g. NFS mounts,
/// broken pipes). Matches port-whisperer's 5-10s timeout pattern.
fn run_with_timeout(cmd: &str, args: &[&str], timeout: std::time::Duration) -> String {
    let mut child = match Command::new(cmd).args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn() {
        Ok(c) => c,
        Err(_) => return String::new(),
    };

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return String::new();
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => return String::new(),
        }
    }

    child.stdout.take()
        .and_then(|mut out| {
            let mut buf = String::new();
            std::io::Read::read_to_string(&mut out, &mut buf).ok()?;
            Some(buf)
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn list_listening_ports(
    workspace: State<'_, WorkspaceManager>,
) -> Result<Vec<PortInfo>, String> {
    let repos = workspace.list_repos().unwrap_or_default();
    let repo_paths: Vec<String> = repos.iter().map(|r| r.path.clone()).collect();
    let timeout = std::time::Duration::from_secs(5);

    // ── Step 1: lsof to find listening ports ──────────────────────────
    // Matching port-whisperer: parts[8] is the NAME field.
    // fix_path_env already set PATH at startup, so lsof is findable.
    let stdout = run_with_timeout("lsof", &["-iTCP", "-sTCP:LISTEN", "-P", "-n"], timeout);

    let mut port_map: std::collections::HashSet<u16> = std::collections::HashSet::new();
    struct Entry { port: u16, pid: u32, process_name: String }
    let mut entries: Vec<Entry> = Vec::new();

    for line in stdout.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 9 { continue; }

        let process_name = parts[0].to_string();
        let pid: u32 = match parts[1].parse() { Ok(p) => p, Err(_) => continue };

        // NAME is at index 8 (fixed position), e.g. "*:3000" or "127.0.0.1:8080"
        let port: u16 = match extract_port(parts[8]) {
            Some(p) => p,
            None => continue,
        };

        // Deduplicate by port (first entry wins, like port-whisperer)
        if !port_map.insert(port) { continue; }

        // Filter out system/desktop apps
        if !is_dev_process(&process_name) { continue; }

        entries.push(Entry { port, pid, process_name });
    }

    if entries.is_empty() {
        return Ok(Vec::new());
    }

    // ── Step 2: Batch ps call for all PIDs ────────────────────────────
    let pid_list: String = entries.iter().map(|e| e.pid.to_string()).collect::<Vec<_>>().join(",");
    let ps_stdout = run_with_timeout("ps", &["-p", &pid_list, "-o", "pid=,rss=,etime=,command="], timeout);

    let mut ps_map: std::collections::HashMap<u32, (u64, String, String)> = std::collections::HashMap::new();
    for line in ps_stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        let mut parts = trimmed.splitn(4, char::is_whitespace);
        let pid: u32 = match parts.next().and_then(|s| s.parse().ok()) { Some(p) => p, None => continue };
        let rss: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let etime = parts.next().unwrap_or("").to_string();
        let command = parts.next().unwrap_or("").to_string();
        ps_map.insert(pid, (rss, etime, command));
    }

    // ── Step 3: Batch cwd via single lsof call ───────────────────────
    let cwd_stdout = run_with_timeout("lsof", &["-a", "-d", "cwd", "-p", &pid_list], timeout);

    let mut cwd_map: std::collections::HashMap<u32, String> = std::collections::HashMap::new();
    for line in cwd_stdout.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 9 { continue; }
        if let Ok(pid) = parts[1].parse::<u32>() {
            let path = parts[8..].join(" ");
            if path.starts_with('/') {
                cwd_map.insert(pid, path);
            }
        }
    }

    // ── Step 4: Assemble results ─────────────────────────────────────
    let mut results: Vec<PortInfo> = Vec::with_capacity(entries.len());

    for entry in entries {
        let (memory_kb, uptime, cmdline) = ps_map.get(&entry.pid)
            .map(|(rss, etime, cmd)| (*rss, etime.as_str(), cmd.as_str()))
            .unwrap_or((0, "", ""));
        let raw_cwd = cwd_map.get(&entry.pid).cloned().unwrap_or_default();

        let project_root = find_project_root(&raw_cwd);
        let framework = detect_framework(&entry.process_name, cmdline, &project_root);
        let project = match_project(&project_root, &repo_paths);

        results.push(PortInfo {
            port: entry.port,
            pid: entry.pid,
            process: entry.process_name,
            cwd: project_root,
            project,
            framework,
            uptime: uptime.to_string(),
            memory_kb,
        });
    }

    results.sort_by_key(|p| p.port);
    Ok(results)
}

/// Extract port number from lsof NAME field like "*:3000", "127.0.0.1:8080", "[::1]:5173"
fn extract_port(name_field: &str) -> Option<u16> {
    name_field.rsplit(':').next()?.parse().ok()
}

/// Filter out system/desktop apps — only show dev processes.
/// Matches port-whisperer's isDevProcess systemApps list.
fn is_dev_process(process_name: &str) -> bool {
    let name = process_name.to_lowercase();
    let system_apps = [
        "spotify", "raycast", "tableplus", "postman", "linear", "controlce",
        "rapportd", "superhuma", "setappage", "slack", "discord", "firefox",
        "chrome", "google", "safari", "figma", "notion", "zoom", "teams",
        "iterm2", "warp", "arc", "loginwindow", "windowserver", "systemuise",
        "kernel_tas", "launchd", "mdworker", "mds_store", "cfprefsd",
        "coreaudio", "corebrigh", "airportd", "bluetoothd", "sharingd",
        "usernoted", "notificat", "cloudd",
    ];
    for app in &system_apps {
        if name.starts_with(app) { return false; }
    }
    true
}

/// Walk up from cwd to find project root via marker files (package.json, Cargo.toml, etc.)
/// Matches port-whisperer's findProjectRoot.
fn find_project_root(cwd: &str) -> String {
    if cwd.is_empty() { return String::new(); }
    let markers = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "Gemfile", "pom.xml", "build.gradle"];
    let mut current = std::path::PathBuf::from(cwd);
    for _ in 0..15 {
        for marker in &markers {
            if current.join(marker).exists() {
                return current.to_string_lossy().to_string();
            }
        }
        if !current.pop() { break; }
    }
    cwd.to_string()
}

/// Detect framework — first from command line, then from project files.
/// Matches port-whisperer's detectFrameworkFromCommand + detectFramework.
fn detect_framework(process: &str, cmdline: &str, project_root: &str) -> String {
    // 1. Command line detection
    let cmd = cmdline.to_lowercase();
    if cmd.contains("next") { return "Next.js".to_string(); }
    if cmd.contains("vite") { return "Vite".to_string(); }
    if cmd.contains("nuxt") { return "Nuxt".to_string(); }
    if cmd.contains("angular") || cmd.contains("ng serve") { return "Angular".to_string(); }
    if cmd.contains("webpack") { return "Webpack".to_string(); }
    if cmd.contains("remix") { return "Remix".to_string(); }
    if cmd.contains("astro") { return "Astro".to_string(); }
    if cmd.contains("gatsby") { return "Gatsby".to_string(); }
    if cmd.contains("flask") { return "Flask".to_string(); }
    if cmd.contains("django") || cmd.contains("manage.py") { return "Django".to_string(); }
    if cmd.contains("uvicorn") { return "FastAPI".to_string(); }
    if cmd.contains("rails") { return "Rails".to_string(); }
    if cmd.contains("cargo") || cmd.contains("rustc") { return "Rust".to_string(); }
    if cmd.contains("storybook") { return "Storybook".to_string(); }

    // 2. Process name fallback
    let name = process.to_lowercase();
    if name == "node" { return "Node.js".to_string(); }
    if name.starts_with("python") { return "Python".to_string(); }
    if name.starts_with("ruby") { return "Ruby".to_string(); }
    if name.starts_with("java") { return "Java".to_string(); }
    if name == "go" { return "Go".to_string(); }
    if name.contains("postgres") || name == "postmaster" { return "PostgreSQL".to_string(); }
    if name.contains("redis") { return "Redis".to_string(); }
    if name.contains("mongod") { return "MongoDB".to_string(); }
    if name.contains("mysqld") { return "MySQL".to_string(); }
    if name.contains("docker") || name.starts_with("com.docke") { return "Docker".to_string(); }
    if name.contains("nginx") { return "nginx".to_string(); }

    // 3. Project file detection (like port-whisperer's detectFramework)
    if !project_root.is_empty() {
        let root = Path::new(project_root);
        if root.join("vite.config.ts").exists() || root.join("vite.config.js").exists() { return "Vite".to_string(); }
        if root.join("next.config.js").exists() || root.join("next.config.mjs").exists() { return "Next.js".to_string(); }
        if root.join("angular.json").exists() { return "Angular".to_string(); }
        if root.join("Cargo.toml").exists() { return "Rust".to_string(); }
        if root.join("go.mod").exists() { return "Go".to_string(); }
        if root.join("manage.py").exists() { return "Django".to_string(); }
        if root.join("Gemfile").exists() { return "Ruby".to_string(); }
    }

    String::new()
}

fn match_project(cwd: &str, repo_paths: &[String]) -> String {
    if cwd.is_empty() { return String::new(); }
    repo_paths
        .iter()
        .filter(|repo| cwd.starts_with(repo.as_str()))
        .max_by_key(|repo| repo.len())
        .and_then(|repo| repo.rsplit('/').next())
        .unwrap_or("")
        .to_string()
}

#[tauri::command]
pub async fn kill_port(pid: u32) -> Result<(), String> {
    // SIGTERM first, then SIGKILL if needed
    let pid_str = pid.to_string();
    let status = Command::new("kill")
        .arg(&pid_str)
        .status()
        .map_err(|e| format!("Failed to kill process {pid}: {e}"))?;

    if !status.success() {
        Command::new("kill")
            .args(["-9", &pid_str])
            .status()
            .map_err(|e| format!("Failed to force-kill process {pid}: {e}"))?;
    }
    Ok(())
}

// ── Pi config commands ─────────────────────────────────────────────

#[tauri::command]
pub fn get_pi_config() -> Result<crate::pi_config::PiConfig, String> {
    crate::pi_config::get_pi_config()
}

#[tauri::command]
pub fn save_pi_settings(settings: crate::pi_config::PiSettings) -> Result<(), String> {
    crate::pi_config::save_pi_settings(settings)
}

#[tauri::command]
pub fn save_pi_api_key(provider: String, api_key: String) -> Result<(), String> {
    crate::pi_config::save_pi_api_key(&provider, &api_key)
}

#[tauri::command]
pub fn delete_pi_api_key(provider: String) -> Result<(), String> {
    crate::pi_config::delete_pi_api_key(&provider)
}
