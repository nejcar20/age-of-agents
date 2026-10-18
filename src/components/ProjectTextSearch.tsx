import { useEffect, useMemo, useRef, useState } from "react";
import { searchProjectText, type ProjectTextSearch as SearchResult, type TextMatch } from "../inspection";

type SearchState = { key: string } & ({ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: SearchResult });

export function ProjectTextSearch({ root, focusSequence, compact, refresh, active = true, onSelect }: {
  root: string; focusSequence: number; compact: boolean; refresh: number; active?: boolean; onSelect: (match: TextMatch) => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [submission, setSubmission] = useState(0);
  const [state, setState] = useState<SearchState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const immediate = useRef(false);
  const pending = useRef<Promise<SearchResult> | null>(null);
  const key = JSON.stringify([root, query, caseSensitive, refresh, submission]);
  const valid = query.length > 0 && Array.from(query).length <= 500 && !/[\r\n\0]/.test(query);
  useEffect(() => { if (active) { inputRef.current?.focus(); inputRef.current?.select(); } }, [focusSequence, active]);
  useEffect(() => {
    if (!valid) { setState(null); return; }
    let cancelled = false;
    setState({ key, kind: "loading" });
    const timer = window.setTimeout(async () => {
      // One scan at a time: while a repository is busy, retain only the latest query.
      if (pending.current) await pending.current.catch(() => {});
      if (cancelled) return;
      const request = searchProjectText(root, query, caseSensitive);
      pending.current = request;
      request.then(data => {
        if (!data || data.root !== root || data.query !== query || !Array.isArray(data.matches)) throw new Error("Search returned an invalid response.");
        if (!cancelled) setState({ key, kind: "ready", data });
      }).catch(error => { if (!cancelled) setState({ key, kind: "error", message: String(error) }); })
        .finally(() => { if (pending.current === request) pending.current = null; });
    }, immediate.current ? 0 : 300);
    immediate.current = false;
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [root, query, caseSensitive, key, valid]);
  const current = state?.key === key ? state : null;
  const data = current?.kind === "ready" ? current.data : null;
  const groups = useMemo(() => {
    const grouped = new Map<string, TextMatch[]>();
    for (const match of data?.matches ?? []) grouped.set(match.path, [...(grouped.get(match.path) ?? []), match]);
    return [...grouped];
  }, [data]);

  return <section hidden={!active} className="town-text-search" aria-label="Search repository text">
    <form onSubmit={event => { event.preventDefault(); immediate.current = true; setSubmission(value => value + 1); }}>
      <div className="town-text-search__field"><input ref={inputRef} className="town-file-search" type="search" aria-label="Search file contents" placeholder="Find text across this project…" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" aria-label="Match case" aria-pressed={caseSensitive} onClick={() => setCaseSensitive(value => !value)} title="Match case">Aa</button></div>
      <div className="town-text-search__options"><span>Literal text · respects .gitignore</span><button type="submit" disabled={!valid}>Search</button></div>
    </form>
    {!query ? <p className="town-muted">Search inside tracked and non-ignored files. Pick a result to visit its building and read the matching line. <kbd>⌘ / Ctrl ⇧ F</kbd></p> : !valid ? <p role="alert" className="town-inspection-error">Use a single line of up to 500 characters.</p> : !current || current.kind === "loading" ? <p className="town-muted" role="status">Searching file contents…</p> : current.kind === "error" ? <p role="alert" className="town-inspection-error">{current.message}</p> : data && <>
      <p className="town-text-search__summary" role="status">{data.matches.length ? `${data.matches.length} matching ${data.matches.length === 1 ? "line" : "lines"} in ${groups.length} ${groups.length === 1 ? "file" : "files"}` : "No matching text found."}<small>{data.files_searched} files searched{data.files_skipped ? ` · ${data.files_skipped} skipped (binary, unreadable or limited)` : ""}</small></p>
      {data.truncated && <p className="town-muted">Search reached a limit. More matches may exist; narrow the text and search again.</p>}
      <div className={`town-text-results${compact ? " town-text-results--compact" : ""}`}>
        {groups.map(([path, matches]) => <section key={path}><h4>{path}<span>{matches.length}</span></h4>{matches.map(match => <button key={match.line} aria-label={`Open ${path} at line ${match.line}`} onClick={() => onSelect(match)}><span className="town-text-results__line">{match.line}</span><code><MatchExcerpt match={match} query={query} caseSensitive={caseSensitive} /></code></button>)}</section>)}
      </div>
    </>}
  </section>;
}


function MatchExcerpt({ match, query, caseSensitive }: { match: TextMatch; query: string; caseSensitive: boolean }) {
  const chars = Array.from(match.text);
  const at = match.column - 1;
  if (at >= chars.length) return <>Match at column {match.column} (outside this excerpt)</>;
  const before = Math.max(0, at - 24);
  const length = (caseSensitive ? query : query.toLowerCase()).length;
  let end = at, foldedLength = 0;
  while (end < chars.length && foldedLength < length) {
    foldedLength += (caseSensitive ? chars[end] : chars[end].toLowerCase()).length;
    end++;
  }
  const after = Math.min(chars.length, end + 60);
  return <>{before > 0 && "…"}{chars.slice(before, at).join("")}<mark>{chars.slice(at, end).join("")}</mark>{chars.slice(end, after).join("")}{after < chars.length || match.truncated ? "…" : ""}</>;
}
