import { describe, expect, it } from "vitest";
import {
  diffTownLines,
  townLines,
  buildingColor,
  cellCenter,
  cityStats,
  contentExtent,
  FALLBACK_GRID_PITCH,
  footprintClearance,
  formFor,
  gridPitchOf,
  townVillagerSlots,
  worldUnits,
  type CityLayout,
  type CityModel,
  type District,
  type PlacedDistrict,
} from "./city";

describe("worldUnits", () => {
  it("maps grid cells to world units with a consistent scale", () => {
    expect(worldUnits(0)).toBe(0);
    expect(worldUnits(2)).toBe(worldUnits(1) * 2);
  });

  // The test above is satisfied by ANY linear scale, including a wrong
  // `CELL_SIZE` — the same weakness `buildingColor`'s brief-given test had
  // (see below). Pin the exact value: `city::layout`'s grid units already
  // bake in `MARGIN`/`SPACING`, so this must stay a 1:1 mapping, not merely
  // "some" linear one.
  it("uses a 1:1 scale, not merely some linear one", () => {
    expect(worldUnits(1)).toBe(1);
  });
});

describe("cellCenter", () => {
  // Final whole-branch review, Critical 1: a building used to sit at
  // `worldUnits(placed.x)` directly — the cell's CORNER — which straddled
  // the boundary with the PREVIOUS cell instead of sitting inside its own.
  // `cellCenter` is the fix, and every one of these pins the exact
  // half-cell offset, not merely "some" offset.
  it("is half a cell past the cell's own corner", () => {
    expect(cellCenter(0)).toBe(0.5);
    expect(cellCenter(1)).toBe(1.5);
  });

  // The concrete regression this guards: an off-by-one in a district's own
  // plot origin could hide behind a test that only ever used cell 0 (where
  // a corner-vs-centre bug and a sign error can look identical). Pin a
  // district whose plot does NOT start at the origin.
  it("holds for a non-zero cell coordinate (a district whose plot origin isn't 0)", () => {
    expect(cellCenter(5)).toBe(5.5);
    expect(cellCenter(12)).toBe(12.5);
  });

  it("matches the convention RoadNetwork already used for tile centres (worldUnits(cell) + 0.5)", () => {
    for (const cell of [0, 1, 5, 12]) {
      expect(cellCenter(cell)).toBe(worldUnits(cell) + 0.5);
    }
  });
});

describe("buildingColor", () => {
  it("gives every kind its own colour", () => {
    const kinds = ["Source", "Test", "Config", "Docs", "Asset", "Data"] as const;
    const colors = new Set(kinds.map(buildingColor));
    expect(colors.size).toBe(kinds.length);
  });

  it("is deterministic", () => {
    expect(buildingColor("Source")).toBe(buildingColor("Source"));
  });

  // The two tests above pass on six wrong-but-distinct colours. Pinned here
  // to `city::preview::kind_color`'s exact table (task-6-design-inputs.md
  // §4) so the SVG preview and this 3D view are provably the same palette,
  // not two products that merely both happen to use six different colours.
  it("matches city::preview::kind_color exactly", () => {
    expect(buildingColor("Source")).toBe("#8fb2d9");
    expect(buildingColor("Test")).toBe("#8fcb9b");
    expect(buildingColor("Config")).toBe("#e0c27a");
    expect(buildingColor("Docs")).toBe("#b9a6da");
    expect(buildingColor("Asset")).toBe("#e2a0ae");
    expect(buildingColor("Data")).toBe("#7fcbc0");
  });
});

describe("contentExtent", () => {
  function district(plot: PlacedDistrict["plot"], buildings: PlacedDistrict["buildings"]): PlacedDistrict {
    return { district_index: 0, plot, buildings, road_edges: [] };
  }

  it("falls back to a minimum 3x3 footprint for an empty district", () => {
    expect(contentExtent(district({ x: 0, z: 0, w: 9, d: 9 }, []))).toEqual([3, 3]);
  });

  it("is the exact minimum rectangle around the buildings, not the reserved plot", () => {
    // One building at local (1, 1) inside a plot reserved much larger than
    // that (headroom for future growth — see `city::layout`'s module docs):
    // content extent must reflect what is actually built, not the
    // reservation.
    const d = district(
      { x: 0, z: 0, w: 11, d: 11 },
      [{ building_index: 0, x: 1, z: 1, height: 1 }],
    );
    expect(contentExtent(d)).toEqual([3, 3]);
  });

  it("never exceeds the reserved plot even if the math would suggest more", () => {
    const d = district(
      { x: 0, z: 0, w: 4, d: 4 },
      [{ building_index: 0, x: 5, z: 5, height: 1 }],
    );
    expect(contentExtent(d)).toEqual([4, 4]);
  });
});

describe("formFor", () => {
  it("is deterministic — the same path always gets the same form", () => {
    const a = formFor("src/components/TownView.tsx");
    const b = formFor("src/components/TownView.tsx");
    expect(a).toEqual(b);
  });

  it("gives different paths independently-derived forms, not one shared value", () => {
    const a = formFor("src/components/TownView.tsx");
    const b = formFor("src/city.ts");
    // Not asserting they must differ (a coincidence is allowed) — asserting
    // the function actually reads its input rather than ignoring it.
    expect(formFor("src/components/TownView.tsx")).toEqual(a);
    expect(a === b || JSON.stringify(a) !== JSON.stringify(b)).toBe(true);
  });

  it("keeps every value within its documented range", () => {
    for (const path of ["a", "b/c.ts", "very/long/nested/path/to/a/file.rs", "x".repeat(50)]) {
      const form = formFor(path);
      expect(["normal", "tower", "squat"]).toContain(form.variant);
      expect(form.heightJitter).toBeGreaterThanOrEqual(0.9);
      expect(form.heightJitter).toBeLessThanOrEqual(1.1);
      expect(form.roofPitch).toBeGreaterThanOrEqual(0.3);
      expect(form.roofPitch).toBeLessThanOrEqual(0.55);
    }
  });

  // "A minority," per the brief — checked over a large deterministic sample
  // rather than asserted on any one path, since any single path could
  // legitimately hash to either bucket.
  it("keeps tower and squat as a minority across many paths", () => {
    const paths = Array.from({ length: 2000 }, (_, i) => `src/file-${i}.ts`);
    const counts = { normal: 0, tower: 0, squat: 0 };
    for (const path of paths) counts[formFor(path).variant]++;
    expect(counts.tower).toBeLessThan(counts.normal);
    expect(counts.squat).toBeLessThan(counts.normal);
    expect(counts.tower + counts.squat).toBeLessThan(paths.length * 0.3);
  });
});

describe("gridPitchOf", () => {
  it("falls back to FALLBACK_GRID_PITCH when the payload has no grid_pitch", () => {
    expect(gridPitchOf({ grid_pitch: undefined })).toBe(FALLBACK_GRID_PITCH);
  });

  // The whole point of `gridPitchOf`: once `city::layout` sends its own
  // `grid_pitch`, that value must win over the fallback, not the reverse —
  // a stale fallback silently overriding a real value on the wire is
  // exactly the drift this contract exists to prevent.
  it("prefers the payload's own grid_pitch over the fallback", () => {
    expect(gridPitchOf({ grid_pitch: 1 })).toBe(1);
    expect(gridPitchOf({ grid_pitch: 3 })).toBe(3);
  });
});

describe("footprintClearance", () => {
  // Coordinator correction, packing pass: renamed from `worstCaseGap`, and
  // the guarantee it proves changed along with the name — see the function's
  // own doc comment for why. `SPACING` (the wire's `grid_pitch`) went `2` ->
  // `1` in `4717763`, "let buildings abut": adjacent cells are now meant to
  // visually touch, so the old invariant (a real, positive GAP between
  // neighbours) would have asserted the opposite of what the model now
  // says. What must still hold at ANY pitch: the widest footprint never
  // crosses into a neighbouring cell — that would misattribute rendered
  // space to the wrong file, the same honesty requirement `worstCaseGap`
  // used to prove, in the new shape the packing change requires.
  it("never lets the widest footprint cross into a neighbouring cell, at today's real pitch", () => {
    const { wallClearance, roofClearance } = footprintClearance(1);
    expect(wallClearance).toBeGreaterThanOrEqual(0);
    expect(roofClearance).toBeGreaterThanOrEqual(0);
  });

  // The fallback pitch is a real code path (`gridPitchOf` reaches for it
  // whenever a payload lacks `grid_pitch`), not just a historical footnote —
  // the invariant has to hold there too, not only at today's real value.
  it("holds at the historical fallback pitch too — the invariant must survive either value", () => {
    const { wallClearance, roofClearance } = footprintClearance(FALLBACK_GRID_PITCH);
    expect(wallClearance).toBeGreaterThanOrEqual(0);
    expect(roofClearance).toBeGreaterThanOrEqual(0);
  });

  // `footprintClearance` is linear in `gridPitch` (clearance scales with
  // `gridPitch * (1 - frac)`), so the invariant is scale-invariant in
  // principle — pinned down here at a pitch neither of the two values above
  // happens to use, rather than assumed.
  it("holds at an arbitrary pitch, not just the two values this file happens to use today", () => {
    const { wallClearance, roofClearance } = footprintClearance(5);
    expect(wallClearance).toBeGreaterThanOrEqual(0);
    expect(roofClearance).toBeGreaterThanOrEqual(0);
  });

  it("is exercised through gridPitchOf against a real payload shape, not a bare constant", () => {
    const layout: Pick<CityLayout, "grid_pitch"> = { grid_pitch: 1 };
    const { wallClearance, roofClearance } = footprintClearance(gridPitchOf(layout));
    expect(wallClearance).toBeGreaterThanOrEqual(0);
    expect(roofClearance).toBeGreaterThanOrEqual(0);
  });

  // Final whole-branch review, Critical 1 (still true after the rename):
  // fixing the corner-vs-centre bug (see `cellCenter`) shifts every
  // building's rendered position by the same half-cell amount, in both x
  // and z. Neither `footprintClearance` nor `cellCenter` reference an
  // absolute position — pinned down here rather than assumed: two buildings
  // one grid-pitch apart still have exactly that many world units between
  // their (correctly centred) positions, uniform shift and all.
  it("the shift from the Critical-1 fix does not change the distance between adjacent building centres", () => {
    const pitch = gridPitchOf({ grid_pitch: 1 });
    const a = cellCenter(3);
    const b = cellCenter(3 + pitch);
    expect(b - a).toBe(pitch);
  });
});

// I4 (Opus frontend review): `CityModel.skipped`/`submodules` were defined
// on the wire but never rendered anywhere — a fully vendored repository (all
// real files, zero indexed) drew identically to a genuinely empty one, "0
// districts · 0 buildings" either way.
describe("cityStats", () => {
  function model(overrides: Partial<CityModel> = {}): CityModel {
    return { root: "/p/repo", name: "repo", districts: [], skipped: 0, submodules: 0, ...overrides };
  }

  it("reports plain district/building counts when nothing was skipped", () => {
    const district: District = { path: "src", name: "src", walled: false, depth: 0, buildings: [{ path: "a", name: "a", kind: "Source", lines: 10, height: 1 }] };
    expect(cityStats(model({ districts: [district] }))).toBe("1 districts · 1 buildings");
  });

  it("says nothing extra for a genuinely empty repo (0/0/0) — 'nothing here'", () => {
    expect(cityStats(model())).toBe("0 districts · 0 buildings");
  });

  it("surfaces skipped files — 'we could not find out' rather than 'nothing here'", () => {
    expect(cityStats(model({ skipped: 340 }))).toBe("0 districts · 0 buildings · 340 skipped");
  });

  it("surfaces submodules, correctly pluralized", () => {
    expect(cityStats(model({ submodules: 1 }))).toBe("0 districts · 0 buildings · 1 submodule");
    expect(cityStats(model({ submodules: 3 }))).toBe("0 districts · 0 buildings · 3 submodules");
  });

  it("surfaces both when both are nonzero", () => {
    expect(cityStats(model({ skipped: 12, submodules: 2 }))).toBe(
      "0 districts · 0 buildings · 12 skipped · 2 submodules",
    );
  });
});

describe("townVillagerSlots", () => {
  function district(name: string, walled: boolean): District {
    return { path: name, name, buildings: [], walled, depth: 1 };
  }
  function placed(
    index: number,
    plot: PlacedDistrict["plot"],
    roadEdges: [number, number][],
  ): PlacedDistrict {
    return { district_index: index, plot, buildings: [], road_edges: roadEdges };
  }
  function model(districts: District[]): CityModel {
    return { root: "/repo", name: "repo", districts, skipped: 0, submodules: 0 };
  }
  function layout(districts: PlacedDistrict[], width = 20, depth = 20): CityLayout {
    return { districts, width, depth, grid_pitch: 1 };
  }

  it("prefers an UNWALLED district's own street cells over a walled one's", () => {
    const m = model([district("open", false), district("vault", true)]);
    const l = layout([
      placed(0, { x: 0, z: 0, w: 5, d: 5 }, [
        [0, 0],
        [1, 0],
      ]),
      placed(1, { x: 10, z: 10, w: 5, d: 5 }, [
        [10, 10],
        [11, 10],
      ]),
    ]);
    expect(townVillagerSlots(m, l)).toEqual([
      { x: cellCenter(0), z: cellCenter(0) },
      { x: cellCenter(1), z: cellCenter(0) },
    ]);
  });

  it("falls back to every street cell, walled ones included, if the city has no unwalled ones", () => {
    const m = model([district("vault", true)]);
    const l = layout([
      placed(0, { x: 0, z: 0, w: 5, d: 5 }, [
        [0, 0],
        [1, 0],
      ]),
    ]);
    expect(townVillagerSlots(m, l)).toEqual([
      { x: cellCenter(0), z: cellCenter(0) },
      { x: cellCenter(1), z: cellCenter(0) },
    ]);
  });

  // Never an empty list — a district-less (or empty) city must still give a
  // villager somewhere to stand, not silently drop it.
  it("falls back to the town's own centre for a district-less city", () => {
    const m = model([]);
    const l = layout([], 20, 30);
    expect(townVillagerSlots(m, l)).toEqual([{ x: worldUnits(20) / 2, z: worldUnits(30) / 2 }]);
  });

  // The same convention `RoadNetwork` already draws its own tiles at
  // (`cellCenter`, not the cell's raw corner) — a villager standing at the
  // corner would visibly straddle the boundary between two street tiles.
  it("places a slot at the cell's CENTRE, not its corner", () => {
    const m = model([district("open", false)]);
    const l = layout([placed(0, { x: 0, z: 0, w: 5, d: 5 }, [[3, 4]])]);
    expect(townVillagerSlots(m, l)).toEqual([{ x: cellCenter(3), z: cellCenter(4) }]);
  });

  // A walled district's `walled` fact comes from `CityModel`, joined by
  // `district_index` — not from `PlacedDistrict` itself, which has no
  // `walled` field. A district_index with no matching model district must
  // not throw, and must be treated as unwalled (the safe default: showing a
  // villager on an ordinary street is a smaller honesty risk than hiding one
  // behind a fabricated wall).
  it("treats a district with no matching model entry as unwalled rather than throwing", () => {
    const m = model([]);
    const l = layout([placed(0, { x: 0, z: 0, w: 5, d: 5 }, [[0, 0]])]);
    expect(() => townVillagerSlots(m, l)).not.toThrow();
    expect(townVillagerSlots(m, l)).toEqual([{ x: cellCenter(0), z: cellCenter(0) }]);
  });
});

describe("diffTownLines", () => {
  const model = (files: Record<string, number>): CityModel => ({
    root: "/r", name: "r", skipped: 0, submodules: 0,
    districts: [{ path: "/r", name: "r", walled: false, depth: 0,
      buildings: Object.entries(files).map(([path, lines]) => ({ path, name: path, kind: "Source" as const, lines, height: 1 })) }],
  });

  it("reports nothing on the first measurement — there is nothing to compare against", () => {
    expect(diffTownLines(null, townLines(model({ "/r/a.ts": 10 })))).toEqual({ added: new Set(), deltas: [] });
  });

  it("reports the real line change of every edited file, and new files as new", () => {
    const before = townLines(model({ "/r/a.ts": 10, "/r/b.ts": 50, "/r/same.ts": 5 }));
    const after = townLines(model({ "/r/a.ts": 52, "/r/b.ts": 40, "/r/same.ts": 5, "/r/new.ts": 30 }));
    const growth = diffTownLines(before, after);
    expect(growth.added).toEqual(new Set(["/r/new.ts"]));
    expect(growth.deltas).toEqual([
      { path: "/r/a.ts", delta: 42, isNew: false },
      { path: "/r/new.ts", delta: 30, isNew: true },
      { path: "/r/b.ts", delta: -10, isNew: false },
    ]);
  });

  it("keeps only the biggest changes, so a sweeping edit does not bury the town in labels", () => {
    const before = townLines(model(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/r/${i}.ts`, 1]))));
    const after = townLines(model(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/r/${i}.ts`, 2 + i]))));
    const growth = diffTownLines(before, after, 5);
    expect(growth.deltas.map(d => d.delta)).toEqual([30, 29, 28, 27, 26]);
  });
});

describe("roof shapes", () => {
  it("gives towers a pyramid and squat halls a flat roof", () => {
    const paths = Array.from({ length: 400 }, (_, i) => `/r/file-${i}.ts`);
    for (const path of paths) {
      const form = formFor(path);
      if (form.variant === "tower") expect(form.roofShape).toBe("pyramid");
      if (form.variant === "squat") expect(form.roofShape).toBe("flat");
    }
  });

  it("mixes gables and hipped roofs across ordinary houses, the same every time", () => {
    const shapes = Array.from({ length: 400 }, (_, i) => formFor(`/r/file-${i}.ts`).roofShape);
    expect(shapes.filter((s) => s === "gable").length).toBeGreaterThan(150);
    expect(shapes.filter((s) => s === "hip").length).toBeGreaterThan(70);
    expect(formFor("/r/a.ts")).toEqual(formFor("/r/a.ts"));
  });
});
