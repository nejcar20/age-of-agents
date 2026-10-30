// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRaids } from "./useRaids";
import type { RaidReport } from "./raids";

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

let handlers: Record<string, (event: { payload: unknown }) => void> = {};

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  listenMock.mockReset();
  handlers = {};
});

const rep = (root: string, kind: "clean" | "raided", scanned_at = 1): RaidReport => ({
  root, scanned_at, scanner: "osv-scanner", covered: [], uncovered: [], stale: false,
  status: kind === "clean" ? { kind } : { kind, findings: [] },
});

function setup(responses: Record<string, unknown>) {
  listenMock.mockImplementation((name: string, handler: (e: { payload: unknown }) => void) => {
    handlers[name] = handler;
    return Promise.resolve(vi.fn());
  });
  invokeMock.mockImplementation((cmd: string) =>
    cmd in responses
      ? responses[cmd] instanceof Error ? Promise.reject(responses[cmd]) : Promise.resolve(responses[cmd])
      : Promise.reject(new Error(`unexpected ${cmd}`)));
}

let api!: ReturnType<typeof useRaids>;
function Probe() {
  api = useRaids();
  return (
    <div>
      <span data-testid="reports">{[...api.reports.values()].map((r) => `${r.root}:${r.status.kind}`).join(",")}</span>
      <span data-testid="prev">{[...api.previous.values()].map((r) => `${r.root}:${r.status.kind}`).join(",")}</span>
      <span data-testid="scouting">{api.scouting ? `${api.scouting.done}/${api.scouting.total}` : "none"}</span>
      <span data-testid="error">{api.error ?? ""}</span>
      <span data-testid="scanners">{api.scanners ? `${api.scanners.osv}` : "null"}</span>
    </div>
  );
}

describe("useRaids", () => {
  it("report_event_replaces_and_keeps_previous", async () => {
    setup({ raid_reports: [rep("/p/a", "raided")], raid_scanners: { osv: true, npm: false } });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("reports").textContent).toBe("/p/a:raided"));
    await waitFor(() => expect(screen.getByTestId("scanners").textContent).toBe("true"));
    await waitFor(() => expect(handlers["raid-report"]).toBeDefined());
    act(() => handlers["raid-report"]({ payload: rep("/p/a", "clean", 2) }));
    expect(screen.getByTestId("reports").textContent).toBe("/p/a:clean");
    expect(screen.getByTestId("prev").textContent).toBe("/p/a:raided");
  });

  it("scout_all_tracks_progress_and_clears_on_done", async () => {
    setup({ raid_reports: [], raid_scanners: { osv: true, npm: true }, scout_all: 3 });
    render(<Probe />);
    await waitFor(() => expect(handlers["raid-scout-done"]).toBeDefined());
    await act(async () => { await api.scoutAll(); });
    expect(screen.getByTestId("scouting").textContent).toBe("0/3");
    act(() => handlers["raid-report"]({ payload: rep("/p/a", "clean") }));
    expect(screen.getByTestId("scouting").textContent).toBe("1/3");
    act(() => handlers["raid-scout-done"]({ payload: null }));
    expect(screen.getByTestId("scouting").textContent).toBe("none");
  });

  it("scout_all_rejection_surfaces_error_and_leaves_scouting_null", async () => {
    setup({ raid_reports: [], raid_scanners: { osv: true, npm: true }, scout_all: new Error("already scouting") });
    render(<Probe />);
    await waitFor(() => expect(handlers["raid-report"]).toBeDefined());
    await act(async () => { await api.scoutAll(); });
    expect(screen.getByTestId("scouting").textContent).toBe("none");
    expect(screen.getByTestId("error").textContent).toContain("already scouting");
  });

  it("done_before_scout_all_resolves_ends_with_scouting_null", async () => {
    let resolveAll!: (n: number) => void;
    setup({ raid_reports: [], raid_scanners: { osv: true, npm: true } });
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "scout_all" ? new Promise<number>((r) => { resolveAll = r; }) : base(cmd));
    render(<Probe />);
    await waitFor(() => expect(handlers["raid-report"]).toBeDefined());
    let p!: Promise<void>;
    act(() => { p = api.scoutAll(); });
    expect(screen.getByTestId("scouting").textContent).toBe("0/0");
    act(() => handlers["raid-report"]({ payload: rep("/p/a", "clean") }));
    expect(screen.getByTestId("scouting").textContent).toBe("1/0");
    act(() => handlers["raid-scout-done"]({ payload: null }));
    await act(async () => { resolveAll(1); await p; });
    expect(screen.getByTestId("scouting").textContent).toBe("none");
  });

  it("scout_all_count_zero_ends_with_scouting_null", async () => {
    setup({ raid_reports: [], raid_scanners: { osv: true, npm: true }, scout_all: 0 });
    render(<Probe />);
    await waitFor(() => expect(handlers["raid-report"]).toBeDefined());
    await act(async () => { await api.scoutAll(); });
    expect(screen.getByTestId("scouting").textContent).toBe("none");
  });

  it("scout_island_resolves_to_its_own_failure", async () => {
    setup({ raid_reports: [], raid_scanners: { osv: true, npm: true }, scout_island: new Error("scanner crashed") });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("scanners").textContent).toBe("true"));
    let result: string | null = "unset";
    await act(async () => { result = await api.scoutIsland("/p/a"); });
    expect(result).toBe("Error: scanner crashed");
  });

  it("scout_island_resolves_null_on_success", async () => {
    setup({ raid_reports: [], raid_scanners: { osv: true, npm: true }, scout_island: rep("/p/a", "clean") });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("scanners").textContent).toBe("true"));
    let result: string | null = "unset";
    await act(async () => { result = await api.scoutIsland("/p/a"); });
    expect(result).toBeNull();
  });
});
