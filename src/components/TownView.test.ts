// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  BuildingInstances,
  buildKindBuckets,
  clampTooltipPosition,
  DistrictPad,
  Ground,
  isometricDepthRange,
  isSameHoveredBuilding,
  RoadNetwork,
  skyDomeRadius,
  TownVegetation,
} from "./TownView";
import type { CityLayout, CityModel } from "../city";

// The bug from the author's screenshot: a hover tooltip rendered clipped at
// the very bottom edge of the window. `clampTooltipPosition` is the pure fix
// — see its own doc comment for the two independent causes. These tests
// cover the clamping math directly, without needing a rendered WebGL canvas
// or a simulated pointer event.
describe("clampTooltipPosition", () => {
  const STAGE_W = 1200;
  const STAGE_H = 800;

  it("places the tooltip near the cursor, offset down-and-right, when there is room", () => {
    const { left, top } = clampTooltipPosition(100, 100, STAGE_W, STAGE_H);
    expect(left).toBeGreaterThan(100);
    expect(top).toBeGreaterThan(100);
  });

  it("flips to the other side of the cursor instead of overflowing the right edge", () => {
    const cursorX = STAGE_W - 20;
    const { left } = clampTooltipPosition(cursorX, 100, STAGE_W, STAGE_H);
    expect(left).toBeLessThan(cursorX);
    expect(left + 280).toBeLessThanOrEqual(STAGE_W);
  });

  // The exact bug: a cursor near the BOTTOM edge must never place the
  // tooltip below the visible stage.
  it("flips to the other side of the cursor instead of overflowing the bottom edge", () => {
    const cursorY = STAGE_H - 10;
    const { top } = clampTooltipPosition(100, cursorY, STAGE_W, STAGE_H);
    expect(top).toBeLessThan(cursorY);
    expect(top + 30).toBeLessThanOrEqual(STAGE_H);
  });

  it("stays fully inside the stage even in a corner, where flipping alone is not enough", () => {
    const { left, top } = clampTooltipPosition(STAGE_W - 2, STAGE_H - 2, STAGE_W, STAGE_H);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + 280).toBeLessThanOrEqual(STAGE_W + 1);
    expect(top + 30).toBeLessThanOrEqual(STAGE_H + 1);
  });

  it("degrades gracefully on a tiny stage (never returns a negative position)", () => {
    const { left, top } = clampTooltipPosition(50, 50, 100, 60);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });
});

// CRITICAL 1 (Opus frontend review): `formFor`'s tower/squat variant used to
// also override HEIGHT — the one measurement this town exists to show — so a
// tiny file that happened to hash to "tower" drew taller than a genuinely
// huge file, and a huge file hashing to "squat" drew shorter than a tiny one.
// These three paths are fixed points of `formFor`'s hash (`city.ts`,
// TOWER_PCT/SQUAT_PCT = 7 each, keyed on `${path}#form}`): "src/file11.ts"
// always rolls "tower", "src/file24.ts" always rolls "squat", "src/file0.ts"
// always falls through to "normal". Pinning real paths (rather than mocking
// `formFor`) is deliberate — this is the same hash real buildings go
// through, so a regression here is the exact bug a rendered town would show.
describe("buildKindBuckets", () => {
  function cityModel(): CityModel {
    return {
      root: "/p/repo",
      name: "repo",
      skipped: 0,
      submodules: 0,
      districts: [
        {
          path: "src",
          name: "src",
          walled: false,
          depth: 0,
          buildings: [
            { path: "src/file11.ts", name: "file11.ts", kind: "Source", lines: 5, height: 1 },
            { path: "src/file24.ts", name: "file24.ts", kind: "Source", lines: 3000, height: 5 },
            { path: "src/file0.ts", name: "file0.ts", kind: "Source", lines: 400, height: 3 },
          ],
        },
      ],
    };
  }

  function cityLayout(): CityLayout {
    return {
      width: 20,
      depth: 20,
      grid_pitch: 1,
      districts: [
        {
          district_index: 0,
          plot: { x: 0, z: 0, w: 10, d: 10 },
          road_edges: [],
          buildings: [
            // building_index 0: hashes to "tower", but its OWN real bucket
            // is the smallest (1) — a tiny file.
            { building_index: 0, x: 0, z: 0, height: 1 },
            // building_index 1: hashes to "squat", but its OWN real bucket
            // is the largest (5) — a huge file.
            { building_index: 1, x: 2, z: 0, height: 5 },
            // building_index 2: hashes to "normal" — a mid-size file.
            { building_index: 2, x: 4, z: 0, height: 3 },
          ],
        },
      ],
    };
  }

  it("keeps height a pure function of the real line-count bucket, regardless of the tower/squat variant", () => {
    const buckets = buildKindBuckets(cityModel(), cityLayout(), 1);
    const [towerHeight, squatHeight, normalHeight] = buckets.Source.transforms.map((t) => t.height);
    // The bucket-5 file ("squat") must draw TALLEST, the bucket-1 file
    // ("tower") SHORTEST, and the bucket-3 file in between — real height,
    // never the variant, decides. Against the old code this was inverted:
    // the "tower" (bucket 1) drew as `buildingWorldHeight(5) * 1.1` and the
    // "squat" (bucket 5) drew as `buildingWorldHeight(1) * 0.8`.
    expect(squatHeight).toBeGreaterThan(normalHeight);
    expect(normalHeight).toBeGreaterThan(towerHeight);
  });

  it("still varies footprint by variant — narrow for a tower, wide for a squat — without touching height", () => {
    const buckets = buildKindBuckets(cityModel(), cityLayout(), 1);
    const [towerFootprint, squatFootprint] = buckets.Source.transforms.map((t) => t.footprint);
    expect(towerFootprint).toBeLessThan(squatFootprint);
  });
});

// Cost-of-hover round (Item 2 of the resource-hygiene report): a pointer
// move over a 1,064-building town used to raycast ~2,130 instances (walls +
// roofs) AND allocate a fresh hover object on every single event, forcing a
// full `TownView` re-render (and, before this round, every un-memoised child
// underneath it) even while the cursor sat still inside the same building.
// `isSameHoveredBuilding` is the pure predicate `BuildingInstances`'s
// `handleHover` now checks before ever calling `onHover` — these tests cover
// it directly, the same way `clampTooltipPosition` above is tested without
// any r3f/WebGL plumbing.
describe("isSameHoveredBuilding", () => {
  const metaA = { path: "src/a.ts" };
  const metaB = { path: "src/b.ts" };
  const transformA = { x: 0 };
  const transformB = { x: 1 };

  it("is false the first time anything is hovered (no previous state)", () => {
    expect(isSameHoveredBuilding(null, metaA, transformA)).toBe(false);
  });

  it("is true for the SAME building reported twice — the common case while the cursor drifts within its footprint", () => {
    const last = { meta: metaA, transform: transformA };
    expect(isSameHoveredBuilding(last, metaA, transformA)).toBe(true);
  });

  it("is false when the meta changed (moved to a different building)", () => {
    const last = { meta: metaA, transform: transformA };
    expect(isSameHoveredBuilding(last, metaB, transformA)).toBe(false);
  });

  it("is false when the transform changed, even if meta happens to match", () => {
    const last = { meta: metaA, transform: transformA };
    expect(isSameHoveredBuilding(last, metaA, transformB)).toBe(false);
  });

  it("never compares by VALUE — two structurally-identical-but-distinct objects are a real change", () => {
    const last = { meta: { path: "src/a.ts" }, transform: transformA };
    // A different object with the same `path` string — this must NOT be
    // treated as "the same building": `bucket.metas`/`transforms` are
    // stable array elements in the real caller, so reference equality is the
    // correct (and only correct) comparison here.
    expect(isSameHoveredBuilding(last, { path: "src/a.ts" }, transformA)).toBe(false);
  });
});

// Cost-of-hover round (Item 2): the OTHER half of "so React can bail out" —
// even on the (rarer) event where the hovered building genuinely changes and
// `TownView` really does re-render, its heavy children must not blindly
// re-execute. `React.memo` needs stable props to bail on (see
// `TownView`'s own `handleDistrictSelect`/`handleBuildingSelect` — hoisted
// out of an inline JSX closure for exactly this) and each of these is
// wrapped in it.
describe("the town's heavy per-district/per-building components are memoised", () => {
  const REACT_MEMO = Symbol.for("react.memo");

  it("DistrictPad, RoadNetwork, TownVegetation, Ground, and BuildingInstances are all React.memo-wrapped", () => {
    for (const component of [DistrictPad, RoadNetwork, TownVegetation, Ground, BuildingInstances]) {
      expect((component as unknown as { $$typeof: symbol }).$$typeof).toBe(REACT_MEMO);
    }
  });
});

// Halo-and-camera round, item 2 — the near-plane clip.
//
// `fitIsometricCamera` derives the camera's DISTANCE from the tight default
// framing while `CameraRig` derives `minZoom` from the full outer bounds, so
// at full zoom-out the frame is several times wider than the camera is far
// from the scene. With the old fixed `near = 0.1` that clipped the water
// plane along a straight horizontal line — measured at 22% of the frame
// height on a 1100x720 render of the real 73-island sea.
//
// The suite has never caught a visual problem in this project first (README),
// and it would not have caught this one either — but once the geometry is
// understood it is exactly expressible, so these pin the arithmetic so a
// later tweak to the framing cannot quietly reintroduce it.
describe("isometricDepthRange", () => {
  // The real, measured sea: `outerBounds` diagonal 1258.66, the tight default
  // framing 432.44 (so `cameraDistance` = 432.44 * 2 + 20), fitted at
  // 1100x720 with `MIN_ZOOM_FACTOR` 0.5 -> a visible half-height of 889.7
  // world units, and the default framing 379.6 units off the sea's centre.
  const SEA = {
    cameraDistance: 884.87,
    elevation: new THREE.Vector3(1, 0.82, 1).normalize().y,
    visibleHalfHeight: 889.7,
    sceneDiagonal: 1258.66,
    focusOffset: 379.6,
  };

  /** How far along the view axis a ground point at screen-space half-height
   * `h` sits from one at the centre of frame. Derived independently of the
   * implementation: the camera's screen-HORIZONTAL axis lies in the ground
   * plane, so only the vertical one tilts, by cot(elevation). */
  function groundDepthOffset(halfHeight: number, elevation: number): number {
    return (Math.sqrt(1 - elevation * elevation) / elevation) * halfHeight;
  }

  it("puts the near plane in front of the nearest ground the frame can ever show", () => {
    const { near } = isometricDepthRange(SEA);
    const nearestVisibleGround =
      SEA.cameraDistance -
      groundDepthOffset(SEA.visibleHalfHeight, SEA.elevation) -
      SEA.focusOffset;
    expect(near).toBeLessThan(nearestVisibleGround);
  });

  it("needs a NEGATIVE near plane to do it — which is exactly why 0.1 could not work", () => {
    expect(isometricDepthRange(SEA).near).toBeLessThan(0);
    // ...and the old value was on the wrong side of the ground it had to clear.
    expect(0.1).toBeGreaterThan(
      SEA.cameraDistance - groundDepthOffset(SEA.visibleHalfHeight, SEA.elevation) - SEA.focusOffset,
    );
  });

  it("still clips the sky dome's NEAR hemisphere away", () => {
    // `Atmosphere`'s dome is a `BackSide` sphere with `depthWrite={false}`:
    // it is only ever a clean backdrop while its near half is clipped. Stop
    // clipping it and its triangles paint over the far half's in arbitrary
    // draw order.
    const { near } = isometricDepthRange(SEA);
    const domeNearPoint =
      SEA.cameraDistance - SEA.focusOffset - skyDomeRadius(SEA.sceneDiagonal);
    expect(near).toBeGreaterThan(domeNearPoint);
  });

  it("puts the far plane beyond the sky dome, the furthest thing drawn", () => {
    const { far } = isometricDepthRange(SEA);
    expect(far).toBeGreaterThan(
      SEA.cameraDistance + SEA.focusOffset + skyDomeRadius(SEA.sceneDiagonal),
    );
  });

  // An orthographic depth buffer is LINEAR in camera-space z, so what
  // threatens the scene's coplanar surfaces (water at -0.06, the halo at
  // -0.045, the search ring at -0.05, all under the terrain) is the RANGE,
  // not the near/far ratio a perspective camera cares about. The smallest
  // separation that must survive is 0.005 world units in Y, which the view
  // direction foreshortens to 0.005 * elevation along the depth axis.
  it("keeps the depth range small enough that the scene's coplanar surfaces stay resolvable", () => {
    const { near, far } = isometricDepthRange(SEA);
    const quantum = (far - near) / 2 ** 24; // 24-bit depth, measured in the real headless GPU
    expect(0.005 * SEA.elevation).toBeGreaterThan(quantum * 4);
  });

  it("collapses to a tight slab when the whole scene is what is framed (a town)", () => {
    const town = {
      cameraDistance: 300,
      elevation: SEA.elevation,
      visibleHalfHeight: 160,
      sceneDiagonal: 140,
      focusOffset: 0,
    };
    const { near, far } = isometricDepthRange(town);
    expect(far - near).toBeLessThan(2000);
    expect(far).toBeGreaterThan(town.cameraDistance + skyDomeRadius(town.sceneDiagonal));
  });
});
