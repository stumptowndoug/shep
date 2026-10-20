//! Chat adapters published on npm. Shep installs each one into its own
//! application data folder with the user's npm, so the result never depends on
//! npm's global prefix or on which folders happen to be on PATH. At launch, at
//! most once a day, Shep moves every adapter the user has set up to its newest
//! release.
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};

use crate::acp_runtime::RuntimeCommand;
use crate::shell_path::{self, executable, find_in};

pub struct NpmAdapter {
    id: &'static str,
    package: &'static str,
    /// Installed when npm can't say which release is newest.
    fallback: &'static str,
    bin: &'static str,
}

// None of these need npm install scripts; the ignored install test checks each
// fallback.
const ADAPTERS: [NpmAdapter; 4] = [
    NpmAdapter {
        id: "claude",
        package: "@agentclientprotocol/claude-agent-acp",
        fallback: "0.89.1",
        bin: "claude-agent-acp",
    },
    NpmAdapter {
        id: "codex",
        package: "@agentclientprotocol/codex-acp",
        fallback: "2.2.2",
        bin: "codex-acp",
    },
    NpmAdapter {
        id: "pi",
        package: "pi-acp",
        fallback: "0.0.34",
        bin: "pi-acp",
    },
    // Community adapter; Meta does not publish one. Ships prebuilt binaries
    // and a small node launcher.
    NpmAdapter {
        id: "muse",
        package: "@brokkai/muse-acp",
        fallback: "0.12.1",
        bin: "muse-acp",
    },
];

const MANIFEST: &str = "shep-install.json";
pub(crate) const LAST_CHECK: &str = "last-update-check";
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// A broken or hijacked release is usually pulled within days, so Shep only
/// installs releases that have been out at least this long.
const MIN_RELEASE_AGE_DAYS: i64 = 3;
const NODE_MISSING: &str =
    "Chat needs Node.js. Install it from nodejs.org or with `brew install node`, then try again.";
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: String,
    /// The node found at install time, kept unresolved so a Homebrew link
    /// keeps working after node upgrades.
    node: String,
}

/// A release version; prereleases don't parse, so they're never installed.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub(crate) struct Version(u64, u64, u64);

impl Version {
    pub(crate) fn parse(text: &str) -> Option<Self> {
        let mut parts = text.split('.').map(|part| part.parse::<u64>().ok());
        let version = Version(parts.next()??, parts.next()??, parts.next()??);
        parts.next().is_none().then_some(version)
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

pub fn find(id: &str) -> Option<&'static NpmAdapter> {
    ADAPTERS.iter().find(|adapter| adapter.id == id)
}

/// npm on PATH, or where Homebrew and the Node installer put it when Shep's
/// PATH is missing those folders.
fn find_npm() -> Option<PathBuf> {
    shell_path::find("npm").or_else(|| {
        let mut dirs = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ];
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join("homebrew/bin"));
        }
        find_in(dirs, "npm")
    })
}

fn acp_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Application data directory is unavailable")?;
    Ok(base.join("shep/acp"))
}

/// Each version installs into its own folder, so an update never changes
/// files under a running adapter.
fn versions_dir(adapter: &NpmAdapter) -> Result<PathBuf, String> {
    Ok(acp_dir()?.join("npm").join(adapter.id))
}

/// Where Shep 0.11 and earlier installed the adapter.
fn legacy_dir(adapter: &NpmAdapter) -> Result<PathBuf, String> {
    Ok(acp_dir()?.join(adapter.id))
}

/// How to start Shep's own copy in `dir`, or None if it isn't usable.
fn managed_command(adapter: &NpmAdapter, dir: &Path) -> Option<RuntimeCommand> {
    let script = dir.join("node_modules/.bin").join(adapter.bin);
    if !script.is_file() {
        return None;
    }
    let manifest: Option<Manifest> = fs::read(dir.join(MANIFEST))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let node = manifest
        .map(|manifest| PathBuf::from(manifest.node))
        .filter(|node| executable(node))
        .or_else(|| shell_path::find("node"))?;
    Some(RuntimeCommand {
        command: node.to_string_lossy().into_owned(),
        args: vec![script.to_string_lossy().into_owned()],
    })
}

/// The newest working copy in `versions`.
fn newest_copy(adapter: &NpmAdapter, versions: &Path) -> Option<(Version, RuntimeCommand)> {
    fs::read_dir(versions)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let version = Version::parse(&entry.file_name().to_string_lossy())?;
            Some((version, managed_command(adapter, &entry.path())?))
        })
        .max_by_key(|(version, _)| *version)
}

fn user_copy(adapter: &NpmAdapter) -> Option<RuntimeCommand> {
    shell_path::find(adapter.bin).map(|path| RuntimeCommand {
        command: path.to_string_lossy().into_owned(),
        args: vec![],
    })
}

/// Shep's own copy, which stays current, ahead of one the user installed.
pub fn get(adapter: &NpmAdapter) -> Result<Option<RuntimeCommand>, String> {
    if let Some((_, runtime)) = newest_copy(adapter, &versions_dir(adapter)?) {
        return Ok(Some(runtime));
    }
    Ok(user_copy(adapter).or(managed_command(adapter, &legacy_dir(adapter)?)))
}

/// Sets up chat for an agent: installs its newest release unless Shep already
/// has a copy.
pub fn install(adapter: &NpmAdapter) -> Result<RuntimeCommand, String> {
    let _lock = INSTALL_LOCK
        .lock()
        .map_err(|_| "Adapter installer is unavailable")?;
    let versions = versions_dir(adapter)?;
    if let Some((_, runtime)) = newest_copy(adapter, &versions) {
        return Ok(runtime);
    }
    let tools = NodeTools::find()?;
    let version = newest_release(adapter, &tools, &versions)
        .map(|version| version.to_string())
        .unwrap_or_else(|_| adapter.fallback.into());
    install_into(adapter, &tools, &version, &versions.join(&version))
}

/// Runs on a background thread at launch: clears out copies nothing can be
/// using yet, then updates each adapter the user has set up.
pub fn update_on_launch() {
    let Ok(npm_dir) = acp_dir().map(|dir| dir.join("npm")) else {
        return;
    };
    let due = check_due(&npm_dir.join(LAST_CHECK), SystemTime::now());
    let mut checked = false;
    for adapter in &ADAPTERS {
        let (Ok(legacy), Ok(versions)) = (legacy_dir(adapter), versions_dir(adapter)) else {
            continue;
        };
        let Ok(_lock) = INSTALL_LOCK.lock() else {
            return;
        };
        prune_in(adapter, &legacy, &versions);
        let current = newest_copy(adapter, &versions).map(|(version, _)| version);
        let set_up = current.is_some()
            || user_copy(adapter).is_some()
            || managed_command(adapter, &legacy).is_some();
        // A user who only has their own copy gets Shep's at the next launch,
        // even within a day of the last check.
        if !set_up || (current.is_some() && !due) {
            continue;
        }
        checked = true;
        if let Err(error) = update(adapter, current, &versions) {
            if cfg!(debug_assertions) {
                eprintln!("Couldn’t update the {} chat adapter: {error}", adapter.id);
            }
        }
    }
    if checked && due {
        record_check(&npm_dir.join(LAST_CHECK));
    }
}

fn update(adapter: &NpmAdapter, current: Option<Version>, versions: &Path) -> Result<(), String> {
    let tools = NodeTools::find()?;
    let newest = newest_release(adapter, &tools, versions)?;
    if current.is_some_and(|current| current >= newest) {
        return Ok(());
    }
    let version = newest.to_string();
    install_into(adapter, &tools, &version, &versions.join(&version)).map(|_| ())
}

pub(crate) fn record_check(stamp: &Path) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    if let Some(dir) = stamp.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(stamp, now.to_string());
}

pub(crate) fn check_due(stamp: &Path, now: SystemTime) -> bool {
    let last = fs::read_to_string(stamp)
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok())
        .map(|secs| UNIX_EPOCH + Duration::from_secs(secs));
    last.is_none_or(|last| {
        now.duration_since(last)
            .is_ok_and(|age| age >= CHECK_INTERVAL)
    })
}

/// Keeps only the newest working copy. Runs at launch, before any chat can be
/// using an older one.
fn prune_in(adapter: &NpmAdapter, legacy: &Path, versions: &Path) {
    let Some((newest, _)) = newest_copy(adapter, versions) else {
        return;
    };
    let _ = fs::remove_dir_all(legacy);
    let Ok(entries) = fs::read_dir(versions) else {
        return;
    };
    for entry in entries.flatten() {
        if Version::parse(&entry.file_name().to_string_lossy()) == Some(newest) {
            continue;
        }
        let path = entry.path();
        let _ = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
    }
}

/// The newest release old enough to install, as npm's registry lists it.
fn newest_release(
    adapter: &NpmAdapter,
    tools: &NodeTools,
    scratch: &Path,
) -> Result<Version, String> {
    fs::create_dir_all(scratch).map_err(|e| e.to_string())?;
    let output = scratch.join(format!(".view-{}-{}", std::process::id(), stamp()?));
    let result = (|| {
        let child = tools
            .npm(["view", adapter.package, "dist-tags", "time", "--json"])
            .current_dir(scratch)
            .stdin(Stdio::null())
            .stdout(Stdio::from(
                File::create(&output).map_err(|e| e.to_string())?,
            ))
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Couldn’t run npm: {e}"))?;
        let status = wait(child, LOOKUP_TIMEOUT)
            .ok_or("Looking up chat adapter releases took too long.")??;
        if !status.success() {
            return Err("npm couldn’t look up chat adapter releases.".into());
        }
        let view: serde_json::Value =
            serde_json::from_slice(&fs::read(&output).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        pick_release(&view, Utc::now()).ok_or_else(|| "No release is old enough yet.".into())
    })();
    let _ = fs::remove_file(&output);
    result
}

/// The newest release no newer than `latest` that has been out long enough.
fn pick_release(view: &serde_json::Value, now: DateTime<Utc>) -> Option<Version> {
    let latest = Version::parse(view["dist-tags"]["latest"].as_str()?)?;
    let cutoff = now - TimeDelta::days(MIN_RELEASE_AGE_DAYS);
    view["time"]
        .as_object()?
        .iter()
        .filter_map(|(version, published)| {
            let version = Version::parse(version)?;
            let published = DateTime::parse_from_rfc3339(published.as_str()?).ok()?;
            (version <= latest && published <= cutoff).then_some(version)
        })
        .max()
}

struct NodeTools {
    npm: PathBuf,
    node: PathBuf,
}

impl NodeTools {
    fn find() -> Result<Self, String> {
        let npm = find_npm().ok_or(NODE_MISSING)?;
        let node = npm
            .parent()
            .map(|dir| dir.join("node"))
            .filter(|node| executable(node))
            .or_else(|| shell_path::find("node"))
            .ok_or(NODE_MISSING)?;
        Ok(NodeTools { npm, node })
    }

    fn npm<const N: usize>(&self, args: [&str; N]) -> Command {
        // npm starts with `#!/usr/bin/env node`, so the node beside it must be on PATH.
        let mut path_dirs: Vec<PathBuf> = [self.npm.parent(), self.node.parent()]
            .into_iter()
            .flatten()
            .map(Path::to_path_buf)
            .collect();
        if let Some(existing) = shell_path::current() {
            path_dirs.extend(std::env::split_paths(&existing));
        }
        let mut command = Command::new(&self.npm);
        command.args(args);
        if let Ok(path) = std::env::join_paths(path_dirs) {
            command.env("PATH", path);
        }
        command
    }
}

fn stamp() -> Result<u128, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos())
}

/// The child's exit status, or None after killing it at `timeout`.
fn wait(mut child: Child, timeout: Duration) -> Option<Result<ExitStatus, String>> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(Ok(status)),
            Ok(None) if Instant::now() > deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(error) => return Some(Err(error.to_string())),
        }
    }
}

fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<_> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

fn run_npm_install(tools: &NodeTools, stage: &Path, log: &Path, spec: &str) -> Result<(), String> {
    let stage_arg = stage.to_string_lossy();
    let child = tools
        .npm([
            "install",
            "--no-audit",
            "--no-fund",
            "--ignore-scripts",
            "--omit=dev",
            "--prefix",
            &*stage_arg,
            spec,
        ])
        .current_dir(stage)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(File::create(log).map_err(|e| e.to_string())?))
        .spawn()
        .map_err(|e| format!("Couldn’t run npm: {e}"))?;
    let status = wait(child, INSTALL_TIMEOUT).ok_or(
        "Installing the chat adapter took too long. Check your connection and try again.",
    )??;
    if !status.success() {
        let output = fs::read_to_string(log).unwrap_or_default();
        return Err(format!(
            "Couldn’t install the chat adapter with npm.\n{}",
            last_lines(&output, 4)
        ));
    }
    Ok(())
}

/// The adapter starts and answers ACP initialize, which catches a release that
/// needs a newer Node or no longer runs on this machine.
pub(crate) fn answers_initialize(command: &RuntimeCommand) -> Result<(), String> {
    let mut process = Command::new(&command.command);
    process
        .args(&command.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(path) = shell_path::current() {
        process.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group, so stopping it also stops a CLI the adapter started.
        process.process_group(0);
    }
    let mut child = process
        .spawn()
        .map_err(|e| format!("The chat adapter didn’t start: {e}"))?;
    let (sender, receiver) = mpsc::channel();
    let stdout = child.stdout.take();
    std::thread::spawn(move || {
        let Some(stdout) = stdout else { return };
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { return };
            // Adapters occasionally log to stdout before replying.
            if let Ok(reply) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = sender.send(reply);
                return;
            }
        }
    });
    // Keep stdin open until the reply: some adapters exit at end of input.
    let mut stdin = child.stdin.take();
    let request = br#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"shep","version":"update-check"}}}"#;
    let sent = stdin.as_mut().is_some_and(|stdin| {
        stdin
            .write_all(request)
            .and_then(|_| stdin.write_all(b"\n"))
            .is_ok()
    });
    let reply = sent
        .then(|| receiver.recv_timeout(HANDSHAKE_TIMEOUT).ok())
        .flatten();
    drop(stdin);
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    match reply {
        Some(reply) if reply["result"]["protocolVersion"] == 1 => Ok(()),
        _ => Err("The chat adapter didn’t answer Shep’s handshake.".into()),
    }
}

fn install_into(
    adapter: &NpmAdapter,
    tools: &NodeTools,
    version: &str,
    target: &Path,
) -> Result<RuntimeCommand, String> {
    let parent = target.parent().ok_or("Invalid adapter directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stamp = stamp()?;
    let stage = parent.join(format!(".install-{}-{stamp}", std::process::id()));
    let log = parent.join(format!(".install-{}-{stamp}.log", std::process::id()));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        run_npm_install(
            tools,
            &stage,
            &log,
            &format!("{}@{version}", adapter.package),
        )?;
        let manifest = Manifest {
            version: version.into(),
            node: tools.node.to_string_lossy().into_owned(),
        };
        fs::write(
            stage.join(MANIFEST),
            serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let staged = managed_command(adapter, &stage)
            .ok_or("npm finished, but the chat adapter wasn’t installed. Try again.")?;
        answers_initialize(&staged)?;
        // Replace a broken copy without exposing half an install.
        let backup = parent.join(format!(".previous-{stamp}"));
        if target.exists() {
            fs::rename(target, &backup).map_err(|e| e.to_string())?;
        }
        if let Err(error) = fs::rename(&stage, target) {
            if backup.exists() {
                let _ = fs::rename(&backup, target);
            }
            return Err(error.to_string());
        }
        if backup.exists() {
            let _ = fs::remove_dir_all(backup);
        }
        managed_command(adapter, target)
            .ok_or_else(|| "The chat adapter installation could not be verified.".into())
    })();
    let _ = fs::remove_dir_all(&stage);
    let _ = fs::remove_file(&log);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shep-npm-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_executable(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// A runnable managed copy of `adapter` in `dir`.
    fn fake_install(adapter: &NpmAdapter, dir: &Path) {
        write_executable(&dir.join("node_modules/.bin").join(adapter.bin));
        let node = dir.join("node");
        write_executable(&node);
        let manifest = Manifest {
            version: "1".into(),
            node: node.to_string_lossy().into_owned(),
        };
        fs::write(dir.join(MANIFEST), serde_json::to_vec(&manifest).unwrap()).unwrap();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn only_known_adapters_are_installable() {
        for id in ["claude", "codex", "pi", "muse"] {
            assert!(find(id).is_some(), "{id}");
        }
        assert!(find("../claude").is_none());
        assert!(find("antigravity").is_none());
    }

    #[test]
    fn fallbacks_are_release_versions() {
        for adapter in &ADAPTERS {
            assert!(Version::parse(adapter.fallback).is_some(), "{}", adapter.id);
        }
    }

    #[test]
    fn managed_copy_runs_the_script_with_the_recorded_node() {
        let dir = temp_dir("managed");
        let adapter = find("claude").unwrap();
        assert!(managed_command(adapter, &dir).is_none());

        fake_install(adapter, &dir);
        let command = managed_command(adapter, &dir).unwrap();
        assert_eq!(command.command, dir.join("node").to_string_lossy());
        assert_eq!(
            command.args,
            vec![dir
                .join("node_modules/.bin/claude-agent-acp")
                .to_string_lossy()
                .into_owned()]
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn versions_compare_numerically_and_skip_prereleases() {
        assert!(Version::parse("0.10.0") > Version::parse("0.9.9"));
        assert_eq!(Version::parse("2.2.3-preview.15"), None);
        assert_eq!(Version::parse("1.2"), None);
        assert_eq!(Version::parse("1.2.3.4"), None);
        assert_eq!(Version::parse("created"), None);
    }

    #[test]
    fn the_newest_working_copy_runs() {
        let dir = temp_dir("newest");
        let adapter = find("codex").unwrap();
        fake_install(adapter, &dir.join("0.9.0"));
        fake_install(adapter, &dir.join("0.10.0"));
        fs::create_dir_all(dir.join("0.11.0")).unwrap(); // Not a working copy.
        fake_install(adapter, &dir.join(".install-123"));
        let (version, _) = newest_copy(adapter, &dir).unwrap();
        assert_eq!(version, Version(0, 10, 0));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prune_keeps_only_the_newest_working_copy() {
        let dir = temp_dir("prune");
        let adapter = find("pi").unwrap();
        let (legacy, versions) = (dir.join("pi"), dir.join("npm/pi"));
        fake_install(adapter, &legacy);

        prune_in(adapter, &legacy, &versions);
        assert!(
            legacy.exists(),
            "nothing is removed before Shep has a versioned copy"
        );

        fake_install(adapter, &versions.join("0.0.9"));
        fake_install(adapter, &versions.join("0.0.10"));
        fs::create_dir_all(versions.join(".install-stale")).unwrap();
        prune_in(adapter, &legacy, &versions);
        assert!(!legacy.exists());
        assert_eq!(names(&versions), vec!["0.0.10"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn releases_must_be_out_three_days_and_no_newer_than_latest() {
        let now = DateTime::parse_from_rfc3339("2026-10-19T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let view = serde_json::json!({
            "dist-tags": { "latest": "2.2.0", "next": "3.0.0" },
            "time": {
                "created": "2026-01-01T00:00:00Z",
                "modified": "2026-10-19T00:00:00Z",
                "2.0.0": "2026-09-01T00:00:00Z",
                "2.1.0": "2026-10-15T00:00:00Z",
                "2.1.1-beta.1": "2026-10-15T06:00:00Z",
                "2.2.0": "2026-10-18T00:00:00Z",
                "3.0.0": "2026-10-01T00:00:00Z"
            }
        });
        assert_eq!(pick_release(&view, now), Some(Version(2, 1, 0)));

        let later = now + TimeDelta::days(2);
        assert_eq!(pick_release(&view, later), Some(Version(2, 2, 0)));

        let too_soon = DateTime::parse_from_rfc3339("2026-09-02T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(pick_release(&view, too_soon), None);
    }

    #[test]
    fn updates_are_checked_at_most_once_a_day() {
        let dir = temp_dir("due");
        let stamp = dir.join(LAST_CHECK);
        let now = UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert!(check_due(&stamp, now), "never checked");

        fs::write(&stamp, (1_000_000 - 60).to_string()).unwrap();
        assert!(!check_due(&stamp, now));

        fs::write(&stamp, (1_000_000 - 25 * 60 * 60).to_string()).unwrap();
        assert!(check_due(&stamp, now));

        fs::write(&stamp, "garbage").unwrap();
        assert!(check_due(&stamp, now));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_copy_that_cannot_answer_initialize_is_rejected() {
        let command = RuntimeCommand {
            command: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "read line; echo '{\"jsonrpc\":\"2.0\",\"id\":0,\"error\":{}}'".into(),
            ],
        };
        assert!(answers_initialize(&command).is_err());

        let answering = RuntimeCommand {
            command: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "echo starting; read line; echo '{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{\"protocolVersion\":1}}'; sleep 5".into(),
            ],
        };
        assert!(answers_initialize(&answering).is_ok());
    }

    #[test]
    #[ignore = "Installs every adapter from the npm registry"]
    fn installs_working_adapters_from_npm() {
        let dir = temp_dir("install");
        let tools = NodeTools::find().expect("npm is installed");
        for adapter in &ADAPTERS {
            let versions = dir.join(adapter.id);
            let newest = newest_release(adapter, &tools, &versions).expect("npm lists releases");
            assert!(
                newest >= Version::parse(adapter.fallback).unwrap(),
                "{}",
                adapter.id
            );
            install_into(
                adapter,
                &tools,
                adapter.fallback,
                &versions.join(adapter.fallback),
            )
            .expect("adapter installs and answers initialize");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn npm_errors_keep_only_the_last_lines() {
        assert_eq!(last_lines("a\n\nb\n c \nd\ne\n", 3), "c\nd\ne");
    }
}
