use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const FLOW_CONTROL_HIGH_WATERMARK_BYTES: usize = 100_000;
const FLOW_CONTROL_LOW_WATERMARK_BYTES: usize = 5_000;
const MAX_PENDING_CONTROL_BYTES: usize = 4 * 1024;
const OUTPUT_COALESCE_WINDOW: Duration = Duration::from_millis(5);

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum PtyOutput {
    #[serde(rename = "data")]
    Data(String),
    #[serde(rename = "exit")]
    Exit { code: i32 },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyColorTheme {
    pub foreground: String,
    pub background: String,
    pub palette: Vec<String>,
}

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    color_theme: Arc<Mutex<PtyColorTheme>>,
    theme_mode_updates: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    output_flow: Arc<OutputFlowControl>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    child_pid: Option<u32>,
}

#[derive(Default)]
struct OutputFlowState {
    unacked_bytes: usize,
    paused: bool,
}

#[derive(Default)]
struct OutputFlowControl {
    state: Mutex<OutputFlowState>,
    readable: Condvar,
}

impl OutputFlowControl {
    fn wait_until_readable(&self, alive: &AtomicBool) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        while state.paused && alive.load(Ordering::SeqCst) {
            state = self
                .readable
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
        alive.load(Ordering::SeqCst)
    }

    fn record_dispatched(&self, bytes: usize) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.unacked_bytes = state.unacked_bytes.saturating_add(bytes);
        if state.unacked_bytes >= FLOW_CONTROL_HIGH_WATERMARK_BYTES {
            state.paused = true;
        }
    }

    fn acknowledge(&self, bytes: usize) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.unacked_bytes = state.unacked_bytes.saturating_sub(bytes);
        if state.paused && state.unacked_bytes <= FLOW_CONTROL_LOW_WATERMARK_BYTES {
            state.paused = false;
            self.readable.notify_all();
        }
    }

    fn wake(&self) {
        self.readable.notify_all();
    }

    #[cfg(test)]
    fn snapshot(&self) -> (usize, bool) {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        (state.unacked_bytes, state.paused)
    }
}

enum ReaderOutput {
    Data(String),
    Exit(i32),
}

fn hold_trailing_escape(data: &mut String) -> bool {
    if data.ends_with('\x1b') {
        data.pop();
        true
    } else {
        false
    }
}

fn dispatch_output(
    channel: &Channel<PtyOutput>,
    output_flow: &OutputFlowControl,
    data: String,
) -> bool {
    if data.is_empty() {
        return true;
    }

    let bytes = data.len();
    // Reserve before dispatch so an acknowledgement cannot race the counter.
    output_flow.record_dispatched(bytes);
    if channel.send(PtyOutput::Data(data)).is_err() {
        output_flow.acknowledge(bytes);
        return false;
    }
    true
}

fn run_output_coalescer(
    receiver: Receiver<ReaderOutput>,
    channel: Channel<PtyOutput>,
    output_flow: Arc<OutputFlowControl>,
    alive: Arc<AtomicBool>,
) {
    let mut trailing_escape = false;

    while let Ok(message) = receiver.recv() {
        let ReaderOutput::Data(first) = message else {
            if trailing_escape {
                let _ = dispatch_output(&channel, &output_flow, "\x1b".to_string());
            }
            if let ReaderOutput::Exit(code) = message {
                let _ = channel.send(PtyOutput::Exit { code });
            }
            break;
        };

        let started = Instant::now();
        let mut data = String::with_capacity(first.len());
        if trailing_escape {
            data.push('\x1b');
            trailing_escape = false;
        }
        data.push_str(&first);
        let mut exit_code = None;

        loop {
            let Some(remaining) = OUTPUT_COALESCE_WINDOW.checked_sub(started.elapsed()) else {
                break;
            };
            match receiver.recv_timeout(remaining) {
                Ok(ReaderOutput::Data(next)) => data.push_str(&next),
                Ok(ReaderOutput::Exit(code)) => {
                    exit_code = Some(code);
                    break;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        // Keep a bare ESC with the following read so an escape sequence is not
        // divided immediately after its introducer.
        if exit_code.is_none() {
            trailing_escape = hold_trailing_escape(&mut data);
        }

        if !dispatch_output(&channel, &output_flow, data) {
            alive.store(false, Ordering::SeqCst);
            output_flow.wake();
            return;
        }

        if let Some(code) = exit_code {
            if trailing_escape {
                let _ = dispatch_output(&channel, &output_flow, "\x1b".to_string());
            }
            let _ = channel.send(PtyOutput::Exit { code });
            break;
        }
    }

    alive.store(false, Ordering::SeqCst);
    output_flow.wake();
}

fn is_light_background(hex: &str) -> bool {
    let trimmed = hex.trim();
    if trimmed.len() != 7 || !trimmed.starts_with('#') {
        return false;
    }

    let Ok(r) = u8::from_str_radix(&trimmed[1..3], 16) else {
        return false;
    };
    let Ok(g) = u8::from_str_radix(&trimmed[3..5], 16) else {
        return false;
    };
    let Ok(b) = u8::from_str_radix(&trimmed[5..7], 16) else {
        return false;
    };

    ((0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64) / 255.0) > 0.5
}

fn theme_mode_response(theme: &PtyColorTheme) -> String {
    let mode = if is_light_background(&theme.background) {
        2
    } else {
        1
    };
    format!("\x1b[?997;{mode}n")
}

fn to_osc_rgb(hex: &str) -> Option<String> {
    let trimmed = hex.trim();
    if trimmed.len() != 7 || !trimmed.starts_with('#') {
        return None;
    }
    let rgb = &trimmed[1..];
    if !rgb.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }

    let r = &rgb[0..2];
    let g = &rgb[2..4];
    let b = &rgb[4..6];
    Some(format!("rgb:{r}{r}/{g}{g}/{b}{b}"))
}

fn osc_color_response(content: &str, theme: &PtyColorTheme) -> Option<String> {
    let mut responses = Vec::new();

    match content {
        "10;?" => {
            if let Some(rgb) = to_osc_rgb(&theme.foreground) {
                responses.push(format!("\x1b]10;{rgb}\x1b\\"));
            }
        }
        "11;?" => {
            if let Some(rgb) = to_osc_rgb(&theme.background) {
                responses.push(format!("\x1b]11;{rgb}\x1b\\"));
            }
        }
        _ if content.starts_with("4;") => {
            let mut parts = content.split(';');
            let _ = parts.next();
            while let (Some(index), Some(value)) = (parts.next(), parts.next()) {
                if value != "?" {
                    continue;
                }

                let Ok(palette_index) = index.parse::<usize>() else {
                    continue;
                };
                let Some(hex) = theme.palette.get(palette_index) else {
                    continue;
                };
                if let Some(rgb) = to_osc_rgb(hex) {
                    responses.push(format!("\x1b]4;{palette_index};{rgb}\x1b\\"));
                }
            }
        }
        _ => {}
    }

    if responses.is_empty() {
        None
    } else {
        Some(responses.join(""))
    }
}

fn csi_response(
    content: &str,
    theme: &PtyColorTheme,
    theme_mode_updates: &Arc<AtomicBool>,
) -> (bool, Option<String>) {
    match content {
        "?2031$p" => (true, Some("\x1b[?2031;2$y".to_string())),
        "?996n" => (true, Some(theme_mode_response(theme))),
        "?2031h" => {
            theme_mode_updates.store(true, Ordering::SeqCst);
            (true, Some(theme_mode_response(theme)))
        }
        "?2031l" => {
            theme_mode_updates.store(false, Ordering::SeqCst);
            (true, None)
        }
        _ => (false, None),
    }
}

fn respond_to_terminal_queries(
    pending: &mut String,
    incoming: &str,
    theme: &Arc<Mutex<PtyColorTheme>>,
    theme_mode_updates: &Arc<AtomicBool>,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
) -> String {
    let mut text = String::with_capacity(pending.len() + incoming.len());
    text.push_str(pending);
    text.push_str(incoming);
    pending.clear();

    let bytes = text.as_bytes();
    let mut cursor = 0;
    let mut emit_cursor = 0;
    let mut incomplete_start = None;
    let mut output = String::with_capacity(text.len());

    while cursor < bytes.len() {
        let Some(offset) = text[cursor..].find('\x1b') else {
            break;
        };
        let start = cursor + offset;

        if start + 1 >= bytes.len() {
            incomplete_start = Some(start);
            break;
        }

        let control = bytes[start + 1];
        if control != b']' && control != b'[' {
            cursor = start + 1;
            continue;
        }

        let content_start = start + 2;

        let mut end = content_start;
        let mut terminator_len = 0;
        if control == b']' {
            while end < bytes.len() {
                if bytes[end] == 0x07 {
                    terminator_len = 1;
                    break;
                }
                if bytes[end] == 0x1b && end + 1 < bytes.len() && bytes[end + 1] == b'\\' {
                    terminator_len = 2;
                    break;
                }
                end += 1;
            }
        } else {
            while end < bytes.len() {
                if (0x40..=0x7e).contains(&bytes[end]) {
                    terminator_len = 1;
                    break;
                }
                end += 1;
            }
        }

        if terminator_len == 0 {
            incomplete_start = Some(start);
            break;
        }

        let content = if control == b']' {
            &text[content_start..end]
        } else {
            &text[content_start..end + terminator_len]
        };
        let (handled, response) = theme
            .lock()
            .ok()
            .map(|theme| {
                if control == b']' {
                    let response = osc_color_response(content, &theme);
                    (response.is_some(), response)
                } else {
                    csi_response(content, &theme, theme_mode_updates)
                }
            })
            .unwrap_or((false, None));
        if let Some(response) = response {
            if let Ok(mut writer) = writer.lock() {
                let _ = writer.write_all(response.as_bytes());
            }
        }

        if handled {
            output.push_str(&text[emit_cursor..start]);
            emit_cursor = end + terminator_len;
        }

        cursor = end + terminator_len;
    }

    if let Some(start) = incomplete_start {
        output.push_str(&text[emit_cursor..start]);
        let incomplete = &text[start..];
        if incomplete.len() > MAX_PENDING_CONTROL_BYTES {
            // An unterminated OSC/CSI must not retain an unbounded tail. Once
            // the cap is exceeded, forward it verbatim and resume scanning new
            // input instead of holding subsequent terminal output hostage.
            output.push_str(incomplete);
        } else {
            pending.push_str(incomplete);
        }
        output
    } else {
        output.push_str(&text[emit_cursor..]);
        output
    }
}

fn decode_utf8_chunks(pending: &mut Vec<u8>, incoming: &[u8]) -> Vec<String> {
    pending.extend_from_slice(incoming);

    let mut output = Vec::new();
    let mut cursor = 0;

    while cursor < pending.len() {
        match std::str::from_utf8(&pending[cursor..]) {
            Ok(text) => {
                if !text.is_empty() {
                    output.push(text.to_string());
                }
                pending.clear();
                return output;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    let valid = &pending[cursor..cursor + valid_up_to];
                    output.push(String::from_utf8_lossy(valid).to_string());
                    cursor += valid_up_to;
                }

                match err.error_len() {
                    Some(error_len) => {
                        let invalid_end = cursor + error_len;
                        let invalid = &pending[cursor..invalid_end];
                        output.push(String::from_utf8_lossy(invalid).to_string());
                        cursor = invalid_end;
                    }
                    None => {
                        if cursor > 0 {
                            pending.drain(..cursor);
                        }
                        return output;
                    }
                }
            }
        }
    }

    pending.clear();
    output
}

/// Find all descendant PIDs of the given root PID by walking the process tree.
/// Uses `pgrep -P <pid>` to find direct children, then recurses.
fn get_all_descendants(root_pid: i32) -> Vec<i32> {
    let mut descendants = Vec::new();
    let mut queue = vec![root_pid];

    while let Some(parent) = queue.pop() {
        if let Ok(output) = Command::new("pgrep")
            .arg("-P")
            .arg(parent.to_string())
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if let Ok(pid) = line.trim().parse::<i32>() {
                    if !descendants.contains(&pid) {
                        descendants.push(pid);
                        queue.push(pid);
                    }
                }
            }
        }
    }

    descendants
}

impl PtySession {
    pub fn spawn(
        command: &str,
        args: Option<Vec<String>>,
        cwd: &str,
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
        color_theme: PtyColorTheme,
        channel: Channel<PtyOutput>,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {e}"))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.arg("-i");
        cmd.arg("-c");
        if let Some(args) = args {
            cmd.arg("exec \"$@\"");
            cmd.arg("shep");
            cmd.arg(command);
            for arg in args {
                cmd.arg(arg);
            }
        } else {
            cmd.arg(command);
        }
        cmd.cwd(cwd);

        for (key, val) in &env {
            cmd.env(key, val);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "iTerm.app"); // Fix for CLI tools (like gemini-cli) assuming solid backgrounds
        cmd.env("COLORTERM", "truecolor"); // Enable 24-bit color support

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {e}"))?;
        let child_pid = child.process_id();
        let killer = child.clone_killer();

        // Drop slave — we only need the master side
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {e}"))?;
        let writer = Arc::new(Mutex::new(writer));

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

        let alive = Arc::new(AtomicBool::new(true));
        let color_theme = Arc::new(Mutex::new(color_theme));
        let reader_color_theme = color_theme.clone();
        let reader_writer = writer.clone();
        let theme_mode_updates = Arc::new(AtomicBool::new(false));
        let reader_theme_mode_updates = theme_mode_updates.clone();
        let output_flow = Arc::new(OutputFlowControl::default());
        let reader_output_flow = output_flow.clone();
        let reader_alive = alive.clone();
        let coalescer_output_flow = output_flow.clone();
        let coalescer_alive = alive.clone();
        // A one-message handoff bounds read-ahead while still letting the
        // coalescer collect all output produced during its 5 ms window.
        let (output_sender, output_receiver) = sync_channel::<ReaderOutput>(1);

        thread::spawn(move || {
            run_output_coalescer(
                output_receiver,
                channel,
                coalescer_output_flow,
                coalescer_alive,
            );
        });

        // Spawn reader thread
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut pending = Vec::new();
            let mut pending_control = String::new();
            loop {
                if !reader_output_flow.wait_until_readable(&reader_alive) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        for text in decode_utf8_chunks(&mut pending, &buf[..n]) {
                            let text = respond_to_terminal_queries(
                                &mut pending_control,
                                &text,
                                &reader_color_theme,
                                &reader_theme_mode_updates,
                                &reader_writer,
                            );
                            if text.is_empty() {
                                continue;
                            }
                            if output_sender.send(ReaderOutput::Data(text)).is_err() {
                                return;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }

            if !pending.is_empty() {
                let text = String::from_utf8_lossy(&pending).to_string();
                let text = respond_to_terminal_queries(
                    &mut pending_control,
                    &text,
                    &reader_color_theme,
                    &reader_theme_mode_updates,
                    &reader_writer,
                );
                if !text.is_empty() {
                    let _ = output_sender.send(ReaderOutput::Data(text));
                }
            }

            if !pending_control.is_empty() {
                let _ = output_sender.send(ReaderOutput::Data(pending_control));
            }

            reader_alive.store(false, Ordering::SeqCst);
            let exit_code = child
                .wait()
                .map(|status| status.exit_code() as i32)
                .unwrap_or(1);
            let _ = output_sender.send(ReaderOutput::Exit(exit_code));
        });

        Ok(PtySession {
            master: pair.master,
            writer,
            color_theme,
            theme_mode_updates,
            alive,
            output_flow,
            killer,
            child_pid,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.child_pid
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "Failed to lock PTY writer".to_string())?;
        writer
            .write_all(data)
            .map_err(|e| format!("Failed to write to PTY: {e}"))
    }

    pub fn acknowledge_output(&self, bytes: usize) {
        self.output_flow.acknowledge(bytes);
    }

    pub fn set_color_theme(&self, color_theme: PtyColorTheme) -> Result<(), String> {
        let response = theme_mode_response(&color_theme);
        let mut theme = self
            .color_theme
            .lock()
            .map_err(|_| "Failed to lock PTY color theme".to_string())?;
        *theme = color_theme;

        if self.theme_mode_updates.load(Ordering::SeqCst) {
            let mut writer = self
                .writer
                .lock()
                .map_err(|_| "Failed to lock PTY writer".to_string())?;
            writer
                .write_all(response.as_bytes())
                .map_err(|e| format!("Failed to write theme mode update: {e}"))?;
        }

        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize PTY: {e}"))
    }

    pub fn kill(&mut self) -> Result<(), String> {
        self.alive.store(false, Ordering::SeqCst);
        self.output_flow.wake();

        if let Some(pid) = self.child_pid {
            let pid = pid as i32;

            // Collect all descendant PIDs before killing anything, since
            // dying parents cause reparenting which scrambles the tree.
            let descendants = get_all_descendants(pid);

            unsafe {
                // Signal the process group (covers children that stayed in group)
                if libc::kill(pid, 0) == 0 {
                    libc::killpg(pid, libc::SIGHUP);
                    libc::killpg(pid, libc::SIGTERM);
                }

                // Also signal descendants that escaped to their own process
                // group or session (e.g. opencode, which calls setsid).
                for &child in &descendants {
                    if libc::kill(child, 0) == 0 {
                        libc::kill(child, libc::SIGTERM);
                    }
                }
            }

            // Give processes a moment to exit gracefully, then SIGKILL survivors.
            thread::sleep(Duration::from_millis(100));

            unsafe {
                for &child in &descendants {
                    if libc::kill(child, 0) == 0 {
                        libc::kill(child, libc::SIGKILL);
                    }
                }
                if libc::kill(pid, 0) == 0 {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }

        self.killer
            .kill()
            .map_err(|e| format!("Failed to kill PTY: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_utf8_chunks, hold_trailing_escape, respond_to_terminal_queries,
        OutputFlowControl, PtyColorTheme, FLOW_CONTROL_HIGH_WATERMARK_BYTES,
        FLOW_CONTROL_LOW_WATERMARK_BYTES, MAX_PENDING_CONTROL_BYTES,
    };
    use std::io::{Result as IoResult, Write};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};

    struct TestWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for TestWriter {
        fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> IoResult<()> {
            Ok(())
        }
    }

    fn test_theme() -> PtyColorTheme {
        PtyColorTheme {
            foreground: "#4c4f69".to_string(),
            background: "#eff1f5".to_string(),
            palette: vec![
                "#5c5f77".to_string(),
                "#d20f39".to_string(),
                "#40a02b".to_string(),
                "#df8e1d".to_string(),
                "#1e66f5".to_string(),
                "#ea76cb".to_string(),
                "#179299".to_string(),
                "#acb0be".to_string(),
                "#6c6f85".to_string(),
                "#de293e".to_string(),
                "#49af3d".to_string(),
                "#eea02d".to_string(),
                "#456eff".to_string(),
                "#fe85d8".to_string(),
                "#2d9fa8".to_string(),
                "#bcc0cc".to_string(),
            ],
        }
    }

    fn run_query(input: &str) -> (String, String) {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::new(Mutex::new(
            Box::new(TestWriter(captured.clone())) as Box<dyn Write + Send>
        ));
        let theme = Arc::new(Mutex::new(test_theme()));
        let theme_mode_updates = Arc::new(AtomicBool::new(false));
        let mut pending = String::new();

        let forwarded = respond_to_terminal_queries(
            &mut pending,
            input,
            &theme,
            &theme_mode_updates,
            &writer,
        );
        let response = String::from_utf8(captured.lock().unwrap().clone()).unwrap();

        (forwarded, response)
    }

    #[test]
    fn preserves_split_utf8_sequences() {
        let mut pending = Vec::new();

        let part_one = decode_utf8_chunks(&mut pending, &[0xE2, 0x9C]);
        assert!(part_one.is_empty());
        assert_eq!(pending, vec![0xE2, 0x9C]);

        let part_two = decode_utf8_chunks(&mut pending, &[0xA8]);
        assert_eq!(part_two, vec!["\u{2728}".to_string()]);
        assert!(pending.is_empty());
    }

    #[test]
    fn emits_valid_prefix_and_keeps_incomplete_suffix() {
        let mut pending = Vec::new();

        let output = decode_utf8_chunks(&mut pending, &[b'a', b'b', 0xE2, 0x9C]);
        assert_eq!(output, vec!["ab".to_string()]);
        assert_eq!(pending, vec![0xE2, 0x9C]);
    }

    #[test]
    fn replaces_invalid_utf8_without_dropping_following_text() {
        let mut pending = Vec::new();

        let output = decode_utf8_chunks(&mut pending, &[b'a', 0xFF, b'b']);
        assert_eq!(
            output,
            vec!["a".to_string(), "\u{FFFD}".to_string(), "b".to_string()]
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn responds_to_and_strips_osc_background_query() {
        let (forwarded, response) = run_query("before\x1b]11;?\x07after");

        assert_eq!(forwarded, "beforeafter");
        assert_eq!(response, "\x1b]11;rgb:efef/f1f1/f5f5\x1b\\");
    }

    #[test]
    fn responds_to_and_strips_opentui_color_scheme_queries() {
        let (forwarded, response) = run_query("before\x1b[?2031$p\x1b[?2031h\x1b[?996nafter");

        assert_eq!(forwarded, "beforeafter");
        assert_eq!(response, "\x1b[?2031;2$y\x1b[?997;2n\x1b[?997;2n");
    }

    #[test]
    fn flow_control_resumes_only_at_low_watermark() {
        let flow = OutputFlowControl::default();

        flow.record_dispatched(FLOW_CONTROL_HIGH_WATERMARK_BYTES);
        assert_eq!(flow.snapshot(), (FLOW_CONTROL_HIGH_WATERMARK_BYTES, true));

        flow.acknowledge(
            FLOW_CONTROL_HIGH_WATERMARK_BYTES - FLOW_CONTROL_LOW_WATERMARK_BYTES - 1,
        );
        assert_eq!(flow.snapshot(), (FLOW_CONTROL_LOW_WATERMARK_BYTES + 1, true));

        flow.acknowledge(1);
        assert_eq!(flow.snapshot(), (FLOW_CONTROL_LOW_WATERMARK_BYTES, false));
    }

    #[test]
    fn bounds_and_flushes_unterminated_control_sequences() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::new(Mutex::new(
            Box::new(TestWriter(captured)) as Box<dyn Write + Send>
        ));
        let theme = Arc::new(Mutex::new(test_theme()));
        let theme_mode_updates = Arc::new(AtomicBool::new(false));
        let mut pending = String::new();
        let at_limit = format!("\x1b]{}", "x".repeat(MAX_PENDING_CONTROL_BYTES - 2));

        let first = respond_to_terminal_queries(
            &mut pending,
            &at_limit,
            &theme,
            &theme_mode_updates,
            &writer,
        );
        assert!(first.is_empty());
        assert_eq!(pending.len(), MAX_PENDING_CONTROL_BYTES);

        let second = respond_to_terminal_queries(
            &mut pending,
            "x",
            &theme,
            &theme_mode_updates,
            &writer,
        );
        assert_eq!(second, format!("{at_limit}x"));
        assert!(pending.is_empty());
    }

    #[test]
    fn preserves_screen_clears_and_colors_inside_synchronized_output() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::new(Mutex::new(
            Box::new(TestWriter(captured)) as Box<dyn Write + Send>
        ));
        let theme = Arc::new(Mutex::new(test_theme()));
        let theme_mode_updates = Arc::new(AtomicBool::new(false));
        let mut pending = String::new();

        let forwarded = respond_to_terminal_queries(
            &mut pending,
            "before\x1b[?2026h\x1b[1;36minside\x1b[2Jmiddle\x1b[31mafter\x1b[3J\x1b[0mtail\x1b[?2026l\x1b[2Jend",
            &theme,
            &theme_mode_updates,
            &writer,
        );

        assert_eq!(
            forwarded,
            "before\x1b[?2026h\x1b[1;36minside\x1b[2Jmiddle\x1b[31mafter\x1b[3J\x1b[0mtail\x1b[?2026l\x1b[2Jend"
        );
    }

    #[test]
    fn holds_a_bare_trailing_escape_for_the_next_chunk() {
        let mut data = "output\x1b".to_string();
        assert!(hold_trailing_escape(&mut data));
        assert_eq!(data, "output");

        let mut complete = "output\x1b[2J".to_string();
        assert!(!hold_trailing_escape(&mut complete));
        assert_eq!(complete, "output\x1b[2J");
    }
}
