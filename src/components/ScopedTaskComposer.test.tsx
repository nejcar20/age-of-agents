// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ScopedTaskComposer } from "./ScopedTaskComposer";
import type { SwitchTarget } from "../agentSwitcher";

const { sendPrompt } = vi.hoisted(() => ({ sendPrompt: vi.fn() }));
vi.mock("../agents", () => ({ sendPrompt }));
const target: SwitchTarget = { root: "/app", islandName: "app", agent: { pane_id: "w1:p1", workspace_id: "w1", title: "Builder", kind: "codex", cwd: "/worktrees/feature", is_worktree: true, status: "idle", attention: "stopped" } };
const props = { root: "/app", selection: { path: "src/auth.ts", kind: "file" as const }, targets: [target], connected: true, onClose: vi.fn(), onOpenTerminal: vi.fn() };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function reviewTask() {
  fireEvent.change(screen.getByRole("textbox", { name: "Task" }), { target: { value: "Review token expiry" } });
  fireEvent.click(screen.getByRole("button", { name: "Review task" }));
}

it("previews a file-scoped worktree-aware task, then sends only the explicitly reviewed text", async () => {
  let resolve!: () => void;
  sendPrompt.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  render(<ScopedTaskComposer {...props} />);
  reviewTask();
  const message = screen.getByRole("textbox", { name: "Message the agent will receive" }) as HTMLTextAreaElement;
  expect(message.value).toContain('"src/auth.ts"');
  expect(message.value).toContain('"/worktrees/feature"');
  expect(sendPrompt).not.toHaveBeenCalled();
  fireEvent.change(message, { target: { value: "Reviewed exact task" } });
  const send = screen.getByRole("button", { name: "Send task" });
  fireEvent.click(send); fireEvent.click(send);
  expect(sendPrompt).toHaveBeenCalledExactlyOnceWith("w1:p1", "Reviewed exact task", "/app");
  await act(async () => resolve());
  expect(screen.getByText("Task sent")).toBeTruthy();
});

it("blocks a task when the receiver changed worktree during review", () => {
  const view = render(<ScopedTaskComposer {...props} />);
  reviewTask();
  view.rerender(<ScopedTaskComposer {...props} targets={[{ ...target, agent: { ...target.agent, cwd: "/different" } }]} />);
  expect((screen.getByRole("button", { name: "Send task" }) as HTMLButtonElement).disabled).toBe(true);
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("preserves failed tasks and traps focus away from underlying terminals", async () => {
  sendPrompt.mockRejectedValue(new Error("Offline"));
  render(<><button>Behind the dialog</button><ScopedTaskComposer {...props} /></>);
  screen.getByRole("button", { name: "Behind the dialog" }).focus();
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  reviewTask();
  fireEvent.click(screen.getByRole("button", { name: "Send task" }));
  await screen.findByRole("alert");
  expect((screen.getByRole("textbox", { name: "Message the agent will receive" }) as HTMLTextAreaElement).value).toContain("Review token expiry");
  expect(sendPrompt).toHaveBeenCalledOnce();
});
