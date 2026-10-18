/**
 * The activity lens — an OPT-IN overlay that answers one question across
 * the whole sea at once: "which of these projects is alive, and which has
 * been sitting?"
 *
 * The author's ask: show when work last happened on each project, so a
 * regularly worked-on project reads differently from a neglected one, and,
 * importantly, do it even when Herdr is not running, so you can still see
 * which projects have gone quiet.
 *
 * ## Which signal this uses, and which it deliberately does not
 *
 * The lens reads `IslandView.last_changed_at` — the Unix seconds of a
 * repository's most recent COMMIT, produced by the filesystem/git scan in
 * `get_archipelago`. It is the only one of the two "work happened here"
 * signals this codebase has that actually answers the question:
 *
 * - It exists for every repository, whether or not herdr is running and
 *   whether or not an agent was ever pointed at it — the author's explicit
 *   second constraint above.
 * - It reaches back as far as the repository's own history does, which is
 *   what "regularly programmed vs not" is a question about.
 *
 * `repo_history` (`history.ts`, aggregated from
 * `~/.age-of-agents/transitions.jsonl`) is a real and complementary signal —
 * "when did an AGENT last work here" — and it stays exactly where it is, in
 * the island panel. It is not what the wide view is built on, and mixing
 * the two into one channel would be a conflation, not a feature: measured
 * on the author's own machine on 2026-09-19 that log covered **8 roots out
 * of 152**, going back three days. A lens built on it would report "unknown"
 * for 95% of the sea and could not distinguish a project worked on weekly
 * for two years from one abandoned in 2021.
 *
 * ## Why buckets, and why THESE buckets
 *
 * Six ordered buckets, with boundaries at 1 / 7 / 30 / 90 / 365 days. These
 * are not a guess: they were chosen against the author's real archipelago
 * cache (`~/.age-of-agents/archipelago.json`, all 152 repositories, read on
 * 2026-09-19). Every single boundary falls inside a genuinely EMPTY gap in
 * his distribution, so no repository sits near a cut and none is arbitrarily
 * assigned to one side of it:
 *
 * | boundary | repos below | nearest below | nearest above | empty gap |
 * |---|---|---|---|---|
 * | 1 day    |   5 | 0.46 d  | 2.21 d  | 1.75 d  |
 * | 7 days   |   9 | 6.86 d  | 8.54 d  | 1.68 d  |
 * | 30 days  |  17 | 25.31 d | 34.43 d | 9.12 d  |
 * | 90 days  |  26 | 84.21 d | 97.13 d | 12.92 d |
 * | 365 days |  62 | 363.11 d| 395.35 d| 32.24 d |
 *
 * The resulting shape of his world — 5 today, 4 this week, 8 this month, 9
 * this quarter, 36 this year, 90 over a year, median 575 days — is also the
 * argument for why this is a LENS and not a permanent change to how every
 * island looks. See the report for that argument in full.
 *
 * ## The honesty rules this module carries
 *
 * - `null` (`last_changed_at` genuinely unknown: no commits yet, not a
 *   repository, or the git call failed — see `Island.last_changed_at`'s own
 *   doc comment in `world.ts`) is its OWN bucket, `"unknown"`. It is never
 *   folded into `"older"` ("very old") and never into `"today"` ("brand
 *   new"), it is not placed on the colour ramp at all, and the sea draws it
 *   with a visibly different mark (a broken ring) rather than a ramp colour.
 * - A timestamp in the FUTURE (clock skew, a rebase) reads as `"today"`, the
 *   same honest floor `formatLastChanged` already applies with "just now" —
 *   never a negative age and never "unknown".
 * - Nothing here ranks, scores, or counts streaks. A bucket is a date, not a
 *   verdict; the labels say when, never how much or how well.
 */

/** One step of the recency scale, most recent first. `"unknown"` is
 * deliberately part of this union and deliberately NOT part of the ordered
 * ramp — see the module doc. */
export type ActivityBucket = "today" | "week" | "month" | "quarter" | "year" | "older" | "unknown";

/** Upper bound (exclusive) in DAYS for each dated bucket, in order. The last
 * dated bucket (`"older"`) has no upper bound. Exported so the legend and
 * the tests read the same numbers the classifier does. */
export const ACTIVITY_BUCKET_DAYS: readonly { bucket: ActivityBucket; maxDays: number }[] = [
  { bucket: "today", maxDays: 1 },
  { bucket: "week", maxDays: 7 },
  { bucket: "month", maxDays: 30 },
  { bucket: "quarter", maxDays: 90 },
  { bucket: "year", maxDays: 365 },
];

/** Every bucket in the order the legend lists them: the ramp, most recent
 * first, then `"unknown"` off the end of it. */
export const ACTIVITY_BUCKET_ORDER: readonly ActivityBucket[] = [
  "today",
  "week",
  "month",
  "quarter",
  "year",
  "older",
  "unknown",
];

const MS_PER_DAY = 86_400_000;

/**
 * Which recency bucket a repository's `last_changed_at` falls in.
 *
 * @param unixSeconds `Island.last_changed_at` / `IslandView.last_changed_at`
 *   — Unix SECONDS, or `null` for genuinely unknown.
 * @param nowMs "now" as an explicit parameter, matching `formatLastChanged`
 *   and `jumpMessage`: this decides what the sea draws, so it must be
 *   testable outside real-clock time.
 */
export function activityBucket(unixSeconds: number | null, nowMs: number = Date.now()): ActivityBucket {
  if (unixSeconds === null) return "unknown";
  const deltaMs = nowMs - unixSeconds * 1000;
  // Same floor as `formatLastChanged`'s "just now": a commit timestamped
  // slightly in the future is a real, common thing (a fast clock, a rebase)
  // and must not fall off the scale or become "unknown".
  if (deltaMs <= 0) return "today";
  const days = deltaMs / MS_PER_DAY;
  for (const { bucket, maxDays } of ACTIVITY_BUCKET_DAYS) {
    if (days < maxDays) return bucket;
  }
  return "older";
}

/**
 * The lens palette — a SEQUENTIAL ramp (ordered data gets an ordered scale,
 * never six categorical hues), monotonically darkening from the most recent
 * step to the least.
 *
 * Every value sits in the violet band, which is the one part of the wheel
 * this product has not already spent:
 *
 * - `ATTENTION_COLOR` owns amber (`stopped`), azure (`working`), slate
 *   (`unknown`) and warm sand (`quiet`) — an island's AGE must never be
 *   confusable with an agent's STATE, so the lens shares no hue with any of
 *   them.
 * - `SEARCH_MATCH_COLOR` owns vivid magenta (`#ff3fb0`).
 * - The scenery owns deep blue through turquoise (water), green (grass),
 *   sand and cream (ground and walls).
 *
 * Direction of the ramp: lighter = more recent. This is NOT "old things
 * fade" — every ring is drawn at the same opacity and the same thickness, so
 * a year-old island is exactly as present on screen as a fresh one, just a
 * different colour. The dark end is a deep violet against bright turquoise
 * shallows, which is a high-contrast mark, not an absent one. That
 * distinction matters: a channel that made dormant islands FAINT would be
 * both a second use of the search filter's recede language and an implicit
 * judgement about projects that are perfectly fine as they are.
 *
 * `"unknown"` is deliberately off the ramp — a desaturated VIOLET-grey,
 * drawn as a BROKEN ring (see `ActivityRing` in `Archipelago.tsx`), so "we
 * have no date for this repository" can never be read as a position on the
 * scale. The violet cast is deliberate too: it says the mark belongs to
 * this overlay, while keeping it clear of the blue-grey `FOG_COLOR`
 * (`#9aa3ad`) that already means the DIFFERENT unknown "we could not
 * measure how big this repository is". The two can legitimately appear on
 * one island at once, which is exactly why they must not look alike.
 */
export const ACTIVITY_COLOR: Record<ActivityBucket, string> = {
  today: "#f7c9ff",
  week: "#e2a4fa",
  month: "#c478f0",
  quarter: "#a552e2",
  year: "#8434c6",
  older: "#6023a0",
  unknown: "#b3a9c2",
};

/**
 * Legend text. Deliberately plain "when" language with no adjective of
 * approval anywhere in it — "over a year" is a date, "neglected" would be a
 * verdict, and principle 5 ("nothing rewards being a worse engineer") plus
 * principle 6 ("threats attack the code, never your attendance") between
 * them rule the second kind of word out of this app entirely.
 */
export const ACTIVITY_LABEL: Record<ActivityBucket, string> = {
  today: "today",
  week: "past week",
  month: "past month",
  quarter: "past 3 months",
  year: "past year",
  older: "over a year",
  unknown: "no known date",
};

/**
 * How many repositories fall in each bucket — what the legend puts beside
 * each swatch, so the lens shows the actual SHAPE of his archipelago rather
 * than making him count coloured rings. Every bucket is present in the
 * result even at zero, so the legend's rows never shift around as the world
 * changes.
 *
 * This is a distribution, not a score: it goes up and down with nothing the
 * user did today, it is not stored, not compared against a previous value,
 * and nothing in the app reacts to it.
 */
export function activityBucketCounts(
  lastChangedAt: readonly (number | null)[],
  nowMs: number = Date.now(),
): Record<ActivityBucket, number> {
  const counts = {
    today: 0, week: 0, month: 0, quarter: 0, year: 0, older: 0, unknown: 0,
  } as Record<ActivityBucket, number>;
  for (const value of lastChangedAt) counts[activityBucket(value, nowMs)] += 1;
  return counts;
}

const LENS_STORAGE_KEY = "aoa.activityLens";

/**
 * The lens remembers whether it was on between launches — same
 * `localStorage`-only, best-effort, never-crash treatment (and the same
 * reasoning) as `loadIslandSortMode` in `world.ts`: a small per-machine UI
 * preference, not state worth a backend, and `localStorage` can legitimately
 * throw or not exist at all (privacy mode, or any non-`jsdom` test here).
 * Defaults to OFF, which is the whole point of an opt-in channel.
 */
export function loadActivityLens(): boolean {
  try {
    return localStorage.getItem(LENS_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

/** The save side of `loadActivityLens` — same best-effort rationale. */
export function saveActivityLens(enabled: boolean): void {
  try {
    localStorage.setItem(LENS_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Best-effort only — see `loadActivityLens`.
  }
}
