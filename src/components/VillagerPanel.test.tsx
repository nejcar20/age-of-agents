// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VillagerPanel } from "./VillagerPanel";
import { RAISE_EXTERNAL_TERMINAL_LABEL } from "../externalTerminal";
import { isModalOpen } from "../useHotkey";
import type { Agent } from "../world";

afterEach(cleanup);

const agent: Agent = {
  pane_id: "pane-1",
  workspace_id: "ws-1",
  status: "idle",
  attention: "working",
  title: "claude",
  kind: "claude",
  is_worktree: false,
  cwd: "/repo/src",
};

describe("VillagerPanel", () => {
  it("shows the agent's status, attention, and directory", () => {
    render(<VillagerPanel agent={agent} onClose={vi.fn()} />);
    expect(screen.getByText("idle")).toBeTruthy();
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.getByText("/repo/src")).toBeTruthy();
  });

  it("falls back to the pane_id when the agent has no title", () => {
    render(
      <VillagerPanel agent={{ ...agent, title: null }} onClose={vi.fn()} />,
    );
    // Twice, now, and deliberately: as the heading (the title fallback)
    // and as the `Pane` fact the panel gained with the town's terminal —
    // two agents on one island are told apart by pane id, and this panel
    // is now a doorway into a keyboard-connected surface, so §5.6's "you
    // can always see which pane" applies to it too.
    expect(screen.getAllByText("pane-1").length).toBe(2);
  });

  it("names which kind of agent this is, when herdr said", () => {
    render(
      <VillagerPanel
        agent={{ ...agent, kind: "codex", title: "refactoring the parser" }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Kind")).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();
  });

  // The honesty half: `kind === null` is "herdr reported no agent for this
  // pane," and the panel must say nothing rather than guess. A defaulted
  // "claude" here would be a claim about the author's machine that nothing
  // on the wire supports — see `Agent.kind`'s doc comment.
  it("shows no kind at all — never a guessed one — when herdr reported none", () => {
    render(
      <VillagerPanel
        agent={{ ...agent, kind: null, title: "pane with no agent" }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText("Kind")).toBeNull();
    expect(screen.queryByText("claude")).toBeNull();
  });

  it("shows a worktree fact only when the agent actually is one", () => {
    const { rerender } = render(
      <VillagerPanel agent={agent} onClose={vi.fn()} />,
    );
    expect(screen.queryByText("Worktree")).toBeNull();
    rerender(
      <VillagerPanel
        agent={{ ...agent, is_worktree: true }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Worktree")).toBeTruthy();
  });

  it("is detected by isModalOpen() while mounted, and not after unmount", () => {
    const { unmount } = render(
      <VillagerPanel agent={agent} onClose={vi.fn()} />,
    );
    expect(isModalOpen()).toBe(true);
    unmount();
    expect(isModalOpen()).toBe(false);
  });

  it("clears the selection on Escape", () => {
    const onClose = vi.fn();
    render(<VillagerPanel agent={agent} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes via the explicit close button too", () => {
    const onClose = vi.fn();
    render(<VillagerPanel agent={agent} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // SEA/TOWN CONSISTENCY ROUND: raising the user's own terminal window is
  // still offered, and still explicitly worded — but it lives in
  // `AgentActions` now (see `AgentActions.test.tsx`, "raising the user's
  // own terminal window"), shared with the sea, rather than in this panel
  // where it existed only for the town. This panel must NOT offer a second
  // one of its own: two buttons with one label in one panel is the drift
  // this round exists to remove.
  it("offers no external-terminal button of its own — that action is shared, and arrives as `children`", () => {
    render(<VillagerPanel agent={agent} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: RAISE_EXTERNAL_TERMINAL_LABEL })).toBeNull();
  });

  // The host supplies the agent's working surface (`AgentActions` in the
  // shipped app) rather than this panel importing it — see the component's
  // own doc comment on why it keeps no `invoke` dependency.
  it("renders the working surface its host hands it, below the facts", () => {
    render(
      <VillagerPanel agent={agent} onClose={vi.fn()}>
        <p>prompt box goes here</p>
      </VillagerPanel>,
    );
    expect(screen.getByText("prompt box goes here")).toBeTruthy();
  });
});
