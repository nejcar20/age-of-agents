import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { switchTargets, type SwitchTarget } from "../agentSwitcher";
import { useTerminalAttachment } from "../terminalAttachment";
import { TerminalStageProvider, useTerminalStageHost } from "../terminalStage";
import { useArchipelago } from "../useArchipelago";
import { useWorld } from "../useWorld";
import { useHotkey } from "../useHotkey";
import { matchesAgent, matchesProject, workspaceProjects } from "../workspace";
import { ATTENTION_LABEL, type Attention, type Island } from "../world";
import { NewProjectPanel } from "./NewProjectPanel";
import { useStartAgentFlow } from "./StartAgent";
import { TerminalDock } from "./TerminalDock";
import "../workbench.css";
import { TradeRoutesProvider, TradeRoutesPage } from "./TradeRoutes";
import { HerdrSetupCard, HerdrSetupStrip, WorldLegend } from "./HerdrSetup";

type Filter = "all" | "stopped" | "working";
const statusText: Record<Attention, string> = { stopped: "Needs you", working: "Working", quiet: "Idle", unknown: "Unknown" };

export function IslandMark({ small = false }: { small?: boolean }) {
  return <svg className={small ? "island-mark island-mark--small" : "island-mark"} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <path d="m4 25 16-8 16 8-16 9L4 25Z" fill="currentColor" opacity=".22" />
    <path d="m4 21 16-8 16 8-16 9L4 21Z" stroke="currentColor" strokeWidth="1.6" />
    <path d="M13 20V11l7-4 7 4v9l-7 4-7-4Z" fill="currentColor" opacity=".8" />
    <path d="m13 11 7 4 7-4M20 15v9" stroke="#101f2b" strokeWidth="1.4" />
  </svg>;
}

type View = "work" | "world" | "routes";
const VIEW_KEY = "aoa.workspaceView";

/** The view the user last chose; on a first launch with nothing on the agent
 * desk, the world — the map is what explains this app, an empty desk does not. */
function startingView(hasAgents: boolean): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "work" || saved === "world" || saved === "routes") return saved;
  } catch { /* No storage: fall through to the first-launch choice. */ }
  return hasAgents ? "work" : "world";
}

/** `initialView` is screenshot-harness-only: start on a given view. The
 * shipped app never passes it. */
export function Workbench({ renderAtlas, initialView }: { renderAtlas: () => ReactNode; initialView?: View }) {
  const world = useWorld();
  const discovery = useArchipelago();
  const projects = useMemo(() => workspaceProjects(discovery.kind === "ready" ? discovery.islands : [], world.islands), [discovery, world.islands]);
  const targets = useMemo(() => switchTargets(world.islands), [world.islands]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [view, setViewState] = useState<View>(() => initialView ?? startingView(world.islands.some(island => island.agents.length > 0)));
  const setView = useCallback((next: View) => {
    setViewState(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* Session-only preference. */ }
  }, []);
  const [newProject, setNewProject] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { attachment, attached, attach, detach } = useTerminalAttachment(world.islands, setNote);
  const selectAgent = useCallback((target: SwitchTarget) => {
    setView("work");
    setSidebarOpen(false);
    setSelectedRoot(target.root);
    setNote(null);
    attach(target.agent.pane_id, target.root);
  }, [attach]);
  const { stage } = useTerminalStageHost(targets, selectAgent);
  const waiting = targets.filter(target => target.agent.attention === "stopped");
  const working = targets.filter(target => target.agent.attention === "working");
  const selected = projects.find(project => project.root === selectedRoot) ?? null;
  const shownProjects = projects.filter(project => matchesProject(project, query));
  const shownAgents = targets.filter(target =>
    (selectedRoot === null || target.root === selectedRoot) &&
    (filter === "all" || target.agent.attention === filter) &&
    matchesAgent(target.agent, { name: target.islandName, root: target.root }, query),
  );

  const nextWaiting = useCallback(() => {
    const current = waiting.findIndex(target => target.agent.pane_id === attachment?.paneId);
    const next = waiting[(current + 1) % waiting.length];
    if (next) selectAgent(next);
    else setNote("No agents need your attention right now.");
  }, [waiting, attachment, selectAgent]);
  useHotkey(" ", nextWaiting, { enabled: view === "work" && attachment === null });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "k" && !event.altKey) {
        // A dialog owns its keyboard until it closes.
        if (document.querySelector('[role="dialog"]')) return;
        if (event.target instanceof Element && event.target.closest('textarea, select, [contenteditable="true"], .terminal input')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (window.innerWidth <= 620) setSidebarOpen(true);
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => { if (sidebarOpen) searchRef.current?.focus(); }, [sidebarOpen]);

  const showOverview = () => { setSidebarOpen(false); detach(); setSelectedRoot(null); setQuery(""); setFilter("all"); setView("work"); };
  const selectProject = (project: Island) => { setSidebarOpen(false); detach(); setSelectedRoot(project.root); setFilter("all"); setView("work"); };

  return <TradeRoutesProvider projects={projects} targets={targets} connected={world.herdr_connected} onOpenAgent={selectAgent} onViewRoutes={() => { detach(); setView("routes"); }}><div className={`workbench${sidebarOpen ? " workbench--sidebar-open" : ""}`}>
    <aside className="workbench__sidebar" aria-label="Project navigation">
      <button className="workbench__brand" onClick={showOverview} aria-label="Age of Agents home">
        <IslandMark /><span>Age of Agents<small>Your local command center</small></span>
      </button>
      <div className="workbench__search">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
        <input ref={searchRef} type="search" aria-label="Search projects and agents" placeholder="Find a project or agent" value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter") {
              const target = targets.find(t => matchesAgent(t.agent, { name: t.islandName, root: t.root }, query));
              if (target) selectAgent(target);
              else if (shownProjects[0]) selectProject(shownProjects[0]);
            }
            if (event.key === "Escape") { event.stopPropagation(); setQuery(""); searchRef.current?.blur(); }
          }} />
        <kbd>⌘K</kbd>
      </div>
      <nav className="workbench__nav" aria-label="Views">
        <button aria-current={selectedRoot === null && view === "work" ? "page" : undefined} onClick={showOverview}><span aria-hidden="true">▦</span>Overview<span className="workbench__count">{targets.length}</span></button>
        <button aria-current={view === "world" ? "page" : undefined} onClick={() => { setSidebarOpen(false); detach(); setView("world"); }}><IslandMark small />World<span className="workbench__nav-detail">Explore</span></button>
        <button aria-current={view === "routes" ? "page" : undefined} onClick={() => { setSidebarOpen(false); detach(); setView("routes"); }}><span aria-hidden="true">⤳</span>Trade routes<span className="workbench__nav-detail">Connect</span></button>
      </nav>
      <div className="workbench__section-label"><span>Projects</span><span>{projects.length}</span></div>
      <div className="workbench__projects">
        {shownProjects.map(project => <button key={project.root} className={`project-link ${selectedRoot === project.root && view === "work" ? "project-link--selected" : ""}`}
          onClick={() => selectProject(project)} title={project.root} aria-current={selectedRoot === project.root && view === "work" ? "page" : undefined}>
          <span className={`state-dot state-dot--${project.attention}`} /><span className="project-link__name">{project.name}<small>{project.root}</small></span>
          {project.agents.length > 0 && <span className="project-link__count">{project.agents.length}</span>}
        </button>)}
        {shownProjects.length === 0 && <p className="workbench__muted">{query ? "No matching projects." : discovery.kind === "loading" ? "Finding your repositories…" : "Your repositories will appear here."}</p>}
      </div>
      <button className="workbench__new" onClick={() => setNewProject(true)} disabled={!world.herdr_connected}><span aria-hidden="true">+</span>New project</button>
      <div className="workbench__connection"><span className={`state-dot state-dot--${world.herdr_connected ? "online" : "unknown"}`} /><span>{world.herdr_connected ? "Connected to Herdr" : "Herdr is offline"}<small>Local to this Mac</small></span>{world.herdr_connected && <span className="workbench__version">{world.herdr_version}</span>}</div>
    </aside>
    <main className="workbench__main">
      <header className="workbench__topbar"><button className="workbench__sidebar-toggle" aria-label="Toggle projects" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>☰</button><div className="workbench__breadcrumb"><span>Workspace</span><span aria-hidden="true">/</span><strong>{view === "world" ? "World" : view === "routes" ? "Trade routes" : selected?.name ?? "Overview"}</strong></div>
        <button className={`workbench__attention ${waiting.length ? "workbench__attention--waiting" : ""}`} onClick={nextWaiting}><span className={`state-dot state-dot--${waiting.length ? "stopped" : "quiet"}`} />{waiting.length ? `${waiting.length} need${waiting.length === 1 ? "s" : ""} you` : "All clear"}<kbd>Space</kbd></button>
      </header>
      {note && <div className="workbench__notice" role="status">{note}<button onClick={() => setNote(null)} aria-label="Dismiss notification">×</button></div>}
      {!world.herdr_connected && view !== "work" && <HerdrSetupStrip onShowSetup={showOverview} />}
      {world.protocol_mismatch && <div className="workbench__notice workbench__notice--warning" role="alert">Herdr uses a different protocol. Agent state may be incomplete.</div>}
      {discovery.kind === "error" && <div className="workbench__notice workbench__notice--warning" role="alert">Could not load projects: {discovery.message}<button onClick={discovery.refetch}>Retry</button></div>}
      {discovery.kind === "ready" && discovery.staleError && <div className="workbench__notice workbench__notice--warning" role="alert">Project list could not refresh: {discovery.staleError}<button onClick={discovery.refetch}>Retry</button></div>}
      {view === "routes" ? <TradeRoutesPage /> : view === "world" ? <div className="workbench__atlas">{renderAtlas()}<WorldLegend /></div> : <TerminalStageProvider stage={stage}>
        {attached && attachment ? <TerminalDock primary={{ agent: attached, root: attachment.root, islandName: projects.find(p => p.root === attachment.root)?.name ?? attachment.root }} targets={targets} onSwitch={selectAgent} onClose={detach} /> : <div className="workbench__content">
          <section className="workbench__intro">
            <div><div className="workbench__eyebrow">{selected ? "Project workspace" : "Your local workspace"}</div><h1>{selected?.name ?? "Your agents, in view."}</h1><p>{selected ? selected.root : "Pick up where you’re needed. Give your next idea a place to grow."}</p></div>
            {selected ? <ProjectLauncher key={selected.root} project={selected} connected={world.herdr_connected} settled={world.islands.some(p => p.root === selected.root)} onReady={paneId => attach(paneId, selected.root)} /> : <button className="workbench__world-button" onClick={() => setView("world")}><IslandMark /><span>Visit your world<small>{projects.length} {projects.length === 1 ? "island" : "islands"} to explore</small></span><span aria-hidden="true">↗</span></button>}
          </section>
          {!world.herdr_connected && <HerdrSetupCard projectCount={projects.length} />}
          {!selected && world.herdr_connected && <div className="workbench__pulse" aria-label="Agent activity"><span><i className="state-dot state-dot--stopped" /><strong>{waiting.length}</strong> need your attention</span><span><i className="state-dot state-dot--working" /><strong>{working.length}</strong> working</span><span><i className="state-dot state-dot--quiet" /><strong>{targets.length - waiting.length - working.length}</strong> idle or unknown</span></div>}
          <section className="workbench__agents" aria-label="Agents">
            <div className="workbench__list-heading"><h2>{selected ? "Agents in this project" : "Agent desk"}<span>{selected?.agents.length ?? targets.length}</span></h2><div className="workbench__filters" role="group" aria-label="Filter agents">{([['all', 'All agents'], ['stopped', 'Needs you'], ['working', 'Working']] as const).map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div></div>
            {shownAgents.length > 0 ? <div className="agent-desk">{shownAgents.map(target => <button className={`agent-desk__row agent-desk__row--${target.agent.attention}`} key={`${target.root}:${target.agent.pane_id}`} onClick={() => selectAgent(target)} aria-label={`Open terminal for ${target.agent.title ?? target.agent.pane_id} in ${target.islandName}`}>
              <span className={`agent-desk__avatar agent-desk__avatar--${target.agent.kind ?? "shell"}`}>{(target.agent.kind ?? "?").slice(0, 2)}</span>
              <span className="agent-desk__identity"><strong>{target.agent.title ?? target.agent.pane_id}</strong><span>{target.islandName}<span className="agent-desk__kind">{target.agent.kind ?? "Unknown"}</span>{target.agent.is_worktree && <span>Worktree</span>}</span></span>
              <span className={`agent-desk__status agent-desk__status--${target.agent.attention}`} title={ATTENTION_LABEL[target.agent.attention]}><i className={`state-dot state-dot--${target.agent.attention}`} />{statusText[target.agent.attention]}</span>
              <span className="agent-desk__open">Open terminal <span aria-hidden="true">↗</span></span>
            </button>)}</div> : <div className="workbench__empty"><span className="workbench__empty-icon" aria-hidden="true">⌘</span><h3>{query || filter !== "all" ? "Nothing in this view" : selected ? "Ready for your first agent" : "Make room for your next idea"}</h3><p>{query || filter !== "all" ? "Try another search or show all agents." : selected ? "Start an agent in this project to open its terminal here." : world.herdr_connected ? "Choose a project in the sidebar and start an agent. Its live session will appear here." : "Agents appear here once Herdr is running."}</p>{(query || filter !== "all") && <button onClick={() => { setFilter("all"); setQuery(""); }}>Clear filters</button>}</div>}
          </section>
          <footer className="workbench__footer"><span><kbd>⌘K</kbd> Find anything</span><span><kbd>Space</kbd> Next agent that needs you</span><span><kbd>⌃⌥⇥</kbd> Switch terminals</span><span className="workbench__private">Your code stays on your machine</span></footer>
        </div>}
      </TerminalStageProvider>}
    </main>
    {newProject && <NewProjectPanel onClose={() => setNewProject(false)} onCreated={(path, reason) => { setNewProject(false); setNote(reason ? `Created ${path}. ${reason}` : `Created ${path}`); discovery.refetch(); }} />}
  </div></TradeRoutesProvider>;
}

function ProjectLauncher({ project, settled, connected, onReady }: { project: Island; settled: boolean; connected: boolean; onReady: (paneId: string) => void }) {
  const flow = useStartAgentFlow({ root: project.root, name: project.name, settled, agents: project.agents, onPaneReady: onReady });
  return <div className="project-launcher"><button className="workbench__primary" disabled={!connected || flow.loading || flow.busy || flow.error !== null} onClick={flow.open}>+ Start agent</button>{flow.error && <p role="alert">{flow.error}</p>}{flow.notes}{flow.sheets}</div>;
}
