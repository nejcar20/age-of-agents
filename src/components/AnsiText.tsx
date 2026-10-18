import { Fragment, useMemo } from "react";
import { parseAnsi } from "../ansi";

/**
 * Renders `read_agent`'s snapshot text with real ANSI colour instead of
 * either stripping it to plain grey or (the bug the author's screenshot
 * caught) dumping the raw escape bytes as visible garbage. One `<span>` per
 * styled run — `parseAnsi` already collapses a plain string with no escape
 * codes into a single span, so the common case costs nothing extra.
 */
export function AnsiText({ text, className }: { text: string; className?: string }) {
  const spans = useMemo(() => parseAnsi(text), [text]);
  return (
    <pre className={className}>
      {spans.map((span, i) => (
        <Fragment key={i}>
          {span.fg || span.bg || span.bold || span.italic || span.underline || span.dim ? (
            <span
              style={{
                color: span.fg,
                backgroundColor: span.bg,
                fontWeight: span.bold ? 700 : undefined,
                fontStyle: span.italic ? "italic" : undefined,
                textDecoration: span.underline ? "underline" : undefined,
                opacity: span.dim ? 0.65 : undefined,
              }}
            >
              {span.text}
            </span>
          ) : (
            span.text
          )}
        </Fragment>
      ))}
    </pre>
  );
}
