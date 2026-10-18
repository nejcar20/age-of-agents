import type { ReactNode } from "react";
import { useEscapeKey } from "../useEscapeKey";
import type { Agent } from "../world";

/**
 * The persistent panel shown once a VILLAGER (an agent standing in the town)
 * is selected — mirrors `BuildingPanel`/`DistrictPanel`'s own shape (a click
 * persists the selection until Escape, the close button, or a click that
 * misses every interactive thing) so a villager slots into the town's
 * existing selection model rather than inventing a second one.
 *
 * Deliberately a separate, small component rather than a third case bolted
 * onto `BuildingPanel`: an agent has no `path`/`kind`/`lines` — its own
 * facts are `status`/`attention`/`cwd` — so the two panels' content
 * genuinely differs, the same reasoning `DistrictPanel`'s own doc comment
 * gives for not sharing one with `BuildingPanel`.
 *
 * TOWN-TERMINAL ROUND. This panel used to offer exactly one action, "Focus
 * terminal", which called `pane.focus` and threw the user out of the app
 * into iTerm — the same thing a plain click on the villager already did.
 * Both are now what they say they are: the click opens the agent's terminal
 * IN the app (the same `Terminal` the sea uses), and the external raise
 * survives as its own, explicitly-worded button. `children` is where the
 * host puts that agent's own working surface (`AgentActions` — the prompt
 * box, its last output, and both terminal actions), so a town villager
 * offers exactly what an expanded island row in the sea offers, from the
 * same components.
 *
 * SEA/TOWN CONSISTENCY ROUND: that external-raise button used to live HERE,
 * in this panel's own button row, which meant the capability existed twice
 * the moment the sea needed one too. It now lives in `AgentActions`
 * (`children`, a few pixels higher, beside "Open terminal ⤢" where the
 * distinction between the two actually needs to be visible) and is
 * therefore one button, one label and one call on both screens. This panel
 * is back to what its name says: the facts about a villager, plus whatever
 * working surface its host hands it.
 *
 * `role="dialog"` is not decorative here either: `useHotkey`'s
 * `isModalOpen()` detects any `[role="dialog"]` in the document, so the
 * app-level Escape hotkey that closes the whole town self-gates into a
 * no-op while this panel is open, exactly like `BuildingPanel`/
 * `DistrictPanel` already rely on — see `BuildingPanel`'s own doc comment
 * for the full two-listener ordering proof this mirrors.
 */
export function VillagerPanel({
  agent,
  onClose,
  children,
}: {
  agent: Agent;
  onClose: () => void;
  /** This agent's working surface, supplied by the host so this panel keeps
   * no `invoke` dependency of its own (the same division `TownView` already
   * keeps: it renders, the caller acts). In the shipped app this is always
   * `AgentActions`, which is where both terminal actions live. */
  children?: ReactNode;
}) {
  // The shared dialog Escape (`useEscapeKey`) — this listener existed
  // verbatim in five components before the sea/town consistency round; see
  // that hook's doc comment for the whole depth ladder it takes part in.
  useEscapeKey(onClose);

  const label = agent.title ?? agent.pane_id;

  return (
    <div className="building-panel" role="dialog" aria-label={`Agent: ${label}`}>
      <button
        type="button"
        className="building-panel__close"
        onClick={onClose}
        aria-label="Close (Escape)"
      >
        ×
      </button>
      <h3 className="building-panel__name">{label}</h3>
      <dl className="building-panel__facts">
        {/* WHICH agent this is — the author runs claude and codex side by
            side, and until this row existed the panel described what a
            villager was DOING without ever saying who it was. Rendered
            only when herdr actually named a kind: `agent.kind === null`
            means genuinely unknown (see its doc comment on `Agent`), and
            the honest rendering of unknown here is the absence of the
            row, exactly as `Worktree` below is absent rather than "no".
            Never `agent.kind ?? "claude"`. */}
        {agent.kind !== null && (
          <>
            <dt>Kind</dt>
            <dd>{agent.kind}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>{agent.status}</dd>
        <dt>Attention</dt>
        <dd>{agent.attention}</dd>
        <dt>Pane</dt>
        <dd className="building-panel__path">{agent.pane_id}</dd>
        <dt>Directory</dt>
        <dd className="building-panel__path">{agent.cwd}</dd>
        {agent.is_worktree && (
          <>
            <dt>Worktree</dt>
            <dd>yes</dd>
          </>
        )}
      </dl>
      {children}
    </div>
  );
}
