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

use crate::acp_npm::{answers_initialize, check_due, record_check, Version, LAST_CHECK};

// https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
/// Installed when the registry can't be reached, and checked against the hashes below.
const ANTIGRAVITY_VERSION: &str = "1.3.0";
const REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";
/// Other releases must carry Google's Developer ID signature: an Apple-issued
/// Developer ID certificate for Google LLC's team.
const GOOGLE_SIGNATURE: &str = "=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"EQHXZ8M8AV\"";
const FILES: [&str; 2] = ["agy_acp_server.par", "localharness_external"];
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy)]
struct RuntimeHashes {
    archive: &'static str,
    files: [&'static str; 2],
}

/// How a runtime folder's files are checked before they run.
#[derive(Clone, Copy)]
enum Trust {
    Pinned(RuntimeHashes),
    Signed,
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

fn trust_for(version: Version, arch: &str) -> Result<Trust, String> {
    if Version::parse(ANTIGRAVITY_VERSION) == Some(version) {
        Ok(Trust::Pinned(runtime_hashes(arch)?))
    } else {
        Ok(Trust::Signed)
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

fn verify_signature(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Antigravity verification requires a regular file.".into());
    }
    let status = Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict", "-R", GOOGLE_SIGNATURE])
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err("Antigravity isn’t signed by Google. The runtime was not accepted.".into());
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

/// Each release installs into its own `<version>-<arch>` folder here.
fn runtime_root(adapter: &str) -> Result<PathBuf, String> {
    if adapter != "antigravity" {
        return Err("Unknown managed chat adapter".into());
    }
    let base = dirs::data_local_dir().ok_or("Application data directory is unavailable")?;
    Ok(base.join("shep/acp/antigravity"))
}

/// Identity of a file that passed verification. Rewriting, replacing, or
/// chmod-ing it changes the stamp, so the file is checked again.
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

fn installed(dir: &Path, trust: Trust) -> bool {
    FILES.iter().enumerate().all(|(index, name)| {
        let path = dir.join(name);
        let Some(stamp) = runnable_stamp(&path) else {
            return false;
        };
        let expected = match trust {
            Trust::Pinned(hashes) => hashes.files[index],
            Trust::Signed => GOOGLE_SIGNATURE,
        };
        let cached = VERIFIED.lock().is_ok_and(|verified| {
            verified
                .iter()
                .any(|(p, check, s)| *p == path && *check == expected && *s == stamp)
        });
        if cached {
            return true;
        }
        let verified = match trust {
            Trust::Pinned(_) => verify_sha256(&path, expected),
            Trust::Signed => verify_signature(&path),
        };
        if verified.is_err() {
            return false;
        }
        // Only trust the stamp if the file didn't change while it was checked.
        if runnable_stamp(&path).as_ref() == Some(&stamp) {
            if let Ok(mut verified) = VERIFIED.lock() {
                verified.retain(|(p, _, _)| *p != path);
                verified.push((path, expected, stamp));
            }
        }
        true
    })
}

/// The newest release in `root` whose files pass verification.
fn newest_runtime(root: &Path, arch: &str) -> Option<(Version, PathBuf)> {
    let suffix = format!("-{arch}");
    let mut releases: Vec<_> = fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            Some((Version::parse(name.strip_suffix(&suffix)?)?, entry.path()))
        })
        .collect();
    releases.sort_by_key(|(version, _)| std::cmp::Reverse(*version));
    releases
        .into_iter()
        .find(|(version, dir)| trust_for(*version, arch).is_ok_and(|trust| installed(dir, trust)))
}

fn launch_command(dir: &Path) -> RuntimeCommand {
    RuntimeCommand {
        command: dir.join(FILES[0]).to_string_lossy().into_owned(),
        args: vec![],
    }
}

pub fn get(adapter: &str) -> Result<Option<RuntimeCommand>, String> {
    if let Some(npm) = crate::acp_npm::find(adapter) {
        return crate::acp_npm::get(npm);
    }
    let root = runtime_root(adapter)?;
    Ok(newest_runtime(&root, platform_arch()?).map(|(_, dir)| launch_command(&dir)))
}

fn validate_archive_listing(listing: &str) -> Result<(), String> {
    let entries: Vec<_> = listing.lines().collect();
    if entries.len() != FILES.len() || !FILES.iter().all(|name| entries.contains(name)) {
        return Err("The Antigravity download has unexpected contents. Please try again after updating Shep.".into());
    }
    Ok(())
}

fn download_url(version: Version, arch: &str) -> String {
    format!("https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-{version}-darwin-{arch}.zip")
}

/// The release the ACP registry lists, accepted only when its download is
/// Google's versioned URL for that release.
fn registry_release(entry: &serde_json::Value, arch: &str) -> Result<Version, String> {
    let version = entry["version"]
        .as_str()
        .and_then(Version::parse)
        .ok_or("The ACP registry lists no Antigravity release.")?;
    let platform = if arch == "arm64" {
        "darwin-aarch64"
    } else {
        "darwin-x86_64"
    };
    if entry["distribution"]["binary"][platform]["archive"].as_str()
        != Some(&download_url(version, arch))
    {
        return Err("The ACP registry lists an unexpected Antigravity download.".into());
    }
    Ok(version)
}

fn curl(url: &str, output: &Path, max_bytes: u64, max_secs: u64) -> Result<(), String> {
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
            &max_secs.to_string(),
            "--max-filesize",
            &max_bytes.to_string(),
            "--output",
        ])
        .arg(output)
        .arg(url)
        .output()
        .map_err(|e| format!("Couldn’t download Antigravity: {e}"))?;
    if !download.status.success() {
        return Err(format!(
            "Couldn’t download Antigravity. Check your connection and try again. {}",
            String::from_utf8_lossy(&download.stderr).trim()
        ));
    }
    Ok(())
}

fn newest_release(root: &Path, arch: &str) -> Result<Version, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let output = root.join(format!(".registry-{}-{}", std::process::id(), stamp()?));
    let result = curl(REGISTRY_URL, &output, 1_000_000, 30).and_then(|_| {
        let entry = serde_json::from_slice(&fs::read(&output).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        registry_release(&entry, arch)
    });
    let _ = fs::remove_file(&output);
    result
}

fn stamp() -> Result<u128, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos())
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
    let root = runtime_root(adapter)?;
    let arch = platform_arch()?;
    let pinned = Version::parse(ANTIGRAVITY_VERSION).ok_or("Invalid Antigravity version")?;
    match newest_release(&root, arch) {
        Ok(newest) if newest > pinned => {
            install_release(&root, newest, arch).or_else(|_| install_release(&root, pinned, arch))
        }
        _ => install_release(&root, pinned, arch),
    }
}

/// Runs at launch, after the npm adapters. Only someone who already chose to
/// download Antigravity's runtime gets newer releases.
pub fn update_on_launch() {
    crate::acp_npm::update_on_launch();
    if let Err(error) = update_antigravity() {
        if cfg!(debug_assertions) {
            eprintln!("Couldn’t update Antigravity’s chat runtime: {error}");
        }
    }
}

fn update_antigravity() -> Result<(), String> {
    let root = runtime_root("antigravity")?;
    let arch = platform_arch()?;
    let _lock = INSTALL_LOCK
        .lock()
        .map_err(|_| "Adapter installer is unavailable")?;
    let Some((current, dir)) = newest_runtime(&root, arch) else {
        return Ok(());
    };
    prune(&root, &dir);
    let last_check = root.join(LAST_CHECK);
    if !check_due(&last_check, SystemTime::now()) {
        return Ok(());
    }
    // Recorded first: a 400 MB download shouldn't be retried every launch.
    record_check(&last_check);
    let newest = newest_release(&root, arch)?;
    if newest > current {
        install_release(&root, newest, arch)?;
    }
    Ok(())
}

/// Keeps only `keep` and the check stamp. Runs at launch, before any chat can
/// be using an older release.
fn prune(root: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep || entry.file_name() == LAST_CHECK {
            continue;
        }
        let _ = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
    }
}

fn install_release(root: &Path, version: Version, arch: &str) -> Result<RuntimeCommand, String> {
    let trust = trust_for(version, arch)?;
    let target = root.join(format!("{version}-{arch}"));
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let stamp = stamp()?;
    let stage = root.join(format!(".install-{}-{stamp}", std::process::id()));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        let archive = stage.join("runtime.zip");
        curl(&download_url(version, arch), &archive, 300_000_000, 180)?;
        // A pinned archive is checked before invoking an extractor or accepting
        // executable files; a signed release is checked once extracted.
        if let Trust::Pinned(hashes) = trust {
            verify_sha256(&archive, hashes.archive)?;
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
        if !installed(&stage, trust) {
            return Err("Antigravity's extracted files failed integrity verification.".into());
        }
        fs::remove_file(archive).map_err(|e| e.to_string())?;
        answers_initialize(&launch_command(&stage))?;
        // An incomplete older attempt can be repaired without exposing half an install.
        let backup = root.join(format!(".incomplete-{stamp}"));
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
        if !installed(&target, trust) {
            return Err("Antigravity installation could not be verified.".into());
        }
        Ok(launch_command(&target))
    })();
    let _ = fs::remove_dir_all(stage);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shep-runtime-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_runtime_files(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        for name in FILES {
            let path = dir.join(name);
            fs::write(&path, b"abc").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
    }

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
    fn only_the_fallback_release_is_checked_by_hash() {
        let pinned = Version::parse(ANTIGRAVITY_VERSION).unwrap();
        assert!(matches!(trust_for(pinned, "arm64"), Ok(Trust::Pinned(_))));
        let newer = Version::parse("1.4.1").unwrap();
        assert!(matches!(trust_for(newer, "arm64"), Ok(Trust::Signed)));
    }

    #[test]
    fn registry_releases_must_use_googles_versioned_download() {
        let entry = |version: &str, archive: &str| {
            serde_json::json!({
                "version": version,
                "distribution": { "binary": { "darwin-aarch64": { "archive": archive } } }
            })
        };
        let official =
            "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-arm64.zip";
        assert_eq!(
            registry_release(&entry("1.4.1", official), "arm64"),
            Ok(Version::parse("1.4.1").unwrap())
        );
        assert!(registry_release(&entry("1.4.1", official), "x86_64").is_err());
        assert!(registry_release(&entry("1.4.2", official), "arm64").is_err());
        assert!(registry_release(&entry("1.4.1-beta", official), "arm64").is_err());
        assert!(registry_release(
            &entry(
                "1.4.1",
                "https://example.com/agy-acp-server-1.4.1-darwin-arm64.zip"
            ),
            "arm64"
        )
        .is_err());
    }

    #[test]
    fn unsigned_and_non_google_binaries_are_rejected() {
        let dir = temp_dir("signature");
        write_runtime_files(&dir);
        assert!(verify_signature(&dir.join(FILES[0])).is_err());
        // Signed, but by Apple rather than Google.
        assert!(verify_signature(Path::new("/bin/ls")).is_err());
        assert!(!installed(&dir, Trust::Signed));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_newest_verified_release_runs_and_prune_keeps_only_it() {
        let root = temp_dir("newest");
        let hashes = RuntimeHashes {
            archive: "",
            files: ["ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; 2],
        };
        // An unsigned folder claiming a newer release is never chosen.
        write_runtime_files(&root.join("9.9.9-arm64"));
        write_runtime_files(&root.join(format!("{ANTIGRAVITY_VERSION}-x86_64")));
        assert!(newest_runtime(&root, "arm64").is_none());

        let pinned = root.join(format!("{ANTIGRAVITY_VERSION}-arm64"));
        write_runtime_files(&pinned);
        assert!(installed(&pinned, Trust::Pinned(hashes)));
        assert!(!installed(
            &pinned,
            trust_for(Version::parse(ANTIGRAVITY_VERSION).unwrap(), "arm64").unwrap()
        ));

        fs::write(root.join(LAST_CHECK), "1").unwrap();
        fs::create_dir_all(root.join(".install-stale")).unwrap();
        prune(&root, &pinned);
        let mut left: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec![
                format!("{ANTIGRAVITY_VERSION}-arm64"),
                LAST_CHECK.to_string()
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "Downloads the official runtime into the local Shep app-data directory"]
    fn install_official_antigravity_runtime() {
        let first = install("antigravity").expect("official runtime installs");
        let second = install("antigravity").expect("repeat install reuses the verified release");
        assert_eq!(first.command, second.command);
        let dir = Path::new(&first.command).parent().unwrap();
        assert!(newest_runtime(dir.parent().unwrap(), platform_arch().unwrap()).is_some());
    }

    #[test]
    #[ignore = "Downloads the newest official runtime into a temporary folder"]
    fn installs_the_registry_release_by_signature() {
        let root = temp_dir("registry");
        let arch = platform_arch().unwrap();
        let newest = newest_release(&root, arch).expect("registry lists a release");
        install_release(&root, newest, arch)
            .expect("signed release installs and answers initialize");
        assert_eq!(
            newest_runtime(&root, arch).map(|(version, _)| version),
            Some(newest)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_modified_missing_and_linked_runtime_files() {
        let dir = temp_dir("hash");
        let hashes = RuntimeHashes {
            archive: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            files: ["ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; 2],
        };
        write_runtime_files(&dir);
        assert!(installed(&dir, Trust::Pinned(hashes)));
        fs::write(dir.join(FILES[0]), b"abd").unwrap();
        assert!(verify_sha256(&dir.join(FILES[0]), hashes.archive).is_err());
        assert!(!installed(&dir, Trust::Pinned(hashes)));
        fs::remove_file(dir.join(FILES[0])).unwrap();
        assert!(!installed(&dir, Trust::Pinned(hashes)));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join(FILES[1]), dir.join(FILES[0])).unwrap();
            assert!(!installed(&dir, Trust::Pinned(hashes)));
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
