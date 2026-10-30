// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DefendComposer, DEFEND_PREVIEW_NOTE } from "./DefendComposer";
import type { SwitchTarget } from "../agentSwitcher";
import type { Finding } from "../raids";

const { sendPrompt } = vi.hoisted(() => ({ sendPrompt: vi.fn() }));
vi.mock("../agents", () => ({ sendPrompt }));

const ROOT = "/p/app";
const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "GHSA-1", summary: "Prototype pollution", severity: "critical", package: "lodash",
  installed: "4.17.15", fixed_in: "4.17.21", lockfile: "package-lock.json", url: "https://osv.dev/vulnerability/GHSA-1",
  ...overrides,
});
const target = (overrides: Partial<SwitchTarget["agent"]> = {}, root = ROOT): SwitchTarget => ({
  root, islandName: "app",
  agent: { pane_id: "w1:p1", workspace_id: "w1", title: "Builder", kind: "claude", cwd: ROOT, is_worktree: false, status: "idle", attention: "stopped", ...overrides },
});
const props = (overrides: Partial<Parameters<typeof DefendComposer>[0]> = {}) => ({
  root: ROOT, findings: [finding()], targets: [target()], connected: true, onClose: vi.fn(), onOpenTerminal: vi.fn(),
  ...overrides,
});
const message = () => screen.getByRole("textbox", { name: "Message the agent will receive" }) as HTMLTextAreaElement;
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("defend_sends_once_with_expected_root", async () => {
  let resolve!: () => void;
  sendPrompt.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
  render(<DefendComposer {...props()} />);
  const prompt = message().value;
  expect(prompt).toContain("GHSA-1");
  const send = screen.getByRole("button", { name: "Send to agent" });
  fireEvent.click(send); fireEvent.click(send);
  expect(sendPrompt).toHaveBeenCalledExactlyOnceWith("w1:p1", prompt, ROOT);
  await act(async () => resolve());
  expect(screen.getByText("Your agent has its orders.")).toBeTruthy();
});

it("lists only this island's agents with a known kind", () => {
  render(<DefendComposer {...props({ targets: [
    target(),
    target({ pane_id: "w1:p2", kind: null, title: "shell" }),
    target({ pane_id: "w9:p1", title: "Elsewhere" }, "/p/other"),
  ] })} />);
  const options = (screen.getAllByRole("option") as HTMLOptionElement[]).filter((o) => o.value).map((o) => o.textContent);
  expect(options).toEqual(["Builder · w1:p1"]);
});

it("defend_names_worktree_when_cwd_differs", () => {
  render(<DefendComposer {...props({ targets: [target({ cwd: "/wt/fix-deps", is_worktree: true })] })} />);
  const note = screen.getByTestId("defend-worktree-note");
  expect(note.textContent).toBe("This agent works in /wt/fix-deps. The ships sink once the fix reaches /p/app.");
  expect([...note.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["/wt/fix-deps", ROOT]);
  expect(message().value).toContain("You are working in the worktree /wt/fix-deps");
});

it("shows no worktree note when the agent works in the island root", () => {
  render(<DefendComposer {...props()} />);
  expect(screen.queryByTestId("defend-worktree-note")).toBeNull();
});

it("will not send text written for an agent that has since moved", () => {
  const view = render(<DefendComposer {...props()} />);
  view.rerender(<DefendComposer {...props({ targets: [target({ cwd: "/wt/elsewhere" })] })} />);
  const send = screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Rewrite for this agent" }));
  expect(message().value).toContain("/wt/elsewhere");
  expect(send.disabled).toBe(false);
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("send_failure_preserves_prompt", async () => {
  sendPrompt.mockRejectedValue(new Error("Offline"));
  render(<DefendComposer {...props()} />);
  fireEvent.change(message(), { target: { value: "My edited orders" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  await screen.findByRole("alert");
  expect(message().value).toBe("My edited orders");
  expect(sendPrompt).toHaveBeenCalledOnce();
});

it("nothing_sent_without_click", () => {
  render(<DefendComposer {...props()} />);
  fireEvent.change(message(), { target: { value: "edited" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "w1:p1" } });
  fireEvent.keyDown(message(), { key: "Enter" });
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("sending is disabled in the browser preview", () => {
  render(<DefendComposer {...props({ previewDisabled: true })} />);
  const send = screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.click(send);
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(screen.getByText(DEFEND_PREVIEW_NOTE)).toBeTruthy();
});

it("keeps the user's edits when another agent (or the placeholder) is picked", () => {
  const worktreeAgent = target({ pane_id: "w1:p2", title: "Fixer", cwd: "/wt/fix-deps", is_worktree: true });
  render(<DefendComposer {...props({ targets: [target(), worktreeAgent] })} />);
  // Untouched prefill follows the agent.
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "w1:p2" } });
  expect(message().value).toContain("/wt/fix-deps");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "w1:p1" } });
  expect(message().value).not.toContain("/wt/fix-deps");
  // Once edited, the text is the user's.
  fireEvent.change(message(), { target: { value: "My own orders" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
  expect(message().value).toBe("My own orders");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "w1:p2" } });
  expect(message().value).toBe("My own orders");
  // Written for a different checkout: not sendable until explicitly rewritten.
  const send = screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Rewrite for this agent" }));
  expect(message().value).toContain("/wt/fix-deps");
  expect(send.disabled).toBe(false);
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("edited text stays sendable to another agent in the same checkout", () => {
  render(<DefendComposer {...props({ targets: [target(), target({ pane_id: "w1:p3", title: "Second" })] })} />);
  fireEvent.change(message(), { target: { value: "My own orders" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "w1:p3" } });
  expect(message().value).toBe("My own orders");
  expect((screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement).disabled).toBe(false);
});
