//! Herdr's supported terminal-session CLI transport; see the findings document.

use crate::commands::AppState;
use crate::world::state::WorldState;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

const MAX_RECORD_BYTES: usize = 4 * 1024 * 1024;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_STDERR_BYTES: usize = 8192;
const MAX_ATTACHMENTS: usize = 4;
const MAX_UNACKED_BYTES: usize = 4 * 1024 * 1024;
const MAX_UNACKED_FRAMES: usize = 128;
const RENDER_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const CLOSE_GRACE: Duration = Duration::from_millis(300);
static NEXT_LEASE: AtomicU64 = AtomicU64::new(1);
type EventSink = Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>;

#[derive(Default)]
pub struct TerminalTransportState {
    inner: Arc<Registry>,
}
#[derive(Default)]
struct Registry {
    leases: Mutex<HashMap<String, Arc<Lease>>>,
    shutting_down: AtomicBool,
}
struct Lease {
    pane_id: String,
    root: String,
    cwd: String,
    writer: mpsc::SyncSender<Vec<u8>>,
    closing: AtomicBool,
    received_frame: AtomicBool,
    remote_closed: AtomicBool,
    stdout_done: AtomicBool,
    failure: Mutex<Option<String>>,
    render: Mutex<RenderWindow>,
    done: (Mutex<bool>, Condvar),
}

/// Channel::send can return before JavaScript consumes its native payload. Keep
/// an explicit budget until the renderer confirms that xterm applied the frame.
struct RenderWindow {
    pending: VecDeque<(u64, usize, Instant)>,
    pending_bytes: usize,
    last_sent: Option<u64>,
    last_acked: Option<u64>,
    last_ack_at: Instant,
}

impl Default for RenderWindow {
    fn default() -> Self {
        Self {
            pending: VecDeque::new(),
            pending_bytes: 0,
            last_sent: None,
            last_acked: None,
            last_ack_at: Instant::now(),
        }
    }
}

impl RenderWindow {
    fn reserve(&mut self, seq: u64, bytes: usize, now: Instant) -> Result<(), String> {
        if self.pending.len() >= MAX_UNACKED_FRAMES
            || bytes > MAX_UNACKED_BYTES.saturating_sub(self.pending_bytes)
        {
            return Err(
                "terminal renderer has too many unacknowledged frames; connection closed".into(),
            );
        }
        self.pending.push_back((seq, bytes, now));
        self.pending_bytes += bytes;
        self.last_sent = Some(seq);
        Ok(())
    }

    fn acknowledge(&mut self, seq: u64, now: Instant) -> Result<(), String> {
        let Some(last_sent) = self.last_sent else {
            return Err("terminal renderer acknowledged before the first frame".into());
        };
        let oldest = self
            .last_acked
            .or_else(|| self.pending.front().map(|record| record.0))
            .unwrap_or(last_sent);
        if seq < oldest || seq > last_sent {
            return Err("terminal renderer acknowledged an invalid frame sequence".into());
        }
        while self.pending.front().is_some_and(|record| record.0 <= seq) {
            self.pending_bytes -= self.pending.pop_front().unwrap().1;
        }
        self.last_acked = Some(seq);
        self.last_ack_at = now;
        Ok(())
    }

    fn expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.last_ack_at) >= RENDER_ACK_TIMEOUT
            || self
                .pending
                .front()
                .is_some_and(|record| now.saturating_duration_since(record.2) >= RENDER_ACK_TIMEOUT)
    }
}
impl Lease {
    fn close(&self) {
        self.closing.store(true, Ordering::Release);
    }

    fn fail(&self, message: String) {
        self.failure.lock().unwrap().get_or_insert(message);
        self.close();
    }

    fn wait_done(&self, timeout: Duration) -> bool {
        let (guard, _) = self
            .done
            .1
            .wait_timeout_while(self.done.0.lock().unwrap(), timeout, |done| !*done)
            .unwrap();
        *guard
    }
}

impl Drop for TerminalTransportState {
    fn drop(&mut self) {
        self.inner.shutting_down.store(true, Ordering::Release);
        let leases: Vec<_> = self
            .inner
            .leases
            .lock()
            .unwrap()
            .drain()
            .map(|(_, lease)| lease)
            .collect();
        for lease in &leases {
            lease.close();
        }
        for lease in leases {
            lease.wait_done(Duration::from_secs(2));
        }
    }
}

impl TerminalTransportState {
    #[cfg(test)]
    fn start(
        &self,
        executable: &Path,
        socket: &Path,
        pane: &str,
        root: &str,
        cols: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<String, String> {
        Registry::start(
            &self.inner,
            executable,
            socket,
            pane,
            root,
            root,
            cols,
            rows,
            sink,
        )
    }

    fn validated_lease(
        &self,
        world: &WorldState,
        id: &str,
        pane: &str,
        root: &str,
    ) -> Result<Arc<Lease>, String> {
        let lease = self
            .inner
            .leases
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("terminal connection is closed")?;
        if lease.pane_id != pane || lease.root != root {
            return Err("terminal connection belongs to a different pane or repository".into());
        }
        match validate_target(world, pane, root) {
            Ok(cwd) if cwd == lease.cwd => {}
            Ok(_) => {
                lease.close();
                return Err(
                    "terminal pane working directory changed; reconnect to the selected pane"
                        .into(),
                );
            }
            Err(error) => {
                lease.close();
                return Err(error);
            }
        }
        if lease.closing.load(Ordering::Acquire) {
            return Err("terminal connection is closing".into());
        }
        Ok(lease)
    }

    /// Success acknowledges a bounded local queue, not a write acknowledged by Herdr.
    fn queue(
        &self,
        world: &WorldState,
        id: &str,
        pane: &str,
        root: &str,
        value: Value,
    ) -> Result<(), String> {
        let lease = self.validated_lease(world, id, pane, root)?;
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        lease.writer.try_send(bytes).map_err(|error| {
            let message = match error {
                mpsc::TrySendError::Full(_) => {
                    "terminal input queue is full; connection closed without retrying input"
                }
                mpsc::TrySendError::Disconnected(_) => "terminal input connection is closed",
            }
            .to_string();
            lease.fail(message.clone());
            message
        })
    }

    fn acknowledge(
        &self,
        world: &WorldState,
        id: &str,
        pane: &str,
        root: &str,
        seq: u64,
    ) -> Result<(), String> {
        let lease = self.validated_lease(world, id, pane, root)?;
        let result = lease
            .render
            .lock()
            .unwrap()
            .acknowledge(seq, Instant::now());
        if let Err(message) = &result {
            lease.fail(message.clone());
        }
        result
    }

    fn take_lease(&self, id: &str) -> Option<Arc<Lease>> {
        let lease = self.inner.leases.lock().unwrap().remove(id);
        if let Some(lease) = &lease {
            lease.close();
        }
        lease
    }

    #[cfg(test)]
    fn detach(&self, id: &str) -> Result<(), String> {
        finish_detach(self.take_lease(id))
    }
}

impl Registry {
    fn start(
        this: &Arc<Self>,
        executable: &Path,
        socket: &Path,
        pane: &str,
        root: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<String, String> {
        validate_dimensions(cols, rows)?;
        let mut leases = this.leases.lock().unwrap();
        if this.shutting_down.load(Ordering::Acquire) {
            return Err("application is closing".into());
        }
        if leases.len() >= MAX_ATTACHMENTS {
            return Err("too many direct terminal connections".into());
        }
        if leases.values().any(|lease| lease.pane_id == pane) {
            return Err("this pane already has a direct terminal connection in this window".into());
        }
        let mut child = OwnedChild(
            Command::new(executable)
                .args([
                    "terminal",
                    "session",
                    "control",
                    pane,
                    "--cols",
                    &cols.to_string(),
                    "--rows",
                    &rows.to_string(),
                ])
                .env("HERDR_SOCKET_PATH", socket)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("could not start Herdr terminal connection: {e}"))?,
        );
        let stdin = child
            .0
            .stdin
            .take()
            .ok_or("could not open terminal input")?;
        let stdout = child
            .0
            .stdout
            .take()
            .ok_or("could not open terminal output")?;
        let stderr = child
            .0
            .stderr
            .take()
            .ok_or("could not open terminal diagnostics")?;
        // Both records and input queues are bounded; overload closes the connection.
        let (writer, input) = mpsc::sync_channel(16);
        let lease = Arc::new(Lease {
            pane_id: pane.into(),
            root: root.into(),
            cwd: cwd.into(),
            writer,
            closing: AtomicBool::new(false),
            received_frame: AtomicBool::new(false),
            remote_closed: AtomicBool::new(false),
            stdout_done: AtomicBool::new(false),
            failure: Mutex::new(None),
            render: Mutex::new(RenderWindow::default()),
            done: (Mutex::new(false), Condvar::new()),
        });
        let id = format!(
            "terminal-{}-{}",
            std::process::id(),
            NEXT_LEASE.fetch_add(1, Ordering::Relaxed)
        );
        leases.insert(id.clone(), lease.clone());
        drop(leases);
        let writer_lease = lease.clone();
        let writer_thread = std::thread::spawn(move || write_input(stdin, input, writer_lease));
        let output_lease = lease.clone();
        let output_sink = sink.clone();
        let output_thread =
            std::thread::spawn(move || read_frames(stdout, output_lease, output_sink));
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let diagnostic_copy = diagnostics.clone();
        let stderr_thread = std::thread::spawn(move || read_diagnostics(stderr, diagnostic_copy));
        let registry = Arc::downgrade(this);
        let thread_id = id.clone();
        std::thread::spawn(move || {
            supervise(&mut child, &lease);
            lease.close();
            // Reap even if process monitoring failed before joining pipe readers.
            // Otherwise a still-running helper could keep those joins blocked.
            drop(child);
            let _ = writer_thread.join();
            if output_thread.join().is_err() {
                lease.fail("terminal output reader stopped unexpectedly".into());
            }
            let _ = stderr_thread.join();
            if !lease.remote_closed.load(Ordering::Acquire) {
                let failure = lease.failure.lock().unwrap().clone();
                let stderr = String::from_utf8_lossy(&diagnostics.lock().unwrap())
                    .trim()
                    .to_string();
                let event = if let Some(message) = failure {
                    json!({"type":"terminal.error","message": if stderr.is_empty() {message} else {format!("{message}: {stderr}")} })
                } else if !stderr.is_empty() && !lease.received_frame.load(Ordering::Acquire) {
                    json!({"type":"terminal.error","message":stderr})
                } else if !lease.received_frame.load(Ordering::Acquire) {
                    json!({"type":"terminal.error","message":"Herdr terminal connection ended before its initial frame"})
                } else {
                    json!({"type":"terminal.closed","reason":"terminal connection ended"})
                };
                let _ = sink(event);
            }
            remove_finished(&registry, &thread_id);
            *lease.done.0.lock().unwrap() = true;
            lease.done.1.notify_all();
        });
        Ok(id)
    }
}

/// Owns only the helper CLI. Killing it never kills the server or pane process.
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn remove_finished(registry: &Weak<Registry>, id: &str) {
    if let Some(registry) = registry.upgrade() {
        registry.leases.lock().unwrap().remove(id);
    }
}

fn supervise(child: &mut OwnedChild, lease: &Lease) {
    let started = Instant::now();
    let mut closing_since = None;
    loop {
        match child.0.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    lease.fail(format!("Herdr terminal connection exited with {status}"));
                }
                return;
            }
            Err(error) => {
                lease.fail(format!("could not monitor terminal connection: {error}"));
                return;
            }
            Ok(None) => {}
        }
        if !lease.received_frame.load(Ordering::Acquire)
            && started.elapsed() > Duration::from_secs(10)
        {
            lease.fail("Herdr did not provide an initial terminal frame within 10 seconds".into());
        }
        if lease.stdout_done.load(Ordering::Acquire) {
            lease.close();
        }
        if lease.render.lock().unwrap().expired(Instant::now()) {
            lease.fail(
                "terminal renderer stopped acknowledging frames or heartbeats for 15 seconds"
                    .into(),
            );
        }
        if lease.closing.load(Ordering::Acquire) {
            let since = closing_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= CLOSE_GRACE {
                let _ = child.0.kill();
                let _ = child.0.wait();
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn write_input(mut stdin: impl Write, input: mpsc::Receiver<Vec<u8>>, lease: Arc<Lease>) {
    loop {
        if lease.closing.load(Ordering::Acquire) {
            let _ = stdin.write_all(b"{\"type\":\"terminal.release\"}\n");
            return;
        }
        match input.recv_timeout(Duration::from_millis(20)) {
            Ok(bytes) => {
                if lease.closing.load(Ordering::Acquire) {
                    continue;
                }
                if let Err(error) = stdin.write_all(&bytes).and_then(|_| stdin.flush()) {
                    lease.fail(format!("could not queue input to Herdr: {error}"));
                    return;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn read_bounded_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .map_err(|e| format!("could not read terminal stream: {e}"))?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err("terminal stream ended within a record".into())
            };
        }
        let take = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|n| n + 1)
            .unwrap_or(buffer.len());
        if line.len() + take > MAX_RECORD_BYTES {
            return Err("terminal frame exceeds the size limit".into());
        }
        let finished = buffer[take - 1] == b'\n';
        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if finished {
            return Ok(Some(line));
        }
    }
}

fn read_frames(stdout: impl Read, lease: Arc<Lease>, sink: EventSink) {
    let mut reader = BufReader::new(stdout);
    let mut frames = FrameValidator::default();
    let outcome = (|| -> Result<(), String> {
        while let Some(line) = read_bounded_line(&mut reader)? {
            let event: Value = serde_json::from_slice(&line)
                .map_err(|e| format!("invalid Herdr terminal record: {e}"))?;
            let closed = frames.accept(&event)?;
            if closed {
                lease.remote_closed.store(true, Ordering::Release);
            } else {
                let bytes = serde_json::to_vec(&event)
                    .map_err(|error| error.to_string())?
                    .len();
                lease.render.lock().unwrap().reserve(
                    event["seq"].as_u64().unwrap(),
                    bytes,
                    Instant::now(),
                )?;
                lease.received_frame.store(true, Ordering::Release);
            }
            sink(event).map_err(|_| "terminal view disconnected".to_string())?;
            if closed {
                return Ok(());
            }
        }
        Ok(())
    })();
    if let Err(error) = outcome {
        lease.fail(error);
    }
    lease.stdout_done.store(true, Ordering::Release);
}

fn read_diagnostics(mut stderr: impl Read, diagnostics: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0_u8; 1024];
    while let Ok(count) = stderr.read(&mut chunk) {
        if count == 0 {
            return;
        }
        let mut bytes = diagnostics.lock().unwrap();
        bytes.extend_from_slice(&chunk[..count]);
        let excess = bytes.len().saturating_sub(MAX_STDERR_BYTES);
        bytes.drain(..excess);
    }
}

fn validate_target<'a>(world: &'a WorldState, pane: &str, root: &str) -> Result<&'a str, String> {
    if !world.herdr_connected || world.protocol_mismatch {
        return Err("Herdr is not connected with a compatible protocol".into());
    }
    if pane.is_empty()
        || pane.starts_with('-')
        || pane == "help"
        || pane.len() > 256
        || pane.chars().any(char::is_whitespace)
    {
        return Err("invalid terminal pane target".into());
    }
    crate::commands::validate_live_pane(world, pane, Some(root))?;
    world
        .islands
        .iter()
        .filter(|island| island.root == root)
        .flat_map(|island| &island.agents)
        .find(|agent| agent.pane_id == pane)
        .map(|agent| agent.cwd.as_str())
        .ok_or_else(|| "terminal repository must exactly match the selected live pane".into())
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > 500 || rows > 200 {
        return Err("terminal size must be 1–500 columns and 1–200 rows".into());
    }
    Ok(())
}

fn input_command(text: &str) -> Result<Value, String> {
    if text.len() > MAX_INPUT_BYTES {
        return Err("terminal input exceeds 64 KiB; shorten it before sending".into());
    }
    Ok(json!({"type":"terminal.input","text":text}))
}

fn scroll_command(direction: &str, lines: u16, source: &str) -> Result<Value, String> {
    if !matches!(direction, "up" | "down")
        || lines == 0
        || lines > 200
        || !matches!(source, "wheel" | "page_key")
    {
        return Err(
            "terminal scroll requires up/down, 1–200 lines, and wheel/page_key source".into(),
        );
    }
    Ok(json!({"type":"terminal.scroll","direction":direction,"lines":lines,"source":source}))
}

#[derive(Default)]
struct FrameValidator {
    last_seq: Option<u64>,
}
impl FrameValidator {
    fn accept(&mut self, event: &Value) -> Result<bool, String> {
        if event["type"] == "terminal.closed" {
            if !event["reason"].is_null() && !event["reason"].is_string() {
                return Err("invalid terminal close reason".into());
            }
            return Ok(true);
        }
        if event["type"] != "terminal.frame" || event["encoding"] != "ansi" {
            return Err("unsupported terminal stream record".into());
        }
        let seq = event["seq"]
            .as_u64()
            .filter(|seq| *seq > 0 && *seq <= 9_007_199_254_740_991)
            .ok_or("invalid terminal frame sequence")?;
        if self.last_seq.is_some_and(|previous| seq != previous + 1) {
            return Err(
                "terminal frame sequence was interrupted; reconnect for a new screen".into(),
            );
        }
        let full = event["full"]
            .as_bool()
            .ok_or("invalid terminal frame redraw flag")?;
        if self.last_seq.is_none() && !full {
            return Err("terminal connection did not begin with a full frame".into());
        }
        let cols = event["width"]
            .as_u64()
            .and_then(|value| u16::try_from(value).ok())
            .ok_or("invalid terminal frame width")?;
        let rows = event["height"]
            .as_u64()
            .and_then(|value| u16::try_from(value).ok())
            .ok_or("invalid terminal frame height")?;
        validate_dimensions(cols, rows)?;
        let bytes = event["bytes"]
            .as_str()
            .ok_or("terminal frame has no encoded bytes")?;
        if !valid_base64(bytes) {
            return Err("terminal frame contains invalid base64 bytes".into());
        }
        self.last_seq = Some(seq);
        Ok(false)
    }
}

fn valid_base64(encoded: &str) -> bool {
    if encoded.len() % 4 != 0 {
        return false;
    }
    let content = encoded.trim_end_matches('=');
    encoded.len() - content.len() <= 2
        && content
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

fn resolve_executable(home: &Path) -> Result<PathBuf, String> {
    find_herdr(std::env::var_os("PATH").as_deref(), home, &executable_file).ok_or_else(|| {
        "Herdr executable was not found in PATH, ~/.local/bin, /opt/homebrew/bin or /usr/local/bin"
            .into()
    })
}

/// The first `herdr` on PATH, then in the places installers put it. The
/// fallbacks matter more than they look: an app opened from Finder inherits
/// a minimal PATH with no Homebrew directories, so `brew install herdr` —
/// the documented install — was never found outside a terminal launch.
fn find_herdr(
    path: Option<&std::ffi::OsStr>,
    home: &Path,
    is_executable: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let on_path = path
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|directory| directory.is_absolute());
    let fallbacks = [
        home.join(".local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    on_path
        .chain(fallbacks)
        .map(|directory| directory.join("herdr"))
        .find(|candidate| is_executable(candidate))
}

/// Read-only: whether Herdr is installed somewhere this app can run it, so
/// first-run setup can say "install it" or "start it" instead of guessing.
#[tauri::command]
pub fn herdr_setup() -> Value {
    let installed = dirs::home_dir().is_some_and(|home| resolve_executable(&home).is_ok());
    json!({ "installed": installed })
}

fn finish_detach(lease: Option<Arc<Lease>>) -> Result<(), String> {
    if lease.is_some_and(|lease| !lease.wait_done(Duration::from_secs(2))) {
        return Err("terminal helper is still shutting down".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_attach(
    state: tauri::State<'_, AppState>,
    transport: tauri::State<'_, TerminalTransportState>,
    pane_id: String,
    expected_root: String,
    cols: u16,
    rows: u16,
    on_event: tauri::ipc::Channel<Value>,
) -> Result<String, String> {
    validate_dimensions(cols, rows)?;
    let cwd = validate_target(&state.world.lock().unwrap(), &pane_id, &expected_root)?.to_string();
    let home = dirs::home_dir().ok_or("no home directory")?;
    let executable = resolve_executable(&home)?;
    let socket =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
    let registry = transport.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Registry::start(
            &registry,
            &executable,
            &socket,
            &pane_id,
            &expected_root,
            &cwd,
            cols,
            rows,
            Arc::new(move |value| on_event.send(value).map_err(|error| error.to_string())),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn terminal_ack(
    state: tauri::State<'_, AppState>,
    transport: tauri::State<'_, TerminalTransportState>,
    lease_id: String,
    pane_id: String,
    expected_root: String,
    seq: u64,
) -> Result<(), String> {
    transport.acknowledge(
        &state.world.lock().unwrap(),
        &lease_id,
        &pane_id,
        &expected_root,
        seq,
    )
}

#[tauri::command]
pub fn terminal_write(
    state: tauri::State<'_, AppState>,
    transport: tauri::State<'_, TerminalTransportState>,
    lease_id: String,
    pane_id: String,
    expected_root: String,
    text: String,
) -> Result<(), String> {
    transport.queue(
        &state.world.lock().unwrap(),
        &lease_id,
        &pane_id,
        &expected_root,
        input_command(&text)?,
    )
}

#[tauri::command]
pub fn terminal_resize(
    state: tauri::State<'_, AppState>,
    transport: tauri::State<'_, TerminalTransportState>,
    lease_id: String,
    pane_id: String,
    expected_root: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    validate_dimensions(cols, rows)?;
    transport.queue(
        &state.world.lock().unwrap(),
        &lease_id,
        &pane_id,
        &expected_root,
        json!({"type":"terminal.resize","cols":cols,"rows":rows}),
    )
}

#[tauri::command]
pub fn terminal_scroll(
    state: tauri::State<'_, AppState>,
    transport: tauri::State<'_, TerminalTransportState>,
    lease_id: String,
    pane_id: String,
    expected_root: String,
    direction: String,
    lines: u16,
    source: Option<String>,
) -> Result<(), String> {
    transport.queue(
        &state.world.lock().unwrap(),
        &lease_id,
        &pane_id,
        &expected_root,
        scroll_command(&direction, lines, source.as_deref().unwrap_or("wheel"))?,
    )
}

#[tauri::command]
pub async fn terminal_detach(
    transport: tauri::State<'_, TerminalTransportState>,
    lease_id: String,
) -> Result<(), String> {
    let lease = transport.take_lease(&lease_id);
    tauri::async_runtime::spawn_blocking(move || finish_detach(lease))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_herdr_on_path_first_then_where_installers_put_it() {
        let home = Path::new("/Users/you");
        let at = |found: &'static [&'static str]| move |p: &Path| found.iter().any(|f| p == Path::new(f));
        let path = std::ffi::OsString::from("/usr/bin:relative/bin:/custom/bin");
        assert_eq!(
            find_herdr(Some(&path), home, &at(&["/custom/bin/herdr", "/opt/homebrew/bin/herdr"])),
            Some(PathBuf::from("/custom/bin/herdr")),
        );
        // A Finder launch: PATH has no Homebrew, but brew installed it there.
        let finder = std::ffi::OsString::from("/usr/bin:/bin:/usr/sbin:/sbin");
        assert_eq!(
            find_herdr(Some(&finder), home, &at(&["/opt/homebrew/bin/herdr"])),
            Some(PathBuf::from("/opt/homebrew/bin/herdr")),
        );
        assert_eq!(
            find_herdr(None, home, &at(&["/Users/you/.local/bin/herdr", "/usr/local/bin/herdr"])),
            Some(PathBuf::from("/Users/you/.local/bin/herdr")),
        );
        // Relative PATH entries are never trusted.
        assert_eq!(find_herdr(Some(&path), home, &at(&["relative/bin/herdr"])), None);
        assert_eq!(find_herdr(Some(&finder), home, &at(&[])), None);
    }
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[cfg(unix)]
    fn fake_cli(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake herdr");
        std::fs::write(
            &path,
            format!("#!/usr/bin/env python3\nimport sys, os, json, time\n{body}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn world() -> crate::world::state::WorldState {
        use crate::world::{
            attention::Attention,
            state::{Island, IslandAgent, WorldState},
        };
        let mut world = WorldState::disconnected();
        world.herdr_connected = true;
        world.islands.push(Island {
            id: "repo".into(),
            name: "repo".into(),
            root: "/repo".into(),
            attention: Attention::Quiet,
            last_changed_at: None,
            agents: vec![IslandAgent {
                pane_id: "w1:p1".into(),
                workspace_id: "w1".into(),
                status: crate::herdr::snapshot::AgentStatus::Idle,
                title: None,
                kind: None,
                is_worktree: false,
                attention: Attention::Quiet,
                cwd: "/repo".into(),
            }],
        });
        world
    }

    #[test]
    fn refuses_disconnected_stale_wrong_root_and_option_targets() {
        assert!(validate_target(&world(), "w1:p1", "/repo").is_ok());
        assert!(validate_target(&world(), "w1:p1", "/other").is_err());
        assert!(validate_target(&world(), "w1:p2", "/repo").is_err());
        assert!(validate_target(&world(), "--takeover", "/repo").is_err());
        let mut offline = world();
        offline.herdr_connected = false;
        assert!(validate_target(&offline, "w1:p1", "/repo").is_err());
        assert!(validate_target(&world(), "w1:p1", "/repo/").is_err());
    }

    #[test]
    fn validates_frames_before_forwarding_any_partial_state() {
        let mut frames = FrameValidator::default();
        let frame = json!({"type":"terminal.frame","seq":1,"encoding":"ansi","width":80,"height":24,"full":true,"bytes":"aGk="});
        assert!(frames.accept(&frame).is_ok());
        let mut skipped = frame.clone();
        skipped["seq"] = json!(3);
        skipped["full"] = json!(false);
        assert!(frames.accept(&skipped).is_err());
        let mut initial_diff = frame.clone();
        initial_diff["full"] = json!(false);
        assert!(FrameValidator::default().accept(&initial_diff).is_err());
        let mut invalid_bytes = frame;
        invalid_bytes["bytes"] = json!("not base64!");
        assert!(FrameValidator::default().accept(&invalid_bytes).is_err());
    }

    #[test]
    fn preserves_page_key_vs_wheel_scroll_source_and_rejects_unknown_modes() {
        assert_eq!(
            scroll_command("up", 24, "page_key").unwrap(),
            json!({"type":"terminal.scroll","direction":"up","lines":24,"source":"page_key"})
        );
        assert_eq!(
            scroll_command("down", 3, "wheel").unwrap()["source"],
            "wheel"
        );
        assert!(scroll_command("up", 24, "guessed_mouse").is_err());
    }

    #[test]
    fn cumulative_render_acks_release_bytes_and_idle_heartbeats_do_not_hide_stalled_frames() {
        let mut window = RenderWindow::default();
        let now = Instant::now();
        assert!(window.acknowledge(9, now).is_err());
        window.reserve(9, MAX_UNACKED_BYTES / 2, now).unwrap();
        window.reserve(10, MAX_UNACKED_BYTES / 2, now).unwrap();
        assert!(window.reserve(11, 1, now).is_err());
        assert_eq!(window.pending.len(), 2);
        assert_eq!(window.last_sent, Some(10));
        assert!(window.acknowledge(8, now).is_err());
        assert!(window.acknowledge(11, now).is_err());
        window.acknowledge(9, now).unwrap();
        assert_eq!(window.pending_bytes, MAX_UNACKED_BYTES / 2);
        window.acknowledge(10, now).unwrap();
        assert_eq!(window.pending_bytes, 0);
        assert!(window.expired(now + RENDER_ACK_TIMEOUT));
        window
            .acknowledge(10, now + Duration::from_secs(14))
            .unwrap();
        assert!(!window.expired(now + Duration::from_secs(16)));
        window
            .reserve(11, 100, now + Duration::from_secs(16))
            .unwrap();
        window
            .acknowledge(10, now + Duration::from_secs(30))
            .unwrap();
        assert!(window.expired(now + Duration::from_secs(31)));
        assert!(window
            .acknowledge(9, now + Duration::from_secs(31))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn stalled_renderer_and_missing_idle_heartbeat_reap_the_helper() {
        for acknowledged in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let cli = fake_cli(dir.path(), "print(json.dumps({'type':'terminal.frame','seq':9,'encoding':'ansi','width':80,'height':24,'full':True,'bytes':'aA=='}),flush=True)\ntime.sleep(60)");
            let state = TerminalTransportState::default();
            let (tx, rx) = mpsc::channel();
            let id = state
                .start(
                    &cli,
                    Path::new("/tmp/test.sock"),
                    "w1:p1",
                    "/repo",
                    80,
                    24,
                    Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
                )
                .unwrap();
            let owned = state.inner.leases.lock().unwrap().get(&id).unwrap().clone();
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(3)).unwrap()["type"],
                "terminal.frame"
            );
            assert!(state
                .acknowledge(&world(), &id, "w1:p1", "/wrong", 9)
                .is_err());
            if acknowledged {
                state
                    .acknowledge(&world(), &id, "w1:p1", "/repo", 9)
                    .unwrap();
            }
            // Move only the transport deadline instead of sleeping for 15 seconds.
            {
                let mut window = owned.render.lock().unwrap();
                let expired = Instant::now() - RENDER_ACK_TIMEOUT - Duration::from_secs(1);
                if acknowledged {
                    window.last_ack_at = expired;
                } else {
                    window.pending.front_mut().unwrap().2 = expired;
                }
            }
            let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_eq!(event["type"], "terminal.error");
            assert!(event["message"].as_str().unwrap().contains("acknowledging"));
            assert!(owned.wait_done(Duration::from_secs(3)));
            assert!(state
                .queue(
                    &world(),
                    &id,
                    "w1:p1",
                    "/repo",
                    input_command("late").unwrap()
                )
                .is_err());
        }
    }

    #[test]
    fn caps_geometry_input_and_scroll_commands() {
        assert!(validate_dimensions(80, 24).is_ok());
        assert!(validate_dimensions(0, 24).is_err());
        assert!(validate_dimensions(501, 24).is_err());
        assert!(input_command(&"x".repeat(65_537)).is_err());
        assert!(scroll_command("up", 0, "wheel").is_err());
        assert!(scroll_command("--takeover", 1, "wheel").is_err());
        assert_eq!(
            scroll_command("down", 3, "wheel").unwrap(),
            json!({"type":"terminal.scroll","direction":"down","lines":3,"source":"wheel"})
        );
    }

    #[test]
    fn bounds_records_and_diagnostics_without_accepting_truncated_json() {
        let mut oversized = std::io::Cursor::new(vec![b'x'; MAX_RECORD_BYTES + 1]);
        assert!(read_bounded_line(&mut oversized)
            .unwrap_err()
            .contains("size limit"));
        let mut truncated = std::io::Cursor::new(b"{\"type\":\"terminal.frame\"}");
        assert!(read_bounded_line(&mut truncated)
            .unwrap_err()
            .contains("within a record"));
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        read_diagnostics(
            std::io::Cursor::new(vec![b'x'; MAX_STDERR_BYTES * 3]),
            diagnostics.clone(),
        );
        assert_eq!(diagnostics.lock().unwrap().len(), MAX_STDERR_BYTES);
    }

    #[test]
    fn closes_on_stale_world_or_input_backpressure_without_retargeting() {
        fn pending_lease(state: &TerminalTransportState) -> (Arc<Lease>, mpsc::Receiver<Vec<u8>>) {
            let (writer, receiver) = mpsc::sync_channel(1);
            let lease = Arc::new(Lease {
                pane_id: "w1:p1".into(),
                root: "/repo".into(),
                cwd: "/repo".into(),
                writer,
                closing: AtomicBool::new(false),
                received_frame: AtomicBool::new(false),
                remote_closed: AtomicBool::new(false),
                stdout_done: AtomicBool::new(false),
                failure: Mutex::new(None),
                render: Mutex::new(RenderWindow::default()),
                done: (Mutex::new(true), Condvar::new()),
            });
            state
                .inner
                .leases
                .lock()
                .unwrap()
                .insert("test".into(), lease.clone());
            (lease, receiver)
        }
        let state = TerminalTransportState::default();
        let (lease, receiver) = pending_lease(&state);
        assert!(state
            .queue(
                &world(),
                "test",
                "w1:p2",
                "/repo",
                input_command("wrong").unwrap()
            )
            .is_err());
        assert!(receiver.try_recv().is_err());
        let mut stale = world();
        stale.islands[0].root = "/different".into();
        assert!(state
            .queue(
                &stale,
                "test",
                "w1:p1",
                "/repo",
                input_command("stale").unwrap()
            )
            .is_err());
        assert!(lease.closing.load(Ordering::Acquire));
        assert!(receiver.try_recv().is_err());

        let (lease, receiver) = pending_lease(&state);
        let mut moved = world();
        moved.islands[0].agents[0].cwd = "/repo/other-worktree".into();
        assert!(state
            .queue(
                &moved,
                "test",
                "w1:p1",
                "/repo",
                input_command("moved").unwrap()
            )
            .is_err());
        assert!(lease.closing.load(Ordering::Acquire));
        assert!(receiver.try_recv().is_err());

        let (lease, receiver) = pending_lease(&state);
        state
            .queue(
                &world(),
                "test",
                "w1:p1",
                "/repo",
                input_command("first").unwrap(),
            )
            .unwrap();
        assert!(state
            .queue(
                &world(),
                "test",
                "w1:p1",
                "/repo",
                input_command("second").unwrap()
            )
            .unwrap_err()
            .contains("queue is full"));
        assert!(lease.closing.load(Ordering::Acquire));
        assert!(String::from_utf8(receiver.recv().unwrap())
            .unwrap()
            .contains("first"));
        assert!(receiver.try_recv().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn malformed_stream_is_not_forwarded_and_reaps_the_helper() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(dir.path(), "print('{broken',flush=True)\ntime.sleep(60)");
        let state = TerminalTransportState::default();
        let (tx, rx) = mpsc::channel();
        let lease = state
            .start(
                &cli,
                Path::new("/tmp/test.sock"),
                "w1:p1",
                "/repo",
                80,
                24,
                Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
            )
            .unwrap();
        let owned = state
            .inner
            .leases
            .lock()
            .unwrap()
            .get(&lease)
            .unwrap()
            .clone();
        let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(event["type"], "terminal.error");
        assert!(event["message"]
            .as_str()
            .unwrap()
            .contains("invalid Herdr terminal record"));
        assert!(owned.wait_done(Duration::from_secs(3)));
        assert!(rx.try_recv().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn stdout_eof_without_a_closed_record_releases_a_running_helper() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(dir.path(), "print(json.dumps({'type':'terminal.frame','seq':9,'encoding':'ansi','width':80,'height':24,'full':True,'bytes':'aA=='}),flush=True)\nos.close(1)\ntime.sleep(60)");
        let state = TerminalTransportState::default();
        let (tx, rx) = mpsc::channel();
        let lease = state
            .start(
                &cli,
                Path::new("/tmp/test.sock"),
                "w1:p1",
                "/repo",
                80,
                24,
                Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
            )
            .unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap()["type"],
            "terminal.frame"
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap()["type"],
            "terminal.closed"
        );
        state.detach(&lease).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pipes_exact_argv_env_input_resize_scroll_and_release_to_owned_process() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(
            dir.path(),
            r#"
base=os.path.dirname(__file__)
with open(base+'/startup.json','w') as f: json.dump({'argv':sys.argv[1:],'socket':os.environ.get('HERDR_SOCKET_PATH')},f)
print(json.dumps({'type':'terminal.frame','seq':1,'encoding':'ansi','width':80,'height':24,'full':True,'bytes':'aGk='}),flush=True)
with open(base+'/commands.jsonl','w') as log:
 for line in sys.stdin:
  log.write(line); log.flush()
  if json.loads(line)['type']=='terminal.release':
   print(json.dumps({'type':'terminal.closed','reason':'detached'}),flush=True)
   break
"#,
        );
        let state = TerminalTransportState::default();
        let (tx, rx) = mpsc::channel();
        let lease = state
            .start(
                &cli,
                Path::new("/tmp/chosen.sock"),
                "w1:p1",
                "/repo",
                80,
                24,
                Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
            )
            .unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap()["type"],
            "terminal.frame"
        );
        let startup: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("startup.json")).unwrap())
                .unwrap();
        assert_eq!(
            startup["argv"],
            json!(["terminal", "session", "control", "w1:p1", "--cols", "80", "--rows", "24"])
        );
        assert_eq!(startup["socket"], "/tmp/chosen.sock");
        assert!(state
            .queue(
                &world(),
                &lease,
                "w1:p1",
                "/elsewhere",
                input_command("wrong").unwrap()
            )
            .is_err());
        state
            .queue(
                &world(),
                &lease,
                "w1:p1",
                "/repo",
                input_command("hello\n").unwrap(),
            )
            .unwrap();
        state
            .queue(
                &world(),
                &lease,
                "w1:p1",
                "/repo",
                json!({"type":"terminal.resize","cols":90,"rows":25}),
            )
            .unwrap();
        state
            .queue(
                &world(),
                &lease,
                "w1:p1",
                "/repo",
                scroll_command("up", 3, "wheel").unwrap(),
            )
            .unwrap();
        // A successful enqueue is not a child acknowledgment. Detach intentionally
        // discards pending writes; wait for the fake to record them before testing release.
        let deadline = Instant::now() + Duration::from_secs(3);
        while std::fs::read_to_string(dir.path().join("commands.jsonl"))
            .unwrap_or_default()
            .lines()
            .count()
            < 3
        {
            assert!(
                Instant::now() < deadline,
                "fake CLI did not receive queued commands"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        state.detach(&lease).unwrap();
        let commands: Vec<Value> = std::fs::read_to_string(dir.path().join("commands.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            commands,
            vec![
                json!({"type":"terminal.input","text":"hello\n"}),
                json!({"type":"terminal.resize","cols":90,"rows":25}),
                json!({"type":"terminal.scroll","direction":"up","lines":3,"source":"wheel"}),
                json!({"type":"terminal.release"})
            ]
        );
        assert!(state
            .queue(
                &world(),
                &lease,
                "w1:p1",
                "/repo",
                input_command("late").unwrap()
            )
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn forwards_cli_rejection_and_cleans_up_after_eof() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(
            dir.path(),
            "print('already has an attached client',file=sys.stderr,flush=True)\nsys.exit(1)",
        );
        let state = TerminalTransportState::default();
        let (tx, rx) = mpsc::channel();
        let lease = state
            .start(
                &cli,
                Path::new("/tmp/test.sock"),
                "w1:p1",
                "/repo",
                80,
                24,
                Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
            )
            .unwrap();
        let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(event["type"], "terminal.error");
        assert!(event["message"]
            .as_str()
            .unwrap()
            .contains("already has an attached client"));
        state.detach(&lease).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn large_frame_byte_budget_is_reserved_before_delivery() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(dir.path(), "for seq in range(1,3):\n print(json.dumps({'type':'terminal.frame','seq':seq,'encoding':'ansi','width':80,'height':24,'full':seq==1,'bytes':'YWFh'*600000}),flush=True)\ntime.sleep(60)");
        let state = TerminalTransportState::default();
        let (tx, rx) = mpsc::channel();
        let id = state
            .start(
                &cli,
                Path::new("/tmp/test.sock"),
                "w1:p1",
                "/repo",
                80,
                24,
                Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
            )
            .unwrap();
        let owned = state.inner.leases.lock().unwrap().get(&id).unwrap().clone();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap()["type"],
            "terminal.frame"
        );
        let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(event["type"], "terminal.error");
        assert!(event["message"]
            .as_str()
            .unwrap()
            .contains("unacknowledged"));
        assert!(owned.wait_done(Duration::from_secs(3)));
        assert!(rx.try_recv().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn bounds_unacknowledged_frames_before_sending_them_to_a_stalled_view() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(dir.path(), "for seq in range(1,1000):\n print(json.dumps({'type':'terminal.frame','seq':seq,'encoding':'ansi','width':80,'height':24,'full':seq==1,'bytes':'aA=='}),flush=True)\ntime.sleep(60)");
        let state = TerminalTransportState::default();
        let (tx, rx) = mpsc::channel();
        let id = state
            .start(
                &cli,
                Path::new("/tmp/test.sock"),
                "w1:p1",
                "/repo",
                80,
                24,
                Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
            )
            .unwrap();
        let owned = state.inner.leases.lock().unwrap().get(&id).unwrap().clone();
        for _ in 0..128 {
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(3)).unwrap()["type"],
                "terminal.frame"
            );
        }
        let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(event["type"], "terminal.error");
        assert!(event["message"]
            .as_str()
            .unwrap()
            .contains("unacknowledged"));
        assert!(owned.wait_done(Duration::from_secs(3)));
        assert!(rx.try_recv().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn channel_failure_and_state_drop_reap_the_child() {
        let dir = tempfile::tempdir().unwrap();
        let cli=fake_cli(dir.path(),"print(json.dumps({'type':'terminal.frame','seq':1,'encoding':'ansi','width':80,'height':24,'full':True,'bytes':'aA=='}),flush=True)\ntime.sleep(60)");
        let state = TerminalTransportState::default();
        let lease = state
            .start(
                &cli,
                Path::new("/tmp/test.sock"),
                "w1:p1",
                "/repo",
                80,
                24,
                Arc::new(|_| Err("view gone".into())),
            )
            .unwrap();
        let owned = state
            .inner
            .leases
            .lock()
            .unwrap()
            .get(&lease)
            .unwrap()
            .clone();
        assert!(owned.wait_done(Duration::from_secs(3)));
        let lease2 = state
            .start(
                &cli,
                Path::new("/tmp/test.sock"),
                "w1:p1",
                "/repo",
                80,
                24,
                Arc::new(|_| Ok(())),
            )
            .unwrap();
        let owned2 = state
            .inner
            .leases
            .lock()
            .unwrap()
            .get(&lease2)
            .unwrap()
            .clone();
        drop(state);
        assert!(owned2.wait_done(Duration::from_secs(3)));
    }
}
