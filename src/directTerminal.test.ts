import { describe, expect, it, vi, beforeEach } from "vitest";
import { connectDirectTerminal, type DirectTerminalEvent } from "./directTerminal";

const { invokeMock, channels } = vi.hoisted(() => ({ invokeMock: vi.fn(), channels: [] as { onmessage: (event: DirectTerminalEvent) => void }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class { onmessage = (_event: DirectTerminalEvent) => {}; constructor() { channels.push(this); } },
}));

function fixture(paneId = "w1:p1") {
  const applied: string[] = [];
  const callbacks: (() => void)[] = [];
  let active = true;
  const state = vi.fn();
  const terminal = {
    resize: (cols: number, rows: number) => applied.push(`resize ${cols} ${rows}`),
    write: (bytes: Uint8Array, callback: () => void) => { applied.push(new TextDecoder().decode(bytes)); callbacks.push(callback); },
  };
  const connection = connectDirectTerminal({ paneId, root: "/repo", size: { cols: 80, rows: 24 }, terminal,
    onState: state, isInputActive: () => active });
  const event = (payload: DirectTerminalEvent) => channels[channels.length - 1].onmessage(payload);
  const frame = (seq: number, text: string, full = false, width = 80, height = 24) => event({ type: "terminal.frame", seq, bytes: btoa(text), full, width, height, encoding: "ansi" });
  return { connection, event, frame, applied, callbacks, state, setActive: (value: boolean) => { active = value; } };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
beforeEach(() => { channels.length = 0; invokeMock.mockReset(); invokeMock.mockImplementation((command: string) => Promise.resolve(command === "terminal_attach" ? "lease-1" : undefined)); });

describe("direct terminal lifecycle", () => {
  it("requires a full baseline, applies ordered diffs after resize, and never resets the emulator", async () => {
    const f = fixture();
    f.frame(10, "\x1b[2Jhello", true);
    f.frame(11, "\x1b[1;1Hworld");
    f.frame(12, "\x1b[1;1Hsmall", true, 60, 20);
    await flush();
    expect(f.applied).toEqual(["resize 80 24", "\x1b[2Jhello"]);
    expect(f.state).not.toHaveBeenCalledWith({ status: "ready" });
    f.callbacks.shift()!();
    expect(f.applied).toEqual(["resize 80 24", "\x1b[2Jhello", "resize 80 24", "\x1b[1;1Hworld"]);
    f.callbacks.shift()!();
    expect(f.applied.slice(-2)).toEqual(["resize 60 20", "\x1b[1;1Hsmall"]);
    f.callbacks.shift()!();
    expect(f.state).toHaveBeenCalledWith({ status: "ready" });
    f.connection.close();
    expect(invokeMock).toHaveBeenCalledWith("terminal_detach", { leaseId: "lease-1" });
  });

  it.each(["gap", "diff baseline", "invalid bytes", "oversized geometry"])("releases on %s instead of guessing terminal state", async problem => {
    const f = fixture();
    if (problem === "gap") { f.frame(1, "first", true); f.callbacks.shift()!(); f.frame(3, "lost"); }
    if (problem === "diff baseline") f.frame(1, "partial");
    if (problem === "invalid bytes") f.event({ type: "terminal.frame", seq: 1, bytes: "@@@", full: true, width: 80, height: 24, encoding: "ansi" });
    if (problem === "oversized geometry") f.frame(1, "big", true, 501, 24);
    await flush();
    expect(f.state).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
    f.connection.send("must not send");
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("terminal_detach", { leaseId: "lease-1" });
  });

  it("releases an attach result that arrives after close without replaying input", async () => {
    let resolve!: (lease: string) => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_attach" ? new Promise(done => { resolve = done; }) : Promise.resolve());
    const f = fixture();
    f.connection.send("before ready");
    f.connection.close();
    resolve("late-lease");
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("terminal_detach", { leaseId: "late-lease" });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toEqual([]);
  });

  it("waits for a retiring pane's native detach before attaching its replacement", async () => {
    let release!: () => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_detach" ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve(cmd === "terminal_attach" ? "lease-1" : undefined));
    const old = fixture(); await flush(); old.connection.close();
    const replacement = fixture();
    replacement.connection.send("must not replay while waiting");
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(1);
    release(); await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toHaveLength(0);
    replacement.connection.close(); release(); await flush();
  });

  it("waits for a late attach and its detach when the old view closed before receiving its lease", async () => {
    let attach!: (lease: string) => void;
    let detach!: () => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_attach" ? new Promise<string>(resolve => { attach = resolve; }) : cmd === "terminal_detach" ? new Promise<void>(resolve => { detach = resolve; }) : Promise.resolve());
    const old = fixture(); old.connection.close();
    const replacement = fixture(); await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(1);
    attach("old-lease"); await flush();
    expect(invokeMock).toHaveBeenCalledWith("terminal_detach", { leaseId: "old-lease" });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(1);
    detach(); await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(2);
    attach("new-lease"); await flush(); replacement.connection.close(); detach(); await flush();
  });

  it("skips a replacement closed while waiting and preserves the release barrier for the next view", async () => {
    let release!: () => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_detach" ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve(cmd === "terminal_attach" ? "lease-1" : undefined));
    const old = fixture(); await flush(); old.connection.close();
    const discarded = fixture(); discarded.connection.close();
    const current = fixture(); await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(1);
    release(); await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(2);
    expect(discarded.state).not.toHaveBeenCalledWith({ status: "ready" });
    current.connection.close(); release(); await flush();
  });

  it("surfaces a failed release without automatically attaching, and clears the barrier for an explicit later retry", async () => {
    let reject!: (reason: Error) => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_detach" ? new Promise<void>((_, fail) => { reject = fail; }) : Promise.resolve(cmd === "terminal_attach" ? "lease-1" : undefined));
    const old = fixture(); await flush(); old.connection.close();
    const replacement = fixture(); await flush();
    reject(new Error("native release failed")); await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(1);
    expect(replacement.state).toHaveBeenLastCalledWith({ status: "error", message: expect.stringContaining("native release failed") });
    invokeMock.mockImplementation((cmd: string) => Promise.resolve(cmd === "terminal_attach" ? "retry-lease" : undefined));
    const retry = fixture(); await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(2);
    retry.connection.close(); await flush();
  });

  it("does not hold another pane behind an unrelated native release", async () => {
    let release!: () => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_detach" ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve(cmd === "terminal_attach" ? "lease-1" : undefined));
    const old = fixture(); await flush(); old.connection.close();
    const other = fixture("w2:p1"); await flush();
    expect(invokeMock).toHaveBeenCalledWith("terminal_attach", expect.objectContaining({ paneId: "w2:p1" }));
    release(); await flush(); other.connection.close(); release(); await flush();
  });

  it("unblocks the replacement when an old pending attach rejects without acquiring a lease", async () => {
    let reject!: (reason: Error) => void;
    invokeMock.mockImplementationOnce(() => new Promise<string>((_, fail) => { reject = fail; }));
    const old = fixture(); old.connection.close();
    const replacement = fixture();
    reject(new Error("pane not available")); await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_detach")).toHaveLength(0);
    replacement.connection.close(); await flush();
  });

  it("propagates a release failure through a discarded waiting view", async () => {
    let reject!: (reason: Error) => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_detach" ? new Promise<void>((_, fail) => { reject = fail; }) : Promise.resolve(cmd === "terminal_attach" ? "lease-1" : undefined));
    const old = fixture(); await flush(); old.connection.close();
    const discarded = fixture(); discarded.connection.close();
    const replacement = fixture();
    reject(new Error("release failed")); await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(1);
    expect(replacement.state).toHaveBeenLastCalledWith({ status: "error", message: expect.stringContaining("release failed") });
    await flush();
  });

  it("serializes input and scroll with validated identity while refusing inactive input", async () => {
    const f = fixture();
    f.frame(1, "baseline", true);
    f.callbacks.shift()!();
    await flush();
    f.setActive(false);
    f.connection.send("inactive");
    f.connection.scroll("up", 4);
    f.setActive(true);
    let finish!: () => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_write" ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve());
    f.connection.send("first");
    f.connection.send("second");
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toEqual([["terminal_write", { leaseId: "lease-1", paneId: "w1:p1", expectedRoot: "/repo", text: "first" }]]);
    finish();
    await flush();
    const writes = invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write");
    expect(writes[writes.length - 1][1].text).toBe("second");
    finish();
    f.connection.scroll("down", 500);
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("terminal_scroll", { leaseId: "lease-1", paneId: "w1:p1", expectedRoot: "/repo", direction: "down", lines: 200, source: "wheel" });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_scroll")).toHaveLength(1);
    f.connection.close();
  });

  it("surfaces control conflicts and write failures without retrying or retaining control", async () => {
    invokeMock.mockRejectedValueOnce(new Error("another controller owns this terminal"));
    const conflict = fixture();
    await flush();
    expect(conflict.state).toHaveBeenLastCalledWith({ status: "error", message: expect.stringContaining("another controller") });
    const f = fixture();
    f.frame(1, "baseline", true); f.callbacks.shift()!(); await flush();
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_write" ? Promise.reject(new Error("pane root changed")) : Promise.resolve());
    f.connection.send("first"); f.connection.send("do not replay");
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toHaveLength(1);
    expect(f.state).toHaveBeenLastCalledWith({ status: "error", message: expect.stringContaining("pane root changed") });
    expect(invokeMock).toHaveBeenCalledWith("terminal_detach", { leaseId: "lease-1" });
  });

  it("releases on stream closure and rejects zero-size resizes", async () => {
    const f = fixture();
    f.frame(1, "baseline", true); f.callbacks.shift()!(); await flush();
    f.connection.resize({ cols: 0, rows: 0 });
    f.connection.resize({ cols: 90, rows: 30 });
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_resize")).toEqual([["terminal_resize", { leaseId: "lease-1", paneId: "w1:p1", expectedRoot: "/repo", cols: 90, rows: 30 }]]);
    f.event({ type: "terminal.closed", reason: "pane exited" });
    await flush();
    expect(f.state).toHaveBeenLastCalledWith({ status: "error", message: expect.stringContaining("pane exited") });
    expect(invokeMock).toHaveBeenCalledWith("terminal_detach", { leaseId: "lease-1" });
  });

  it("fails closed if the renderer falls behind a bounded frame queue", async () => {
    const f = fixture();
    f.frame(1, "first", true);
    for (let seq = 2; seq <= 132; seq++) f.frame(seq, "");
    await flush();
    expect(f.state).toHaveBeenLastCalledWith({ status: "error", message: expect.stringContaining("render queue") });
    expect(f.applied).toEqual(["resize 80 24", "first"]);
    expect(invokeMock).toHaveBeenCalledWith("terminal_detach", { leaseId: "lease-1" });
  });

  it("acknowledges each frame only after the renderer finishes parsing it", async () => {
    const f = fixture();
    f.frame(10, "baseline", true);
    f.frame(11, "diff");
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_ack")).toEqual([]);
    f.callbacks.shift()!();
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_ack")).toEqual([["terminal_ack", { leaseId: "lease-1", paneId: "w1:p1", expectedRoot: "/repo", seq: 10 }]]);
    f.callbacks.shift()!();
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_ack")[1]).toEqual(["terminal_ack", { leaseId: "lease-1", paneId: "w1:p1", expectedRoot: "/repo", seq: 11 }]);
    f.connection.close();
  });

  it("holds parsed frame acknowledgments until a late attachment lease arrives", async () => {
    let resolve!: (lease: string) => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_attach" ? new Promise(done => { resolve = done; }) : Promise.resolve());
    const f = fixture();
    f.frame(1, "baseline", true); f.callbacks.shift()!();
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_ack")).toEqual([]);
    resolve("late-lease");
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("terminal_ack", { leaseId: "late-lease", paneId: "w1:p1", expectedRoot: "/repo", seq: 1 });
    f.connection.close();
  });

  it("stops input and releases without replay when frame acknowledgment fails", async () => {
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_ack" ? Promise.reject(new Error("attachment expired")) : Promise.resolve(cmd === "terminal_attach" ? "lease-1" : undefined));
    const f = fixture();
    f.frame(1, "baseline", true); f.callbacks.shift()!();
    await flush();
    f.connection.send("do not send");
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toEqual([]);
    expect(f.state).toHaveBeenLastCalledWith({ status: "error", message: expect.stringContaining("attachment expired") });
    expect(invokeMock).toHaveBeenCalledWith("terminal_detach", { leaseId: "lease-1" });
  });

  it("keeps a quiet rendered lease alive and stops heartbeats on close", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.frame(8, "quiet baseline", true); f.callbacks.shift()!(); await flush();
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_ack")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_ack")).toEqual([
        ["terminal_ack", { leaseId: "lease-1", paneId: "w1:p1", expectedRoot: "/repo", seq: 8 }],
        ["terminal_ack", { leaseId: "lease-1", paneId: "w1:p1", expectedRoot: "/repo", seq: 8 }],
      ]);
      f.connection.close();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_ack")).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it.each(["scroll", "resize"])("bounds zero-byte %s commands behind a stalled write and discards them on overflow", async kind => {
    const f = fixture();
    f.frame(1, "baseline", true); f.callbacks.shift()!(); await flush();
    let finish!: () => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_write" ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve());
    f.connection.send("held");
    await flush();
    const enqueue = (index: number) => kind === "scroll" ? f.connection.scroll("up", 1, "page_key") : f.connection.resize({ cols: 90 + index, rows: 24 });
    for (let index = 0; index < 63; index++) enqueue(index);
    expect(f.state).toHaveBeenLastCalledWith({ status: "ready" });
    enqueue(63);
    expect(f.state).toHaveBeenLastCalledWith({ status: "error", message: expect.stringContaining("pending command limit") });
    expect(invokeMock).toHaveBeenCalledWith("terminal_detach", { leaseId: "lease-1" });
    finish();
    // Let the bounded, abandoned promise chain drain after the held IPC.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_scroll" || cmd === "terminal_resize")).toHaveLength(0);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toHaveLength(1);
  });

  it("coalesces queued wheel distance behind slow IPC without dropping the connection", async () => {
    const f = fixture();
    f.frame(1, "baseline", true); f.callbacks.shift()!(); await flush();
    let finish!: () => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "terminal_write" ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve());
    f.connection.send("held"); await flush();
    for (let index = 0; index < 100; index++) f.connection.scroll("up", 1);
    f.connection.scroll("down", 25);
    expect(f.state).toHaveBeenLastCalledWith({ status: "ready" });
    finish(); await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_scroll")).toEqual([["terminal_scroll", expect.objectContaining({ direction: "up", lines: 75, source: "wheel" })]]);
    f.connection.close();
  });
});
