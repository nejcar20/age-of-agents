import { describe, expect, it } from "vitest";
import {
  displayPath,
  foldFounding,
  foundingSummary,
  INITIAL_FOUNDING_STATE,
  listStatus,
  shouldRescan,
  subtractSettled,
  type FoundingState,
  type UnsettledReport,
} from "./founding";
import type { Agent, Island } from "./world";

const repo = { path: "/Users/me/Projects/api", name: "api" };

describe("foundingSummary", () => {
  // THE `agent_name_taken` FIX, as a test. `name` and `kind` used to be the
  // same string here because the backend sent the same string for both, and
  // herdr requires the name to be globally unique — so the first `claude`
  // this app started claimed the name `claude` for the whole herdr session
  // and every later start failed. The name is now the repository's, looked
  // up and de-duplicated in Rust (`proposed_agent_name`), and this block
  // prints whatever that answered.
  it("names the exact herdr calls, so nothing runs unseen", () => {
    expect(foundingSummary(repo, "claude", true, "api")).toEqual([
      'workspace.create  cwd="/Users/me/Projects/api"  label="api"',
      'agent.start       name="api"  kind="claude"',
    ]);
  });

  it("never prints the kind as the agent name, whatever the kind is", () => {
    // A regression guard with teeth: if the name were ever wired back to
    // the kind, this passes only by accident of `api` !== `codex`.
    const [, agentLine] = foundingSummary(repo, "codex", true, "api-2");
    expect(agentLine).toContain('name="api-2"');
    expect(agentLine).toContain('kind="codex"');
    expect(agentLine).not.toContain('name="codex"');
  });

  it("omits the name it does not know rather than inventing one", () => {
    // `proposed_agent_name` still in flight (or failed). The one thing this
    // block may never do is print a guess — it exists to name the call that
    // will actually run.
    expect(foundingSummary(repo, "claude", true)).toEqual([
      'workspace.create  cwd="/Users/me/Projects/api"  label="api"',
      'agent.start       kind="claude"',
    ]);
  });

  it("omits the agent line when only a shell is wanted", () => {
    expect(foundingSummary(repo, "claude", false)).toEqual([
      'workspace.create  cwd="/Users/me/Projects/api"  label="api"',
    ]);
  });
});

describe("displayPath", () => {
  it("shortens the home directory to ~", () => {
    expect(displayPath("/Users/me/Projects/api", "/Users/me")).toBe("~/Projects/api");
  });

  it("shortens home itself to ~", () => {
    expect(displayPath("/Users/me", "/Users/me")).toBe("~");
  });

  it("leaves paths outside home untouched", () => {
    expect(displayPath("/Volumes/work/api", "/Users/me")).toBe("/Volumes/work/api");
  });

  it("does not shorten a sibling directory that merely shares a prefix", () => {
    expect(displayPath("/Users/mearth/api", "/Users/me")).toBe("/Users/mearth/api");
  });
});

const agent = (paneId: string, workspaceId: string, cwd: string): Agent => ({
  pane_id: paneId,
  workspace_id: workspaceId,
  status: "idle",
  attention: "quiet",
  title: null,
  kind: null,
  is_worktree: false,
  cwd,
});

const island = (root: string, agents: Agent[]): Island => ({
  id: root,
  name: root.split("/").pop() ?? root,
  root,
  attention: "quiet",
  agents,
  last_changed_at: null,
});

describe("subtractSettled", () => {
  // FINAL WHOLE-BRANCH REVIEW, Critical. The settled set used to be derived
  // from `island.root` — where a pane RESOLVES TO — instead of the pane's own
  // cwd, where the workspace was actually founded. `world::repo` deliberately
  // collapses a worktree onto its MAIN repo (one island per repository), so
  // for a workspace founded on `/p/repo-wt` the island's root is `/p/repo`.
  // Subtracting by root therefore hid the wrong row (`/p/repo`, which has no
  // workspace) and left the founded worktree clickable — a second workspace
  // on the same worktree, one restart later.
  it("hides a founded worktree and keeps its main repo offered", () => {
    const world = [
      // The worktree's pane collapsed onto the main repo's island, exactly as
      // `world::repo::RepoResolver` produces it.
      island("/p/repo", [agent("w7:p1", "w7", "/p/repo-wt")]),
    ];

    expect(
      subtractSettled([{ path: "/p/repo", name: "repo" }, { path: "/p/repo-wt", name: "repo-wt" }], world),
    ).toEqual([{ path: "/p/repo", name: "repo" }]);
  });

  it("hides a repo whose own root is a pane's cwd", () => {
    const world = [island("/p/api", [agent("w1:p1", "w1", "/p/api")])];

    expect(
      subtractSettled([{ path: "/p/api", name: "api" }, { path: "/p/web", name: "web" }], world),
    ).toEqual([{ path: "/p/web", name: "web" }]);
  });

  // A workspace whose pane sits several directories inside the repo still
  // settles that repo — it is the same repository, and Phase 0 renders it as
  // one island. Matching only on exact equality would re-offer it and invite
  // a second workspace.
  it("hides a repo whose workspace pane sits inside it", () => {
    const world = [island("/p/api", [agent("w1:p1", "w1", "/p/api/src/payments")])];

    expect(subtractSettled([{ path: "/p/api", name: "api" }], world)).toEqual([]);
  });

  // The prefix match must be path-segment aware: `/p/api-docs` is not inside
  // `/p/api`, and hiding it would make a real repo unfoundable forever.
  it("does not hide a sibling that merely shares a path prefix", () => {
    const world = [island("/p/api", [agent("w1:p1", "w1", "/p/api")])];

    expect(subtractSettled([{ path: "/p/api-docs", name: "api-docs" }], world)).toEqual([
      { path: "/p/api-docs", name: "api-docs" },
    ]);
  });

  it("subtracts nothing from an empty world", () => {
    expect(subtractSettled([{ path: "/p/api", name: "api" }], [])).toEqual([
      { path: "/p/api", name: "api" },
    ]);
  });
});

describe("shouldRescan", () => {
  it("always scans on mount", () => {
    expect(shouldRescan("mount", 0, 1_000)).toBe(true);
  });

  it("always scans when the user asks", () => {
    expect(shouldRescan("manual", 999_000, 1_000_000)).toBe(true);
  });

  it("scans on focus when the last scan is stale", () => {
    expect(shouldRescan("focus", 0, 30_000)).toBe(true);
  });

  it("ignores focus churn right after a scan", () => {
    // Clicking between windows must not re-walk the filesystem every time.
    expect(shouldRescan("focus", 10_000, 12_000)).toBe(false);
  });
});

const sampleReport: UnsettledReport = {
  roots: ["/Users/me/Projects"],
  repos: [repo],
  home: "/Users/me",
  default_agent: "claude",
};

describe("listStatus", () => {
  // Fix round 1, Critical: before this state existed, a failure after a
  // successful scan was invisible — `error` had no consumer once `report`
  // was non-null. This is the case that must not collapse to "ok".
  it("a report plus an error is stale-with-error, never ok", () => {
    expect(listStatus({ report: sampleReport, error: "boom", lastScanAt: 1_000 })).toEqual({
      kind: "stale-with-error",
      error: "boom",
    });
  });

  it("no report and no error yet is loading", () => {
    expect(listStatus({ report: null, error: null, lastScanAt: null })).toEqual({
      kind: "loading",
    });
  });

  it("no report and an error is error-no-data (the first scan itself failed)", () => {
    expect(listStatus({ report: null, error: "boom", lastScanAt: null })).toEqual({
      kind: "error-no-data",
      error: "boom",
    });
  });

  it("a report and no error is ok", () => {
    expect(listStatus({ report: sampleReport, error: null, lastScanAt: 1_000 })).toEqual({
      kind: "ok",
    });
  });
});

const other = { path: "/Users/me/Projects/other", name: "other" };

const withSheetOpen = (base: FoundingState = INITIAL_FOUNDING_STATE): FoundingState =>
  foldFounding({ ...base, repos: [repo, other] }, { kind: "openSheet", repo, agentKind: "claude" });

describe("foldFounding", () => {
  // CRITICAL 1 (fix round 1): a failed founding must keep the sheet open
  // and show the error ON the sheet, because the sheet is a `position:
  // fixed` overlay that paints over any status line elsewhere on the page.
  // A silently-closed sheet with no visible error reads as "nothing
  // happened", which invites a retry that creates a second workspace.
  it("a failure keeps the sheet open and retains the error text", () => {
    let state = withSheetOpen();
    state = foldFounding(state, { kind: "foundingStarted" });
    state = foldFounding(state, { kind: "foundingFailed", error: "workspace w1 (api) was created, but the agent did not start: boom" });

    expect(state.sheet).not.toBeNull();
    expect(state.sheet?.founding).toBe(false);
    expect(state.sheet?.error).toBe("workspace w1 (api) was created, but the agent did not start: boom");
  });

  // A success closes the sheet and reports the workspace id. It does NOT
  // edit `repos`: the displayed list is `subtractSettled(repos, islands)`,
  // so the founded row leaves as soon as the world reports the new
  // workspace's pane — from the same source of truth as everything else.
  // The optimistic removal that used to live here was a second, divergent
  // answer to "is this founded", and it is what needed `foundedPaths` to
  // stop a late `reposLoaded` from undoing it. Both are deleted.
  it("a success closes the sheet and reports the workspace id", () => {
    let state = withSheetOpen();
    state = foldFounding(state, { kind: "foundingStarted" });
    state = foldFounding(state, { kind: "foundingSucceeded", workspaceId: "w1" });

    expect(state.sheet).toBeNull();
    expect(state.lastFounded).toBe("w1");
  });

  // The founded row leaving the list is now a property of the subtraction,
  // driven by the world — which is the point of the final review's Critical
  // fix. This is the same scenario as the test above, one world update
  // later.
  it("the founded repo leaves the displayed list once the world reports its pane", () => {
    let state = withSheetOpen();
    state = foldFounding(state, { kind: "foundingStarted" });
    state = foldFounding(state, { kind: "foundingSucceeded", workspaceId: "w1" });

    const world = [island(repo.path, [agent("w1:p1", "w1", repo.path)])];
    expect(subtractSettled(state.repos, world)).toEqual([other]);
  });

  // ...and, for free, it comes BACK if the user later closes that workspace
  // in herdr. The deleted `foundedPaths` memo never forgot, so a repo stayed
  // hidden until the app was restarted.
  it("a repo whose workspace is later closed in herdr is offered again", () => {
    let state = withSheetOpen();
    state = foldFounding(state, { kind: "foundingStarted" });
    state = foldFounding(state, { kind: "foundingSucceeded", workspaceId: "w1" });

    expect(subtractSettled(state.repos, [])).toEqual([repo, other]);
  });

  // CRITICAL 2, other half: a founding already in flight must not be
  // restartable — a double click, or a re-fired event while the promise is
  // pending, must not re-arm a second `found_settlement` call.
  //
  // Fix round 2, Important 1: this must assert REFERENCE identity
  // (`toBe`), not `toEqual`. Re-applying `foundingStarted` to an
  // already-founding sheet is idempotent in VALUE — `founding` stays
  // `true`, `error` stays `null` — so an unguarded rebuild that spreads a
  // brand new object would be structurally equal to the guarded no-op and
  // `toEqual` could not tell them apart. Only `toBe` proves the reducer
  // actually short-circuited instead of doing the work again.
  it("a founding in flight cannot start a second founding", () => {
    let state = withSheetOpen();
    state = foldFounding(state, { kind: "foundingStarted" });
    const afterFirstStart = state;
    const afterSecondStart = foldFounding(state, { kind: "foundingStarted" });

    expect(afterSecondStart).toBe(afterFirstStart);
    expect(afterSecondStart.sheet?.founding).toBe(true);
  });

  // The stale-`reposLoaded` race the deleted `foundedPaths` existed to cover
  // cannot happen any more: `reposLoaded` stores the raw scan, and what the
  // user sees is derived from the world at render time, so a late fetch has
  // nothing to undo.
  it("a late reposLoaded cannot resurrect a repo the world says is settled", () => {
    let state = withSheetOpen();
    state = foldFounding(state, { kind: "foundingStarted" });
    state = foldFounding(state, { kind: "foundingSucceeded", workspaceId: "w1" });
    state = foldFounding(state, { kind: "reposLoaded", repos: [repo, other] });

    const world = [island(repo.path, [agent("w1:p1", "w1", repo.path)])];
    expect(subtractSettled(state.repos, world)).toEqual([other]);
  });

  // Minor 3: unreachable through today's UI (the cancel button is disabled
  // mid-flight) but must hold at the reducer level regardless — dropping
  // the sheet while a call is in flight would turn the eventual
  // `foundingSucceeded`/`foundingFailed` into a silent no-op against a
  // `null` sheet, i.e. a founding that completes with no visible outcome.
  it("closing the sheet while a founding is in flight is a no-op", () => {
    let state = withSheetOpen();
    state = foldFounding(state, { kind: "foundingStarted" });
    const afterStart = state;
    const afterClose = foldFounding(state, { kind: "closeSheet" });

    expect(afterClose).toBe(afterStart);
    expect(afterClose.sheet).not.toBeNull();
  });

  // MINOR (fix round 1): opening the sheet for a different repo must not
  // wipe out a still-relevant "founded <id>" confirmation from the repo
  // founded just before it.
  it("opening a new sheet does not clear a prior success outcome", () => {
    let state = withSheetOpen();
    state = foldFounding(state, { kind: "foundingStarted" });
    state = foldFounding(state, { kind: "foundingSucceeded", workspaceId: "w1" });
    state = foldFounding(state, { kind: "openSheet", repo: other, agentKind: "claude" });

    expect(state.lastFounded).toBe("w1");
    expect(state.sheet?.repo).toEqual(other);
  });

  it("toggling start-agent and closing the sheet are no-ops with no sheet open", () => {
    expect(foldFounding(INITIAL_FOUNDING_STATE, { kind: "toggleStartAgent" })).toEqual(INITIAL_FOUNDING_STATE);
    expect(foldFounding(INITIAL_FOUNDING_STATE, { kind: "closeSheet" })).toEqual(INITIAL_FOUNDING_STATE);
  });

  // Item 4 (terminal-polish round): the sheet now carries WHICH agent it
  // is going to start, because `found_settlement` now takes one.
  it("opens preselected on the kind it was given, never one it invented", () => {
    const state = foldFounding(INITIAL_FOUNDING_STATE, { kind: "openSheet", repo, agentKind: "codex" });
    expect(state.sheet?.agentKind).toBe("codex");
    expect(
      foundingSummary(repo, state.sheet!.agentKind, state.sheet!.startAgent, "api"),
    ).toContain('agent.start       name="api"  kind="codex"');
  });

  it("choosing a different kind changes what the sheet will start", () => {
    let state = withSheetOpen();
    state = foldFounding(state, { kind: "chooseAgentKind", agentKind: "codex" });
    expect(state.sheet?.agentKind).toBe("codex");
  });

  it("refuses to change the kind while the call is in flight, so the sheet cannot name the wrong agent", () => {
    let state = withSheetOpen();
    state = foldFounding(state, { kind: "foundingStarted" });
    const guarded = foldFounding(state, { kind: "chooseAgentKind", agentKind: "codex" });
    // By reference: a guarded no-op, not a rebuilt-but-equal copy (the
    // same discipline `foundingStarted`'s own guard is tested with).
    expect(guarded).toBe(state);
    expect(guarded.sheet?.agentKind).toBe("claude");
  });

  it("choosing a kind with no sheet open is a no-op", () => {
    expect(foldFounding(INITIAL_FOUNDING_STATE, { kind: "chooseAgentKind", agentKind: "codex" })).toEqual(
      INITIAL_FOUNDING_STATE,
    );
  });
});
