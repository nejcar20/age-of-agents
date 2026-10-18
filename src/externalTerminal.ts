import { focusPane } from "./agents";
import type { Agent } from "./world";

/**
 * Raising the user's OWN terminal window — `pane.focus`/`workspace.focus`'s
 * honest purpose — as ONE set of words used by every screen.
 *
 * WHY THIS MODULE EXISTS. This capability existed twice, in two components,
 * with two different success messages and (until the sea caught up) two
 * different meanings for the same gesture: `App.tsx` called `focus_pane`
 * from a villager CLICK at sea and reported "focused X", while
 * `TownScreen`/`VillagerPanel` called it from an explicitly-labelled BUTTON
 * and reported "focused X in your own terminal". That is the exact shape of
 * the defect this project has already paid real time for — a label (and
 * here, a whole gesture) living in two places, free to drift, and drifting.
 *
 * So: one label, one tooltip, one message on success, one on failure, one
 * function that makes the call. Both screens import these; neither spells
 * any of it out itself.
 *
 * The ↗ is part of the label, not decoration: it is what distinguishes
 * "raise my own terminal window, leaving the app" from `OPEN_TERMINAL_LABEL`'s
 * "⤢ open the embedded mirror, here". Those two live one button apart, and a
 * user who cannot tell them apart is one click from being ejected out of the
 * app mid-conversation.
 */

/** The pane-level raise (herdr `pane.focus` via `focus_pane`) — one specific
 * agent's own terminal window. Named identically on both screens. */
export const RAISE_EXTERNAL_TERMINAL_LABEL = "Focus external terminal ↗";

/** Says out loud that it leaves the app, because it does. */
export const RAISE_EXTERNAL_TERMINAL_TITLE =
  "Brings your own terminal window (herdr's pane.focus) to the front — this leaves the app";

/**
 * The ISLAND-level raise (herdr `workspace.focus` via `focus_workspace`) —
 * a different call, aimed at a repository's whole workspace rather than one
 * agent's pane, so it gets its own words rather than being folded into the
 * label above. It used to read just "Focus terminal", which collided
 * head-on with the embedded terminal the same panel now opens: two buttons,
 * one word, two completely different places your keyboard ends up.
 *
 * The town has no counterpart on purpose — a town is one repository, and
 * its header already offers that repository's agents directly.
 */
export const FOCUS_WORKSPACE_TERMINAL_LABEL = "Focus workspace terminal ↗";

export const FOCUS_WORKSPACE_TERMINAL_TITLE =
  "Brings your own terminal window for this repository's herdr workspace (herdr's workspace.focus) to the front — this leaves the app";

/** What to say once herdr has accepted the focus call. Names the agent the
 * way every other surface names it (its herdr title, falling back to the
 * pane id — never a guess, never a default). */
export function raisedExternalNote(agent: Agent): string {
  return `focused ${agent.title ?? agent.pane_id} in your own terminal`;
}

/** What to say when it did not work, quoting herdr's own reason rather than
 * paraphrasing it. */
export function raiseExternalFailedNote(error: unknown): string {
  return `focus failed: ${String(error)}`;
}

/**
 * Makes the call and resolves with the message to show — success or
 * failure, never a throw, because every caller wants to say what happened
 * rather than handle an exception. Fire-and-forget by design: nothing in
 * either screen waits on this (principle 2 — nothing on the attention path
 * is gated on a round trip).
 */
export function raiseExternalTerminal(agent: Agent): Promise<string> {
  return focusPane(agent.pane_id).then(
    () => raisedExternalNote(agent),
    (error) => raiseExternalFailedNote(error),
  );
}
