import { describe, expect, it } from "vitest";
import { MODE_ISLAND, MODE_OPEN, MODE_RECT, waterShelfQuadCovers } from "./Water";
import { MASK_BASE_RADIUS, MASK_PLOT_INSET, MASK_HARMONICS, maskBoundary, maskPhases } from "../terrain";

/**
 * Scenery-craft round. Two things about the water are worth a test rather
 * than a comment, because getting either wrong brings back a defect this
 * round exists to remove and neither shows up in a wide screenshot until
 * someone happens to look at the right island.
 *
 * 1. A shelf quad that is too small for its own shoreness falloff leaves a
 *    visible hard-edged rectangle around an island. That is exactly what
 *    the "before" renders show, and what an earlier round already believed
 *    it had fixed once.
 * 2. The shader evaluates `terrain.ts`'s coastline curve itself, in GLSL,
 *    from constants this module imports. If those constants stopped
 *    describing the real curve, the surf line would drift off the actual
 *    shore — the `GRID_PITCH` class of bug (`phase-0-followups.md` §6).
 */
describe("water shelf coverage", () => {
  it("the shipped quad size covers the shipped shelf reach, for every seed", () => {
    // The two values `IslandShallows` actually ships with.
    expect(waterShelfQuadCovers(2.0, 1.42)).toBe(true);
  });

  it("rejects a quad that a seeded coastline's widest wobble could out-reach", () => {
    // The widest boundary is `MASK_BASE_RADIUS * (1 + all three harmonics)`
    // ≈ 1.34, so a quad of 1.0 half-extents cannot even contain the shore
    // itself at that angle, let alone a shelf reaching past it.
    expect(waterShelfQuadCovers(1.0, 1.42)).toBe(false);
    expect(waterShelfQuadCovers(2.0, 1.6)).toBe(false);
  });

  it("is monotone in both directions — a bigger quad never covers less", () => {
    expect(waterShelfQuadCovers(2.5, 1.42)).toBe(true);
    expect(waterShelfQuadCovers(2.0, 1.2)).toBe(true);
  });

  it("the three modes are distinct (the GLSL mirrors these exact values)", () => {
    expect(new Set([MODE_OPEN, MODE_ISLAND, MODE_RECT]).size).toBe(3);
  });
});

describe("the coastline constants the water shader reproduces", () => {
  it("rebuild `maskBoundary` exactly, which is what the GLSL does", () => {
    // The shader has no function call available — it inlines
    // `MASK_BASE_RADIUS` and `MASK_HARMONICS` and takes the phases as a
    // uniform. This asserts that doing so really does reproduce
    // `maskBoundary`, so the surf line lands on the same coastline the
    // terrain mesh is shaped by rather than near it.
    for (const seed of ["/a/repo", "/Users/x/Projects/pocketAlarm", "zzz"]) {
      const [p1, p2, p3] = maskPhases(seed);
      const [a1, a2, a3] = MASK_HARMONICS;
      for (let angle = -3; angle < 3.2; angle += 0.37) {
        const inlined =
          MASK_BASE_RADIUS *
          (1 + a1 * Math.sin(2 * angle + p1) + a2 * Math.sin(3 * angle + p2) + a3 * Math.sin(5 * angle + p3));
        const plotLimit = MASK_PLOT_INSET / Math.pow(Math.cos(angle) ** 4 + Math.sin(angle) ** 4, 0.25);
        expect(Math.min(inlined, plotLimit)).toBeCloseTo(maskBoundary(seed, angle), 12);
      }
    }
  });

  it("gives every seed its own phases, deterministically", () => {
    expect(maskPhases("a")).toEqual(maskPhases("a"));
    expect(maskPhases("a")).not.toEqual(maskPhases("b"));
  });
});
