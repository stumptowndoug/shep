//! Stdio bridge for Agent Client Protocol (ACP) agents.
//!
//! The protocol itself (JSON-RPC requests, permissions, session updates) is
//! handled in the frontend. This side only spawns the adapter process,
//! forwards each stdout line, and writes lines to stdin — keeping the Rust
//! surface small and free of extra dependencies.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;

/// Stderr kept for the exit event, so launch failures (missing auth, bad
/// flags) can be shown to the user instead of a bare exit code.
const STDERR_TAIL_LINES: usize = 20;
// Bound a single protocol frame before JSON parsing or forwarding it over IPC.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_STDERR_LINE_BYTES: usize = 24_000;
const KILL_GRACE: Duration = Duration::from_millis(1500);

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum AcpOutput {
    #[serde(rename = "line")]
    Line(String),
    #[serde(rename = "stderr")]
    Stderr(String),
    #[serde(rename = "exit")]
    Exit { code: i32, stderr: String },
}

struct AcpProcess {
    pid: u32,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Clone)]
pub struct AcpManager {
    processes: Arc<Mutex<HashMap<u32, AcpProcess>>>,
}

impl AcpManager {
    pub fn new() -> Self {
        AcpManager {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn session_count(&self) -> usize {
        self.processes.lock().unwrap().len()
    }

    pub fn spawn(
        &self,
        id: u32,
        command: &str,
        args: Vec<String>,
        cwd: &str,
        channel: Channel<AcpOutput>,
    ) -> Result<(), String> {
        let mut cmd = Command::new(command);
        cmd.args(&args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Own process group so kill() also stops the CLI the adapter wraps.
            cmd.process_group(0);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start {command}: {e}"))?;
        let stdin = child.stdin.take().ok_or("Agent stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Agent stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("Agent stderr unavailable")?;

        self.processes.lock().unwrap().insert(
            id,
            AcpProcess {
                pid: child.id(),
                stdin: Arc::new(Mutex::new(stdin)),
            },
        );

        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        spawn_stderr_reader(stderr, Arc::clone(&stderr_tail), channel.clone());

        let processes = Arc::clone(&self.processes);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut bridge_error = None;
            loop {
                let line = match read_acp_line(&mut reader) {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(error) => {
                        bridge_error =
                            Some(format!("Chat adapter output could not be read: {error}"));
                        terminate_group(child.id());
                        break;
                    }
                };
                if line.trim().is_empty() {
                    continue;
                }
                if channel.send(AcpOutput::Line(line)).is_err() {
                    terminate_group(child.id());
                    break;
                }
            }
            let exit_code = wait_for_exit(&mut child);
            let code = if bridge_error.is_some() {
                -1
            } else {
                exit_code
            };
            processes.lock().unwrap().remove(&id);
            let mut stderr = stderr_tail
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            if let Some(error) = bridge_error {
                stderr.push_str(&format!("\n{error}"));
            }
            let _ = channel.send(AcpOutput::Exit { code, stderr });
        });

        Ok(())
    }

    pub fn write(&self, id: u32, line: &str) -> Result<(), String> {
        // A full pipe may block until the agent reads again. Never keep the
        // process registry locked: close must still be able to kill that agent.
        let stdin = self
            .processes
            .lock()
            .unwrap()
            .get(&id)
            .map(|process| Arc::clone(&process.stdin))
            .ok_or_else(|| format!("Agent {id} is not running"))?;
        let mut stdin = stdin.lock().unwrap();
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Failed to write to agent: {e}"))
    }

    pub fn kill(&self, id: u32) {
        let process = self.processes.lock().unwrap().remove(&id);
        if let Some(process) = process {
            terminate_group(process.pid);
        }
    }

    pub fn kill_all(&self) {
        let drained: Vec<_> = self.processes.lock().unwrap().drain().collect();
        for (_, process) in drained {
            terminate_group(process.pid);
        }
    }
}

fn read_acp_line(reader: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "A single agent message exceeded 8 MiB. Start a new chat and request a smaller output.",
        ));
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

fn spawn_stderr_reader(
    stderr: impl Read + Send + 'static,
    tail: Arc<Mutex<VecDeque<String>>>,
    channel: Channel<AcpOutput>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        loop {
            // A CLI can log an arbitrarily long line. Drain it in bounded pieces.
            let mut bytes = Vec::new();
            match (&mut reader)
                .take(MAX_STDERR_LINE_BYTES as u64)
                .read_until(b'\n', &mut bytes)
            {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&bytes).trim_end().to_owned();
            // Only forward the bounded sign-in instruction, not verbose agent logs.
            if line.starts_with("Open the following link to authenticate the ACP server: ") {
                let _ = channel.send(AcpOutput::Stderr(line.clone()));
            }
            let mut tail = tail.lock().unwrap();
            if tail.len() == STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });
}

fn wait_for_exit(child: &mut Child) -> i32 {
    child
        .wait()
        .ok()
        .and_then(|status| status.code())
        .unwrap_or(-1)
}

/// SIGTERM the agent's process group, then SIGKILL whatever ignores it.
fn terminate_group(pid: u32) {
    #[cfg(unix)]
    {
        let group = -(pid as i32);
        unsafe {
            libc::kill(group, libc::SIGTERM);
        }
        std::thread::spawn(move || {
            std::thread::sleep(KILL_GRACE);
            unsafe {
                libc::kill(group, libc::SIGKILL);
            }
        });
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn bounded_frames_preserve_line_framing() {
        let mut reader = std::io::Cursor::new(b"first\r\nsecond\nlast");
        assert_eq!(
            read_acp_line(&mut reader).unwrap().as_deref(),
            Some("first")
        );
        assert_eq!(
            read_acp_line(&mut reader).unwrap().as_deref(),
            Some("second")
        );
        assert_eq!(read_acp_line(&mut reader).unwrap().as_deref(), Some("last"));
        assert_eq!(read_acp_line(&mut reader).unwrap(), None);
    }

    #[test]
    fn oversized_frames_fail_even_without_a_newline() {
        let mut reader = std::io::Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 100]);
        assert_eq!(
            read_acp_line(&mut reader).unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
        assert_eq!(reader.position(), (MAX_FRAME_BYTES + 1) as u64);
    }

    fn close_with_stalled_stdin(close_all: bool) {
        let manager = Arc::new(AcpManager::new());
        manager
            .spawn(
                1,
                "/bin/sh",
                vec!["-c".into(), "exec sleep 30".into()],
                "/",
                Channel::new(|_| Ok(())),
            )
            .unwrap();
        let pid = manager.processes.lock().unwrap()[&1].pid;
        let (written_tx, written_rx) = mpsc::channel();
        let writer_manager = Arc::clone(&manager);
        let writer = std::thread::spawn(move || {
            let result = writer_manager.write(1, &"x".repeat(1024 * 1024));
            let _ = written_tx.send(result);
        });
        // A process that never reads stdin must leave the large write blocked.
        let blocked = written_rx.recv_timeout(Duration::from_millis(100)).is_err();
        let (closed_tx, closed_rx) = mpsc::channel();
        let close_manager = Arc::clone(&manager);
        let closer = std::thread::spawn(move || {
            if close_all {
                close_manager.kill_all();
            } else {
                close_manager.kill(1);
            }
            let _ = closed_tx.send(close_manager.session_count());
        });
        let closed = closed_rx.recv_timeout(Duration::from_millis(500));
        // Clean up even if a regression prevents close from reaching the child.
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        writer.join().unwrap();
        closer.join().unwrap();
        assert!(blocked, "the test must exercise a full stdin pipe");
        assert_eq!(closed.ok(), Some(0), "close waited for the agent's stdin");
    }

    #[test]
    fn close_does_not_wait_for_stalled_stdin() {
        close_with_stalled_stdin(false);
    }

    #[test]
    fn close_all_does_not_wait_for_stalled_stdin() {
        close_with_stalled_stdin(true);
    }
}
