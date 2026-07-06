use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::config::{
    CommandConfig, EditorSettings, GlobalConfig, GroupEntry, KeybindingSettings, ProjectSettings, RegisteredRepo,
    RepoEntry, RepoInfo, TerminalSettings, UsageSettings, WorkspaceConfig,
    normalize_terminal_settings,
};

static CONFIG_CACHE: Mutex<Option<(GlobalConfig, SystemTime)>> = Mutex::new(None);

// ── Paths ───────────────────────────────────────────────────────────

fn shep_home() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".shep"))
}

fn global_config_path() -> Result<PathBuf, String> {
    Ok(shep_home()?.join("config.yml"))
}

fn old_projects_dir() -> Result<PathBuf, String> {
    Ok(shep_home()?.join("projects"))
}

fn repo_shep_dir(repo_path: &str) -> PathBuf {
    Path::new(repo_path).join(".shep")
}

fn repo_workspace_file(repo_path: &str) -> PathBuf {
    repo_shep_dir(repo_path).join("workspace.yml")
}

// ── Global config ───────────────────────────────────────────────────

pub fn load_global_config() -> Result<GlobalConfig, String> {
    let path = global_config_path()?;
    if !path.exists() {
        return Ok(GlobalConfig::default());
    }

    let mtime = fs::metadata(&path)
        .and_then(|m| m.modified())
        .unwrap_or(UNIX_EPOCH);

    if let Ok(guard) = CONFIG_CACHE.lock() {
        if let Some((ref cached, ref cached_mtime)) = *guard {
            if *cached_mtime == mtime {
                return Ok(cached.clone());
            }
        }
    }

    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read global config: {e}"))?;
    let config: GlobalConfig =
        serde_yaml::from_str(&content).map_err(|e| format!("Failed to parse global config: {e}"))?;

    if let Ok(mut guard) = CONFIG_CACHE.lock() {
        *guard = Some((config.clone(), mtime));
    }

    Ok(config)
}

pub fn save_global_config(config: &GlobalConfig) -> Result<(), String> {
    let dir = shep_home()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create .shep dir: {e}"))?;

    let path = global_config_path()?;
    let yaml =
        serde_yaml::to_string(config).map_err(|e| format!("Failed to serialize config: {e}"))?;
    fs::write(&path, &yaml).map_err(|e| format!("Failed to write global config: {e}"))?;

    // Update cache with the config we just wrote
    if let Ok(mtime) = fs::metadata(&path).and_then(|m| m.modified()) {
        if let Ok(mut guard) = CONFIG_CACHE.lock() {
            *guard = Some((config.clone(), mtime));
        }
    }

    Ok(())
}

pub fn backfill_global_config_defaults() -> Result<(), String> {
    let path = global_config_path()?;
    if !path.exists() {
        return save_global_config(&GlobalConfig::default());
    }

    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read global config: {e}"))?;
    let needs_url_allowlist = !content.contains("urlAllowlist:");

    if !needs_url_allowlist {
        return Ok(());
    }

    let mut config = load_global_config()?;
    normalize_terminal_settings(&mut config.terminal);
    save_global_config(&config)
}

pub fn load_editor_settings() -> Result<EditorSettings, String> {
    Ok(load_global_config()?.editor)
}

pub fn load_project_settings() -> Result<ProjectSettings, String> {
    Ok(load_global_config()?.projects)
}

pub fn save_editor_settings(settings: &EditorSettings) -> Result<(), String> {
    let mut config = load_global_config()?;
    config.editor = settings.clone();
    save_global_config(&config)
}

pub fn save_project_settings(settings: &ProjectSettings) -> Result<(), String> {
    let mut config = load_global_config()?;
    config.projects = settings.clone();
    save_global_config(&config)
}

pub fn load_keybinding_settings() -> Result<KeybindingSettings, String> {
    Ok(load_global_config()?.keybindings)
}

pub fn save_keybinding_settings(settings: &KeybindingSettings) -> Result<(), String> {
    let mut config = load_global_config()?;
    config.keybindings = settings.clone();
    save_global_config(&config)
}

pub fn load_terminal_settings() -> Result<TerminalSettings, String> {
    Ok(load_global_config()?.terminal)
}

pub fn save_terminal_settings(settings: &TerminalSettings) -> Result<(), String> {
    let mut config = load_global_config()?;
    config.terminal = settings.clone();
    save_global_config(&config)
}

pub fn load_usage_settings() -> Result<UsageSettings, String> {
    Ok(load_global_config()?.usage)
}

pub fn save_usage_settings(settings: &UsageSettings) -> Result<(), String> {
    let mut config = load_global_config()?;
    config.usage = settings.clone();
    save_global_config(&config)
}

// ── Repo operations ─────────────────────────────────────────────────

pub fn list_repos() -> Result<Vec<RepoInfo>, String> {
    let config = load_global_config()?;

    let repos = config.repos
        .iter()
        .map(|entry| {
            let path = Path::new(&entry.path);
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            RepoInfo {
                path: entry.path.clone(),
                name,
                group: entry.group.clone(),
            }
        })
        .collect();
    Ok(repos)
}

pub fn register_repo(repo_path: &str) -> Result<RegisteredRepo, String> {
    let path = Path::new(repo_path);
    if !path.is_dir() {
        return Err(format!("Directory does not exist: {repo_path}"));
    }

    // Add to global config if not already there. dunce avoids the \\?\
    // verbatim prefix std canonicalize produces on Windows — this string is
    // the repo's identity across the whole app (git -C, watcher, UI).
    let mut config = load_global_config()?;
    let canonical = dunce::canonicalize(path)
        .map_err(|e| format!("Failed to resolve path: {e}"))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    if !config.repos.iter().any(|r| r.path == canonical_str) {
        config.repos.push(RepoEntry {
            path: canonical_str.clone(),
            group: None,
        });
        save_global_config(&config)?;
    }

    // Load existing workspace config or return an in-memory default. We create
    // `.shep` lazily only when the user actually saves project config.
    let workspace = load_or_default_workspace(&canonical_str)?;
    Ok(RegisteredRepo {
        path: canonical_str,
        workspace,
    })
}

pub fn unregister_repo(repo_path: &str) -> Result<(), String> {
    let mut config = load_global_config()?;
    config.repos.retain(|r| r.path != repo_path);
    save_global_config(&config)
}

// ── Per-repo workspace ──────────────────────────────────────────────

pub fn load_repo_workspace(repo_path: &str) -> Result<WorkspaceConfig, String> {
    load_or_default_workspace(repo_path)
}

pub fn save_repo_workspace(repo_path: &str, config: &WorkspaceConfig) -> Result<(), String> {
    ensure_repo_shep_dir(repo_path)?;

    let path = repo_workspace_file(repo_path);
    let yaml =
        serde_yaml::to_string(config).map_err(|e| format!("Failed to serialize config: {e}"))?;
    fs::write(&path, yaml).map_err(|e| format!("Failed to write workspace file: {e}"))
}

// ── Migration ───────────────────────────────────────────────────────

pub fn migrate_old_projects() -> Result<(), String> {
    let old_dir = old_projects_dir()?;
    if !old_dir.exists() {
        return Ok(());
    }

    // Check if we already have a global config (migration already done)
    let global_path = global_config_path()?;
    if global_path.exists() {
        return Ok(());
    }

    let mut global_config = GlobalConfig::default();

    let entries = fs::read_dir(&old_dir).map_err(|e| format!("Failed to read old projects: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let path = entry.path();

        if !path.is_dir() {
            continue;
        }

        let old_workspace_file = path.join("workspace.yml");
        if !old_workspace_file.exists() {
            continue;
        }

        let content = match fs::read_to_string(&old_workspace_file) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Parse old format (has cwd and tasks fields)
        let old_config: serde_yaml::Value = match serde_yaml::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let cwd = old_config
            .get("cwd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if cwd.is_empty() || !Path::new(&cwd).is_dir() {
            continue;
        }

        let name = old_config
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Convert tasks -> commands
        let commands: Vec<CommandConfig> = if let Some(tasks) = old_config.get("tasks") {
            serde_yaml::from_value::<Vec<CommandConfig>>(tasks.clone()).unwrap_or_default()
        } else {
            Vec::new()
        };

        let workspace = WorkspaceConfig {
            name: if name.is_empty() {
                Path::new(&cwd)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string()
            } else {
                name
            },
            commands,
            assistants: Vec::new(),
        };

        // Write to repo's .shep/workspace.yml
        if ensure_repo_shep_dir(&cwd).is_ok() {
            let _ = save_repo_workspace(&cwd, &workspace);
        }

        // Add to global registry
        global_config.repos.push(RepoEntry { path: cwd, group: None });
    }

    if !global_config.repos.is_empty() {
        save_global_config(&global_config)?;
    }

    Ok(())
}

// ── Group operations ───────────────────────────────────────────────

pub fn list_groups() -> Result<Vec<GroupEntry>, String> {
    let config = load_global_config()?;
    let mut groups = config.groups;
    groups.sort_by_key(|g| g.order);
    Ok(groups)
}

pub fn create_group(name: &str) -> Result<GroupEntry, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Group name cannot be empty".to_string());
    }

    let mut config = load_global_config()?;
    let next_order = config.groups.iter().map(|g| g.order).max().unwrap_or(0) + 1;

    let id = format!(
        "{}-{}",
        slug_from_name(trimmed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    let entry = GroupEntry {
        id,
        name: trimmed.to_string(),
        order: next_order,
    };

    config.groups.push(entry.clone());
    save_global_config(&config)?;
    Ok(entry)
}

pub fn rename_group(group_id: &str, new_name: &str) -> Result<(), String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("Group name cannot be empty".to_string());
    }

    let mut config = load_global_config()?;
    let group = config
        .groups
        .iter_mut()
        .find(|g| g.id == group_id)
        .ok_or_else(|| format!("Group not found: {group_id}"))?;
    group.name = trimmed.to_string();
    save_global_config(&config)
}

pub fn delete_group(group_id: &str) -> Result<(), String> {
    let mut config = load_global_config()?;
    config.groups.retain(|g| g.id != group_id);
    // Ungroup any repos that belonged to this group
    for repo in &mut config.repos {
        if repo.group.as_deref() == Some(group_id) {
            repo.group = None;
        }
    }
    save_global_config(&config)
}

pub fn move_repo_to_group(repo_path: &str, group_id: Option<&str>) -> Result<(), String> {
    let mut config = load_global_config()?;

    // Validate group exists (if setting, not clearing)
    if let Some(gid) = group_id {
        if !config.groups.iter().any(|g| g.id == gid) {
            return Err(format!("Group not found: {gid}"));
        }
    }

    let repo = config
        .repos
        .iter_mut()
        .find(|r| r.path == repo_path)
        .ok_or_else(|| format!("Repo not found: {repo_path}"))?;
    repo.group = group_id.map(|s| s.to_string());
    save_global_config(&config)
}

fn slug_from_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

// ── Helpers ─────────────────────────────────────────────────────────

fn ensure_repo_shep_dir(repo_path: &str) -> Result<(), String> {
    let shep_dir = repo_shep_dir(repo_path);
    fs::create_dir_all(&shep_dir).map_err(|e| format!("Failed to create .shep dir: {e}"))?;

    // Create .gitignore in .shep/ to ignore everything
    let gitignore = shep_dir.join(".gitignore");
    if !gitignore.exists() {
        fs::write(&gitignore, "*\n").map_err(|e| format!("Failed to write .gitignore: {e}"))?;
    }

    Ok(())
}

fn load_or_default_workspace(repo_path: &str) -> Result<WorkspaceConfig, String> {
    let path = repo_workspace_file(repo_path);
    if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read workspace file: {e}"))?;
        serde_yaml::from_str(&content)
            .map_err(|e| format!("Failed to parse workspace YAML: {e}"))
    } else {
        let name = Path::new(repo_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let config = WorkspaceConfig {
            name,
            commands: Vec::new(),
            assistants: Vec::new(),
        };

        Ok(config)
    }
}
