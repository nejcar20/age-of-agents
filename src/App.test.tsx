// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SeaViewBoundary, TownViewBoundary } from "./App";

afterEach(cleanup);

/** Throws on every render, standing in for `<TownView>`'s `<Canvas>` failing
 * to get a WebGL context (no usable GPU, or a lost context). */
function Boom(): never {
  throw new Error("no WebGL context");
}

// IMPORTANT 3 (final whole-branch review): with no error boundary anywhere,
// a throw from `<Canvas>` used to unmount the WHOLE React tree — the
// archipelago and the window-level jump hotkey (this product's headline
// feature) along with it. These tests assert the two things that boundary
// exists to guarantee: (1) something OUTSIDE the boundary's own subtree
// keeps rendering after the crash, standing in for `App`'s hotkey/
// archipelago, which live as siblings of `TownViewBoundary`, never inside
// it; and (2) the failure is visible, with a working way back.
describe("TownViewBoundary", () => {
  it("shows a visible, legible error instead of a blank panel", () => {
    // React logs the caught error to the console on its own, in addition to
    // this component's own `componentDidCatch` log — both expected, neither
    // a test failure.
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <TownViewBoundary onReset={() => {}}>
        <Boom />
      </TownViewBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/no WebGL context/);
  });

  it("keeps a sibling outside the boundary mounted and interactive after the crash", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let hotkeyPresses = 0;
    render(
      <div>
        {/* Stands in for `App`'s own `useHotkey`-driven UI, a SIBLING of the
            boundary, exactly as it is in `App.tsx` — never a descendant. */}
        <button onClick={() => hotkeyPresses++}>jump hotkey surrogate</button>
        <TownViewBoundary onReset={() => {}}>
          <Boom />
        </TownViewBoundary>
      </div>,
    );
    fireEvent.click(screen.getByText("jump hotkey surrogate"));
    expect(hotkeyPresses).toBe(1);
  });

  it("offers a working return-to-the-archipelago affordance", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onReset = vi.fn();
    render(
      <TownViewBoundary onReset={onReset}>
        <Boom />
      </TownViewBoundary>,
    );
    fireEvent.click(screen.getByText(/back to islands/i));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("renders its children normally when nothing throws", () => {
    render(
      <TownViewBoundary onReset={() => {}}>
        <p>a perfectly fine town</p>
      </TownViewBoundary>,
    );
    expect(screen.getByText("a perfectly fine town")).toBeTruthy();
  });
});

// The archipelago's own boundary: same shape as `TownViewBoundary` above,
// but now guarding the PRIMARY screen (Item 1 — the sea replaces the plain
// list as the default view), so a WebGL failure here has no other view left
// to fall back to except "try again" (a remount), never "back to islands".
describe("SeaViewBoundary", () => {
  it("shows a visible, legible error instead of a blank sea", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <SeaViewBoundary onRetry={() => {}}>
        <Boom />
      </SeaViewBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/no WebGL context/);
  });

  it("keeps a sibling outside the boundary mounted and interactive after the crash", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let hotkeyPresses = 0;
    render(
      <div>
        <button onClick={() => hotkeyPresses++}>jump hotkey surrogate</button>
        <SeaViewBoundary onRetry={() => {}}>
          <Boom />
        </SeaViewBoundary>
      </div>,
    );
    fireEvent.click(screen.getByText("jump hotkey surrogate"));
    expect(hotkeyPresses).toBe(1);
  });

  it("calls onRetry and clears its own error when 'try again' is clicked", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onRetry = vi.fn();
    render(
      <SeaViewBoundary onRetry={onRetry}>
        <Boom />
      </SeaViewBoundary>,
    );
    fireEvent.click(screen.getByText(/try again/i));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders its children normally when nothing throws", () => {
    render(
      <SeaViewBoundary onRetry={() => {}}>
        <p>a perfectly fine sea</p>
      </SeaViewBoundary>,
    );
    expect(screen.getByText("a perfectly fine sea")).toBeTruthy();
  });
});
