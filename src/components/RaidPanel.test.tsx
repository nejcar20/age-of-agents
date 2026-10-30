// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RaidPanel } from "./RaidPanel";
import type { SwitchTarget } from "../agentSwitcher";
import type { SeaIsland } from "../archipelago";
import type { Finding, RaidReport } from "../raids";
import type { Agent } from "../world";

const { sendPrompt, openUrl, startOpen } = vi.hoisted(() => ({ sendPrompt: vi.fn(), openUrl: vi.fn(), startOpen: vi.fn() }));
vi.mock("../agents", () => ({ sendPrompt }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
// The real flow talks to the backend (`agent_kinds`); what this panel owes it
// is only "the button opens it", so the flow is stubbed at its boundary.
vi.mock("./StartAgent", () => ({
  START_AGENT_LABEL: "Start agent…",
  useStartAgentFlow: () => ({ open: startOpen, loading: false, error: null, busy: false, notes: null, sheets: null, cancelWait: () => {} }),
}));

const ROOT = "/p/app";
const agent: Agent = { pane_id: "w1:p1", workspace_id: "w1", title: "Builder", kind: "claude", cwd: ROOT, is_worktree: false, status: "idle", attention: "stopped" };
const target: SwitchTarget = { root: ROOT, islandName: "app", agent };
const island = (agents: Agent[] = [agent]): SeaIsland => ({
  view: { root: ROOT, name: "app", plot: { x: 0, z: 0, w: 40, d: 40 }, city: { status: "known", district_count: 1, building_count: 1, width: 1, depth: 1, source: "Git", measured_at: null }, last_changed_at: null },
  attention: agents.length ? "stopped" : null,
  agents,
});
const f = (id: string, severity: Finding["severity"], extra: Partial<Finding> = {}): Finding => ({
  id, summary: `${id} summary`, severity, package: `pkg-${id}`, installed: "1.0.0", fixed_in: "1.0.1",
  lockfile: "package-lock.json", url: `https://osv.dev/vulnerability/${id}`, ...extra,
});
const report = (overrides: Partial<RaidReport> = {}): RaidReport => ({
  root: ROOT, scanned_at: Math.floor(Date.now() / 1000) - 2 * 86400, scanner: "osv-scanner",
  covered: ["package-lock.json"], uncovered: [],
  status: { kind: "raided", findings: [f("LOW-1", "low"), f("CRIT-1", "critical"), f("HIGH-1", "high", { fixed_in: null, lockfile: "web/yarn.lock" })] },
  stale: false, ...overrides,
});
const props = (overrides: Partial<Parameters<typeof RaidPanel>[0]> = {}) => ({
  seaIsland: island(), report: report(), onClose: vi.fn(), onScout: vi.fn(), scouting: false,
  targets: [target], connected: true, onOpenTerminal: vi.fn(), ...overrides,
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("panel_lists_findings_by_severity_with_links", () => {
  render(<RaidPanel {...props()} />);
  expect(screen.getByText(/osv-scanner · scouted 2 days ago/)).toBeTruthy();
  const rows = screen.getAllByRole("listitem");
  expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual(["CRIT-1", "HIGH-1", "LOW-1"]);
  expect(rows[0].textContent).toContain("critical");
  expect(rows[0].textContent).toContain("1.0.0 → 1.0.1");
  expect(rows[1].textContent).toContain("no fix known");
  expect(rows[1].textContent).toContain("web/yarn.lock");
  for (const row of rows) expect((within(row).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  const link = within(rows[0]).getByRole("link");
  expect(link.getAttribute("href")).toBe("https://osv.dev/vulnerability/CRIT-1");
  openUrl.mockResolvedValue(undefined);
  fireEvent.click(link);
  expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://osv.dev/vulnerability/CRIT-1");
});

it("stale_banner_shown", () => {
  const { rerender } = render(<RaidPanel {...props()} />);
  expect(screen.queryByText("The lockfiles changed since this scout — rescout")).toBeNull();
  rerender(<RaidPanel {...props({ report: report({ stale: true }) })} />);
  expect(screen.getByText("The lockfiles changed since this scout — rescout")).toBeTruthy();
});

it("uncovered_listed_as_not_checked", () => {
  render(<RaidPanel {...props({ report: report({ uncovered: ["poetry.lock", "go.sum"] }) })} />);
  expect(screen.getByText("Not checked: poetry.lock, go.sum")).toBeTruthy();
});

it("defend_without_agent_offers_start_agent", () => {
  render(<RaidPanel {...props({ seaIsland: island([]), targets: [] })} />);
  expect(screen.queryByRole("button", { name: "Send an agent to defend" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start an agent first" }));
  expect(startOpen).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog", { name: /defend/i })).toBeNull();
});

it("defends with only the checked findings, and not at all with none", () => {
  render(<RaidPanel {...props()} />);
  const rows = screen.getAllByRole("listitem");
  fireEvent.click(within(rows[2]).getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Send an agent to defend" }));
  const prompt = (screen.getByRole("textbox", { name: "Message the agent will receive" }) as HTMLTextAreaElement).value;
  expect(prompt).toContain("CRIT-1");
  expect(prompt).toContain("HIGH-1");
  expect(prompt).not.toContain("LOW-1");
  expect(sendPrompt).not.toHaveBeenCalled();
  cleanup();
  render(<RaidPanel {...props()} />);
  for (const row of screen.getAllByRole("listitem")) fireEvent.click(within(row).getByRole("checkbox"));
  expect((screen.getByRole("button", { name: "Send an agent to defend" }) as HTMLButtonElement).disabled).toBe(true);
});

it("rescout calls onScout, and says so while scouting", () => {
  const onScout = vi.fn();
  const { rerender } = render(<RaidPanel {...props({ onScout })} />);
  fireEvent.click(screen.getByRole("button", { name: "Rescout" }));
  expect(onScout).toHaveBeenCalledOnce();
  rerender(<RaidPanel {...props({ onScout, scouting: true })} />);
  expect((screen.getByRole("button", { name: "Scouting…" }) as HTMLButtonElement).disabled).toBe(true);
});

it("an unscouted island shows its reason and offers no defence", () => {
  render(<RaidPanel {...props({ report: report({ status: { kind: "unscouted", reason: "no scanner installed" } }) })} />);
  expect(screen.getByText("no scanner installed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send an agent to defend" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Start an agent first" })).toBeNull();
});

it("a clean island is calm, with when and how it was scouted", () => {
  render(<RaidPanel {...props({ report: report({ status: { kind: "clean" } }) })} />);
  expect(screen.getByText("No known vulnerabilities")).toBeTruthy();
  expect(screen.getByText(/osv-scanner · scouted 2 days ago/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Rescout" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send an agent to defend" })).toBeNull();
});

it("scouting is disabled in the browser preview", () => {
  const onScout = vi.fn();
  render(<RaidPanel {...props({ onScout, previewDisabled: true })} />);
  const button = screen.getByRole("button", { name: "Rescout" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByText("Scouting is disabled in the preview.")).toBeTruthy();
});
