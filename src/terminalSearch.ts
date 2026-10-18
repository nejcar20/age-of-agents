import { parseAnsi, type AnsiSpan } from "./ansi";

export type OutputMatch = { start: number; end: number };
export type SearchedOutput = { spans: AnsiSpan[]; matches: OutputMatch[] };

/** Search exactly the text the ANSI renderer displays. Offsets remain UTF-16
 * indices so a match can span styled runs without changing any output. */
export function searchTerminalOutput(text: string, query: string): SearchedOutput {
  const spans = parseAnsi(text);
  if (!query) return { spans, matches: [] };
  const visible = spans.map(span => span.text).join("");
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...visible.matchAll(new RegExp(literal, "giu"))]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
  return { spans, matches };
}
