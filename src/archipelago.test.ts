import { describe, expect, it } from "vitest";
import {
  assignVillagerPositions,
  ATTENTION_COLOR,
  blockCenters,
  defaultFocusBounds,
  findBestSeaIslandMatch,
  houseCluster,
  isFilterActive,
  islandCenter,
  isSeaIslandMatch,
  joinArchipelago,
  landLobes,
  landRect,
  massingBlockCount,
  matchesSearchQuery,
  matchesStateFilter,
  padFadeOpacity,
  pickDefaultFocusIsland,
  resolveFlyToTarget,
  seaBounds,
  vegetationFadeOpacity,
  activityRingOpacity,
  villagerSlots,
  type IslandView,
  type SeaIsland,
} from "./archipelago";
import type { Agent, Island } from "./world";

function knownView(overrides: Partial<IslandView> = {}): IslandView {
  return {
    root: "/p/api",
    name: "api",
    plot: { x: 0, z: 0, w: 40, d: 40 },
    city: { status: "known", district_count: 17, building_count: 75, width: 18, depth: 24, source: "Git", measured_at: null },
    last_changed_at: 1000,
    ...overrides,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    pane_id: "w1:p1",
    workspace_id: "w1",
    status: "working",
    attention: "working",
    title: null,
    kind: null,
    is_worktree: false,
    cwd: "/p/api",
    ...overrides,
  };
}

function island(overrides: Partial<Island> = {}): Island {
  return {
    id: "/p/api",
    name: "api",
    root: "/p/api",
    attention: "quiet",
    agents: [],
    last_changed_at: 1000,
    ...overrides,
  };
}

describe("joinArchipelago", () => {
  it("matches a world island by root and carries its attention/agents", () => {
    const view = knownView();
    const a = agent();
    const worldIslands = [island({ attention: "stopped", agents: [a] })];
    const [sea] = joinArchipelago([view], worldIslands);
    expect(sea.attention).toBe("stopped");
    expect(sea.agents).toEqual([a]);
  });

  it("never fabricates attention or agents for a repo with no live workspace", () => {
    const view = knownView({ root: "/p/unsettled" });
    const [sea] = joinArchipelago([view], []);
    expect(sea.attention).toBeNull();
    expect(sea.agents).toEqual([]);
  });

  it("does not cross-wire two different roots", () => {
    const views = [knownView({ root: "/p/a" }), knownView({ root: "/p/b" })];
    const worldIslands = [island({ root: "/p/b", id: "/p/b", attention: "stopped" })];
    const [a, b] = joinArchipelago(views, worldIslands);
    expect(a.attention).toBeNull();
    expect(b.attention).toBe("stopped");
  });
});

describe("landRect", () => {
  it("centers a Known city's real width/depth inside its plot", () => {
    const view = knownView({ plot: { x: 10, z: 20, w: 40, d: 40 } });
    const land = landRect(view);
    // width=18 depth=24 inside a 40x40 plot at (10,20): margins (40-18)/2=11, (40-24)/2=8
    expect(land).toEqual({ x: 21, z: 28, w: 18, d: 24 });
  });

  it("never draws an Unknown island at its plot's own (placeholder) size", () => {
    const view = knownView({
      plot: { x: 0, z: 0, w: 100, d: 100 },
      city: { status: "unknown", reason: "repository root no longer exists on disk" },
    });
    const land = landRect(view);
    // Fixed small fog footprint, centered — NOT 100x100 (that would present a
    // stability placeholder as a real measurement, Item 6's forbidden case).
    expect(land.w).toBe(6);
    expect(land.d).toBe(6);
    expect(land.x).toBe(47);
    expect(land.z).toBe(47);
  });
});

describe("massingBlockCount", () => {
  it("matches the author's real five repositories at a proportional, capped scale", () => {
    // From archipelago-layout-report.md's real numbers.
    expect(massingBlockCount(17)).toBe(1); // AgeOfAgents
    expect(massingBlockCount(60)).toBe(3); // picks
    expect(massingBlockCount(23)).toBe(2); // pocketAlarm
    expect(massingBlockCount(363)).toBe(19); // my-site-next
    expect(massingBlockCount(127)).toBe(7); // speech.cpp
  });

  it("is monotonic and never exceeds the cap even for a huge district count", () => {
    expect(massingBlockCount(1)).toBeGreaterThanOrEqual(1);
    expect(massingBlockCount(6471)).toBe(24); // ~/Projects/Old, 34 unrelated projects
    expect(massingBlockCount(100)).toBeGreaterThan(massingBlockCount(10));
  });
});

describe("blockCenters and villagerSlots", () => {
  it("never places a villager slot exactly on a block center, for a range of block counts", () => {
    for (const blockCount of [1, 2, 3, 7, 19, 24]) {
      const centers = blockCenters(60, 80, blockCount);
      const slots = villagerSlots(60, 80, blockCount);
      for (const center of centers) {
        for (const slot of slots) {
          const same = Math.abs(center.x - slot.x) < 1e-9 && Math.abs(center.z - slot.z) < 1e-9;
          expect(same).toBe(false);
        }
      }
    }
  });

  it("keeps every villager slot inset from the coastline, never at the raw edge", () => {
    const slots = villagerSlots(50, 50, 1);
    for (const slot of slots) {
      expect(slot.x).toBeGreaterThan(0);
      expect(slot.x).toBeLessThan(50);
      expect(slot.z).toBeGreaterThan(0);
      expect(slot.z).toBeLessThan(50);
    }
  });
});

describe("assignVillagerPositions", () => {
  it("is deterministic across repeated calls with the same agents", () => {
    const agents = [agent({ pane_id: "w1:p1" }), agent({ pane_id: "w1:p2" }), agent({ pane_id: "w2:p1" })];
    const slots = villagerSlots(60, 60, massingBlockCount(20));
    const first = assignVillagerPositions(agents, slots);
    const second = assignVillagerPositions(agents, slots);
    for (const a of agents) {
      expect(second.get(a.pane_id)).toEqual(first.get(a.pane_id));
    }
  });

  it("gives every agent a distinct slot when slots are not scarce", () => {
    const agents = [agent({ pane_id: "w1:p1" }), agent({ pane_id: "w1:p2" }), agent({ pane_id: "w2:p1" })];
    const slots = villagerSlots(60, 60, massingBlockCount(20)); // grid 5 -> 36 slots
    const placed = assignVillagerPositions(agents, slots);
    const positions = agents.map((a) => JSON.stringify(placed.get(a.pane_id)));
    expect(new Set(positions).size).toBe(agents.length);
  });

  it("returns an empty map rather than throwing when there are no slots", () => {
    expect(assignVillagerPositions([agent()], [])).toEqual(new Map());
  });
});

describe("seaBounds", () => {
  it("covers every island's full reserved plot", () => {
    const views = [
      knownView({ plot: { x: 0, z: 0, w: 38, d: 44 } }),
      knownView({ root: "/p/b", plot: { x: 38, z: 0, w: 52, d: 64 } }),
    ];
    expect(seaBounds(views)).toEqual({ minX: 0, maxX: 90, minZ: 0, maxZ: 64 });
  });

  it("returns a small nominal box rather than NaN when there are no islands yet", () => {
    const bounds = seaBounds([]);
    expect(Number.isFinite(bounds.minX)).toBe(true);
    expect(Number.isFinite(bounds.maxX)).toBe(true);
  });
});

describe("landLobes", () => {
  it("never lets a lobe extend past the real footprint (honesty)", () => {
    // The coordinator's own wording: shaping the coastline WITHIN the
    // footprint is scenery; the footprint itself must never grow.
    for (const [landW, landD] of [
      [18, 31],
      [76, 101],
      [5, 5],
      [100, 40],
    ]) {
      const lobes = landLobes("/p/some-repo", landW, landD);
      expect(lobes.length).toBeGreaterThan(1);
      for (const lobe of lobes) {
        expect(lobe.x).toBeGreaterThanOrEqual(0);
        expect(lobe.z).toBeGreaterThanOrEqual(0);
        expect(lobe.x + lobe.w).toBeLessThanOrEqual(landW + 1e-9);
        expect(lobe.z + lobe.d).toBeLessThanOrEqual(landD + 1e-9);
      }
    }
  });

  it("is deterministic for the same root and size", () => {
    const a = landLobes("/p/api", 40, 40);
    const b = landLobes("/p/api", 40, 40);
    expect(b).toEqual(a);
  });

  it("gives two different roots different shapes", () => {
    const a = landLobes("/p/api", 40, 40);
    const b = landLobes("/p/other", 40, 40);
    expect(b).not.toEqual(a);
  });
});

describe("houseCluster", () => {
  it("keeps every house within its own cell (a fraction of the pitch)", () => {
    for (const house of houseCluster("/p/api#block3")) {
      expect(Math.abs(house.dx)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(house.dz)).toBeLessThanOrEqual(0.5);
      expect(house.size).toBeGreaterThan(0);
      expect(house.heightFactor).toBeGreaterThan(0);
    }
  });

  it("is deterministic for the same seed", () => {
    expect(houseCluster("/p/api#block3")).toEqual(houseCluster("/p/api#block3"));
  });

  it("gives more than one house per block, per the coordinator's ask", () => {
    expect(houseCluster("/p/api#block0").length).toBeGreaterThan(1);
  });
});

describe("islandCenter", () => {
  it("targets the LAND's own centre, not the plot's", () => {
    const view = knownView({ plot: { x: 0, z: 0, w: 40, d: 40 } });
    // land is 18x24 centered in a 40x40 plot -> land origin (11, 8), center (20, 20)
    expect(islandCenter(view)).toEqual({ x: 20, z: 20 });
  });
});

// ---------------------------------------------------------------------
// Search and state filtering (search-and-filter round) — at the author's
// real scale (152 repositories once discovery stops capping at depth 2),
// finding one island by eye is not viable; this is the pure logic behind
// the search box and state filter, unit-tested directly since there is no
// DOM/WebGL environment for `Archipelago.tsx` itself.
// ---------------------------------------------------------------------

function seaIsland(overrides: Partial<SeaIsland> = {}): SeaIsland {
  return { view: knownView(), attention: "quiet", agents: [], ...overrides };
}

describe("matchesSearchQuery", () => {
  it("matches case-insensitively, anywhere in the name", () => {
    expect(matchesSearchQuery("PocketAlarm", "alarm")).toBe(true);
    expect(matchesSearchQuery("PocketAlarm", "POCKET")).toBe(true);
  });

  it("does not match an unrelated name", () => {
    expect(matchesSearchQuery("api-docs", "widget")).toBe(false);
  });

  it("treats an empty or whitespace-only query as matching everything", () => {
    expect(matchesSearchQuery("api-docs", "")).toBe(true);
    expect(matchesSearchQuery("api-docs", "   ")).toBe(true);
  });
});

describe("matchesStateFilter", () => {
  it("'all' matches every attention, including null (unsettled)", () => {
    expect(matchesStateFilter("stopped", "all")).toBe(true);
    expect(matchesStateFilter(null, "all")).toBe(true);
  });

  it("a specific state matches only that exact live attention", () => {
    expect(matchesStateFilter("stopped", "stopped")).toBe(true);
    expect(matchesStateFilter("working", "stopped")).toBe(false);
  });

  it("an unsettled island (null attention) never matches a specific state filter", () => {
    expect(matchesStateFilter(null, "stopped")).toBe(false);
    expect(matchesStateFilter(null, "quiet")).toBe(false);
  });
});

describe("isSeaIslandMatch", () => {
  it("requires both the name query and the state filter to pass", () => {
    const island = seaIsland({ view: knownView({ name: "pocketAlarm" }), attention: "stopped" });
    expect(isSeaIslandMatch(island, "pocket", "stopped")).toBe(true);
    expect(isSeaIslandMatch(island, "pocket", "working")).toBe(false);
    expect(isSeaIslandMatch(island, "widget", "stopped")).toBe(false);
  });
});

describe("isFilterActive", () => {
  it("is false only for an empty query AND 'all'", () => {
    expect(isFilterActive("", "all")).toBe(false);
    expect(isFilterActive("   ", "all")).toBe(false);
  });

  it("is true when either a query or a specific state is set", () => {
    expect(isFilterActive("api", "all")).toBe(true);
    expect(isFilterActive("", "stopped")).toBe(true);
    expect(isFilterActive("api", "stopped")).toBe(true);
  });
});

describe("findBestSeaIslandMatch", () => {
  const islands = [
    seaIsland({ view: knownView({ root: "/p/api", name: "api" }) }),
    seaIsland({ view: knownView({ root: "/p/api-docs", name: "api-docs" }) }),
    seaIsland({ view: knownView({ root: "/p/widget-api", name: "widget-api" }) }),
  ];

  it("returns null for an empty query — nothing was actually typed to jump to", () => {
    expect(findBestSeaIslandMatch(islands, "", "all")).toBeNull();
    expect(findBestSeaIslandMatch(islands, "   ", "all")).toBeNull();
  });

  it("prefers an exact (case-insensitive) name match over any substring match", () => {
    expect(findBestSeaIslandMatch(islands, "API", "all")?.view.root).toBe("/p/api");
  });

  it("falls back to the first name that starts with the query", () => {
    expect(findBestSeaIslandMatch(islands, "api-", "all")?.view.root).toBe("/p/api-docs");
  });

  it("falls back further to the first name that merely contains the query", () => {
    expect(findBestSeaIslandMatch(islands, "-api", "all")?.view.root).toBe("/p/widget-api");
  });

  it("returns null when nothing matches", () => {
    expect(findBestSeaIslandMatch(islands, "nonexistent", "all")).toBeNull();
  });

  it("honours the state filter — never jumps to an island the filter is hiding", () => {
    const mixed = [
      seaIsland({ view: knownView({ root: "/p/api", name: "api" }), attention: "quiet" }),
      seaIsland({ view: knownView({ root: "/p/api-2", name: "api-2" }), attention: "stopped" }),
    ];
    expect(findBestSeaIslandMatch(mixed, "api", "stopped")?.view.root).toBe("/p/api-2");
    expect(findBestSeaIslandMatch(mixed, "api", "working")).toBeNull();
  });
});

// I1 (Opus frontend review): a fly-to request used to be resolved by NAME
// alone, even when the caller already had the exact `SeaIsland` (and its
// unambiguous `root`) in hand — at the author's scale (152 repositories)
// three basenames collide (`StrategyTrader_v2`, `padel-court-api`,
// `space-guardian`), so a name-only lookup can silently land on the WRONG
// repository, and "Start agent" then acts on it.
describe("resolveFlyToTarget", () => {
  it("routes by root when the request carries one, even with a colliding basename", () => {
    const wrong = seaIsland({ view: knownView({ root: "/old/StrategyTrader_v2", name: "StrategyTrader_v2" }) });
    const right = seaIsland({ view: knownView({ root: "/new/StrategyTrader_v2", name: "StrategyTrader_v2" }) });
    const target = resolveFlyToTarget([wrong, right], {
      islandName: "StrategyTrader_v2",
      islandRoot: "/new/StrategyTrader_v2",
    });
    expect(target).toBe(right);
  });

  it("falls back to a name lookup when the request has no root (jump_to_next's own contract)", () => {
    const only = seaIsland({ view: knownView({ root: "/p/api", name: "api" }) });
    expect(resolveFlyToTarget([only], { islandName: "api" })).toBe(only);
  });

  it("returns null when nothing matches, by root or by name", () => {
    const only = seaIsland({ view: knownView({ root: "/p/api", name: "api" }) });
    expect(resolveFlyToTarget([only], { islandName: "nope" })).toBeNull();
    expect(resolveFlyToTarget([only], { islandName: "nope", islandRoot: "/p/nope" })).toBeNull();
  });

  it("still prefers root even when a DIFFERENT island happens to match by name too", () => {
    const byNameOnly = seaIsland({ view: knownView({ root: "/p/decoy", name: "target" }) });
    const byRoot = seaIsland({ view: knownView({ root: "/p/real", name: "not-target" }) });
    const target = resolveFlyToTarget([byNameOnly, byRoot], { islandName: "target", islandRoot: "/p/real" });
    expect(target).toBe(byRoot);
  });
});

describe("padFadeOpacity", () => {
  it("is at its minimum at and below the default wide-view ratio (2)", () => {
    expect(padFadeOpacity(2)).toBeCloseTo(0.1, 5);
    expect(padFadeOpacity(0)).toBeCloseTo(0.1, 5);
    expect(padFadeOpacity(-5)).toBeCloseTo(0.1, 5);
  });

  it("reaches full opacity at and beyond a modest zoom-in (5)", () => {
    expect(padFadeOpacity(5)).toBeCloseTo(1, 5);
    expect(padFadeOpacity(20)).toBeCloseTo(1, 5);
  });

  it("is monotonically increasing between the two ends", () => {
    expect(padFadeOpacity(3)).toBeGreaterThan(padFadeOpacity(2));
    expect(padFadeOpacity(4)).toBeGreaterThan(padFadeOpacity(3));
  });

  it("never goes below its own floor or above 1, for any input", () => {
    for (const ratio of [-100, 0, 1, 2, 2.5, 3, 4, 5, 100]) {
      const opacity = padFadeOpacity(ratio);
      expect(opacity).toBeGreaterThanOrEqual(0.1);
      expect(opacity).toBeLessThanOrEqual(1);
    }
  });
});

describe("vegetationFadeOpacity", () => {
  it("is at its minimum at and below the default wide-view ratio (2)", () => {
    expect(vegetationFadeOpacity(2)).toBeCloseTo(0.18, 5);
    expect(vegetationFadeOpacity(0)).toBeCloseTo(0.18, 5);
  });

  it("reaches full opacity at and beyond its own zoom-in threshold (6)", () => {
    expect(vegetationFadeOpacity(6)).toBeCloseTo(1, 5);
    expect(vegetationFadeOpacity(20)).toBeCloseTo(1, 5);
  });

  it("is monotonically increasing between the two ends", () => {
    expect(vegetationFadeOpacity(4)).toBeGreaterThan(vegetationFadeOpacity(2));
    expect(vegetationFadeOpacity(5)).toBeGreaterThan(vegetationFadeOpacity(4));
  });

  it("fades back in more slowly than the pads (reaches full opacity at a higher ratio)", () => {
    // Coordinator's own instinct: vegetation "probably needs to thin out or
    // fade with distance too" — this asserts the two curves are actually
    // DIFFERENT, not that one was copy-pasted as the other under a new name.
    const midRatio = 4.5;
    expect(vegetationFadeOpacity(midRatio)).toBeLessThan(padFadeOpacity(midRatio));
  });
});

describe("activityRingOpacity", () => {
  it("is at its BOLDEST at and below the default wide-view ratio (2)", () => {
    expect(activityRingOpacity(2)).toBeCloseTo(0.92, 5);
    expect(activityRingOpacity(0)).toBeCloseTo(0.92, 5);
  });

  it("recedes to its floor at and beyond the zoomed-in threshold (5)", () => {
    expect(activityRingOpacity(5)).toBeCloseTo(0.42, 5);
    expect(activityRingOpacity(20)).toBeCloseTo(0.42, 5);
  });

  it("never fades to nothing — receded, not deleted, at any zoom", () => {
    for (const ratio of [-100, 0, 2, 3, 4, 5, 100]) {
      expect(activityRingOpacity(ratio)).toBeGreaterThan(0.4);
      expect(activityRingOpacity(ratio)).toBeLessThanOrEqual(0.92);
    }
  });

  it("runs the OPPOSITE way to the scenery fades — bold when they are faint", () => {
    // The lens is an orientation instrument: the wide view is exactly where
    // it has to dominate, which is exactly where pads and vegetation are at
    // their most receded. This asserts the inversion is real rather than a
    // copy of one of those curves under a new name.
    expect(activityRingOpacity(4)).toBeLessThan(activityRingOpacity(2));
    expect(padFadeOpacity(4)).toBeGreaterThan(padFadeOpacity(2));
  });
});

describe("pickDefaultFocusIsland", () => {
  it("returns null for an empty sea (never a fabricated centre)", () => {
    expect(pickDefaultFocusIsland([])).toBeNull();
  });

  it("prefers a stopped island over anything else, regardless of recency", () => {
    const calm = seaIsland({
      view: knownView({ root: "/p/calm", name: "calm", last_changed_at: 9999 }),
      attention: "quiet",
    });
    const stopped = seaIsland({
      view: knownView({ root: "/p/stopped", name: "stopped", last_changed_at: 1 }),
      attention: "stopped",
    });
    expect(pickDefaultFocusIsland([calm, stopped])?.view.root).toBe("/p/stopped");
  });

  it("breaks a stopped/stopped tie by most-recently-changed", () => {
    const a = seaIsland({
      view: knownView({ root: "/p/a", name: "a", last_changed_at: 100 }),
      attention: "stopped",
    });
    const b = seaIsland({
      view: knownView({ root: "/p/b", name: "b", last_changed_at: 200 }),
      attention: "stopped",
    });
    expect(pickDefaultFocusIsland([a, b])?.view.root).toBe("/p/b");
  });

  it("falls back to most-recently-changed when nothing is stopped", () => {
    const older = seaIsland({
      view: knownView({ root: "/p/older", name: "older", last_changed_at: 100 }),
      attention: "working",
    });
    const newer = seaIsland({
      view: knownView({ root: "/p/newer", name: "newer", last_changed_at: 200 }),
      attention: "quiet",
    });
    expect(pickDefaultFocusIsland([older, newer])?.view.root).toBe("/p/newer");
  });

  it("falls back to the largest known city when nothing is stopped or dated", () => {
    const small = seaIsland({
      view: knownView({
        root: "/p/small",
        name: "small",
        last_changed_at: null,
        city: { status: "known", district_count: 1, building_count: 1, width: 4, depth: 4, source: "Git", measured_at: null },
      }),
    });
    const big = seaIsland({
      view: knownView({
        root: "/p/big",
        name: "big",
        last_changed_at: null,
        city: { status: "known", district_count: 20, building_count: 200, width: 40, depth: 40, source: "Git", measured_at: null },
      }),
    });
    expect(pickDefaultFocusIsland([small, big])?.view.root).toBe("/p/big");
  });

  it("never picks an unknown-status island as 'largest', even with a huge reserved plot", () => {
    const unknownBig = seaIsland({
      view: knownView({
        root: "/p/unknown",
        name: "unknown",
        last_changed_at: null,
        plot: { x: 0, z: 0, w: 500, d: 500 },
        city: { status: "unknown", reason: "not scanned yet" },
      }),
    });
    const knownSmall = seaIsland({
      view: knownView({
        root: "/p/known",
        name: "known",
        last_changed_at: null,
        city: { status: "known", district_count: 1, building_count: 1, width: 4, depth: 4, source: "Git", measured_at: null },
      }),
    });
    expect(pickDefaultFocusIsland([unknownBig, knownSmall])?.view.root).toBe("/p/known");
  });

  it("is deterministic — a tie at every tier breaks by name", () => {
    const a = seaIsland({
      view: knownView({
        root: "/p/aaa",
        name: "aaa",
        last_changed_at: null,
        city: { status: "known", district_count: 1, building_count: 1, width: 10, depth: 10, source: "Git", measured_at: null },
      }),
    });
    const b = seaIsland({
      view: knownView({
        root: "/p/bbb",
        name: "bbb",
        last_changed_at: null,
        city: { status: "known", district_count: 1, building_count: 1, width: 10, depth: 10, source: "Git", measured_at: null },
      }),
    });
    expect(pickDefaultFocusIsland([b, a])?.view.root).toBe("/p/aaa");
  });
});

describe("defaultFocusBounds", () => {
  it("returns null for an empty sea", () => {
    expect(defaultFocusBounds([], "/p/anything")).toBeNull();
  });

  it("returns null when the named root isn't actually present", () => {
    const only = seaIsland({ view: knownView({ root: "/p/only" }) });
    expect(defaultFocusBounds([only], "/p/missing")).toBeNull();
  });

  it("fully contains the focus island's own land, with a margin, when it is the only one", () => {
    const only = seaIsland({
      view: knownView({
        root: "/p/only",
        plot: { x: 0, z: 0, w: 20, d: 20 },
        city: { status: "known", district_count: 1, building_count: 1, width: 20, depth: 20, source: "Git", measured_at: null },
      }),
    });
    const bounds = defaultFocusBounds([only], "/p/only");
    expect(bounds).not.toBeNull();
    expect(bounds!.minX).toBeLessThanOrEqual(0);
    expect(bounds!.maxX).toBeGreaterThanOrEqual(20);
    expect(bounds!.minZ).toBeLessThanOrEqual(0);
    expect(bounds!.maxZ).toBeGreaterThanOrEqual(20);
  });

  it("excludes a distant outlier once there are enough closer neighbours to fill the handful", () => {
    const mk = (root: string, x: number, z: number): SeaIsland =>
      seaIsland({
        view: knownView({
          root,
          name: root,
          plot: { x, z, w: 10, d: 10 },
          city: { status: "known", district_count: 1, building_count: 1, width: 10, depth: 10, source: "Git", measured_at: null },
        }),
      });
    const islands: SeaIsland[] = [mk("/p/focus", 0, 0)];
    for (let i = 1; i <= 6; i++) islands.push(mk(`/p/near${i}`, i * 15, 0));
    islands.push(mk("/p/far", 100000, 100000));

    const bounds = defaultFocusBounds(islands, "/p/focus")!;
    expect(bounds.maxX).toBeLessThan(1000);
    expect(bounds.maxZ).toBeLessThan(1000);
  });

  it("degrades to the whole sea on its own when there are fewer islands than the handful size", () => {
    const mk = (root: string, x: number): SeaIsland =>
      seaIsland({
        view: knownView({
          root,
          name: root,
          plot: { x, z: 0, w: 10, d: 10 },
          city: { status: "known", district_count: 1, building_count: 1, width: 10, depth: 10, source: "Git", measured_at: null },
        }),
      });
    const islands = [mk("/p/focus", 0), mk("/p/b", 20)];
    const bounds = defaultFocusBounds(islands, "/p/focus")!;
    // Both islands' land must be included — nothing left out just because
    // the sea has fewer islands than the usual neighbour count.
    expect(bounds.maxX).toBeGreaterThanOrEqual(30);
  });
});

// Town-villagers round: `ATTENTION_COLOR` is the ONE table both this sea
// scene and `TownView.tsx`'s own villagers read — pinned to the exact
// values `styles.css`'s `--stopped`/`--working`/`--grey` custom properties
// mirror, so a future edit to one can't silently drift out of step with the
// other.
describe("ATTENTION_COLOR", () => {
  it("matches the CSS custom properties' own documented meaning", () => {
    expect(ATTENTION_COLOR.stopped).toBe("#22c993");
    expect(ATTENTION_COLOR.working).toBe("#f5992b");
    expect(ATTENTION_COLOR.unknown).toBe("#8f97a3");
  });

  it("gives every Attention state its own colour", () => {
    const colors = new Set(Object.values(ATTENTION_COLOR));
    expect(colors.size).toBe(Object.keys(ATTENTION_COLOR).length);
  });
});
