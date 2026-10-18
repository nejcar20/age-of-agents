import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { RecordingProvider } from "./recording";
import { ChartHud } from "./components/ChartHud";
import { MoodProvider, type Mood } from "./mood";
import { invoke } from "@tauri-apps/api/core";
import { AgentActions, OPEN_TERMINAL_LABEL } from "./components/AgentActions";
import { Archipelago } from "./components/Archipelago";
import { IslandGrid } from "./components/IslandGrid";
import { NewProjectPanel } from "./components/NewProjectPanel";
import { SeaSearchBar } from "./components/SeaSearchBar";
import { START_AGENT_LABEL, useStartAgentFlow } from "./components/StartAgent";
import { Workbench } from "./components/Workbench";
import { TownWorkspace } from "./components/TownWorkspace";
import { TerminalDock } from "./components/TerminalDock";
import { UnsettledList } from "./components/UnsettledList";
import { switchTargets, type SwitchTarget } from "./agentSwitcher";
import { useTerminalAttachment } from "./terminalAttachment";
import { sceneFrameloop, TerminalStageProvider, useTerminalStageHost } from "./terminalStage";
import {
  findBestSeaIslandMatch,
  isSeaIslandMatch,
  joinArchipelago,
  type FlyToRequest,
  type SeaIsland,
  type StateFilter,
} from "./archipelago";
import { cityStats, type CityView } from "./city";
import { jumpMessage } from "./jump";
import { formatLastChanged } from "./lastChanged";
import { useArchipelago } from "./useArchipelago";
import { useHotkey } from "./useHotkey";
import { useWindowFocused } from "./useWindowFocused";
import { useWorld } from "./useWorld";
import {
  liveIslandFor,
  loadIslandSortMode,
  saveIslandSortMode,
  type Agent,
  type Island,
  type IslandSortMode,
} from "./world";
// Craft pass, item 4: "the typography is system-UI... a game has a voice."
// Self-hosted via `@fontsource-variable`, not a Google Fonts `<link>` — this
// app "talks to nothing but a local socket" (the brief's own constraint),
// and every font FILE this package ships is bundled into the build by Vite
// exactly like any other imported asset, never fetched over the network at
// runtime. See `--font-display` in `styles.css` for where this actually
// gets used (headings/titles/labels only — body copy and the terminal stay
// on the plain system sans/mono, unchanged).
import "@fontsource-variable/fredoka";
import "./styles.css";
import "./terminal.css";

/** How long a jump's status line stays on screen. */
const NOTE_MS = 5000;

function AtlasAppInner({
  seaHarnessProps,
}: {
  /** Screenshot-harness-only passthrough to `<Archipelago>` — lets
   * `townshot.tsx`'s `?app=1` mode render the REAL production tree (this
   * exact component, not a stand-in) with an island already selected/
   * expanded, the same state a real click would set, without a synthetic
   * pointer event. `main.tsx` never passes this (it calls `<App />` with no
   * props at all), so the shipped app's behavior is completely unaffected. */
  seaHarnessProps?: {
    autoSelectRoot?: string;
    autoOpenSendAgent?: boolean;
    autoOpenTerminal?: boolean;
    autoExpandPaneId?: string;
    /** Sea/town consistency round, screenshot-harness-only: runs
     * `Archipelago`'s REAL villager-click handler for this pane the moment
     * the world reports it, so a render of "clicked a villager in the sea"
     * goes through the shipped code path rather than through a hand-set
     * state that merely resembles it. Unused by the shipped app. */
    autoVillagerClickPaneId?: string;
    /** Search-and-filter round: seeds `searchQuery`/`stateFilter`'s initial
     * state, the same "start already in this state, no synthetic pointer/
     * keyboard event needed" convention every other `autoX` prop here
     * follows — so a render can show the search box already filled in and
     * the sea already highlighting/receding islands, without a headless
     * screenshot script having to simulate typing into a real `<input>`.
     * Unused by the shipped app. */
    autoSearchQuery?: string;
    autoStateFilter?: StateFilter;
    /** Art-direction round: opens `TownScreen` for the island whose `root`
     * matches, the instant `world.islands` is available — the same
     * `setOpenIsland` a real click on the sea already calls, so a
     * screenshot of the TOWN can go through this exact `<App/>` root (real
     * header, real "‹ islands" back button, real stats line) instead of
     * `townshot.tsx`'s OTHER, plain `<TownView>`-only harness path, which
     * (like the sea's old standalone harness the coordinator already caught
     * missing its header/HUD) never renders `TownScreen`'s own chrome
     * around it. Unused by the shipped app. */
    autoOpenIslandRoot?: string;
    /** Town-terminal round, screenshot-harness-only: with a town open (see
     * `autoOpenIslandRoot`), attaches its terminal to this pane the moment
     * the world reports it — the same state a real villager click sets, so
     * a render can show the terminal over a town without a synthetic click
     * on a 3D villager. Unused by the shipped app. */
    autoTownTerminalPaneId?: string;
    /** Screenshot-harness-only: starts in recording mode (⇧R). Unused by
     * the shipped app. */
    autoRecording?: boolean;
    /** Screenshot-harness-only: starts in this time of day. */
    autoMood?: Mood;
    /** Screenshot-harness-only: selects the town's first villager, showing
     * its panel (facts, prompt box, last output) without opening a
     * terminal over it. Unused by the shipped app. */
    autoSelectFirstVillager?: boolean;
  };
} = {}) {
  const world = useWorld();
  const archipelagoState = useArchipelago();
  // Art-direction round, item 2: the coordinator's explicit authorization
  // for continuous rendering (the moving water/sky) is conditional — "while
  // the window is focused, paused when blurred/hidden." One hook call here,
  // both `<Archipelago>` and `<TownView>` read the same value, so the sea
  // and the town pause/resume identically rather than each guessing their
  // own answer to "is the user actually looking at this."
  const windowFocused = useWindowFocused();
  // A sequence number, so a second press replaces the first note (and
  // restarts its timer) even when the wording is identical.
  const seq = useRef(0);
  const [note, setNote] = useState<{ text: string; seq: number } | null>(null);
  // The town view REPLACES the archipelago entirely (spec §5.4 allows one
  // attention state at a time — task-6-design-inputs.md §7.4); there is no
  // overlay state where both are visible.
  const [openIsland, setOpenIsland] = useState<Island | null>(null);
  // Harness-only, and a genuine ONE-SHOT: closing the town it opened must
  // leave it closed. The old `if (openIsland) return` guard only worked as
  // long as the effect's own dependencies happened not to change after a
  // manual close — which a real Escape-unwind render caught the moment
  // this effect gained a second source to look in (a `useArchipelago`
  // state object, fresh on every render). A ref says what was meant.
  const harnessOpenedIslandRef = useRef(false);
  useEffect(() => {
    const root = seaHarnessProps?.autoOpenIslandRoot;
    if (!root || openIsland || harnessOpenedIslandRef.current) return;
    const match = world.islands.find((island) => island.root === root);
    if (match) {
      harnessOpenedIslandRef.current = true;
      setOpenIsland(match);
      return;
    }
    // A repository herdr has no workspace for is still a town you can open
    // — the sea shows every repository, settled or not, and its own click
    // path (`handleOpenSeaIsland`) builds the same `Island` from the
    // archipelago view. The harness could not reach that case at all until
    // the town-terminal round needed a render of "Start agent…" in an
    // UNSETTLED town, which is precisely where the two flows differ.
    if (archipelagoState.kind !== "ready") return;
    const view = archipelagoState.islands.find((island) => island.root === root);
    if (view) {
      harnessOpenedIslandRef.current = true;
      setOpenIsland({
        id: view.root,
        name: view.name,
        root: view.root,
        attention: "quiet",
        agents: [],
        last_changed_at: view.last_changed_at,
      });
    }
    // `openIsland` deliberately excluded — this only ever fires the FIRST
    // time the target island appears, exactly like a one-shot click; it
    // must not re-fire (and stomp a manual `onClose`) just because
    // `openIsland` itself changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seaHarnessProps?.autoOpenIslandRoot, world.islands, archipelagoState]);
  // Lazy initializer: reads `localStorage` at most once, on the first
  // render, not on every one.
  const [sortMode, setSortMode] = useState<IslandSortMode>(() => loadIslandSortMode());
  // The HUD's slide-out drawer: the old plain-list view (`IslandGrid` +
  // `UnsettledList`), collapsed by default now that the sea is the primary
  // screen, but never removed — "nothing that works today may become
  // unreachable" is this round's own explicit constraint. Opening a town
  // from a row here calls the exact same `setOpenIsland` the 3D scene does.
  const [showPanel, setShowPanel] = useState(false);
  // The search slip behind the chart's search button (see `ChartHud`); it
  // also stays open while a search or filter is active, so a filtered sea
  // never hides what is filtering it.
  const [searchOpen, setSearchOpen] = useState(() => Boolean(seaHarnessProps?.autoSearchQuery || seaHarnessProps?.autoStateFilter));
  // Bumped after a successful Space-hotkey jump so `Archipelago` knows to
  // pan/zoom the camera to wherever the jump actually landed (Item 5) — a
  // fresh object each time (not just the island name) so pressing the
  // hotkey twice for the SAME island still re-triggers a flight; see
  // `Archipelago`'s `flyToRequest` prop doc comment and
  // `resolveFlyToTarget`'s (I1, Opus frontend review) for why `islandRoot`
  // matters whenever it's known.
  const [flyToRequest, setFlyToRequest] = useState<FlyToRequest | null>(null);
  const flySeq = useRef(0);
  // Forces `Archipelago` to remount after a crash — see `SeaViewBoundary`.
  const [sceneKey, setSceneKey] = useState(0);
  // Item 4 (actions-UI round): "found a new project" — a brand-new town on
  // empty water. A single boolean is enough state at this level; the whole
  // multi-step form/confirm flow lives inside `NewProjectPanel` itself.
  const [showNewProject, setShowNewProject] = useState(false);
  // Search-and-filter round: "find the repo I want" at 152 islands (up from
  // the 73 a depth-2 discovery cap silently showed — see this round's own
  // brief). Both live here, not inside `Archipelago`, because `SeaSearchBar`
  // sits in the HUD (a sibling of `Archipelago`, not a descendant) and
  // Enter-to-jump reuses the exact same `flyToRequest` mechanism the Space
  // hotkey already drives — one implementation of "fly the camera to an
  // island and open its panel," not two.
  const [searchQuery, setSearchQuery] = useState(() => seaHarnessProps?.autoSearchQuery ?? "");
  const [stateFilter, setStateFilter] = useState<StateFilter>(() => seaHarnessProps?.autoStateFilter ?? "all");

  const changeSortMode = (mode: IslandSortMode) => {
    setSortMode(mode);
    saveIslandSortMode(mode);
  };

  // The same join `Archipelago` computes internally from these exact two
  // props (`archipelago`/`islands`) — recomputed here only for the search
  // box's own two jobs (the live match count and Enter-to-jump), never
  // stored or treated as a second source of truth for the scene itself.
  const seaIslands = useMemo<SeaIsland[]>(
    () => (archipelagoState.kind === "ready" ? joinArchipelago(archipelagoState.islands, world.islands) : []),
    [archipelagoState, world.islands],
  );
  const filterActive = searchQuery.trim() !== "" || stateFilter !== "all";
  // Minor (Opus frontend review): while the archipelago is still loading (or
  // failed), `seaIslands` is `[]` — filtering an empty array over a typed
  // query used to read as a confident "no islands match" when the honest
  // state is "we don't know yet."
  const matchCount =
    filterActive && archipelagoState.kind === "ready"
      ? seaIslands.filter((s) => isSeaIslandMatch(s, searchQuery, stateFilter)).length
      : undefined;

  // Item 2 (search-and-filter round): "typing a name and pressing Enter
  // should fly the camera to that island and open its panel." Reuses the
  // Space hotkey's own `flyToRequest` flight — never a second "jump to an
  // island" implementation — so a search-triggered jump looks and behaves
  // exactly like a Space-triggered one.
  const submitSearch = useCallback(() => {
    const match = findBestSeaIslandMatch(seaIslands, searchQuery, stateFilter);
    if (match) {
      // I1 (Opus frontend review): `match` IS the exact island — carry its
      // `root` through rather than discarding it and forcing `Archipelago`
      // to re-resolve by name alone, which gets a colliding basename wrong
      // (the author has three: `StrategyTrader_v2`, `padel-court-api`,
      // `space-guardian`).
      setFlyToRequest({ islandName: match.view.name, islandRoot: match.view.root, seq: ++flySeq.current });
    } else if (searchQuery.trim() !== "") {
      // Honest, visible "nothing there" rather than silently doing nothing
      // — the same `note` banner every other fire-and-forget action in this
      // component already reports through.
      setNote({ text: `no island matches "${searchQuery.trim()}"`, seq: ++seq.current });
    }
  }, [seaIslands, searchQuery, stateFilter]);

  // Game-feel round: factored out of the Space hotkey below so the SAME code
  // path also fires from `WhoNeedsMe`'s own click — "make that feel like a
  // real move" is about the RESULT of a jump (the camera flies there, the
  // panel opens — see `Archipelago`'s `flyToRequest` handling), not about
  // which input triggered it, so the badge is a second door into the exact
  // same action rather than a parallel implementation of it.
  const triggerJump = useCallback(() => {
    // Deliberately fire-and-forget: the jump must not wait on anything we
    // render (principle 2 — no delay on the attention path). The result is
    // only reported once herdr has already answered. Any camera movement
    // this triggers (`setFlyToRequest`, below) happens strictly AFTER the
    // real jump already landed, so it can never gate or slow it down.
    const report = (text: string) => setNote({ text, seq: ++seq.current });
    invoke<string | null>("jump_to_next")
      .then((island) => {
        report(jumpMessage({ ok: true, island }));
        // No `islandRoot` here: `jump_to_next`'s own backend contract
        // (`commands::jump_to_next`) answers with `island.name` only — a
        // real backend limitation `resolveFlyToTarget`'s doc comment
        // explains, not something fixable on this side of the wire.
        if (island !== null) setFlyToRequest({ islandName: island, seq: ++flySeq.current });
      })
      .catch((error) => report(jumpMessage({ ok: false, error: String(error) })));
  }, []);

  useHotkey(
    " ",
    triggerJump,
    // Disabled while a town is open so the jump hotkey cannot fire unseen
    // (brief step 5) — the user's muscle-memory jump key does nothing while
    // looking at a town. See task-6-design-inputs.md §7.5 for why that is a
    // deliberate trade-off worth naming rather than a silent side effect.
    { enabled: openIsland === null },
  );

  useHotkey(
    "Escape",
    () => setOpenIsland(null),
    // Only listens while a town is actually open — with the town view
    // replacing the whole list (§7.4), there is no other Escape consumer it
    // could ever collide with in this state (`UnsettledList`'s confirm sheet
    // cannot be open here, since it lives in the archipelago view).
    { enabled: openIsland !== null },
  );

  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(
      () => setNote((current) => (current?.seq === note.seq ? null : current)),
      NOTE_MS,
    );
    return () => clearTimeout(timer);
  }, [note]);

  if (openIsland !== null) {
    // I2 (Opus frontend review): `openIsland` is the snapshot captured at
    // click time — `liveIslandFor` re-derives it from the CURRENT
    // `world.islands` by `root` on every render, so `TownView`'s villagers
    // (coloured by the LIVE `agent.attention`) never freeze at whatever an
    // agent's status happened to be the moment the town was opened.
    //
    // `islands` (the whole world, not just this one) is what the town's
    // terminal switcher reads — see `TownScreen`'s own doc comment for why
    // it lists every agent rather than only this repository's.
    return (
      <TownScreen
        island={liveIslandFor(openIsland, world.islands)}
        islands={world.islands}
        connected={world.herdr_connected}
        onClose={() => setOpenIsland(null)}
        autoTerminalPaneId={seaHarnessProps?.autoTownTerminalPaneId}
        autoSelectFirstVillager={seaHarnessProps?.autoSelectFirstVillager}
      />
    );
  }

  // WHAT A CLICK ON A VILLAGER AT SEA DOES is no longer this component's
  // business at all (sea/town consistency round). It used to be
  // `focus_pane` — fired immediately and unconditionally, raising iTerm and
  // ejecting the user from the app — while the same gesture in a town opened
  // that agent's terminal inside it. `Archipelago` now opens the terminal
  // itself, exactly as `TownScreen` does, so the gesture means one thing on
  // both screens; raising the real external terminal survives as
  // `AgentActions`' own explicitly-labelled button, shared by both. See
  // §5.6's town amendment, which ruled this for a town, and
  // `externalTerminal.ts`.

  // Opens the SAME `TownScreen` a row in the old list opens — constructed
  // from the sea's own joined data (`SeaIsland`, see `archipelago.ts`)
  // rather than requiring a matching `world.islands` entry to exist, since
  // the sea shows EVERY repository (Item 1), settled or not, and clicking an
  // unsettled one must still be able to open its city (`city_for` only ever
  // needs a path, never a herdr workspace).
  const handleOpenSeaIsland = (seaIsland: SeaIsland) => {
    setOpenIsland({
      id: seaIsland.view.root,
      name: seaIsland.view.name,
      root: seaIsland.view.root,
      attention: seaIsland.attention ?? "quiet",
      agents: seaIsland.agents,
      last_changed_at: seaIsland.view.last_changed_at,
    });
  };


  return (
    <main className="app app--sea">
      <div className="sea-hud">
        {world.protocol_mismatch && (
          <p className="warning">
            This Herdr speaks a different protocol than expected. Some state may be wrong.
          </p>
        )}
        {note !== null && (
          <p className="jump-note" role="status">
            {note.text}
          </p>
        )}
        {!world.herdr_connected && (
          <p className="empty">Start Herdr, then this window will fill in on its own.</p>
        )}
        {showPanel && (
          <div className="sea-hud__panel">
            <label className="app__sort">
              <span className="label-meta">Sort</span>
              <select
                value={sortMode}
                onChange={(event) => changeSortMode(event.target.value as IslandSortMode)}
              >
                <option value="name">name</option>
                <option value="recency">recently changed</option>
              </select>
              <span className={world.herdr_connected ? "status status--ok" : "status status--off"}>
                {world.herdr_connected ? `herdr ${world.herdr_version}` : "herdr not running"}
              </span>
            </label>
            <IslandGrid
              islands={world.islands}
              connected={world.herdr_connected}
              sortMode={sortMode}
              onOpen={setOpenIsland}
            />
            {/* Founding needs a live herdr to create a workspace in, and the
                settled/unsettled split is only correct while `world` is
                actually populated from herdr — see the original comment this
                carried over from the plain-list screen. */}
            {world.herdr_connected && <UnsettledList islands={world.islands} />}
          </div>
        )}
      </div>
      <div className="sea-stage">
        {archipelagoState.kind === "error" && (
          <p className="sea-stage__status sea-stage__status--error" role="alert">
            Could not chart the archipelago: {archipelagoState.message}
          </p>
        )}
        {archipelagoState.kind === "loading" && (
          <p className="sea-stage__status">Charting the sea…</p>
        )}
        {/* CRITICAL 4 (Opus frontend review): a refresh failure after a
            successful one used to render the OLD island list with no
            indication anything had gone wrong — an alt-tab back after
            deleting a repo would keep showing an island that no longer
            exists. `staleError` (see `useArchipelago`'s own doc comment)
            carries that failure alongside the still-displayed list, so this
            banner can say both what failed and how old what's on screen
            actually is. */}
        {archipelagoState.kind === "ready" && archipelagoState.staleError !== undefined && (
          <p className="sea-stage__status sea-stage__status--error" role="alert">
            Could not refresh the archipelago: {archipelagoState.staleError} — showing the list as of{" "}
            {formatLastChanged(archipelagoState.staleSince ?? null)}.
          </p>
        )}
        {archipelagoState.kind === "ready" && (
          <SeaViewBoundary onRetry={() => setSceneKey((k) => k + 1)}>
            <Archipelago
              key={sceneKey}
              archipelago={archipelagoState.islands}
              islands={world.islands}
              onOpenIsland={handleOpenSeaIsland}
              flyToRequest={flyToRequest}
              searchQuery={searchQuery}
              stateFilter={stateFilter}
              frameloop={windowFocused ? "always" : "demand"}
              {...seaHarnessProps}
            />
          </SeaViewBoundary>
        )}
      </div>
      <ChartHud
        islands={world.islands}
        islandCount={archipelagoState.kind === "ready" ? archipelagoState.islands.length : world.islands.length}
        connected={world.herdr_connected}
        herdrVersion={world.herdr_version}
        onJump={triggerJump}
        onOpenAgent={(island) => setFlyToRequest({ islandName: island.name, islandRoot: island.root, seq: ++flySeq.current })}
        search={
          <SeaSearchBar
            query={searchQuery}
            onQueryChange={setSearchQuery}
            stateFilter={stateFilter}
            onStateFilterChange={setStateFilter}
            onSubmit={submitSearch}
            matchCount={matchCount}
          />
        }
        searchOpen={searchOpen || searchQuery.trim() !== "" || stateFilter !== "all"}
        onToggleSearch={() => setSearchOpen((open) => !open)}
        listOpen={showPanel}
        onToggleList={() => setShowPanel((v) => !v)}
        onNewProject={() => setShowNewProject(true)}
      />
      {showNewProject && (
        <NewProjectPanel
          onClose={() => setShowNewProject(false)}
          onCreated={(path, undiscoverableReason) => {
            setShowNewProject(false);
            // `undiscoverableReason` is non-null only once the user has
            // already acknowledged `NewProjectPanel`'s own "created, but…"
            // screen (see its doc comment) — this note is a second,
            // redundant confirmation, not the only place that fact is
            // said. `refetch` below still runs either way: even when this
            // scan won't find it, a fresh scan is never wrong to have.
            setNote({
              text:
                undiscoverableReason !== null
                  ? `created ${path} — no island will appear: ${undiscoverableReason}`
                  : `founded ${path}`,
              seq: ++seq.current,
            });
            // Honesty rule, same as Item 2: the new ISLAND appears once the
            // real backend says it exists. Unlike an agent's own status,
            // repository discovery has no live-push channel, so this round
            // trip is the honest way to learn about it promptly instead of
            // waiting for the next window-focus rescan.
            archipelagoState.refetch();
          }}
        />
      )}
    </main>
  );
}


/**
 * The sea-level analogue of `TownViewBoundary`, below — same reasoning
 * (IMPORTANT 3, final whole-branch review): `<Archipelago>` mounts a real
 * WebGL `<Canvas>` too, and it is now the PRIMARY screen, so an uncaught
 * throw here would be strictly worse than in the town view — it would take
 * down the very first thing the user sees, hotkey included, with no list
 * screen left to fall back to. A separate class (not a reuse of
 * `TownViewBoundary`) because the fallback's wording and recovery action
 * differ: there is no "other view" to step back to from the sea itself, so
 * the affordance here is "try again" (remount via `sceneKey`), not "back to
 * islands".
 */
type SeaViewBoundaryState = { error: Error | null };

export class SeaViewBoundary extends Component<
  { onRetry: () => void; children: ReactNode },
  SeaViewBoundaryState
> {
  state: SeaViewBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): SeaViewBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Archipelago crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="sea-stage__status sea-stage__status--error" role="alert">
          <p>
            The sea view failed to render: {this.state.error.message}. This is a rendering
            problem here, not a fact about your repositories — the list above still works.
          </p>
          <button
            type="button"
            className="town__back"
            onClick={() => {
              this.setState({ error: null });
              this.props.onRetry();
            }}
          >
            try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * IMPORTANT 3 (final whole-branch review): `<TownView>` mounts a real WebGL
 * `<Canvas>` (`@react-three/fiber`), and WebGL context creation can throw —
 * no usable GPU, or a lost context after a GPU reset. With no error boundary
 * anywhere in the tree (there was none before this), that throw unmounts the
 * WHOLE React root: the archipelago AND the jump hotkey (this product's
 * headline feature — see `useHotkey`) go with it, leaving a blank window
 * recoverable only by restarting the app. That is a direct violation of
 * principles 2 and 3.
 *
 * This boundary is placed here — around `<TownView>` specifically, INSIDE
 * `TownScreen`, not around all of `App` (and not in `main.tsx`, despite that
 * being where the missing-boundary evidence was found) — because scope is
 * the whole point: `App` itself, its `useHotkey` calls, and the archipelago
 * live OUTSIDE this boundary's subtree, so a town-view crash can only ever
 * take out the town view. A boundary wrapping the entire app would satisfy
 * neither requirement, since catching the error would still discard
 * everything inside it — hotkey included.
 */
type TownViewBoundaryState = { error: Error | null };

/** Exported for `App.test.tsx` — see that file for why the boundary itself,
 * rather than all of `App`, is the thing worth testing directly. */
export class TownViewBoundary extends Component<
  { onReset: () => void; children: ReactNode },
  TownViewBoundaryState
> {
  state: TownViewBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): TownViewBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // The console line is for whoever's watching devtools; the fallback
    // below is the half that must be visible to the user with no devtools
    // open at all — see its own comment for why that distinction matters.
    console.error("TownView crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      // Rendered in place of `<TownView>`, i.e. still inside `.town__stage`
      // — the same visible slot the loading/error states already use (see
      // `.town__status`/`.town__status--error` in `styles.css`), which is
      // itself inside `.town`, a `position: fixed; inset: 0` layer that
      // paints over everything else. Deliberately NOT relying on that alone
      // for visibility, though: this branch shipped one bug already where
      // error text rendered underneath a fixed-position overlay where
      // nobody could see it (`UnsettledList`'s `.sheet__error` fix), so a
      // second, independent "return to the archipelago" affordance is given
      // right here, not just via the header's `‹ islands` button (which is
      // a sibling, and does also keep working, since it's outside this
      // boundary's subtree).
      return (
        <div className="town__status town__status--error" role="alert">
          <p>
            This city failed to render: {this.state.error.message}. This is a rendering
            problem here, not a fact about your repository.
          </p>
          <button type="button" className="town__back" onClick={this.props.onReset}>
            ‹ back to islands
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

type CityFetchState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; cityView: CityView };

/**
 * Opens one island's town: fetches its `CityModel`/`CityLayout` via the
 * `city_for` command and renders `TownView` once it arrives.
 *
 * `city_for` is `async` specifically because building a city means walking
 * (or asking `git` for) an entire repository — on the user's larger repos
 * that is thousands of files, so this must show a visible "reading the
 * repository" state rather than freezing or rendering an empty city while
 * it loads (task-6-design-inputs.md §7.2: an empty town would be a factual
 * claim that the repo has no code, which principle 4 forbids). The error
 * branch is equally visible, in the same place, for the same reason.
 */
export function TownScreen({
  island,
  islands,
  connected = true,
  onClose,
  autoTerminalPaneId,
  autoSelectFirstVillager,
}: {
  island: Island;
  /**
   * The WHOLE world, not just this town's island. Two things here need it,
   * and both would be wrong with a narrower list: the terminal's switcher
   * (⌃⌥⇥ and its tab strip) lists every agent running anywhere, exactly as
   * it does at sea, and its "this is the only agent running" answer would
   * be a lie if this screen only ever looked at one repository.
   */
  islands: Island[];
  connected?: boolean;
  onClose: () => void;
  /** Screenshot-harness-only — see `App`'s own `autoTownTerminalPaneId`. */
  autoTerminalPaneId?: string;
  /** Screenshot-harness-only — see `App`'s own `autoSelectFirstVillager`. */
  autoSelectFirstVillager?: boolean;
}) {
  const [state, setState] = useState<CityFetchState>({ kind: "loading" });
  // Same focus-gated continuous-render authorization as the sea (see
  // `App`'s own `windowFocused` for the doc comment) — a separate call here
  // rather than a prop from `App`, since `TownScreen` replaces `App`'s own
  // returned tree entirely (line ~195) rather than nesting inside it.
  const windowFocused = useWindowFocused();
  const noteSeq = useRef(0);
  const [note, setNote] = useState<{ text: string; seq: number } | null>(null);
  const report = useCallback((text: string) => setNote({ text, seq: ++noteSeq.current }), []);
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(
      () => setNote((current) => (current?.seq === note.seq ? null : current)),
      NOTE_MS,
    );
    return () => clearTimeout(timer);
  }, [note]);

  // ---- TOWN-TERMINAL ROUND ----------------------------------------------
  //
  // The author, looking at a town with their own agents standing in it,
  // found nothing to act with: no terminal, nothing. That was right, and the
  // click they did try was worse than nothing: it called `focus_pane`, which raises iTerm and throws you out
  // of the app.
  //
  // WHICH PANE THIS SCREEN'S KEYBOARD IS POINTED AT, as one piece of state
  // — now from the SHARED `useTerminalAttachment` hook that `IslandPanel`
  // uses at sea (sea/town consistency round). See `terminalAttachment.ts`
  // for what it owns and why each of those three things could otherwise be
  // wrong in two places at once: the `seq` that makes every switch a fresh
  // mount, the `root` carried with the pane id (this screen's switcher can
  // and should point the terminal at an agent in a DIFFERENT repository, and
  // `root` is what every pane call is checked against), and the live
  // re-resolution that drops the attachment — with an honest sentence —
  // when herdr stops reporting the pane.
  const { attachment, attached, attach, detach } = useTerminalAttachment(islands, report);

  // Every agent the terminal could switch to, in switcher order — the same
  // `switchTargets` the sea builds from the same live `world.islands`, so
  // the strip cannot tell a different story on one screen than the other.
  const targets = useMemo(() => switchTargets(islands), [islands]);
  const switchTo = useCallback(
    (target: SwitchTarget) => attach(target.agent.pane_id, target.root),
    [attach],
  );
  const { stage, sceneClaimed } = useTerminalStageHost(targets, switchTo);
  // Just this repository's agents, attention-first — via the SAME ordering
  // function, never a second opinion about which of two agents matters
  // more. Only used to decide which pane the header's own "Open terminal"
  // button lands on (whoever is waiting, else whoever is first).
  const localTargets = useMemo(() => switchTargets([island]), [island]);

  // Screenshot-harness-only (see `autoTerminalPaneId`): attaches once the
  // world genuinely reports that pane in THIS town — the same rule the
  // shipped paths follow, never an attachment to a pane nobody confirmed.
  useEffect(() => {
    if (!autoTerminalPaneId) return;
    if (island.agents.some((agent) => agent.pane_id === autoTerminalPaneId)) {
      attach(autoTerminalPaneId, island.root);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTerminalPaneId, island.agents, island.root]);

  const handleVillagerClick = useCallback(
    (agent: Agent) => {
      // ITEM 1: a click on a villager opens THAT AGENT'S TERMINAL, here, in
      // the app — the single most concrete "this agent works in this
      // repository" moment in the product, finally connected to the thing
      // you would want at that moment. `focus_pane` survives as the
      // villager panel's own explicitly-labelled button; it is no longer
      // what a plain click does.
      attach(agent.pane_id, island.root);
    },
    [attach, island.root],
  );

  // The explicit "raise my real terminal window" action is NOT here any
  // more: it is `AgentActions`' own `RAISE_EXTERNAL_TERMINAL_LABEL` button,
  // shared with the sea, reporting in the same words in the same place on
  // both screens (sea/town consistency round — see `externalTerminal.ts`).
  // This screen used to own a second copy of that call and a second wording
  // of its result.

  // ITEM 3: starting an agent, reachable from the town — "I'm looking at
  // this project" is exactly when you want one. The SAME flow the sea's
  // island panel uses (`useStartAgentFlow`), not a second copy of it, so
  // both screens run the same command, show the same confirm sheet, and
  // land the user in the new agent's terminal the moment herdr reports its
  // pane.
  //
  // `settled` is asked of the live world rather than of `island.attention`:
  // a town can be opened for a repository that has no herdr workspace at
  // all (the sea shows every repository, settled or not), and that is
  // precisely the case where "Start agent…" must take the founding path.
  const settled = useMemo(
    () => islands.some((candidate) => candidate.root === island.root),
    [islands, island.root],
  );
  const start = useStartAgentFlow({
    root: island.root,
    name: island.name,
    settled,
    agents: island.agents,
    onPaneReady: (paneId) => attach(paneId, island.root),
    noteClassName: "town__note",
  });

  const cityRequestRef = useRef(0);
  useEffect(() => {
    const request = ++cityRequestRef.current;
    setState({ kind: "loading" });
    // `island.root`, never an agent's own `cwd` — see
    // task-6-design-inputs.md §7.1: `root` is the one canonical repository a
    // worktree pane's island already collapsed onto, while `cwd` is where
    // that specific pane was founded and can name a different directory.
    invoke<CityView>("city_for", { path: island.root })
      .then((cityView) => {
        if (request === cityRequestRef.current) setState({ kind: "ready", cityView });
      })
      .catch((error) => {
        if (request === cityRequestRef.current) setState({ kind: "error", message: String(error) });
      });
    return () => {
      cityRequestRef.current++;
    };
  }, [island.root]);

  // I4 (Opus frontend review): `cityStats` (`./city`) also surfaces
  // `skipped`/`submodules` when nonzero — "nothing here" now reads
  // differently from "we could not find out" instead of both drawing as a
  // bare "0 districts · 0 buildings".
  const stats = state.kind === "ready" ? cityStats(state.cityView.model) : null;
  const refreshCity = useCallback(() => {
    const root = island.root;
    const request = ++cityRequestRef.current;
    return invoke<CityView>("city_for", { path: root }).then(cityView => {
      if (request === cityRequestRef.current) setState({ kind: "ready", cityView });
    }).catch(error => { if (request === cityRequestRef.current) report(`Could not refresh the town: ${String(error)}`); });
  }, [island.root, report]);

  return (
    <TerminalStageProvider stage={stage}>
      <div className="town">
        <header className="town__header">
          <button type="button" className="town__back" onClick={onClose}>
            ‹ islands
          </button>
          <h2 className="town__title">{island.name}</h2>
          {/* ITEM 2: reaching the agents that work HERE without hunting for
              a villager among a thousand buildings. One button, because the
              switcher this app already has is the right answer to "and the
              others" — it opens the terminal on whoever in this repository
              most needs attention (`switchTargets` orders by the same
              `ATTENTION_RANK` everything else uses), and its own tab strip
              then reaches every other agent, here or anywhere, by one click
              or ⌃⌥⇥. A second, town-only agent list would be exactly the
              parallel mechanism this project keeps paying for. */}
          <button
            type="button"
            className="town__action town__action--primary"
            onClick={() => {
              const first = localTargets[0];
              if (first) attach(first.agent.pane_id, first.root);
            }}
            disabled={localTargets.length === 0}
            title={
              localTargets.length === 0
                ? "no agent is running in this repository yet — start one"
                : `${localTargets[0]?.agent.pane_id} · ⌃⌥⇥ switches between agents once it is open`
            }
          >
            {OPEN_TERMINAL_LABEL}
            {localTargets.length > 1 ? ` · ${localTargets.length} here` : ""}
          </button>
          {/* ITEM 3, the same flow the sea offers — see `start` above. */}
          <button
            type="button"
            className="town__action"
            onClick={start.open}
            disabled={start.loading}
            title={start.error ?? undefined}
          >
            {START_AGENT_LABEL}
          </button>
          {note !== null && (
            <span className="town__note" role="status">
              {note.text}
            </span>
          )}
          {/* The two honest in-between states of a just-started agent, in
              the town's own voice (`noteClassName`) — the agent is running
              in both, and neither pretends a terminal is open when it is
              not. */}
          {start.notes}
          {stats && <span className="town__stats">{stats}</span>}
        </header>
        <TerminalDock primary={attached && attachment ? { agent: attached, root: attachment.root, islandName: islands.find(i => i.root === attachment.root)?.name ?? island.name } : null} targets={targets} onSwitch={switchTo} onClose={detach}>
        <div className="town__stage" style={{ height: "100%" }}>
          {state.kind === "loading" && <p className="town__status">Reading the repository…</p>}
          {state.kind === "error" && (
            <p className="town__status town__status--error" role="alert">
              Could not build this city: {state.message}
            </p>
          )}
          {state.kind === "ready" && (
            <TownViewBoundary onReset={onClose}>
              <TownWorkspace
                key={island.root}
                root={island.root}
                targets={targets}
                connected={connected}
                onOpenTerminal={switchTo}
                onRefreshCity={refreshCity}
                cityView={state.cityView}
                agents={island.agents}
                onVillagerClick={handleVillagerClick}
                // The selected villager's own working surface — the SAME
                // `AgentActions` an expanded island row shows at sea: its
                // last output, a prompt box that goes through herdr's
                // `agent.prompt`, and both terminal actions ("Open
                // terminal ⤢" here, "Focus external terminal ↗" out to the
                // real one). `onOpenTerminal` is what keeps the terminal
                // itself owned by this screen rather than by the panel, so
                // there is exactly one attachment and one answer to "where
                // is my keyboard pointed".
                villagerActions={(agent) => (
                  <AgentActions
                    agent={agent}
                    root={island.root}
                    onOpenTerminal={() => attach(agent.pane_id, island.root)}
                  />
                )}
                keyboardCaptured={attached !== null}
                autoSelectFirstVillager={autoSelectFirstVillager}
                // THE PERFORMANCE FIX, carried across (87c03a6/195a558): a
                // full-screen terminal over this town narrows the already
                // focus-gated frameloop to "demand", exactly as it does
                // over the sea. A town is a 3D scene too, and a terminal
                // tab does not render a city behind itself. See
                // `sceneFrameloop`'s own doc comment.
                frameloop={sceneFrameloop(windowFocused ? "always" : "demand", sceneClaimed)}
              />
            </TownViewBoundary>
          )}
        </div>
        </TerminalDock>
        {start.sheets}
      </div>
    </TerminalStageProvider>
  );
}

/** The world views, with recording mode (⇧R) available throughout them. */
export function AtlasApp(props: Parameters<typeof AtlasAppInner>[0] = {}) {
  return (
    <MoodProvider initial={props.seaHarnessProps?.autoMood}>
      <RecordingProvider initial={props.seaHarnessProps?.autoRecording}><AtlasAppInner {...props} /></RecordingProvider>
    </MoodProvider>
  );
}

export default function App(props: Parameters<typeof AtlasApp>[0] = {}) {
  if (props.seaHarnessProps) return <AtlasApp {...props} />;
  return <Workbench renderAtlas={() => <AtlasApp />} />;
}
