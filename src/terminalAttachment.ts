import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "./world";

/**
 * WHICH PANE THIS SCREEN'S KEYBOARD IS POINTED AT — the one piece of state
 * spec §5.6 makes the embedded terminal's existence conditional on ("the
 * user can always see where their keys are going"), as one shared hook
 * instead of one per screen.
 *
 * WHY THIS MODULE EXISTS. The town got this right first (`TownScreen`'s own
 * `attachment` state), and the sea reached the same answer by a different
 * route: a one-shot request relayed from `Archipelago` through `IslandPanel`
 * and `AgentActions`, which then mounted its own `Terminal`. Two
 * implementations of one concept, with no shared code and therefore nothing
 * stopping them drifting — which they had already done in one visible way
 * (a pane that herdr stopped reporting said so in a town and silently
 * blanked at sea) and one invisible one (the sea got a fresh mount as a
 * side effect of a row unmounting, rather than because anything said it
 * must).
 *
 * The three things this owns, which are the three that could be wrong:
 *
 *  - **A `seq` per attachment**, so re-attaching to the SAME pane after
 *    closing it actually re-opens (the convention `flyToRequest` and
 *    `openTerminalRequest` already use), and so the value can double as the
 *    `Terminal`'s React key: every switch is then a FRESH mount by
 *    construction — no stale screen text from the previous agent, and no
 *    keyboard focus carried over, so the new terminal opens in its
 *    "○ click to type" state and not one keystroke can reach the wrong
 *    session.
 *  - **`root` carried with the pane id**, never inferred at the far end. It
 *    is what every pane call is checked against (`expected_root`, so a pane
 *    id herdr has recycled cannot misdeliver a keystroke), and a town's
 *    switcher can legitimately point this at an agent in a DIFFERENT
 *    repository from the one on screen behind it.
 *  - **Live re-resolution against the world**, so the terminal's header, tab
 *    strip and attention marks describe the agent as it IS rather than as it
 *    was at click time — and so an agent that exits while its terminal is
 *    open takes the terminal with it AND says so, rather than leaving a dark
 *    rectangle mirroring a pane that no longer exists.
 */
export type TerminalAttachment = { paneId: string; root: string; seq: number };

/** Anything with a canonical root and the agents herdr reports for it — an
 * `Island` satisfies this, and so does the one-island list the sea's own
 * panel builds. Deliberately structural rather than `Island`: the sea's
 * panel holds a `SeaIsland`, whose agents live beside a different view
 * object, and neither caller should have to fake the other's type. */
export type AttachmentHost = { root: string; agents: Agent[] };

/**
 * The attached agent as the world reports it right now, or `null` when
 * there is no attachment or herdr no longer reports that pane.
 *
 * Matches on BOTH root and pane id, in that order. The root check is not
 * redundant: herdr recycles `w<N>:p1`-style pane ids once a workspace
 * closes, so an id alone can name an unrelated agent in an unrelated
 * repository, and resolving one by id across a whole world would quietly
 * re-point a terminal's header at it.
 */
export function attachedAgent(
  attachment: TerminalAttachment | null,
  hosts: AttachmentHost[],
): Agent | null {
  if (attachment === null) return null;
  const host = hosts.find((candidate) => candidate.root === attachment.root);
  return host?.agents.find((agent) => agent.pane_id === attachment.paneId) ?? null;
}

/** What to say when herdr stops reporting the pane a terminal was attached
 * to. Names the pane, because that is the only handle the user has on it,
 * and says what is actually known — that herdr does not report it any more
 * — rather than guessing why. */
export function paneGoneNote(paneId: string): string {
  return `${paneId} is no longer running — herdr does not report that pane any more`;
}

/**
 * `hosts` is the live world this attachment is resolved against (the whole
 * `world.islands` for a town, the single selected island for the sea), and
 * `onPaneGone` is how the hosting screen says so in its own voice — each
 * screen renders that sentence in its own place, but the sentence itself is
 * `paneGoneNote`'s, once.
 */
export function useTerminalAttachment(
  hosts: AttachmentHost[],
  onPaneGone: (message: string) => void,
): {
  attachment: TerminalAttachment | null;
  /** The attached agent, re-resolved from `hosts` on every render. */
  attached: Agent | null;
  attach: (paneId: string, root: string) => void;
  detach: () => void;
} {
  const [attachment, setAttachment] = useState<TerminalAttachment | null>(null);
  const seq = useRef(0);

  const attach = useCallback((paneId: string, root: string) => {
    setAttachment({ paneId, root, seq: ++seq.current });
  }, []);

  const detach = useCallback(() => setAttachment(null), []);

  const attached = useMemo(() => attachedAgent(attachment, hosts), [attachment, hosts]);

  // A ref so a screen that passes a fresh closure every render (the common
  // case — it usually closes over that screen's own note state) cannot make
  // this effect re-run and re-report.
  const onPaneGoneRef = useRef(onPaneGone);
  onPaneGoneRef.current = onPaneGone;

  useEffect(() => {
    if (attachment === null || attached !== null) return;
    setAttachment(null);
    onPaneGoneRef.current(paneGoneNote(attachment.paneId));
  }, [attachment, attached]);

  return { attachment, attached, attach, detach };
}
