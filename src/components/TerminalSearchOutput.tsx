import type { ReactNode } from "react";
import type { SearchedOutput } from "../terminalSearch";

/** Highlight inside styled runs, preserving the parser's ANSI colors and
 * the original text (including matches that cross an ANSI boundary). */
export function TerminalSearchOutput({ output, current }: { output: SearchedOutput; current: number }) {
  let offset = 0;
  let matchIndex = 0;
  return <pre className="terminal__text">{output.spans.map((span, spanIndex) => {
    const start = offset;
    const end = start + span.text.length;
    offset = end;
    const parts: ReactNode[] = [];
    let cursor = start;
    while (matchIndex < output.matches.length && output.matches[matchIndex].end <= start) matchIndex++;
    let nextMatch = matchIndex;
    while (nextMatch < output.matches.length && output.matches[nextMatch].start < end) {
      const match = output.matches[nextMatch];
      const from = Math.max(start, match.start);
      const to = Math.min(end, match.end);
      if (cursor < from) parts.push(span.text.slice(cursor - start, from - start));
      parts.push(<mark key={nextMatch} className={`terminal__match${current === nextMatch ? " terminal__match--current" : ""}`}>
        {span.text.slice(from - start, to - start)}
      </mark>);
      cursor = to;
      nextMatch++;
    }
    if (cursor < end) parts.push(span.text.slice(cursor - start));
    return <span key={spanIndex} style={{
      color: span.fg,
      backgroundColor: span.bg,
      fontWeight: span.bold ? 700 : undefined,
      fontStyle: span.italic ? "italic" : undefined,
      textDecoration: span.underline ? "underline" : undefined,
      opacity: span.dim ? 0.65 : undefined,
    }}>{parts}</span>;
  })}</pre>;
}
