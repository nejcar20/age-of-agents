import { useEffect, useState } from "react";
import { useEscapeKey } from "../useEscapeKey";
import { revealPath } from "../reveal";

export type SelectedDistrictInfo = { name: string; path: string; buildingCount: number };

/**
 * The persistent panel shown once a DISTRICT is selected — a click on its
 * pad, not on one of its buildings (Item 5 of the actions-UI round: "let a
 * district offer the same [reveal] for its directory"). Deliberately a
 * small, separate component rather than a generalization of `BuildingPanel`
 * shared between the two: a district has no single file to "open," only a
 * directory to reveal, so the two panels' action sets genuinely differ.
 *
 * Same `role="dialog"` / local-Escape-listener mechanism `BuildingPanel`
 * already uses, for the identical reason — see that component's own doc
 * comment for the full "selection first, then view" ordering proof this
 * mirrors.
 */
export function DistrictPanel({
  selection,
  onClose,
}: {
  selection: SelectedDistrictInfo;
  onClose: () => void;
}) {
  // The shared dialog Escape (`useEscapeKey`) — this listener existed
  // verbatim in five components before the sea/town consistency round; see
  // that hook's doc comment for the whole depth ladder it takes part in.
  useEscapeKey(onClose);

  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [selection.path]);

  const handleReveal = () => {
    setError(null);
    revealPath(selection.path).catch((err: unknown) => setError(String(err)));
  };

  return (
    <div className="building-panel" role="dialog" aria-label={`District: ${selection.name}`}>
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
        <dt>Buildings</dt>
        <dd>{selection.buildingCount.toLocaleString()}</dd>
      </dl>
      <button type="button" className="building-panel__reveal" onClick={handleReveal}>
        Reveal in Finder
      </button>
      {error && (
        <p className="building-panel__error" role="alert">
          Could not reveal this folder: {error}
        </p>
      )}
    </div>
  );
}
