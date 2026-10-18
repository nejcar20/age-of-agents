import { describe, expect, it } from "vitest";
import {
  activityBucket,
  activityBucketCounts,
  ACTIVITY_BUCKET_DAYS,
  ACTIVITY_BUCKET_ORDER,
  ACTIVITY_COLOR,
  ACTIVITY_LABEL,
  type ActivityBucket,
} from "./activityLens";
import { ATTENTION_COLOR } from "./archipelago";

// A fixed "now" so every test is deterministic — never `Date.now()`. Same
// convention as `lastChanged.test.ts`.
const NOW = Date.parse("2026-09-19T12:00:00Z");
const DAY_SECONDS = 86_400;
const daysAgo = (d: number) => Math.floor(NOW / 1000) - Math.round(d * DAY_SECONDS);

describe("activityBucket", () => {
  it("puts a genuinely unknown date in its own bucket, never on the ramp", () => {
    expect(activityBucket(null, NOW)).toBe("unknown");
  });

  it("does not read an unknown date as very old", () => {
    expect(activityBucket(null, NOW)).not.toBe("older");
  });

  it("does not read an unknown date as brand new", () => {
    expect(activityBucket(null, NOW)).not.toBe("today");
  });

  it("reads a commit from minutes ago as today", () => {
    expect(activityBucket(daysAgo(0.01), NOW)).toBe("today");
  });

  it("reads a future timestamp as today, never a negative age or unknown", () => {
    expect(activityBucket(Math.floor(NOW / 1000) + 3600, NOW)).toBe("today");
  });

  it("holds 'today' right up to the one-day boundary", () => {
    expect(activityBucket(daysAgo(0.999), NOW)).toBe("today");
  });

  it("crosses out of 'today' at exactly one day", () => {
    expect(activityBucket(daysAgo(1), NOW)).toBe("week");
  });

  it("crosses out of 'past week' at exactly seven days", () => {
    expect(activityBucket(daysAgo(6.99), NOW)).toBe("week");
    expect(activityBucket(daysAgo(7), NOW)).toBe("month");
  });

  it("crosses out of 'past month' at exactly thirty days", () => {
    expect(activityBucket(daysAgo(29.9), NOW)).toBe("month");
    expect(activityBucket(daysAgo(30), NOW)).toBe("quarter");
  });

  it("crosses out of 'past 3 months' at exactly ninety days", () => {
    expect(activityBucket(daysAgo(89.9), NOW)).toBe("quarter");
    expect(activityBucket(daysAgo(90), NOW)).toBe("year");
  });

  it("crosses into 'over a year' at exactly 365 days", () => {
    expect(activityBucket(daysAgo(364.9), NOW)).toBe("year");
    expect(activityBucket(daysAgo(365), NOW)).toBe("older");
  });

  it("keeps a very old repository in 'over a year' rather than falling off the scale", () => {
    expect(activityBucket(daysAgo(1855), NOW)).toBe("older");
  });

  // The author's real distribution on 2026-09-19 (all 152 repositories, from
  // `~/.age-of-agents/archipelago.json`). Every boundary was chosen to fall
  // in an EMPTY gap of this distribution — these are the two real repository
  // ages that bracket each cut, so a drift in the boundaries that would start
  // reclassifying his actual repositories fails here.
  const REAL_GAPS: { below: number; above: number; belowBucket: ActivityBucket; aboveBucket: ActivityBucket }[] = [
    { below: 0.46, above: 2.21, belowBucket: "today", aboveBucket: "week" },
    { below: 6.86, above: 8.54, belowBucket: "week", aboveBucket: "month" },
    { below: 25.31, above: 34.43, belowBucket: "month", aboveBucket: "quarter" },
    { below: 84.21, above: 97.13, belowBucket: "quarter", aboveBucket: "year" },
    { below: 363.11, above: 395.35, belowBucket: "year", aboveBucket: "older" },
  ];

  it.each(REAL_GAPS)(
    "puts the real repositories bracketing each boundary ($below d / $above d) on the sides they belong on",
    ({ below, above, belowBucket, aboveBucket }) => {
      expect(activityBucket(daysAgo(below), NOW)).toBe(belowBucket);
      expect(activityBucket(daysAgo(above), NOW)).toBe(aboveBucket);
    },
  );
});

describe("the lens palette", () => {
  it("covers every bucket with a colour and a label", () => {
    for (const bucket of ACTIVITY_BUCKET_ORDER) {
      expect(ACTIVITY_COLOR[bucket]).toMatch(/^#[0-9a-f]{6}$/);
      expect(ACTIVITY_LABEL[bucket].length).toBeGreaterThan(0);
    }
  });

  it("never reuses an attention colour — an island's AGE must not read as an agent's STATE", () => {
    const attention = new Set(Object.values(ATTENTION_COLOR));
    for (const bucket of ACTIVITY_BUCKET_ORDER) {
      expect(attention.has(ACTIVITY_COLOR[bucket])).toBe(false);
    }
  });

  it("gives every bucket a distinct colour", () => {
    const seen = new Set(ACTIVITY_BUCKET_ORDER.map((b) => ACTIVITY_COLOR[b]));
    expect(seen.size).toBe(ACTIVITY_BUCKET_ORDER.length);
  });

  // The ramp is sequential: ordered data gets an ordered scale. Luminance
  // must decrease monotonically across the DATED buckets so "lighter = more
  // recent" holds at every step rather than only at the ends.
  it("darkens monotonically from the most recent dated bucket to the least", () => {
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    };
    const dated = ACTIVITY_BUCKET_ORDER.filter((b) => b !== "unknown");
    for (let i = 1; i < dated.length; i++) {
      expect(luminance(ACTIVITY_COLOR[dated[i]])).toBeLessThan(luminance(ACTIVITY_COLOR[dated[i - 1]]));
    }
  });

  it("lists the dated buckets in the same order the classifier crosses them", () => {
    expect(ACTIVITY_BUCKET_ORDER.slice(0, ACTIVITY_BUCKET_DAYS.length)).toEqual(
      ACTIVITY_BUCKET_DAYS.map((b) => b.bucket),
    );
    expect(ACTIVITY_BUCKET_ORDER[ACTIVITY_BUCKET_ORDER.length - 1]).toBe("unknown");
  });
});

describe("activityBucketCounts", () => {
  it("reports every bucket even at zero, so the legend's rows never shift", () => {
    const counts = activityBucketCounts([], NOW);
    for (const bucket of ACTIVITY_BUCKET_ORDER) expect(counts[bucket]).toBe(0);
  });

  it("counts an unknown date as unknown rather than silently dropping it", () => {
    const counts = activityBucketCounts([null, null, daysAgo(0.2)], NOW);
    expect(counts.unknown).toBe(2);
    expect(counts.today).toBe(1);
    const total = ACTIVITY_BUCKET_ORDER.reduce((sum, b) => sum + counts[b], 0);
    expect(total).toBe(3);
  });

  it("reproduces the shape of the author's real archipelago", () => {
    // One representative real age per bucket, repeated to the real counts
    // measured on 2026-09-19 across all 152 repositories.
    const ages: number[] = [];
    const push = (days: number, times: number) => {
      for (let i = 0; i < times; i++) ages.push(daysAgo(days));
    };
    push(0.2, 5);
    push(4, 4);
    push(10, 8);
    push(50, 9);
    push(200, 36);
    push(900, 90);
    const counts = activityBucketCounts(ages, NOW);
    expect(counts).toEqual({ today: 5, week: 4, month: 8, quarter: 9, year: 36, older: 90, unknown: 0 });
    expect(ages.length).toBe(152);
  });
});
