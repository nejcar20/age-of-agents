import * as THREE from "three";

/**
 * The land around a town: a meadow, a beach and a slope into the lagoon,
 * with an organic coastline — so a town reads as a place on an island
 * rather than a board lying on the sea.
 *
 * Scenery only, by the project's own rule (see the README: "ground, water,
 * sky and trees are scenery and are allowed to be decorative, because
 * nobody can mistake a tree for a file"). The town's own ground stays the
 * honest rectangle every building is placed on; this only grows OUTWARD
 * from its edge and never overlaps it. It encodes nothing: its shape is a
 * fixed wobble, the same for every town.
 *
 * One coastline, two consumers. The land mesh here and the water shader
 * (`Water.tsx`, `MODE_RECT`) both call the same wobble — the GLSL is
 * generated from `COAST_TERMS` below, never hand-copied — so the surf lands
 * exactly on the beach, the same guarantee the sea islands already get from
 * `terrain.ts`'s shared mask.
 */

/** `[frequency, amplitude, phase]` of each angular term of the coastline. */
export const COAST_TERMS: [number, number, number][] = [
  [2, 0.24, 0.7],
  [3, 0.15, 2.3],
  [5, 0.09, 4.1],
  [9, 0.045, 1.2],
];

/** Coast width relative to the town's shorter side — how far land reaches
 * past the town's own ground before the sea. */
const COAST_FRACTION = 0.2;
const COAST_MIN = 3;

export function townCoastWidth(width: number, depth: number): number {
  return Math.max(Math.min(width, depth) * COAST_FRACTION, COAST_MIN);
}

/** The coastline's angular wobble around the town's centre (≈0.47..1.53). */
export function coastWobble(angle: number): number {
  return 1 + COAST_TERMS.reduce((sum, [f, a, p]) => sum + a * Math.sin(f * angle + p), 0);
}

/** GLSL for `coastWobble`, generated from the same terms. */
export function coastWobbleGlsl(): string {
  const terms = COAST_TERMS.map(([f, a, p]) => `${a.toFixed(4)} * sin(${f.toFixed(1)} * ang + ${p.toFixed(4)})`).join(" + ");
  return `float coastWobble(float ang) { return 1.0 + ${terms}; }`;
}

/** Distance from a point to the rectangle [0,w]×[0,d] — 0 inside it. */
export function rectDistance(x: number, z: number, width: number, depth: number): number {
  const dx = Math.max(-x, 0, x - width);
  const dz = Math.max(-z, 0, z - depth);
  return Math.hypot(dx, dz);
}

/** The coast mesh's own extent: the town plus a margin wide enough for the
 * furthest the wobbled coast (and its seabed) reaches. */
export function coastExtent(width: number, depth: number): { margin: number; spanX: number; spanZ: number } {
  const margin = townCoastWidth(width, depth) * 1.7;
  return { margin, spanX: width + margin * 2, spanZ: depth + margin * 2 };
}

/** Normalized distance across the coast at a world point: 0 at the town's
 * edge, 1 where the seabed levels off; 0 inside the town itself. */
export function coastT(x: number, z: number, width: number, depth: number): number {
  const outside = rectDistance(x, z, width, depth);
  if (outside <= 0) return 0;
  const angle = Math.atan2(z - depth / 2, x - width / 2);
  return outside / (townCoastWidth(width, depth) * coastWobble(angle));
}

/** The meadow's hummocks, varying around the coast (0.1..1). */
export function coastSwell(x: number, z: number, width: number, depth: number): number {
  const angle = Math.atan2(z - depth / 2, x - width / 2);
  return 0.55 + 0.45 * Math.sin(angle * 7 + 1.3) * Math.cos(angle * 4 - 0.4);
}

/** How deep the coast's seabed goes, below the ground's own base. */
const SEABED_DROP = 0.35;

/**
 * The coast's height at normalized distance `t` (0 = the town's edge,
 * 1 = where the seabed levels off), relative to the ground's base.
 * A gentle meadow swell, then a beach, then the slope under the water.
 */
export function coastHeight(t: number, groundThickness: number, swell: number): number {
  const meadow = 0.14 * swell * Math.sin(Math.PI * THREE.MathUtils.clamp(t / 0.62, 0, 1));
  const drop = THREE.MathUtils.smoothstep(t, 0.6, 1.0) * (groundThickness + SEABED_DROP);
  return meadow - drop;
}

/**
 * Where, in `t`, the coast crosses a water surface at `waterY` — the
 * waterline the shader draws its surf on. Found numerically (the profile is
 * monotonic past the meadow), so it can never disagree with `coastHeight`.
 */
export function coastWaterlineT(groundThickness: number, waterY: number): number {
  let lo = 0.62;
  let hi = 1.0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (coastHeight(mid, groundThickness, 0) > waterY) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export type CoastColors = { grass: string; grassShade: string; sand: string; wetSand: string; seabed: string };

/**
 * The coast mesh: a grid over the town's rectangle plus its coast, heights
 * from `coastHeight`, vertex colours from meadow to beach to seabed. Grid
 * points inside the town's own rectangle sit just under its ground, where
 * they are never seen.
 */
export function buildTownCoastGeometry({
  width,
  depth,
  groundThickness,
  colors,
}: {
  width: number;
  depth: number;
  groundThickness: number;
  colors: CoastColors;
}): THREE.BufferGeometry {
  const { spanX, spanZ } = coastExtent(width, depth);
  const step = Math.max(0.35, Math.max(spanX, spanZ) / 240);
  const segX = Math.ceil(spanX / step);
  const segZ = Math.ceil(spanZ / step);
  const geometry = new THREE.PlaneGeometry(spanX, spanZ, segX, segZ);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(width / 2, 0, depth / 2);

  const position = geometry.attributes.position;
  const vertexColors = new Float32Array(position.count * 3);
  const grass = new THREE.Color(colors.grass);
  const grassShade = new THREE.Color(colors.grassShade);
  const sand = new THREE.Color(colors.sand);
  const wet = new THREE.Color(colors.wetSand);
  const seabed = new THREE.Color(colors.seabed);
  const c = new THREE.Color();

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    if (rectDistance(x, z, width, depth) <= 0) {
      position.setY(i, -0.03);
      c.copy(grass);
    } else {
      const t = coastT(x, z, width, depth);
      // A low swell that varies around the coast, so the meadow has hummocks
      // rather than one uniform berm.
      const swell = coastSwell(x, z, width, depth);
      position.setY(i, coastHeight(t, groundThickness, swell));
      if (t < 0.5) {
        c.copy(grassShade).lerp(grass, 0.55 + 0.45 * swell);
      } else if (t < 0.6) {
        c.copy(grass).lerp(sand, (t - 0.5) / 0.1);
      } else if (t < 0.8) {
        c.copy(sand).lerp(wet, (t - 0.6) / 0.2);
      } else {
        c.copy(wet).lerp(seabed, THREE.MathUtils.clamp((t - 0.8) / 0.25, 0, 1));
      }
    }
    vertexColors[i * 3] = c.r;
    vertexColors[i * 3 + 1] = c.g;
    vertexColors[i * 3 + 2] = c.b;
  }
  position.needsUpdate = true;
  geometry.setAttribute("color", new THREE.BufferAttribute(vertexColors, 3));
  geometry.computeVertexNormals();
  return geometry;
}
