import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { foldActionSheet, type ActionSheet } from "../actionSheet";
import { startAgentSummary } from "../actions";
import { foundSettlement, startAgent } from "../agents";
import { foldFounding, INITIAL_FOUNDING_STATE } from "../founding";
import { type AgentKindsState, useAgentKinds, useResumableAgentKinds } from "../useAgentKinds";
import { useProposedAgentName } from "../useProposedAgentName";
import type { Agent } from "../world";
import { FoundingSheet } from "./FoundingSheet";

type StartAgentDraft = { kind: string; resume: boolean };

/**
 * The start-an-agent action, and the whole point of the start-agent-anywhere
 * round: ONE string, used by every branch of every screen, so the label a
 * user sees can never depend on whether the repo they picked happens to
 * already have a herdr workspace — or on whether they are looking at the sea
 * or standing in the town.
 *
 * The author reported being unable to start an agent in `~/Projects/webAdmin`,
 * a real git repo with no workspace yet, so
 * the panel took the unsettled branch, and the only button there said
 * "Found a settlement" — pure metaphor, never once the word "agent". The
 * capability was there the whole time (`found_settlement` creates the
 * workspace and optionally starts the agent); the NAME was not.
 *
 * Both branches still reach different backend calls, and that stays true —
 * `start_agent` for a settled island, `found_settlement` for an unsettled
 * one, two distinct commands with two distinct confirm sheets. What is
 * unified is the language and the entry point. The unsettled sheet
 * (`FoundingSheet`) then discloses the extra step in plain words rather
 * than hiding it behind "settle"; see its own doc comment.
 *
 * Keeping it a shared constant rather than two literals is the guard
 * against exactly the drift that caused the bug: one pass renamed the
 * settled side from "Send an agent" to "Start agent…" and left the
 * unsettled side speaking a different language entirely. The town-terminal
 * round is why it lives HERE rather than in `IslandPanel`: a third caller
 * (the town header) now uses it too, and a constant that only one screen's
 * module owns is the same drift waiting to happen again.
 *
 * The trailing ellipsis is load-bearing twice over: it is the ordinary
 * convention for "this opens a dialog rather than acting immediately"
 * (which is spec §5.6's whole promise here), AND it is what keeps this
 * opener's accessible name distinct from the settled sheet's own "Start
 * agent" confirm button.
 */
export const START_AGENT_LABEL = "Start agent…";

/**
 * How long to wait for a just-started agent's pane to appear in the world
 * before saying so out loud (Item 1, terminal-polish round).
 *
 * The world is not ours to poll: it arrives asynchronously over herdr's
 * `world-updated` push, normally within a fraction of a second of
 * `agent.start` returning. This deadline is not a timeout on the agent —
 * the agent is already started, and nothing here cancels or retries
 * anything — it is only the point at which silence stops being honest and
 * the caller has to say "it started, we cannot show you its terminal yet"
 * instead of showing a spinner forever.
 */
export const TERMINAL_WAIT_MS = 10_000;

/** What `useStartAgentFlow` hands back to whichever screen is hosting it. */
export type StartAgentFlow = {
  /** Opens the right confirm sheet for this repository — `StartAgentSheet`
   * when it already has a herdr workspace, `FoundingSheet` when it does
   * not. Never starts anything by itself. */
  open: () => void;
  /** True while `agent_kinds()` is still in flight: the sheet NAMES the
   * agent kind it will start, and the only honest source for that name is
   * `kinds[0]`. */
  loading: boolean;
  /** `agent_kinds()`'s own failure message, for the opener's tooltip. */
  error: string | null;
  /** A real call is in flight behind a modal sheet — callers whose own
   * Escape handler would unmount this flow must not close while this is
   * true, or a `failed` dispatch moments later lands on nothing. */
  busy: boolean;
  /** The two honest in-between states: "waiting for herdr to report the
   * pane" and "we waited, and it has not". Render these somewhere visible;
   * the agent is running in both. */
  notes: ReactNode;
  /** The confirm sheets themselves. Render once, anywhere in the tree. */
  sheets: ReactNode;
  /** Drop a pending wait — for a host that has just been pointed at a
   * different pane and must not have an old wait re-attach a terminal
   * underneath the one just asked for. */
  cancelWait: () => void;
};

/**
 * Starting an agent in one repository, as one reusable flow: the kind
 * picker, the two confirm sheets, the call, and the wait for herdr to
 * report the pane it created.
 *
 * LIFTED OUT OF `IslandPanel`, not copied from it (town-terminal round).
 * "Starting an agent should be reachable from the town" was this round's
 * item 3, and the sea's version of it is four interlocking pieces —
 * `agent_kinds`/`resumable_agent_kinds`, an `ActionSheet` reducer, a
 * `FoundingState` reducer, and the awaiting-pane deadline. A second copy of
 * that in `App.tsx` would have drifted from this one within a round; this
 * project has already paid for exactly that mistake once, with a one-word
 * label that existed twice.
 *
 * WHAT THIS DELIBERATELY DOES NOT OWN: the button. Each screen renders its
 * own, with its own layout and its own class names, using the shared
 * `START_AGENT_LABEL` above — the sea's lives in a wrapped row of panel
 * actions, the town's in a single-line header, and a component that tried
 * to own both would have to grow a styling prop to say which. What it does
 * own is everything that could be *wrong*: which command runs, what the
 * sheet says it will run, and what happens afterwards.
 *
 * `onPaneReady` fires exactly once per successful start, with the pane id
 * the BACKEND named (never a guess), and only once the world actually
 * reports that pane — the honesty rule the whole terminal feature rests on:
 * a terminal attached to a pane herdr has not confirmed would be pointing
 * the user's keyboard at a guess.
 */
export function useStartAgentFlow({
  root,
  name,
  settled,
  agents,
  onPaneReady,
  noteClassName = "island-panel__waiting",
}: {
  /** The repository's canonical root — what both commands are given. */
  root: string;
  /** Its display name, for the founding sheet. */
  name: string;
  /** Whether herdr already has a workspace for this repository. Decides
   * which of the two commands (and which sheet) this flow uses. */
  settled: boolean;
  /** The agents the world currently reports for this repository — watched
   * so `onPaneReady` can fire the moment a just-started pane appears. */
  agents: Agent[];
  onPaneReady: (paneId: string) => void;
  /** The class the two waiting notes are rendered with, so each screen can
   * place them in its own visual language (the sea's panel column, the
   * town's header row) without a second copy of the words. */
  noteClassName?: string;
}): StartAgentFlow {
  const kindsState = useAgentKinds();
  const resumableState = useResumableAgentKinds();
  const [startSheet, dispatchStart] = useReducer(foldActionSheet<StartAgentDraft>, null);
  const [foundState, dispatchFound] = useReducer(foldFounding, INITIAL_FOUNDING_STATE);
  // Three pieces of state, because the honest version of "start an agent and
  // land in its terminal" has three distinct moments and they must not be
  // collapsed into one:
  //
  //  - `awaitingPane`: the backend has CONFIRMED a pane id (`start_agent`
  //    returns one; `found_settlement` returns one alongside the workspace
  //    id), and we are waiting for herdr's own `world-updated` push to
  //    report that pane.
  //  - `onPaneReady`: fired only once the pane is genuinely in `agents`.
  //  - `waitNote`: what to say when the wait does not resolve. The agent
  //    is running either way — that must be said plainly rather than
  //    swallowed.
  const [awaitingPane, setAwaitingPane] = useState<{ paneId: string; since: number } | null>(null);
  const [waitNote, setWaitNote] = useState<string | null>(null);
  // A ref, so a host that passes a fresh closure every render (the common
  // case — it usually closes over that screen's own setState) cannot make
  // the deadline effect below re-run and re-arm its timer on every render.
  const onPaneReadyRef = useRef(onPaneReady);
  onPaneReadyRef.current = onPaneReady;

  // Reset per repository: a pending "open its terminal" wait belongs to the
  // repo it was started on and nothing else.
  useEffect(() => {
    setAwaitingPane(null);
    setWaitNote(null);
  }, [root]);

  /**
   * The one effect: report the pane the backend named, the moment the world
   * actually reports it — and only then.
   *
   * Re-runs on every `agents` change (each `world-updated` push re-renders
   * the host with a new list), so the match happens on the first push that
   * contains the pane. The timer is re-armed against the ORIGINAL start time
   * rather than restarted, so a busy island pushing updates every 200ms
   * cannot postpone the deadline indefinitely.
   */
  useEffect(() => {
    if (awaitingPane === null) return;
    if (agents.some((agent) => agent.pane_id === awaitingPane.paneId)) {
      setAwaitingPane(null);
      setWaitNote(null);
      onPaneReadyRef.current(awaitingPane.paneId);
      return;
    }
    const remaining = Math.max(0, awaitingPane.since + TERMINAL_WAIT_MS - Date.now());
    const timer = window.setTimeout(() => {
      setAwaitingPane(null);
      // Names the pane, because that is the only handle the user has on
      // the thing that undeniably exists — and says what did happen
      // (it started) before what did not (we cannot show it yet).
      setWaitNote(
        `Started — herdr has not reported pane ${awaitingPane.paneId} yet, so its terminal is not open. ` +
          `It will appear in the list above when herdr reports it.`,
      );
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [awaitingPane, agents]);

  const cancelWait = useCallback(() => {
    setAwaitingPane(null);
    setWaitNote(null);
  }, []);

  /** Arms the wait for one specific, backend-confirmed pane id. Both start
   * paths funnel through here so there is exactly one place that decides
   * what "the terminal for the agent I just started" means. */
  const awaitTerminalFor = (paneId: string) => setAwaitingPane({ paneId, since: Date.now() });

  // The kind `FoundingSheet` opens PRESELECTED on (it is a starting point
  // rather than the only possibility — the sheet's picker can change it, and
  // whatever it ends on is passed explicitly to `found_settlement`, so sheet
  // and call still agree by construction). `kinds[0]` IS the configured
  // default — `agent_kinds` is `ordered_with_default_first(AGENT_KINDS,
  // config.default_agent)` and `found_settlement` resolves that same
  // `config.default_agent` — so on the `ready` path this is exact, not a
  // guess.
  //
  // The `"claude"` tail is only reachable when `agent_kinds()` outright
  // FAILED (the `loading` window is gated by the opener's own `disabled`),
  // which is also the state where the button carries the error as its
  // tooltip. It matches the backend's own fallback for the same unknown, so
  // the sheet and the call still agree; it is a remaining soft spot, not a
  // fresh one, and it is called out here rather than left silent.
  const defaultAgentLabel = kindsState.status === "ready" ? (kindsState.kinds[0] ?? "claude") : "claude";

  const open = () => {
    if (settled) {
      const defaultKind = kindsState.status === "ready" ? (kindsState.kinds[0] ?? "") : "";
      dispatchStart({ kind: "open", draft: { kind: defaultKind, resume: false } });
      return;
    }
    dispatchFound({ kind: "openSheet", repo: { path: root, name }, agentKind: defaultAgentLabel });
  };

  const confirmStart = async () => {
    if (startSheet === null || startSheet.busy) return;
    dispatchStart({ kind: "started" });
    setWaitNote(null);
    try {
      const paneId = await startAgent(root, startSheet.draft.kind || undefined, startSheet.draft.resume);
      dispatchStart({ kind: "succeeded" });
      // Deliberately no local "agent started" note and no locally-added
      // villager: the honesty rule — the new villager must come from the
      // real `world-updated` push once herdr reports the pane, never from
      // this component assuming its own call worked. The terminal rests on
      // exactly that rule rather than bending it: this records WHICH pane
      // to open a terminal for (the backend's own return value, not a
      // guess), and the effect above reports it only once the world does.
      awaitTerminalFor(paneId);
    } catch (error) {
      dispatchStart({ kind: "failed", error: String(error) });
    }
  };

  const confirmFound = async () => {
    if (foundState.sheet === null || foundState.sheet.founding) return;
    const { repo, startAgent: withAgent, agentKind } = foundState.sheet;
    dispatchFound({ kind: "foundingStarted" });
    setWaitNote(null);
    try {
      const founded = await foundSettlement(repo.path, withAgent, agentKind);
      dispatchFound({
        kind: "foundingSucceeded",
        workspaceId: founded.workspace_id,
        // What herdr was actually told to call it — see
        // `FoundingState.lastAgentName`.
        agentName: founded.agent_name,
      });
      // Only when an agent was actually started. With the checkbox cleared
      // this call creates a workspace and nothing else, and opening a
      // terminal on its empty shell pane would be the app answering a
      // question the user did not ask.
      if (withAgent) awaitTerminalFor(founded.pane_id);
    } catch (error) {
      dispatchFound({ kind: "foundingFailed", error: String(error) });
    }
  };

  const notes = (
    <>
      {awaitingPane !== null && (
        <p className={noteClassName} role="status">
          Started — opening the terminal for {awaitingPane.paneId} as soon as herdr reports it…
        </p>
      )}
      {waitNote !== null && (
        <p className={noteClassName} role="status">
          {waitNote}
        </p>
      )}
    </>
  );

  const sheets = (
    <>
      {startSheet && (
        <StartAgentSheet
          sheet={startSheet}
          kindsState={kindsState}
          resumableState={resumableState}
          root={root}
          onChangeKind={(kind) => dispatchStart({ kind: "edit", draft: { kind, resume: false } })}
          onChangeResume={(resume) =>
            dispatchStart({ kind: "edit", draft: { kind: startSheet.draft.kind, resume } })
          }
          onCancel={() => dispatchStart({ kind: "close" })}
          onConfirm={confirmStart}
        />
      )}
      {foundState.sheet && (
        <FoundingSheet
          sheet={foundState.sheet}
          kindsState={kindsState}
          onChooseAgentKind={(agentKind) => dispatchFound({ kind: "chooseAgentKind", agentKind })}
          onToggleStartAgent={() => dispatchFound({ kind: "toggleStartAgent" })}
          onCancel={() => dispatchFound({ kind: "closeSheet" })}
          onConfirm={confirmFound}
        />
      )}
    </>
  );

  return {
    open,
    loading: kindsState.status === "loading",
    error: kindsState.status === "error" ? kindsState.message : null,
    busy: (startSheet?.busy ?? false) || (foundState.sheet?.founding ?? false),
    notes,
    sheets,
    cancelWait,
  };
}

/**
 * The "start an agent" confirm sheet — same visual language as
 * `FoundingSheet` (the `.sheet`/`.sheet__panel` classes), a distinct
 * component rather than a generalized one because its content (a kind
 * picker fed by `agent_kinds()`, and a resume toggle) doesn't map onto
 * founding's own start-agent checkbox.
 *
 * The resume toggle exists ONLY for a kind `resumable_agent_kinds()`
 * actually lists — never present-but-silently-ineffective for any other
 * kind. For a non-resumable kind this says so plainly instead of hiding the
 * option with no explanation.
 */
function StartAgentSheet({
  sheet,
  kindsState,
  resumableState,
  root,
  onChangeKind,
  onChangeResume,
  onCancel,
  onConfirm,
}: {
  sheet: ActionSheet<StartAgentDraft>;
  kindsState: AgentKindsState;
  resumableState: AgentKindsState;
  root: string;
  onChangeKind: (kind: string) => void;
  onChangeResume: (resume: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const kinds = kindsState.status === "ready" ? kindsState.kinds : [];
  const resumableKinds = resumableState.status === "ready" ? resumableState.kinds : [];
  const canResume = sheet.draft.kind !== "" && resumableKinds.includes(sheet.draft.kind);
  // herdr's globally unique NAME for the agent, which is not its kind
  // (`agent_name_taken` round — see `startAgentSummary`). Read-only lookup,
  // made because the sheet is open; `null` until it answers, and then the
  // `<pre>` below simply omits `name=` rather than inventing one.
  const agentName = useProposedAgentName(root);
  return (
    <div className="sheet" role="dialog" aria-label="Start an agent">
      <div className="sheet__panel">
        <h3>Start an agent</h3>
        <pre className="sheet__calls">{startAgentSummary(root, sheet.draft.kind, sheet.draft.resume, agentName).join("\n")}</pre>
        {sheet.error !== null && (
          <p className="sheet__error" role="alert">
            {sheet.error}
          </p>
        )}
        {kinds.length > 0 && (
          <label className="sheet__field">
            Kind:
            <select value={sheet.draft.kind} disabled={sheet.busy} onChange={(event) => onChangeKind(event.target.value)}>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
        )}
        {resumableState.status === "ready" && sheet.draft.kind !== "" && (
          canResume ? (
            <label className="sheet__checkbox">
              <input
                type="checkbox"
                checked={sheet.draft.resume}
                disabled={sheet.busy}
                onChange={(event) => onChangeResume(event.target.checked)}
              />
              resume previous conversation
            </label>
          ) : (
            <p className="sheet__hint">
              no known resume flag for {sheet.draft.kind} — configure resume_args in config.json
            </p>
          )
        )}
        <div className="sheet__actions">
          <button type="button" onClick={onCancel} disabled={sheet.busy}>
            cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={sheet.busy}>
            {sheet.busy ? "starting…" : "Start agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
