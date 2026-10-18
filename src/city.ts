/**
 * Types and pure helpers for the town view. The types below mirror
 * `src-tauri/src/city/model.rs` and `.../layout.rs`'s `Serialize`d structs
 * FIELD FOR FIELD, in the same snake_case those derives emit (neither Rust
 * struct uses `#[serde(rename_all = "camelCase")]`, so there is no case
 * conversion anywhere on this wire) — see `CityView`, which is exactly what
 * the `city_for` command returns.
 */

export type BuildingKind = "Source" | "Test" | "Config" | "Docs" | "Asset" | "Data";

export type Building = {
  path: string;
  name: string;
  kind: BuildingKind;
  lines: number;
  height: number;
};

export type District = {
  path: string;
  name: string;
  buildings: Building[];
  walled: boolean;
  depth: number;
};

export type CityModel = {
  root: string;
  name: string;
  districts: District[];
  skipped: number;
  /** Git submodules found at `root` — excluded from every district, and
   * counted separately from `skipped` (see `CityModel::submodules` in
   * `city::model`). */
  submodules: number;
};

export type Plot = { x: number; z: number; w: number; d: number };

export type PlacedBuilding = { building_index: number; x: number; z: number; height: number };

export type PlacedDistrict = {
  district_index: number;
  plot: Plot;
  buildings: PlacedBuilding[];
  road_edges: [number, number][];
};

export type CityLayout = {
  districts: PlacedDistrict[];
  width: number;
  depth: number;
  /**
   * The grid pitch (in grid cells) between one building's index and the next
   * along either axis — `city::layout::SPACING` on the wire, `1` as of the
   * "let buildings abut" change (`4717763`): adjacent building cells are now
   * actually adjacent, not one cell apart (`SPACING` went `2` -> `1`). Marked
   * optional here anyway, defensively — this TypeScript type is not the
   * thing that enforces the wire contract, and a reader that assumes a field
   * always exists is exactly the assumption that broke once already in this
   * file's history (the old, literally-hard-coded `GRID_PITCH = 2`). Every
   * reader of this value MUST go through `gridPitchOf` rather than reading
   * `grid_pitch` directly.
   */
  grid_pitch?: number;
};

/** What the `city_for` Tauri command returns: model and layout together. */
export type CityView = { model: CityModel; layout: CityLayout };

/**
 * I4 (Opus frontend review): `TownScreen`'s header caption used to be
 * `${districts} districts · ${buildings} buildings` alone — so a fully
 * vendored repository (every file real, none of it indexed into a district)
 * drew identically to a genuinely empty one, "0 districts · 0 buildings"
 * either way, even though `CityModel.skipped`/`submodules` already carry the
 * honest reason on the wire and were never read anywhere in this frontend.
 * This surfaces them: "nothing here" (both zero) reads differently from "we
 * could not find out" (either nonzero) now, the same distinction principle 4
 * requires everywhere else in this app.
 */
export function cityStats(model: CityModel): string {
  const districtCount = model.districts.length;
  const buildingCount = model.districts.reduce((sum, d) => sum + d.buildings.length, 0);
  const parts = [`${districtCount} districts`, `${buildingCount} buildings`];
  if (model.skipped > 0) parts.push(`${model.skipped} skipped`);
  if (model.submodules > 0) {
    parts.push(`${model.submodules} submodule${model.submodules === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

/**
 * Grid cell -> world unit, the one scale constant every piece of geometry
 * in `TownView` shares (buildings, district pads, road tiles) so nothing
 * drifts out of alignment with anything else. `city::layout`'s grid units
 * already bake in `MARGIN`/`SPACING` (one cell of margin, a two-cell stride
 * between buildings), so this is a plain linear scale, not a second layout
 * decision — 1 grid cell is 1 world unit.
 */
const CELL_SIZE = 1;

export function worldUnits(gridUnits: number): number {
  return gridUnits * CELL_SIZE;
}

/**
 * World-unit coordinate of a grid cell's CENTRE, not its corner.
 *
 * Final whole-branch review, Critical 1: `TownView` used to place a
 * building at `worldUnits(placed.x)` directly — the cell's CORNER — while
 * `RoadNetwork` draws road tiles at `worldUnits(cell) + 0.5` (their centre)
 * and `DistrictPad` spans `[plot.x, plot.x + w]` (cell corners, correct for
 * a span of whole cells). A building centred on its own cell's corner
 * straddles the boundary with the PREVIOUS cell instead of sitting inside
 * its own — with `buildingFootprint`'s 1.0..1.5 range, roughly 75% of the
 * first row/column of every district landed on that district's own
 * boundary street (and inside the brick wall, for a walled district).
 *
 * `cellCenter` is the correct convention, and the only place it now lives:
 * it mirrors `city::preview::preview_svg`'s building placement exactly — a
 * building there is drawn INSET WITHIN its own cell's box (`bx = b.x * CELL
 * + PADDING`, centred by `(CELL - size) / 2`), never straddling the
 * boundary with a neighbour. Every piece of geometry keyed off a cell
 * coordinate (buildings, roofs — which simply follow their building's own
 * `x`/`z` — and, already, roads/walls) must go through this, not restate
 * "+ 0.5" by hand, so the convention cannot silently drift out of step
 * again.
 */
export function cellCenter(gridUnits: number): number {
  return worldUnits(gridUnits + 0.5);
}

/**
 * Fallback for `CityLayout.grid_pitch` when a payload doesn't carry it (see
 * that field's doc comment) — deliberately the OLD `city::layout::SPACING`
 * value (`2`, before the "let buildings abut" change), not the current one:
 * a payload missing the field is, by definition, one this code cannot prove
 * is packed, so falling back to the sparser historical spacing is the
 * conservative guess, not the current one. This is a FALLBACK, not a source
 * of truth: every real read goes through `gridPitchOf`, which prefers the
 * payload's own `grid_pitch` and only reaches for this constant when the
 * field is missing. Every current Rust build sends `grid_pitch` (`1` as of
 * `4717763`), so this constant should almost never actually be reached
 * today — it existing at all is what let this code keep working across the
 * exact commit boundary where the Rust field landed, without this file
 * needing to change in lockstep.
 */
export const FALLBACK_GRID_PITCH = 2;

/**
 * The grid pitch actually in effect for a given layout: the payload's own
 * `grid_pitch` when present, `FALLBACK_GRID_PITCH` otherwise. Every piece of
 * geometry that needs to reason about spacing between building slots
 * (`buildingFootprint`, `footprintClearance`) must go through this rather than a
 * bare constant, so a future Rust change to the real pitch is picked up
 * automatically instead of silently drifting out of sync with what's
 * actually on the wire.
 */
export function gridPitchOf(layout: Pick<CityLayout, "grid_pitch">): number {
  return layout.grid_pitch ?? FALLBACK_GRID_PITCH;
}

/**
 * Per-`BuildingKind` colour. Pinned to `city::preview::kind_color`'s table
 * verbatim (task-6-design-inputs.md §4) — the same repository must not be a
 * different product in the SVG preview and in this 3D town. The brief's own
 * `buildingColor` test only checks the six colours are distinct and stable,
 * which a wrong-but-consistent palette would also pass — `city.test.ts`
 * pins the exact hex values below as the real requirement.
 */
const KIND_COLOR: Record<BuildingKind, string> = {
  Source: "#8fb2d9",
  Test: "#8fcb9b",
  Config: "#e0c27a",
  Docs: "#b9a6da",
  Asset: "#e2a0ae",
  Data: "#7fcbc0",
};

export function buildingColor(kind: BuildingKind): string {
  return KIND_COLOR[kind];
}

/**
 * A building's own footprint, in world units, as a function of its 1..=5
 * height bucket and the layout's actual grid pitch (`gridPitchOf(layout)` —
 * never a bare constant, see that function's doc comment).
 *
 * Coordinator correction, packing pass: `city::layout`'s `SPACING` (now the
 * wire's `grid_pitch`) went `2` -> `1` in `4717763` — buildings now sit in
 * ADJACENT cells, with no empty cell between them. The previous version of
 * this function kept the SAME fraction-of-pitch range (`0.5..0.75`) across
 * that change, which was exactly wrong: it halved the footprint's absolute
 * size right along with the pitch, preserving the old sparse LOOK even
 * though the model had just gotten denser. The whole point of the packing
 * change was for neighbours to actually touch and read as one block —
 * fractions this small left most of every cell showing as bare ground
 * (the "sand checkerboard" a coordinator review caught).
 *
 * `0.86..0.94` instead: a building now fills nearly the whole width of its
 * own cell. Two maximum-footprint neighbours leave only
 * `gridPitch * (1 - 0.94)` of clearance between them — see
 * `footprintClearance` for why that's still enough, and for what "enough"
 * now MEANS (not visual separation anymore; not crossing into a neighbour's
 * cell). Tuned by rendering all four sample repos and looking, per the
 * coordinator's instruction, not by arithmetic alone.
 */
const FOOTPRINT_FRAC_MIN = 0.86;
const FOOTPRINT_FRAC_MAX = 0.94;

export function buildingFootprint(heightBucket: number, gridPitch: number): number {
  const bucket = Math.min(5, Math.max(1, heightBucket));
  const frac = FOOTPRINT_FRAC_MIN + (bucket - 1) * ((FOOTPRINT_FRAC_MAX - FOOTPRINT_FRAC_MIN) / 4);
  return frac * gridPitch;
}

/**
 * World-unit Y extent for a building's 1..=5 height bucket, as a function of
 * the layout's actual grid pitch — like `buildingFootprint`, expressed as a
 * multiple of `gridPitch` rather than an absolute number, so the
 * height:footprint RATIO this was tuned for stays the same no matter what
 * pitch the layout actually uses (today `1`, previously `2`, and this file
 * has no way to know it won't change again). Height is finally free in 3D
 * (design inputs §2) — a flat step per bucket, not something logarithmic, so
 * a bucket-5 tower clearly reads as taller than a bucket-1 shed rather than
 * the difference being flattened away.
 *
 * Coordinator correction, packing pass: the previous version's height was an
 * ABSOLUTE constant, blind to `gridPitch`. Once `buildingFootprint` shrank
 * to `0.86..0.94` of the new, smaller pitch, that absolute height suddenly
 * towered over the new (much narrower in absolute terms) footprint — the
 * "skinny pillars" a coordinator review caught. Expressing height as a
 * fraction of `gridPitch` too (`HEIGHT_BASE_FRAC`/`HEIGHT_STEP_FRAC`) keeps
 * height and footprint scaling together, so the ratio survives any future
 * pitch change instead of breaking the same way again.
 *
 * Round 2 of the same correction (coordinator review, shading-fix pass):
 * `0.42` still read as "slabs or columns" once flat-shaded roofs stopped
 * hiding the real proportions — even the `2.7×` ratio that earlier looked
 * "chunky and solid" as a rough cone with smeared normals looked like a
 * pillar once the roof read as a crisp pyramid instead of a smudge. `0.26`
 * brings a height-5 building to `(0.85 + 0.26*4) / 0.94 ≈ 2.0×` its own
 * footprint's width — a bucket-1 building is still close to a CUBE (`0.85`
 * against a `0.86` footprint fraction), and a bucket-5 tower now reads as
 * "the tallest building in town," not a needle. Tuned by rendering AFTER
 * the flat-shading fix landed, per the coordinator's explicit instruction
 * not to tune this against a shading bug.
 */
const HEIGHT_BASE_FRAC = 0.85;
const HEIGHT_STEP_FRAC = 0.26;

export function buildingWorldHeight(heightBucket: number, gridPitch: number): number {
  const bucket = Math.min(5, Math.max(1, heightBucket));
  return (HEIGHT_BASE_FRAC + HEIGHT_STEP_FRAC * (bucket - 1)) * gridPitch;
}

/**
 * The district's CONTENT extent, in grid cells from the plot's own
 * top-left corner — the smallest rectangle that actually holds its current
 * buildings, as opposed to `plot.w`/`plot.d`, which is the RESERVED
 * footprint (padded with headroom for the next file, and never shrunk once
 * grown — see `city::layout`'s module docs). Independently mirrors
 * `city::preview::content_extent`'s exact algorithm against the same
 * `PlacedDistrict` data, so `TownView` draws a district's pad at the size
 * it's actually built to, not the size it's reserved for — the same "don't
 * paint headroom as an occupied plaza" fix Task 5's SVG review required.
 */
export function contentExtent(district: PlacedDistrict): [number, number] {
  if (district.buildings.length === 0) return [3, 3];
  let maxLocalX = 0;
  let maxLocalZ = 0;
  for (const b of district.buildings) {
    maxLocalX = Math.max(maxLocalX, b.x - district.plot.x);
    maxLocalZ = Math.max(maxLocalZ, b.z - district.plot.z);
  }
  const w = Math.min(Math.max(maxLocalX + 2, 1), district.plot.w);
  const d = Math.min(Math.max(maxLocalZ + 2, 1), district.plot.d);
  return [w, d];
}

/** A world-unit ground position — a villager standing spot, never a claim
 * about which building (if any) is nearby. See `townVillagerSlots`. */
export type GroundSlot = { x: number; z: number };

/**
 * Town-villagers round: deterministic standing spots for the agents working
 * in this repository's own town, drawn ONLY from cells the layout already
 * committed to being a STREET, never a building.
 *
 * We do not know which file (or district) an agent is actually editing —
 * Herdr reports a pane's `cwd`, not a file path, and guessing one from the
 * other is exactly the class of fabricated-fact bug this project has been
 * bitten by four times already (`docs/superpowers/phase-0-followups.md`
 * §6). So every candidate slot below is equally eligible for every agent:
 * this function returns candidates, never an assignment, and carries no
 * per-agent information at all. `Archipelago.tsx`'s own
 * `assignVillagerPositions` (shared, not re-derived) is what turns a list of
 * candidates into a stable per-`pane_id` choice.
 *
 * Candidates are every cell in every district's own `road_edges` — the
 * plot's perimeter, already computed by `city::layout::boundary_cells` and
 * already drawn as a paved tile by `RoadNetwork`. Those cells are
 * guaranteed free of buildings by construction: `city::layout` always
 * starts a district's building grid `MARGIN` cells in from the plot's own
 * edge (see that module's docs), so a building can never occupy the same
 * cell a road tile occupies. Choosing FROM this exact set — rather than any
 * other "empty-looking" ground — is what makes "never implies a connection
 * to any particular building" true by construction rather than by care.
 *
 * A WALLED district's own boundary cells are excluded first (`RoadNetwork`
 * draws a raised brick strip on those same cells — see `WALL_COLOR`), so a
 * villager never renders standing inside/behind a wall. Falls back to every
 * street cell (walled included) only if a city has no unwalled streets at
 * all, and to the town's own centre only if it has no streets whatsoever
 * (a district-less city) — never an empty list, which would silently drop
 * every villager from a town that does have room for them.
 */
export function townVillagerSlots(model: CityModel, layout: CityLayout): GroundSlot[] {
  const unwalled: GroundSlot[] = [];
  const all: GroundSlot[] = [];
  for (const district of layout.districts) {
    const walled = model.districts[district.district_index]?.walled ?? false;
    for (const [x, z] of district.road_edges) {
      const slot: GroundSlot = { x: cellCenter(x), z: cellCenter(z) };
      all.push(slot);
      if (!walled) unwalled.push(slot);
    }
  }
  if (unwalled.length > 0) return unwalled;
  if (all.length > 0) return all;
  return [{ x: worldUnits(layout.width) / 2, z: worldUnits(layout.depth) / 2 }];
}

/**
 * Coordinator correction, packing pass: this file used to give every
 * building a small deterministic position nudge and Y-axis rotation
 * (`POSITION_JITTER`/`ROTATION_JITTER`, retired here) on top of its colour
 * tint. That was safe when `SPACING` (the grid pitch) was `2` and a
 * building's footprint covered well under half of it — there was real slack
 * to spend on breaking up the grid without two neighbours' geometry ever
 * touching.
 *
 * At `SPACING = 1` there is no slack left to spend: `buildingFootprint`
 * already uses `0.86..0.94` of the ENTIRE pitch on purpose (that's the
 * packing change's whole point — see that function's doc comment), which
 * leaves at most `~0.06 * gridPitch` of clearance even with zero jitter.
 * Rotating a square can only ever WIDEN its axis-aligned bounding box, never
 * narrow it (`cosθ + sinθ >= 1` for every θ), and any position nudge eats
 * directly into that same sliver — either one alone would already erode it
 * to nothing or past it. Rather than re-tune two more constants against a
 * margin this thin, both are gone: `formFor` (deterministic per-path height/
 * roof-pitch/silhouette variety) already does the "stop looking
 * interchangeable" job jitter used to do, without touching footprint width
 * at all. `tintFor` below keeps only the one jitter that was always
 * footprint-safe — colour has no width.
 */
// Craft pass: the author's own "cheap" verdict named uniform surfaces
// explicitly ("every wall of every building is the exact same flat
// colour"). Rendering a district at the old `0.07` and looking closely
// showed the per-building lightness nudge WAS present but barely readable
// once lit — bumped to `0.11` (still a lightness-only nudge, still driven by
// the exact same `hashString(path)` this always was, so it stays honest:
// deterministic per real file identity, never fabricated or a function of
// anything ELSE about that file). Kept well short of anything that would
// read as "noisy" or draw the eye away from the roof colour, which is what
// actually carries `BuildingKind` — see `tintFor`'s own doc comment.
const TINT_JITTER = 0.11;

/**
 * A small, deterministic per-building colour-lightness nudge derived from
 * the building's own path — stable across renders and independent of every
 * other building, mirroring `city::preview::jitter`'s rationale (breaks the
 * flatness of one solid colour per kind without fabricating anything). Pure
 * colour, not geometry: unlike the position/rotation jitter this file used
 * to also compute (see the comment above `TINT_JITTER`), a tint can never
 * make one building's rendered footprint cross into a neighbour's cell, so
 * it plays no part in `footprintClearance`'s invariant.
 */
export function tintFor(path: string): number {
  const hash = hashString(path);
  const a = ((hash & 0xff) / 255) * 2 - 1;
  return a * TINT_JITTER;
}

/**
 * How much wider than its own building's footprint a roof is drawn, as a
 * multiplier — a small eave overhang. Kept at exactly `1.0` (no overhang):
 * at `1.0` the roof's own footprint is IDENTICAL to the wall's, so
 * `footprintClearance` only has to prove its invariant once, not once per
 * shape.
 */
export const ROOF_OVERHANG = 1.0;

/**
 * The worst-case clearance, in world units, between a building's own
 * rendered footprint and its cell's boundary — separately for walls and for
 * roofs — at the widest height bucket (`buildingFootprint(5, gridPitch)`,
 * the largest footprint this file ever draws).
 *
 * RENAMED from `worstCaseGap` (coordinator correction, packing pass), and
 * this is not a rename for its own sake: the guarantee itself changed, and
 * the old name asserted the old one. Before `SPACING` (`gridPitch`) went
 * `2` -> `1`, "two adjacent buildings are a cell APART" was the model's own
 * claim, and a presentation choice that let their footprints visually touch
 * would have been the city lying about the code (task-6-design-inputs.md
 * §3) — `worstCaseGap` proved a real, positive GAP so that could never
 * happen. Now the model's own claim is the opposite: adjacent cells abut,
 * so buildings in them SHOULD visually touch — that is what "let buildings
 * abut" (`4717763`) means, and a render that kept them apart would be the
 * one lying about the code.
 *
 * What must still never happen: a building's rendered footprint crossing
 * INTO a neighbouring cell's own space — that would misrepresent which cell
 * (and therefore which file) that space belongs to, the same honesty
 * requirement in a new shape. `footprintClearance` proves exactly that:
 * zero or positive means the footprint stays within its own cell (zero =
 * exactly filling it, touching a neighbour at the boundary, which is
 * correct); negative would mean interpenetration into the next cell over.
 * `city.test.ts` asserts both returned clearances stay non-negative, so a
 * future change to `buildingFootprint`'s max or `ROOF_OVERHANG` that pushes
 * a footprint past its own cell fails the suite instead of shipping as a
 * building silently misattributed to the wrong file.
 */
export function footprintClearance(gridPitch: number): { wallClearance: number; roofClearance: number } {
  const maxFootprint = buildingFootprint(5, gridPitch);
  return {
    wallClearance: gridPitch - maxFootprint,
    roofClearance: gridPitch - maxFootprint * ROOF_OVERHANG,
  };
}

// ---------------------------------------------------------------------
// Form variety: a deterministic, per-path silhouette variation so buildings
// stop being interchangeable. Same rationale as `tintFor` (a function of
// the file's own path, never fabricated randomness) but a SEPARATE hash key
// ("#form") so this is independent of the colour tint — a building's
// silhouette and its wall tint should not be correlated with each other
// just because they both come from the same path. Since the packing pass
// retired position/rotation jitter entirely (see the comment above
// `TINT_JITTER`), this is now the ONLY source of per-building variety that
// isn't colour, which is exactly why the coordinator called it out as
// already doing that job "better anyway."
// ---------------------------------------------------------------------

export type BuildingVariant = "normal" | "tower" | "squat";

/** The roof's silhouette — decoration only, chosen from the path hash like
 * every other part of a building's form (see `formFor`). */
export type RoofShape = "gable" | "hip" | "pyramid" | "flat";

export type BuildingForm = {
  variant: BuildingVariant;
  /** Multiplier applied on top of the bucket-derived wall height, for a
   * finer-grained height variation than the 5 buckets alone provide. */
  heightJitter: number;
  /** Fraction of the roof's own (edge-aligned) width that its height
   * reaches — a per-building roof pitch, replacing a single fixed constant. */
  roofPitch: number;
  /** Art-direction round, item 6 ("occasional chimneys"): purely decorative,
   * deterministic from the SAME per-building hash as `variant`/`heightJitter`
   * (never randomised, never a function of the building's real properties
   * like `kind` or `lines` — see this round's item 5 ruling that decoration
   * "must not encode anything"), from a disjoint bit range so it varies
   * independently of them. Roughly 1 in 5 buildings, which reads as
   * "occasional" without being rare enough to miss entirely on a small
   * district. */
  hasChimney: boolean;
  roofShape: RoofShape;
  /** Turn the roof a quarter turn, so gable ridges do not all run one way. */
  roofTurned: boolean;
};

const HEIGHT_JITTER_MIN = 0.9;
const HEIGHT_JITTER_MAX = 1.1;
const ROOF_PITCH_MIN = 0.3;
const ROOF_PITCH_MAX = 0.55;
/** Roughly 1 in 14 buildings becomes a tower, another 1 in 14 a squat form —
 * "a minority," per the brief, not a dominant share. */
const TOWER_PCT = 7;
const SQUAT_PCT = 7;

export function formFor(path: string): BuildingForm {
  const hash = hashString(`${path}#form`);
  const roll = hash % 100;
  const variant: BuildingVariant =
    roll < TOWER_PCT ? "tower" : roll < TOWER_PCT + SQUAT_PCT ? "squat" : "normal";
  const heightJitter =
    HEIGHT_JITTER_MIN + (((hash >>> 8) & 0xff) / 255) * (HEIGHT_JITTER_MAX - HEIGHT_JITTER_MIN);
  const roofPitch =
    ROOF_PITCH_MIN + (((hash >>> 16) & 0xff) / 255) * (ROOF_PITCH_MAX - ROOF_PITCH_MIN);
  const hasChimney = ((hash >>> 24) & 0xff) % 5 === 0;
  // A second hash, so the roof does not correlate with the bits already
  // spent on height, pitch and chimney above.
  const roofHash = hashString(`${path}#roof`);
  const roofRoll = roofHash % 100;
  const roofShape: RoofShape =
    variant === "tower" ? "pyramid" : variant === "squat" ? "flat" : roofRoll < 58 ? "gable" : roofRoll < 90 ? "hip" : "pyramid";
  const roofTurned = ((roofHash >>> 8) & 1) === 1;
  return { variant, heightJitter, roofPitch, hasChimney, roofShape, roofTurned };
}

/**
 * FNV-1a, 32-bit, exported so other pure modules that need the same
 * "deterministic small number from a stable string identity" property
 * (`archipelago.ts`'s villager placement, keyed on `pane_id` rather than a
 * building's path) can share one implementation instead of restating it.
 */
export function hashString(s: string): number {
  // FNV-1a, 32-bit. Not cryptographic, just a small stable hash so the same
  // path always produces the same jitter across renders and reloads.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Every building's real line count, by path — one town measurement. */
export function townLines(model: CityModel): Map<string, number> {
  const lines = new Map<string, number>();
  for (const district of model.districts) {
    for (const building of district.buildings) lines.set(building.path, building.lines);
  }
  return lines;
}

export type TownGrowth = {
  /** Paths that were not in the previous measurement. */
  added: ReadonlySet<string>;
  /** Real line changes, biggest first, capped at `limit` entries. */
  deltas: { path: string; delta: number; isNew: boolean }[];
};

/**
 * What changed between two measurements of the same town — the "+42" labels
 * a working agent leaves behind. Real line counts, never estimates; a
 * deleted file is simply absent (its building disappears with it). `before`
 * is `null` on a town's first measurement, which has nothing to compare
 * against and therefore reports nothing.
 */
export function diffTownLines(before: ReadonlyMap<string, number> | null, after: ReadonlyMap<string, number>, limit = 12): TownGrowth {
  if (before === null) return { added: new Set(), deltas: [] };
  const added = new Set<string>();
  const deltas: TownGrowth["deltas"] = [];
  for (const [path, lines] of after) {
    const previous = before.get(path);
    if (previous === undefined) {
      added.add(path);
      deltas.push({ path, delta: lines, isNew: true });
    } else if (previous !== lines) {
      deltas.push({ path, delta: lines - previous, isNew: false });
    }
  }
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.path.localeCompare(b.path));
  return { added, deltas: deltas.slice(0, limit) };
}
