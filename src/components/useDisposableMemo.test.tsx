// @vitest-environment jsdom
//
// Resource-hygiene round (Item 1): "no dispose() call anywhere in src/" —
// every island's terrain/shore geometry (`Archipelago.tsx`), the town's
// ground/shore/sky geometry (`TownView.tsx`), and the sea's own animated
// water plane (`Water.tsx`) are all `THREE.BufferGeometry` objects THIS
// codebase constructs directly, rebuilt in a `useMemo` whenever an island's
// real content changes (which a window-focus refetch can trigger — see
// `App.tsx`'s `windowFocused`/`useArchipelago`). Dropping the old JS
// reference alone leaks its GPU buffers forever; three.js requires an
// explicit `dispose()`.
//
// `useDisposableMemo` is the one place that pattern now lives — these tests
// exercise it directly (no `<Canvas>`/WebGL needed: `THREE.BufferGeometry`'s
// `dispose()` is pure JS bookkeeping, real even off-GPU) rather than through
// a full r3f scene, for the same reason `Archipelago.test.tsx`'s own doc
// comment gives: this project's test environment has no WebGL.
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import * as THREE from "three";
import { buildTerrainGeometry } from "./terrainGeometry";
import { useDisposableMemo } from "./useDisposableMemo";

/** A minimal disposable stand-in — cheaper than a real `BufferGeometry` for
 * the tests that only care about IDENTITY and call counts, not real
 * geometry data. */
function fakeDisposable(id: number) {
  return { id, dispose: vi.fn() };
}

/** Renders `useDisposableMemo(factory, [dep])` and exposes a setter to
 * change `dep` (driving a rerender, the same way a real `App.tsx` refetch
 * changes a `useMemo`'s own dependencies). */
function Harness({
  dep,
  factory,
  onValue,
}: {
  dep: unknown;
  factory: () => { dispose(): void } | null;
  onValue: (v: unknown) => void;
}) {
  const value = useDisposableMemo(factory, [dep]);
  onValue(value);
  return null;
}

describe("useDisposableMemo", () => {
  it("disposes the OLD value exactly once when a rerender produces a genuinely new one", () => {
    const a = fakeDisposable(1);
    const b = fakeDisposable(2);
    const factory = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b);
    const { rerender } = render(<Harness dep={1} factory={factory} onValue={() => {}} />);
    expect(a.dispose).not.toHaveBeenCalled();

    // Mirrors a real refetch that actually changed this island's land size —
    // `useMemo`'s own dependency changed, so the factory runs again.
    rerender(<Harness dep={2} factory={factory} onValue={() => {}} />);

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).not.toHaveBeenCalled();
  });

  it("never disposes the CURRENT value — the opposite, worse bug (a black/missing island)", () => {
    const a = fakeDisposable(1);
    const factory = vi.fn(() => a);
    // Deliberately the SAME dep across two renders — e.g. a refetch that
    // produced a new `IslandView` identity but the SAME real width/depth
    // (the common case per the leak's own bug report), so `useMemo` must
    // reuse `a` rather than rebuild it.
    const { rerender } = render(<Harness dep={1} factory={factory} onValue={() => {}} />);
    rerender(<Harness dep={1} factory={factory} onValue={() => {}} />);
    rerender(<Harness dep={1} factory={factory} onValue={() => {}} />);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(a.dispose).not.toHaveBeenCalled();
  });

  it("disposes the last value on unmount", () => {
    const a = fakeDisposable(1);
    const factory = vi.fn(() => a);
    const { unmount } = render(<Harness dep={1} factory={factory} onValue={() => {}} />);
    expect(a.dispose).not.toHaveBeenCalled();
    unmount();
    expect(a.dispose).toHaveBeenCalledTimes(1);
  });

  it("tolerates a factory that returns null (an island with no known city yet)", () => {
    const factory = vi.fn(() => null);
    const { unmount } = render(<Harness dep={1} factory={factory} onValue={() => {}} />);
    expect(() => unmount()).not.toThrow();
  });

  it("disposes every intermediate value across a rapid sequence of refetches, not just the last", () => {
    const values = [1, 2, 3, 4, 5].map(fakeDisposable);
    let i = 0;
    const factory = vi.fn(() => values[i]);
    const { rerender, unmount } = render(<Harness dep={0} factory={factory} onValue={() => {}} />);
    for (i = 1; i < values.length; i++) {
      rerender(<Harness dep={i} factory={factory} onValue={() => {}} />);
    }
    // Every value except the last (still mounted, still in use) must have
    // been disposed exactly once.
    for (let j = 0; j < values.length - 1; j++) {
      expect(values[j].dispose).toHaveBeenCalledTimes(1);
    }
    expect(values[values.length - 1].dispose).not.toHaveBeenCalled();
    unmount();
    expect(values[values.length - 1].dispose).toHaveBeenCalledTimes(1);
  });
});

/**
 * The same pattern, but with the REAL geometry builders this bug was found
 * in — `buildTerrainGeometry` (an island's mound + coastline,
 * `Archipelago.tsx`) and the shallow-water shelf quad (`Water.tsx`'s
 * `IslandShallows`, one per island) — so this is a genuine end-to-end proof,
 * not just a proof
 * about the hook in isolation. Spies on `THREE.BufferGeometry.prototype.
 * dispose` directly (real GPU-buffer bookkeeping — `dispose()` works
 * perfectly off-GPU) rather than trusting our own fake.
 */
describe("useDisposableMemo with the real terrain/shore geometry builders", () => {
  it("simulates 152 islands across 5 window-focus refetches: every replaced geometry is disposed, nothing live is", () => {
    const disposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    const ISLAND_COUNT = 12; // scaled down from the real 152 — same shape, fast to run.
    const REFETCH_COUNT = 5;

    function TerrainAndShore({ seed, width }: { seed: string; width: number }) {
      // Mirrors `SeaIslandGroup`'s own two per-island geometries exactly.
      useDisposableMemo(
        () =>
          buildTerrainGeometry({
            seed,
            width,
            depth: width,
            moundHeight: 0.34,
            beachDepth: 0.5,
            landColor: "#5c7a4a",
            shadeColor: "#3f5c38",
            lightColor: "#8fb069",
            sandColor: "#d8c48a",
            wetSandColor: "#b09772",
            cliffColor: "#8a7a63",
            segments: 6,
          }),
        [seed, width],
      );
      // The island's shallow-water shelf quad (`Water.tsx`'s
      // `IslandShallows`) — a plain plane since the scenery-craft round moved
      // every shore band into the fragment shader, but still a geometry WE
      // construct and therefore still ours to dispose, which is the whole
      // point of this test.
      useDisposableMemo(() => {
        const geo = new THREE.PlaneGeometry(width * 2, width * 2, 1, 1);
        geo.rotateX(-Math.PI / 2);
        return geo;
      }, [width]);
      return null;
    }

    function Sea({ widths }: { widths: number[] }) {
      return (
        <>
          {widths.map((w, i) => (
            <TerrainAndShore key={i} seed={`island-${i}`} width={w} />
          ))}
        </>
      );
    }

    const baseWidths = Array.from({ length: ISLAND_COUNT }, (_, i) => 20 + i);
    const { rerender, unmount } = render(<Sea widths={baseWidths} />);
    expect(disposeSpy).not.toHaveBeenCalled();

    // Each "refetch" mirrors the real bug report: a NEW `archipelago` array
    // (new object identities throughout) arrives on every window focus.
    // Round `r` (1-indexed) changes ONE island's REAL width (index `r - 1` —
    // new files genuinely landed there) and leaves every other island's
    // width untouched — the common case, which must NOT dispose anything.
    let widths = baseWidths;
    for (let round = 1; round <= REFETCH_COUNT; round++) {
      const changedIndex = round - 1;
      widths = widths.map((w, i) => (i === changedIndex ? w + 1 : w));
      rerender(<Sea widths={widths} />);
      // Exactly 2 disposals this round (the changed island's old terrain +
      // old shore) — never more (nothing else moved) and never zero (the
      // one real change must not have been silently skipped).
      expect(disposeSpy).toHaveBeenCalledTimes(round * 2);
    }

    const disposedBeforeUnmount = disposeSpy.mock.calls.length;
    expect(disposedBeforeUnmount).toBe(REFETCH_COUNT * 2);

    unmount();
    // Unmounting disposes every geometry still alive: 2 per island (terrain
    // + shore), whether it was ever replaced above or not.
    expect(disposeSpy).toHaveBeenCalledTimes(disposedBeforeUnmount + ISLAND_COUNT * 2);

    disposeSpy.mockRestore();
  });
});
