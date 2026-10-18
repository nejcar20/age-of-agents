import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildingRoofGeometry, buildingWallGeometry, flatRoofGeometry, gabledRoofGeometry } from "./bevelGeometry";

/** Triangles whose winding (the side the GPU draws) faces toward `inside`. */
function inwardFacets(geometry: THREE.BufferGeometry, insideOf: (centroid: THREE.Vector3) => THREE.Vector3): number[] {
  const p = geometry.attributes.position;
  const inward: number[] = [];
  for (let i = 0; i < p.count; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(p, i + k));
    const normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
    const centroid = a.clone().add(b).add(c).divideScalar(3);
    if (normal.dot(centroid.clone().sub(insideOf(centroid))) <= 0) inward.push(i / 3);
  }
  return inward;
}

describe("gabledRoofGeometry", () => {
  it("has outward faces and fits its footprint, so roofs remain visible from every orbit angle", () => {
    const geometry = gabledRoofGeometry();
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.toArray()).toEqual([-0.5, -0.5, -0.5]);
    expect(geometry.boundingBox!.max.toArray()).toEqual([0.5, 0.5, 0.5]);
    const p = geometry.attributes.position;
    const n = geometry.attributes.normal;
    const inside = new THREE.Vector3(0, -0.25, 0);
    for (let i = 0; i < p.count; i += 3) {
      const centroid = new THREE.Vector3().fromBufferAttribute(p, i)
        .add(new THREE.Vector3().fromBufferAttribute(p, i + 1))
        .add(new THREE.Vector3().fromBufferAttribute(p, i + 2)).divideScalar(3);
      expect(centroid.sub(inside).dot(new THREE.Vector3().fromBufferAttribute(n, i))).toBeGreaterThan(0);
    }
    expect(gabledRoofGeometry()).toBe(geometry);
  });
});

/**
 * Craft pass, item 1: these geometries replace plain `boxGeometry`/
 * `coneGeometry` in `TownView.tsx` — no React/WebGL needed to check the two
 * things that actually matter: the chamfer never grows the bounding box
 * (the invariant `footprintClearance` in `../city` depends on — a bevelled
 * building must still fit exactly the same unit cell a sharp-edged one
 * did), and the extra geometry stays cheap enough to justify 1,000+
 * instances (see `bevelGeometry.ts`'s own doc comment on why a hand-built
 * chamfer was chosen over `RoundedBoxGeometry` specifically because that
 * alternative measured at 192 triangles per box against this one's 44).
 */
describe("buildingWallGeometry", () => {
  it("winds every facet outward, so no chamfer is culled into an open seam at the corners", () => {
    expect(inwardFacets(buildingWallGeometry(), () => new THREE.Vector3())).toEqual([]);
  });

  it("stays a shared, module-cached geometry — same object every call", () => {
    expect(buildingWallGeometry()).toBe(buildingWallGeometry());
  });

  it("never exceeds the original unit cube's bounds", () => {
    const geometry = buildingWallGeometry();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // A tiny floating-point margin, not a real allowance — the chamfer cuts
    // INTO the corners, it must never add anything outside -0.5..0.5.
    const eps = 1e-6;
    expect(box.min.x).toBeGreaterThanOrEqual(-0.5 - eps);
    expect(box.min.y).toBeGreaterThanOrEqual(-0.5 - eps);
    expect(box.min.z).toBeGreaterThanOrEqual(-0.5 - eps);
    expect(box.max.x).toBeLessThanOrEqual(0.5 + eps);
    expect(box.max.y).toBeLessThanOrEqual(0.5 + eps);
    expect(box.max.z).toBeLessThanOrEqual(0.5 + eps);
  });

  it("is a cheap, non-indexed chamfered box — 44 triangles, not a smoothly rounded 192", () => {
    const geometry = buildingWallGeometry();
    expect(geometry.index).toBeNull();
    expect(geometry.attributes.position.count).toBe(44 * 3);
  });

  it("has finite, non-degenerate normals for every vertex (a real flat facet, not a collapsed one)", () => {
    const geometry = buildingWallGeometry();
    const normal = geometry.attributes.normal;
    expect(normal).toBeDefined();
    const v = new THREE.Vector3();
    for (let i = 0; i < normal.count; i++) {
      v.fromBufferAttribute(normal, i);
      expect(Number.isFinite(v.length())).toBe(true);
      expect(v.length()).toBeGreaterThan(0.9);
    }
  });

  it("keeps every UV inside 0..1 (a real regression: UVs outside this range silently lose the facade texture)", () => {
    // `buildingFacadeTexture()`'s texture uses the default
    // `ClampToEdgeWrapping` — a UV outside 0..1 samples the texture's
    // clamped edge pixel instead of the actual window/door pattern. A first
    // version of this geometry derived UV from bare vertex position after
    // the fact (`x + z + 1`, `y + 0.5`) and produced values well outside
    // this range on most faces, silently erasing the facade detail on most
    // walls — caught by a rendered comparison, not a code read. This test
    // is the regression guard so it can't come back silently.
    const geometry = buildingWallGeometry();
    const uv = geometry.attributes.uv;
    expect(uv).toBeDefined();
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("buildingRoofGeometry", () => {
  it("stays a shared, module-cached geometry — same object every call", () => {
    expect(buildingRoofGeometry()).toBe(buildingRoofGeometry());
  });

  it("is a flat-topped frustum (a small cap, not a sharp point) within the old cone's bounds", () => {
    const geometry = buildingRoofGeometry();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // Same base radius (1) and height range (-0.5..0.5) `coneGeometry(1, 1,
    // 4)` used, so every existing `dummy.position`/`scale` computation in
    // `TownView.tsx` stays correct unchanged.
    const eps = 1e-6;
    expect(box.min.y).toBeCloseTo(-0.5, 5);
    expect(box.max.y).toBeCloseTo(0.5, 5);
    expect(Math.abs(box.min.x)).toBeLessThanOrEqual(1 + eps);
    expect(Math.abs(box.max.x)).toBeLessThanOrEqual(1 + eps);
  });

  it("stays cheap — a modest triangle count next to the old 8-triangle cone", () => {
    const geometry = buildingRoofGeometry();
    const triangleCount = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
    expect(triangleCount).toBeLessThanOrEqual(20);
  });
});

describe("flatRoofGeometry", () => {
  it("winds every facet of the parapet, deck and slab outward", () => {
    // Emitted in order: four parapet boxes (10 triangles each), the deck
    // (2, facing up), then the slab (10). Each box is judged from its centre.
    const centres = [[0, 0.3, -0.45], [0, 0.3, 0.45], [-0.45, 0.3, 0], [0.45, 0.3, 0]].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const geometry = flatRoofGeometry();
    let triangle = 0;
    const insideOf = (c: THREE.Vector3) => {
      const t = triangle++;
      if (t < 40) return centres[Math.floor(t / 10)];
      if (t < 42) return new THREE.Vector3(c.x, 0, c.z); // the deck, judged from below
      return new THREE.Vector3(0, -0.2, 0);
    };
    expect(geometry.attributes.position.count / 3).toBe(52);
    expect(inwardFacets(geometry, insideOf)).toEqual([]);
  });
});
