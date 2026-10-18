import { describe, expect, it } from "vitest";
import { describeMeasuredAt } from "./measuredAt";

// A fixed "now" so every test is deterministic — never `Date.now()`.
const NOW = Date.parse("2026-09-18T12:00:00Z");
const secondsAgo = (s: number) => Math.floor(NOW / 1000) - s;

describe("describeMeasuredAt", () => {
  it("renders null as an honest 'never recorded', never a fabricated date", () => {
    const result = describeMeasuredAt(null, NOW);
    expect(result.kind).toBe("unrecorded");
    expect(result).toMatchObject({
      kind: "unrecorded",
      text: "measurement age not recorded (cached before this was tracked)",
    });
  });

  it("treats a recent measurement (5 minutes ago) as fresh, no caveat", () => {
    const result = describeMeasuredAt(secondsAgo(60 * 5), NOW);
    expect(result).toEqual({ kind: "fresh", relative: "5m ago" });
  });

  it("stays fresh right up to (but not including) the noticeably-old threshold", () => {
    const result = describeMeasuredAt(secondsAgo(60 * 59), NOW);
    expect(result.kind).toBe("fresh");
  });

  it("crosses into 'old' at exactly one hour, with a caveat that never claims the count is wrong", () => {
    const result = describeMeasuredAt(secondsAgo(60 * 60), NOW);
    expect(result).toEqual({
      kind: "old",
      relative: "1h ago",
      caveat: "may not reflect uncommitted work since",
    });
  });

  it("renders a noticeably old (multi-day) measurement as 'old' with the same relative text formatLastChanged would produce", () => {
    const result = describeMeasuredAt(secondsAgo(60 * 60 * 24 * 3), NOW);
    expect(result).toEqual({
      kind: "old",
      relative: "3 days ago",
      caveat: "may not reflect uncommitted work since",
    });
  });

  it("never renders 'old'/'fresh' text as though it were a claim of certainty — caveat wording is hedged", () => {
    const result = describeMeasuredAt(secondsAgo(60 * 60 * 5), NOW);
    if (result.kind !== "old") throw new Error("expected old");
    expect(result.caveat.toLowerCase()).toContain("may not");
  });
});
