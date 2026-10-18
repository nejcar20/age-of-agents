import { describe, expect, it } from "vitest";
import { parseAnsi } from "./ansi";

const ESC = "\x1b";

describe("parseAnsi", () => {
  it("returns one plain span for text with no escape codes at all", () => {
    expect(parseAnsi("hello world")).toEqual([{ text: "hello world" }]);
  });

  it("colours text between an SGR foreground code and a reset", () => {
    const spans = parseAnsi(`plain ${ESC}[32mgreen${ESC}[0m plain again`);
    expect(spans).toEqual([
      { text: "plain " },
      { text: "green", fg: "#8fc97a" },
      { text: " plain again" },
    ]);
  });

  it("supports bright/high-intensity foreground codes (90-97)", () => {
    const spans = parseAnsi(`${ESC}[91mbright red${ESC}[0m`);
    expect(spans[0]).toEqual({ text: "bright red", fg: "#f0958e" });
  });

  it("supports background colours independently of foreground", () => {
    const spans = parseAnsi(`${ESC}[44mon blue${ESC}[49m`);
    expect(spans[0]).toEqual({ text: "on blue", bg: "#6fa8dc" });
  });

  it("stacks bold onto a still-active colour rather than replacing it", () => {
    const spans = parseAnsi(`${ESC}[33m${ESC}[1mbold yellow${ESC}[0m`);
    expect(spans[0]).toEqual({ text: "bold yellow", fg: "#e0b95f", bold: true });
  });

  it("a bare reset with no digits (\\x1b[m) clears all active style", () => {
    const spans = parseAnsi(`${ESC}[31mred${ESC}[mplain`);
    expect(spans).toEqual([{ text: "red", fg: "#e0716a" }, { text: "plain" }]);
  });

  it("truecolour (38;2;r;g;b) renders the exact RGB given", () => {
    const spans = parseAnsi(`${ESC}[38;2;10;20;30mcustom${ESC}[0m`);
    expect(spans[0]).toEqual({ text: "custom", fg: "rgb(10, 20, 30)" });
  });

  it("256-colour codes within the basic 16 slots map onto the same palette", () => {
    const spans = parseAnsi(`${ESC}[38;5;2mgreen256${ESC}[0m`);
    expect(spans[0].fg).toBe("#8fc97a");
  });

  it("256-colour codes past slot 15 render as no colour, never a guess", () => {
    const spans = parseAnsi(`${ESC}[38;5;200mwhatever${ESC}[0m`);
    expect(spans[0].fg).toBeUndefined();
  });

  it("drops non-SGR CSI sequences (cursor/clear/hide) entirely, leaving no garbage", () => {
    // `\x1b[2K` (clear line), `\x1b[?25l` (hide cursor), `\x1b[1;1H` (cursor
    // position) — none of these are colour codes, and none should ever
    // appear as literal text in the rendered output.
    const spans = parseAnsi(`${ESC}[2Kclearing${ESC}[?25lhidden${ESC}[1;1Hhome`);
    const joined = spans.map((s) => s.text).join("");
    expect(joined).toBe("clearinghiddenhome");
    expect(joined).not.toContain("\x1b");
  });

  it("drops OSC sequences (e.g. a terminal-title set) entirely", () => {
    const spans = parseAnsi(`${ESC}]0;my title${ESC}\\visible text`);
    expect(spans.map((s) => s.text).join("")).toBe("visible text");
  });

  it("drops a bare carriage return (progress-bar overwrite) but keeps \\r\\n as a newline", () => {
    const spans = parseAnsi("progress...\rdone\r\nnext line");
    const joined = spans.map((s) => s.text).join("");
    expect(joined).toBe("progress...donenext line".replace("donenext", "done\r\nnext"));
  });

  it("an empty string parses to no spans", () => {
    expect(parseAnsi("")).toEqual([]);
  });
});
