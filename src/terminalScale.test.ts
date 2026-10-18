import { describe, expect, it } from "vitest";
import { fitScale, MAX_TERMINAL_SCALE } from "./terminalScale";

describe("fitScale", () => {
  it("magnifies a small grid until it fills the shorter axis of the panel", () => {
    // The author's real pane: ~55 columns x 23 rows at 13px/1.6 monospace is
    // roughly 430x478 CSS px, in the panel's ~1170x700 content box. Height
    // is the binding constraint, so that is the ratio that wins.
    const scale = fitScale({ width: 430, height: 478 }, { width: 1170, height: 700 });
    expect(scale).toBeCloseTo(700 / 478, 1);
    expect(430 * scale).toBeLessThanOrEqual(1170);
    expect(478 * scale).toBeLessThanOrEqual(700);
  });

  it("never exceeds either axis, so text can never overflow or clip", () => {
    for (const natural of [
      { width: 4000, height: 40 }, // a very wide pane
      { width: 40, height: 4000 }, // a very tall one
      { width: 1200, height: 800 }, // one that already fills the box
      { width: 1, height: 1 }, // a degenerate single cell
    ]) {
      const available = { width: 900, height: 600 };
      const scale = fitScale(natural, available);
      expect(natural.width * scale).toBeLessThanOrEqual(available.width + 0.01);
      expect(natural.height * scale).toBeLessThanOrEqual(available.height + 0.01);
    }
  });

  it("shrinks below 1 rather than clipping a pane wider than the panel", () => {
    expect(fitScale({ width: 2000, height: 100 }, { width: 1000, height: 600 })).toBeCloseTo(0.5, 2);
  });

  it("caps magnification so a one-line pane does not become a poster", () => {
    expect(fitScale({ width: 10, height: 10 }, { width: 1000, height: 1000 })).toBe(MAX_TERMINAL_SCALE);
  });

  it("returns 1 for an unmeasurable box rather than guessing", () => {
    // jsdom, the first paint before layout, and a pane with no text yet all
    // land here. Guessing from an unmeasured box is the one way this could
    // clip real output.
    expect(fitScale({ width: 0, height: 0 }, { width: 900, height: 600 })).toBe(1);
    expect(fitScale({ width: 400, height: 400 }, { width: 0, height: 600 })).toBe(1);
    expect(fitScale({ width: Number.NaN, height: 400 }, { width: 900, height: 600 })).toBe(1);
    expect(fitScale({ width: 400, height: 400 }, { width: Number.POSITIVE_INFINITY, height: 600 })).toBe(1);
    expect(fitScale({ width: -400, height: 400 }, { width: 900, height: 600 })).toBe(1);
  });

  it("is the same uniform factor on both axes, so no glyph is ever stretched", () => {
    const natural = { width: 300, height: 500 };
    const scale = fitScale(natural, { width: 1200, height: 700 });
    // Height binds (700/500 = 1.4 < 1200/300 = 4), and the width is drawn
    // at that same 1.4 rather than being stretched to fill 1200.
    expect(scale).toBe(1.4);
    expect(natural.width * scale).toBeCloseTo(420, 5);
  });

  it("is stable: the same pane in the same panel always lands on the same number", () => {
    // Rounded to two decimals so sub-pixel jitter cannot drive a
    // measure -> scale -> re-measure loop.
    expect(fitScale({ width: 431, height: 478 }, { width: 1170, height: 700 })).toBe(
      fitScale({ width: 431, height: 478 }, { width: 1170, height: 700.2 }),
    );
  });
});
