import { createPortal } from "react-dom";
import type { RaidScanners } from "../useRaids";

export const SCOUT_SHEET_TITLE = "Scout for threats";

/** What each scanner is called on screen, and how to get it when missing. */
const SCANNERS: { key: keyof RaidScanners; name: string; install: string }[] = [
  { key: "osv", name: "osv-scanner", install: "brew install osv-scanner" },
  { key: "npm", name: "npm", install: "brew install node" },
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
 * Portalled to `<body>`: it is opened from inside the HUD's search slip,
 * and a `position: fixed` overlay inside an ancestor with a
 * `backdrop-filter` is positioned against that ancestor, not the window.
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
          Checks {islandCount} islands' dependencies against public advisory databases. This uses the network.
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
