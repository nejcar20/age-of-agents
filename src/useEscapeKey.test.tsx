// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useEscapeKey } from "./useEscapeKey";

afterEach(cleanup);

function Panel({ onClose, enabled }: { onClose: () => void; enabled?: boolean }) {
  // A fresh closure every render, like all five real callers pass.
  useEscapeKey(() => onClose(), enabled === undefined ? {} : { enabled });
  return <div>panel</div>;
}

describe("useEscapeKey", () => {
  it("closes on Escape, and prevents the key's default", () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} />);
    const prevented = !fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it("ignores every other key", () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} />);
    for (const key of ["Enter", " ", "r", "Tab", "ArrowUp"]) {
      fireEvent.keyDown(window, { key });
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  // The guard `IslandPanel` and `NewProjectPanel` both need: while a real
  // call is in flight behind a confirm sheet, Escape must be a GENUINE
  // no-op — closing would unmount the sheet (and the component waiting for
  // the result), so the user would never learn their call failed.
  it("is a genuine no-op while disabled — nothing fires, and nothing is prevented", () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} enabled={false} />);
    const prevented = !fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it("reads the latest handler and the latest enabled, without resubscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Panel onClose={first} enabled={false} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(first).not.toHaveBeenCalled();
    rerender(<Panel onClose={second} enabled={true} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unmounted", () => {
    const onClose = vi.fn();
    const { unmount } = render(<Panel onClose={onClose} />);
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  // Two panels open at once is not a state this app has (selections are
  // mutually exclusive, and the terminal stops propagation before these
  // listeners run) — but if it ever happened, this hook must not silently
  // close both on one press. It cannot promise that on its own, so the
  // property is asserted where it IS decided: the terminal's capture-phase
  // listener, in `Archipelago.terminal.test.tsx` and `TownScreen.test.tsx`.
  it("does exactly what it says and nothing more: one listener, one handler", () => {
    const a = vi.fn();
    render(<Panel onClose={a} />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(a).toHaveBeenCalledTimes(2);
  });
});
