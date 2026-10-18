// Pure terrain-shaping math (art-direction round). Two complaints from the
// same coordinator review, solved by one mechanism:
//
//   "The island outlines are rounded rectangles... make coastlines
//   genuinely irregular and organic."
//   "The terrain is a flat slab. Islands need elevation: a gentle mound, a
//   beach sloping into the water... terrain height must never read as a
//   building."
//
// Rather than a hand-built polygon (which needs real triangulation), this
// is a HEIGHTMAP over the honest, real footprint rectangle: every point in
// [0,w]x[0,d] gets a height. Points near the rectangle's corners always sink
// below the waterline (hidden under the water plane already sitting there),
// which is what actually DRAWS the organic coastline — the visible land
// shape is wherever this function says "above water," not the rectangle's
// own edge. The footprint itself never changes: the mesh this feeds still
// spans the full real w x d, so "shaped within the honest footprint" (design
// inputs §3, reaffirmed by the coordinator for this exact round) holds by
// construction, not by clipping.
//
// Seeded by the caller's own real identity string (an island's root, same
// convention `houseCluster`/`tintFor`/`formFor` already use) — deterministic
// per repo, never literal random noise, and never a function of anything
// ABOUT the repo's content (line count, file count, language) — only of its
// identity string, the same "which repo" input `hashString` was always meant
// to take, never "how big/complex is it".

import { hashString } from "./city";

/**
 * A smooth, organic "how much land is here" mask, 0..1, for a point at
 * normalized offset `(u, v)` from a plot's centre — `u = (x - w/2) / (w/2)`,
 * `v = (z - d/2) / (d/2)`, so the plot's four corners sit at
 * `dist = sqrt(2) ≈ 1.414` and its edge midpoints at `dist = 1`.
 *
 * `boundary` (a fraction of that same normalized radius, angularly
 * modulated by three seeded sine harmonics) is where the mask reaches zero.
 * Tuned so it never exceeds ~1.08 at any angle — corners (at 1.414) are
 * therefore ALWAYS fully water, guaranteeing the mesh's own corners recede
 * regardless of seed, while edge midpoints (at 1.0) sit right around the
 * boundary, giving a scalloped, never-rectangular edge. `edgeWidth` softens
 * the 1/0 boundary into a smoothstep so the coastline has a real slope
 * (used as "beach" by `terrainHeight` below) rather than a cliff edge.
 */
/**
 * The three seeded phase angles that wobble a given island's coastline.
 *
 * Extracted from `islandMask` (scenery-craft round) for ONE reason: the
 * water's shore shelf is now drawn by a fragment shader
 * (`Water.tsx`/`waterMaterial.ts`) that has to find the very same coastline
 * `islandMask` traces, per pixel, so foam and the shallow bands hug the real
 * shore instead of a concentric circle roughly near it. Rather than
 * hand-copying three sine harmonics into GLSL and letting the two drift
 * apart (the exact `GRID_PITCH` mistake `phase-0-followups.md` §6 warns
 * about), both sides read their phases from here and from `MASK_HARMONICS`
 * below.
 */
export function maskPhases(seed: string): [number, number, number] {
  const h1 = hashString(`${seed}#coast1`);
  const h2 = hashString(`${seed}#coast2`);
  const h3 = hashString(`${seed}#coast3`);
  return [
    ((h1 % 1000) / 1000) * Math.PI * 2,
    ((h2 % 1000) / 1000) * Math.PI * 2,
    ((h3 % 1000) / 1000) * Math.PI * 2,
  ];
}

/** The coastline's base radius and its three wobble amplitudes, in the same
 * normalized radius `islandMask` works in. Shared with the water shader (see
 * `maskPhases`) — the GLSL side reads these numbers from this module at
 * build time rather than restating them. */
export const MASK_BASE_RADIUS = 0.98;
export const MASK_HARMONICS: [number, number, number] = [0.2, 0.11, 0.06];
// Keep the full coast inside the terrain mesh, with a submerged border.
export const MASK_PLOT_INSET = 0.94;

/** The wobbled coastline radius at `angle`, in normalized plot radius — the
 * value `islandMask` compares `dist` against. Exported so the water shader
 * can evaluate the identical curve. */
export function maskBoundary(seed: string, angle: number): number {
  const [p1, p2, p3] = maskPhases(seed);
  const [a1, a2, a3] = MASK_HARMONICS;
  const wobble =
    1 + a1 * Math.sin(2 * angle + p1) + a2 * Math.sin(3 * angle + p2) + a3 * Math.sin(5 * angle + p3);
  const roundedFootprint = MASK_PLOT_INSET / Math.pow(Math.cos(angle) ** 4 + Math.sin(angle) ** 4, 0.25);
  return Math.min(MASK_BASE_RADIUS * wobble, roundedFootprint);
}

export function islandMask(seed: string, u: number, v: number): number {
  const dist = Math.sqrt(u * u + v * v);
  const angle = Math.atan2(v, u);
  // Water-fix round (coordinator review, items 2+4): two complaints that
  // trace back to this ONE function. Item 2 — "the sand district pads
  // dominate... the cream buildings with coloured roofs become invisible" —
  // turned out NOT to be about pads at all (verified by hiding/recolouring
  // the pad mesh directly and rendering: the visible tan area was
  // completely unaffected). It is this mask: at the OLD `0.9` boundary, the
  // "fully land" disk (mask ≥ 0.6, i.e. dist ≤ boundary − 0.6·edgeWidth) only
  // covers roughly HALF the area of the square plot the mesh actually
  // spans — the rest reads as sand/foam, an inherent consequence of fitting
  // a round-ish coastline inside a square footprint with a modest boundary.
  // Item 4 — "still visibly stepped and rectangular from above" — is the
  // SAME function's wobble amplitude being too small relative to its own
  // base radius to read as organic rather than "a circle with a slight
  // wave on it." Both are addressed together here: a bigger `boundary`
  // (more of the square is land, shrinking the sand fraction that was
  // crowding out the buildings) AND bigger wobble amplitudes (a more
  // clearly organic, less circular silhouette) — kept safely under the
  // rectangle's own corner distance (√2 ≈ 1.414) with margin to spare
  // (worst case ≈ 0.98 × 1.37 ≈ 1.34), so corners still always recede
  // regardless of seed.
  const boundary = maskBoundary(seed, angle);
  // A SECOND retune, smaller again (`0.22` → `0.14` → `0.08`): a radial band
  // covers AREA proportional to its outer radius squared minus its inner
  // radius squared, not to its radial width — even a seemingly-thin `0.14`
  // band sitting near the outer edge of the shape covered nearly as much
  // total area as the entire "full land" interior inside it. `0.08` finally
  // keeps the coastline reading as a real but narrow band, verified by
  // actually rendering a close-up island, not by re-deriving the area math
  // and assuming it now holds.
  const edgeWidth = 0.08;
  const t = (boundary - dist) / edgeWidth;
  return Math.max(0, Math.min(1, t));
}

/**
 * The actual terrain height at `(u, v)` (same normalized coordinates as
 * `islandMask`), in world units. `moundHeight` is the peak elevation at the
 * island's own centre; `beachDepth` is how far BELOW the base ground level
 * the mesh sinks once fully outside the mask (submerged under the water
 * plane, which is what makes it invisible — no clipping needed).
 *
 * `Math.pow(mask, 0.6)` flattens the top slightly (a mound, not a pointed
 * hill) while keeping a real slope at the edge — "a beach sloping into the
 * water" comes from the SAME smoothstep `islandMask` already computes for
 * the coastline, not a second, separate ramp.
 *
 * A small seeded directional tilt (`tiltStrength`, capped well under the
 * dome's own height) gives "maybe low cliffs on one side" — one edge of the
 * island sits a little higher than the other — without ever approaching
 * building-scale height on its own.
 */
export function terrainHeight(
  seed: string,
  u: number,
  v: number,
  moundHeight: number,
  beachDepth: number,
): number {
  const mask = islandMask(seed, u, v);
  const h4 = hashString(`${seed}#tilt`);
  const tiltAngle = ((h4 % 1000) / 1000) * Math.PI * 2;
  const tiltStrength = 0.16;
  const tilt = 1 + tiltStrength * (u * Math.cos(tiltAngle) + v * Math.sin(tiltAngle));
  const dome = Math.pow(mask, 0.6) * tilt;
  // Scenery-craft round — the one line that was quietly making every island
  // sit on a visible pale slab. The submerging term used to be LINEAR in
  // `1 - mask`, so at `mask = 0` (the plot's corners, everything past the
  // coastline) the mesh bottomed out at exactly `-beachDepth`. With the real
  // call-site numbers that is `-0.5`, and the water plane sits at
  // `-GROUND_THICKNESS - 0.06 = -0.56` — six hundredths of a unit LOWER. So
  // the "submerged" part of the footprint was never submerged at all: the
  // entire square plot rendered as a flat, foam-coloured shelf floating just
  // above the sea, which is exactly the field of hard-edged rectangles
  // visible in this round's own "before" renders (see the report). The
  // organic coastline the rest of this module carefully computes was being
  // drawn on top of a rectangle the viewer could plainly see.
  //
  // Cubed instead: the beach still leaves dry land alone (at `clampToLand`'s
  // own `minMask = 0.65` floor the drop is `0.35³ ≈ 0.043` of `beachDepth`,
  // so every block, house and villager stays comfortably above water, which
  // a bigger LINEAR drop would NOT have allowed), while everything past the
  // coastline plunges fast enough to genuinely disappear under the water
  // plane. Callers raise `beachDepth` to suit; the shape of the curve is
  // what makes that raise safe.
  const submergence = Math.pow(1 - mask, 3);
  return moundHeight * dome - beachDepth * submergence;
}

/**
 * A safe, ALWAYS-non-negative gentle dome — no coastline recession, no risk
 * of ever reading as "submerged" anywhere inside the rectangle. Deliberately
 * a more conservative sibling of `terrainHeight`: `Archipelago`'s islands
 * are synthetic LOD massing, free to reshape within the honest footprint
 * (design inputs §3), but `TownView`'s own ground carries REAL building
 * positions from the actual repository layout — those must never be
 * implied to sit underwater just because they happen to be near a plot
 * edge. This gives the town elevation and a beach-like slope toward its
 * edges (reaching exactly 0 at the rectangle's own edge midpoints, `dist =
 * 1`, and staying at 0 — never negative — beyond that, including every
 * corner) without ever touching whether a point counts as "land".
 */
export function safeDomeHeight(u: number, v: number, moundHeight: number): number {
  // Scenery-craft round. This used to be purely RADIAL (`1 - length(u, v)`),
  // which put the dome's own zero at the unit circle — but the plot it
  // covers is a RECTANGLE, and every part of that rectangle outside its
  // inscribed circle (28% of a square's area, all of it in the corners) was
  // therefore dead flat at exactly zero. Since the ground's sand banding is
  // driven by height, that whole region painted as beach: a wide muddy
  // border with a curved inner edge wrapping each corner, plainly visible in
  // this round's own "before" render and nothing like what a town ought to
  // look like.
  //
  // Mostly-Chebyshev instead, with a quarter of the radial term left in so
  // the ridge stays rounded rather than reading as a pyramid: the falloff
  // now follows the rectangle's own edges, so the beach is a uniform band
  // around the whole plot and the hill fills the land it is on.
  //
  // Every guarantee the radial version made is unchanged and still tested:
  // exactly `moundHeight` at the centre (both terms are 0 there), exactly 0
  // at every edge midpoint (both terms are 1), 0 at every corner (Chebyshev
  // 1, radial sqrt(2), mixed 1.104 — past the zero), never negative
  // anywhere, and never a function of any seed.
  const radial = Math.sqrt(u * u + v * v);
  const boxy = Math.max(Math.abs(u), Math.abs(v));
  const dist = boxy * 0.75 + radial * 0.25;
  const t = Math.max(0, 1 - dist);
  return moundHeight * Math.pow(t, 0.7);
}

/**
 * How far inside its own rectangle `(u, v)` is, as a fraction — 1 at the
 * centre, 0 exactly on the edge (every edge, corners included), negative
 * outside. The town's beach band is measured with this rather than with
 * height, so it is a constant width all the way round instead of tracking
 * whatever shape the dome's falloff happens to have.
 */
export function rectInset(u: number, v: number): number {
  return 1 - Math.max(Math.abs(u), Math.abs(v));
}

/** Whether `(u, v)` counts as "land" at all (mask > 0) — the LOD massing
 * (houses, villagers) must never be placed somewhere that renders as
 * submerged, even if the footprint rectangle technically contains that
 * point. Callers doing block/villager placement can use this to keep
 * scenery on dry land without needing the full height value. */
export function isLand(seed: string, u: number, v: number): boolean {
  return islandMask(seed, u, v) > 0;
}

/**
 * Pulls `(u, v)` straight toward the plot's own centre, in small steps,
 * until `islandMask` at the result is at least `minMask` — the mechanism
 * that keeps LOD massing (blocks, villager slots) off the now-organic,
 * receding coastline without hand-tuning the coastline's own parameters
 * against the placement grid (or vice versa): whatever the coastline's
 * seeded wobble does at a given angle, this guarantees a safe, comfortably-
 * on-dry-land result for that exact seed and angle, by construction, not by
 * a margin that happens to work for today's tuning.
 *
 * Always terminates (the centre itself has `islandMask(seed, 0, 0) === 1`,
 * so the loop's own guard bound is hit only in a pathological case that
 * cannot occur with `islandMask`'s actual shape) and returns a point on the
 * SAME ray as the input (never changes direction, only distance from
 * centre) — the visual result is "this block sits a little further inland,"
 * never "this block jumped sideways."
 */
export function clampToLand(
  seed: string,
  u: number,
  v: number,
  minMask = 0.65,
): { u: number; v: number } {
  let cu = u;
  let cv = v;
  for (let i = 0; i < 60 && islandMask(seed, cu, cv) < minMask; i++) {
    cu *= 0.94;
    cv *= 0.94;
  }
  return { u: cu, v: cv };
}
