import { describe, expect, it } from "vitest";
import { summarizeRepoHistory, type RepoHistory } from "./history";

const NOW = Date.parse("2026-09-18T12:00:00Z");

function history(overrides: Partial<RepoHistory> = {}): RepoHistory {
  return {
    root: "/x",
    name: "x",
    spans: [],
    working_sessions: 0,
    total_working_secs: 0,
    last_observed_at: null,
    current_status: null,
    current_status_pane: null,
    current_status_since: null,
    current_status_since_exact: false,
    name_ambiguous: false,
    legacy_rows_matched_by_name: 0,
    legacy_rows_excluded_ambiguous: 0,
    ...overrides,
  };
}

describe("summarizeRepoHistory", () => {
  it("is null when there is nothing honest to say at all", () => {
    expect(summarizeRepoHistory(history(), NOW)).toBeNull();
  });

  it("never fabricates '0 sessions' — a truly empty history stays null even if the repo is ambiguous", () => {
    expect(summarizeRepoHistory(history({ name_ambiguous: true }), NOW)).toBeNull();
  });

  it("reports session count and total worked time", () => {
    expect(summarizeRepoHistory(history({ working_sessions: 5, total_working_secs: 8040 }), NOW)).toBe(
      "5 sessions · 2h 14m worked",
    );
  });

  it("uses singular 'session' for exactly one", () => {
    expect(summarizeRepoHistory(history({ working_sessions: 1, total_working_secs: 60 }), NOW)).toBe(
      "1 session · 1m worked",
    );
  });

  it("prefers 'stopped <relative>' when the current status is an EXACT stop", () => {
    const h = history({
      current_status: "stopped",
      current_status_since: "2026-09-18T10:00:00Z",
      current_status_since_exact: true,
      last_observed_at: "2026-09-18T10:00:00Z",
    });
    expect(summarizeRepoHistory(h, NOW)).toBe("stopped 2h ago");
  });

  it("falls back to 'last seen <relative>' when not an exact current stop", () => {
    const h = history({ last_observed_at: "2026-09-18T11:00:00Z" });
    expect(summarizeRepoHistory(h, NOW)).toBe("last seen 1h ago");
  });

  it("never claims an exact 'stopped since' when the span start was only inferred", () => {
    // Honesty rule: `current_status_since_exact: false` means the true start
    // predates our observation — showing "stopped Xh ago" here would claim
    // more precision than the data actually has.
    const h = history({
      current_status: "stopped",
      current_status_since: "2026-09-18T10:00:00Z",
      current_status_since_exact: false,
      last_observed_at: "2026-09-18T11:30:00Z",
    });
    expect(summarizeRepoHistory(h, NOW)).toBe("last seen 30m ago");
  });

  it("combines all three parts when all are available", () => {
    const h = history({
      working_sessions: 3,
      total_working_secs: 120,
      current_status: "stopped",
      current_status_since: "2026-09-18T11:59:00Z",
      current_status_since_exact: true,
    });
    expect(summarizeRepoHistory(h, NOW)).toBe("3 sessions · 2m worked · stopped 1m ago");
  });
});
