use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ── Global config (~/.shep/config.yml) ──────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub repos: Vec<RepoEntry>,
    #[serde(default)]
    pub groups: Vec<GroupEntry>,
    #[serde(default)]
    pub projects: ProjectSettings,
    #[serde(default)]
    pub editor: EditorSettings,
    #[serde(default)]
    pub keybindings: KeybindingSettings,
    #[serde(default)]
    pub terminal: TerminalSettings,
    #[serde(default)]
    pub usage: UsageSettings,
}

fn default_version() -> u32 {
    1
}

impl Default for GlobalConfig {
    fn default() -> Self {
        GlobalConfig {
            version: 1,
            repos: Vec::new(),
            groups: Vec::new(),
            projects: ProjectSettings::default(),
            editor: EditorSettings::default(),
            keybindings: KeybindingSettings::default(),
            terminal: TerminalSettings::default(),
            usage: UsageSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EditorSettings {
    #[serde(default, rename = "preferredEditor")]
    pub preferred_editor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSettings {
    #[serde(default = "default_true", rename = "autoImportWorktrees")]
    pub auto_import_worktrees: bool,
    /// Label shown for live agent sessions: "repository" or "title".
    #[serde(default = "default_agent_label_mode", rename = "agentLabelMode")]
    pub agent_label_mode: String,
    /// Permission mode used when starting or resuming agent sessions.
    #[serde(default = "default_agent_session_mode", rename = "defaultAgentMode")]
    pub default_agent_mode: String,
    #[serde(default = "default_true", rename = "showTodos")]
    pub show_todos: bool,
    /// Shape of a lazily created TODO.md: "kanban" (columned board) or "list".
    #[serde(default = "default_todo_file_style", rename = "todoFileStyle")]
    pub todo_file_style: String,
}

fn default_todo_file_style() -> String {
    "kanban".to_string()
}

fn default_agent_label_mode() -> String {
    "repository".to_string()
}

fn default_agent_session_mode() -> String {
    "yolo".to_string()
}

impl Default for ProjectSettings {
    fn default() -> Self {
        ProjectSettings {
            auto_import_worktrees: true,
            agent_label_mode: default_agent_label_mode(),
            default_agent_mode: default_agent_session_mode(),
            show_todos: true,
            todo_file_style: default_todo_file_style(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeybindingSettings {
    #[serde(default = "default_true", rename = "shiftEnterNewline")]
    pub shift_enter_newline: bool,
    #[serde(default = "default_true", rename = "optionDeleteWord")]
    pub option_delete_word: bool,
    #[serde(default = "default_true", rename = "cmdKClear")]
    pub cmd_k_clear: bool,
}

fn default_true() -> bool {
    true
}

impl Default for KeybindingSettings {
    fn default() -> Self {
        KeybindingSettings {
            shift_enter_newline: true,
            option_delete_word: true,
            cmd_k_clear: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSettings {
    #[serde(default = "default_cursor_style", rename = "cursorStyle")]
    pub cursor_style: String,
    #[serde(default = "default_true", rename = "cursorBlink")]
    pub cursor_blink: bool,
    #[serde(default = "default_scrollback")]
    pub scrollback: u32,
    #[serde(default = "default_font_family", rename = "fontFamily")]
    pub font_family: String,
    #[serde(default = "default_font_size", rename = "fontSize")]
    pub font_size: u32,
    #[serde(
        default = "default_url_allowlist",
        rename = "urlAllowlist",
        alias = "allowedUrlSchemes"
    )]
    pub url_allowlist: Vec<String>,
}

fn default_cursor_style() -> String {
    "block".to_string()
}

fn default_scrollback() -> u32 {
    10000
}

fn default_font_family() -> String {
    "MesloLGS NF".to_string()
}

fn default_font_size() -> u32 {
    14
}

fn default_url_allowlist() -> Vec<String> {
    vec!["http".to_string(), "https".to_string()]
}

impl Default for TerminalSettings {
    fn default() -> Self {
        TerminalSettings {
            cursor_style: default_cursor_style(),
            cursor_blink: true,
            scrollback: default_scrollback(),
            font_family: default_font_family(),
            font_size: default_font_size(),
            url_allowlist: default_url_allowlist(),
        }
    }
}

pub fn normalize_terminal_settings(settings: &mut TerminalSettings) {
    settings.url_allowlist = normalize_url_allowlist(&settings.url_allowlist);
}

fn normalize_url_allowlist(schemes: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for scheme in ["http", "https"] {
        seen.insert(scheme.to_string());
        normalized.push(scheme.to_string());
    }

    for scheme in schemes {
        let candidate = scheme.trim().trim_end_matches(':').to_ascii_lowercase();
        if !is_valid_url_scheme_token(&candidate) {
            continue;
        }
        if seen.insert(candidate.clone()) {
            normalized.push(candidate);
        }
    }

    normalized
}

fn is_valid_url_scheme_token(scheme: &str) -> bool {
    let mut chars = scheme.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphabetic() => {}
        _ => return false,
    }

    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderBudgetConfig {
    #[serde(default = "default_true")]
    pub show: bool,
    #[serde(default = "default_budget_mode_subscription", rename = "budgetMode")]
    pub budget_mode: String,
    #[serde(default, rename = "monthlyBudget")]
    pub monthly_budget: Option<f64>,
}

fn default_budget_mode_subscription() -> String {
    "subscription".to_string()
}

impl ProviderBudgetConfig {
    fn default_subscription() -> Self {
        ProviderBudgetConfig {
            show: true,
            budget_mode: "subscription".to_string(),
            monthly_budget: None,
        }
    }

    fn default_custom() -> Self {
        ProviderBudgetConfig {
            show: true,
            budget_mode: "custom".to_string(),
            monthly_budget: None,
        }
    }
}

fn default_provider_subscription() -> ProviderBudgetConfig {
    ProviderBudgetConfig::default_subscription()
}

fn default_provider_custom() -> ProviderBudgetConfig {
    ProviderBudgetConfig::default_custom()
}

fn default_provider_custom_hidden() -> ProviderBudgetConfig {
    ProviderBudgetConfig {
        show: false,
        ..ProviderBudgetConfig::default_custom()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSettings {
    #[serde(default = "default_provider_subscription")]
    pub claude: ProviderBudgetConfig,
    #[serde(default = "default_provider_subscription")]
    pub codex: ProviderBudgetConfig,
    #[serde(default = "default_provider_subscription")]
    pub antigravity: ProviderBudgetConfig,
    #[serde(default = "default_provider_subscription")]
    pub gemini: ProviderBudgetConfig,
    #[serde(default = "default_provider_custom")]
    pub opencode: ProviderBudgetConfig,
    #[serde(default = "default_provider_custom_hidden")]
    pub pi: ProviderBudgetConfig,
}

impl Default for UsageSettings {
    fn default() -> Self {
        UsageSettings {
            claude: ProviderBudgetConfig::default_subscription(),
            codex: ProviderBudgetConfig::default_subscription(),
            antigravity: ProviderBudgetConfig::default_subscription(),
            gemini: ProviderBudgetConfig { show: false, ..ProviderBudgetConfig::default_subscription() },
            opencode: ProviderBudgetConfig {
                monthly_budget: Some(100.0),
                ..ProviderBudgetConfig::default_custom()
            },
            pi: ProviderBudgetConfig::default_custom(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoEntry {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: u32,
}

// ── Repo info returned to frontend ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredRepo {
    pub path: String,
    pub workspace: WorkspaceConfig,
}

// ── Per-repo workspace config (<repo>/.shep/workspace.yml) ──────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    pub yolo_flag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub name: String,
    #[serde(default)]
    pub commands: Vec<CommandConfig>,
    #[serde(default)]
    pub assistants: Vec<AssistantConfig>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_settings_default_agent_mode_to_yolo() {
        let settings: ProjectSettings = serde_yaml::from_str(
            "autoImportWorktrees: true\nagentLabelMode: repository\nshowTodos: true\ntodoFileStyle: kanban\n",
        )
        .unwrap();

        assert_eq!(settings.default_agent_mode, "yolo");
        assert_eq!(ProjectSettings::default().default_agent_mode, "yolo");
    }

    #[test]
    fn project_settings_preserve_an_explicit_standard_agent_mode() {
        let settings: ProjectSettings = serde_yaml::from_str(
            "autoImportWorktrees: true\ndefaultAgentMode: standard\nshowTodos: true\ntodoFileStyle: kanban\n",
        )
        .unwrap();

        assert_eq!(settings.default_agent_mode, "standard");
    }
}
