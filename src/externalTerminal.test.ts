// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOCUS_WORKSPACE_TERMINAL_LABEL,
  FOCUS_WORKSPACE_TERMINAL_TITLE,
  RAISE_EXTERNAL_TERMINAL_LABEL,
  RAISE_EXTERNAL_TERMINAL_TITLE,
  raiseExternalFailedNote,
  raiseExternalTerminal,
  raisedExternalNote,
} from "./externalTerminal";
import type { Agent } from "./world";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

afterEach(() => invokeMock.mockReset());

const agent: Agent = {
  pane_id: "w2:p1",
  workspace_id: "w2",
  status: "blocked",
  attention: "stopped",
  title: "claude",
  kind: "claude",
  is_worktree: false,
  cwd: "/p/orchard",
};

describe("the words for leaving the app", () => {
  // The sea and the town both leave the app through this module now. These
  // assertions are about the two properties a user's safety rests on, not
  // about the prose: the label must distinguish itself from the EMBEDDED
  // terminal's own "Open terminal ⤢" (they sit one button apart), and it
  // must say out loud that it leaves the app.
  it("marks both raises as leaving the app, distinctly from the embedded terminal", () => {
    for (const label of [RAISE_EXTERNAL_TERMINAL_LABEL, FOCUS_WORKSPACE_TERMINAL_LABEL]) {
      expect(label).toMatch(/↗$/);
      expect(label).not.toMatch(/⤢/);
    }
    for (const title of [RAISE_EXTERNAL_TERMINAL_TITLE, FOCUS_WORKSPACE_TERMINAL_TITLE]) {
      expect(title).toMatch(/leaves the app/);
    }
  });

  // Two different herdr calls, two different scopes — a pane and a whole
  // workspace — so they must not read as the same button. The sea offers
  // both, in the same panel.
  it("keeps the pane-level and workspace-level raises tellable apart", () => {
    expect(RAISE_EXTERNAL_TERMINAL_LABEL).not.toBe(FOCUS_WORKSPACE_TERMINAL_LABEL);
    expect(RAISE_EXTERNAL_TERMINAL_TITLE).toMatch(/pane\.focus/);
    expect(FOCUS_WORKSPACE_TERMINAL_TITLE).toMatch(/workspace\.focus/);
  });

  it("names the agent by its herdr title, and falls back to the pane id rather than inventing one", () => {
    expect(raisedExternalNote(agent)).toBe("focused claude in your own terminal");
    expect(raisedExternalNote({ ...agent, title: null })).toBe("focused w2:p1 in your own terminal");
  });

  it("quotes the failure rather than paraphrasing it", () => {
    expect(raiseExternalFailedNote(new Error("no such pane"))).toBe("focus failed: Error: no such pane");
  });
});

describe("raiseExternalTerminal", () => {
  it("makes exactly one focus_pane call, and resolves with what to say", async () => {
    invokeMock.mockResolvedValue(undefined);
    await expect(raiseExternalTerminal(agent)).resolves.toBe(raisedExternalNote(agent));
    expect(invokeMock.mock.calls).toEqual([["focus_pane", { paneId: "w2:p1" }]]);
  });

  // Never a throw: every caller wants to SAY what happened, and a rejected
  // promise nobody caught would leave the user looking at a button that
  // did nothing visible.
  it("resolves — never rejects — when herdr refuses", async () => {
    invokeMock.mockRejectedValue(new Error("not a pane in the current world"));
    await expect(raiseExternalTerminal(agent)).resolves.toMatch(
      /^focus failed: .*not a pane in the current world/,
    );
  });
});
