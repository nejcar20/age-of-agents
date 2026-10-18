// Pure placement math for decorative vegetation (art-direction round, item
// 5). Kept separate from any `.tsx`/THREE.js rendering code — same
// "testable without WebGL/DOM" convention `terrain.ts` already established
// — so the placement RULE itself (not just its visual result) has direct
// unit tests.
//
// The coordinator's explicit ruling for this item: "decorative vegetation is
// scenery (same category as grass/water) — trees/rocks ARE allowed since a
// tree is unmistakably not a building. But it must not encode anything —
// keep density uniform per unit of unbuilt land; if vegetation varies by any
// property of the repo, that's the city inventing information and must
// stop." Concretely, that means:
//
//   - `PLACEMENT_CHANCE`, `CELL_SIZE`, `ROCK_CHANCE`, the scale range, etc.
//     are all fixed module constants — never a parameter derived from a
//     repository's own properties (district count, line count, building
//     count, ...). The SAME constants apply to every island/town, always.
//   - The only per-call INPUT that varies is `identity` (a repo's/island's
//     own root path — "which repo," never "how big/complex is it," the same
//     convention `terrain.ts`'s own module doc comment already established)
//     plus the purely geometric `width`/`depth`/`landMaskAt`/`exclusions` —
//     none of which encode anything beyond "where is dry, unbuilt land."
//   - `identity` only makes the RESULT deterministic/reproducible (the same
//     repo gets the same tree layout on every render, rather than visibly
//     reshuffling); it is never read for its length, hash magnitude, or any
//     other stand-in for "how much code is here."
import { hashString } from "./city";

export type VegetationExclusion = { x: number; z: number; radius: number };

export type VegetationInstance = {
  x: number;
  z: number;
  /** Normalized position, same convention as `terrain.ts` (`u = (x -
   * width/2) / (width/2)`) — callers sample their own height/mask functions
   * with this rather than re-deriving it. */
  u: number;
  v: number;
  kind: "tree" | "rock";
  scale: number;
  rotationY: number;
};

/** Spacing of the placement grid, in world units — a FIXED density knob,
 * the same for every repo/island, never scaled by content. */
const CELL_SIZE = 2.2;
/** Fixed fraction of grid cells that get anything at all — "uniform density
 * per unit of unbuilt land." */
const PLACEMENT_CHANCE = 0.4;
/** How far a placement can drift from its own cell's centre, as a fraction
 * of `CELL_SIZE` — enough to avoid a visibly regular grid without ever
 * drifting into a neighbouring cell. */
const JITTER_FRACTION = 0.7;
/** Fixed fraction of placements that become a rock rather than a tree. */
const ROCK_CHANCE = 0.25;
const SCALE_MIN = 0.75;
const SCALE_MAX = 1.3;
/** `islandMask`/`safeDomeHeight` both reach 0 well before their own edge
 * midpoint; this keeps vegetation off the beach/foam band and the very
 * flattened rim, matching where `buildTerrainGeometry` itself still calls
 * the ground "land" rather than shoreline. */
const LAND_SAFE_MASK = 0.62;
/**
 * A hard cap, purely for frame cost — NOT a density knob (see this module's
 * own doc comment: density is `PLACEMENT_CHANCE` alone).
 *
 * I5 (Opus frontend review): this used to be enforced as a `break` the
 * moment `out.length` reached it, in row-major (`gz` outer, `gx` inner)
 * iteration order — so on a large island, every candidate past that point
 * (the rest of that row, and every row after it) was silently dropped,
 * leaving a contiguous BARE BAND on one side. That reads as a rendering bug,
 * but it is actually decoration encoding data: a large island's vegetation
 * coverage became a readable proxy for "this is a big repository," exactly
 * the kind of fact a scenery layer must never carry (see this module's own
 * ruling above). The fix collects every valid candidate first, then — only
 * if there are more than the cap — deterministically thins them evenly
 * across the WHOLE list rather than truncating a tail, so the cap still
 * costs nothing extra to compute but no longer draws a lopsided island.
 */
const MAX_INSTANCES = 260;

/**
 * Every candidate point in a `width` x `depth` rectangle (grid-based, one
 * candidate per `CELL_SIZE` cell, jittered), filtered down to points that
 * are (a) rolled "placed" by this exact cell's own deterministic hash, (b)
 * on safe dry land per `landMaskAt`, and (c) outside every exclusion circle
 * (buildings, pads, roads — real occupied ground vegetation must not grow
 * through). Above `MAX_INSTANCES`, thinned evenly across the whole
 * rectangle (see that constant's own doc comment) rather than truncated.
 */
export function scatterVegetation(
  identity: string,
  width: number,
  depth: number,
  landMaskAt: (u: number, v: number) => number,
  exclusions: VegetationExclusion[] = [],
): VegetationInstance[] {
  const candidates: VegetationInstance[] = [];
  if (width <= 0 || depth <= 0) return candidates;
  const cols = Math.max(1, Math.floor(width / CELL_SIZE));
  const rows = Math.max(1, Math.floor(depth / CELL_SIZE));

  for (let gz = 0; gz < rows; gz++) {
    for (let gx = 0; gx < cols; gx++) {
      const hash = hashString(`${identity}#veg#${gx}_${gz}`);
      if ((hash % 1000) / 1000 >= PLACEMENT_CHANCE) continue;

      const jitterX = (((hash >>> 8) & 0xff) / 255 - 0.5) * JITTER_FRACTION * CELL_SIZE;
      const jitterZ = (((hash >>> 16) & 0xff) / 255 - 0.5) * JITTER_FRACTION * CELL_SIZE;
      const x = Math.min(width, Math.max(0, gx * CELL_SIZE + CELL_SIZE / 2 + jitterX));
      const z = Math.min(depth, Math.max(0, gz * CELL_SIZE + CELL_SIZE / 2 + jitterZ));
      const u = (x - width / 2) / (width / 2);
      const v = (z - depth / 2) / (depth / 2);

      if (landMaskAt(u, v) < LAND_SAFE_MASK) continue;

      let excluded = false;
      for (const ex of exclusions) {
        const dx = x - ex.x;
        const dz = z - ex.z;
        if (dx * dx + dz * dz < ex.radius * ex.radius) {
          excluded = true;
          break;
        }
      }
      if (excluded) continue;

      const kind: "tree" | "rock" = ((hash >>> 24) & 0xff) / 255 < ROCK_CHANCE ? "rock" : "tree";
      const scale = SCALE_MIN + (((hash >>> 4) & 0xf) / 15) * (SCALE_MAX - SCALE_MIN);
      const rotationY = ((hash % 360) / 360) * Math.PI * 2;
      candidates.push({ x, z, u, v, kind, scale, rotationY });
    }
  }

  if (candidates.length <= MAX_INSTANCES) return candidates;

  // Evenly-spaced sampling across the full candidate list (still in the
  // same deterministic row-major order) rather than a contiguous slice —
  // this is what turns "one bare band" into "slightly sparser everywhere,"
  // with no information about island size encoded in WHERE it's sparser.
  const out: VegetationInstance[] = [];
  const step = candidates.length / MAX_INSTANCES;
  for (let i = 0; i < MAX_INSTANCES; i++) {
    out.push(candidates[Math.floor(i * step)]);
  }
  return out;
}
