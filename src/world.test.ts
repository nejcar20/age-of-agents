import { describe, expect, it } from "vitest";
import {
  taskLabel,
  ATTENTION_LABEL,
  ATTENTION_MARK,
  ATTENTION_RANK,
  countStoppedAgents,
  type Agent,
  type Attention,
  type Island,
} from "./world";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    pane_id: "p1",
    workspace_id: "w1",
    status: "working",
    attention: "working",
    title: null,
    kind: null,
    is_worktree: false,
    cwd: "/x",
    ...overrides,
  };
}

function island(overrides: Partial<Island> = {}): Island {
  return {
    id: "i1",
    name: "i1",
    root: "/x",
    attention: "quiet",
    agents: [],
    last_changed_at: null,
    ...overrides,
  };
}

describe("countStoppedAgents", () => {
  it("is zero for no islands", () => {
    expect(countStoppedAgents([])).toBe(0);
  });

  it("counts individual stopped AGENTS, not stopped islands", () => {
    const islands = [
      island({
        agents: [agent({ pane_id: "a", attention: "stopped" }), agent({ pane_id: "b", attention: "working" })],
      }),
      island({ agents: [agent({ pane_id: "c", attention: "stopped" })] }),
    ];
    // Three agents total, two stopped — the answer is 2, not "1 island has a
    // stopped agent" and not "3 agents exist".
    expect(countStoppedAgents(islands)).toBe(2);
  });

  it("never counts an island with no live agents at all, even if the island itself is unsettled/unknown", () => {
    expect(countStoppedAgents([island({ agents: [] })])).toBe(0);
  });
});

// The four words and glyphs this app speaks for an agent's state, which the
// sea/town consistency round folded out of four identical copies (in
// `IslandGrid`, `IslandPanel`, `Archipelago` and `Terminal` — the last of
// which appears over BOTH screens, right next to the others).
describe("the shared attention vocabulary", () => {
  const STATES: Attention[] = ["stopped", "working", "unknown", "quiet"];

  it("has a glyph and words for every state — no state can render as blank", () => {
    for (const state of STATES) {
      expect(ATTENTION_MARK[state].length).toBeGreaterThan(0);
      expect(ATTENTION_LABEL[state].length).toBeGreaterThan(0);
      expect(ATTENTION_RANK[state]).toBeTypeOf("number");
    }
    // Exactly these four, so adding a fifth state to `Attention` without
    // giving it words fails here rather than rendering `undefined` at the
    // moment somebody needs to read it.
    expect(Object.keys(ATTENTION_MARK).sort()).toEqual([...STATES].sort());
    expect(Object.keys(ATTENTION_LABEL).sort()).toEqual([...STATES].sort());
  });

  // The honesty property the tables' own doc comment names: "herdr cannot
  // tell" must never be drawn as the calm "nothing to do" (principle 4 —
  // never draw a guess as a fact).
  it("never renders `unknown` as the calm idle mark or word", () => {
    expect(ATTENTION_MARK.unknown).not.toBe(ATTENTION_MARK.quiet);
    expect(ATTENTION_LABEL.unknown).not.toBe(ATTENTION_LABEL.quiet);
    expect(ATTENTION_LABEL.unknown).toMatch(/cannot tell/);
  });

  it("says out loud, in the stopped label, that this one needs the human", () => {
    expect(ATTENTION_LABEL.stopped).toMatch(/needs you/);
    expect(ATTENTION_MARK.stopped).toBe("❗");
  });
});

describe("taskLabel", () => {
  it("drops Herdr's spinner and status glyphs, which the badge already shows", () => {
    expect(taskLabel("◑ How to run this")).toBe("How to run this");
    expect(taskLabel("✳ Bug review")).toBe("Bug review");
  });

  it("shortens a long title to fit above a villager", () => {
    expect(taskLabel("✳ Email credits system with limitations and more")).toBe("Email credits system with l…");
  });

  it("has nothing to say when Herdr reported no real title", () => {
    expect(taskLabel(null)).toBeNull();
    expect(taskLabel("  ◑  ")).toBeNull();
  });
});
