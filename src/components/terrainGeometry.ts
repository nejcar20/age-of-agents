// Builds the actual Three.js geometry from `terrain.ts`'s pure height/mask
// functions — impure (constructs real `THREE.BufferGeometry` objects), kept
// separate from `terrain.ts` so the math stays unit-testable without a
// WebGL/DOM environment.
//
// Scenery-craft round: the colouring here stopped being three flat bands.
// The author's complaint was that the water and grass looked bad, and the
// grass half of that is not a hue problem — `#8fce6a` is a perfectly good
// green. It is that ONE value, applied across an entire island under
// near-uniform light, has nothing in it for the eye to catch. A large flat
// area of a single colour reads as paper regardless of which colour it is.
// Every band below is now a RANGE, mixed per vertex from things the mesh
// already knows about itself — its own elevation, its own slope, and a
// seeded 2-octave value noise. None of that is information about the
// repository; it is the same category as a tree (design inputs §3: ground,
// water, sky and trees are scenery and may be decorative).
import * as THREE from "three";
import { islandMask, rectInset, safeDomeHeight, terrainHeight } from "../terrain";

export type TerrainGeometryOptions = {
  seed: string;
  width: number;
  depth: number;
  moundHeight: number;
  beachDepth: number;
  /** Vertex colour for full-height dry land, the MIDDLE of the grass range. */
  landColor: string;
  /** Grass in the hollows / away from the sun — the dark end of the range. */
  shadeColor: string;
  /** Grass on the sunlit crests — the light end of the range. */
  lightColor: string;
  /** Dry sand, inland of the waterline. */
  sandColor: string;
  /** Wet sand, in the narrow band the surf reaches — darker and cooler than
   * `sandColor`. Scenery-craft round: this replaced an almost-white foam
   * tone that was both the wrong material (foam belongs on the water, and
   * `Water.tsx` now draws it there) and invisible anyway, since the part of
   * the mesh carrying it sat under the waterline. */
  wetSandColor: string;
  /** Exposed rock on the steepest slopes. */
  cliffColor: string;
  /** Geometry subdivisions per axis — the ONLY thing this scales with is
   * "how smooth does the coastline/mound read," never city content, so a
   * flat constant is honest here (see call sites for the numbers actually
   * used and their frame-cost reasoning). */
  segments: number;
};

/** A cheap, deterministic 2-octave value noise over normalized plot
 * coordinates. Seeded by the caller's own identity string exactly the way
 * `terrain.ts` already is (see its module doc comment: read for "which
 * one", never for "how big"), hashed into a phase pair so two repositories
 * get differently-placed patches rather than the same one everywhere.
 *
 * Deliberately sines rather than a real noise function: this is evaluated
 * once per vertex at build time, never per frame, and a handful of
 * harmonics is indistinguishable from noise at the scale a patch of grass
 * is ever seen at. */
function grassNoise(phase: number, u: number, v: number): number {
  const a = Math.sin(u * 3.7 + phase) * Math.cos(v * 4.3 - phase * 0.7);
  const b = Math.sin(u * 9.1 - phase * 1.7) * Math.cos(v * 8.3 + phase * 1.3);
  return a * 0.66 + b * 0.34; // -1..1
}

/** A stable phase for `grassNoise`, from any identity string. Small, local
 * and dependency-free rather than pulling `hashString` in — this is a
 * decorative dither, not a placement decision. */
function noisePhase(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return ((h % 1000) / 1000) * Math.PI * 2;
}

/**
 * A single subdivided plane, height- and colour-displaced per vertex by
 * `terrain.ts`, still spanning the EXACT real footprint (`width` x `depth`)
 * end to end — the mesh's own bounding box never shrinks; the organic
 * coastline is drawn entirely by which vertices sink below the waterline
 * (see `terrain.ts`'s module doc comment), not by trimming the mesh.
 *
 * Positioned so `(0, *, 0)` is the plot's own top-left corner and
 * `(width, *, depth)` its bottom-right — the same local-origin convention
 * every other piece of scenery in `Archipelago.tsx`/`TownView.tsx` already
 * uses, so callers place it exactly like the flat box it replaces.
 */
export function buildTerrainGeometry(options: TerrainGeometryOptions): THREE.BufferGeometry {
  const {
    seed,
    width,
    depth,
    moundHeight,
    beachDepth,
    landColor,
    shadeColor,
    lightColor,
    sandColor,
    wetSandColor,
    cliffColor,
    segments,
  } = options;
  const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(width / 2, 0, depth / 2);

  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const land = new THREE.Color(landColor);
  const shade = new THREE.Color(shadeColor);
  const bright = new THREE.Color(lightColor);
  const sand = new THREE.Color(sandColor);
  const wet = new THREE.Color(wetSandColor);
  const cliff = new THREE.Color(cliffColor);
  const tmp = new THREE.Color();
  const phase = noisePhase(seed);

  // Slope needs a neighbour sample; one cell is the natural step.
  const stepU = 2 / Math.max(segments, 1);

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const u = (x - width / 2) / (width / 2);
    const v = (z - depth / 2) / (depth / 2);
    const height = terrainHeight(seed, u, v, moundHeight, beachDepth);
    position.setY(i, height);

    const mask = islandMask(seed, u, v);
    // Four bands, all driven by the SAME mask the height is:
    //   mask >= 0.60   grass, mixed across its own three-tone range
    //   0.30 .. 0.60   dry sand fading inland into grass
    //   0.16 .. 0.30   wet sand — the narrow strip the surf reaches
    //   below 0.16     genuinely underwater (see `terrain.ts`'s cubed
    //                  submergence curve), so its colour never shows.
    // The waterline itself falls around `mask ~ 0.27` at the real call-site
    // numbers, so the visible beach is roughly `0.27 .. 0.60`.
    if (mask >= 0.60) {
      // Height relative to this island's own peak, 0..1 — the crests take
      // the light tone, the hollows the shaded one.
      const relief = THREE.MathUtils.clamp(height / Math.max(moundHeight, 1e-6), 0, 1);
      const n = grassNoise(phase, u, v);
      // Noise and relief contribute about equally; neither alone is enough
      // to stop a big island reading as one flat sheet.
      const t = THREE.MathUtils.clamp(0.5 + (relief - 0.4) * 0.95 + n * 0.38, 0, 1);
      if (t < 0.5) {
        tmp.copy(shade).lerp(land, t * 2);
      } else {
        tmp.copy(land).lerp(bright, (t - 0.5) * 2);
      }
      // Exposed rock where the ground actually falls away steeply — the
      // mound's own outer slope, never anywhere flat.
      const slope = Math.abs(
        terrainHeight(seed, u + stepU, v, moundHeight, beachDepth) -
          terrainHeight(seed, u - stepU, v, moundHeight, beachDepth),
      );
      const rockiness = THREE.MathUtils.clamp((slope / Math.max(moundHeight, 1e-6) - 0.35) * 1.1, 0, 0.45);
      tmp.lerp(cliff, rockiness);
    } else if (mask >= 0.30) {
      const t = (mask - 0.30) / (0.60 - 0.30);
      tmp.copy(sand).lerp(land, t);
      // The sand gets the same dither, at a third the strength — a beach is
      // less varied than a meadow, but not uniform either.
      tmp.offsetHSL(0, 0, grassNoise(phase * 1.7 + 1.1, u, v) * 0.035);
    } else {
      const t = THREE.MathUtils.clamp((mask - 0.16) / (0.30 - 0.16), 0, 1);
      tmp.copy(wet).lerp(sand, t);
    }
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  position.needsUpdate = true;
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** How wide the town's beach is, as a fraction of the plot's half-extent —
 * the last ~9% before the water. */
const SAND_INSET = 0.09;

export type SafeGroundOptions = {
  width: number;
  depth: number;
  moundHeight: number;
  landColor: string;
  shadeColor: string;
  lightColor: string;
  sandColor: string;
  wetSandColor: string;
  /** Paint a beach around the rectangle's own edge. Off when a coast
   * (`townCoast.ts`) surrounds the ground and provides the beach itself. */
  beachAtEdge?: boolean;
  /** Shade the grass by the dome but keep the surface at y=0. A town's own
   * ground sits under real buildings, roads and plots that all stand on
   * y=0: a raised dome buried them toward the centre, sank buildings by up
   * to `moundHeight` (so equal files looked unequal), and z-fought with the
   * paths wherever the two heights met. */
  flat?: boolean;
};

/**
 * The TOWN's own ground — a gentle, ALWAYS-safe dome (see
 * `terrain.ts`'s `safeDomeHeight` for why this is a deliberately more
 * conservative sibling of `buildTerrainGeometry`): every real building in
 * this repository sits somewhere inside `[0,width]x[0,depth]`, so this
 * geometry must never imply any point in that rectangle is underwater. No
 * seed, no organic coastline recession — only elevation, the same grass
 * range the sea islands get, and a sand fade at the rectangle's own edge
 * where the shallow-water shelf begins.
 */
export function buildSafeGroundGeometry(options: SafeGroundOptions): THREE.BufferGeometry {
  const { width, depth, moundHeight, landColor, shadeColor, lightColor, sandColor, wetSandColor, beachAtEdge = true, flat = false } = options;
  const segments = 40;
  const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(width / 2, 0, depth / 2);

  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const land = new THREE.Color(landColor);
  const shade = new THREE.Color(shadeColor);
  const bright = new THREE.Color(lightColor);
  const sand = new THREE.Color(sandColor);
  const wet = new THREE.Color(wetSandColor);
  const tmp = new THREE.Color();
  const beach = new THREE.Color();
  // A town has no seed (its ground must never shift with content — see
  // `safeDomeHeight`'s own doc comment and its test), so the dither's phase
  // is a fixed constant here rather than derived from anything.
  const phase = 2.3;

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const u = (x - width / 2) / (width / 2);
    const v = (z - depth / 2) / (depth / 2);
    const height = safeDomeHeight(u, v, moundHeight);
    position.setY(i, flat ? 0 : height);

    // The beach, measured as a constant inset from the plot's own edge
    // (`rectInset`) rather than from the dome's height. Scenery-craft round:
    // driving it from height made the band's width follow the dome's
    // falloff, which over a RECTANGLE meant the four corners — 28% of a
    // square — were all beach. See `safeDomeHeight`'s own comment.
    const sandAmount = beachAtEdge ? 1 - THREE.MathUtils.clamp(rectInset(u, v) / SAND_INSET, 0, 1) : 0;
    const relief = THREE.MathUtils.clamp(height / Math.max(moundHeight, 1e-6), 0, 1);
    const n = grassNoise(phase, u, v);
    const t = THREE.MathUtils.clamp(0.5 + (relief - 0.35) * 0.9 + n * 0.3, 0, 1);
    if (t < 0.5) {
      tmp.copy(shade).lerp(land, t * 2);
    } else {
      tmp.copy(land).lerp(bright, (t - 0.5) * 2);
    }
    if (sandAmount > 0) {
      beach.copy(sand);
      // The outermost sliver is wet sand, the way it is on a sea island —
      // a tonal step right at the waterline instead of grass simply
      // stopping.
      if (sandAmount > 0.72) beach.lerp(wet, (sandAmount - 0.72) / 0.28);
      tmp.lerp(beach, Math.min(sandAmount, 1));
    }
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  position.needsUpdate = true;
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}
