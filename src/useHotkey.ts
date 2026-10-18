import { useEffect, useRef } from "react";

/**
 * Tag names whose OWN default action for the keys this hook cares about
 * (Space especially) belongs to the focused control, not to us — a focused
 * checkbox or button activates on Space, and a text input/textarea inserts
 * a literal space character. `isContentEditable` covers the same case for
 * non-form editable regions (e.g. a `contenteditable` div).
 *
 * IMPORTANT 2 (final whole-branch review): without this, the founding
 * confirm sheet's checkbox and its confirm/"cancel" buttons never
 * actually receive the Space the user aims at them — Space instead fires
 * whatever hotkey happens to be `enabled`, because `useHotkey`'s listener is
 * on `window` and does not otherwise know or care what has focus. The same
 * applies to the always-visible `rescan`/`browse…` buttons, which sit
 * outside any modal.
 */
const INTERACTIVE_TAGS = new Set(["INPUT", "BUTTON", "TEXTAREA", "SELECT"]);

/**
 * Whether `target` is a control that should handle this keypress itself
 * rather than have `useHotkey` act on it. Deliberately duck-typed against
 * `tagName`/`isContentEditable` rather than `instanceof HTMLElement` — the
 * check works identically against a real DOM element and against a small
 * fake object in a test, so this stays testable without a browser DOM.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (typeof el.tagName === "string" && INTERACTIVE_TAGS.has(el.tagName.toUpperCase())) {
    return true;
  }
  return el.isContentEditable === true;
}

/**
 * Whether any modal dialog is currently open, so a hotkey aimed at the
 * window can bail out entirely rather than reach past it (principle 1: the
 * user keeps full control — a keypress aimed at a modal must not do
 * something else, somewhere else). Detected structurally, via
 * `role="dialog"`, rather than by threading each modal's own open/closed
 * state up into this hook — any future modal that follows the same
 * convention (e.g. `UnsettledList`'s founding confirm sheet) is covered for
 * free, with no new prop plumbing per modal.
 *
 * CRITICAL 3 (Opus frontend review): `role="dialog"` alone conflated two
 * different things — "this must be answered before anything else happens"
 * (a confirm sheet like `FoundingSheet`/`StartAgentSheet`/`NewProjectPanel`,
 * or the "selection first" ordering `BuildingPanel`/`DistrictPanel`/
 * `VillagerPanel` rely on to swallow the town's own Escape hotkey) versus
 * "here is some information, off to the side, that does not need the
 * keyboard" (`IslandPanel`'s corner card). Every `flyToRequest`'s own
 * `onArrive` opens `IslandPanel`, so treating it as modal meant the jump
 * hotkey's own muscle-memory press did nothing the moment it landed
 * anywhere, with zero feedback — the product's headline gesture, dead.
 *
 * The fix generalizes rather than special-cases `IslandPanel` by name: any
 * `[role="dialog"]` still counts as modal BY DEFAULT (every existing modal
 * keeps working with zero changes), and a non-modal one opts out with
 * `aria-modal="false"` — the same attribute ARIA already defines for exactly
 * this distinction, just with this codebase's default flipped (most dialogs
 * here truly are modal). Any future informational side panel can reuse the
 * same opt-out; nothing here has to know its name.
 *
 * `root` defaults to the real `document` and is only ever overridden in
 * tests, with a small fake exposing just `querySelector` — this keeps the
 * function testable without a jsdom-style browser DOM.
 */
export function isModalOpen(root: { querySelector(selector: string): unknown } = document): boolean {
  return root.querySelector('[role="dialog"]:not([aria-modal="false"])') !== null;
}

export type HotkeyDecision = { fire: boolean; preventDefault: boolean };

/**
 * Pure decision for one keydown event: should it fire the hotkey's handler,
 * and should its default action be suppressed? Pulled out of the `window`
 * listener itself specifically so the whole decision matrix — wrong key,
 * modifier held, an interactive control focused, a physical-key repeat,
 * disabled, a modal open — is unit-testable without a real browser DOM (a
 * plain object with `key`/`metaKey`/`ctrlKey`/`altKey`/`repeat`/`target` is
 * enough; see `useHotkey.test.ts`).
 *
 * `preventDefault` fires whenever the key matches and no interactive
 * control is focused, REGARDLESS of `enabled`/`modalOpen` (task-6-design-
 * inputs.md §7.5): otherwise a suppressed Space would scroll the town view
 * (or, now, the archipelago behind an open modal) instead of doing nothing,
 * turning "this hotkey does not apply right now" into a visible side effect.
 * The one case that must NOT call `preventDefault` is an interactive target
 * — that is precisely the case where the browser's own default action
 * (toggle the checkbox, activate the button, type the space) is the correct
 * one, and suppressing it would be the same principle-1 violation this fix
 * exists for.
 */
export function decideHotkey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "repeat" | "target">,
  options: { key: string; enabled: boolean; modalOpen: boolean },
): HotkeyDecision {
  if (event.key !== options.key || event.metaKey || event.ctrlKey || event.altKey) {
    return { fire: false, preventDefault: false };
  }
  if (isInteractiveTarget(event.target)) {
    return { fire: false, preventDefault: false };
  }
  // Still preventDefault on every repeat (e.g. stop a held space bar from
  // scrolling the page), but only ever fire once per physical press — see
  // the module's original rationale below.
  if (event.repeat) return { fire: false, preventDefault: true };
  if (!options.enabled || options.modalOpen) return { fire: false, preventDefault: true };
  return { fire: true, preventDefault: true };
}

export function useHotkey(key: string, handler: () => void, options: { enabled?: boolean } = {}) {
  const { enabled = true } = options;
  // Refs, not the effect's own dependency array, so the listener is
  // attached once per `key` and always reads the LATEST handler/enabled
  // without resubscribing (and therefore never fighting the `event.repeat`
  // guard below, which must survive across renders for the whole physical
  // key-press).
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // `isModalOpen()` is read live, at the moment of the keypress, rather
      // than folded into the `enabled` prop at render time: `enabled` is a
      // value this hook only sees once per React render, but a modal can
      // open or close between renders with nothing else forcing a re-render
      // of whoever calls `useHotkey` (`UnsettledList`'s sheet state is local
      // to that component, not lifted into `App`). Checking the DOM at
      // keydown time is the only way this cannot go stale.
      const decision = decideHotkey(event, {
        key,
        enabled: enabledRef.current,
        modalOpen: isModalOpen(),
      });
      if (decision.preventDefault) event.preventDefault();
      if (decision.fire) handlerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key]);
}
