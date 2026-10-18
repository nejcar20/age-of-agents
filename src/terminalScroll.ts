// Wheel-gesture arithmetic and scrollback detection for the embedded
// terminal (spec §5.6, terminal-feel round — the author: the terminal could
// not be scrolled). Framework-free and unit-testable without a DOM, same
// convention as `terminalKeys.ts`/`terminalScale.ts`.
//
// There is no `pane.scroll` in herdr's API. The full method list (`herdr
// api schema --json`, protocol 19) has `pane.scroll_changed` as a
// subscribable EVENT and nothing that scrolls a pane, so the app cannot
// drive herdr's own viewport. What it can do is the two things below.

/** One text row, in CSS pixels, for turning a wheel delta into a number of
 * lines. The terminal renders at `13px/1.6`, so a row is ~20.8px; 21 is
 * close enough for a gesture whose own granularity is a notch. A wheel
 * notch on this platform reports ~40–120px, i.e. two to six lines, which
 * is the same ballpark every terminal emulator scrolls by. */
export const ROW_PX = 21;

/** The most line-steps one wheel EVENT may turn into. A trackpad fling
 * emits a long tail of events; without a cap a single flick could become
 * hundreds of keypresses into a live session. Five rows per event is
 * already faster than anyone reads, and the tail's later events still
 * arrive, so a real long scroll still scrolls far — it just cannot do it
 * in one unbounded burst. */
export const MAX_STEPS_PER_EVENT = 5;

/**
 * Turns accumulated wheel delta into whole line-steps, keeping the
 * remainder so a trackpad's stream of sub-line deltas adds up instead of
 * being rounded away to nothing.
 *
 * Positive `steps` means scrolling DOWN (towards newer output), matching
 * the sign of `WheelEvent.deltaY`.
 *
 * This is deliberately a pure function of what the user's fingers did:
 * `steps` is never larger than the distance they actually scrolled (bar
 * the cap above, which only ever makes it smaller). Nothing here invents
 * motion, repeats a gesture, or keeps scrolling after the user stopped —
 * §5.6's prohibition is on the app acting on its own, and a wheel tick is
 * the user acting.
 */
export function wheelSteps(accumulated: number): { steps: number; remainder: number } {
  const whole = Math.trunc(accumulated / ROW_PX);
  const remainder = accumulated - whole * ROW_PX;
  const steps = Math.max(-MAX_STEPS_PER_EVENT, Math.min(MAX_STEPS_PER_EVENT, whole));
  return { steps, remainder };
}

/**
 * Does this pane actually have scrollback to show?
 *
 * MEASURED, and the measurement is the whole point (terminal-feel round,
 * against a throwaway workspace this session created and closed plus
 * read-only reads of the author's live panes):
 *
 * - A shell pane that has scrolled: `recent` returned 141 lines where
 *   `visible` returned 23. Real scrollback, and the app can show it.
 * - A pane running a full-screen program — `less`, and every one of the
 *   author's `claude` panes — returned EXACTLY the visible screen from
 *   both sources, 23 lines each. The alternate screen has no scrollback
 *   by definition, so there is nothing to show and nothing herdr is
 *   withholding.
 * - `pane.get`'s `scroll.max_offset_from_bottom` looks like the field that
 *   answers this and is not: it read `0` on every pane probed, INCLUDING
 *   the shell pane with 141 lines of genuine scrollback. Comparing the two
 *   sources is the only way to tell, and it costs one extra read.
 *
 * Compared as line counts rather than by text equality on purpose: the
 * `recent` source re-wraps and may differ character-for-character from
 * `visible` even when it holds nothing extra, and "is there anything above
 * the top of the screen" is a question about rows.
 */
export function hasScrollback(visibleText: string, recentText: string): boolean {
  return countRows(recentText) > countRows(visibleText);
}

/** Rows in a snapshot, ignoring a single trailing newline (herdr's reads
 * end with one) and any wholly blank rows at the bottom, which the visible
 * screen is padded with and the scrollback is not. */
export function countRows(text: string): number {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  return end;
}
