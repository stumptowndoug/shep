//! Images that agents reference in chat replies (usually screenshots they just
//! took). The webview can't load local paths, so chat reads them through here.
//! Only real image files under a size cap are returned, and only to the webview.
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const MAX_CHAT_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"];

/// Error codes the chat maps to its own wording.
pub const MISSING: &str = "missing";
pub const TOO_LARGE: &str = "too-large";
pub const UNSUPPORTED: &str = "unsupported";

/// Absolute paths, `~/…`, `file://…`, and paths relative to the chat's project.
fn resolve(path: &str, base_dir: &str) -> Option<PathBuf> {
    let path = path.strip_prefix("file://").unwrap_or(path);
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => dirs::home_dir()?.join(rest),
        None => PathBuf::from(path),
    };
    if expanded.is_absolute() {
        return Some(expanded);
    }
    // Without a known folder, a relative path would resolve against Shep's own cwd.
    let base = Path::new(base_dir);
    base.is_absolute().then(|| base.join(expanded))
}

fn is_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
        || (bytes.len() >= 12
            && &bytes[4..8] == b"ftyp"
            && matches!(&bytes[8..12], b"avif" | b"avis"))
        || bytes.starts_with(b"BM")
}

pub fn read(path: &str, base_dir: &str) -> Result<Vec<u8>, String> {
    let file_path = resolve(path, base_dir).ok_or(MISSING)?;
    let extension = file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase);
    if !extension.is_some_and(|ext| EXTENSIONS.contains(&ext.as_str())) {
        return Err(UNSUPPORTED.into());
    }
    let metadata = std::fs::metadata(&file_path).map_err(|_| MISSING)?;
    if !metadata.is_file() {
        return Err(UNSUPPORTED.into());
    }
    if metadata.len() > MAX_CHAT_IMAGE_BYTES {
        return Err(TOO_LARGE.into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(&file_path)
        .map_err(|_| MISSING)?
        .take(MAX_CHAT_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| MISSING)?;
    if bytes.len() as u64 > MAX_CHAT_IMAGE_BYTES {
        return Err(TOO_LARGE.into());
    }
    if !is_image(&bytes) {
        return Err(UNSUPPORTED.into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("shep-chat-images-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_absolute_relative_and_file_urls() {
        let dir = temp_dir("paths");
        fs::create_dir_all(dir.join("shots")).unwrap();
        fs::write(dir.join("shots/preview.PNG"), PNG).unwrap();
        let absolute = dir.join("shots/preview.PNG");
        let base = dir.to_str().unwrap();
        assert_eq!(read(absolute.to_str().unwrap(), "/elsewhere").unwrap(), PNG);
        assert_eq!(read("shots/preview.PNG", base).unwrap(), PNG);
        assert_eq!(
            read(&format!("file://{}", absolute.display()), "/elsewhere").unwrap(),
            PNG
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rejects_missing_non_images_and_oversized_files() {
        let dir = temp_dir("reject");
        let base = dir.to_str().unwrap();
        assert_eq!(read("absent.png", base).unwrap_err(), MISSING);
        assert_eq!(read("absent.png", "").unwrap_err(), MISSING);

        fs::write(dir.join("notes.txt"), PNG).unwrap();
        assert_eq!(read("notes.txt", base).unwrap_err(), UNSUPPORTED);

        fs::write(dir.join("secret.png"), b"not really an image").unwrap();
        assert_eq!(read("secret.png", base).unwrap_err(), UNSUPPORTED);

        fs::create_dir_all(dir.join("folder.png")).unwrap();
        assert_eq!(read("folder.png", base).unwrap_err(), UNSUPPORTED);

        let mut big = PNG.to_vec();
        big.resize(MAX_CHAT_IMAGE_BYTES as usize + 1, 0);
        fs::write(dir.join("big.png"), big).unwrap();
        assert_eq!(read("big.png", base).unwrap_err(), TOO_LARGE);
        fs::remove_dir_all(dir).ok();
    }
}
