import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { SwitchTarget } from "../agentSwitcher";
import type { Island } from "../world";
import { decodeTradeRoutes, TRADE_ROUTES_KEY, type RoutePreset, type TradeRoute } from "../tradeRoutes";
import { TradeRouteComposer } from "./TradeRouteComposer";
import "../tradeRoutes.css";

type TradeRoutesContextValue = {
  routes: TradeRoute[];
  warning: string | null;
  open: (preset?: RoutePreset) => void;
  remove: (id: string) => void;
  openAgent: (route: TradeRoute) => void;
  targets: SwitchTarget[];
  showRoutes: () => void;
};
const Context = createContext<TradeRoutesContextValue | null>(null);
export const useTradeRoutes = () => useContext(Context);
type RouteStorage = Pick<Storage, "getItem" | "setItem">;
// Dev previews can supply an isolated memory store without writing fake routes
// into real saved history. The shipped application uses localStorage.
export const TradeRouteStorageContext = createContext<RouteStorage | null>(null);
const browserStorage: RouteStorage = {
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
};
const SESSION_WARNING = "This change is saved for this session only. Local storage is unavailable; it will not survive a reload.";

export function TradeRoutesProvider({ projects, targets, connected, onOpenAgent, onViewRoutes, children }: {
  projects: Island[]; targets: SwitchTarget[]; connected: boolean;
  onOpenAgent: (target: SwitchTarget) => void; onViewRoutes: () => void; children: ReactNode;
}) {
  const storage = useContext(TradeRouteStorageContext) ?? browserStorage;
  const [initial] = useState(() => {
    try { return { routes: decodeTradeRoutes(storage.getItem(TRADE_ROUTES_KEY)), warning: null }; }
    catch { return { routes: [], warning: "Saved routes could not be read. Your existing data has not been overwritten." }; }
  });
  const [routes, setRoutes] = useState<TradeRoute[]>(initial.routes);
  const [warning, setWarning] = useState<string | null>(initial.warning);
  const routesRef = useRef(routes);
  routesRef.current = routes;
  const pending = useRef(new Map<string, TradeRoute | null>());
  const [preset, setPreset] = useState<RoutePreset | null>(null);
  const open = useCallback((value: RoutePreset = {}) => setPreset(value), []);
  const close = useCallback(() => setPreset(null), []);

  const applyPending = useCallback((current: TradeRoute[]) => {
    const merged = new Map(current.map(route => [route.id, route]));
    for (const [id, route] of pending.current) {
      if (route) merged.set(id, route);
      else merged.delete(id);
    }
    return [...merged.values()];
  }, []);

  const changeRoutes = useCallback((id: string, route: TradeRoute | null) => {
    // Retain both additions and deletions until a write succeeds. Merging
    // entire stale snapshots would resurrect records removed in this window.
    pending.current.set(id, route);
    let updated = applyPending(routesRef.current);
    try {
      const persisted = decodeTradeRoutes(storage.getItem(TRADE_ROUTES_KEY));
      updated = applyPending(persisted);
      storage.setItem(TRADE_ROUTES_KEY, JSON.stringify({ version: 1, routes: updated }));
      pending.current.clear();
      setWarning(null);
    } catch {
      setWarning(SESSION_WARNING);
    }
    routesRef.current = updated;
    setRoutes(updated);
  }, [storage, applyPending]);

  useEffect(() => {
    if (storage !== browserStorage) return;
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== TRADE_ROUTES_KEY) return;
      try {
        const next = applyPending(decodeTradeRoutes(event.newValue));
        routesRef.current = next; setRoutes(next);
        setWarning(pending.current.size ? SESSION_WARNING : null);
      }
      catch { setWarning("Saved routes changed but could not be read. The routes already open here are still available."); }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [storage, applyPending]);

  const openAgent = (route: TradeRoute) => {
    const target = targets.find(t => t.root === route.targetRoot && t.agent.pane_id === route.paneId && t.agent.cwd === route.targetCwd && t.agent.kind === route.agentKind);
    if (target) { close(); onOpenAgent(target); }
  };

  return <Context.Provider value={{ routes, warning, open, remove: id => changeRoutes(id, null), openAgent, targets, showRoutes: onViewRoutes }}>
    {children}
    {preset && <TradeRouteComposer projects={projects} targets={targets} connected={connected} preset={preset}
      onClose={close} onSent={route => changeRoutes(route.id, route)} onOpenAgent={openAgent} warning={warning} />}
  </Context.Provider>;
}

export function TradeRoutesPage() {
  const trade = useTradeRoutes();
  if (!trade) return null;
  return <div className="workbench__content trade-page">
    <section className="workbench__intro">
      <div><div className="workbench__eyebrow">Better together</div><h1>Trade routes</h1><p>Give an agent a project to learn from. Bring the good parts home.</p></div>
      <button className="workbench__primary" onClick={() => trade.open()}>+ Establish a route</button>
    </section>
    {trade.warning && <p className="trade-warning" role="status">{trade.warning}</p>}
    {trade.routes.length === 0 ? <div className="trade-empty">
      <div className="trade-illustration" aria-hidden="true"><span>⌂</span><i /><span>⌂</span></div>
      <h2>A small project. A bigger possibility.</h2>
      <p>Connect a prototype, a useful library, or an older project to an agent working on your next idea.</p>
      <button onClick={() => trade.open()}>Create your first trade route <span aria-hidden="true">→</span></button>
      <small>You review the brief before sending. Routes never send messages on their own.</small>
    </div> : <div className="trade-list">
      {[...trade.routes].sort((a, b) => b.createdAt - a.createdAt).map(route => {
        const available = trade.targets.some(t => t.root === route.targetRoot && t.agent.pane_id === route.paneId && t.agent.cwd === route.targetCwd && t.agent.kind === route.agentKind);
        return <article className="trade-card" key={route.id}>
          <div className="trade-card__connection"><div><small>Reference</small><strong>{route.sourceName}</strong><span title={route.sourceRoot}>{route.sourceRoot}</span></div><span className="trade-arrow" aria-label="to">⤳</span><div><small>Destination</small><strong>{route.targetName}</strong><span title={route.targetRoot}>{route.targetRoot}</span></div></div>
          <p className="trade-card__brief">{route.brief}</p>
          <div className="trade-card__meta"><span className="trade-sent">Brief sent</span><span>{route.mode === "plan" ? "Inspect first" : "Implementation requested"}</span><time dateTime={new Date(route.createdAt).toISOString()}>{new Date(route.createdAt).toLocaleString()}</time></div>
          <details><summary>View the submitted brief</summary><pre>{route.prompt}</pre><p>Sent to {route.agentTitle} · {route.paneId}</p></details>
          <footer><button onClick={() => trade.openAgent(route)} disabled={!available}>{available ? "Open receiving terminal ↗" : "Receiving agent is no longer available"}</button><button className="trade-remove" onClick={() => trade.remove(route.id)} title="Removes this saved route. It does not stop the agent or undo code changes.">Remove route</button></footer>
        </article>;
      })}
    </div>}
    <p className="trade-footnote">A route records a brief you sent, not a completed integration. Follow the receiving agent for progress.</p>
  </div>;
}
