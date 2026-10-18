import { describe, expect, it } from "vitest";
import { decodePaneKey, switchTerminalKey, terminalEditKey } from "./terminalKeys";

function key(
  k: string,
  mods: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
) {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    metaKey: mods.metaKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  };
}

describe("decodePaneKey", () => {
  it("sends a plain letter as literal text, not a named key", () => {
    expect(decodePaneKey(key("a"))).toEqual({ kind: "text", value: "a" });
  });

  it("sends a shifted symbol (already resolved by the browser) as literal text", () => {
    expect(decodePaneKey(key("!"))).toEqual({ kind: "text", value: "!" });
  });

  it("sends space as literal text, matching how it would be typed", () => {
    expect(decodePaneKey(key(" "))).toEqual({ kind: "text", value: " " });
  });

  it("sends a non-Latin character as literal text unchanged", () => {
    expect(decodePaneKey(key("é"))).toEqual({ kind: "text", value: "é" });
  });

  it("maps Enter/Escape/Tab/Backspace to Herdr's named keys", () => {
    expect(decodePaneKey(key("Enter"))).toEqual({ kind: "keys", value: ["enter"] });
    expect(decodePaneKey(key("Escape"))).toEqual({ kind: "keys", value: ["escape"] });
    expect(decodePaneKey(key("Tab"))).toEqual({ kind: "keys", value: ["tab"] });
    expect(decodePaneKey(key("Backspace"))).toEqual({ kind: "keys", value: ["backspace"] });
  });

  it("maps the arrow keys", () => {
    expect(decodePaneKey(key("ArrowUp"))).toEqual({ kind: "keys", value: ["up"] });
    expect(decodePaneKey(key("ArrowDown"))).toEqual({ kind: "keys", value: ["down"] });
    expect(decodePaneKey(key("ArrowLeft"))).toEqual({ kind: "keys", value: ["left"] });
    expect(decodePaneKey(key("ArrowRight"))).toEqual({ kind: "keys", value: ["right"] });
  });

  it("adds a shift+ prefix only for keys Herdr documents with one", () => {
    expect(decodePaneKey(key("Tab", { shiftKey: true }))).toEqual({ kind: "keys", value: ["shift+tab"] });
    expect(decodePaneKey(key("ArrowUp", { shiftKey: true }))).toEqual({ kind: "keys", value: ["shift+up"] });
    // Enter has no documented shift+ form — falls back to the plain key
    // rather than inventing a name Herdr doesn't have.
    expect(decodePaneKey(key("Enter", { shiftKey: true }))).toEqual({ kind: "keys", value: ["enter"] });
  });

  // The one keystroke the brief calls out by name: NOT filtered, despite the
  // backend's documented finding that it can suspend an idle shell and take
  // the whole workspace down with it. The author's ruling is "do not block
  // or filter keys" — a real terminal passes it, so this one must too.
  it("does not filter ctrl+z — the exact hazard named in the brief", () => {
    expect(decodePaneKey(key("z", { ctrlKey: true }))).toEqual({ kind: "keys", value: ["ctrl+z"] });
  });

  it("maps documented ctrl combos", () => {
    expect(decodePaneKey(key("c", { ctrlKey: true }))).toEqual({ kind: "keys", value: ["ctrl+c"] });
    expect(decodePaneKey(key("d", { ctrlKey: true }))).toEqual({ kind: "keys", value: ["ctrl+d"] });
    expect(decodePaneKey(key("[", { ctrlKey: true }))).toEqual({ kind: "keys", value: ["ctrl+["] });
    expect(decodePaneKey(key("ArrowLeft", { ctrlKey: true }))).toEqual({ kind: "keys", value: ["ctrl+left"] });
    expect(decodePaneKey(key(" ", { ctrlKey: true }))).toEqual({ kind: "keys", value: ["ctrl+space"] });
  });

  it("maps ctrl+shift+<key> distinctly from plain ctrl+<key>", () => {
    expect(decodePaneKey(key("c", { ctrlKey: true, shiftKey: true }))).toEqual({
      kind: "keys",
      value: ["ctrl+shift+c"],
    });
  });

  it("maps alt and meta combos generically", () => {
    expect(decodePaneKey(key("b", { altKey: true }))).toEqual({ kind: "keys", value: ["alt+b"] });
    expect(decodePaneKey(key("b", { metaKey: true }))).toEqual({ kind: "keys", value: ["meta+b"] });
  });

  it("still decodes a ctrl combo Herdr is not documented to accept, rather than silently dropping it", () => {
    // Herdr's own send_keys validation is the source of truth for what's
    // supported; this module's job is only to name the keystroke honestly,
    // never to pre-guess which ones will be rejected.
    expect(decodePaneKey(key("q", { ctrlKey: true }))).toEqual({ kind: "keys", value: ["ctrl+q"] });
  });

  // Terminal-feel round. These six used to be sent to herdr as logical key
  // names it is verified to reject outright, so they did nothing but
  // produce an error. They now travel as the bytes a terminal emulator
  // sends — the sequences this machine's own `infocmp xterm-256color`
  // declares, verified live against `less` and zsh. See
  // `KEY_ESCAPE_SEQUENCES`.
  it("sends the keys Herdr has no word for as the escape bytes a terminal sends", () => {
    expect(decodePaneKey(key("PageUp"))).toEqual({ kind: "text", value: "\x1b[5~" });
    expect(decodePaneKey(key("PageDown"))).toEqual({ kind: "text", value: "\x1b[6~" });
    expect(decodePaneKey(key("Home"))).toEqual({ kind: "text", value: "\x1bOH" });
    expect(decodePaneKey(key("End"))).toEqual({ kind: "text", value: "\x1bOF" });
    expect(decodePaneKey(key("Delete"))).toEqual({ kind: "text", value: "\x1b[3~" });
    expect(decodePaneKey(key("Insert"))).toEqual({ kind: "text", value: "\x1b[2~" });
  });

  // The escape table covers the UNMODIFIED press only. xterm has a
  // modifier encoding for these and this module does not guess at it: a
  // modified press still goes to herdr and comes back as herdr's own
  // honest "unsupported key", which beats a plausible-looking sequence
  // nobody has tested.
  it("still attempts a MODIFIED press of those keys, rather than guessing at xterm's modifier encoding", () => {
    expect(decodePaneKey(key("Home", { ctrlKey: true }))).toEqual({
      kind: "keys",
      value: ["ctrl+home"],
    });
    expect(decodePaneKey(key("Delete", { altKey: true }))).toEqual({
      kind: "keys",
      value: ["alt+delete"],
    });
  });

  // The mechanical half of the copy/paste ruling: whatever `Terminal.tsx`
  // does or stops doing with these three, they have no path to a pane.
  // herdr ACCEPTS `meta+c` without complaint (probed live against a
  // throwaway pane), so before this they really did put bytes into a
  // session when the user meant "copy".
  it("never sends the three ⌘ chords macOS reserves for the application", () => {
    expect(decodePaneKey(key("c", { metaKey: true }))).toBeNull();
    expect(decodePaneKey(key("v", { metaKey: true }))).toBeNull();
    expect(decodePaneKey(key("a", { metaKey: true }))).toBeNull();
    expect(terminalEditKey(key("c", { metaKey: true }))).toBe("copy");
    expect(terminalEditKey(key("v", { metaKey: true }))).toBe("paste");
    expect(terminalEditKey(key("a", { metaKey: true }))).toBe("select-all");
  });

  it("leaves every other ⌘ chord alone, for herdr to answer for", () => {
    expect(terminalEditKey(key("k", { metaKey: true }))).toBeNull();
    expect(decodePaneKey(key("k", { metaKey: true }))).toEqual({ kind: "keys", value: ["meta+k"] });
  });

  it("ignores a bare modifier key with nothing pressed alongside it", () => {
    expect(decodePaneKey(key("Control", { ctrlKey: true }))).toBeNull();
    expect(decodePaneKey(key("Shift", { shiftKey: true }))).toBeNull();
    expect(decodePaneKey(key("Alt", { altKey: true }))).toBeNull();
    expect(decodePaneKey(key("Meta", { metaKey: true }))).toBeNull();
  });

  it("ignores an in-progress IME composition marker", () => {
    expect(decodePaneKey(key("Dead"))).toBeNull();
    expect(decodePaneKey(key("Process"))).toBeNull();
  });

  it("drops an unrepresentable multi-modifier combo rather than guessing", () => {
    expect(decodePaneKey(key("x", { ctrlKey: true, altKey: true }))).toBeNull();
  });
});

/**
 * The switcher key's whole safety argument, mechanised (lag-and-switcher
 * round — the author's main ask: easy switching between terminals).
 *
 * The terminal owns the keyboard: any app-level shortcut it adds must be
 * one that could never ALSO reach the agent's session, or he gets a stray
 * `ctrl+alt+tab` in a live conversation.
 *
 * `switchTerminalKey` is deliberately not a carve-out inside
 * `decodePaneKey` — the author's own ruling is that no key may be filtered
 * out of the pane path. It names a combination that already decodes to
 * `null`, and these tests are what keep that true: edit either function in
 * a way that lets the shortcut become sendable, and this file fails.
 */
describe("the terminal switcher key can never reach the pane", () => {
  const NEXT = key("Tab", { ctrlKey: true, altKey: true });
  const BACK = key("Tab", { ctrlKey: true, altKey: true, shiftKey: true });

  it("reads ctrl+alt+Tab as forwards and ctrl+alt+shift+Tab as backwards", () => {
    expect(switchTerminalKey(NEXT)).toBe("next");
    expect(switchTerminalKey(BACK)).toBe("previous");
  });

  it("decodes to NOTHING sendable — the proof neither can leak into the agent", () => {
    expect(decodePaneKey(NEXT)).toBeNull();
    expect(decodePaneKey(BACK)).toBeNull();
  });

  it("does not claim the keys the agent actually uses", () => {
    // Every one of these is a real keystroke in the author's own claude
    // session — shift+Tab is literally printed at the bottom of his pane
    // ("shift+tab to cycle"). Each must still decode to something sent to
    // the pane, and none may be mistaken for the shortcut.
    for (const event of [
      key("Tab"),
      key("Tab", { shiftKey: true }),
      key("Tab", { ctrlKey: true }),
      key("Tab", { altKey: true }),
      key("Tab", { metaKey: true }),
      key("c", { ctrlKey: true }),
      key("Escape"),
      key("a"),
    ]) {
      expect(switchTerminalKey(event)).toBeNull();
      expect(decodePaneKey(event)).not.toBeNull();
    }
  });

  it("is not triggered by ctrl+alt on some other key", () => {
    expect(switchTerminalKey(key("t", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(switchTerminalKey(key("Enter", { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it("is not triggered when Meta is also held — that is a different chord", () => {
    expect(switchTerminalKey(key("Tab", { ctrlKey: true, altKey: true, metaKey: true }))).toBeNull();
  });
});
