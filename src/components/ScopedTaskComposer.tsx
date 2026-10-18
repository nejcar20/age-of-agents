import { useEffect, useRef, useState } from "react";
import type { SwitchTarget } from "../agentSwitcher";
import { sendPrompt } from "../agents";
import { buildScopedPrompt, type CodeSelection } from "../inspection";
import type { TradeMode } from "../tradeRoutes";
import "../tradeRoutes.css";

export function ScopedTaskComposer({ root, selection, targets, connected, onClose, onOpenTerminal }: {
  root: string; selection: CodeSelection; targets: SwitchTarget[]; connected: boolean;
  onClose: () => void; onOpenTerminal: (target: SwitchTarget) => void;
}) {
  const eligible = targets.filter(t => t.root === root && t.agent.kind !== null);
  const [paneId, setPaneId] = useState(eligible[0]?.agent.pane_id ?? "");
  const [brief, setBrief] = useState("");
  const [mode, setMode] = useState<TradeMode>("plan");
  const [receiver, setReceiver] = useState<SwitchTarget | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current!;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled),select:not(:disabled),textarea:not(:disabled),input:not(:disabled)")];
    const contain = (event: FocusEvent) => { if (!dialog.contains(event.target as Node)) (taskRef.current ?? promptRef.current ?? focusable()[0] ?? dialog).focus(); };
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
  useEffect(() => { (sent ? doneRef.current : receiver ? promptRef.current : taskRef.current)?.focus(); }, [receiver, sent]);
  const chosen = eligible.find(t => t.agent.pane_id === paneId);
  const liveReceiver = receiver && eligible.find(t => t.agent.pane_id === receiver.agent.pane_id && t.agent.cwd === receiver.agent.cwd && t.agent.kind === receiver.agent.kind);
  const validPrompt = prompt.trim().length > 0 && Array.from(prompt).length <= 20_000;
  const review = () => {
    if (!chosen || !brief.trim()) return;
    setPrompt(buildScopedPrompt({ root, cwd: chosen.agent.cwd, ...selection, brief, mode }));
    setReceiver(chosen); setError(null);
  };
  const submit = async () => {
    if (busyRef.current || sent || !connected || !receiver || !liveReceiver || !validPrompt) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await sendPrompt(receiver.agent.pane_id, prompt, root); setSent(true); }
    catch (reason) { setError(`${String(reason)} Check the terminal before retrying; the task is not resent automatically.`); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="trade-backdrop"><div className="trade-composer" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="scoped-task-title">
    <header><div><span className="workbench__eyebrow">Work from the town</span><h2 id="scoped-task-title">{sent ? "Task sent" : receiver ? "Review the task" : "Ask an agent"}</h2></div><button className="trade-close" aria-label="Close task" disabled={busy} onClick={onClose}>×</button></header>
    <div className="trade-composer__body">
      <div className="town-task-scope"><span>{selection.kind === "directory" ? "District" : "File"}</span><code>{selection.path}</code></div>
      {sent ? <div className="trade-success" role="status"><h3>Your agent has the brief.</h3><p>Open its terminal to follow the response. The submitted task does not imply that changes are complete.</p></div> : receiver ? <>
        <p className="trade-small">To {receiver.agent.title ?? receiver.agent.kind} · {receiver.agent.cwd}</p>
        <label className="trade-field">Message the agent will receive<textarea className="trade-prompt" ref={promptRef} value={prompt} onChange={e => setPrompt(e.target.value)} disabled={busy} spellCheck={false} /></label>
        {!liveReceiver && <p className="trade-warning" role="alert">The selected agent changed or is no longer available. Go back and choose a receiver.</p>}
        {Array.from(prompt).length > 20_000 && <p className="trade-warning" role="alert">The message must fit within 20,000 characters.</p>}
      </> : <>
        <label className="trade-field">Receiving agent<select value={paneId} onChange={e => setPaneId(e.target.value)}><option value="">Choose an agent</option>{eligible.map(t => <option key={t.agent.pane_id} value={t.agent.pane_id}>{t.agent.title ?? t.agent.kind} · {t.agent.pane_id}</option>)}</select>{chosen && <small>{chosen.agent.cwd}{chosen.agent.is_worktree ? " · worktree" : ""}</small>}</label>
        {!eligible.length && <p className="trade-warning">Start an agent in this project first, then return to give it a task.</p>}
        <label className="trade-field">Task<textarea ref={taskRef} value={brief} onChange={e => setBrief(e.target.value)} placeholder="Review the authentication flow and propose tests for token expiry." maxLength={16000} rows={4} /></label>
        <div className="town-task-suggestions">{["Explain how this works", "Review for bugs", "Add useful tests"].map(text => <button key={text} onClick={() => { setBrief(text); taskRef.current?.focus(); }}>{text}</button>)}</div>
        <fieldset className="trade-modes"><legend>How should the agent start?</legend><label className={mode === "plan" ? "selected" : ""}><input type="radio" name="task-mode" checked={mode === "plan"} onChange={() => setMode("plan")} /><span><strong>Inspect & propose</strong><small>Bring back findings before editing.</small></span></label><label className={mode === "implement" ? "selected" : ""}><input type="radio" name="task-mode" checked={mode === "implement"} onChange={() => setMode("implement")} /><span><strong>Start implementing</strong><small>Make changes in the agent’s worktree.</small></span></label></fieldset>
      </>}
      {!connected && !sent && <p className="trade-warning" role="alert">Herdr is offline. Reconnect before sending.</p>}
      {error && <p className="trade-warning" role="alert">{error}</p>}
    </div>
    <footer>{sent ? <><button ref={doneRef} onClick={onClose}>Done</button><button className="trade-primary" disabled={!liveReceiver} onClick={() => { if (liveReceiver) { onClose(); onOpenTerminal(liveReceiver); } }}>Open receiving terminal</button></> : receiver ? <><button disabled={busy} onClick={() => { setReceiver(null); setError(null); }}>Edit task</button><button className="trade-primary" disabled={busy || !liveReceiver || !connected || !validPrompt} onClick={submit}>{busy ? "Sending…" : "Send task"}</button></> : <><button onClick={onClose}>Cancel</button><button className="trade-primary" disabled={!chosen || !brief.trim()} onClick={review}>Review task</button></>}</footer>
  </div></div>;
}
