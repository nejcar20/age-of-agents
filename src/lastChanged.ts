/**
 * A short, relative rendering of `Island.last_changed_at` (Unix seconds, or
 * `null` when genuinely unknown — see that field's doc comment in
 * `world.ts`). Pure, and takes "now" as an explicit parameter, matching this
 * codebase's pattern of keeping formatting logic testable outside a
 * component and outside real-clock time (`jump.ts`'s `jumpMessage`).
 *
 * `null` renders as an honest "no known date" — never substituted with "just
 * now" or any other guess. `compareByRecency` in `world.ts` applies the
 * matching rule on the sort side (an unknown date sorts last, never first).
 */
export function formatLastChanged(unixSeconds: number | null, nowMs: number = Date.now()): string {
  if (unixSeconds === null) return "no known date";

  const deltaMs = nowMs - unixSeconds * 1000;
  // A clock skew or a commit timestamped slightly in the future (a common
  // real-world case: a machine with a fast clock, or a rebase) must not
  // render as a negative duration — "just now" is the honest floor, not a
  // claim about the future.
  if (deltaMs <= 0) return "just now";

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "1 day ago" : `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;

  const years = Math.floor(days / 365);
  return years <= 1 ? "1 year ago" : `${years} years ago`;
}
