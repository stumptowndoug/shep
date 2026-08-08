use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;

use super::session::{PtyColorTheme, PtyOutput, PtySession};

pub struct PtyManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
    shutting_down: AtomicBool,
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            sessions: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn session_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    pub fn begin_shutdown(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::SeqCst)
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        command: &str,
        args: Option<Vec<String>>,
        cwd: &str,
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
        color_theme: PtyColorTheme,
        channel: Channel<PtyOutput>,
    ) -> Result<u32, String> {
        let session = PtySession::spawn(command, args, cwd, env, cols, rows, color_theme, channel)?;

        let mut next_id = self.next_id.lock().unwrap();
        let id = *next_id;
        *next_id += 1;

        self.sessions.lock().unwrap().insert(id, session);
        Ok(id)
    }

    pub fn write(&self, pty_id: u32, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(&pty_id)
            .ok_or_else(|| format!("PTY {pty_id} not found"))?;
        session.write(data)
    }

    pub fn acknowledge_output(&self, pty_id: u32, bytes: usize) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(&pty_id)
            .ok_or_else(|| format!("PTY {pty_id} not found"))?;
        session.acknowledge_output(bytes);
        Ok(())
    }

    pub fn set_color_theme(&self, color_theme: PtyColorTheme) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        for session in sessions.values() {
            session.set_color_theme(color_theme.clone())?;
        }
        Ok(())
    }

    pub fn resize(&self, pty_id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(&pty_id)
            .ok_or_else(|| format!("PTY {pty_id} not found"))?;
        session.resize(cols, rows)
    }

    pub fn kill(&self, pty_id: u32) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(mut session) = sessions.remove(&pty_id) {
            session.kill()
        } else {
            Ok(())
        }
    }

    pub fn child_pids(&self) -> Vec<u32> {
        self.sessions.lock().unwrap().values().filter_map(|s| s.pid()).collect()
    }

    pub fn child_pid(&self, pty_id: u32) -> Option<u32> {
        self.sessions
            .lock()
            .unwrap()
            .get(&pty_id)
            .and_then(|session| session.pid())
    }

    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            let _ = session.kill();
        }
    }
}
