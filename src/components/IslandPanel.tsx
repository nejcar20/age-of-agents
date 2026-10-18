import { useTradeRoutes } from "./TradeRoutes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { focusWorkspace } from "../agents";
import type { SeaIsland } from "../archipelago";
import {
  FOCUS_WORKSPACE_TERMINAL_LABEL,
  FOCUS_WORKSPACE_TERMINAL_TITLE,
} from "../externalTerminal";
import { summarizeRepoHistory, useRepoHistory } from "../history";
import { formatLastChanged } from "../lastChanged";
import { describeMeasuredAt } from "../measuredAt";
import { revealPath } from "../reveal";
import { useTerminalAttachment } from "../terminalAttachment";
import { useEscapeKey } from "../useEscapeKey";
import { ATTENTION_LABEL, ATTENTION_MARK, type Agent } from "../world";
import { AgentActions } from "./AgentActions";
import { START_AGENT_LABEL, useStartAgentFlow } from "./StartAgent";
import { Terminal } from "./Terminal";

// The glyph and words for an agent's state come from the SHARED vocabulary
// in `world.ts`, used directly below — the second of the four identical
// copies the sea/town consistency round folded into one.

// The start-an-agent flow (both confirm sheets, both commands, and the wait
// for herdr to report the pane) was LIFTED into `StartAgent.tsx` by the
// town-terminal round, so the town's own header can offer the identical
// action rather than a second copy of it — see `useStartAgentFlow`'s doc
// comment. Re-exported here because this module is where the label has
// always lived from a caller's point of view.
export { START_AGENT_LABEL, TERMINAL_WAIT_MS } from "./StartAgent";

/**
 * The archipelago's island action panel (Item 1) — what selecting an island
 * shows: what it is (name, path, real city size, last change, its agents)
 * and what you can do with it. This is deliberately a SEPARATE gesture from
 * flying into the town (Item 5 of the archipelago-scene round already gave
 * a click that meaning); `Archipelago.tsx` now treats a click as "select,"
 * and this panel's own "Visit town" button is the explicit trigger for the
 * flight, per this round's "every action must be explicit" instruction.
 *
 * `role="dialog"` WITHOUT `aria-modal="true"` (CRITICAL 3, Opus frontend
 * review): this card is informational, not modal — it never blocks the rest
 * of the sea, and the Space jump hotkey must keep working while it's open,
 * since every jump's own `onArrive` opens exactly this panel (`useHotkey`'s
 * `isModalOpen()` used to treat ANY `role="dialog"` as modal, which made
 * Space go dead the instant a jump landed anywhere, with no feedback — see
 * that function's own doc comment for the general fix). The nested
 * `StartAgentSheet`/`FoundingSheet` confirm sheets below ARE real modals
 * (they keep plain `role="dialog"`, no opt-out) — a "Start agent" call in
 * flight still owns the keyboard the same as `NewProjectPanel`'s does.
 */
export function IslandPanel({
  seaIsland,
  onClose,
  onVisitTown,
  autoExpandPaneId,
  autoOpenSendAgent,
  autoOpenTerminal,
  openTerminalRequest,
}: {
  seaIsland: SeaIsland;
  onClose: () => void;
  onVisitTown: () => void;
  /** Set when a villager was clicked (rather than the island itself) — see
   * `Archipelago.tsx`'s villager click handler.
   *
   * SEA/TOWN CONSISTENCY ROUND: a villager click used to ALSO fire
   * `focus_pane` immediately and unconditionally, raising iTerm and
   * ejecting the user from the app. It no longer does — it opens that
   * agent's terminal here instead (via `openTerminalRequest` below), the
   * same thing the same gesture does in a town. Expanding the row survives
   * that change and is now load-bearing rather than merely convenient:
   * closing the terminal leaves the user on that agent's own prompt box and
   * last output rather than on nothing. */
  autoExpandPaneId?: string;
  /** Screenshot-harness-only (mirrors `autoExpandPaneId`): opens the
   * "Start agent…" sheet on mount, once `agent_kinds()` has resolved, so
   * a render can show the sheet (including the resume checkbox/hint) laid
   * out over the scene without simulating a real click. Unused by the
   * shipped app. */
  autoOpenSendAgent?: boolean;
  /** Screenshot-harness-only: attaches this panel's `Terminal` to whichever
   * agent row is expanded (see `autoExpandPaneId`), the same state a real
   * click on "Open terminal ⤢" would set. Unused by the shipped app. */
  autoOpenTerminal?: boolean;
  /** Item 2 (lag-and-switcher round): a ONE-SHOT "open the big terminal for
   * this pane" request from the sea — how the "go to whoever else is
   * waiting" switch inside an already-open terminal lands on another agent.
   * Deliberately a fresh object per request (see `Archipelago`'s
   * `openTerminalRequest` state) rather than a bare pane id, so switching
   * away and back re-opens rather than silently doing nothing. Goes through
   * the SAME `openTerminalFor` a villager click, the row's own button and
   * "start an agent and land in its terminal" all use — one meaning of
   * "open this pane's terminal", not four. */
  openTerminalRequest?: { paneId: string; seq: number } | null;
}) {
  const { view, attention, agents } = seaIsland;
  const tradeRoutes = useTradeRoutes();
  const settled = attention !== null;
  // Game-feel round: "give the place a sense of history." A quiet, honest
  // one-line summary (never a graphical timeline — see `summarizeRepoHistory`'s
  // own doc comment on why a line earns its place here and a bigger widget
  // didn't need to). `null` while loading/erroring/genuinely-empty simply
  // renders nothing — this is supplementary colour, not core data, so a
  // failure here is never worth an alarming error box next to the real facts
  // above it.
  const historyState = useRepoHistory(view.root);
  const historySummary =
    historyState.status === "ready" ? summarizeRepoHistory(historyState.history) : null;

  // Opus review (ITEM 1): `view.city.measured_at` discloses WHEN a `known`
  // city's numbers were actually measured, never advanced just because a
  // cached summary was reused — see `measuredAt.ts`'s own doc comment for
  // why this exists and why it is rendered, not silently carried unread.
  const measuredAge = view.city.status === "known" ? describeMeasuredAt(view.city.measured_at) : null;

  // Non-creating actions (focus, reveal) are fire-and-forget — no sheet, no
  // gating, exactly like the villager click's own `focus_pane` call. This
  // only surfaces a FAILURE; success is self-evident (the terminal actually
  // comes forward, Finder actually opens), so there is nothing honest to
  // say on success that the OS action itself doesn't already say louder.
  const [actionError, setActionError] = useState<string | null>(null);
  // Which agent's row is expanded, showing `AgentActions` (Items 6/7,
  // second coordinator round) — an accordion, not a second floating panel,
  // so `read_agent` is only ever fetched for the one agent someone is
  // actually looking at (never polled, never fetched for every agent on
  // open — see `AgentActions`'s own doc comment).
  const [expandedPaneId, setExpandedPaneId] = useState<string | null>(autoExpandPaneId ?? null);

  // ---- WHICH PANE THE KEYBOARD IS POINTED AT, and the terminal itself.
  //
  // Owned by this PANEL, through the same `useTerminalAttachment` hook the
  // town's screen uses (sea/town consistency round) — not by the agent row
  // inside it, which is where the sea's terminal used to mount. One
  // attachment, one answer to "where are my keys going", one `seq` that
  // doubles as the `Terminal`'s key so every switch is a fresh mount, and
  // one shared sentence when herdr stops reporting the pane. See
  // `terminalAttachment.ts` for the full reasoning, including why the sea
  // stops here rather than continuing up to `Archipelago` the way a town
  // continues up to `TownScreen`: a town's switcher can point its terminal
  // at an agent with no villager on screen, while every island the sea's
  // switcher can reach has this very panel — keyed on the island root, so a
  // cross-island switch remounts it.
  //
  // ---- Item 1 (terminal-polish round): starting an agent lands you in
  // its terminal, with no second gesture. The author asked for it twice in
  // one report: starting an agent should open its terminal, instantly.
  //
  // The flow itself — both sheets, both commands, and the wait for herdr to
  // actually report the pane the backend named — lives in
  // `useStartAgentFlow` (`StartAgent.tsx`), shared with the town's own
  // header so the two screens cannot drift. What stays here is what is
  // genuinely this panel's own: WHICH row to expand and which row's
  // terminal to open when the pane finally appears.
  const [paneGone, setPaneGone] = useState<string | null>(null);
  // The one host this panel's terminal can ever be attached to: this
  // island. A fresh array is fine — see the hook's own note on why a stable
  // `Agent` identity is what matters, not a stable array.
  const hosts = useMemo(() => [{ root: view.root, agents }], [view.root, agents]);
  const { attachment, attached, attach, detach } = useTerminalAttachment(hosts, setPaneGone);
  /** Point this panel's terminal at one of this island's panes, and expand
   * that agent's row underneath it — the sea's equivalent of `TownScreen`'s
   * `attach`, and the ONLY way a terminal opens here. */
  const openTerminalFor = useCallback(
    (paneId: string) => {
      setPaneGone(null);
      setExpandedPaneId(paneId);
      attach(paneId, view.root);
    },
    [attach, view.root],
  );
  const start = useStartAgentFlow({
    root: view.root,
    name: view.name,
    settled,
    agents,
    // Nothing is opened optimistically: this only ever runs once the world
    // genuinely reports the pane (see `useStartAgentFlow`), because a
    // terminal attached to a pane herdr has not confirmed would be pointing
    // the user's keyboard at a guess.
    onPaneReady: openTerminalFor,
  });

  // I3 (Opus frontend review): this used to close UNCONDITIONALLY, even
  // while a real call was in flight underneath (`start.busy`) — unmounting
  // this whole panel, and the sheet nested inside it, so a `failed` dispatch
  // moments later landed on nothing and the user never learned their "start
  // agent"/"found a settlement" call actually failed. `NewProjectPanel`
  // already guards its own Escape listener the same way; this mirrors that
  // guard for both of this panel's own in-flight sheets.
  const startBusy = start.busy;
  const cancelStartWait = start.cancelWait;
  useEscapeKey(onClose, { enabled: !startBusy });

  // Reset per island: switching selection while an old error is showing
  // must not carry it forward onto a repo it has nothing to do with, and a
  // terminal must never be left attached to a pane in a repository this
  // panel is no longer describing. (The pending-pane wait resets itself,
  // inside `useStartAgentFlow`, on the same `root` change.)
  //
  // Declared BEFORE the `openTerminalRequest` effect below on purpose:
  // effects run in declaration order, so on a mount that carries a request
  // this clears first and the request lands second, never the other way
  // round.
  useEffect(() => {
    setActionError(null);
    setPaneGone(null);
    detach();
  }, [view.root, detach]);

  // A later villager click (while this same panel instance is still open,
  // e.g. clicking a different agent on the same island) re-expands to the
  // newly-clicked agent.
  useEffect(() => {
    if (autoExpandPaneId) setExpandedPaneId(autoExpandPaneId);
  }, [autoExpandPaneId]);

  // Item 2 (lag-and-switcher round): the sea asked for one specific pane's
  // terminal. Declared AFTER the `[view.root]` reset effect above on
  // purpose — on a cross-island switch this panel remounts, both effects
  // run, and the reset (which only ever writes the value a fresh mount
  // already has) must not land on top of the request.
  useEffect(() => {
    if (!openTerminalRequest) return;
    openTerminalFor(openTerminalRequest.paneId);
    // A pending wait belongs to an agent THIS panel started and is waiting
    // for herdr to report; a switch to an agent that already exists must
    // not leave that wait armed to re-open a different terminal underneath
    // the one just requested.
    cancelStartWait();
    // `start.cancelWait` and `openTerminalFor` are both stable
    // `useCallback`s, so naming them here cannot churn this one-shot
    // effect.
  }, [openTerminalRequest, cancelStartWait, openTerminalFor]);

  const handleFocus = () => {
    setActionError(null);
    focusWorkspace(view.root).catch((error) => setActionError(String(error)));
  };

  const handleReveal = () => {
    setActionError(null);
    revealPath(view.root).catch((error) => setActionError(String(error)));
  };

  // Screenshot-harness-only: see `autoOpenSendAgent`'s doc comment. Waits
  // for the kinds lookup to actually resolve so the sheet opens with the
  // real preselected default, the same as a genuine click on "Start agent…"
  // would (which is itself `disabled` until it is ready). It opens
  // whichever of the two sheets this island's own settled/unsettled state
  // calls for, exactly as the real button does — one entry point, per
  // `useStartAgentFlow`.
  const openStart = start.open;
  const startLoading = start.loading;
  useEffect(() => {
    if (autoOpenSendAgent && !startLoading) openStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenSendAgent, startLoading]);

  // Screenshot-harness-only (see `autoOpenTerminal`): attaches to whichever
  // row the harness expanded, through the SAME `openTerminalFor` every real
  // gesture uses — never a second way to open a terminal.
  useEffect(() => {
    if (autoOpenTerminal && expandedPaneId !== null) openTerminalFor(expandedPaneId);
    // Deliberately one-shot on the harness flag, not on `expandedPaneId`:
    // this must not re-open a terminal every time the user picks a
    // different row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenTerminal]);

  // Expanding a row shows that agent's own surface (last output, prompt
  // box) and NOTHING ELSE — it has never opened a terminal, and now cannot:
  // the only paths to a terminal are the explicit "Open terminal ⤢" button,
  // a villager click, a switch from inside an open terminal, and landing in
  // a just-started agent. A terminal is never opened unasked.
  const toggleExpanded = (agent: Agent) => {
    setExpandedPaneId((current) => (current === agent.pane_id ? null : agent.pane_id));
  };

  /**
   * The bare kind word an agent row should print to the right of its
   * title, or `null` for "print nothing."
   *
   * Two different reasons to print nothing, and they must not be confused:
   *
   * 1. `agent.kind === null` — herdr genuinely reported no agent for this
   *    pane (verified live: a plain shell pane omits the `agent` key
   *    entirely). Nothing is the honest rendering; a defaulted `"claude"`
   *    would be a claim about the author's machine with nothing behind it.
   *    See `Agent.kind`.
   *
   * 2. The row's own title IS the kind, verbatim — which is the COMMON
   *    case, not an edge one: herdr reports `terminal_title: "claude"` for
   *    a pane running claude, so printing the kind too renders
   *    `claude   claude blocked`, a stutter a human reads as a bug (caught
   *    by rendering this row and looking at it, exactly as the README
   *    warns). This omits nothing — the word is still on the row, once,
   *    in the title — so it is a typography fix, not a silent omission.
   *    Deliberately an EXACT (case-folded, trimmed) match against the
   *    whole displayed label, never a substring test: a pane titled
   *    "claude" that is actually running codex must still show `codex`,
   *    and that is the whole reason this field exists.
   *
   * `VillagerPanel` deliberately does NOT share rule 2: its facts are a
   * `<dl>` where every value sits under its own `KIND` label, so the same
   * word appearing there and in the heading reads as a labelled fact
   * rather than a stutter.
   */
  const rowKind = (agent: Agent, label: string): string | null => {
    if (agent.kind === null) return null;
    return agent.kind.trim().toLowerCase() === label.trim().toLowerCase() ? null : agent.kind;
  };

  return (
    <div className="island-panel" role="dialog" aria-modal="false" aria-label={`Island: ${view.name}`}>
      <button type="button" className="island-panel__close" onClick={onClose} aria-label="Close (Escape)">
        ×
      </button>
      <h3 className="island-panel__name">{view.name}</h3>
      <p className="island-panel__path">{view.root}</p>

      <dl className="island-panel__facts">
        {view.city.status === "known" ? (
          <>
            <dt>Districts</dt>
            <dd>{view.city.district_count.toLocaleString()}</dd>
            <dt>Buildings</dt>
            <dd>{view.city.building_count.toLocaleString()}</dd>
            {measuredAge && (
              <>
                <dt>Measured</dt>
                <dd
                  className={
                    measuredAge.kind === "old"
                      ? "island-panel__measured island-panel__measured--old"
                      : "island-panel__measured"
                  }
                >
                  {measuredAge.kind === "unrecorded" ? (
                    measuredAge.text
                  ) : (
                    <>
                      {measuredAge.relative}
                      {measuredAge.kind === "old" && (
                        <span className="island-panel__measured-caveat">
                          {" "}
                          — {measuredAge.caveat}
                        </span>
                      )}
                    </>
                  )}
                </dd>
              </>
            )}
          </>
        ) : (
          <>
            <dt>City</dt>
            <dd>unknown — {view.city.reason}</dd>
          </>
        )}
        <dt>Last change</dt>
        <dd>{formatLastChanged(view.last_changed_at)}</dd>
        <dt>Settlement</dt>
        <dd>{settled ? `${agents.length} agent${agents.length === 1 ? "" : "s"}` : "none — unsettled"}</dd>
        {historySummary !== null && (
          <>
            <dt>History</dt>
            <dd>{historySummary}</dd>
          </>
        )}
      </dl>

      {settled && agents.length > 0 && (
        <ul className="island-panel__agents">
          {agents.map((agent) => {
            const expanded = expandedPaneId === agent.pane_id;
            const label = agent.title ?? agent.pane_id;
            const kind = rowKind(agent, label);
            return (
              <li key={agent.pane_id}>
                <button
                  type="button"
                  className="island-panel__agent-row"
                  onClick={() => toggleExpanded(agent)}
                  aria-expanded={expanded}
                >
                  <span
                    className={`island-panel__agent-marker island-panel__agent-marker--${agent.attention}`}
                    title={ATTENTION_LABEL[agent.attention]}
                  >
                    {ATTENTION_MARK[agent.attention]}
                  </span>
                  <span className="island-panel__agent-title">{label}</span>
                  {/* The two MACHINE facts about this agent — which kind it
                      is, and what it is doing — grouped at the row's right
                      edge, away from the human-readable title on the left.
                      The wrapper carries the `margin-left: auto` the status
                      span used to carry alone, so the group still sits hard
                      right and the title still gets the whole remaining
                      width to wrap into. */}
                  <span
                    className="island-panel__agent-meta"
                    style={{ marginLeft: "auto", display: "flex", alignItems: "baseline", gap: 6 }}
                  >
                    {/* See `rowKind` for when this prints nothing and why
                        each of those cases is honest. `--ink-faint` is the
                        tone styles.css already gives metadata labels;
                        deliberately outside the stopped/working/unknown
                        colour language, because which agent this is is a
                        useful label, not a call for attention. */}
                    {kind !== null && (
                      <span className="island-panel__agent-kind" style={{ color: "var(--ink-faint)" }}>
                        {kind}
                      </span>
                    )}
                    <span className="island-panel__agent-status">{agent.status}</span>
                  </span>
                </button>
                {expanded && (
                  <AgentActions
                    agent={agent}
                    root={view.root}
                    // The row asks, this panel attaches — the same
                    // arrangement the town uses, so there is exactly one
                    // terminal and one answer to "where is my keyboard
                    // pointed" on either screen.
                    onOpenTerminal={() => openTerminalFor(agent.pane_id)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {actionError !== null && (
        <p className="island-panel__error" role="alert">
          {actionError}
        </p>
      )}

      {/* An agent that exits while its terminal is open takes the terminal
          with it — and says so, in the same words a town says it (see
          `paneGoneNote`), rather than leaving the user looking at a
          rectangle that stopped being a mirror. The sea used to blank
          silently here; that was the one visible consequence of the two
          screens having implemented this twice. */}
      {paneGone !== null && (
        <p className="island-panel__waiting" role="status">
          {paneGone}
        </p>
      )}

      {/* Item 1's two honest in-between states, rendered from the shared
          flow. The agent is running in both: the first says we are waiting
          on herdr to report its pane, the second says we waited and it has
          not. Neither is an error, and neither pretends a terminal is open
          when it is not. */}
      {start.notes}

      <div className="island-panel__actions">
        <button type="button" onClick={onVisitTown}>
          Visit town
        </button>
        {tradeRoutes && <button type="button" onClick={() => tradeRoutes.open({ sourceRoot: view.root })}>⤳ Establish trade route</button>}
        {settled ? (
          <>
            {/* The ISLAND-level raise (herdr `workspace.focus`), which is a
                different call from the per-agent one an expanded row
                offers. It used to read just "Focus terminal", one word away
                from the embedded terminal this same panel now opens; the
                shared label says which terminal and that it leaves the app.
                See `externalTerminal.ts`. */}
            <button type="button" onClick={handleFocus} title={FOCUS_WORKSPACE_TERMINAL_TITLE}>
              {FOCUS_WORKSPACE_TERMINAL_LABEL}
            </button>
            <button
              type="button"
              onClick={start.open}
              disabled={start.loading}
              title={start.error ?? undefined}
            >
              {START_AGENT_LABEL}
            </button>
          </>
        ) : (
          // Same label, same shape, same disabled-while-loading rule as the
          // settled button above — one `start.open`, which picks the sheet
          // this island's settled state calls for (see `useStartAgentFlow`).
          // "Focus terminal" is genuinely absent rather than disabled:
          // there is no workspace and therefore no terminal to focus, and a
          // greyed-out control would imply one exists.
          //
          // `disabled` while `agent_kinds()` is still in flight: the
          // confirm sheet this opens NAMES the agent it will start, and the
          // only honest source for that name is `kinds[0]`, which IS the
          // configured default (`agent_kinds` = `ordered_with_default_first`,
          // and `found_settlement` resolves the same `config.default_agent`).
          // Opening the sheet before that resolves would show
          // `agent.start name="claude"` on a machine configured for codex —
          // an exact-calls sheet naming a call other than the one that runs.
          <button
            type="button"
            onClick={start.open}
            disabled={start.loading}
            title={start.error ?? undefined}
          >
            {START_AGENT_LABEL}
          </button>
        )}
        <button type="button" onClick={handleReveal}>
          Reveal in Finder
        </button>
      </div>

      {start.sheets}

      {/* THE TERMINAL ITSELF, mounted by this PANEL — the sea's counterpart
          to `TownScreen`'s own mount, from the same attachment hook and
          keyed the same way, so every switch is a fresh mount with no
          keyboard focus carried over. It is `position: fixed; inset: 0`, so
          living inside this card costs it nothing visually. */}
      {attached !== null && attachment !== null && (
        <Terminal
          key={attachment.seq}
          agent={attached}
          root={attachment.root}
          initialMode="direct"
          onClose={detach}
        />
      )}
    </div>
  );
}
