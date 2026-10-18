// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRecordingToggle, RecordingProvider, useRecording } from "./recording";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function Probe() {
  return <span data-testid="state">{useRecording() ? "on" : "off"}</span>;
}

const press = (target: Window | Element, init: KeyboardEventInit = { key: "R", shiftKey: true }) => fireEvent.keyDown(target, init);

describe("recording mode", () => {
  it("toggles with Shift+R and marks the document so the stage can take over", () => {
    render(<RecordingProvider><Probe /></RecordingProvider>);
    press(window);
    expect(screen.getByTestId("state").textContent).toBe("on");
    expect(document.documentElement.dataset.recording).toBe("1");
    press(window);
    expect(screen.getByTestId("state").textContent).toBe("off");
    expect(document.documentElement.dataset.recording).toBeUndefined();
  });

  it("shows the REC badge briefly, then gets out of the shot", () => {
    vi.useFakeTimers();
    render(<RecordingProvider><Probe /></RecordingProvider>);
    press(window);
    expect(screen.getByRole("status").textContent).toContain("REC");
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("never steals a capital R typed into a terminal or a field", () => {
    const terminal = document.createElement("div");
    terminal.setAttribute("role", "application");
    const inner = document.createElement("span");
    terminal.appendChild(inner);
    const input = document.createElement("input");
    const base = { key: "R", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false, repeat: false };
    expect(isRecordingToggle({ ...base, target: inner })).toBe(false);
    expect(isRecordingToggle({ ...base, target: input })).toBe(false);
    expect(isRecordingToggle({ ...base, target: document.body })).toBe(true);
    expect(isRecordingToggle({ ...base, key: "r", shiftKey: false, target: document.body })).toBe(false);
    expect(isRecordingToggle({ ...base, metaKey: true, target: document.body })).toBe(false);
  });
});
