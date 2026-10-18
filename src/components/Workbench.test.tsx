// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";
import type { World } from "../world";

const { invokeMock, worldState } = vi.hoisted(() => ({ invokeMock: vi.fn(), worldState: { current: {} as World } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
// jsdom has no terminal canvas. Exercise the real mode switch and mirror fallback;
// DirectTerminal and transport have separate emulator/IPC lifecycle tests.
vi.mock("./DirectTerminal", () => ({ DirectTerminal: () => <p role="alert">Direct control unavailable in test browser</p> }));
async function openMirror() {
  fireEvent.click(await screen.findByRole("button", { name: "Return to mirror" }));
  await screen.findByText("Waiting for your review");
  fireEvent.mouseDown(screen.getByRole("application"));
}
vi.mock("../useWorld", () => ({ useWorld: () => worldState.current }));
vi.mock("../useArchipelago", () => ({ useArchipelago: () => ({ kind: "ready", islands: [], refetch: vi.fn() }) }));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  worldState.current = { herdr_connected: true, herdr_version: "0.9", protocol_mismatch: false, islands: [{
    id: "w1", root: "/work/api", name: "api", last_changed_at: null, attention: "stopped",
    agents: [{ pane_id: "w1:p1", workspace_id: "w1", title: "Fix payments", kind: "codex", cwd: "/work/api", attention: "stopped", status: "idle", is_worktree: false }],
  }] };
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "pane_read") return Promise.resolve({ text: "Waiting for your review", truncated: false, revision: 0 });
    if (cmd === "agent_kinds") return Promise.resolve(["codex"]);
    if (cmd === "resumable_agent_kinds") return Promise.resolve(["codex"]);
    return Promise.resolve(null);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); invokeMock.mockReset(); });

it("opens an agent inline, focuses typing, and keeps it attached while filtering projects", async () => {
  render(<Workbench renderAtlas={() => <p>World view</p>} />);
  fireEvent.click(screen.getByRole("button", { name: /Open terminal for Fix payments/ }));
  await openMirror();
  expect(document.activeElement).toBe(screen.getByRole("application"));
  expect(screen.queryByRole("dialog", { name: /Terminal:/ })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no match" } });
  expect(screen.getByText("Waiting for your review")).toBeTruthy();
  fireEvent.focus(screen.getByRole("application"));
  fireEvent.keyDown(screen.getByRole("application"), { key: "a" });
  expect(invokeMock).toHaveBeenCalledWith("pane_send_text", { paneId: "w1:p1", text: "a", expectedRoot: "/work/api" });
});

it("detaches a vanished pane and reports it instead of retaining a writable stale session", async () => {
  const view = render(<Workbench renderAtlas={() => <p>World view</p>} />);
  fireEvent.click(screen.getByRole("button", { name: /Open terminal for Fix payments/ }));
  await openMirror();
  worldState.current = { ...worldState.current, islands: [] };
  await act(async () => view.rerender(<Workbench renderAtlas={() => <p>World view</p>} />));
  expect(screen.queryByRole("application")).toBeNull();
  expect(screen.getByText(/no longer running/)).toBeTruthy();
});

it("preserves Ctrl+K for the terminal and lets search clear on Escape without detaching", async () => {
  render(<Workbench renderAtlas={() => <p>World view</p>} />);
  fireEvent.click(screen.getByRole("button", { name: /Open terminal for Fix payments/ }));
  await openMirror();
  const terminal = screen.getByRole("application");
  fireEvent.keyDown(terminal, { key: "k", ctrlKey: true });
  expect(document.activeElement).toBe(terminal);
  expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", { paneId: "w1:p1", keys: ["ctrl+k"], expectedRoot: "/work/api" });
  fireEvent.keyDown(terminal, { key: "k", metaKey: true });
  const search = screen.getByRole("searchbox");
  expect(document.activeElement).toBe(search);
  fireEvent.change(search, { target: { value: "something" } });
  fireEvent.keyDown(search, { key: "Escape" });
  expect((search as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("application")).toBe(terminal);
});

it("moves focus into New project and prevents terminal typing behind its dialog", async () => {
  render(<Workbench renderAtlas={() => <p>World view</p>} />);
  fireEvent.click(screen.getByRole("button", { name: /Open terminal for Fix payments/ }));
  await openMirror();
  const terminal = screen.getByRole("application");
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  const dialog = screen.getByRole("dialog", { name: "Found a new project" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  // Even an accidental programmatic focus cannot arm a pane behind a sheet.
  terminal.focus();
  invokeMock.mockClear();
  fireEvent.keyDown(terminal, { key: "x" });
  fireEvent.keyDown(terminal, { key: "Tab", ctrlKey: true, altKey: true });
  expect(invokeMock.mock.calls.some(([cmd]) => cmd === "pane_send_text" || cmd === "pane_send_keys")).toBe(false);
});

it("opens a project handoff from the terminal without letting dialog keystrokes reach the pane", async () => {
  worldState.current.islands.push({ id: "mini", root: "/work/mini", name: "mini", last_changed_at: null, attention: "quiet", agents: [] });
  render(<Workbench renderAtlas={() => <p>World view</p>} />);
  fireEvent.click(screen.getByRole("button", { name: /Open terminal for Fix payments/ }));
  await openMirror();
  const terminal = screen.getByRole("application");
  fireEvent.click(screen.getByRole("button", { name: /Share project/ }));
  const dialog = screen.getByRole("dialog", { name: "Establish a trade route" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect((screen.getByRole("combobox", { name: /Destination project/ }) as HTMLSelectElement).value).toBe("/work/api");
  terminal.focus();
  invokeMock.mockClear();
  fireEvent.keyDown(terminal, { key: "x" });
  expect(invokeMock.mock.calls.some(([cmd]) => cmd === "pane_send_text" || cmd === "pane_send_keys")).toBe(false);
});

describe("first run", () => {
  const offline = () => { worldState.current = { herdr_connected: false, herdr_version: "", protocol_mismatch: false, islands: [] }; };
  const setup = (installed: boolean) => invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "herdr_setup") return Promise.resolve({ installed });
    if (cmd === "list_unsettled") return Promise.resolve({ roots: ["/Users/you/code", "/Users/you/Projects"], repos: [], home: "/Users/you", default_agent: "claude" });
    return Promise.resolve(null);
  });

  it("opens on the world with a dismissible legend when there are no agents yet, and remembers the choice", async () => {
    offline(); setup(false);
    const first = render(<Workbench renderAtlas={() => <p>World view</p>} />);
    expect(screen.getByText("World view")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss map legend" }));
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Overview/ }));
    first.unmount();
    render(<Workbench renderAtlas={() => <p>World view</p>} />);
    expect(screen.queryByText("World view")).toBeNull();
    expect(screen.getByRole("region", { name: "Connect your agents" })).toBeTruthy();
  });

  it("explains Herdr and asks to install it only when it is missing", async () => {
    offline(); setup(false);
    localStorage.setItem("aoa.workspaceView", "work");
    render(<Workbench renderAtlas={() => <p>World view</p>} />);
    expect(await screen.findByText("brew install herdr")).toBeTruthy();
    expect(screen.getByText("Start it").parentElement?.textContent).toMatch(/run herdr/);
    expect(await screen.findByText(/~\/code, ~\/Projects/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Waiting for Herdr/);
  });

  it("skips the install step when Herdr is installed but not running", async () => {
    offline(); setup(true);
    localStorage.setItem("aoa.workspaceView", "work");
    render(<Workbench renderAtlas={() => <p>World view</p>} />);
    expect(await screen.findByText("Herdr is installed")).toBeTruthy();
    expect(screen.queryByText("brew install herdr")).toBeNull();
  });

  it("points back to setup from the world while Herdr is offline, and shows no setup once connected", async () => {
    offline(); setup(true);
    localStorage.setItem("aoa.workspaceView", "world");
    const view = render(<Workbench renderAtlas={() => <p>World view</p>} />);
    fireEvent.click(screen.getByRole("button", { name: "How to connect" }));
    expect(screen.getByRole("region", { name: "Connect your agents" })).toBeTruthy();
    worldState.current = { herdr_connected: true, herdr_version: "0.9", protocol_mismatch: false, islands: [] };
    view.rerender(<Workbench renderAtlas={() => <p>World view</p>} />);
    expect(screen.queryByRole("region", { name: "Connect your agents" })).toBeNull();
  });
});
