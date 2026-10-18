// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectTerminal } from "./DirectTerminal";
import { Terminal } from "./Terminal";
import { TerminalStageProvider } from "../terminalStage";
import type { Agent } from "../world";
import { StrictMode } from "react";
import type { DirectTerminalEvent } from "../directTerminal";

const { invokeMock, emulators, channels, geometry } = vi.hoisted(() => ({
  invokeMock: vi.fn(), emulators: [] as any[], channels: [] as any[], geometry: { cols: 80, rows: 24 },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, Channel: class { onmessage = (_: DirectTerminalEvent) => {}; constructor() { channels.push(this); } } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { proposeDimensions() { return geometry; } } }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  textarea = document.createElement("textarea");
  options: Record<string, unknown>;
  cols = 80; rows = 24;
  data = (_: string) => {};
  key = (_: KeyboardEvent) => true;
  disposed = false;
  selection = "";
  getSelection() { return this.selection; }
  constructor(options: Record<string, unknown>) { this.options = options; emulators.push(this); }
  open(host: HTMLElement) { host.append(this.textarea); }
  loadAddon() {}
  onData(callback: (data: string) => void) { this.data = callback; return { dispose() {} }; }
  attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean) { this.key = callback; }
  attachCustomWheelEventHandler() {}
  write(_bytes: Uint8Array, done: () => void) { done(); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  focus() { this.textarea.focus(); }
  paste(text: string) { this.data(text); }
  blur() { this.textarea.blur(); }
  dispose() { this.disposed = true; this.textarea.remove(); }
} }));

async function ready() {
  await waitFor(() => expect(channels.length).toBeGreaterThan(0));
  await act(async () => {
    channels[channels.length - 1].onmessage({ type: "terminal.frame", seq: 1, encoding: "ansi", width: 80, height: 24, full: true, bytes: btoa("live") });
  });
}
beforeEach(() => {
  emulators.length = 0; channels.length = 0; geometry.cols = 80; geometry.rows = 24;
  invokeMock.mockImplementation((cmd: string) => Promise.resolve(cmd === "terminal_attach" ? "lease-1" : cmd === "pane_read" ? { text: "snapshot only", revision: 0, truncated: false } : undefined));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => { cleanup(); invokeMock.mockReset(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("DirectTerminal", () => {
  it("attaches with explicit geometry, disables local history, and forwards only focused active input", async () => {
    const view = render(<DirectTerminal paneId="w1:p1" root="/repo" active textSize={14} onReadyChange={vi.fn()} />);
    await ready();
    expect(invokeMock).toHaveBeenCalledWith("terminal_attach", expect.objectContaining({ paneId: "w1:p1", expectedRoot: "/repo", cols: 80, rows: 24 }));
    expect(emulators[0].options.scrollback).toBe(0);
    emulators[0].focus();
    await act(async () => { emulators[0].data("hello"); });
    expect(invokeMock).toHaveBeenCalledWith("terminal_write", { leaseId: "lease-1", paneId: "w1:p1", expectedRoot: "/repo", text: "hello" });
    view.rerender(<DirectTerminal paneId="w1:p1" root="/repo" active={false} textSize={14} onReadyChange={vi.fn()} />);
    await act(async () => { emulators[0].data("inactive"); });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toHaveLength(1);
    view.unmount();
    expect(invokeMock).toHaveBeenCalledWith("terminal_detach", { leaseId: "lease-1" });
    expect(emulators[0].disposed).toBe(true);
  });

  it("routes wheel and plain page keys through bounded server scroll commands", async () => {
    render(<DirectTerminal paneId="w1:p1" root="/repo" active textSize={14} onReadyChange={vi.fn()} />);
    await ready();
    emulators[0].focus();
    const el = screen.getByRole("application");
    await act(async () => { fireEvent.wheel(el, { deltaY: -1200 }); });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("terminal_scroll", expect.objectContaining({ direction: "up", lines: 50, source: "wheel" })));
    await act(async () => { expect(emulators[0].key(new KeyboardEvent("keydown", { key: "PageDown" }))).toBe(false); });
    expect(invokeMock).toHaveBeenCalledWith("terminal_scroll", expect.objectContaining({ direction: "down", lines: 23, source: "page_key" }));
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toHaveLength(0);
  });

  it("coalesces a trackpad burst and keeps its partial-line remainder", async () => {
    render(<DirectTerminal paneId="w1:p1" root="/repo" active textSize={14} onReadyChange={vi.fn()} />);
    await ready();
    vi.useFakeTimers();
    const host = screen.getByRole("application");
    for (let i = 0; i < 10; i++) fireEvent.wheel(host, { deltaY: -5 });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_scroll")).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_scroll")).toEqual([["terminal_scroll", expect.objectContaining({ direction: "up", lines: 2 })]]);
    fireEvent.wheel(host, { deltaY: -22 });
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    const scrolls = invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_scroll");
    expect(scrolls[scrolls.length - 1]).toEqual(["terminal_scroll", expect.objectContaining({ direction: "up", lines: 1 })]);
  });

  it.each(["typing", "page key"])("flushes an earlier wheel gesture before %s instead of jumping back afterward", async kind => {
    render(<DirectTerminal paneId="w1:p1" root="/repo" active textSize={14} onReadyChange={vi.fn()} />);
    await ready(); vi.useFakeTimers();
    fireEvent.wheel(screen.getByRole("application"), { deltaY: -50 });
    await act(async () => {
      if (kind === "typing") emulators[0].data("x");
      else emulators[0].key(new KeyboardEvent("keydown", { key: "PageDown" }));
      await vi.advanceTimersByTimeAsync(16);
    });
    const commands = invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_scroll" || cmd === "terminal_write");
    expect(commands).toEqual([
      ["terminal_scroll", expect.objectContaining({ direction: "up", lines: 2, source: "wheel" })],
      kind === "typing" ? ["terminal_write", expect.objectContaining({ text: "x" })] : ["terminal_scroll", expect.objectContaining({ direction: "down", source: "page_key" })],
    ]);
    fireEvent.wheel(screen.getByRole("application"), { deltaY: -22 });
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_scroll" || cmd === "terminal_write")).toHaveLength(2);
  });

  it("copies only a completed selection started in the active xterm output", async () => {
    const view = render(<><input aria-label="Composer" /><DirectTerminal paneId="w1:p1" root="/repo" active textSize={14} onReadyChange={vi.fn()} /></>);
    await ready();
    const host = screen.getByRole("application");
    fireEvent.mouseDown(host); emulators[0].selection = "selected terminal output";
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "clipboard_write_text")).toHaveLength(0);
    fireEvent.mouseUp(document);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("clipboard_write_text", { text: "selected terminal output" }));
    fireEvent.mouseDown(screen.getByLabelText("Composer")); fireEvent.mouseUp(document);
    fireEvent.mouseDown(host); emulators[0].selection = "inactive output";
    view.rerender(<><input aria-label="Composer" /><DirectTerminal paneId="w1:p1" root="/repo" active={false} textSize={14} onReadyChange={vi.fn()} /></>);
    fireEvent.mouseUp(document);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "clipboard_write_text")).toHaveLength(1);
  });

  it("reports an automatic copy failure and does not forward copy as input", async () => {
    invokeMock.mockImplementation((cmd: string) => cmd === "clipboard_write_text" ? Promise.reject(new Error("denied")) : Promise.resolve(cmd === "terminal_attach" ? "lease-1" : undefined));
    render(<DirectTerminal paneId="w1:p1" root="/repo" active textSize={14} onReadyChange={vi.fn()} />);
    await ready();
    fireEvent.mouseDown(screen.getByRole("application")); emulators[0].selection = "output"; fireEvent.mouseUp(document);
    expect((await screen.findByRole("alert")).textContent).toMatch(/copy failed.*denied/i);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toHaveLength(0);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("reserves the project content search chord for the workspace: %j", async modifier => {
    render(<DirectTerminal paneId="w1:p1" root="/repo" active textSize={14} onReadyChange={vi.fn()} />);
    await ready();
    expect(emulators[0].key(new KeyboardEvent("keydown", { key: "F", shiftKey: true, ...modifier }))).toBe(false);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toHaveLength(0);
  });

  it("coalesces resize requests and never submits a zero-sized viewport", async () => {
    render(<DirectTerminal paneId="w1:p1" root="/repo" active textSize={14} onReadyChange={vi.fn()} />);
    await ready();
    vi.useFakeTimers();
    geometry.cols = 0; geometry.rows = 0;
    fireEvent(window, new Event("resize"));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_resize")).toHaveLength(0);
    geometry.cols = 90; geometry.rows = 30;
    fireEvent(window, new Event("resize"));
    geometry.cols = 100;
    fireEvent(window, new Event("resize"));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_resize")).toEqual([["terminal_resize", { leaseId: "lease-1", paneId: "w1:p1", expectedRoot: "/repo", cols: 100, rows: 30 }]]);
  });

  it("retains external control focus when a split becomes active", async () => {
    const view = render(<><input aria-label="Agent picker" /><DirectTerminal paneId="w1:p1" root="/repo" active={false} textSize={14} onReadyChange={vi.fn()} /></>);
    await ready();
    const input = screen.getByLabelText("Agent picker"); input.focus();
    view.rerender(<><input aria-label="Agent picker" /><DirectTerminal paneId="w1:p1" root="/repo" active textSize={14} onReadyChange={vi.fn()} /></>);
    expect(document.activeElement).toBe(input);
  });

  it("acquires only one lease during StrictMode's discarded initial effect", async () => {
    render(<StrictMode><DirectTerminal paneId="w1:p1" root="/repo" active textSize={14} onReadyChange={vi.fn()} /></StrictMode>);
    await ready();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_attach")).toHaveLength(1);
  });

  it("uses native clipboard text for Command-V and discards a paste that resolves after deactivation", async () => {
    let resolveClipboard!: (text: string) => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "clipboard_read_text" ? new Promise(resolve => { resolveClipboard = resolve; }) : Promise.resolve(cmd === "terminal_attach" ? "lease-1" : undefined));
    const view = render(<DirectTerminal paneId="w1:p1" root="/repo" active textSize={14} onReadyChange={vi.fn()} />);
    await ready();
    emulators[0].focus();
    expect(emulators[0].key(new KeyboardEvent("keydown", { key: "v", metaKey: true }))).toBe(false);
    await act(async () => { resolveClipboard("paste\nthese lines"); });
    expect(invokeMock).toHaveBeenCalledWith("terminal_write", expect.objectContaining({ text: "paste\nthese lines" }));
    emulators[0].key(new KeyboardEvent("keydown", { key: "v", metaKey: true }));
    view.rerender(<DirectTerminal paneId="w1:p1" root="/repo" active={false} textSize={14} onReadyChange={vi.fn()} />);
    await act(async () => { resolveClipboard("do not paste here"); });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "terminal_write")).toHaveLength(1);
  });
});

const agent: Agent = { pane_id: "w1:p1", workspace_id: "w1", title: "test agent", kind: "codex", cwd: "/repo", is_worktree: false, status: "working", attention: "working" };

describe("explicit Direct control mode", () => {
  it("opens a dock-requested direct terminal at the available width and keeps mirror recovery available", async () => {
    geometry.cols = 180; geometry.rows = 40;
    render(<Terminal agent={agent} root="/repo" embedded active initialMode="direct" onClose={vi.fn()} />);
    await ready();
    expect(invokeMock).toHaveBeenCalledWith("terminal_attach", expect.objectContaining({ cols: 180, rows: 40 }));
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Return to mirror" }));
    await screen.findByText("snapshot only");
  });
  it("keeps the snapshot default, acquires only after the resize action, and releases when returning to mirror", async () => {
    render(<Terminal agent={agent} root="/repo" embedded active onClose={vi.fn()} />);
    await screen.findByText("snapshot only");
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "terminal_attach")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Direct control/ }));
    await ready();
    expect(screen.queryByText("snapshot only")).toBeNull();
    expect(screen.getByRole("application", { name: "Direct terminal control" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Find output" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Return to mirror" }));
    expect(invokeMock).toHaveBeenCalledWith("terminal_detach", { leaseId: "lease-1" });
    await screen.findByText("snapshot only");
  });

  it("lets the active direct terminal keep Escape and use the existing switch shortcut", async () => {
    const close = vi.fn();
    const switchTo = vi.fn();
    render(<TerminalStageProvider stage={{ claimScene: () => () => {}, switchTo, targets: [
      { agent, root: "/repo", islandName: "repo" },
      { agent: { ...agent, pane_id: "w2:p1" }, root: "/next", islandName: "next" },
    ] }}><Terminal agent={agent} root="/repo" embedded active onClose={close} /></TerminalStageProvider>);
    await screen.findByText("snapshot only");
    fireEvent.click(screen.getByRole("button", { name: /Direct control/ }));
    await ready();
    emulators[0].focus();
    fireEvent.keyDown(emulators[0].textarea, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(emulators[0].textarea, { key: "Tab", ctrlKey: true, altKey: true });
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_send_text" || cmd === "pane_send_keys")).toHaveLength(0);
  });
});
