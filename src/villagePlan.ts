import { blockCenters, houseCluster, massingGridSize } from "./archipelago";
import { islandMask, terrainHeight } from "./terrain";

export type VillageHouse = {
  x: number; z: number; width: number; depth: number;
  height: number; groundY: number; colorSeed: number;
};
export type VillageLane = { x: number; z: number; width: number; depth: number; groundY: number; slopeX: number; slopeZ: number };

/** Candidate standing places must use the final buildings, after coastal contraction. */
export function villageAgentSlots(seed: string, w: number, d: number, houses: VillageHouse[]) {
  const slots: { x: number; z: number }[] = [];
  const clearance = Math.min(w, d) * 0.015;
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const x = (col + 0.5) / 9 * w;
      const z = (row + 0.5) / 9 * d;
      if (islandMask(seed, x / w * 2 - 1, z / d * 2 - 1) < 0.9) continue;
      if (houses.some(h => Math.abs(h.x - x) <= h.width * 0.57 + clearance && Math.abs(h.z - z) <= h.depth * 0.57 + clearance)) continue;
      slots.push({ x, z });
    }
  }
  return slots;
}

/** Decorative village massing. Block count still comes from measured districts.
 * Shrink the whole plan together until every roof fits the actual coastline:
 * clamping buildings individually would collapse neighbours into one another. */
export function villagePlan(seed: string, w: number, d: number, count: number, mound: number, beach: number) {
  if (count < 1) return { houses: [], lanes: [], pads: [] };
  const pitch = Math.min(w, d) / massingGridSize(count);
  const centers = blockCenters(w, d, count);
  const raw = centers.flatMap((c, i) => houseCluster(`${seed}#block${i}`).map(h => ({
    x: c.x + h.dx * pitch, z: c.z + h.dz * pitch,
    width: h.size * pitch, depth: h.size * pitch * (0.85 + (h.colorSeed % 3) * 0.1),
    height: h.size * pitch * h.heightFactor, colorSeed: h.colorSeed,
  })));
  const transform = (x: number, z: number, scale: number) => ({ x: w / 2 + (x - w / 2) * scale, z: d / 2 + (z - d / 2) * scale });
  let scale = 1;
  for (let attempt = 0; attempt < 50; attempt++) {
    const fits = raw.every(h => [-1, 1].every(sx => [-1, 1].every(sz => {
      const p = transform(h.x + sx * h.width * 0.66, h.z + sz * h.depth * 0.66, scale);
      return islandMask(seed, p.x / w * 2 - 1, p.z / d * 2 - 1) >= 0.7;
    })));
    if (fits) break;
    scale *= 0.94;
  }
  const ground = (x: number, z: number) => terrainHeight(seed, x / w * 2 - 1, z / d * 2 - 1, mound, beach);
  const houses: VillageHouse[] = raw.map(h => {
    const p = transform(h.x, h.z, scale);
    return { ...h, ...p, width: h.width * scale, depth: h.depth * scale, height: h.height * scale, groundY: ground(p.x, p.z) };
  });
  const pavingAt = (x: number, z: number, width: number, depth: number): VillageLane => ({
    x, z, width, depth, groundY: ground(x, z),
    slopeX: (ground(x + width / 2, z) - ground(x - width / 2, z)) / width,
    slopeZ: (ground(x, z + depth / 2) - ground(x, z - depth / 2)) / depth,
  });
  const lanes = centers.flatMap(c => {
    const p = transform(c.x, c.z, scale);
    return [
      pavingAt(p.x, p.z, pitch * scale * 0.09, pitch * scale * 0.64),
      pavingAt(p.x - pitch * scale * 0.125, p.z, pitch * scale * 0.34, pitch * scale * 0.065),
    ];
  });
  const pads = houses.map(h => {
    const size = Math.max(h.width, h.depth) * 1.25;
    return { ...pavingAt(h.x, h.z, size, size), size };
  });
  return { houses, lanes, pads };
}
