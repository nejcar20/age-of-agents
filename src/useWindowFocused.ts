import { useEffect, useState } from "react";

/**
 * Art-direction round, item 2: the coordinator explicitly authorized a
 * continuous render loop ("`frameloop="always"`") for the moving water/sky,
 * but only "while the window is focused, paused when blurred/hidden" —
 * "A dead-still sea is a diorama; a moving one is a place... it must
 * genuinely pause when the user is elsewhere — verify that, do not assume
 * it."
 *
 * This is the ONE place that decides "is the user actually here right now":
 * true only while the document both HAS focus (`document.hasFocus()` — false
 * the instant another app/window is frontmost, even if this window is still
 * technically "visible" underneath it) AND is not hidden (`visibilityState`
 * — false when the tab/window is minimized or, on some platforms, occluded).
 * Either condition failing is enough to stop paying for animation the user
 * cannot see.
 *
 * Callers pass this straight through as `<Canvas frameloop>`: `"always"`
 * while focused, `"demand"` (the existing, already-tested default — only
 * re-renders when something explicitly calls `invalidate()`) otherwise. No
 * new rendering path for the "unfocused" case — it reuses the exact
 * frameloop mode this codebase already relied on before this round.
 */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(
    () => typeof document !== "undefined" && document.hasFocus() && document.visibilityState === "visible",
  );

  useEffect(() => {
    const update = () => {
      setFocused(document.hasFocus() && document.visibilityState === "visible");
    };
    // All four are needed, not a subset: `blur`/`focus` fire when a DIFFERENT
    // application becomes frontmost (visibility never changes in that case
    // on most platforms); `visibilitychange` fires on minimize/tab-switch
    // (focus/blur never fire in that case). Missing either pair leaves a
    // real "user is elsewhere" case where the loop keeps spinning.
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return focused;
}
