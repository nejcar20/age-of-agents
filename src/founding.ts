import type { Island } from "./world";

export type Unsettled = { path: string; name: string };

/** What `list_unsettled` returns — kept snake_case verbatim, matching every
 * other Tauri payload in this codebase (no camelCase conversion).
 *
 * `repos` is EVERY scanned repo, settled ones included: the backend no
 * longer subtracts (see `subtractSettled`). */
export type UnsettledReport = {
  roots: string[];
  repos: Unsettled[];
  home: string;
  default_agent: string;
};

/**
 * The repos from a `list_unsettled` scan that do NOT already have a herdr
 * workspace, given the world as it stands right now.
 *
 * FINAL WHOLE-BRANCH REVIEW, Critical — why this moved here, and why it
 * keys off `agent.cwd` rather than `island.root`.
 *
 * `island.root` is where a pane RESOLVES TO. `world::repo` deliberately
 * collapses a git worktree onto its MAIN repository (Phase 0's
 * one-island-per-repository rule), so a workspace founded on `/p/repo-wt`
 * produces an island rooted at `/p/repo`. Deriving the settled set from
 * `root` therefore got both rows wrong at once: it hid `/p/repo`, which has
 * no workspace and is now unfoundable, and kept offering `/p/repo-wt`,
 * which has one — a second workspace on the same worktree, one restart
 * later. `agent.cwd` is where the workspace was actually founded, so it is
 * the honest input. It also does not drift when `foreground_cwd` does.
 *
 * Doing the subtraction HERE, against the world the UI already holds,
 * rather than in Rust against a snapshot taken at fetch time, is what let
 * three separate patches be deleted: the session-long `foundedPaths` memo,
 * the optimistic removal on success, and the debounced refetch on every
 * `world-updated`. The world IS the input now, so the list re-derives
 * itself the instant the world changes, and it forgets just as readily —
 * close a workspace in herdr and the repo comes back, which the
 * `foundedPaths` version could not do until the app restarted.
 *
 * A pane sitting several directories inside a repo still settles that repo:
 * it is the same repository, and Phase 0 draws it as one island. The prefix
 * test is path-segment aware so `/p/api-docs` is not mistaken for something
 * inside `/p/api`.
 *
 * Both sides are already canonical when they reach here — Rust canonicalizes
 * scanned repo paths, `IslandAgent.cwd`, and the `browse…` dialog's path.
 */
export function subtractSettled(repos: Unsettled[], islands: Island[]): Unsettled[] {
  const cwds = islands.flatMap((island) => island.agents.map((agent) => agent.cwd));
  return repos.filter(
    (repo) => !cwds.some((cwd) => cwd === repo.path || cwd.startsWith(`${repo.path}/`)),
  );
}

/**
 * Whether an unsettled-list trigger is worth a filesystem walk.
 *
 * The prior implementation refetched on every `world-updated` event and was
 * deleted for cause: Herdr pushes far more world updates than the unsettled
 * set actually changes, and that produced roughly 279 scans in 15 seconds.
 * `world-updated` must never drive a rescan again — the settled subtraction
 * already reacts to the world on its own (`subtractSettled`, computed at
 * render time), so only the raw scan needs a trigger at all, and only two
 * things are worth walking the filesystem for: the user asking directly
 * (`manual`, the rescan button) and the window regaining focus after the
 * user could plausibly have cloned something outside the app (`focus`).
 * `mount` always scans because there is no previous scan to compare against.
 *
 * `focus` fires constantly while alt-tabbing, so it is gated on staleness:
 * a scan within the last `RESCAN_STALE_AFTER_MS` is assumed still accurate,
 * which is what keeps window-switching from re-walking the filesystem on
 * every click. Split out as a pure function, same as `foldWorldUpdate`
 * (`world.ts`) and `foldFounding` above, because there is no DOM test
 * environment in this project — this is how the policy gets tested at all.
 */
export const RESCAN_STALE_AFTER_MS = 10_000;

export function shouldRescan(
  trigger: "focus" | "manual" | "mount",
  lastScanAt: number,
  now: number,
): boolean {
  if (trigger === "mount" || trigger === "manual") return true;
  return now - lastScanAt >= RESCAN_STALE_AFTER_MS;
}

/**
 * What `UnsettledList` should actually show, given the raw scan state.
 *
 * Fix round 1, Critical: `error` used to be rendered ONLY in the branch
 * where no report had ever loaded (`report === null`). Once the first scan
 * succeeds, `report` is non-null forever, so every LATER failure — a
 * transient IPC hiccup, a filesystem error on a `focus` or manual rescan —
 * set `error` and nothing ever read it again: the user kept seeing the old
 * list next to a "scanned at" timestamp frozen at the last successful scan,
 * which looks current and is not. Keeping the stale list on screen instead
 * of discarding known-good data on a transient error is still the right
 * call (principle 4 does not require throwing away data, only not lying
 * about it) — the fix is to make the UI SAY the list may be stale, not to
 * blank it.
 *
 * Pulled out as a pure function, same reasoning as `shouldRescan` above:
 * there is no DOM test environment in this project, so this is how "does a
 * failed rescan after a successful one get surfaced" is actually tested,
 * rather than eyeballed in a running app.
 *
 * The four states:
 * - `loading`: no report yet and no error yet (the initial mount fetch is
 *   still in flight). Nothing honest to say yet — render nothing.
 * - `error-no-data`: the FIRST scan failed, so there has never been a real
 *   report. This is the original error branch's behavior, preserved
 *   exactly: no `browse…`, no confirm sheet, because there is no real
 *   `default_agent` to name in it yet.
 * - `stale-with-error`: a report exists, but the most recent attempt to
 *   refresh it failed. This is the state fix round 1 added: the list stays
 *   visible (it is still the best information available) but the error
 *   must be shown ALONGSIDE it, not silently dropped.
 * - `ok`: a report exists and nothing has gone wrong since.
 *
 * `lastScanAt` is accepted (rather than the function taking only `report`
 * and `error`) so the full state `UnsettledList` tracks is one shape callers
 * can pass straight through, and so a future caller that wants to fold
 * staleness (e.g. "warn if the last successful scan itself is very old")
 * into this decision has everywhere it needs already in one place. It does
 * not affect today's four outcomes: whether the list is stale-with-error is
 * a function of `report`/`error` alone.
 */
export type ListStatus =
  | { kind: "loading" }
  | { kind: "error-no-data"; error: string }
  | { kind: "stale-with-error"; error: string }
  | { kind: "ok" };

export function listStatus({
  report,
  error,
}: {
  report: UnsettledReport | null;
  error: string | null;
  lastScanAt: number | null;
}): ListStatus {
  if (report === null) {
    return error === null ? { kind: "loading" } : { kind: "error-no-data", error };
  }
  return error === null ? { kind: "ok" } : { kind: "stale-with-error", error };
}

/**
 * The exact lines the confirm sheet shows before anything runs (principle
 * 1 — nothing is called until the button is pressed). These are the literal
 * herdr calls `found_settlement` makes on the backend
 * (`herdr::launch::create_workspace` / `start_agent`), spelled out so the
 * user is never asked to trust a paraphrase.
 */
export function foundingSummary(
  repo: Unsettled,
  agent: string,
  startAgent: boolean,
  agentName: string | null = null,
): string[] {
  const lines = [
    `workspace.create  cwd="${repo.path}"  label="${repo.name}"`,
  ];
  if (startAgent) {
    // `name` and `kind` are TWO DIFFERENT THINGS and this line used to
    // print the kind for both, because the backend sent the kind for both.
    // herdr requires the name to be globally unique and refuses a
    // duplicate, so that shipped an app which could start exactly one
    // agent ever (`agent_name_taken`, four orphaned workspaces on the
    // author's machine). The name now comes from `proposed_agent_name`,
    // which is the same Rust function `found_settlement` itself calls.
    //
    // Omitted entirely while unknown rather than guessed — this block's
    // whole contract is that it names the call that will run, and an
    // invented name would be a worse lie than a missing parameter. Same
    // rule `startAgentSummary` already applies to an unresolved kind.
    lines.push(
      agentName === null
        ? `agent.start       kind="${agent}"`
        : `agent.start       name="${agentName}"  kind="${agent}"`,
    );
  }
  return lines;
}

/**
 * Renders `path` the way a human reads their own filesystem: the home
 * directory collapsed to `~`, exactly as a shell prompt would.
 *
 * Used for BOTH the scanned roots ("looked in ~/Projects") and each repo's
 * own path, so the two lines the unsettled list renders describe the same
 * tree in the same spelling — see the carried finding in the Task 4 brief:
 * `list_unsettled` now normalizes (canonicalizes) `roots` the same way it
 * already normalized `repos[].path`, so both sides are the same underlying
 * string before this function ever touches them; this is the readability
 * pass on top of that fix, not a substitute for it.
 */
export function displayPath(path: string, home: string): string {
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * The confirm sheet's own state: which repo is being founded, whether the
 * agent checkbox is on, whether a call is currently in flight, and — this
 * is the part fix round 1 found missing — the error from a failed attempt,
 * kept ON THE SHEET rather than somewhere the sheet's own `position: fixed`
 * overlay (`.sheet` in styles.css) would paint over. `null` means the sheet
 * is closed, and nothing calls `found_settlement` while it is (principle 1).
 */
export type Sheet = {
  repo: Unsettled;
  startAgent: boolean;
  /** Which agent kind the confirm button will actually start (Item 4 of
   * the terminal-polish round — the author: "where cna i choose which
   * claude od codex?"). Seeded from the configured default, which is
   * `agent_kinds()[0]`, and changed by the sheet's own picker.
   *
   * It is a plain string rather than `string | null` because there is
   * always an answer: something IS going to be started, and the sheet's
   * whole contract is to name it before anything runs. The one caller that
   * genuinely does not know yet (`agent_kinds()` still in flight) keeps
   * its opener disabled until it does. */
  agentKind: string;
  founding: boolean;
  error: string | null;
};

/**
 * `UnsettledList`'s whole state: the scanned repo list as the backend last
 * reported it, the confirm sheet, and the id of the last successful
 * founding (shown outside the sheet, once it closes).
 *
 * `repos` is the RAW scan — settled ones included. What the user sees is
 * `subtractSettled(state.repos, islands)`, recomputed on every render from
 * the live world, so nothing in this reducer has to model "which repos have
 * been founded". That is what removed `foundedPaths` and the optimistic
 * removal along with it.
 */
export type FoundingState = {
  repos: Unsettled[];
  sheet: Sheet | null;
  lastFounded: string | null;
  /** The NAME herdr actually gave the agent the last successful founding
   * started, or `null` when that founding started no agent.
   *
   * This is the after-the-fact half of the `agent_name_taken` fix. The
   * sheet PREDICTS a name (`proposed_agent_name`, a read-only lookup) and
   * herdr has no way to reserve one, so the command resolves again at call
   * time and reports what it really sent. Recording it here is what lets
   * the outcome line say the true name rather than leaving the user to
   * assume the prediction held. */
  lastAgentName: string | null;
};

export const INITIAL_FOUNDING_STATE: FoundingState = {
  repos: [],
  sheet: null,
  lastFounded: null,
  lastAgentName: null,
};

export type FoundingAction =
  | { kind: "reposLoaded"; repos: Unsettled[] }
  /** `agentKind` is the kind the sheet opens PRESELECTED on — the
   * configured default. Deliberately a required field rather than a
   * defaulted one: the sheet prints the exact calls that will run, so
   * "which agent" can never be a thing this reducer invents. */
  | { kind: "openSheet"; repo: Unsettled; agentKind: string }
  | { kind: "closeSheet" }
  | { kind: "toggleStartAgent" }
  | { kind: "chooseAgentKind"; agentKind: string }
  | { kind: "foundingStarted" }
  | { kind: "foundingSucceeded"; workspaceId: string; agentName?: string | null }
  | { kind: "foundingFailed"; error: string };

/**
 * The pure decision logic behind `UnsettledList`, split out for the same
 * reason `foldWorldUpdate` (`world.ts`) is: the invariants that matter here
 * are async-race invariants, and a reducer lets them be asserted directly
 * against data instead of through a DOM harness. Fix round 1's two
 * Criticals were both races in the imperative version of this logic
 * (`useState` + ad hoc `set*` calls with no single source of truth for
 * "is a call in flight" or "what does the sheet currently say"); a reducer
 * makes both invariants checkable in one place:
 *
 * - `foundingStarted` is a no-op once `sheet.founding` is already true, so
 *   a double click (or a re-fired event while the promise is pending)
 *   cannot issue a second `found_settlement` call. The no-op returns
 *   `state` BY REFERENCE, not a rebuilt-but-equal copy — this is what
 *   makes the guard actually testable: a `toEqual` comparison cannot tell
 *   a guarded no-op from an unguarded re-application that happens to
 *   produce the same values (fix round 2, Important 1), but `toBe` can.
 * - `closeSheet` is likewise a no-op while `founding` is true (fix round 2,
 *   Minor 3): today `UnsettledList` also disables the cancel button
 *   mid-flight, so this is currently unreachable through the UI, but
 *   without the guard here a future caller that fires it anyway would
 *   silently drop the sheet, and the `foundingSucceeded`/`foundingFailed`
 *   that resolves moments later would become a no-op against a `null`
 *   sheet — a founding that completed with no visible outcome at all.
 * - `foundingFailed` never closes the sheet and always attaches the error
 *   to it — the sheet is where the user is actually looking (it is a
 *   `position: fixed` overlay; a status line elsewhere in the page paints
 *   underneath it and is invisible), so an honest failure (principle 4)
 *   has to surface there or it does not surface at all.
 * - `foundingSucceeded` closes the sheet and records the workspace id. It
 *   does NOT remove the repo from `repos` (final whole-branch review): the
 *   displayed list is `subtractSettled(repos, islands)`, so the row leaves
 *   the moment the world reports the new workspace's pane, from the same
 *   source of truth as everything else. An optimistic removal here would be
 *   a second, divergent answer to the same question — which is precisely
 *   what needed `foundedPaths` to keep a stale `reposLoaded` from undoing
 *   it. Both are gone.
 * - `reposLoaded` stores the raw scan verbatim. It has nothing to filter
 *   against any more, and a fetch that resolves late can no longer "undo"
 *   anything, because the subtraction is not stored state.
 */
export function foldFounding(state: FoundingState, action: FoundingAction): FoundingState {
  switch (action.kind) {
    case "reposLoaded":
      return { ...state, repos: action.repos };

    case "openSheet":
      // Deliberately does NOT touch `lastFounded` — a prior "founded <id>"
      // confirmation must survive opening the next sheet, not vanish the
      // moment the user looks at another repo (fix round 1, minor finding).
      return {
        ...state,
        sheet: {
          repo: action.repo,
          startAgent: true,
          agentKind: action.agentKind,
          founding: false,
          error: null,
        },
      };

    case "closeSheet":
      if (state.sheet !== null && state.sheet.founding) return state;
      return { ...state, sheet: null };

    case "toggleStartAgent":
      if (state.sheet === null) return state;
      return { ...state, sheet: { ...state.sheet, startAgent: !state.sheet.startAgent } };

    // Guarded on `founding` for the same reason `closeSheet` is: the
    // sheet's `<select>` is disabled mid-flight, but if it ever were not,
    // changing the kind while the call is in the air would leave the sheet
    // naming an agent other than the one being started — the precise
    // dishonesty this sheet exists to prevent.
    case "chooseAgentKind":
      if (state.sheet === null || state.sheet.founding) return state;
      return { ...state, sheet: { ...state.sheet, agentKind: action.agentKind } };

    case "foundingStarted":
      if (state.sheet === null || state.sheet.founding) return state;
      return { ...state, sheet: { ...state.sheet, founding: true, error: null } };

    case "foundingSucceeded":
      if (state.sheet === null) return state;
      return {
        ...state,
        sheet: null,
        lastFounded: action.workspaceId,
        // `?? null` rather than "keep the previous one": a founding that
        // started no agent must not inherit the last one's name and read
        // as though it had.
        lastAgentName: action.agentName ?? null,
      };

    case "foundingFailed":
      if (state.sheet === null) return state;
      return { ...state, sheet: { ...state.sheet, founding: false, error: action.error } };
  }
}
