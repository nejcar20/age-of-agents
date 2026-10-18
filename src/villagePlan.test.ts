import { describe, expect, it } from "vitest";
import { islandMask, terrainHeight } from "./terrain";
import { villageAgentSlots, villagePlan } from "./villagePlan";

describe("villagePlan", () => {
  it("keeps roofs separated and every building on dry land, including narrow and dense islands", () => {
    for (const seed of ["AgeOfAgents", "harbor-api", "fieldnotes", "tiny-tools"]) {
      for (const [w, d, count] of [[12, 12, 1], [45, 70, 7], [20, 95, 24]]) {
        const { houses } = villagePlan(seed, w, d, count, 0.34, 1.2);
        expect(houses).toHaveLength(count * 5);
        for (const h of houses) {
          for (const dx of [-h.width * 0.57, h.width * 0.57]) {
            for (const dz of [-h.depth * 0.57, h.depth * 0.57]) {
              expect(islandMask(seed, (h.x + dx) / w * 2 - 1, (h.z + dz) / d * 2 - 1)).toBeGreaterThanOrEqual(0.65);
            }
          }
          expect(h.groundY).toBeCloseTo(terrainHeight(seed, h.x / w * 2 - 1, h.z / d * 2 - 1, 0.34, 1.2));
          for (const other of houses) {
            if (h === other) continue;
            const separatedX = Math.abs(h.x - other.x) > (h.width + other.width) * 0.57;
            const separatedZ = Math.abs(h.z - other.z) > (h.depth + other.depth) * 0.57;
            expect(separatedX || separatedZ).toBe(true);
          }
        }
      }
    }
  });

  it("is stable across refreshes", () => {
    expect(villagePlan("repo", 12, 12, 3, 0.34, 1.2)).toEqual(villagePlan("repo", 12, 12, 3, 0.34, 1.2));
  });

  it("keeps agent markers out of the final contracted village", () => {
    for (const count of [1, 7, 17, 24]) {
      const { houses } = villagePlan("repo0", 12, 12, count, 0.52, 1.8);
      const slots = villageAgentSlots("repo0", 12, 12, houses);
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        expect(islandMask("repo0", slot.x / 6 - 1, slot.z / 6 - 1)).toBeGreaterThanOrEqual(0.9);
        for (const h of houses) {
          expect(Math.abs(h.x - slot.x) > h.width * 0.57 || Math.abs(h.z - slot.z) > h.depth * 0.57).toBe(true);
        }
      }
    }
  });
});
