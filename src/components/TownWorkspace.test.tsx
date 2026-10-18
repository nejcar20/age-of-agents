// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TownWorkspace } from "./TownWorkspace";
import type { TownViewProps } from "./TownView";
import type { CityView } from "../city";
import type { Agent, Attention } from "../world";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./TownView", () => ({ TownView: (props: TownViewProps) => <div><span data-testid="focus-path">{props.focusRequest?.path}</span><button onClick={() => props.onCodeSelect?.("/app/src", "directory")}>Select district</button><button onClick={() => props.onCodeSelect?.("/app/src/other.ts", "file")}>Select other building</button><span data-testid="changes-live">{String(!!props.changesLive)}</span></div> }));
const city: CityView = { model: { root: "/app", name: "app", skipped: 0, submodules: 0, districts: [{ path: "/app/src", name: "src", depth: 1, walled: false, buildings: [{ path: "/app/src/auth.ts", name: "auth.ts", kind: "Source", lines: 20, height: 1 }] }] }, layout: { width: 10, depth: 10, districts: [] } };
const props = { root: "/app", cityView: city, targets: [], connected: true, onOpenTerminal: vi.fn() };
beforeEach(() => invoke.mockImplementation((cmd: string, args: {path: string}) => {
  if (cmd === "repo_changes") return Promise.resolve({ root: "/app", branch: "feature", truncated: false, entries: [{ path: "src/auth.ts", previous_path: null, status: "modified", staged: true, unstaged: true }, { path: "deleted.ts", previous_path: null, status: "deleted", staged: false, unstaged: true }] });
  if (cmd === "inspect_project_path") return Promise.resolve({ path: args.path, kind: args.path === "src" ? "directory" : "text", content: "export const auth = true;", truncated: false, staged_diff: "+ staged change", unstaged_diff: "+ working change", diff_truncated: false });
  return Promise.resolve(null);
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("searches real indexed paths, focuses the building, and reads the file with repository context", async () => {
  render(<TownWorkspace {...props} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a file in this town" }), { target: { value: "auth" } });
  fireEvent.click(screen.getByRole("button", { name: /Open src\/auth.ts/ }));
  expect(screen.getByTestId("focus-path").textContent).toBe("/app/src/auth.ts");
  await screen.findByText("export const auth = true;");
  expect(invoke).toHaveBeenCalledWith("inspect_project_path", { root: "/app", path: "src/auth.ts" });
  fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
  expect(screen.getByText("+ staged change")).toBeTruthy();
  expect(screen.getByText("+ working change")).toBeTruthy();
});
it("lists deleted paths honestly even when there is no matching building", async () => {
  render(<TownWorkspace {...props} />);
  fireEvent.click(screen.getByRole("tab", { name: /Changes/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Open deleted.ts/ }));
  expect(screen.getByText(/No building for this path/)).toBeTruthy();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("inspect_project_path", { root: "/app", path: "deleted.ts" }));
});
it("invalidates a list navigation request when a different building is selected on the map", async () => {
  const view = render(<TownWorkspace {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Open src\/auth.ts/ }));
  expect(screen.getByTestId("focus-path").textContent).toBe("/app/src/auth.ts");
  fireEvent.click(screen.getByRole("button", { name: "Select other building" }));
  view.rerender(<TownWorkspace {...props} cityView={{ ...city, model: { ...city.model } }} />);
  expect(screen.getByTestId("focus-path").textContent).toBe("");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("inspect_project_path", { root: "/app", path: "src/other.ts" }));
});
it("allows giving a selected district to an agent and surfaces read failures", async () => {
  invoke.mockImplementation((cmd: string) => cmd === "inspect_project_path" ? Promise.reject(new Error("Permission denied")) : Promise.resolve({ entries: [], branch: null, truncated: false }));
  render(<TownWorkspace {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Select district" }));
  await screen.findByText(/Permission denied/);
  fireEvent.click(screen.getByRole("button", { name: "Ask an agent" }));
  expect(screen.getByRole("dialog", { name: "Ask an agent" })).toBeTruthy();
  expect(screen.getByText(/Start an agent in this project first/)).toBeTruthy();
});

it("opens content search with Cmd+Shift+F and jumps to the matching file and line", async () => {
  const fallback = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, args: { path: string }) => cmd === "search_project_text" ? Promise.resolve({ root: "/app", query: "auth", matches: [{ path: "src/auth.ts", line: 2, column: 14, text: "export const auth = true;", truncated: false }], truncated: false, files_searched: 2, files_skipped: 0 }) : cmd === "inspect_project_path" ? Promise.resolve({ path: args.path, kind: "text", content: "// module\nexport const auth = true;\n", truncated: false, staged_diff: "", unstaged_diff: "", diff_truncated: false }) : fallback(cmd, args));
  render(<TownWorkspace {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Hide work panel" }));
  fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
  const input = screen.getByRole("searchbox", { name: "Search file contents" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.change(input, { target: { value: "auth" } });
  fireEvent.submit(input.closest("form")!);
  fireEvent.click(await screen.findByRole("button", { name: "Open src/auth.ts at line 2" }));
  expect(invoke).toHaveBeenCalledWith("search_project_text", { root: "/app", query: "auth", caseSensitive: false });
  expect(screen.getByTestId("focus-path").textContent).toBe("/app/src/auth.ts");
  await waitFor(() => expect(screen.getByLabelText("Line 2").textContent).toContain("export const auth"));
  fireEvent.click(screen.getByRole("tab", { name: /Changes/ }));
  fireEvent.click(screen.getByRole("button", { name: "Hide work panel" }));
  fireEvent.keyDown(window, { key: "f", ctrlKey: true, shiftKey: true });
  expect((screen.getByRole("searchbox", { name: "Search file contents" }) as HTMLInputElement).value).toBe("auth");
  expect(screen.getByRole("button", { name: "Open src/auth.ts at line 2" })).toBeTruthy();
});

it("leaves Cmd+Shift+F to an open dialog", async () => {
  render(<TownWorkspace {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Select district" }));
  fireEvent.click(screen.getByRole("button", { name: "Ask an agent" }));
  fireEvent.keyDown(window, { key: "F", ctrlKey: true, shiftKey: true });
  expect(screen.queryByRole("searchbox", { name: "Search file contents" })).toBeNull();
});

const agentThat = (attention: Attention): Agent => ({ pane_id: "w1:p1", workspace_id: "w1", status: attention === "working" ? "working" : "idle", attention, title: "✳ Fix login", kind: "claude", is_worktree: false, cwd: "/app" });
const changeReads = () => invoke.mock.calls.filter(([cmd]) => cmd === "repo_changes").length;

it("keeps the town's changes live while an agent here is working, and reads once more when it stops", async () => {
  vi.useFakeTimers();
  try {
    const view = render(<TownWorkspace {...props} agents={[agentThat("working")]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(changeReads()).toBe(1);
    expect(screen.getByTestId("changes-live").textContent).toBe("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(changeReads()).toBe(3);
    expect(screen.queryByText("Reading Git changes…")).toBeNull();

    view.rerender(<TownWorkspace {...props} agents={[agentThat("stopped")]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(changeReads()).toBe(4);
    expect(screen.getByTestId("changes-live").textContent).toBe("false");
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(changeReads()).toBe(4);
  } finally {
    vi.useRealTimers();
  }
});

it("does not poll a town where nobody is working", async () => {
  vi.useFakeTimers();
  try {
    render(<TownWorkspace {...props} agents={[agentThat("quiet")]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(changeReads()).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it("re-measures the town on each working tick, but never while the last measurement is still running", async () => {
  vi.useFakeTimers();
  try {
    let finish: () => void = () => {};
    const onRefreshCity = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<TownWorkspace {...props} agents={[agentThat("working")]} onRefreshCity={onRefreshCity} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(onRefreshCity).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(onRefreshCity).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await vi.advanceTimersByTimeAsync(5_000); });
    expect(onRefreshCity).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
