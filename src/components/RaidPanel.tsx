import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SwitchTarget } from "../agentSwitcher";
import type { SeaIsland } from "../archipelago";
import { formatLastChanged } from "../lastChanged";
import { findingKey, findingsOf, SEVERITY_COLOR, type Finding, type RaidReport, type Severity } from "../raids";
import { DefendComposer } from "./DefendComposer";
import { SCOUT_PREVIEW_NOTE } from "./ScoutSheet";
import { useStartAgentFlow } from "./StartAgent";

export const STALE_BANNER = "The lockfiles changed since this scout — rescout";
export const DEFEND_LABEL = "Send an agent to defend";
export const START_FIRST_LABEL = "Start an agent first";

/** Worst first, matching the order ships are drawn in. */
const RANK: Record<Severity, number> = { critical: 0, high: 1, moderate: 2, low: 3, unknown: 4 };

/** A scanner-supplied URL is only ever handed to the OS opener when it is
 * plainly a web page; anything else renders as text. */
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

/**
 * What a raid IS, and what you can do about it — opened from a pirate ship,
 * a raider group in town, or the island panel's "Show raid".
 *
 * Same card family as `IslandPanel` (and drawn in its place, on top of it):
 * `role="dialog"` but deliberately NOT `aria-modal="false"`, unlike
 * `IslandPanel`. While it is open the app-level hotkeys stand down
 * (`isModalOpen`), so Escape closes THIS card and not the town behind it —
 * one press, one thing, per `useEscapeKey`'s ladder. It does not trap focus:
 * reading a raid never blocks the scene. Its Escape is a CAPTURE-phase
 * listener that stops the press, so the island panel underneath at sea does
 * not close on the same key.
 *
 * Nothing here sends anything: "Send an agent to defend" opens
 * `DefendComposer`, which sends only on its own explicit click.
 */
export function RaidPanel({
  seaIsland,
  report,
  onClose,
  onScout,
  scouting,
  scoutError = null,
  targets,
  connected,
  onOpenTerminal,
  previewDisabled = false,
}: {
  seaIsland: SeaIsland;
  report: RaidReport | undefined;
  onClose: () => void;
  /** Rescouts THIS island's main root (spec decision 1), never a worktree. */
  onScout: () => void;
  /** This island is being scouted right now. */
  scouting: boolean;
  /** Why this island's last rescout failed, if it did. Shown here because
   * the HUD that shows scout errors is not on screen inside a town. */
  scoutError?: string | null;
  /** Every agent anywhere (`switchTargets`); the composer narrows them. */
  targets: SwitchTarget[];
  connected: boolean;
  onOpenTerminal: (target: SwitchTarget) => void;
  /** The browser preview: nothing real to scout or send to. */
  previewDisabled?: boolean;
}) {
  const { view, agents, attention } = seaIsland;
  const root = view.root;
  const findings = useMemo(() => findingsOf(report).slice().sort((a, b) => RANK[a.severity] - RANK[b.severity]), [report]);
  // Unchecked, not checked, is what gets stored: a finding that appears on a
  // rescout is checked by default like every other, with no reset needed.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());
  const checked = findings.filter((f) => !unchecked.has(findingKey(f)));
  const [composing, setComposing] = useState<Finding[] | null>(null);
  const toggle = (f: Finding) =>
    setUnchecked((current) => {
      const next = new Set(current);
      if (!next.delete(findingKey(f))) next.add(findingKey(f));
      return next;
    });
  const [linkError, setLinkError] = useState<string | null>(null);

  // "Has an agent" means one the composer could actually send to — the same
  // filter it applies — so this button never opens an empty picker.
  const canDefend = targets.some((t) => t.root === root && t.agent.kind !== null);
  // Starting one is the existing flow, unchanged. Once herdr reports the
  // pane, `targets` updates and the button becomes "Send an agent to
  // defend" by itself; nothing is opened on the user's behalf.
  const start = useStartAgentFlow({ root, name: view.name, settled: attention !== null, agents, onPaneReady: () => {} });

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const escapeEnabled = composing === null && !start.busy;
  const escapeRef = useRef(escapeEnabled);
  escapeRef.current = escapeEnabled;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !escapeRef.current) return;
      // A full-window terminal opened over this card is higher on the
      // ladder: its own capture listener answers this press, not us.
      if (document.querySelector('.terminal[role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const open = (url: string) => {
    setLinkError(null);
    openUrl(url).catch((error: unknown) => setLinkError(String(error)));
  };

  const scoutedLine = report ? `${report.scanner ?? "no scanner"} · scouted ${formatLastChanged(report.scanned_at)}` : null;
  const rescout = (
    <button type="button" onClick={onScout} disabled={scouting || previewDisabled}>
      {scouting ? "Scouting…" : report ? "Rescout" : "Scout"}
    </button>
  );

  return (
    <div className="island-panel raid-panel" role="dialog" aria-label={`Raid on ${view.name}`}>
      <button type="button" className="island-panel__close" onClick={onClose} aria-label="Close (Escape)">
        ×
      </button>
      <span className="raid-panel__eyebrow">Raid</span>
      <h3 className="island-panel__name">{view.name}</h3>
      <p className="island-panel__path">{root}</p>
      {scoutedLine && <p className="raid-panel__scouted">{scoutedLine}</p>}
      {report?.stale && <p className="raid-panel__stale" role="status">{STALE_BANNER}</p>}

      {report === undefined ? (
        <p className="raid-panel__calm">Not scouted yet.</p>
      ) : report.status.kind === "unscouted" ? (
        <div className="raid-panel__unscouted">
          <strong>Could not scout this island</strong>
          <p>{report.status.reason}</p>
        </div>
      ) : report.status.kind === "clean" ? (
        // Stale: the banner above says the lockfiles changed, and this line
        // must not claim more than the scan it describes.
        <p className="raid-panel__calm">{report.stale ? "No known vulnerabilities when last scouted" : "No known vulnerabilities"}</p>
      ) : (
        <ul className="raid-panel__findings">
          {findings.map((f) => (
            <li key={findingKey(f)} className="raid-panel__finding">
              <input
                type="checkbox"
                checked={!unchecked.has(findingKey(f))}
                onChange={() => toggle(f)}
                aria-label={`Include ${f.id}`}
              />
              <div>
                <div className="raid-panel__finding-head">
                  <span className="raid-panel__severity">
                    <i style={{ background: SEVERITY_COLOR[f.severity] }} aria-hidden="true" />
                    {f.severity}
                  </span>
                  {isWebUrl(f.url) ? (
                    <a
                      href={f.url}
                      onClick={(event) => {
                        // The webview must not navigate itself away; the
                        // OS browser opens it, through the same opener
                        // plugin `BuildingPanel` uses for files.
                        event.preventDefault();
                        open(f.url);
                      }}
                    >
                      {f.id}
                    </a>
                  ) : (
                    <span>{f.id}</span>
                  )}
                </div>
                <p className="raid-panel__summary">{f.summary}</p>
                <p className="raid-panel__meta">
                  <code>{f.package}</code> {f.installed ?? "?"} → {f.fixed_in ?? "no fix known"} · <code>{f.lockfile}</code>
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {report && report.uncovered.length > 0 && (
        <p className="raid-panel__uncovered">Not checked: {report.uncovered.join(", ")}</p>
      )}
      {scoutError && <p className="island-panel__error" role="alert">Rescout failed: {scoutError}</p>}
      {linkError !== null && <p className="island-panel__error" role="alert">{linkError}</p>}
      {previewDisabled && <p className="island-panel__waiting">{SCOUT_PREVIEW_NOTE}</p>}
      {start.notes}

      <div className="island-panel__actions">
        {report?.status.kind === "raided" &&
          (canDefend ? (
            <button type="button" disabled={checked.length === 0} onClick={() => setComposing(checked)}>
              {DEFEND_LABEL}
            </button>
          ) : (
            <button type="button" onClick={start.open} disabled={start.loading} title={start.error ?? undefined}>
              {START_FIRST_LABEL}
            </button>
          ))}
        {rescout}
      </div>

      {start.sheets}
      {/* Portalled: this card is its own stacking context (`z-index`), and
          the composer's full-window backdrop must cover the whole app, not
          sit at this card's level among the HUD. */}
      {composing !== null && createPortal(
        <DefendComposer
          root={root}
          findings={composing}
          targets={targets}
          connected={connected}
          onClose={() => setComposing(null)}
          onOpenTerminal={onOpenTerminal}
          previewDisabled={previewDisabled}
        />,
        document.body,
      )}
    </div>
  );
}
