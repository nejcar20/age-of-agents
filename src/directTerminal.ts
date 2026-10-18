import { Channel, invoke } from "@tauri-apps/api/core";

export type TerminalSize = { cols: number; rows: number };
export type DirectTerminalEvent =
  | { type: "terminal.frame"; seq: number; encoding: "ansi"; width: number; height: number; full: boolean; bytes: string }
  | { type: "terminal.closed"; reason: string }
  | { type: "terminal.error"; message: string };
export type DirectTerminalState = { status: "connecting" | "ready" } | { status: "error"; message: string };
type Renderer = { resize(cols: number, rows: number): void; write(bytes: Uint8Array, callback: () => void): void };

// A dock promotion can remount a pane before its old helper has finished
// releasing control. Only retiring views participate; live conflicts
// remain the native transport's responsibility.
const pendingReleases = new Map<string, Promise<void>>();

export function validTerminalSize(size: TerminalSize): boolean {
  return Number.isInteger(size.cols) && Number.isInteger(size.rows) && size.cols > 0 && size.rows > 0 && size.cols <= 500 && size.rows <= 200;
}

/** One lease and one ordered render baseline. This accepts only Herdr's
 * ANSI frame transport, never snapshots or original PTY history. */
export function connectDirectTerminal({ paneId, root, size, terminal, onState, isInputActive }: {
  paneId: string;
  root: string;
  size: TerminalSize;
  terminal: Renderer;
  onState: (state: DirectTerminalState) => void;
  isInputActive: () => boolean;
}) {
  let stopped = false;
  let leaseId: string | null = null;
  let attachment: Promise<string | null> | null = null;
  const previousRelease = pendingReleases.get(paneId);
  let lastSeq: number | null = null;
  let baselineApplied = false;
  let reportedReady = false;
  let writing = false;
  let pendingBytes = 0;
  let inputBytes = 0;
  let pendingCommands = 0;
  let commands = Promise.resolve();
  let pendingWheel: { direction: "up" | "down"; lines: number; source: "wheel" } | null = null;
  let currentSize = size;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let ackInFlight = false;
  let lastRenderedSeq: number | null = null;
  const parsedAcks: number[] = [];
  const frames: { seq: number; size: TerminalSize; bytes: Uint8Array }[] = [];
  const MAX_PENDING_BYTES = 8 * 1024 * 1024;
  const MAX_INPUT_BYTES = 64 * 1024;
  const MAX_PENDING_COMMANDS = 64;

  const release = () => {
    const releasing = leaseId;
    leaseId = null;
    const complete = releasing ? invoke<void>("terminal_detach", { leaseId: releasing }) : (async () => {
      // A view closed while waiting must carry the preceding barrier,
      // including failure, forward to any subsequent replacement.
      if (previousRelease) await previousRelease;
      let pendingLease: string | null;
      try { pendingLease = attachment ? await attachment : null; }
      catch { return; } // An unsuccessful attach acquired no lease.
      if (pendingLease) await invoke<void>("terminal_detach", { leaseId: pendingLease });
    })();
    pendingReleases.set(paneId, complete);
    const clear = () => { if (pendingReleases.get(paneId) === complete) pendingReleases.delete(paneId); };
    // Keep the rejected barrier available to an already-waiting view,
    // while handling it even when the closed view has no replacement.
    void complete.then(clear, clear);
  };
  const close = () => {
    if (stopped) return;
    stopped = true;
    frames.length = 0;
    parsedAcks.length = 0;
    pendingWheel = null;
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    release();
  };
  const fail = (reason: unknown) => {
    if (stopped) return;
    close();
    onState({ status: "error", message: String(reason) });
  };
  const ready = () => !stopped && leaseId !== null && baselineApplied;
  const reportReady = () => {
    if (ready() && !reportedReady) {
      reportedReady = true;
      onState({ status: "ready" });
    }
  };

  const drainAcks = () => {
    if (stopped || !leaseId || ackInFlight || !parsedAcks.length) return;
    const seq = parsedAcks.shift()!;
    ackInFlight = true;
    // This acknowledges rendered bytes, never user input or agent work.
    // Native bounds its emitted-but-unacknowledged IPC payloads with it.
    void invoke("terminal_ack", { leaseId, paneId, expectedRoot: root, seq }).then(() => {
      ackInFlight = false;
      drainAcks();
    }).catch(fail);
  };

  const drainFrames = () => {
    if (stopped || writing || !frames.length) return;
    const frame = frames.shift()!;
    writing = true;
    try {
      // A queued diff is interpreted only after the previous write parsed.
      // A later full redraw is still ANSI output, not a reset instruction.
      terminal.resize(frame.size.cols, frame.size.rows);
      terminal.write(frame.bytes, () => {
        if (stopped) return;
        writing = false;
        pendingBytes -= frame.bytes.byteLength;
        baselineApplied = true;
        lastRenderedSeq = frame.seq;
        if (parsedAcks.length >= 128) { fail("Terminal frame acknowledgments exceeded the render queue."); return; }
        parsedAcks.push(frame.seq);
        drainAcks();
        reportReady();
        drainFrames();
      });
    } catch (reason) { fail(reason); }
  };

  const channel = new Channel<DirectTerminalEvent>();
  channel.onmessage = event => {
    if (stopped) return;
    if (event.type === "terminal.closed") { fail(`Direct control ended: ${event.reason}`); return; }
    if (event.type === "terminal.error") { fail(event.message); return; }
    try {
      if (event.type !== "terminal.frame" || event.encoding !== "ansi") throw new Error("Unsupported terminal frame.");
      if (!Number.isSafeInteger(event.seq) || event.seq < 1 || (lastSeq === null ? !event.full : event.seq !== lastSeq + 1)) {
        throw new Error("Terminal frame sequence was interrupted. Return to mirror and connect again for a fresh screen.");
      }
      const dimensions = { cols: event.width, rows: event.height };
      if (!validTerminalSize(dimensions)) throw new Error("Invalid terminal frame dimensions.");
      if (typeof event.bytes !== "string" || event.bytes.length > MAX_PENDING_BYTES || event.bytes.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.bytes)) {
        throw new Error("Invalid terminal frame bytes.");
      }
      const bytes = Uint8Array.from(atob(event.bytes), char => char.charCodeAt(0));
      if (pendingBytes + bytes.byteLength > MAX_PENDING_BYTES || frames.length >= 128) throw new Error("Terminal output exceeded the render queue. Connect again for a fresh screen.");
      lastSeq = event.seq;
      pendingBytes += bytes.byteLength;
      frames.push({ seq: event.seq, size: dimensions, bytes });
      drainFrames();
    } catch (reason) { fail(reason); }
  };

  onState({ status: "connecting" });
  if (!validTerminalSize(size)) fail("Cannot attach with invalid terminal dimensions.");
  else {
    const attach = () => stopped ? Promise.resolve(null) : invoke<string>("terminal_attach", { paneId, expectedRoot: root, ...size, onEvent: channel });
    attachment = previousRelease ? previousRelease.then(attach, reason => {
      throw new Error(`Previous terminal control could not be released: ${String(reason)}`);
    }) : attach();
    void attachment.then(id => {
      if (stopped || id === null) return;
      leaseId = id;
      drainAcks(); reportReady();
    }).catch(fail);
  }

  // A quiet but mounted renderer keeps its lease alive. Closing/reloading
  // the view stops this, so native expiry can release a lost IPC consumer.
  if (!stopped) heartbeatTimer = setInterval(() => {
    if (lastRenderedSeq !== null && !ackInFlight && parsedAcks.length === 0) {
      parsedAcks.push(lastRenderedSeq);
      drainAcks();
    }
  }, 5000);

  const enqueue = (command: string, payload: Record<string, unknown>, input: boolean, bytes = 0, starting?: () => void) => {
    if (!ready() || (input && !isInputActive())) return;
    if (pendingCommands >= MAX_PENDING_COMMANDS) { fail("Terminal input exceeded the pending command limit. No queued input was replayed."); return; }
    if (inputBytes + bytes > MAX_INPUT_BYTES) { fail("Terminal input exceeded the pending limit. No input was replayed."); return; }
    inputBytes += bytes;
    pendingCommands++;
    commands = commands.then(async () => {
      try {
        starting?.();
        if (!ready() || (input && !isInputActive())) return;
        if (command === "terminal_scroll" && payload.lines === 0) return;
        await invoke(command, { leaseId, paneId, expectedRoot: root, ...payload });
      } finally {
        inputBytes -= bytes;
        pendingCommands--;
      }
    }).catch(fail);
  };

  return {
    close,
    send(text: string) {
      if (!text || !ready() || !isInputActive()) return;
      pendingWheel = null;
      const bytes = new TextEncoder().encode(text).byteLength;
      if (bytes > MAX_INPUT_BYTES) { fail("Input exceeds the 64 KiB terminal limit. Shorten the paste and connect again."); return; }
      enqueue("terminal_write", { text }, true, bytes);
    },
    resize(next: TerminalSize) {
      if (!validTerminalSize(next) || !ready() || (next.cols === currentSize.cols && next.rows === currentSize.rows)) return;
      currentSize = next;
      pendingWheel = null;
      enqueue("terminal_resize", next, false);
    },
    scroll(direction: "up" | "down", lines: number, source: "wheel" | "page_key" = "wheel") {
      if (!Number.isFinite(lines) || lines < 1 || !ready() || !isInputActive()) return;
      const bounded = Math.min(200, Math.floor(lines));
      if (source === "wheel") {
        if (pendingWheel) {
          const distance = (pendingWheel.direction === "up" ? -pendingWheel.lines : pendingWheel.lines) + (direction === "up" ? -bounded : bounded);
          pendingWheel.direction = distance < 0 ? "up" : "down";
          pendingWheel.lines = Math.min(200, Math.abs(distance));
          return;
        }
        const payload = { direction, lines: bounded, source };
        pendingWheel = payload;
        enqueue("terminal_scroll", payload, true, 0, () => { if (pendingWheel === payload) pendingWheel = null; });
      } else {
        pendingWheel = null;
        enqueue("terminal_scroll", { direction, lines: bounded, source }, true);
      }
    },
  };
}

export type DirectTerminalConnection = ReturnType<typeof connectDirectTerminal>;
