use super::config::{
    EditorSettings, GroupEntry, KeybindingSettings, ProjectSettings, RegisteredRepo, RepoInfo,
    TerminalSettings, UsageSettings, WorkspaceConfig,
};
use super::loader;

pub struct WorkspaceManager;

impl WorkspaceManager {
    pub fn new() -> Self {
        WorkspaceManager
    }

    pub fn migrate(&self) -> Result<(), String> {
        loader::migrate_old_projects()
    }

    pub fn backfill_global_config_defaults(&self) -> Result<(), String> {
        loader::backfill_global_config_defaults()
    }

    pub fn list_repos(&self) -> Result<Vec<RepoInfo>, String> {
        loader::list_repos()
    }

    pub fn register_repo(&self, repo_path: &str) -> Result<RegisteredRepo, String> {
        loader::register_repo(repo_path)
    }

    pub fn unregister_repo(&self, repo_path: &str) -> Result<(), String> {
        loader::unregister_repo(repo_path)
    }

    pub fn load_workspace(&self, repo_path: &str) -> Result<WorkspaceConfig, String> {
        loader::load_repo_workspace(repo_path)
    }

    pub fn save_workspace(
        &self,
        repo_path: &str,
        config: &WorkspaceConfig,
    ) -> Result<(), String> {
        loader::save_repo_workspace(repo_path, config)
    }

    pub fn load_editor_settings(&self) -> Result<EditorSettings, String> {
        loader::load_editor_settings()
    }

    pub fn load_project_settings(&self) -> Result<ProjectSettings, String> {
        loader::load_project_settings()
    }

    pub fn save_editor_settings(&self, settings: &EditorSettings) -> Result<(), String> {
        loader::save_editor_settings(settings)
    }

    pub fn save_project_settings(&self, settings: &ProjectSettings) -> Result<(), String> {
        loader::save_project_settings(settings)
    }

    pub fn load_keybinding_settings(&self) -> Result<KeybindingSettings, String> {
        loader::load_keybinding_settings()
    }

    pub fn save_keybinding_settings(&self, settings: &KeybindingSettings) -> Result<(), String> {
        loader::save_keybinding_settings(settings)
    }

    pub fn load_terminal_settings(&self) -> Result<TerminalSettings, String> {
        loader::load_terminal_settings()
    }

    pub fn save_terminal_settings(&self, settings: &TerminalSettings) -> Result<(), String> {
        loader::save_terminal_settings(settings)
    }

    pub fn load_usage_settings(&self) -> Result<UsageSettings, String> {
        loader::load_usage_settings()
    }

    pub fn save_usage_settings(&self, settings: &UsageSettings) -> Result<(), String> {
        loader::save_usage_settings(settings)
    }

    pub fn list_groups(&self) -> Result<Vec<GroupEntry>, String> {
        loader::list_groups()
    }

    pub fn create_group(&self, name: &str) -> Result<GroupEntry, String> {
        loader::create_group(name)
    }

    pub fn rename_group(&self, group_id: &str, new_name: &str) -> Result<(), String> {
        loader::rename_group(group_id, new_name)
    }

    pub fn delete_group(&self, group_id: &str) -> Result<(), String> {
        loader::delete_group(group_id)
    }

    pub fn move_repo_to_group(
        &self,
        repo_path: &str,
        group_id: Option<&str>,
    ) -> Result<(), String> {
        loader::move_repo_to_group(repo_path, group_id)
    }

    pub fn set_group_pinned(&self, group_id: &str, pinned: bool) -> Result<(), String> {
        loader::set_group_pinned(group_id, pinned)
    }

    pub fn set_repo_pinned(&self, repo_path: &str, pinned: bool) -> Result<(), String> {
        loader::set_repo_pinned(repo_path, pinned)
    }

    pub fn mark_repo_opened(&self, repo_path: &str) -> Result<u64, String> {
        loader::mark_repo_opened(repo_path)
    }
}
