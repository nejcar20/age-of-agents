import { describe, expect, it } from "vitest";
import { nextSwitchTarget, switchTargets, type SwitchTarget } from "./agentSwitcher";
import { countStoppedAgents, type Agent, type Attention, type Island } from "./world";

function agent(paneId: string, attention: Attention, overrides: Partial<Agent> = {}): Agent {
  return {
    pane_id: paneId,
    workspace_id: paneId.split(":")[0] ?? paneId,
    status: attention === "stopped" ? "blocked" : "working",
    attention,
    title: null,
    kind: "claude",
    is_worktree: false,
    cwd: "/p/x",
    ...overrides,
  };
}

function island(name: string, agents: Agent[]): Island {
  return {
    id: `/p/${name}`,
    name,
    root: `/p/${name}`,
    attention: agents.some((a) => a.attention === "stopped") ? "stopped" : "working",
    agents,
    last_changed_at: null,
  };
}

const panes = (targets: SwitchTarget[]) => targets.map((t) => t.agent.pane_id);

describe("switchTargets", () => {
  it("lists EVERY running agent, not only the ones that have stopped", () => {
    // The whole point of the round, per the author's correction: the main
    // need is switching between terminals. A tab bar that only shows blocked
    // agents is not a tab bar.
    const islands = [
      island("alpha", [agent("wA:p1", "working")]),
      island("beta", [agent("wB:p1", "quiet")]),
      island("gamma", [agent("wC:p1", "unknown")]),
    ];
    expect(panes(switchTargets(islands))).toEqual(["wA:p1", "wC:p1", "wB:p1"]);
  });

  it("puts whoever needs you first, by the SAME ordering the island list uses", () => {
    const islands = [
      island("alpha", [agent("wA:p1", "quiet")]),
      island("beta", [agent("wB:p1", "stopped")]),
      island("gamma", [agent("wC:p1", "working")]),
    ];
    expect(panes(switchTargets(islands))).toEqual(["wB:p1", "wC:p1", "wA:p1"]);
  });

  it("agrees with the HUD badge about how many have stopped", () => {
    // These two are on screen at the same time answering the same question.
    // Two derivations of "stopped" is how they would come to disagree.
    const islands = [
      island("alpha", [agent("wA:p1", "stopped"), agent("wA:p2", "stopped")]),
      island("beta", [agent("wB:p1", "working")]),
      island("gamma", [agent("wC:p1", "unknown"), agent("wC:p2", "quiet")]),
      island("delta", []),
    ];
    const stopped = switchTargets(islands).filter((t) => t.agent.attention === "stopped");
    expect(stopped.length).toBe(countStoppedAgents(islands));
    expect(stopped.length).toBe(2);
  });

  it("lists a pane herdr reported no agent kind for, rather than quietly dropping it", () => {
    // Principle 4 cuts both ways: a pane that exists and has a terminal is
    // a place the user can go, and omitting it would be the same lie as
    // inventing one.
    const islands = [island("alpha", [agent("wA:p1", "quiet", { kind: null, title: null })])];
    expect(panes(switchTargets(islands))).toEqual(["wA:p1"]);
  });

  it("orders deterministically within one attention group, and within one island", () => {
    const islands = [
      island("zulu", [agent("wZ:p2", "working"), agent("wZ:p1", "working")]),
      island("alpha", [agent("wA:p1", "working")]),
    ];
    expect(panes(switchTargets(islands))).toEqual(["wA:p1", "wZ:p1", "wZ:p2"]);
  });

  it("is empty when nothing is running", () => {
    expect(switchTargets([])).toEqual([]);
    expect(switchTargets([island("alpha", [])])).toEqual([]);
  });
});

describe("nextSwitchTarget", () => {
  const targets = switchTargets([
    island("alpha", [agent("wA:p1", "stopped")]),
    island("beta", [agent("wB:p1", "working")]),
    island("gamma", [agent("wC:p1", "quiet")]),
  ]);
  const paneOf = (t: SwitchTarget | null) => t?.agent.pane_id ?? null;

  it("steps forward through every agent and wraps, exactly like cycling tabs", () => {
    expect(paneOf(nextSwitchTarget(targets, "wA:p1"))).toBe("wB:p1");
    expect(paneOf(nextSwitchTarget(targets, "wB:p1"))).toBe("wC:p1");
    expect(paneOf(nextSwitchTarget(targets, "wC:p1"))).toBe("wA:p1");
  });

  it("steps backward with shift, and wraps the other way", () => {
    expect(paneOf(nextSwitchTarget(targets, "wC:p1", "previous"))).toBe("wB:p1");
    expect(paneOf(nextSwitchTarget(targets, "wB:p1", "previous"))).toBe("wA:p1");
    expect(paneOf(nextSwitchTarget(targets, "wA:p1", "previous"))).toBe("wC:p1");
  });

  it("reaches a calm agent, not only a stopped one", () => {
    // If this ever regresses to "jump to whoever is waiting", the third
    // agent becomes unreachable from the keyboard.
    expect(paneOf(nextSwitchTarget(targets, "wB:p1"))).toBe("wC:p1");
  });

  it("starts at an end when the current pane is no longer running", () => {
    expect(paneOf(nextSwitchTarget(targets, "gone:p1"))).toBe("wA:p1");
    expect(paneOf(nextSwitchTarget(targets, "gone:p1", "previous"))).toBe("wC:p1");
  });

  it("never returns the pane you are already on, even as the only one running", () => {
    const alone = switchTargets([island("alpha", [agent("wA:p1", "working")])]);
    expect(nextSwitchTarget(alone, "wA:p1")).toBeNull();
    expect(nextSwitchTarget(alone, "wA:p1", "previous")).toBeNull();
  });

  it("answers null when nothing is running, so the caller can say so out loud", () => {
    expect(nextSwitchTarget([], "wA:p1")).toBeNull();
  });
});
