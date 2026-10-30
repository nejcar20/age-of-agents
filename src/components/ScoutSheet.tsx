import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { RaidScanners } from "../useRaids";

export const SCOUT_SHEET_TITLE = "Scout for threats";

/** What each scanner is called on screen, and how to get it when missing.
 * Only osv-scanner gets an install command: it is the one scanner the app
 * recommends; npm is merely used when it happens to be there. */
const SCANNERS: { key: keyof RaidScanners; name: string; install: string | null }[] = [
  { key: "osv", name: "osv-scanner", install: "brew install osv-scanner" },
  { key: "npm", name: "npm", install: null },
];

/** Shown on the sheet when Scout is disabled in the browser preview — the
 * same wording the guide uses for the preview's other disabled sends
 * ("Submitting prompts remains disabled in the preview."). */
export const SCOUT_PREVIEW_NOTE = "Scouting is disabled in the preview.";

/**
 * The confirm step before `scout_all`. Scouting sends every island's
 * dependency list to public advisory databases, so it never starts on a
 * single click: this sheet says what will happen, with which scanners, over
 * how many islands, and that it uses the network.
 *
 * Portalled to `<body>`: it is opened from the HUD's button column
 * (`ScoutControl`), and a `position: fixed` overlay inside an ancestor with
 * a `backdrop-filter` would be positioned against that ancestor, not the
 * window.
 */
export function ScoutSheet({
  scanners,
  islandCount,
  onConfirm,
  onClose,
  disabled = false,
}: {
  /** `null` while the backend hasn't answered which scanners exist. */
  scanners: RaidScanners | null;
  islandCount: number;
  onConfirm: () => void;
  onClose: () => void;
  /** True in the browser preview, where there is nothing real to scan. */
  disabled?: boolean;
}) {
  return createPortal(
    <div className="sheet" role="dialog" aria-label={SCOUT_SHEET_TITLE}>
      <div className="sheet__panel">
        <h3>{SCOUT_SHEET_TITLE}</h3>
        <ul className="scout-sheet__scanners">
          {scanners === null ? (
            <li>checking which scanners are installed…</li>
          ) : (
            SCANNERS.map((s) => (
              <li key={s.key} className={scanners[s.key] ? "" : "scout-sheet__missing"}>
                {scanners[s.key] ? (
                  `${s.name} ✓ found`
                ) : s.install === null ? (
                  `${s.name} — not found`
                ) : (
                  <>
                    {s.name} — not installed (<code>{s.install}</code>)
                  </>
                )}
              </li>
            ))
          )}
        </ul>
        <p className="sheet__lede">
          Checks {islandCount} {islandCount === 1 ? "island's" : "islands'"} dependencies against public advisory
          databases. This uses the network.
        </p>
        {disabled && <p className="sheet__error">{SCOUT_PREVIEW_NOTE}</p>}
        <div className="sheet__actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={disabled}>
            Scout
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The running scout's progress. `total === 0` means the backend hasn't
 * said how many islands yet — no "/0", which would read as "nothing to do". */
export function scoutProgressLabel(scouting: { done: number; total: number }): string {
  return scouting.total > 0 ? `Scouting ${scouting.done}/${scouting.total}…` : "Scouting…";
}

/** How long a scout error stays up before getting out of the way. */
const SCOUT_ERROR_MS = 6000;

export type ScoutControlProps = {
  scanners: RaidScanners | null;
  islandCount: number;
  /** `useRaids().scouting` — while set, progress shows beside the button. */
  scouting: { done: number; total: number } | null;
  error: string | null;
  onScoutAll: () => void;
  /** The browser preview: the sheet still opens, Scout does not. */
  disabled: boolean;
  /** Called each time the sheet opens, so the scanner list it shows is
   * current (`useRaids().refreshScanners`). */
  onOpen?: () => void;
};

/**
 * The HUD's round "Scout for threats" button, its confirm sheet, and a
 * small note beside it for progress or a failure. Lives in the chart's
 * button column rather than the search slip: the slip grows leftward from
 * the right edge, and a wider slip covered the title banner.
 */
export function ScoutControl({ scanners, islandCount, scouting, error, onScoutAll, disabled, onOpen }: ScoutControlProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  // A scout error ("already scouting", a scanner crash) is shown, then
  // cleared after a while — and shown again whenever a new one arrives.
  const [shownError, setShownError] = useState<string | null>(error);
  useEffect(() => {
    setShownError(error);
    if (error === null) return;
    const timer = setTimeout(() => setShownError(null), SCOUT_ERROR_MS);
    return () => clearTimeout(timer);
  }, [error]);

  return (
    <div className="chart-scout">
      <button
        type="button"
        className="chart-round"
        aria-label={SCOUT_SHEET_TITLE}
        title={SCOUT_SHEET_TITLE}
        aria-pressed={scouting !== null}
        // One scout at a time: while one runs, its progress is the answer.
        disabled={scouting !== null}
        onClick={() => {
          onOpen?.();
          setSheetOpen(true);
        }}
      >
        {/* A spyglass, drawn in the same 24-unit, 2.2-stroke hand as the
            column's other glyphs. */}
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 13.5l11-6.5 2.5 4.3-11 6.5z" />
          <path d="M17 7.6l2.6-1.5 1.6 2.8-2.6 1.5" />
          <path d="M10 15.5l-2.5 5M10 15.5l3 4.5" />
        </svg>
      </button>
      {scouting !== null ? (
        <span className="chart-scout__note" role="status">
          {scoutProgressLabel(scouting)}
        </span>
      ) : (
        shownError !== null && (
          <span className="chart-scout__note chart-scout__note--error" role="alert">
            {shownError}
          </span>
        )
      )}
      {sheetOpen && (
        <ScoutSheet
          scanners={scanners}
          islandCount={islandCount}
          disabled={disabled}
          onClose={() => setSheetOpen(false)}
          onConfirm={() => {
            // Closing first is what makes this fire once: the sheet (and
            // its button) is gone before a second click can land.
            setSheetOpen(false);
            onScoutAll();
          }}
        />
      )}
    </div>
  );
}
