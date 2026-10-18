// Pure "zoom the pane's grid to fit the panel" math for the Phase 0.7
// interactive terminal — framework-free and unit-testable without a DOM,
// same convention as `ansi.ts`/`terminalKeys.ts`/`jump.ts`.
//
// WHY THIS EXISTS (terminal-polish round, the author's report that the
// terminal did not look full-sized). Their live pane really was small — `viewport_rows: 23`, and about 55 columns wide,
// verified by reading the pane itself — while the terminal panel is
// ~1200×820. We are faithfully mirroring a genuinely small grid into a much
// larger box, so the emptiness he saw is real, and the fix is emphatically
// NOT to stretch the panel or to reflow the text: `pane.resize` exists in
// herdr's API and is deliberately NOT in this app's permitted write surface
// (resizing his real pane so our window looks better would rearrange the
// session he is actually working in — see README's "what the app is
// permitted to do").
//
// What is left is the honest option: draw the SAME grid — same rows, same
// columns, same content — larger. That is a rendering choice about our own
// window, invisible to herdr and to his real terminal emulator, and it
// keeps the panel a true mirror (spec §5.6's condition for this capability
// existing at all) rather than a stamp in a frame.
//
// The scale is UNIFORM on both axes on purpose: a monospace character cell
// has an aspect ratio, and scaling width and height independently would
// stretch every glyph and every box-drawing character the agent prints —
// a picture of a terminal that no terminal could produce. So one dimension
// fills and the other keeps whatever slack the pane's own shape implies;
// that residual space is the pane's true shape, not a layout bug.

/** The most this will ever magnify a pane. A one-line pane in a
 * near-fullscreen panel would otherwise scale to absurd, poster-sized text
 * that says nothing more than small text would; past roughly 3× the result
 * stops reading as "a terminal" at all. Nothing is hidden by the cap — the
 * grid still fits entirely, with room to spare. */
export const MAX_TERMINAL_SCALE = 3;

export type Size = { width: number; height: number };

/**
 * The factor to draw `natural` (the grid's real, unscaled layout size) at
 * so it fills as much of `available` as it can without ever exceeding it.
 *
 * Returns exactly `1` — draw it at its true size, change nothing — whenever
 * either box is unmeasurable (zero, negative, `NaN`, `Infinity`). That is
 * the state in jsdom (no layout engine), on the very first paint before a
 * layout effect has run, and for a pane that has not reported any text yet.
 * Guessing a scale from an unmeasured box would be the one way this could
 * clip real output, so it doesn't guess.
 *
 * Never exceeds either ratio, so the scaled grid is always <= the available
 * box in BOTH dimensions: text cannot overflow or be clipped, including for
 * the degenerate cases — a very wide pane (limited by width, drawn smaller
 * than 1× if it must be), a very tall one (limited by height), and a pane
 * whose size changes between polls or whose panel the user resizes (both
 * just produce a new `natural`/`available` pair and a new answer).
 */
export function fitScale(natural: Size, available: Size, max: number = MAX_TERMINAL_SCALE): number {
  if (!positive(natural.width) || !positive(natural.height)) return 1;
  if (!positive(available.width) || !positive(available.height)) return 1;
  const scale = Math.min(available.width / natural.width, available.height / natural.height);
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  // Snapped DOWN to two decimals — down, never to-nearest, because
  // rounding up is exactly how a "fits by construction" scale stops
  // fitting (0.225 -> 0.23 puts a 4000px-wide grid 20px past a 900px box).
  // The snapping itself is what keeps sub-pixel jitter in a measured box (a
  // scrollbar appearing, a fractional device-pixel ratio) from driving an
  // endless measure -> scale -> re-measure loop, and what makes the same
  // pane in the same panel always render at exactly the same size.
  const capped = Math.min(scale, max);
  const snapped = Math.floor(capped * 100) / 100;
  // A grid so large that even 0.01 rounds it away keeps its exact ratio
  // rather than collapsing to zero.
  return snapped > 0 ? snapped : capped;
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
