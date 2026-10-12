//! The user's shell PATH, rereadable after Shep starts. `fix_path_env` copies it
//! once at launch, so a CLI or adapter installed while Shep is open would stay
//! invisible until a restart. This keeps its own copy instead of changing the
//! process environment, which other threads may be reading.
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DELIMITER: &str = "_SHEP_PATH_DELIMITER_";
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);
const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(10);

struct Cached {
    path: Option<OsString>,
    refreshed: Option<Instant>,
}

static CACHED: Mutex<Cached> = Mutex::new(Cached {
    path: None,
    refreshed: None,
});

pub fn current() -> Option<OsString> {
    CACHED
        .lock()
        .ok()
        .and_then(|cached| cached.path.clone())
        .or_else(|| std::env::var_os("PATH"))
}

pub fn executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    meta.is_file()
}

pub fn find_in(dirs: impl IntoIterator<Item = PathBuf>, name: &str) -> Option<PathBuf> {
    dirs.into_iter()
        .map(|dir| dir.join(name))
        .find(|path| path.is_absolute() && executable(path))
}

fn find_now(name: &str) -> Option<PathBuf> {
    find_in(std::env::split_paths(&current()?), name)
}

/// Finds `name` on the user's PATH, rereading it from their shell once if it's
/// missing, in case it was installed after Shep started.
pub fn find(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        return Some(PathBuf::from(name)).filter(|path| executable(path));
    }
    find_now(name).or_else(|| {
        refresh();
        find_now(name)
    })
}

fn parse(output: &str) -> Option<OsString> {
    let path = output.split(DELIMITER).nth(1)?.trim();
    (!path.is_empty()).then(|| path.into())
}

fn read_shell_path() -> Option<OsString> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // Same login, interactive shell that fix_path_env reads at launch.
    let mut child = Command::new(shell)
        .arg("-ilc")
        .arg(format!(
            "printf '%s' \"{DELIMITER}${{PATH}}{DELIMITER}\"; exit"
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + SHELL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut output = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut output).ok()?;
    parse(&output)
}

/// Rereads PATH from the user's shell, at most once per interval. Concurrent
/// callers wait for the same read.
pub fn refresh() {
    let Ok(mut cached) = CACHED.lock() else {
        return;
    };
    if cached
        .refreshed
        .is_some_and(|at| at.elapsed() < MIN_REFRESH_INTERVAL)
    {
        return;
    }
    cached.refreshed = Some(Instant::now());
    if let Some(path) = read_shell_path() {
        cached.path = Some(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_path_between_delimiters_despite_shell_noise() {
        let output = format!("welcome!\n{DELIMITER}/a/bin:/b/bin{DELIMITER}bye");
        assert_eq!(parse(&output), Some(OsString::from("/a/bin:/b/bin")));
        assert_eq!(parse("no delimiters"), None);
        assert_eq!(parse(&format!("{DELIMITER}{DELIMITER}")), None);
    }

    #[test]
    fn relative_path_entries_are_ignored() {
        assert_eq!(find_in([PathBuf::from("bin")], "sh"), None);
        assert_eq!(
            find_in([PathBuf::from("/bin")], "sh"),
            Some(PathBuf::from("/bin/sh"))
        );
    }

    #[test]
    fn reads_the_login_shell_path() {
        let path = read_shell_path().expect("shell prints PATH");
        assert!(std::env::split_paths(&path).any(|dir| dir == Path::new("/bin")));
    }
}
