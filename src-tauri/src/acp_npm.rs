//! Chat adapters published on npm. Shep installs each one into its own
//! application data folder with the user's npm, so the result never depends on
//! npm's global prefix or on which folders happen to be on PATH. A copy the
//! user installed themselves still wins.
use std::ffi::OsString;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::acp_runtime::RuntimeCommand;
use crate::shell_path::{self, executable, find_in};

pub struct NpmAdapter {
    id: &'static str,
    package: &'static str,
    version: &'static str,
    bin: &'static str,
}

// Pinned so every install runs the version Shep was tested with. None of these
// need npm install scripts; the ignored install test checks each one.
const ADAPTERS: [NpmAdapter; 3] = [
    NpmAdapter {
        id: "claude",
        package: "@agentclientprotocol/claude-agent-acp",
        version: "0.89.1",
        bin: "claude-agent-acp",
    },
    NpmAdapter {
        id: "codex",
        package: "@agentclientprotocol/codex-acp",
        version: "2.2.2",
        bin: "codex-acp",
    },
    NpmAdapter {
        id: "pi",
        package: "pi-acp",
        version: "0.0.34",
        bin: "pi-acp",
    },
];

const MANIFEST: &str = "shep-install.json";
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
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

fn install_dir(adapter: &NpmAdapter) -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Application data directory is unavailable")?;
    Ok(base.join("shep/acp").join(adapter.id))
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

pub fn get(adapter: &NpmAdapter) -> Result<Option<RuntimeCommand>, String> {
    if let Some(path) = shell_path::find(adapter.bin) {
        return Ok(Some(RuntimeCommand {
            command: path.to_string_lossy().into_owned(),
            args: vec![],
        }));
    }
    Ok(managed_command(adapter, &install_dir(adapter)?))
}

fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<_> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

fn run_npm(npm: &Path, node: &Path, stage: &Path, log: &Path, spec: &str) -> Result<(), String> {
    // npm starts with `#!/usr/bin/env node`, so the node beside it must be on PATH.
    let mut path_dirs: Vec<PathBuf> = [npm.parent(), node.parent()]
        .into_iter()
        .flatten()
        .map(Path::to_path_buf)
        .collect();
    if let Some(existing) = shell_path::current() {
        path_dirs.extend(std::env::split_paths(&existing));
    }
    let path: OsString = std::env::join_paths(path_dirs).map_err(|e| e.to_string())?;
    let mut child = Command::new(npm)
        .args([
            "install",
            "--no-audit",
            "--no-fund",
            "--ignore-scripts",
            "--omit=dev",
            "--prefix",
        ])
        .arg(stage)
        .arg(spec)
        .current_dir(stage)
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(File::create(log).map_err(|e| e.to_string())?))
        .spawn()
        .map_err(|e| format!("Couldn’t run npm: {e}"))?;
    let deadline = Instant::now() + INSTALL_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Installing the chat adapter took too long. Check your connection and try again."
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    if !status.success() {
        let output = fs::read_to_string(log).unwrap_or_default();
        return Err(format!(
            "Couldn’t install the chat adapter with npm.\n{}",
            last_lines(&output, 4)
        ));
    }
    Ok(())
}

pub fn install(adapter: &NpmAdapter) -> Result<RuntimeCommand, String> {
    let _lock = INSTALL_LOCK
        .lock()
        .map_err(|_| "Adapter installer is unavailable")?;
    if let Some(runtime) = get(adapter)? {
        return Ok(runtime);
    }
    install_into(adapter, &install_dir(adapter)?)
}

fn install_into(adapter: &NpmAdapter, target: &Path) -> Result<RuntimeCommand, String> {
    let npm = find_npm().ok_or(NODE_MISSING)?;
    let node = npm
        .parent()
        .map(|dir| dir.join("node"))
        .filter(|node| executable(node))
        .or_else(|| shell_path::find("node"))
        .ok_or(NODE_MISSING)?;
    let parent = target.parent().ok_or("Invalid adapter directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let stage = parent.join(format!(
        ".install-{}-{}-{stamp}",
        adapter.id,
        std::process::id()
    ));
    let log = parent.join(format!(
        ".install-{}-{}-{stamp}.log",
        adapter.id,
        std::process::id()
    ));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        run_npm(
            &npm,
            &node,
            &stage,
            &log,
            &format!("{}@{}", adapter.package, adapter.version),
        )?;
        let manifest = Manifest {
            version: adapter.version.into(),
            node: node.to_string_lossy().into_owned(),
        };
        fs::write(
            stage.join(MANIFEST),
            serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if managed_command(adapter, &stage).is_none() {
            return Err("npm finished, but the chat adapter wasn’t installed. Try again.".into());
        }
        // Replace an older or broken copy without exposing half an install.
        let backup = parent.join(format!(".previous-{}-{stamp}", adapter.id));
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

    #[test]
    fn only_known_adapters_are_installable() {
        for id in ["claude", "codex", "pi"] {
            assert!(find(id).is_some(), "{id}");
        }
        assert!(find("../claude").is_none());
        assert!(find("antigravity").is_none());
    }

    #[test]
    fn managed_copy_runs_the_script_with_the_recorded_node() {
        let dir = temp_dir("managed");
        let adapter = find("claude").unwrap();
        assert!(managed_command(adapter, &dir).is_none());

        let script = dir.join("node_modules/.bin/claude-agent-acp");
        let node = dir.join("homebrew/bin/node");
        write_executable(&script);
        write_executable(&node);
        let manifest = Manifest {
            version: "1".into(),
            node: node.to_string_lossy().into_owned(),
        };
        fs::write(dir.join(MANIFEST), serde_json::to_vec(&manifest).unwrap()).unwrap();

        let command = managed_command(adapter, &dir).unwrap();
        assert_eq!(command.command, node.to_string_lossy());
        assert_eq!(command.args, vec![script.to_string_lossy().into_owned()]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[ignore = "Installs every adapter from the npm registry"]
    fn installs_working_adapters_from_npm() {
        let dir = temp_dir("install");
        for adapter in &ADAPTERS {
            assert_answers_initialize(
                &install_into(adapter, &dir.join(adapter.id)).expect("adapter installs"),
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    /// The adapter answers initialize with only the system folders on PATH.
    fn assert_answers_initialize(command: &RuntimeCommand) {
        let mut child = Command::new(&command.command)
            .args(&command.args)
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        use std::io::{BufRead, BufReader, Write};
        // Keep stdin open until the reply: some adapters exit at end of input.
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(br#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
"#).unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        drop(stdin);
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            line.contains(r#""protocolVersion":1"#),
            "{} {line}",
            command.args[0]
        );
    }

    #[test]
    fn npm_errors_keep_only_the_last_lines() {
        assert_eq!(last_lines("a\n\nb\n c \nd\ne\n", 3), "c\nd\ne");
    }
}
