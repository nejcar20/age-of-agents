// @vitest-environment jsdom
//
// THE SEA'S OWN SCREEN-LEVEL WIRING, in jsdom — the half that had no test
// at all before this round, and the half the defect lived in: what a click
// on a villager actually does.
//
// `Archipelago` mounts a real WebGL `<Canvas>`, which jsdom has no answer
// for, so `@react-three/fiber` and `@react-three/drei` are replaced here by
// the smallest possible stand-ins: a `Canvas` that renders nothing (its
// children are the 3D scene, which no assertion here is about) and inert
// hooks. Everything under test is the shipped code: `Archipelago`'s own
// state, the real `IslandPanel`, the real `AgentActions`, the real
// `Terminal`, the real `useTerminalStageHost`/`sceneFrameloop`.
//
// The villager click is reached through `autoVillagerClickPaneId`, which
// calls the REAL `handleVillagerClick` — deliberately not a hand-set piece
// of state that resembles a click, because the whole point of these tests
// is the handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IslandView } from "../archipelago";
import type { Agent, Island } from "../world";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
// Browser canvas is covered by DirectTerminal's emulator lifecycle tests.
// Keep the actual sea -> IslandPanel -> Terminal mode selection here.
vi.mock("./DirectTerminal", () => ({ DirectTerminal: ({ paneId }: { paneId: string }) => <div role="application" aria-label="Direct terminal control" tabIndex={0}>Streaming {paneId}</div> }));

vi.mock("@react-three/fiber", () => ({
  Canvas: () => null,
  useFrame: () => {},
  useThree: () => ({ camera: null, gl: null, size: { width: 800, height: 600 }, invalidate: () => {} }),
  extend: () => {},
  invalidate: () => {},
}));
vi.mock("@react-three/drei", () => ({ Html: () => null, OrbitControls: () => null }));

const { Archipelago } = await import("./Archipelago");
const { RAISE_EXTERNAL_TERMINAL_LABEL } = await import("../externalTerminal");
const { paneGoneNote } = await import("../terminalAttachment");

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

function view(root: string, name: string): IslandView {
  return {
    root,
    name,
    plot: { x: 0, z: 0, w: 40, d: 40 },
    city: {
      status: "known",
      district_count: 3,
      building_count: 9,
      width: 10,
      depth: 10,
      source: "Git",
      measured_at: null,
    },
    last_changed_at: null,
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
  agents: [
    agent({ pane_id: "w9:p1", workspace_id: "w9", attention: "stopped", status: "blocked", cwd: "/p/pocketAlarm" }),
  ],
  last_changed_at: null,
};

const ARCHIPELAGO = [view("/p/orchard", "orchard"), view("/p/pocketAlarm", "pocketAlarm")];

beforeEach(() => {
  // `Terminal`'s poll only runs while `useWindowFocused` reports focused —
  // asserted rather than assumed of jsdom's default, as every other
  // terminal test in this repo does.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  invokeMock.mockImplementation((cmd: string) => {
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

async function useMirror() {
  fireEvent.click(await screen.findByRole("button", { name: "Return to mirror" }));
  await screen.findByText("live pane screen");
}

function renderSea(islands: Island[] = [ORCHARD, OTHER], clickPaneId = "w2:p1") {
  return render(
    <Archipelago
      archipelago={ARCHIPELAGO}
      islands={islands}
      onOpenIsland={vi.fn()}
      autoVillagerClickPaneId={clickPaneId}
    />,
  );
}

describe("clicking a villager in the sea", () => {
  it("opens the world-map terminal in direct control and preserves that mode when switching projects", async () => {
    renderSea();
    await screen.findByText("Streaming w2:p1");
    expect(screen.getByRole("button", { name: "Return to mirror" })).toBeTruthy();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "pane_read")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /pocketAlarm/ }));
    await screen.findByText("Streaming w9:p1");
    expect(screen.getByRole("button", { name: "Return to mirror" })).toBeTruthy();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "pane_read" || cmd === "focus_pane")).toBe(false);
  });
  // THE DEFECT, pinned. The sea called `focus_pane` immediately and
  // unconditionally, raising the author's own iTerm window and ejecting them
  // from the app — while the SAME gesture in a town opened that agent's
  // terminal inside it. One gesture, one meaning, on both screens.
  it("opens that agent's terminal in the app — and never calls focus_pane", async () => {
    renderSea();
    await useMirror();
    expect(screen.getByText("w2:p1 · /p/orchard")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("pane_read", { paneId: "w2:p1", expectedRoot: "/p/orchard" });
    expect(invokeMock.mock.calls.some((call) => call[0] === "focus_pane")).toBe(false);
  });

  // The two things the old click did BESIDES `focus_pane`, both deliberately
  // kept: the island is selected (its panel is what mounts the terminal, and
  // what says which repository this is), and that agent's row is expanded
  // (so closing the terminal lands on its prompt box, not on nothing).
  it("selects the island and expands that agent's row underneath the terminal", async () => {
    renderSea();
    await useMirror();
    expect(screen.getByRole("dialog", { name: "Island: orchard" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    await waitFor(() => expect(screen.queryByRole("application")).toBeNull());
    // Still on that agent, with its own working surface open.
    expect(screen.getByText("last output")).toBeTruthy();
    expect(screen.getByPlaceholderText(/Message this agent/)).toBeTruthy();
  });

  it("attaches to the clicked agent's own island, not the first island in the sea", async () => {
    renderSea([ORCHARD, OTHER], "w9:p1");
    await screen.findByText("w9:p1 · /p/pocketAlarm");
    await useMirror();
    expect(screen.getByRole("dialog", { name: "Island: pocketAlarm" })).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("pane_read", {
      paneId: "w9:p1",
      expectedRoot: "/p/pocketAlarm",
    });
  });

  // `focus_pane` is still permitted and still offered — as something the
  // user asks for by name. This is the same shared button the town has.
  it("still offers the explicit way out to the real terminal, and calls it only when clicked", async () => {
    renderSea();
    await useMirror();
    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    const raise = await screen.findByRole("button", { name: RAISE_EXTERNAL_TERMINAL_LABEL });
    expect(raise.getAttribute("title")).toMatch(/leaves the app/);
    expect(invokeMock.mock.calls.some((call) => call[0] === "focus_pane")).toBe(false);
    fireEvent.click(raise);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("focus_pane", { paneId: "w2:p1" }));
  });

  // The switcher's own reach, from the sea, across repositories — the same
  // `switchTargets` a town uses, and the same `attach` the click above
  // uses, so a switch lands in exactly the state clicking that villager
  // would have.
  it("reaches an agent in another repository from the open terminal", async () => {
    renderSea();
    await useMirror();
    fireEvent.click(screen.getByRole("button", { name: /pocketAlarm/ }));
    await screen.findByText("w9:p1 · /p/pocketAlarm");
    await useMirror();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pane_read", {
        paneId: "w9:p1",
        expectedRoot: "/p/pocketAlarm",
      }),
    );
  });

  it("never opens a terminal without a click — nothing here opens one unasked", async () => {
    render(
      <Archipelago archipelago={ARCHIPELAGO} islands={[ORCHARD, OTHER]} onOpenIsland={vi.fn()} />,
    );
    // Give every effect and promise a chance to settle before concluding.
    await waitFor(() => expect(screen.getByTitle("Reset view (r)")).toBeTruthy());
    expect(screen.queryByRole("application")).toBeNull();
    expect(invokeMock.mock.calls.some((call) => call[0] === "pane_read")).toBe(false);
  });

  it("closes the terminal, and says why, when herdr stops reporting that pane", async () => {
    const { rerender } = renderSea();
    await useMirror();
    const gone: Island = { ...ORCHARD, agents: [] };
    rerender(
      <Archipelago
        archipelago={ARCHIPELAGO}
        islands={[gone, OTHER]}
        onOpenIsland={vi.fn()}
        autoVillagerClickPaneId="w2:p1"
      />,
    );
    await waitFor(() => expect(screen.queryByRole("application")).toBeNull());
    expect(screen.getByText(paneGoneNote("w2:p1"))).toBeTruthy();
  });
});

// ESCAPE, by depth — the same ladder a town resolves, asserted at sea for
// the first time. One press does one thing, and never two.
describe("Escape in the sea, with a terminal open", () => {
  it("goes to the agent, and closes nothing, while the pane surface is focused", async () => {
    renderSea();
    await useMirror();
    const surface = await screen.findByRole("application");
    surface.focus();
    fireEvent.keyDown(surface, { key: "Escape" });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", {
        paneId: "w2:p1",
        keys: ["escape"],
        expectedRoot: "/p/orchard",
      }),
    );
    expect(screen.getByRole("application")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Island: orchard" })).toBeTruthy();
  });

  it("closes the terminal — and only the terminal — when pressed outside the pane surface", async () => {
    renderSea();
    await useMirror();
    await screen.findByRole("application");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("application")).toBeNull());
    // The island panel is still there: no press ever does two steps.
    expect(screen.getByRole("dialog", { name: "Island: orchard" })).toBeTruthy();
    // And nothing was sent to the agent.
    expect(invokeMock.mock.calls.some((call) => call[0] === "pane_send_keys")).toBe(false);
  });

  it("then closes the island panel on the next press", async () => {
    renderSea();
    await useMirror();
    await screen.findByRole("application");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("application")).toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Island: orchard" })).toBeNull());
  });
});
