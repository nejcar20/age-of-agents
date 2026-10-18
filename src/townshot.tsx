// Dev-only screenshot-harness entry point (task-6-design-inputs.md §1).
// Never imported by `main.tsx`/`App.tsx`, and only ever built via
// `vite.townshot.config.ts` — the app's own `main.tsx` is the sole entry
// `npm run build`/`tauri build` know about, so this file cannot reach the
// shipped bundle by any path the main build takes.
//
// Reads a `CityView` fixture (see `src-tauri/src/bin/city_fixture.rs`) named
// by `?fixture=<name>` from `/fixtures/<name>.json`, and renders `TownView`
// full-window with `frameloop="always"` (overridable — see `?frameloop=`
// below) and `preserveDrawingBuffer` so headless Chrome's `--screenshot`
// reliably captures a settled frame (see the design inputs' "two known
// screenshot traps" — both fixes live here, in the harness, never in
// `TownView`'s own defaults). An optional `?focus=<district-path>` fits the
// camera to one district instead of the whole city, for the "closer shot of
// a single district" fixture.
//
// `?frameloop=demand` overrides the default `"always"` — needed to verify
// the app's REAL default (`TownView`'s own default is `"demand"`) actually
// re-renders on a programmatic camera move via `invalidate()`, which
// `"always"` cannot prove (it re-renders every frame regardless of whether
// anything invalidated).
//
// `?orbit=1` drives the SAME production `OrbitControls` instance the app
// uses — via `TownView`'s harness-only `onControlsReady` — to a distinctly
// different angle/zoom after mount, exercised through `setAzimuthalAngle`/
// `setPolarAngle`/`dollyIn` (which each call the controls' own `update()`
// and fire a real `change` event, precisely the code path a real drag
// would take). Combine with `?frameloop=demand` to prove demand-mode
// rendering end-to-end: if the resulting screenshot shows the moved camera,
// `invalidate()` really propagated; if it still shows the initial fitted
// view, it did not.
import React from "react";
import ReactDOM from "react-dom/client";
import App, { AtlasApp } from "./App";
import { Workbench } from "./components/Workbench";
import { Archipelago } from "./components/Archipelago";
import { TownView } from "./components/TownView";
import { terminalPreview } from "./terminalPreview";
import { TradeRouteStorageContext } from "./components/TradeRoutes";
import { buildTradePrompt, TRADE_ROUTES_KEY, type TradeRoute } from "./tradeRoutes";
import type { CityView } from "./city";
import type { IslandView, StateFilter } from "./archipelago";
import type { World } from "./world";
// The same stylesheet the shipped app loads (via `App.tsx`) — this round
// added several DOM overlay panels (`IslandPanel`, `BuildingPanel`'s reveal
// button, `DistrictPanel`, the various `.sheet`s) that are absolutely
// positioned and rely on this file for layout; without it they render
// unstyled and un-positioned (falling into normal document flow, off the
// bottom of the viewport a screenshot actually captures) rather than
// invisible-but-present. Importing it here changes nothing about what the
// shipped app does — `main.tsx`/`App.tsx` already import it independently —
// it only makes this dev-only harness represent the real app faithfully.
// See `App.tsx`'s matching import for why this is here at all — the same
// self-hosted display font the real app loads, so a harness render actually
// shows the real typography rather than falling back to `--font-display`'s
// own system-font tail of its stack.
import "@fontsource-variable/fredoka";
import "./styles.css";

/** How many times the harness has served `city_for` (see `?grow=1`). */
let harnessMeasurements = 0;

// Harness-only Tauri IPC shim (see this file's own top-of-file doc comment
// on why nothing here can reach the shipped bundle). `IslandPanel` and
// friends call `invoke()` directly (via `agents.ts`/`reveal.ts`), not
// through props the way `onOpenIsland`/`onVillagerClick` let round 1/2's
// harness pass no-ops — there IS no Tauri runtime under a plain
// `http.server` + headless Chrome, so `window.__TAURI_INTERNALS__` is
// simply undefined and every one of those calls would otherwise reject with
// an opaque "not a function," leaving the sheet stuck in perpetual
// loading/error rather than showing what it actually looks like.
//
// This answers ONLY the read-only/informational commands a render needs to
// settle into its real shape (`agent_kinds`, `resumable_agent_kinds`,
// `read_agent`, `get_world`, `get_archipelago`), with canned-but-plausible
// data clearly living only in this dev-only file. Every ACTUAL
// herdr/filesystem-touching command (`start_agent`, `create_project`,
// `found_settlement`, `send_prompt`, `focus_workspace`, `reveal_path`,
// `focus_pane`, `canonical_path`, `jump_to_next`) is hard-rejected with an
// explicit "disabled in the screenshot harness" message — belt-and-suspenders
// on top of "no real backend exists here anyway," so a screenshot script can
// never cause a real side effect on the author's machine even by accident
// (the coordinator's explicit constraint: unit tests and fakes only, never
// the author's live session).
//
// `get_world`/`get_archipelago` are what let `?app=1` (below) render the
// REAL `<App/>` root — header, HUD, sea, panels — instead of a component in
// isolation. That distinction mattered this round: the harness's own
// missing `styles.css` import (fixed last round) and its habit of rendering
// `<Archipelago>` standalone both hid a real layout bug the author's own
// screenshot caught. Both read from the SAME `?fixture=<name>.json` the
// `?scene=archipelago` mode already uses (`{ archipelago, world }`), fetched
// once and cached.
let harnessFixtureCache: Promise<{ archipelago: IslandView[]; world: World }> | null = null;
function loadHarnessFixture(): Promise<{ archipelago: IslandView[]; world: World }> {
  const fixture = new URLSearchParams(window.location.search).get("fixture");
  if (!fixture) return Promise.reject(new Error("harness: missing ?fixture=<name>"));
  if (!harnessFixtureCache) {
    harnessFixtureCache = fetch(`/fixtures/${fixture}.json`).then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json();
    });
  }
  return harnessFixtureCache;
}

/**
 * One canned pane screen, in the SHAPE a real agent pane has: 23 rows by
 * about 55 columns, blank rows and all (`herdr pane get w2J:p1` reports
 * `viewport_rows: 23`; the divider rule claude draws is 54 characters wide).
 * That shape is load-bearing — an earlier version of this fixture was five
 * short lines, which made the terminal panel look reasonably full in a
 * screenshot while the author's real pane did not, and "the terminal is not
 * full sized" was therefore something only they could ever see.
 *
 * Only two lines depend on `paneId`, and they exist so a render can tell a
 * working terminal SWITCH (lag-and-switcher round, Item 2) from a broken
 * one: with one identical screen for every pane, the before and after
 * screenshots would match pixel for pixel below the header. The content is
 * canned and generic, like every handler here — never a copy of anything
 * from the author's own session.
 */
function paneScreen(paneId: string): string {
  return [
    " \x1b[1m▐▛███▛█\x1b[0m   Claude Code v2.1.278",
    " \x1b[1m▝▜██████▀\x1b[0m  Opus 5 (1M context) · Claude Max",
    ` \x1b[1m  ▝▝ ▝▝\x1b[0m    \x1b[2mpane ${paneId}\x1b[0m`,
    "",
    "\x1b[2m> port the CSV importer to the new schema\x1b[0m",
    "",
    "\x1b[2m⏺ Reading src/import/csv.ts…\x1b[0m",
    "  Mapped 9 of 11 columns; two need a decision:",
    "    · \x1b[33mlegacy_ref\x1b[0m  → drop, or keep as a note?",
    "    · \x1b[33mvat_rate\x1b[0m    → per-row, or per-invoice?",
    "",
    "  Tests: \x1b[32m42 passed\x1b[0m, 0 failed",
    "",
    "",
    "",
    "",
    "",
    "",
    "──────────────────────────────────────────────────────",
    `❯ \x1b[2m(${paneId})\x1b[0m`,
    "──────────────────────────────────────────────────────",
    "  \x1b[2m⏵⏵ auto mode on (shift+tab to cycle) · ← 4 agents\x1b[0m",
    "",
  ].join("\n");
}

const samplePreviewCode = (path: string) => `// Sample preview: ${path}\n// The native app reads your actual files.\n\nexport function ProjectWorkspace() {\n  return (\n    <TownWorkspace\n      showChanges\n      onSelectFile={openInspector}\n    />\n  );\n}\n`;

const HARNESS_HANDLERS: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {
  // Three kinds the REAL `agent_kinds()` can actually return, configured
  // default first — this used to list "aider", which is not one of the 21
  // kinds `AGENT_KINDS` (verified against `herdr agent start --help`)
  // contains, so every screenshot of a kind picker showed a menu entry the
  // shipped app could never offer. A harness that renders a lie is how
  // this project has been burned before; fixed with the terminal-polish
  // round's own kind-picker work (Item 4), which made this menu
  // load-bearing in two sheets instead of one.
  agent_kinds: async () => ["claude", "codex", "gemini"],
  // Accurate as-is: `builtin_resume_args()` covers exactly claude and
  // codex, the two whose resume invocation was verified on this machine.
  resumable_agent_kinds: async () => ["claude", "codex"],
  // The agent's herdr NAME, which is NOT its kind (`agent_name_taken`
  // round — herdr enforces global uniqueness on the name, and this app
  // used to send the kind for both, so it could start exactly one agent
  // per herdr session before failing forever).
  //
  // Mirrors `commands::agent_name_base` character for character: the
  // repository's own directory name, anything outside `[A-Za-z0-9._-]`
  // folded to `-`, runs collapsed, edges trimmed, capped at 64.
  //
  // WHAT THIS CANNOT MIRROR, stated rather than glossed: the real command
  // also checks the derived name against a live `agent.list` and appends
  // `-2`, `-3`, … if it is taken. There is no herdr here, so this always
  // renders the FREE case. That is the honest majority case (on the
  // author's machine exactly one name — `claude` — is taken, and no
  // repository is called that), but a screenshot from this harness is not
  // evidence that the suffix path renders correctly. Fixtures in this
  // project have been caught lying three times; this one says where its
  // edge is instead of becoming the fourth.
  proposed_agent_name: async (args) => {
    const root = typeof args?.root === "string" ? args.root : "";
    const base = (root.split("/").pop() ?? "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+/, "")
      .replace(/[-.]+$/, "")
      .slice(0, 64)
      .replace(/[-.]+$/, "");
    return base === "" ? "agent" : base;
  },
  // Includes real ANSI SGR colour codes (a green "passed", a dim path) —
  // proving `AnsiText`/`ansi.ts` actually renders colour in a screenshot,
  // not just plain text that happens to look fine either way. Security
  // review round: `read_agent` now returns `{ text, truncated }`, not a bare
  // string (MINOR 5 — see `agents.ts`'s `readAgent` doc comment); `truncated:
  // true` here is deliberate, so a screenshot of this harness also exercises
  // and shows `AgentActions`/`Terminal`'s own truncated-output badge, not
  // just the transcript.
  read_agent: async () => ({
    text:
      "$ claude\n" +
      "> implement the retry backoff for the sync worker\n" +
      "\x1b[2mReading src/sync/worker.ts...\x1b[0m\n" +
      "Added exponential backoff (base 200ms, cap 5s) around the fetch loop.\n" +
      "Running tests... \x1b[32m42 passed\x1b[0m.\n" +
      "Done — want me to wire this into the queue drain path too?",
    truncated: true,
  }),
  // Phase 0.7's interactive terminal (`Terminal.tsx`) polls `pane_read` —
  // read-only, so it's safe to answer here, same reasoning as `read_agent`
  // above. Real ANSI SGR colour codes again, so a screenshot of the terminal
  // actually exercises `ansi.ts`'s colour rendering, not plain text that
  // would look the same either way. `pane_send_text`/`pane_send_keys` are
  // deliberately NOT listed here — they fall through to the default
  // rejection below, exactly like every other herdr-touching write this
  // harness refuses, so a screenshot script can never send a real keystroke
  // anywhere even by accident.
  //
  // TERMINAL-POLISH ROUND — this fixture's SHAPE is now load-bearing, and
  // it was wrong before. It used to be five short lines, which made the
  // terminal panel look reasonably full in a screenshot while the author's
  // REAL pane is 23 rows by about 55 columns (`herdr pane get w2J:p1`
  // reports `viewport_rows: 23`; the divider rule claude draws is 54
  // characters wide). A harness that renders a fuller screen than any real
  // pane produces is exactly the kind of lie that has burned this project
  // before — it is why "the terminal is not full sized" could only be seen
  // by the author and never by us. So: 23 lines, ~55 columns, blank rows
  // and all, in the shape a real agent pane actually has.
  //
  // The CONTENT is canned and generic, like every other handler here —
  // never a copy of anything from the author's own session.
  //
  // LAG-AND-SWITCHER ROUND — it now varies BY PANE, and that is load-
  // bearing rather than decoration. Item 2 lets the terminal re-attach
  // itself to a different agent's pane; with one canned screen for every
  // pane, a render of "before the switch" and a render of "after the
  // switch" would be pixel-identical below the header, and a screenshot
  // could not tell a working switch from a broken one. Only the two
  // marked lines differ (the pane's own id, and the prompt it is sitting
  // on); everything else — 23 rows, ~55 columns, blank lines and all —
  // stays exactly the shape a real pane has.
  pane_read: async (args) => ({
    text: paneScreen(typeof args?.paneId === "string" ? args.paneId : "w?:p?"),
    revision: 0,
    truncated: false,
  }),
  // TERMINAL-FEEL ROUND — and this fake is a fixture with a sharp edge, so
  // it says which case it is rendering rather than quietly picking one.
  //
  // The real `pane_read_scrollback` asks herdr for `source: "recent"`, and
  // what comes back is ONE OF TWO THINGS, both measured live:
  //
  //   `?scrollback=1`  a shell pane that has scrolled — much more than the
  //                    visible screen (141 rows against 23, measured), so
  //                    the terminal shows a real scrollback view.
  //   (default)        a pane running a full-screen program — every one of
  //                    the author's live `claude` panes — where `recent`
  //                    returns EXACTLY the visible screen, because the
  //                    alternate screen has no scrollback. The terminal
  //                    then translates the wheel into PageUp and says so.
  //
  // The default is the author's own case on purpose: a harness that made
  // scrollback look universal would hide the very limitation this round
  // had to make legible.
  pane_read_scrollback: async (args) => {
    const paneId = typeof args?.paneId === "string" ? args.paneId : "w?:p?";
    const scrolled = new URLSearchParams(window.location.search).get("scrollback") === "1";
    if (!scrolled) return { text: paneScreen(paneId), revision: 0, truncated: false };
    const history = [
      `\x1b[2m$ git log --oneline -n 3\x1b[0m`,
      "8f21c04 make the importer tolerate a missing vat_rate",
      "1d9ab77 drop legacy_ref from the write path",
      "c002e51 first cut of the new schema",
      "",
    ];
    for (let batch = 0; batch < 20; batch += 1) {
      history.push(`\x1b[2m$ npm test -- --shard ${batch + 1}\x1b[0m`);
      history.push(`  \x1b[32m42 passed\x1b[0m, 0 failed  \x1b[2m(shard ${batch + 1} of 20)\x1b[0m`);
      history.push("");
    }
    history.push(paneScreen(paneId));
    return { text: history.join("\n"), revision: 0, truncated: false };
  },
  // The paste path's own read. Canned and generic like every other handler
  // here — this harness never touches the real clipboard.
  clipboard_read_text: async () => "npm run tauri dev",
  get_world: async () => {
    const data = await loadHarnessFixture();
    return data.world;
  },
  // Read-only filesystem scan (`UnsettledList`), added by the
  // start-agent-anywhere round so the HUD's unsettled list actually renders
  // in a harness shot instead of collapsing to its "could not scan" branch.
  // Derived FROM the fixture rather than invented: whichever islands the
  // fixture leaves out of `world.islands` are exactly the rows this list
  // shows, so a harness shot is steered by editing the fixture, not by
  // editing this file.
  //
  // One deliberate divergence from the real command, called out rather than
  // glossed: `list_unsettled` returns EVERY scanned repo, settled ones
  // included, and `subtractSettled` does the subtraction on this side —
  // keyed off `agent.cwd`, because that is where a workspace was actually
  // founded (see its doc comment). A static fixture has almost no agents,
  // so handing the raw list over would leave that subtraction a no-op and
  // render all 73 repos as "unsettled", which is the opposite of true. The
  // subtraction is therefore done here, against `world.islands`, so the
  // rows on screen are the ones a live backend would genuinely leave
  // standing. `default_agent` matches `agent_kinds`'s own first entry so
  // the confirm sheet and the kind picker cannot disagree.
  list_unsettled: async () => {
    const data = await loadHarnessFixture();
    const settled = new Set(data.world.islands.map((island) => island.root));
    return {
      roots: ["/Users/you/Projects"],
      repos: data.archipelago
        .filter((island) => !settled.has(island.root))
        .map((island) => ({ path: island.root, name: island.name })),
      home: "/Users/you",
      default_agent: "claude",
    };
  },
  get_archipelago: async () => {
    const data = await loadHarnessFixture();
    return { islands: data.archipelago };
  },
  // Art-direction round: lets `?app=1&openIslandRoot=<root>` open a REAL
  // `TownScreen` (this component's own header/back-button/stats chrome,
  // not a bare `<TownView>`) from within the real `<App/>` root — the same
  // "trust the real App path, the isolated-component harness has misled
  // you before" reasoning `get_world`/`get_archipelago` already answer for
  // the sea. `?cityFixture=<name>` (default `aoa-town`) names the
  // `city_fixture`-produced `CityView` JSON to serve — every island opened
  // this way shows that SAME canned city, regardless of which island's root
  // was actually requested; harness-only, exactly like the fixture's own
  // synthetic `world` half above.
  city_for: async (args) => {
    const params = new URLSearchParams(window.location.search);
    const cityFixture = params.get("cityFixture") ?? "aoa-town";
    const response = await fetch(`/fixtures/${cityFixture}.json`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const city: CityView = await response.json();
    // `?grow=1`: every measurement after the first acts as if an agent had
    // been writing — a few files gain lines (some enough to cross a height
    // bucket) and one new file appears — so live growth can be rendered
    // without a live agent. Harness-only, like the rest of this shim.
    const round = params.get("grow") === "1" ? harnessMeasurements++ : 0;
    if (round > 0) {
      // Cumulative, so each measurement differs from the one before it.
      const district = city.model.districts.find(d => d.buildings.length > 3) ?? city.model.districts[0];
      district.buildings.slice(0, 4).forEach((b, i) => { b.lines += [42, 180, 7, 260][i] * round; b.height = Math.min(5, b.height + (i % 2 === 1 ? round : 0)); });
      const template = district.buildings[0];
      for (let n = 1; template && n <= round; n++) district.buildings.push({ ...template, path: `${district.path}/streaming-${n}.ts`, name: `streaming-${n}.ts`, lines: 60 * n, height: 1 });
    }
    const root = typeof args?.path === "string" ? args.path : city.model.root;
    const rebase = (path: string) => root + path.slice(city.model.root.length);
    return { ...city, model: { ...city.model, root, name: root.split("/").pop() ?? city.model.name,
      districts: city.model.districts.map(d => ({ ...d, path: rebase(d.path), buildings: d.buildings.map(b => ({ ...b, path: rebase(b.path) })) })) } };
  },
  // Illustrative changes and code, never a read of the user's checkout.
  // The workspace preview carries a persistent "sample data" badge.
  repo_changes: async (args) => ({ root: args?.root, branch: "feature/town-workspace", truncated: false, entries: [
    { path: "src/App.tsx", previous_path: null, status: "modified", staged: true, unstaged: true },
    { path: "src/city.ts", previous_path: null, status: "modified", staged: false, unstaged: true },
    { path: "src/workspace.ts", previous_path: null, status: "untracked", staged: false, unstaged: true },
    { path: "src/legacy-panel.tsx", previous_path: null, status: "deleted", staged: false, unstaged: true },
  ] }),
  search_project_text: async (args) => {
    const query = typeof args?.query === "string" ? args.query : "";
    const fold = (value: string) => args?.caseSensitive ? value : value.toLowerCase();
    const paths = ["src/App.tsx", "src/city.ts", "src/workspace.ts"];
    const matches = query ? paths.flatMap(path => samplePreviewCode(path).split("\n").flatMap((text, index) => {
      const column = fold(text).indexOf(fold(query));
      return column < 0 ? [] : [{ path, line: index + 1, column: Array.from(text.slice(0, column)).length + 1, text, truncated: false }];
    })) : [];
    return { root: args?.root, query, matches, truncated: false, files_searched: paths.length, files_skipped: 0 };
  },
  inspect_project_path: async (args) => {
    const path = typeof args?.path === "string" ? args.path : "src/App.tsx";
    const deleted = path === "src/legacy-panel.tsx";
    const directory = !path.split("/").pop()?.includes(".");
    return { path, kind: deleted ? "missing" : directory ? "directory" : "text", truncated: false, diff_truncated: false,
      content: deleted || directory ? null : samplePreviewCode(path),
      staged_diff: path === "src/App.tsx" ? `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n-  <TownView />\n+  <TownWorkspace\n+    onSelectFile={openInspector}\n+  />\n` : "",
      unstaged_diff: deleted ? `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const legacyPanel = true;\n` : path === "src/App.tsx" || path === "src/city.ts" || directory ? `--- a/${path}\n+++ b/${path}\n@@ -4,1 +4,2 @@\n   <TownWorkspace\n+    showChanges\n` : "" };
  },
  // A plausible, canned `RepoHistory` — real values come from
  // `~/.age-of-agents/transitions.jsonl`, which cannot exist in a static
  // screenshot fixture (same category as the fixture's synthetic `world`
  // half — see this file's own doc comment above).
  repo_history: async () => ({
    root: "",
    name: "",
    spans: [],
    working_sessions: 6,
    total_working_secs: 5 * 3600 + 20 * 60,
    last_observed_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    current_status: "working",
    current_status_pane: null,
    current_status_since: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    current_status_since_exact: true,
    name_ambiguous: false,
    legacy_rows_matched_by_name: 0,
    legacy_rows_excluded_ambiguous: 0,
  }),
  // `@tauri-apps/api/event`'s `listen()` (used by `useWorld`) calls this —
  // the returned id is never looked up again since no event ever actually
  // fires in a static screenshot, so any distinct-looking number will do.
  "plugin:event|listen": async () => Math.floor(Math.random() * 1e9),
};

(
  window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      transformCallback: (cb: unknown) => number;
    };
  }
).__TAURI_INTERNALS__ = {
  // `args` used to be dropped on the floor here, which was fine while
  // every handler answered the same thing regardless of what was asked.
  // `proposed_agent_name` is the first one whose answer DEPENDS on its
  // argument (which repository), and a harness that ignored it would have
  // rendered one canned name on every island — exactly the kind of
  // plausible-looking lie a screenshot is supposed to catch.
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (["terminal_attach", "terminal_resize", "terminal_ack", "terminal_detach", "terminal_write", "terminal_scroll"].includes(cmd)) return terminalPreview(cmd, args);
    const handler = HARNESS_HANDLERS[cmd];
    if (handler) return handler(args);
    return Promise.reject(
      new Error(`"${cmd}" is disabled in the screenshot harness — fakes only, never the author's live session`),
    );
  },
  // `transformCallback` (also via `@tauri-apps/api/event`'s `listen()`)
  // registers a callback id with the real IPC bridge; there is none here, so
  // this just hands back a distinct number and drops the callback — the
  // `world-updated` event it would have wired up never fires against a
  // static fixture either way (`get_world`, above, already supplies the
  // full initial state).
  transformCallback: () => Math.floor(Math.random() * 1e9),
};

type HarnessState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; cityView: CityView };

/**
 * `?scene=archipelago&fixture=<name>` renders the SEA instead of a single
 * town — the archipelago-scene round's own extension of this harness (see
 * `src-tauri/src/bin/archipelago_fixture.rs` for how `<name>.json`'s
 * `archipelago` half is produced, via the exact same `build_archipelago`
 * pipeline `get_archipelago` uses, over the author's REAL repositories).
 *
 * The fixture's `world` half is the one deliberately synthetic piece in this
 * whole pipeline — real herdr agent/attention data can only come from a
 * live connection, which a static screenshot fixture cannot have. This is
 * the same category as `?orbit=1`/`?focus=` below: harness-only demonstration
 * data, never shipped, never presented as a live measurement (the sea's
 * ISLANDS — every root, plot, and city size — are 100% real; only the
 * overlaid "who is stopped/working" story on top of them is a stand-in for
 * a live herdr session).
 */
type ArchipelagoFixture = { archipelago: IslandView[]; world: World };

function ArchipelagoHarness({
  fixture,
  focusRoot,
  selectRoot,
  openSendAgent,
  expandPaneId,
  searchQuery,
  stateFilter,
  frameloop = "always",
}: {
  fixture: string;
  focusRoot?: string;
  selectRoot?: string;
  openSendAgent?: boolean;
  expandPaneId?: string;
  /** Search-and-filter round: passthrough for `?searchQuery=`/`?stateFilter=`
   * — lets `?scene=archipelago` (combined with `?focusRoot=`) render a
   * close-up of the match/recede styling on one specific island, without
   * needing the full `?app=1` HUD around it. */
  searchQuery?: string;
  stateFilter?: StateFilter;
  /** Mirrors the town `Harness`'s own `?frameloop=` (see its doc comment) —
   * `"demand"` bounds a headless screenshot to only the frames the scene
   * actually invalidates, instead of a continuous render loop. A UI-heavy
   * shot (a panel with an expanded agent accordion) has enough extra DOM to
   * make each of `"always"`'s many repaints noticeably slower under
   * software rendering, which a fixed `--virtual-time-budget` then has to
   * fully drain — ballooning real wall-clock time for no visual benefit in
   * a STATIC screenshot. Defaults to `"always"`, unchanged, for any
   * existing screenshot script that doesn't pass this. */
  frameloop?: "always" | "demand";
}) {
  const [state, setState] = React.useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: ArchipelagoFixture }
  >({ kind: "loading" });

  React.useEffect(() => {
    fetch(`/fixtures/${fixture}.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json() as Promise<ArchipelagoFixture>;
      })
      .then((data) => setState({ kind: "ready", data }))
      .catch((error) => setState({ kind: "error", message: String(error) }));
  }, [fixture]);

  if (state.kind === "loading") {
    return <div style={{ color: "#e6e9ef", padding: 20, font: "13px sans-serif" }}>loading fixture…</div>;
  }
  if (state.kind === "error") {
    return <div style={{ color: "#e0a44b", padding: 20, font: "13px sans-serif" }}>{state.message}</div>;
  }

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Archipelago
        archipelago={state.data.archipelago}
        islands={state.data.world.islands}
        onOpenIsland={() => {}}
        frameloop={frameloop}
        preserveDrawingBuffer
        focusRoot={focusRoot}
        autoSelectRoot={selectRoot}
        autoOpenSendAgent={openSendAgent}
        autoExpandPaneId={expandPaneId}
        searchQuery={searchQuery}
        stateFilter={stateFilter}
      />
    </div>
  );
}

function Harness() {
  const [state, setState] = React.useState<HarnessState>({ kind: "loading" });
  const params = new URLSearchParams(window.location.search);
  const fixture = params.get("fixture");
  const focus = params.get("focus") ?? undefined;
  const frameloop = params.get("frameloop") === "demand" ? "demand" : "always";
  const orbit = params.get("orbit") === "1";
  const selectBuilding = params.get("selectBuilding") === "1";
  const selectDistrict = params.get("selectDistrict") === "1";

  React.useEffect(() => {
    if (!fixture) {
      setState({ kind: "error", message: "missing ?fixture=<name>" });
      return;
    }
    fetch(`/fixtures/${fixture}.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json() as Promise<CityView>;
      })
      .then((cityView) => setState({ kind: "ready", cityView }))
      .catch((error) => setState({ kind: "error", message: String(error) }));
  }, [fixture]);

  const handleControlsReady = React.useCallback(
    (controls: Parameters<NonNullable<React.ComponentProps<typeof TownView>["onControlsReady"]>>[0]) => {
      if (!orbit || !controls) return;
      // A different azimuth AND a lower (more oblique) polar angle than the
      // fitted default, plus a zoom-in — deliberately far enough from the
      // initial framing that "did the camera actually move" is unambiguous
      // in a screenshot diff, not a judgment call.
      controls.setAzimuthalAngle(controls.getAzimuthalAngle() + Math.PI / 2.2);
      controls.setPolarAngle(Math.max(controls.minPolarAngle, controls.getPolarAngle() - 0.5));
      controls.dollyIn(1.6);
      controls.update();
    },
    [orbit],
  );

  if (state.kind === "loading") {
    return <div style={{ color: "#e6e9ef", padding: 20, font: "13px sans-serif" }}>loading fixture…</div>;
  }
  if (state.kind === "error") {
    return <div style={{ color: "#e0a44b", padding: 20, font: "13px sans-serif" }}>{state.message}</div>;
  }

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <TownView
        cityView={state.cityView}
        frameloop={frameloop}
        preserveDrawingBuffer
        focusDistrictPath={focus}
        onControlsReady={handleControlsReady}
        autoSelectFirstBuilding={selectBuilding}
        autoSelectFirstDistrict={selectDistrict}
      />
    </div>
  );
}

// Canned routes for visual verification only. Never touch browser persistence
// or enable send_prompt: all real writes are still rejected by the IPC shim.
const previewRoutes: TradeRoute[] = [
  { sourceName: "design-system", targetName: "AgeOfAgents", paneId: "w1:p1", agentKind: "codex", agentTitle: "Review the workspace redesign", brief: "Bring the component library into AgeOfAgents. Keep the town's character and improve the agent controls." },
  { sourceName: "tiny-tools", targetName: "fieldnotes", paneId: "w3:p1", agentKind: "claude", agentTitle: "Waiting for API credentials", brief: "Explore using the small markdown editor in fieldnotes. Propose how to preserve the existing note format." },
].map((route, index) => {
  const sourceRoot = `/demo/projects/${route.sourceName}`, targetRoot = `/demo/projects/${route.targetName}`;
  return { ...route, id: `preview-route-${index}`, sourceRoot, targetRoot, targetCwd: targetRoot, mode: "plan", createdAt: Date.UTC(2026, 8, 21, 12, index * 20),
    prompt: buildTradePrompt({ source: { root: sourceRoot, name: route.sourceName }, destination: { root: targetRoot, name: route.targetName }, cwd: targetRoot, brief: route.brief, mode: "plan" }) };
});
const previewRouteMemory = new Map([[TRADE_ROUTES_KEY, JSON.stringify({ version: 1, routes: previewRoutes })]]);
const previewRouteStorage = { getItem: (key: string) => previewRouteMemory.get(key) ?? null, setItem: (key: string, value: string) => { previewRouteMemory.set(key, value); } };

function Root() {
  const params = new URLSearchParams(window.location.search);
  // `?app=1&fixture=<name>` renders the REAL production root — `<App/>`
  // itself, unmodified, with no props from `main.tsx`'s point of view — so
  // a render actually shows the header/HUD/sea/panels exactly as the
  // shipped app assembles them, not a component tested in isolation. This
  // is the harness's answer to the coordinator's "your harness lied to
  // you": `?scene=archipelago` alone never rendered `.sea-hud` at all, so a
  // layout bug from the header/HUD interacting with the sea below it had no
  // way to show up in a `?scene=archipelago` screenshot.
  if (params.get("workspace") === "1") return <TradeRouteStorageContext.Provider value={params.get("routes") === "1" ? previewRouteStorage : null}><Workbench renderAtlas={() => <AtlasApp seaHarnessProps={{ autoOpenIslandRoot: params.get("openIslandRoot") ?? undefined, autoTownTerminalPaneId: params.get("townTerminalPaneId") ?? undefined, autoMood: (["day", "golden", "night"] as const).find((m) => m === params.get("mood")) }} />} initialView={params.get("view") === "world" ? "world" : "work"} /><div style={{ position: "fixed", bottom: 8, right: 12, zIndex: 100, pointerEvents: "none", font: "10px system-ui", color: "#dce8eb", background: "#263d4b", border: "1px solid #627d8c", borderRadius: 4, padding: "3px 7px" }}>Preview · sample data</div></TradeRouteStorageContext.Provider>;
  if (params.get("app") === "1") {
    return (
      <App
        seaHarnessProps={{
          autoSelectRoot: params.get("selectRoot") ?? undefined,
          autoOpenSendAgent: params.get("openSendAgent") === "1",
          autoOpenTerminal: params.get("openTerminal") === "1",
          autoExpandPaneId: params.get("expandPaneId") ?? undefined,
          // Search-and-filter round: `?searchQuery=`/`?stateFilter=` seed
          // `App`'s own search box / state-filter select, so a screenshot
          // can show them already active without simulating real typing.
          autoSearchQuery: params.get("searchQuery") ?? undefined,
          autoStateFilter: (params.get("stateFilter") as StateFilter | null) ?? undefined,
          autoOpenIslandRoot: params.get("openIslandRoot") ?? undefined,
          // Town-terminal round: `?townTerminalPaneId=` opens the town's
          // own embedded terminal on that pane, and `?selectVillager=1`
          // shows a selected villager's panel (facts + prompt box + last
          // output) without one — the two renders this round has to be
          // looked at, taken through the REAL `<App/>`/`TownScreen` path
          // rather than a stand-in.
          autoTownTerminalPaneId: params.get("townTerminalPaneId") ?? undefined,
          autoSelectFirstVillager: params.get("selectVillager") === "1",
          // Sea/town consistency round: `?villagerClickPaneId=` runs the
          // sea's REAL villager-click handler on that pane, so the render
          // of "clicked a villager in the sea" is evidence about the
          // shipped click path rather than about a state the harness set
          // by hand. See `Archipelago`'s `autoVillagerClickPaneId`.
          autoVillagerClickPaneId: params.get("villagerClickPaneId") ?? undefined,
          autoRecording: params.get("recording") === "1",
          autoMood: (["day", "golden", "night"] as const).find((m) => m === params.get("mood")),
        }}
      />
    );
  }
  if (params.get("scene") === "archipelago") {
    const fixture = params.get("fixture");
    if (!fixture) {
      return <div style={{ color: "#e0a44b", padding: 20, font: "13px sans-serif" }}>missing ?fixture=&lt;name&gt;</div>;
    }
    return (
      <ArchipelagoHarness
        fixture={fixture}
        focusRoot={params.get("focusRoot") ?? undefined}
        selectRoot={params.get("selectRoot") ?? undefined}
        openSendAgent={params.get("openSendAgent") === "1"}
        expandPaneId={params.get("expandPaneId") ?? undefined}
        searchQuery={params.get("searchQuery") ?? undefined}
        stateFilter={(params.get("stateFilter") as StateFilter | null) ?? undefined}
        frameloop={params.get("frameloop") === "demand" ? "demand" : "always"}
      />
    );
  }
  return <Harness />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
