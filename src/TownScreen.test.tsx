// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Agent, Island } from "./world";
import type { TownViewProps } from "./components/TownView";
import { RAISE_EXTERNAL_TERMINAL_LABEL } from "./externalTerminal";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
// jsdom has no terminal canvas. Exercise the real mode switch and mirror fallback;
// DirectTerminal and transport have separate emulator/IPC lifecycle tests.
vi.mock("./components/DirectTerminal", () => ({ DirectTerminal: () => <p role="alert">Direct control unavailable in test browser</p> }));
async function openMirror() {
  fireEvent.click(await screen.findByRole("button", { name: "Return to mirror" }));
  await screen.findByText("live pane screen");
}

/**
 * The real `TownView` mounts a WebGL `<Canvas>`, which jsdom has no answer
 * for — so it is replaced here by a stand-in that does exactly three things
 * and nothing else: it REPORTS the two props this round is about
 * (`frameloop`, `keyboardCaptured`) into the DOM where a test can read them,
 * it offers the two villager gestures as ordinary buttons, and it renders
 * whatever `villagerActions` hands it. Everything under test —
 * `TownScreen`'s own state, the real `Terminal`, the real `AgentActions`,
 * the real `useTerminalStageHost`/`sceneFrameloop` — is the shipped code.
 *
 * It offers ONE villager gesture, because there is now one: the external
 * raise moved into `AgentActions` (shared with the sea), so it arrives
 * through `villagerActions` below rather than through a prop of its own.
 */
vi.mock("./components/TownView", () => ({
  TownView: (props: TownViewProps) => (
    <div
      data-testid="town-view"
      data-frameloop={props.frameloop}
      data-keyboard-captured={String(props.keyboardCaptured ?? false)}
    >
      {(props.agents ?? []).map((agent) => (
        <div key={agent.pane_id}>
          <button type="button" onClick={() => props.onVillagerClick?.(agent)}>
            villager {agent.pane_id}
          </button>
        </div>
      ))}
      {/* Stands in for the villager panel actually being open. */}
      {props.villagerActions?.((props.agents ?? [])[0] as Agent)}
    </div>
  ),
}));

// Imported AFTER the mock, as vitest requires for a module the subject
// imports at load time.
const { TownScreen } = await import("./App");

const CITY = {
  model: { districts: [], skipped: 0, submodules: 0 },
  layout: { districts: [], width: 1, depth: 1 },
};

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    pane_id: "w2:p1",
    workspace_id: "w2",
    status: "working",
    attention: "working",
    title: "claude",
    kind: "claude",
    is_worktree: false,
    cwd: "/p/orchard",
    ...overrides,
  };
}

const ORCHARD: Island = {
  id: "/p/orchard",
  name: "orchard",
  root: "/p/orchard",
  attention: "working",
  agents: [agent()],
  last_changed_at: null,
};

const OTHER: Island = {
  id: "/p/pocketAlarm",
  name: "pocketAlarm",
  root: "/p/pocketAlarm",
  attention: "stopped",
  agents: [agent({ pane_id: "w9:p1", workspace_id: "w9", attention: "stopped", cwd: "/p/pocketAlarm" })],
  last_changed_at: null,
};

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "city_for") return Promise.resolve(CITY);
    if (cmd === "repo_changes") return Promise.resolve({ root: "/p/orchard", branch: "main", entries: [], truncated: false });
    if (cmd === "pane_read") return Promise.resolve({ text: "live pane screen", revision: 0, truncated: false });
    if (cmd === "read_agent") return Promise.resolve({ text: "last output", truncated: false });
    if (cmd === "agent_kinds") return Promise.resolve(["claude", "codex"]);
    if (cmd === "resumable_agent_kinds") return Promise.resolve(["claude"]);
    if (cmd === "repo_history") return Promise.reject(new Error("no history in this test"));
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  vi.restoreAllMocks();
});

function renderTown(islands: Island[] = [ORCHARD, OTHER], island: Island = ORCHARD) {
  return render(<TownScreen island={island} islands={islands} onClose={vi.fn()} />);
}

function townView() {
  return screen.getByTestId("town-view");
}

describe("TownScreen — a town you can work from", () => {
  it("keeps the newest refresh when an older scan finishes later", async () => {
    renderTown();
    await screen.findByRole("button", { name: "Refresh files and changes" });
    let first!: (value: unknown) => void, second!: (value: unknown) => void;
    // city_for is called synchronously by the refresh action; repository
    // changes are read by an effect after that render.
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "city_for") return new Promise(resolve => { if (!first) first = resolve; else second = resolve; });
      return Promise.resolve({ root: "/p/orchard", branch: "main", entries: [], truncated: false });
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh files and changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh files and changes" }));
    await act(async () => second({ ...CITY, model: { ...CITY.model, skipped: 99 } }));
    expect(screen.getByText(/99 skipped/)).toBeTruthy();
    await act(async () => first({ ...CITY, model: { ...CITY.model, skipped: 13 } }));
    expect(screen.getByText(/99 skipped/)).toBeTruthy();
  });
  // The defect this round started from, in one test: a town offered no
  // terminal at all, and what a click DID do was worse than nothing: it
  // raised iTerm and ejected the author from the app.
  it("opens that agent's terminal in the app when a villager is clicked — and never calls focus_pane", async () => {
    renderTown();
    fireEvent.click(await screen.findByText("villager w2:p1"));
    // The real Terminal starts direct; its explicit mirror fallback reads the named pane.
    await openMirror();
    expect(screen.getByText("w2:p1 · /p/orchard")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("pane_read", { paneId: "w2:p1", expectedRoot: "/p/orchard" });
    expect(invokeMock.mock.calls.some((call) => call[0] === "focus_pane")).toBe(false);
  });

  // The explicit action now comes from the SHARED `AgentActions` button
  // (sea/town consistency round) rather than a town-only one, which is why
  // this reaches it through the selected villager's own panel.
  it("still raises the real external terminal — but only from the explicit action", async () => {
    renderTown();
    fireEvent.click(await screen.findByRole("button", { name: RAISE_EXTERNAL_TERMINAL_LABEL }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("focus_pane", { paneId: "w2:p1" }));
    // And it did NOT open the embedded one: that is a different gesture.
    expect(screen.queryByRole("application")).toBeNull();
  });

  // THE PERFORMANCE FIX, carried across from the sea (87c03a6/195a558).
  it("stops rendering the town while a terminal covers it, and resumes when it closes", async () => {
    renderTown();
    await screen.findByTestId("town-view");
    expect(townView().getAttribute("data-frameloop")).toBe("always");
    fireEvent.click(screen.getByText("villager w2:p1"));
    await openMirror();
    expect(townView().getAttribute("data-frameloop")).toBe("demand");
    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    await waitFor(() => expect(townView().getAttribute("data-frameloop")).toBe("always"));
  });

  it("tells the town its keyboard is spoken for while the terminal is up", async () => {
    renderTown();
    await screen.findByTestId("town-view");
    expect(townView().getAttribute("data-keyboard-captured")).toBe("false");
    fireEvent.click(screen.getByText("villager w2:p1"));
    await openMirror();
    expect(townView().getAttribute("data-keyboard-captured")).toBe("true");
  });

  // Item 2: the switcher belongs here too, and it is the SAME switcher —
  // every agent running anywhere, so its "this is the only agent running"
  // answer stays true and a town is not a dead end.
  it("reaches every agent from the town's terminal, including other repositories'", async () => {
    renderTown();
    fireEvent.click(await screen.findByText("villager w2:p1"));
    await openMirror();
    const otherTab = screen.getByRole("button", { name: /pocketAlarm/ });
    expect(otherTab).toBeTruthy();
    fireEvent.click(otherTab);
    // Re-attached: the header's attachment line now names the other pane
    // AND the other repository, which is what every pane call is checked
    // against.
    await screen.findByText("w9:p1 · /p/pocketAlarm");
    await openMirror();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pane_read", {
        paneId: "w9:p1",
        expectedRoot: "/p/pocketAlarm",
      }),
    );
  });

  // Item 2, the other half: you should not have to find a villager among a
  // thousand buildings to reach the agents working here.
  it("opens this repository's terminal from the header, without hunting for a villager", async () => {
    const two: Island = {
      ...ORCHARD,
      agents: [
        agent({ pane_id: "w2:p1", attention: "working" }),
        agent({ pane_id: "w2:p2", attention: "stopped", title: "codex", kind: "codex" }),
      ],
    };
    renderTown([two, OTHER], two);
    const opener = await screen.findByRole("button", { name: /Open terminal ⤢ · 2 here/ });
    fireEvent.click(opener);
    // Attention-first, via the same `switchTargets` ordering the strip
    // uses: the stopped one is the one waiting for him.
    await screen.findByText("w2:p2 · /p/orchard");
  });

  it("says plainly when there is no agent here to open a terminal on", async () => {
    const empty: Island = { ...ORCHARD, agents: [], attention: "quiet" };
    renderTown([empty], empty);
    const opener = await screen.findByRole("button", { name: /Open terminal ⤢/ });
    expect((opener as HTMLButtonElement).disabled).toBe(true);
    expect(opener.getAttribute("title")).toMatch(/no agent is running in this repository/);
  });

  // Item 3, and it is the SEA's flow — same label, same sheet, same
  // command — not a second implementation living in `App.tsx`.
  it("offers the same Start agent… flow the sea does", async () => {
    renderTown();
    const starter = await screen.findByRole("button", { name: "Start agent…" });
    await waitFor(() => expect((starter as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(starter);
    expect(screen.getByRole("dialog", { name: "Start an agent" })).toBeTruthy();
    expect(screen.getByText(/agent\.start/)).toBeTruthy();
  });

  // The prompt box and "read what it last said", from the same component
  // the sea uses — and with the terminal hosted by the screen, so pressing
  // "Open terminal ⤢" inside it cannot mount a second, competing mirror.
  it("gives a selected villager the same prompt box and last output the sea gives", async () => {
    renderTown();
    await screen.findByText("last output");
    expect(screen.getByPlaceholderText(/Message this agent/)).toBeTruthy();
    // Two doors, one action, one label (`OPEN_TERMINAL_LABEL`) — the row's
    // own button and the header's. This clicks the ROW's.
    const rowOpener = screen
      .getAllByRole("button", { name: "Open terminal ⤢" })
      .find((button) => button.classList.contains("agent-actions__open"));
    expect(rowOpener).toBeTruthy();
    fireEvent.click(rowOpener as HTMLElement);
    await openMirror();
    // Exactly one terminal surface: the row delegated to the screen rather
    // than mounting a second, competing mirror of the same pane.
    expect(screen.getAllByRole("application").length).toBe(1);
  });

  it("closes the terminal, and says why, when herdr stops reporting that pane", async () => {
    const { rerender } = renderTown();
    fireEvent.click(await screen.findByText("villager w2:p1"));
    await openMirror();
    const gone: Island = { ...ORCHARD, agents: [] };
    rerender(<TownScreen island={gone} islands={[gone, OTHER]} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole("application")).toBeNull());
    expect(screen.getByText(/w2:p1 is no longer running/)).toBeTruthy();
  });
});

// ESCAPE, resolved deliberately: the town uses it to go back, the terminal
// sends it to the agent, and both of those must keep being true.
describe("TownScreen — Escape", () => {
  it("sends Escape to the agent (and closes nothing) while the pane surface is focused", async () => {
    const onClose = vi.fn();
    render(<TownScreen island={ORCHARD} islands={[ORCHARD, OTHER]} onClose={onClose} />);
    fireEvent.click(await screen.findByText("villager w2:p1"));
    await openMirror();
    const surface = await screen.findByRole("application");
    act(() => surface.focus());
    fireEvent.keyDown(surface, { key: "Escape" });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", {
        paneId: "w2:p1",
        keys: ["escape"],
        expectedRoot: "/p/orchard",
      }),
    );
    // Neither the terminal nor the town went anywhere.
    expect(screen.getByRole("application")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes the terminal — and only the terminal — when Escape is pressed outside the pane surface", async () => {
    const onClose = vi.fn();
    render(<TownScreen island={ORCHARD} islands={[ORCHARD, OTHER]} onClose={onClose} />);
    fireEvent.click(await screen.findByText("villager w2:p1"));
    await openMirror();
    await screen.findByRole("application");
    act(() => screen.getByRole("button", { name: "Close terminal dock" }).focus());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("application")).toBeNull());
    expect(screen.getByTestId("town-view")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
