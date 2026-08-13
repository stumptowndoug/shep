use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;

use super::helpers::{home_join, now_epoch_seconds, run_command};
use super::types::{LocalUsageDetails, UsageCost, UsageNamedTokens, UsageWindowSnapshot};

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

    let Some(rate_limit) = json.get("rate_limit") else {
        return Err("Codex usage response missing rate_limit".to_string());
    };
    let windows: Vec<UsageWindowSnapshot> = ["primary_window", "secondary_window"]
        .into_iter()
        .filter_map(|key| rate_limit.get(key))
        .filter(|value| !value.is_null())
        .filter_map(codex_rate_window)
        .collect();
    if windows.is_empty() {
        return Err("Codex usage response did not include any rate windows".to_string());
    }
    Ok(windows)
}

fn codex_rate_window(value: &Value) -> Option<UsageWindowSnapshot> {
    let seconds = value.get("limit_window_seconds").and_then(Value::as_u64)?;
    let label = if seconds <= 6 * 60 * 60 {
        "5h"
    } else if seconds <= 8 * 24 * 60 * 60 {
        "7d"
    } else {
        return None;
    };
    Some(percent_window("codex", label, value))
}

#[derive(Debug, Clone, Default)]
pub struct CursorModelAggregate {
    pub name: String,
    pub tokens_input: u64,
    pub tokens_output: u64,
    pub tokens_cache_read: u64,
    pub tokens_cache_write: u64,
    pub cost: Option<f64>,
}

impl CursorModelAggregate {
    pub(super) fn tokens_total(&self) -> u64 {
        self.tokens_input
            .saturating_add(self.tokens_output)
            .saturating_add(self.tokens_cache_read)
            .saturating_add(self.tokens_cache_write)
    }
}

#[derive(Debug, Clone, Default)]
pub struct CursorWindowAggregate {
    pub tokens_input: u64,
    pub tokens_output: u64,
    pub tokens_cache_read: u64,
    pub tokens_cache_write: u64,
    pub cost: Option<f64>,
    pub models: Vec<CursorModelAggregate>,
}

impl CursorWindowAggregate {
    pub(super) fn tokens_total(&self) -> u64 {
        self.tokens_input
            .saturating_add(self.tokens_output)
            .saturating_add(self.tokens_cache_read)
            .saturating_add(self.tokens_cache_write)
    }

    fn is_empty(&self) -> bool {
        self.tokens_total() == 0 && self.models.is_empty() && self.cost.is_none()
    }
}

#[derive(Debug, Clone)]
pub struct CursorProviderData {
    pub summary: Vec<UsageWindowSnapshot>,
    pub extra: Vec<UsageWindowSnapshot>,
    pub window_24h: CursorWindowAggregate,
    pub window_7d: CursorWindowAggregate,
    pub window_30d: CursorWindowAggregate,
}

/// Fetch billing-period utilization plus token/cost aggregates for 24h / 7d / 30d.
pub fn cursor_provider_data() -> Result<CursorProviderData, String> {
    let token = cursor_access_token()?;
    let (summary, extra) = cursor_period_usage(&token)?;
    Ok(CursorProviderData {
        summary,
        extra,
        window_24h: cursor_window_aggregate(&token, 86_400).unwrap_or_default(),
        window_7d: cursor_window_aggregate(&token, 604_800).unwrap_or_default(),
        window_30d: cursor_window_aggregate(&token, 2_592_000).unwrap_or_default(),
    })
}

fn cursor_dashboard_post(token: &str, method: &str, body: &str) -> Result<String, String> {
    let authorization = format!("Authorization: Bearer {token}");
    let url = format!("https://api2.cursor.sh/aiserver.v1.DashboardService/{method}");
    run_command(
        "curl",
        &[
            "-sS", "--max-time", "10", "-X", "POST",
            "-H", &authorization,
            "-H", "Content-Type: application/json",
            "-H", "Connect-Protocol-Version: 1",
            "-H", "x-cursor-client-type: cli",
            "-H", "x-cursor-client-version: cli-shep",
            "-d", body,
            &url,
        ],
    )
}

fn cursor_period_usage(token: &str) -> Result<(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>), String> {
    cursor_parse_period_usage(&cursor_dashboard_post(token, "GetCurrentPeriodUsage", "{}")?)
}

fn cursor_window_aggregate(token: &str, window_secs: u64) -> Result<CursorWindowAggregate, String> {
    let end_ms = now_epoch_seconds().saturating_mul(1000);
    let start_ms = end_ms.saturating_sub(window_secs.saturating_mul(1000));
    let body = format!(r#"{{"startDate":"{start_ms}","endDate":"{end_ms}"}}"#);
    cursor_parse_aggregated_usage(&cursor_dashboard_post(token, "GetAggregatedUsageEvents", &body)?)
}

fn cursor_access_token() -> Result<String, String> {
    for key in ["CURSOR_AUTH_TOKEN", "CURSOR_API_KEY"] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                return Ok(value);
            }
        }
    }

    if cfg!(target_os = "macos") {
        for service in ["cursor-access-token", "cursor-api-key"] {
            if let Ok(value) = run_command(
                "security",
                &["find-generic-password", "-s", service, "-a", "cursor-user", "-w"],
            ) {
                if !value.trim().is_empty() {
                    return Ok(value);
                }
            }
        }
    }

    for path in [".config/cursor/auth.json", ".cursor/auth.json"] {
        let Ok(auth_text) = fs::read_to_string(home_join(path)?) else {
            continue;
        };
        let Ok(auth) = serde_json::from_str::<Value>(&auth_text) else {
            continue;
        };
        for key in ["accessToken", "access_token", "apiKey", "api_key", "token"] {
            if let Some(token) = auth.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()) {
                return Ok(token.to_string());
            }
        }
    }

    Err("Missing Cursor login. Run `cursor-agent login` to enable subscription utilization.".to_string())
}

fn cursor_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse::<f64>().ok()))
}

fn cursor_percent(plan: &Value, field: &str, spend_field: &str, limit_field: &str) -> Option<f64> {
    cursor_number(plan.get(field)).or_else(|| {
        let spend = cursor_number(plan.get(spend_field))?;
        let limit = cursor_number(plan.get(limit_field))?;
        (limit > 0.0).then_some((spend / limit) * 100.0)
    })
}

fn cursor_usage_window(id: &str, label: &str, used: f64, reset_at: Option<String>) -> UsageWindowSnapshot {
    UsageWindowSnapshot {
        provider: "cursor".to_string(),
        window_id: format!("cursor-{id}"),
        window: "billing".to_string(),
        label: label.to_string(),
        scope: "plan".to_string(),
        limit: Some(100.0),
        used: Some(used),
        source_type: "provider".to_string(),
        confidence: "official".to_string(),
        cost_kind: "included".to_string(),
        used_percent: Some(used),
        remaining_percent: Some((100.0 - used).max(0.0)),
        reset_at,
        token_total: None,
        pace_status: None,
    }
}

fn cursor_parse_period_usage(body: &str) -> Result<(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>), String> {
    let json: Value = serde_json::from_str(body)
        .map_err(|e| format!("Failed to parse Cursor usage response: {e}"))?;
    if let Some(code) = json.get("code") {
        let message = json.get("message").and_then(Value::as_str).unwrap_or("request failed");
        return Err(format!("Cursor usage API returned {code}: {message}. Run `cursor-agent login` and retry."));
    }
    if json.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Err("Cursor subscription utilization is not enabled for this account.".to_string());
    }

    let plan = json.get("planUsage")
        .or_else(|| json.get("plan_usage"))
        .ok_or_else(|| "Cursor usage response missing plan usage".to_string())?;
    let total = cursor_percent(plan, "totalPercentUsed", "totalSpend", "limit")
        .ok_or_else(|| "Cursor usage response missing included utilization".to_string())?;
    let reset_at = cursor_number(json.get("billingCycleEnd").or_else(|| json.get("billing_cycle_end")))
        .map(|millis| (millis / 1000.0).round().to_string());

    let summary = vec![cursor_usage_window("billing", "30d", total, reset_at.clone())];
    let mut extra = Vec::new();
    if let Some(used) = cursor_percent(plan, "autoPercentUsed", "autoSpend", "autoLimit") {
        extra.push(cursor_usage_window("billing-auto", "Auto usage", used, reset_at.clone()));
    }
    if let Some(used) = cursor_percent(plan, "apiPercentUsed", "apiSpend", "apiLimit") {
        extra.push(cursor_usage_window("billing-api", "API usage", used, reset_at));
    }
    Ok((summary, extra))
}

fn cursor_parse_aggregated_usage(body: &str) -> Result<CursorWindowAggregate, String> {
    let json: Value = serde_json::from_str(body)
        .map_err(|e| format!("Failed to parse Cursor aggregate usage: {e}"))?;
    if let Some(code) = json.get("code") {
        let message = json.get("message").and_then(Value::as_str).unwrap_or("request failed");
        return Err(format!("Cursor aggregate usage API returned {code}: {message}"));
    }

    let mut models: Vec<CursorModelAggregate> = json
        .get("aggregations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(cursor_model_aggregate)
        .collect();
    models.sort_by(|a, b| b.tokens_total().cmp(&a.tokens_total()));

    let tokens_input = cursor_u64(json.get("totalInputTokens"))
        .or_else(|| Some(models.iter().map(|model| model.tokens_input).sum()));
    let tokens_output = cursor_u64(json.get("totalOutputTokens"))
        .or_else(|| Some(models.iter().map(|model| model.tokens_output).sum()));
    let tokens_cache_write = cursor_u64(json.get("totalCacheWriteTokens"))
        .or_else(|| Some(models.iter().map(|model| model.tokens_cache_write).sum()));
    let tokens_cache_read = cursor_u64(json.get("totalCacheReadTokens"))
        .or_else(|| Some(models.iter().map(|model| model.tokens_cache_read).sum()));
    let cost = cursor_cents_to_usd(json.get("totalCostCents")).or_else(|| {
        let total: f64 = models.iter().filter_map(|model| model.cost).sum();
        (total > 0.0).then_some(total)
    });

    Ok(CursorWindowAggregate {
        tokens_input: tokens_input.unwrap_or(0),
        tokens_output: tokens_output.unwrap_or(0),
        tokens_cache_read: tokens_cache_read.unwrap_or(0),
        tokens_cache_write: tokens_cache_write.unwrap_or(0),
        cost,
        models,
    })
}

fn cursor_model_aggregate(value: &Value) -> Option<CursorModelAggregate> {
    let name = value
        .get("modelIntent")
        .or_else(|| value.get("model_intent"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())?
        .to_string();
    Some(CursorModelAggregate {
        name,
        tokens_input: cursor_u64(value.get("inputTokens").or_else(|| value.get("input_tokens"))).unwrap_or(0),
        tokens_output: cursor_u64(value.get("outputTokens").or_else(|| value.get("output_tokens"))).unwrap_or(0),
        tokens_cache_read: cursor_u64(value.get("cacheReadTokens").or_else(|| value.get("cache_read_tokens"))).unwrap_or(0),
        tokens_cache_write: cursor_u64(value.get("cacheWriteTokens").or_else(|| value.get("cache_write_tokens"))).unwrap_or(0),
        cost: cursor_cents_to_usd(value.get("totalCents").or_else(|| value.get("total_cents"))),
    })
}

fn cursor_u64(value: Option<&Value>) -> Option<u64> {
    cursor_number(value).map(|value| value.max(0.0).round() as u64)
}

fn cursor_cents_to_usd(value: Option<&Value>) -> Option<f64> {
    cursor_number(value).map(|cents| cents / 100.0)
}

fn cursor_included_cost(amount: Option<f64>) -> UsageCost {
    UsageCost {
        amount,
        kind: "included".to_string(),
        basis: "subscription".to_string(),
        confidence: "official".to_string(),
    }
}

pub fn cursor_local_details(data: &CursorProviderData) -> Option<LocalUsageDetails> {
    if data.window_24h.is_empty() && data.window_7d.is_empty() && data.window_30d.is_empty() {
        return None;
    }
    let primary = &data.window_30d;
    let has_type_breakdown = primary.tokens_input > 0 || primary.tokens_output > 0;
    let cost_7d = data.window_7d.cost;
    let cost_30d = primary.cost;
    Some(LocalUsageDetails {
        source_type: "local".to_string(),
        confidence: "official".to_string(),
        tokens_total: primary.tokens_total(),
        tokens_input: has_type_breakdown.then_some(primary.tokens_input),
        tokens_output: has_type_breakdown.then_some(primary.tokens_output),
        tokens_cached: has_type_breakdown.then_some(
            primary.tokens_cache_read.saturating_add(primary.tokens_cache_write),
        ),
        tokens_thoughts: None,
        tokens_5h: 0,
        tokens_7d: data.window_7d.tokens_total(),
        tokens_30d: primary.tokens_total(),
        cost_total: cost_30d,
        cost_total_detail: cursor_included_cost(cost_30d),
        cost_month: cost_30d,
        cost_month_detail: cursor_included_cost(cost_30d),
        cost_5h: None,
        cost_5h_detail: cursor_included_cost(None),
        cost_7d,
        cost_7d_detail: cursor_included_cost(cost_7d),
        cost_30d,
        cost_30d_detail: cursor_included_cost(cost_30d),
        top_models: primary
            .models
            .iter()
            .map(|model| UsageNamedTokens {
                name: model.name.clone(),
                tokens: model.tokens_total(),
                cost: model.cost,
                cost_detail: cursor_included_cost(model.cost),
            })
            .collect(),
        top_tasks: Vec::new(),
        top_projects: Vec::new(),
    })
}

pub fn cursor_window_for_overview<'a>(data: &'a CursorProviderData, window: &str) -> Option<&'a CursorWindowAggregate> {
    let aggregate = match window {
        "24h" => &data.window_24h,
        "7d" => &data.window_7d,
        "30d" => &data.window_30d,
        _ => return None,
    };
    (!aggregate.is_empty()).then_some(aggregate)
}

#[cfg(test)]
mod cursor_tests {
    use super::{
        cursor_local_details, cursor_parse_aggregated_usage, cursor_parse_period_usage,
        cursor_window_for_overview, CursorModelAggregate, CursorProviderData, CursorWindowAggregate,
    };

    #[test]
    fn maps_cursor_billing_percentages_and_millisecond_reset() {
        let (summary, extra) = cursor_parse_period_usage(r#"{
            "billingCycleStart":"1785542400000",
            "billingCycleEnd":"1788220800000",
            "enabled":true,
            "planUsage":{"totalPercentUsed":42.5,"autoPercentUsed":25,"apiPercentUsed":10}
        }"#).expect("usage windows");
        assert_eq!(summary[0].provider, "cursor");
        assert_eq!(summary[0].window, "billing");
        assert_eq!(summary[0].label, "30d");
        assert_eq!(summary[0].used_percent, Some(42.5));
        assert_eq!(summary[0].reset_at.as_deref(), Some("1788220800"));
        assert_eq!(extra.len(), 2);
    }

    #[test]
    fn reports_connect_auth_errors_cleanly() {
        let error = cursor_parse_period_usage(r#"{"code":"unauthenticated","message":"not logged in"}"#)
            .expect_err("auth error");
        assert!(error.contains("cursor-agent login"));
    }

    #[test]
    fn maps_cursor_aggregate_tokens_cost_and_models() {
        let aggregate = cursor_parse_aggregated_usage(r#"{
            "aggregations": [
                {
                    "modelIntent": "cursor-grok-4.6-high-fast",
                    "inputTokens": "833991",
                    "outputTokens": "130654",
                    "cacheReadTokens": "10320640",
                    "totalCents": 760.4595,
                    "tier": 2
                },
                {
                    "modelIntent": "default",
                    "inputTokens": "16201",
                    "outputTokens": "517",
                    "cacheReadTokens": "16896",
                    "totalCents": 2.757725,
                    "tier": 2
                }
            ],
            "totalInputTokens": "850192",
            "totalOutputTokens": "131171",
            "totalCacheReadTokens": "10337536",
            "totalCostCents": 763.217225
        }"#).expect("aggregate");
        assert_eq!(aggregate.tokens_input, 850192);
        assert_eq!(aggregate.tokens_output, 131171);
        assert_eq!(aggregate.tokens_cache_read, 10337536);
        assert!((aggregate.cost.unwrap() - 7.63217225).abs() < 0.0001);
        assert_eq!(aggregate.models[0].name, "cursor-grok-4.6-high-fast");
        assert_eq!(aggregate.models[1].name, "default");
        assert_eq!(aggregate.models[0].tokens_total(), 833991 + 130654 + 10320640);
    }

    #[test]
    fn local_details_use_30d_totals_and_7d_window() {
        let data = CursorProviderData {
            summary: Vec::new(),
            extra: Vec::new(),
            window_24h: CursorWindowAggregate::default(),
            window_7d: CursorWindowAggregate {
                tokens_input: 10,
                tokens_output: 5,
                tokens_cache_read: 20,
                tokens_cache_write: 0,
                cost: Some(1.25),
                models: Vec::new(),
            },
            window_30d: CursorWindowAggregate {
                tokens_input: 100,
                tokens_output: 50,
                tokens_cache_read: 200,
                tokens_cache_write: 0,
                cost: Some(4.5),
                models: vec![CursorModelAggregate {
                    name: "cursor-grok-4.6-high-fast".to_string(),
                    tokens_input: 100,
                    tokens_output: 50,
                    tokens_cache_read: 200,
                    tokens_cache_write: 0,
                    cost: Some(4.5),
                }],
            },
        };
        let details = cursor_local_details(&data).expect("details");
        assert_eq!(details.tokens_7d, 35);
        assert_eq!(details.tokens_30d, 350);
        assert_eq!(details.tokens_input, Some(100));
        assert_eq!(details.top_models[0].name, "cursor-grok-4.6-high-fast");
        assert_eq!(cursor_window_for_overview(&data, "7d").unwrap().tokens_total(), 35);
        assert!(cursor_window_for_overview(&data, "365d").is_none());
    }
}

#[cfg(test)]
mod codex_tests {
    use super::codex_rate_window;
    use serde_json::json;

    #[test]
    fn weekly_primary_window_is_7d() {
        let window = codex_rate_window(&json!({
            "used_percent": 15,
            "limit_window_seconds": 604800,
            "reset_at": 1787019940
        }))
        .expect("window");
        assert_eq!(window.window, "7d");
        assert_eq!(window.used_percent, Some(15.0));
    }

    #[test]
    fn five_hour_window_still_maps_when_present() {
        let window = codex_rate_window(&json!({
            "used_percent": 40,
            "limit_window_seconds": 18000,
            "reset_at": 1786557812
        }))
        .expect("window");
        assert_eq!(window.window, "5h");
    }
}

/// Fetch Claude rate limit windows from Anthropic API.
pub fn claude_provider_windows() -> Result<(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>), String> {
    let token_json = run_command("security", &["find-generic-password", "-s", "Claude Code-credentials", "-w"])?;
    let credentials: Value = serde_json::from_str(&token_json)
        .map_err(|e| format!("Failed to parse Claude Keychain credentials: {e}"))?;
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

// ── SuperGrok ─────────────────────────────────────────────

/// Fetch SuperGrok's unofficial weekly usage pool from grok.com billing.
/// Uses the OIDC session in ~/.grok/auth.json, not XAI_API_KEY.
pub fn grok_provider_windows() -> Result<Vec<UsageWindowSnapshot>, String> {
    let token = grok_access_token()?;
    let body = grok_billing_request(&token)?;
    grok_windows_from_grpc_web(&body)
}

fn grok_access_token() -> Result<String, String> {
    let auth_path = home_join(".grok/auth.json")?;
    let auth_text = fs::read_to_string(&auth_path)
        .map_err(|e| format!("Failed to read Grok auth file: {e}"))?;
    let auth_json: Value = serde_json::from_str(&auth_text)
        .map_err(|e| format!("Failed to parse Grok auth file: {e}"))?;
    let object = auth_json
        .as_object()
        .ok_or_else(|| "Grok auth file is not an object".to_string())?;

    let entry = object
        .iter()
        .find(|(key, _)| key.starts_with("https://auth.x.ai::"))
        .or_else(|| object.iter().find(|(key, _)| key.contains("accounts.x.ai")))
        .map(|(_, value)| value)
        .or_else(|| object.values().next())
        .ok_or_else(|| "Missing Grok SuperGrok login. Run `grok login`.".to_string())?;

    entry
        .get("key")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "Grok auth file is missing an access token".to_string())
}

fn grok_billing_request(token: &str) -> Result<Vec<u8>, String> {
    let empty_frame = [0u8; 5];
    let mut child = Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "10",
            "-X",
            "POST",
            "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
            "-H",
            &format!("Authorization: Bearer {token}"),
            "-H",
            "Origin: https://grok.com",
            "-H",
            "Referer: https://grok.com/?_s=usage",
            "-H",
            "Accept: */*",
            "-H",
            "Content-Type: application/grpc-web+proto",
            "-H",
            "x-grpc-web: 1",
            "-H",
            "x-user-agent: connect-es/2.1.1",
            "--data-binary",
            "@-",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to request SuperGrok usage: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(&empty_frame)
            .map_err(|e| format!("Failed to write SuperGrok usage request: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to request SuperGrok usage: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "SuperGrok usage request failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn grok_windows_from_grpc_web(body: &[u8]) -> Result<Vec<UsageWindowSnapshot>, String> {
    let (used_percent, reset_at) = parse_grok_billing(body)?;
    Ok(vec![UsageWindowSnapshot {
        provider: "grok".to_string(),
        window_id: "grok-7d".to_string(),
        window: "7d".to_string(),
        label: "7d".to_string(),
        scope: "plan".to_string(),
        limit: Some(100.0),
        used: Some(used_percent),
        source_type: "provider".to_string(),
        confidence: "observed".to_string(),
        cost_kind: "included".to_string(),
        used_percent: Some(used_percent),
        remaining_percent: Some((100.0 - used_percent).max(0.0)),
        reset_at,
        token_total: None,
        pace_status: None,
    }])
}

fn parse_grok_billing(body: &[u8]) -> Result<(f64, Option<String>), String> {
    let payloads = grpc_web_data_frames(body);
    let mut percents = Vec::new();
    let mut resets = Vec::new();
    for payload in payloads {
        scan_protobuf(&payload, &[], 0, &mut percents, &mut resets);
    }
    let used_percent = percents
        .into_iter()
        .find(|value| value.is_finite() && (0.0..=100.0).contains(value))
        .ok_or_else(|| "SuperGrok billing response did not include a weekly usage percent".to_string())?;
    let reset_at = resets.into_iter().next().map(unix_seconds_to_iso);
    Ok((used_percent, reset_at))
}

fn grpc_web_data_frames(body: &[u8]) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let mut index = 0;
    while index + 5 <= body.len() {
        let flags = body[index];
        let length = u32::from_be_bytes([
            body[index + 1],
            body[index + 2],
            body[index + 3],
            body[index + 4],
        ]) as usize;
        let start = index + 5;
        let end = start.saturating_add(length);
        if end > body.len() {
            break;
        }
        if flags & 0x80 == 0 {
            frames.push(body[start..end].to_vec());
        }
        index = end;
    }
    if frames.is_empty() && !body.is_empty() {
        frames.push(body.to_vec());
    }
    frames
}

fn scan_protobuf(
    buf: &[u8],
    path: &[u64],
    depth: usize,
    percents: &mut Vec<f64>,
    resets: &mut Vec<u64>,
) {
    let mut index = 0;
    while index < buf.len() {
        let Some((key, next)) = read_varint(buf, index) else {
            break;
        };
        index = next;
        let field = key >> 3;
        let wire = key & 7;
        let mut field_path = path.to_vec();
        field_path.push(field);
        match wire {
            0 => {
                let Some((value, next)) = read_varint(buf, index) else {
                    break;
                };
                index = next;
                if (1_700_000_000..=2_100_000_000).contains(&value) && field_path.ends_with(&[5, 1]) {
                    resets.push(value);
                }
            }
            1 => {
                if index + 8 > buf.len() {
                    break;
                }
                index += 8;
            }
            2 => {
                let Some((length, next)) = read_varint(buf, index) else {
                    break;
                };
                index = next;
                let end = index.saturating_add(length as usize);
                if end > buf.len() {
                    break;
                }
                if depth < 4 {
                    scan_protobuf(&buf[index..end], &field_path, depth + 1, percents, resets);
                }
                index = end;
            }
            5 => {
                if index + 4 > buf.len() {
                    break;
                }
                let bits = u32::from_le_bytes([
                    buf[index],
                    buf[index + 1],
                    buf[index + 2],
                    buf[index + 3],
                ]);
                percents.push(f32::from_bits(bits) as f64);
                index += 4;
            }
            _ => break,
        }
    }
}

fn read_varint(buf: &[u8], mut index: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0;
    while index < buf.len() {
        let byte = buf[index];
        index += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return Some((value, index));
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
    None
}

fn unix_seconds_to_iso(seconds: u64) -> String {
    let days = seconds / 86400;
    let time = seconds % 86400;
    let h = time / 3600;
    let m = (time % 3600) / 60;
    let s = time % 60;
    let z = days as i64 + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

#[cfg(test)]
mod grok_tests {
    use super::{grok_windows_from_grpc_web, parse_grok_billing};

    fn sample_body() -> Vec<u8> {
        vec![
            0x00, 0x00, 0x00, 0x00, 0x52, 0x0a, 0x50, 0x0d, 0x00, 0x00, 0xd8, 0x41, 0x12, 0x00,
            0x1a, 0x00, 0x22, 0x0b, 0x08, 0xf7, 0xca, 0xf2, 0xd3, 0x06, 0x10, 0x80, 0xa7, 0x9a,
            0x70, 0x2a, 0x0b, 0x08, 0xf7, 0xbf, 0x97, 0xd4, 0x06, 0x10, 0x80, 0xa7, 0x9a, 0x70,
            0x3a, 0x07, 0x08, 0x02, 0x15, 0x00, 0x00, 0xd8, 0x41, 0x42, 0x1c, 0x08, 0x02, 0x12,
            0x0b, 0x08, 0xf7, 0xca, 0xf2, 0xd3, 0x06, 0x10, 0x80, 0xa7, 0x9a, 0x70, 0x1a, 0x0b,
            0x08, 0xf7, 0xbf, 0x97, 0xd4, 0x06, 0x10, 0x80, 0xa7, 0x9a, 0x70, 0x58, 0x01, 0x62,
            0x00, 0x68, 0x01, 0x80, 0x00, 0x00, 0x00, 0x0f, 0x67, 0x72, 0x70, 0x63, 0x2d, 0x73,
            0x74, 0x61, 0x74, 0x75, 0x73, 0x3a, 0x30, 0x0d, 0x0a,
        ]
    }

    #[test]
    fn parse_grok_billing_reads_weekly_percent_and_reset() {
        let (used, reset) = parse_grok_billing(&sample_body()).expect("billing");
        assert!((used - 27.0).abs() < 0.01, "used={used}");
        assert_eq!(reset.as_deref(), Some("2026-08-19T16:55:19Z"));
    }

    #[test]
    fn grok_windows_use_the_weekly_plan_slot() {
        let windows = grok_windows_from_grpc_web(&sample_body()).expect("windows");
        assert_eq!(windows[0].provider, "grok");
        assert_eq!(windows[0].window, "7d");
        assert_eq!(windows[0].used_percent, Some(27.0));
    }
}
