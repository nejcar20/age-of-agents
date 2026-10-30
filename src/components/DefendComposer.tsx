import { useEffect, useRef, useState } from "react";
import type { SwitchTarget } from "../agentSwitcher";
import { sendPrompt } from "../agents";
import { defendPrompt, type Finding } from "../raids";
import "../tradeRoutes.css";

/** The browser preview's wording for a send it will not make — the guide's
 * own sentence, so the preview says one thing about prompts everywhere. */
export const DEFEND_PREVIEW_NOTE = "Submitting prompts remains disabled in the preview.";

const MAX_PROMPT_CHARS = 20_000;

/**
 * Sending an agent to fix a raid. Built on `ScopedTaskComposer`'s shape and
 * its safety rules, minus the brief/review step (the findings ARE the brief):
 * a picker of this island's agents with a known kind, an editable prompt
 * prefilled by `defendPrompt`, one explicit Send, a busy guard so a double
 * click sends once, and a failure that keeps the text.
 *
 * `expectedRoot` is the ISLAND root, exactly as `ScopedTaskComposer` passes
 * it, even when the agent works in a worktree: the backend refuses a pane
 * id that was recycled into another island (`validate_send_prompt`), and a
 * worktree agent still belongs to this one. The raid itself is
 * keyed to the main checkout (spec decision 1), so the composer says plainly
 * when the agent is somewhere else.
 */
export function DefendComposer({ root, findings, targets, connected, onClose, onOpenTerminal, previewDisabled = false }: {
  root: string; findings: Finding[]; targets: SwitchTarget[]; connected: boolean;
  onClose: () => void; onOpenTerminal: (target: SwitchTarget) => void;
  /** The browser preview: everything renders, Send does not. */
  previewDisabled?: boolean;
}) {
  const eligible = targets.filter(t => t.root === root && t.agent.kind !== null);
  const [paneId, setPaneId] = useState(eligible[0]?.agent.pane_id ?? "");
  const chosen = eligible.find(t => t.agent.pane_id === paneId);
  const [prompt, setPrompt] = useState(() => defendPrompt(root, findings, chosen?.agent.cwd ?? null));
  // Which checkout the prompt was written for — the only thing about the
  // receiving agent `defendPrompt` depends on (it names the worktree). Text
  // written for one checkout must not go to an agent working in another.
  const [writtenFor, setWrittenFor] = useState<string | null>(() => chosen?.agent.cwd ?? null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  // A real modal, with the same focus containment and Escape handling as
  // `ScopedTaskComposer`: what it sends types into a live session.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current!;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled),select:not(:disabled),textarea:not(:disabled),input:not(:disabled)")];
    const contain = (event: FocusEvent) => { if (!dialog.contains(event.target as Node)) (promptRef.current ?? focusable()[0] ?? dialog).focus(); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busyRef.current) closeRef.current(); }
      if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
      const elements = focusable();
      if (!elements.length) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements[elements.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === elements[elements.length - 1]) { event.preventDefault(); elements[0].focus(); }
    };
    document.addEventListener("focusin", contain); dialog.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("focusin", contain); dialog.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { (sent ? doneRef.current : promptRef.current)?.focus(); }, [sent]);
  const writeFor = (target: SwitchTarget | undefined) => {
    const cwd = target?.agent.cwd ?? null;
    setPrompt(defendPrompt(root, findings, cwd));
    setWrittenFor(cwd);
  };
  // Untouched prefill follows the picker; once the user has edited the text
  // it is theirs, and only "Rewrite for this agent" replaces it.
  const untouched = prompt === defendPrompt(root, findings, writtenFor);
  const pick = (next: string) => {
    setPaneId(next);
    if (untouched) writeFor(eligible.find(t => t.agent.pane_id === next));
  };
  const current = !!chosen && writtenFor === chosen.agent.cwd;
  const promptLength = Array.from(prompt).length;
  const validPrompt = prompt.trim().length > 0 && promptLength <= MAX_PROMPT_CHARS;
  const worktree = chosen && chosen.agent.cwd !== root ? chosen.agent.cwd : null;
  const submit = async () => {
    if (busyRef.current || sent || previewDisabled || !connected || !chosen || !current || !validPrompt) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await sendPrompt(chosen.agent.pane_id, prompt, root); setSent(true); }
    catch (reason) { setError(`${String(reason)} Check the terminal before retrying; the orders are not resent automatically.`); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="trade-backdrop"><div className="trade-composer" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="defend-title">
    <header><div><span className="workbench__eyebrow">Defend the island</span><h2 id="defend-title">{sent ? "Orders sent" : "Send an agent to defend"}</h2></div><button className="trade-close" aria-label="Close" disabled={busy} onClick={onClose}>×</button></header>
    <div className="trade-composer__body">
      {sent ? <div className="trade-success" role="status"><h3>Your agent has its orders.</h3><p>Open its terminal to follow along. When it reports the fix, rescout this island: ships for fixed findings sink.</p></div> : <>
        <label className="trade-field">Receiving agent<select value={paneId} onChange={e => pick(e.target.value)} disabled={busy}><option value="">Choose an agent</option>{eligible.map(t => <option key={t.agent.pane_id} value={t.agent.pane_id}>{t.agent.title ?? t.agent.kind} · {t.agent.pane_id}</option>)}</select>{chosen && <small>{chosen.agent.cwd}{chosen.agent.is_worktree ? " · worktree" : ""}</small>}</label>
        {!eligible.length && <p className="trade-warning">Start an agent in this project first, then return to send it.</p>}
        {worktree !== null && <p className="trade-small" data-testid="defend-worktree-note">This agent works in <code>{worktree}</code>. The ships sink once the fix reaches <code>{root}</code>.</p>}
        <label className="trade-field">Message the agent will receive<textarea className="trade-prompt" ref={promptRef} value={prompt} onChange={e => setPrompt(e.target.value)} disabled={busy} spellCheck={false} /></label>
        {chosen && !current && <p className="trade-warning" role="alert">This message was written {writtenFor === null ? "before an agent was chosen" : <>for <code>{writtenFor}</code></>}; this agent works in <code>{chosen.agent.cwd}</code>. <button type="button" onClick={() => writeFor(chosen)}>Rewrite for this agent</button></p>}
        {promptLength > MAX_PROMPT_CHARS && <p className="trade-warning" role="alert">The message must fit within 20,000 characters.</p>}
        {previewDisabled && <p className="trade-warning">{DEFEND_PREVIEW_NOTE}</p>}
      </>}
      {!connected && !sent && <p className="trade-warning" role="alert">Herdr is offline. Reconnect before sending.</p>}
      {error && <p className="trade-warning" role="alert">{error}</p>}
    </div>
    <footer>{sent
      ? <><button ref={doneRef} onClick={onClose}>Done</button><button className="trade-primary" disabled={!chosen} onClick={() => { if (chosen) { onClose(); onOpenTerminal(chosen); } }}>Open receiving terminal</button></>
      : <><button disabled={busy} onClick={onClose}>Cancel</button><button className="trade-primary" aria-label="Send to agent" disabled={busy || previewDisabled || !chosen || !current || !connected || !validPrompt} onClick={submit}>{busy ? "Sending…" : "Send to agent"}</button></>}</footer>
  </div></div>;
}
