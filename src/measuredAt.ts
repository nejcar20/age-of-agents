/**
 * Pure formatting for `CityStatus.Known.measured_at` (Unix seconds, or
 * `null` — see that field's own doc comment in
 * `src-tauri/src/city/archipelago.rs` and its TypeScript mirror in
 * `archipelago.ts`): the moment a repo's city size was ACTUALLY measured,
 * carried through unchanged whenever a cached summary is reused rather than
 * advanced to "now."
 *
 * The Rust side added this field to DISCLOSE age rather than guess
 * freshness: the cache is revalidated against the repo's last COMMIT epoch,
 * which deliberately ignores uncommitted work, so an agent that has been
 * working for hours without committing leaves its island's cached measurement
 * looking current indefinitely. `measured_at` alone cannot tell a viewer
 * whether that has actually happened — it only ever says WHEN the number on
 * screen was last actually true. This module's whole job is to say that
 * honestly and nothing more: never "this is stale," never "this is live,"
 * only "this was measured N ago" (or, for `null`, "no measurement time was
 * ever recorded").
 *
 * Kept as a separate module from `lastChanged.ts` (rather than reusing
 * `formatLastChanged` directly for the whole job) because the two `null`s
 * mean different things: `Island.last_changed_at`'s `null` is "no known
 * commit," honestly rendered "no known date." `measured_at`'s `null` is "no
 * measurement time was ever recorded" (a summary cached before this field
 * existed) — a categorically different fact that must never render as a
 * plausible-looking blank date.
 */

import { formatLastChanged } from "./lastChanged";

/**
 * Below this age, a measurement is shown as a plain fact with no added
 * emphasis. At or above it, the island panel adds a visible (but not
 * alarming) caveat alongside the same relative-time text — chosen to match
 * the review's own illustration of the failure this field exists to
 * disclose ("an agent that works for two hours without committing"): by the
 * time a measurement is this old, real uncommitted work is a live enough
 * possibility that the age deserves more than a ticking relative-time string
 * easy to skim past. This is still never a claim that the number IS stale —
 * only that it has been long enough since the last real measurement that the
 * viewer should treat "current" as unverified.
 */
const NOTICEABLY_OLD_SECONDS = 60 * 60;

/**
 * How prominently the island panel should present a measurement's age.
 * `"old"`/`"fresh"` only change how LOUDLY the same true fact (the relative
 * time since `measured_at`) is shown — never a claim that the underlying
 * count is actually wrong, which this module has no way to know (see the
 * module doc above). `"unrecorded"` is the one case that is not a date at
 * all and must never be squeezed into the same relative-time shape.
 */
export type MeasurementAge =
  | { kind: "fresh"; relative: string }
  | { kind: "old"; relative: string; caveat: string }
  | { kind: "unrecorded"; text: string };

export function describeMeasuredAt(measuredAt: number | null, nowMs: number = Date.now()): MeasurementAge {
  if (measuredAt === null) {
    return {
      kind: "unrecorded",
      text: "measurement age not recorded (cached before this was tracked)",
    };
  }
  const relative = formatLastChanged(measuredAt, nowMs);
  const ageSeconds = Math.max(0, Math.floor((nowMs - measuredAt * 1000) / 1000));
  if (ageSeconds >= NOTICEABLY_OLD_SECONDS) {
    return { kind: "old", relative, caveat: "may not reflect uncommitted work since" };
  }
  return { kind: "fresh", relative };
}
