// @vitest-environment node
//
// r3f components can't be mounted through a real `<Canvas>` in this
// project's test environment (no WebGL, no `@react-three/test-renderer`
// dependency) — so these tests exercise the ACTUAL `useFrame` callbacks the
// components register, captured via a partial mock of `@react-three/fiber`
// (everything else — `Canvas`, `useThree`, ... — stays real), and invoked
// directly with a fake per-frame `state`. `renderToStaticMarkup` (not
// `@testing-library/react`) is what lets this happen with zero DOM/WebGL: it
// never attaches refs (no commit phase exists in static SSR), so every
// `if (mesh) {...}`/`if (poleRef.current) {...}` guard these components
// already have skips its ref-touching body safely, leaving exactly the
// per-frame side effect under test (does this callback call `invalidate`)
// isolated from everything else the component does.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useFrame } from "@react-three/fiber";

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

const { buildAttentionHaloGeometry, IgnitionPulse, StoppedBeacon, StoppedHalo, WorkingHalo } =
  await import("./Archipelago");

const LAND = { w: 40, d: 40 };

/**
 * CRITICAL 2 (Opus frontend review): `IgnitionPulse`/`StoppedBeacon`/
 * `StoppedHalo` used to call `invalidate()` UNCONDITIONALLY on every tick —
 * under r3f 9.7 that is self-sustaining (`invalidate()` sets
 * `internal.frames = 2`, the render loop's own `update()` decrements it to
 * 1, and the very frame this callback runs in sets it back to 2), which
 * defeats `frameloop="demand"` entirely: with even one agent stopped, the
 * sea keeps rendering at 60fps forever, focused or not. `useWindowFocused`
 * correctly flips `App.tsx`'s `frameloop` prop; nothing here ever obeyed it.
 *
 * The fix (`TownView`'s own `AnimatedWater` already proves the pattern,
 * referenced by each component's own doc comment): a plain `useFrame` with
 * no explicit `invalidate()` call at all, so a tick only ever actually runs
 * while r3f's OWN `frameloop="always"` is already pumping frames — exactly
 * the focused-only authorization this component must respect, with no
 * separate gating logic of its own.
 */
describe("the sea's attention effects never force the render loop awake", () => {
  it("IgnitionPulse's per-frame callback never calls invalidate()", () => {
    renderToStaticMarkup(<IgnitionPulse land={LAND} />);
    const cb = captured[captured.length - 1];
    const invalidate = vi.fn();
    cb({ clock: { elapsedTime: 0.3 }, invalidate });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("StoppedBeacon's per-frame callback never calls invalidate()", () => {
    renderToStaticMarkup(<StoppedBeacon land={LAND} dim={false} />);
    const cb = captured[captured.length - 1];
    const invalidate = vi.fn();
    cb({ clock: { elapsedTime: 1.7 }, invalidate });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("StoppedHalo's per-frame callback never calls invalidate()", () => {
    renderToStaticMarkup(<StoppedHalo land={LAND} dim={false} />);
    const cb = captured[captured.length - 1];
    const invalidate = vi.fn();
    cb({ clock: { elapsedTime: 2.1 }, invalidate });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("WorkingHalo's per-frame callback never calls invalidate()", () => {
    renderToStaticMarkup(<WorkingHalo land={LAND} dim={false} />);
    const cb = captured[captured.length - 1];
    const invalidate = vi.fn();
    cb({ clock: { elapsedTime: 2.1 }, invalidate });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("proves the harness itself can detect the bug: a component that DOES call invalidate() fails this assertion", () => {
    // A deliberately-buggy stand-in, same shape as the old code, so this
    // suite is not silently vacuous (e.g. because `captured` never actually
    // received a callback).
    function BuggyPulse() {
      useFrame((state: unknown) => {
        (state as FakeFrameState).invalidate();
      });
      return null;
    }
    renderToStaticMarkup(<BuggyPulse />);
    const cb = captured[captured.length - 1];
    const invalidate = vi.fn();
    cb({ clock: { elapsedTime: 0 }, invalidate });
    expect(invalidate).toHaveBeenCalled();
  });
});

/**
 * Halo-and-camera round, item 1. `StoppedHalo` is half of "this agent
 * stopped and needs you" — the single most important signal in the product
 * — and the scenery-craft round's new deep blue sea turned it into a pale
 * grey-green disc, because ADDING amber to a mid-luminance blue raises R
 * and G and leaves B alone. The fix is normal-alpha blending plus a radial
 * alpha profile, which is what this geometry carries.
 *
 * Two of these guard things that fail SILENTLY rather than loudly, which is
 * the only reason a unit test earns its place next to a render: a `color`
 * attribute that stopped being 4-wide would compile without
 * `USE_COLOR_ALPHA` and flatten the whole cue back to a solid disc, and an
 * outer alpha that stopped reaching exactly zero would put a hard circular
 * edge back in the water. Neither throws; both just look wrong.
 */
describe("buildAttentionHaloGeometry", () => {
  const INNER = 20;
  const RIM = 24;
  const OUTER = 50;
  const geometry = buildAttentionHaloGeometry({ inner: INNER, rim: RIM, outer: OUTER, segments: 16 });
  const color = geometry.getAttribute("color");
  const position = geometry.getAttribute("position");

  function radiusAt(i: number): number {
    return Math.hypot(position.getX(i), position.getY(i));
  }

  it("carries per-vertex ALPHA — a 4-component color attribute, which is what three.js compiles as USE_COLOR_ALPHA", () => {
    expect(color.itemSize).toBe(4);
  });

  it("is fully opaque across the rim and exactly transparent at its own outer edge", () => {
    for (let i = 0; i < color.count; i++) {
      const r = radiusAt(i);
      if (Math.abs(r - RIM) < 1e-6) expect(color.getW(i)).toBe(1);
      if (Math.abs(r - OUTER) < 1e-6) expect(color.getW(i)).toBe(0);
    }
  });

  it("never reaches inside the island — no vertex is closer than `inner`", () => {
    for (let i = 0; i < position.count; i++) {
      expect(radiusAt(i)).toBeGreaterThanOrEqual(INNER - 1e-6);
    }
  });

  it("falls off monotonically from the rim outward, so there is no second visible edge", () => {
    const byRadius = new Map<number, number>();
    for (let i = 0; i < color.count; i++) {
      byRadius.set(Math.round(radiusAt(i) * 1e4) / 1e4, color.getW(i));
    }
    const radii = [...byRadius.keys()].filter((r) => r >= RIM).sort((a, b) => a - b);
    expect(radii.length).toBeGreaterThan(2);
    for (let i = 1; i < radii.length; i++) {
      expect(byRadius.get(radii[i])!).toBeLessThan(byRadius.get(radii[i - 1])!);
    }
  });

  it("is a closed annulus — every ring shares the seam vertex position", () => {
    const rings = position.count / 17; // segments + 1 columns per ring
    expect(Number.isInteger(rings)).toBe(true);
    for (let r = 0; r < rings; r++) {
      const first = r * 17;
      const last = first + 16;
      expect(position.getX(last)).toBeCloseTo(position.getX(first), 6);
      expect(position.getY(last)).toBeCloseTo(position.getY(first), 6);
    }
  });

  it("degenerates safely when `rim` is clamped to `outer` (a tiny island)", () => {
    expect(() =>
      buildAttentionHaloGeometry({ inner: 5, rim: 12, outer: 12, segments: 8 }),
    ).not.toThrow();
  });
});
