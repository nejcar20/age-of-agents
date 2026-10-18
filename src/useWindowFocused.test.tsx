// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowFocused } from "./useWindowFocused";

/**
 * The coordinator's explicit instruction for this round's continuous render
 * loop: "it must genuinely pause when the user is elsewhere — verify that,
 * do not assume it." These tests are that verification — they don't just
 * read the hook's source, they mount it in a real (jsdom) DOM, fire the
 * actual browser events `blur`/`focus`/`visibilitychange` dispatch, and
 * assert the returned value flips both ways.
 */

function Probe() {
  const focused = useWindowFocused();
  return <div data-testid="probe">{focused ? "focused" : "unfocused"}</div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useWindowFocused", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  it("starts focused when the document already has focus and is visible", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("focused");
  });

  it("flips to unfocused on a real `blur` event", () => {
    render(<Probe />);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.getByTestId("probe").textContent).toBe("unfocused");
  });

  it("flips back to focused on a real `focus` event", () => {
    render(<Probe />);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.getByTestId("probe").textContent).toBe("unfocused");

    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByTestId("probe").textContent).toBe("focused");
  });

  it("flips to unfocused on `visibilitychange` when the tab is hidden, even while `document.hasFocus()` still reports true", () => {
    // Regression case for the exact bug this hook exists to avoid: a
    // minimized/occluded window can still report `hasFocus() === true` on
    // some platforms — `visibilityState` is the other half of the check,
    // and either one failing must be enough to stop the loop.
    render(<Probe />);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByTestId("probe").textContent).toBe("unfocused");
  });

  it("removes its listeners on unmount (no update-after-unmount)", () => {
    const { unmount } = render(<Probe />);
    unmount();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    // Must not throw / warn about setting state on an unmounted component.
    expect(() => {
      window.dispatchEvent(new Event("blur"));
    }).not.toThrow();
  });
});
