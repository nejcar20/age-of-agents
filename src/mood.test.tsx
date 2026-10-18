// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isMoodToggle, MOOD_LOOK, MoodProvider, nextMood, useMood } from "./mood";
import { SKY_HORIZON_COLOR } from "./components/TownView";

afterEach(() => { cleanup(); localStorage.clear(); });

function Probe() {
  return <span data-testid="mood">{useMood().mood}</span>;
}

describe("mood", () => {
  it("cycles day → golden hour → night → day", () => {
    expect(nextMood("day")).toBe("golden");
    expect(nextMood("golden")).toBe("night");
    expect(nextMood("night")).toBe("day");
  });

  it("changes with Shift+M and remembers the choice", () => {
    const first = render(<MoodProvider><Probe /></MoodProvider>);
    fireEvent.keyDown(window, { key: "M", shiftKey: true });
    expect(screen.getByTestId("mood").textContent).toBe("golden");
    first.unmount();
    render(<MoodProvider><Probe /></MoodProvider>);
    expect(screen.getByTestId("mood").textContent).toBe("golden");
  });

  it("leaves a terminal's capital M alone", () => {
    const terminal = document.createElement("div");
    terminal.setAttribute("role", "application");
    const inside = document.createElement("span");
    terminal.appendChild(inside);
    const base = { key: "M", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false, repeat: false };
    expect(isMoodToggle({ ...base, target: inside })).toBe(false);
    expect(isMoodToggle({ ...base, target: document.body })).toBe(true);
  });

  it("day restates nothing, so it is exactly the scene's own look", () => {
    expect(MOOD_LOOK.day.sky).toBeNull();
    expect(MOOD_LOOK.day.water).toBeNull();
    expect(MOOD_LOOK.day.windows).toBeNull();
    // The defaults it falls back to are the scene constants themselves.
    expect(SKY_HORIZON_COLOR).toBe("#cfe3e6");
  });
});
