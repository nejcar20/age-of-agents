import { useTradeRoutes } from "./TradeRoutes";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  markAgentSeen,
  readClipboardText,
  readPane,
  readPaneScrollback,
  sendPaneKeys,
  sendPaneText,
} from "../agents";
import { nextSwitchTarget } from "../agentSwitcher";
import {
  decodePaneKey,
  switchTerminalKey,
  terminalEditKey,
} from "../terminalKeys";
import { fitScale } from "../terminalScale";
import { raiseExternalTerminal, RAISE_EXTERNAL_TERMINAL_LABEL, RAISE_EXTERNAL_TERMINAL_TITLE } from "../externalTerminal";
import { ROW_PX, hasScrollback, wheelSteps } from "../terminalScroll";
import { copyCompletedSelection, selectedOutputText } from "../terminalSelection";
import { useTerminalStage } from "../terminalStage";
import { useWindowFocused } from "../useWindowFocused";
import { ATTENTION_LABEL, ATTENTION_MARK, type Agent } from "../world";
import { AnsiText } from "./AnsiText";
import { searchTerminalOutput } from "../terminalSearch";
import { TerminalSearchOutput } from "./TerminalSearchOutput";
import { TerminalPromptComposer } from "./TerminalPromptComposer";
const DirectTerminal = lazy(() => import("./DirectTerminal").then(module => ({ default: module.DirectTerminal })));

/** The IDLE interval: how long to wait before re-reading a pane nobody is
 * typing into. 250ms is the backend report's own suggestion and is fine for
 * WATCHING an agent work — a person reading a terminal does not perceive a
 * quarter-second lag as "stale".
 *
 * It was never fine for TYPING, which is what the author found the moment they
 * used this for real work: typing in the real terminal was fast, and here it
 * lagged. A typed character cannot appear before the next scheduled read, so
 * this interval alone put an average of ~125ms and a worst case of 250ms
 * between a keypress and the echo — measured end to end at a median of
 * 118ms, mean 124ms, max 251ms (see `typing-latency-report.md`). That is the
 * whole of the lag; the work itself is nothing (a `pane.read` round trip
 * over the herdr socket measures 0.2ms median, connect included).
 *
 * Only ticks while this panel is mounted AND the window is actually focused
 * (`useWindowFocused`) — no background polling for a terminal nobody is
 * looking at. */
const POLL_MS = 250;

/** The TYPING interval: one display frame. While the user is actively typing
 * this panel reads at 16ms instead of 250ms, which is the entire fix for the
 * lag above — the mirror asks sooner, it never draws a character the pane has
 * not actually echoed (see this component's doc comment: predicted echo is
 * forbidden here, and nothing below invents a single glyph).
 *
 * Affordable because a read is genuinely cheap (0.2ms), because reads never
 * overlap (the loop schedules the next read only once the previous one has
 * settled, so a slow herdr answer backs the rate off by itself instead of
 * queueing), and because a read that returns the identical screen still costs
 * zero re-renders — the `lastTextRef` diff below was already doing that work
 * at 250ms and does proportionally more of it at 16ms. Faster than one frame
 * would be pointless: the browser cannot paint a character sooner than the
 * next frame regardless of when we learn about it. */
const TYPING_POLL_MS = 16;

/** How long a keystroke keeps the fast rate alive. Half a second covers the
 * gap between keystrokes of even slow typing (and the pause while an agent
 * starts answering a just-submitted line) without leaving a panel polling at
 * 60Hz for a user who typed one character and walked away. Every keystroke
 * pushes the window out again, so a burst of typing stays fast throughout and
 * one keystroke costs at most half a second of fast polling. */
const TYPING_WINDOW_MS = 500;

/** How close to the bottom of the scrollback counts as "you are back at
 * the live screen". Smaller than one row (`ROW_PX`), so entering
 * scrollback one row up cannot immediately bounce straight back out. */
const AT_BOTTOM_PX = 4;

// The switcher strip's glyphs and words come from the SHARED vocabulary in
// `world.ts` now, rather than from a third hand-copied table with a comment
// asking politely that it stay in step. This strip appears over both
// screens, next to both panels, which is exactly where a drifted word would
// be read side by side with its original.

type ScreenState =
  | { status: "loading" }
  | { status: "error"; message: string }
  // `truncated` is the app's own structured field, rendered as its own
  // affordance below, never spliced into `text` — same discipline as
  // `AgentActions`'s identical type: the untrusted agent's own screen
  // content and the app's own words about it must never be able to look
  // like the same thing.
  | { status: "ready"; text: string; truncated: boolean };

/**
 * The interactive terminal (Phase 0.7, spec §5.6, asked for by the author on
 * 2026-09-19). A TRUE MIRROR of one
 * Herdr pane: the same pane, the same session, visible identically in the
 * user's own terminal emulator at the same time — not a second, independent
 * session. The separate prompt composer uses Herdr's `agent.prompt` with
 * its own explicit submission semantics; its draft never becomes output
 * on this surface. The mirror shows the pane's current screen and forwards
 * exactly the keystrokes the user types into IT straight into the pane.
 *
 * IMPORTANT — this renders a SCREEN SNAPSHOT on a poll timer, not a stream.
 * `pane_read` always asks Herdr for `source: "visible"` — the CURRENT state
 * of the screen, already resolved (cursor movement/redraws already applied
 * server-side), never a scrollback log to append to. That is why this reuses
 * `ansi.ts`/`AnsiText` (a plain SGR-colour parser) rather than a real
 * terminal emulator like xterm.js: an emulator expects an incremental BYTE
 * STREAM it replays into its own persistent screen buffer, and feeding it
 * repeated whole-screen snapshots would duplicate every line on every poll
 * instead of replacing the screen — the exact trap the brief warns about.
 * Every successful `pane_read` here REPLACES the rendered text wholesale;
 * there is no append path anywhere in this component.
 *
 * NO LOCAL ECHO, EVER. Every character on this surface came back from a
 * real `pane.read`; not one is drawn because the user pressed a key. A real
 * terminal emulator can afford to echo locally because it owns the screen it
 * is drawing; this owns nothing — it is a view of a screen that lives
 * somewhere else, and drawing a character before the pane has actually
 * echoed it would be showing output that does not exist yet. That is the
 * project's own governing rule ("it never draws something that is not on
 * disk") applied to a pane, and it is the condition §5.6 attaches to this
 * capability existing at all. So when typing felt laggy the answer was to
 * ASK SOONER — read the moment a keystroke lands, and keep reading at one
 * frame while the user is typing (`TYPING_POLL_MS`) — and never to guess.
 * The cost of that honesty is real and bounded: a character appears one
 * round trip after the pane echoes it, not instantly.
 *
 * `revision` (also returned by `pane_read`) is deliberately never read here —
 * the backend measured it staying `0` across every real read against a
 * local pane regardless of content changes (see `agents.ts`'s `readPane` doc
 * comment). Change detection instead diffs the raw `text` against what was
 * last rendered (`lastTextRef`) and only calls `setState` on an actual
 * difference, so a tick that returns identical content costs one `useState`
 * check, not a full re-render.
 *
 * FOCUS IS THE SAFETY BOUNDARY. Every keystroke this component ever sends
 * originates from a real `onKeyDown` on `surfaceRef` — the one focusable
 * element rendered here — while it is the actual `document.activeElement`.
 * There is no other path to `sendPaneText`/`sendPaneKeys` anywhere in this
 * component: no timer, no effect, no "helpful" completion. Losing focus
 * (clicking anywhere else in the app, including this very dialog's own
 * header or close button) stops keystrokes from reaching the pane
 * immediately — verified directly in `Terminal.test.tsx`.
 *
 * A CLICK IS NOT FORWARDED TO THE PANE, AND CANNOT HONESTLY BE (terminal-
 * polish round, the author: "if i click in it it doesnt pass the click
 * through"). Herdr 0.9.0's API has `pane.send_text`, `pane.send_keys` and
 * `pane.send_input`, and no mouse event of any kind — its whole pane-input
 * vocabulary is keystrokes. The only way to deliver a click would be to
 * synthesise xterm mouse-REPORTING escape sequences (DECSET 1000/1002/1006)
 * and inject them as text, and those are mode-dependent: if the foreground
 * program has not enabled mouse reporting, the bytes land as garbage in
 * the user's input line. Still ruled out, and the footer says so.
 *
 * WHAT A CLICK DOES DO, since the terminal-feel round, is what a click
 * does in iTerm2 or Ghostty: it takes focus, and it SELECTS TEXT. Both are
 * pure DOM and touch herdr not at all. `onMouseDown` focuses the surface
 * explicitly rather than trusting WKWebView's default handling of
 * `tabindex="0"` (the consequence of getting that wrong is a terminal that
 * looks live and swallows every keystroke) and never calls
 * `preventDefault`, so drag-select, double-click-for-a-word and
 * triple-click-for-a-line all behave normally. ⌘C copies the selection,
 * ⌘A selects the whole screen, ⌘V pastes — see `terminalEditKey` for why
 * those three chords are the app's and not the pane's.
 *
 * SCROLLING, and why it is two different things (terminal-feel round, the
 * author: the terminal could not be scrolled). There is no `pane.scroll` in
 * herdr's API — `pane.scroll_changed` is an event, and nothing drives a
 * pane's viewport — so what the wheel can do depends entirely on what the
 * pane actually has:
 *
 * - A pane with real scrollback (a shell that has scrolled: 141 lines from
 *   `source: "recent"` against 23 from `visible`, measured) gets a real
 *   scrollback view. The wheel enters it, the DOM scrolls it, and the live
 *   mirror is PAUSED while it is up and says so — showing a live screen
 *   and a frozen history at the same time would be two truths in one box.
 * - A full-screen program may expose no snapshot scrollback. In that case
 *   the wheel stays local and explains the limit. Direct control routes
 *   scroll requests through Herdr’s native scroll protocol; only explicit
 *   keyboard events may send PageUp/PageDown to a mirrored application.
 *
 * This component does NOT filter or block any key, including `ctrl+z` (the
 * backend's own documented hazard: sent to an idle shell, it suspends the
 * shell and Herdr auto-closes the whole workspace). The author's explicit
 * ruling: a real terminal passes it through, the same thing happens if he
 * types it into his own terminal emulator, and a filtered terminal would no
 * longer be the "true mirror" this capability is only authorized to be. The
 * boundary this component enforces is WHERE keys come from (a focused
 * surface, and only that), never WHICH keys are allowed once they do.
 */
export function Terminal({
  agent,
  root,
  onClose,
  embedded = false,
  autoFocus = false,
  active = true,
  initialMode = "mirror",
}: {
  agent: Agent;
  /** The island's own canonical root this pane belongs to, passed as
   * `expected_root` on every read/send call — Herdr recycles `w<N>:p1`
   * pane ids once a workspace closes, and a stale id reused for a different
   * repository must be refused, not silently misdelivered (or, worse here,
   * silently mis-READ into this dialog's own screen). */
  root: string;
  onClose: () => void;
  embedded?: boolean;
  autoFocus?: boolean;
  /** Only one split terminal may own global shortcuts and autofocus. */
  active?: boolean;
  initialMode?: "mirror" | "direct";
}) {
  const tradeRoutes = useTradeRoutes();
  const [screen, setScreen] = useState<ScreenState>({ status: "loading" });
  const [focused, setFocused] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [showComposer, setShowComposer] = useState(false);
  const targetIdentity = JSON.stringify([root, agent.pane_id]);
  const [modeChoice, setModeChoice] = useState<{ target: string; mode: "mirror" | "direct" } | null>(null);
  const [directReady, setDirectReady] = useState(false);
  const directTarget = modeChoice?.target === targetIdentity ? modeChoice.mode : initialMode;
  const setDirectTarget = (target: string | null) => setModeChoice({ target: targetIdentity, mode: target ? "direct" : "mirror" });
  const directMode = directTarget === "direct";
  const directRef = useRef(directMode);
  directRef.current = directMode;
  useEffect(() => { setDirectReady(false); }, [root, agent.pane_id]);
  // An open terminal is a look at the agent, so a finished one is seen — but
  // only while the app has focus: a dock left open while the user is in
  // another app must not swallow the "done" it would otherwise come back to.
  const stopped = agent.attention === "stopped";
  useEffect(() => {
    if (!stopped) return;
    const markSeen = () => { markAgentSeen(agent.pane_id).catch(() => { /* Cosmetic; the next open retries. */ }); };
    if (document.hasFocus()) { markSeen(); return; }
    window.addEventListener("focus", markSeen, { once: true });
    return () => window.removeEventListener("focus", markSeen);
  }, [stopped, agent.pane_id]);
  const findRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [textSize, setTextSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("aoa.terminalTextSize"));
      return saved >= 10 && saved <= 24 ? saved : 14;
    } catch { return 14; }
  });
  const [fitPane, setFitPane] = useState(false);
  const resizeText = (delta: number) => {
    setFitPane(false);
    setTextSize(current => {
      const next = Math.max(10, Math.min(24, current + delta));
      try { localStorage.setItem("aoa.terminalTextSize", String(next)); } catch { /* Session-only preference. */ }
      return next;
    });
  };

  const [sendError, setSendError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const blockedByDialog = useCallback(() => {
    const owner = terminalRef.current;
    return [...document.querySelectorAll('[role="dialog"]')].some(dialog =>
      !owner?.contains(dialog) && !dialog.contains(owner),
    );
  }, []);
  const autofocusAttemptedRef = useRef(false);
  useEffect(() => {
    if (autofocusAttemptedRef.current) return;
    autofocusAttemptedRef.current = true;
    const editing = document.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
    if (autoFocus && active && !editing && !blockedByDialog() && !terminalRef.current?.contains(document.activeElement)) {
      surfaceRef.current?.focus();
    }
  }, [autoFocus, active, blockedByDialog]);
  const wasFindOpenRef = useRef(false);
  useEffect(() => {
    const opening = showFind && !wasFindOpenRef.current;
    wasFindOpenRef.current = showFind;
    if (opening && active) findRef.current?.focus();
  }, [showFind, active]);
  // Item 2's measurement pair: `fitRef` is the box the grid may occupy,
  // `gridRef` is the grid at its true, unscaled layout size (a CSS
  // transform does not change `offsetWidth`/`offsetHeight`, which is
  // exactly why the measurement stays stable while the drawn size changes).
  const fitRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const liveAtBottomRef = useRef(true);
  const [grid, setGrid] = useState<{ scale: number; width: number; height: number } | null>(null);
  const lastTextRef = useRef<string | null>(null);
  const lastTruncatedRef = useRef<boolean | null>(null);
  const inFlightRef = useRef(false);
  /** Typing-latency round. `typingUntilRef` is the moment the fast rate
   * expires (pushed out by every keystroke); `readNowRef` is the read loop's
   * own "read as soon as you can" handle, installed by the effect that owns
   * the timer and reset to a no-op when that effect tears down — so nothing
   * can trigger a read for an unmounted or blurred terminal; `readSoonRef`
   * is the one-bit queue for a request that arrives while a read is already
   * in flight. */
  const typingUntilRef = useRef(0);
  const readNowRef = useRef<() => void>(() => {});
  const readSoonRef = useRef(false);
  /** Terminal-feel round. `scrollback` non-null IS the mode: the live poll
   * is paused and the history is on screen. `wheelAccumRef` adds up
   * sub-line trackpad deltas, `wheelBusyRef` is the same one-at-a-time
   * guard the read loop uses (a wheel gesture costs one `pane.read`),
   * and `pendingScrollRef` carries the gesture's offset from the bottom
   * into the freshly-rendered scrollback box. */
  const [scrollback, setScrollback] = useState<{ text: string; truncated: boolean } | null>(null);
  const outputText = scrollback?.text ?? (screen.status === "ready" ? screen.text : "");
  const searchedOutput = useMemo(() => showFind && findQuery
    ? searchTerminalOutput(outputText, findQuery)
    : { spans: [], matches: [] }, [outputText, findQuery, showFind]);
  const matchCount = searchedOutput.matches.length;
  const currentMatch = Math.min(matchIndex, Math.max(0, matchCount - 1));
  useEffect(() => setMatchIndex(0), [outputText, findQuery]);
  const navigateMatch = (direction: number) => {
    if (matchCount) setMatchIndex((currentMatch + direction + matchCount) % matchCount);
  };
  useEffect(() => {
    if (!showFind || !findQuery || !matchCount) return;
    terminalRef.current?.querySelector(".terminal__match--current")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [showFind, findQuery, currentMatch, searchedOutput, matchCount]);
  const scrollbackOpen = scrollback !== null;
  const scrollbackRef = useRef(false);
  scrollbackRef.current = scrollbackOpen;
  const scrollBoxRef = useRef<HTMLDivElement | null>(null);
  const wheelAccumRef = useRef(0);
  const wheelBusyRef = useRef(false);
  const pendingScrollRef = useRef(0);
  /** Said out loud when a scroll gesture could not do the obvious thing —
   * the "make the distinction legible" half of the scrolling work. */
  const [scrollNote, setScrollNote] = useState<string | null>(null);
  const windowFocused = useWindowFocused();
  // Lag-and-switcher round, both halves. See `terminalStage.tsx` for why
  // these two arrive by context rather than as props from four levels up.
  const stage = useTerminalStage();
  const { claimScene, switchTo, targets } = stage;
  // Item 1: while this dialog is up, the sea behind it stops rendering.
  // Mount/unmount are the ONLY two events that can change that — see
  // `claimScene`'s own doc comment — so there is no path by which closing
  // (or crashing) this component leaves the scene paused.
  useEffect(() => claimScene(), [claimScene]);
  // Read by the window-level key listener below, which is deliberately
  // subscribed once (it must not re-attach on every `world-updated` push,
  // and a listener that owns a keystroke is not something to churn).
  const switchRef = useRef({ targets, switchTo, paneId: agent.pane_id });
  switchRef.current = { targets, switchTo, paneId: agent.pane_id };
  /** Said out loud when the switch key has nowhere to go. */
  const [switchNote, setSwitchNote] = useState<string | null>(null);

  useEffect(() => {
    const host = surfaceRef.current;
    if (!host || directMode) return;
    return copyCompletedSelection({ host,
      enabled: () => activeRef.current && !directRef.current && !blockedByDialog(),
      getText: () => selectedOutputText(scrollbackRef.current ? scrollBoxRef.current : gridRef.current),
      onError: setCopyError,
    });
  }, [directMode, agent.pane_id, root, blockedByDialog]);

  const poll = useCallback(() => {
    return readPane(agent.pane_id, root)
      .then(({ text, truncated }) => {
        // Diff against what was last actually rendered, per the backend's
        // own measured guidance ("`revision` is useless for change
        // detection... diff the returned `text` yourself") — a tick that
        // reports the identical screen triggers no re-render at all.
        if (text === lastTextRef.current && truncated === lastTruncatedRef.current) return;
        lastTextRef.current = text;
        lastTruncatedRef.current = truncated;
        setScreen({ status: "ready", text, truncated });
      })
      .catch((error) => {
        lastTextRef.current = null;
        lastTruncatedRef.current = null;
        setScreen({ status: "error", message: String(error) });
      });
  }, [agent.pane_id, root]);

  /**
   * THE READ LOOP. Starts/stops purely on mount state and window focus —
   * never on anything this component itself renders. Reads once immediately
   * (so opening the terminal doesn't wait an interval for its first paint),
   * then again and again, and always clears its timer on the way out,
   * including the moment the window loses focus: a background timer for a
   * panel nobody is looking at is exactly the "wasteful" this was scoped to
   * avoid, and a fast rate makes that guarantee matter more, not less.
   * Blurred and idle, this schedules nothing at all.
   *
   * A CHAIN OF TIMEOUTS, not `setInterval`, and that shape is load-bearing
   * three times over:
   *
   * - The next read is scheduled only once the previous one has SETTLED, so
   *   two reads of the same pane can never be in flight at once — the
   *   guarantee the old `inFlightRef` was there to provide, now structural.
   * - It self-limits. herdr's own answer time is bimodal on this machine
   *   (0.2ms usually, ~105ms in bursts — measured, see
   *   `typing-latency-report.md`), and a slow answer simply delays the next
   *   read instead of piling requests up behind it.
   * - The delay can change between reads, which is what lets the rate follow
   *   whether the user is typing (`TYPING_POLL_MS`) or watching
   *   (`POLL_MS`).
   *
   * `readSoonRef` is how `send` asks for a read the instant a keystroke has
   * actually reached the pane, rather than waiting out even the 16ms. If a
   * read is already in flight it sets a flag instead of starting a second
   * one, and the loop picks it up the moment the current read lands — one
   * extra read per keystroke at the very most, never a retry storm.
   */
  useEffect(() => {
    if (!windowFocused || directMode) return;
    // Terminal-feel round: while the scrollback view is up the mirror is
    // deliberately paused — there is nothing to paint, and polling a
    // screen nobody can see is the same "wasteful" the focus gate exists
    // to avoid. Leaving scrollback re-runs this effect, which reads
    // immediately, so going live is never a quarter-second stale.
    if (scrollbackOpen) return;
    let stopped = false;
    let timer = 0;
    const run = () => {
      if (stopped) return;
      inFlightRef.current = true;
      void poll().finally(() => {
        inFlightRef.current = false;
        if (stopped) return;
        const asap = readSoonRef.current;
        readSoonRef.current = false;
        const delay = asap ? 0 : Date.now() < typingUntilRef.current ? TYPING_POLL_MS : POLL_MS;
        timer = window.setTimeout(run, delay);
      });
    };
    readNowRef.current = () => {
      if (stopped) return;
      // A read is already on the wire; let it finish and take the next slot
      // immediately, rather than overlapping a second read onto the same
      // pane.
      if (inFlightRef.current) {
        readSoonRef.current = true;
        return;
      }
      window.clearTimeout(timer);
      run();
    };
    run();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      readNowRef.current = () => {};
      readSoonRef.current = false;
      inFlightRef.current = false;
    };
  }, [poll, windowFocused, scrollbackOpen, directMode]);

  /**
   * Item 2: re-fit the pane's grid to the panel. Measures the grid's true
   * layout size and the space it may fill, and stores the uniform factor
   * `fitScale` derives from the two (see `terminalScale.ts` for why this is
   * a zoom and emphatically not a `pane.resize`).
   *
   * Idempotent and cheap: it writes state only when the answer actually
   * moved, so a re-measure that agrees with what is already drawn costs one
   * comparison and no re-render — which is what makes it safe to call from
   * a `ResizeObserver` that this very state change can cause to fire again.
   */
  const measure = useCallback(() => {
    const fit = fitRef.current;
    const content = gridRef.current;
    if (fit === null || content === null) return;
    const natural = { width: content.offsetWidth, height: content.offsetHeight };
    const available = { width: fit.clientWidth, height: fit.clientHeight };
    const scale = fitPane ? fitScale(natural, available) : textSize / 13;
    setGrid((current) => {
      const next = {
        scale,
        width: natural.width * scale,
        height: natural.height * scale,
      };
      if (
        current !== null &&
        current.scale === next.scale &&
        Math.abs(current.width - next.width) < 0.5 &&
        Math.abs(current.height - next.height) < 0.5
      ) {
        return current;
      }
      return next;
    });
  }, [fitPane, textSize]);

  // Before the browser paints, so a freshly-read screen is never shown at
  // the wrong size for a frame. `screen` (not `screen.text`) because the
  // loading/error/ready switch changes what is in the box too.
  useLayoutEffect(() => {
    measure();
  }, [measure, screen, scrollbackOpen]);

  // Keep the input line visible at readable sizes, while preserving a
  // viewport the user deliberately scrolled upward to read.
  useLayoutEffect(() => {
    const box = fitRef.current;
    if (box && liveAtBottomRef.current) box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
  }, [grid, scrollbackOpen]);

  // The panel is user-resizable (`resize: both` in styles.css) and the
  // window itself can be resized, neither of which re-renders this
  // component — so the available box is watched directly. `ResizeObserver`
  // is absent in jsdom, where there is no layout to observe in the first
  // place; the `resize` listener is the honest fallback there and for the
  // window case generally.
  useEffect(() => {
    const onResize = () => {
      measure();
      // A fixed text size can keep the measured grid unchanged while
      // the viewport shrinks. Preserve bottom pinning in that case too.
      const box = fitRef.current;
      if (box && liveAtBottomRef.current) box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
    };
    window.addEventListener("resize", onResize);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", onResize);
    }
    const observer = new ResizeObserver(onResize);
    if (fitRef.current !== null) observer.observe(fitRef.current);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [measure, screen.status, scrollbackOpen]);

  const send = useCallback(
    (input: { kind: "text"; value: string } | { kind: "keys"; value: string[] }) => {
      // Someone is typing: hold the read loop at one-frame intervals for the
      // next half second, starting NOW rather than when this call comes
      // back, so the fast rate is already in force while the keystroke is
      // still travelling.
      if (!activeRef.current || directRef.current || blockedByDialog()) return;
      liveAtBottomRef.current = true;
      const box = fitRef.current;
      if (box) box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
      typingUntilRef.current = Date.now() + TYPING_WINDOW_MS;
      const call =
        input.kind === "text"
          ? sendPaneText(agent.pane_id, input.value, root)
          : sendPaneKeys(agent.pane_id, input.value, root);
      // The pane can echo before its send acknowledgement returns. Wake
      // the read loop now so an idle 250ms timer cannot hide that output.
      readNowRef.current();
      call
        .then(() => {
          setSendError(null);
          typingUntilRef.current = Date.now() + TYPING_WINDOW_MS;
          // ASK SOONER — the whole fix, in one line. herdr has accepted the
          // keystroke, so the pane is about to echo it; read now instead of
          // waiting for a timer. This does NOT assume the echo has already
          // happened: the read may well come back with the screen as it was
          // a moment ago, and if it does, this component draws exactly that
          // and the next read (one frame away, at most) picks up the echo.
          // What it must never do is draw the character itself — see the
          // module doc comment: a mirror that predicts is not a mirror.
          //
          // A second, deliberately-quick follow-up read was tried here and
          // MEASURED WORSE (median 22.9ms vs 17.5ms): scheduled at `0` it
          // is clamped to ~4ms by the browser's nested-timer rule, which
          // lands it in a photo finish with the echo it is chasing — it
          // usually arrives a fraction too early, and then the character
          // waits for the ordinary next read anyway, one read later than
          // before. Tuning that delay would mean tuning against how long a
          // real pane takes to echo, which cannot be measured from here
          // without sending keys to a real pane. Not guessed at: dropped.
          readNowRef.current();
        })
        .catch((error) => setSendError(String(error)));
    },
    [agent.pane_id, root, blockedByDialog],
  );

  /** Back to the live screen, and the only way out of scrollback: the
   * wheel reaching the bottom, any keystroke (iTerm2 and Ghostty both do
   * exactly this), or the bar's own button. Nothing else — in particular
   * no timer and no "the pane changed, better jump" — because a view that
   * scrolls itself out from under someone reading it is the single most
   * irritating thing a terminal can do. */
  const goLive = useCallback(() => {
    wheelAccumRef.current = 0;
    setScrollback(null);
    setScrollNote(null);
  }, []);

  /** ⌘V. The user pressed paste; the content is theirs. One clipboard
   * read, one `pane.send_text`, no newline appended and nothing trimmed —
   * whatever is on the clipboard is what a real terminal would put into
   * the pty, multiple lines included (a pasted multi-line command is
   * exactly why bracketed paste exists, and herdr's own pane owns that
   * end of it). A failure is surfaced in the same place a failed
   * keystroke is, never swallowed. */
  const paste = useCallback(() => {
    if (!activeRef.current || blockedByDialog()) return;
    readClipboardText()
      .then((text) => {
        if (text.length === 0) {
          setScrollNote("the clipboard is empty");
          return;
        }
        send({ kind: "text", value: text });
      })
      .catch((error) => setSendError(String(error)));
  }, [send, blockedByDialog]);

  /**
   * One wheel gesture, translated. Runs off a NON-PASSIVE native listener
   * (see the effect below) because React attaches `onWheel` passively and
   * `preventDefault` there is a no-op — without it the whole dialog
   * would scroll behind the terminal instead.
   *
   * At most one `pane.read` is ever in flight (`wheelBusyRef`), and the
   * drain re-runs itself afterwards so a gesture that arrived during the
   * read is not lost. The scrollback question is asked FRESH on every
   * gesture rather than cached: a pane stops being a full-screen program
   * the moment the agent exits, and a cached "no scrollback here" would
   * then be a lie with no event to correct it.
   */
  const drainWheel = useCallback(() => {
    if (wheelBusyRef.current || scrollbackRef.current || directRef.current || !activeRef.current || blockedByDialog()) return;
    const { steps, remainder } = wheelSteps(wheelAccumRef.current);
    if (steps === 0) return;
    wheelAccumRef.current = remainder;
    wheelBusyRef.current = true;
    const viewport = fitRef.current;
    const offsetFromBottom = viewport ? Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) : 0;
    readPaneScrollback(agent.pane_id, root)
      .then(({ text, truncated }) => {
        if (directRef.current || !activeRef.current || blockedByDialog()) return;
        const visible = lastTextRef.current ?? "";
        if (hasScrollback(visible, text)) {
          pendingScrollRef.current = steps * ROW_PX - offsetFromBottom;
          setScrollNote(null);
          setScrollback({ text, truncated });
          return;
        }
        // No scrollback: the program owns the screen. Scrolling down at
        // the live screen is already "you are at the bottom" — do not
        // send a PageDown nobody asked for.
        if (steps > 0) {
          setScrollNote(
            "this is the bottom — there is no scrollback in this pane, because the program running in it owns the whole screen",
          );
          return;
        }
        wheelAccumRef.current = 0;
        setScrollNote(
          "No earlier output in this mirror. Direct control provides the pane’s native scrolling; application navigation keys remain available from the keyboard.",
        );
      })
      .catch((error) => setSendError(String(error)))
      .finally(() => {
        wheelBusyRef.current = false;
        drainWheel();
      });
  }, [agent.pane_id, root, blockedByDialog]);

  // The wheel listener itself: native, non-passive, and attached to the
  // surface rather than the window so a wheel over the tab bar still
  // scrolls the tab bar.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!activeRef.current || directRef.current || blockedByDialog()) return;
      // In scrollback the box scrolls natively — the browser does it
      // better than we would, and `handleScrollbackScroll` notices when it
      // reaches the bottom.
      if (scrollbackRef.current) return;
      // At a readable fixed size, scroll the local viewport before asking
      // for pane history. Horizontal trackpad gestures stay local too.
      const fit = fitRef.current;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? ROW_PX : event.deltaMode === 2 ? fit?.clientHeight || ROW_PX : 1);
      if (fit && ((delta > 0 && fit.scrollTop + fit.clientHeight < fit.scrollHeight - AT_BOTTOM_PX) ||
          (delta < 0 && fit.scrollTop > AT_BOTTOM_PX))) {
        event.preventDefault();
        fit.scrollTop = Math.max(0, Math.min(fit.scrollHeight - fit.clientHeight, fit.scrollTop + delta));
        liveAtBottomRef.current = fit.scrollHeight - fit.clientHeight - fit.scrollTop <= AT_BOTTOM_PX;
        return;
      }
      event.preventDefault();
      wheelAccumRef.current += delta;
      drainWheel();
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, [drainWheel, directMode, blockedByDialog]);

  // Entering scrollback: land where the gesture asked for, measured from
  // the bottom, so the first wheel-up shows the rows that were just above
  // the screen rather than jumping to the beginning of history.
  useLayoutEffect(() => {
    const box = scrollBoxRef.current;
    if (box === null || scrollback === null) return;
    if (pendingScrollRef.current === 0) return;
    const pixels = pendingScrollRef.current;
    pendingScrollRef.current = 0;
    box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight + pixels);
  }, [scrollback]);

  const handleScrollbackScroll = () => {
    const box = scrollBoxRef.current;
    if (box === null) return;
    if (!(showFind && findQuery) && box.scrollHeight - box.clientHeight - box.scrollTop <= AT_BOTTOM_PX) goLive();
  };

  // The safety boundary, made concrete: this handler only ever runs from a
  // REAL `keydown` React dispatched because `surfaceRef` (or a descendant —
  // there is none) was the focused element at the time. `stopPropagation`
  // keeps every key typed here — space included — from ever reaching the
  // app-level hotkeys on `window` (`useHotkey`'s Space-jump, the Escape
  // view-unwind): the app must never interpret a keystroke aimed at the
  // agent as a command aimed at itself, and vice versa.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!active || blockedByDialog()) return;
    if (event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") return;
    // isComposing: mid-IME composition (an accent/CJK input sequence still
    // being assembled) — the eventual composed character arrives via
    // `onCompositionEnd` below, not this raw keydown, so nothing is sent
    // (and nothing is stolen either: the browser's own composition UI still
    // runs normally since default isn't prevented here).
    if (event.nativeEvent.isComposing) return;

    // The three ⌘ chords that belong to the application on this platform,
    // handled before anything else and provably unable to reach the pane
    // either way (`decodePaneKey` returns `null` for all three; see
    // `terminalEditKey`).
    const edit = terminalEditKey(event);
    if (edit !== null) {
      event.stopPropagation();
      if (edit === "copy") {
        // NOT prevented: the browser's own copy of the document selection
        // is the real thing, and it already handles the scaled grid, the
        // ANSI spans and the line breaks between them. The app only says
        // something when there is nothing to copy, so ⌘C on an empty
        // selection is not a silent no-op.
        if ((window.getSelection()?.toString() ?? "").length === 0) {
          event.preventDefault();
          setScrollNote("nothing is selected — drag across the text first, then ⌘C");
        }
        return;
      }
      event.preventDefault();
      if (edit === "paste") {
        paste();
        return;
      }
      selectAllText();
      return;
    }

    const input = decodePaneKey(event);
    if (input === null) return;
    event.preventDefault();
    event.stopPropagation();
    // Typing goes to the bottom, exactly as it does in iTerm2 and Ghostty:
    // if the user is sending something, the live screen is what they need
    // to see. Their own keystroke asked for it — nothing here scrolls on
    // the pane's behalf.
    if (scrollbackRef.current) goLive();
    send(input);
  };

  /** ⌘A. Selects the pane's text and only the pane's text — never the
   * focus hint, the truncated badge or the scrollback bar, which are the
   * app's own words and have no business in a copy of someone's terminal
   * output. */
  const selectAllText = () => {
    const target = scrollback === null ? gridRef.current : scrollBoxRef.current;
    const selection = window.getSelection();
    if (target === null || selection === null || typeof document.createRange !== "function") return;
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  /**
   * A paste that arrives as a DOM event rather than as our own ⌘V keydown.
   * Belt and braces, and they cannot both fire: the keydown handler above
   * calls `preventDefault`, which cancels the browser's paste command
   * outright, so this only ever runs for a paste that reached the surface
   * some other way. It exists because the one thing about this feature
   * that cannot be verified from here is exactly how a WKWebView routes
   * ⌘V — see the README's known gaps.
   */
  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData?.getData("text") ?? "";
    event.preventDefault();
    event.stopPropagation();
    if (text.length === 0) return;
    if (scrollbackRef.current) goLive();
    send({ kind: "text", value: text });
  };

  const handleCompositionEnd = (event: ReactCompositionEvent<HTMLDivElement>) => {
    if (event.data.length === 0) return;
    event.stopPropagation();
    send({ kind: "text", value: event.data });
  };

  // Escape is deliberately NOT wired to close this dialog while the pane
  // surface itself is focused — vim, a REPL, an agent's own prompt, all
  // genuinely need Escape, and stealing it here would be exactly the
  // "silently stolen key" the brief warns against. It reaches `handleKeyDown`
  // above like any other key (mapped to `["escape"]`, sent to the pane) and
  // never reaches this listener at all, because that handler's own
  // `stopPropagation` stops it first.
  //
  // This listener only ever fires for an Escape typed while the SURFACE is
  // NOT focused (the header, the close button, or nothing in this dialog) —
  // the same "Escape closes the topmost dialog" behaviour every other
  // dialog in this app already has. Capture phase, like the panel's
  // predecessor, so it still runs ahead of any parent dialog's own Escape
  // listener.
  //
  // The SWITCH key (ctrl+alt+Tab, Item 2) is handled here too, and here
  // rather than in `handleKeyDown` below, on purpose. This listener is on
  // `window` in the CAPTURE phase, so it runs before React's own dispatch
  // ever reaches the surface — which means the branch below both acts on
  // the key and stops it, in one place, with no possibility of the pane's
  // own handler having already seen it. Unlike Escape it is handled
  // whether or not the surface is focused: it is the one gesture that must
  // work at the exact moment the keyboard belongs to the agent, since that
  // is the only moment the user needs it.
  //
  // `isCycleWaitingKey` names a combination `decodePaneKey` provably
  // decodes to `null` (asserted in `terminalKeys.test.ts`), so even if this
  // listener were removed entirely the key could still never reach the
  // pane. See that predicate's own doc comment for the full argument.
  useEffect(() => {
    if (!active) return;
    const onKeyDownWindow = (event: KeyboardEvent) => {
      if (blockedByDialog()) return;
      // Inputs own all shortcuts, including the switch chord. Capture runs
      // before their React handlers can stop bubbling to app-level hotkeys.
      const directInput = event.target instanceof Element && event.target.closest(".terminal__direct-host");
      if (!directInput && event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!directInput && document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) return;
      const direction = switchTerminalKey(event);
      if (direction !== null) {
        event.preventDefault();
        event.stopPropagation();
        const { targets: all, switchTo: go, paneId } = switchRef.current;
        const target = nextSwitchTarget(all, paneId, direction);
        if (target === null) {
          // Honest and quiet, in the one place the user is already looking.
          // Never a silent no-op: a shortcut that does nothing visible is
          // indistinguishable from a broken one.
          setSwitchNote("this is the only agent running — there is nowhere to switch to");
          return;
        }
        go(target);
        return;
      }
      if (event.key !== "Escape") return;
      if (directInput) return;
      if (document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (document.activeElement === surfaceRef.current) return; // -> the agent, not this listener
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDownWindow, true);
    return () => window.removeEventListener("keydown", onKeyDownWindow, true);
  }, [onClose, blockedByDialog, active]);

  // The "nowhere to go" answer is about one press, not a standing state —
  // it must not still be on screen a minute later, contradicting a strip
  // that by then has someone in it.
  useEffect(() => {
    if (switchNote === null) return;
    const timer = window.setTimeout(() => setSwitchNote(null), 4000);
    return () => window.clearTimeout(timer);
  }, [switchNote]);

  // Same discipline for the scroll answer, and for the same reason: it
  // describes one gesture, not a standing state. Longer than the
  // switcher's four seconds because it is a sentence explaining why the
  // wheel did what it did, and somebody has to be able to read it.
  useEffect(() => {
    if (scrollNote === null) return;
    const timer = window.setTimeout(() => setScrollNote(null), 8000);
    return () => window.clearTimeout(timer);
  }, [scrollNote]);

  return (
    <div ref={terminalRef} className={`terminal${embedded ? " terminal--embedded" : ""}${fullscreen ? " terminal--fullscreen" : ""}${fitPane ? " terminal--fit" : " terminal--readable"}`} role={embedded && !fullscreen ? "region" : "dialog"} aria-label={`Terminal: ${agent.title ?? agent.pane_id}`}>

      <div className="terminal__panel">
        <header className="terminal__header">
          {/* The attachment, always visible: which agent, which pane, which
              repository — spec §5.6's own explicit requirement, "the
              terminal surface shows which pane and which repository it is
              attached to." */}
          <span className="terminal__title">{agent.title ?? agent.pane_id}</span>
          <span className="terminal__attachment">
            {agent.pane_id} · {root}
          </span>
          <span
            className={focused && active ? "terminal__focus-badge terminal__focus-badge--live" : "terminal__focus-badge"}
            role="status"
          >
            {focused && active ? "● live — keys go to the agent" : "○ click to type"}
          </span>
          <button type="button" className="terminal__expand" onClick={() => setFullscreen(value => !value)} aria-label={fullscreen ? "Exit fullscreen" : "Expand terminal"} title={fullscreen ? "Exit fullscreen" : "Expand terminal"}>{fullscreen ? "⊡" : "⤢"}</button>
          <button type="button" className="terminal__close" onClick={onClose} aria-label="Close terminal">
            ×
          </button>
        </header>
        {/* THE SWITCHER (lag-and-switcher round). The author's main ask,
            twice: switching between terminals has to be easy.

            A TAB BAR, and it lives HERE — directly under the attachment
            line — because while he is deep in a conversation this header
            is the only part of the app still on screen. The sea's own "N
            agents need you" badge and the island beacons are behind this
            dialog and cannot do this job any more, which is exactly why
            pausing the scene behind it (Item 1) costs nothing.

            EVERY running agent, not only the stopped ones: the thing being
            replaced is Cmd-tabbing between terminal tabs, and a tab bar
            that only shows you the blocked ones is not that. Stopped ones
            come first (`switchTargets` orders by the same `ATTENTION_RANK`
            the island list uses) and wear the same ❗ the rest of the app
            has always used for "needs you", so "who needs me" survives
            intact as an ordering and a marker rather than as a separate
            feature.

            The bar is measured against the product's own bar — "never
            slower than switching terminal tabs": one click reaches ANY
            agent directly (better than sequential tab-cycling), or
            ctrl+alt+Tab steps to the next without leaving the keyboard.
            No dialog, no menu, no hunting.

            Nothing here accumulates. It lists exactly the agents that
            exist right now; it shrinks when one exits; there is no total,
            no streak, and nothing that rewards running more of them. */}
        {targets.length > 0 && (
          <div className="terminal__tabs">
            <span className="terminal__tabs-label">terminals</span>
            {/* The keyboard half's hint sits WITH the label, at the start
                of the bar. It used to be pushed to the far right with
                `margin-left: auto`, which a render immediately caught: with
                eight agents the tabs wrap to a second row and the hint
                lands on a third, below the bar's own scroll cutoff, where
                nobody would ever see it. */}
            {targets.length > 1 && (
              <span className="terminal__tabs-hint">⌃⌥⇥{targets.length > 2 ? " / ⌃⌥⇧⇥" : ""}</span>
            )}
            <ul className="terminal__tabs-list">
              {targets.map((candidate) => {
                const here = candidate.agent.pane_id === agent.pane_id;
                const attention = candidate.agent.attention;
                return (
                  <li key={candidate.agent.pane_id}>
                    <button
                      type="button"
                      className={
                        here
                          ? `terminal__tab terminal__tab--here terminal__tab--${attention}`
                          : `terminal__tab terminal__tab--${attention}`
                      }
                      // The one you are attached to stays in the bar and is
                      // marked, never removed: a tab bar that hides the
                      // current tab makes you count to work out where you
                      // are. `aria-current` is the same fact for a screen
                      // reader that the filled style is for an eye.
                      aria-current={here ? "true" : undefined}
                      // Disabled rather than a no-op click: switching to
                      // where you already are would remount this terminal
                      // and silently drop keyboard focus for no reason.
                      disabled={here}
                      onClick={() => switchTo(candidate)}
                      // The full attachment, including the parts that do
                      // not fit on a tab: the canonical root (three of the
                      // author's repositories share a basename with
                      // another, so a name alone is genuinely ambiguous)
                      // and the agent's own title when herdr gave it one.
                      title={
                        (here ? "You are here: " : "Switch this terminal to ") +
                        `${candidate.agent.pane_id} in ${candidate.root}` +
                        (candidate.agent.title === null ? "" : ` — ${candidate.agent.title}`) +
                        ` (${ATTENTION_LABEL[attention]})`
                      }
                    >
                      <span className="terminal__tab-mark" aria-hidden="true">
                        {ATTENTION_MARK[attention]}
                      </span>
                      <span className="terminal__tab-island">{candidate.islandName}</span>
                      {/* The pane id, ALWAYS — never the title in its
                          place. Two agents on one island is the exact case
                          this bar has to get right, and the pane id is the
                          handle that separates them; the same pairing the
                          attachment line above already uses. */}
                      <span className="terminal__tab-pane">{candidate.agent.pane_id}</span>
                      {/* Said in WORDS, not only in a glyph and a colour.
                          A render caught why this matters: when the tab you
                          are attached to is itself a stopped one, the
                          attention fill makes it look exactly like the other
                          stopped tabs, and "which one am I on" — the single
                          most consequential question this bar answers — was
                          left to a colour difference that was not there.
                          "you are here" replaces "needs you" on the current
                          tab rather than joining it: you are already there,
                          and the header directly above states the
                          attachment in full. */}
                      {here ? (
                        <span className="terminal__tab-needs">you are here</span>
                      ) : (
                        attention === "stopped" && (
                          <span className="terminal__tab-needs">needs you</span>
                        )
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="terminal__mode" role="group" aria-label="Terminal mode">
          <span><strong>{directMode ? "Direct terminal" : "Mirror"}</strong><span>{directMode ? "Fits this view and resizes the linked pane" : "Keeps the linked pane’s existing width"}</span></span>
          <button type="button" className="terminal__direct-toggle" aria-pressed={directMode}
            title={directMode ? "Release this view’s control and return to screen snapshots" : "Acquire Direct control and resize the real pane to this view. Existing controllers are never taken over."}
            onClick={() => {
              setDirectReady(false);
              if (directMode) {
                setDirectTarget(null);
                setScreen({ status: "loading" });
                lastTextRef.current = null;
                lastTruncatedRef.current = null;
              } else {
                setScrollback(null);
                setDirectTarget(targetIdentity);
              }
            }}>{directMode ? "Return to mirror" : "Direct control · fill view"}</button>
        </div>
        <div className="terminal__toolbar">
          {tradeRoutes && <button type="button" onClick={() => tradeRoutes.open({ targetRoot: root, paneId: agent.pane_id })} title="Give this agent another project as reference">⤳ Share project</button>}
          <div className="terminal__zoom" role="group" aria-label="Text size">
            <button type="button" aria-label="Decrease text size" disabled={textSize <= 10} onClick={() => resizeText(-1)}>A−</button>
            <span aria-label="Terminal text size">{fitPane ? "Fit" : `${textSize}px`}</span>
            <button type="button" aria-label="Increase text size" disabled={textSize >= 24} onClick={() => resizeText(1)}>A+</button>
          </div>
          <button type="button" aria-pressed={fitPane} disabled={directMode || scrollback !== null} onClick={() => setFitPane(value => !value)}>Fit pane</button>
          <span className="terminal__toolbar-divider" />
          <button type="button" disabled={directMode} title={directMode ? "Use the wheel or PageUp/PageDown to read server history" : undefined} onClick={() => {
            if (scrollback) { goLive(); return; }
            readPaneScrollback(agent.pane_id, root).then(result => {
              if (hasScrollback(lastTextRef.current ?? "", result.text)) {
                pendingScrollRef.current = -8 * ROW_PX;
                setScrollback(result);
              } else setScrollNote("No earlier output in this pane. Full-screen programs manage their own history.");
            }).catch(error => setSendError(String(error)));
          }}>{scrollback ? "Back to live" : "Scrollback"}</button>
          <button type="button" disabled={directMode} title={directMode ? "Output search is available in mirror mode" : undefined} aria-expanded={showFind && !directMode} onClick={() => setShowFind(value => !value)}>Find output</button>
          <button type="button" aria-expanded={showComposer} onClick={() => setShowComposer(value => !value)}>Compose prompt</button>
          <button type="button" className="terminal__external" title={RAISE_EXTERNAL_TERMINAL_TITLE} onClick={() => { void raiseExternalTerminal(agent).then(setScrollNote); }}>{RAISE_EXTERNAL_TERMINAL_LABEL}</button>
          <button type="button" className="terminal__help-button" aria-expanded={showHelp} onClick={() => setShowHelp(value => !value)}>Keyboard help</button>
        </div>
        {showFind && !directMode && <div className="terminal__find" role="search" aria-label="Terminal output search" onKeyDown={event => event.stopPropagation()}>
          <input ref={findRef} type="search" aria-label="Find in output" placeholder="Find in output…" value={findQuery}
            onChange={event => setFindQuery(event.target.value)} onKeyDown={event => {
              if (event.key === "Enter") { event.preventDefault(); navigateMatch(event.shiftKey ? -1 : 1); }
              if (event.key === "Escape") { event.preventDefault(); setShowFind(false); }
            }} />
          <output aria-label="Output match" aria-live="polite">{matchCount ? currentMatch + 1 : 0} of {matchCount}</output>
          <button type="button" aria-label="Previous match" disabled={!matchCount} onClick={() => navigateMatch(-1)}>↑</button>
          <button type="button" aria-label="Next match" disabled={!matchCount} onClick={() => navigateMatch(1)}>↓</button>
          <span>{scrollback ? "Available scrollback" : "Current screen"}</span>
          <button type="button" aria-label="Close output search" onClick={() => setShowFind(false)}>×</button>
        </div>}
        {switchNote !== null && (
          <p className="terminal__tabs-note" role="status">
            {switchNote}
          </p>
        )}
        {!directMode && sendError !== null && (
          <p className="terminal__error" role="alert">
            {sendError}
          </p>
        )}
        {!directMode && copyError && <p className="terminal__error" role="alert">{copyError}</p>}
        {/* THE PAUSED-MIRROR BAR. Whenever the scrollback view is up, the
            live screen is not being read, and that has to be stated where
            the eye already is — a terminal that has quietly stopped
            updating looks exactly like an agent that has quietly stopped
            working, and telling those two apart is the entire product. */}
        {!directMode && scrollback !== null && (
          <div className="terminal__scrollback-bar" role="status">
            <span className="terminal__scrollback-mark" aria-hidden="true">
              ⏸
            </span>
            <span>
              scrollback — the live screen is paused. Scroll to the bottom or type anything to go
              back.
            </span>
            {scrollback.truncated && (
              <span className="terminal__scrollback-truncated">
                ⚠ older lines beyond herdr's limit are not shown
              </span>
            )}
            <button type="button" className="terminal__scrollback-live" onClick={goLive}>
              go live
            </button>
          </div>
        )}
        {scrollNote !== null && (
          <p className="terminal__tabs-note" role="status">
            {scrollNote}
          </p>
        )}
        {directMode ? <Suspense fallback={<p className="terminal__direct-status" role="status">Loading direct terminal…</p>}><DirectTerminal paneId={agent.pane_id} root={root} active={active} textSize={textSize} onReadyChange={setDirectReady} /></Suspense> : <div
          ref={surfaceRef}
          className={focused && active ? "terminal__surface terminal__surface--focused" : "terminal__surface"}
          tabIndex={0}
          role="application"
          aria-label={`Live terminal for ${agent.title ?? agent.pane_id} — click, then type; every key goes straight to this pane`}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          // See the module doc comment: a click's ONE effect is focus, and
          // it is taken explicitly rather than relying on WKWebView's
          // default handling of `tabindex="0"`. No `preventDefault`, so
          // selecting text with the mouse still works.
          onMouseDown={() => surfaceRef.current?.focus()}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionEnd={handleCompositionEnd}
        >
          {scrollback === null && screen.status === "loading" && (
            <p className="terminal__hint">reading…</p>
          )}
          {scrollback === null && screen.status === "error" && (
            <p className="terminal__error" role="alert">
              {screen.message}
            </p>
          )}
          {/* THE SCROLLBACK VIEW. A plain scrollable box, drawn at the
              same glyph size the live grid is zoomed to (`fontSize`, since
              a transform and a scroll container fight each other) so
              entering and leaving it does not resize the text under the
              reader. `white-space: pre` and herdr's own wrapping are kept,
              exactly as in the live view — this is the pane's history, not
              a reflowed approximation of it. */}
          {scrollback !== null && (
            <div
              ref={scrollBoxRef}
              className="terminal__scrollback"
              onScroll={handleScrollbackScroll}
              style={{ fontSize: `${fitPane ? 13 * (grid?.scale ?? 1) : textSize}px` }}
            >
              {showFind && findQuery ? <TerminalSearchOutput output={searchedOutput} current={currentMatch} /> : <AnsiText className="terminal__text" text={scrollback.text} />}
            </div>
          )}
          {scrollback === null && screen.status === "ready" && (
            <>
              {screen.truncated && (
                <p className="terminal__truncated" role="status">
                  ⚠ output truncated — showing only the most recent portion
                </p>
              )}
              {/* Item 2's three nested boxes, each with exactly one job:
                  `__fit` is the space the grid may fill (and the box that
                  gets measured); `__grid` reserves the grid's DRAWN size so
                  the centering below is honest about how big it really is;
                  `__grid-inner` is the grid at its true layout size, drawn
                  scaled. The content is identical either way — same rows,
                  same columns, same text — so this remains a true mirror,
                  just not a postage stamp in a window. */}
              <div ref={fitRef} className="terminal__fit" onScroll={() => {
                const box = fitRef.current;
                if (box) liveAtBottomRef.current = box.scrollHeight - box.clientHeight - box.scrollTop <= AT_BOTTOM_PX;
              }}>
                <div
                  className="terminal__grid"
                  style={grid === null ? undefined : { width: grid.width, height: grid.height }}
                >
                  <div
                    ref={gridRef}
                    className="terminal__grid-inner"
                    style={
                      grid === null || grid.scale === 1
                        ? undefined
                        : { transform: `scale(${grid.scale})`, transformOrigin: "top left" }
                    }
                  >
                    {showFind && findQuery && screen.text ? <TerminalSearchOutput output={searchedOutput} current={currentMatch} /> : <AnsiText
                      className="terminal__text"
                      text={screen.text.length > 0 ? screen.text : "(no output yet)"}
                    />}
                  </div>
                </div>
              </div>
            </>
          )}
          {(!focused || !active) && <p className="terminal__hint terminal__hint--overlay">click here to type — every key you press goes straight to this pane, exactly as if you typed it in your own terminal</p>}
        </div>}
        <TerminalPromptComposer key={`${root}:${agent.pane_id}`} agent={agent} root={root} open={showComposer} active={active}
          unavailable={directMode ? !directReady : screen.status !== "ready"} onClose={() => setShowComposer(false)} />
        {/* THE CONTRACT, in one place: what the mouse does, what the
            keyboard does, which keys the app keeps, and — the part that
            has to stay — what this surface still cannot do. Every line
            here is a limitation someone would otherwise discover by
            clicking at something that silently did nothing, which is the
            exact complaint this round started from. */}
        <div className="terminal__statusline"><span>{directMode ? "Direct control" : scrollback ? "Reading scrollback" : screen.status === "error" ? "Connection error" : screen.status === "loading" ? "Connecting…" : "Live pane"}</span><span>Selection auto-copies <kbd>⌘C</kbd> <span aria-hidden="true">/</span> Paste <kbd>⌘V</kbd></span><span>Switch agents <kbd>⌃⌥⇥</kbd></span></div>
        <p className="terminal__note" hidden={!showHelp}>
          Selecting output copies it automatically. ⌘C to copy, ⌘V to paste, ⌘A for the whole screen. Every other key
          goes straight to the pane — arrows, Tab, shift+Tab, Escape, ctrl+C, and PageUp/Home/End
          as the escape codes your own terminal sends. ⌃⌥⇥ (ctrl+alt+Tab) is the one keystroke the
          app keeps for switching agents; ⌘K opens project search in the workspace. Click to focus/select; in-app terminal mouse actions are unavailable through the Herdr bridge.
          The wheel scrolls available output; use application keyboard shortcuts for its menus.
        </p>
      </div>
    </div>
  );
}
