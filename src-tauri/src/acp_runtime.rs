//! Shep-managed binary adapters. Keep each release and its helper together;
//! never change the user's CLI installation or PATH.
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

// https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
const ANTIGRAVITY_VERSION: &str = "1.3.0";
const FILES: [&str; 2] = ["agy_acp_server.par", "localharness_external"];
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
pub struct RuntimeCommand {
    command: String,
    args: Vec<String>,
}

fn platform_arch() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("arm64"),
        ("macos", "x86_64") => Ok("x86_64"),
        _ => Err("Antigravity chat installation is currently supported on macOS.".into()),
    }
}

fn runtime_dir(adapter: &str) -> Result<PathBuf, String> {
    if adapter != "antigravity" {
        return Err("Unknown managed chat adapter".into());
    }
    let base = dirs::data_local_dir().ok_or("Application data directory is unavailable")?;
    Ok(base
        .join("shep/acp/antigravity")
        .join(format!("{ANTIGRAVITY_VERSION}-{}", platform_arch()?)))
}

fn installed(dir: &Path) -> bool {
    FILES.iter().all(|name| {
        let Ok(meta) = fs::symlink_metadata(dir.join(name)) else {
            return false;
        };
        if !meta.is_file() || meta.len() == 0 {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o100 == 0 {
                return false;
            }
        }
        true
    })
}

pub fn get(adapter: &str) -> Result<Option<RuntimeCommand>, String> {
    let dir = runtime_dir(adapter)?;
    Ok(installed(&dir).then(|| RuntimeCommand {
        command: dir.join(FILES[0]).to_string_lossy().into_owned(),
        args: vec![],
    }))
}

fn validate_archive_listing(listing: &str) -> Result<(), String> {
    let entries: Vec<_> = listing.lines().collect();
    if entries.len() != FILES.len() || !FILES.iter().all(|name| entries.contains(name)) {
        return Err("The Antigravity download has unexpected contents. Please try again after updating Shep.".into());
    }
    Ok(())
}

pub fn install(adapter: &str) -> Result<RuntimeCommand, String> {
    let _lock = INSTALL_LOCK
        .lock()
        .map_err(|_| "Adapter installer is unavailable")?;
    if let Some(runtime) = get(adapter)? {
        return Ok(runtime);
    }
    let target = runtime_dir(adapter)?;
    let parent = target.parent().ok_or("Invalid adapter directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let stage = parent.join(format!(".install-{}-{stamp}", std::process::id()));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        let archive = stage.join("runtime.zip");
        let url = format!("https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-{ANTIGRAVITY_VERSION}-darwin-{}.zip", platform_arch()?);
        let download = Command::new("/usr/bin/curl")
            .args([
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--connect-timeout",
                "15",
                "--max-time",
                "180",
                "--max-filesize",
                "300000000",
                "--output",
            ])
            .arg(&archive)
            .arg(url)
            .output()
            .map_err(|e| format!("Couldn’t download Antigravity: {e}"))?;
        if !download.status.success() {
            return Err(format!(
                "Couldn’t download Antigravity. Check your connection and try again. {}",
                String::from_utf8_lossy(&download.stderr).trim()
            ));
        }
        let listing = Command::new("/usr/bin/unzip")
            .arg("-Z1")
            .arg(&archive)
            .output()
            .map_err(|e| e.to_string())?;
        if !listing.status.success() {
            return Err("Antigravity download is not a valid archive.".into());
        }
        validate_archive_listing(&String::from_utf8_lossy(&listing.stdout))?;
        // Extract only these exact entries, without trusting paths or modes in the ZIP.
        for name in FILES {
            let path = stage.join(name);
            let file = File::create(&path).map_err(|e| e.to_string())?;
            let output = Command::new("/usr/bin/unzip")
                .arg("-p")
                .arg(&archive)
                .arg(name)
                .stdout(Stdio::from(file))
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!("Couldn’t extract Antigravity’s {name}."));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                    .map_err(|e| e.to_string())?;
            }
        }
        if !installed(&stage) {
            return Err("Antigravity download is incomplete.".into());
        }
        fs::remove_file(archive).map_err(|e| e.to_string())?;
        // An incomplete older attempt can be repaired without exposing half an install.
        let backup = parent.join(format!(".incomplete-{stamp}"));
        if target.exists() {
            fs::rename(&target, &backup).map_err(|e| e.to_string())?;
        }
        if let Err(error) = fs::rename(&stage, &target) {
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(error.to_string());
        }
        if backup.exists() {
            let _ = fs::remove_dir_all(backup);
        }
        get(adapter)?.ok_or_else(|| "Antigravity installation could not be verified.".into())
    })();
    let _ = fs::remove_dir_all(stage);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_requires_both_binaries_and_no_extra_paths() {
        assert!(validate_archive_listing("agy_acp_server.par\nlocalharness_external\n").is_ok());
        for invalid in [
            "agy_acp_server.par\n",
            "../agy_acp_server.par\nlocalharness_external\n",
            "agy_acp_server.par\nlocalharness_external\nextra\n",
            "agy_acp_server.par\nagy_acp_server.par\n",
        ] {
            assert!(validate_archive_listing(invalid).is_err());
        }
    }

    #[test]
    fn unknown_adapter_never_creates_a_path() {
        assert!(get("../outside").is_err());
    }

    #[test]
    #[ignore = "Downloads the official runtime into the local Shep app-data directory"]
    fn install_official_antigravity_runtime() {
        let first = install("antigravity").expect("official runtime installs");
        let second = install("antigravity").expect("repeat install reuses the verified release");
        assert_eq!(first.command, second.command);
        assert!(installed(Path::new(&first.command).parent().unwrap()));
    }
}
