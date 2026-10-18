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
});
