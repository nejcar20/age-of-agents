/**
 * Types and pure helpers for the archipelago scene — the sea-level view that
 * replaces the plain HTML island list. Mirrors `src-tauri/src/city/
 * archipelago.rs`'s `Serialize`d structs field-for-field, exactly the same
 * discipline `city.ts` already follows for `city_for`'s payload (no case
 * conversion anywhere on this wire).
 *
 * This module holds only PURE, DOM/WebGL-free logic — join, sizing, and
 * deterministic placement — so it can be unit tested directly, the same
 * reasoning `founding.ts`/`world.ts` already document for why their own
 * decisions live outside any component.
 */

import { hashString, worldUnits } from "./city";
import type { Agent, Attention, Island } from "./world";

// ---------------------------------------------------------------------
// Wire types — mirror `city::archipelago`'s `Serialize`d structs verbatim.
// ---------------------------------------------------------------------

export type IslandPlot = { x: number; z: number; w: number; d: number };

export type SourceKind = "Git" | "Walk";

/**
 * Mirrors `CityStatus`'s `#[serde(tag = "status", rename_all =
 * "snake_case")]` shape exactly: `{ status: "known", ... }` or
 * `{ status: "unknown", reason }` — never a bare width/depth on its own,
 * which is the whole honesty point (see `IslandView.city`'s doc comment on
 * the Rust side and Item 6 of this round's brief).
 */
export type CityStatus =
  | {
      status: "known";
      district_count: number;
      building_count: number;
      width: number;
      depth: number;
      source: SourceKind;
      /** Mirrors `CityStatus::Known::measured_at` on the Rust side verbatim:
       * the Unix-seconds timestamp this measurement was ACTUALLY taken at —
       * never advanced just because a cached summary was reused. `null`
       * only for a summary persisted before this field existed. See
       * `describeMeasuredAt` in `measuredAt.ts` for how this is honestly
       * rendered (never as a fabricated freshness claim). */
      measured_at: number | null;
    }
  | { status: "unknown"; reason: string };

export type IslandView = {
  root: string;
  name: string;
  plot: IslandPlot;
  city: CityStatus;
  last_changed_at: number | null;
};

export type Archipelago = { islands: IslandView[] };

// ---------------------------------------------------------------------
// The join: `get_archipelago`'s islands (every repo, real or not-yet-
// settled) against `get_world`'s islands (only repos with a live herdr
// pane). `IslandView.root` / `Island.root` is the shared identity — both
// already canonical (`world::repo::normalize_path` on the Rust side).
// ---------------------------------------------------------------------

/**
 * One island as the sea actually renders it: the real repository/city data
 * from `get_archipelago`, plus whatever the live world currently knows about
 * it — `null` attention and an empty `agents` array when herdr has never
 * reported a pane there, which is the honest "no settlement here" case (Item
 * 6: no villager stands in for an agent that is not running).
 */
export type SeaIsland = {
  view: IslandView;
  /** `null`, not a fabricated `"quiet"`, when this repo has no live herdr
   * workspace at all — a real absence, not a calm state to draw a marker
   * for. See `IslandBeacon` in `Archipelago.tsx` for how the two render
   * differently. */
  attention: Attention | null;
  agents: Agent[];
};

/**
 * Builds the sea's actual island list, in `get_archipelago`'s own order
 * (`Archipelago.islands` is documented as sorted by name — nothing here
 * re-sorts it, so the sea's layout order is stable across renders the same
 * way the underlying plots already are).
 */
export function joinArchipelago(archipelago: IslandView[], worldIslands: Island[]): SeaIsland[] {
  const byRoot = new Map(worldIslands.map((island) => [island.root, island]));
  return archipelago.map((view) => {
    const match = byRoot.get(view.root);
    return { view, attention: match?.attention ?? null, agents: match?.agents ?? [] };
  });
}

// ---------------------------------------------------------------------
// Landmass extent — where the ACTUAL land sits inside its reserved plot.
// ---------------------------------------------------------------------

/**
 * A brand-new `Unknown` island has no known land size at all (its `plot` is
 * a stability placeholder — see `IslandPlot`'s doc comment on the Rust
 * side), so this is a fixed, small, explicitly-not-a-measurement footprint
 * used only to draw the fog blob at a readable size. Mirrors
 * `city::archipelago::UNKNOWN_ISLAND_LAND` in spirit (same number, `6`) —
 * not imported from Rust (there is no such channel), so if that constant
 * ever changes this drifts silently. The cost of drifting is purely
 * cosmetic (the fog blob's size), never a honesty violation either way,
 * since `renderUnknownAsFog` below never claims this number is a
 * measurement.
 */
export const UNKNOWN_FOG_LAND = 6;

/** A land rectangle in WORLD units, an island's plot origin already added —
 * ready to position geometry directly, no further translation needed.
 * `x`/`z` is the rectangle's own near corner (not a centre). */
export type LandRect = { x: number; z: number; w: number; d: number };

/**
 * Where an island's actual land sits, in world units, given its plot and
 * `CityStatus`. For `Known`, this is `city.width`/`city.depth` CENTERED
 * inside the plot (mirrors `IslandView.plot`'s own doc comment: "the
 * frontend draws the island's actual landmass at `city`'s reported
 * `width`/`depth`, centered inside this plot" — exactly the same
 * plot-centering convention `city::layout`'s districts already use inside
 * their own margin-inclusive `Plot`).
 *
 * For `Unknown`, there is no real width/depth to centre — this returns a
 * small FIXED footprint (`UNKNOWN_FOG_LAND`) centred in the plot instead,
 * deliberately NOT the plot's own (possibly much larger, stability-only)
 * extent: drawing at the plot's full size would present a stability
 * placeholder as though it were a real measurement, exactly what Item 6
 * forbids.
 */
export function landRect(view: IslandView): LandRect {
  const { plot, city } = view;
  const [landW, landD] =
    city.status === "known" ? [city.width, city.depth] : [UNKNOWN_FOG_LAND, UNKNOWN_FOG_LAND];
  const x0 = plot.x + (plot.w - landW) / 2;
  const z0 = plot.z + (plot.d - landD) / 2;
  return {
    x: worldUnits(x0),
    z: worldUnits(z0),
    w: worldUnits(Math.max(landW, 1)),
    d: worldUnits(Math.max(landD, 1)),
  };
}

// ---------------------------------------------------------------------
// LOD massing: a SMALL number of blocks that reads as "a town from above"
// without ever loading a full `CityModel`/`CityLayout` (Item 1's whole
// point — `my-site-next` alone is 1,057 buildings). The block COUNT is a
// real, monotonic function of the repo's own `district_count` — more real
// districts always means more visible blocks, capped for draw-call cost —
// never an arbitrary decoration (Item 6: this is a proportional massing,
// not an invented townscape).
// ---------------------------------------------------------------------

/** Ceiling on how many massing blocks a single island ever draws, so a
 * 363-district repository (the author's own `my-site-next`) costs a
 * bounded, small number of extra instances rather than one per district. */
const MAX_MASSING_BLOCKS = 24;
/** How many real districts one massing block represents at minimum — chosen
 * so islands in the author's own observed range (17..363 districts) spread
 * across roughly 1..19 blocks, a visibly different count at a glance without
 * needing the cap for any of his five real repositories. */
const DISTRICTS_PER_BLOCK = 20;

export function massingBlockCount(districtCount: number): number {
  return Math.min(MAX_MASSING_BLOCKS, Math.max(1, Math.ceil(districtCount / DISTRICTS_PER_BLOCK)));
}

/** Smallest square grid that fits `blockCount` cells. */
export function massingGridSize(blockCount: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(blockCount)));
}

export type Vec2 = { x: number; z: number };

/**
 * Herdr's own sidebar vocabulary, so a glance here reads the same as a
 * glance there: orange is working, green is finished work, and a finished
 * agent the user has already looked at is a hollow green ring (`quiet`,
 * drawn as a ring rather than a dot wherever the shape is ours to choose).
 * Mirrored by `styles.css`'s `--stopped`/`--working`/`--grey` and, in
 * Herdr's softer dark-theme tones, by `workbench.css`. One shared table so a
 * villager's colour means the same thing everywhere it appears (the sea and
 * the town both import this rather than each keeping its own copy that could
 * drift). `Archipelago.tsx`'s own `STOPPED_COLOR`/`WORKING_COLOR`/
 * `UNKNOWN_COLOR`/`QUIET_VILLAGER_COLOR` now alias into this table instead of
 * restating the hex values.
 */
export const ATTENTION_COLOR: Record<Attention, string> = {
  stopped: "#22c993",
  working: "#f5992b",
  unknown: "#8f97a3",
  quiet: "#8fd6bd",
};

/**
 * Massing block centres, in LOCAL land-relative units (`[0, landW] x
 * [0, landD]`, the caller adds the land's own world-space origin). Blocks
 * sit at cell CENTRES of a `grid x grid` division of the land; villager
 * slots (`villagerSlots` below) sit at that same grid's CORNERS — the two
 * sets can never coincide by construction (a corner is never a centre of
 * any cell), which is what keeps a villager standing in the "streets"
 * between blocks rather than inside one (Item 3: "keep them out of the
 * buildings").
 */
export function blockCenters(landW: number, landD: number, blockCount: number): Vec2[] {
  const grid = massingGridSize(blockCount);
  const pitchX = landW / grid;
  const pitchZ = landD / grid;
  const centers: Vec2[] = [];
  outer: for (let gz = 0; gz < grid; gz++) {
    for (let gx = 0; gx < grid; gx++) {
      if (centers.length >= blockCount) break outer;
      centers.push({ x: (gx + 0.5) * pitchX, z: (gz + 0.5) * pitchZ });
    }
  }
  return centers;
}

/**
 * Villager candidate slots — the SAME grid's corners (`grid + 1` per axis),
 * inset by a small margin so a corner slot never lands exactly on the
 * coastline. See `blockCenters`'s doc comment for why this can never
 * collide with a block's own position.
 */
export function villagerSlots(landW: number, landD: number, blockCount: number): Vec2[] {
  const grid = massingGridSize(blockCount);
  const pitchX = landW / grid;
  const pitchZ = landD / grid;
  const margin = 0.08;
  const slots: Vec2[] = [];
  for (let gz = 0; gz <= grid; gz++) {
    for (let gx = 0; gx <= grid; gx++) {
      const fx = gx * pitchX;
      const fz = gz * pitchZ;
      slots.push({
        x: landW * margin + fx * (1 - 2 * margin),
        z: landD * margin + fz * (1 - 2 * margin),
      });
    }
  }
  return slots;
}

/**
 * Assigns each agent a villager slot, deterministically from its own
 * `pane_id` (Item 3: "position them deterministically from pane_id so a
 * villager does not teleport between renders"). Two agents whose hash picks
 * the same slot resolve by linear probing, in `pane_id` order — this makes
 * the WHOLE assignment a pure function of `(agents, slots)`, not of
 * insertion order into some other structure, so re-running it on the exact
 * same island (which is the common case — a re-render, not a world change)
 * reproduces byte-identical positions.
 *
 * If there are more agents than slots (only possible on a very small,
 * lightly-massed island with an unusually large number of live panes),
 * later agents wrap around and can share a slot with an earlier one — a
 * real, honest crowding rather than an invented extra slot, and strictly
 * better than silently dropping a villager.
 */
export function assignVillagerPositions(agents: Agent[], slots: Vec2[]): Map<string, Vec2> {
  const result = new Map<string, Vec2>();
  if (slots.length === 0) return result;
  const taken = new Set<number>();
  for (const agent of agents) {
    const start = hashString(agent.pane_id) % slots.length;
    let index = start;
    for (let attempt = 0; attempt < slots.length; attempt++) {
      if (!taken.has(index)) break;
      index = (index + 1) % slots.length;
    }
    taken.add(index);
    result.set(agent.pane_id, slots[index]);
  }
  return result;
}

// ---------------------------------------------------------------------
// Camera bounds for the whole sea — the archipelago-scale analogue of
// `TownView`'s `computeBounds`, over every island's PLOT (the reserved
// cell, water included) rather than one city's layout extent.
// ---------------------------------------------------------------------

export type SeaBounds = { minX: number; maxX: number; minZ: number; maxZ: number };

/** A small nominal box so an empty archipelago (no repositories found yet)
 * never produces a degenerate/NaN camera fit. */
const EMPTY_SEA_BOUNDS: SeaBounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 20 };

export function seaBounds(islands: IslandView[]): SeaBounds {
  if (islands.length === 0) return EMPTY_SEA_BOUNDS;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const { plot } of islands) {
    minX = Math.min(minX, plot.x);
    maxX = Math.max(maxX, plot.x + plot.w);
    minZ = Math.min(minZ, plot.z);
    maxZ = Math.max(maxZ, plot.z + plot.d);
  }
  return { minX, maxX, minZ, maxZ };
}

// ---------------------------------------------------------------------
// Shoreline shape (coordinator review: "islands should look like islands,"
// not flat rectangles with a hard edge) — a small number of overlapping
// rectangular "lobes" that together read as a rounded, slightly irregular
// blob from above, exactly like the town's own land slab given a coastline
// instead of a repeated cardboard-cutout footprint at sea scale.
//
// HONESTY (coordinator's own wording): "keep the island's footprint honest
// ... shaping the coastline WITHIN that footprint is scenery." Every lobe
// this returns is a strict sub-rectangle of `[0, landW] x [0, landD]` — the
// bounding footprint itself never grows past what `landRect` already
// computed from the real city extent. `landLobes.test` pins exactly this.
// ---------------------------------------------------------------------

export type LandLobe = { x: number; z: number; w: number; d: number };

/** How much smaller than the full footprint the BASE lobe is — enough that
 * the two accent lobes below can visibly round a corner without the whole
 * shape reading as shrunken at a glance. */
const BASE_LOBE_INSET = 0.05;
/** How many extra accent lobes break up the base rectangle's silhouette. */
const ACCENT_LOBE_COUNT = 2;

export function landLobes(root: string, landW: number, landD: number): LandLobe[] {
  const baseW = landW * (1 - BASE_LOBE_INSET);
  const baseD = landD * (1 - BASE_LOBE_INSET);
  const lobes: LandLobe[] = [
    { x: (landW - baseW) / 2, z: (landD - baseD) / 2, w: baseW, d: baseD },
  ];
  for (let i = 0; i < ACCENT_LOBE_COUNT; i++) {
    const h = hashString(`${root}#lobe${i}`);
    const w = Math.min(landW, landW * (0.22 + ((h % 40) / 200)));
    const d = Math.min(landD, landD * (0.22 + (((h >>> 8) % 40) / 200)));
    const x = Math.max(0, Math.min(landW - w, (((h >>> 16) % 1000) / 1000) * (landW - w)));
    const z = Math.max(0, Math.min(landD - d, (((h >>> 24) % 1000) / 1000) * (landD - d)));
    lobes.push({ x, z, w, d });
  }
  return lobes;
}

// ---------------------------------------------------------------------
// LOD massing houses — item 1 of the coordinator's visual review: a block
// must read as "a cluster of little houses," not a flat pad. `houseCluster`
// gives each massing block a small, fixed number of miniature houses,
// offset within the block's own cell (as fractions of the cell's pitch, so
// the caller scales by whatever `blockSize` it is already using) and
// deterministically varied in size/height/roof-colour-seed from the
// block's own identity — the same "real function of identity, not
// fabricated randomness" rule `city.ts`'s `formFor`/`tintFor` already use.
// These are NOT claimed to be real per-file buildings (the LOD cap stays):
// they are miniature scenery standing in for "a real, measured amount of
// content," exactly as permitted for ground/water/coastline shaping.
// ---------------------------------------------------------------------

export type MiniHouse = {
  /** Offset from the block's own centre, as a fraction of the cell pitch
   * (`-0.5..0.5` on each axis — multiply by the caller's cell size). */
  dx: number;
  dz: number;
  /** Footprint size, as a fraction of the cell pitch. */
  size: number;
  /** Wall height as a fraction of this house's footprint. */
  heightFactor: number;
  /** Deterministic seed for picking a roof colour — not a claim about real
   * file kind, purely decorative variety (see module doc above). */
  colorSeed: number;
};

/** Small, fixed offsets (fractions of the cell pitch) so a cluster reads as
 * a few distinct little houses rather than one shape — deliberately NOT
 * random per render; only which houses are placed here, not where, comes
 * from a fixed layout, and per-house size/height/colour still varies by
 * hash below. */
const HOUSE_OFFSETS: readonly [number, number][] = [
  [-0.2, -0.23],
  [0.2, -0.23],
  [-0.2, 0.23],
  [0.2, 0.23],
  [0.2, 0],
];

export function houseCluster(seed: string): MiniHouse[] {
  return HOUSE_OFFSETS.map(([dx, dz], i) => {
    const h = hashString(`${seed}#house${i}`);
    return {
      dx,
      dz,
      size: 0.125 + ((h % 100) / 100) * 0.04,
      heightFactor: 0.65 + (((h >>> 8) % 100) / 100) * 0.4,
      colorSeed: (h >>> 16) >>> 0,
    };
  });
}

/** The world-space centre of one island's land — what a camera "flies to"
 * (Item 5) actually targets: the LAND's centre, not the plot's (which would
 * off-centre the shot toward whichever side has more reserved headroom). */
export function islandCenter(view: IslandView): Vec2 {
  const land = landRect(view);
  return { x: land.x + land.w / 2, z: land.z + land.d / 2 };
}

// ---------------------------------------------------------------------
// Search and state filtering (search-and-filter round) — pure decisions
// over the joined `SeaIsland[]`, kept out of `Archipelago.tsx` for the same
// reason every other decision in this module is: there is no DOM/WebGL test
// environment for the 3D scene itself, so this is how "does typing 'api'
// actually narrow the sea to islands named like that" is ever tested at all,
// rather than eyeballed in a screenshot. At the author's real scale (152
// repositories, once discovery stops capping at depth 2), a working search
// is not a nicety — see this round's own brief.
// ---------------------------------------------------------------------

/** `"all"` (no state narrowing) or one specific live `Attention` — the
 * options a state-filter control offers. Never a `Set`/array of states: the
 * brief's own headline case is "show me only what needs me," a single,
 * specific choice, not an arbitrary combination. */
export type StateFilter = "all" | Attention;

/**
 * Case-insensitive substring match on an island's own NAME — the identity
 * the sea already displays and keys its labels by, so it's what a search
 * box searches. An empty/whitespace-only query matches every island (a
 * cleared box is the neutral, unfiltered state, not "matches nothing").
 */
export function matchesSearchQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return name.toLowerCase().includes(q);
}

/**
 * Whether a live attention state — or `null`, the honest "no herdr
 * workspace at all" absence `SeaIsland.attention`'s own doc comment
 * documents — satisfies a state filter. `"all"` matches everything,
 * `null` included. Any specific `Attention` matches only an island whose
 * LIVE attention is exactly that state; an unsettled island never matches a
 * specific state filter (there is no live state to match), the same way it
 * never gets a fabricated `"quiet"` anywhere else in this codebase.
 */
export function matchesStateFilter(attention: Attention | null, filter: StateFilter): boolean {
  if (filter === "all") return true;
  return attention === filter;
}

/** Both filters combined — an island must pass the name query AND the state
 * filter to count as a match. */
export function isSeaIslandMatch(seaIsland: SeaIsland, query: string, filter: StateFilter): boolean {
  return matchesSearchQuery(seaIsland.view.name, query) && matchesStateFilter(seaIsland.attention, filter);
}

/**
 * Whether a search/filter is actually narrowing the sea right now. An empty
 * query together with `"all"` is the neutral, unfiltered state — every
 * island must render exactly as it always has, not merely "happens to match
 * everything," so callers use this (rather than re-deriving it from
 * `isSeaIslandMatch` being true everywhere) to decide whether to draw any
 * match/recede styling at all.
 */
export function isFilterActive(query: string, filter: StateFilter): boolean {
  return query.trim() !== "" || filter !== "all";
}

/**
 * The island a submitted search (pressing Enter) flies the camera to — never
 * a fuzzy "closest guess," just the most specific of the ordinary substring
 * matches: an exact case-insensitive name match first, then the first name
 * that STARTS WITH the query, then the first that merely CONTAINS it — each
 * tier searched in the sea's own stable, name-sorted order (`joinArchipelago`'s
 * own doc comment), so the result never depends on incidental iteration
 * order that could shift between renders. Also honours the current state
 * filter — jumping should never land on an island the state filter is
 * actively hiding. Returns `null` when nothing was actually typed (an empty
 * query has no "the" match to jump to) or nothing passes `filter`.
 */
export function findBestSeaIslandMatch(
  seaIslands: SeaIsland[],
  query: string,
  filter: StateFilter,
): SeaIsland | null {
  const q = query.trim().toLowerCase();
  if (q === "") return null;
  const candidates = seaIslands.filter((s) => matchesStateFilter(s.attention, filter));
  const exact = candidates.find((s) => s.view.name.toLowerCase() === q);
  if (exact) return exact;
  const prefix = candidates.find((s) => s.view.name.toLowerCase().startsWith(q));
  if (prefix) return prefix;
  return candidates.find((s) => s.view.name.toLowerCase().includes(q)) ?? null;
}

/** A request to fly the camera to one island — `App.tsx`'s shared plumbing
 * for both the Space hotkey (`jump_to_next`) and the search bar's
 * Enter-to-jump (`submitSearch`). See `resolveFlyToTarget`'s own doc comment
 * for why `islandRoot` exists. */
export type FlyToRequest = { islandName: string; islandRoot?: string; seq: number };

/**
 * I1 (Opus frontend review): resolves a `FlyToRequest` to the exact
 * `SeaIsland` it should land on. This used to be done by NAME alone
 * (`byName.get(request.islandName)`, a `Map` built last-wins over
 * `seaIslands`), even when the caller already had the precise island — and
 * therefore its unambiguous `root` — in hand: `App.tsx`'s `submitSearch`
 * calls `findBestSeaIslandMatch`, which returns a real `SeaIsland`, then
 * discarded everything but its `name` before handing the request off. At the
 * author's real scale (152 repositories) three basenames collide
 * (`StrategyTrader_v2`, `padel-court-api`, `space-guardian`), so a name-only
 * lookup can silently resolve to a DIFFERENT repository than the one that
 * was actually matched — and "Start agent" then acts on the wrong one.
 *
 * `islandRoot` is preferred whenever the request carries one (every caller
 * that already holds a `SeaIsland` should always set it). The name-only
 * fallback still exists for exactly one caller that has no better option:
 * `jump_to_next`'s own backend contract (`commands::jump_to_next`) returns
 * only `island.name`, nothing else — a real, disclosed backend limitation
 * this frontend cannot fix without a wire change, not a regression.
 */
export function resolveFlyToTarget(
  seaIslands: SeaIsland[],
  request: { islandName: string; islandRoot?: string },
): SeaIsland | null {
  if (request.islandRoot) {
    const byRoot = seaIslands.find((s) => s.view.root === request.islandRoot);
    if (byRoot) return byRoot;
  }
  // Last-wins, matching the old `Map`'s own behavior for this one remaining
  // caller — with no root to disambiguate a collision, this is the best any
  // implementation can do.
  let match: SeaIsland | null = null;
  for (const s of seaIslands) {
    if (s.view.name === request.islandName) match = s;
  }
  return match;
}

// ---------------------------------------------------------------------
// Distance-based LOD fade (water-fix round, coordinator review item 2):
// "the wide view got worse... the sand district pads dominate, the
// vegetation darkens everything, and the cream buildings with coloured
// roofs — the best thing you have — become invisible. Work out what should
// dominate at distance... pads should recede substantially as the camera
// pulls back while roofs stay saturated."
//
// Both curves are pure functions of `zoomRatio` alone
// (`camera.zoom / controls.minZoom` — see `Archipelago.tsx`'s
// `ZoomTracker`), never of anything about the island itself: fading is a
// viewing-distance effect, not a per-repo decision, so every island fades
// on exactly the same curve regardless of its own size/content — the same
// "must not encode anything about the repo" discipline `vegetation.ts`
// already documents for density.
//
// `zoomRatio` sits at 2 for the sea's own DEFAULT, just-fitted view (the
// `MIN_ZOOM_FACTOR = 0.5` `TownView.CameraRig` sets `controls.minZoom` to,
// inverted) — that is deliberately where both fades are close to their
// FAR-end (low-opacity) value, not their near end, since the default view
// is exactly the "wide" picture the coordinator's review was about.
// ---------------------------------------------------------------------

const PAD_FADE_START = 2;
const PAD_FADE_END = 5;
const PAD_MIN_OPACITY = 0.1;

/**
 * A block's decorative plaza pad: nearly invisible at the sea's default
 * wide view (so a distant island reads as "a cluster of coloured roofs,"
 * not "a sandy patch"), ramping up to fully opaque by a modest zoom-in —
 * well short of the camera's own max zoom, so pads are back to their full
 * `final-close-moja.png` look well before the user is all the way in on
 * one island.
 */
export function padFadeOpacity(zoomRatio: number): number {
  const t = Math.max(0, Math.min(1, (zoomRatio - PAD_FADE_START) / (PAD_FADE_END - PAD_FADE_START)));
  return PAD_MIN_OPACITY + t * (1 - PAD_MIN_OPACITY);
}

const VEG_FADE_START = 2;
const VEG_FADE_END = 6;
const VEG_MIN_OPACITY = 0.18;

/**
 * Decorative trees/rocks: thin out (via opacity, not instance count — see
 * `Vegetation.tsx`) at distance for the same reason pads do, fully back by
 * a somewhat closer zoom than pads (vegetation is smaller or, and reads as
 * clutter sooner, so it should reappear a little later while zooming in).
 */
export function vegetationFadeOpacity(zoomRatio: number): number {
  const t = Math.max(0, Math.min(1, (zoomRatio - VEG_FADE_START) / (VEG_FADE_END - VEG_FADE_START)));
  return VEG_MIN_OPACITY + t * (1 - VEG_MIN_OPACITY);
}

const RING_FADE_START = 2;
const RING_FADE_END = 5;
const RING_WIDE_OPACITY = 0.92;
const RING_NEAR_OPACITY = 0.42;

/**
 * Activity-lens round: the age ring's opacity, fading the OPPOSITE way to
 * `padFadeOpacity`/`vegetationFadeOpacity` above — bold at the sea's wide
 * view and receding as the camera comes in.
 *
 * That inversion is the whole point of the curve. The lens is an
 * orientation instrument: at wide zoom it is the only thing that can tell
 * one island's age from another's and it has to be unmissable, while up
 * close the island's own name label, hover tooltip and panel already state
 * the exact date in words — so a bold ring there is a hoop in the way of
 * the thing you zoomed in to look at, and (on a stopped island) a band
 * competing with `StoppedHalo`'s own rim. Caught by rendering it: at the
 * flat `0.95` this shipped with in its first draft, a close shot of the
 * author's largest repository was a stack of heavy purple hoops.
 *
 * It fades toward a floor, never to zero: "recede, not delete" is the same
 * rule the search filter's `DIM_OPACITY` follows, and a channel that
 * silently disappeared at some zoom would be exactly the kind of quiet
 * omission this project treats as a defect.
 *
 * Like both curves above, this is a pure function of `zoomRatio` alone and
 * therefore identical for every island — a viewing-distance effect, never a
 * per-repository decision.
 */
export function activityRingOpacity(zoomRatio: number): number {
  const t = Math.max(0, Math.min(1, (zoomRatio - RING_FADE_START) / (RING_FADE_END - RING_FADE_START)));
  return RING_WIDE_OPACITY + t * (RING_NEAR_OPACITY - RING_WIDE_OPACITY);
}

// ---------------------------------------------------------------------
// Default sea framing (coordinator review, framing round): "the first
// thing the author sees on launch is the one composition where the game
// cannot look good... fitting all 152 islands into one frame [leaves] each
// building about 2 pixels. Nothing survives that." The fix is not a colour
// or LOD change; it is WHERE the camera starts. These two pure functions
// decide that — which island to centre on, and how much of the sea around
// it counts as "a handful" — kept here, not in `Archipelago.tsx`, so the
// PRIORITY RULE itself has direct unit tests independent of any WebGL/DOM
// dependency, the same reasoning every other pure decision in this module
// already follows.
// ---------------------------------------------------------------------

function byRecencyThenName(a: SeaIsland, b: SeaIsland): number {
  const at = a.view.last_changed_at;
  const bt = b.view.last_changed_at;
  if (at !== null && bt !== null) return bt - at || a.view.name.localeCompare(b.view.name);
  if (at !== bt) return at !== null ? -1 : 1;
  return a.view.name.localeCompare(b.view.name);
}

/** A `known` island's real measured footprint area — `0` for `unknown`
 * status, never a guess: an island whose true size is not actually known
 * must never win a "largest" comparison on a fabricated number (the same
 * honesty rule `landRect`'s own doc comment states for `UNKNOWN_FOG_LAND`). */
function knownArea(seaIsland: SeaIsland): number {
  const { city } = seaIsland.view;
  return city.status === "known" ? city.width * city.depth : 0;
}

/**
 * The island the sea opens centred on, in the coordinator's own stated
 * priority:
 *
 *   1. An island with a STOPPED agent — needs the human right now. Ties
 *      (more than one stopped) broken by most-recently-changed, then name,
 *      for a deterministic single choice.
 *   2. Otherwise, the most recently changed repository overall (by
 *      `last_changed_at`), ties broken by name.
 *   3. Otherwise, the largest known city by real measured footprint area
 *      (never an `unknown`-status island, whose true size isn't known —
 *      see `knownArea`), ties broken by name.
 *
 * Returns `null` only when there is truly nothing to centre on (an empty
 * sea) — the caller must fall back to the full (empty) bounds in that
 * case, never a fabricated centre point (the coordinator's own explicit
 * instruction: "never the geometric centre of an empty sea").
 */
export function pickDefaultFocusIsland(seaIslands: SeaIsland[]): SeaIsland | null {
  if (seaIslands.length === 0) return null;

  const stopped = seaIslands.filter((s) => s.attention === "stopped");
  if (stopped.length > 0) {
    return stopped.slice().sort(byRecencyThenName)[0];
  }

  const withRecency = seaIslands.filter((s) => s.view.last_changed_at !== null);
  if (withRecency.length > 0) {
    return withRecency.slice().sort(byRecencyThenName)[0];
  }

  return seaIslands
    .slice()
    .sort((a, b) => knownArea(b) - knownArea(a) || a.view.name.localeCompare(b.view.name))[0];
}

/** How many islands (the focus island plus its nearest neighbours) count as
 * "a handful" — fixed, not content-derived, the same "a flat constant is
 * honest here" reasoning `terrainGeometry.ts`'s own `segments` doc comment
 * already states for a purely presentational knob. */
const DEFAULT_FOCUS_NEIGHBOR_COUNT = 6;
/** Breathing room around the tightest box that contains every included
 * island's own land, as a fraction of that box's own larger dimension. */
const DEFAULT_FOCUS_MARGIN_FRACTION = 0.28;

/**
 * A tight bounds around `pickDefaultFocusIsland`'s choice AND its nearest
 * `DEFAULT_FOCUS_NEIGHBOR_COUNT - 1` neighbours (by land-centre distance) —
 * "a handful of islands fill the view," not the geometric centre of the
 * whole sea and not a single island alone. Scales with the sea's own actual
 * DENSITY (nearest-N, never a fixed world-space radius), so it reads the
 * same whether islands happen to be packed tightly or spread thin, and
 * degrades gracefully to "the whole sea" on its own when there are fewer
 * than `DEFAULT_FOCUS_NEIGHBOR_COUNT` islands in total — no special case
 * needed for a small archipelago.
 *
 * `null` when there is nothing to focus on (empty sea) or the named root
 * isn't actually present — the caller falls back to the full sea bounds in
 * either case.
 */
export function defaultFocusBounds(seaIslands: SeaIsland[], focusRoot: string): SeaBounds | null {
  if (seaIslands.length === 0) return null;
  const rects = seaIslands.map((s) => ({ root: s.view.root, rect: landRect(s.view) }));
  const focus = rects.find((r) => r.root === focusRoot);
  if (!focus) return null;

  const focusCenterX = focus.rect.x + focus.rect.w / 2;
  const focusCenterZ = focus.rect.z + focus.rect.d / 2;

  const nearest = rects
    .map(({ rect }) => {
      const cx = rect.x + rect.w / 2;
      const cz = rect.z + rect.d / 2;
      return { rect, dist: Math.hypot(cx - focusCenterX, cz - focusCenterZ) };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, Math.max(1, DEFAULT_FOCUS_NEIGHBOR_COUNT));

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const { rect } of nearest) {
    minX = Math.min(minX, rect.x);
    maxX = Math.max(maxX, rect.x + rect.w);
    minZ = Math.min(minZ, rect.z);
    maxZ = Math.max(maxZ, rect.z + rect.d);
  }
  const margin = Math.max(maxX - minX, maxZ - minZ) * DEFAULT_FOCUS_MARGIN_FRACTION;
  return { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };
}
