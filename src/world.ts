export type Attention = "stopped" | "working" | "unknown" | "quiet";
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type Agent = {
  pane_id: string;
  workspace_id: string;
  status: AgentStatus;
  /**
   * This agent's OWN attention — the exact same per-pane computation that
   * feeds the island roll-up (`Island.attention`), not a second derivation.
   * Lets the UI show which specific pane within a multi-agent island is the
   * one that stopped, instead of only the island-wide marker.
   */
  attention: Attention;
  title: string | null;
  /**
   * WHICH KIND of agent is running in this pane — `"claude"`, `"codex"`,
   * whatever herdr named it — mirroring Rust's `world::state::IslandAgent::
   * kind` field for field (an `Option<String>` serializes to a JSON string
   * or `null`, never an absent key), which in turn is herdr's own
   * per-pane `agent`.
   *
   * `null` means genuinely unknown: herdr reported no kind for this pane
   * (verified live — a plain shell pane omits the key entirely, and
   * herdr's schema also permits an explicit `null`). It is NEVER a
   * fabricated stand-in — not `"claude"`, not the configured default kind
   * (`useAgentKinds`'s `kinds[0]`, which answers the different question of
   * what a NEW agent would be), not guessed from `title`. Every reader
   * (`VillagerPanel`, `IslandPanel`'s agent rows) must render `null` by
   * showing nothing at all rather than filling the gap.
   */
  kind: string | null;
  is_worktree: boolean;
  /**
   * This pane's own working directory, already canonicalized by Rust
   * (`world::repo::normalize_path`) — the webview cannot canonicalize, so
   * every path it compares must arrive that way.
   *
   * Deliberately NOT `Island.root`: `root` is where the pane RESOLVES TO
   * after worktrees collapse onto their main repository (one island per
   * repository), while `cwd` is where the workspace was actually founded.
   * `subtractSettled` in `founding.ts` needs the latter — see its comment.
   */
  cwd: string;
};

export type Island = {
  id: string;
  name: string;
  root: string;
  attention: Attention;
  agents: Agent[];
  /**
   * Unix seconds of `root`'s most recent commit, per Rust's
   * `world::repo::RepoResolver::last_changed` — mirrors
   * `Island.last_changed_at` field for field (an `Option<i64>` serializes to
   * a JSON number or `null`, never an absent key). `null` means genuinely
   * unknown (no commits yet, not a repository, or the git call
   * failed/timed out) — NEVER a fabricated stand-in like "now" or the
   * epoch. Every reader of this field (`compareByRecency`,
   * `formatLastChanged` in `lastChanged.ts`) must treat `null` as "unknown,"
   * sorting and rendering it honestly rather than guessing.
   */
  last_changed_at: number | null;
};

export type World = {
  islands: Island[];
  herdr_connected: boolean;
  herdr_version: string;
  protocol_mismatch: boolean;
};

/**
 * The ONE attention ordering in the frontend: whatever needs the human comes
 * first. `unknown` sits between `working` and `quiet`, mirroring the
 * backend's own `Attention` ordering — it is not a claim that anything needs
 * doing, but it is not the calm "nothing to do" either.
 *
 * Exported because the terminal switcher (`agentSwitcher.ts`) orders its
 * tabs by exactly this, and two different answers to "which of these
 * matters more" on two surfaces the user sees at the same time would be a
 * disagreement about the only question this product asks.
 */
export const ATTENTION_RANK: Record<Attention, number> = { stopped: 0, working: 1, unknown: 2, quiet: 3 };

/**
 * THE ONE VOCABULARY for the four states this app has spoken since its
 * first round — the glyph, and the words behind it.
 *
 * WHY THIS LIVES HERE (sea/town consistency round). It was written out four
 * times, identically, in `IslandGrid`, `IslandPanel`, `Archipelago` and
 * `Terminal` — one of them (`Terminal`, whose switcher strip appears over
 * BOTH screens) carrying the comment "the SAME glyph and wording
 * `IslandPanel`'s own agent rows use — the switcher must not invent a third
 * vocabulary", with nothing but that sentence enforcing it. This project has
 * already paid real time for a label that existed in two places and drifted
 * (§9.3 of the follow-ups); four copies of the words for "stopped — needs
 * you" is the same bet, taken four times, on the surfaces where the user is
 * reading them side by side.
 *
 * `unknown` is deliberately NOT `·`: herdr does not know what that agent is
 * doing, and principle 4 forbids drawing a guess as a calm fact. It is kept
 * visually quiet (see `.island--unknown` in `styles.css`) so it never
 * competes with ❗.
 *
 * `SeaSearchBar` keeps its OWN wording ("needing you", "unclear") on
 * purpose, and says so at the site: those strings name FILTER OPTIONS in a
 * sentence ("showing islands needing you"), not the state of one agent, and
 * folding them in here would make one of the two read wrong.
 */
export const ATTENTION_MARK: Record<Attention, string> = {
  stopped: "❗",
  working: "⚒",
  unknown: "?",
  quiet: "·",
};

/**
 * What an agent is working on, short enough to hang over a villager:
 * Herdr's terminal title without its leading spinner/status glyph (`◑`,
 * `✳` — the badge beside it already says that), cut to `max` characters.
 * `null` when there is no real title, so nothing is drawn rather than a
 * made-up one.
 */
export function taskLabel(title: string | null, max = 28): string | null {
  const text = (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export const ATTENTION_LABEL: Record<Attention, string> = {
  stopped: "stopped — needs you",
  working: "working",
  unknown: "herdr cannot tell what this agent is doing",
  quiet: "idle",
};

/**
 * The two orderings the header's sort control switches between. Both are
 * ATTENTION-first (see `sortIslands`) — `"name"` (the original, and still
 * the default) breaks ties alphabetically, `"recency"` breaks ties by
 * `Island.last_changed_at`, most recent first.
 */
export type IslandSortMode = "name" | "recency";

function compareByName(a: Island, b: Island): number {
  return a.name.localeCompare(b.name);
}

/**
 * Most-recently-changed first. An island whose `last_changed_at` is `null`
 * (genuinely unknown — see that field's doc comment on `Island`) sorts LAST
 * within its attention group: never substituted with "now" (which would
 * float a repo of unknown age to the top as though it were the freshest)
 * and never left to float to the top by accident of comparator arithmetic
 * either. Falls back to name whenever the recency comparison alone would be
 * a tie (both unknown, or the same timestamp), so the ordering stays
 * deterministic rather than depending on the sort's stability.
 */
function compareByRecency(a: Island, b: Island): number {
  const aKnown = a.last_changed_at !== null;
  const bKnown = b.last_changed_at !== null;
  if (aKnown && bKnown) {
    return b.last_changed_at! - a.last_changed_at! || compareByName(a, b);
  }
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  return compareByName(a, b);
}

/**
 * `mode` only ever changes the TIE-BREAKER within an attention group, never
 * the primary key: the whole product is a hotkey that jumps to whichever
 * agent has stopped and needs the human, so a stopped island must never be
 * buried below a calm one just because it was committed to more recently
 * (or less recently) — see the coordinator's explicit call on this in the
 * visual-overhaul follow-up. `mode` defaults to `"name"`, the ordering this
 * function always used before `last_changed_at` existed, so every existing
 * caller that doesn't pass a mode keeps its exact prior behaviour.
 */
export function sortIslands(islands: Island[], mode: IslandSortMode = "name"): Island[] {
  const tiebreak = mode === "recency" ? compareByRecency : compareByName;
  return [...islands].sort(
    (a, b) => ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention] || tiebreak(a, b),
  );
}

/**
 * "Who needs me" — the count the game-feel round's persistent HUD badge
 * shows (see `App.tsx`'s `WhoNeedsMe`). Counts individual STOPPED AGENTS,
 * not stopped islands: an island with two agents where only one is stopped
 * genuinely has one person waiting on the human, not zero or two, and this
 * is the same per-agent `attention` field `IslandPanel`'s own agent rows
 * already read (never a second, differently-scoped derivation of "stopped").
 */
export function countStoppedAgents(islands: Island[]): number {
  return islands.reduce(
    (sum, island) => sum + island.agents.filter((agent) => agent.attention === "stopped").length,
    0,
  );
}

/**
 * I2 (Opus frontend review): `App.tsx`'s `openIsland` used to be captured
 * once, at click time, and never re-derived — but `TownView`'s villagers
 * colour their own heads by `agent.attention`, a LIVE signal, so a town left
 * open for even a minute would keep showing whichever agents were working or
 * stopped at the moment it was opened, not now. `liveIslandFor` is the fix:
 * re-derive the open island from the CURRENT `world.islands` by `root` on
 * every render, falling back to `snapshot` only when the live world doesn't
 * (yet, or ever, for a genuinely unsettled repo opened straight from the
 * sea) know this root at all — never silently losing the island the user is
 * actually looking at just because it hasn't been settled.
 */
export function liveIslandFor(snapshot: Island, worldIslands: Island[]): Island {
  return worldIslands.find((island) => island.root === snapshot.root) ?? snapshot;
}

const SORT_MODE_STORAGE_KEY = "aoa.islandSortMode";

/**
 * The header's sort control remembers the user's choice between launches —
 * `localStorage` only, deliberately: this is a small per-machine UI
 * preference, not state worth a backend (the author's own instruction).
 * Wrapped in `try`/`catch` because `localStorage` can throw (privacy mode,
 * disabled storage, or — for every non-`jsdom` test in this codebase — not
 * existing at all outside a browser/webview): a preference that fails to
 * load is not worth crashing the app over, so this falls back to the
 * original default (`"name"`) exactly as if nothing had ever been saved.
 */
export function loadIslandSortMode(): IslandSortMode {
  try {
    return localStorage.getItem(SORT_MODE_STORAGE_KEY) === "recency" ? "recency" : "name";
  } catch {
    return "name";
  }
}

/** The save side of `loadIslandSortMode` — same best-effort rationale. */
export function saveIslandSortMode(mode: IslandSortMode): void {
  try {
    localStorage.setItem(SORT_MODE_STORAGE_KEY, mode);
  } catch {
    // Best-effort only — see `loadIslandSortMode`.
  }
}

export const EMPTY_WORLD: World = {
  islands: [], herdr_connected: false, herdr_version: "", protocol_mismatch: false,
};

/**
 * One incoming piece of world data: either the one-shot `get_world` fetch
 * a hook makes on mount, or a `world-updated` push event.
 */
export type WorldUpdate =
  | { kind: "initial"; world: World }
  | { kind: "event"; world: World };

export type WorldFoldState = { world: World; eventArrived: boolean };

export const INITIAL_FOLD_STATE: WorldFoldState = { world: EMPTY_WORLD, eventArrived: false };

/**
 * Resolves the race between the initial `get_world` fetch and the
 * `world-updated` event stream: both are kicked off concurrently, so the
 * fetch's promise can settle after one or more events have already landed.
 * An event is always at least as fresh as a concurrently-in-flight fetch
 * (herdr only emits it once that state exists), so once any event has
 * arrived, a still-pending initial fetch is stale and must not overwrite it.
 *
 * An event always applies immediately - it is by definition newer than
 * whatever is currently rendered.
 */
export function foldWorldUpdate(state: WorldFoldState, update: WorldUpdate): WorldFoldState {
  if (update.kind === "initial" && state.eventArrived) return state;
  return { world: update.world, eventArrived: state.eventArrived || update.kind === "event" };
}
