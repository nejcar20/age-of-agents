import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { ContactShadows, Html, OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import { assignVillagerPositions, ATTENTION_COLOR } from "../archipelago";
import { BuildingPanel, type SelectedBuildingInfo } from "./BuildingPanel";
import { DistrictPanel, type SelectedDistrictInfo } from "./DistrictPanel";
import { VillagerPanel } from "./VillagerPanel";
import { buildingWallGeometry, flatRoofGeometry, gabledRoofGeometry, hippedRoofGeometry, pyramidRoofGeometry } from "./bevelGeometry";
import { buildSafeGroundGeometry } from "./terrainGeometry";
import { safeDomeHeight } from "../terrain";
import { OpenWater, SUN_OFFSET, TownShallows } from "./Water";
import { useDisposableMemo } from "./useDisposableMemo";
import { buildAttentionHaloGeometry } from "./attentionHalo";
import { buildTownCoastGeometry, coastExtent, coastHeight, coastSwell, coastT as coastTAt, coastWaterlineT, townCoastWidth } from "./townCoast";
import { useRecording } from "../recording";
import { CinematicEffects } from "./CinematicEffects";
import { ChimneySmoke, chimneyTop, Crane, Scaffolding, type Site } from "./Construction";
import { SailingBoats, type BoatRoute } from "./Boats";
import { useMood } from "../mood";
import { buildingFacadeTexture, buildingWindowMask } from "./facadeTexture";
import { Vegetation } from "./Vegetation";
import { sceneFogRange } from "./sceneFog";
import { isInteractiveTarget } from "../useHotkey";
import { ATTENTION_LABEL, taskLabel, type Agent, type Attention } from "../world";
import type { ChangeStatus } from "../inspection";
import {
  buildingColor,
  buildingFootprint,
  buildingWorldHeight,
  cellCenter,
  contentExtent,
  formFor,
  gridPitchOf,
  diffTownLines,
  hashString,
  ROOF_OVERHANG,
  tintFor,
  townLines,
  townVillagerSlots,
  worldUnits,
  type BuildingKind,
  type CityLayout,
  type CityModel,
  type RoofShape,
  type TownGrowth,
  type CityView,
  type PlacedDistrict,
} from "../city";

/**
 * The interactive 3D town view: renders the SAME `CityModel`/`CityLayout`
 * pair the top-down SVG preview draws (task-6-design-inputs.md's whole
 * premise) — no new geometry decision is made here that the model/layout
 * didn't already decide; this only chooses how to *look at* it.
 *
 * `frameloop`/`preserveDrawingBuffer` default to the values the shipped app
 * wants (a static picture that never spins the GPU while idle, and a
 * drawing buffer three.js is free to clear after each frame). The
 * screenshot harness passes `"always"`/`true` explicitly — see
 * `src/townshot.tsx` — so the app can never silently inherit the harness's
 * settings by one of them changing its own default later.
 */
export type TownViewProps = {
  cityView: CityView;
  onCodeSelect?: (path: string, kind: "file" | "directory") => void;
  focusRequest?: { path: string; seq: number } | null;
  changes?: ReadonlyMap<string, ChangeStatus>;
  /** An agent in this town is working, so `changes` is being re-read as it
   * edits: the change markers breathe to say "this is happening now". */
  changesLive?: boolean;
  externalInspector?: boolean;
  /**
   * Town-villagers round: every agent whose island this town belongs to —
   * the SAME `Island.agents` the sea already reads, not a second fetch or a
   * re-derivation. Defaults to `[]` (a town with no live agents draws none,
   * never a fabricated one) so every existing caller (the screenshot
   * harness, `TownView.test.ts`) keeps working unchanged.
   */
  agents?: Agent[];
  /**
   * Fires the moment a villager is clicked. This component never invokes
   * anything itself (it has no `invoke` dependency at all, like every
   * other pure-rendering piece here); the caller (`TownScreen` in
   * `App.tsx`) owns the side effect.
   *
   * TOWN-TERMINAL ROUND: what that side effect IS changed. It used to be
   * `focus_pane` — raising iTerm and ejecting the user from the app — and
   * it is now "open this agent's terminal here", the same `Terminal` the
   * sea uses. Raising the real external terminal survives as its own
   * explicit button, inside `villagerActions`' `AgentActions` — shared with
   * the sea rather than owned here, which is why this component no longer
   * has an `onRaiseExternalTerminal` of its own (sea/town consistency
   * round; see `externalTerminal.ts`).
   */
  onVillagerClick?: (agent: Agent) => void;
  /**
   * What a selected villager's panel shows below its facts — in the shipped
   * app, that agent's own `AgentActions` (its last output, a prompt box,
   * and both terminal actions), supplied by `TownScreen` rather than
   * imported here so this component keeps its "renders, never acts"
   * division: `AgentActions` invokes herdr, and nothing inside `TownView`
   * ever does.
   */
  villagerActions?: (agent: Agent) => ReactNode;
  /**
   * True while a surface above this town owns the keyboard — in the
   * shipped app, the embedded `Terminal`. This view's own "r" (reset the
   * camera) stands down while it is set, so a key typed at the terminal
   * can never also move the town behind it.
   */
  keyboardCaptured?: boolean;
  frameloop?: "always" | "demand";
  preserveDrawingBuffer?: boolean;
  /**
   * Screenshot-harness-only: fit the camera to one district's plot (by its
   * `District.path`) instead of the whole city, for a closer shot of a
   * single district on a large repo. Unused by the shipped app.
   */
  focusDistrictPath?: string;
  /**
   * Screenshot-harness-only: called once the real `OrbitControls` instance
   * exists (and again if it's ever replaced), so the harness can drive the
   * SAME production camera controls the shipped app uses — proving the
   * `frameloop="demand"` + `invalidate()` wiring actually renders a
   * programmatically-moved camera, and producing a screenshot from a
   * genuinely different angle, rather than a hand-rolled stand-in camera
   * that would prove nothing about the real code path. Unused by the
   * shipped app.
   */
  onControlsReady?: (controls: OrbitControlsImpl | null) => void;
  /** Screenshot-harness-only: selects the first building (or district) on
   * mount, the same state a real click would set, so a render can show
   * `BuildingPanel`/`DistrictPanel` actually laid out over the scene.
   * Unused by the shipped app. */
  autoSelectFirstBuilding?: boolean;
  autoSelectFirstDistrict?: boolean;
  /** Screenshot-harness-only: selects the first villager on mount — the
   * same state a real click would set MINUS the click's own side effect
   * (it deliberately does not fire `onVillagerClick`, so a render can show
   * the villager panel without also opening a terminal over it). Unused by
   * the shipped app. */
  autoSelectFirstVillager?: boolean;
};

// Visual overhaul pass (the author rejected the previous palette outright:
// "looks pretty bad... like a circuit board in a swamp"). Townscaper reads
// as a sunny afternoon on a bright, saturated toy island — fresh grass,
// turquoise water, warm sand, cream walls with COLOURED ROOFS (the roof, not
// the wall, now carries `BuildingKind`'s colour — see `BuildingInstances`).
// Every one of these got tuned by rendering all four sample repos and
// looking, not by picking hex codes in the abstract.
// Exported (not just `const`): `Archipelago.tsx` reuses this exact palette —
// "the two screens look like one product" is the brief's own instruction, and
// a second hand-copied set of hex values is exactly the kind of drift
// `city.ts`'s `GRID_PITCH` mistake (`phase-0-followups.md` §6) warns against.
//
// ============================================================================
// AGREED PALETTE
//
// The SCENERY half of this block (ground, sand, foam, water, sky, fog) was
// retuned in the scenery-craft round on the author's own explicit
// instruction — "water looks bad and grass and so on", after two earlier
// rounds' colour work had failed twice. The two conditions the old pinned
// block imposed still bind and were both met: the wide sea AND a close town
// were rendered before and after in the same round, and this block was
// rewritten to match what actually landed.
//
// The rest of the block is still pinned. Do NOT retune a value here without
// an explicit coordinator instruction — a value LOOKING different in one
// screenshot is not sufficient justification on its own.
//
//   GROUND_COLOR          #79bf5e  (below)      grass, mid tone
//   GRASS_SHADE_COLOR     #4f8f55  (below)      grass in the hollows
//   GRASS_LIGHT_COLOR     #a6d46a  (below)      grass on the sunlit crests
//   PLOT_FILL             #f0dfae  (below)      decorative block/plot pads
//   WATER_DEEP_COLOR      #0f5773  (below)      open sea
//   WATER_MID_COLOR       #1a8fa3  (below)      the middle shelf
//   WATER_SHALLOW_COLOR   #4ec7c6  (below)      bright shallows
//   WATER_SANDY_COLOR     #9ad9c1  (below)      sand seen through water
//   WATER_FOAM_COLOR      #eefaf4  (below)      the surf line
//   WATER_GLINT_COLOR     #fff3d6  (below)      sun sparkle on the water
//   WALL_BASE_COLOR       #f5ecd6  (further down) cream building walls
//   CHIMNEY_COLOR         #4a4038  (further down) small dark roof detail
//   SAND_COLOR            (see below, near FOAM_COLOR)
//   FOAM_COLOR            (see below, near SAND_COLOR)
//   SKY_ZENITH_COLOR      #3f7fb4  (further down) overhead sky
//   SKY_HORIZON_COLOR     #cfe3e6  (further down) hazy horizon == FOG_COLOR
//   SEA_FALLBACK_COLOR    #005f83  (below)      below-horizon sky == the
//                                                open sea's own RENDERED
//                                                tone, so a pixel the water
//                                                plane cannot reach still
//                                                reads as sea
//   FOG_COLOR             = SKY_HORIZON_COLOR    distance fog tint
//
// The single most important thing to know before touching the water values:
// they are NOT lit. `Water.tsx` renders the sea with its own shader, on
// purpose — see that module's doc comment for the measurement that forced
// it. A hex here lands on screen close to the hex you wrote (ACES
// tone-mapping aside), which is exactly what was NOT true of the previous
// `meshStandardMaterial` sea, where nearly two units of warm light turned
// every cyan olive no matter how far its saturation was pushed.
//
// Roof colours themselves are `buildingColor(kind)` (six `BuildingKind`
// hues, untouched by that round — it changed no building colour, height,
// footprint, position, wall or villager) — see that function's own
// definition; the saturation/lightness OFFSET applied on top of them for the
// sea's miniature LOD roofs (`+0.22` saturation, `-0.12` lightness) is
// pinned in `Archipelago.tsx`'s `MiniTown`, not restated here.
// ============================================================================
/** Grass, mid tone. Pulled off the old `#8fce6a` — a light yellow-green
 * that, applied as ONE flat value across an entire island, was most of what
 * made the land read as construction paper. It is now the middle of a
 * three-tone range (see `GRASS_SHADE_COLOR`/`GRASS_LIGHT_COLOR`), which is
 * the actual fix: the variation matters far more than the hue did. */
export const GROUND_COLOR = "#79bf5e";
/** Grass in the hollows and on the slopes facing away from the sun — cooler
 * and darker. Blended per vertex by `terrainGeometry.ts` from the terrain's
 * own height and slope, which the mesh already knows and which encodes
 * nothing about the repository. */
export const GRASS_SHADE_COLOR = "#4f8f55";
/** Grass on the sunlit crests — lighter and warmer, drifting toward dry
 * meadow. The other end of the same range. */
export const GRASS_LIGHT_COLOR = "#a6d46a";
/** The rock face under the turf — the town's ground slab's vertical sides,
 * and the same tone the sea islands' own steep slopes fade toward. It used
 * to be `GROUND_COLOR` itself, i.e. grass painted down a cliff, which is a
 * large part of why a town read as a rug laid on the water rather than a
 * piece of land sticking out of it. */
export const CLIFF_COLOR = "#9e9179";
export const PLOT_FILL = "#f0dfae";
/** The open sea. Genuinely DARK, which is the structural change: the old
 * water sat at almost exactly the same luminance as the grass, so islands
 * read as patches on a green carpet rather than land in a sea. Value
 * separation between land and water is what makes this style work, and no
 * amount of hue tuning substitutes for it. */
export const WATER_DEEP_COLOR = "#155761";
/** The middle of the shelf, between the open sea and the bright shallows. */
export const WATER_MID_COLOR = "#258f96";
/** The bright shallows right off the coastline — the tropical note the
 * whole palette is built around. */
export const WATER_SHALLOW_COLOR = "#4ec7c6";
/** Sand seen THROUGH shallow water, in the last band before the surf. */
export const WATER_SANDY_COLOR = "#9ad9c1";
/** The surf line itself, right at the coastline. */
export const WATER_FOAM_COLOR = "#eefaf4";
/** Sun sparkle on the water — warm, matching `SunLight`'s own colour, and
 * the only place the sun's actual direction shows up on a flat surface. */
export const WATER_GLINT_COLOR = "#fff3d6";
/** What the sky dome paints BELOW the horizon, and what the canvas clears
 * to. Not `WATER_DEEP_COLOR` itself but the value the open sea actually
 * RENDERS at — sampled from a real render (`#005f83`, against the
 * authored `#0f5773`), so the one place the water plane cannot reach (see
 * `Atmosphere`'s own comment on the near-plane clip) blends into it instead
 * of stepping. */
export const SEA_FALLBACK_COLOR = "#005f83";

/** The six scenery water tones as one object, because `Water.tsx` takes them
 * together and a fresh object literal per render would rebuild the shader
 * material on every frame. Module-level, so its identity never changes. */
export const WATER_COLORS = {
  deep: WATER_DEEP_COLOR,
  mid: WATER_MID_COLOR,
  shallow: WATER_SHALLOW_COLOR,
  sandy: WATER_SANDY_COLOR,
  foam: WATER_FOAM_COLOR,
  glint: WATER_GLINT_COLOR,
};
// Roads recede rather than dominate: lighter, closer to the land tone than
// the old saturated brown.
//
// Coordinator correction (checkerboard pass): `ROAD_WIDTH_FRAC` used to be
// `0.55` — narrower than a full cell, on purpose, so a strip of `GROUND_COLOR`
// showed on every side of a road tile. That was fine for a district whose
// `road_edges` loop hugs a fully-built content pad, but `road_edges` is the
// PLOT's own perimeter (real reserved space — Task 5/6's "don't paint
// headroom as an occupied plaza" rule forbids `DistrictPad` from covering
// it), and a sparsely-populated district (my-site-next's
// `src/app/demos/1`: a 4x3 plot, 1 building, 10 of its 12 cells are
// `road_edges`) has almost NO content pad to hug — its perimeter tiles sit
// directly on bare grass instead. A `0.55`-wide tile there is an isolated
// diamond surrounded by grass on every side; a whole neighbourhood of such
// districts side by side (exactly what `src/app/demos/*` is) reads as a
// scattered grid of tan dots on green, which is the "checkerboard tiling
// artefact" a coordinator review caught — not a shading bug, a GEOMETRY gap
// between adjacent perimeter tiles that should be touching.
//
// `1.0` (a full, ungapped cell) instead: adjacent `road_edges` cells along
// the SAME loop are exactly one grid unit apart, so at `1.0` they share an
// edge exactly — no gap, no overlap, no z-fighting (coplanar quads that meet
// at a boundary render as one continuous surface, not two competing ones).
// The loop now reads as a solid outline path around the plot instead of a
// dashed/scattered one. "Recede, don't dominate" is carried entirely by
// colour now (`ROAD_COLOR` sits close to `PLOT_FILL`, not a bare tan against
// bright grass) rather than by leaving gaps for grass to show through.
const ROAD_COLOR = "#e6d3a1";
/** Fraction of a cell a road tile actually covers — see `RoadNetwork`. `1.0`
 * — see the doc comment on `ROAD_COLOR` for why a full, ungapped cell is
 * what makes a road (or a district's boundary loop) read as one continuous
 * path rather than a scatter of separate tiles. */
const ROAD_WIDTH_FRAC = 1.0;
// The one element both the author and the coordinator liked already — kept,
// but re-tuned to a warm terracotta so it belongs on the new palette instead
// of the old muddy one.
export const WALL_COLOR = "#c1704a";
/** The land's visible thickness above the water, in world units — this is
 * what gives the island a coastline (a visible cliff edge) instead of being
 * an infinite flat sheet the water merely tints. */
export const GROUND_THICKNESS = 0.5;
/** Warm off-white/cream — every building's WALL colour now, regardless of
 * `BuildingKind`. This is the single inversion that does most of the work of
 * reading as Townscaper rather than a spreadsheet: kind is still fully
 * encoded (on the roof, via `buildingColor`), but the wall no longer carries
 * it, so a block of houses reads as a block of houses first and a
 * colour-coded diagram second. */
export const WALL_BASE_COLOR = "#f5ecd6";
/** A small dark stack tone (item 6, "occasional chimneys") — deliberately
 * close to the window/door marks' own colour (`facadeTexture.ts`) so it
 * reads as "the same kind of dark architectural detail," not a fourth new
 * material competing for attention. */
export const CHIMNEY_COLOR = "#4a4038";
/** The void beyond the water plane, at an isometric view's far corners —
 * see the `<color attach="background">` comment where this is used. A flat
 * fallback only, for a pixel the sky dome somehow misses; `Atmosphere`'s
 * gradient dome is what is actually visible in practice. Scenery-craft
 * round: it is the DEEP SEA colour now rather than a pale cyan, for the
 * same reason the dome's lower hemisphere is (see `Atmosphere`) — anywhere
 * the water fails to cover should read as more water, not as a hole. */
export const SKY_COLOR = SEA_FALLBACK_COLOR;
/** Art-direction round, item 1: "there is no atmosphere at all... add a
 * graded sky, distance fog... a warmer, more directional sun." A flat pale
 * background reads as a diagram, not a place — real air has a colour
 * gradient and things far away soften into that haze rather than staying
 * crisp. `SKY_HORIZON_COLOR` doubles as `FOG_COLOR` so distant
 * islands/buildings fade INTO the sky rather than into a mismatched tint.
 *
 * Scenery-craft round: the horizon was a warm cream (`#f7e0b8`). Against
 * the old olive sea that was invisible; against a genuinely deep blue sea it
 * would have read as a band of sand along the top of every wide shot,
 * because `FOG_COLOR` is what everything distant turns into. Moved to a pale
 * sea-haze, and the zenith deepened (`#5f93bf` -> `#3f7fb4`) so the dome
 * actually has somewhere to travel between the two. */
export const SKY_ZENITH_COLOR = "#3f7fb4";
export const SKY_HORIZON_COLOR = "#cfe3e6";
export const FOG_COLOR = SKY_HORIZON_COLOR;
/** A warm sand tone for the beach band between full land and open water —
 * shared by the town's own ground and every sea island's terrain, so the
 * two screens' coastlines read as the same material. */
export const SAND_COLOR = "#e8d3a2";
/** Wet sand, in the narrow band the surf actually reaches — darker and a
 * touch cooler than dry `SAND_COLOR`. Scenery-craft round: the old terrain
 * put an almost-white `FOAM_COLOR` band here instead, which was both the
 * wrong material (foam is on the WATER, and is now drawn there by
 * `Water.tsx`) and invisible anyway, since that part of the mesh sat below
 * the waterline. A darkening wet band is what a real beach does at its
 * waterline, and it gives the coastline the tonal step it never had. */
export const WET_SAND_COLOR = "#c9ab7c";
/** A bright, almost-white foam tone. Still used for the town's own ground
 * edge; the SEA's surf line moved into the water shader
 * (`WATER_FOAM_COLOR`), where it belongs. */
export const FOAM_COLOR = "#f5f3e8";
/** A CLICKED building's highlight — an edge outline plus a ground tile,
 * both this colour. Deliberately distinct from `HOVER_COLOR` (a warm gold
 * versus a cool white) so a hovered-and-selected building is never
 * ambiguous about which state it's in. */
const SELECTION_COLOR = "#ffd23f";
/** A HOVERED building's highlight — a single, subtler ground tile, no edge
 * outline. See `SELECTION_COLOR`'s doc comment for why the two must read as
 * different states, not different intensities of the same one. */
const HOVER_COLOR = "#ffffff";

const KIND_ORDER: BuildingKind[] = ["Source", "Test", "Config", "Docs", "Asset", "Data"];

// ---------------------------------------------------------------------
// Camera controls: orbit/pan/zoom via drei's OrbitControls, constrained so
// the user cannot get lost or break the illusion (the author's own
// complaint this round: "so i cant move around and scroll... it looks very
// basic"). Every bound below is a MULTIPLE of the fitted view's own zoom or
// the city's own diagonal, computed fresh per city in `CameraRig` — never
// an absolute number — so a tiny repo and a 1,055-building one get
// proportionally the same freedom to explore.
// ---------------------------------------------------------------------

/** How far out the user may zoom, as a fraction of the initial fitted zoom.
 * Below `1.0` on purpose (zooming OUT past the fitted frame) but bounded —
 * scrolling out into empty turquoise with no island in view is a user who
 * has lost the thing they were looking at, per the coordinator's own
 * instruction. */
const MIN_ZOOM_FACTOR = 0.5;
/** How far in the user may zoom, as a multiple of the initial fitted zoom —
 * close enough to read a single house's facade. */
const MAX_ZOOM_FACTOR = 8;
/** How far the orbit TARGET may be panned from the city's own centre,
 * as a fraction of the city's bounding-box diagonal. Bounds panning so the
 * island cannot be shoved off-screen entirely, per the coordinator's own
 * instruction, while still leaving room to inspect an edge district up
 * close. */
const PAN_RADIUS_FACTOR = 0.6;

/** A generous estimate of the tooltip's own rendered size, in pixels — see
 * `clampTooltipPosition`. Slightly larger than any real building path is
 * likely to render at, on purpose: overestimating here can only ever pull
 * the tooltip a little further from the cursor than strictly necessary,
 * while underestimating it is what lets it run off an edge. */
const TOOLTIP_W = 280;
const TOOLTIP_H = 30;
const TOOLTIP_CURSOR_OFFSET = 14;

/**
 * Where to draw the hover tooltip, in STAGE-relative pixels, given the raw
 * cursor position and the stage's own size — a pure function so the fix for
 * the bug the author's screenshot caught (a tooltip rendered clipped at the
 * very bottom edge of the window) has its own unit test, not only a
 * screenshot nobody happens to hover a building in.
 *
 * The bug had two independent causes, and this fixes both: (1) the tooltip
 * was positioned from `event.clientX`/`clientY` — viewport-relative — while
 * being placed inside a container that does not start at the viewport's own
 * origin (`.town__stage` sits below `.town__header`), which by itself
 * offsets the tooltip from the cursor; TownView's caller now converts to
 * stage-relative coordinates before this function ever runs. (2) nothing
 * clamped the result, so a cursor near the stage's bottom or right edge
 * could place the tooltip partly or entirely outside the visible window.
 * This flips to the opposite side of the cursor when the default placement
 * would overflow, and then hard-clamps to the stage's own bounds as a last
 * resort.
 */
export function clampTooltipPosition(
  cursorX: number,
  cursorY: number,
  stageWidth: number,
  stageHeight: number,
): { left: number; top: number } {
  let left = cursorX + TOOLTIP_CURSOR_OFFSET;
  let top = cursorY + TOOLTIP_CURSOR_OFFSET;
  if (left + TOOLTIP_W > stageWidth) left = cursorX - TOOLTIP_CURSOR_OFFSET - TOOLTIP_W;
  if (top + TOOLTIP_H > stageHeight) top = cursorY - TOOLTIP_CURSOR_OFFSET - TOOLTIP_H;
  left = Math.max(4, Math.min(left, Math.max(4, stageWidth - TOOLTIP_W - 4)));
  top = Math.max(4, Math.min(top, Math.max(4, stageHeight - TOOLTIP_H - 4)));
  return { left, top };
}

export function TownView({
  cityView,
  agents = [],
  onVillagerClick,
  villagerActions,
  keyboardCaptured = false,
  frameloop = "demand",
  preserveDrawingBuffer = false,
  focusDistrictPath,
  onControlsReady,
  autoSelectFirstBuilding,
  autoSelectFirstDistrict,
  autoSelectFirstVillager,
  onCodeSelect,
  focusRequest,
  changes,
  changesLive = false,
  externalInspector = false,
}: TownViewProps) {
  const { model, layout } = cityView;
  const recording = useRecording();
  const gridPitch = useMemo(() => gridPitchOf(layout), [layout]);
  // The sea's island cue, carried into the town: waiting-for-you wins over
  // working, and a town where nobody is doing either gets no glow at all.
  const townAttention: "stopped" | "working" | null = agents.some((a) => a.attention === "stopped")
    ? "stopped"
    : agents.some((a) => a.attention === "working")
      ? "working"
      : null;
  // Hover coordinates are stored in STAGE-relative pixels (see `handleHover`
  // in `BuildingInstances`), not raw `clientX`/`clientY` — the bug the
  // author's screenshot caught was a tooltip positioned from viewport
  // coordinates inside a container that doesn't start at the viewport's
  // origin (`.town__stage` sits below `.town__header`), which both offsets
  // the tooltip from the cursor and can push it past the window's bottom
  // edge with nothing to clamp it back in.
  const [hover, setHover] = useState<BuildingHoverInfo | null>(null);
  // A CLICK, not a hover — persists until Escape, the close button, or a
  // click that misses every building (see the `Canvas`'s `onPointerMissed`
  // below). Deliberately separate state from `hover`: the two are different
  // interactions with different lifetimes, and conflating them is exactly
  // what made the previous round's only interaction (a tooltip) feel inert.
  const [selected, setSelected] = useState<SelectedBuilding | null>(null);
  // Item 5 (actions-UI round): a district can be selected too, offering
  // "reveal in Finder" for its own directory — mutually exclusive with a
  // building selection (selecting one clears the other), so only one panel
  // is ever on screen. `null` means neither empty ground was clicked NOR a
  // district — see `onPointerMissed` below, which clears both.
  const [selectedDistrict, setSelectedDistrict] = useState<SelectedDistrictInfo | null>(null);
  // Town-villagers round, item 5 (selection consistency): a villager is a
  // THIRD, mutually-exclusive selection alongside a building and a district
  // — never more than one of the three panels on screen at once. Every path
  // that sets one of the other two (below, and `onPointerMissed`) also
  // clears this.
  const [selectedVillager, setSelectedVillager] = useState<Agent | null>(null);
  // The selected villager as the world reports it RIGHT NOW, not as it was
  // the instant it was clicked — the same reasoning `App`'s `liveIslandFor`
  // already applies one level up. A panel that keeps saying "Attention:
  // working" for an agent that stopped ten minutes ago is the honesty rule
  // broken in the one place the user is looking. Falls back to the clicked
  // snapshot only while the agent is genuinely gone from `agents`, which is
  // the honest reading of "herdr no longer reports this pane" — the panel
  // then still names it rather than vanishing mid-sentence.
  const liveVillager = useMemo(() => {
    if (selectedVillager === null) return null;
    return agents.find((agent) => agent.pane_id === selectedVillager.pane_id) ?? selectedVillager;
  }, [agents, selectedVillager]);
  // Cursor feedback for a hovered villager — deliberately NOT folded into
  // `hover` (below): that state carries building-specific data
  // (`BuildingHoverInfo`) a villager has none of, and this is used for
  // nothing but the cursor style, unlike `hover`'s own tooltip.
  const [villagerHovered, setVillagerHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  const kindBuckets = useMemo(
    () => buildKindBuckets(model, layout, gridPitch),
    [model, layout, gridPitch],
  );
  // Live growth: compare each measurement of this town with the one before
  // it (a re-measure happens every few seconds while an agent here works —
  // see `TownWorkspace`), so new files rise and every real line change gets
  // a short-lived "+N" over its building. A different repository is a first
  // measurement again, never a diff.
  const lines = useMemo(() => townLines(model), [model]);
  const lastLinesRef = useRef<{ root: string; lines: Map<string, number> } | null>(null);
  const growth = useMemo(() => {
    const previous = lastLinesRef.current;
    return diffTownLines(previous && previous.root === model.root ? previous.lines : null, lines);
  }, [lines, model.root]);
  useEffect(() => {
    lastLinesRef.current = { root: model.root, lines };
  }, [lines, model.root]);
  // Construction (see `Construction.tsx`): only while an agent here is
  // working. Scaffolding and the crane go where Git says files changed;
  // smoke rises from a fixed share of the chimneys — which ones is a hash of
  // the path, so the same houses smoke every time.
  const working = townAttention === "working";
  const construction = useMemo(() => {
    if (!working) return { sites: [] as Site[], smoke: [] as THREE.Vector3[] };
    const sites: Site[] = [];
    const chimneys: { order: number; site: Site }[] = [];
    for (const bucket of Object.values(kindBuckets)) {
      bucket.metas.forEach((meta, i) => {
        const t = bucket.transforms[i];
        if (changes?.has(meta.path)) sites.push(t);
        if (t.hasChimney) chimneys.push({ order: hashString(meta.path) % 1000, site: t });
      });
    }
    chimneys.sort((a, b) => a.order - b.order);
    return {
      sites: sites.slice(0, MAX_SCAFFOLDS),
      smoke: chimneys.slice(0, MAX_SMOKING_CHIMNEYS).map((c) => chimneyTop(c.site)),
    };
  }, [working, kindBuckets, changes]);
  const growthSeqRef = useRef(0);
  const growthSeq = useMemo(() => (growth.deltas.length > 0 ? ++growthSeqRef.current : growthSeqRef.current), [growth]);
  const codeSelectRef = useRef(onCodeSelect);
  codeSelectRef.current = onCodeSelect;
  const focusBounds = useMemo(() => {
    if (!focusRequest) return undefined;
    for (const bucket of Object.values(kindBuckets)) {
      const index = bucket.metas.findIndex(meta => meta.path === focusRequest.path);
      if (index >= 0) {
        const t = bucket.transforms[index];
        const radius = Math.max(3, t.footprint * 2.5);
        return new THREE.Box3(new THREE.Vector3(t.x - radius, 0, t.z - radius), new THREE.Vector3(t.x + radius, t.height + 1, t.z + radius));
      }
    }
    if (model.districts.some(d => d.path === focusRequest.path)) return computeBounds(layout, model, focusRequest.path);
    return undefined;
  }, [focusRequest, kindBuckets, model, layout]);
  useEffect(() => {
    if (!focusRequest) return;
    for (const bucket of Object.values(kindBuckets)) {
      const index = bucket.metas.findIndex(meta => meta.path === focusRequest.path);
      if (index >= 0) {
        setSelected({ meta: bucket.metas[index], transform: bucket.transforms[index] });
        setSelectedDistrict(null); setSelectedVillager(null); return;
      }
    }
    setSelected(null);
    const district = model.districts.find(d => d.path === focusRequest.path);
    setSelectedDistrict(district ? { path: district.path, name: district.name, buildingCount: district.buildings.length } : null);
    setSelectedVillager(null);
  }, [focusRequest, kindBuckets, model]);

  // Screenshot-harness-only (see `TownViewProps`'s own doc comment): select
  // the first real building/district on mount, the same state a click would
  // set, so `BuildingPanel`/`DistrictPanel` render for a screenshot without
  // a synthetic pointer event.
  useEffect(() => {
    if (autoSelectFirstBuilding) {
      for (const kind of KIND_ORDER) {
        const bucket = kindBuckets[kind];
        if (bucket.transforms.length > 0) {
          setSelected({ meta: bucket.metas[0], transform: bucket.transforms[0] });
          break;
        }
      }
    }
  }, [autoSelectFirstBuilding, kindBuckets]);

  useEffect(() => {
    if (autoSelectFirstVillager && agents.length > 0) setSelectedVillager(agents[0] ?? null);
  }, [autoSelectFirstVillager, agents]);

  useEffect(() => {
    if (autoSelectFirstDistrict) {
      const district = model.districts[0];
      if (district) {
        setSelectedDistrict({ name: district.name, path: district.path, buildingCount: district.buildings.length });
      }
    }
  }, [autoSelectFirstDistrict, model]);

  const bounds = useMemo(
    () => computeBounds(layout, focusDistrictPath ? model : undefined, focusDistrictPath),
    [layout, model, focusDistrictPath],
  );

  // Clamped so the tooltip always stays fully inside the stage, on every
  // edge — not just "add an offset and hope the cursor was far enough from
  // the edge," which is what produced the clipped-at-the-bottom bug. The
  // actual math is `clampTooltipPosition`, a pure function kept outside the
  // component (and exported) specifically so it has its own unit tests
  // rather than only ever being exercised through a rendered screenshot.
  const tooltipStyle = useMemo(() => {
    if (!hover) return null;
    const rect = stageRef.current?.getBoundingClientRect();
    const stageW = rect?.width ?? hover.x + 300;
    const stageH = rect?.height ?? hover.y + 100;
    return clampTooltipPosition(hover.x, hover.y, stageW, stageH);
  }, [hover]);

  // Reset-view: a button AND a key ("r"), per the coordinator's explicit
  // instruction — the first thing anyone does with a new orbit control is
  // get lost. Bumping `resetSignal` (rather than calling `controls.reset()`
  // directly) is what makes this EASED (game-feel round: "ease transitions
  // when... resetting the view") and re-derives the fit from the CURRENT
  // window size/bounds rather than whatever was `saveState()`-d, which could
  // predate a resize — see `CameraRig`'s own doc comment on `resetSignal`. A
  // plain `window` listener (not `useHotkey`): this is scoped to "a town is
  // open at all," which is already this component's entire lifetime, and "r"
  // needs no coordination with any other hotkey or modal the way Escape does.
  const [resetSignal, setResetSignal] = useState(0);
  const resetView = useCallback(() => setResetSignal((s) => s + 1), []);
  // A ref rather than a dependency: the listener below must stay
  // subscribed exactly once (see its own comment), and this value flips
  // every time a terminal opens or closes.
  const keyboardCapturedRef = useRef(keyboardCaptured);
  keyboardCapturedRef.current = keyboardCaptured;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "r" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isInteractiveTarget(event.target) &&
        // Town-terminal round: while the embedded terminal is up it owns
        // the keyboard over this town. With its pane surface focused this
        // key never reaches here anyway (that surface stops propagation),
        // but an "r" typed while the terminal's HEADER or close button has
        // focus used to spin the camera behind it — the same class of leak
        // this round had to close in both directions. Read from a ref so
        // this listener still subscribes exactly once.
        //
        // Deliberately NOT `isModalOpen()`, which the sea's own "r" uses:
        // the town's `BuildingPanel`/`DistrictPanel`/`VillagerPanel` are
        // all `role="dialog"` (that is how they swallow the town's Escape),
        // so that test would also disable "r" for an ordinary selected
        // building, which nothing asked for.
        !keyboardCapturedRef.current
      ) {
        resetView();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [resetView]);

  // Cursor feedback (item 4, "make it feel alive"): grab while idle,
  // grabbing while actually dragging the camera, pointer while hovering a
  // clickable building OR villager. Independent of `OrbitControls`, which
  // attaches its OWN native listeners straight to the canvas — this is
  // purely visual and never interferes with it.
  const cursor = dragging ? "grabbing" : hover || villagerHovered ? "pointer" : "grab";

  // Town-villagers round, item 2: fires `onVillagerClick` FIRST and
  // unconditionally — the same "never gated behind an animation" rule
  // `Archipelago.tsx`'s own `handleVillagerClick` follows — then updates
  // local selection state. Selecting a villager clears any building/district
  // selection (item 5: one thing selected at a time).
  const handleVillagerSelect = useCallback(
    (agent: Agent) => {
      onVillagerClick?.(agent);
      setSelected(null);
      setSelectedDistrict(null);
      setSelectedVillager(agent);
    },
    [onVillagerClick],
  );

  // Cost-of-hover round (Item 2 of the resource-hygiene report): these two
  // used to be inlined at their JSX call sites below, a fresh closure every
  // `TownView` render — including every render `setHover` alone causes on
  // ordinary pointer movement over a building. A fresh `onSelect` identity
  // every render defeats `React.memo` on `DistrictPad`/`BuildingInstances`
  // (memo bails on REFERENCE equality; a new function is never equal to the
  // last one) even though neither component's OWN data (`district`/`bucket`)
  // actually changed. Hoisting them here, with `[]` deps (both only ever
  // call the same three setters, never anything that varies across
  // renders), gives every `DistrictPad`/`BuildingInstances` instance a
  // stable prop across a hover-only re-render — the other half of what lets
  // `React.memo` below skip re-invoking ~1,064 buildings' worth of
  // components for a mouse move that didn't even change which building is
  // hovered.
  const handleDistrictSelect = useCallback((info: SelectedDistrictInfo) => {
    setSelected(null);
    setSelectedVillager(null);
    setSelectedDistrict(info);
    codeSelectRef.current?.(info.path, "directory");
  }, []);
  const handleBuildingSelect = useCallback((selection: SelectedBuilding) => {
    setSelectedDistrict(null);
    setSelectedVillager(null);
    setSelected(selection);
    codeSelectRef.current?.(selection.meta.path, "file");
  }, []);

  return (
    <div
      ref={stageRef}
      className="scene-stage"
      style={{ position: "relative", width: "100%", height: "100%", cursor }}
      onPointerDown={() => setDragging(true)}
      onPointerUp={() => setDragging(false)}
      onPointerLeave={() => setDragging(false)}
    >
      <Canvas
        style={{ isolation: "isolate" }}
        frameloop={frameloop}
        shadows="soft"
        gl={{
          antialias: true,
          preserveDrawingBuffer,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.15,
        }}
        orthographic
        camera={{ near: 0.1, far: 4000 }}
        // Fires when a click hits nothing interactive — every building
        // registers its own handlers, but the ground/water/roads/plots
        // never do (design inputs §3: they are honest, non-interactive
        // scenery), so this is exactly "the user clicked empty space,"
        // never a building. Clears the selection the same way Escape or
        // the panel's own close button does.
        onPointerMissed={() => {
          setSelected(null);
          setSelectedDistrict(null);
          setSelectedVillager(null);
        }}
      >
        <CameraRig
          bounds={bounds}
          controlsRef={controlsRef}
          onControlsReady={onControlsReady}
          resetSignal={resetSignal}
          focusBounds={focusBounds}
          focusSequence={focusRequest?.seq}
          autoRotate={recording}
        />
        {/* A flat fallback only — `Atmosphere`'s graded sky dome is what's
            actually visible; this is what would show if a pixel somehow
            missed the dome entirely. */}
        <color attach="background" args={[SKY_COLOR]} />
        <Atmosphere bounds={bounds} />
        {/* Cool sky fill plus the warm, shadow-casting sun — see
            `SceneLights`' own doc comment for why the temperature split
            between the two is doing the work here. */}
        <SceneLights bounds={bounds} />
        <Ground layout={layout} />
        {townAttention && <TownAttentionGlow layout={layout} attention={townAttention} />}
        <TownVegetation layout={layout} model={model} />
        {layout.districts.map((district) => (
          <DistrictPad
            key={district.district_index}
            district={district}
            model={model}
            onSelect={handleDistrictSelect}
          />
        ))}
        <RoadNetwork model={model} layout={layout} />
        {KIND_ORDER.map((kind) => (
          <BuildingInstances
            key={kind}
            kind={kind}
            bucket={kindBuckets[kind]}
            onHover={setHover}
            onSelect={handleBuildingSelect}
            stageRef={stageRef}
            grownPaths={growth.added}
            windowsLit={townAttention !== null}
          />
        ))}
        {growth.deltas.length > 0 && <GrowthLabels key={growthSeq} deltas={growth.deltas} buckets={kindBuckets} />}
        <Scaffolding sites={construction.sites} pitch={gridPitch} />
        <Crane sites={construction.sites} pitch={gridPitch} />
        <ChimneySmoke sources={construction.smoke} pitch={gridPitch} />
        {/* Town-villagers round: every agent working in this repository,
            standing in its town — see `TownVillagers`'s own doc comment for
            placement/attention/idle-motion, and `handleVillagerSelect` above
            for the click contract. */}
        <TownVillagers
          agents={agents}
          model={model}
          layout={layout}
          gridPitch={gridPitch}
          selectedPaneId={selectedVillager?.pane_id ?? null}
          onSelect={handleVillagerSelect}
          onHoverChange={setVillagerHovered}
        />
        {/* Item 7: "objects look pasted on... add contact shadows/cheap
            ambient occlusion where things meet ground." One `ContactShadows`
            for the whole town (never per-building/per-district) — a single
            extra shadow-camera pass, not one per building, is what actually
            sells "sitting on the ground" at a fraction of a real shadow
            map's cost, and this is the ONE place in the whole scene it's
            worth paying for it (see `SeaIslandGroup`'s own comment for why
            the sea deliberately does NOT get one per island).

            NOT `frames={1}` (a one-shot bake, the first thing tried, in
            case the earliest frame(s) render before `BuildingInstances`'
            own `useLayoutEffect` finishes writing real matrices): rendering
            with `frames={1}` and without `ContactShadows` at all side by
            side showed the exact same result either way, so that was never
            actually the cause of anything — left at its default
            (continuous) regardless, since it costs one extra shadow-camera
            render per frame for the WHOLE town, not per building, which is
            cheap enough not to need the one-shot optimisation at all. */}
        <ContactShadows
          position={[(bounds.min.x + bounds.max.x) / 2, 0.01, (bounds.min.z + bounds.max.z) / 2]}
          opacity={0.4}
          scale={Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 1.3}
          blur={2.5}
          far={3}
          resolution={512}
          color="#2a2118"
        />
        {/* Hover and selection are rendered as SEPARATE highlights, in
            different colours (see `HOVER_COLOR`/`SELECTION_COLOR`) — the
            coordinator's explicit ask for "a hover highlight distinct from
            the selection highlight." Skip the hover tile entirely when it's
            the SAME building that's already selected, so the two never
            visually compete over one spot. */}
        {hover && hover.meta.path !== selected?.meta.path && (
          <HoverHighlight transform={hover.transform} />
        )}
        {selected && <SelectionHighlight transform={selected.transform} />}
        {changes && <ChangeMarkers buckets={kindBuckets} changes={changes} live={changesLive} />}
        <CinematicEffects tiltShift={recording} />
      </Canvas>
      {hover && tooltipStyle && (
        <div
          style={{
            position: "absolute",
            left: tooltipStyle.left,
            top: tooltipStyle.top,
            pointerEvents: "none",
            background: "rgba(30, 24, 16, 0.92)",
            color: "#faf3e3",
            font: "12px ui-monospace, SFMono-Regular, Menlo, monospace",
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid #6b4a30",
            whiteSpace: "nowrap",
            zIndex: 1,
          }}
        >
          {hover.meta.path}
          <span style={{ opacity: 0.7 }}> — {hover.meta.districtName}</span>
        </div>
      )}
      {/* A button AND a key ("r") reset the view — see `resetView`'s own
          comment for why both exist. Positioned clear of the tooltip/panel
          corners so it never overlaps either. */}
      <button
        type="button"
        onClick={resetView}
        title="Reset view (r)"
        className="chart-chip town-reset-view"
      >
        ⟲ reset view
      </button>
      {selected && !externalInspector && (
        <BuildingPanel
          selection={
            {
              path: selected.meta.path,
              name: selected.meta.name,
              kind: selected.meta.kind,
              lines: selected.meta.lines,
              districtName: selected.meta.districtName,
            } satisfies SelectedBuildingInfo
          }
          onClose={() => setSelected(null)}
        />
      )}
      {selectedDistrict && !externalInspector && (
        <DistrictPanel selection={selectedDistrict} onClose={() => setSelectedDistrict(null)} />
      )}
      {liveVillager && !keyboardCaptured && (
        <VillagerPanel agent={liveVillager} onClose={() => setSelectedVillager(null)}>
          {villagerActions?.(liveVillager)}
        </VillagerPanel>
      )}
    </div>
  );
}

/**
 * The sun: a single directional light, positioned and shadow-frustum-fit to
 * the SAME bounds the camera fits to (see `CameraRig`), so its shadow map
 * always covers exactly the visible city — never clipped, never wastefully
 * oversized. Art-direction round: lowered further and pushed warmer —
 * "Islanders gets its beauty from... long warm light" — so shadows read as
 * genuinely long and directional (late-afternoon, not high noon) rather
 * than the shorter, cooler ones a steeper sun gives; this is the single
 * biggest lever on the whole scene reading as three-dimensional rather than
 * pasted-on flat colour.
 */
/** Exported so `Archipelago.tsx` can reuse the SAME shadow-casting sun
 * rather than writing a second lighting setup — the archipelago-scene
 * round's own coordinator review called this out explicitly: the town's
 * look comes largely from this light, and the sea had none of it. */
export function SunLight({ bounds }: { bounds: THREE.Box3 }) {
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const targetRef = useRef<THREE.Object3D>(null);
  const { invalidate } = useThree();
  const { sun } = useMood().look;

  useLayoutEffect(() => {
    const light = lightRef.current;
    const target = targetRef.current;
    if (!light || !target) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);

    // Lowered from `radius * 1.15` to `radius * 0.95` (height) against a
    // wider horizontal spread (`1.3`/`1.4` vs the old `0.85`/`1.25`) — a
    // shallower elevation angle (~34° vs. the original ~42°) throws
    // noticeably longer, warmer-reading shadows without the near-grazing
    // ~20° a first attempt at this used, which threw shadows so long they
    // swept across and washed out the whole scene instead of reading as
    // "afternoon light."
    // Exactly the position this always used (`radius * 1.3`, `radius * 0.95
    // + 2`, `radius * 1.4`) — the numbers simply live in `Water.tsx`'s
    // `SUN_OFFSET` now, because the water shader has to normalize the same
    // three to know where to put its glint. Nothing about the sun moved.
    light.position.set(
      center.x + radius * SUN_OFFSET.x,
      radius * SUN_OFFSET.y * sun.height + 2,
      center.z + radius * SUN_OFFSET.z,
    );
    target.position.copy(center);
    light.target = target;
    target.updateMatrixWorld();
    light.target.updateMatrixWorld();

    const cam = light.shadow.camera as THREE.OrthographicCamera;
    cam.left = -radius * 1.3;
    cam.right = radius * 1.3;
    cam.top = radius * 1.3;
    cam.bottom = -radius * 1.3;
    cam.near = 0.1;
    cam.far = radius * 4 + 10;
    cam.updateProjectionMatrix();
    // Depth bias alone left shadow acne — dark blotches crawling over the
    // sloped roofs and walls as the camera moved. Offsetting along the
    // normal by about one shadow texel clears it; a texel's size depends on
    // how large the frustum above is, so it is derived, not a constant.
    light.shadow.normalBias = ((cam.right - cam.left) / light.shadow.mapSize.width) * 1.5;

    invalidate();
  }, [bounds, invalidate, sun.height]);

  return (
    <>
      {/* Warm key light. Its partner is `SceneLights`' deliberately COOL
          hemisphere fill — see that component's own doc comment for why the
          temperature SPLIT, not the warmth, is what makes a surface read as
          shaded. */}
      <directionalLight
        ref={lightRef}
        color={sun.color}
        intensity={sun.intensity}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-bias={-0.0015}
      />
      <object3D ref={targetRef} />
    </>
  );
}

/**
 * The whole scene's lighting, in one place, used identically by the town and
 * the sea (the brief's "the two screens look like one product").
 *
 * Scenery-craft round. Before it, the fill was a WARM hemisphere
 * (`#ffe6bd`) under a warm sun (`#ffcf94`) — roughly 1.8 units of amber
 * irradiance on an up-facing surface, with nothing cool anywhere in the
 * scene. That is why every large flat area read as cheap: with key and fill
 * at the same colour temperature, a lit face and a shaded face differ only
 * in brightness, so shading carries no information and every surface
 * flattens toward one tint. (It is also, measurably, what was turning the
 * sea olive — see `Water.tsx`.)
 *
 * A warm key against a COOL sky fill is the oldest fix there is: the lit
 * side goes warm, the shaded side goes blue, and the difference between them
 * becomes a hue shift rather than a dimmer version of the same colour.
 * Nothing else about the light moved — same sun position, same elevation,
 * same shadow frustum.
 */
export function SceneLights({ bounds }: { bounds: THREE.Box3 }) {
  const { fill } = useMood().look;
  return (
    <>
      {/* Cool sky above, warm bounced earth below — per mood (see `mood.tsx`). */}
      <hemisphereLight color={fill.sky} groundColor={fill.ground} intensity={fill.intensity} />
      <SunLight bounds={bounds} />
    </>
  );
}

/**
 * Art-direction round, item 1 (the highest-leverage change on the whole
 * list): a graded sky and distance fog — "a sense of air between you and
 * the far shore." Two pieces:
 *
 * - A large inverted sphere, vertex-coloured from a cooler `SKY_ZENITH_COLOR`
 *   overhead to a warm, hazy `SKY_HORIZON_COLOR` low down, centred on the
 *   scene and sized well past the camera's own orbit range so it can never
 *   be seen from "outside" (which would show its unlit backside as a flat
 *   colour) or clipped by the far plane. `depthWrite={false}` and a
 *   `renderOrder` of `-1` so it never fights real geometry for the depth
 *   buffer — it is always the backdrop, never a Z-fighting hazard.
 * - `fogExp2`, coloured to match `SKY_HORIZON_COLOR` exactly, so a far
 *   island/building doesn't fade into a mismatched tint — it fades into the
 *   SAME haze the sky itself is made of. Density is scaled by the scene's
 *   own diagonal (`bounds`) so a tiny district and the whole 152-island sea
 *   both get "far things soften," not "everything past 20 units vanishes"
 *   or "no fog ever visible because the whole scene is smaller than the
 *   falloff."
 *
 * Cost: one extra low-poly mesh (a single draw call, ~24×16 segments, no
 * per-frame work) and fog, which three.js already compiles into every
 * standard-material shader for free when a scene has `fog` attached —
 * negligible next to instanced buildings/houses.
 */
export function Atmosphere({ bounds }: { bounds: THREE.Box3 }) {
  const center = useMemo(() => bounds.getCenter(new THREE.Vector3()), [bounds]);
  const diagonal = useMemo(() => Math.max(bounds.getSize(new THREE.Vector3()).length(), 1), [bounds]);
  const radius = skyDomeRadius(diagonal);
  const look = useMood().look;
  const skyColors = useMemo(
    () => ({
      zenith: look.sky?.zenith ?? SKY_ZENITH_COLOR,
      horizon: look.sky?.horizon ?? SKY_HORIZON_COLOR,
      sea: look.water?.deep ?? SEA_FALLBACK_COLOR,
    }),
    [look],
  );
  // Resource-hygiene round: `SphereGeometry` constructed directly (not JSX)
  // — WE own it, so a `radius` change (the sea's own bounds growing/shrinking
  // as repositories are added, or a district focused for the screenshot
  // harness) must dispose the OLD sphere, not just drop the JS reference to
  // it. See `useDisposableMemo`'s own doc comment for the ownership rule.
  const geometry = useDisposableMemo(() => {
    const geo = new THREE.SphereGeometry(radius, 24, 16);
    const position = geo.attributes.position;
    const colors = new Float32Array(position.count * 3);
    const zenith = new THREE.Color(skyColors.zenith);
    const horizon = new THREE.Color(skyColors.horizon);
    const belowHorizon = new THREE.Color(skyColors.sea);
    const tmp = new THREE.Color();
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i) / radius; // -1..1
      // The horizon band dominates from a bit below eye level up through a
      // bit above it (an isometric camera looking down mostly sees this
      // band at the frame's far corners); the zenith colour only takes over
      // well above that.
      const t = THREE.MathUtils.clamp((y + 0.1) / 0.55, 0, 1);
      tmp.copy(horizon).lerp(zenith, t);
      // BELOW the horizon the dome is sea, not sky — scenery-craft round.
      //
      // This was introduced as a cover for the near-plane clipping defect
      // that round disclosed (a straight edge across the lower frame at full
      // zoom-out, with bare sky dome behind it). That defect is FIXED at
      // source now — see `isometricDepthRange` — and re-rendering with this
      // hemisphere painted magenta confirms none of it shows at the default
      // framing, at full zoom-out, or panned to the clamp.
      //
      // It survives because it turned out to be doing a second, honest job:
      // the water plane is finite (`Sea`'s `* 8 + 800`), and `OrbitControls`
      // lets the camera reach `maxPolarAngle` — very nearly horizontal —
      // where an orthographic frame covers tens of thousands of world units
      // of ground and genuinely runs out of water before it runs out of
      // frame. The same magenta render shows the dome's lower hemisphere
      // filling the bottom half of THAT view. A sea-toned dome makes what
      // shows there read as more sea; a sky-toned one reads as the world
      // ending. Scenery, and allowed to be decorative (README) — it encodes
      // nothing.
      const sea = THREE.MathUtils.clamp((-y - 0.02) / 0.16, 0, 1);
      tmp.lerp(belowHorizon, sea);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [radius, skyColors]);
  const fogRef = useRef<THREE.Fog>(null);
  useFrame(({ camera }) => {
    if (!fogRef.current) return;
    camera.updateMatrixWorld();
    const range = sceneFogRange(camera, bounds);
    fogRef.current.near = range.near;
    fogRef.current.far = range.far;
  });

  return (
    <>
      <fog key={skyColors.horizon} ref={fogRef} attach="fog" args={[look.sky?.horizon ?? FOG_COLOR, 1000, 2000]} />
      <mesh geometry={geometry} position={[center.x, 0, center.z]} renderOrder={-1}>
        <meshBasicMaterial vertexColors side={THREE.BackSide} depthWrite={false} fog={false} />
      </mesh>
    </>
  );
}

/**
 * Craft pass — post-processing was tried here (`@react-three/postprocessing`'s
 * `EffectComposer` with `Bloom`/`Vignette`/`Noise`) and REMOVED after a
 * coordinator review of the real rendered before/after: routing the scene
 * through `EffectComposer` at all measurably muddied and desaturated every
 * surface — not just where `Bloom`'s threshold was crossed. Isolating each
 * effect (rendered separately, not assumed) showed `Vignette` ALONE
 * reproduced almost the same desaturated, hazy look as the full three-effect
 * stack — the loss was in the composite pipeline itself (most likely the
 * ACES tone-mapping/colour-space handling `gl={{ toneMapping:
 * THREE.ACESFilmicToneMapping }}` gets on a direct `gl.render()` call not
 * surviving `EffectComposer`'s own render-to-texture passes unchanged),
 * not in any single effect's own tuning. Retuning `Bloom`'s threshold once
 * already (`0.82` -> `0.93`) had not fixed it, so per the coordinator's
 * explicit instruction this was removed outright rather than retuned again
 * — "the third time this project has traded appeal for an effect and come
 * out behind." A real emissive glow on the stopped-agent beacon specifically
 * (an emissive material or sprite on that one object, not a full-frame
 * composite pass) remains open for a future round if the author wants it.
 *
 * `@react-three/postprocessing` and `postprocessing` were removed from
 * `package.json` — nothing else in this codebase used them.
 *
 * Cinematic round: back, with the cause found and fixed rather than tuned
 * around — `EffectComposer` turns the renderer's tone mapping off, and that
 * stack had no `ToneMapping` effect to put it back. See `CinematicEffects`
 * for the fix and the before/after measurements.
 */

// ---------------------------------------------------------------------
// Camera: a static isometric orthographic view, fit to the city (or, for
// the screenshot harness only, to one focused district).
// ---------------------------------------------------------------------

function computeBounds(
  layout: CityLayout,
  model: CityModel | undefined,
  focusDistrictPath: string | undefined,
): THREE.Box3 {
  if (focusDistrictPath && model) {
    const target = layout.districts.find(
      (d) => model.districts[d.district_index]?.path === focusDistrictPath,
    );
    if (target) {
      const [cw, cd] = contentExtent(target);
      const x0 = worldUnits(target.plot.x);
      const z0 = worldUnits(target.plot.z);
      return new THREE.Box3(
        new THREE.Vector3(x0, 0, z0),
        new THREE.Vector3(x0 + worldUnits(cw), 3, z0 + worldUnits(cd)),
      );
    }
  }
  const w = Math.max(worldUnits(layout.width), 1);
  const d = Math.max(worldUnits(layout.depth), 1);
  // Frame the island, not just the town on it: most of the coast and a
  // little of its lagoon, so the default shot shows a place in the sea.
  const pad = townCoastWidth(w, d) * 0.8;
  return new THREE.Box3(new THREE.Vector3(-pad, 0, -pad), new THREE.Vector3(w + pad, 4, d + pad));
}

/**
 * Fits the camera to `bounds` AND owns the `OrbitControls` that let the
 * user move away from that fit — the author's round-3 complaint ("so i cant
 * move around and scroll and do anything? it looks very basic") is what
 * this component exists to answer. Every bound (`minZoom`/`maxZoom`, the
 * pan radius) is computed FRESH per `bounds` change, as a multiple of that
 * city's own fitted zoom/diagonal (see the constants above `CameraRig`), so
 * the same relative freedom applies whether the city is 17 districts or
 * 362.
 *
 * UPDATED (game-feel round): a window resize DOES now re-fit — see
 * `userAdjustedRef`'s own doc comment below for the full reasoning (a
 * resize before any manual pan/zoom self-corrects; a resize after one
 * leaves the user's own framing alone). The original "never re-fit on
 * resize" behaviour this comment used to describe was the direct cause of
 * a real bug (the sea "occupies maybe a third of the window" after a
 * maximize) — corrected, not merely superseded.
 */
/**
 * What `fitIsometricCamera` would set `camera.zoom` to for `bounds`,
 * WITHOUT mutating the real camera — probes on a throwaway clone, the same
 * technique `CameraRig`'s own eased reset path already uses below (and
 * `Archipelago`'s `FlightController` one level up) for exactly the same
 * reason: computing a hypothetical fit must never snap the camera that is
 * actually on screen.
 */
function computeFittedZoom(
  camera: THREE.Camera,
  size: { width: number; height: number },
  bounds: THREE.Box3,
): number {
  if (!(camera instanceof THREE.OrthographicCamera)) return 1;
  const probe = camera.clone();
  return fitIsometricCamera(probe, size, bounds);
}

/**
 * Exported so `Archipelago.tsx` (the sea-level scene) can reuse the exact
 * same fit-and-orbit rig rather than re-deriving a second camera behaviour
 * for what the brief calls "the same visual language" — this component has
 * no city-specific data in its own signature (only a bounding box), so
 * nothing about it needs to change to serve a very different-shaped `bounds`
 * (a whole sea of islands rather than one repository's districts).
 */
export function CameraRig({
  bounds,
  outerBounds,
  minZoomFactor = MIN_ZOOM_FACTOR,
  maxZoomFactor = MAX_ZOOM_FACTOR,
  controlsRef,
  onControlsReady,
  resetSignal,
  focusBounds,
  focusSequence,
  autoRotate = false,
}: {
  /** Recording mode: a slow hands-off orbit around the current target. */
  autoRotate?: boolean;
  /** What the camera actually FITS to on mount/reset — the DEFAULT framing.
   * `TownView` passes its whole city here, same as always. `Archipelago`
   * (framing round, coordinator review — "the default camera framing... is
   * the actual defect") passes a TIGHT bounds around a handful of islands,
   * not the whole sea, so the first thing the author sees is legible
   * rather than 152 islands at a couple of pixels each. */
  bounds: THREE.Box3;
  /** The FULL extent the user must still be able to reach by panning/zooming
   * OUT — defaults to `bounds` itself (every existing caller, and every
   * `TownView` call, where "fit to" and "the whole thing" are the same
   * box). `Archipelago` passes the WHOLE sea here specifically so "zoom all
   * the way out" and "pan anywhere" still reach every island even though
   * the DEFAULT framing (`bounds`) is much tighter — per the coordinator's
   * explicit instruction that the full-archipelago view "must still work...
   * it should be somewhere he goes, not where he lands." */
  outerBounds?: THREE.Box3;
  /** Explicit file/district navigation; scene bounds remain unchanged. */
  focusBounds?: THREE.Box3;
  focusSequence?: number;
  /** Multiplier on `outerBounds`'s own fitted zoom for `controls.minZoom`
   * (how far OUT the user may go) — see `MIN_ZOOM_FACTOR`'s own doc comment
   * for the reasoning; only overridden by a caller whose `outerBounds`
   * differs from `bounds`, since the constant was tuned assuming they were
   * the same box. */
  minZoomFactor?: number;
  /** Multiplier on `bounds`'s own fitted zoom for `controls.maxZoom` (how
   * far IN the user may go). `MAX_ZOOM_FACTOR` (8x) was tuned against
   * `TownView`'s "whole city" fit — applied to `Archipelago`'s much
   * TIGHTER default `bounds`, 8x would zoom in absurdly far (an untested
   * range), so `Archipelago` passes a smaller override here. */
  maxZoomFactor?: number;
  controlsRef: RefObject<OrbitControlsImpl | null>;
  onControlsReady?: (controls: OrbitControlsImpl | null) => void;
  /**
   * Bumped by the caller's own "reset view" button/key (see `TownView`'s and
   * `Archipelago`'s `resetView`) — a fresh number each time, the same
   * "sequence, not a boolean" convention `Archipelago`'s `flyToRequest.seq`
   * already uses, so pressing reset twice in a row still re-triggers even
   * though nothing else about the request changed. Re-fits EASED (see
   * `applyFit`'s `animate` argument) rather than snapping, per the
   * coordinator's "ease transitions... resetting the view" instruction.
   * Optional: a caller with no reset affordance of its own (there was none
   * before this round) simply never passes it. Re-fits to `bounds` (the
   * DEFAULT framing), never `outerBounds` — "reset view" must return to the
   * good framing, not the fitted-to-everything one.
   */
  resetSignal?: number;
}) {
  const { camera, size, invalidate } = useThree();
  // The scene's own centre/pan-radius, read by `handlePanClamp` below on
  // every orbit "change" event — refs, not state, since they must be
  // current inside a callback that fires many times per second during a
  // drag without itself triggering a re-render.
  const centerRef = useRef(new THREE.Vector3());
  const panRadiusRef = useRef(1);
  // Latest callback, read imperatively — see `useHotkey`'s `handlerRef` for
  // the same pattern. Keeps `onControlsReady` (a screenshot-harness-only,
  // often-inline prop) OUT of the fit effects' dependency arrays below: an
  // inline arrow function's identity changes every render, and those effects
  // must only re-run when the scene itself (`bounds`), the window size, or
  // an explicit reset actually changes.
  const onControlsReadyRef = useRef(onControlsReady);
  onControlsReadyRef.current = onControlsReady;
  // Whether the user has manually orbited/panned/zoomed since the last fit —
  // once true, a window resize RESCALES the existing framing instead of
  // silently discarding it (see the size-effect below); a fresh `bounds` or
  // an explicit reset both clear it, since both are "start over" moments.
  // `programmaticRef` distinguishes our OWN `controls.update()` calls (which
  // also fire drei's "change" event) from a genuine user drag — without it,
  // every fit would immediately flag itself as a "user adjustment".
  const userAdjustedRef = useRef(false);
  const programmaticRef = useRef(false);
  const animRef = useRef<{
    startPos: THREE.Vector3;
    endPos: THREE.Vector3;
    startTarget: THREE.Vector3;
    endTarget: THREE.Vector3;
    startZoom: number;
    endZoom: number;
    endMinZoom: number;
    endMaxZoom: number;
    t0: number;
  } | null>(null);

  const applyFit = useCallback(
    (animate: boolean, requestedBounds?: THREE.Box3) => {
      if (!(camera instanceof THREE.OrthographicCamera)) return;
      const controls = controlsRef.current;
      if (!controls) return;
      const fitBounds = requestedBounds ?? bounds;
      const center = fitBounds.getCenter(new THREE.Vector3());
      // Pan clamping uses `outerBounds` (the FULL extent), not `bounds` (the
      // tighter default framing) — otherwise a tight default would also
      // trap panning near it, defeating "zoom out and pan anywhere still
      // reaches the whole sea."
      const outer = outerBounds ?? bounds;
      const outerDiagonal = Math.max(outer.getSize(new THREE.Vector3()).length(), 1);
      centerRef.current.copy(center);
      panRadiusRef.current = outerDiagonal * PAN_RADIUS_FACTOR;

      if (!animate) {
        const fittedZoom = fitIsometricCamera(camera, size, fitBounds, outer);
        // `minZoom` is governed by `outerBounds`'s OWN fit (computed on a
        // throwaway clone — see the eased path's own comment below for why
        // a clone, never the real camera, does this probing) so "zoom all
        // the way out" still reaches the full sea even though the camera
        // itself just fit to the much tighter `bounds`.
        const outerZoom = computeFittedZoom(camera, size, outer);
        // Sync OrbitControls to the freshly fitted camera — without this, the
        // NEXT time `update()` runs (every rendered frame — see drei's
        // `OrbitControls`) it would recompute `camera.position` from its OWN
        // stale spherical state and silently undo the fit. `update()`
        // re-derives that spherical state from the CURRENT `camera.position`/
        // `target` every call, so calling it once, right after setting both,
        // rebases it cleanly with no visible jump.
        programmaticRef.current = true;
        controls.target.copy(center);
        controls.minZoom = outerZoom * minZoomFactor;
        controls.maxZoom = fittedZoom * maxZoomFactor;
        controls.update();
        controls.saveState();
        programmaticRef.current = false;
        onControlsReadyRef.current?.(controls);
        invalidate();
        return;
      }

      // Eased path (an explicit "reset view"): compute the fitted end state
      // on a throwaway camera clone first, so `fitIsometricCamera`'s own
      // mutation never snaps the REAL camera before the animation starts,
      // then interpolate position/target/zoom over one short `useFrame` run
      // — the same technique `Archipelago`'s `FlightController` uses for
      // flying between islands, one level up. Resets to `bounds` (the
      // DEFAULT framing) — never `outerBounds` — per the coordinator's
      // explicit "reset view must return to the good framing, not the
      // fitted one."
      const probe = camera.clone();
      const endZoom = fitIsometricCamera(probe, size, fitBounds, outer);
      const endMinZoom = computeFittedZoom(camera, size, outer) * minZoomFactor;
      animRef.current = {
        startPos: camera.position.clone(),
        endPos: probe.position.clone(),
        startTarget: controls.target.clone(),
        endTarget: center,
        startZoom: camera.zoom,
        endZoom,
        endMinZoom,
        endMaxZoom: endZoom * maxZoomFactor,
        t0: performance.now(),
      };
      invalidate();
    },
    [camera, size, bounds, outerBounds, minZoomFactor, maxZoomFactor, controlsRef, invalidate],
  );

  // The initial/data-driven fit: a fresh `bounds` (new scene, new city, new
  // sea) always fits instantly and clears `userAdjustedRef` — a genuinely
  // new thing to look at is exactly the "start over" moment `saveState`'s
  // own doc comment already describes.
  useLayoutEffect(() => {
    userAdjustedRef.current = false;
    applyFit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds]);

  // The rescue fit: re-fit whenever the actual rendered viewport size
  // changes — e.g. the window was resized (or, on some platforms, restored
  // to a remembered size shortly AFTER the webview's first paint) — but only
  // while the user hasn't yet touched the camera themselves. Without this,
  // the ORIGINAL fit (computed for whatever size existed at mount) never
  // updates, and the world can end up occupying a small fraction of a since-
  // enlarged window — exactly the "sea is small in a big empty field of pale
  // nothing" bug report. Once the user has manually adjusted the camera,
  // this intentionally stops firing (a resize must never discard a chosen
  // pan/zoom), matching `applyFit`'s handling of `bounds` above.
  useLayoutEffect(() => {
    if (userAdjustedRef.current) return;
    applyFit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  // An explicit reset (button or key): re-fit EASED, and treat it as a fresh
  // "start over" baseline the same way a new `bounds` does, so a resize
  // right after a reset still auto-corrects.
  const resetSignalRef = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === undefined || resetSignal === resetSignalRef.current) return;
    resetSignalRef.current = resetSignal;
    userAdjustedRef.current = false;
    applyFit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  const lastFocusSequence = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!focusBounds || focusSequence === undefined || focusSequence === lastFocusSequence.current) return;
    lastFocusSequence.current = focusSequence;
    userAdjustedRef.current = true;
    applyFit(true, focusBounds);
    // A focus request navigates once; resizing the dock must preserve it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBounds, focusSequence]);

  useFrame(() => {
    const anim = animRef.current;
    const controls = controlsRef.current;
    if (!anim || !controls || !(camera instanceof THREE.OrthographicCamera)) return;
    const t = Math.min(1, (performance.now() - anim.t0) / 500);
    const eased = easeInOutCubic(t);
    camera.position.lerpVectors(anim.startPos, anim.endPos, eased);
    controls.target.lerpVectors(anim.startTarget, anim.endTarget, eased);
    camera.zoom = anim.startZoom + (anim.endZoom - anim.startZoom) * eased;
    camera.updateProjectionMatrix();
    programmaticRef.current = true;
    controls.update();
    programmaticRef.current = false;
    invalidate();
    if (t >= 1) {
      animRef.current = null;
      controls.minZoom = anim.endMinZoom;
      controls.maxZoom = anim.endMaxZoom;
      controls.saveState();
      onControlsReadyRef.current?.(controls);
    }
  });

  // Bounds panning so the scene cannot be shoved off-screen entirely (the
  // coordinator's explicit instruction): if the orbit TARGET has drifted
  // further than `panRadiusRef` from the scene's own centre, pull both the
  // target and the camera back by the same correction — preserving the
  // current zoom/angle, just recentring — rather than fighting the user's
  // in-progress drag by fully re-fitting.
  const handlePanClamp = useCallback(() => {
    if (programmaticRef.current) return;
    userAdjustedRef.current = true;
    const controls = controlsRef.current;
    if (!controls) return;
    const target = controls.target;
    const dx = target.x - centerRef.current.x;
    const dz = target.z - centerRef.current.z;
    const dist = Math.hypot(dx, dz);
    const max = panRadiusRef.current;
    if (dist > max) {
      const scale = max / dist;
      const correctionX = dx - dx * scale;
      const correctionZ = dz - dz * scale;
      target.x -= correctionX;
      target.z -= correctionZ;
      camera.position.x -= correctionX;
      camera.position.z -= correctionZ;
    }
    // Redundant with drei's own `invalidate()`-on-change wiring most of the
    // time, but this handler can itself mutate the camera/target AFTER that
    // internal call already ran for this same event — cheap to call again,
    // and the one case (a clamp correction) where skipping it would ship a
    // frame that doesn't reflect the correction.
    invalidate();
  }, [camera, controlsRef, invalidate]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      autoRotate={autoRotate}
      autoRotateSpeed={0.35}
      enableDamping
      dampingFactor={0.12}
      // Never below the ground plane (never see the island from
      // underneath) and never perfectly overhead (three.js's own gimbal
      // handling gets unstable exactly at the pole) — the coordinator's
      // explicit polar-angle instruction.
      minPolarAngle={0.05}
      maxPolarAngle={Math.PI / 2 - 0.02}
      // Panning slides across the GROUND plane rather than the camera's own
      // tilted screen plane — with `screenSpacePanning` (three.js's newer
      // default) `true`, panning at this camera's steep-ish angle would
      // drift the orbit target's Y away from 0 over repeated drags, slowly
      // tilting the whole scene's apparent horizon. `false` is the correct
      // choice for an RTS/city-viewer-style camera specifically because it
      // keeps panning meaning "slide across the island," never "climb".
      screenSpacePanning={false}
      onChange={handlePanClamp}
    />
  );
}

/** Shared with `Archipelago.tsx`'s `FlightController` (island-to-island
 * flights) and `CameraRig`'s own eased reset above — one easing curve for
 * every deliberate camera move in the product, rather than a second copy
 * tuned slightly differently. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * The radius of `Atmosphere`'s sky dome, and — because the two must agree —
 * the ceiling on how far back `isometricDepthRange` may push the camera's
 * near plane. Shared rather than written twice: the dome is a `BackSide`
 * sphere with `depthWrite={false}`, so it is only ever a clean backdrop
 * while the near plane still clips its NEAR hemisphere away. Stop clipping
 * that hemisphere and its triangles start painting over the far
 * hemisphere's in arbitrary draw order, which is a much worse artifact than
 * the one the near plane is being moved to fix. One number, one place —
 * the same "the two cannot drift" rule `Water.tsx` applies to the inlined
 * coastline curve.
 */
export function skyDomeRadius(diagonal: number): number {
  return diagonal * 3 + 150;
}

/**
 * Where the orthographic camera's near and far planes belong.
 *
 * This is the honest fix for a real, previously-disclosed clipping defect
 * (`Atmosphere`'s own comment used to describe it, and painted the dome's
 * lower hemisphere sea-coloured to cover it): `fitIsometricCamera` derives
 * the camera's DISTANCE from the tight default framing, while `CameraRig`
 * derives `minZoom` from the full outer bounds. At full zoom-out the frame
 * is therefore several times wider than the camera is far from the scene,
 * and with a fixed `near = 0.1` every water pixel nearer than the camera's
 * own plane was clipped — a straight horizontal edge across the lower
 * frame, measured at 22% of a 1100x720 render.
 *
 * Enlarging the water plane cannot fix it (the clip plane is fixed in world
 * space; 1.4x, 2.2x, 4x and 8x all put the edge in the same place). The
 * near plane has to move, and for an ORTHOGRAPHIC camera it may legally go
 * negative: three.js builds the projection as a plain linear remap with no
 * division by `near`, and `Raycaster.setFromCamera` puts its ortho ray
 * origin in the plane of the camera regardless of what `near` is
 * (`projectionMatrix.elements[14]` unprojects to depth 0 for ANY near/far
 * pair), so picking is unaffected.
 *
 * Depth-buffer precision: an orthographic depth buffer is LINEAR in
 * camera-space z, so unlike a perspective camera it is the RANGE that
 * matters and not the near/far RATIO. Every term below is a real thing in
 * the scene rather than a round number, which is what keeps the range from
 * inflating:
 *
 * - `groundReach` — how far along the view axis the ground/water plane can
 *   travel inside the frame. For this camera a ground point at screen-space
 *   half-height `h` sits exactly `cot(elevation) * h` nearer or further
 *   along the view axis (the ground plane's own tilt; the screen-space
 *   HORIZONTAL axis is in the ground plane and contributes nothing), plus
 *   whatever `handlePanClamp` lets the target drift.
 * - `skyDomeRadius` — the furthest thing drawn at all.
 *
 * @param cameraDistance how far the camera sits from what it is framing
 * @param elevation the view direction's own `y` (its sine of elevation)
 * @param visibleHalfHeight half the frame's world height at the most
 *   zoomed-out state `CameraRig` allows
 * @param sceneDiagonal the FULL scene's diagonal (`outerBounds`), which is
 *   what the sky dome, the water plane and the pan clamp all size against
 * @param focusOffset distance from what the camera frames to that full
 *   scene's own centre
 */
export function isometricDepthRange({
  cameraDistance,
  elevation,
  visibleHalfHeight,
  sceneDiagonal,
  focusOffset,
}: {
  cameraDistance: number;
  elevation: number;
  visibleHalfHeight: number;
  sceneDiagonal: number;
  focusOffset: number;
}): { near: number; far: number } {
  const horizontal = Math.sqrt(Math.max(0, 1 - elevation * elevation));
  const cot = horizontal / Math.max(elevation, 1e-6);
  const groundReach = cot * visibleHalfHeight + sceneDiagonal * PAN_RADIUS_FACTOR * horizontal;
  const margin = sceneDiagonal * 0.25 + 50;
  const domeRadius = skyDomeRadius(sceneDiagonal);
  // `focusOffset` applies to BOTH terms: the water plane and the dome are
  // centred on the full scene, and the camera is looking at something that
  // may sit a long way off that centre, so either can be that much further
  // along the view axis than its own radius alone suggests. (Left off the
  // dome term first, and the unit test below caught the far plane landing
  // 15 units INSIDE the dome on the real sea's numbers.)
  const reach = Math.max(groundReach, domeRadius) + focusOffset + margin;
  return {
    // Never past the dome — see `skyDomeRadius`'s own doc comment. `0.9`
    // leaves its near hemisphere genuinely clipped rather than exactly
    // grazing the plane.
    near: cameraDistance - Math.min(groundReach + focusOffset + margin, domeRadius * 0.9),
    far: cameraDistance + reach,
  };
}

/** Exported for `Archipelago.tsx` — see `CameraRig`'s doc comment for why
 * sharing this (rather than a second copy tuned separately) is the point.
 *
 * `depthBounds` is the FULL scene (`CameraRig`'s `outerBounds`) when that
 * differs from what is being framed; the near/far planes must cover
 * everything the user can ever zoom out or pan to, not just the default
 * framing. See `isometricDepthRange`. */
export function fitIsometricCamera(
  camera: THREE.OrthographicCamera,
  size: { width: number; height: number },
  bounds: THREE.Box3,
  depthBounds?: THREE.Box3,
): number {
  const center = bounds.getCenter(new THREE.Vector3());
  const diagonal = Math.max(bounds.getSize(new THREE.Vector3()).length(), 1);
  // Lowered from the previous (1, 1.15, 1) — ~39° above the horizon — to a
  // more oblique ~30°. The author's complaint was that you saw roofs and
  // almost no facade: an orthographic camera's FRAMING doesn't depend on distance,
  // only on this angle, so lowering it is the one knob that actually shows
  // more wall.
  const direction = new THREE.Vector3(1, 0.82, 1).normalize();
  const distance = diagonal * 2 + 20;

  camera.position.copy(center.clone().add(direction.clone().multiplyScalar(distance)));
  camera.up.set(0, 1, 0);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

  const fitted = fittedZoomForBox(camera, size, bounds);

  // near/far are a property of the whole SCENE, not of whatever is framed
  // right now — an orthographic camera's frame can be far wider than its
  // own distance from what it looks at. See `isometricDepthRange`.
  const outer = depthBounds ?? bounds;
  // The projected extent of a box does not depend on where along the view
  // axis the camera sits (that is what orthographic means), only on the
  // view basis — which `bounds` and `outer` share — so this is exactly the
  // zoom `computeFittedZoom(camera, size, outer)` returns, with no second
  // camera clone.
  const outerFitted = fittedZoomForBox(camera, size, outer);
  const { near, far } = isometricDepthRange({
    cameraDistance: distance,
    elevation: direction.y,
    visibleHalfHeight:
      size.height > 0 ? size.height / 2 / Math.max(outerFitted * MIN_ZOOM_FACTOR, 1e-6) : 0,
    sceneDiagonal: Math.max(outer.getSize(new THREE.Vector3()).length(), 1),
    focusOffset: center.distanceTo(outer.getCenter(new THREE.Vector3())),
  });
  camera.near = near;
  camera.far = far;

  camera.zoom = fitted;
  camera.updateProjectionMatrix();
  return camera.zoom;
}

/** The zoom at which `box` exactly fills `size`, for a camera whose view
 * basis (`matrixWorldInverse`) is already up to date. */
function fittedZoomForBox(
  camera: THREE.OrthographicCamera,
  size: { width: number; height: number },
  box: THREE.Box3,
): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const v = new THREE.Vector3();
  for (const corner of boxCorners(box)) {
    v.copy(corner).applyMatrix4(camera.matrixWorldInverse);
    minX = Math.min(minX, v.x);
    maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }

  // Tightened from 1.18: the author's other complaint was the island
  // "floats in a sea of empty water" — this fits the frame closer to the
  // land itself, with just enough margin that nothing at the coastline is
  // ever clipped.
  const PADDING = 1.08;
  const neededWidth = Math.max((maxX - minX) * PADDING, 0.001);
  const neededHeight = Math.max((maxY - minY) * PADDING, 0.001);
  const zoomX = size.width > 0 ? size.width / neededWidth : 1;
  const zoomY = size.height > 0 ? size.height / neededHeight : 1;
  return Math.max(0.001, Math.min(zoomX, zoomY));
}

function boxCorners(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

// ---------------------------------------------------------------------
// Ground + district pads + roads/walls — all honest renderings of data the
// model/layout already computed, never a decoration invented for looks
// (design inputs §3: "no filler trees in empty plots, no invented harbour").
// ---------------------------------------------------------------------

/** How high the town's own ground mound rises at its centre, and how far it
 * dips (never below 0 — see `safeDomeHeight`) toward its edges. Kept small
 * and constant, well under the smallest real building's own height
 * (`buildingWorldHeight`'s `HEIGHT_BASE_FRAC * gridPitch`, at minimum
 * `0.85 * gridPitch`): art-direction round's own constraint, "terrain
 * height must never read as a building" — the two also read as
 * categorically different SHAPES (a smooth dome vs. cream walls + a
 * coloured roof), which matters at least as much as the raw number. */
const TOWN_MOUND_HEIGHT = 0.32;

/**
 * The land the city sits on, plus the water around it. Art-direction round:
 * the land is now a gently domed, vertex-coloured mesh (item 3 — "islands
 * need elevation... a beach sloping into the water") instead of a flat box,
 * and the water gets a real shallow-to-deep gradient plus gentle animated
 * waves (item 2) instead of two flat colours. Both are still honest scenery
 * (design inputs §3): the ground's extent is derived entirely from
 * `layout.width`/`depth`, and — unlike `Archipelago`'s synthetic sea
 * islands — this mesh uses the SAFE dome (`safeDomeHeight`, never seeded,
 * never able to imply a point is "underwater"), because every vertex here
 * sits under REAL building positions this repository's own layout put
 * there. The organic coastline RECESSION item 4 asks for is deliberately
 * scoped to `Archipelago`'s synthetic islands only — see that file's own
 * comment on `SeaIslandGroup`'s terrain for the full reasoning.
 */
/**
 * Item 5: decorative trees/rocks scattered across the town's own unbuilt
 * ground — the real district plots (the SAME rectangles `DistrictPad`
 * already draws, not a re-derived approximation) are the exclusion zones,
 * so vegetation only ever grows in genuinely empty land between/around
 * them, never through a building or a district's own paved plot.
 */
// Cost-of-hover round (Item 2): wrapped in `React.memo` — `layout`/`model`
// only ever change identity when the town's own `cityView` prop changes
// (a real refetch), never on a hover-driven `TownView` re-render, so a
// stable-props re-render can bail here entirely instead of re-walking every
// district's `contentExtent` for nothing.
function TownVegetationImpl({ layout, model }: { layout: CityLayout; model: CityModel }) {
  const w = Math.max(worldUnits(layout.width), 1);
  const d = Math.max(worldUnits(layout.depth), 1);
  const exclusions = useMemo(
    () =>
      layout.districts.map((district) => {
        const [cw, cd] = contentExtent(district);
        const dw = worldUnits(cw);
        const dd = worldUnits(cd);
        const x0 = worldUnits(district.plot.x);
        const z0 = worldUnits(district.plot.z);
        // A circle covering the district's own rectangle (radius = half its
        // diagonal) — a slight over-exclusion at the corners, never an
        // under-exclusion, which is the safe direction to round to since
        // the goal is "never through a real building," not "pack every
        // last inch of empty land."
        return { x: x0 + dw / 2, z: z0 + dd / 2, radius: Math.hypot(dw, dd) / 2 };
      }),
    [layout],
  );
  const heightAt = useMemo(() => (u: number, v: number) => safeDomeHeight(u, v, TOWN_MOUND_HEIGHT), []);
  // The coast's meadow gets trees and rocks too — the same scatter, masked
  // to the band of grass between the town's edge and the beach.
  const { margin, spanX, spanZ } = useMemo(() => coastExtent(w, d), [w, d]);
  const toWorld = useCallback((u: number, v: number) => ({ x: ((u + 1) * spanX) / 2 - margin, z: ((v + 1) * spanZ) / 2 - margin }), [spanX, spanZ, margin]);
  const coastHeightAt = useCallback((u: number, v: number) => {
    const { x, z } = toWorld(u, v);
    return coastHeight(coastTAt(x, z, w, d), GROUND_THICKNESS, coastSwell(x, z, w, d));
  }, [toWorld, w, d]);
  const meadowAt = useCallback((u: number, v: number) => {
    const { x, z } = toWorld(u, v);
    const t = coastTAt(x, z, w, d);
    return t > 0.1 && t < 0.46 ? 1 : 0;
  }, [toWorld, w, d]);
  return (
    <>
      <Vegetation identity={model.root} width={w} depth={d} heightAt={heightAt} exclusions={exclusions} />
      <group position={[-margin, 0, -margin]}>
        <Vegetation identity={`${model.root}#coast`} width={spanX} depth={spanZ} heightAt={coastHeightAt} landMaskAt={meadowAt} />
      </group>
    </>
  );
}
// Exported for `TownView.test.ts` (same convention as `buildKindBuckets`/
// `clampTooltipPosition` above): lets the resource-hygiene round's test
// confirm these are actually memoised, without mounting a real r3f scene.
export const TownVegetation = memo(TownVegetationImpl);

// Cost-of-hover round (Item 2): same reasoning as `TownVegetation` above —
// `layout` alone drives every geometry/material here, and stays referentially
// stable across a hover-only re-render.
function GroundImpl({ layout }: { layout: CityLayout }) {
  const waterColors = useMood().look.water ?? WATER_COLORS;
  const w = Math.max(worldUnits(layout.width), 1);
  const d = Math.max(worldUnits(layout.depth), 1);
  // How far the shallows reach past the town's own ground rectangle. The
  // shelf is drawn per pixel by `Water.tsx`'s `TownShallows`, so this is a
  // real world-space width rather than a mesh size to tessellate.
  // A wide, lagoon-like shelf: the turquoise shallows with light playing
  // across them are most of what makes the town's water read as water.
  const shelfWidth = Math.max(Math.min(w, d) * 0.26, 4.0);
  // Scenery-craft round, `9 + 400` up from `1.6 + 24`: at the town's own
  // default framing the old plane's far corner fell INSIDE the frame, so a
  // wedge of bare sky dome showed through at the bottom-right — visible in
  // this round's "before" render — and zooming out reached past its edge
  // entirely. Sized to clear both. Free, now that the plane is four vertices
  // rather than 841.
  const waterSize = Math.max(w, d) * 9 + 400;

  // Resource-hygiene round: both constructed directly (`terrainGeometry.ts`/
  // `Water.ts`), so WE own them — disposed on every genuine `w`/`d` change
  // (a repository's real size changing) and on unmount, via
  // `useDisposableMemo`.
  const groundGeometry = useDisposableMemo(
    () =>
      buildSafeGroundGeometry({
        width: w,
        depth: d,
        moundHeight: TOWN_MOUND_HEIGHT,
        landColor: GROUND_COLOR,
        sandColor: SAND_COLOR,
        wetSandColor: WET_SAND_COLOR,
        shadeColor: GRASS_SHADE_COLOR,
        lightColor: GRASS_LIGHT_COLOR,
        beachAtEdge: false,
      }),
    [w, d],
  );
  // The land around the town — meadow, beach, slope into the lagoon — so the
  // town sits on an island instead of a board (see `townCoast.ts`).
  const coast = townCoastWidth(w, d);
  const coastT = coastWaterlineT(GROUND_THICKNESS, -GROUND_THICKNESS - 0.05);
  // Three boats working the lagoon, each on its own lane between the widest
  // the coast ever reaches and the lagoon's outer edge (see `Boats.tsx`).
  const boatRoutes = useMemo<BoatRoute[]>(() => {
    const clear = coast * coastT * 1.6;
    const size = Math.max(2, Math.min(w, d) * 0.05);
    return [0.3, 0.55, 0.8].map((lane, i) => {
      const rx = w / 2 + clear + shelfWidth * lane;
      const rz = d / 2 + clear + shelfWidth * lane;
      return { cx: w / 2, cz: d / 2, rx, rz, speed: (i % 2 ? -1 : 1) * (1.1 / Math.max(rx, rz)), phase: i * 2.1, size };
    });
  }, [w, d, coast, coastT, shelfWidth]);
  const coastGeometry = useDisposableMemo(
    () =>
      buildTownCoastGeometry({
        width: w,
        depth: d,
        groundThickness: GROUND_THICKNESS,
        colors: { grass: GROUND_COLOR, grassShade: GRASS_SHADE_COLOR, sand: SAND_COLOR, wetSand: WET_SAND_COLOR, seabed: WATER_SANDY_COLOR },
      }),
    [w, d],
  );

  return (
    <group>
      {/* The domed top — height 0 (at/past the edge) to `TOWN_MOUND_HEIGHT`
          (at the centre), sitting ABOVE y=0 so it never sinks the ground
          below the level every building's own base assumes. */}
      <mesh geometry={groundGeometry} receiveShadow castShadow>
        <meshStandardMaterial vertexColors roughness={1} />
      </mesh>
      <mesh geometry={coastGeometry} receiveShadow>
        <meshStandardMaterial vertexColors roughness={1} />
      </mesh>
      {/* The vertical "cliff" face beneath the domed top, from y=0 down to
          the water — kept as a plain box so the coastline still reads as a
          real drop to the water, not a mesh floating with no visible
          thickness. */}
      {/* Scenery-craft round: the cliff is the ROCK under the turf, not more
          grass painted vertically — an identically-coloured side face is
          what made the town read as a rug rather than a piece of land. */}
      <mesh position={[w / 2, -GROUND_THICKNESS / 2, d / 2]}>
        <boxGeometry args={[w, GROUND_THICKNESS, d]} />
        <meshStandardMaterial color={CLIFF_COLOR} roughness={1} />
      </mesh>
      {/* The open sea, then the town's own shallows laid over it — see
          `Water.tsx` for why both are one shader and why the shelf's alpha
          reaching zero before its quad's edge is the thing that makes the
          two impossible to see a seam between. */}
      <OpenWater
        center={{ x: w / 2, z: d / 2 }}
        y={-GROUND_THICKNESS - 0.06}
        size={waterSize}
        colors={waterColors}
      />
      <group position={[w / 2, 0, d / 2]}>
        <TownShallows
          width={w}
          depth={d}
          shelfWidth={shelfWidth}
          coast={coast}
          coastT={coastT}
          y={-GROUND_THICKNESS - 0.04}
          colors={waterColors}
        />
      </group>
      <SailingBoats routes={boatRoutes} waterY={-GROUND_THICKNESS - 0.03} />
    </group>
  );
}
export const Ground = memo(GroundImpl);

/**
 * A thin pad at the district's CONTENT extent (`contentExtent`), never its
 * reserved headroom — see that function's doc comment.
 *
 * Clickable since the actions-UI round (Item 5): a click that misses every
 * building on this pad selects the DISTRICT instead, offering "reveal in
 * Finder" for its own directory (`DistrictPanel`). A building's own click
 * handler calls `stopPropagation()` and renders on top of this pad, so
 * clicking a building still selects the building, never the district
 * underneath it — this only ever fires for empty pad area.
 *
 * Cost-of-hover round (Item 2 of the resource-hygiene report): wrapped in
 * `React.memo` below. `contentExtent` was already memoised per-district
 * (the Opus frontend review comment right below), which stops THIS
 * component's own work from repeating — but before this round, `TownView`'s
 * hover state changing (a pointer move over any building, anywhere) still
 * re-invoked every `DistrictPad`'s function body across the whole town, one
 * per district, on every single mouse move. `React.memo` needs stable props
 * to bail on, which `onSelect` was NOT until `TownView` hoisted
 * `handleDistrictSelect` out of an inline JSX closure (see its own doc
 * comment) — `district`/`model` were already stable (both come straight
 * from `layout`/`model`, unaffected by hover).
 */
function DistrictPadImpl({
  district,
  model,
  onSelect,
}: {
  district: PlacedDistrict;
  model: CityModel;
  onSelect: (info: SelectedDistrictInfo) => void;
}) {
  // Minor (Opus frontend review): `contentExtent` walks every building in
  // this district (up to ~1,064 total across a town) — memoised so a
  // re-render this component doesn't own the reason for (a parent prop
  // change unrelated to this district's own data) doesn't re-walk it.
  const [cw, cd] = useMemo(() => contentExtent(district), [district]);
  const w = worldUnits(cw);
  const d = worldUnits(cd);
  const x = worldUnits(district.plot.x) + w / 2;
  const z = worldUnits(district.plot.z) + d / 2;
  const modelDistrict = model.districts[district.district_index];

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (!modelDistrict) return;
    onSelect({
      name: modelDistrict.name,
      path: modelDistrict.path,
      buildingCount: modelDistrict.buildings.length,
    });
  };

  return (
    <mesh position={[x, 0.01, z]} receiveShadow onClick={handleClick}>
      <boxGeometry args={[w, 0.02, d]} />
      <meshStandardMaterial color={PLOT_FILL} roughness={1} />
    </mesh>
  );
}
export const DistrictPad = memo(DistrictPadImpl);

/**
 * `PlacedDistrict.road_edges` — the plot's own perimeter cells, already
 * computed by `city::layout::boundary_cells` — drawn as paved street tiles
 * bordering every district, and, for walled districts, an additional taller
 * strip along the same cells. This is Task 6's answer to the SVG preview's
 * "street hierarchy under-delivers" critique that a 3D view can attack for
 * free (design inputs §2): real, already-computed boundary data, never a
 * fabricated avenue.
 *
 * Cost-of-hover round (Item 2): wrapped in `React.memo` — `model`/`layout`
 * are the same stable references every other memoised child here relies on,
 * so a hover-only `TownView` re-render bails before re-walking every
 * district's `road_edges`.
 */
function RoadNetworkImpl({ model, layout }: { model: CityModel; layout: CityLayout }) {
  const cells = useMemo(() => {
    const all: { x: number; z: number; walled: boolean }[] = [];
    for (const district of layout.districts) {
      const modelDistrict = model.districts[district.district_index];
      // `layout.rs` guarantees every `district_index` resolves — this is
      // dead code today. It stays loud rather than a silent `?? false`
      // fallback specifically because "a real district silently renders
      // wrong" is the exact failure shape this project has been bitten by
      // four times before in other guises (coordinator review, round 3):
      // a future model/layout change that ever violates the guarantee must
      // announce itself, not quietly draw an unwalled road where a walled
      // one belongs.
      if (!modelDistrict) {
        console.warn(
          `TownView: PlacedDistrict.district_index ${district.district_index} has no matching CityModel district — its road_edges will render as unwalled.`,
        );
      }
      const walled = modelDistrict?.walled ?? false;
      for (const [x, z] of district.road_edges) all.push({ x, z, walled });
    }
    return all;
  }, [model, layout]);
  const wallCells = useMemo(() => cells.filter((c) => c.walled), [cells]);
  // A walled district is ringed by a real wall: a short post on every walled
  // cell, joined to each walled neighbour by a thin, low run of wall. (One
  // solid block per cell read as a row of red paving slabs.)
  const wallPieces = useMemo(() => {
    const walled = new Set(wallCells.map((c) => `${c.x},${c.z}`));
    const pieces: { x: number; z: number; sx: number; sy: number; sz: number }[] = [];
    for (const c of wallCells) {
      pieces.push({ x: cellCenter(c.x), z: cellCenter(c.z), sx: 0.26, sy: 0.46, sz: 0.26 });
      if (walled.has(`${c.x + 1},${c.z}`)) pieces.push({ x: (cellCenter(c.x) + cellCenter(c.x + 1)) / 2, z: cellCenter(c.z), sx: cellCenter(c.x + 1) - cellCenter(c.x), sy: 0.3, sz: 0.14 });
      if (walled.has(`${c.x},${c.z + 1}`)) pieces.push({ x: cellCenter(c.x), z: (cellCenter(c.z) + cellCenter(c.z + 1)) / 2, sx: 0.14, sy: 0.3, sz: cellCenter(c.z + 1) - cellCenter(c.z) });
    }
    return pieces;
  }, [wallCells]);

  const roadRef = useRef<THREE.InstancedMesh>(null);
  const wallRef = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D();
    const road = roadRef.current;
    if (road) {
      cells.forEach((cell, i) => {
        dummy.position.set(cellCenter(cell.x), 0.015, cellCenter(cell.z));
        dummy.rotation.set(0, 0, 0);
        // A full, ungapped cell (see `ROAD_WIDTH_FRAC`'s doc comment for why
        // narrower used to be here, and why that read as a checkerboard for
        // a sparsely-populated district).
        dummy.scale.set(ROAD_WIDTH_FRAC, 0.03, ROAD_WIDTH_FRAC);
        dummy.updateMatrix();
        road.setMatrixAt(i, dummy.matrix);
      });
      road.instanceMatrix.needsUpdate = true;
    }
    const wall = wallRef.current;
    if (wall) {
      wallPieces.forEach((piece, i) => {
        dummy.position.set(piece.x, 0.03 + piece.sy / 2, piece.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(piece.sx, piece.sy, piece.sz);
        dummy.updateMatrix();
        wall.setMatrixAt(i, dummy.matrix);
      });
      wall.instanceMatrix.needsUpdate = true;
    }
  }, [cells, wallPieces]);

  return (
    <>
      {cells.length > 0 && (
        <instancedMesh ref={roadRef} args={[undefined, undefined, cells.length]} receiveShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color={ROAD_COLOR} roughness={1} />
        </instancedMesh>
      )}
      {wallPieces.length > 0 && (
        <instancedMesh
          key={wallPieces.length}
          ref={wallRef}
          args={[undefined, undefined, wallPieces.length]}
          castShadow
          receiveShadow
        >
          {/* Craft pass, item 1: the district's own brick boundary wall is a
              real wall, not decorative dressing — bevelled for the same
              reason the buildings are (see `bevelGeometry.ts`). Road tiles
              just above are deliberately left as a plain box: at
              `ROAD_WIDTH_FRAC`'s thin 0.03-unit height, a chamfer sized for
              a building would read as an odd bevelled paver rather than a
              flat road surface. */}
          <primitive object={buildingWallGeometry()} attach="geometry" />
          <meshStandardMaterial color={WALL_COLOR} roughness={0.85} flatShading />
        </instancedMesh>
      )}
    </>
  );
}
export const RoadNetwork = memo(RoadNetworkImpl);

// ---------------------------------------------------------------------
// Villagers: the agents actually working in this repository, standing in
// its town (town-villagers round). The sea's own villagers are fixed-size
// `Html` DOM markers specifically because a 3D figure shrinks to
// unclickable sub-pixels once the camera pulls back far enough to see the
// WHOLE sea (up to 152 islands at once). The town's camera never does
// that: it always fits to exactly ONE city, and the furthest the user may
// zoom out is `MIN_ZOOM_FACTOR` (0.5×) of that single fit — the same order
// of magnitude a real building already renders at, and a real building's
// own `instancedMesh` raycasts and clicks correctly at every zoom level
// this view allows (that's the existing building-selection feature, not a
// new claim). So a REAL 3D low-poly figure is viable here where it wasn't
// in the sea, and it costs nothing extra: the number of villagers in one
// town is bounded by how many agents are actually live in that repository
// (single digits in practice, never anything close to a building count),
// so this renders one small, un-instanced group per agent rather than
// needing `BuildingInstances`'s per-kind batching at all.
//
// Idle motion reuses `Water.tsx`'s own pattern (see that module's
// doc comment): a plain `useFrame` with no explicit `invalidate()` call, so
// it only ever actually animates while `frameloop="always"` — which
// `TownScreen` (`App.tsx`) already ties to `useWindowFocused()`. No second
// animation system, no new focus-gating logic.
// ---------------------------------------------------------------------

/** How tall a villager's body is, and how large its head, as a fraction of
 * the layout's own grid pitch — expressed the same relative way
 * `buildingFootprint`/`buildingWorldHeight` are, so the figure scales with
 * whatever pitch a layout actually uses. Sized to stay well under the
 * shortest real building (`buildingWorldHeight(1, gridPitch)` is
 * `0.85 * gridPitch`) at every height bucket, so a villager can never be
 * mistaken for architecture. */
const VILLAGER_BODY_HEIGHT_FRAC = 0.34;
const VILLAGER_HEAD_RADIUS_FRAC = 0.11;
const VILLAGER_BODY_TOP_RADIUS_FRAC = 0.1;
const VILLAGER_BODY_BOTTOM_RADIUS_FRAC = 0.14;
/** Idle bob amplitude/speed — small on purpose (mirrors the sea's own
 * `.villager-marker` CSS bob, which the coordinator explicitly kept subtle
 * so it "never competes with the stopped-island beacon... for the eye"; the
 * town has no beacon, but the same "gentle, not distracting" bar applies to
 * every building's own stillness). */
const VILLAGER_BOB_AMPLITUDE_FRAC = 0.035;
const VILLAGER_BOB_SPEED = 2.4;

/**
 * Standing spots for every agent in `agents`, deterministic from each one's
 * own `pane_id` (never re-derived per render in a way that could reorder) —
 * `townVillagerSlots` (`../city`) supplies the candidate street cells, honest
 * and building-free by construction (see its own doc comment), and
 * `assignVillagerPositions` (shared with `Archipelago.tsx` — not a second
 * implementation) turns that candidate list plus this exact agent set into a
 * stable per-agent choice.
 */
function useVillagerPositions(
  agents: Agent[],
  model: CityModel,
  layout: CityLayout,
): Map<string, { x: number; z: number }> {
  return useMemo(() => {
    if (agents.length === 0) return new Map();
    return assignVillagerPositions(agents, townVillagerSlots(model, layout));
  }, [agents, model, layout]);
}

function TownVillagers({
  agents,
  model,
  layout,
  gridPitch,
  selectedPaneId,
  onSelect,
  onHoverChange,
}: {
  agents: Agent[];
  model: CityModel;
  layout: CityLayout;
  gridPitch: number;
  selectedPaneId: string | null;
  onSelect: (agent: Agent) => void;
  onHoverChange: (hovered: boolean) => void;
}) {
  const positions = useVillagerPositions(agents, model, layout);
  if (agents.length === 0) return null;
  return (
    <>
      {agents.map((agent) => {
        const pos = positions.get(agent.pane_id);
        if (!pos) return null;
        return (
          <TownVillager
            key={agent.pane_id}
            agent={agent}
            x={pos.x}
            z={pos.z}
            gridPitch={gridPitch}
            selected={agent.pane_id === selectedPaneId}
            onSelect={onSelect}
            onHoverChange={onHoverChange}
          />
        );
      })}
    </>
  );
}

/**
 * One villager: a cream cylinder "body" (the same `WALL_BASE_COLOR` every
 * building's own wall uses — a villager belongs to the same town, made of
 * the same material) topped by a small sphere "head" carrying its OWN
 * attention colour (`ATTENTION_COLOR`) — the exact "the coloured part
 * carries the meaning, the rest is neutral" grammar `BuildingInstances`
 * already uses (cream wall, coloured roof), reapplied to a person instead of
 * a house.
 */
function TownVillager({
  agent,
  x,
  z,
  gridPitch,
  selected,
  onSelect,
  onHoverChange,
}: {
  agent: Agent;
  x: number;
  z: number;
  gridPitch: number;
  selected: boolean;
  onSelect: (agent: Agent) => void;
  onHoverChange: (hovered: boolean) => void;
}) {
  const bobRef = useRef<THREE.Group>(null);
  // A phase offset per agent (from its own `pane_id`, the same "function of
  // real identity, never randomised" rule `tintFor`/`formFor` already
  // follow) so multiple villagers in one town don't bob in lockstep.
  const phase = useMemo(() => ((hashString(agent.pane_id) % 1000) / 1000) * Math.PI * 2, [agent.pane_id]);
  const bodyHeight = gridPitch * VILLAGER_BODY_HEIGHT_FRAC;
  const headRadius = gridPitch * VILLAGER_HEAD_RADIUS_FRAC;
  const bobAmplitude = gridPitch * VILLAGER_BOB_AMPLITUDE_FRAC;

  useFrame(({ clock }) => {
    const group = bobRef.current;
    if (!group) return;
    group.position.y = Math.sin(clock.elapsedTime * VILLAGER_BOB_SPEED + phase) * bobAmplitude;
  });

  const color = ATTENTION_COLOR[agent.attention];

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onSelect(agent);
  };
  const handlePointerOver = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onHoverChange(true);
  };
  const handlePointerOut = () => onHoverChange(false);

  return (
    <group position={[x, 0, z]}>
      <group ref={bobRef}>
        <mesh
          position={[0, bodyHeight / 2, 0]}
          onClick={handleClick}
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
          castShadow
          receiveShadow
        >
          <cylinderGeometry
            args={[gridPitch * VILLAGER_BODY_TOP_RADIUS_FRAC, gridPitch * VILLAGER_BODY_BOTTOM_RADIUS_FRAC, bodyHeight, 8]}
          />
          <meshStandardMaterial color={WALL_BASE_COLOR} roughness={0.85} metalness={0.04} />
        </mesh>
        <mesh
          position={[0, bodyHeight + headRadius * 0.85, 0]}
          onClick={handleClick}
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
          castShadow
        >
          <sphereGeometry args={[headRadius, 12, 10]} />
          <meshStandardMaterial color={color} roughness={0.6} />
        </mesh>
        {/* A selected villager gets the SAME ground-ring treatment a
            selected building's edge highlight gives (`SELECTION_COLOR`) —
            one selection colour, one meaning, everywhere it appears. */}
        {selected && (
          <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[gridPitch * 0.22, gridPitch * 0.3, 24]} />
            <meshBasicMaterial color={SELECTION_COLOR} transparent opacity={0.55} toneMapped={false} />
          </mesh>
        )}
        <AgentBadge agent={agent} y={bodyHeight + headRadius * 2 + gridPitch * 0.12} onSelect={onSelect} />
      </group>
    </group>
  );
}

/** Caps so a sweeping change (a formatter over the whole repo) builds a
 * busy town, not a solid wall of scaffolding. */
const MAX_SCAFFOLDS = 60;
const MAX_SMOKING_CHIMNEYS = 36;

/** How long a "+N" label stays over its building. */
const GROWTH_LABEL_MS = 3200;

/**
 * "+42" over a building whose file just grew by 42 real lines (and "−10"
 * for one that shrank) — the visible trace of an agent's edit even when the
 * edit is too small to move the building across a height bucket. Numbers
 * only, so these stay in recording mode. Remounted (via `key`) for each new
 * measurement, so every batch rises and fades on its own.
 */
function GrowthLabels({ deltas, buckets }: { deltas: TownGrowth["deltas"]; buckets: Record<BuildingKind, KindBucket> }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), GROWTH_LABEL_MS);
    return () => clearTimeout(timer);
  }, []);
  const byPath = useMemo(() => {
    const map = new Map<string, BuildingTransform>();
    for (const bucket of Object.values(buckets)) bucket.metas.forEach((meta, i) => map.set(meta.path, bucket.transforms[i]));
    return map;
  }, [buckets]);
  if (!visible) return null;
  return (
    <>
      {deltas.map(({ path, delta, isNew }) => {
        const t = byPath.get(path);
        if (!t) return null;
        return (
          <Html key={path} position={[t.x, t.height + t.footprint * t.roofPitch + 0.2, t.z]} center zIndexRange={[15, 0]} style={{ pointerEvents: "none" }}>
            <span className={`growth-label growth-label--${delta >= 0 ? "up" : "down"}`}>
              {delta >= 0 ? "+" : "−"}{Math.abs(delta)}{isNew ? " new" : ""}
            </span>
          </Html>
        );
      })}
    </>
  );
}

/**
 * The villager's state and task, readable at any zoom: Herdr's dot (orange
 * working, green done, hollow green seen) beside the task name Herdr reports
 * as the pane's title. Screen-space, so it never shrinks to nothing when the
 * camera pulls back the way the villager's own coloured head does.
 */
function AgentBadge({ agent, y, onSelect }: { agent: Agent; y: number; onSelect: (agent: Agent) => void }) {
  // Recording mode keeps the dot and drops the words — a task title can name
  // a client (see `recording.tsx`).
  const recording = useRecording();
  const label = recording ? null : taskLabel(agent.title);
  return (
    <Html position={[0, y, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: "auto" }}>
      <button
        type="button"
        className={`town-agent-badge town-agent-badge--${agent.attention}`}
        title={agent.title ? `${agent.title} — ${ATTENTION_LABEL[agent.attention]}` : ATTENTION_LABEL[agent.attention]}
        aria-label={`${label ?? agent.pane_id}: ${ATTENTION_LABEL[agent.attention]}`}
        onClick={(event) => { event.stopPropagation(); onSelect(agent); }}
      >
        <i className={`agent-status-dot agent-status-dot--${agent.attention}`} />
        {label && <span>{label}</span>}
      </button>
    </Html>
  );
}

/**
 * The sea's island glow, in the water around the town: orange and slow
 * while an agent here works, green and pulsing while one waits for you.
 * Starts just outside the ground's own half-diagonal, like `StoppedHalo`, so
 * it never shares a point with the land and needs no depth tricks.
 */
function TownAttentionGlow({ layout, attention }: { layout: CityLayout; attention: Exclude<Attention, "quiet" | "unknown"> }) {
  const ref = useRef<THREE.Mesh>(null);
  const w = Math.max(worldUnits(layout.width), 1);
  const d = Math.max(worldUnits(layout.depth), 1);
  const halfDiagonal = Math.hypot(w / 2, d / 2);
  // Out past the coast and the lagoon, so the glow rings the island rather
  // than tinting its shallows.
  const inner = halfDiagonal + townCoastWidth(w, d) * 0.9 + Math.max(Math.min(w, d) * 0.26, 4) * 0.8;
  const outer = inner + Math.max(w, d) * (attention === "stopped" ? 0.2 : 0.12) + 2;
  const rim = Math.min(inner + Math.max(0.6, halfDiagonal * 0.06), outer);
  const geometry = useDisposableMemo(() => buildAttentionHaloGeometry({ inner, rim, outer }), [inner, rim, outer]);
  const [base, swing, speed] = attention === "stopped" ? [0.5, 0.12, 2.2] : [0.3, 0.08, 1.1];
  // No `invalidate()` — see `ChangeMarkers`.
  useFrame(({ clock }) => {
    const material = ref.current?.material as THREE.MeshBasicMaterial | undefined;
    if (material) material.opacity = base + Math.sin(clock.elapsedTime * speed) * swing;
  });
  return (
    <mesh ref={ref} geometry={geometry} position={[w / 2, -GROUND_THICKNESS - 0.03, d / 2]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={5} raycast={() => {}}>
      <meshBasicMaterial color={ATTENTION_COLOR[attention]} vertexColors transparent opacity={base} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

// ---------------------------------------------------------------------
// Buildings: one instancedMesh per BuildingKind for the WALLS (a uniform
// cream colour, only lightly tinted — see `WALL_BASE_COLOR`), plus a thin
// hipped-roof cap per instance that carries the kind's actual colour. This
// is the inversion the visual-overhaul pass made on purpose: kind is still
// fully encoded, but on the roof, not the wall (see that constant's doc
// comment for why).
// ---------------------------------------------------------------------

/** Exported for `TownView.test.ts`: `buildKindBuckets` is pure (no
 * React/WebGL) and is the direct target of the height-purity regression
 * test for Critical 1 (Opus frontend review). */
export type BuildingTransform = {
  x: number;
  z: number;
  height: number;
  footprint: number;
  tint: number;
  roofPitch: number;
  hasChimney: boolean;
  roofShape: RoofShape;
  roofTurned: boolean;
};

/**
 * Everything about a building that ISN'T geometry — what the selection
 * panel and the hover tooltip actually show. Kept as its own type (rather
 * than reusing `city.ts`'s `Building` directly) because it also carries the
 * OWNING district's own name/path, which `Building` itself has no way to
 * know — a building has no back-reference to its district in the model.
 */
type BuildingMeta = {
  path: string;
  name: string;
  kind: BuildingKind;
  lines: number;
  districtName: string;
};

/** What a hover reports: which building (`meta`), where to draw its ground
 * highlight (`transform`), and where to draw the tooltip (`x`/`y`, stage-
 * relative pixels — see `clampTooltipPosition`). */
export type BuildingHoverInfo = { meta: BuildingMeta; transform: BuildingTransform; x: number; y: number };

/** What a CLICK reports — no screen coordinates, since the selection panel
 * has its own fixed position rather than following the cursor. */
export type SelectedBuilding = { meta: BuildingMeta; transform: BuildingTransform };

export type KindBucket = { transforms: BuildingTransform[]; metas: BuildingMeta[] };

function emptyBucket(): KindBucket {
  return { transforms: [], metas: [] };
}

export function buildKindBuckets(
  model: CityModel,
  layout: CityLayout,
  gridPitch: number,
): Record<BuildingKind, KindBucket> {
  const buckets: Record<BuildingKind, KindBucket> = {
    Source: emptyBucket(),
    Test: emptyBucket(),
    Config: emptyBucket(),
    Docs: emptyBucket(),
    Asset: emptyBucket(),
    Data: emptyBucket(),
  };
  for (const placedDistrict of layout.districts) {
    const district = model.districts[placedDistrict.district_index];
    // Same guarantee, same reason to stay loud rather than silently drop a
    // building — see `RoadNetwork`'s matching check.
    if (!district) {
      console.warn(
        `TownView: PlacedDistrict.district_index ${placedDistrict.district_index} has no matching CityModel district — its buildings will not render.`,
      );
      continue;
    }
    for (const placed of placedDistrict.buildings) {
      const building = district.buildings[placed.building_index];
      if (!building) {
        console.warn(
          `TownView: district "${district.path}" (index ${placedDistrict.district_index}) has no building at building_index ${placed.building_index} — it will not render.`,
        );
        continue;
      }
      const bucket = buckets[building.kind];
      // `formFor` — a deterministic hash of the building's own path (see its
      // doc comment) — gives every building a small height nudge (via
      // `heightJitter`, applied uniformly below, never swapping which
      // bucket a building reads as) and a per-building roof pitch, and a
      // minority a distinctly different FOOTPRINT (a narrow tower, or a wide
      // squat). Every variant caps its footprint at
      // `buildingFootprint(5, gridPitch)` — the exact value
      // `footprintClearance` already treats as the widest footprint this
      // file ever draws — so this can never erode that invariant no matter
      // how the variant's own footprint is chosen. Coordinator correction,
      // packing pass: no more position/rotation jitter (see `tintFor`'s doc
      // comment in `../city` for why) — a building sits exactly at its own
      // cell's centre, unrotated; `formFor` alone now carries the "stop
      // looking interchangeable" job.
      //
      // CRITICAL 1 (Opus frontend review): height must stay a PURE function
      // of `placed.height` — the building's own real line-count bucket —
      // ALWAYS, with no exception for `variant`. Height is the one
      // measurement this whole town exists to show (design inputs §2), and
      // `BuildingPanel` displays the SAME building's true `lines` when
      // clicked; a variant that also overrode height (as this used to, for
      // "tower"/"squat") made the silhouette and the panel contradict each
      // other — a 12-line file hashing to "tower" drew taller than a
      // genuine 1000-line file, and a 3000-line file hashing to "squat"
      // drew shorter than a 10-line config. `hasChimney`'s own doc comment
      // states the rule this violated: decoration must never become a
      // function of a building's real properties. Variety now lives
      // entirely in footprint (below), roof pitch, and chimney — channels
      // that carry no information about the file at all — never in height.
      const form = formFor(building.path);
      const maxFootprint = worldUnits(buildingFootprint(5, gridPitch));
      let footprint = worldUnits(buildingFootprint(placed.height, gridPitch));
      const height = buildingWorldHeight(placed.height, gridPitch) * form.heightJitter;
      if (form.variant === "tower") {
        // A narrow footprint of the building's OWN true height — a "tower"
        // is thin, never tall-for-its-size.
        footprint = worldUnits(buildingFootprint(1, gridPitch)) * 0.9;
      } else if (form.variant === "squat") {
        // A wide footprint of the building's OWN true height — a "squat" is
        // wide, never short-for-its-size.
        footprint = maxFootprint;
      }
      bucket.transforms.push({
        // Critical 1 (final whole-branch review): a building sits at its
        // own cell's CENTRE — see `cellCenter`'s doc comment — never at the
        // cell's raw corner coordinate `placed.x`/`placed.z` gives you
        // directly. Roofs need no separate fix: `BuildingInstances` reads
        // the roof's position from this same `x`/`z`.
        x: cellCenter(placed.x),
        z: cellCenter(placed.z),
        height,
        footprint,
        tint: tintFor(building.path),
        // A flat roof is a low slab-and-parapet, whatever pitch the hash
        // rolled — and everything that stacks on a roof (chimneys, smoke,
        // "+N" labels) reads this one value, so it must be the real one.
        roofPitch: form.roofShape === "flat" ? FLAT_ROOF_PITCH : form.roofPitch,
        hasChimney: form.hasChimney,
        roofShape: form.roofShape,
        roofTurned: form.roofTurned,
      });
      bucket.metas.push({
        path: building.path,
        name: building.name,
        kind: building.kind,
        lines: building.lines,
        districtName: district.name,
      });
    }
  }
  return buckets;
}

/**
 * Cost-of-hover round (Item 2 of the resource-hygiene report): before this
 * round, EVERY pointer move over either instanced mesh below allocated a
 * fresh `{ meta, transform, x, y }` object and called `onHover` (→
 * `TownView`'s `setHover`) with it — even while the cursor sat still inside
 * the SAME building, moving one pixel at a time. Each call is a new object
 * by definition, so React can never bail on it (`Object.is` always says
 * "different"), which re-ran `TownView`'s own render AND, before this round,
 * every un-memoised child underneath it — up to ~1,064 buildings' worth of
 * component work for a mouse twitch that didn't even change which building
 * was hovered.
 *
 * `bucket.metas[i]`/`bucket.transforms[i]` are stable array elements (the
 * SAME object reference every render, since `bucket` itself only changes
 * when the underlying model/layout does — see `TownView`'s `kindBuckets`) —
 * so "is this still the same building as last time" is a plain reference
 * comparison against `lastRef`, wired below.
 *
 * Pulled out as its own pure, exported function — same reasoning as
 * `clampTooltipPosition` above — so this exact dedup decision has its own
 * unit tests, independent of any r3f/WebGL plumbing (`TownView.test.ts`).
 */
const NO_PATHS: ReadonlySet<string> = new Set();
/** A flat roof's slab-and-parapet height, as a fraction of its footprint. */
const FLAT_ROOF_PITCH = 0.16;
const ROOF_SHAPES: RoofShape[] = ["gable", "hip", "pyramid", "flat"];
const ROOF_GEOMETRY: Record<RoofShape, () => THREE.BufferGeometry> = {
  gable: gabledRoofGeometry,
  hip: hippedRoofGeometry,
  pyramid: pyramidRoofGeometry,
  flat: flatRoofGeometry,
};
/** Scratch object for `BuildingInstances`' per-frame matrix writes. */
const GROWTH_DUMMY = new THREE.Object3D();
/** A new file's first drawn height: flush with the ground, never zero (a
 * zero scale makes a singular matrix). */
const GROWTH_START_HEIGHT = 0.001;
const GROWTH_EPSILON = 0.002;
/** Easing rate toward the measured height, per second (~1s to settle). */
const GROWTH_RATE = 4;

export function isSameHoveredBuilding(
  last: { meta: unknown; transform: unknown } | null,
  meta: unknown,
  transform: unknown,
): boolean {
  return last !== null && last.meta === meta && last.transform === transform;
}

function BuildingInstancesImpl({
  kind,
  bucket,
  onHover,
  onSelect,
  stageRef,
  grownPaths = NO_PATHS,
  windowsLit = false,
}: {
  kind: BuildingKind;
  bucket: KindBucket;
  onHover: (hover: BuildingHoverInfo | null) => void;
  onSelect: (selection: SelectedBuilding) => void;
  stageRef: RefObject<HTMLDivElement | null>;
  /** Files that did not exist at the previous measurement: they rise out of
   * the ground instead of simply appearing. */
  grownPaths?: ReadonlySet<string>;
  /** Someone is home: at night (see `MoodLook.windows`) these windows glow. */
  windowsLit?: boolean;
}) {
  const windows = useMood().look.windows;
  const glow = windowsLit && windows !== null;
  const meshRef = useRef<THREE.InstancedMesh>(null);
  // One roof mesh per shape; `roofIndices[shape][j]` is the building that
  // roof instance `j` sits on, so hover and click map back to the building.
  const roofRefs = useRef<Partial<Record<RoofShape, THREE.InstancedMesh | null>>>({});
  const roofIndices = useMemo(() => {
    const groups: Record<RoofShape, number[]> = { gable: [], hip: [], pyramid: [], flat: [] };
    bucket.transforms.forEach((t, i) => groups[t.roofShape].push(i));
    return groups;
  }, [bucket]);
  const chimneyRef = useRef<THREE.InstancedMesh>(null);
  // Cost-of-hover round (Item 2): the last building `handleHover` actually
  // reported UP to `TownView`, shared by both the wall and roof
  // `onPointerMove` below (see this component's own doc comment for why a
  // plain reference comparison against `bucket.metas[i]`/`transforms[i]` is
  // enough — those arrays never change identity out from under an
  // in-progress hover).
  const lastHoverRef = useRef<{ meta: BuildingMeta; transform: BuildingTransform } | null>(null);
  const count = bucket.transforms.length;

  // Live growth: the height each building is DRAWN at, by path. It eases
  // toward the measured height (`t.height`) whenever a re-measure changes it,
  // so a file crossing a line-count bucket visibly rises, and a brand-new
  // file climbs out of the ground. Always converges on the true height —
  // the animation is the path there, never a different resting value.
  const shownRef = useRef(new Map<string, number>());
  const movingRef = useRef(false);
  // Item 6, "occasional chimneys": a SUBSET of this kind's buildings (see
  // `formFor`'s `hasChimney`, ~1 in 5) — its own small instancedMesh, sized
  // to that subset, not the full bucket. One more draw call per KIND that
  // actually has any chimneys this round, never one per building. Indices,
  // not transforms, so a chimney can follow its own building's growth.
  const chimneyIndices = useMemo(
    () => bucket.transforms.flatMap((t, i) => (t.hasChimney ? [i] : [])),
    [bucket],
  );

  const writeMatrices = useCallback(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = GROWTH_DUMMY;
    const heightAt = (i: number) => shownRef.current.get(bucket.metas[i].path) ?? bucket.transforms[i].height;
    // Coordinator correction, packing pass: every building sits exactly at
    // its own cell's centre, unrotated — no more position/rotation jitter
    // (see `tintFor`'s doc comment in `../city` for why: at the packed
    // pitch there is no slack left to spend on it). Gabled roofs share
    // the same cell-aligned footprint; file heights and positions are unchanged.
    bucket.transforms.forEach((t, i) => {
      const height = heightAt(i);
      dummy.position.set(t.x, height / 2, t.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(t.footprint, height, t.footprint);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    for (const shape of ROOF_SHAPES) {
      const roof = roofRefs.current[shape];
      if (!roof) continue;
      roofIndices[shape].forEach((i, j) => {
        const t = bucket.transforms[i];
        const roofWidth = t.footprint * ROOF_OVERHANG;
        const roofHeight = t.footprint * t.roofPitch;
        dummy.position.set(t.x, heightAt(i) + roofHeight / 2, t.z);
        dummy.rotation.set(0, t.roofTurned ? Math.PI / 2 : 0, 0);
        dummy.scale.set(roofWidth, roofHeight, roofWidth);
        dummy.updateMatrix();
        roof.setMatrixAt(j, dummy.matrix);
      });
      roof.instanceMatrix.needsUpdate = true;
    }

    const chimney = chimneyRef.current;
    if (chimney) {
      chimneyIndices.forEach((i, j) => {
        const t = bucket.transforms[i];
        const height = heightAt(i);
        const roofHeight = t.footprint * t.roofPitch;
        // A small square stack, offset toward one fixed corner of the roof
        // (never a random/seeded direction — a chimney's exact corner isn't
        // information worth encoding) and poking a little above the ridge,
        // as if it were built through the hipped roof rather than floating
        // next to it.
        const offset = t.footprint * 0.24;
        const chimneyWidth = Math.max(0.06, t.footprint * 0.09);
        const baseY = height + roofHeight * 0.25;
        const topY = height + roofHeight + t.footprint * 0.1;
        const chimneyHeight = Math.max(0.05, topY - baseY);
        dummy.position.set(t.x + offset, baseY + chimneyHeight / 2, t.z + offset);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(chimneyWidth, chimneyHeight, chimneyWidth);
        dummy.updateMatrix();
        chimney.setMatrixAt(j, dummy.matrix);
      });
      chimney.instanceMatrix.needsUpdate = true;
    }
  }, [bucket, chimneyIndices, roofIndices]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Where each building starts this time: where it was last drawn, the
    // ground for a file that is new since the last measurement, and its
    // true height for everything seen for the first time (a town opening
    // is not growth).
    const previous = shownRef.current;
    const next = new Map<string, number>();
    let moving = false;
    bucket.transforms.forEach((t, i) => {
      const path = bucket.metas[i].path;
      const from = previous.get(path) ?? (grownPaths.has(path) ? GROWTH_START_HEIGHT : t.height);
      next.set(path, from);
      if (Math.abs(from - t.height) > GROWTH_EPSILON) moving = true;
    });
    shownRef.current = next;
    movingRef.current = moving;

    // Walls: a uniform warm cream, only lightly tinted per building — kind
    // no longer lives here (see `WALL_BASE_COLOR`'s doc comment).
    const wallBase = new THREE.Color(WALL_BASE_COLOR);
    // Roofs: the kind's OWN colour, pushed warmer/more saturated and a touch
    // darker so it reads as a shingle/tile tone rather than the same pastel
    // flat colour repeated on a different shape.
    const roofColor = new THREE.Color(buildingColor(kind));
    const roofHsl = { h: 0, s: 0, l: 0 };
    roofColor.getHSL(roofHsl);
    roofColor.setHSL(
      (roofHsl.h - 0.02 + 1) % 1,
      Math.min(1, roofHsl.s + 0.15),
      Math.max(0, roofHsl.l - 0.12),
    );
    const tmpColor = new THREE.Color();
    bucket.transforms.forEach((t, i) => {
      tmpColor.copy(wallBase).offsetHSL(0, 0, t.tint);
      mesh.setColorAt(i, tmpColor);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    for (const shape of ROOF_SHAPES) {
      const roof = roofRefs.current[shape];
      if (!roof) continue;
      roofIndices[shape].forEach((i, j) => {
        tmpColor.copy(roofColor).offsetHSL(0, 0, bucket.transforms[i].tint * 0.6);
        roof.setColorAt(j, tmpColor);
      });
      if (roof.instanceColor) roof.instanceColor.needsUpdate = true;
    }

    writeMatrices();
    mesh.computeBoundingSphere();
    for (const shape of ROOF_SHAPES) roofRefs.current[shape]?.computeBoundingSphere();
    chimneyRef.current?.computeBoundingSphere();
  }, [bucket, kind, grownPaths, writeMatrices, roofIndices]);

  // No `invalidate()` — like every ambient animation here it only advances
  // while the render loop is already awake (see `ChangeMarkers`).
  useFrame((_, delta) => {
    if (!movingRef.current) return;
    const shown = shownRef.current;
    const step = Math.min(1, delta * GROWTH_RATE);
    let moving = false;
    bucket.transforms.forEach((t, i) => {
      const path = bucket.metas[i].path;
      const current = shown.get(path) ?? t.height;
      const nextHeight = Math.abs(t.height - current) <= GROWTH_EPSILON ? t.height : current + (t.height - current) * step;
      shown.set(path, nextHeight);
      if (nextHeight !== t.height) moving = true;
    });
    movingRef.current = moving;
    writeMatrices();
    if (!moving) {
      meshRef.current?.computeBoundingSphere();
      for (const shape of ROOF_SHAPES) roofRefs.current[shape]?.computeBoundingSphere();
      chimneyRef.current?.computeBoundingSphere();
    }
  });

  if (count === 0) return null;

  // Hover coordinates are converted to STAGE-relative pixels here, once,
  // rather than raw `event.clientX`/`clientY` — see the tooltip-clamping
  // comment on `TownView` itself for the bug this fixes (a tooltip
  // positioned from viewport coordinates inside a container that doesn't
  // start at the viewport's origin, which both offset it from the cursor
  // and let it run off the bottom of the window with nothing to clamp it).
  // `toBuilding` maps an instance id on the mesh that was hit to the
  // building's index in `bucket` — the identity for walls, the shape's own
  // index list for roofs (see `roofIndices`).
  const handleHover = (event: ThreeEvent<PointerEvent>, toBuilding: (id: number) => number | undefined = (id) => id) => {
    event.stopPropagation();
    const i = event.instanceId != null ? toBuilding(event.instanceId) : undefined;
    const meta = i != null ? bucket.metas[i] : undefined;
    const transform = i != null ? bucket.transforms[i] : undefined;
    if (!meta || !transform) {
      if (lastHoverRef.current) {
        lastHoverRef.current = null;
        onHover(null);
      }
      return;
    }
    // Cost-of-hover round (Item 2): still the SAME building as last event —
    // most of a "sustained pointer movement" is exactly this, the cursor
    // drifting a few pixels within one building's own footprint. Skip
    // allocating a new hover object (and the `setHover` call it would
    // trigger) entirely rather than re-reporting the same building with a
    // marginally different `x`/`y`: the tooltip stays glued to where it
    // first appeared for THIS building, which is the deliberate trade —
    // "avoid allocating a new hover object when the hovered building has
    // not actually changed, so React can bail out" (this round's own brief)
    // — for not re-rendering the whole town on every pixel of mouse motion.
    if (isSameHoveredBuilding(lastHoverRef.current, meta, transform)) {
      return;
    }
    lastHoverRef.current = { meta, transform };
    const rect = stageRef.current?.getBoundingClientRect();
    const x = rect ? event.clientX - rect.left : event.clientX;
    const y = rect ? event.clientY - rect.top : event.clientY;
    onHover({ meta, transform, x, y });
  };

  const handlePointerOut = () => {
    if (lastHoverRef.current) {
      lastHoverRef.current = null;
      onHover(null);
    }
  };

  // A SELECT, not a hover — see `SelectedBuilding`'s doc comment. Never
  // fires anything beyond updating state: opening the file is an explicit,
  // separate button in `BuildingPanel` (item 3's own instruction — an
  // accidental click must not launch an application).
  const handleClick = (event: ThreeEvent<MouseEvent>, toBuilding: (id: number) => number | undefined = (id) => id) => {
    event.stopPropagation();
    const i = event.instanceId != null ? toBuilding(event.instanceId) : undefined;
    const meta = i != null ? bucket.metas[i] : undefined;
    const transform = i != null ? bucket.transforms[i] : undefined;
    if (meta && transform) onSelect({ meta, transform });
  };

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, count]}
        onPointerMove={(event) => handleHover(event)}
        onPointerOut={handlePointerOut}
        onClick={(event) => handleClick(event)}
        castShadow
        receiveShadow
      >
        {/* Craft pass, item 1: a plain unit cube was the single biggest
            "cheap" tell — see `bevelGeometry.ts`'s doc comment for why a
            shared, module-cached, CHAMFERED (not smoothly rounded) box
            replaces it here, at zero extra per-instance cost — the geometry
            is still shared across all `count` instances exactly like the
            plain box was. `flatShading` keeps every chamfer facet a crisp,
            distinct plane instead of blending into a curve, the same fix
            already applied to the roof below. */}
        <primitive object={buildingWallGeometry()} attach="geometry" />
        <meshStandardMaterial
          roughness={0.85}
          metalness={0.04}
          map={buildingFacadeTexture()}
          emissiveMap={buildingWindowMask()}
          emissive={glow ? windows.color : "#000000"}
          emissiveIntensity={glow ? windows.intensity : 0}
          flatShading
        />
      </instancedMesh>
      {/* A low four-sided pyramid, instanced per kind exactly like the
          walls above — one extra draw call per BuildingKind, never one per
          building (coordinator's round-2 review, item 2).

          MINOR (final whole-branch review): the roof needs the SAME hover
          (and now click) wiring as the wall mesh above, or hovering/
          clicking a building's roof — a large share of what's actually
          under the cursor from the default camera angle — does nothing.
          Roofs are split by shape (gable, hip, pyramid, flat — see
          `formFor`), so each shape's mesh maps its instance ids back to
          buildings through `roofIndices` before the shared handlers run. */}
      {ROOF_SHAPES.map((shape) => {
        const indices = roofIndices[shape];
        if (indices.length === 0) return null;
        const toBuilding = (id: number) => indices[id];
        return (
          <instancedMesh
            key={`${shape}-${indices.length}`}
            ref={(mesh) => { roofRefs.current[shape] = mesh; }}
            args={[undefined, undefined, indices.length]}
            onPointerMove={(event) => handleHover(event, toBuilding)}
            onPointerOut={handlePointerOut}
            onClick={(event) => handleClick(event, toBuilding)}
            castShadow
            receiveShadow
          >
            <primitive object={ROOF_GEOMETRY[shape]()} attach="geometry" dispose={null} />
            <meshStandardMaterial vertexColors roughness={0.8} metalness={0} flatShading />
          </instancedMesh>
        );
      })}
      {chimneyIndices.length > 0 && (
        <instancedMesh ref={chimneyRef} args={[undefined, undefined, chimneyIndices.length]} castShadow>
          <primitive object={buildingWallGeometry()} attach="geometry" />
          <meshStandardMaterial color={CHIMNEY_COLOR} roughness={0.9} flatShading />
        </instancedMesh>
      )}
    </group>
  );
}
// Cost-of-hover round (Item 2): wrapped in `React.memo` — `bucket` only
// changes identity when the underlying model/layout does (`kindBuckets` is
// itself memoised in `TownView`), and `onHover`/`onSelect`/`stageRef` are now
// all stable across a hover-only re-render (`setHover` from `useState` always
// is; `onSelect` was hoisted to `handleBuildingSelect` above). Combined with
// `handleHover`'s own same-building bail, hovering a still building now costs
// nothing beyond the raycast itself: neither `BuildingInstances` nor its
// `useLayoutEffect`s re-run.
export const BuildingInstances = memo(BuildingInstancesImpl);

// ---------------------------------------------------------------------
// Hover/selection highlights (item 2/4): both a ground tile sized to the
// building's own footprint, so the highlight is unmistakably attached to
// ONE building rather than reading as ambient lighting. Selection adds a
// wireframe edge box around the whole building on top — "unmistakably
// connected" to the panel, per the coordinator's own instruction — which
// hover deliberately omits, so the two never look like the same state at a
// glance.
// ---------------------------------------------------------------------

const HIGHLIGHT_BOX_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));

function ChangeMarkers({ buckets, changes, live }: { buckets: Record<BuildingKind, KindBucket>; changes: ReadonlyMap<string, ChangeStatus>; live: boolean }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  // No `invalidate()`: like every other ambient animation here it only runs
  // while the render loop is already awake (see `IgnitionPulse`).
  useFrame(({ clock }) => {
    const material = meshRef.current?.material as THREE.MeshBasicMaterial | undefined;
    if (material) material.opacity = live ? 0.62 + Math.sin(clock.elapsedTime * 2.4) * 0.26 : 0.7;
  });
  const markers = useMemo(() => Object.values(buckets).flatMap(bucket => bucket.metas.flatMap((meta, i) => {
    const status = changes.get(meta.path);
    return status ? [{ transform: bucket.transforms[i], status }] : [];
  })), [buckets, changes]);
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const object = new THREE.Object3D();
    markers.forEach(({ transform: t, status }, i) => {
      object.position.set(t.x, 0.045, t.z); object.rotation.set(-Math.PI / 2, 0, 0);
      object.scale.set(t.footprint * 1.45, t.footprint * 1.45, 1); object.updateMatrix();
      mesh.setMatrixAt(i, object.matrix);
      mesh.setColorAt(i, new THREE.Color(status === "added" || status === "untracked" ? "#73dbc1" : status === "deleted" || status === "conflicted" ? "#ee9386" : "#efc26d"));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [markers]);
  if (!markers.length) return null;
  return <instancedMesh key={markers.length} ref={meshRef} args={[undefined, undefined, markers.length]} raycast={() => {}}><planeGeometry args={[1, 1]} /><meshBasicMaterial transparent opacity={0.7} toneMapped={false} depthWrite={false} /></instancedMesh>;
}

function HoverHighlight({ transform }: { transform: BuildingTransform }) {
  const { x, z, footprint } = transform;
  return (
    <mesh position={[x, 0.03, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[footprint * 1.2, footprint * 1.2]} />
      <meshBasicMaterial color={HOVER_COLOR} transparent opacity={0.25} toneMapped={false} />
    </mesh>
  );
}

function SelectionHighlight({ transform }: { transform: BuildingTransform }) {
  const { x, z, height, footprint } = transform;
  return (
    <group>
      <mesh position={[x, 0.035, z]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[footprint * 1.3, footprint * 1.3]} />
        <meshBasicMaterial color={SELECTION_COLOR} transparent opacity={0.4} toneMapped={false} />
      </mesh>
      <lineSegments
        geometry={HIGHLIGHT_BOX_EDGES}
        position={[x, height / 2, z]}
        scale={[footprint * 1.1, height * 1.05, footprint * 1.1]}
      >
        <lineBasicMaterial color={SELECTION_COLOR} toneMapped={false} />
      </lineSegments>
    </group>
  );
}
