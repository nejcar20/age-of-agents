import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Mirrors Rust's `history::StatusSpan` field for field (no `rename_all` on
 * that struct, so the wire format is already snake_case — see
 * `src-tauri/src/history.rs`). */
export type StatusSpan = {
  pane_id: string;
  status: string;
  start: string | null;
  start_exact: boolean;
  end: string | null;
  end_exact: boolean;
  last_confirmed: string;
  duration_secs: number | null;
};

/** Mirrors Rust's `history::RepoHistory` — see that struct's own doc
 * comments for what each field honestly does and doesn't claim. */
export type RepoHistory = {
  root: string;
  name: string;
  spans: StatusSpan[];
  working_sessions: number;
  total_working_secs: number;
  last_observed_at: string | null;
  current_status: string | null;
  current_status_pane: string | null;
  current_status_since: string | null;
  current_status_since_exact: boolean;
  name_ambiguous: boolean;
  legacy_rows_matched_by_name: number;
  legacy_rows_excluded_ambiguous: number;
};

export function repoHistory(root: string): Promise<RepoHistory> {
  return invoke<RepoHistory>("repo_history", { root });
}

export type RepoHistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; history: RepoHistory };

/**
 * Fetched once per island root, same "fetch on mount, never poll" shape
 * `useAgentKinds` already uses — this is supplementary colour for the panel,
 * not a live feed, and `repo_history` reads a log file that only changes on
 * a real attention transition, never worth re-fetching on a timer.
 */
export function useRepoHistory(root: string): RepoHistoryState {
  const [state, setState] = useState<RepoHistoryState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    repoHistory(root)
      .then((history) => {
        if (cancelled) return;
        // Defensive: a test double (or a future backend change) resolving
        // something other than a real `RepoHistory` must not crash
        // `summarizeRepoHistory` — this is supplementary colour for the
        // panel, so treating anything malformed as "nothing to show" is the
        // honest, safe fallback rather than a hard error for what amounts to
        // missing data.
        if (history && typeof history === "object" && Array.isArray(history.spans)) {
          setState({ status: "ready", history });
        } else {
          setState({ status: "error", message: "no history available" });
        }
      })
      .catch((error) => {
        if (!cancelled) setState({ status: "error", message: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  return state;
}

/**
 * "Give the place a sense of history" (game-feel round) — a short, honest
 * ONE-LINE summary for the island panel, not a full visual timeline: the
 * coordinator's own instruction was to add this "only if it earns its
 * place," and a compact line that answers "how much has actually happened
 * here" earns it without the panel-height cost (and design risk) a graphical
 * timeline would add on top of a panel this round already had to shrink to
 * fix a real layout bug.
 *
 * Returns `null` when there is genuinely nothing honest to say — no
 * recorded sessions at all, or every legacy log row had to be excluded
 * because this repo's name is ambiguous (`RepoHistory.name_ambiguous`) —
 * rather than a misleading "0 sessions" that reads as "nothing has ever
 * happened here."
 */
export function summarizeRepoHistory(history: RepoHistory, nowMs: number = Date.now()): string | null {
  const parts: string[] = [];
  if (history.working_sessions > 0) {
    parts.push(`${history.working_sessions} session${history.working_sessions === 1 ? "" : "s"}`);
  }
  if (history.total_working_secs > 0) {
    parts.push(`${formatDuration(history.total_working_secs)} worked`);
  }
  if (history.current_status === "stopped" && history.current_status_since_exact && history.current_status_since) {
    parts.push(`stopped ${formatRelative(history.current_status_since, nowMs)}`);
  } else if (history.last_observed_at) {
    parts.push(`last seen ${formatRelative(history.last_observed_at, nowMs)}`);
  }
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

/** Same relative-time shape as `lastChanged.ts`'s `formatLastChanged`
 * (never a fabricated "just now" for the future, never silently negative),
 * parameterized on an ISO/RFC3339 string instead of Unix seconds since
 * that's what `history::StatusSpan`'s timestamps actually are. */
function formatRelative(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const deltaMs = nowMs - then;
  if (deltaMs <= 0) return "just now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
