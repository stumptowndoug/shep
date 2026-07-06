use serde_json::Value;
use std::collections::HashMap;
use std::fs;
#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use std::process::Command;

use super::helpers::{home_join, run_command};
use super::types::UsageWindowSnapshot;

/// Fetch Codex rate limit windows from ChatGPT API.
pub fn codex_provider_windows() -> Result<Vec<UsageWindowSnapshot>, String> {
    let auth_path = home_join(".codex/auth.json")?;
    let auth_text = fs::read_to_string(&auth_path)
        .map_err(|e| format!("Failed to read Codex auth file: {e}"))?;
    let auth_json: Value = serde_json::from_str(&auth_text)
        .map_err(|e| format!("Failed to parse Codex auth file: {e}"))?;
    let token = auth_json
        .get("tokens")
        .and_then(|v| v.get("access_token"))
        .and_then(Value::as_str)
        .or_else(|| auth_json.get("access_token").and_then(Value::as_str))
        .ok_or_else(|| "Missing Codex access token".to_string())?;

    let body = run_command(
        "curl",
        &[
            "-sS",
            "--max-time", "10",
            "-H",
            &format!("Authorization: Bearer {token}"),
            "https://chatgpt.com/backend-api/wham/usage",
        ],
    )?;
    let json: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse Codex usage response: {e}"))?;

    let primary = json
        .get("rate_limit")
        .and_then(|v| v.get("primary_window"))
        .ok_or_else(|| "Codex usage response missing primary window".to_string())?;
    let secondary = json
        .get("rate_limit")
        .and_then(|v| v.get("secondary_window"))
        .ok_or_else(|| "Codex usage response missing secondary window".to_string())?;

    Ok(vec![
        percent_window("codex", "5h", primary),
        percent_window("codex", "7d", secondary),
    ])
}

/// Read Claude Code OAuth credentials. macOS stores them in the Keychain;
/// Windows and Linux store the same JSON shape at ~/.claude/.credentials.json.
#[cfg(target_os = "macos")]
fn claude_credentials_json() -> Result<String, String> {
    run_command("security", &["find-generic-password", "-s", "Claude Code-credentials", "-w"])
}

#[cfg(not(target_os = "macos"))]
fn claude_credentials_json() -> Result<String, String> {
    let path = home_join(".claude/.credentials.json")?;
    fs::read_to_string(&path).map_err(|e| format!("Failed to read Claude credentials file: {e}"))
}

/// Fetch Claude rate limit windows from Anthropic API.
pub fn claude_provider_windows() -> Result<(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>), String> {
    let token_json = claude_credentials_json()?;
    let credentials: Value = serde_json::from_str(&token_json)
        .map_err(|e| format!("Failed to parse Claude credentials: {e}"))?;
    let token = credentials
        .get("claudeAiOauth")
        .and_then(|v| v.get("accessToken"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing Claude OAuth access token".to_string())?;

    let body = run_command(
        "curl",
        &[
            "-sS",
            "--max-time", "10",
            "-H",
            &format!("Authorization: Bearer {token}"),
            "-H",
            "anthropic-beta: oauth-2025-04-20",
            "https://api.anthropic.com/api/oauth/usage",
        ],
    )?;
    let json: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse Claude usage response: {e}"))?;

    let mut primary = Vec::new();
    let mut extra = Vec::new();

    if let Some(five_hour) = json.get("five_hour") {
        primary.push(claude_window("5h", five_hour));
    }
    if let Some(seven_day) = json.get("seven_day") {
        primary.push(claude_window("7d", seven_day));
    }
    if let Some(seven_day_sonnet) = json.get("seven_day_sonnet") {
        if !seven_day_sonnet.is_null() {
            extra.push(claude_window("7d_sonnet", seven_day_sonnet));
        }
    }

    if primary.is_empty() {
        Err("Claude usage response did not include expected windows".to_string())
    } else {
        Ok((primary, extra))
    }
}

fn claude_window(window: &str, value: &Value) -> UsageWindowSnapshot {
    let used = value.get("utilization").and_then(Value::as_f64);
    UsageWindowSnapshot {
        provider: "claude".to_string(),
        window_id: format!("claude-{window}"),
        window: window.to_string(),
        label: window.replace('_', " "),
        scope: if window == "5h" { "session" } else { "plan" }.to_string(),
        limit: Some(100.0),
        used,
        source_type: "provider".to_string(),
        confidence: "official".to_string(),
        cost_kind: "included".to_string(),
        used_percent: used,
        remaining_percent: used.map(|v| (100.0 - v).max(0.0)),
        reset_at: value.get("resets_at").and_then(Value::as_str).map(ToString::to_string),
        token_total: None,
        pace_status: None,
    }
}

fn percent_window(provider: &str, label: &str, value: &Value) -> UsageWindowSnapshot {
    let used = value.get("used_percent").and_then(Value::as_f64);
    UsageWindowSnapshot {
        provider: provider.to_string(),
        window_id: format!("{provider}-{label}"),
        window: label.to_string(),
        label: label.to_string(),
        scope: if label == "5h" { "session" } else { "plan" }.to_string(),
        limit: Some(100.0),
        used,
        source_type: "provider".to_string(),
        confidence: "official".to_string(),
        cost_kind: "included".to_string(),
        used_percent: used,
        remaining_percent: used.map(|v| (100.0 - v).max(0.0)),
        reset_at: value.get("reset_at").map(|v| v.to_string()),
        token_total: None,
        pace_status: None,
    }
}

// ── Antigravity ───────────────────────────────────────────

struct AntigravityProcess {
    pid: i64,
    csrf_token: String,
    extension_port: Option<i64>,
    extension_csrf_token: Option<String>,
}

struct AntigravityEndpoint {
    scheme: &'static str,
    port: i64,
    csrf_token: String,
}

struct AntigravityQuota {
    label: String,
    model_id: String,
    remaining_fraction: f64,
    reset_time: Option<String>,
}

pub fn antigravity_provider_windows() -> Result<(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>), String> {
    let process = antigravity_detect_process()?;
    let ports = antigravity_listening_ports(process.pid)?;
    let endpoints = antigravity_endpoints(&process, &ports);
    if endpoints.is_empty() {
        return Err("Antigravity language server has no detectable API port".to_string());
    }

    let quotas = antigravity_fetch_quotas(&endpoints)?;
    antigravity_quotas_to_windows(&quotas)
}

fn antigravity_detect_process() -> Result<AntigravityProcess, String> {
    let output = antigravity_process_list()?;
    let mut saw_tokenless_ide = false;

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((pid_raw, command)) = trimmed.split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = pid_raw.trim().parse::<i64>() else {
            continue;
        };
        let command = command.trim();
        let Some(kind) = antigravity_process_kind(command) else {
            continue;
        };
        let csrf_token = match extract_flag("--csrf_token", command) {
            Some(token) => token,
            None if kind == "cli" => String::new(),
            None => {
                saw_tokenless_ide = true;
                continue;
            }
        };
        return Ok(AntigravityProcess {
            pid,
            csrf_token,
            extension_port: extract_flag("--extension_server_port", command)
                .and_then(|value| value.parse::<i64>().ok()),
            extension_csrf_token: extract_flag("--extension_server_csrf_token", command),
        });
    }

    if saw_tokenless_ide {
        Err("Antigravity language server is missing a CSRF token".to_string())
    } else {
        Err("Antigravity language server not detected. Launch Antigravity or agy and retry.".to_string())
    }
}

#[cfg(unix)]
fn antigravity_process_list() -> Result<String, String> {
    let output = Command::new("/bin/ps")
        .args(["-ax", "-o", "pid=,command="])
        .output()
        .map_err(|e| format!("Failed to run /bin/ps: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "/bin/ps exited with status {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("Invalid UTF-8 from /bin/ps: {e}"))
}

/// Produce the same "PID COMMAND" line format `/bin/ps` emits on unix so the
/// caller's parsing/flag extraction stays shared.
#[cfg(windows)]
fn antigravity_process_list() -> Result<String, String> {
    use sysinfo::{ProcessesToUpdate, System};

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut lines = Vec::new();
    for (pid, process) in sys.processes() {
        let mut command = process
            .cmd()
            .iter()
            .map(|part| part.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        if command.is_empty() {
            command = process
                .exe()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
        }
        if command.is_empty() {
            continue;
        }
        lines.push(format!("{} {}", pid.as_u32(), command));
    }
    Ok(lines.join("\n"))
}

fn antigravity_process_kind(command: &str) -> Option<&'static str> {
    let lower = command.to_lowercase();
    if is_antigravity_ide_language_server(&lower) {
        return Some("ide");
    }
    if is_antigravity_cli_command(&lower) {
        return Some("cli");
    }
    None
}

fn is_antigravity_ide_language_server(lower: &str) -> bool {
    (lower.contains("/language_server") || lower.contains("\\language_server"))
        && (lower.contains("--app_data_dir") && lower.contains("antigravity")
            || lower.contains("/antigravity/")
            || lower.contains("\\antigravity\\"))
}

fn is_antigravity_cli_command(lower: &str) -> bool {
    command_contains_program(lower, "agy")
        || command_contains_program(lower, "antigravity-cli")
        || command_contains_program(lower, "antigravity_cli")
}

fn command_contains_program(command: &str, program: &str) -> bool {
    command == program
        || command.starts_with(&format!("{program} "))
        || command.contains(&format!(" {program} "))
        || command.ends_with(&format!("/{program}"))
        || command.contains(&format!("/{program} "))
        || command.ends_with(&format!("\\{program}"))
        || command.contains(&format!("\\{program} "))
}

fn extract_flag(flag: &str, command: &str) -> Option<String> {
    let bytes = command.as_bytes();
    let flag_bytes = flag.as_bytes();
    let mut index = 0;
    while index + flag_bytes.len() <= bytes.len() {
        if &bytes[index..index + flag_bytes.len()] == flag_bytes {
            let mut value_start = index + flag_bytes.len();
            while value_start < bytes.len() && (bytes[value_start] == b'=' || bytes[value_start].is_ascii_whitespace()) {
                value_start += 1;
            }
            if value_start >= bytes.len() {
                return None;
            }
            let mut value_end = value_start;
            while value_end < bytes.len() && !bytes[value_end].is_ascii_whitespace() {
                value_end += 1;
            }
            return Some(command[value_start..value_end].to_string());
        }
        index += 1;
    }
    None
}

#[cfg(unix)]
fn antigravity_listening_ports(pid: i64) -> Result<Vec<i64>, String> {
    let lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"]
        .into_iter()
        .find(|path| Path::new(path).exists())
        .ok_or_else(|| "lsof not available".to_string())?;
    let output = run_command(lsof, &["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", &pid.to_string()])?;
    let mut ports = Vec::new();
    for line in output.lines() {
        if !line.contains("(LISTEN)") {
            continue;
        }
        let Some(colon) = line.rfind(':') else {
            continue;
        };
        let rest = &line[colon + 1..];
        let port_raw: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let Ok(port) = port_raw.parse::<i64>() else {
            continue;
        };
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    ports.sort_unstable();
    if ports.is_empty() {
        Err("No Antigravity listening ports found".to_string())
    } else {
        Ok(ports)
    }
}

#[cfg(windows)]
fn antigravity_listening_ports(pid: i64) -> Result<Vec<i64>, String> {
    let output = run_command("netstat", &["-ano"])?;
    let mut ports = Vec::new();
    for line in output.lines() {
        // "  TCP    127.0.0.1:42100    0.0.0.0:0    LISTENING    1234"
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 || parts[0] != "TCP" || parts[3] != "LISTENING" {
            continue;
        }
        if parts[4].parse::<i64>() != Ok(pid) {
            continue;
        }
        let Some(colon) = parts[1].rfind(':') else {
            continue;
        };
        let Ok(port) = parts[1][colon + 1..].parse::<i64>() else {
            continue;
        };
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    ports.sort_unstable();
    if ports.is_empty() {
        Err("No Antigravity listening ports found".to_string())
    } else {
        Ok(ports)
    }
}

fn antigravity_endpoints(process: &AntigravityProcess, ports: &[i64]) -> Vec<AntigravityEndpoint> {
    let mut endpoints = Vec::new();
    for port in ports {
        endpoints.push(AntigravityEndpoint {
            scheme: "https",
            port: *port,
            csrf_token: process.csrf_token.clone(),
        });
    }
    if let Some(port) = process.extension_port {
        if let Some(token) = &process.extension_csrf_token {
            endpoints.push(AntigravityEndpoint {
                scheme: "http",
                port,
                csrf_token: token.clone(),
            });
        }
        if process.extension_csrf_token.as_deref() != Some(process.csrf_token.as_str()) {
            endpoints.push(AntigravityEndpoint {
                scheme: "http",
                port,
                csrf_token: process.csrf_token.clone(),
            });
        }
    }
    endpoints
}

fn antigravity_fetch_quotas(endpoints: &[AntigravityEndpoint]) -> Result<Vec<AntigravityQuota>, String> {
    let mut last_error = "No Antigravity endpoint available".to_string();
    for endpoint in endpoints {
        for path in [
            "/exa.language_server_pb.LanguageServerService/GetUserStatus",
            "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs",
        ] {
            match antigravity_request(endpoint, path).and_then(|body| antigravity_parse_quotas(&body)) {
                Ok(quotas) if !quotas.is_empty() => return Ok(quotas),
                Ok(_) => last_error = "Antigravity returned no quota models".to_string(),
                Err(error) => last_error = error,
            }
        }
    }
    Err(last_error)
}

fn antigravity_request(endpoint: &AntigravityEndpoint, path: &str) -> Result<String, String> {
    let url = format!("{}://127.0.0.1:{}{}", endpoint.scheme, endpoint.port, path);
    let csrf_header = format!("X-Codeium-Csrf-Token: {}", endpoint.csrf_token);
    let body = r#"{"metadata":{"ideName":"antigravity","extensionName":"antigravity","ideVersion":"unknown","locale":"en"}}"#;
    run_command(
        "curl",
        &[
            "-skS",
            "--max-time",
            "8",
            "--connect-timeout",
            "2",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-H",
            "Connect-Protocol-Version: 1",
            "-H",
            &csrf_header,
            "-d",
            body,
            &url,
        ],
    )
}

fn antigravity_parse_quotas(body: &str) -> Result<Vec<AntigravityQuota>, String> {
    let json: Value = serde_json::from_str(body)
        .map_err(|e| format!("Failed to parse Antigravity response: {e}"))?;

    if let Some(code) = json.get("code") {
        let text = code
            .as_str()
            .map(ToString::to_string)
            .unwrap_or_else(|| code.to_string());
        let normalized = text.trim_matches('"').to_lowercase();
        if !normalized.is_empty() && normalized != "ok" && normalized != "success" && normalized != "0" {
            return Err(format!("Antigravity API returned code {text}"));
        }
    }

    let model_configs = json
        .pointer("/userStatus/cascadeModelConfigData/clientModelConfigs")
        .and_then(Value::as_array)
        .or_else(|| json.get("clientModelConfigs").and_then(Value::as_array))
        .ok_or_else(|| "Antigravity response missing model configs".to_string())?;

    let mut quotas = Vec::new();
    for config in model_configs {
        let Some(quota) = config.get("quotaInfo") else {
            continue;
        };
        let Some(remaining_fraction) = quota.get("remainingFraction").and_then(Value::as_f64) else {
            continue;
        };
        let model_id = config
            .pointer("/modelOrAlias/model")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let label = config
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or(&model_id)
            .to_string();
        let reset_time = quota.get("resetTime").and_then(Value::as_str).map(ToString::to_string);
        quotas.push(AntigravityQuota {
            label,
            model_id,
            remaining_fraction,
            reset_time,
        });
    }

    Ok(quotas)
}

fn antigravity_quotas_to_windows(quotas: &[AntigravityQuota]) -> Result<(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>), String> {
    let mut summary = Vec::new();
    let families = [
        ("claude", "24h_claude", "Claude quota"),
        ("gemini_pro", "24h_gemini_pro", "Gemini Pro quota"),
        ("gemini_flash", "24h_gemini_flash", "Gemini Flash quota"),
    ];

    for (family, window, label) in families {
        if let Some(quota) = quotas
            .iter()
            .filter(|quota| antigravity_model_family(quota) == family)
            .min_by(|a, b| a.remaining_fraction.total_cmp(&b.remaining_fraction))
        {
            summary.push(antigravity_window(
                &format!("antigravity-{window}"),
                window,
                label,
                quota,
            ));
        }
    }

    if summary.is_empty() {
        if let Some(quota) = quotas
            .iter()
            .min_by(|a, b| a.remaining_fraction.total_cmp(&b.remaining_fraction))
        {
            summary.push(antigravity_window(
                "antigravity-quota",
                "quota",
                &quota.label,
                quota,
            ));
        }
    }

    let mut extra: Vec<_> = quotas
        .iter()
        .map(|quota| {
            antigravity_window(
                &format!("antigravity-model-{}", sanitize_window_id(&quota.model_id)),
                &sanitize_window_id(&quota.model_id),
                &quota.label,
                quota,
            )
        })
        .collect();
    extra.sort_by(|a, b| a.label.cmp(&b.label));

    if summary.is_empty() {
        return Err("No Antigravity quota windows could be derived".to_string());
    }

    Ok((summary, extra))
}

fn antigravity_model_family(quota: &AntigravityQuota) -> &'static str {
    let text = format!("{} {}", quota.label, quota.model_id).to_lowercase();
    if text.contains("claude") {
        "claude"
    } else if text.contains("gemini") && text.contains("pro") && !text.contains("flash") {
        "gemini_pro"
    } else if text.contains("gemini") && text.contains("flash") {
        "gemini_flash"
    } else {
        "other"
    }
}

fn antigravity_window(
    window_id: &str,
    window: &str,
    label: &str,
    quota: &AntigravityQuota,
) -> UsageWindowSnapshot {
    let remaining = (quota.remaining_fraction * 100.0).clamp(0.0, 100.0);
    let used = (100.0 - remaining).max(0.0);
    UsageWindowSnapshot {
        provider: "antigravity".to_string(),
        window_id: window_id.to_string(),
        window: window.to_string(),
        label: label.to_string(),
        scope: "plan".to_string(),
        limit: Some(100.0),
        used: Some(used),
        source_type: "provider".to_string(),
        confidence: "official".to_string(),
        cost_kind: "included".to_string(),
        used_percent: Some(used),
        remaining_percent: Some(remaining),
        reset_at: quota.reset_time.clone(),
        token_total: None,
        pace_status: None,
    }
}

fn sanitize_window_id(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch.to_ascii_lowercase() } else { '-' })
        .collect();
    sanitized.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_process_kind_matches_cli_commands() {
        assert_eq!(antigravity_process_kind("agy --model gemini"), Some("cli"));
        assert_eq!(antigravity_process_kind("/usr/local/bin/antigravity-cli serve"), Some("cli"));
        assert_eq!(antigravity_process_kind("/opt/bin/antigravity_cli"), Some("cli"));
        assert_eq!(antigravity_process_kind("/usr/bin/env agy --dangerously-skip-permissions"), Some("cli"));
    }

    #[test]
    fn antigravity_process_kind_matches_ide_language_server() {
        let command = "/Applications/Antigravity.app/Contents/Resources/app/bin/language_server --app_data_dir /Users/me/Library/Application Support/Antigravity --csrf_token token";
        assert_eq!(antigravity_process_kind(command), Some("ide"));
    }

    #[test]
    fn extract_flag_accepts_space_and_equals_forms() {
        assert_eq!(extract_flag("--csrf_token", "language_server --csrf_token abc123"), Some("abc123".to_string()));
        assert_eq!(extract_flag("--csrf_token", "language_server --csrf_token=abc123"), Some("abc123".to_string()));
        assert_eq!(extract_flag("--csrf_token", "language_server --other abc123"), None);
    }

    #[test]
    fn antigravity_parse_quotas_reads_user_status_shape() {
        let body = r#"{
            "code": "success",
            "userStatus": {
                "cascadeModelConfigData": {
                    "clientModelConfigs": [
                        {
                            "label": "Claude Sonnet 4.5",
                            "modelOrAlias": { "model": "claude-sonnet-4-5" },
                            "quotaInfo": { "remainingFraction": 0.42, "resetTime": "2026-06-10T12:00:00Z" }
                        },
                        {
                            "label": "Gemini 3 Pro",
                            "modelOrAlias": { "model": "gemini-3-pro" }
                        }
                    ]
                }
            }
        }"#;

        let quotas = antigravity_parse_quotas(body).expect("quotas");
        assert_eq!(quotas.len(), 1);
        assert_eq!(quotas[0].label, "Claude Sonnet 4.5");
        assert_eq!(quotas[0].model_id, "claude-sonnet-4-5");
        assert_eq!(quotas[0].remaining_fraction, 0.42);
        assert_eq!(quotas[0].reset_time.as_deref(), Some("2026-06-10T12:00:00Z"));
    }

    #[test]
    fn antigravity_windows_use_24h_summary_names() {
        let quotas = vec![
            AntigravityQuota {
                label: "Claude Sonnet 4.5".to_string(),
                model_id: "claude-sonnet-4-5".to_string(),
                remaining_fraction: 0.5,
                reset_time: None,
            },
            AntigravityQuota {
                label: "Gemini 3 Pro".to_string(),
                model_id: "gemini-3-pro".to_string(),
                remaining_fraction: 0.75,
                reset_time: None,
            },
        ];

        let (summary, extra) = antigravity_quotas_to_windows(&quotas).expect("windows");
        assert_eq!(summary[0].window, "24h_claude");
        assert_eq!(summary[1].window, "24h_gemini_pro");
        assert_eq!(summary[0].used_percent, Some(50.0));
        assert_eq!(summary[1].remaining_percent, Some(75.0));
        assert_eq!(extra.len(), 2);
    }

}

// ── Gemini ────────────────────────────────────────────────

// OAuth client credentials from the Gemini CLI bundle.
// These are public values embedded in the open-source CLI.
const GEMINI_OAUTH_CLIENT_ID: &str = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_OAUTH_CLIENT_SECRET: &str = "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";

/// Fetch Gemini quota windows from Google's internal API.
pub fn gemini_provider_windows() -> Result<Vec<UsageWindowSnapshot>, String> {
    let settings_path = home_join(".gemini/settings.json")?;
    if settings_path.exists() {
        let settings_text = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read Gemini settings: {e}"))?;
        let settings: Value = serde_json::from_str(&settings_text).unwrap_or(Value::Null);
        let auth_type = settings
            .pointer("/security/auth/selectedType")
            .and_then(Value::as_str)
            .unwrap_or("oauth-personal");
        match auth_type {
            "api-key" | "vertex-ai" => return Err(format!("Gemini auth type '{auth_type}' not supported for quota")),
            _ => {} // oauth-personal or unknown — proceed
        }
    }

    let token = gemini_get_access_token()?;
    let project_id = gemini_load_project(&token)?;
    let buckets = gemini_retrieve_quota(&token, &project_id)?;
    gemini_buckets_to_windows(&buckets)
}

/// Read the access token from ~/.gemini/oauth_creds.json, refreshing if expired.
fn gemini_get_access_token() -> Result<String, String> {
    let creds_path = home_join(".gemini/oauth_creds.json")?;
    let creds_text = fs::read_to_string(&creds_path)
        .map_err(|e| format!("Failed to read Gemini OAuth creds: {e}"))?;
    let creds: Value = serde_json::from_str(&creds_text)
        .map_err(|e| format!("Failed to parse Gemini OAuth creds: {e}"))?;

    let expiry = creds.get("expiry_date").and_then(Value::as_u64).unwrap_or(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    if now_ms < expiry.saturating_sub(60_000) {
        // Token still valid (with 60s buffer)
        return creds.get("access_token")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .ok_or_else(|| "Missing access_token in Gemini OAuth creds".to_string());
    }

    // Refresh the token
    let refresh_token = creds.get("refresh_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing refresh_token in Gemini OAuth creds".to_string())?;

    let body = format!(
        "client_id={}&client_secret={}&refresh_token={}&grant_type=refresh_token",
        GEMINI_OAUTH_CLIENT_ID, GEMINI_OAUTH_CLIENT_SECRET, refresh_token
    );

    let response = run_command("curl", &[
        "-sS", "--max-time", "10",
        "-X", "POST",
        "-H", "Content-Type: application/x-www-form-urlencoded",
        "-d", &body,
        "https://oauth2.googleapis.com/token",
    ])?;

    let resp: Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse token refresh response: {e}"))?;

    let new_token = resp.get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            let error = resp.get("error_description")
                .or_else(|| resp.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            format!("Token refresh failed: {error}")
        })?;

    let expires_in = resp.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);

    // Write updated creds back
    let mut updated = creds.clone();
    if let Some(obj) = updated.as_object_mut() {
        obj.insert("access_token".to_string(), Value::String(new_token.to_string()));
        obj.insert("expiry_date".to_string(), Value::Number((now_ms + expires_in * 1000).into()));
        if let Some(new_id_token) = resp.get("id_token") {
            obj.insert("id_token".to_string(), new_id_token.clone());
        }
    }
    let _ = fs::write(&creds_path, serde_json::to_string_pretty(&updated).unwrap_or_default());

    Ok(new_token.to_string())
}

/// Discover the Google Cloud project ID via loadCodeAssist.
fn gemini_load_project(token: &str) -> Result<String, String> {
    let body = r#"{"metadata":{"ideType":"GEMINI_CLI","pluginType":"GEMINI"}}"#;

    let response = run_command("curl", &[
        "-sS", "--max-time", "10",
        "-X", "POST",
        "-H", &format!("Authorization: Bearer {token}"),
        "-H", "Content-Type: application/json",
        "-d", body,
        "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    ])?;

    let resp: Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse loadCodeAssist response: {e}"))?;

    // Try cloudaicompanionProject first
    if let Some(project) = resp.get("cloudaicompanionProject").and_then(Value::as_str) {
        if !project.is_empty() {
            return Ok(project.to_string());
        }
    }

    // Fallback: empty project — retrieveUserQuota may still work
    Ok(String::new())
}

/// Fetch quota buckets from retrieveUserQuota.
fn gemini_retrieve_quota(token: &str, project_id: &str) -> Result<Vec<GeminiQuotaBucket>, String> {
    let body = if project_id.is_empty() {
        "{}".to_string()
    } else {
        format!(r#"{{"project":"{}"}}"#, project_id)
    };

    let response = run_command("curl", &[
        "-sS", "--max-time", "10",
        "-X", "POST",
        "-H", &format!("Authorization: Bearer {token}"),
        "-H", "Content-Type: application/json",
        "-d", &body,
        "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    ])?;

    let resp: Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse retrieveUserQuota response: {e}"))?;

    let buckets = resp.get("buckets")
        .and_then(Value::as_array)
        .ok_or_else(|| "retrieveUserQuota response missing buckets".to_string())?;

    let mut result = Vec::new();
    for bucket in buckets {
        let remaining = bucket.get("remainingFraction").and_then(Value::as_f64);
        let reset = bucket.get("resetTime").and_then(Value::as_str).map(ToString::to_string);
        let model = bucket.get("modelId").and_then(Value::as_str).unwrap_or("unknown").to_string();
        let token_type = bucket.get("tokenType").and_then(Value::as_str).unwrap_or("").to_string();

        if let Some(frac) = remaining {
            result.push(GeminiQuotaBucket {
                model_id: model,
                token_type,
                remaining_fraction: frac,
                reset_time: reset,
            });
        }
    }

    if result.is_empty() {
        return Err("No quota buckets returned".to_string());
    }

    Ok(result)
}

struct GeminiQuotaBucket {
    model_id: String,
    #[allow(dead_code)]
    token_type: String,
    remaining_fraction: f64,
    reset_time: Option<String>,
}

/// Classify a model ID into a display tier.
fn gemini_model_tier(model: &str) -> &'static str {
    if model.contains("pro") && !model.contains("flash") {
        "pro"
    } else if model.contains("flash") && !model.contains("lite") {
        "flash"
    } else if model.contains("lite") {
        "lite"
    } else {
        "other"
    }
}

/// Convert quota buckets to UsageWindowSnapshot entries.
/// Groups by tier (pro/flash/lite), takes the lowest remaining fraction per
/// tier (worst case across all models and token types in that tier).
fn gemini_buckets_to_windows(buckets: &[GeminiQuotaBucket]) -> Result<Vec<UsageWindowSnapshot>, String> {
    // Group by tier — keep lowest remaining fraction and earliest reset
    let mut by_tier: HashMap<&str, (f64, Option<String>)> = HashMap::new();
    for bucket in buckets {
        let tier = gemini_model_tier(&bucket.model_id);
        let entry = by_tier.entry(tier).or_insert((1.0, None));
        if bucket.remaining_fraction < entry.0 {
            entry.0 = bucket.remaining_fraction;
        }
        if entry.1.is_none() {
            entry.1.clone_from(&bucket.reset_time);
        }
    }

    let mut windows: Vec<UsageWindowSnapshot> = by_tier.iter().map(|(tier, (remaining, reset))| {
        let used_pct = ((1.0 - remaining) * 100.0).max(0.0);
        UsageWindowSnapshot {
            provider: "gemini".to_string(),
            window_id: format!("gemini-24h-{tier}"),
            window: format!("24h_{tier}"),
            label: format!("24h {tier}"),
            scope: "plan".to_string(),
            limit: Some(100.0),
            used: Some(used_pct),
            source_type: "provider".to_string(),
            confidence: "official".to_string(),
            cost_kind: "included".to_string(),
            used_percent: Some(used_pct),
            remaining_percent: Some((remaining * 100.0).max(0.0)),
            reset_at: reset.clone(),
            token_total: None,
            pace_status: None,
        }
    }).collect();

    // Sort so pro comes first, then flash, then lite
    windows.sort_by_key(|w| {
        if w.window.contains("pro") { 0 }
        else if w.window.contains("flash") && !w.window.contains("lite") { 1 }
        else if w.window.contains("lite") { 2 }
        else { 3 }
    });

    if windows.is_empty() {
        return Err("No quota windows could be derived".to_string());
    }

    Ok(windows)
}
