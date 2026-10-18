import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { SwitchTarget } from "../agentSwitcher";
import { TerminalStageProvider, useTerminalStage } from "../terminalStage";
import { Terminal } from "./Terminal";
import "../terminalDock.css";

const targetKey = (target: SwitchTarget) => JSON.stringify([target.root, target.agent.pane_id]);
export function TerminalDock({ primary, targets, onSwitch, onClose, children }: {
  primary: SwitchTarget | null; targets: SwitchTarget[]; onSwitch: (target: SwitchTarget) => void;
  onClose: () => void; children?: ReactNode;
}) {
  const [position, setPosition] = useState<"bottom" | "right">("bottom");
  const [narrow, setNarrow] = useState(false);
  const placement = narrow ? "bottom" : position;
  const [size, setSize] = useState(46);
  const [second, setSecond] = useState<SwitchTarget | null>(null);
  const [active, setActive] = useState<0 | 1 | null>(0);
  const [note, setNote] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const dragRef = useRef(false);
  const primaryKey = primary ? targetKey(primary) : null;
  const secondary = second && targets.find(t => targetKey(t) === targetKey(second) && t.agent.cwd === second.agent.cwd && t.agent.kind === second.agent.kind) || null;
  const alternatives = targets.filter(t => targetKey(t) !== primaryKey);
  useEffect(() => {
    const update = () => { const width = containerRef.current?.getBoundingClientRect().width ?? 0; setNarrow(width > 0 && width <= 620); };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (containerRef.current) observer?.observe(containerRef.current);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  useEffect(() => {
    const leaveDock = (event: Event) => { if (event.target instanceof Node && !dockRef.current?.contains(event.target)) setActive(null); };
    document.addEventListener("pointerdown", leaveDock);
    document.addEventListener("focusin", leaveDock);
    return () => { document.removeEventListener("pointerdown", leaveDock); document.removeEventListener("focusin", leaveDock); };
  }, []);
  useEffect(() => {
    setActive(0);
    if (!primaryKey) setSecond(null);
  }, [primaryKey]);
  useEffect(() => {
    if (second && !secondary) { setSecond(null); setActive(0); setNote("The second terminal is no longer available. Its view was detached."); }
    else if (secondary && targetKey(secondary) === primaryKey) { setSecond(null); setActive(0); }
  }, [second, secondary, primaryKey]);
  const closePrimary = useCallback(() => {
    if (secondary) { onSwitch(secondary); setSecond(null); setActive(0); }
    else onClose();
  }, [secondary, onSwitch, onClose]);
  const closeSecond = useCallback(() => { setSecond(null); setActive(0); }, []);
  const split = () => { if (alternatives[0]) { setSecond(alternatives[0]); setActive(1); setNote(null); } };
  const resize = (x: number, y: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const extent = placement === "bottom" ? rect.height : rect.width;
    if (extent <= 0) return;
    const pixels = placement === "bottom" ? rect.bottom - y : rect.right - x;
    setSize(Math.max(25, Math.min(75, pixels / extent * 100)));
  };
  const style = { "--dock-size": `${size}%` } as CSSProperties;
  return <div ref={containerRef} className={`terminal-dock-layout terminal-dock-layout--${placement}${primary ? " terminal-dock-layout--open" : ""}${children ? "" : " terminal-dock-layout--solo"}`} style={style}>
    <div className="terminal-dock-layout__content">{children}</div>
    {primary && <>
      {children && <div className="terminal-dock__resize" role="separator" aria-label="Resize terminal dock" aria-orientation={placement === "bottom" ? "horizontal" : "vertical"} aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(size)} tabIndex={0}
        onPointerDown={event => { event.preventDefault(); dragRef.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (dragRef.current) resize(event.clientX, event.clientY); }}
        onPointerUp={event => { dragRef.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { dragRef.current = false; }}
        onKeyDown={event => { if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); setSize(current => event.key === "Home" ? 25 : event.key === "End" ? 75 : Math.max(25, Math.min(75, current + (["ArrowUp", "ArrowLeft"].includes(event.key) ? 5 : -5)))); }} />}
      <section ref={dockRef} className="terminal-dock" aria-label="Terminal dock" onFocusCapture={() => { if (active === null) setActive(0); }}>
        <header className="terminal-dock__header"><strong>Terminals <span>{secondary ? 2 : 1}</span></strong><div>
          {children && !narrow && <button onClick={() => setPosition(value => value === "bottom" ? "right" : "bottom")} title="Choose where the terminal sits beside the town">{position === "bottom" ? "Dock right" : "Dock below"}</button>}
          <button disabled={!alternatives.length || !!secondary} onClick={split}>Split terminal</button>
          <button aria-label="Close terminal dock" onClick={() => { setSecond(null); onClose(); }}>×</button>
        </div></header>
        {note && <p className="terminal-dock__notice" role="status">{note}<button aria-label="Dismiss terminal notice" onClick={() => setNote(null)}>×</button></p>}
        <div className={`terminal-dock__panes${secondary ? " terminal-dock__panes--split" : ""}`}>
          <DockPane label="First terminal" target={primary} targets={targets.filter(t => !secondary || targetKey(t) !== targetKey(secondary))} active={active === 0} onActivate={() => setActive(0)} onSwitch={onSwitch} onClose={closePrimary} />
          {secondary && <DockPane label="Second terminal" target={secondary} targets={alternatives} active={active === 1} onActivate={() => setActive(1)} onSwitch={target => { setSecond(target); setActive(1); }} onClose={closeSecond} />}
        </div>
      </section>
    </>}
  </div>;
}

function DockPane({ label, target, targets, active, onActivate, onSwitch, onClose }: {
  label: string; target: SwitchTarget; targets: SwitchTarget[]; active: boolean;
  onActivate: () => void; onSwitch: (target: SwitchTarget) => void; onClose: () => void;
}) {
  const parent = useTerminalStage();
  const stage = useMemo(() => ({ ...parent, targets, switchTo: onSwitch }), [parent, targets, onSwitch]);
  return <div className={`terminal-dock__pane${active ? " terminal-dock__pane--active" : ""}`} onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
    <label className="terminal-dock__picker"><span>{label}</span><select aria-label={label} value={targetKey(target)} onChange={event => { const next = targets.find(t => targetKey(t) === event.target.value); if (next) onSwitch(next); }}>{targets.map(t => <option key={targetKey(t)} value={targetKey(t)}>{t.islandName} · {t.agent.title ?? t.agent.kind ?? t.agent.pane_id}</option>)}</select></label>
    <TerminalStageProvider stage={stage}><Terminal key={targetKey(target)} agent={target.agent} root={target.root} embedded initialMode="direct" autoFocus active={active} onClose={onClose} /></TerminalStageProvider>
  </div>;
}
