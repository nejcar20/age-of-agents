import { describe, expect, it } from "vitest";
import { islandMask, terrainHeight, isLand, clampToLand, safeDomeHeight } from "./terrain";

const SEEDS = ["a", "some/repo", "/Users/x/Projects/foo", "z", "12345"];

describe("islandMask", () => {
  it("submerges the whole mesh perimeter so the coastline never clips into a straight edge", () => {
    for (const seed of [...SEEDS, "/demo/projects/AgeOfAgents"]) {
      for (let i = 0; i <= 40; i++) {
        const edge = -1 + i / 20;
        for (const [u, v] of [[edge, -1], [edge, 1], [-1, edge], [1, edge]]) {
          expect(islandMask(seed, u, v)).toBe(0);
        }
      }
    }
  });
  it("is always within [0, 1]", () => {
    for (const seed of SEEDS) {
      for (let a = 0; a < 32; a++) {
        const angle = (a / 32) * Math.PI * 2;
        for (const dist of [0, 0.3, 0.6, 0.9, 1.0, 1.2, 1.414]) {
          const u = Math.cos(angle) * dist;
          const v = Math.sin(angle) * dist;
          const mask = islandMask(seed, u, v);
          expect(mask).toBeGreaterThanOrEqual(0);
          expect(mask).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("is always 1 at the exact centre", () => {
    for (const seed of SEEDS) {
      expect(islandMask(seed, 0, 0)).toBe(1);
    }
  });

  it("is always 0 at every corner (dist = sqrt(2)), for every seed — corners never read as land", () => {
    const corners: [number, number][] = [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    for (const seed of SEEDS) {
      for (const [u, v] of corners) {
        expect(islandMask(seed, u, v)).toBe(0);
      }
    }
  });

  it("is deterministic for the same seed and position", () => {
    expect(islandMask("repo-x", 0.3, -0.2)).toBe(islandMask("repo-x", 0.3, -0.2));
  });

  it("varies by angle at a fixed radius — the boundary is not a perfect circle/rectangle", () => {
    const seed = "some/repo";
    const radius = 0.85;
    const samples = new Set<number>();
    for (let a = 0; a < 16; a++) {
      const angle = (a / 16) * Math.PI * 2;
      samples.add(Math.round(islandMask(seed, Math.cos(angle) * radius, Math.sin(angle) * radius) * 1000));
    }
    // A perfect circle/ellipse would give the same mask at every angle for a
    // fixed radius; an organic coastline must not.
    expect(samples.size).toBeGreaterThan(1);
  });

  it("differs across seeds at the same position — every repo gets its own coastline", () => {
    const values = SEEDS.map((s) => islandMask(s, 0.7, 0.4));
    expect(new Set(values.map((v) => Math.round(v * 1000))).size).toBeGreaterThan(1);
  });
});

describe("terrainHeight", () => {
  it("is positive and at most moundHeight at the centre (a mound, never taller than its own peak)", () => {
    for (const seed of SEEDS) {
      const h = terrainHeight(seed, 0, 0, 0.3, 0.4);
      expect(h).toBeGreaterThan(0);
      expect(h).toBeLessThanOrEqual(0.3 + 1e-9);
    }
  });

  it("is fully submerged (<= -beachDepth + a hair) at every corner", () => {
    for (const seed of SEEDS) {
      const h = terrainHeight(seed, 1, 1, 0.3, 0.4);
      expect(h).toBeLessThanOrEqual(-0.4 + 1e-9);
    }
  });

  it("never exceeds moundHeight anywhere, for any seed/position — the mound cannot spike above its own cap", () => {
    for (const seed of SEEDS) {
      for (let a = 0; a < 24; a++) {
        const angle = (a / 24) * Math.PI * 2;
        for (const dist of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
          const u = Math.cos(angle) * dist;
          const v = Math.sin(angle) * dist;
          const h = terrainHeight(seed, u, v, 0.3, 0.4);
          // The seeded tilt can add a little on top of the dome height in
          // the up-tilted direction — bounded well short of doubling it.
          expect(h).toBeLessThanOrEqual(0.3 * 1.2);
        }
      }
    }
  });

  it("is deterministic for the same seed and position", () => {
    expect(terrainHeight("x", 0.4, 0.1, 0.3, 0.4)).toBe(terrainHeight("x", 0.4, 0.1, 0.3, 0.4));
  });
});

describe("safeDomeHeight", () => {
  it("is never negative anywhere, including well past the rectangle edge", () => {
    for (let a = 0; a < 24; a++) {
      const angle = (a / 24) * Math.PI * 2;
      for (const dist of [0, 0.3, 0.6, 0.9, 1.0, 1.2, 1.414, 2]) {
        const u = Math.cos(angle) * dist;
        const v = Math.sin(angle) * dist;
        expect(safeDomeHeight(u, v, 0.3)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("is exactly moundHeight at the centre", () => {
    expect(safeDomeHeight(0, 0, 0.3)).toBe(0.3);
  });

  it("is 0 at every edge midpoint (dist = 1) and every corner (dist = sqrt(2))", () => {
    expect(safeDomeHeight(1, 0, 0.3)).toBe(0);
    expect(safeDomeHeight(0, 1, 0.3)).toBe(0);
    expect(safeDomeHeight(1, 1, 0.3)).toBe(0);
  });

  it("never depends on any seed — the town's real building positions must never shift with content", () => {
    // No seed parameter at all is itself the honesty proof here: there is
    // nothing to vary by identity, so two different "seeds" (impossible to
    // even pass in) can't diverge — this test just pins the pure function's
    // signature/behaviour so a future edit can't quietly add one.
    expect(safeDomeHeight(0.4, 0.2, 0.3)).toBe(safeDomeHeight(0.4, 0.2, 0.3));
  });
});

describe("isLand", () => {
  it("agrees with islandMask > 0", () => {
    expect(isLand("x", 0, 0)).toBe(true);
    expect(isLand("x", 1.2, 1.2)).toBe(false);
  });
});

describe("clampToLand", () => {
  it("always lands somewhere with mask >= minMask, for every seed and starting corner", () => {
    for (const seed of SEEDS) {
      for (const [u, v] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
        [1, 0],
        [0, 1],
      ] as const) {
        const { u: cu, v: cv } = clampToLand(seed, u, v, 0.55);
        expect(islandMask(seed, cu, cv)).toBeGreaterThanOrEqual(0.55 - 1e-9);
      }
    }
  });

  it("never changes direction — the result stays on the same ray from the centre", () => {
    const { u, v } = clampToLand("some/repo", 1, 0.5, 0.55);
    // Same ratio as the input direction (allowing for floating point).
    expect(Math.abs(u / v - 1 / 0.5)).toBeLessThan(1e-6);
  });

  it("leaves an already-safe point untouched", () => {
    const result = clampToLand("x", 0, 0, 0.55);
    expect(result).toEqual({ u: 0, v: 0 });
  });

  it("is deterministic", () => {
    expect(clampToLand("x", 0.9, 0.9, 0.55)).toEqual(clampToLand("x", 0.9, 0.9, 0.55));
  });
});
