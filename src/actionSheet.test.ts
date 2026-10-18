import { describe, expect, it } from "vitest";
import { foldActionSheet, type ActionSheet } from "./actionSheet";

type Draft = { kind: string };

describe("foldActionSheet", () => {
  it("starts closed and opens with the given draft", () => {
    const state = foldActionSheet<Draft>(null, { kind: "open", draft: { kind: "claude" } });
    expect(state).toEqual({ draft: { kind: "claude" }, busy: false, error: null });
  });

  it("edits the draft while idle", () => {
    let state = foldActionSheet<Draft>(null, { kind: "open", draft: { kind: "claude" } });
    state = foldActionSheet(state, { kind: "edit", draft: { kind: "codex" } });
    expect(state?.draft).toEqual({ kind: "codex" });
  });

  it("closes from idle", () => {
    let state = foldActionSheet<Draft>(null, { kind: "open", draft: { kind: "claude" } });
    state = foldActionSheet(state, { kind: "close" });
    expect(state).toBeNull();
  });

  it("refuses to close while busy (no double-dismiss mid-flight)", () => {
    let state = foldActionSheet<Draft>(null, { kind: "open", draft: { kind: "claude" } });
    state = foldActionSheet(state, { kind: "started" });
    const beforeClose = state;
    state = foldActionSheet(state, { kind: "close" });
    // Reference equality, not just deep equality — proves the no-op didn't
    // rebuild an equal-looking object, the same distinction `foundingStarted`'s
    // own guard is tested for in founding.test.ts.
    expect(state).toBe(beforeClose);
  });

  it("refuses to edit the draft while busy", () => {
    let state = foldActionSheet<Draft>(null, { kind: "open", draft: { kind: "claude" } });
    state = foldActionSheet(state, { kind: "started" });
    const beforeEdit = state;
    state = foldActionSheet(state, { kind: "edit", draft: { kind: "codex" } });
    expect(state).toBe(beforeEdit);
  });

  it("a second 'started' while already busy is a no-op (guards a double click)", () => {
    let state = foldActionSheet<Draft>(null, { kind: "open", draft: { kind: "claude" } });
    state = foldActionSheet(state, { kind: "started" });
    const first = state;
    state = foldActionSheet(state, { kind: "started" });
    expect(state).toBe(first);
  });

  it("'started' clears any previous error", () => {
    let state: ActionSheet<Draft> | null = { draft: { kind: "claude" }, busy: false, error: "boom" };
    state = foldActionSheet(state, { kind: "started" });
    expect(state?.error).toBeNull();
    expect(state?.busy).toBe(true);
  });

  it("'succeeded' closes the sheet outright", () => {
    let state = foldActionSheet<Draft>(null, { kind: "open", draft: { kind: "claude" } });
    state = foldActionSheet(state, { kind: "started" });
    state = foldActionSheet(state, { kind: "succeeded" });
    expect(state).toBeNull();
  });

  it("'failed' keeps the sheet open, un-busies it, and attaches the error", () => {
    let state = foldActionSheet<Draft>(null, { kind: "open", draft: { kind: "claude" } });
    state = foldActionSheet(state, { kind: "started" });
    state = foldActionSheet(state, { kind: "failed", error: "agent_pane_busy" });
    expect(state).toEqual({ draft: { kind: "claude" }, busy: false, error: "agent_pane_busy" });
  });

  it("'failed' against a closed sheet is a no-op", () => {
    const state = foldActionSheet<Draft>(null, { kind: "failed", error: "boom" });
    expect(state).toBeNull();
  });
});
