import * as THREE from "three";

let cachedGabledRoof: THREE.BufferGeometry | null = null;

/** A pitched roof with a long ridge, normalized to a unit box. */
export function gabledRoofGeometry(): THREE.BufferGeometry {
  if (cachedGabledRoof) return cachedGabledRoof;
  const a = [-0.5, -0.44, -0.5], b = [0.5, -0.44, -0.5];
  const c = [-0.5, -0.44, 0.5], d = [0.5, -0.44, 0.5];
  const ab = [-0.5, -0.5, -0.5], bb = [0.5, -0.5, -0.5];
  const cb = [-0.5, -0.5, 0.5], db = [0.5, -0.5, 0.5];
  const e = [0, 0.5, -0.5], f = [0, 0.5, 0.5];
  const triangles = [
    [a, e, b], [c, d, f], [a, c, f], [a, f, e], [b, e, f], [b, f, d],
    [ab, a, b], [ab, b, bb], [cb, db, d], [cb, d, c],
    [ab, cb, c], [ab, c, a], [bb, b, d], [bb, d, db], [ab, bb, db], [ab, db, cb],
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(triangles.flat(2), 3));
  // Dark fascia is part of this shared mesh, not another draw call per island.
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(triangles.flatMap((_, i) => Array(9).fill(i < 6 ? 1 : 0.38)), 3));
  geometry.computeVertexNormals();
  cachedGabledRoof = geometry;
  return geometry;
}

/**
 * Builds a roof mesh from triangles, the first `lit` of them the roof's own
 * surfaces (full kind colour) and the rest its fascia/underside (darkened),
 * the same shading convention `gabledRoofGeometry` uses.
 */
function roofMesh(triangles: number[][][], lit: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(triangles.flat(2), 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(triangles.flatMap((_, i) => Array(9).fill(i < lit ? 1 : 0.38)), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** The fascia band and underside every pitched roof shares: a thin dark
 * skirt from y=-0.5 to y=-0.44 around the unit footprint. */
function fascia(): number[][][] {
  const a = [-0.5, -0.44, -0.5], b = [0.5, -0.44, -0.5], c = [-0.5, -0.44, 0.5], d = [0.5, -0.44, 0.5];
  const ab = [-0.5, -0.5, -0.5], bb = [0.5, -0.5, -0.5], cb = [-0.5, -0.5, 0.5], db = [0.5, -0.5, 0.5];
  return [
    [ab, a, b], [ab, b, bb], [cb, db, d], [cb, d, c],
    [ab, cb, c], [ab, c, a], [bb, b, d], [bb, d, db], [ab, bb, db], [ab, db, cb],
  ];
}

let cachedHippedRoof: THREE.BufferGeometry | null = null;
/** Four slopes up to a short ridge — the calm, "grown-up" house roof. */
export function hippedRoofGeometry(): THREE.BufferGeometry {
  if (cachedHippedRoof) return cachedHippedRoof;
  const a = [-0.5, -0.44, -0.5], b = [0.5, -0.44, -0.5], c = [-0.5, -0.44, 0.5], d = [0.5, -0.44, 0.5];
  const e = [0, 0.5, -0.22], f = [0, 0.5, 0.22];
  const slopes = [[a, e, b], [c, d, f], [a, c, f], [a, f, e], [b, e, f], [b, f, d]];
  cachedHippedRoof = roofMesh([...slopes, ...fascia()], slopes.length);
  return cachedHippedRoof;
}

let cachedPyramidRoof: THREE.BufferGeometry | null = null;
/** Four slopes to a single point — for towers, where it reads as a spire. */
export function pyramidRoofGeometry(): THREE.BufferGeometry {
  if (cachedPyramidRoof) return cachedPyramidRoof;
  const a = [-0.5, -0.44, -0.5], b = [0.5, -0.44, -0.5], c = [-0.5, -0.44, 0.5], d = [0.5, -0.44, 0.5];
  const apex = [0, 0.5, 0];
  const slopes = [[a, apex, b], [b, apex, d], [d, apex, c], [c, apex, a]];
  cachedPyramidRoof = roofMesh([...slopes, ...fascia()], slopes.length);
  return cachedPyramidRoof;
}

let cachedFlatRoof: THREE.BufferGeometry | null = null;
/** A flat roof behind a low parapet — the wide "squat" buildings read as
 * warehouses and halls rather than stretched cottages. */
export function flatRoofGeometry(): THREE.BufferGeometry {
  if (cachedFlatRoof) return cachedFlatRoof;
  const o = 0.5, i = 0.4, top = 0.5, deck = 0.1, base = -0.5;
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[][][] => {
    const p = (x: number, y: number, z: number) => [x, y, z];
    const [a, b, c, d] = [p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)];
    const [e, f, g, h] = [p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)];
    const centre = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    // Each piece is a convex box: wind every face away from its centre
    // (the hand-written order had most of them facing in, and culled).
    return [[a, d, c], [a, c, b], [e, f, b], [e, b, a], [f, g, c], [f, c, b], [g, h, d], [g, d, c], [h, e, a], [h, a, d]].map(([u, v, w]) => {
      const n = [(v[1] - u[1]) * (w[2] - u[2]) - (v[2] - u[2]) * (w[1] - u[1]), (v[2] - u[2]) * (w[0] - u[0]) - (v[0] - u[0]) * (w[2] - u[2]), (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])];
      const out = n.reduce((sum, c, k) => sum + c * ((u[k] + v[k] + w[k]) / 3 - centre[k]), 0);
      return out >= 0 ? [u, v, w] : [u, w, v];
    });
  };
  // Lit: the parapet's four walls and the deck; dark: the slab's edge.
  const parapet = [...box(-o, o, deck, top, -o, -i), ...box(-o, o, deck, top, i, o), ...box(-o, -i, deck, top, -i, i), ...box(i, o, deck, top, -i, i)];
  const deckTris = [[[-i, deck, -i], [-i, deck, i], [i, deck, i]], [[-i, deck, -i], [i, deck, i], [i, deck, -i]]];
  const slab = box(-o, o, base, deck, -o, o);
  // The deck is a shade lighter than the roof colour: sunk behind the
  // parapet it otherwise reads as a dark hole.
  const geometry = roofMesh([...parapet, ...deckTris, ...slab], parapet.length + deckTris.length);
  const color = geometry.attributes.color as THREE.BufferAttribute;
  for (let v = parapet.length * 3; v < (parapet.length + deckTris.length) * 3; v++) color.setXYZ(v, 1.3, 1.3, 1.3);
  cachedFlatRoof = geometry;
  return cachedFlatRoof;
}

/**
 * Craft pass — "everything is an unbevelled primitive with a dead-flat
 * fill... that is the single biggest tell." A plain `boxGeometry`/
 * `coneGeometry` has perfectly sharp edges everywhere; a real low-poly
 * "made object" gives every edge a small chamfer so it catches a bright rim
 * of light and drops a soft line of shade next to it.
 *
 * Both geometries below are built ONCE (module-level cache, the exact
 * pattern `facadeTexture.ts` already established for the same reason: a
 * town can have 1,000+ building instances, and the whole point of
 * `instancedMesh` is that geometry is shared, not per-instance work) and are
 * unit-sized (spanning -0.5..0.5 on every axis, matching plain
 * `boxGeometry`/`coneGeometry`'s own default extents) so every existing call
 * site's `dummy.scale.set(footprint, height, footprint)` keeps working
 * completely unchanged — only the shape each instance is stamped from
 * changed, never how it's positioned or scaled.
 *
 * A REAL, hand-built chamfer, not `three/examples`' `RoundedBoxGeometry`:
 * that helper was tried first and measured (this round's own before/after
 * render harness) to cost 192 triangles per box — it subdivides the box's
 * ENTIRE surface uniformly (a smooth-curvature strategy) rather than adding
 * geometry only where an edge actually needs one. At 1,000+ building
 * instances that is a real, disclosed cost this codebase's own performance
 * discipline (`archipelago-perf-report.md` et al.) would flag. The
 * hand-built version below is the classic "chamfered box" construction —
 * 6 shrunk main faces, 12 flat edge-bevel quads, 8 flat corner triangles —
 * 44 triangles total, under 4x the plain box's 12, for the exact same
 * visual result (every edge gets a flat chamfer facet). Every face is its
 * own set of non-shared vertices (like `BoxGeometry` itself), so
 * `computeVertexNormals()` naturally yields correct FLAT per-facet normals
 * with no smoothing artefact — no `flatShading` trick required, though call
 * sites keep it anyway for consistency with the roof's own geometry below.
 */
const WALL_CHAMFER = 0.08;

/** A neutral UV sample for the small edge/corner chamfer facets — the
 * canvas's own plain white background (see `facadeTexture.ts`'s doc
 * comment: the window/door marks are drawn starting a few pixels in from
 * every edge), not `(0, 0)` exactly, so a facet never accidentally lands
 * squarely on a window/door mark's own corner pixel. */
const NEUTRAL_UV = new THREE.Vector2(0.02, 0.02);

function pushTri(
  positions: number[],
  uvs: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  ua: THREE.Vector2,
  ub: THREE.Vector2,
  uc: THREE.Vector2,
) {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  uvs.push(ua.x, ua.y, ub.x, ub.y, uc.x, uc.y);
}

function pushQuad(
  positions: number[],
  uvs: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  ua: THREE.Vector2,
  ub: THREE.Vector2,
  uc: THREE.Vector2,
  ud: THREE.Vector2,
) {
  // a-b-c-d in winding order, split into two triangles (a,b,c) and (a,c,d).
  pushTri(positions, uvs, a, b, c, ua, ub, uc);
  pushTri(positions, uvs, a, c, d, ua, uc, ud);
}

/**
 * A unit (size×size×size) box with every edge replaced by a flat chamfer
 * facet and every corner capped by a flat triangle — see this file's own
 * top comment for why this is hand-built rather than `RoundedBoxGeometry`.
 * `chamfer` must be less than `size / 2`; every call site here uses the
 * fixed `WALL_CHAMFER` against a unit (`size = 1`) box.
 *
 * UVs are computed PER FACE, inline, while each face's own 4 (or 3) corners
 * are still known by name — never derived after the fact from a vertex's
 * bare position. A first version of this function tried the latter (a
 * single global `x + z`/`y` formula applied to every vertex regardless of
 * which face it belonged to) and it was wrong: it produced UVs well outside
 * `0..1` for most faces, which — since `buildingFacadeTexture()`'s texture
 * uses the default `ClampToEdgeWrapping` — sample the texture's clamped
 * edge pixel instead of the actual window/door pattern, silently erasing
 * the facade detail on most walls. Coordinator review caught the visual
 * regression (a rendered comparison, not a code read) before this shipped.
 * Each of the 6 main faces below gets a proper `0..1` planar UV across its
 * own shrunk rectangle; the 12 edge-bevel and 8 corner chamfer facets get a
 * fixed `NEUTRAL_UV` sample (the texture's own plain background) — they are
 * a sliver at most `WALL_CHAMFER` wide next to a wall that is several times
 * that even at the smallest real footprint, so no visible seam results.
 */
function buildChamferedBox(size: number, chamfer: number): THREE.BufferGeometry {
  const h = size / 2;
  const r = chamfer;
  const positions: number[] = [];
  const uvs: number[] = [];

  const SIGNS = [-1, 1] as const;

  // The 6 main faces — each shrunk by `r` on both of its own in-plane axes
  // so the flat centre of every face is unchanged in shape (still a
  // rectangle, just smaller), exactly what "chamfered," not "rounded,"
  // means: the FACE stays flat, only the EDGE next to it grows a new flat
  // facet (below). Each face's own 4 corners map to a proper `0..1` UV
  // square, exactly like a plain `BoxGeometry` face would.
  for (const axis of ["x", "y", "z"] as const) {
    for (const s of SIGNS) {
      const other = (["x", "y", "z"] as const).filter((a) => a !== axis);
      const corner = (o1: number, o2: number) => {
        const v = new THREE.Vector3();
        v[axis] = s * h;
        v[other[0]] = o1 * (h - r);
        v[other[1]] = o2 * (h - r);
        return v;
      };
      const cornerUv = (o1: number, o2: number) => new THREE.Vector2((o1 + 1) / 2, (o2 + 1) / 2);
      const p00 = corner(-1, -1);
      const p10 = corner(1, -1);
      const p11 = corner(1, 1);
      const p01 = corner(-1, 1);
      const u00 = cornerUv(-1, -1);
      const u10 = cornerUv(1, -1);
      const u11 = cornerUv(1, 1);
      const u01 = cornerUv(-1, 1);
      // Winding: outward-facing for +axis normal when s === 1, flipped for
      // s === -1, matching a standard box's own face winding. The UV
      // argument order always mirrors whichever position order is used, so
      // each vertex keeps its own correct corner UV regardless of winding.
      if (s > 0) pushQuad(positions, uvs, p00, p10, p11, p01, u00, u10, u11, u01);
      else pushQuad(positions, uvs, p00, p01, p11, p10, u00, u01, u11, u10);
    }
  }

  // The 12 edge-bevel quads — one per (axisA sign, axisB sign) pair for
  // each of the 3 axis-pairs (x/y, y/z, x/z), running the full length of
  // the third axis. Each is a flat rectangle at 45°, connecting the two
  // adjacent main faces' now-shrunk edges. A fixed neutral UV throughout —
  // see this function's own doc comment for why.
  const axisPairs: Array<[("x" | "y" | "z"), ("x" | "y" | "z"), ("x" | "y" | "z")]> = [
    ["x", "y", "z"],
    ["y", "z", "x"],
    ["z", "x", "y"],
  ];
  for (const [a, b, c] of axisPairs) {
    for (const sa of SIGNS) {
      for (const sb of SIGNS) {
        const at = (sc: number) => {
          const v = new THREE.Vector3();
          v[a] = sa * h;
          v[b] = sb * (h - r);
          v[c] = sc * h;
          return v;
        };
        const bt = (sc: number) => {
          const v = new THREE.Vector3();
          v[a] = sa * (h - r);
          v[b] = sb * h;
          v[c] = sc * h;
          return v;
        };
        const p0 = at(-1);
        const p1 = at(1);
        const p2 = bt(1);
        const p3 = bt(-1);
        // Outward normal points roughly toward (sa, sb) in the (a, b)
        // plane — winding chosen so `p0 -> p1 -> p2` is counter-clockwise
        // when viewed from outside for every sign combination.
        if (sa * sb > 0) pushQuad(positions, uvs, p0, p1, p2, p3, NEUTRAL_UV, NEUTRAL_UV, NEUTRAL_UV, NEUTRAL_UV);
        else pushQuad(positions, uvs, p3, p2, p1, p0, NEUTRAL_UV, NEUTRAL_UV, NEUTRAL_UV, NEUTRAL_UV);
      }
    }
  }

  // The 8 corner triangles — one per (sx, sy, sz) sign combination, capping
  // the small gap the three meeting edge-bevels would otherwise leave open.
  // Same fixed neutral UV.
  for (const sx of SIGNS) {
    for (const sy of SIGNS) {
      for (const sz of SIGNS) {
        const px = new THREE.Vector3(sx * h, sy * (h - r), sz * (h - r));
        const py = new THREE.Vector3(sx * (h - r), sy * h, sz * (h - r));
        const pz = new THREE.Vector3(sx * (h - r), sy * (h - r), sz * h);
        // Winding so the face normal points outward (toward sx, sy, sz):
        // flip based on the parity of the sign combination, the same
        // "flip on odd reflection" rule a box's own corner triangles need.
        const parity = (sx > 0 ? 1 : 0) ^ (sy > 0 ? 1 : 0) ^ (sz > 0 ? 1 : 0);
        if (parity === 0) pushTri(positions, uvs, px, py, pz, NEUTRAL_UV, NEUTRAL_UV, NEUTRAL_UV);
        else pushTri(positions, uvs, px, pz, py, NEUTRAL_UV, NEUTRAL_UV, NEUTRAL_UV);
      }
    }
  }

  // The winding tables above got most facets backwards (top, bottom, every
  // edge bevel and corner), so they were culled and the corners rendered as
  // open seams. The box is convex and centred on the origin, so "faces away
  // from the origin" is the whole rule; enforce it rather than trust tables.
  for (let t = 0; t < positions.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(t, t + 9);
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (nx * (ax + bx + cx) + ny * (ay + by + cy) + nz * (az + bz + cz) >= 0) continue;
    positions.splice(t + 3, 6, cx, cy, cz, bx, by, bz);
    const u = (t / 9) * 6;
    uvs.splice(u + 2, 4, uvs[u + 4], uvs[u + 5], uvs[u + 2], uvs[u + 3]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  // Every triangle above uses its own private vertices (nothing is shared
  // between faces/facets, exactly like a plain, non-indexed `BoxGeometry`),
  // so `computeVertexNormals()` yields genuinely flat per-facet normals —
  // no smoothing artefact, no `flatShading` material trick required (call
  // sites keep it anyway, harmlessly, for consistency with the roof below).
  geometry.computeVertexNormals();
  return geometry;
}

let cachedWallGeometry: THREE.BufferGeometry | null = null;

/**
 * The shared wall geometry for every `instancedMesh` that used to be a
 * plain `boxGeometry(1, 1, 1)`: building walls, chimneys, and district
 * boundary walls. Never disposed (module lifetime, same as
 * `buildingFacadeTexture()`) since it is never rebuilt — there is no
 * parameter here that ever changes at runtime.
 */
export function buildingWallGeometry(): THREE.BufferGeometry {
  if (cachedWallGeometry) return cachedWallGeometry;
  cachedWallGeometry = buildChamferedBox(1, WALL_CHAMFER);
  return cachedWallGeometry;
}

/**
 * How much narrower than the base the roof's own flat cap is, as a fraction
 * of the base radius — see `buildingRoofGeometry`'s doc comment for why a
 * flat cap (a frustum) replaces the old sharp-apex cone.
 */
const ROOF_CAP_FRACTION = 0.16;

let cachedRoofGeometry: THREE.BufferGeometry | null = null;

/**
 * The old roof was `coneGeometry(1, 1, 4)` — a perfect 4-sided pyramid,
 * apex a single infinitely sharp point. Real hipped roofs (and every
 * hand-crafted low-poly building that inspired this pass) don't actually
 * come to a knife-edge point; there's a small flat ridge/cap where the four
 * hip faces meet, which is also exactly the kind of small bevelled surface
 * the craft-pass brief calls out — it catches its own sliver of sky light
 * and reads as a "made" roof rather than a mathematical primitive.
 *
 * A `CylinderGeometry` with a small non-zero `radiusTop` produces exactly
 * that: a 4-sided frustum with a small flat square cap instead of a point,
 * at a negligible cost (16 triangles vs. the cone's 8). Every existing call
 * site's `dummy.position`/`scale` math is unchanged — this geometry spans
 * the same -0.5..0.5 height range and the same base radius `1` (before
 * `ROOF_WIDTH_SCALE`/footprint scaling) the old cone did.
 */
export function buildingRoofGeometry(): THREE.BufferGeometry {
  if (cachedRoofGeometry) return cachedRoofGeometry;
  cachedRoofGeometry = new THREE.CylinderGeometry(ROOF_CAP_FRACTION, 1, 1, 4);
  return cachedRoofGeometry;
}
