/**
 * A small, generic "confirm before a real side effect" flow — the shared
 * shape behind every NEW action this round adds that creates something on
 * the user's real machine (sending an agent, creating a project). This is
 * deliberately the SAME reducer shape `founding.ts`'s `foldFounding`
 * already uses for the pre-existing founding sheet (open → edit → confirm
 * → busy → succeed/fail, a double-click guard, an error that stays ON the
 * sheet rather than vanishing) — generalized here as a reusable type rather
 * than copy-pasted a third and fourth time. `founding.ts`'s own reducer is
 * left exactly as it is: it already shipped and is exercised by
 * `UnsettledList`, and retrofitting a proven reducer onto a new generic
 * shape is not worth the risk for this round.
 *
 * `TDraft` is whatever the caller needs to edit before confirming (e.g. an
 * agent kind, or a new project's name) — this module knows nothing about
 * what it contains.
 */
export type ActionSheet<TDraft> = {
  draft: TDraft;
  /** True while the real `invoke` call is in flight — every action button
   * disables itself on this, the same guard `founding.ts`'s `Sheet.founding`
   * already proves out. */
  busy: boolean;
  /** The most recent failure, shown ON the sheet (never a status line
   * elsewhere that a `position: fixed` overlay would paint underneath —
   * `phase-0-followups.md`'s own carried lesson, from the founding sheet's
   * first bug). `null` until something has actually failed. */
  error: string | null;
};

export type ActionSheetAction<TDraft> =
  | { kind: "open"; draft: TDraft }
  | { kind: "edit"; draft: TDraft }
  | { kind: "close" }
  | { kind: "started" }
  | { kind: "succeeded" }
  | { kind: "failed"; error: string };

/**
 * `state` is `null` when no sheet is open — the same "closed means null,
 * not a hidden-but-present object" convention `founding.ts`'s `Sheet |
 * null` uses.
 *
 * - `close` and `started` are no-ops (return `state` BY REFERENCE) while
 *   `busy` is true, so a double click or a re-fired event cannot dismiss a
 *   sheet mid-flight or issue a second call — the identical guard
 *   `foldFounding`'s own doc comment explains, and for the same testing
 *   reason: a `toBe` comparison can tell a guarded no-op from a rebuilt-but-
 *   equal copy, `toEqual` cannot.
 * - `edit` while busy is also a no-op — the draft (e.g. which kind to
 *   start) must not change out from under an in-flight call.
 * - `succeeded` always closes the sheet outright (`null`), mirroring
 *   `foldFounding`'s `foundingSucceeded`: the caller's own success feedback
 *   (e.g. "sent claude to pocketAlarm") lives OUTSIDE this reducer, the same
 *   place `UnsettledList.lastFounded` already lives.
 */
export function foldActionSheet<TDraft>(
  state: ActionSheet<TDraft> | null,
  action: ActionSheetAction<TDraft>,
): ActionSheet<TDraft> | null {
  switch (action.kind) {
    case "open":
      return { draft: action.draft, busy: false, error: null };
    case "edit":
      if (state === null || state.busy) return state;
      return { ...state, draft: action.draft };
    case "close":
      if (state !== null && state.busy) return state;
      return null;
    case "started":
      if (state === null || state.busy) return state;
      return { ...state, busy: true, error: null };
    case "succeeded":
      return null;
    case "failed":
      if (state === null) return state;
      return { ...state, busy: false, error: action.error };
  }
}
