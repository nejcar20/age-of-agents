// Pure keystroke -> Herdr-pane-input mapping for the Phase 0.7 interactive
// terminal (spec §5.6). Framework-free and unit-testable without a DOM, same
// convention as `ansi.ts`/`jump.ts` — `Terminal.tsx` is a thin renderer that
// calls `decodePaneKey` on every `keydown` it receives while focused and does
// exactly what it says, nothing more.
//
// The one governing rule (the author's own ruling, relayed in the brief):
// "do not block or filter keys." This module NEVER drops a real keystroke
// because it looks dangerous (ctrl+z is a real, accepted mapping — see
// `terminal-backend-report.md`'s safety finding) and never adds one the user
// didn't press (no appended newline, no macro expansion). The only keys it
// ever ignores are ones that carry no keystroke of their own to send — a
// bare modifier key going down by itself (`Control`, `Shift`, ...) or an
// in-progress IME composition marker (`Dead`, `Process`) — because there is
// nothing yet to transmit, not because transmitting them would be unsafe.
//
// Herdr's accepted key vocabulary (verified live against Herdr 0.8.0 by the
// backend round, see `terminal-backend-report.md`) is deliberately NOT
// hardcoded here as a strict allowlist: the report explicitly found `ctrl+z`
// IS accepted for validation despite not appearing in its own "Accepted"
// bullet list, so a strict allowlist built from that list alone would have
// silently dropped a real, working combination. Instead this module follows
// Herdr's own consistent naming pattern (`ctrl+<key>`, `alt+<key>`,
// `meta+<key>`, `shift+<named>`) generically, for any physical combination —
// an unsupported one is sent anyway and comes back as Herdr's own honest,
// specific `invalid_key` error ("unsupported key ctrl+q"), which
// `Terminal.tsx` surfaces exactly like any other send failure. That is
// honesty, not guessing: the pattern itself is documented and verified, only
// its full extent isn't enumerable from the outside.
export type PaneInput = { kind: "text"; value: string } | { kind: "keys"; value: string[] };

/** `event.key` values that carry no character of their own — a modifier
 * going down alone, or a mid-composition IME marker. Nothing to send yet. */
const IGNORED_KEYS = new Set([
  "Control",
  "Alt",
  "Meta",
  "Shift",
  "AltGraph",
  "CapsLock",
  "OS",
  "Dead",
  "Process",
  "Unidentified",
]);

/**
 * The six keys herdr's `send_keys` has no word for, and the bytes a
 * terminal emulator sends for each — the terminal-feel round's answer to
 * "a terminal UI has to decide what to do with the keys that have nowhere
 * to go" (`phase-0-followups.md` §8.4).
 *
 * THE RULING THIS RESTS ON (spec §5.6, terminal-feel amendment):
 * translating one real keypress into the byte sequence a terminal emulator
 * would send for that keypress is not synthesising input — it is what a
 * terminal emulator IS. The prohibition §5.6 states exists to stop the app
 * acting on its own (macros, replay, auto-answering, retries). A keypress
 * is the user acting. Nothing here is ever sent except from a real
 * `keydown` on a focused surface, exactly like every other key.
 *
 * WHERE THESE SPECIFIC BYTES COME FROM — not invented, and not copied from
 * memory. herdr launches panes with `TERM=xterm-256color` (read out of a
 * live pane: `echo TERM=$TERM`), and this machine's own terminfo for that
 * terminal declares exactly these:
 *
 *     infocmp xterm-256color
 *       kpp=\E[5~   knp=\E[6~   khome=\EOH
 *       kend=\EOF   kdch1=\E[3~ kich1=\E[2~
 *
 * VERIFIED LIVE, against a throwaway workspace this session created and
 * closed: `\x1b[6~`/`\x1b[5~` paged `less` forward and back; `\x1bOH`,
 * `\x1bOF` and `\x1b[3~` moved zsh's cursor home, to the end, and deleted
 * forward. `pane.send_text` was confirmed to carry the real ESC byte (a
 * pane running `cat -v` echoed `^[[5~`), which is the only reason this
 * table can work at all.
 *
 * Only the UNMODIFIED keys are here. xterm has a modifier encoding for
 * these (`\x1b[1;5H` for ctrl+Home and so on), and this module does not
 * guess at it: ctrl+Home still goes to herdr as `ctrl+home` and comes back
 * as herdr's own honest "unsupported key", which is a better answer than a
 * plausible-looking sequence nobody has tested.
 */
export const KEY_ESCAPE_SEQUENCES: Record<string, string> = {
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Home: "\x1bOH",
  End: "\x1bOF",
  Delete: "\x1b[3~",
  Insert: "\x1b[2~",
};

/** `event.key` -> Herdr's own logical-key name, for keys with no printable
 * character of their own. Still includes the six names Herdr is verified to
 * REJECT (`delete`, `home`, `end`, `pageup`, `pagedown`, `insert`) because
 * a MODIFIED press of one of them (ctrl+Home, shift+Delete) has nowhere
 * better to go and herdr's own error is the honest answer; an unmodified
 * press is handled by `KEY_ESCAPE_SEQUENCES` above and never reaches
 * herdr's key vocabulary at all. */
const NAMED_KEYS: Record<string, string> = {
  Enter: "enter",
  Escape: "escape",
  Tab: "tab",
  Backspace: "backspace",
  " ": "space",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Delete: "delete",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Insert: "insert",
  F1: "f1",
  F2: "f2",
  F3: "f3",
  F4: "f4",
  F5: "f5",
  F6: "f6",
  F7: "f7",
  F8: "f8",
  F9: "f9",
  F10: "f10",
  F11: "f11",
  F12: "f12",
};

/** Named keys Herdr is verified to accept with a `shift+` prefix — only
 * these get one; an unlisted key held with Shift falls back to its plain
 * name (Herdr has no vocabulary slot for e.g. `shift+enter`, and this app
 * invents no new one on its behalf). */
const SHIFTABLE = new Set(["up", "down", "left", "right", "tab"]);

/**
 * Decodes one `keydown` event into exactly what should reach the pane, or
 * `null` if this particular physical event carries nothing to send (a bare
 * modifier, a mid-composition marker). Every real keystroke — including
 * `ctrl+z` — decodes to something; nothing is filtered for being dangerous.
 *
 * Deliberately duck-typed against a plain object (not `KeyboardEvent`) so
 * this stays testable without a DOM, matching `useHotkey.ts`'s own
 * `decideHotkey` convention.
 */
export function decodePaneKey(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): PaneInput | null {
  const { key, ctrlKey, altKey, metaKey, shiftKey } = event;
  if (IGNORED_KEYS.has(key)) return null;

  // The three ⌘ chords no terminal emulator on this platform forwards to
  // the pty, because on macOS ⌘ is the APPLICATION's modifier: ⌘C copies,
  // ⌘V pastes, ⌘A selects all, and the pane never sees any of them — not
  // in iTerm2, not in Ghostty, not in Terminal.app. Forwarding them was
  // the bug, not the fix: herdr accepts `meta+c` and `cmd+c` without
  // complaint (probed live), so ⌘C used to put bytes into the author's
  // session instead of copying their selection, which is exactly what
  // "you can't click in it" felt like from the other side.
  //
  // Returning `null` here — rather than letting `Terminal.tsx` intercept
  // them earlier — is the same mechanical proof `switchTerminalKey` below
  // relies on: whatever that component does or stops doing, these three
  // combinations have no path to a pane, and `terminalKeys.test.ts`
  // asserts it. Every OTHER ⌘ chord is unchanged and still forwarded.
  if (metaKey && !ctrlKey && !altKey && (key === "c" || key === "v" || key === "a")) {
    return null;
  }

  // No ctrl/alt/meta held: a single printable character (letters, digits,
  // punctuation, space) is literal typed text — sent as text, not as a
  // named key, so it needs no per-character entry in `NAMED_KEYS` and
  // renders exactly the character the user's own keyboard layout produced
  // (accents, symbols, non-Latin scripts included).
  if (!ctrlKey && !altKey && !metaKey && key.length === 1) {
    return { kind: "text", value: key };
  }

  const named = NAMED_KEYS[key];

  // No modifier at all, but a NAMED (non-printable) key — Enter, Escape,
  // Tab, Backspace, arrows, function keys, and the six herdr has no word
  // for, which travel as the escape bytes a terminal emulator sends (see
  // `KEY_ESCAPE_SEQUENCES`). Shift is allowed to ride along here: shift+End
  // is still End as far as these sequences go, and inventing xterm's
  // modifier encoding for it is exactly the guess this module refuses to
  // make.
  if (!ctrlKey && !altKey && !metaKey) {
    const sequence = KEY_ESCAPE_SEQUENCES[key];
    if (sequence !== undefined) return { kind: "text", value: sequence };
    if (!named) return null;
    return { kind: "keys", value: [shiftKey && SHIFTABLE.has(named) ? `shift+${named}` : named] };
  }

  // Exactly one of ctrl/alt/meta (Herdr's documented combos are never more
  // than one modifier plus an optional shift — `ctrl+shift+c` is the one
  // exception, handled explicitly).
  const base = named ?? key.toLowerCase();
  if (ctrlKey && !altKey && !metaKey) {
    return { kind: "keys", value: [shiftKey ? `ctrl+shift+${base}` : `ctrl+${base}`] };
  }
  if (altKey && !ctrlKey && !metaKey) {
    return { kind: "keys", value: [`alt+${base}`] };
  }
  if (metaKey && !ctrlKey && !altKey) {
    return { kind: "keys", value: [`meta+${base}`] };
  }

  // Multiple modifiers held together in some other combination (e.g.
  // ctrl+alt+X) — Herdr has no documented vocabulary for this shape, and
  // guessing one would risk sending something that LOOKS like a keystroke
  // but isn't the one the user pressed. Nothing to send is more honest than
  // a wrong guess here.
  return null;
}

/**
 * The three ⌘ chords the TERMINAL SURFACE handles itself, because on macOS
 * they belong to the application and not to the pane: ⌘C copy, ⌘V paste,
 * ⌘A select all. Exactly the set `decodePaneKey` above is proven to return
 * `null` for, so there is no combination here that could also reach a pane.
 *
 * This is the "feels like iTerm2" list, and it is short on purpose. ⌘K
 * (clear screen), ⌘F (find) and the rest are not here: this app has no
 * screen of its own to clear and no find bar, and claiming a chord it then
 * does nothing with would be worse than passing it along.
 *
 * Duck-typed, same convention as the two functions around it.
 */
export function terminalEditKey(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): "copy" | "paste" | "select-all" | null {
  if (!event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "c") return "copy";
  if (event.key === "v") return "paste";
  if (event.key === "a") return "select-all";
  return null;
}

/**
 * The app-level shortcut the terminal surface itself acts on:
 * **ctrl+alt+Tab** for the next agent's terminal, **ctrl+alt+shift+Tab**
 * for the previous one. The gesture the author actually asked for — easy
 * switching between terminals — measured
 * against the bar the product sets itself, which is cycling terminal tabs.
 *
 * The rule this had to satisfy is the hard one. The terminal owns the
 * keyboard — every keystroke typed into it goes to the agent, and §5.6
 * forbids the app synthesising input the user did not type. A shortcut that
 * the pane ALSO receives would put a stray `ctrl+alt+tab` into someone's
 * live session; a shortcut some other listener eats first would be dead.
 *
 * So this is deliberately NOT a new exception carved out of `decodePaneKey`
 * above — that function's governing rule ("do not block or filter keys") is
 * the author's own, and stealing a key from the agent would break it.
 * Instead, this combination was chosen from the set `decodePaneKey` ALREADY
 * returns `null` for: two of ctrl/alt/meta held together, which falls past
 * every single-modifier branch above and sends nothing. `terminalKeys.test.ts`
 * asserts exactly that invariant against this function, so the proof that
 * it cannot leak into a pane is mechanical rather than a claim — and it
 * stays true if either side is ever edited.
 *
 * Why these specific keys, rather than any other null-decoding pair:
 *
 * - **`Tab`** rather than a letter, because `event.key` for a named key is
 *   the same string on every keyboard layout. On macOS, Option composes the
 *   character a letter key produces (`alt+k` reports `˚`, not `k`), so a
 *   letter-based ctrl+alt shortcut is layout- and OS-dependent in a way this
 *   one is not. Tab is also what every terminal, browser and editor already
 *   means by "cycle", and claude's own pane prints "shift+tab to cycle" at
 *   the bottom of its screen — so shift for "backwards" needs no teaching.
 * - **`ctrl+alt`** rather than a pair involving Meta, because macOS itself
 *   claims a great many Cmd-based combinations (Cmd+Opt+Esc, Cmd+Ctrl+Space,
 *   Cmd+Tab) and essentially no Ctrl+Opt ones by default.
 *
 * TWO MODIFIERS IS THE FLOOR, NOT A PREFERENCE. Cmd+Tab is two keys; this
 * is three. That cost is imposed entirely by the surface: a terminal that
 * forwards every keystroke leaves only the combinations it *cannot* forward
 * available, and those are exactly the multi-modifier ones. The cheap path
 * to any agent is therefore the strip's own one click, which beats
 * tab-cycling outright by being direct rather than sequential; the chord is
 * the keyboard equivalent for the hand already on the home row.
 *
 * What this CANNOT prove, said plainly rather than glossed: nothing in the
 * webview can observe a shortcut the OS swallows before the webview ever
 * sees it. macOS binds no Ctrl+Option+Tab by default, and VoiceOver (whose
 * "VO" modifier is Ctrl+Option) is off unless the user turns it on — if it
 * is on, that is a real conflict and this key is the wrong one for that
 * machine.
 *
 * Duck-typed against a plain object, same convention as `decodePaneKey`.
 */
export function switchTerminalKey(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): "next" | "previous" | null {
  if (!event.ctrlKey || !event.altKey || event.metaKey || event.key !== "Tab") return null;
  return event.shiftKey ? "previous" : "next";
}
