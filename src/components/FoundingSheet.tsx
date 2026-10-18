import { foundingSummary, type Sheet } from "../founding";
import type { AgentKindsState } from "../useAgentKinds";
import { useProposedAgentName } from "../useProposedAgentName";

/** This sheet's own accessible name and heading — see `FoundingSheet`'s doc
 * comment below for why it is worded like this, and why it must stay
 * distinct from both the opener that raises it (`START_AGENT_LABEL`) and
 * the confirm button inside it. Exported so tests assert against the one
 * definition instead of re-typing a string that could drift. */
export const FOUNDING_SHEET_TITLE = "Start an agent — new workspace";

/**
 * The confirm sheet for starting an agent on a repository that has NO herdr
 * workspace yet — extracted out of `UnsettledList` so the archipelago
 * scene's `IslandPanel` can offer the identical flow directly from an
 * unsettled island (this round's Item 3) without a second, divergent
 * implementation. "Reuse the existing confirm sheet rather than writing a
 * second one" is the coordinator's own instruction.
 *
 * WHY IT NO LONGER CALLS ITSELF "Found a settlement" (the start-agent-
 * anywhere round). The author reported being unable to start an agent in a
 * repository with no agent running yet. That was right, and the capability was never
 * missing — `found_settlement` has always been able to create the workspace
 * AND start the agent in one go. What was missing was the WORD. On an
 * unsettled repo the only button on screen said "Found a settlement" and
 * never said "agent" at all, so the one thing he wanted to do had no name
 * anywhere on the path to doing it. From the user's side there is a single
 * intention — *start an agent in this repo* — and which backend call
 * implements it (`start_agent` on a settled island, `found_settlement`
 * here) is our business, not theirs.
 *
 * So the language is unified with the settled flow (`IslandPanel`'s
 * `START_AGENT_LABEL` is literally the same string on both), and the extra
 * step this path takes is DISCLOSED rather than hidden behind the metaphor:
 * the lede below says in plain words that the workspace gets created first,
 * and the `<pre>` underneath it still shows the exact `workspace.create` /
 * `agent.start` calls, unchanged (spec §5.6 — nothing runs until the
 * confirm button is pressed, and the sheet names precisely what will run).
 * The metaphor is kept as an aside ("the settlement is founded") rather
 * than as the load-bearing verb: islands, villagers and towns stay; the
 * button that performs the concrete action the user asked for by name does
 * not get to be the place the metaphor costs them the action.
 *
 * THREE DISTINCT ACCESSIBLE NAMES, deliberately (a previous pass broke six
 * tests by giving two of them the same name):
 *   opener  "Start agent…"                   (`IslandPanel`, or a row in
 *                                             `UnsettledList`)
 *   dialog  "Start an agent — new workspace" (this component)
 *   confirm "Create workspace & start agent" / "Create workspace"
 * The confirm button's own label TRACKS the checkbox, so it can never
 * promise an agent the call is not going to start.
 *
 * Deliberately dumb: all the state (which repo, whether to start an agent,
 * whether a call is in flight, the last error) lives in the caller's own
 * `foldFounding` reducer — this component only renders it and reports
 * intent back up via callbacks, exactly like `BuildingPanel` does for its
 * own selection state.
 *
 * No resume toggle here, and that is not an oversight: resume is only ever
 * offered for a kind `resumable_agent_kinds()` actually lists
 * (`StartAgentSheet`), and a workspace that does not exist yet has no
 * previous conversation to resume in the first place. `found_settlement`
 * takes no resume flag, so offering one would be a control that silently
 * does nothing. That stays true with the kind picker below: picking
 * `claude` here still starts a FRESH claude, because this workspace has
 * never had a conversation to resume.
 *
 * THE KIND PICKER (terminal-polish round, Item 4 — the author, having hit
 * exactly this path on a repo with no workspace: "where cna i choose which
 * claude od codex?"). There was no choice here at all: `found_settlement`
 * took no kind and fell back to the configured default, while the settled
 * path had offered a picker all along. So the same picker, fed by the same
 * `agent_kinds()` (configured default first), now sits here too — and
 * `found_settlement` takes the chosen kind, so the `<pre>` above it keeps
 * naming the call that actually runs. When `agent_kinds()` has not
 * resolved, no picker is rendered rather than one listing a guess; the
 * sheet still names the kind it was opened with, which IS what the command
 * will use.
 */
export function FoundingSheet({
  sheet,
  kindsState,
  onChooseAgentKind,
  onToggleStartAgent,
  onCancel,
  onConfirm,
}: {
  sheet: Sheet;
  /** The kinds herdr accepts, configured default first — the same source
   * `StartAgentSheet` uses, so the two sheets can never offer different
   * menus for the same machine. */
  kindsState: AgentKindsState;
  onChooseAgentKind: (kind: string) => void;
  onToggleStartAgent: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const kinds = kindsState.status === "ready" ? kindsState.kinds : [];
  // The agent's NAME, asked of the backend the moment this sheet opened
  // (read-only `agent.list`; nothing is started). Separate from the kind
  // because herdr treats them as separate things and enforces uniqueness on
  // the name — see `foundingSummary`. `null` until it answers, in which
  // case the `<pre>` below simply does not claim a name.
  const agentName = useProposedAgentName(sheet.startAgent ? sheet.repo.path : null);
  // What this sheet says it will start, everywhere it says it: the `<pre>`
  // of exact calls, the checkbox label, and the picker's own value are one
  // string, never three.
  const agent = sheet.agentKind;
  return (
    <div className="sheet" role="dialog" aria-label={FOUNDING_SHEET_TITLE}>
      <div className="sheet__panel">
        <h3>{FOUNDING_SHEET_TITLE}</h3>
        {/* The disclosure the old "Found a settlement" title hid. Written
            against the checkbox's CURRENT value, not as a fixed sentence:
            with the agent box cleared this path really does only create a
            workspace, and saying "then starts the agent" anyway would be
            the same class of untruth the rename is fixing. */}
        <p className="sheet__lede">
          {sheet.repo.name} has no herdr workspace yet.{" "}
          {sheet.startAgent
            ? "This creates one — the settlement is founded — and then starts the agent in it:"
            : "This creates one. No agent will be started:"}
        </p>
        <pre className="sheet__calls">
          {foundingSummary(sheet.repo, agent, sheet.startAgent, agentName).join("\n")}
        </pre>
        {sheet.error !== null && (
          <p className="sheet__error" role="alert">
            {sheet.error}
          </p>
        )}
        {/* Only offered when an agent is actually going to be started —
            with the checkbox cleared there is nothing for a kind to
            describe, and a live picker over a call that will not happen is
            the same class of empty control as the absent resume toggle. */}
        {kinds.length > 0 && sheet.startAgent && (
          <label className="sheet__field">
            Kind:
            <select
              value={agent}
              disabled={sheet.founding}
              onChange={(event) => onChooseAgentKind(event.target.value)}
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="sheet__checkbox">
          <input
            type="checkbox"
            checked={sheet.startAgent}
            disabled={sheet.founding}
            onChange={onToggleStartAgent}
          />
          start {agent}
        </label>
        <div className="sheet__actions">
          <button type="button" onClick={onCancel} disabled={sheet.founding}>
            cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={sheet.founding}>
            {sheet.founding
              ? "creating…"
              : sheet.startAgent
                ? "Create workspace & start agent"
                : "Create workspace"}
          </button>
        </div>
      </div>
    </div>
  );
}
