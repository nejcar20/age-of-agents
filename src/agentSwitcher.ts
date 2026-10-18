import { ATTENTION_RANK, type Agent, type Island } from "./world";

/**
 * One agent you can switch the terminal to, with the repository it is
 * running in — the two facts you need to decide whether to go there, and
 * the two the terminal's own attachment line already shows for whichever
 * pane you are currently attached to.
 */
export type SwitchTarget = {
  agent: Agent;
  /** The island's canonical `root` — the same value `Terminal` requires as
   * `expected_root` on every pane call, carried along here so switching
   * needs no second lookup (and cannot land on a different island that
   * happens to share a basename: the author has three such pairs). */
  root: string;
  /** The island's display name, so a tab names a repository, not a path. */
  islandName: string;
};

/** `next` = the entry after the current one, `previous` = the one before. */
export type SwitchDirection = "next" | "previous";

/**
 * Every agent currently running, anywhere, in the order the switcher shows
 * them (lag-and-switcher round: the author's main ask was easy switching
 * between terminals).
 *
 * EVERY agent, not only the stopped ones. This is the distinction the round
 * turned on: "which town needs me" and "switch between my terminals" are
 * different features, and the second is the one he asked for. He runs
 * several at once and wants to move between them the way he moves between
 * terminal tabs — so a calm agent is just as reachable as a blocked one,
 * and a pane herdr reports no agent kind for is still listed rather than
 * quietly dropped (principle 4 cuts both ways: never draw what is not
 * there, never omit what is).
 *
 * ORDERED BY ATTENTION FIRST, via the one `ATTENTION_RANK` `sortIslands`
 * already uses — never a second opinion about which of two agents matters
 * more. Whoever has stopped and is waiting is therefore always at the
 * front, which is the "who needs me" signal surviving intact inside a
 * switcher that is no longer only about that. Ties break by island name
 * then pane id, so the order is deterministic between renders rather than
 * depending on the sort's stability or on herdr's own enumeration order.
 *
 * The cost of attention-first is honest and worth naming: an agent that
 * stops will move leftward in the strip. The alternative — a fixed order
 * with the one that needs you buried in the middle — loses the product's
 * entire point to spare a small amount of positional muscle memory, and
 * every entry is read by repository name rather than by position anyway.
 */
export function switchTargets(islands: Island[]): SwitchTarget[] {
  const targets: SwitchTarget[] = [];
  for (const island of islands) {
    for (const agent of island.agents) {
      targets.push({ agent, root: island.root, islandName: island.name });
    }
  }
  return targets.sort(
    (a, b) =>
      ATTENTION_RANK[a.agent.attention] - ATTENTION_RANK[b.agent.attention] ||
      a.islandName.localeCompare(b.islandName) ||
      a.agent.pane_id.localeCompare(b.agent.pane_id),
  );
}

/**
 * Where the switch key should land: the entry after (or before) wherever
 * the terminal is attached now, wrapping at either end — exactly what
 * cycling terminal tabs does.
 *
 * The current pane does not have to be in the list at all; when it is not
 * (its agent just exited, say), `next` starts at the front and `previous`
 * at the back, which is the only non-arbitrary reading of "one step from
 * nowhere". Returns `null` only when there is genuinely nowhere else to go
 * — which the caller must SAY out loud rather than silently doing nothing:
 * a shortcut with no visible effect is indistinguishable from a broken one.
 */
export function nextSwitchTarget(
  targets: SwitchTarget[],
  currentPaneId: string,
  direction: SwitchDirection = "next",
): SwitchTarget | null {
  if (targets.length === 0) return null;
  const step = direction === "next" ? 1 : -1;
  const index = targets.findIndex((candidate) => candidate.agent.pane_id === currentPaneId);
  const from = index === -1 ? (direction === "next" ? -1 : 0) : index;
  for (let moved = 1; moved <= targets.length; moved++) {
    const at = (((from + step * moved) % targets.length) + targets.length) % targets.length;
    const candidate = targets[at];
    if (candidate !== undefined && candidate.agent.pane_id !== currentPaneId) return candidate;
  }
  return null;
}
