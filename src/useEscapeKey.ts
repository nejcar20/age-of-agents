import { useEffect, useRef } from "react";

/**
 * A DIALOG'S OWN ESCAPE: "while I am open, Escape closes me."
 *
 * WHY THIS IS NOT `useHotkey("Escape", …)`. That hook stands down whenever
 * any modal is open (`isModalOpen()`), which is exactly right for an
 * app-level hotkey reaching past a dialog and exactly wrong for the dialog
 * itself — the panel that must answer Escape IS the modal. That is why five
 * components had each hand-rolled this same listener
 * (`BuildingPanel`, `DistrictPanel`, `VillagerPanel`, `IslandPanel`,
 * `NewProjectPanel`), three of them byte-identical. This is that listener,
 * once (sea/town consistency round).
 *
 * HOW IT SITS IN THE ESCAPE LADDER, which is resolved by DEPTH and not by
 * precedence (spec §5.6's town amendment, and now the sea too):
 *
 *  1. The embedded `Terminal`'s pane surface, when focused, handles Escape
 *     itself and sends it to the agent — vim, a REPL and an agent's own
 *     prompt all genuinely need that key, and stealing it would make the
 *     terminal something the real one is not. Its own React handler stops
 *     propagation, so no listener here ever sees that press.
 *  2. The `Terminal` dialog's window listener, in the CAPTURE phase, closes
 *     the terminal when the surface is not focused — and stops propagation,
 *     so the panel underneath does not also close on the same press.
 *  3. These listeners, in the bubble phase: the topmost panel closes.
 *  4. The app's own `useHotkey("Escape")` (leaving a town), which self-gates
 *     on `isModalOpen()` and therefore only fires once no panel is left.
 *
 * One press does exactly one of those, which is the property worth
 * protecting: a single key that closed a terminal AND a panel AND a town
 * would lose the user their place with no way to ask for less.
 *
 * `enabled: false` makes the press a genuine no-op — nothing fires and
 * nothing is prevented, so a real call in flight behind a confirm sheet
 * cannot have the sheet (and the component waiting for its result)
 * unmounted out from under it. `IslandPanel` and `NewProjectPanel` both
 * need that; the other three have nothing in flight to protect.
 */
export function useEscapeKey(handler: () => void, options: { enabled?: boolean } = {}) {
  const { enabled = true } = options;
  // Refs, so a component that passes a fresh closure every render (all five
  // callers do) re-subscribes nothing: a listener that owns a keystroke is
  // not something to churn on every unrelated re-render.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !enabledRef.current) return;
      event.preventDefault();
      handlerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
