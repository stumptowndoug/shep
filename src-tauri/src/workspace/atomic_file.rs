use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    replace_with(path, |file| file.write_all(bytes))
}

fn replace_with(
    path: &Path,
    write_contents: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    // Keep users' dotfile symlinks intact while replacing their target atomically.
    let resolved = if path.is_symlink() {
        path.canonicalize()?
    } else {
        path.to_path_buf()
    };
    let parent = resolved
        .parent()
        .ok_or_else(|| io::Error::other("No parent directory"))?;
    let name = resolved
        .file_name()
        .ok_or_else(|| io::Error::other("No file name"))?
        .to_string_lossy();
    let temporary = parent.join(format!(
        ".{name}.{}-{}.tmp",
        std::process::id(),
        NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        if let Ok(metadata) = fs::metadata(&resolved) {
            file.set_permissions(metadata.permissions())?;
        }
        write_contents(&mut file)?;
        file.sync_all()?;
        fs::rename(&temporary, &resolved)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_write_keeps_the_previous_file_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!("shep-atomic-test-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("config.yml");
        write(&path, b"previous").unwrap();
        let result = replace_with(&path, |file| {
            file.write_all(b"partial")?;
            Err(io::Error::other("simulated disk failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"previous");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        write(&path, b"complete").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"complete");
        #[cfg(unix)]
        {
            let link = dir.join("linked.yml");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            write(&link, b"through symlink").unwrap();
            assert!(link.is_symlink());
            assert_eq!(fs::read(&path).unwrap(), b"through symlink");
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
