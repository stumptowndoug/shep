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
use std::time::{Duration, Instant};

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
    state: Arc<Mutex<AcpState>>,
}

#[derive(Default)]
struct AcpState {
    processes: HashMap<u32, AcpProcess>,
    terminations: Vec<std::thread::JoinHandle<()>>,
    shutting_down: bool,
}

impl AcpState {
    fn terminate(&mut self, id: u32, reaped: bool) {
        if let Some(process) = self.processes.remove(&id) {
            self.terminations.retain(|worker| !worker.is_finished());
            self.terminations.push(terminate_group(process.pid, reaped));
        }
    }
}

impl AcpManager {
    pub fn new() -> Self {
        AcpManager {
            state: Arc::new(Mutex::new(AcpState::default())),
        }
    }

    pub fn session_count(&self) -> usize {
        self.state.lock().unwrap().processes.len()
    }

    pub fn child_pids(&self) -> Vec<u32> {
        self.state
            .lock()
            .unwrap()
            .processes
            .values()
            .map(|process| process.pid)
            .collect()
    }

    pub fn spawn(
        &self,
        id: u32,
        command: &str,
        args: Vec<String>,
        cwd: &str,
        channel: Channel<AcpOutput>,
    ) -> Result<(), String> {
        // Keep insertion and shutdown ordered: no process may appear after the drain.
        let mut state = self.state.lock().unwrap();
        if state.shutting_down {
            return Err("Shep is shutting down".into());
        }
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

        state.processes.insert(
            id,
            AcpProcess {
                pid: child.id(),
                stdin: Arc::new(Mutex::new(stdin)),
            },
        );
        drop(state);

        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        spawn_stderr_reader(stderr, Arc::clone(&stderr_tail), channel.clone());

        let manager = self.clone();
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
                        manager.kill(id);
                        break;
                    }
                };
                if line.trim().is_empty() {
                    continue;
                }
                if channel.send(AcpOutput::Line(line)).is_err() {
                    manager.kill(id);
                    break;
                }
            }
            let exit_code = wait_for_exit(&mut child);
            let code = if bridge_error.is_some() {
                -1
            } else {
                exit_code
            };
            // The agent is reaped; clean up only what is left in its group.
            manager.state.lock().unwrap().terminate(id, true);
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
            .state
            .lock()
            .unwrap()
            .processes
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
        self.state.lock().unwrap().terminate(id, false);
    }

    pub fn kill_all(&self) {
        let mut state = self.state.lock().unwrap();
        let ids: Vec<_> = state.processes.keys().copied().collect();
        for id in ids {
            state.terminate(id, false);
        }
    }

    /// Used before process exit, including cleanup already started by closed tabs.
    pub fn shutdown(&self) {
        self.state.lock().unwrap().shutting_down = true;
        self.kill_all();
        let workers = std::mem::take(&mut self.state.lock().unwrap().terminations);
        for worker in workers {
            let _ = worker.join();
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
/// Once the agent is `reaped`, its pid may belong to another process, so only
/// its group is signalled: the group id stays reserved while members remain.
fn terminate_group(pid: u32, reaped: bool) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        #[cfg(unix)]
        {
            let descendants = if reaped {
                Vec::new()
            } else {
                crate::pty::session::get_all_descendants(pid as i32)
            };
            let group = -(pid as i32);
            unsafe {
                libc::kill(group, libc::SIGTERM);
                for &child in &descendants {
                    libc::kill(child, libc::SIGTERM);
                }
            }
            let deadline = Instant::now() + KILL_GRACE;
            while Instant::now() < deadline {
                let alive = unsafe {
                    libc::kill(group, 0) == 0
                        || descendants.iter().any(|&child| libc::kill(child, 0) == 0)
                };
                if !alive {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            unsafe {
                libc::kill(group, libc::SIGKILL);
                for &child in &descendants {
                    libc::kill(child, libc::SIGKILL);
                }
            }
        }
    })
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
        let pid = manager.state.lock().unwrap().processes[&1].pid;
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

    #[test]
    fn shutdown_waits_for_resistant_agents_and_previously_closed_tabs() {
        for close_first in [false, true] {
            let manager = AcpManager::new();
            let (ready_tx, ready_rx) = mpsc::channel();
            manager
                .spawn(
                    1,
                    "/bin/sh",
                    vec![
                        "-c".into(),
                        "trap '' TERM; echo ready; exec sleep 30".into(),
                    ],
                    "/",
                    Channel::new(move |_| {
                        let _ = ready_tx.send(());
                        Ok(())
                    }),
                )
                .unwrap();
            let pid = manager.state.lock().unwrap().processes[&1].pid;
            ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            if close_first {
                manager.kill(1);
            }
            manager.shutdown();
            let deadline = Instant::now() + Duration::from_secs(1);
            while unsafe { libc::kill(pid as i32, 0) == 0 } && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            let alive = unsafe { libc::kill(pid as i32, 0) == 0 };
            if alive {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            assert!(
                !alive,
                "shutdown returned before the resistant agent stopped"
            );
            assert!(manager
                .spawn(
                    2,
                    "/bin/sleep",
                    vec!["30".into()],
                    "/",
                    Channel::new(|_| Ok(()))
                )
                .is_err());
        }
    }
}
