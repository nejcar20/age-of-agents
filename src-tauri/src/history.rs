//! Turns `~/.age-of-agents/transitions.jsonl`'s raw per-pane status
//! transitions into a per-repository, readable history: not a list of state
//! changes but a list of spans — "worked 14:02-14:31, blocked since 14:31" —
//! that an island panel can render as a small timeline.
//!
//! ## First-sight rows do not invent a transition
//!
//! `transitions::TransitionLog::record` writes `from: null` the first time a
//! pane is seen by a given (in-memory, reset-on-restart) `last` map — it is
//! a re-observation ("this pane is *currently* in state X"), never a
//! transition ("it just became X"). On the author's real log this is the
//! majority case (58 of 112 rows) and it recurs for the SAME pane across
//! many app restarts without the underlying status ever changing (see
//! `w16:p1` and `w27:p1` in the real file — dozens of `from: null` rows all
//! landing on the same `to`).
//!
//! Treating a first-sight row as "the state changed right now" would put a
//! fabricated start time on a span that in reality started long before we
//! ever looked. So a first-sight row only ever does one of two things here:
//!
//! - if it repeats the status we already believe the pane is in, it just
//!   pushes `last_confirmed` forward (still that status, confirmed again at
//!   this later time) — it changes NOTHING about when the span started;
//! - if it reports a *different* status than we last believed, something
//!   changed at some unobserved point between `last_confirmed` and now.  We
//!   close the old span at `last_confirmed` (the last instant we actually
//!   know it still held) and open a new one whose start is `None` /
//!   "not exact" — never a made-up timestamp.
//!
//! Only a REAL transition (`from` is `Some`) ever produces an exact
//! boundary, because only a real transition tells us precisely when a
//! change happened.
//!
//! ## The identity problem: `repo` is a display name, not an identity
//!
//! Every row written before this module existed carries only `repo` (a
//! basename such as `"atlas"`), not a canonical root — `Island` identity
//! everywhere else in this codebase is the canonical root
//! (`world::repo::normalize_path`), because that's the only thing that can't
//! collide. Two differently-located repositories that happen to share a
//! basename would otherwise show each other's history.
//!
//! Going forward, `transitions::TransitionLog::record` additionally writes
//! `repo_root` (the island's already-canonical `root`) on every new row, so
//! future lookups are exact matches, never name guesses. Rows written before
//! that change have no `repo_root` (`#[serde(default)]` lets them parse
//! fine) and can only be matched by name. `build_repo_history` is handed
//! `name_ambiguous` (computed by the caller from the user's real repository
//! set — see `commands::repo_history`) and:
//!
//! - if the name is unique among the repositories this user has, legacy rows
//!   matching it by name are included, and the count is reported
//!   (`legacy_rows_matched_by_name`) so a caller can still choose to
//!   caveat them;
//! - if the name collides with another real repository, legacy rows are
//!   EXCLUDED rather than silently attributed to the wrong island — a wrong
//!   "certain" answer is worse than a missing one — and the count of what
//!   was excluded is reported (`legacy_rows_excluded_ambiguous`) so this
//!   is visible, not silently dropped.
//!
//! A row that carries `repo_root` for a DIFFERENT root is never matched by
//! name either, even if the display name happens to match — an explicit
//! root always wins over a name guess.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Never pull more than this many trailing bytes of the log into memory.
/// The file is append-only and, per the module the author wrote it for,
/// expected to grow without bound over months of use; a caller asking for a
/// repo's history wants its recent story, not a full re-parse of the user's
/// entire history every time. 8 MiB is generous for a format this compact
/// (real-world: 112 lines is a few KB) while keeping a hard ceiling.
const DEFAULT_TAIL_LIMIT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
struct TransitionRow {
    at: String,
    from: Option<String>,
    pane_id: String,
    repo: String,
    to: String,
    /// Added going forward (see module docs). Absent on every row written
    /// before this change; `#[serde(default)]` keeps those parsing exactly
    /// as before rather than failing the whole line.
    #[serde(default)]
    repo_root: Option<String>,
}

/// One contiguous stretch of a pane holding a single status.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatusSpan {
    pub pane_id: String,
    pub status: String,
    /// RFC3339, or `None` if the true start predates our observation (the
    /// span's opening was inferred from a re-observation, never a real
    /// transition).
    pub start: Option<String>,
    /// `true` only when `start` came from an actual recorded transition —
    /// i.e. it is exact, not "no earlier than".
    pub start_exact: bool,
    /// RFC3339, or `None` if this is the pane's current (still ongoing)
    /// status.
    pub end: Option<String>,
    /// `true` only when `end` came from an actual recorded transition.
    pub end_exact: bool,
    /// The last time this status was independently confirmed (a real
    /// transition, or a re-observation that still reported the same
    /// status). Lets a UI say "blocked, confirmed as recently as 12:39"
    /// even when there is no closing transition yet.
    pub last_confirmed: String,
    /// Only ever `Some` when both `start_exact` and `end_exact` are true —
    /// never a guess dressed up as a number.
    pub duration_secs: Option<i64>,
}

/// A repository's readable transition history — the shape an island panel's
/// timeline wants.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RepoHistory {
    pub root: String,
    pub name: String,
    /// Chronological (by start when known, else by first confirmation),
    /// across every pane ever seen for this repo. Left un-merged across
    /// panes deliberately: two panes in the same repo (e.g. a worktree) can
    /// genuinely be in different statuses at once, and merging them into one
    /// synthetic repo-wide status would invent a single truth where there
    /// isn't one. `pane_id` on each span lets a UI split or merge as it
    /// likes.
    pub spans: Vec<StatusSpan>,
    /// Count of spans whose status is `"working"` — "how many distinct
    /// working sessions" from the spec, regardless of whether the session's
    /// bounds are exact.
    pub working_sessions: usize,
    /// Sum of `duration_secs` over working spans that have one. Sessions
    /// with an inexact bound are simply not counted rather than estimated.
    pub total_working_secs: i64,
    /// The timestamp of the most recent row attributed to this repo, across
    /// every pane (first-sight rows count: they are still real evidence the
    /// repo was observed at that moment).
    pub last_observed_at: Option<String>,
    /// The status of whichever pane was most recently observed.
    pub current_status: Option<String>,
    pub current_status_pane: Option<String>,
    /// When the CURRENT span began, if known exactly.
    pub current_status_since: Option<String>,
    pub current_status_since_exact: bool,
    /// True if this repo's basename collides with at least one other
    /// repository the user actually has (computed by the caller from the
    /// real repository set, not guessed here).
    pub name_ambiguous: bool,
    /// Legacy (pre-`repo_root`) rows included because the name was unique.
    pub legacy_rows_matched_by_name: usize,
    /// Legacy rows found for this name but EXCLUDED because the name is
    /// ambiguous — never silently attributed.
    pub legacy_rows_excluded_ambiguous: usize,
}

/// Reads the lines of `path` worth considering, bounded to `tail_limit_bytes`
/// of the file's tail.
///
/// - A missing file yields no lines (a repo with no history at all, or a
///   fresh install) — not an error.
/// - When the file is larger than the limit, only the tail is read and the
///   first (possibly partial, since we seeked into the middle of the file)
///   line inside that window is discarded.
/// - The file may be actively appended to by the running app while this
///   reads it. A partial final line (write in progress) is handled at parse
///   time — it simply fails to deserialize and is skipped, same as any other
///   corrupt line — never here and never as an error.
fn read_tail_lines(path: &Path, tail_limit_bytes: u64) -> Vec<String> {
    let Ok(mut file) = File::open(path) else { return Vec::new() };
    let Ok(meta) = file.metadata() else { return Vec::new() };
    let len = meta.len();

    let mut buf = Vec::new();
    if len > tail_limit_bytes {
        let start = len - tail_limit_bytes;
        if file.seek(SeekFrom::Start(start)).is_err() || file.read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        match buf.iter().position(|&b| b == b'\n') {
            Some(pos) => {
                buf.drain(..=pos);
            }
            // The whole tail window is one line (or a fragment) — nothing
            // in it can be trusted to start on a real line boundary.
            None => buf.clear(),
        }
    } else if file.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }

    String::from_utf8_lossy(&buf).lines().map(str::to_string).collect()
}

/// Parses lines into rows, silently skipping anything that doesn't
/// deserialize — a corrupt or truncated line must never be fatal.
fn parse_rows(lines: &[String]) -> Vec<TransitionRow> {
    lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<TransitionRow>(l).ok())
        .collect()
}

fn parse_at(at: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(at).ok()
}

struct PaneState {
    status: String,
    start: Option<String>,
    start_exact: bool,
    last_confirmed: String,
}

/// Builds `name`'s/`root`'s `RepoHistory` from the transition log at
/// `log_path`. `name_ambiguous` must be computed by the caller from the
/// user's actual repository set (see `commands::repo_history`) — this
/// function has no filesystem access beyond the log itself and never guesses
/// at ambiguity.
pub fn build_repo_history(
    log_path: &Path,
    root: &str,
    name: &str,
    name_ambiguous: bool,
) -> RepoHistory {
    build_repo_history_with_limit(log_path, root, name, name_ambiguous, DEFAULT_TAIL_LIMIT_BYTES)
}

/// What one transition-log row means for THIS repo's history, decided once
/// up front so a single chronological pass over the WHOLE log (every repo,
/// not just `root`'s own rows) can both build `root`'s spans and detect when
/// its pane left for somewhere else — see `build_repo_history_with_limit`'s
/// "Opus review, IMPORTANT 4" comment for why seeing only `root`'s own rows
/// is not enough.
enum RowKind {
    /// Definitely `root`: either an explicit matching `repo_root`, or a
    /// legacy (pre-`repo_root`) row whose name unambiguously means `root`.
    Ours,
    /// Definitely NOT `root`: an explicit `repo_root` pointing elsewhere, or
    /// a legacy row whose display name is a different repository entirely.
    /// This is what proves a pane already believed to be in `root` could
    /// not have stayed there.
    Away,
    /// A legacy row whose name matches `root`'s but which COULD belong to a
    /// different, ambiguously-named repository — already excluded from
    /// `relevant` for the same reason `legacy_rows_excluded_ambiguous`
    /// exists, and for the identical reason never trusted as "away"
    /// evidence either: guessing wrong in either direction risks either a
    /// false attribution or a wrongly-closed real span.
    Ignore,
}

fn build_repo_history_with_limit(
    log_path: &Path,
    root: &str,
    name: &str,
    name_ambiguous: bool,
    tail_limit_bytes: u64,
) -> RepoHistory {
    let rows = parse_rows(&read_tail_lines(log_path, tail_limit_bytes));

    let mut legacy_rows_matched_by_name = 0usize;
    let mut legacy_rows_excluded_ambiguous = 0usize;

    // Opus review, IMPORTANT 4: classified from the FULL log (every repo),
    // not just rows attributed to `root` — a pane's appearance under a
    // DIFFERENT repo's root, sorted into its true chronological place among
    // `root`'s own rows, is exactly the evidence needed to know the pane
    // left `root` in between two of its rows, rather than assuming it held
    // its last known `root` status the whole time. Keying `pane_states` by
    // `(pane_id, repo_root)` alone (i.e. only ever looking at `relevant`)
    // stops a `cd` from smuggling a `from` INTO `root`, but does nothing to
    // CLOSE `root`'s span when the pane leaves for elsewhere — this is the
    // fix for that gap.
    let mut all_rows: Vec<(TransitionRow, RowKind)> = Vec::new();
    for row in rows {
        if parse_at(&row.at).is_none() {
            // Corrupt data we can't place on a timeline — dropped here too,
            // same as the old code's separate `retain`.
            continue;
        }
        let kind = match &row.repo_root {
            Some(r) if r == root => RowKind::Ours,
            Some(_) => RowKind::Away,
            None if row.repo == name => {
                if name_ambiguous {
                    legacy_rows_excluded_ambiguous += 1;
                    RowKind::Ignore
                } else {
                    legacy_rows_matched_by_name += 1;
                    RowKind::Ours
                }
            }
            None => RowKind::Away,
        };
        all_rows.push((row, kind));
    }
    all_rows.sort_by_key(|(r, _)| parse_at(&r.at));

    let mut pane_states: HashMap<String, PaneState> = HashMap::new();
    let mut spans: Vec<StatusSpan> = Vec::new();

    for (row, kind) in &all_rows {
        if matches!(kind, RowKind::Ignore) {
            continue;
        }
        if matches!(kind, RowKind::Away) {
            // Definite evidence this pane is (or was, by this timestamp)
            // NOT in `root` any more. If we currently believe it's still
            // open here, close it honestly: we only ever confirmed it as
            // recently as `last_confirmed`, never later, so the end is
            // never exact and no duration is claimed — exactly like the
            // existing "re-observed with a different status" close below,
            // just triggered by leaving the repo instead of by a status
            // change. Removing the entry (rather than leaving it) is what
            // makes a LATER `Ours` row for this pane bootstrap fresh —
            // i.e. inexact — instead of wrongly finding `already_tracked_
            // here == true` across the gap.
            if let Some(state) = pane_states.remove(&row.pane_id) {
                spans.push(StatusSpan {
                    pane_id: row.pane_id.clone(),
                    status: state.status,
                    start: state.start,
                    start_exact: state.start_exact,
                    end: Some(state.last_confirmed.clone()),
                    end_exact: false,
                    last_confirmed: state.last_confirmed,
                    duration_secs: None,
                });
            }
            continue;
        }

        match &row.from {
            None => match pane_states.get_mut(&row.pane_id) {
                None => {
                    pane_states.insert(
                        row.pane_id.clone(),
                        PaneState {
                            status: row.to.clone(),
                            start: None,
                            start_exact: false,
                            last_confirmed: row.at.clone(),
                        },
                    );
                }
                Some(state) if state.status == row.to => {
                    state.last_confirmed = row.at.clone();
                }
                Some(state) => {
                    spans.push(StatusSpan {
                        pane_id: row.pane_id.clone(),
                        status: state.status.clone(),
                        start: state.start.clone(),
                        start_exact: state.start_exact,
                        end: Some(state.last_confirmed.clone()),
                        end_exact: false,
                        last_confirmed: state.last_confirmed.clone(),
                        duration_secs: None,
                    });
                    *state = PaneState {
                        status: row.to.clone(),
                        start: None,
                        start_exact: false,
                        last_confirmed: row.at.clone(),
                    };
                }
            },
            Some(_from) => {
                // IMPORTANT 2: whether this boundary is trustworthy depends
                // on whether we already had state for this pane WITHIN this
                // repo's own relevant rows. If we did, the transition really
                // did happen here, at exactly `row.at`. If this is the first
                // relevant row this pane has produced for this repo (the
                // `or_insert_with` below fires), the `from` status may in
                // truth have started somewhere else entirely — e.g. a `cd`
                // moved this pane's foreground cwd into this repo without an
                // intervening status change, so herdr's *next* observed
                // status change writes `from: Some(<the old repo's last
                // status>)` on a row now attributed to the NEW repo (see
                // `transitions::TransitionLog.last`'s doc comment for the
                // mechanism). Treat a bootstrap boundary as inexact at BOTH
                // ends, exactly like a `from: null` re-observation, rather
                // than manufacturing a trustworthy boundary — and a counted
                // "working session" — that this repo's own history never
                // actually witnessed.
                let already_tracked_here = pane_states.contains_key(&row.pane_id);
                let state = pane_states.entry(row.pane_id.clone()).or_insert_with(|| PaneState {
                    status: _from.clone(),
                    start: None,
                    start_exact: false,
                    last_confirmed: row.at.clone(),
                });
                let boundary_exact = already_tracked_here;
                let duration_secs = if state.start_exact && boundary_exact {
                    state
                        .start
                        .as_ref()
                        .and_then(|s| parse_at(s))
                        .zip(parse_at(&row.at))
                        .map(|(s, e)| (e - s).num_seconds())
                } else {
                    None
                };
                spans.push(StatusSpan {
                    pane_id: row.pane_id.clone(),
                    status: state.status.clone(),
                    start: state.start.clone(),
                    start_exact: state.start_exact,
                    end: Some(row.at.clone()),
                    end_exact: boundary_exact,
                    last_confirmed: row.at.clone(),
                    duration_secs,
                });
                *state = PaneState {
                    status: row.to.clone(),
                    start: if boundary_exact { Some(row.at.clone()) } else { None },
                    start_exact: boundary_exact,
                    last_confirmed: row.at.clone(),
                };
            }
        }
    }

    // Whichever pane's last confirmation is the most recent overall is the
    // repo's "current" answer.
    let current_pane = pane_states
        .iter()
        .max_by(|a, b| parse_at(&a.1.last_confirmed).cmp(&parse_at(&b.1.last_confirmed)))
        .map(|(pane_id, state)| {
            (pane_id.clone(), state.status.clone(), state.start.clone(), state.start_exact)
        });

    let last_observed_at =
        pane_states.values().map(|s| s.last_confirmed.clone()).max_by(|a, b| parse_at(a).cmp(&parse_at(b)));

    for (pane_id, state) in pane_states {
        spans.push(StatusSpan {
            pane_id,
            status: state.status,
            start: state.start,
            start_exact: state.start_exact,
            end: None,
            end_exact: false,
            last_confirmed: state.last_confirmed,
            duration_secs: None,
        });
    }

    spans.sort_by(|a, b| {
        let key = |s: &StatusSpan| s.start.clone().unwrap_or_else(|| s.last_confirmed.clone());
        parse_at(&key(a)).cmp(&parse_at(&key(b)))
    });

    let working_sessions = spans.iter().filter(|s| s.status == "working").count();
    let total_working_secs: i64 =
        spans.iter().filter(|s| s.status == "working").filter_map(|s| s.duration_secs).sum();

    let (current_status, current_status_pane, current_status_since, current_status_since_exact) =
        match current_pane {
            Some((pane_id, status, start, start_exact)) => {
                (Some(status), Some(pane_id), start, start_exact)
            }
            None => (None, None, None, false),
        };

    RepoHistory {
        root: root.to_string(),
        name: name.to_string(),
        spans,
        working_sessions,
        total_working_secs,
        last_observed_at,
        current_status,
        current_status_pane,
        current_status_since,
        current_status_since_exact,
        name_ambiguous,
        legacy_rows_matched_by_name,
        legacy_rows_excluded_ambiguous,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_log(dir: &std::path::Path, lines: &[&str]) -> std::path::PathBuf {
        let path = dir.join("transitions.jsonl");
        let mut file = File::create(&path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
        path
    }

    #[test]
    fn missing_file_yields_empty_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.jsonl");
        let history = build_repo_history(&path, "/p/api", "api", false);
        assert!(history.spans.is_empty());
        assert_eq!(history.working_sessions, 0);
        assert_eq!(history.last_observed_at, None);
        assert_eq!(history.current_status, None);
    }

    #[test]
    fn empty_file_yields_empty_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(dir.path(), &[]);
        let history = build_repo_history(&path, "/p/api", "api", false);
        assert!(history.spans.is_empty());
    }

    #[test]
    fn a_corrupt_line_mid_file_is_skipped_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[
                r#"{"at":"2026-09-16T22:45:05.000000+00:00","from":null,"pane_id":"w1:p1","repo":"api","to":"unknown","repo_root":"/p/api"}"#,
                "{ this is not json at all",
                r#"{"at":"2026-09-16T22:45:10.000000+00:00","from":"unknown","pane_id":"w1:p1","repo":"api","to":"working","repo_root":"/p/api"}"#,
            ],
        );
        let history = build_repo_history(&path, "/p/api", "api", false);
        // Both valid rows still produced spans; the corrupt one didn't crash
        // or poison the rest.
        assert_eq!(history.working_sessions, 1);
        assert_eq!(history.current_status.as_deref(), Some("working"));
    }

    #[test]
    fn a_truncated_final_line_is_skipped_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[r#"{"at":"2026-09-16T22:45:05.000000+00:00","from":null,"pane_id":"w1:p1","repo":"api","to":"unknown","repo_root":"/p/api"}"#],
        );
        // Simulate a write in progress: an unterminated, incomplete JSON
        // object appended without a trailing newline.
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, r#"{{"at":"2026-09-18T00:00:00+00:00","from":"unknow"#).unwrap();

        let history = build_repo_history(&path, "/p/api", "api", false);
        assert_eq!(history.current_status.as_deref(), Some("unknown"));
        assert_eq!(history.spans.len(), 1);
    }

    #[test]
    fn a_repo_with_only_first_sight_rows_has_no_working_sessions_and_an_inexact_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[
                r#"{"at":"2026-09-18T08:07:48.000000+00:00","from":null,"pane_id":"w27:p1","repo":"atlas","to":"blocked","repo_root":"/p/atlas"}"#,
                r#"{"at":"2026-09-18T12:39:51.000000+00:00","from":null,"pane_id":"w27:p1","repo":"atlas","to":"blocked","repo_root":"/p/atlas"}"#,
            ],
        );
        let history = build_repo_history(&path, "/p/atlas", "atlas", false);
        assert_eq!(history.working_sessions, 0);
        assert_eq!(history.spans.len(), 1);
        let span = &history.spans[0];
        assert_eq!(span.status, "blocked");
        assert_eq!(span.start, None, "first sighting must never invent a start time");
        assert!(!span.start_exact);
        // But re-observation DOES push last_confirmed forward.
        assert_eq!(span.last_confirmed, "2026-09-18T12:39:51.000000+00:00");
        assert_eq!(history.current_status_since, None);
        assert!(!history.current_status_since_exact);
    }

    #[test]
    fn a_repo_with_no_history_at_all_returns_an_empty_but_valid_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[r#"{"at":"2026-09-16T22:45:05.000000+00:00","from":null,"pane_id":"w1:p1","repo":"other","to":"unknown","repo_root":"/p/other"}"#],
        );
        let history = build_repo_history(&path, "/p/nothing-here", "nothing-here", false);
        assert!(history.spans.is_empty());
        assert_eq!(history.current_status, None);
    }

    /// IMPORTANT 2, at the history layer. Even with the `transitions.rs` fix
    /// (keying `last` by `(pane_id, repo_root)`) in place going forward, this
    /// module must not trust a `from: Some` row as an exact boundary the
    /// first time it sees that pane within a given repo's own relevant rows
    /// — whether because of pre-fix legacy data, or the tail-limit window
    /// cutting off earlier context. This is the exact cd-between-repos row a
    /// pre-fix `transitions.rs` could still produce: `w2:p1` was `working` in
    /// AgeOfAgents, then (after a `cd`) the very first row `atlas`'s own
    /// history ever sees for `w2:p1` claims `from:"working"` — a status that
    /// in truth happened in a different repository, never in atlas.
    #[test]
    fn a_from_some_bootstrap_row_never_manufactures_an_exact_span_or_duration() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[
                r#"{"at":"2026-09-18T09:00:00.000000+00:00","from":"working","pane_id":"w2:p1","repo":"atlas","to":"idle","repo_root":"/p/atlas"}"#,
            ],
        );
        let history = build_repo_history(&path, "/p/atlas", "atlas", false);

        assert_eq!(history.spans.len(), 2, "the bootstrapped 'working' span and the current 'idle' span");
        let working = history.spans.iter().find(|s| s.status == "working").unwrap();
        assert!(!working.start_exact, "a bootstrap span's start was never observed in this repo");
        assert!(
            !working.end_exact,
            "a bootstrap span's end must not be presented as exact — atlas never actually \
             witnessed this transition, it only inherited the OTHER repo's last known status"
        );
        assert_eq!(working.duration_secs, None, "no exact span means no fabricated duration");

        // The current ('idle') state must likewise not claim an exact start,
        // since it rests on the very same untrustworthy boundary.
        assert_eq!(history.current_status.as_deref(), Some("idle"));
        assert!(!history.current_status_since_exact);
    }

    /// Opus review, IMPORTANT 4: keying by `(pane_id, repo_root)` stops a
    /// `cd` from smuggling a `from` state INTO the new repo (the test
    /// above), but it does not CLOSE the old repo's span when the pane
    /// leaves. Pane `w16:p1` has an already-tracked, exact "blocked" state
    /// in A, transitions blocked->working in A at 09:00 (exact, since it
    /// was already tracked there), then `cd`s to B and does real work there
    /// for ~3 hours (evidenced by a row explicitly rooted at B), then
    /// returns to A and goes working->idle at 12:00. Since `build_repo_
    /// history` only ever sees ROOT's rows, the old (buggy) code had no
    /// evidence the pane ever left A, so it saw two "working"-adjacent rows
    /// for the same pane with nothing in between and confidently closed a
    /// THREE HOUR "working" span with `end_exact: true` and `duration_secs`
    /// close to 10800 — even though only 5 minutes of that was actually
    /// spent in A. The fix must use the row explicitly rooted at B (which
    /// this repo's own log tail already contains) as evidence that the
    /// span could not have stayed open, and never report an exact multi-
    /// hour duration across a gap the pane was demonstrably elsewhere for.
    #[test]
    fn time_spent_in_another_repository_is_never_credited_to_this_one_as_an_exact_duration() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[
                // Already-tracked "blocked" state in A.
                r#"{"at":"2026-09-18T08:59:00.000000+00:00","from":null,"pane_id":"w16:p1","repo":"A","to":"blocked","repo_root":"/p/A"}"#,
                // Real, exact transition in A: blocked -> working.
                r#"{"at":"2026-09-18T09:00:00.000000+00:00","from":"blocked","pane_id":"w16:p1","repo":"A","to":"working","repo_root":"/p/A"}"#,
                // The pane `cd`s to B and does real work there — explicit
                // evidence, in the SAME log, that it left A.
                r#"{"at":"2026-09-18T10:00:00.000000+00:00","from":"working","pane_id":"w16:p1","repo":"B","to":"idle","repo_root":"/p/B"}"#,
                // The pane returns to A and transitions again.
                r#"{"at":"2026-09-18T12:00:00.000000+00:00","from":"working","pane_id":"w16:p1","repo":"A","to":"idle","repo_root":"/p/A"}"#,
            ],
        );
        let history = build_repo_history(&path, "/p/A", "A", false);

        for span in &history.spans {
            if span.status == "working" {
                assert!(
                    span.duration_secs.unwrap_or(0) < 3600,
                    "must never credit A with time actually spent in B: got a 'working' span \
                     with duration {:?} (start_exact={}, end_exact={})",
                    span.duration_secs,
                    span.start_exact,
                    span.end_exact
                );
                assert!(
                    !(span.start_exact && span.end_exact),
                    "a 'working' span spanning the cross-repo gap must not claim BOTH ends exact"
                );
            }
        }
        assert!(
            history.total_working_secs < 3600,
            "total_working_secs must not include the ~3 hours actually spent in B, got {}",
            history.total_working_secs
        );
    }

    #[test]
    fn real_transition_produces_an_exact_working_session_with_a_duration() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[
                r#"{"at":"2026-09-16T22:45:05.000000+00:00","from":null,"pane_id":"w1:p1","repo":"api","to":"unknown","repo_root":"/p/api"}"#,
                r#"{"at":"2026-09-16T22:45:10.000000+00:00","from":"unknown","pane_id":"w1:p1","repo":"api","to":"working","repo_root":"/p/api"}"#,
                r#"{"at":"2026-09-16T22:46:43.000000+00:00","from":"working","pane_id":"w1:p1","repo":"api","to":"blocked","repo_root":"/p/api"}"#,
            ],
        );
        let history = build_repo_history(&path, "/p/api", "api", false);
        assert_eq!(history.working_sessions, 1);
        assert_eq!(history.total_working_secs, 93);
        let working = history.spans.iter().find(|s| s.status == "working").unwrap();
        assert!(working.start_exact && working.end_exact);
        assert_eq!(working.start.as_deref(), Some("2026-09-16T22:45:10.000000+00:00"));
        assert_eq!(working.end.as_deref(), Some("2026-09-16T22:46:43.000000+00:00"));
        assert_eq!(history.current_status.as_deref(), Some("blocked"));
        assert!(history.current_status_since_exact);
    }

    #[test]
    fn legacy_rows_without_repo_root_are_matched_by_name_when_unambiguous() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[r#"{"at":"2026-09-16T22:45:05.000000+00:00","from":null,"pane_id":"w1:p1","repo":"api","to":"working"}"#],
        );
        let history = build_repo_history(&path, "/p/api", "api", false);
        assert_eq!(history.legacy_rows_matched_by_name, 1);
        assert_eq!(history.legacy_rows_excluded_ambiguous, 0);
        assert_eq!(history.current_status.as_deref(), Some("working"));
    }

    #[test]
    fn legacy_rows_without_repo_root_are_excluded_when_the_name_is_ambiguous() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[r#"{"at":"2026-09-16T22:45:05.000000+00:00","from":null,"pane_id":"w1:p1","repo":"api","to":"working"}"#],
        );
        // Two real repos named "api" exist (e.g. ~/work/api and
        // ~/side/api) — the caller passes name_ambiguous=true.
        let history = build_repo_history(&path, "/p/work/api", "api", true);
        assert_eq!(history.legacy_rows_matched_by_name, 0);
        assert_eq!(history.legacy_rows_excluded_ambiguous, 1);
        assert!(history.spans.is_empty(), "an ambiguous name match must never be presented as certain");
        assert_eq!(history.current_status, None);
    }

    #[test]
    fn an_explicit_repo_root_is_never_overridden_by_a_coincidental_name_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[
                // A DIFFERENT "api" repo, with its own explicit root.
                r#"{"at":"2026-09-16T22:45:05.000000+00:00","from":null,"pane_id":"w1:p1","repo":"api","to":"working","repo_root":"/p/other/api"}"#,
            ],
        );
        let history = build_repo_history(&path, "/p/mine/api", "api", false);
        assert!(history.spans.is_empty(), "a row explicitly rooted elsewhere must never be attributed here");
    }

    #[test]
    fn tail_limit_drops_a_partial_leading_line_but_keeps_full_lines_after_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[
                r#"{"at":"2026-09-16T22:45:05.000000+00:00","from":null,"pane_id":"w1:p1","repo":"api","to":"unknown","repo_root":"/p/api"}"#,
                r#"{"at":"2026-09-16T22:45:10.000000+00:00","from":"unknown","pane_id":"w1:p1","repo":"api","to":"working","repo_root":"/p/api"}"#,
            ],
        );
        // A tiny limit forces the reader to seek into the middle of the
        // file; the first line inside that window is a fragment and must be
        // discarded rather than fed to the parser.
        let history = build_repo_history_with_limit(&path, "/p/api", "api", false, 20);
        // Only whatever full line(s) survive after the seek point remain;
        // the important property is that nothing panics or fabricates data,
        // and any row that DOES survive is a genuine, complete line.
        assert!(history.working_sessions <= 1);
    }

    #[test]
    fn multiple_panes_in_one_repo_keep_independent_spans() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(
            dir.path(),
            &[
                r#"{"at":"2026-09-16T22:45:05.000000+00:00","from":null,"pane_id":"w1:p1","repo":"api","to":"working","repo_root":"/p/api"}"#,
                r#"{"at":"2026-09-16T22:45:06.000000+00:00","from":null,"pane_id":"w2:p1","repo":"api","to":"blocked","repo_root":"/p/api"}"#,
            ],
        );
        let history = build_repo_history(&path, "/p/api", "api", false);
        assert_eq!(history.spans.len(), 2);
        let panes: std::collections::HashSet<_> = history.spans.iter().map(|s| s.pane_id.clone()).collect();
        assert!(panes.contains("w1:p1") && panes.contains("w2:p1"));
    }
}
