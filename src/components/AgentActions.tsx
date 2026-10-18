import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { readAgent, sendPrompt } from "../agents";
import {
  RAISE_EXTERNAL_TERMINAL_LABEL,
  RAISE_EXTERNAL_TERMINAL_TITLE,
  raiseExternalTerminal,
} from "../externalTerminal";
import type { Agent } from "../world";
import { AnsiText } from "./AnsiText";

type OutputState =
  | { status: "loading" }
  | { status: "error"; message: string }
  // `truncated` (security review, MINOR 5) is now its own structured field
  // from `read_agent`, never spliced into `text` — the whole point being
  // that the app's own words and the agent's own (untrusted) output can
  // never be confused for each other. Every renderer of `text` MUST render
  // `truncated` as a separate UI affordance alongside it, never concatenate
  // the two back together.
  | { status: "ready"; text: string; truncated: boolean };

type SendState = { busy: boolean; error: string | null; sent: boolean };

/**
 * The one name for "show me this pane's live terminal, in the app" — used
 * by this row's own button and by the town's header button (`App.tsx`).
 *
 * A constant rather than two literals for the reason this project keeps
 * paying for: a one-word label that existed twice already drifted once
 * (`START_AGENT_LABEL`'s own doc comment tells that story). The glyph is
 * part of the label, not decoration — it is what distinguishes "open the
 * embedded mirror" from "raise your real terminal window", which is the
 * distinction a villager click used to get wrong.
 */
export const OPEN_TERMINAL_LABEL = "Open terminal ⤢";

/**
 * What a selected agent offers (Items 6 and 7, second coordinator round): a
 * SNAPSHOT of its recent terminal output, and a way to send it a prompt.
 * Mounted only while its own row is expanded (see `IslandPanel`'s
 * accordion) — never rendered, and therefore never fetching, for an agent
 * nobody has asked about. This is the module's own answer to "do not poll
 * it on a timer at sea level across every agent": there is no timer here at
 * all, only a fetch on mount and an explicit "refresh" button.
 *
 * Phase 0.7 split this component's own responsibility in two, on purpose:
 *
 * - THIS component composes and sends a PROMPT via Herdr's `agent.prompt`
 *   (`sendPrompt`/`send_prompt`) — spec §5.6's Phase 0.6 write, sanctioned
 *   specifically because it is Herdr's own submission primitive with defined
 *   semantics, not raw keystroke injection. Every prompt this ever sends was
 *   composed and reviewed by the user in the box below and released by a
 *   deliberate action (Send, or Enter) — the app itself never originates,
 *   re-sends, or auto-retries one.
 * - `Terminal` (opened via "Open terminal ⤢") is a SEPARATE, self-contained
 *   surface: Phase 0.7's raw interactive mirror, backed by
 *   `pane_read`/`pane_send_text`/`pane_send_keys`, with its own polling and
 *   its own focus-gated keystroke path. It shares none of this component's
 *   `output`/`prompt`/`send` state (there is nothing to share — it reads and
 *   writes the live pane directly) — see `Terminal.tsx`'s own doc comment
 *   for why raw keystrokes and a reviewed prompt box are deliberately kept
 *   as two distinct controls rather than merged into one, so it is never
 *   ambiguous which write path a keystroke or a click takes.
 *
 * THIS ROW NEVER MOUNTS THE TERMINAL ITSELF (sea/town consistency round).
 * It asks its host — `IslandPanel` at sea, `TownScreen` in a town — which
 * is what keeps "which pane is the keyboard pointed at" a single piece of
 * state with a single answer on both screens (§5.6's own condition on this
 * capability existing). It used to mount its own `Terminal` at sea while
 * delegating in a town, and that fork was the largest remaining place the
 * two screens implemented one concept twice; the delegating half won
 * because a town's terminal can be switched to an agent with no row (and
 * no villager) on the screen at all, so the screen must own it.
 *
 * The three terminal-shaped controls here are deliberately three, with the
 * distinction visible in the labels rather than implied:
 * "Open terminal ⤢" (the embedded mirror, here), "Focus external
 * terminal ↗" (your own window, leaving the app), and the prompt box (one
 * reviewed message through `agent.prompt`).
 */
export function AgentActions({
  agent,
  root,
  onOpenTerminal,
}: {
  agent: Agent;
  /** The island's own canonical root this agent belongs to — passed
   * through to `sendPrompt` as `expectedRoot` (security review, IMPORTANT
   * 3) so a stale `pane_id` Herdr has since recycled for a different
   * repository is refused rather than silently misdelivering this user's
   * prompt there. */
  root: string;
  /**
   * WHO OWNS THE TERMINAL. Required, on both screens (sea/town consistency
   * round): this row never mounts a `Terminal` of its own, it asks the
   * screen that does. See the module doc comment for why the delegating
   * arrangement won.
   */
  onOpenTerminal: () => void;
}) {
  const [output, setOutput] = useState<OutputState>({ status: "loading" });
  const [prompt, setPrompt] = useState("");
  const [send, setSend] = useState<SendState>({ busy: false, error: null, sent: false });
  // Bumped by the "refresh" button so the mount effect's own fetch (below)
  // re-runs on demand, without a second, duplicated fetch implementation.
  const [refreshToken, setRefreshToken] = useState(0);
  /** What the external raise actually did, said out loud. Both screens
   * report it here, in the same place, in the same words — see
   * `externalTerminal.ts` for why that is one module and not two literals.
   * `null` is "nothing has been asked for yet", never a stale answer: it is
   * cleared the moment the row is pointed at a different pane. */
  const [raiseNote, setRaiseNote] = useState<string | null>(null);

  // Fetches once when this row is actually expanded (mount) — see the
  // module doc comment — and again whenever `agent.pane_id` changes (a
  // stale snapshot showing under the wrong agent's name would itself be a
  // real honesty problem) or the user asks via "refresh."
  useEffect(() => {
    let cancelled = false;
    setOutput({ status: "loading" });
    readAgent(agent.pane_id)
      .then(({ text, truncated }) => {
        if (!cancelled) setOutput({ status: "ready", text, truncated });
      })
      .catch((error) => {
        if (!cancelled) setOutput({ status: "error", message: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [agent.pane_id, refreshToken]);

  // The raise note describes one gesture aimed at one pane. Pointed at a
  // different pane, the previous answer is no longer about anything on
  // screen, so it goes rather than sitting there looking current.
  useEffect(() => setRaiseNote(null), [agent.pane_id]);

  const handleSend = () => {
    const text = prompt.trim();
    if (text.length === 0 || send.busy) return;
    setSend({ busy: true, error: null, sent: false });
    sendPrompt(agent.pane_id, text, root)
      .then(() => {
        setPrompt("");
        setSend({ busy: false, error: null, sent: true });
        // Deliberately does NOT flip this agent to "working" locally — the
        // honesty rule this whole round keeps repeating: the real state
        // comes from `world-updated` once herdr actually reports it, never
        // from this component assuming its own call worked.
      })
      .catch((error) => setSend({ busy: false, error: String(error), sent: false }));
  };

  // Enter sends (Shift+Enter inserts a newline) — a deliberate, visible send
  // action per spec §5.6, not a stray keypress: this is a single-purpose
  // box, so Enter is unambiguous here the way it wouldn't be in a general
  // text editor. `useHotkey`'s own `isInteractiveTarget` already lists
  // TEXTAREA, so the global Space/jump hotkey already bails while this box
  // has focus — verified directly in `AgentActions.test.tsx`.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const handleRefresh = () => setRefreshToken((t) => t + 1);

  return (
    <div className="agent-actions">
      <div className="agent-actions__output">
        <div className="agent-actions__output-header">
          {/* "snapshot," not "live" — Item 7's own instruction: never let
              this read as a live tail. */}
          <span>Last output (snapshot)</span>
          <div className="agent-actions__output-header-buttons">
            <button type="button" onClick={handleRefresh} disabled={output.status === "loading"}>
              refresh
            </button>
            {/* Opens the Phase 0.7 interactive terminal — a real, live,
                typeable mirror of this pane, not another view of the
                snapshot/compose state on this row. See `Terminal.tsx`.
                Where that terminal is MOUNTED depends on who is hosting
                this row — see `onOpenTerminal`; the button, the label and
                the meaning are the same either way. */}
            <button type="button" className="agent-actions__open" onClick={onOpenTerminal}>
              {OPEN_TERMINAL_LABEL}
            </button>
          </div>
        </div>
        {output.status === "loading" && <p className="agent-actions__hint">reading…</p>}
        {output.status === "error" && (
          <p className="agent-actions__error" role="alert">
            {output.message}
          </p>
        )}
        {output.status === "ready" && (
          <>
            {output.truncated && (
              // The app's own words, rendered as its own affordance — never
              // spliced into `output.text` (security review, MINOR 5): an
              // agent's own transcript could otherwise contain this exact
              // sentence, and the user would have no way to tell which one
              // said it.
              <p className="agent-actions__truncated" role="status">
                ⚠ output truncated — showing only the most recent portion
              </p>
            )}
            <AnsiText
              className="agent-actions__text"
              text={output.text.length > 0 ? output.text : "(no output yet)"}
            />
          </>
        )}
      </div>
      {send.error !== null && (
        <p className="agent-actions__error" role="alert">
          {send.error}
        </p>
      )}
      {send.sent && <p className="agent-actions__hint">sent — watch above for the reply</p>}
      <div className="agent-actions__compose">
        <textarea
          className="agent-actions__prompt"
          value={prompt}
          placeholder="Message this agent… (Enter to send, Shift+Enter for a newline)"
          disabled={send.busy}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="agent-actions__send"
          onClick={handleSend}
          disabled={send.busy || prompt.trim().length === 0}
        >
          {send.busy ? "sending…" : "Send"}
        </button>
      </div>
      {/* THE WAY OUT TO THE REAL TERMINAL, on both screens, from the same
          component (sea/town consistency round). It is a secondary action
          at the foot of this agent's own panel — the exact placement the
          town's villager panel gave it, now shared rather than mirrored —
          and it says where it takes you, because it takes you OUT of the
          app. That distinction is the whole point: a villager click used
          to do this silently at sea, which is how the author ended up in
          iTerm without asking. */}
      <div className="agent-actions__external">
        <button
          type="button"
          className="agent-actions__raise"
          onClick={() => {
            // Fire-and-forget (principle 2: nothing on the attention path
            // waits on a round trip); the note below is the only thing
            // that ever depends on the answer.
            setRaiseNote(null);
            raiseExternalTerminal(agent).then(setRaiseNote);
          }}
          title={RAISE_EXTERNAL_TERMINAL_TITLE}
        >
          {RAISE_EXTERNAL_TERMINAL_LABEL}
        </button>
        {raiseNote !== null && (
          <span className="agent-actions__hint" role="status">
            {raiseNote}
          </span>
        )}
      </div>
    </div>
  );
}
