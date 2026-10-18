import { describe, expect, it } from "vitest";
import { searchTerminalOutput } from "./terminalSearch";

describe("searchTerminalOutput", () => {
  it("treats punctuation as literal text and searches across ANSI formatting", () => {
    const result = searchTerminalOutput("x[a\x1b[32m.b]\x1b[0m [A.B]", "[a.b]");
    expect(result.matches).toEqual([{ start: 1, end: 6 }, { start: 7, end: 12 }]);
    expect(result.spans.map(span => span.text).join("")).toBe("x[a.b] [A.B]");
  });

  it("keeps character offsets correct after Unicode text and ignores ANSI control contents", () => {
    expect(searchTerminalOutput("🌳\x1b]0;hidden title\x07İhello HELLO", "hello").matches)
      .toEqual([{ start: 3, end: 8 }, { start: 9, end: 14 }]);
    expect(searchTerminalOutput("\x1b]0;hidden title\x07visible", "hidden").matches).toEqual([]);
    expect(searchTerminalOutput("anything", "").matches).toEqual([]);
  });
});
