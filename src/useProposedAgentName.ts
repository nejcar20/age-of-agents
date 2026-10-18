import { useEffect, useState } from "react";
import { proposedAgentName } from "./agents";

/**
 * The name a confirm sheet will print for the agent it is about to start —
 * `null` while it is unknown, for either reason (still in flight, or the
 * lookup failed).
 *
 * ONE STATE FOR BOTH UNKNOWNS, on purpose. The sheets that use this print
 * the exact herdr calls that will run, and the only two honest renderings
 * of "I do not know the name yet" are *say nothing about the name* or
 * *refuse to show the sheet*. A guessed name is not on the list — it is
 * precisely the class of untruth this whole fix is about, and the kind
 * picker next door already works this way (`agent_kinds()` unresolved ->
 * no picker rendered, rather than a picker listing a guess).
 */
export type ProposedAgentName = string | null;

/**
 * Asks the backend what a new agent in `root` will be called.
 *
 * `root` of `null` means "no sheet is open" and makes this fetch nothing at
 * all: opening a sheet is what makes the question worth asking, and this app
 * does not talk to herdr speculatively.
 *
 * Refetches whenever `root` changes, and drops a response whose request has
 * been superseded (the `cancelled` flag, same discipline as
 * `useAgentKinds`) — a slow answer for the previous island must never land
 * as the name for the one now on screen. Same reason `read_agent`'s panel
 * guards its own async: a stale answer rendered as current is a lie the
 * user has no way to detect.
 */
export function useProposedAgentName(root: string | null): ProposedAgentName {
  const [name, setName] = useState<ProposedAgentName>(null);

  useEffect(() => {
    if (root === null) {
      setName(null);
      return;
    }
    let cancelled = false;
    // Clear first: while the new lookup is in flight, the previous island's
    // name must not stay on screen labelled as this one's.
    setName(null);
    proposedAgentName(root)
      .then((resolved) => {
        // A backend that answered with something other than a string is not
        // an answer — treated exactly like a failure rather than rendered.
        if (!cancelled && typeof resolved === "string" && resolved.length > 0) {
          setName(resolved);
        }
      })
      .catch(() => {
        // Deliberately swallowed rather than surfaced as a sheet error: not
        // knowing the name yet is not a failure of the action the user is
        // about to take, and the sheet simply omits the `name=` it cannot
        // vouch for. If the lookup is genuinely broken, the confirm itself
        // fails loudly with the real reason (Rust runs the same lookup).
        if (!cancelled) setName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  return name;
}
