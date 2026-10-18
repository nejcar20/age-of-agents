// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TradeRouteComposer } from "./TradeRouteComposer";
import { TradeRoutesPage, TradeRoutesProvider } from "./TradeRoutes";
import { decodeTradeRoutes, TRADE_ROUTES_KEY } from "../tradeRoutes";
import type { Island } from "../world";
import type { SwitchTarget } from "../agentSwitcher";

const { sendPrompt } = vi.hoisted(() => ({ sendPrompt: vi.fn() }));
vi.mock("../agents", () => ({ sendPrompt }));
const projects: Island[] = ["mini", "main"].map(name => ({ id: name, root: `/work/${name}`, name, agents: [], attention: "quiet", last_changed_at: null }));
const targets: SwitchTarget[] = [{ root: "/work/main", islandName: "main", agent: {
  pane_id: "w1:p1", workspace_id: "w1", title: "Builder", kind: "codex", cwd: "/work/main-feature",
  attention: "stopped", status: "idle", is_worktree: true,
} }];
const defaults = { projects, targets, connected: true, preset: { sourceRoot: "/work/mini", targetRoot: "/work/main", paneId: "w1:p1" },
  onClose: vi.fn(), onSent: vi.fn(), onOpenAgent: vi.fn(), warning: null };
function review() {
  fireEvent.change(screen.getByRole("textbox", { name: "What should travel across?" }), { target: { value: "Bring the editor into the main app." } });
  fireEvent.click(screen.getByRole("button", { name: "Review brief →" }));
}
beforeEach(() => { localStorage.clear(); sendPrompt.mockReset().mockResolvedValue(undefined); defaults.onSent.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("reviews the worktree-aware message and sends the edited text exactly once after an explicit click", async () => {
  let resolve!: () => void;
  sendPrompt.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  render(<TradeRouteComposer {...defaults} />);
  review();
  const prompt = screen.getByRole("textbox", { name: "Message the agent will receive" }) as HTMLTextAreaElement;
  expect(prompt.value).toContain('"/work/main-feature"');
  expect(prompt.value).toContain("Wait for my approval");
  expect(sendPrompt).not.toHaveBeenCalled();
  fireEvent.change(prompt, { target: { value: "My edited integration brief" } });
  const submit = screen.getByRole("button", { name: "Establish route & send" });
  fireEvent.click(submit); fireEvent.click(submit);
  expect(sendPrompt).toHaveBeenCalledExactlyOnceWith("w1:p1", "My edited integration brief", "/work/main");
  expect(defaults.onSent).not.toHaveBeenCalled();
  await act(async () => resolve());
  expect(defaults.onSent).toHaveBeenCalledOnce();
  expect(defaults.onSent.mock.calls[0][0]).toMatchObject({ prompt: "My edited integration brief", targetCwd: "/work/main-feature", sourceRoot: "/work/mini", mode: "plan" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" }));
});

it("keeps failed submissions reviewable without recording or automatically retrying them", async () => {
  sendPrompt.mockRejectedValue(new Error("Agent disconnected"));
  render(<TradeRouteComposer {...defaults} />);
  review();
  fireEvent.click(screen.getByRole("button", { name: "Establish route & send" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("Check the receiving terminal");
  expect(screen.getByRole("textbox", { name: "Message the agent will receive" })).toBeTruthy();
  expect(sendPrompt).toHaveBeenCalledOnce();
  expect(defaults.onSent).not.toHaveBeenCalled();
});

it("disables sending if the receiver moves to another working tree after review", () => {
  const view = render(<TradeRouteComposer {...defaults} />);
  review();
  view.rerender(<TradeRouteComposer {...defaults} targets={[{ ...targets[0], agent: { ...targets[0].agent, cwd: "/elsewhere" } }]} />);
  expect((screen.getByRole("button", { name: "Establish route & send" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("no longer available");
  fireEvent.click(screen.getByRole("button", { name: "Establish route & send" }));
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("allows preparing a brief offline but blocks its submission and overlong prompts", () => {
  const view = render(<TradeRouteComposer {...defaults} connected={false} />);
  review();
  expect((screen.getByRole("button", { name: "Establish route & send" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<TradeRouteComposer {...defaults} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Message the agent will receive" }), { target: { value: "x".repeat(20001) } });
  expect((screen.getByRole("button", { name: "Establish route & send" }) as HTMLButtonElement).disabled).toBe(true);
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("requires two distinct projects and an actual agent", () => {
  render(<TradeRouteComposer {...defaults} targets={[]} />);
  fireEvent.change(screen.getByRole("textbox", { name: "What should travel across?" }), { target: { value: "Bring it over" } });
  expect((screen.getByRole("button", { name: "Review brief →" }) as HTMLButtonElement).disabled).toBe(true);
});

function renderRoutes() {
  return render(<TradeRoutesProvider projects={projects} targets={targets} connected onOpenAgent={vi.fn()} onViewRoutes={vi.fn()}><TradeRoutesPage /></TradeRoutesProvider>);
}
async function sendRoute() {
  fireEvent.click(screen.getByRole("button", { name: "+ Establish a route" }));
  review();
  fireEvent.click(screen.getByRole("button", { name: "Establish route & send" }));
  await screen.findByRole("heading", { name: "Route established" });
}

it("persists successful routes, restores their submitted text, and removes them without contacting the agent", async () => {
  const view = renderRoutes();
  await sendRoute();
  const routes = decodeTradeRoutes(localStorage.getItem(TRADE_ROUTES_KEY));
  expect(routes).toHaveLength(1);
  expect(routes[0].prompt).toContain("Bring the editor");
  view.unmount();
  renderRoutes();
  expect(screen.getByText("Brief sent")).toBeTruthy();
  expect(screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent === routes[0].prompt)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove route" }));
  expect(decodeTradeRoutes(localStorage.getItem(TRADE_ROUTES_KEY))).toEqual([]);
  expect(sendPrompt).toHaveBeenCalledOnce();
});

it("reports session-only history after a storage failure without resending an acknowledged prompt", async () => {
  renderRoutes();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
  await sendRoute();
  expect(screen.getAllByText(/saved for this session only/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByText("Brief sent")).toBeTruthy();
  expect(sendPrompt).toHaveBeenCalledOnce();
});

it("preserves unreadable stored data even when a new brief succeeds", async () => {
  localStorage.setItem(TRADE_ROUTES_KEY, "unreadable original history");
  renderRoutes();
  expect(screen.getByText(/existing data has not been overwritten/)).toBeTruthy();
  await sendRoute();
  expect(localStorage.getItem(TRADE_ROUTES_KEY)).toBe("unreadable original history");
  expect(sendPrompt).toHaveBeenCalledOnce();
});

it("does not resurrect a session-only removal when a later save succeeds", async () => {
  renderRoutes();
  await sendRoute();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  const originalId = decodeTradeRoutes(localStorage.getItem(TRADE_ROUTES_KEY))[0].id;
  const failingWrite = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  fireEvent.click(screen.getByRole("button", { name: "Remove route" }));
  expect(screen.queryByText("Brief sent")).toBeNull();
  failingWrite.mockRestore();
  await sendRoute();
  const saved = decodeTradeRoutes(localStorage.getItem(TRADE_ROUTES_KEY));
  expect(saved).toHaveLength(1);
  expect(saved[0].id).not.toBe(originalId);
});

it("does not reopen an exited agent's shell or a replacement agent kind as the receiving terminal", async () => {
  const view = renderRoutes();
  await sendRoute();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  for (const kind of [null, "claude"]) {
    view.rerender(<TradeRoutesProvider projects={projects} targets={[{ ...targets[0], agent: { ...targets[0].agent, kind } }]} connected onOpenAgent={vi.fn()} onViewRoutes={vi.fn()}><TradeRoutesPage /></TradeRoutesProvider>);
    expect((screen.getByRole("button", { name: "Receiving agent is no longer available" }) as HTMLButtonElement).disabled).toBe(true);
  }
});
