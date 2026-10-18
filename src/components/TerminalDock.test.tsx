// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SwitchTarget } from "../agentSwitcher";
import { TerminalDock } from "./TerminalDock";
import { useTerminalStage } from "../terminalStage";

vi.mock("./Terminal", () => ({ Terminal: ({agent,active,onClose,initialMode}: {agent:{pane_id:string}; active:boolean;onClose:()=>void;initialMode?:string}) => {
  const stage = useTerminalStage();
  return <div data-testid={`terminal-${agent.pane_id}`} data-active={String(active)} data-initial-mode={initialMode}><input aria-label={`Input ${agent.pane_id}`} /><button onClick={onClose}>Close {agent.pane_id}</button><button onClick={() => stage.switchTo(stage.targets[0])}>Switch {agent.pane_id}</button></div>;
} }));
const target = (pane: string): SwitchTarget => ({ root: `/app/${pane}`, islandName: pane, agent: { pane_id: pane, workspace_id: "w1", cwd: `/app/${pane}`, title: pane, kind: "codex", status: "idle", attention: "quiet", is_worktree: false } });
const targets = [target("one"),target("two"),target("three")];
afterEach(() => cleanup());

it("keeps the town mounted while opening a dock and gives only the focused split keyboard ownership", () => {
  const view = render(<TerminalDock primary={null} targets={targets} onSwitch={vi.fn()} onClose={vi.fn()}><div data-testid="town">Town</div></TerminalDock>);
  const town = screen.getByTestId("town");
  view.rerender(<TerminalDock primary={targets[0]} targets={targets} onSwitch={vi.fn()} onClose={vi.fn()}><div data-testid="town">Town</div></TerminalDock>);
  expect(screen.getByTestId("town")).toBe(town);
  expect(screen.getByTestId("terminal-one").getAttribute("data-initial-mode")).toBe("direct");
  fireEvent.click(screen.getByRole("button", { name: "Split terminal" }));
  expect(screen.getByTestId("terminal-two").getAttribute("data-active")).toBe("true");
  expect(screen.getByTestId("terminal-one").getAttribute("data-active")).toBe("false");
  fireEvent.focus(screen.getByRole("textbox", { name: "Input one" }));
  expect(screen.getByTestId("terminal-one").getAttribute("data-active")).toBe("true");
  expect(screen.getByTestId("terminal-two").getAttribute("data-active")).toBe("false");
  fireEvent.pointerDown(town);
  expect(screen.getByTestId("terminal-one").getAttribute("data-active")).toBe("false");
  expect(screen.getByTestId("terminal-two").getAttribute("data-active")).toBe("false");
});

it("switches and detaches the second terminal independently, and offers keyboard resizing", () => {
  const onSwitch = vi.fn(), onClose = vi.fn();
  render(<TerminalDock primary={targets[0]} targets={targets} onSwitch={onSwitch} onClose={onClose}><p>Town</p></TerminalDock>);
  fireEvent.click(screen.getByRole("button", { name: "Split terminal" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Second terminal" }), { target: { value: JSON.stringify([targets[2].root, "three"]) } });
  expect(screen.getByTestId("terminal-three")).toBeTruthy();
  expect(onSwitch).not.toHaveBeenCalled();
  const separator = screen.getByRole("separator", { name: "Resize terminal dock" });
  const previous = separator.getAttribute("aria-valuenow");
  fireEvent.keyDown(separator, { key: "ArrowUp" });
  expect(separator.getAttribute("aria-valuenow")).not.toBe(previous);
  fireEvent.click(within(screen.getByTestId("terminal-three")).getByRole("button", { name: "Close three" }));
  expect(screen.queryByTestId("terminal-three")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

it("drops a vanished secondary pane instead of keeping a writable stale terminal", () => {
  const view = render(<TerminalDock primary={targets[0]} targets={targets} onSwitch={vi.fn()} onClose={vi.fn()}><p>Town</p></TerminalDock>);
  fireEvent.click(screen.getByRole("button", { name: "Split terminal" }));
  view.rerender(<TerminalDock primary={targets[0]} targets={[targets[0]]} onSwitch={vi.fn()} onClose={vi.fn()}><p>Town</p></TerminalDock>);
  expect(screen.queryByTestId("terminal-two")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("no longer available");
});
