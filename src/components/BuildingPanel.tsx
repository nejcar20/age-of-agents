import { useEffect, useState } from "react";
import { useEscapeKey } from "../useEscapeKey";
import { openPath } from "@tauri-apps/plugin-opener";
import type { BuildingKind } from "../city";
import { revealPath } from "../reveal";

export type SelectedBuildingInfo = {
  path: string;
  name: string;
  kind: BuildingKind;
  lines: number;
  districtName: string;
};

/**
 * The persistent panel shown once a building is SELECTED (a click), as
 * opposed to merely hovered — what the building actually is (path, kind,
 * line count, district) and a button to open it in the user's default
 * editor via `tauri-plugin-opener`'s `openPath`.
 *
 * "Open file" is a button, never triggered by the click that selected the
 * building — an accidental click on a house must not launch an application
 * (the coordinator's explicit instruction). `openPath` opens with the OS's
 * own file association, which is the "default editor" for a real desktop
 * environment; a rejected promise (no association, a bad path) renders as
 * an honest inline error rather than failing silently.
 *
 * `role="dialog"` is not decorative: `useHotkey`'s `isModalOpen()` detects
 * any `[role="dialog"]` in the document structurally (the same mechanism
 * `UnsettledList`'s confirm sheet already relies on — see that component),
 * so the app-level Escape hotkey in `App.tsx` (closes the whole town) checks
 * `isModalOpen()` on every keypress and self-gates into a no-op while this
 * panel exists, without this component or `TownView` having to tell it so.
 *
 * This component's OWN Escape handling below (clearing the selection) is
 * DELIBERATELY a plain `window` listener, not `useHotkey` — `useHotkey`'s
 * modal gate would block this handler too, since `decideHotkey` cannot tell
 * "some modal is open" from "I AM that modal." Native event dispatch order
 * settles the ordering correctly without any coordination: `App`'s Escape
 * listener was registered once, when `App` first mounted, long before any
 * selection could exist; this listener is added only once a building is
 * actually selected — strictly later. Two listeners on the same target
 * fire in registration order, so `App`'s runs first (finds the dialog,
 * no-ops) and this one runs second (actually clears the selection) — one
 * keypress, exactly one effect. See `BuildingPanel.test.tsx` for the two
 * halves of this proof (this component clears on Escape; mounting it makes
 * `isModalOpen()` true).
 */
export function BuildingPanel({
  selection,
  onClose,
}: {
  selection: SelectedBuildingInfo;
  onClose: () => void;
}) {
  // The shared dialog Escape (`useEscapeKey`) — this listener existed
  // verbatim in five components before the sea/town consistency round; see
  // that hook's doc comment for the whole depth ladder it takes part in.
  useEscapeKey(onClose);

  // Reset per selection: opening a second building after an error on the
  // first must not carry the old error forward.
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [selection.path]);

  const handleOpen = () => {
    setError(null);
    openPath(selection.path).catch((err: unknown) => setError(String(err)));
  };

  // Item 5 (actions-UI round): reveal, alongside open — same fire-and-forget
  // shape, same honest inline error on failure, never gated behind a
  // confirm step (this doesn't create or change anything on disk).
  const handleReveal = () => {
    setError(null);
    revealPath(selection.path).catch((err: unknown) => setError(String(err)));
  };

  return (
    <div className="building-panel" role="dialog" aria-label={`Selected: ${selection.name}`}>
      <button
        type="button"
        className="building-panel__close"
        onClick={onClose}
        aria-label="Close (Escape)"
      >
        ×
      </button>
      <h3 className="building-panel__name">{selection.name}</h3>
      <dl className="building-panel__facts">
        <dt>Path</dt>
        <dd className="building-panel__path">{selection.path}</dd>
        <dt>Kind</dt>
        <dd>{selection.kind}</dd>
        <dt>Lines</dt>
        <dd>{selection.lines.toLocaleString()}</dd>
        <dt>District</dt>
        <dd>{selection.districtName}</dd>
      </dl>
      <div className="building-panel__buttons">
        <button type="button" className="building-panel__open" onClick={handleOpen}>
          Open file
        </button>
        <button type="button" className="building-panel__reveal" onClick={handleReveal}>
          Reveal in Finder
        </button>
      </div>
      {error && (
        <p className="building-panel__error" role="alert">
          Could not open this file: {error}
        </p>
      )}
    </div>
  );
}
