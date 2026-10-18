import { describe, expect, it } from "vitest";
import { formatLastChanged } from "./lastChanged";

// A fixed "now" so every test is deterministic — never `Date.now()`.
const NOW = Date.parse("2026-09-18T12:00:00Z");
const secondsAgo = (s: number) => Math.floor(NOW / 1000) - s;

describe("formatLastChanged", () => {
  it("renders null as an honest unknown, never a guessed date", () => {
    expect(formatLastChanged(null, NOW)).toBe("no known date");
  });

  it("renders a moment ago as 'just now'", () => {
    expect(formatLastChanged(secondsAgo(5), NOW)).toBe("just now");
  });

  it("does not cross into minutes before 60 seconds", () => {
    expect(formatLastChanged(secondsAgo(59), NOW)).toBe("just now");
  });

  it("crosses into minutes at exactly 60 seconds", () => {
    expect(formatLastChanged(secondsAgo(60), NOW)).toBe("1m ago");
  });

  it("renders minutes", () => {
    expect(formatLastChanged(secondsAgo(60 * 45), NOW)).toBe("45m ago");
  });

  it("does not cross into hours before 60 minutes", () => {
    expect(formatLastChanged(secondsAgo(60 * 59), NOW)).toBe("59m ago");
  });

  it("crosses into hours at exactly 60 minutes", () => {
    expect(formatLastChanged(secondsAgo(60 * 60), NOW)).toBe("1h ago");
  });

  it("renders hours", () => {
    expect(formatLastChanged(secondsAgo(60 * 60 * 2), NOW)).toBe("2h ago");
  });

  it("does not cross into days before 24 hours", () => {
    expect(formatLastChanged(secondsAgo(60 * 60 * 23), NOW)).toBe("23h ago");
  });

  it("crosses into days at exactly 24 hours, singular", () => {
    expect(formatLastChanged(secondsAgo(60 * 60 * 24), NOW)).toBe("1 day ago");
  });

  it("renders days, plural", () => {
    expect(formatLastChanged(secondsAgo(60 * 60 * 24 * 3), NOW)).toBe("3 days ago");
  });

  it("does not cross into months before 30 days", () => {
    expect(formatLastChanged(secondsAgo(60 * 60 * 24 * 29), NOW)).toBe("29 days ago");
  });

  it("crosses into months at 30 days, singular", () => {
    expect(formatLastChanged(secondsAgo(60 * 60 * 24 * 30), NOW)).toBe("1 month ago");
  });

  it("renders months, plural", () => {
    expect(formatLastChanged(secondsAgo(60 * 60 * 24 * 90), NOW)).toBe("3 months ago");
  });

  it("crosses into years at 365 days", () => {
    expect(formatLastChanged(secondsAgo(60 * 60 * 24 * 365), NOW)).toBe("1 year ago");
  });

  it("renders years, plural", () => {
    expect(formatLastChanged(secondsAgo(60 * 60 * 24 * 365 * 2), NOW)).toBe("2 years ago");
  });

  it("treats a future timestamp (clock skew) as 'just now', never a negative duration", () => {
    const future = Math.floor(NOW / 1000) + 3600;
    expect(formatLastChanged(future, NOW)).toBe("just now");
  });
});
