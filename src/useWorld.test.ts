import { describe, expect, it } from "vitest";
import { EMPTY_WORLD, foldWorldUpdate, liveIslandFor, sortIslands } from "./world";
import type { Attention, Island, World } from "./world";

const island = (
  name: string,
  attention: Island["attention"],
  lastChangedAt: number | null = null,
): Island => ({
  id: `/p/${name}`, name, root: `/p/${name}`, attention, agents: [], last_changed_at: lastChangedAt,
});

const world = (islands: Island[]): World => ({
  islands, herdr_connected: true, herdr_version: "0.8.0", protocol_mismatch: false,
});

describe("sortIslands", () => {
  it("puts stopped islands first, then working, then quiet", () => {
    const sorted = sortIslands([
      island("quiet-one", "quiet"),
      island("working-one", "working"),
      island("stopped-one", "stopped"),
    ]);
    expect(sorted.map((i) => i.name)).toEqual(["stopped-one", "working-one", "quiet-one"]);
  });

  it("puts unknown between working and quiet", () => {
    // An island herdr cannot report on is not the same as an idle one, but
    // it must not be pushed above a repo where work is demonstrably
    // happening either.
    const sorted = sortIslands([
      island("quiet-one", "quiet"),
      island("unknown-one", "unknown"),
      island("working-one", "working"),
    ]);
    expect(sorted.map((i) => i.name)).toEqual(["working-one", "unknown-one", "quiet-one"]);
  });

  it("sorts alphabetically within a group", () => {
    const sorted = sortIslands([island("beta", "stopped"), island("alpha", "stopped")]);
    expect(sorted.map((i) => i.name)).toEqual(["alpha", "beta"]);
  });

  it("does not mutate its input", () => {
    const input = [island("b", "quiet"), island("a", "stopped")];
    sortIslands(input);
    expect(input.map((i) => i.name)).toEqual(["b", "a"]);
  });

  // `mode: "recency"` — the header's sort control's other option. Every one
  // of these pins the coordinator's explicit requirement: attention still
  // wins, recency only breaks ties within an attention group.
  describe("with mode: recency", () => {
    it("orders by most-recently-changed first within an attention group", () => {
      const sorted = sortIslands(
        [
          island("older", "quiet", 1000),
          island("newer", "quiet", 3000),
          island("middle", "quiet", 2000),
        ],
        "recency",
      );
      expect(sorted.map((i) => i.name)).toEqual(["newer", "middle", "older"]);
    });

    it("still puts a stopped island above a more-recently-changed quiet one", () => {
      // The whole point: attention is the hotkey's contract. A stale but
      // stopped repo must never be buried under a calm one just because the
      // calm one was touched more recently.
      const sorted = sortIslands(
        [
          island("fresh-but-quiet", "quiet", 5000),
          island("stale-but-stopped", "stopped", 1),
        ],
        "recency",
      );
      expect(sorted.map((i) => i.name)).toEqual(["stale-but-stopped", "fresh-but-quiet"]);
    });

    it("sorts an unknown date last within its group, never first and never as if it were fresh", () => {
      const sorted = sortIslands(
        [
          island("known-old", "quiet", 100),
          island("unknown-date", "quiet", null),
          island("known-new", "quiet", 200),
        ],
        "recency",
      );
      expect(sorted.map((i) => i.name)).toEqual(["known-new", "known-old", "unknown-date"]);
    });

    it("falls back to name when two unknown-date islands tie", () => {
      const sorted = sortIslands(
        [island("beta", "quiet", null), island("alpha", "quiet", null)],
        "recency",
      );
      expect(sorted.map((i) => i.name)).toEqual(["alpha", "beta"]);
    });

    it("defaults to name-only ordering when no mode is passed, unchanged from before recency existed", () => {
      const sorted = sortIslands([
        island("beta", "quiet", 5000),
        island("alpha", "quiet", 1),
      ]);
      expect(sorted.map((i) => i.name)).toEqual(["alpha", "beta"]);
    });
  });
});

describe("foldWorldUpdate", () => {
  it("applies the initial snapshot when no event has arrived yet", () => {
    const state = { world: EMPTY_WORLD, eventArrived: false };
    const next = foldWorldUpdate(state, { kind: "initial", world: world([island("a", "working")]) });
    expect(next.world.islands.map((i) => i.name)).toEqual(["a"]);
    expect(next.eventArrived).toBe(false);
  });

  it("applies an event and marks that one has arrived", () => {
    const state = { world: EMPTY_WORLD, eventArrived: false };
    const next = foldWorldUpdate(state, { kind: "event", world: world([island("a", "stopped")]) });
    expect(next.world.islands.map((i) => i.name)).toEqual(["a"]);
    expect(next.eventArrived).toBe(true);
  });

  it("does not let a stale initial snapshot replace state an event already set", () => {
    // The get_world fetch and the world-updated listener race: an event can
    // land, and be applied, before the initial fetch it raced against
    // finally settles. That late initial snapshot is now stale and must be
    // ignored, not silently overwrite the newer, event-driven state.
    let state = { world: EMPTY_WORLD, eventArrived: false };
    state = foldWorldUpdate(state, { kind: "event", world: world([island("fresh", "stopped")]) });
    state = foldWorldUpdate(state, { kind: "initial", world: world([island("stale", "quiet")]) });
    expect(state.world.islands.map((i) => i.name)).toEqual(["fresh"]);
  });
});

// I2 (Opus frontend review): `App.tsx`'s `openIsland` used to be a snapshot
// captured once, at click time, and never re-derived — but `TownView`'s
// villagers colour their own heads by `agent.attention`, a LIVE signal, so a
// town left open would keep showing stale attention forever.
describe("liveIslandFor", () => {
  const agent = (attention: Attention) => ({
    pane_id: "w1:p1",
    workspace_id: "w1",
    status: "working" as const,
    attention,
    title: "agent",
    kind: null,
    is_worktree: false,
    cwd: "/p/repo",
  });

  it("re-derives from the live world by root when it's there", () => {
    const snapshot = island("repo", "quiet");
    const live: Island = { ...island("repo", "stopped"), agents: [agent("stopped")] };
    expect(liveIslandFor(snapshot, [live])).toBe(live);
  });

  it("falls back to the snapshot when the live world doesn't know this root (an unsettled island)", () => {
    const snapshot = island("unsettled-repo", "quiet");
    const unrelated = island("other-repo", "stopped");
    expect(liveIslandFor(snapshot, [unrelated])).toBe(snapshot);
  });

  it("picks up a later change in live attention without a new snapshot", () => {
    const snapshot = island("repo", "working");
    const worldIslands = [island("repo", "stopped")];
    expect(liveIslandFor(snapshot, worldIslands).attention).toBe("stopped");
  });
});
