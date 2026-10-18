import { describe, expect, it } from "vitest";
import { scatterVegetation } from "./vegetation";

const ALWAYS_LAND = () => 1;

describe("scatterVegetation", () => {
  it("is deterministic for the same identity/bounds", () => {
    const a = scatterVegetation("repo-a", 40, 30, ALWAYS_LAND);
    const b = scatterVegetation("repo-a", 40, 30, ALWAYS_LAND);
    expect(b).toEqual(a);
  });

  it("varies with identity (different repos get a different layout)", () => {
    const a = scatterVegetation("repo-a", 40, 30, ALWAYS_LAND);
    const b = scatterVegetation("repo-b", 40, 30, ALWAYS_LAND);
    expect(b).not.toEqual(a);
  });

  it("produces a non-trivial number of instances on open land", () => {
    const instances = scatterVegetation("repo-a", 40, 30, ALWAYS_LAND);
    expect(instances.length).toBeGreaterThan(20);
  });

  it("never places anything where the land mask says unsafe", () => {
    const instances = scatterVegetation("repo-a", 40, 30, () => 0);
    expect(instances).toHaveLength(0);
  });

  it("respects a land mask that is only safe in one half of the rectangle", () => {
    const instances = scatterVegetation("repo-a", 40, 30, (u) => (u < 0 ? 1 : 0));
    expect(instances.length).toBeGreaterThan(0);
    for (const inst of instances) {
      expect(inst.x).toBeLessThan(20); // left half only, in world space
    }
  });

  it("never places anything inside an exclusion circle", () => {
    const exclusions = [{ x: 20, z: 15, radius: 8 }];
    const instances = scatterVegetation("repo-a", 40, 30, ALWAYS_LAND, exclusions);
    for (const inst of instances) {
      const dx = inst.x - 20;
      const dz = inst.z - 15;
      expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(8);
    }
  });

  it("keeps every instance within the given rectangle", () => {
    const instances = scatterVegetation("repo-a", 40, 30, ALWAYS_LAND);
    for (const inst of instances) {
      expect(inst.x).toBeGreaterThanOrEqual(0);
      expect(inst.x).toBeLessThanOrEqual(40);
      expect(inst.z).toBeGreaterThanOrEqual(0);
      expect(inst.z).toBeLessThanOrEqual(30);
    }
  });

  it("is a mix of trees and rocks, mostly trees", () => {
    const instances = scatterVegetation("a-fairly-large-repo-name", 60, 60, ALWAYS_LAND);
    const trees = instances.filter((i) => i.kind === "tree").length;
    const rocks = instances.filter((i) => i.kind === "rock").length;
    expect(trees).toBeGreaterThan(0);
    expect(rocks).toBeGreaterThan(0);
    expect(trees).toBeGreaterThan(rocks);
  });

  it("returns nothing for a zero-size rectangle", () => {
    expect(scatterVegetation("repo-a", 0, 0, ALWAYS_LAND)).toEqual([]);
  });

  it("caps the instance count regardless of how large the rectangle is (frame-cost bound)", () => {
    const instances = scatterVegetation("repo-a", 400, 400, ALWAYS_LAND);
    expect(instances.length).toBeLessThanOrEqual(260);
  });

  // I5 (Opus frontend review): the cap used to be enforced as a `break` in
  // row-major order, so every candidate past the 260th (the rest of that
  // row, and every row after it) was silently dropped — a large island drew
  // with a contiguous BARE BAND on one side, which read as a rendering bug
  // but was actually decoration (vegetation coverage) encoding data (how big
  // the island's land is). The fix must thin evenly, so every quarter of a
  // capped, oversized rectangle still has some vegetation.
  it("spreads the cap evenly across the whole rectangle instead of leaving a bare band (I5)", () => {
    const instances = scatterVegetation("a-very-large-repo", 300, 300, ALWAYS_LAND);
    expect(instances.length).toBe(260);
    const quarters = [0, 0, 0, 0];
    for (const inst of instances) {
      const q = Math.min(3, Math.floor((inst.z / 300) * 4));
      quarters[q]++;
    }
    for (const count of quarters) {
      expect(count).toBeGreaterThan(0);
    }
  });

  it("density does not scale with an unrelated 'repo size' input — only real geometry changes the count", () => {
    // Same rectangle, same identity: whatever a caller believes about "how
    // big" the repo is must have no channel into this function at all — it
    // isn't even a parameter. This test exists to make that structural fact
    // explicit rather than merely implicit in the function's signature.
    const small = scatterVegetation("same-repo", 40, 30, ALWAYS_LAND);
    const alsoSmall = scatterVegetation("same-repo", 40, 30, ALWAYS_LAND);
    expect(small).toEqual(alsoSmall);
  });
});
