import { useEffect, useId, useRef, useState } from "react";
import { sendPrompt } from "../agents";
import type { Agent } from "../world";

const MAX_PROMPT_CHARS = 20_000;

export function TerminalPromptComposer({ agent, root, open, active, unavailable, onClose }: {
  agent: Agent;
  root: string;
  open: boolean;
  active: boolean;
  unavailable: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const pendingRef = useRef(false);
  const wasOpenRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const hintId = useId();
  const count = Array.from(draft).length;
  const unknownAgent = !agent.kind?.trim();
  const canSend = !unknownAgent && !unavailable && !busy && draft.trim().length > 0 && count <= MAX_PROMPT_CHARS;

  useEffect(() => {
    const opening = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    // Re-activating a split must preserve the control its user selected.
    if (opening && active) inputRef.current?.focus();
  }, [open, active]);

  const send = async () => {
    if (!canSend || pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setError(null);
    setSent(false);
    try {
      await sendPrompt(agent.pane_id, draft, root);
      setDraft("");
      setSent(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  };

  return <section className="terminal__composer" hidden={!open} aria-label="Compose agent prompt" onKeyDown={event => event.stopPropagation()}>
    <div className="terminal__composer-heading">
      <label htmlFor={inputId}>Agent prompt</label>
      <span>{agent.title ?? agent.pane_id} · {agent.pane_id}</span>
      <button type="button" aria-label="Close prompt composer" onClick={onClose}>×</button>
    </div>
    <textarea ref={inputRef} id={inputId} aria-describedby={hintId} value={draft} disabled={busy || unknownAgent}
      rows={4} placeholder="Write a multiline task for this agent…"
      onChange={event => { setDraft(event.target.value); setError(null); setSent(false); }} />
    <div className="terminal__composer-footer">
      <span id={hintId}>Enter adds a line. Send submits the whole prompt.</span>
      <span className={count > MAX_PROMPT_CHARS ? "terminal__composer-limit" : ""}>{count.toLocaleString()} / 20,000</span>
      <button type="button" disabled={!canSend} onClick={() => { void send(); }}>{busy ? "Sending…" : "Send prompt"}</button>
    </div>
    {unknownAgent && <p>No agent kind is reported for this pane. Use the terminal for shell input.</p>}
    {unavailable && <p>The pane is unavailable. Your draft is kept until it reconnects.</p>}
    {count > MAX_PROMPT_CHARS && <p role="alert">Shorten the prompt to 20,000 characters before sending.</p>}
    {error && <p className="terminal__composer-error" role="alert">{error}</p>}
    {sent && <p role="status">Prompt sent.</p>}
  </section>;
}
