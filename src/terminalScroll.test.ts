import { describe, expect, it } from "vitest";
import { MAX_STEPS_PER_EVENT, ROW_PX, countRows, hasScrollback, wheelSteps } from "./terminalScroll";

describe("wheelSteps", () => {
  it("turns a wheel delta into whole rows, in the same sign as deltaY", () => {
    expect(wheelSteps(ROW_PX * 3).steps).toBe(3);
    expect(wheelSteps(-ROW_PX * 2).steps).toBe(-2);
  });

  it("keeps the remainder, so a trackpad's sub-row deltas add up instead of vanishing", () => {
    // Eight deltas of a quarter-row each are two rows of real movement.
    let accumulated = 0;
    let moved = 0;
    for (let i = 0; i < 8; i += 1) {
      accumulated += ROW_PX / 4;
      const { steps, remainder } = wheelSteps(accumulated);
      accumulated = remainder;
      moved += steps;
    }
    expect(moved).toBe(2);
  });

  it("reports nothing at all for a delta smaller than one row", () => {
    expect(wheelSteps(ROW_PX - 1).steps).toBe(0);
    expect(wheelSteps(ROW_PX - 1).remainder).toBe(ROW_PX - 1);
  });

  // The guarantee that matters for a surface wired to someone's live
  // session: a flick can never become an unbounded burst of keypresses.
  it("caps one event, however violent the flick", () => {
    expect(wheelSteps(ROW_PX * 400).steps).toBe(MAX_STEPS_PER_EVENT);
    expect(wheelSteps(-ROW_PX * 400).steps).toBe(-MAX_STEPS_PER_EVENT);
  });
});

describe("hasScrollback", () => {
  // The measured shapes, both of them. A shell pane that has scrolled
  // returns far more from `recent` than from `visible` (141 rows against
  // 23, live); a pane running a full-screen program returns exactly the
  // same screen from both, because the alternate screen has no scrollback.
  it("is true when the scrollback source holds rows the visible screen does not", () => {
    const visible = Array.from({ length: 23 }, (_, i) => `row ${i}`).join("\n");
    const recent = Array.from({ length: 141 }, (_, i) => `row ${i}`).join("\n");
    expect(hasScrollback(visible, recent)).toBe(true);
  });

  it("is false for a full-screen program, where both sources are the same screen", () => {
    const screen = Array.from({ length: 23 }, (_, i) => `row ${i}`).join("\n");
    expect(hasScrollback(screen, screen)).toBe(false);
  });

  // The visible screen is padded to the pane's height with blank rows and
  // the scrollback is not, so a naive line count would claim scrollback
  // exists for every idle pane in the world.
  it("does not mistake the visible screen's blank padding for missing history", () => {
    const visible = "one\ntwo\n" + "\n".repeat(20);
    const recent = "one\ntwo\n";
    expect(hasScrollback(visible, recent)).toBe(false);
  });
});

describe("countRows", () => {
  it("ignores the trailing newline every herdr read ends with", () => {
    expect(countRows("a\nb\n")).toBe(2);
    expect(countRows("a\nb")).toBe(2);
  });

  it("is zero for an empty screen", () => {
    expect(countRows("")).toBe(0);
    expect(countRows("\n\n\n")).toBe(0);
  });
});
