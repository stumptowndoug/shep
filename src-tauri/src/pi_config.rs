use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PiSettings {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "defaultProvider"
    )]
    pub default_provider: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "defaultModel"
    )]
    pub default_model: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "defaultThinkingLevel"
    )]
    pub default_thinking_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiConfig {
    pub settings: PiSettings,
    #[serde(rename = "configuredProviders")]
    pub configured_providers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PiAuthEntry {
    #[serde(rename = "type")]
    entry_type: String,
    key: String,
}

fn pi_agent_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".pi")
        .join("agent"))
}

fn pi_settings_path() -> Result<PathBuf, String> {
    Ok(pi_agent_dir()?.join("settings.json"))
}

fn pi_auth_path() -> Result<PathBuf, String> {
    Ok(pi_agent_dir()?.join("auth.json"))
}

pub fn get_pi_config() -> Result<PiConfig, String> {
    let settings = load_pi_settings()?;
    let configured_providers = load_configured_providers()?;
    Ok(PiConfig {
        settings,
        configured_providers,
    })
}

fn load_pi_settings() -> Result<PiSettings, String> {
    let path = pi_settings_path()?;
    if !path.exists() {
        return Ok(PiSettings::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read pi settings: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse pi settings: {e}"))
}

fn load_configured_providers() -> Result<Vec<String>, String> {
    let path = pi_auth_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read pi auth: {e}"))?;
    let auth: HashMap<String, PiAuthEntry> = serde_json::from_str(&content).unwrap_or_default();
    let mut providers: Vec<String> = auth.keys().cloned().collect();
    providers.sort();
    Ok(providers)
}

pub fn save_pi_settings(settings: PiSettings) -> Result<(), String> {
    let dir = pi_agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create ~/.pi/agent dir: {e}"))?;

    let path = pi_settings_path()?;

    // Merge with existing to preserve fields we don't manage (e.g. theme, extensions)
    let mut merged: serde_json::Value = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read pi settings: {e}"))?;
        serde_json::from_str(&content)
            .unwrap_or_else(|_| serde_json::Value::Object(Default::default()))
    } else {
        serde_json::Value::Object(Default::default())
    };

    if let Some(obj) = merged.as_object_mut() {
        match &settings.default_provider {
            Some(v) => {
                obj.insert(
                    "defaultProvider".to_string(),
                    serde_json::Value::String(v.clone()),
                );
            }
            None => {
                obj.remove("defaultProvider");
            }
        }
        match &settings.default_model {
            Some(v) => {
                obj.insert(
                    "defaultModel".to_string(),
                    serde_json::Value::String(v.clone()),
                );
            }
            None => {
                obj.remove("defaultModel");
            }
        }
        match &settings.default_thinking_level {
            Some(v) => {
                obj.insert(
                    "defaultThinkingLevel".to_string(),
                    serde_json::Value::String(v.clone()),
                );
            }
            None => {
                obj.remove("defaultThinkingLevel");
            }
        }
    }

    let json = serde_json::to_string_pretty(&merged)
        .map_err(|e| format!("Failed to serialize pi settings: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write pi settings: {e}"))
}

#[cfg(target_os = "macos")]
pub fn save_pi_api_key(provider: &str, api_key: &str) -> Result<(), String> {
    validate_provider_id(provider)?;
    let service = format!("shep-pi-{provider}");

    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            "shep-pi",
            "-s",
            &service,
            "-w",
            api_key,
        ])
        .output()
        .map_err(|e| format!("Failed to run security command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to save API key to Keychain: {stderr}"));
    }

    update_auth_entry(
        provider,
        &format!("!security find-generic-password -a shep-pi -ws {service}"),
    )
}

/// On non-macOS platforms there is no Keychain-backed `!command` reference the
/// pi CLI can execute, so store the key directly in auth.json (a plain
/// `api_key` entry, which pi supports natively). The file lives in the user's
/// home directory with default user-only ACLs.
#[cfg(not(target_os = "macos"))]
pub fn save_pi_api_key(provider: &str, api_key: &str) -> Result<(), String> {
    validate_provider_id(provider)?;
    update_auth_entry(provider, api_key)
}

#[cfg(target_os = "macos")]
pub fn delete_pi_api_key(provider: &str) -> Result<(), String> {
    validate_provider_id(provider)?;
    let service = format!("shep-pi-{provider}");

    // Ignore errors — key may not exist in Keychain
    let _ = Command::new("security")
        .args(["delete-generic-password", "-a", "shep-pi", "-s", &service])
        .output();

    remove_auth_entry(provider)
}

#[cfg(not(target_os = "macos"))]
pub fn delete_pi_api_key(provider: &str) -> Result<(), String> {
    validate_provider_id(provider)?;
    remove_auth_entry(provider)
}

fn validate_provider_id(provider: &str) -> Result<(), String> {
    if provider.is_empty()
        || !provider
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Invalid provider id: {provider}"));
    }
    Ok(())
}

fn update_auth_entry(provider: &str, key_ref: &str) -> Result<(), String> {
    let dir = pi_agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create ~/.pi/agent dir: {e}"))?;

    let path = pi_auth_path()?;
    let mut auth: HashMap<String, PiAuthEntry> = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read pi auth: {e}"))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        HashMap::new()
    };

    auth.insert(
        provider.to_string(),
        PiAuthEntry {
            entry_type: "api_key".to_string(),
            key: key_ref.to_string(),
        },
    );

    let json = serde_json::to_string_pretty(&auth)
        .map_err(|e| format!("Failed to serialize pi auth: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write pi auth: {e}"))
}

fn remove_auth_entry(provider: &str) -> Result<(), String> {
    let path = pi_auth_path()?;
    if !path.exists() {
        return Ok(());
    }

    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read pi auth: {e}"))?;
    let mut auth: HashMap<String, PiAuthEntry> =
        serde_json::from_str(&content).unwrap_or_default();
    auth.remove(provider);

    let json = serde_json::to_string_pretty(&auth)
        .map_err(|e| format!("Failed to serialize pi auth: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write pi auth: {e}"))
}
