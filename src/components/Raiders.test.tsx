// @vitest-environment node
//
// Same harness as `PirateShips.test.tsx`: no WebGL here, so the scene is
// rendered with `renderToStaticMarkup` (r3f elements come out as plain tags
// with their props as attributes) and `useFrame` is captured rather than run
// by a real Canvas.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { raidColor, raiderGroups, type Finding, type RaidReport, type Severity } from "../raids";

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

const { Raiders } = await import("./Raiders");

function finding(i: number, severity: Severity, lockfile: string): Finding {
  return {
    id: `GHSA-${i}`,
    summary: "s",
    severity,
    package: `pkg${i}`,
    installed: "1.0.0",
    fixed_in: "1.0.1",
    lockfile,
    url: "https://osv.dev",
  };
}

function report(findings: Finding[], stale = false): RaidReport {
  return {
    root: "/r",
    scanned_at: 0,
    scanner: "osv-scanner",
    covered: [],
    uncovered: [],
    status: findings.length > 0 ? { kind: "raided", findings } : { kind: "clean" },
    stale,
  };
}

const BUILDINGS = new Set(["package.json", "src-tauri/Cargo.toml"]);
const POSITIONS = new Map([
  ["package.json", { x: 3, z: 4 }],
  ["src-tauri/Cargo.toml", { x: 11, z: 7 }],
]);
const COAST = { x: 20, z: 30 };

function render(r: RaidReport, stale = r.stale) {
  return renderToStaticMarkup(
    <Raiders groups={raiderGroups(r, BUILDINGS)} positions={POSITIONS} coast={COAST} stale={stale} onClick={() => {}} />,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

/** The `position` attribute of the group named `name`. */
function groupPosition(html: string, name: string): number[] {
  const match = new RegExp(`<group[^>]*name="${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"[^>]*>`).exec(html);
  expect(match, `group ${name}`).not.toBeNull();
  const pos = /position="([^"]+)"/.exec(match![0]);
  return pos![1].split(",").map(Number);
}

describe("Raiders", () => {
  it("one_group_per_manifest_anchored_to_its_building", () => {
    const html = render(
      report([
        finding(1, "high", "package-lock.json"),
        finding(2, "moderate", "package-lock.json"),
        finding(3, "low", "src-tauri/Cargo.lock"),
      ]),
    );
    expect(count(html, 'name="raiders:')).toBe(2);
    const [px, , pz] = groupPosition(html, "raiders:package.json");
    expect([px, pz]).toEqual([3, 4]);
    const [cx, , cz] = groupPosition(html, "raiders:src-tauri/Cargo.toml");
    expect([cx, cz]).toEqual([11, 7]);
    // One figure per finding (two at package.json, one at Cargo.toml),
    // tinted by each group's worst severity.
    expect(count(html, 'name="raider"')).toBe(3);
    expect(html).toContain(`color="${raidColor("high", false)}"`);
    expect(html).toContain(`color="${raidColor("low", false)}"`);
  });

  it("caps a group at five figures and greys a stale report", () => {
    const many = Array.from({ length: 9 }, (_, i) => finding(i, "critical", "package-lock.json"));
    const html = render(report(many, true));
    expect(count(html, 'name="raider"')).toBe(5);
    expect(html).toContain(`color="${raidColor("critical", true)}"`);
    expect(html).not.toContain(`color="${raidColor("critical", false)}"`);
  });

  it("unknown_manifest_gathers_at_coast", () => {
    const html = render(report([finding(1, "high", "web/yarn.lock")]));
    const [x, , z] = groupPosition(html, "raiders:web/package.json");
    expect([x, z]).toEqual([COAST.x, COAST.z]);
  });

  it("no_raiders_without_findings", () => {
    expect(render(report([]))).toBe("");
    const unscouted: RaidReport = { ...report([]), status: { kind: "unscouted", reason: "no lockfile" } };
    expect(render(unscouted)).toBe("");
  });

  it("never forces the render loop awake for the torch flicker", () => {
    captured.length = 0;
    render(report([finding(1, "high", "package-lock.json")]));
    const invalidate = vi.fn();
    for (const cb of captured) cb({ clock: { elapsedTime: 2.1 }, invalidate });
    expect(captured.length).toBeGreaterThan(0);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
