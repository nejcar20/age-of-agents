import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { connectDirectTerminal, validTerminalSize, type DirectTerminalConnection, type DirectTerminalState } from "../directTerminal";
import { switchTerminalKey } from "../terminalKeys";
import { readClipboardText } from "../agents";
import { copyCompletedSelection } from "../terminalSelection";

export function DirectTerminal({ paneId, root, active, textSize, onReadyChange }: {
  paneId: string;
  root: string;
  active: boolean;
  textSize: number;
  onReadyChange: (ready: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const connectionRef = useRef<DirectTerminalConnection | null>(null);
  const measureRef = useRef<() => void>(() => {});
  const activeRef = useRef(active);
  activeRef.current = active;
  const readyCallbackRef = useRef(onReadyChange);
  readyCallbackRef.current = onReadyChange;
  const [state, setState] = useState<DirectTerminalState>({ status: "connecting" });
  const [inputError, setInputError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let resizeTimer = 0;
    let wheelTimer = 0;
    let connection: DirectTerminalConnection | null = null;
    const terminal = new XTerm({
      scrollback: 0,
      disableStdin: !activeRef.current,
      cursorBlink: true,
      fontSize: textSize,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      theme: { background: "#0c1822", foreground: "#dce8eb", cursor: "#b9e1d0", selectionBackground: "#3c696c" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    termRef.current = terminal;

    const blockedByDialog = () => {
      const owner = host.closest(".terminal") ?? host;
      return [...document.querySelectorAll('[role="dialog"]')].some(dialog => !owner.contains(dialog) && !dialog.contains(owner));
    };
    const isInputActive = () => activeRef.current && !blockedByDialog() && host.contains(document.activeElement);
    const stopCopy = copyCompletedSelection({ host,
      enabled: () => activeRef.current && !blockedByDialog(),
      getText: () => terminal.getSelection(),
      onError: setInputError,
    });
    const measure = () => {
      if (disposed) return;
      const proposed = fit.proposeDimensions();
      if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
      const size = { cols: Math.min(500, Math.floor(proposed.cols)), rows: Math.min(200, Math.floor(proposed.rows)) };
      if (!validTerminalSize(size)) return;
      if (connection) connection.resize(size);
      else {
        connection = connectDirectTerminal({ paneId, root, size, terminal, isInputActive, onState: next => {
          if (disposed) return;
          setState(next);
          readyCallbackRef.current(next.status === "ready");
          if (next.status === "ready") scheduleMeasure();
          if (next.status === "error") terminal.options.disableStdin = true;
        } });
        connectionRef.current = connection;
      }
    };
    const scheduleMeasure = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(measure, 120);
    };
    measureRef.current = scheduleMeasure;

    const input = terminal.onData(text => {
      if (isInputActive()) {
        finishWheelGesture();
        connection?.send(text);
      }
    });
    terminal.attachCustomKeyEventHandler(event => {
      if (!isInputActive()) return false;
      if (event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") return false;
      if (switchTerminalKey(event) !== null) return false;
      if (event.type === "keydown" && event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        event.stopPropagation();
        void readClipboardText().then(text => {
          if (!disposed && isInputActive()) { setInputError(null); terminal.paste(text); }
        }).catch(reason => { if (!disposed) setInputError(`Clipboard paste failed: ${String(reason)}`); });
        return false;
      }
      if (event.type === "keydown" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && (event.key === "PageUp" || event.key === "PageDown")) {
        event.preventDefault();
        finishWheelGesture();
        connection?.scroll(event.key === "PageUp" ? "up" : "down", Math.max(1, terminal.rows - 1), "page_key");
        return false;
      }
      return true;
    });
    // Herdr routes the wheel using its actual terminal modes and history.
    // Xterm has zero history and never generates wheel/mouse reports here.
    terminal.attachCustomWheelEventHandler(() => false);
    let wheelPixels = 0;
    const flushWheel = () => {
      wheelTimer = 0;
      if (disposed || !isInputActive()) { wheelPixels = 0; return; }
      const whole = Math.trunc(wheelPixels / 24);
      wheelPixels -= whole * 24;
      if (whole) connection?.scroll(whole < 0 ? "up" : "down", Math.min(200, Math.abs(whole)));
    };
    const finishWheelGesture = () => {
      window.clearTimeout(wheelTimer);
      flushWheel();
      // A later key owns the viewport now; sub-line wheel remainder
      // must not combine with a separate gesture after that key.
      wheelPixels = 0;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!activeRef.current || blockedByDialog() || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      terminal.focus();
      wheelPixels += event.deltaY * (event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? terminal.rows * 24 : 1);
      if (!wheelTimer) wheelTimer = window.setTimeout(flushWheel, 16);
    };
    host.addEventListener("wheel", wheel, { passive: false, capture: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    observer?.observe(host);
    window.addEventListener("resize", scheduleMeasure);
    // StrictMode discards its first effect before this microtask. Acquiring
    // only after that cleanup avoids two competing leases for one click.
    queueMicrotask(() => { if (!disposed) measure(); });
    // Opening this view requests Direct control. Later slot activation
    // must keep the picker, search, or composer the user selected focused.
    if (activeRef.current && !blockedByDialog()) terminal.focus();
    return () => {
      disposed = true;
      window.clearTimeout(resizeTimer);
      window.clearTimeout(wheelTimer);
      window.removeEventListener("resize", scheduleMeasure);
      observer?.disconnect();
      host.removeEventListener("wheel", wheel, true);
      stopCopy();
      input.dispose();
      connection?.close();
      connectionRef.current = null;
      measureRef.current = () => {};
      termRef.current = null;
      terminal.dispose();
    };
  }, [paneId, root]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.disableStdin = !active || state.status !== "ready";
  }, [active, state.status]);
  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = textSize;
    measureRef.current();
  }, [textSize]);

  return <div className="terminal__direct" onKeyDown={event => event.stopPropagation()}>
    <div className="terminal__direct-status" role={state.status === "error" ? "alert" : "status"}>
      {state.status === "error" ? state.message : state.status === "ready"
        ? "Direct control · real pane follows this view’s size · wheel reads server history"
        : "Connecting direct control…"}
    </div>
    <div ref={hostRef} className="terminal__direct-host" role="application" aria-label="Direct terminal control" />
    {inputError && <p className="terminal__direct-status" role="alert">{inputError}</p>}
    <p className="terminal__direct-note">Selecting output copies it automatically. Click to focus/select; in-app terminal mouse actions are unavailable through the Herdr bridge.</p>
  </div>;
}
