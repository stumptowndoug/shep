//! Shep-managed binary adapters (npm adapters live in acp_npm). Keep each release and its helper together;
//! never change the user's CLI installation or PATH.
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

// https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
const ANTIGRAVITY_VERSION: &str = "1.3.0";
const FILES: [&str; 2] = ["agy_acp_server.par", "localharness_external"];
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

struct RuntimeHashes {
    archive: &'static str,
    files: [&'static str; 2],
}

// Pinned from Google's versioned HTTPS downloads. Both extracted binaries were
// verified as signed by Google LLC (EQHXZ8M8AV); see docs/managed-runtimes.md.
fn runtime_hashes(arch: &str) -> Result<RuntimeHashes, String> {
    match arch {
        "arm64" => Ok(RuntimeHashes {
            archive: "7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88",
            files: [
                "cb1f0725183ed922079ed6cd1d2422b4d8be44c5fb60be3e9a43d8d04f99a18e",
                "b04b00662c1821b953a409d43626b86d1229130eeb2078b4e1304c06199aa481",
            ],
        }),
        "x86_64" => Ok(RuntimeHashes {
            archive: "bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646",
            files: [
                "f31bd5797eeb225a5efa12e24573f1f4eb157ec00698dd6a2cda6f0d924705cf",
                "d724f49b2c9e440c5d37925b1da203fc204c17dd9c662df45094c641f9806bc6",
            ],
        }),
        _ => Err("No verified Antigravity runtime is available for this architecture.".into()),
    }
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 300_000_000 {
        return Err("Antigravity verification requires a regular file under 300 MB.".into());
    }
    let mut file = File::open(path)
        .map_err(|error| error.to_string())?
        .take(300_000_001);
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err("Antigravity failed integrity verification. The runtime was not accepted. Try installing again, or update Shep if the problem continues.".into());
    }
    Ok(())
}

#[derive(Serialize)]
pub struct RuntimeCommand {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
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

/// Identity of a file that passed verification. Rewriting, replacing, or
/// chmod-ing it changes the stamp, so the file is hashed again.
#[derive(Clone, PartialEq)]
struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    changed: (i64, i64),
    inode: u64,
}

/// The runtime is ~400 MB, and availability checks run on every chat start.
static VERIFIED: Mutex<Vec<(PathBuf, &'static str, FileStamp)>> = Mutex::new(Vec::new());

/// A non-empty, executable regular file's stamp, or None if it can't be run.
fn runnable_stamp(path: &Path) -> Option<FileStamp> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.permissions().mode() & 0o100 == 0 {
            return None;
        }
        Some(FileStamp {
            len: meta.len(),
            modified: meta.modified().ok(),
            changed: (meta.ctime(), meta.ctime_nsec()),
            inode: meta.ino(),
        })
    }
    #[cfg(not(unix))]
    Some(FileStamp {
        len: meta.len(),
        modified: meta.modified().ok(),
        changed: (0, 0),
        inode: 0,
    })
}

fn installed(dir: &Path, hashes: &RuntimeHashes) -> bool {
    FILES.iter().zip(hashes.files).all(|(name, expected)| {
        let path = dir.join(name);
        let Some(stamp) = runnable_stamp(&path) else {
            return false;
        };
        let cached = VERIFIED.lock().is_ok_and(|verified| {
            verified
                .iter()
                .any(|(p, hash, s)| *p == path && *hash == expected && *s == stamp)
        });
        if cached {
            return true;
        }
        if verify_sha256(&path, expected).is_err() {
            return false;
        }
        // Only trust the stamp if the file didn't change while it was hashed.
        if runnable_stamp(&path).as_ref() == Some(&stamp) {
            if let Ok(mut verified) = VERIFIED.lock() {
                verified.retain(|(p, _, _)| *p != path);
                verified.push((path, expected, stamp));
            }
        }
        true
    })
}

pub fn get(adapter: &str) -> Result<Option<RuntimeCommand>, String> {
    if let Some(npm) = crate::acp_npm::find(adapter) {
        return crate::acp_npm::get(npm);
    }
    let dir = runtime_dir(adapter)?;
    let hashes = runtime_hashes(platform_arch()?)?;
    Ok(installed(&dir, &hashes).then(|| RuntimeCommand {
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
    if let Some(npm) = crate::acp_npm::find(adapter) {
        return crate::acp_npm::install(npm);
    }
    let _lock = INSTALL_LOCK
        .lock()
        .map_err(|_| "Adapter installer is unavailable")?;
    if let Some(runtime) = get(adapter)? {
        return Ok(runtime);
    }
    let target = runtime_dir(adapter)?;
    let hashes = runtime_hashes(platform_arch()?)?;
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
        // Check the archive before invoking an extractor or accepting executable files.
        verify_sha256(&archive, hashes.archive)?;
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
        if !installed(&stage, &hashes) {
            return Err("Antigravity's extracted files failed integrity verification.".into());
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
        assert!(installed(
            Path::new(&first.command).parent().unwrap(),
            &runtime_hashes(platform_arch().unwrap()).unwrap()
        ));
    }

    #[test]
    fn rejects_modified_missing_and_linked_runtime_files() {
        let dir =
            std::env::temp_dir().join(format!("shep-runtime-hash-test-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let hashes = RuntimeHashes {
            archive: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            files: ["ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; 2],
        };
        for name in FILES {
            let path = dir.join(name);
            fs::write(&path, b"abc").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        assert!(installed(&dir, &hashes));
        fs::write(dir.join(FILES[0]), b"abd").unwrap();
        assert!(verify_sha256(&dir.join(FILES[0]), hashes.archive).is_err());
        assert!(!installed(&dir, &hashes));
        fs::remove_file(dir.join(FILES[0])).unwrap();
        assert!(!installed(&dir, &hashes));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join(FILES[1]), dir.join(FILES[0])).unwrap();
            assert!(!installed(&dir, &hashes));
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
