import * as THREE from "three";

/**
 * A flat annulus whose OPACITY varies with radius: faint where it meets the
 * coastline, solid across a defined rim just outside it, then falling away
 * to nothing well before its own outer edge.
 *
 * Why a built geometry rather than `ringGeometry` + a flat material
 * opacity: a constant-alpha annulus has two hard circular edges, and the
 * wide one this cue needs (see `StoppedHalo`'s reach) then reads as a
 * painted disc lying on the water — which is exactly what it looked like.
 * Alpha reaching zero BEFORE the geometry ends means the outer boundary is
 * invisible by construction, the same trick `Water.tsx`'s shelf quads use
 * so a per-island quad can never seam against the open sea.
 *
 * Per-vertex ALPHA (a 4-component `color` attribute, which three.js
 * compiles as `USE_COLOR_ALPHA`) rather than a custom shader: one
 * `meshBasicMaterial` still does the work, and `material.opacity` still
 * multiplies the whole thing, so the pulse and the search-filter `dim`
 * factor keep working untouched.
 *
 * @param inner where the ring starts — just outside the island's own
 *   half-diagonal, so it never shares an (x, z) with the terrain mesh
 * @param rim where the solid part ends; between `inner` and here the alpha
 *   ramps up, which is what gives the cue a legible EDGE instead of a smear
 * @param outer where the glow has faded to exactly zero
 */
export function buildAttentionHaloGeometry({
  inner,
  rim,
  outer,
  segments = 64,
}: {
  inner: number;
  rim: number;
  outer: number;
  segments?: number;
}): THREE.BufferGeometry {
  // Where the ring meets the coast it is present but not solid — a hard
  // bright edge right at the waterline reads as a decal stuck to the
  // island, and the shallows/surf the water shader draws there are worth
  // seeing through.
  const INNER_ALPHA = 0.32;
  const TAIL_RINGS = 8;
  const radii: number[] = [inner, rim];
  const alphas: number[] = [INNER_ALPHA, 1];
  for (let i = 1; i <= TAIL_RINGS; i++) {
    const t = i / TAIL_RINGS;
    radii.push(rim + (outer - rim) * t);
    // Quadratic, not linear: a linear ramp still leaves a faint but
    // perfectly circular step where it hits zero, because the eye picks up
    // the discontinuity in the SLOPE. `(1-t)^2` arrives at zero with zero
    // slope.
    alphas.push((1 - t) * (1 - t));
  }

  const cols = segments + 1;
  const rings = radii.length;
  const positions = new Float32Array(rings * cols * 3);
  const colors = new Float32Array(rings * cols * 4);
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < cols; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const i = r * cols + s;
      positions[i * 3] = Math.cos(theta) * radii[r];
      positions[i * 3 + 1] = Math.sin(theta) * radii[r];
      positions[i * 3 + 2] = 0;
      // RGB stays white so the material's own `color` (the SHARED
      // `ATTENTION_COLOR.stopped`, never a second copy) is what tints it.
      colors[i * 4] = 1;
      colors[i * 4 + 1] = 1;
      colors[i * 4 + 2] = 1;
      colors[i * 4 + 3] = alphas[r];
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * cols + s;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  return geometry;
}
