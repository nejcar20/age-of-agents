// Dev-only native-transport stand-in, imported only by townshot.tsx.
// It renders real xterm cells at requested dimensions without contacting Herdr.
import type { DirectTerminalEvent } from "./directTerminal";

type PreviewLease = { cols: number; rows: number; seq: number; channel: { onmessage: (event: DirectTerminalEvent) => void } };
const leases = new Map<string, PreviewLease>();
let sequence = 0;

function paint(lease: PreviewLease) {
  const rule = "+" + "-".repeat(Math.max(0, lease.cols - 2)) + "+";
  const lines = [
    "SYNTHETIC TERMINAL PREVIEW - no live connection",
    `Measured terminal: ${lease.cols} columns x ${lease.rows} rows`,
    rule,
    "This line uses the available terminal columns. ".repeat(Math.ceil(lease.cols / 45)).slice(0, lease.cols),
    rule,
    "Resize the window or terminal to check column fitting.",
  ].map(line => line.slice(0, lease.cols));
  const bytes = "\x1b[2J\x1b[H" + lines.map((line, row) => `\x1b[${row + 1};1H${line}`).join("") + "\x1b[8;1H";
  lease.channel.onmessage({ type: "terminal.frame", seq: ++lease.seq, encoding: "ansi", width: lease.cols, height: lease.rows, full: true, bytes: btoa(bytes) });
}

export async function terminalPreview(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (new URLSearchParams(window.location.search).get("terminalFixture") !== "1") {
    throw new Error(`"${command}" is disabled in the screenshot harness - no live terminal connection`);
  }
  if (command === "terminal_attach") {
    const channel = args?.onEvent as PreviewLease["channel"];
    if (typeof channel?.onmessage !== "function") throw new Error("Preview requires an event channel");
    const lease = { cols: Number(args?.cols), rows: Number(args?.rows), seq: 0, channel };
    const id = `synthetic-${++sequence}`;
    leases.set(id, lease);
    queueMicrotask(() => { if (leases.has(id)) paint(lease); });
    return id;
  }
  const id = String(args?.leaseId), lease = leases.get(id);
  if (command === "terminal_detach") { leases.delete(id); return; }
  if (!lease) throw new Error("Synthetic terminal is closed");
  if (command === "terminal_resize") { lease.cols = Number(args?.cols); lease.rows = Number(args?.rows); paint(lease); return; }
  if (command === "terminal_ack") return;
  throw new Error("Input and scrolling are disabled in the synthetic terminal preview");
}
