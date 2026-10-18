// A small, pure ANSI SGR (Select Graphic Rendition) parser — the game-feel
// round's fix for the terminal panel showing raw escape codes as visible
// garbage instead of colour. Deliberately NOT a full terminal emulator (no
// cursor movement, no screen clearing, no OSC sequences): `read_agent`
// returns a scrollback snapshot, never a live cursor-controlled screen, so
// the only escape sequences worth understanding are the ones that colour
// text. Anything else (an unrecognised escape sequence) is silently
// dropped rather than left visible — showing `\x1b[?25l` as literal text
// would be a worse failure than showing plain, uncoloured text.
//
// Pure and framework-free on purpose (this codebase's "business logic in
// plain .ts, components are thin renderers" convention) so the parsing is
// unit-testable without a DOM.

export type AnsiSpan = {
  text: string;
  /** A CSS colour string, or `undefined` for "use the terminal's default
   * foreground/background" — never a fabricated colour for text that had
   * none. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
};

/** The 16 standard ANSI colours, tuned slightly warmer/softer than pure
 * primaries so they sit comfortably on the terminal's near-black background
 * (see `Terminal.tsx`) rather than vibrating against it. Indexed exactly as
 * the SGR codes name them: 0-7 normal, 8-15 bright. */
const ANSI_COLORS = [
  "#5b6270", // 0 black (never pure #000 — invisible on a near-black bg)
  "#e0716a", // 1 red
  "#8fc97a", // 2 green
  "#e0b95f", // 3 yellow
  "#6fa8dc", // 4 blue
  "#c58fd6", // 5 magenta
  "#5fc2c9", // 6 cyan
  "#c9d1d9", // 7 white
  "#7d8590", // 8 bright black (grey)
  "#f0958e", // 9 bright red
  "#b3e69c", // 10 bright green
  "#f0d585", // 11 bright yellow
  "#94c6f2", // 12 bright blue
  "#e0b3f0", // 13 bright magenta
  "#8fe6ec", // 14 bright cyan
  "#ffffff", // 15 bright white
];

// Any CSI sequence (`ESC [ <params> <final byte>`), not only the `m`-
// terminated colour ones — a real agent's terminal output can carry cursor-
// movement/clear-line/hide-cursor sequences too (`\x1b[2K`, `\x1b[?25l`,
// `\x1b[1;1H`, ...), and this is a scrollback SNAPSHOT with no cursor to
// move, so every one of those is simply dropped rather than left visible as
// literal escape-code garbage — exactly the failure the author's screenshot
// showed. Only a `m`-terminated match is interpreted (as colour/style); any
// other final byte still consumes the sequence but contributes no span.
const CSI_RE = /\x1b\[([0-9;?]*)([@-~])/g;
// OSC sequences (`ESC ] ... BEL` or `ESC ] ... ESC \`) — used for things
// like setting a terminal-tab title — carry no visible text of their own.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Parses one string of (possibly ANSI-coloured) terminal text into styled
 * spans, ready to render as a sequence of `<span>`s. A string with no escape
 * codes at all comes back as one plain span — the common case for a lot of
 * `read_agent` output — so callers never pay for styling machinery they
 * don't need.
 */
export function parseAnsi(rawText: string): AnsiSpan[] {
  // A bare `\r` (not part of `\r\n`) is a real terminal's "return to the
  // start of THIS line and overwrite it" — meaningful for a live progress
  // bar, meaningless for a static snapshot with no re-render loop. Dropping
  // it (rather than rendering it, which browsers do inconsistently) avoids
  // stray blank-looking artifacts without pretending to replay the overwrite.
  const text = rawText.replace(OSC_RE, "").replace(/\r(?!\n)/g, "");
  const spans: AnsiSpan[] = [];
  let current: Omit<AnsiSpan, "text"> = {};
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  CSI_RE.lastIndex = 0;
  OSC_RE.lastIndex = 0;

  const pushSpan = (chunk: string) => {
    if (chunk.length === 0) return;
    spans.push({ text: chunk, ...current });
  };

  while ((match = CSI_RE.exec(text)) !== null) {
    pushSpan(text.slice(lastIndex, match.index));
    lastIndex = CSI_RE.lastIndex;
    if (match[2] === "m") current = applyCodes(current, match[1]);
    // Any other final byte (cursor/clear/mode-set controls): the sequence
    // is already consumed by the regex match; it simply produces no span.
  }
  pushSpan(text.slice(lastIndex));
  return spans;
}

function applyCodes(base: Omit<AnsiSpan, "text">, codesRaw: string): Omit<AnsiSpan, "text"> {
  // No digits at all (`\x1b[m`) is shorthand for `\x1b[0m` — reset.
  const codes = codesRaw === "" ? [0] : codesRaw.split(";").map((c) => Number(c) || 0);
  let style = { ...base };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) style = {};
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code >= 30 && code <= 37) style.fg = ANSI_COLORS[code - 30];
    else if (code === 39) style.fg = undefined;
    else if (code >= 40 && code <= 47) style.bg = ANSI_COLORS[code - 40];
    else if (code === 49) style.bg = undefined;
    else if (code >= 90 && code <= 97) style.fg = ANSI_COLORS[8 + (code - 90)];
    else if (code >= 100 && code <= 107) style.bg = ANSI_COLORS[8 + (code - 100)];
    else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
      // 256-colour palette (`38;5;<n>`) — only the 16 basic slots (0-15) map
      // onto `ANSI_COLORS`; anything past that (the 216-colour cube or the
      // greyscale ramp) is real information this parser doesn't have a
      // palette for, so it's left as "no colour" rather than guessed at.
      const n = codes[i + 2];
      const color = n !== undefined && n < 16 ? ANSI_COLORS[n] : undefined;
      if (code === 38) style.fg = color;
      else style.bg = color;
      i += 2;
    } else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
      // Truecolour (`38;2;r;g;b`) — this one IS fully specified, unlike the
      // 256-colour cube above, so it's rendered exactly.
      const r = codes[i + 2] ?? 0;
      const g = codes[i + 3] ?? 0;
      const b = codes[i + 4] ?? 0;
      const color = `rgb(${r}, ${g}, ${b})`;
      if (code === 38) style.fg = color;
      else style.bg = color;
      i += 4;
    }
    // Any other code (cursor movement, screen-clear, unrecognised) has
    // already been stripped by `CSI_RE` matching the whole `\x1b[...m`
    // sequence — nothing further to do, and nothing left visible as raw
    // escape text either.
  }
  return style;
}
