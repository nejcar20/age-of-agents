import { useEffect, useRef, useState } from "react";
import { sendPrompt } from "../agents";
import type { SwitchTarget } from "../agentSwitcher";
import type { Island } from "../world";
import { buildTradePrompt, type RoutePreset, type TradeMode, type TradeRoute } from "../tradeRoutes";

type Draft = Omit<TradeRoute, "id" | "createdAt">;

export function TradeRouteComposer({ projects, targets, connected, preset, onClose, onSent, onOpenAgent, warning }: {
  projects: Island[]; targets: SwitchTarget[]; connected: boolean; preset: RoutePreset;
  onClose: () => void; onSent: (route: TradeRoute) => void; onOpenAgent: (route: TradeRoute) => void;
  warning: string | null;
}) {
  const eligible = targets.filter(t => t.agent.kind !== null);
  const initialRoot = preset.targetRoot ?? eligible.find(t => t.root !== preset.sourceRoot)?.root ?? "";
  const [sourceRoot, setSourceRoot] = useState(preset.sourceRoot ?? projects.find(p => p.root !== initialRoot)?.root ?? "");
  const [targetRoot, setTargetRoot] = useState(initialRoot);
  const [paneId, setPaneId] = useState(preset.paneId ?? eligible.find(t => t.root === initialRoot)?.agent.pane_id ?? "");
  const [mode, setMode] = useState<TradeMode>("plan");
  const [brief, setBrief] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<TradeRoute | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLTextAreaElement>(null);
  const sourceRef = useRef<HTMLSelectElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current!;
    const elements = () => [...dialog.querySelectorAll<HTMLElement>("select:not(:disabled), textarea:not(:disabled), button:not(:disabled), input:not(:disabled)")];
    const focusFirst = () => (elements()[0] ?? dialog).focus();
    const contain = (event: FocusEvent) => { if (!dialog.contains(event.target as Node)) focusFirst(); };
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busyRef.current) closeRef.current(); }
      if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
      const all = elements();
      if (!all.length) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && document.activeElement === all[0]) { event.preventDefault(); all[all.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === all[all.length - 1]) { event.preventDefault(); all[0].focus(); }
    };
    focusFirst();
    document.addEventListener("focusin", contain);
    dialog.addEventListener("keydown", keys);
    return () => { document.removeEventListener("focusin", contain); dialog.removeEventListener("keydown", keys); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (sent) doneRef.current?.focus();
    else if (draft) reviewRef.current?.focus();
    else sourceRef.current?.focus();
  }, [draft, sent]);

  const source = projects.find(p => p.root === sourceRoot);
  const destination = projects.find(p => p.root === targetRoot);
  const receiver = eligible.find(t => t.root === targetRoot && t.agent.pane_id === paneId);
  const canReview = source && destination && sourceRoot !== targetRoot && receiver && brief.trim();
  const currentReceiver = draft && eligible.find(t => t.root === draft.targetRoot && t.agent.pane_id === draft.paneId && t.agent.cwd === draft.targetCwd && t.agent.kind === draft.agentKind);
  const referenceAvailable = draft && projects.some(p => p.root === draft.sourceRoot);
  const promptLength = Array.from(prompt).length;

  const review = () => {
    if (!canReview || !source || !destination || !receiver) return;
    const text = buildTradePrompt({ source, destination, cwd: receiver.agent.cwd, mode, brief });
    setDraft({ sourceRoot, sourceName: source.name, targetRoot, targetName: destination.name, paneId,
      agentTitle: receiver.agent.title ?? receiver.agent.kind ?? paneId, agentKind: receiver.agent.kind!,
      targetCwd: receiver.agent.cwd, mode, brief: brief.trim(), prompt: text });
    setPrompt(text);
    setError(null);
  };

  const submit = async () => {
    if (busyRef.current || sent || !draft || !currentReceiver || !referenceAvailable || !connected || !prompt.trim() || promptLength > 20_000) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let route: TradeRoute;
    try {
      route = { ...draft, prompt, id: crypto.randomUUID(), createdAt: Date.now() };
      await sendPrompt(draft.paneId, prompt, draft.targetRoot);
    } catch (reason) {
      setError(`${String(reason)} Check the receiving terminal before trying again; nothing is retried automatically.`);
      busyRef.current = false;
      setBusy(false);
      return;
    }
    setSent(route);
    onSent(route);
    busyRef.current = false;
    setBusy(false);
  };

  return <div className="trade-backdrop">
    <div className="trade-composer" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="trade-title" tabIndex={-1}>
      <header><div><span className="workbench__eyebrow">Project connections</span><h2 id="trade-title">{sent ? "Route established" : draft ? "Review the handoff" : "Establish a trade route"}</h2></div><button className="trade-close" onClick={onClose} disabled={busy} aria-label="Close trade route">×</button></header>
      <div className="trade-composer__body">
        {sent ? <div className="trade-success" role="status">
          <span className="trade-success__mark" aria-hidden="true">⤳</span><h3>{sent.sourceName} → {sent.targetName}</h3>
          <p>Your brief was sent to <strong>{sent.agentTitle}</strong>. Follow the receiving agent for its response.</p>
          {warning && <p className="trade-warning">{warning}</p>}
          <p>The connection will appear in World while both projects are visible.</p>
        </div> : draft ? <>
          <div className="trade-handoff"><span><small>Read from</small><strong>{draft.sourceName}</strong><code>{draft.sourceRoot}</code></span><b aria-hidden="true">→</b><span><small>Send to</small><strong>{draft.agentTitle}</strong><code>{draft.targetCwd}</code></span></div>
          <label className="trade-field">Message the agent will receive<textarea ref={reviewRef} className="trade-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={busy} spellCheck={false} /></label>
          <p className="trade-small">You can edit every word. Sending submits this message once to {draft.paneId} in {draft.targetName}.</p>
          {!currentReceiver && <p className="trade-warning" role="alert">The selected agent is no longer available in this working directory. Go back and choose a receiving agent.</p>}
          {!referenceAvailable && <p className="trade-warning" role="alert">The reference project is no longer in your project list. Go back to choose a project.</p>}
          {promptLength > 20_000 && <p className="trade-warning" role="alert">The message must be no longer than 20,000 characters.</p>}
        </> : <>
          <p className="trade-lede">A prototype today. Part of something bigger tomorrow.</p>
          <div className="trade-project-pickers">
            <label className="trade-field"><span><i>01</i> Reference project</span><select ref={sourceRef} value={sourceRoot} onChange={event => setSourceRoot(event.target.value)}><option value="">Choose a project</option>{projects.map(p => <option key={p.root} value={p.root} disabled={p.root === targetRoot}>{p.name}</option>)}</select><small>{source?.root ?? "The project with something worth bringing over."}</small></label>
            <span className="trade-picker-arrow" aria-hidden="true">→</span>
            <label className="trade-field"><span><i>02</i> Destination project</span><select value={targetRoot} onChange={event => { const root = event.target.value; setTargetRoot(root); setPaneId(eligible.find(t => t.root === root)?.agent.pane_id ?? ""); }}><option value="">Choose a project</option>{projects.map(p => <option key={p.root} value={p.root} disabled={p.root === sourceRoot}>{p.name}</option>)}</select><small>{destination?.root ?? "The project you want to improve."}</small></label>
          </div>
          <label className="trade-field">Receiving agent<select value={paneId} onChange={event => setPaneId(event.target.value)}><option value="">Choose an agent</option>{eligible.filter(t => t.root === targetRoot).map(t => <option key={t.agent.pane_id} value={t.agent.pane_id}>{t.agent.title ?? t.agent.kind} · {t.agent.pane_id}</option>)}</select>{receiver && <small>{receiver.agent.kind} · {receiver.agent.cwd}{receiver.agent.is_worktree ? " · worktree" : ""}</small>}</label>
          {targetRoot && !eligible.some(t => t.root === targetRoot) && <p className="trade-small">Start an agent in this destination project first. Then come back to establish the route.</p>}
          <label className="trade-field">What should travel across?<textarea value={brief} onChange={event => setBrief(event.target.value)} placeholder="Bring this prototype’s editor into the main app. Keep our existing design and save format." rows={4} maxLength={16000} /></label>
          <fieldset className="trade-modes"><legend>How should the agent start?</legend>
            <label className={mode === "plan" ? "selected" : ""}><input type="radio" name="trade-mode" checked={mode === "plan"} onChange={() => setMode("plan")} /><span><strong>Inspect & propose</strong><small>Understand both projects and bring back a plan.</small></span></label>
            <label className={mode === "implement" ? "selected" : ""}><input type="radio" name="trade-mode" checked={mode === "implement"} onChange={() => setMode("implement")} /><span><strong>Start implementing</strong><small>Adapt the code in the destination project.</small></span></label>
          </fieldset>
          <p className="trade-small">The reference stays read-only in the generated brief. The agent uses its existing access to your local projects.</p>
        </>}
        {!connected && !sent && <p className="trade-warning" role="alert">Herdr is offline. You can prepare the brief and send it after reconnecting.</p>}
        {error && <p className="trade-warning" role="alert">{error}</p>}
      </div>
      <footer>{sent ? <><button ref={doneRef} onClick={onClose}>Done</button><button className="trade-primary" disabled={!currentReceiver} onClick={() => onOpenAgent(sent)}>Open receiving terminal ↗</button></> : draft ? <><button onClick={() => { setDraft(null); setError(null); }} disabled={busy}>← Edit route</button><button className="trade-primary" onClick={submit} disabled={busy || !connected || !currentReceiver || !referenceAvailable || !prompt.trim() || promptLength > 20_000}>{busy ? "Sending brief…" : "Establish route & send"}</button></> : <><button onClick={onClose}>Cancel</button><button className="trade-primary" onClick={review} disabled={!canReview}>Review brief →</button></>}</footer>
    </div>
  </div>;
}
