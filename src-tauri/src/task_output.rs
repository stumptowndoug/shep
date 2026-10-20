//! The end of a chat agent's background task output. Claude Code writes each
//! backgrounded command's output to a `.output` file in a temporary folder and
//! reports the path; nothing else may be read this way.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Enough to show the recent output of a long-running command.
const TAIL_BYTES: u64 = 64 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct TaskOutput {
    text: String,
    /// Earlier output was left out.
    truncated: bool,
}

fn temp_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/tmp"), std::env::temp_dir()];
    if let Ok(dir) = std::env::var("TMPDIR") {
        roots.push(PathBuf::from(dir));
    }
    roots
        .into_iter()
        .filter_map(|root| root.canonicalize().ok())
        .collect()
}

fn allowed(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.extension().is_none_or(|ext| ext != "output") {
        return Err("Not a background task output file.".into());
    }
    let resolved = path
        .canonicalize()
        .map_err(|_| "The task’s output file is gone.".to_string())?;
    if !roots.iter().any(|root| resolved.starts_with(root)) || !resolved.is_file() {
        return Err("Not a background task output file.".into());
    }
    Ok(resolved)
}

fn read_tail(path: &Path, max: u64) -> Result<TaskOutput, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let start = size.saturating_sub(max);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity((size - start) as usize);
    file.take(max)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    // A cut can land inside a character or a line; start at the next whole line.
    if start > 0 {
        if let Some(newline) = text.find('\n') {
            text.drain(..=newline);
        }
    }
    Ok(TaskOutput {
        text,
        truncated: start > 0,
    })
}

pub fn read(path: &str) -> Result<TaskOutput, String> {
    read_tail(&allowed(Path::new(path), &temp_roots())?, TAIL_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shep-task-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_output_files_in_temporary_folders_are_read() {
        let dir = temp_dir("allowed");
        let output = dir.join("b1.output");
        fs::write(&output, "done\n").unwrap();
        let roots = temp_roots();
        assert!(allowed(&output, &roots).is_ok());

        let other = dir.join("notes.txt");
        fs::write(&other, "secret").unwrap();
        assert!(allowed(&other, &roots).is_err());
        assert!(allowed(Path::new("relative.output"), &roots).is_err());
        assert!(allowed(&dir.join("missing.output"), &roots).is_err());

        // A link named like output that points elsewhere is judged by its target.
        let outside = std::env::current_dir().unwrap().join("Cargo.toml");
        let link = dir.join("link.output");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(unix)]
        assert!(allowed(&link, &roots).is_err());
        assert!(allowed(&output, &[outside.parent().unwrap().to_path_buf()]).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn long_output_keeps_its_end_from_a_whole_line() {
        let dir = temp_dir("tail");
        let output = dir.join("t.output");
        fs::write(&output, "first line\nsecond line\nthird\n").unwrap();
        assert_eq!(
            read_tail(&output, 1024).unwrap(),
            TaskOutput {
                text: "first line\nsecond line\nthird\n".into(),
                truncated: false
            }
        );
        assert_eq!(
            read_tail(&output, 15).unwrap(),
            TaskOutput {
                text: "third\n".into(),
                truncated: true
            }
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
