//! Read Antigravity quotas through its authenticated, read-only CLI command.
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::types::UsageWindowSnapshot;

const MAX_OUTPUT: u64 = 1024 * 1024;

/// None means the CLI is absent or too old; callers can use the legacy service.
/// A supported CLI's errors are authoritative, including authentication failures.
pub(super) fn fetch_windows() -> Result<Option<Vec<UsageWindowSnapshot>>, String> {
    let Some(binary) = resolve_binary() else {
        return Ok(None);
    };
    let directory = ProbeDirectory::new()?;
    let version = run(
        &binary,
        &["--version"],
        &directory.0,
        Duration::from_secs(5),
    )?;
    if !supports_usage_report(&version) {
        return Ok(None);
    }
    let report = run(
        &binary,
        &[
            "-p",
            "/usage",
            "--output-format",
            "json",
            "--print-timeout",
            "30s",
        ],
        &directory.0,
        Duration::from_secs(40),
    )?;
    parse_report(&report).map(Some)
}

fn resolve_binary() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|path| path.join("agy")));
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/agy"));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/agy"),
        PathBuf::from("/usr/local/bin/agy"),
    ]);
    candidates
        .into_iter()
        .find(|path| {
            let Ok(meta) = path.metadata() else {
                return false;
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                meta.is_file() && meta.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                meta.is_file()
            }
        })
        .and_then(|path| path.canonicalize().ok())
}

fn supports_usage_report(version: &str) -> bool {
    // Fail closed: an old CLI can interpret /usage as a model prompt.
    let parts: Vec<_> = version.trim().split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    let numbers: Option<Vec<u64>> = parts.iter().map(|part| part.parse().ok()).collect();
    numbers.is_some_and(|v| (v[0], v[1], v[2]) >= (1, 1, 11))
}

fn parse_report(body: &str) -> Result<Vec<UsageWindowSnapshot>, String> {
    let report: Value = serde_json::from_str(body)
        .map_err(|_| "Antigravity returned an invalid usage report".to_string())?;
    if report.get("status").and_then(Value::as_str) != Some("SUCCESS")
        || report.pointer("/command/name").and_then(Value::as_str) != Some("usage")
    {
        return Err("Antigravity usage report failed; check /usage in agy".to_string());
    }
    let groups = report
        .pointer("/command/data/groups")
        .and_then(Value::as_array)
        .ok_or_else(|| "Antigravity usage report is missing quota groups".to_string())?;
    let mut windows = Vec::new();
    for group in groups {
        let Some(buckets) = group.get("buckets").and_then(Value::as_array) else {
            continue;
        };
        for bucket in buckets {
            if group.get("disabled").and_then(Value::as_bool) == Some(true)
                || bucket.get("disabled").and_then(Value::as_bool) == Some(true)
                || group.get("enabled").and_then(Value::as_bool) == Some(false)
                || bucket.get("enabled").and_then(Value::as_bool) == Some(false)
            {
                continue;
            }
            let id = bucket.get("id").and_then(Value::as_str).unwrap_or_default();
            let (window, label) = match id {
                "gemini-weekly" => ("7d", "Gemini weekly"),
                "gemini-5h" => ("5h", "Gemini 5h"),
                "3p-weekly" => ("7d", "Claude + GPT weekly"),
                "3p-5h" => ("5h", "Claude + GPT 5h"),
                _ => continue,
            };
            let Some(fraction) = bucket
                .get("remaining_fraction")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
            else {
                continue;
            };
            let window_id = format!("antigravity-{id}");
            if windows
                .iter()
                .any(|w: &UsageWindowSnapshot| w.window_id == window_id)
            {
                return Err("Antigravity usage report contains duplicate quota buckets".to_string());
            }
            let remaining = fraction * 100.0;
            let used = 100.0 - remaining;
            windows.push(UsageWindowSnapshot {
                provider: "antigravity".to_string(),
                window_id,
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
                reset_at: bucket
                    .get("reset_time")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                token_total: None,
                pace_status: None,
            });
        }
    }
    if windows.is_empty() {
        return Err("Antigravity usage report has no supported quota values".to_string());
    }
    Ok(windows)
}

struct ProbeDirectory(PathBuf);

impl ProbeDirectory {
    fn new() -> Result<Self, String> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "Unable to create Antigravity usage workspace".to_string())?
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("shep-agy-usage-{}-{nonce}", std::process::id()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .map_err(|_| "Unable to create Antigravity usage workspace".to_string())?;
        Ok(Self(path))
    }
}

impl Drop for ProbeDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run(
    binary: &Path,
    args: &[&str],
    directory: &Path,
    timeout: Duration,
) -> Result<String, String> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Unable to start Antigravity usage command".to_string())?;
    let stdout = child.stdout.take().expect("piped stdout");
    // Drain while running, so a report larger than the pipe buffer cannot deadlock.
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let result = stdout
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut output)
            .map(|_| output);
        let _ = sender.send(result);
    });
    let start = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err("Antigravity usage command failed; check that agy is signed in and /usage works".to_string())
                }
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => break Err("Antigravity usage command timed out; retry shortly".to_string()),
            Err(_) => break Err("Unable to wait for Antigravity usage command".to_string()),
        }
    };
    // Also close inherited pipes in any children of this dedicated probe process.
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    let output = receiver
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "Unable to read Antigravity usage report".to_string())?
        .map_err(|_| "Unable to read Antigravity usage report".to_string())?;
    if output.len() as u64 > MAX_OUTPUT {
        return Err("Antigravity usage report exceeded the size limit".to_string());
    }
    result?;
    String::from_utf8(output).map_err(|_| "Antigravity usage report is not UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report() -> Value {
        // Schema captured from agy 1.2.3's read-only /usage command.
        json!({"status": "SUCCESS", "num_turns": 0, "command": {
            "name": "usage", "data": {"groups": [
                {"name": "Gemini Models", "buckets": [
                    {"id": "gemini-weekly", "remaining_fraction": 0.61,
                     "reset_time": "2026-09-19T14:57:18Z"},
                    {"id": "gemini-5h", "remaining_fraction": 0.999}
                ]},
                {"name": "Claude and GPT models", "buckets": [
                    {"id": "3p-weekly", "remaining_fraction": 1.0},
                    {"id": "3p-5h", "remaining_fraction": 0.0}
                ]}
            ]}
        }})
    }

    #[test]
    fn version_gate_prevents_prompt_fallback_on_old_or_unknown_versions() {
        for version in ["1.1.11", "1.2.3\n", "2.0.0"] {
            assert!(supports_usage_report(version), "{version}");
        }
        for version in [
            "1.1.10",
            "0.9.99",
            "1.1",
            "",
            "unknown",
            "1.1.11-beta",
            "1.1.11.0",
        ] {
            assert!(!supports_usage_report(version), "{version}");
        }
    }

    #[test]
    fn maps_real_report_schema_to_distinct_plan_windows() {
        let windows = parse_report(&report().to_string()).unwrap();
        assert_eq!(windows.len(), 4);
        assert_eq!(windows[0].window_id, "antigravity-gemini-weekly");
        assert_eq!(windows[0].window, "7d");
        assert_eq!(windows[0].used_percent, Some(39.0));
        assert_eq!(windows[0].reset_at.as_deref(), Some("2026-09-19T14:57:18Z"));
        assert_eq!(windows[1].window, "5h");
        assert!(windows[1].used_percent.unwrap() > 0.0);
        assert_eq!(windows[2].used_percent, Some(0.0));
        assert_eq!(windows[3].used_percent, Some(100.0));
        assert!(windows
            .iter()
            .all(|w| w.provider == "antigravity" && w.source_type == "provider"));
    }

    #[test]
    fn rejects_errors_and_model_responses_even_if_they_contain_quota_fields() {
        for (field, value) in [
            ("/status", json!("ERROR")),
            ("/command/name", json!("prompt")),
        ] {
            let mut data = report();
            *data.pointer_mut(field).unwrap() = value;
            assert!(parse_report(&data.to_string()).is_err());
        }
        for data in ["not json", "{}", r#"{"status":"SUCCESS","response":"61%"}"#] {
            assert!(parse_report(data).is_err());
        }
    }

    #[test]
    fn unknown_disabled_and_missing_quotas_are_never_assumed_to_be_zero() {
        let mut data = report();
        let buckets = data.pointer_mut("/command/data/groups/0/buckets").unwrap();
        *buckets = json!([
            {"id":"gemini-weekly"},
            {"id":"gemini-5h", "remaining_fraction":null},
            {"id":"future-pool", "remaining_fraction":0.5},
            {"id":"gemini-5h", "remaining_fraction":0.5, "disabled":true},
            {"id":"gemini-weekly", "remaining_fraction":0.5, "enabled":false},
            {"id":"gemini-weekly", "remaining_fraction":-0.1},
            {"id":"gemini-5h", "remaining_fraction":1.1}
        ]);
        let windows = parse_report(&data.to_string()).unwrap();
        assert_eq!(windows.len(), 2);
        data["command"]["data"]["groups"][1]["disabled"] = json!(true);
        assert!(parse_report(&data.to_string()).is_err());
    }

    #[test]
    fn rejects_duplicate_buckets() {
        let mut data = report();
        data["command"]["data"]["groups"][0]["buckets"][1]["id"] = json!("gemini-weekly");
        assert!(parse_report(&data.to_string())
            .unwrap_err()
            .contains("duplicate"));
    }

    #[cfg(unix)]
    #[test]
    fn command_drains_output_and_bounds_failures() {
        let directory = ProbeDirectory::new().unwrap();
        let shell = Path::new("/bin/sh");
        let output = run(
            shell,
            &["-c", "head -c 100000 /dev/zero"],
            &directory.0,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(output.len(), 100000);
        let error = run(
            shell,
            &["-c", "head -c 1100000 /dev/zero"],
            &directory.0,
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.contains("size limit"));
        let error = run(
            shell,
            &["-c", "echo secret >&2; exit 1"],
            &directory.0,
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(!error.contains("secret"));
        let start = Instant::now();
        let error = run(
            shell,
            &["-c", "sleep 10"],
            &directory.0,
            Duration::from_millis(100),
        )
        .unwrap_err();
        assert!(error.contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    #[ignore = "Uses the installed agy and its existing authenticated account"]
    fn live_cli_usage_report() {
        let binary = resolve_binary().expect("agy installed");
        let directory = ProbeDirectory::new().unwrap();
        let version = run(
            &binary,
            &["--version"],
            &directory.0,
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(supports_usage_report(&version));
        let (windows, extra) = super::super::providers::antigravity_provider_windows().unwrap();
        assert!(extra.is_empty());
        assert!(!windows.is_empty());
        for window in windows {
            println!(
                "{}: {:.1}% used",
                window.label,
                window.used_percent.unwrap()
            );
        }
    }
}
