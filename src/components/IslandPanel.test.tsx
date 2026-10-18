// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IslandPanel, START_AGENT_LABEL } from "./IslandPanel";
import { FOCUS_WORKSPACE_TERMINAL_LABEL, RAISE_EXTERNAL_TERMINAL_LABEL } from "../externalTerminal";
import { paneGoneNote } from "../terminalAttachment";
import { FOUNDING_SHEET_TITLE } from "./FoundingSheet";
import { isModalOpen } from "../useHotkey";
import type { SeaIsland } from "../archipelago";
import type { Agent } from "../world";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
// Test the panel’s real attachment/mode selection without a browser canvas.
vi.mock("./DirectTerminal", () => ({ DirectTerminal: () => <div role="application" aria-label="Direct terminal control" /> }));

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    pane_id: "w1:p1",
    workspace_id: "w1",
    status: "working",
    attention: "working",
    title: "implementing the panel",
    kind: "claude",
    is_worktree: false,
    cwd: "/p/pocketAlarm",
    ...overrides,
  };
}

function settledIsland(overrides: Partial<SeaIsland> = {}): SeaIsland {
  return {
    view: {
      root: "/p/pocketAlarm",
      name: "pocketAlarm",
      plot: { x: 0, z: 0, w: 40, d: 48 },
      city: { status: "known", district_count: 23, building_count: 91, width: 21, depth: 28, source: "Git", measured_at: null },
      last_changed_at: 1_700_000_000,
    },
    attention: "working",
    agents: [agent()],
    ...overrides,
  };
}

function unsettledIsland(): SeaIsland {
  return {
    view: {
      root: "/p/speech.cpp",
      name: "speech.cpp",
      plot: { x: 0, z: 0, w: 60, d: 80 },
      city: { status: "known", district_count: 127, building_count: 464, width: 48, depth: 69, source: "Git", measured_at: null },
      last_changed_at: null,
    },
    attention: null,
    agents: [],
  };
}

// Default fake responses: `agent_kinds` resolves so "Start agent" is
// enabled by the time a test needs it.
function stubDefaults() {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "agent_kinds") return Promise.resolve(["claude", "codex"]);
    if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
    // The agent's herdr NAME, which is not its kind — read-only
    // `agent.list` on the backend (`proposed_agent_name`). Answers with
    // the repository's own name, which is what the real backend derives.
    if (cmd === "proposed_agent_name") return Promise.resolve("speech.cpp");
    // No history fixture in these tests — a real backend without anything to
    // report would still resolve a `RepoHistory`, but rejecting here is a
    // more honest stand-in for "no test data" than resolving `undefined`
    // (which `summarizeRepoHistory` was never meant to receive) and it
    // exercises the exact same silently-render-nothing path either way.
    if (cmd === "repo_history") return Promise.reject(new Error("no history in this test"));
    return Promise.resolve(undefined);
  });
}

describe("IslandPanel", () => {
  it("shows a known city's real district/building counts and last change", () => {
    stubDefaults();
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    expect(screen.getByText("23")).toBeTruthy();
    expect(screen.getByText("91")).toBeTruthy();
  });

  // Opus review (ITEM 1): `measured_at` was stamped on the Rust side but
  // nothing read it — these three pin the panel actually surfacing all three
  // honest states `describeMeasuredAt` can produce, never collapsing them
  // into the same look (see that module's own doc comment).
  it("shows a recent measurement as a plain fact, with no old-measurement styling", () => {
    stubDefaults();
    const recentSeconds = Math.floor(Date.now() / 1000) - 60 * 5;
    const island = settledIsland({
      view: {
        ...settledIsland().view,
        city: { status: "known", district_count: 23, building_count: 91, width: 21, depth: 28, source: "Git", measured_at: recentSeconds },
      },
    });
    render(<IslandPanel seaIsland={island} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    expect(screen.getByText("Measured")).toBeTruthy();
    expect(screen.getByText("5m ago")).toBeTruthy();
    expect(screen.queryByText(/may not reflect uncommitted work/)).toBeNull();
  });

  it("flags a noticeably old measurement with a visible caveat, not silently as a plain date", () => {
    stubDefaults();
    const oldSeconds = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 3;
    const island = settledIsland({
      view: {
        ...settledIsland().view,
        city: { status: "known", district_count: 23, building_count: 91, width: 21, depth: 28, source: "Git", measured_at: oldSeconds },
      },
    });
    render(<IslandPanel seaIsland={island} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    expect(screen.getByText("3 days ago")).toBeTruthy();
    expect(screen.getByText(/may not reflect uncommitted work/)).toBeTruthy();
  });

  it("renders a null measured_at as an honest 'never recorded' — never as a blank or fabricated date", () => {
    stubDefaults();
    const island = settledIsland({
      view: {
        ...settledIsland().view,
        city: { status: "known", district_count: 23, building_count: 91, width: 21, depth: 28, source: "Git", measured_at: null },
      },
    });
    render(<IslandPanel seaIsland={island} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    expect(screen.getByText(/cached before this was tracked/)).toBeTruthy();
  });

  it("lists each agent with its own attention marker and status", () => {
    stubDefaults();
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    expect(screen.getByText("implementing the panel")).toBeTruthy();
    expect(screen.getByText("working")).toBeTruthy();
  });

  // The author runs claude and codex at once; before this the two rows were
  // indistinguishable. Each row names its OWN kind — never one kind for the
  // whole island, and never the configured default.
  it("names each agent's own kind on its row", () => {
    stubDefaults();
    const island = settledIsland({
      agents: [
        agent({ pane_id: "w1:p1", kind: "claude", title: "implementing the panel" }),
        agent({ pane_id: "w1:p2", kind: "codex", title: "refactoring the parser" }),
      ],
    });
    render(<IslandPanel seaIsland={island} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();
  });

  // The honesty half. `kind === null` is "herdr reported no agent for this
  // pane" (verified live: the key is absent for a plain shell), and the row
  // must then say nothing about the kind — not the configured default from
  // `agent_kinds()`, not a placeholder glyph. `stubDefaults` has
  // `agent_kinds` resolving with "claude" first, so this also pins that the
  // row never borrows that answer.
  it("shows no kind on a row herdr reported no agent for, never a guessed one", async () => {
    stubDefaults();
    const island = settledIsland({
      agents: [agent({ pane_id: "w1:p9", kind: null, title: "a pane with no agent" })],
    });
    render(<IslandPanel seaIsland={island} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    await screen.findByRole("button", { name: "Start agent…" });
    const row = screen.getByText("a pane with no agent").closest("button")!;
    expect(row.textContent).not.toContain("claude");
    expect(row.querySelector(".island-panel__agent-kind")).toBeNull();
  });

  // The common live shape: herdr reports `terminal_title: "claude"` for a
  // pane running claude, so printing the kind again renders
  // `claude   claude blocked`. The word stays on the row exactly once
  // (in the title) — nothing is omitted, the stutter is.
  it("does not print the kind twice when the row's title already IS the kind", () => {
    stubDefaults();
    const island = settledIsland({
      agents: [agent({ pane_id: "w27:p1", kind: "claude", title: "claude", status: "blocked" })],
    });
    render(<IslandPanel seaIsland={island} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    const row = screen.getByText("claude").closest("button")!;
    expect(row.querySelector(".island-panel__agent-kind")).toBeNull();
    expect(row.textContent!.match(/claude/g)!.length).toBe(1);
  });

  // The de-duplication is an EXACT match, never a substring test — a pane
  // whose title happens to mention one agent while herdr says another is
  // running is precisely the confusion this field exists to clear up.
  it("still names the kind when the title merely mentions a different agent", () => {
    stubDefaults();
    const island = settledIsland({
      agents: [agent({ pane_id: "w27:p1", kind: "codex", title: "claude" })],
    });
    render(<IslandPanel seaIsland={island} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    const row = screen.getByText("claude").closest("button")!;
    expect(row.querySelector(".island-panel__agent-kind")!.textContent).toBe("codex");
  });

  // Quiet, not loud: the kind is a label, and the row's colour language is
  // reserved for the stopped/working/unknown attention marker. It must not
  // borrow the attention marker's classes (which brighten for `stopped`).
  it("keeps the kind label out of the attention colour language", () => {
    stubDefaults();
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    const kind = document.querySelector(".island-panel__agent-kind")!;
    expect(kind.className).not.toContain("island-panel__agent-marker");
    expect(kind.className).not.toContain("--stopped");
  });

  // Asserted against the SHARED label constants, not against literals —
  // both of these words now exist in exactly one place
  // (`externalTerminal.ts`, `StartAgent.tsx`), which is the whole guard
  // against the drift that has already cost this project real time.
  it("offers Start agent / the workspace-level external terminal for a settled island", () => {
    stubDefaults();
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    expect(screen.getByRole("button", { name: START_AGENT_LABEL })).toBeTruthy();
    const raise = screen.getByRole("button", { name: FOCUS_WORKSPACE_TERMINAL_LABEL });
    // It leaves the app, and says so — the same discipline the per-agent
    // raise follows, in the same words, for a different herdr call.
    expect(raise.getAttribute("title")).toMatch(/leaves the app/);
    expect(raise.getAttribute("title")).toMatch(/workspace\.focus/);
  });

  // THE REPORTED DEFECT, pinned: the author could not find how to start an
  // agent in a repo with no workspace. An unsettled repo's only action used
  // to read "Found a settlement" — pure metaphor, never the word "agent" — so
  // the one thing they wanted had no name anywhere on the path to doing it. The
  // capability was always there; the label was the bug.
  //
  // Asserted against the SHARED constant, deliberately: the regression this
  // guards against is the two branches drifting apart again, and comparing
  // both against one string is what makes that impossible rather than
  // merely unlikely.
  it("offers the very same 'start an agent' action on an UNSETTLED island — the reported defect", async () => {
    stubDefaults();
    render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    expect(screen.getByText(/none — unsettled/)).toBeTruthy();
    const starter = await screen.findByRole("button", { name: START_AGENT_LABEL });
    expect(starter).toBeTruthy();
    // No metaphor-only button left anywhere in the action row.
    expect(screen.queryByRole("button", { name: /settle/i })).toBeNull();
    // Still no "Focus terminal": there is no workspace, so there is no
    // terminal to focus. Genuinely absent, not disabled.
    expect(screen.queryByRole("button", { name: "Focus terminal" })).toBeNull();
  });

  // The opener must not go live before `agent_kinds()` resolves: the sheet
  // it opens NAMES the agent `found_settlement` will start, and the only
  // honest source for that name is `kinds[0]` (the configured default).
  it("keeps the unsettled opener disabled until agent_kinds() has actually answered", async () => {
    let resolveKinds: (kinds: string[]) => void = () => {};
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return new Promise<string[]>((resolve) => (resolveKinds = resolve));
      if (cmd === "resumable_agent_kinds") return Promise.resolve([]);
      if (cmd === "repo_history") return Promise.reject(new Error("no history in this test"));
      return Promise.resolve(undefined);
    });
    render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    expect((screen.getByRole("button", { name: START_AGENT_LABEL }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    resolveKinds(["codex", "claude"]);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: START_AGENT_LABEL }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    // And the sheet then names the CONFIGURED default (kinds[0]) as the
    // KIND, never a hardcoded "claude". It is the kind that tracks
    // `kinds[0]`; the NAME is herdr's own unique handle and comes from
    // `proposed_agent_name` (unstubbed here, so it is simply absent rather
    // than guessed).
    fireEvent.click(screen.getByRole("button", { name: START_AGENT_LABEL }));
    await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
    expect(screen.getByText(/agent\.start\s+kind="codex"/)).toBeTruthy();
  });

  // The other half of the unification: the sheet must SAY that a workspace
  // gets created first, rather than hiding the extra step behind "settle".
  it("discloses the extra workspace step in plain words, above the exact calls", async () => {
    stubDefaults();
    render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
    await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
    expect(screen.getByText(/speech\.cpp has no herdr workspace yet/)).toBeTruthy();
    expect(screen.getByText(/creates one.*then starts the agent in it/)).toBeTruthy();
    // Spec §5.6: the precise calls are still shown, both of them.
    const calls = document.querySelector(".sheet__calls")!.textContent!;
    expect(calls).toMatch(/workspace\.create\s+cwd="\/p\/speech\.cpp"/);
    expect(calls).toMatch(/agent\.start/);
  });

  // Opener, dialog and confirm button must each have their own accessible
  // name — an earlier pass broke six tests by giving two of them the same
  // one, and a duplicate name also makes the flow ambiguous to a screen
  // reader and to `getByRole`.
  it("gives the opener, the dialog and the confirm button three distinct accessible names", async () => {
    stubDefaults();
    render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
    const dialog = await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
    const confirm = screen.getByRole("button", { name: "Create workspace & start agent" });
    const names = [
      START_AGENT_LABEL,
      dialog.getAttribute("aria-label")!,
      confirm.textContent!,
    ];
    expect(new Set(names).size).toBe(3);
  });

  // The confirm button is not allowed to promise an agent the call will not
  // start — `found_settlement`'s `startAgent: false` really does only
  // create the workspace.
  it("stops promising an agent, in both the button and the lede, once the checkbox is cleared", async () => {
    stubDefaults();
    render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
    await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
    fireEvent.click(screen.getByLabelText("start claude"));
    expect(screen.queryByRole("button", { name: "Create workspace & start agent" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeTruthy();
    expect(screen.getByText(/No agent will be started/)).toBeTruthy();
    expect(document.querySelector(".sheet__calls")!.textContent).not.toMatch(/agent\.start/);
  });

  // Honesty about capability: resume exists only for kinds
  // `resumable_agent_kinds()` verifies, and a workspace that does not exist
  // yet has no previous conversation to resume at all. `found_settlement`
  // takes no resume flag, so a toggle here would silently do nothing.
  it("never offers resume on the unsettled path, even for a resumable kind", async () => {
    stubDefaults(); // resumable_agent_kinds() lists "claude", the default here
    render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
    await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
    expect(screen.queryByLabelText("resume previous conversation")).toBeNull();
    expect(document.querySelector(".sheet__calls")!.textContent).not.toMatch(/resume/);
  });

  // CRITICAL 3 (Opus frontend review): this used to assert the OPPOSITE —
  // that mounting this panel makes `isModalOpen()` true. That was the bug:
  // every jump's own `onArrive` opens this exact panel, so treating it as
  // modal made the Space hotkey go dead the instant a jump landed anywhere,
  // silently, forever, until the user clicked the panel closed. This panel
  // is informational, not modal (see its own doc comment) — mounting it must
  // NOT block a window-level hotkey.
  it("is NOT detected by isModalOpen() while mounted — it is informational, not modal, so Space keeps working", () => {
    stubDefaults();
    const { unmount } = render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    expect(isModalOpen()).toBe(false);
    unmount();
    expect(isModalOpen()).toBe(false);
  });

  // The nested "Start agent" confirm sheet IS a real modal (a call that
  // creates something real, same as `NewProjectPanel`/`FoundingSheet`) —
  // opening it while the island panel itself is open must start blocking
  // window-level hotkeys, even though the island panel alone does not.
  it("IS detected by isModalOpen() once the Start agent confirm sheet is open", async () => {
    stubDefaults();
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Start agent…" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(isModalOpen()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Start agent…" }));
    expect(isModalOpen()).toBe(true);
  });

  it("clears the selection on Escape", () => {
    stubDefaults();
    const onClose = vi.fn();
    render(<IslandPanel seaIsland={settledIsland()} onClose={onClose} onVisitTown={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // I3 (Opus frontend review): Escape used to close this panel UNCONDITIONALLY,
  // even mid-flight — unmounting the "Start agent" sheet along with it, so
  // the `failed` dispatch that arrived a moment later landed on nothing and
  // the user never learned their call actually failed.
  it("does not close (and does not discard the sheet) on Escape while 'Start agent' is in flight", async () => {
    let rejectStart: (error: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "resumable_agent_kinds") return Promise.resolve([]);
      if (cmd === "repo_history") return Promise.reject(new Error("no history in this test"));
      if (cmd === "start_agent") return new Promise((_resolve, reject) => (rejectStart = reject));
      return Promise.resolve(undefined);
    });
    const onClose = vi.fn();
    render(<IslandPanel seaIsland={settledIsland()} onClose={onClose} onVisitTown={vi.fn()} />);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Start agent…" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start agent…" }));
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    // Now busy: the real `start_agent` call is still pending.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Start an agent" })).toBeTruthy();

    rejectStart(new Error("herdr rejected agent.start"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/herdr rejected agent\.start/),
    );
  });

  it("calls onVisitTown when 'Visit town' is clicked", () => {
    stubDefaults();
    const onVisitTown = vi.fn();
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={onVisitTown} />);
    fireEvent.click(screen.getByRole("button", { name: "Visit town" }));
    expect(onVisitTown).toHaveBeenCalledTimes(1);
  });

  it("focuses the workspace immediately on click, with no confirm step", () => {
    stubDefaults();
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: FOCUS_WORKSPACE_TERMINAL_LABEL }));
    expect(invokeMock).toHaveBeenCalledWith("focus_workspace", { root: "/p/pocketAlarm" });
  });

  it("shows an honest error when focusing the workspace fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "focus_workspace") return Promise.reject(new Error("herdr not running"));
      return Promise.resolve(undefined);
    });
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: FOCUS_WORKSPACE_TERMINAL_LABEL }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/herdr not running/);
  });

  it("reveals the repository immediately on click, with no confirm step", () => {
    stubDefaults();
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    expect(invokeMock).toHaveBeenCalledWith("reveal_path", { path: "/p/pocketAlarm" });
  });

  it("never calls start_agent just from opening the sheet or picking a kind", async () => {
    stubDefaults();
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Start agent…" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start agent…" }));
    await screen.findByRole("dialog", { name: "Start an agent" });
    fireEvent.change(screen.getByLabelText("Kind:"), { target: { value: "codex" } });
    expect(invokeMock).not.toHaveBeenCalledWith("start_agent", expect.anything());
  });

  it("starts the agent with the picked kind only after the confirm button is clicked", async () => {
    stubDefaults();
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Start agent…" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start agent…" }));
    await screen.findByRole("dialog", { name: "Start an agent" });
    fireEvent.change(screen.getByLabelText("Kind:"), { target: { value: "codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_agent", {
        root: "/p/pocketAlarm",
        kind: "codex",
        resume: false,
      }),
    );
  });

  it("shows the default kind preselected, sourced from agent_kinds(), never hardcoded", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["mycustomkind", "claude"]);
      if (cmd === "resumable_agent_kinds") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Start agent…" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start agent…" }));
    const select = (await screen.findByLabelText("Kind:")) as HTMLSelectElement;
    expect(select.value).toBe("mycustomkind");
  });

  it("shows an honest error inside the sheet when starting the agent fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "start_agent") return Promise.reject(new Error("agent_pane_busy"));
      return Promise.resolve(undefined);
    });
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Start agent…" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start agent…" }));
    await screen.findByRole("dialog", { name: "Start an agent" });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/agent_pane_busy/);
  });

  it("offers 'resume previous conversation' only for a kind resumable_agent_kinds() actually lists", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["claude", "somekind"]);
      if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
      return Promise.resolve(undefined);
    });
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Start agent…" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start agent…" }));
    await screen.findByRole("dialog", { name: "Start an agent" });
    // Default kind "claude" is resumable — the checkbox is offered.
    expect(screen.getByLabelText("resume previous conversation")).toBeTruthy();
    // Switching to a non-resumable kind removes the toggle and explains why,
    // rather than leaving a toggle that would silently do nothing.
    fireEvent.change(screen.getByLabelText("Kind:"), { target: { value: "somekind" } });
    expect(screen.queryByLabelText("resume previous conversation")).toBeNull();
    expect(screen.getByText(/no known resume flag for somekind/)).toBeTruthy();
  });

  it("sends resume=true only when the user actually checked the box", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "start_agent") return Promise.resolve("w9:p1");
      return Promise.resolve(undefined);
    });
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Start agent…" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start agent…" }));
    await screen.findByRole("dialog", { name: "Start an agent" });
    fireEvent.click(screen.getByLabelText("resume previous conversation"));
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_agent", {
        root: "/p/pocketAlarm",
        kind: "claude",
        resume: true,
      }),
    );
  });

  it("never calls found_settlement just from opening the sheet on an unsettled island", async () => {
    stubDefaults();
    render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
    await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
    expect(invokeMock).not.toHaveBeenCalledWith("found_settlement", expect.anything());
  });

  // The renamed entry point must still reach the SAME backend call — the
  // unification is of language, never of the Rust: `found_settlement` and
  // `start_agent` stay two distinct commands.
  it("calls found_settlement only after the confirm button is clicked, reusing the same command as the HUD list", async () => {
    stubDefaults();
    render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
    await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace & start agent" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("found_settlement", {
        path: "/p/speech.cpp",
        startAgent: true,
        // Item 4: the founding path now names its kind explicitly, so the
        // call matches the sheet that authorized it instead of leaning on
        // the backend's fallback.
        kind: "claude",
      }),
    );
  });

  it("shows a quiet history summary when repo_history has something honest to say", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "repo_history") {
        return Promise.resolve({
          root: "/p/pocketAlarm",
          name: "pocketAlarm",
          spans: [],
          working_sessions: 4,
          total_working_secs: 3600,
          last_observed_at: null,
          current_status: null,
          current_status_pane: null,
          current_status_since: null,
          current_status_since_exact: false,
          name_ambiguous: false,
          legacy_rows_matched_by_name: 0,
          legacy_rows_excluded_ambiguous: 0,
        });
      }
      return Promise.resolve(undefined);
    });
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    expect(await screen.findByText(/4 sessions/)).toBeTruthy();
  });

  // ---------------------------------------------------------------------
  // Item 1 (terminal-polish round): starting an agent lands you in its
  // terminal. The author said it twice in one report. The honesty
  // constraint is the whole design: open the terminal for the pane the
  // BACKEND named, only once the world confirms that pane exists — never
  // optimistically, and never for a different one.
  // ---------------------------------------------------------------------
  describe("opening the terminal for an agent you just started", () => {
    function startAgentStubs(paneId: string) {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "agent_kinds") return Promise.resolve(["claude", "codex"]);
        if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
        if (cmd === "repo_history") return Promise.reject(new Error("no history in this test"));
        if (cmd === "start_agent") return Promise.resolve(paneId);
        if (cmd === "pane_read") return Promise.resolve({ text: "the new agent's screen", revision: 0, truncated: false });
        if (cmd === "read_agent") return Promise.resolve({ text: "snapshot", truncated: false });
        return Promise.resolve(undefined);
      });
    }

    async function startAnAgent(island: SeaIsland) {
      const view = render(<IslandPanel seaIsland={island} onClose={vi.fn()} onVisitTown={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
      await screen.findByRole("dialog", { name: "Start an agent" });
      fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
      return view;
    }

    it("does not open a terminal until the world reports the pane the backend named", async () => {
      startAgentStubs("w9:p1");
      const { rerender } = await startAnAgent(settledIsland());
      // The call has returned, and the world has NOT yet pushed the new
      // pane: no terminal, and the panel says what it is waiting for
      // rather than sitting silent or faking it.
      expect(await screen.findByText(/opening the terminal for w9:p1/i)).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: /^Terminal:/ })).toBeNull();

      // Now herdr reports it, exactly as a `world-updated` push would.
      const withNewAgent = settledIsland({
        agents: [agent(), agent({ pane_id: "w9:p1", workspace_id: "w9", title: "fresh claude" })],
      });
      rerender(<IslandPanel seaIsland={withNewAgent} onClose={vi.fn()} onVisitTown={vi.fn()} />);
      const terminal = await screen.findByRole("dialog", { name: /^Terminal:/ });
      expect(terminal.getAttribute("aria-label")).toMatch(/fresh claude/);
      expect(screen.getByText("w9:p1 · /p/pocketAlarm")).toBeTruthy();
    });

    it("opens the terminal for the pane that was created, never the one that was already there", async () => {
      startAgentStubs("w9:p1");
      const { rerender } = await startAnAgent(settledIsland());
      await screen.findByText(/opening the terminal for w9:p1/i);
      rerender(
        <IslandPanel
          seaIsland={settledIsland({
            agents: [agent(), agent({ pane_id: "w9:p1", workspace_id: "w9", title: "fresh claude" })],
          })}
          onClose={vi.fn()}
          onVisitTown={vi.fn()}
        />,
      );
      const terminal = await screen.findByRole("dialog", { name: /^Terminal:/ });
      // The pre-existing agent's pane id (`w1:p1`, title "implementing the
      // panel") must NOT be what the keyboard is now pointed at.
      expect(terminal.getAttribute("aria-label")).not.toMatch(/implementing the panel/);
      expect(screen.queryByText("w1:p1 · /p/pocketAlarm")).toBeNull();
    });

    it("says so plainly when the pane never appears, instead of waiting forever or opening an empty terminal", async () => {
      vi.useFakeTimers();
      try {
        startAgentStubs("w9:p1");
        render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
        // The opener is disabled until `agent_kinds()` resolves (so the
        // sheet can never name a kind it guessed) — under fake timers that
        // promise has to be given a chance to settle, or the click lands
        // on a disabled button and nothing happens.
        await vi.waitFor(() => {
          const opener = screen.getByRole("button", { name: START_AGENT_LABEL }) as HTMLButtonElement;
          if (opener.disabled) throw new Error("agent_kinds has not resolved yet");
          return opener;
        });
        fireEvent.click(screen.getByRole("button", { name: START_AGENT_LABEL }));
        await vi.waitFor(() => screen.getByRole("dialog", { name: "Start an agent" }));
        fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
        await vi.waitFor(() => screen.getByText(/opening the terminal for w9:p1/i));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        // Names the pane, says the agent DID start, and does not pretend
        // a terminal is open.
        expect(screen.getByText(/herdr has not reported pane w9:p1 yet/i)).toBeTruthy();
        expect(screen.queryByRole("dialog", { name: /^Terminal:/ })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("opens nothing at all when the start call fails — the sheet keeps the error", async () => {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "agent_kinds") return Promise.resolve(["claude", "codex"]);
        if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
        if (cmd === "repo_history") return Promise.reject(new Error("no history in this test"));
        if (cmd === "start_agent") return Promise.reject(new Error("herdr is not running"));
        return Promise.resolve(undefined);
      });
      await startAnAgent(settledIsland());
      expect(await screen.findByText(/herdr is not running/)).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: /^Terminal:/ })).toBeNull();
      expect(screen.queryByText(/opening the terminal/i)).toBeNull();
    });

    it("founding a settlement opens the terminal for the pane found_settlement created", async () => {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "agent_kinds") return Promise.resolve(["claude", "codex"]);
        if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
        if (cmd === "repo_history") return Promise.reject(new Error("no history in this test"));
        // The new return shape: the workspace AND the pane the agent was
        // started in. The pane id is the whole reason this is no longer a
        // bare string — a terminal cannot honestly be opened on a guess.
        if (cmd === "found_settlement") return Promise.resolve({ workspace_id: "w12", pane_id: "w12:p1" });
        if (cmd === "pane_read") return Promise.resolve({ text: "a brand new claude", revision: 0, truncated: false });
        if (cmd === "read_agent") return Promise.resolve({ text: "snapshot", truncated: false });
        return Promise.resolve(undefined);
      });
      const { rerender } = render(
        <IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />,
      );
      fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
      await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
      fireEvent.click(screen.getByRole("button", { name: "Create workspace & start agent" }));
      await screen.findByText(/opening the terminal for w12:p1/i);

      // The world catches up: the repo is settled now, with the new pane.
      rerender(
        <IslandPanel
          seaIsland={{
            ...unsettledIsland(),
            attention: "working",
            agents: [
              agent({
                pane_id: "w12:p1",
                workspace_id: "w12",
                cwd: "/p/speech.cpp",
                title: "a fresh settlement",
              }),
            ],
          }}
          onClose={vi.fn()}
          onVisitTown={vi.fn()}
        />,
      );
      expect(await screen.findByText("w12:p1 · /p/speech.cpp")).toBeTruthy();
    });

    it("founding WITHOUT an agent opens no terminal — there is no agent to open one for", async () => {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "agent_kinds") return Promise.resolve(["claude", "codex"]);
        if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
        if (cmd === "repo_history") return Promise.reject(new Error("no history in this test"));
        if (cmd === "found_settlement") return Promise.resolve({ workspace_id: "w12", pane_id: "w12:p1" });
        return Promise.resolve(undefined);
      });
      render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
      await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
      fireEvent.click(screen.getByLabelText(/^start /));
      fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("found_settlement", {
          path: "/p/speech.cpp",
          startAgent: false,
          kind: "claude",
        }),
      );
      expect(screen.queryByText(/opening the terminal/i)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Item 4 (terminal-polish round), the author: "where cna i choose which
  // claude od codex?" — asked while looking at the founding sheet, the one
  // path that never offered the choice.
  // ---------------------------------------------------------------------
  describe("choosing the agent kind when founding", () => {
    it("offers the same kinds the settled sheet does, configured default first", async () => {
      stubDefaults();
      render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
      await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
      const picker = screen.getByLabelText("Kind:") as HTMLSelectElement;
      expect([...picker.options].map((o) => o.value)).toEqual(["claude", "codex"]);
      expect(picker.value).toBe("claude");
    });

    it("the exact-calls block and the checkbox both follow the chosen kind", async () => {
      stubDefaults();
      render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
      await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
      fireEvent.change(screen.getByLabelText("Kind:"), { target: { value: "codex" } });
      // Spec §5.6: the sheet names the exact call that will run. If the
      // picker and the `<pre>` could disagree, the sheet would be worse
      // than useless.
      // The NAME is the repository's (herdr requires it to be globally
      // unique); the KIND is what the picker chose. Two different things,
      // asserted as two different things — they used to be one string, and
      // that was the `agent_name_taken` bug.
      await waitFor(() =>
        expect(
          screen.getByText(/agent\.start\s+name="speech\.cpp"\s+kind="codex"/),
        ).toBeTruthy(),
      );
      expect(screen.getByLabelText("start codex")).toBeTruthy();
    });

    it("passes the chosen kind to found_settlement, not the backend's default", async () => {
      stubDefaults();
      render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
      await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
      fireEvent.change(screen.getByLabelText("Kind:"), { target: { value: "codex" } });
      fireEvent.click(screen.getByRole("button", { name: "Create workspace & start agent" }));
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("found_settlement", {
          path: "/p/speech.cpp",
          startAgent: true,
          kind: "codex",
        }),
      );
    });

    it("still offers no resume toggle — a workspace that does not exist has no conversation to resume", async () => {
      stubDefaults();
      render(<IslandPanel seaIsland={unsettledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: START_AGENT_LABEL }));
      await screen.findByRole("dialog", { name: FOUNDING_SHEET_TITLE });
      expect(screen.queryByLabelText(/resume/i)).toBeNull();
    });
  });

  it("shows nothing for history when repo_history fails, never an alarming error box", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
      if (cmd === "repo_history") return Promise.reject(new Error("no such file"));
      return Promise.resolve(undefined);
    });
    render(<IslandPanel seaIsland={settledIsland()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
    // Give the rejected promise a tick to settle.
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("repo_history", { root: "/p/pocketAlarm" }));
    expect(screen.queryByText("History")).toBeNull();
    expect(screen.queryByText(/no such file/)).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Item 2 (lag-and-switcher round): the sea can ask this panel to open one
  // specific pane's terminal, which is how "go to whoever else is waiting"
  // lands somewhere from inside an already-open terminal.
  // ---------------------------------------------------------------------
  describe("opening a terminal the sea asked for", () => {
    function switchStubs() {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "agent_kinds") return Promise.resolve(["claude", "codex"]);
        if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
        if (cmd === "repo_history") return Promise.reject(new Error("no history in this test"));
        if (cmd === "pane_read")
          return Promise.resolve({ text: "the requested pane", revision: 0, truncated: false });
        if (cmd === "read_agent") return Promise.resolve({ text: "snapshot", truncated: false });
        return Promise.resolve(undefined);
      });
    }

    const twoAgents = () =>
      settledIsland({
        agents: [
          agent({ pane_id: "w1:p1", title: "the one already open" }),
          agent({ pane_id: "w1:p2", title: "the one that is waiting", attention: "stopped", status: "blocked" }),
        ],
      });

    it("opens the terminal for exactly the pane requested, not the first agent on the island", async () => {
      switchStubs();
      render(
        <IslandPanel
          seaIsland={twoAgents()}
          onClose={vi.fn()}
          onVisitTown={vi.fn()}
          openTerminalRequest={{ paneId: "w1:p2", seq: 1 }}
        />,
      );
      const terminal = await screen.findByRole("dialog", { name: /^Terminal:/ });
      expect(terminal.getAttribute("aria-label")).toMatch(/the one that is waiting/);
      expect(screen.getByText("w1:p2 · /p/pocketAlarm")).toBeTruthy();
    });

    it("opens nothing at all without a request — a terminal is never opened unasked", async () => {
      switchStubs();
      render(<IslandPanel seaIsland={twoAgents()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
      await screen.findByRole("button", { name: START_AGENT_LABEL });
      expect(screen.queryByRole("dialog", { name: /^Terminal:/ })).toBeNull();
    });

    // Sea/town consistency round: the terminal is now mounted by this
    // PANEL rather than by the expanded row inside it, so this is the
    // property that has to stay true — expanding a row shows that agent's
    // surface and nothing else. A terminal types into a live session; it is
    // never opened as a side effect of looking at something.
    it("opens no terminal just from expanding an agent's row", async () => {
      switchStubs();
      render(<IslandPanel seaIsland={twoAgents()} onClose={vi.fn()} onVisitTown={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: /the one that is waiting/ }));
      // The row's own surface is up — and its two terminal actions with it.
      await screen.findByText("snapshot");
      expect(screen.getByRole("button", { name: RAISE_EXTERNAL_TERMINAL_LABEL })).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: /^Terminal:/ })).toBeNull();
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "pane_read")).toBe(false);
    });

    it("says so, in the same words a town says it, when herdr stops reporting the attached pane", async () => {
      switchStubs();
      const { rerender } = render(
        <IslandPanel
          seaIsland={twoAgents()}
          onClose={vi.fn()}
          onVisitTown={vi.fn()}
          openTerminalRequest={{ paneId: "w1:p2", seq: 1 }}
        />,
      );
      await screen.findByRole("dialog", { name: /^Terminal:/ });
      rerender(
        <IslandPanel
          seaIsland={settledIsland({ agents: [agent({ pane_id: "w1:p1", title: "the one already open" })] })}
          onClose={vi.fn()}
          onVisitTown={vi.fn()}
          openTerminalRequest={{ paneId: "w1:p2", seq: 1 }}
        />,
      );
      await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Terminal:/ })).toBeNull());
      expect(screen.getByText(paneGoneNote("w1:p2"))).toBeTruthy();
    });

    it("re-opens on a NEW request for the same pane, which a bare pane id could not express", async () => {
      // Switch to a pane, close the terminal, switch back to the same pane:
      // the second request must land. This is why the request is an object
      // with its own sequence number and not a string.
      switchStubs();
      const { rerender } = render(
        <IslandPanel
          seaIsland={twoAgents()}
          onClose={vi.fn()}
          onVisitTown={vi.fn()}
          openTerminalRequest={{ paneId: "w1:p2", seq: 1 }}
        />,
      );
      await screen.findByRole("dialog", { name: /^Terminal:/ });
      fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
      expect(screen.queryByRole("dialog", { name: /^Terminal:/ })).toBeNull();
      rerender(
        <IslandPanel
          seaIsland={twoAgents()}
          onClose={vi.fn()}
          onVisitTown={vi.fn()}
          openTerminalRequest={{ paneId: "w1:p2", seq: 2 }}
        />,
      );
      expect(await screen.findByRole("dialog", { name: /^Terminal:/ })).toBeTruthy();
    });
  });
});
