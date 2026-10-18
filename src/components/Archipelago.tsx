import { TradeRouteLines } from "./TradeRouteLines";
import { useTradeRoutes } from "./TradeRoutes";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import {
  assignVillagerPositions,
  ATTENTION_COLOR,
  defaultFocusBounds,
  isFilterActive,
  islandCenter,
  isSeaIslandMatch,
  joinArchipelago,
  landRect,
  massingBlockCount,
  activityRingOpacity,
  padFadeOpacity,
  pickDefaultFocusIsland,
  resolveFlyToTarget,
  seaBounds,
  type FlyToRequest,
  type IslandView,
  type SeaIsland,
  type StateFilter,
} from "../archipelago";
import {
  activityBucket,
  activityBucketCounts,
  ACTIVITY_BUCKET_ORDER,
  ACTIVITY_COLOR,
  ACTIVITY_LABEL,
  loadActivityLens,
  saveActivityLens,
  type ActivityBucket,
} from "../activityLens";
import { buildingColor, hashString, worldUnits, type BuildingKind } from "../city";
import { formatLastChanged } from "../lastChanged";
import { islandMask, terrainHeight } from "../terrain";
import { switchTargets, type SwitchTarget } from "../agentSwitcher";
import { sceneFrameloop, TerminalStageProvider, useTerminalStageHost } from "../terminalStage";
import { isInteractiveTarget, isModalOpen } from "../useHotkey";

import { IslandPanel } from "./IslandPanel";
import { cottageFacadeTexture, cottageWindowMask } from "./facadeTexture";
import { gabledRoofGeometry } from "./bevelGeometry";
import { villagePlan, villageAgentSlots, type VillageHouse, type VillageLane } from "../villagePlan";
import { buildTerrainGeometry } from "./terrainGeometry";
import { useDisposableMemo } from "./useDisposableMemo";
import { buildAttentionHaloGeometry } from "./attentionHalo";
import { useRecording } from "../recording";
import { useMood } from "../mood";
import { CinematicEffects } from "./CinematicEffects";
import { SailingBoats, type BoatRoute } from "./Boats";

export { buildAttentionHaloGeometry };
import { Vegetation } from "./Vegetation";
import {
  Atmosphere,
  CameraRig,
  CLIFF_COLOR,
  easeInOutCubic,
  GRASS_LIGHT_COLOR,
  GRASS_SHADE_COLOR,
  GROUND_COLOR,
  GROUND_THICKNESS,
  PLOT_FILL,
  SAND_COLOR,
  SceneLights,
  SKY_COLOR,
  WALL_BASE_COLOR,
  WATER_COLORS,
  WET_SAND_COLOR,
} from "./TownView";
import { IslandShallows, OpenWater } from "./Water";
import { ATTENTION_MARK, type Agent, type Attention, type Island } from "../world";

/** The same six kind colours `TownView`'s roofs use — reused here purely as
 * decorative variety for LOD houses that do not correspond to any real
 * per-file classification at this zoom (see `archipelago.ts`'s
 * `houseCluster` doc comment). Not a claim about content, the same way a
 * building's `tintFor` jitter isn't a claim about anything either. */
const HOUSE_ROOF_PALETTE: string[] = (
  ["Source", "Test", "Config", "Docs", "Asset", "Data"] as BuildingKind[]
).map(buildingColor);

// `SAND_COLOR`/`FOAM_COLOR` now live in `TownView.tsx` (imported above) —
// shared with the town's own ground so both screens' coastlines are made of
// the same material, not two hand-tuned near-duplicates.
/** Item 3: an unsettled island's houses — real content, no one living there
 * yet. A muted sage roof (never the lively `HOUSE_ROOF_PALETTE`) and a
 * duller, greyed wall tone, so the island reads as quieter at a glance
 * without changing how much of it there is. */
const UNSETTLED_ROOF_COLOR = "#9aa792";
const UNSETTLED_WALL_COLOR = "#d9d4c4";

/**
 * The archipelago: the primary screen (Item 1 of the archipelago-scene
 * brief). Every one of the user's repositories is an island in a shared sea,
 * sized by its REAL city (never a full `CityModel` — Item 1's whole cost
 * argument), with the ones needing a human visibly marked (Item 2) and the
 * agents working in them standing on their island as villagers (Item 3),
 * clickable straight into their terminal (Item 4). Clicking an island flies
 * the camera down and opens its town (Item 5).
 *
 * Reuses `TownView`'s exact palette and camera rig (`GROUND_COLOR`,
 * `WATER_COLOR`, `CameraRig`, `fitIsometricCamera`, ...) rather than
 * restating them, per the brief's own instruction that the two screens read
 * as one product.
 */
export type ArchipelagoProps = {
  archipelago: IslandView[];
  /** The live world (`get_world`/`world-updated`) — joined against
   * `archipelago` by `root` (see `joinArchipelago`) for attention/agents. */
  islands: Island[];
  onOpenIsland: (seaIsland: SeaIsland) => void;
  /** Bumped by `App.tsx` after a successful Space-hotkey jump (Item 5: "when
   * it jumps, move the camera to that island too, so the user sees where
   * they were sent") or a search Enter-to-jump. `seq` — not just `name` — so
   * pressing the hotkey twice in a row for the SAME island still re-triggers
   * the flight; a plain name-equality check would treat the second press as
   * a no-op change. Resolved to an actual `SeaIsland` via
   * `resolveFlyToTarget` (`../archipelago`) — see that function's own doc
   * comment for why `islandRoot` matters (I1, Opus frontend review). */
  flyToRequest?: FlyToRequest | null;
  frameloop?: "always" | "demand";
  preserveDrawingBuffer?: boolean;
  /** Screenshot-harness-only (mirrors `TownView`'s `focusDistrictPath`): fit
   * the camera to one island's own land, plus a margin, instead of the
   * whole sea — for a closer shot of one island's massing/beacon/villagers
   * on an archipelago with many islands. Unused by the shipped app. */
  focusRoot?: string;
  /** Screenshot-harness-only: opens `IslandPanel` for this root on mount,
   * the same state a real click on that island would set — so a render can
   * show the panel actually laid out over the scene without a synthetic
   * pointer event. Unused by the shipped app. */
  autoSelectRoot?: string;
  /** Screenshot-harness-only: forwarded to `IslandPanel`'s own
   * `autoOpenSendAgent` — see that prop's doc comment. Only meaningful
   * together with `autoSelectRoot`. Unused by the shipped app. */
  autoOpenSendAgent?: boolean;
  /** Screenshot-harness-only: forwarded to `IslandPanel`'s own
   * `autoOpenTerminal`. Only meaningful together with `autoSelectRoot` and
   * `autoExpandPaneId`. Unused by the shipped app. */
  autoOpenTerminal?: boolean;
  /** Screenshot-harness-only: forwarded to `IslandPanel`'s own
   * `autoExpandPaneId`, one of the two pieces of state a real villager
   * click sets — so a render can show `AgentActions` (Items 6/7) laid out
   * without a synthetic pointer event. Only meaningful together with
   * `autoSelectRoot`. Unused by the shipped app. */
  autoExpandPaneId?: string;
  /** Screenshot-harness-only: runs this component's REAL villager-click
   * handler (`handleVillagerClick`) for the named pane, once the world
   * actually reports it. Unlike `autoExpandPaneId`/`autoOpenTerminal`,
   * which set the state a click WOULD have produced, this goes through the
   * shipped code path itself — so a render of the click is evidence about
   * the click, not about the harness. Unused by the shipped app. */
  autoVillagerClickPaneId?: string;
  /** Search-and-filter round: the current name query, filtered case-
   * insensitively against each island's own name (`matchesSearchQuery`).
   * `""`/undefined means no name filter — every island renders exactly as
   * it always has, per `isFilterActive`. */
  searchQuery?: string;
  /** Search-and-filter round: narrows the sea to one live attention state
   * (or `"all"`) — the natural extension of the "N agents need you" badge
   * into "show me ONLY what needs me." Combined with `searchQuery` via AND
   * (`isSeaIslandMatch`). */
  stateFilter?: StateFilter;
};

// Same amber/blue/grey the 2D `IslandGrid`/`styles.css` already use for
// `.island--stopped`/`.island--working`/`.island--unknown` — one meaning, one
// colour, in both views of the same product.
/** Art-direction round: the sea's own terrain constants. Kept small and
 * flat-constant (never a function of city size/content) — see
 * `TownView.TOWN_MOUND_HEIGHT`'s own doc comment for the "never reads as a
 * building" reasoning, which applies identically here. `SEA_BEACH_DEPTH` is
 * how far the coastline sinks once fully outside `islandMask`'s boundary —
 * deep enough to sit convincingly under the shore/water planes at every real
 * island size the author's own repositories produce. */
const SEA_MOUND_HEIGHT = 0.34;
/**
 * Scenery-craft round, `0.5` -> `1.8`, and this is a bug fix wearing a
 * constant's clothes.
 *
 * The water plane sits at `-GROUND_THICKNESS - 0.06 = -0.56`. At `0.5`, the
 * terrain mesh bottomed out at exactly `-0.5` — six hundredths of a unit
 * ABOVE the water. So every island's "submerged" region was not submerged:
 * the whole square plot rendered as a flat pale shelf just proud of the sea,
 * which is the field of hard-edged rectangles this round's "before" renders
 * are full of, and the reason the carefully-computed organic coastline was
 * never actually the silhouette anyone saw.
 *
 * Raising it was only safe once `terrainHeight`'s submergence curve became
 * cubic (see its own comment): the linear version would have dragged real
 * dry land — every block, house and villager, which `clampToLand` only
 * guarantees to `mask >= 0.65` — down under the waterline along with it.
 * With the cubic curve the waterline now falls at about `mask ≈ 0.27`, while
 * `mask = 0.65` still sits ~0.74 units clear of it.
 */
const SEA_BEACH_DEPTH = 1.8;
/** Geometry subdivisions per island terrain mesh. Raised `14` -> `20` in the
 * scenery-craft round: now that the coastline genuinely submerges rather
 * than flattening onto a visible slab, the silhouette is the island, and at
 * `14` its facets were readable as a polygon. 152 islands × 21² ≈ 67,000
 * vertices total, built once per island via `useMemo`, never per frame —
 * paid for several times over by the same round dropping each island's
 * 121-vertex shore plane to a 4-vertex quad and the sea's own 2,401-vertex
 * CPU-animated ocean to 4. */
const SEA_TERRAIN_SEGMENTS = 40;

// Town-villagers round: these four now alias `ATTENTION_COLOR` (shared with
// `TownView.tsx`'s own villagers) instead of restating the hex values —
// "one meaning, one colour," never a second copy that could drift.
const STOPPED_COLOR = ATTENTION_COLOR.stopped;
const WORKING_COLOR = ATTENTION_COLOR.working;
const UNKNOWN_COLOR = ATTENTION_COLOR.unknown;
/** A villager on a calm island — no semantic urgency, so a soft neutral tone
 * rather than reusing any of the three "look at me" colours above. */
const QUIET_VILLAGER_COLOR = ATTENTION_COLOR.quiet;
/** The beacon's lamp and the ignition flash: a near-white tint of the
 * stopped green, so the brightest point on the island still reads as green
 * rather than as a warm light that belongs to no state. */
const STOPPED_FLARE_COLOR = "#c8fbe8";
/** The fog blob over a `CityStatus::Unknown` island's small, explicitly-not-
 * -a-measurement footprint (Item 6). */
const FOG_COLOR = "#9aa3ad";
/** Search-and-filter round: the "this one matches" cue — a vivid magenta,
 * deliberately OUTSIDE both this scene's attention palette (warm amber/
 * blue/grey, all about an AGENT's own state — a match must never be
 * confused with "needs you") AND its water/land palette (teal/turquoise,
 * sand, green — an earlier teal choice here nearly vanished against
 * `WATER_SHALLOW_COLOR`'s own similar hue, caught by actually rendering and
 * reading a screenshot rather than reasoning about the two hex values on
 * paper). Magenta appears nowhere else in this scene, so it reads
 * unambiguously as "the UI is pointing at this one," not as more sea. */
const SEARCH_MATCH_COLOR = "#ff3fb0";
/** How much a non-matching island under an active filter is toned down —
 * "receded, not deleted" (this round's own brief): its plot, houses, and
 * villagers stay exactly where they are, just visually quieter, so a real
 * match still reads clearly against a sea of a hundred-plus islands without
 * making the rest of the archipelago disappear. */
const DIM_OPACITY = 0.32;
/** A receded villager's colour — flatter than even `QUIET_VILLAGER_COLOR`,
 * deliberately the SAME regardless of the villager's real attention: an
 * agent that is filtered out is, by construction, not what the user asked
 * to see right now, so its dot recedes uniformly rather than still
 * competing in amber/blue. */
const DIM_VILLAGER_COLOR = "#8f8879";

/* The sea's island labels use the SHARED vocabulary in `world.ts`
   (`ATTENTION_MARK`, used directly below), so a beacon, a panel row and the
   terminal's switcher strip cannot come to disagree about a glyph. */


/** At most this many boats at sea, however many islands there are. */
const MAX_SEA_BOATS = 12;

/** Recording mode: how long the camera stays on a just-finished island
 * before easing back out to the whole sea. */
const RECORDING_HOLD_MS = 9000;

/** How long `IgnitionPulse` (the "reward attention" flash) plays for. */
const IGNITION_MS = 1400;

/** Whether an island's name label shows UNPROMPTED (no hover needed) — see
 * the call site's doc comment. `null` (no live agent at all) and `"quiet"`
 * both stay label-less by default: neither has anything urgent to say, and
 * at real scale (dozens to low hundreds of repositories) showing every one
 * of them permanently is noise, not signal. */
function shouldLabel(attention: Attention | null): boolean {
  return attention === "stopped" || attention === "working" || attention === "unknown";
}

// ---------------------------------------------------------------------
// Camera bounds + flight
// ---------------------------------------------------------------------

function boundsToBox3(islands: IslandView[]): THREE.Box3 {
  const b = seaBounds(islands);
  return new THREE.Box3(
    new THREE.Vector3(worldUnits(b.minX), 0, worldUnits(b.minZ)),
    new THREE.Vector3(worldUnits(b.maxX), 4, worldUnits(b.maxZ)),
  );
}

/**
 * `CameraRig`'s `MAX_ZOOM_FACTOR` (8x) was tuned against a default framing
 * that fit the WHOLE sea — from there, 8x reaches a single-building close-up.
 * The sea's own default framing (framing round) now fits a handful of
 * islands instead, already close to that same close-up scale, so 8x MORE
 * from here would zoom in absurdly far past any real geometry. A smaller
 * factor keeps "zoom in further to inspect one roof" available without
 * outrunning the scene. Chosen empirically against a real render — see the
 * framing round's report entry — not derived from a formula, the same way
 * the original 8x/0.5x pair on `TownView`'s own city view was.
 */
const SEA_MAX_ZOOM_FACTOR = 3;

type FlightRequest = { targetX: number; targetZ: number; zoomFactor: number; onArrive?: () => void };

/**
 * Plays one camera "fly to" over a fixed duration: pans the orbit target AND
 * the camera position by the SAME delta each frame (preserving the current
 * viewing angle — see `TownView`'s `CameraRig.handlePanClamp` for the same
 * technique) while separately easing `camera.zoom` toward a closer framing.
 * Never gates anything else: `App`'s Space-jump `invoke` and this
 * component's villager-click `invoke` both already resolved (or are firing
 * concurrently) by the time this ever runs — see `ArchipelagoProps.
 * flyToRequest`'s doc comment and `onVillagerClick`'s own call site below.
 */
function FlightController({
  request,
  controlsRef,
}: {
  request: FlightRequest | null;
  controlsRef: RefObject<OrbitControlsImpl | null>;
}) {
  const { camera, invalidate } = useThree();
  const animRef = useRef<{
    startTarget: THREE.Vector3;
    startPos: THREE.Vector3;
    deltaX: number;
    deltaZ: number;
    startZoom: number;
    endZoom: number;
    t0: number;
    onArrive?: () => void;
  } | null>(null);

  useEffect(() => {
    if (!request) return;
    const controls = controlsRef.current;
    if (!controls || !(camera instanceof THREE.OrthographicCamera)) {
      request.onArrive?.();
      return;
    }
    animRef.current = {
      startTarget: controls.target.clone(),
      startPos: camera.position.clone(),
      deltaX: request.targetX - controls.target.x,
      deltaZ: request.targetZ - controls.target.z,
      startZoom: camera.zoom,
      endZoom: camera.zoom * request.zoomFactor,
      t0: performance.now(),
      onArrive: request.onArrive,
    };
    invalidate();
    // `request` is a fresh object every time `App`/`Archipelago` wants a new
    // flight (see `flyToRequest`'s `seq` field and the island-click handler
    // below), so identity comparison is exactly "a new flight was asked
    // for" — intentionally not deep-compared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const DURATION_MS = 550;

  useFrame(() => {
    const anim = animRef.current;
    const controls = controlsRef.current;
    if (!anim || !controls) return;
    const t = Math.min(1, (performance.now() - anim.t0) / DURATION_MS);
    const eased = easeInOutCubic(t);
    controls.target.set(
      anim.startTarget.x + anim.deltaX * eased,
      anim.startTarget.y,
      anim.startTarget.z + anim.deltaZ * eased,
    );
    camera.position.set(
      anim.startPos.x + anim.deltaX * eased,
      anim.startPos.y,
      anim.startPos.z + anim.deltaZ * eased,
    );
    if (camera instanceof THREE.OrthographicCamera) {
      camera.zoom = anim.startZoom + (anim.endZoom - anim.startZoom) * eased;
      camera.updateProjectionMatrix();
    }
    controls.update();
    invalidate();
    if (t >= 1) {
      animRef.current = null;
      anim.onArrive?.();
    }
  });

  return null;
}

/**
 * Coordinator review (water-fix round), item 2: "what reads well at 3
 * metres and at 300 metres are different pictures... this is what LOD is
 * for." The ONE place in the whole sea that reads `camera.zoom` — every
 * island's own distance-based fade (`MiniTown`'s pads, `Vegetation`'s
 * trees/rocks) reads the ref this writes, rather than each of 152 islands
 * doing its own camera/controls lookup every frame. `controls.minZoom` is
 * already set by `CameraRig`'s fit to `fittedZoom * MIN_ZOOM_FACTOR` (see
 * `TownView.tsx`) — using it directly as the "wide" reference means this
 * needs no second copy of that constant, and self-corrects if that factor
 * ever changes.
 */
function ZoomTracker({
  controlsRef,
  zoomRatioRef,
}: {
  controlsRef: RefObject<OrbitControlsImpl | null>;
  zoomRatioRef: RefObject<number>;
}) {
  const { camera } = useThree();
  useFrame(() => {
    const controls = controlsRef.current;
    if (controls && controls.minZoom > 0) {
      zoomRatioRef.current = camera.zoom / controls.minZoom;
    }
  });
  return null;
}

// ---------------------------------------------------------------------
// One island: land (or fog), LOD massing, the attention beacon, villagers,
// and a name label — everything rooted at the island's own land origin.
// ---------------------------------------------------------------------

type HoverInfo =
  | {
      kind: "island";
      name: string;
      /** Carried so the cursor tooltip can say WHEN, in words, while the
       * activity lens is on — the ring says roughly how long ago, the
       * tooltip says exactly, and between them the lens is readable without
       * having to memorise its legend. `null` is rendered by
       * `formatLastChanged` as "no known date", never as a guess. */
      lastChangedAt: number | null;
      x: number;
      y: number;
    }
  | { kind: "villager"; agent: Agent; x: number; y: number };

function SeaIslandGroup({
  seaIsland,
  onClick,
  onVillagerClick,
  onHover,
  dim,
  highlighted,
  activity,
  zoomRatioRef,
}: {
  seaIsland: SeaIsland;
  onClick: (seaIsland: SeaIsland) => void;
  onVillagerClick: (agent: Agent, seaIsland: SeaIsland) => void;
  onHover: (hover: HoverInfo | null) => void;
  /** Search-and-filter round: an active filter (name query and/or state) is
   * hiding this island — recede it, never remove it (see `DIM_OPACITY`'s
   * doc comment). Always `false` when no filter is active. */
  dim: boolean;
  /** Search-and-filter round: this island IS what the active filter is
   * looking for — draw the "you found it" cue (`SearchMatchRing`) and force
   * its label on. Always `false` when no filter is active. */
  highlighted: boolean;
  /** Activity-lens round: which recency bucket this repository's last commit
   * falls in, or `null` when the lens is switched OFF — in which case
   * nothing extra is drawn at all and this island renders exactly as it
   * always has. Computed once by the parent (against one shared "now", see
   * `nowMs` there) rather than per island, so 152 islands cannot disagree
   * about what "today" means. */
  activity: ActivityBucket | null;
  /** Water-fix round, item 2: the shared, single-source-of-truth zoom ratio
   * `ZoomTracker` writes every frame — passed through to `MiniTown` (pads)
   * and `Vegetation`, the two things that should recede/thin at distance so
   * cream walls and coloured roofs (never faded) are what a distant island
   * actually reads as. */
  zoomRatioRef: RefObject<number>;
}) {
  const { view, attention, agents } = seaIsland;
  // Recording mode drops every name from the shot (see `recording.tsx`).
  const recording = useRecording();
  const look = useMood().look;
  // Item 3 (actions-UI round): an unsettled island — real code, no herdr
  // workspace at all — must "look and read differently... quieter" than a
  // settled-but-calm one. `attention === null` is the honest signal for
  // that (see `joinArchipelago`'s doc comment: `null` means no live
  // workspace exists, never a fabricated `"quiet"`), so it doubles as the
  // muting flag for `MiniTown`'s palette below.
  const unsettled = attention === null;
  const land = useMemo(() => landRect(view), [view]);
  const known = view.city.status === "known";
  // Own hover flag, separate from the parent's cursor-tooltip state (`onHover`
  // below still drives that): at the author's real repository count (73 and
  // climbing), a persistent name label on every calm island is exactly the
  // "everything competes" failure Item 2 warns against, one level up from
  // beacons — see the label's own `shouldLabel` just below.
  const [isHovered, setIsHovered] = useState(false);

  // Game-feel round: "when an agent goes from working to stopped, something
  // should happen in the world he can notice from across the sea." Tracks
  // this ISLAND's own previous `attention` across renders; a genuine
  // transition INTO `"stopped"` (never a `null` starting point, which is
  // just "the app just mounted and this happened to already be true" — no
  // transition was actually witnessed, so no flash is honest to show for
  // it) fires a short one-shot pulse, cleared automatically after
  // `IGNITION_MS`.
  const prevAttentionRef = useRef<Attention | null>(null);
  const [justIgnited, setJustIgnited] = useState(false);
  useEffect(() => {
    const prev = prevAttentionRef.current;
    prevAttentionRef.current = attention;
    if (prev !== null && prev !== "stopped" && attention === "stopped") {
      setJustIgnited(true);
      const timer = setTimeout(() => setJustIgnited(false), IGNITION_MS);
      return () => clearTimeout(timer);
    }
  }, [attention]);

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      onClick(seaIsland);
    },
    [onClick, seaIsland],
  );

  const handleHoverIn = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      setIsHovered(true);
      onHover({
        kind: "island",
        name: view.name,
        lastChangedAt: view.last_changed_at,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [onHover, view.name, view.last_changed_at],
  );
  const handleHoverOut = useCallback(() => {
    setIsHovered(false);
    onHover(null);
  }, [onHover]);

  // LOD massing (Item 1): a SMALL number of blocks whose COUNT is a real
  // function of `district_count` — never per-district, per-building
  // geometry. See `archipelago.ts`'s module doc for the honesty reasoning.
  const blockCount = view.city.status === "known" ? massingBlockCount(view.city.district_count) : 0;
  const { houses, lanes, pads } = useMemo(
    () => villagePlan(view.root, land.w, land.d, blockCount, SEA_MOUND_HEIGHT, SEA_BEACH_DEPTH),
    [view.root, land.w, land.d, blockCount],
  );

  const villagerPositions = useMemo(() => {
    const safe = new Map<string, { x: number; z: number; groundY: number }>();
    if (agents.length === 0) return safe;
    const slots = villageAgentSlots(view.root, land.w, land.d, houses);
    for (const [paneId, pos] of assignVillagerPositions(agents, slots)) {
      safe.set(paneId, {
        ...pos,
        groundY: terrainHeight(view.root, pos.x / land.w * 2 - 1, pos.z / land.d * 2 - 1, SEA_MOUND_HEIGHT, SEA_BEACH_DEPTH),
      });
    }
    return safe;
  }, [agents, houses, land.w, land.d, view.root]);

  // Art-direction round, items 3+4: the land itself, as one organic,
  // gently-mounded terrain mesh — replaces the old union of overlapping
  // rectangular "lobes" (which, per the coordinator's own review, "barely
  // break the rectangle"). See `terrain.ts`'s module doc comment for why
  // this is a heightmap over the REAL, unchanged footprint rather than a
  // hand-built polygon: the mesh's own extent still spans `land.w x land.d`
  // end to end (the honest footprint, unchanged), and the organic silhouette
  // comes entirely from which parts of that same rectangle sink below the
  // waterline.
  // Resource-hygiene round: `buildTerrainGeometry` constructs a real
  // `THREE.BufferGeometry` directly — WE own the result,
  // not react-three-fiber (unlike the `<boxGeometry>`/`<coneGeometry>` JSX
  // below), so it needs an explicit `dispose()` or its GPU buffers leak the
  // moment a refetch (every window focus — see `App.tsx`) rebuilds this with
  // a genuinely different `land`/`view.root`. `useDisposableMemo` is a plain
  // `useMemo` plus that cleanup — see its own doc comment for the full
  // "who owns what" rule this whole round is built on.
  const terrainGeometry = useDisposableMemo(() => {
    if (!known) return null;
    return buildTerrainGeometry({
      seed: view.root,
      width: land.w,
      depth: land.d,
      moundHeight: SEA_MOUND_HEIGHT,
      beachDepth: SEA_BEACH_DEPTH,
      landColor: GROUND_COLOR,
      shadeColor: GRASS_SHADE_COLOR,
      lightColor: GRASS_LIGHT_COLOR,
      sandColor: SAND_COLOR,
      wetSandColor: WET_SAND_COLOR,
      cliffColor: CLIFF_COLOR,
      segments: SEA_TERRAIN_SEGMENTS,
    });
  }, [known, view.root, land.w, land.d]);

  // Item 5's vegetation, for this island: the SAME seeded mask/height
  // functions the terrain itself uses (so trees sit at the right elevation
  // and never sprout past the coastline into the water), plus an exclusion
  // circle per block pad so vegetation never grows through a house cluster.
  const vegetationHeightAt = useMemo(
    () => (u: number, v: number) => terrainHeight(view.root, u, v, SEA_MOUND_HEIGHT, SEA_BEACH_DEPTH),
    [view.root],
  );
  const vegetationLandMaskAt = useMemo(
    () => (u: number, v: number) => islandMask(view.root, u, v),
    [view.root],
  );
  const vegetationExclusions = useMemo(
    () => [
      ...pads.map(p => ({ x: p.x, z: p.z, radius: p.size * 0.85 })),
      ...lanes.map(p => ({ x: p.x, z: p.z, radius: Math.hypot(p.width, p.depth) / 2 })),
    ],
    [pads, lanes],
  );

  return (
    <group position={[land.x, 0, land.z]}>
      {/* This island's shallows. Scenery-craft round: the previous version
          of this was a vertex-coloured gradient plane whose OUTER colour was
          `WATER_COLOR` while the big ocean plane underneath it was at a
          different point of its OWN radial gradient at that spot — two
          gradients computed independently, meeting at a hard quad edge. The
          result was a visible teal rectangle around every island, plainly
          there in this round's "before" renders. (An earlier round found and
          fixed a real centring bug in the same mesh and reasonably believed
          that was the whole of the patchwork; it was not. A mispositioned
          quad and a mismatched quad look the same from a distance.)

          `IslandShallows` cannot do that: it fades its own alpha to exactly
          zero before its quad ends, so there is nothing at the boundary to
          mismatch. Everything else — the shelf bands, the wet-sand tone, the
          surf line — is evaluated per pixel from the SAME seeded coastline
          the terrain mesh above is shaped by, so the surf lands on the real
          shore. See `Water.tsx`. */}
      {/* This group's own origin is the land rectangle's CORNER (the
          convention `terrainGeometry` shares, translating its own geometry
          to span local `[0, land.w] x [0, land.d]`), and the shelf quad is
          built centred on ITS origin — so it has to be offset to the
          island's centre here. This is the same offset an earlier round
          found missing on the mesh this replaces. */}
      <group position={[land.w / 2, 0, land.d / 2]}>
        <IslandShallows
          seed={view.root}
          width={land.w}
          depth={land.d}
          y={-GROUND_THICKNESS - 0.04}
          colors={look.water ?? WATER_COLORS}
        />
      </group>

      {known ? (
        <>
          {/* The island itself — one organic, gently-mounded terrain mesh
              (items 3+4), with sand and foam baked into its own vertex
              colours right at the coastline it traces (see
              `buildTerrainGeometry`). Replaces the old union of overlapping
              rectangular "lobes" AND the separate flat sand `ShoreRing`. */}
          {terrainGeometry && (
            <mesh
              geometry={terrainGeometry}
              onClick={handleClick}
              onPointerOver={handleHoverIn}
              onPointerOut={handleHoverOut}
              receiveShadow
            >
              <meshStandardMaterial vertexColors roughness={1} transparent={dim} opacity={dim ? DIM_OPACITY : 1} />
            </mesh>
          )}
          {houses.length > 0 && (
            <MiniTown
              lanes={lanes}
              pads={pads}
              houses={houses}
              muted={unsettled}
              dim={dim}
              lit={attention === "working" || attention === "stopped"}
              onClick={handleClick}
              zoomRatioRef={zoomRatioRef}
            />
          )}
          {/* Item 5: decorative trees/rocks on this island's own unbuilt
              land — `pads` (the same real block footprints `MiniTown` draws
              its plazas on) are the exclusion zones, so vegetation only
              grows in the genuinely empty land around/between house
              clusters, never through one. */}
          <Vegetation
            identity={view.root}
            width={land.w}
            depth={land.d}
            heightAt={vegetationHeightAt}
            landMaskAt={vegetationLandMaskAt}
            exclusions={vegetationExclusions}
            opacity={dim ? DIM_OPACITY : 1}
          />
        </>
      ) : (
        <IslandFog
          land={land}
          dim={dim}
          onClick={handleClick}
          onPointerOver={handleHoverIn}
          onPointerOut={handleHoverOut}
        />
      )}

      {/* Activity-lens round: only ever present while the user has the lens
          switched on. Listed BEFORE the attention cues here to match the
          `renderOrder` hierarchy it actually draws in — age sits under
          everything that says "look at this one now". */}
      {activity !== null && (
        <ActivityRing land={land} bucket={activity} dim={dim} zoomRatioRef={zoomRatioRef} />
      )}

      {attention === "stopped" && (
        <>
          <StoppedHalo land={land} dim={dim} />
          <StoppedBeacon land={land} dim={dim} />
        </>
      )}
      {attention === "working" && <WorkingHalo land={land} dim={dim} />}
      {/* Game-feel round: "reward attention" — a one-shot flash the moment
          THIS island is actually witnessed going working/quiet → stopped
          (never on mount, even if it's already stopped when the page loads
          — see `justIgnited`'s own doc comment for why that distinction is
          an honesty rule, not just a taste choice). */}
      {justIgnited && <IgnitionPulse land={land} />}

      {/* Search-and-filter round: the "you found it" cue — a steady ring in
          a cool tone distinct from every attention colour above, so it can
          never be mistaken for "needs you." Only ever drawn while a filter
          is actually active AND this island passes it. */}
      {highlighted && <SearchMatchRing land={land} />}

      {agents.map((agent) => {
        const pos = villagerPositions.get(agent.pane_id);
        if (!pos) return null;
        return (
          <Villager
            key={agent.pane_id}
            x={pos.x}
            z={pos.z}
            groundY={pos.groundY}
            attention={agent.attention}
            seed={agent.pane_id}
            dim={dim}
            onClick={() => onVillagerClick(agent, seaIsland)}
            onHoverIn={(clientX, clientY) => onHover({ kind: "villager", agent, x: clientX, y: clientY })}
            onHoverOut={handleHoverOut}
          />
        );
      })}

      {/* A persistent name label only when there is something worth reading
          at a glance — an island with a live, non-calm story, or one whose
          city could not be measured (Item 6 wants the "unknown" fact
          visible, not just the fog shape), OR a search/state-filter match
          (search-and-filter round: at 150+ islands, a match must be
          nameable at a glance, not just ringed). A calm/no-agent island
          still shows its name on hover (`onHover` above drives the cursor
          tooltip) — this is purely about what's shown UNPROMPTED. At the
          author's real repository count (73 and climbing), labeling every
          calm island permanently is the "everything competes for attention"
          failure Item 2 warns against, one level up from beacons. */}
      {!recording && (shouldLabel(attention) || view.city.status === "unknown" || isHovered || highlighted) && (
        <Html
          position={[land.w / 2, known ? Math.max(1.4, ...houses.map(h => h.groundY + h.height + h.width * 0.55)) + 0.5 : 0.9, land.d / 2]}
          center
          style={{ pointerEvents: "none" }}
        >
          <div
            className="chart-tag"
            data-attention={attention ?? "none"}
          >
            {view.name} {attention !== null && <span className="chart-tag__mark">{ATTENTION_MARK[attention]}</span>}
            {view.city.status === "unknown" && <span> (unknown)</span>}
          </div>
        </Html>
      )}
    </group>
  );
}

/** Shared instancing keeps each island to three village draw calls:
 * paving (paths + foundations), walls, and roofs with baked fascia. */
function MiniTown({
  lanes,
  pads,
  houses,
  muted,
  dim,
  lit,
  onClick,
  zoomRatioRef,
}: {
  pads: (VillageLane & { size: number })[];
  houses: VillageHouse[];
  lanes: VillageLane[];
  /** Item 3: an unsettled island's massing reads as real content but a
   * quiet, un-lived-in one — muted wall/roof tones instead of the lively
   * palette a settled island's houses get, no other geometry change (the
   * building COUNT is still the same honest function of `district_count`;
   * only the colour says "nobody lives here yet"). */
  muted: boolean;
  /** Search-and-filter round: an active filter is hiding this island —
   * independent of `muted` (an unsettled island can ALSO be filtered out),
   * so both combine: `muted` still picks the wall/roof colour, `dim` only
   * lowers opacity. */
  dim: boolean;
  /** Agents are live here: at night (see `MoodLook.windows`) its windows glow. */
  lit: boolean;
  onClick: (event: ThreeEvent<MouseEvent>) => void;
  /** Water-fix round, item 2: read every frame to fade the PAD only (never
   * the walls/roofs — those must "stay saturated" at any distance, per the
   * coordinator's own instruction) via `padFadeOpacity`. */
  zoomRatioRef: RefObject<number>;
}) {
  const windows = useMood().look.windows;
  const glow = lit && windows !== null && !dim;
  const padRef = useRef<THREE.InstancedMesh>(null);
  const padMaterialRef = useRef<THREE.MeshStandardMaterial>(null);
  const wallRef = useRef<THREE.InstancedMesh>(null);
  const roofRef = useRef<THREE.InstancedMesh>(null);

  // Paths stay legible at overview scale and become fully opaque up close.
  useFrame(() => {
    const material = padMaterialRef.current;
    if (!material) return;
    const fade = Math.max(0.72, padFadeOpacity(zoomRatioRef.current));
    material.opacity = dim ? fade * DIM_OPACITY : fade;
  });

  useEffect(() => {
    const dummy = new THREE.Object3D();
    const pad = padRef.current;
    if (pad) {
      const paving = [...pads, ...lanes];
      paving.forEach((p, i) => {
        dummy.position.set(p.x, p.groundY + 0.035, p.z);
        dummy.rotation.set(-Math.atan(p.slopeZ), 0, Math.atan(p.slopeX));
        dummy.scale.set(p.width, 0.02, p.depth);
        dummy.updateMatrix();
        pad.setMatrixAt(i, dummy.matrix);
      });
      pad.instanceMatrix.needsUpdate = true;
      pad.computeBoundingSphere();
    }

    const wall = wallRef.current;
    const roof = roofRef.current;
    if (wall && roof) {
      const roofColor = new THREE.Color();
      const hsl = { h: 0, s: 0, l: 0 };
      houses.forEach((h, i) => {
        dummy.position.set(h.x, h.groundY + h.height / 2, h.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(h.width, h.height, h.depth);
        dummy.updateMatrix();
        wall.setMatrixAt(i, dummy.matrix);

        const roofHeight = h.width * (0.4 + (h.colorSeed % 3) * 0.07);
        dummy.position.set(h.x, h.groundY + h.height + roofHeight / 2, h.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(h.width * 1.14, roofHeight, h.depth * 1.14);
        dummy.updateMatrix();
        roof.setMatrixAt(i, dummy.matrix);


        if (muted) {
          roofColor.set(UNSETTLED_ROOF_COLOR);
        } else {
          roofColor.set(HOUSE_ROOF_PALETTE[h.colorSeed % HOUSE_ROOF_PALETTE.length]);
          roofColor.getHSL(hsl);
          // Keep the file-kind palette legible at miniature scale.
          roofColor.setHSL((hsl.h - 0.02 + 1) % 1, Math.min(1, hsl.s + 0.22), Math.max(0, hsl.l - 0.12));
        }
        roof.setColorAt(i, roofColor);
      });
      wall.instanceMatrix.needsUpdate = true;
      roof.instanceMatrix.needsUpdate = true;
      if (roof.instanceColor) roof.instanceColor.needsUpdate = true;
      wall.computeBoundingSphere();
      roof.computeBoundingSphere();
    }
  }, [pads, lanes, houses, muted]);

  return (
    <>
      {pads.length > 0 && (
        <instancedMesh ref={padRef} args={[undefined, undefined, pads.length + lanes.length]} onClick={onClick} receiveShadow>
          <boxGeometry args={[1, 1, 1]} />
          {/* No `opacity` prop here — it is driven ENTIRELY by the
              `useFrame` above via `padMaterialRef`. R3F reapplies any
              declared prop on every re-render of this component (which
              happens for reasons unrelated to zoom — world polling,
              search/filter state, ...), which would silently stomp the
              imperative per-frame value right back to a stale constant on
              the very next unrelated re-render. */}
          <meshStandardMaterial ref={padMaterialRef} color={PLOT_FILL} roughness={1} transparent />
        </instancedMesh>
      )}
      <instancedMesh
        ref={wallRef}
        args={[undefined, undefined, houses.length]}
        onClick={onClick}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial
          color={muted ? UNSETTLED_WALL_COLOR : WALL_BASE_COLOR}
          map={cottageFacadeTexture()}
          emissiveMap={cottageWindowMask()}
          emissive={glow ? windows.color : "#000000"}
          emissiveIntensity={glow ? windows.intensity : 0}
          roughness={0.85}
          metalness={0.04}
          transparent={dim}
          opacity={dim ? DIM_OPACITY : 1}
        />
      </instancedMesh>
      <instancedMesh
        ref={roofRef}
        args={[undefined, undefined, houses.length]}
        onClick={onClick}
        castShadow
        receiveShadow
      >
        <primitive object={gabledRoofGeometry()} attach="geometry" dispose={null} />
        <meshStandardMaterial vertexColors roughness={0.8} metalness={0} flatShading transparent={dim} opacity={dim ? DIM_OPACITY : 1} />
      </instancedMesh>
    </>
  );
}

/**
 * A `CityStatus::Unknown` island (Item 6): a small, fixed, grey fog blob —
 * NEVER the plot's own reserved size, which is a stability placeholder, not
 * a measurement (see `landRect`'s doc comment). No massing, no villagers'
 * "town" backdrop — just an honest "we could not measure this."
 */
function IslandFog({
  land,
  dim,
  onClick,
  onPointerOver,
  onPointerOut,
}: {
  land: { w: number; d: number };
  /** Search-and-filter round: same recede-not-remove treatment as every
   * other island layer. */
  dim: boolean;
  onClick: (event: ThreeEvent<MouseEvent>) => void;
  onPointerOver: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut: () => void;
}) {
  return (
    <group>
      <mesh
        position={[land.w / 2, 0.3, land.d / 2]}
        onClick={onClick}
        onPointerOver={onPointerOver}
        onPointerOut={onPointerOut}
        castShadow
      >
        <sphereGeometry args={[Math.max(land.w, land.d) * 0.55, 12, 8]} />
        <meshStandardMaterial color={FOG_COLOR} transparent opacity={dim ? DIM_OPACITY * 0.55 : 0.55} roughness={1} />
      </mesh>
      <Html position={[land.w / 2, 1.1, land.d / 2]} center style={{ pointerEvents: "none" }}>
        <div style={{ color: "#e6e9ef", font: "bold 16px sans-serif", opacity: 0.85 }}>?</div>
      </Html>
    </group>
  );
}

/**
 * The dominant attention cue (Item 2), part 1 of 2 (see `StoppedHalo` for
 * the other half): a bright, tall, gently pulsing beam with a lamp-like
 * flare at its top. This is the ONLY animated geometry in the whole scene —
 * everything else (working/unknown/quiet markers, villagers, massing) is
 * static, so the one thing that moves is the one thing that must draw the
 * eye.
 *
 * Sized against an ABSOLUTE floor, not just a fraction of the island's own
 * (possibly tiny, relative to the whole sea) footprint — coordinator review:
 * "On pocketAlarm it is a thin orange stick I had to hunt for... at 73
 * islands, it is invisible." A beacon sized purely as a fraction of one
 * island's own land could shrink into the same trap as the villagers did;
 * the floor here (`14` world units tall, clamped scale up to `3.5`) is
 * deliberately large enough to compete with an island's own massing at
 * ANY of the author's real land sizes (18..101 grid units wide).
 */
/**
 * The "reward attention" flash (game-feel round): one expanding, fading
 * ring, played ONCE, the moment an island is witnessed going stopped — the
 * coordinator's own instruction that "that is the game's one genuinely
 * important event and right now it just quietly appears." Deliberately a
 * SEPARATE, temporary effect layered on top of `StoppedHalo`/`StoppedBeacon`
 * (which keep pulsing calmly for as long as the island stays stopped) rather
 * than a permanent change to their own animation — the moment of ignition
 * should read as more dramatic than the steady-state "still needs you," the
 * same way a real notification is louder at the instant it arrives than
 * however long it sits unread afterward.
 */
export function IgnitionPulse({ land }: { land: { w: number; d: number } }) {
  const ref = useRef<THREE.Mesh>(null);
  const t0Ref = useRef<number | null>(null);
  // Art-direction round: starts at the island's own half-diagonal (same fix,
  // same reason, as `StoppedHalo` just above) rather than a fraction of
  // `min(w, d)` — the old radius sat WELL inside the terrain's own footprint
  // for most islands, so the ring's initial (small) frames z-fought against
  // the now-undulating coastline before growing past it. Scaling is uniform
  // from the origin (`mesh.scale.set(scale, scale, scale)` below), so
  // starting at/outside the footprint keeps every later, larger frame
  // outside it too.
  const radius = Math.hypot(land.w / 2, land.d / 2) + 1.5;
  // CRITICAL 2 (Opus frontend review): this used to call `invalidate()`
  // unconditionally on every tick. Under r3f 9.7 that is self-sustaining —
  // `invalidate()` sets `internal.frames = 2`, the next `update()` decrements
  // it to 1, and the frame this callback runs in sets it back to 2 — which
  // never lets `frameloop="demand"` (what `windowFocused` switches to on
  // blur, see `App.tsx`) actually go idle. `Water.tsx` (see its own doc
  // comment) already proves the correct pattern: a plain
  // `useFrame` with no explicit `invalidate()` call, so this only actually
  // animates while `frameloop="always"` — exactly the focused-only
  // continuous-render authorization this component must respect too.
  useFrame(({ clock }) => {
    if (t0Ref.current === null) t0Ref.current = clock.elapsedTime;
    const t = Math.min(1, (clock.elapsedTime - t0Ref.current) / (IGNITION_MS / 1000));
    const mesh = ref.current;
    if (mesh) {
      // Ease out: the ring leaves fast and settles, and is mostly faded by
      // the time it is large — a linear fade left a wide flat band on screen.
      const eased = 1 - (1 - t) ** 3;
      const scale = 1 + eased * 5;
      mesh.scale.set(scale, scale, scale);
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity = 0.85 * (1 - t) ** 2;
    }
  });
  return (
    <mesh
      ref={ref}
      position={[land.w / 2, -GROUND_THICKNESS - 0.04, land.d / 2]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={6}
    >
      <ringGeometry args={[radius, radius * 1.25, 40]} />
      {/* `depthTest={false}` — same reason as `StoppedHalo`'s own: this ring
          scales up to 6x its starting radius during the flash and can reach
          a neighbouring island's terrain well before it fades out. */}
      <meshBasicMaterial
        color={STOPPED_FLARE_COLOR}
        transparent
        opacity={0.85}
        toneMapped={false}
        depthWrite={false}
        depthTest={false}
        blending={THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export function StoppedBeacon({ land, dim }: { land: { w: number; d: number }; dim: boolean }) {
  const poleRef = useRef<THREE.Mesh>(null);
  const flareRef = useRef<THREE.Mesh>(null);
  const scale = Math.min(3.5, Math.max(1.4, Math.min(land.w, land.d) * 0.09));
  const height = 3 + scale * 2;
  // CRITICAL 2 (Opus frontend review) — see `IgnitionPulse`'s doc comment
  // for the full explanation: no explicit `invalidate()` call, so this only
  // animates while `frameloop="always"` (window focused) instead of forcing
  // it forever.
  useFrame(({ clock }) => {
    const pulse = 1 + Math.sin(clock.elapsedTime * 2.2) * 0.1;
    const flarePulse = 1 + Math.sin(clock.elapsedTime * 2.2) * 0.28;
    if (poleRef.current) poleRef.current.scale.set(pulse, 1, pulse);
    if (flareRef.current) flareRef.current.scale.set(flarePulse, flarePulse, flarePulse);
  });
  // Search-and-filter round: still visibly "stopped" (this is real, current
  // state, never hidden outright), just toned down like the rest of a
  // filtered-out island — see `DIM_OPACITY`'s doc comment.
  const poleOpacity = dim ? 0.9 * DIM_OPACITY : 0.9;
  const flareOpacity = dim ? 0.95 * DIM_OPACITY : 0.95;
  return (
    <group position={[land.w / 2, 0, land.d / 2]}>
      <mesh ref={poleRef} position={[0, height / 2, 0]} castShadow>
        <cylinderGeometry args={[0.055 * scale, 0.085 * scale, height, 8]} />
        <meshBasicMaterial color={STOPPED_COLOR} toneMapped={false} transparent opacity={poleOpacity} />
      </mesh>
      {/* A brighter flare at the top — the "lighthouse lamp" — so this reads
          as a distinct point of light from far across the sea, not just a
          thin coloured line easy to miss at a glance (Item 2: "must
          dominate"). */}
      <mesh ref={flareRef} position={[0, height, 0]}>
        <sphereGeometry args={[0.3 * scale, 12, 8]} />
        <meshBasicMaterial color={STOPPED_FLARE_COLOR} toneMapped={false} transparent opacity={flareOpacity} />
      </mesh>
    </group>
  );
}

/**
 * The dominant attention cue, part 2: a wide, pulsing amber glow tinting
 * the water around a stopped island — guaranteed to scale with something
 * ALREADY real and sizable (the island's own land, plus a generous fixed
 * margin), so it reads at distance regardless of how small `StoppedBeacon`
 * looks against a very wide camera fit. `depthWrite={false}` so it never
 * fights the global `Sea` plane it sits just above for depth-buffer
 * precedence.
 *
 * Art-direction round: this USED to be a filled square (`planeGeometry`)
 * overlapping the island's own footprint, sitting at a fixed Y this file's
 * own old doc comment called "an ambiguity StoppedHalo tolerates" against
 * the (then perfectly flat) land box. Items 3+4 made the land itself an
 * undulating, organically-receding mound (`terrain.ts`) — a fixed Y now
 * crosses that mound's own surface somewhere between its peak and its
 * submerged edge, and a filled plane z-fights against that crossing in a
 * jagged contour instead of blending cleanly (confirmed by rendering with
 * this component disabled — the jagged pale artifact disappeared entirely).
 * `SearchMatchRing` below already solved the exact same "glow belongs in
 * the water, not fighting the coastline" problem correctly, for the same
 * reason — a RING starting OUTSIDE the island's own half-diagonal never
 * shares any (x, z) with the terrain mesh at all, so there is no surface
 * left to fight regardless of how the coastline undulates. This follows
 * that same pattern rather than inventing a second one.
 *
 * Halo-and-camera round: the ring is no longer a CONSTANT-alpha annulus.
 * It has a solid rim just off the coastline that falls away to nothing
 * before its own outer edge (`buildAttentionHaloGeometry`), and it mixes
 * into the water normally rather than adding to it (see the material's own
 * comment). Measured on the real 73-island render: every pixel of the old
 * version came out at hue 167 deg / 32% saturation — a flat cyan-green, 131
 * degrees away from the `#e0a44b` it is drawn in — against hue 38 deg / 59%
 * for the new rim, which is within two degrees of the source colour.
 */
export function StoppedHalo({ land, dim }: { land: { w: number; d: number }; dim: boolean }) {
  return <AttentionHalo land={land} dim={dim} color={STOPPED_COLOR} reach={0.22} opacity={0.42} swing={0.08} speed={2.2} renderOrder={5} />;
}

/**
 * "Someone is busy here," readable from across the sea — Herdr's orange
 * working dot at island scale. Same ring in the water as `StoppedHalo`, but
 * deliberately the quieter of the two: a narrower reach, about half the
 * opacity, and a slow breath rather than a pulse, so a sea full of working
 * agents never out-shouts the one that is waiting for the user.
 */
export function WorkingHalo({ land, dim }: { land: { w: number; d: number }; dim: boolean }) {
  return <AttentionHalo land={land} dim={dim} color={WORKING_COLOR} reach={0.12} opacity={0.24} swing={0.07} speed={1.1} renderOrder={4} />;
}

function AttentionHalo({
  land,
  dim,
  color,
  reach,
  opacity,
  swing,
  speed,
  renderOrder,
}: {
  land: { w: number; d: number };
  dim: boolean;
  color: string;
  /** How far past the coast the glow spreads, as a fraction of the island. */
  reach: number;
  /** Mean opacity, and how far the animation swings it either way. */
  opacity: number;
  swing: number;
  /** Angular speed of that swing, radians per second. */
  speed: number;
  renderOrder: number;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const halfDiagonal = Math.hypot(land.w / 2, land.d / 2);
  const inner = halfDiagonal + 1.5;
  // Narrower than the old square's reach (`*3+30`) — a dense cluster of 152
  // islands means a wide ring can still geometrically reach a NEIGHBOUR
  // island's own organic terrain (not just this one's), which would
  // reintroduce the exact same crossing artifact one island over.
  // `depthTest={false}` below is the actual fix for that (same as
  // `SearchMatchRing`'s own, already-correct pattern); this narrower reach
  // just keeps the glow visually anchored to ITS island rather than washing
  // across half the sea.
  const outer = inner + Math.max(land.w, land.d) * reach + 2;
  // The solid rim. Proportional to the island (so it reads the same on a
  // 18-unit plot and a 101-unit one) with an absolute floor, the same
  // shape of rule `StoppedBeacon`'s own height uses and for the same
  // reason: a purely proportional band vanishes on the sea's smallest
  // islands, which are exactly the ones hardest to find.
  const rim = Math.min(inner + Math.max(0.6, halfDiagonal * 0.07), outer);
  const geometry = useDisposableMemo(
    () => buildAttentionHaloGeometry({ inner, rim, outer }),
    [inner, rim, outer],
  );
  // CRITICAL 2 (Opus frontend review) — see `IgnitionPulse`'s doc comment:
  // no explicit `invalidate()` call, so this only animates while
  // `frameloop="always"` instead of forcing it forever.
  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (mesh) {
      const material = mesh.material as THREE.MeshBasicMaterial;
      const pulse = opacity + Math.sin(clock.elapsedTime * speed) * swing;
      material.opacity = dim ? pulse * DIM_OPACITY : pulse;
    }
  });
  return (
    <mesh
      ref={ref}
      geometry={geometry}
      position={[land.w / 2, -GROUND_THICKNESS - 0.045, land.d / 2]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={renderOrder}
    >
      {/* Normal alpha blending, NOT the additive blending this used until
          the scenery-craft round replaced the sea.

          Additive was the right call against the OLD sea and is the wrong
          one against this one, for a reason that is arithmetic rather than
          taste. Adding amber (high R, mid G, near-zero B) to a mid-luminance
          ground raises R and G and leaves B where it was; over the old pale
          olive-turquoise that landed somewhere warm, but over the new deep
          saturated blue it lands on roughly equal R, G and B — a flat
          grey-green disc, which is exactly what it rendered as (visible
          around `pocketAlarm` in `/tmp/aoa-scenery-shots/after-sea-wide.png`).
          No amount of extra saturation in the ADDED colour fixes that,
          because the sea's own blue survives the add untouched and is what
          desaturates the result. Interpolating toward amber instead REPLACES
          that blue, and the failure mode normal blending used to have (a
          muddy teal-green "patch of algae") was a property of the saturated
          turquoise it was mixing with, not of normal blending.

          `depthTest={false}` (paired with `renderOrder`, same pattern
          `SearchMatchRing` already uses): the ring's own geometry keeps it
          off THIS island's terrain, but at 152 islands its outer edge can
          still geometrically reach a neighbour's — depth-testing against
          that neighbour's own undulating surface is exactly the crossing
          artifact this component used to have. A soft glow occasionally
          crossing a nearby island's shoreline reads as "glow," not as
          broken geometry, which jagged z-fighting did. */}
      <meshBasicMaterial
        color={color}
        vertexColors
        transparent
        opacity={0.9}
        toneMapped={false}
        depthWrite={false}
        depthTest={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/**
 * Search-and-filter round: the "you found it" cue for a search/state-filter
 * match — a steady (non-pulsing, unlike `StoppedHalo`) ring drawn in the
 * water just outside the coastline, in a tone (`SEARCH_MATCH_COLOR`) that
 * appears nowhere else in this scene. Deliberately NOT animated: this is
 * "here is the one you were looking for," not an urgency cue competing with
 * the amber "needs you" beacon — the two must never be confused, so they
 * don't even share a behaviour, only the "draw it in the water around the
 * island" placement.
 *
 * The radius is the island's own HALF-DIAGONAL (not `min(w, d)`, an earlier
 * version's bug caught by actually rendering it — a circle sized off the
 * SHORTER side of a non-square island sat INSIDE the island's own longer
 * edge, cutting through its own massing instead of surrounding it) plus a
 * fixed margin, so the ring fully encloses the coastline regardless of the
 * island's aspect ratio. `depthTest={false}` renders it unconditionally on
 * top — a UI "you are looking at this" marquee, not a lit surface competing
 * for depth-buffer precedence with the shallow-water plane sitting just
 * above it in Y (the same ambiguity `StoppedHalo` above tolerates because
 * amber blends acceptably either way; magenta must always win outright).
 */
function SearchMatchRing({ land }: { land: { w: number; d: number } }) {
  const halfDiagonal = Math.sqrt((land.w / 2) ** 2 + (land.d / 2) ** 2);
  const inner = halfDiagonal + 3;
  const thickness = Math.max(2.5, halfDiagonal * 0.12);
  return (
    <mesh
      position={[land.w / 2, -GROUND_THICKNESS - 0.05, land.d / 2]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={10}
    >
      <ringGeometry args={[inner, inner + thickness, 48]} />
      <meshBasicMaterial
        color={SEARCH_MATCH_COLOR}
        transparent
        opacity={0.95}
        toneMapped={false}
        depthWrite={false}
        depthTest={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/**
 * A flat annulus in the XY plane (the caller lays it flat with the same
 * `rotation={[-Math.PI / 2, 0, 0]}` every other water-level ring here uses),
 * optionally BROKEN into evenly spaced arcs.
 *
 * `three.js`'s own `RingGeometry` can only make a solid annulus, and the
 * activity lens needs one shape that is unmistakably not a position on its
 * colour ramp — see `ActivityRing` below for why "no known date" has to look
 * different in KIND rather than merely in colour.
 *
 * @param arcs how many dashes the ring is broken into (`1` = a solid ring)
 * @param duty what fraction of each dash's slot is drawn (`1` = solid)
 */
export function buildActivityRingGeometry({
  inner,
  outer,
  arcs = 1,
  duty = 1,
  segmentsPerArc = 48,
}: {
  inner: number;
  outer: number;
  arcs?: number;
  duty?: number;
  segmentsPerArc?: number;
}): THREE.BufferGeometry {
  const slot = (Math.PI * 2) / arcs;
  const span = slot * duty;
  const cols = segmentsPerArc + 1;
  const positions = new Float32Array(arcs * cols * 2 * 3);
  const indices: number[] = [];
  let v = 0;
  for (let a = 0; a < arcs; a++) {
    const base = a * slot;
    const first = v;
    for (let s = 0; s <= segmentsPerArc; s++) {
      const theta = base + (span * s) / segmentsPerArc;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      positions[v * 3] = cos * inner;
      positions[v * 3 + 1] = sin * inner;
      positions[v * 3 + 2] = 0;
      v += 1;
      positions[v * 3] = cos * outer;
      positions[v * 3 + 1] = sin * outer;
      positions[v * 3 + 2] = 0;
      v += 1;
    }
    for (let s = 0; s < segmentsPerArc; s++) {
      const i = first + s * 2;
      indices.push(i, i + 1, i + 2, i + 2, i + 1, i + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * The activity lens's per-island mark (see `activityLens.ts` for the whole
 * argument — which signal, which buckets, and why this is opt-in): a ring in
 * the water just off the coastline, coloured by how long ago this repository
 * was last committed to.
 *
 * Only ever rendered while the lens is switched ON, so the sea's default
 * picture — the one whose entire job is making the ONE island that needs the
 * human jump out — is byte-for-byte unchanged by this feature existing.
 *
 * How it stays out of the attention language's way:
 *
 * - **Colour.** The whole ramp lives in violet, a band nothing else in this
 *   product uses (`ACTIVITY_COLOR`'s own doc comment lists what owns what).
 *   Age can never be misread as amber "needs you" or azure "working".
 * - **Layer.** `renderOrder={4}` puts it UNDERNEATH `StoppedHalo` (5),
 *   `IgnitionPulse` (6) and `SearchMatchRing` (10), all of which draw with
 *   `depthTest={false}` like this one — so wherever an attention cue and an
 *   age ring occupy the same pixel, the attention cue paints last and wins.
 *   The hierarchy is enforced by draw order, not by hoping the colours
 *   happen not to collide.
 * - **Behaviour.** Steady, never pulsing. In this scene motion means "look
 *   at me now" and belongs exclusively to the stopped beacon and the
 *   ignition flash.
 * - **Presence.** Every bucket is drawn at the same opacity and the same
 *   thickness. A dormant island is not faded, thinned or hidden — it is a
 *   different colour, nothing more. Making "old" mean "faint" would reuse
 *   the search filter's recede language AND quietly editorialise about
 *   projects that are perfectly fine as they are.
 *
 * `"unknown"` — `last_changed_at` is genuinely `null` (no commits, not a
 * repository, or the git call failed) — is drawn as a BROKEN ring in a
 * neutral slate, off the ramp entirely. A missing date must not be able to
 * read as "very old" (the darkest step) or "brand new" (the lightest), and
 * a colour alone, on a ramp, cannot carry "we don't know" — the shape has to
 * differ. It is distinct from the "unmeasured city" fog for the same reason
 * it has to be: the fog is a grey BLOB ON the island saying "we could not
 * measure how big this repository is"; this is a broken ring in the water
 * saying "we could not date its last commit". Two different unknowns, two
 * different marks, and an island can legitimately wear both at once.
 */
function ActivityRing({
  land,
  bucket,
  dim,
  zoomRatioRef,
}: {
  land: { w: number; d: number };
  bucket: ActivityBucket;
  dim: boolean;
  /** The shared zoom ratio `ZoomTracker` writes once per frame for the
   * whole scene — read here to fade the ring back as the camera comes in
   * (see `activityRingOpacity`). Same ref, same single source of truth,
   * that `MiniTown`'s pads and `Vegetation` already read. */
  zoomRatioRef: RefObject<number>;
}) {
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => {
    const material = materialRef.current;
    if (!material) return;
    const fade = activityRingOpacity(zoomRatioRef.current);
    material.opacity = dim ? fade * DIM_OPACITY : fade;
  });
  // Half-diagonal, not `min(w, d)` — the same bug `SearchMatchRing`'s own
  // doc comment records being caught by rendering it: a circle sized off the
  // shorter side of a non-square island sits INSIDE its own longer edge and
  // cuts through the massing instead of surrounding it.
  const halfDiagonal = Math.hypot(land.w / 2, land.d / 2);
  const inner = halfDiagonal + 1;
  // Proportional with BOTH a floor and a ceiling. The author's real
  // repositories span half-diagonals of 2.5 to 93.8 grid units — a 37x
  // range — so a purely proportional ring is either invisible on his
  // smallest repository or a painted moat around his largest. The floor is
  // the same reasoning `StoppedBeacon`'s own absolute height floor
  // documents; the ceiling is new here only because this ring is drawn for
  // every island at once rather than for the one that needs attention.
  const thickness = Math.min(6.5, Math.max(2.2, halfDiagonal * 0.085));
  const unknown = bucket === "unknown";
  const geometry = useDisposableMemo(
    () =>
      buildActivityRingGeometry(
        unknown
          ? { inner, outer: inner + thickness, arcs: 12, duty: 0.5, segmentsPerArc: 4 }
          : { inner, outer: inner + thickness, segmentsPerArc: 48 },
      ),
    [inner, thickness, unknown],
  );
  return (
    <mesh
      geometry={geometry}
      position={[land.w / 2, -GROUND_THICKNESS - 0.05, land.d / 2]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={4}
    >
      {/* `depthTest={false}`, the same already-proven pattern
          `SearchMatchRing` and `StoppedHalo` use: at 152 islands a ring's
          own plot is roomy but the sea is dense, and depth-testing a flat
          ring against a neighbour's undulating terrain is exactly the
          jagged crossing artifact both of those components were changed to
          avoid. Paired with `renderOrder` above, which is what actually
          keeps every attention cue on top of this. */}
      {/* No `opacity` prop — it is driven ENTIRELY by the `useFrame` above
          (zoom fade, times the search filter's `DIM_OPACITY` when this
          island is filtered out). Declaring it here as well would let R3F
          stomp the imperative per-frame value back to a stale constant on
          the next unrelated re-render, exactly the trap `MiniTown`'s pad
          material documents. */}
      <meshBasicMaterial
        ref={materialRef}
        color={ACTIVITY_COLOR[bucket]}
        transparent
        toneMapped={false}
        depthWrite={false}
        depthTest={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/**
 * A villager (Item 5, coordinator review): rendered as a fixed-CSS-size
 * `Html` marker rather than a 3D mesh, specifically because a 3D figure
 * shrinks to sub-pixel — and therefore becomes unclickable — the moment the
 * camera pulls back far enough to see the whole (73-island, and growing)
 * sea. An `Html` marker's on-screen size is independent of `camera.zoom`,
 * so it stays exactly as legible, and exactly as clickable (a real DOM
 * element, no raycasting against a shrunken hit-box) at any distance —
 * "a marker that stays readable," per the brief's own second option. It is
 * still anchored to the villager's real, deterministic `(x, z)` position on
 * the island (Item 3), so it still reads as standing in a specific place,
 * not as a fixed HUD icon.
 */
function Villager({
  x,
  z,
  groundY,
  attention,
  seed,
  dim,
  onClick,
  onHoverIn,
  onHoverOut,
}: {
  x: number;
  z: number;
  /** Art-direction round: the island's own terrain height at this exact
   * (already coastline-safe) position — without this a villager would stand
   * at a fixed y=0.3 regardless of the mound beneath it, visibly floating
   * or sinking depending on where on the island it landed. */
  groundY: number;
  attention: Attention;
  /** The agent's own `pane_id` — used ONLY to phase-offset the idle bob
   * below (see `.villager-marker`'s CSS animation in `styles.css`) so a
   * multi-agent island's villagers don't all bob in lockstep. Never a
   * fabricated identity of its own; purely decorative timing, the same
   * "function of real identity, not random" rule `city.ts`'s `tintFor`
   * already follows for buildings. */
  seed: string;
  /** Search-and-filter round: this villager's island is filtered out —
   * recede to one flat, uniform tone (never the real attention colour,
   * which would still compete for attention) and lower opacity, same as
   * every other layer on a dimmed island. */
  dim: boolean;
  onClick: () => void;
  onHoverIn: (clientX: number, clientY: number) => void;
  onHoverOut: () => void;
}) {
  const color = dim
    ? DIM_VILLAGER_COLOR
    : attention === "stopped"
      ? STOPPED_COLOR
      : attention === "working"
        ? WORKING_COLOR
        : attention === "unknown"
          ? UNKNOWN_COLOR
          : QUIET_VILLAGER_COLOR;
  // Game-feel round: "villagers that idle rather than stand frozen... small,
  // cheap, and the difference between a diorama and a world." A CSS
  // `animation-delay` costs nothing extra to render (no `useFrame`, no
  // per-frame React work) and a NEGATIVE delay (see `styles.css`) starts
  // each villager already mid-cycle at a different phase.
  const delay = -((hashString(seed) % 2600) / 1000);
  // Herdr's shapes as well as its colours: finished-and-seen (`quiet`) is a
  // hollow ring, everything else a filled dot. A dimmed villager is always a
  // flat dot — its whole point is to stop saying anything.
  const hollow = !dim && attention === "quiet";
  const working = !dim && attention === "working";
  return (
    <Html position={[x, groundY + 0.3, z]} center style={{ pointerEvents: "auto" }} zIndexRange={[10, 0]}>
      <div
        className={`villager-marker${working ? " villager-marker--working" : ""}`}
        data-attention={attention}
        onClick={onClick}
        onPointerEnter={(event) => onHoverIn(event.clientX, event.clientY)}
        onPointerLeave={onHoverOut}
        style={{
          width: 18,
          height: 18,
          boxSizing: "border-box",
          borderRadius: "50%",
          background: hollow ? "rgba(16, 32, 26, 0.35)" : color,
          border: hollow ? `3.5px solid ${color}` : "2px solid rgba(255, 250, 235, 0.9)",
          boxShadow: hollow
            ? "0 0 0 1.5px rgba(255, 250, 235, 0.85), 0 2px 4px rgba(20, 16, 10, 0.5)"
            : "0 2px 4px rgba(20, 16, 10, 0.5)",
          cursor: "pointer",
          animationDelay: `${delay}s`,
          opacity: dim ? DIM_OPACITY + 0.15 : 1,
        }}
      />
    </Html>
  );
}

// ---------------------------------------------------------------------
// The sea itself, lighting, and the top-level scene.
// ---------------------------------------------------------------------

/**
 * The big background ocean. Art-direction round: replaces the previous
 * flat-colour, roughness-pulse-only plane with `Water.tsx`'s real animated
 * gradient (item 2) — the coordinator's own explicit authorization is what
 * makes the real vertex-displaced waves possible: "I am authorising a
 * continuous render loop while the window is focused... A dead-still sea is
 * a diorama; a moving one is a place." See `useWindowFocused.ts` for the
 * other half (pausing while unfocused/hidden) that makes this affordable.
 */
function Sea({ bounds }: { bounds: THREE.Box3 }) {
  const water = useMood().look.water ?? WATER_COLORS;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  // Scenery-craft round, `8.0 + 800` up from `1.4 + 40`. Two renders drove
  // this: at the DEFAULT framing (which since the framing round centres on
  // one island, not the archipelago) the old plane's far corner fell inside
  // the frame and showed a wedge of bare sky dome, and at FULL zoom-out
  // (`MIN_ZOOM_FACTOR` lets the camera see about twice the fitted extent)
  // the plane's whole diamond silhouette was visible against the sky. Sized
  // to clear both, with margin. Free, now that the plane is four vertices
  // rather than 2,401.
  const waterSize = Math.max(size.x, size.z) * 8 + 800;
  return (
    <OpenWater
      center={{ x: center.x, z: center.z }}
      y={-GROUND_THICKNESS - 0.06}
      size={waterSize}
      colors={water}
    />
  );
}

/**
 * The activity lens's own switch, plus the legend it needs while it is on.
 *
 * The legend shows the real count in each bucket beside its swatch. That is
 * a distribution, not a score: it answers "how much of my world is which
 * age" at a glance without making him count rings, it is not stored, not
 * compared against any previous value, and nothing in the app reacts to it.
 * The labels are dates and nothing else — "over a year" is a fact, and this
 * app is not permitted to have an opinion about it (principle 5, "nothing
 * rewards being a worse engineer", and principle 6, "threats attack the
 * code, never your attendance").
 *
 * The sentence under the swatches is load-bearing rather than decoration:
 * this channel's whole authority is that it reports git, so it has to say
 * so. It is also the honest answer to "does this still work when herdr
 * isn't running" — it does, because no part of it reads the live world.
 */
function ActivityLensControl({
  enabled,
  onToggle,
  counts,
  total,
}: {
  enabled: boolean;
  onToggle: () => void;
  counts: Record<ActivityBucket, number>;
  /** How many islands the archipelago actually has — `0` before it loads,
   * in which case the legend shows no counts at all rather than a
   * fabricated row of zeroes. */
  total: number;
}) {
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="chart-round"
        onClick={onToggle}
        aria-pressed={enabled}
        aria-label="Activity lens: last commit age"
        title={enabled ? "Hide last-commit age" : "Show how long ago each repository was last committed to"}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>
      {enabled && (
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 66,
            width: 168,
            background: "rgba(28, 22, 34, 0.9)",
            color: "#efe7f7",
            border: "1px solid #6c2fae",
            borderRadius: 8,
            padding: "8px 10px",
            font: "11px -apple-system, system-ui, sans-serif",
            boxShadow: "0 2px 6px rgba(20, 16, 10, 0.35)",
          }}
        >
          <div style={{ opacity: 0.75, marginBottom: 6 }}>last commit</div>
          {ACTIVITY_BUCKET_ORDER.map((bucket) => (
            <div
              key={bucket}
              style={{ display: "flex", alignItems: "center", gap: 7, lineHeight: "17px" }}
            >
              <span
                aria-hidden
                style={{
                  width: 11,
                  height: 11,
                  flex: "0 0 auto",
                  borderRadius: "50%",
                  // The "no known date" swatch is a HOLLOW, dashed circle,
                  // matching the broken ring the sea draws for it — so the
                  // legend teaches the shape difference, not just a
                  // seventh colour on what is otherwise a six-step ramp.
                  background: bucket === "unknown" ? "transparent" : ACTIVITY_COLOR[bucket],
                  border: bucket === "unknown" ? `1px dashed ${ACTIVITY_COLOR[bucket]}` : "none",
                }}
              />
              <span style={{ flex: "1 1 auto" }}>{ACTIVITY_LABEL[bucket]}</span>
              {total > 0 && <span style={{ opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>{counts[bucket]}</span>}
            </div>
          ))}
          <div style={{ opacity: 0.6, marginTop: 7, lineHeight: "14px" }}>
            from each repository&rsquo;s own git history — no agent needed
          </div>
        </div>
      )}
    </div>
  );
}

export function Archipelago({
  archipelago,
  islands,
  onOpenIsland,
  flyToRequest,
  frameloop = "demand",
  preserveDrawingBuffer = false,
  focusRoot,
  autoSelectRoot,
  autoOpenSendAgent,
  autoOpenTerminal,
  autoExpandPaneId: autoExpandPaneIdProp,
  autoVillagerClickPaneId,
  searchQuery = "",
  stateFilter = "all",
}: ArchipelagoProps) {
  const tradeRoutes = useTradeRoutes();
  const seaIslands = useMemo(() => joinArchipelago(archipelago, islands), [archipelago, islands]);
  // Search-and-filter round: whether a name query and/or state filter is
  // actually narrowing the sea right now — an inactive filter must render
  // EXACTLY as the unfiltered sea always has (never merely "everything
  // happens to match"), and islands must never move when a filter is
  // applied/cleared (`isFilterActive`'s own doc comment; positions come
  // entirely from `archipelago`/`joinArchipelago` above, untouched by
  // either prop).
  const filterActive = useMemo(() => isFilterActive(searchQuery, stateFilter), [searchQuery, stateFilter]);
  // Latest live world snapshot, read (never a dependency) by the DEFAULT
  // focus pick below — see `bounds`'s own comment for why "which island is
  // the default" must only be recomputed when `archipelago` itself changes,
  // never on every world-poll tick, even though the priority rule that picks
  // it (stopped agent, then most-recently-changed, then largest) needs live
  // attention/recency data to answer.
  const islandsRef = useRef(islands);
  islandsRef.current = islands;
  // `get_world` (fast, an in-memory herdr read) and `get_archipelago` (slow,
  // real git calls across every repository — "~450ms across the author's
  // five real repositories" per `useArchipelago`'s own doc comment) are
  // independent fetches kicked off concurrently on mount, so in the common
  // case `islands` is already populated by the time `archipelago` first
  // resolves. But that ordering is not guaranteed, and the DEFAULT bounds
  // memo below only reads `islandsRef.current` (never depends on `islands`,
  // per its own comment) — so if the world genuinely arrived AFTER the first
  // `archipelago`, that first pick would freeze on a "no attention data yet"
  // snapshot and never notice a stopped agent that was already there.
  // `worldEpoch` bumps exactly once, the first time `islands` goes from
  // empty to populated, giving `bounds` one guaranteed extra look at live
  // attention data without ever re-fitting on ordinary world ticks after
  // that (a genuinely empty world — no live agents at all — never flips
  // this, which is correct: there is no "stopped" to have missed).
  const [worldEpoch, setWorldEpoch] = useState(0);
  const sawWorldRef = useRef(false);
  useEffect(() => {
    if (!sawWorldRef.current && islands.length > 0) {
      sawWorldRef.current = true;
      setWorldEpoch((e) => e + 1);
    }
  }, [islands]);
  // The FULL sea, in world units — the fallback `bounds` below uses when
  // there is no default focus island (an empty/unresolvable sea; see the
  // coordinator's explicit "never the geometric centre of an empty sea"),
  // and the basis for `outerBounds` further down. Depends on `archipelago`
  // alone, same reasoning as `bounds`.
  const fullSeaBounds = useMemo(() => boundsToBox3(archipelago), [archipelago]);
  // Deliberately depends on `archipelago` ALONE, not `islands` — the sea's
  // camera must not re-fit (and silently undo the user's own pan/zoom) every
  // time the live world ticks, which is far more often than a repository's
  // own plot ever changes. Mirrors `TownView.CameraRig`'s own documented
  // "does NOT re-fit on a resize alone" reasoning, one level up.
  //
  // Framing round (coordinator review): the DEFAULT camera framing used to
  // BE `fullSeaBounds` (the whole archipelago) — fitting all of it into one
  // frame means "each island is roughly 40 pixels and each building is
  // about 2 ... nothing survives that. The first thing the author sees on
  // launch is the one composition where the game cannot look good." The
  // first thing he sees now is instead a TIGHT bounds around a handful of
  // islands, centred on whichever one matters most — see
  // `pickDefaultFocusIsland`'s doc comment in `archipelago.ts` for the exact
  // 3-tier priority (a stopped agent; else the most recently changed
  // repository; else the largest known city — never the geometric centre of
  // an empty sea, which is why an empty/unresolvable sea falls back to
  // `fullSeaBounds` below rather than some invented centre point).
  const bounds = useMemo(() => {
    if (focusRoot) {
      const target = archipelago.find((v) => v.root === focusRoot);
      if (target) {
        const land = landRect(target);
        const margin = Math.max(land.w, land.d) * 0.3;
        return new THREE.Box3(
          new THREE.Vector3(land.x - margin, 0, land.z - margin),
          new THREE.Vector3(land.x + land.w + margin, 4, land.z + land.d + margin),
        );
      }
    }
    const snapshot = joinArchipelago(archipelago, islandsRef.current);
    const focus = pickDefaultFocusIsland(snapshot);
    const rect = focus ? defaultFocusBounds(snapshot, focus.view.root) : null;
    if (rect) {
      // `defaultFocusBounds` builds its rectangle from `landRect`, which
      // (unlike `seaBounds`) already returns WORLD units — see that
      // function's own doc comment — so, exactly like the `focusRoot`
      // harness branch above, these coordinates go straight into the Box3
      // with no second `worldUnits()` conversion.
      return new THREE.Box3(
        new THREE.Vector3(rect.minX, 0, rect.minZ),
        new THREE.Vector3(rect.maxX, 4, rect.maxZ),
      );
    }
    return fullSeaBounds;
    // `worldEpoch` is a deliberate one-shot RE-TRIGGER only (see its own doc
    // comment above) — the body above still reads live attention via
    // `islandsRef.current`, never `worldEpoch` itself.
  }, [archipelago, focusRoot, fullSeaBounds, worldEpoch]);

  // What `CameraRig`'s zoom-out/pan limit and `Atmosphere`/`SunLight`/`Sea`
  // size themselves against. In the real app (`focusRoot` unset) this is the
  // FULL sea — "zooming out to the full archipelago must still work... it
  // should be somewhere he goes, not where he lands" — even though `bounds`
  // above now fits a much tighter default. For the screenshot harness's
  // `focusRoot` mode, `bounds` IS already the one tight island being framed
  // (see that branch above), and this stays equal to it — exactly the one
  // single value every one of these consumers shared before this round —
  // so a focused harness render's water/fog/shadow sizing is byte-for-byte
  // unchanged; only the real, no-`focusRoot` sea gained the tight/outer split.
  const outerBounds = focusRoot ? bounds : fullSeaBounds;

  // Activity-lens round. OPT-IN, and off until he asks for it — see
  // `activityLens.ts` for the full argument, but the short version is that
  // 135 of his 152 repositories are older than three months, so a
  // permanent age channel would repaint the whole world to describe a
  // minority of it, on the one screen whose job is making a single island
  // jump out. Remembered between launches (`localStorage` only, best
  // effort) so turning it on is a decision he makes once.
  const [activityLens, setActivityLens] = useState(loadActivityLens);
  const toggleActivityLens = useCallback(() => {
    setActivityLens((on) => {
      saveActivityLens(!on);
      return !on;
    });
  }, []);
  // ONE "now" for the whole sea, re-read each time the lens is switched on
  // — so every island is bucketed against the same instant (152 islands can
  // never disagree about where "today" ends) and a long-running window
  // still picks up a fresh reading the next time he actually looks. A
  // `Date.now()` per island per render would be both wasteful and, at a
  // bucket boundary, genuinely inconsistent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nowMs = useMemo(() => Date.now(), [activityLens]);
  const activityCounts = useMemo(
    () => activityBucketCounts(archipelago.map((view) => view.last_changed_at), nowMs),
    [archipelago, nowMs],
  );

  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [flight, setFlight] = useState<FlightRequest | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // Coordinator review (water-fix round), item 2: "the wide view got worse
  // even though the close view got better... work out what should dominate
  // at distance." A REF, not React state — `ZoomTracker` below writes to it
  // every rendered frame (O(1): one camera/controls read for the WHOLE
  // scene, not per island), and each island's own `MiniTown`/`Vegetation`
  // reads it in their OWN `useFrame` to fade their own materials. Never
  // touches React state/re-renders 152 islands' worth of components on
  // every zoom tick — see `ZoomTracker`'s own doc comment for the full
  // reasoning.
  const zoomRatioRef = useRef(2);
  // Which island's action panel is open (Item 1 of the actions-UI round) —
  // a SEPARATE gesture from flying into the town now: a click SELECTS, and
  // the panel's own "Visit town" button is the explicit trigger for the
  // flight (see `handleVisitTown` below). `null` means no panel is open.
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  // Which agent's row `IslandPanel` should auto-expand — set by a villager
  // click and by a switch (see `attach` below), so the prompt box/output
  // for that exact agent (Items 6/7, second coordinator round) is what the
  // user lands on when the terminal closes.
  const [expandPaneId, setExpandPaneId] = useState<string | undefined>(undefined);
  // Item 2 (lag-and-switcher round): a ONE-SHOT request to open the big
  // terminal for one specific pane — the "go to whoever else is waiting"
  // switch, fired from inside the terminal that is currently open. A fresh
  // object each time (never a bare pane id), the same convention
  // `flyToRequest` already uses in `App.tsx`: switching to a pane, coming
  // back, and switching to it AGAIN must re-open it, which a value compared
  // by identity gives for free and a plain string would silently swallow.
  const [openTerminalRequest, setOpenTerminalRequest] = useState<{ paneId: string; seq: number } | null>(
    null,
  );
  const terminalSeq = useRef(0);
  // Every agent the terminal could switch to, for its own header strip.
  // Derived from the LIVE `islands` prop — the same `world.islands` the
  // HUD's own "N agents need you" badge counts — so the strip and the badge
  // can never tell two different stories about who has stopped. Marking
  // whichever one the terminal is currently attached to happens in
  // `Terminal` itself, the only place that knows which that is.
  const targets = useMemo(() => switchTargets(islands), [islands]);
  /**
   * POINT THE KEYBOARD AT ONE PANE, at sea: select its island (which mounts
   * `IslandPanel`, which owns the attachment and the `Terminal` itself —
   * see its own doc comment and `terminalAttachment.ts`), expand that
   * agent's row underneath, and ask the panel to attach.
   *
   * ONE function, three callers — a villager click, the switcher inside an
   * already-open terminal, and (via the panel) the row's own
   * "Open terminal ⤢" — so all three land the user in exactly the same
   * state rather than in three slightly different "terminal is open" modes.
   * That mattered immediately: the villager click used to be the one caller
   * that did something else entirely.
   *
   * `IslandPanel` is keyed on the island root, so a cross-island switch
   * REMOUNTS the panel; a same-island switch re-attaches with a fresh
   * `seq`, which is the `Terminal`'s key. Either way the terminal is a
   * fresh mount: no stale screen text from the previous agent, and — the
   * part that matters — no keyboard focus carried over, so the new terminal
   * opens in its "○ click to type" state and not one keystroke can reach
   * the wrong session.
   */
  const attach = useCallback((paneId: string, root: string) => {
    setSelectedRoot(root);
    setExpandPaneId(paneId);
    setOpenTerminalRequest({ paneId, seq: ++terminalSeq.current });
  }, []);
  const switchTo = useCallback(
    (target: SwitchTarget) => attach(target.agent.pane_id, target.root),
    [attach],
  );
  const { stage, sceneClaimed } = useTerminalStageHost(targets, switchTo);
  // A request is a ONE-SHOT, and this is what makes it one. Passive effects
  // run child-first, so `IslandPanel`'s own effect has already consumed this
  // request by the time this one runs in the same commit; clearing it here
  // stops a later, unrelated remount of that panel (select island C, then
  // island B again) from re-opening a terminal the user closed and never
  // asked for a second time. Nothing in this app may open a terminal the
  // user did not ask for — that surface types into a live session.
  useEffect(() => {
    if (openTerminalRequest === null) return;
    setOpenTerminalRequest(null);
  }, [openTerminalRequest]);

  // Screenshot-harness-only (see `autoSelectRoot`'s own doc comment): opens
  // the panel for that root once it actually exists in `seaIslands`, the
  // same state a real click on that island would set.
  useEffect(() => {
    if (!autoSelectRoot) return;
    if (seaIslands.some((s) => s.view.root === autoSelectRoot)) {
      setSelectedRoot(autoSelectRoot);
      if (autoExpandPaneIdProp) setExpandPaneId(autoExpandPaneIdProp);
    }
  }, [autoSelectRoot, autoExpandPaneIdProp, seaIslands]);

  const selectedIsland = useMemo(
    () => (selectedRoot ? (seaIslands.find((s) => s.view.root === selectedRoot) ?? null) : null),
    [selectedRoot, seaIslands],
  );

  const flyToTown = useCallback(
    (seaIsland: SeaIsland) => {
      const center = islandCenter(seaIsland.view);
      setFlight({
        targetX: center.x,
        targetZ: center.z,
        zoomFactor: 2.4,
        onArrive: () => onOpenIsland(seaIsland),
      });
    },
    [onOpenIsland],
  );

  const handleIslandSelect = useCallback((seaIsland: SeaIsland) => {
    setSelectedRoot(seaIsland.view.root);
  }, []);

  const handleVisitTown = useCallback(
    (seaIsland: SeaIsland) => {
      setSelectedRoot(null);
      flyToTown(seaIsland);
    },
    [flyToTown],
  );

  // Item 5: the Space hotkey stays live at sea level, and when it jumps, the
  // camera moves to that island too — this effect is the frontend half of
  // that (the actual `jump_to_next` invoke lives in `App.tsx`, unaffected).
  // Purely cosmetic: the jump has ALREADY happened in herdr by the time this
  // runs (`App` only bumps `flyToRequest` after `jump_to_next` resolves), so
  // this can never gate or delay the real jump.
  //
  // Game-feel round: "make that feel like a real move" — a jump used to only
  // pan/zoom the camera and leave the user to find the island's own panel
  // themselves. `onArrive` now also opens it, the same "arrive, then reveal"
  // shape `flyToTown` above already uses for "Visit town" — so pressing
  // Space doesn't just glimpse the destination, it lands you there with its
  // facts and actions already up.
  const lastFlySeq = useRef(0);
  useEffect(() => {
    if (!flyToRequest || flyToRequest.seq === lastFlySeq.current) return;
    lastFlySeq.current = flyToRequest.seq;
    // I1 (Opus frontend review): resolved by ROOT when the request has one
    // (every caller that already holds a `SeaIsland`, e.g. the search bar,
    // always does), never a name-only lookup that gets a colliding basename
    // wrong — see `resolveFlyToTarget`'s own doc comment.
    const target = resolveFlyToTarget(seaIslands, flyToRequest);
    if (!target) return;
    const center = islandCenter(target.view);
    setFlight({
      targetX: center.x,
      targetZ: center.z,
      zoomFactor: 1.8,
      onArrive: () => setSelectedRoot(target.view.root),
    });
  }, [flyToRequest, seaIslands]);

  // Reset-view: a button AND a key ("r"), the same affordance `TownView`
  // already offers one level down — the sea is now the primary screen, so it
  // deserves the same "get un-lost" escape hatch. Bumping `resetSignal`
  // (rather than `controls.reset()`) is what makes this an EASED camera move
  // (game-feel round) and re-derives the fit from the CURRENT window size —
  // see `CameraRig`'s own doc comment.
  const [resetSignal, setResetSignal] = useState(0);
  const resetView = useCallback(() => setResetSignal((s) => s + 1), []);

  // A boat circling roughly one island in three (which ones is a hash of
  // the root, so the same islands always have one), capped so a big sea
  // stays calm. Scenery — see `Boats.tsx`.
  const seaBoatRoutes = useMemo<BoatRoute[]>(() => {
    const routes: BoatRoute[] = [];
    for (const seaIsland of seaIslands) {
      const h = hashString(`${seaIsland.view.root}#boat`);
      if (h % 3 !== 0 || routes.length >= MAX_SEA_BOATS) continue;
      const land = landRect(seaIsland.view);
      const center = islandCenter(seaIsland.view);
      routes.push({
        cx: center.x,
        cz: center.z,
        rx: land.w * 0.8,
        rz: land.d * 0.8,
        speed: ((h >>> 4) & 1 ? 1 : -1) * (0.05 + ((h >>> 8) % 40) / 1000),
        phase: ((h >>> 12) % 628) / 100,
        size: Math.max(2.6, Math.min(land.w, land.d) * 0.14),
      });
    }
    return routes;
  }, [seaIslands]);

  // Recording mode's director: when an island goes from anything else to
  // stopped, fly there so the green flare is in the shot, hold on it while
  // the camera keeps orbiting, then ease back out to the whole sea. Never on
  // mount or on switching recording on — only a transition actually seen.
  const recording = useRecording();
  const lastAttentionRef = useRef(new Map<string, Attention | null>());
  const returnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const previous = lastAttentionRef.current;
    const next = new Map<string, Attention | null>();
    let finished: SeaIsland | null = null;
    for (const seaIsland of seaIslands) {
      next.set(seaIsland.view.root, seaIsland.attention);
      const before = previous.get(seaIsland.view.root);
      if (finished === null && previous.has(seaIsland.view.root) && before !== "stopped" && seaIsland.attention === "stopped") {
        finished = seaIsland;
      }
    }
    lastAttentionRef.current = next;
    if (!recording || finished === null) return;
    const center = islandCenter(finished.view);
    setFlight({ targetX: center.x, targetZ: center.z, zoomFactor: 2.2, onArrive: () => {} });
    if (returnTimerRef.current) clearTimeout(returnTimerRef.current);
    returnTimerRef.current = setTimeout(resetView, RECORDING_HOLD_MS);
  }, [seaIslands, recording, resetView]);
  useEffect(() => {
    if (recording) return;
    if (returnTimerRef.current) clearTimeout(returnTimerRef.current);
    returnTimerRef.current = null;
  }, [recording]);
  useEffect(() => () => { if (returnTimerRef.current) clearTimeout(returnTimerRef.current); }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "r" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isInteractiveTarget(event.target) &&
        // Minor (Opus frontend review): a real modal (either of the two
        // "Start agent…" confirm sheets, or "New project") must own the
        // keyboard the same way `Space`
        // already respects `isModalOpen()` — an "r" typed into a text field
        // inside one of those sheets is already caught by
        // `isInteractiveTarget` above, but "r" typed anywhere else in a
        // modal sheet used to reset the camera behind it regardless.
        !isModalOpen()
      ) {
        resetView();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [resetView]);

  /**
   * A CLICK ON A VILLAGER OPENS THAT AGENT'S TERMINAL, HERE, IN THE APP —
   * the same thing the same gesture does in a town (sea/town consistency
   * round), through the same `attach` a switch from inside an open terminal
   * uses, so there is one implementation of "point the keyboard at this
   * pane" on this screen and not two.
   *
   * WHAT THIS USED TO DO, and what became of each part:
   *
   *  - `focus_pane`, fired immediately and unconditionally (Item 4 of the
   *    archipelago-scene round): GONE from the click. It raised the user's
   *    own iTerm window and ejected him from the app — the exact complaint
   *    §5.6's town amendment already settled for a town, left in place at
   *    sea only because that round's scope stopped at the town. The
   *    capability itself survives, as `AgentActions`' own
   *    "Focus external terminal ↗" button on both screens: `pane.focus` is
   *    still permitted and still offered, as something the user asks for by
   *    name rather than as what the most natural gesture in the product
   *    silently does.
   *  - Selecting the island: SURVIVES, and is required — `IslandPanel` is
   *    what mounts the terminal at sea, and the panel is also what says
   *    which repository you are now looking at.
   *  - Expanding that agent's row: SURVIVES, and is now load-bearing
   *    rather than a convenience: closing the terminal leaves the user on
   *    that agent's own prompt box and last output rather than on nothing.
   *  - The "focused X" note in `App`'s HUD: GONE with the call it was
   *    reporting. The external raise reports in `AgentActions`, beside the
   *    button that asked for it, in the same words a town uses.
   */
  const handleVillagerClick = useCallback(
    (agent: Agent, seaIsland: SeaIsland) => {
      attach(agent.pane_id, seaIsland.view.root);
    },
    [attach],
  );

  // Screenshot-harness-only (see `autoVillagerClickPaneId`): runs the real
  // handler above, once the world genuinely reports that pane on that
  // island — never a click on a pane nobody confirmed. A ref keeps it a
  // one-shot, so a later `world-updated` push cannot re-open a terminal
  // the user closed.
  const harnessClickedRef = useRef(false);
  useEffect(() => {
    if (!autoVillagerClickPaneId || harnessClickedRef.current) return;
    for (const seaIsland of seaIslands) {
      const agent = seaIsland.agents.find((a) => a.pane_id === autoVillagerClickPaneId);
      if (agent) {
        harnessClickedRef.current = true;
        handleVillagerClick(agent, seaIsland);
        return;
      }
    }
  }, [autoVillagerClickPaneId, seaIslands, handleVillagerClick]);

  return (
    <TerminalStageProvider stage={stage}>
      <div ref={stageRef} className="scene-stage" style={{ position: "relative", width: "100%", height: "100%" }}>
        {/* Item 1 (lag-and-switcher round): the ONLY change to this canvas is
            that a full-screen terminal covering it narrows the already
            focus-gated `frameloop` to `"demand"` — see `sceneFrameloop`'s doc
            comment for the measurement that indicted this, and for why
            `"demand"` is a pause rather than a lie. */}
        <Canvas
          // Drei's HTML labels use large depth-based z-indices. Keep them
          // inside the scene's own layer, below island panels and terminals.
          style={{ isolation: "isolate" }}
          frameloop={sceneFrameloop(frameloop, sceneClaimed)}
          shadows="soft"
          gl={{
            antialias: true,
            preserveDrawingBuffer,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.15,
          }}
          orthographic
          camera={{ near: 0.1, far: 4000 }}
          onPointerMissed={() => setHover(null)}
        >
          <CameraRig
            bounds={bounds}
            outerBounds={outerBounds}
            maxZoomFactor={SEA_MAX_ZOOM_FACTOR}
            controlsRef={controlsRef}
            resetSignal={resetSignal}
            autoRotate={recording}
          />
          <FlightController request={flight} controlsRef={controlsRef} />
          <ZoomTracker controlsRef={controlsRef} zoomRatioRef={zoomRatioRef} />
          <color attach="background" args={[SKY_COLOR]} />
          {/* Atmosphere, lighting, water and the LOD fade tracker below all
              size themselves to `outerBounds` (the FULL sea), never the
              tighter default `bounds` above — the fog/sky sphere, the sun's
              shadow frustum, `zoomRatioRef`'s `minZoom` baseline and the water
              quad itself must all still cover (and read correctly across) the
              whole archipelago even though the camera now starts much closer
              in. Sizing any of them to the tight default would leave water,
              sky or fog missing the moment the user zooms or pans out to it. */}
          <Atmosphere bounds={outerBounds} />
          {/* The SAME lighting `TownView` uses (coordinator review, Item 2:
              "reuse the town's lighting setup rather than writing a second
              one"). Scenery-craft round: it is now literally one shared
              component rather than two hand-copied call sites that had to be
              retuned in lockstep — see `SceneLights`' own doc comment for the
              warm-key/cool-fill split it carries. */}
          <SceneLights bounds={outerBounds} />
          <Sea bounds={outerBounds} />
          <SailingBoats routes={seaBoatRoutes} waterY={-GROUND_THICKNESS - 0.03} />
          <TradeRouteLines islands={archipelago} />
          {seaIslands.map((seaIsland) => {
            const matches = filterActive && isSeaIslandMatch(seaIsland, searchQuery, stateFilter);
            return (
              <SeaIslandGroup
                key={seaIsland.view.root}
                seaIsland={seaIsland}
                onClick={handleIslandSelect}
                onVillagerClick={handleVillagerClick}
                onHover={setHover}
                dim={filterActive && !matches}
                highlighted={matches}
                activity={activityLens ? activityBucket(seaIsland.view.last_changed_at, nowMs) : null}
                zoomRatioRef={zoomRatioRef}
              />
            );
          })}
          <CinematicEffects tiltShift={recording} scale="sea" />
        </Canvas>
        {/* A button AND a key ("r") reset the view — mirrors `TownView`'s own
            reset affordance one level up, now that the sea is the primary
            screen too. Top-right, clear of the HUD header (top-left) and the
            island panel (bottom-left). */}
        {/* The chart's lower column of round buttons (see `ChartHud` for the
            upper one, which the HUD owns): the controls this scene owns
            itself — reset view, the activity lens, trade routes. */}
        <div className="chart-column chart-column--scene">
          <button type="button" className="chart-round" onClick={resetView} aria-label="Reset view (r)" title="Reset view (r)">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 12a8 8 0 1 0 2.4-5.7" />
              <path d="M4 4v4h4" />
            </svg>
          </button>
          <ActivityLensControl
            enabled={activityLens}
            onToggle={toggleActivityLens}
            counts={activityCounts}
            total={archipelago.length}
          />
          {tradeRoutes && tradeRoutes.routes.length > 0 && (
            <button
              type="button"
              className="chart-round"
              onClick={tradeRoutes.showRoutes}
              aria-label={`${tradeRoutes.routes.length} trade ${tradeRoutes.routes.length === 1 ? "route" : "routes"}`}
              title="Trade routes"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 17c4-8 12-8 16 0" strokeDasharray="3 3" />
                <path d="M16 14l4 3-4 3" />
              </svg>
              <span className="chart-round__count">{tradeRoutes.routes.length}</span>
            </button>
          )}
        </div>
        {selectedIsland && (
          <IslandPanel
            key={selectedIsland.view.root}
            seaIsland={selectedIsland}
            onClose={() => {
              setSelectedRoot(null);
              setExpandPaneId(undefined);
            }}
            onVisitTown={() => handleVisitTown(selectedIsland)}
            autoExpandPaneId={expandPaneId}
            autoOpenSendAgent={autoOpenSendAgent}
            autoOpenTerminal={autoOpenTerminal}
            openTerminalRequest={openTerminalRequest}
          />
        )}
        {hover && (
          <div
            style={{
              position: "absolute",
              left: (stageRef.current ? hover.x - stageRef.current.getBoundingClientRect().left : hover.x) + 14,
              top: (stageRef.current ? hover.y - stageRef.current.getBoundingClientRect().top : hover.y) + 14,
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
            {hover.kind === "island" ? (
              <>
                {hover.name}
                {/* Only while the lens is on: the exact answer in words,
                    beside the ring's approximate one. `formatLastChanged`
                    renders `null` as "no known date" — never a guessed date
                    and never "just now". */}
                {activityLens && (
                  <span style={{ opacity: 0.7 }}> — {formatLastChanged(hover.lastChangedAt, nowMs)}</span>
                )}
              </>
            ) : (
              <>
                {hover.agent.title ?? hover.agent.pane_id}
                <span style={{ opacity: 0.7 }}> — {hover.agent.attention}</span>
              </>
            )}
          </div>
        )}
      </div>
    </TerminalStageProvider>
  );
}
