import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { SwitchTarget } from "../agentSwitcher";
import { inspectProjectPath, indexTownFiles, readRepoChanges, relativeProjectPath, searchTownFiles, type ChangeStatus, type CodeSelection, type FileInspection, type RepoChanges, type TextMatch } from "../inspection";
import { ProjectTextSearch } from "./ProjectTextSearch";
import { CodePreview } from "./CodePreview";
import { TownView, type TownViewProps } from "./TownView";
import { ScopedTaskComposer } from "./ScopedTaskComposer";
import { useTradeRoutes } from "./TradeRoutes";
import { revealPath } from "../reveal";
import "../townWorkspace.css";

type Load<T> = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: T };
/** How often the town re-reads Git while an agent in it is working. */
const CHANGES_POLL_MS = 5_000;
export function TownWorkspace({ root, targets, connected, onOpenTerminal, onRefreshCity, ...viewProps }: TownViewProps & {
  root: string; targets: SwitchTarget[]; connected: boolean;
  onOpenTerminal: (target: SwitchTarget) => void; onRefreshCity?: () => void | Promise<void>;
}) {
  const trade = useTradeRoutes();
  const files = useMemo(() => indexTownFiles(viewProps.cityView.model), [viewProps.cityView.model]);
  const [tab, setTab] = useState<"files" | "search" | "changes" | "harbor">("files");
  const [query, setQuery] = useState("");
  const [searchFocus, setSearchFocus] = useState(0);
  const [textMatch, setTextMatch] = useState<TextMatch | undefined>();
  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== "f" || event.isComposing || document.querySelector('[role="dialog"]')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      setPanelOpen(true); setTab("search"); setSearchFocus(value => value + 1);
    };
    window.addEventListener("keydown", openSearch, true);
    return () => window.removeEventListener("keydown", openSearch, true);
  }, []);
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  const [focusRequest, setFocusRequest] = useState<{path: string; seq: number} | null>(null);
  const focusSequence = useRef(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [inspectTab, setInspectTab] = useState<"preview" | "diff">("preview");
  const [refresh, setRefresh] = useState(0);
  const [changes, setChanges] = useState<Load<RepoChanges>>({ kind: "loading" });
  const [inspection, setInspection] = useState<Load<FileInspection>>({ kind: "loading" });
  const [task, setTask] = useState<CodeSelection | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setChanges({ kind: "loading" });
    readRepoChanges(root).then(data => {
      if (!data || !Array.isArray(data.entries)) throw new Error("The repository did not return a changes list.");
      if (!cancelled) setChanges({ kind: "ready", data });
    }).catch(error => { if (!cancelled) setChanges({ kind: "error", message: String(error) }); });
    return () => { cancelled = true; };
  }, [root, refresh]);
  // While an agent here is working, its edits should land on the map as it
  // makes them rather than on the next manual ↻ — plus one read the moment
  // it stops, so the finished state is what stays on screen. A poll keeps
  // the last good list visible (no "Reading…" flash) and never errors over
  // it: the next tick simply tries again.
  const working = viewProps.agents?.some(agent => agent.attention === "working") ?? false;
  const [poll, setPoll] = useState(0);
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) setPoll(value => value + 1);
    wasWorking.current = working;
    if (!working) return;
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") setPoll(value => value + 1); }, CHANGES_POLL_MS);
    return () => clearInterval(timer);
  }, [working]);
  // The same tick re-measures the town itself, so buildings grow as the
  // agent writes (see `TownView`'s live growth). Skipped while the previous
  // measurement is still running — a large repository must never queue up.
  const measuringRef = useRef(false);
  const refreshCityRef = useRef(onRefreshCity);
  refreshCityRef.current = onRefreshCity;
  useEffect(() => {
    if (poll === 0 || measuringRef.current || !refreshCityRef.current) return;
    measuringRef.current = true;
    Promise.resolve(refreshCityRef.current()).catch(() => { /* Reported by the caller. */ }).finally(() => { measuringRef.current = false; });
  }, [poll]);
  useEffect(() => {
    if (poll === 0) return;
    let cancelled = false;
    readRepoChanges(root).then(data => {
      if (!cancelled && data && Array.isArray(data.entries)) setChanges({ kind: "ready", data });
    }).catch(() => { /* Keep the last good list; the next poll retries. */ });
    return () => { cancelled = true; };
  }, [root, poll]);
  useEffect(() => {
    if (!selection) return;
    let cancelled = false;
    setInspection({ kind: "loading" }); setActionError(null);
    inspectProjectPath(root, selection.path).then(data => {
      if (!data) throw new Error("No file inspection was returned.");
      if (!cancelled) setInspection({ kind: "ready", data });
    }).catch(error => { if (!cancelled) setInspection({ kind: "error", message: String(error) }); });
    return () => { cancelled = true; };
  }, [root, selection, refresh]);
  const select = useCallback((path: string, kind: CodeSelection["kind"], fly = true) => {
    setSelection({ path, kind }); setTextMatch(undefined); setPanelOpen(true);
    if (fly) setFocusRequest({ path: path === "." ? root : `${root.replace(/\/$/, "")}/${path}`, seq: ++focusSequence.current });
    else setFocusRequest(null);
  }, [root]);
  const mapSelect = useCallback((path: string, kind: CodeSelection["kind"]) => {
    const relative = relativeProjectPath(root, path);
    if (relative !== null) { select(relative, kind, false); setTab("files"); setInspectTab("preview"); }
  }, [root, select]);
  const changeEntries = changes.kind === "ready" ? changes.data.entries : [];
  const changeMap = useMemo(() => new Map<string, ChangeStatus>(changeEntries.map(entry => [`${root.replace(/\/$/, "")}/${entry.path}`, entry.status])), [changeEntries, root]);
  const matchingFiles = useMemo(() => searchTownFiles(files, query), [files, query]);
  const selectedFile = files.find(file => file.path === selection?.path);
  const indexedDistrict = viewProps.cityView.model.districts.some(d => relativeProjectPath(root, d.path) === selection?.path);
  const hasBuilding = selection?.kind === "directory" ? indexedDistrict : !!selectedFile;
  const routes = trade?.routes.filter(route => route.sourceRoot === root || route.targetRoot === root) ?? [];
  const data = inspection.kind === "ready" && inspection.data.path === selection?.path ? inspection.data : null;
  const refreshAll = () => { setRefresh(value => value + 1); onRefreshCity?.(); };

  return <div className={`town-workspace${panelOpen ? " town-workspace--panel" : ""}`}>
    <div className="town-workspace__map"><TownView {...viewProps} onCodeSelect={mapSelect} focusRequest={focusRequest} changes={showChanges ? changeMap : undefined} changesLive={working} externalInspector />
      <button className="town-workspace__toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen(value => !value)}>{panelOpen ? "Hide work panel" : "Files, search & harbor"}</button>
      {showChanges && changeEntries.length > 0 && <div className="town-change-legend"><span><i className="change-dot change-dot--added" />Added / untracked</span><span><i className="change-dot change-dot--modified" />Modified / renamed</span><span><i className="change-dot change-dot--deleted" />Deleted / conflicted</span></div>}
    </div>
    <aside hidden={!panelOpen} className="town-work-panel" aria-label="Town work panel">
      <header className="town-work-panel__header"><div><strong>Work with this town</strong><small>{changes.kind === "ready" ? changes.data.branch ?? "Detached HEAD" : "Repository workspace"}</small></div><button onClick={refreshAll} aria-label="Refresh files and changes" title="Refresh files, preview, and Git changes">↻</button></header>
      <div className="town-work-tabs" role="tablist" aria-label="Town tools"><button role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}>Files <span>{files.length}</span></button><button role="tab" aria-selected={tab === "search"} onClick={() => { setTab("search"); setSearchFocus(value => value + 1); }} title="Search file contents (⌘ / Ctrl Shift F)">Search</button><button role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>Changes <span>{changes.kind === "ready" ? changeEntries.length : "—"}</span></button><button role="tab" aria-selected={tab === "harbor"} onClick={() => setTab("harbor")}>Harbor <span>{routes.length}</span></button></div>
      <div className="town-work-panel__content">
        {tab === "files" && <>
          <input className="town-file-search" type="search" aria-label="Find a file in this town" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a file in this town…" onKeyDown={e => { if (e.key === "Enter" && matchingFiles[0]) { select(matchingFiles[0].path, "file"); setInspectTab("preview"); } }} />
          <div className={`town-file-list${selection ? " town-file-list--compact" : ""}`} aria-label="Indexed files">
            {matchingFiles.slice(0, 200).map(file => <button key={file.path} onClick={() => { select(file.path, "file"); setInspectTab("preview"); }} aria-label={`Open ${file.path}`} aria-pressed={selection?.path === file.path}><span className={`town-file-kind town-file-kind--${file.kind.toLowerCase()}`}>{file.kind.slice(0, 1)}</span><span>{file.name}<small>{file.path}</small></span>{changeMap.has(file.absolutePath) && <i className={`change-dot change-dot--${changeMap.get(file.absolutePath)}`} />}</button>)}
            {!matchingFiles.length && <p className="town-muted">{query ? "No indexed files match this search." : "No files are indexed in this town."}</p>}
            {matchingFiles.length > 200 && <p className="town-muted">Showing 200 of {matchingFiles.length}. Search to narrow the list.</p>}
          </div>
        </>}
        <ProjectTextSearch active={panelOpen && tab === "search"} key={root} root={root} focusSequence={searchFocus} refresh={refresh} compact={!!selection} onSelect={match => { select(match.path, "file"); setTextMatch(match); setInspectTab("preview"); }} />
        {tab === "changes" && <>
          <label className="town-changes-switch"><input type="checkbox" checked={showChanges} onChange={e => setShowChanges(e.target.checked)} />Highlight changes in the town</label>
          {changes.kind === "loading" ? <p className="town-muted" role="status">Reading Git changes…</p> : changes.kind === "error" ? <p className="town-inspection-error" role="alert">{changes.message}</p> : <>
            {!changeEntries.length && <div className="town-tool-empty"><strong>Your working tree is clean.</strong><p>File changes will appear here after a refresh.</p></div>}
            <div className={`town-file-list${selection ? " town-file-list--compact" : ""}`}>{changeEntries.map(entry => <button key={entry.path} aria-label={`Open ${entry.path}, ${entry.status}`} aria-pressed={selection?.path === entry.path} onClick={() => { select(entry.path, "file"); setInspectTab("diff"); }}><i className={`change-dot change-dot--${entry.status}`} /><span>{entry.path}<small>{entry.status}{entry.previous_path ? ` from ${entry.previous_path}` : ""} · {entry.staged ? "staged" : ""}{entry.staged && entry.unstaged ? " + " : ""}{entry.unstaged ? "working tree" : ""}</small></span></button>)}</div>
            {changes.data.truncated && <p className="town-muted">The changes list was limited. More changes may exist.</p>}
          </>}
        </>}
        {tab === "harbor" && <div className="town-harbor"><h3>Your project’s harbor</h3><p>Projects connected through briefs you’ve sent.</p>{!routes.length && <div className="town-tool-empty"><span aria-hidden="true">⤳</span><strong>No routes docked here yet.</strong><p>Bring an idea from another project, or share this one with an agent elsewhere.</p></div>}{routes.map(route => {
          const target = trade?.targets.find(t => t.root === route.targetRoot && t.agent.pane_id === route.paneId && t.agent.cwd === route.targetCwd && t.agent.kind === route.agentKind);
          return <article key={route.id}><small>{route.targetRoot === root ? "Incoming" : "Outgoing"} · Brief sent</small><h4>{route.sourceName} → {route.targetName}</h4><p>{route.brief}</p><details><summary>Read the submitted brief</summary><pre>{route.prompt}</pre></details><button disabled={!target} onClick={() => { if (target) onOpenTerminal(target); }}>{target ? "Open receiving terminal" : "Receiving agent unavailable"}</button></article>;
        })}{trade ? <div className="town-harbor__actions"><button onClick={() => trade.open({ targetRoot: root })}>Bring a project here</button><button onClick={() => trade.open({ sourceRoot: root })}>Share this project</button></div> : <p className="town-muted">Trade routes are available from the main workspace.</p>}</div>}
        {selection && tab !== "harbor" && <section className="town-inspector" aria-label="Code inspector">
          <header><div><small>{selection.kind === "directory" ? "Selected district" : selectedFile?.kind ?? "Repository path"}</small><h3>{selection.path.split("/").pop()}</h3></div><button aria-label="Close code inspector" onClick={() => setSelection(null)}>×</button></header>
          <code className="town-inspector__path">{selection.path}</code>
          {!hasBuilding && <p className="town-muted">No building for this path in the current town. It may be deleted or outside the indexed files.</p>}
          <div className="town-inspector__actions"><button className="town-accent" onClick={() => setTask(selection)}>Ask an agent</button><button onClick={() => openPath(selection.path === "." ? root : `${root}/${selection.path}`).catch(e => setActionError(String(e)))}>Open in editor</button><button onClick={() => revealPath(selection.path === "." ? root : `${root}/${selection.path}`).catch(e => setActionError(String(e)))}>Reveal file</button>{selectedFile && <button onClick={() => select(relativeProjectPath(root, selectedFile.districtPath) ?? ".", "directory")}>Select district</button>}</div>
          {actionError && <p role="alert" className="town-inspection-error">{actionError}</p>}
          <div className="town-inspector__tabs" role="tablist" aria-label="Inspect code"><button role="tab" aria-selected={inspectTab === "preview"} onClick={() => setInspectTab("preview")}>Preview</button><button role="tab" aria-selected={inspectTab === "diff"} onClick={() => setInspectTab("diff")}>Diff</button></div>
          {inspection.kind === "error" ? <p className="town-inspection-error" role="alert">{inspection.message}</p> : !data ? <p className="town-muted" role="status">Reading {selection.kind}…</p> : inspectTab === "preview" ? <>
            {data.kind === "text" ? <CodePreview content={data.content ?? ""} line={textMatch?.line} excerpt={textMatch?.text} /> : <p className="town-muted">{data.kind === "binary" ? "Binary file — open it in its editor to inspect it." : data.kind === "missing" ? "This path is absent from the working tree. Check Diff for its changes." : "This is a directory. Select Diff to review its changes, or give the whole district to an agent."}</p>}
            {data.truncated && <p className="town-muted">Preview limited to the first part of the file. Open in editor for the full contents.</p>}
          </> : <div className="town-diffs">{!data.staged_diff && !data.unstaged_diff ? <p className="town-muted">No staged or working-tree diff. Untracked files are available in Preview.</p> : <>{data.staged_diff && <Diff title="Staged changes" text={data.staged_diff} />}{data.unstaged_diff && <Diff title="Working-tree changes" text={data.unstaged_diff} />}</>}{data.diff_truncated && <p className="town-muted">Diff output was limited; more changes may exist.</p>}</div>}
        </section>}
        {!selection && tab === "files" && <p className="town-work-hint">Select a building or find a file to read its code, review a diff, or give an agent a task.</p>}
      </div>
    </aside>
    {task && <ScopedTaskComposer root={root} selection={task} targets={targets} connected={connected} onClose={() => setTask(null)} onOpenTerminal={onOpenTerminal} />}
  </div>;
}

function Diff({ title, text }: { title: string; text: string }) {
  return <section><h4>{title}</h4><pre tabIndex={0}>{text.split("\n").map((line, i) => <span className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : undefined} key={i}>{line || "\u00a0"}</span>)}</pre></section>;
}
