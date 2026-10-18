// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartHud } from "./ChartHud";
import { MoodProvider } from "../mood";
import { RecordingProvider } from "../recording";
import type { Agent, Attention, Island } from "../world";

afterEach(() => { cleanup(); localStorage.clear(); delete document.documentElement.dataset.recording; });

const agent = (pane: string, attention: Attention, title: string): Agent => ({
  pane_id: pane, workspace_id: pane.split(":")[0], status: attention === "working" ? "working" : "idle",
  attention, title, kind: "claude", is_worktree: false, cwd: "/p",
});
const island = (name: string, agents: Agent[]): Island => ({
  id: `/p/${name}`, name, root: `/p/${name}`, attention: "quiet", agents, last_changed_at: null,
});

function hud(islands: Island[], overrides: Partial<Parameters<typeof ChartHud>[0]> = {}) {
  const props = {
    islands, islandCount: 8, connected: true, herdrVersion: "0.9.0",
    onJump: vi.fn(), onOpenAgent: vi.fn(), search: <input aria-label="Search islands by name" />,
    searchOpen: false, onToggleSearch: vi.fn(), listOpen: false, onToggleList: vi.fn(), onNewProject: vi.fn(),
    ...overrides,
  };
  render(<MoodProvider><RecordingProvider><ChartHud {...props} /></RecordingProvider></MoodProvider>);
  return props;
}

describe("ChartHud", () => {
  const world = [
    island("fieldnotes", [agent("w3:p1", "stopped", "✳ Waiting for API credentials")]),
    island("harbor-api", [agent("w2:p1", "working", "◑ Add streaming responses")]),
    island("weekend-builds", [agent("w5:p1", "quiet", "Explore the prototype")]),
  ];

  it("lists who is waiting, without Herdr's status glyphs, and opens their island", () => {
    const props = hud(world);
    const scroll = screen.getByRole("region", { name: "Agents that need you" });
    expect(scroll.textContent).toContain("Needs you");
    fireEvent.click(screen.getByRole("button", { name: /Waiting for API credentials/ }));
    expect(props.onOpenAgent).toHaveBeenCalledWith(world[0]);
    expect(scroll.textContent).toContain("1 working");
    expect(scroll.textContent).toContain("1 idle");
  });

  it("jumps to whoever waited longest from the seal, and goes quiet when nobody waits", () => {
    const props = hud(world);
    fireEvent.click(screen.getByRole("button", { name: /1 waiting/ }));
    expect(props.onJump).toHaveBeenCalled();
    cleanup();
    hud([world[1]]);
    expect(screen.getByRole("region", { name: "Agents that need you" }).textContent).toContain("All quiet");
    expect((screen.getByRole("button", { name: "Nobody is waiting" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("titles the chart with the real island and agent counts", () => {
    hud(world);
    expect(screen.getByRole("heading", { name: "Age of Agents" })).toBeTruthy();
    expect(screen.getByText(/8 islands · 3 agents/)).toBeTruthy();
  });

  it("cycles the time of day and switches cinematic mode from its round buttons", () => {
    hud(world);
    fireEvent.click(screen.getByRole("button", { name: /Time of day: Day/ }));
    expect(screen.getByRole("button", { name: /Time of day: Golden hour/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Cinematic mode/ }));
    expect(document.documentElement.dataset.recording).toBe("1");
  });

  it("founds a new island from the big button", () => {
    const props = hud(world);
    fireEvent.click(screen.getByRole("button", { name: "Found a new island" }));
    expect(props.onNewProject).toHaveBeenCalled();
  });
});
