// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SeaSearchBar } from "./SeaSearchBar";
import { isInteractiveTarget } from "../useHotkey";

afterEach(cleanup);

describe("SeaSearchBar", () => {
  it("calls onQueryChange on every keystroke, but never onSubmit until Enter", () => {
    const onQueryChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <SeaSearchBar
        query=""
        onQueryChange={onQueryChange}
        stateFilter="all"
        onStateFilterChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const box = screen.getByLabelText(/search islands by name/i);
    fireEvent.change(box, { target: { value: "widget" } });
    expect(onQueryChange).toHaveBeenCalledWith("widget");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit when Enter is pressed in the search box", () => {
    const onSubmit = vi.fn();
    render(
      <SeaSearchBar
        query="widget"
        onQueryChange={vi.fn()}
        stateFilter="all"
        onStateFilterChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText(/search islands by name/i), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not call onSubmit for any other key", () => {
    const onSubmit = vi.fn();
    render(
      <SeaSearchBar
        query="widget"
        onQueryChange={vi.fn()}
        stateFilter="all"
        onStateFilterChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText(/search islands by name/i), { key: "a" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onStateFilterChange when a different state is selected", () => {
    const onStateFilterChange = vi.fn();
    render(
      <SeaSearchBar
        query=""
        onQueryChange={vi.fn()}
        stateFilter="all"
        onStateFilterChange={onStateFilterChange}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/filter islands by state/i), { target: { value: "stopped" } });
    expect(onStateFilterChange).toHaveBeenCalledWith("stopped");
  });

  it("shows a match count only once a filter is active", () => {
    const { rerender } = render(
      <SeaSearchBar
        query=""
        onQueryChange={vi.fn()}
        stateFilter="all"
        onStateFilterChange={vi.fn()}
        onSubmit={vi.fn()}
        matchCount={152}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();

    rerender(
      <SeaSearchBar
        query="widget"
        onQueryChange={vi.fn()}
        stateFilter="all"
        onStateFilterChange={vi.fn()}
        onSubmit={vi.fn()}
        matchCount={3}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/3 islands match/);
  });

  it("honestly says when nothing matches, rather than an empty count", () => {
    render(
      <SeaSearchBar
        query="nonexistent-repo-xyz"
        onQueryChange={vi.fn()}
        stateFilter="all"
        onStateFilterChange={vi.fn()}
        onSubmit={vi.fn()}
        matchCount={0}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/no islands match/i);
  });

  // The coordinator's own instruction: verify — don't assume — that
  // useHotkey's interactive-target check actually covers these two real
  // elements, the same direct-assertion pattern `AgentActions.test.tsx`
  // already uses for its prompt textarea.
  it("is built from real INPUT/SELECT elements, so the global Space/'r' hotkeys already bail on them", () => {
    render(
      <SeaSearchBar
        query=""
        onQueryChange={vi.fn()}
        stateFilter="all"
        onStateFilterChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(/search islands by name/i);
    const select = screen.getByLabelText(/filter islands by state/i);
    expect(input.tagName).toBe("INPUT");
    expect(select.tagName).toBe("SELECT");
    expect(isInteractiveTarget(input)).toBe(true);
    expect(isInteractiveTarget(select)).toBe(true);
  });
  it("under_attack_option_present_and_filters", () => {
    const onStateFilterChange = vi.fn();
    const { rerender } = render(
      <SeaSearchBar
        query=""
        onQueryChange={vi.fn()}
        stateFilter="all"
        onStateFilterChange={onStateFilterChange}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: "Under attack" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/filter islands by state/i), { target: { value: "under_attack" } });
    expect(onStateFilterChange).toHaveBeenCalledWith("under_attack");
    rerender(
      <SeaSearchBar
        query=""
        onQueryChange={vi.fn()}
        stateFilter="under_attack"
        onStateFilterChange={vi.fn()}
        onSubmit={vi.fn()}
        matchCount={2}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("2 islands match (under attack)");
  });
});

describe("SeaSearchBar's scout action", () => {
  const base = {
    query: "",
    onQueryChange: () => {},
    stateFilter: "all" as const,
    onStateFilterChange: () => {},
    onSubmit: () => {},
  };
  const scout = (over: Partial<NonNullable<Parameters<typeof SeaSearchBar>[0]["scout"]>> = {}) => ({
    scanners: { osv: true, npm: true },
    islandCount: 9,
    scouting: null,
    error: null,
    onScoutAll: vi.fn(),
    disabled: false,
    ...over,
  });

  it("scout_sheet_names_missing_scanner_with_install_hint", () => {
    render(<SeaSearchBar {...base} scout={scout({ scanners: { osv: false, npm: true } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Scout for threats" }));
    const sheet = screen.getByRole("dialog", { name: "Scout for threats" });
    expect(sheet.textContent).toContain("osv-scanner — not installed (brew install osv-scanner)");
    expect(sheet.textContent).toContain("npm ✓ found");
    expect(sheet.textContent).toContain(
      "Checks 9 islands' dependencies against public advisory databases. This uses the network.",
    );
  });

  it("scout_confirm_calls_scoutAll_once", () => {
    const onScoutAll = vi.fn();
    render(<SeaSearchBar {...base} scout={scout({ onScoutAll })} />);
    fireEvent.click(screen.getByRole("button", { name: "Scout for threats" }));
    const confirm = screen.getByRole("button", { name: "Scout" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onScoutAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancel closes the sheet without scouting", () => {
    const onScoutAll = vi.fn();
    render(<SeaSearchBar {...base} scout={scout({ onScoutAll })} />);
    fireEvent.click(screen.getByRole("button", { name: "Scout for threats" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onScoutAll).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows progress, with no '/N' until the total is known", () => {
    const { rerender } = render(<SeaSearchBar {...base} scout={scout({ scouting: { done: 0, total: 0 } })} />);
    expect(screen.getByText("Scouting…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Scout for threats" })).toBeNull();
    rerender(<SeaSearchBar {...base} scout={scout({ scouting: { done: 3, total: 9 } })} />);
    expect(screen.getByText("Scouting 3/9…")).toBeTruthy();
  });

  it("surfaces a scout error rather than swallowing it", () => {
    render(<SeaSearchBar {...base} scout={scout({ error: "already scouting" })} />);
    expect(screen.getByRole("alert").textContent).toContain("already scouting");
  });

  it("is disabled in the browser preview", () => {
    const onScoutAll = vi.fn();
    render(<SeaSearchBar {...base} scout={scout({ onScoutAll, disabled: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Scout for threats" }));
    const confirm = screen.getByRole("button", { name: "Scout" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onScoutAll).not.toHaveBeenCalled();
  });
});
