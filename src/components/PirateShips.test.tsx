// @vitest-environment node
//
// Same harness as `Archipelago.test.tsx` (see its header): no WebGL here, so
// the scene is rendered with `renderToStaticMarkup` and `useFrame` is
// captured rather than run by a real Canvas. drei's `<Html>` needs a live
// r3f root (`useThree`), so it is stood in for by a plain `<div>` — which is
// what lets "is the +3 badge there" be asked of the markup at all.
import { describe, expect, it, vi } from "vitest";
import type { CSSProperties, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Finding, RaidReport, Severity } from "../raids";

type FakeFrameState = { clock: { elapsedTime: number }; invalidate: () => void };
const captured: Array<(state: FakeFrameState) => void> = [];

vi.mock("@react-three/fiber", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@react-three/fiber")>();
  return {
    ...actual,
    useFrame: (cb: (state: FakeFrameState) => void) => {
      captured.push(cb);
    },
  };
});
vi.mock("@react-three/drei", () => ({
  Html: ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
    <div data-html="" style={style}>
      {children}
    </div>
  ),
  useCursor: () => {},
}));

const { PirateShips } = await import("./PirateShips");

function finding(i: number, severity: Severity): Finding {
  return {
    id: `GHSA-${i}`,
    summary: "s",
    severity,
    package: `pkg${i}`,
    installed: "1.0.0",
    fixed_in: "1.0.1",
    lockfile: "package-lock.json",
    url: "https://osv.dev",
  };
}

function report(over: Partial<RaidReport> = {}): RaidReport {
  return {
    root: "/r",
    scanned_at: 0,
    scanner: "osv-scanner",
    covered: ["package-lock.json"],
    uncovered: [],
    status: { kind: "clean" },
    stale: false,
    ...over,
  };
}

const SEVERITIES: Severity[] = ["critical", "high", "high", "high", "moderate", "moderate", "low", "unknown", "low"];
const raided = (stale = false) =>
  report({ stale, status: { kind: "raided", findings: SEVERITIES.map((s, i) => finding(i, s)) } });

function render(r: RaidReport | undefined, opacity?: number) {
  return renderToStaticMarkup(
    <PirateShips cx={0} cz={0} landW={20} landD={16} root="/r" report={r} previous={undefined} waterY={-0.5} onClick={() => {}} opacity={opacity} />,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("PirateShips", () => {
  it("renders_one_ship_per_finding_capped_with_badge", () => {
    const html = render(raided());
    expect(count(html, 'name="pirate-ship"')).toBe(6);
    expect(html).toContain("+3");
  });

  it("no_flag_no_smoke_when_stale", () => {
    // Fresh: a critical smokes; a fresh clean scan flies the flag.
    expect(render(raided())).toContain('name="raid-smoke"');
    expect(render(report())).toContain('name="raid-flag"');
    // Stale: neither — we no longer know the lockfiles still say that.
    const staleRaided = render(raided(true));
    expect(staleRaided).not.toContain('name="raid-smoke"');
    expect(staleRaided).not.toContain('name="raid-flag"');
    expect(render(report({ stale: true }))).not.toContain('name="raid-flag"');
    // Stale findings still sail (they were real), just in grey.
    expect(count(staleRaided, 'name="pirate-ship"')).toBe(6);
  });

  it("draws nothing for an unscouted or missing report", () => {
    expect(render(undefined)).toBe("");
    expect(render(report({ status: { kind: "unscouted", reason: "no lockfile" } }))).toBe("");
  });

  it("recedes with its island when a filter dims it", () => {
    expect(render(raided())).not.toContain('opacity="0.5"');
    const dimmed = render(raided(), 0.5);
    // Every hull, mast and sail material, and the "+N" badge.
    expect(count(dimmed, 'opacity="0.5"')).toBeGreaterThanOrEqual(6 * 3);
    expect(dimmed).toContain("opacity:0.5");
    expect(render(report(), 0.5)).toContain('opacity="0.5"'); // the flag
  });

  it("never forces the render loop awake", () => {
    render(raided());
    const invalidate = vi.fn();
    for (const cb of captured) cb({ clock: { elapsedTime: 1.3 }, invalidate });
    expect(captured.length).toBeGreaterThan(0);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
