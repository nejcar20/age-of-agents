import { useEffect, useRef } from "react";

export function CodePreview({ content, line, excerpt }: { content: string; line?: number; excerpt?: string }) {
  const containerRef = useRef<HTMLPreElement>(null);
  const matchRef = useRef<HTMLSpanElement>(null);
  const lines = content.split("\n");
  const available = !!line && line <= lines.length;
  const first = available ? Math.max(0, line - 41) : 0;
  const last = available ? Math.min(lines.length, line + 40) : lines.length;
  useEffect(() => {
    const pre = containerRef.current, match = matchRef.current;
    if (pre && match) pre.scrollTop = Math.max(0, match.offsetTop - pre.clientHeight / 2);
  }, [content, line]);
  if (!line) return <pre className="town-code-preview" tabIndex={0}>{content || "This file is empty."}</pre>;
  if (!available && excerpt !== undefined) return <>
    <p className="town-muted">Line {line} is outside this file preview. This excerpt is from the search; open the file in your editor for surrounding code.</p>
    <pre className="town-code-preview" tabIndex={0} aria-label={`Search excerpt at line ${line}`}>{excerpt}</pre>
  </>;
  return <>
    <p className="town-muted">{available ? `Line ${line} · showing lines ${first + 1}–${last}` : `Line ${line} is outside this preview. Open the file in your editor for the full contents.`}</p>
    <pre ref={containerRef} className="town-code-preview town-code-preview--lines" tabIndex={0}>{available ? lines.slice(first, last).map((text, index) => <span key={first + index} ref={first + index + 1 === line ? matchRef : undefined} aria-label={first + index + 1 === line ? `Line ${line}` : undefined} className={first + index + 1 === line ? "town-code-preview__match" : undefined}><i aria-hidden="true">{first + index + 1}</i><code>{text || "\u00a0"}</code></span>) : content || "This file is empty."}</pre>
  </>;
}
