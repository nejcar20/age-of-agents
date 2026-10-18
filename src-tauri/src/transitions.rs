//! Local-only JSONL log of agent status transitions.
//!
//! This is Phase 0's evidence deliverable: after a week of real use it must
//! be possible to answer "how often did an agent stop without Herdr
//! reporting `blocked` or `done`?" — the single biggest unknown behind the
//! whole detection design. The file lives at
//! `~/.age-of-agents/transitions.jsonl`, is written to on every observed
//! `WorldState`, and is never read back by the app or uploaded anywhere.
//!
//! Each line contains six fields: `at` (RFC3339 timestamp), `pane_id`,
//! `repo` (the island's short name, not its filesystem path), `repo_root`,
//! `from`, and `to` (status names). Deliberately excluded: `agent.title` (a
//! terminal title, which can contain anything the user was typing). This is
//! a firm privacy boundary, not an oversight — do not add fields here
//! without re-checking it.
//!
//! ## `repo_root` deliberately crosses a boundary this file used to hold
//!
//! When this file was first designed, `root` (a filesystem path — could
//! reveal directory/username layout) was excluded on purpose, alongside
//! `agent.title`, because the log was pure write-only evidence: nothing in
//! the app ever read it back, so there was no reason to widen what it
//! exposed on disk beyond a bare, already-ambiguous display name.
//!
//! That premise changed the day something (`history::build_repo_history`)
//! started reading this file back to answer "what happened in repo X" —
//! and `repo` alone cannot answer that honestly. It is a basename, not an
//! identity: two differently-located repositories that happen to share one
//! (the exact collision `world::repo::normalize_path` exists to rule out
//! everywhere else in this codebase) would be indistinguishable in this log,
//! and an island panel would risk showing another repository's history as
//! its own. `repo_root` carries `island.root` (already canonicalized) so
//! `history` can match a row to a repository with certainty instead of
//! guessing from a name that might collide.
//!
//! This is still local-only and still never uploaded — the new field only
//! ever reaches the app's own `history` reader, not any wider surface — and
//! it is information the app already holds in plaintext elsewhere on disk
//! (every path in `~/.age-of-agents/archipelago.json` and `towns/*.json`,
//! for a start), so this does not newly expose anything the app didn't
//! already write to this machine. It is, however, a real change to this
//! file's privacy posture, made deliberately and noted here rather than
//! slipped in silently, exactly as the file's own rule above asks.
//!
//! Added ADDITIVELY: every field that existed before is untouched, in the
//! same place, meaning the same thing, so the 112 rows already on this
//! machine (and anything else that might ever read this file) keep parsing
//! exactly as before. Rows written before this change simply have no
//! `repo_root` — `history`'s reader treats that as "identity unknown, match
//! by name only, and say so" rather than silently upgrading a name match to
//! a certain one.
//!
//! ## Disconnected worlds and the `last` map
//!
//! `WorldState::disconnected()` has zero islands, so `record` naturally
//! contributes zero lines for it (the per-island loop below has nothing to
//! iterate) and, just as importantly, `last` is never cleared when a
//! disconnected world comes through. That's a deliberate choice, not an
//! oversight:
//!
//! - A dropped connection is a transport-level fact, not evidence that any
//!   agent's status changed. If a herdr reconnect resends the same ~39
//!   pane statuses it had before, they should be silently deduplicated
//!   against what we already knew, not re-logged as fresh transitions from
//!   nothing (`from: null`) just because the map got wiped in between.
//!   Wiping on disconnect would make the file *less* truthful: an ordinary
//!   reconnect blip would look, in the data, exactly like every pane's
//!   agent starting up simultaneously.
//! - The failure mode this accepts: a pane that genuinely closes while
//!   herdr is unreachable leaves a stale entry in `last` that is never
//!   evicted. That's harmless — a stale `pane_id` key that never
//!   reappears is simply inert, and reuse of the same `pane_id` for an
//!   unrelated agent is not something herdr does (pane ids are
//!   workspace/pane-scoped) — versus the alternative of manufacturing
//!   thousands of fake "from nothing" transitions on every reconnect,
//!   which is exactly the kind of noise this log exists to avoid.

use crate::herdr::snapshot::AgentStatus;
use crate::world::state::WorldState;
use serde_json::json;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

pub struct TransitionLog {
    path: PathBuf,
    /// Keyed by `(pane_id, repo_root)`, not `pane_id` alone.
    ///
    /// IMPORTANT 2: a pane's `repo_root` can change between two `record`
    /// calls — the agent (or the user) `cd`s from one repository into
    /// another, and `world::attention::build_world` groups the pane onto its
    /// NEW island on the very next snapshot, with no intervening "left this
    /// repo" event. Keying `last` by `pane_id` alone meant that `cd` carried
    /// the pane's last known status across the repo boundary with it: the
    /// very next real status change wrote `from: Some(<the old repo's last
    /// status>), repo_root: <the NEW repo>` — a row that reads as a genuine
    /// transition that happened in the new repo, when the `from` state in
    /// truth never occurred there at all. `history::build_repo_history`
    /// (keyed only by `repo_root`) then manufactured an exact-ended span —
    /// and, worse, a counted "working session" — for a repository the agent
    /// was never observed working in.
    ///
    /// Keying by the pair makes a pane that changes repositories start fresh
    /// (a first-sight `from: null` row) exactly as if this were a brand new
    /// pane, for that new repo — which is the honest description of what an
    /// observer who only watches per-repo state actually knows.
    last: HashMap<(String, String), AgentStatus>,
    /// Set once an append has failed, so repeated failures (e.g. a
    /// persistently unwritable home directory) don't spam stderr on every
    /// single `on_state` call. Cleared on the next successful append, so a
    /// later distinct failure (disk filled up again after being freed) is
    /// reported again rather than staying silent forever.
    warned: bool,
}

impl TransitionLog {
    pub fn new(path: PathBuf) -> Self {
        TransitionLog { path, last: HashMap::new(), warned: false }
    }

    pub fn record(&mut self, world: &WorldState) {
        let mut lines: Vec<String> = Vec::new();

        for island in &world.islands {
            for agent in &island.agents {
                let key = (agent.pane_id.clone(), island.root.clone());
                let previous = self.last.get(&key).copied();
                if previous == Some(agent.status) { continue; }
                lines.push(json!({
                    "at": chrono::Utc::now().to_rfc3339(),
                    "pane_id": agent.pane_id,
                    "repo": island.name,
                    // Added additively (Phase 0.5b's `history` module):
                    // `island.root` is already canonicalized via
                    // `world::repo::normalize_path`, so this is an exact,
                    // collision-proof identity — unlike `repo` above, which
                    // is only a display name and can collide across
                    // differently-located repositories that share a
                    // basename. Every field above this is unchanged so the
                    // 100+ rows already on disk, and anything else reading
                    // this file, keep working exactly as before.
                    "repo_root": island.root,
                    "from": previous.map(status_name),
                    "to": status_name(agent.status),
                }).to_string());
                self.last.insert(key, agent.status);
            }
        }

        if lines.is_empty() { return; }

        match self.append(&lines) {
            Ok(()) => self.warned = false,
            Err(e) => {
                // Append failures must never crash the app, but must not be
                // silently invisible either — report once, not on every
                // `record` call (this runs on every world-changing herdr
                // delivery, so an unlogged failure would repeat forever).
                if !self.warned {
                    eprintln!(
                        "transitions: failed to write {}: {e} (further failures until the next successful write are not logged)",
                        self.path.display()
                    );
                    self.warned = true;
                }
            }
        }
    }

    fn append(&self, lines: &[String]) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        for line in lines {
            writeln!(file, "{line}")?;
        }
        Ok(())
    }
}

fn status_name(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Idle => "idle",
        AgentStatus::Working => "working",
        AgentStatus::Blocked => "blocked",
        AgentStatus::Done => "done",
        AgentStatus::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::snapshot::AgentStatus;
    use crate::world::attention::Attention;
    use crate::world::state::{Island, IslandAgent, WorldState};

    /// `attention` is irrelevant to the transition log (it records raw
    /// per-pane statuses, never the derived island state), so these fixtures
    /// just pick one rather than reaching for the history-aware mapping in
    /// `world::attention`.
    fn world(status: AgentStatus) -> WorldState {
        world_in_repo(status, "/p/api")
    }

    /// Same fixture as `world` above, but the pane's repo (and therefore
    /// `island.root`/`.id`) is a parameter — Important 2's regression test
    /// needs the SAME pane id observed in two different repos back to back.
    fn world_in_repo(status: AgentStatus, repo_root: &str) -> WorldState {
        WorldState {
            herdr_connected: true, herdr_version: "0.8.0".into(), protocol_mismatch: false,
            focused_pane_id: None,
            islands: vec![Island {
                id: repo_root.into(), name: "api".into(), root: repo_root.into(),
                attention: Attention::Working,
                last_changed_at: None,
                agents: vec![IslandAgent {
                    pane_id: "w1:p1".into(), workspace_id: "w1".into(),
                    status, attention: Attention::Working,
                    title: None, kind: None, is_worktree: false, cwd: repo_root.into(),
                }],
            }],
        }
    }

    #[test]
    fn records_one_line_per_status_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transitions.jsonl");
        let mut log = TransitionLog::new(path.clone());

        log.record(&world(AgentStatus::Working));
        log.record(&world(AgentStatus::Working)); // unchanged — no line
        log.record(&world(AgentStatus::Blocked));

        let contents = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2, "only changes are recorded");
        assert!(lines[0].contains("\"to\":\"working\""));
        assert!(lines[1].contains("\"to\":\"blocked\""));
        assert!(lines[1].contains("\"from\":\"working\""));
    }

    /// IMPORTANT 2, at the transition-log layer: a pane that changes repository
    /// must not carry its old repo's last-known status across the boundary.
    /// The same pane_id (`w2:p1`) is `working` in `/p/AgeOfAgents`, then the
    /// SAME pane's next observation is `idle` in `/p/atlas` — as would happen
    /// if the agent `cd`'d between the two snapshots. Before the fix this
    /// wrote `from:"working"` on the atlas row (the old repo's status,
    /// smuggled across); after the fix it must write `from:null`, because as
    /// far as this log can honestly say, this pane has never been observed
    /// in atlas before this instant.
    #[test]
    fn a_pane_that_changes_repository_starts_fresh_not_inheriting_the_old_repos_status() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transitions.jsonl");
        let mut log = TransitionLog::new(path.clone());

        log.record(&world_in_repo(AgentStatus::Working, "/p/AgeOfAgents"));
        log.record(&world_in_repo(AgentStatus::Idle, "/p/atlas"));

        let contents = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"repo_root\":\"/p/AgeOfAgents\""));
        assert!(lines[0].contains("\"from\":null"));
        assert!(lines[1].contains("\"repo_root\":\"/p/atlas\""));
        assert!(
            lines[1].contains("\"from\":null"),
            "a pane's first-ever observation in a NEW repo must not inherit \
             the OLD repo's last status as an exact `from`, got: {}",
            lines[1]
        );
    }

    #[test]
    fn repeated_disconnected_worlds_append_nothing_and_do_not_forget_last_known_status() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transitions.jsonl");
        let mut log = TransitionLog::new(path.clone());

        log.record(&world(AgentStatus::Working));
        log.record(&WorldState::disconnected());
        log.record(&WorldState::disconnected());
        log.record(&WorldState::disconnected());

        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(contents.lines().count(), 1, "disconnected worlds add no lines");

        // Reconnect resending the same status must not look like a fresh
        // transition from nothing: `last` must have survived the
        // disconnected worlds untouched.
        log.record(&world(AgentStatus::Working));
        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            contents.lines().count(),
            1,
            "a reconnect resending an unchanged status is still a no-op"
        );
    }

    #[test]
    fn a_write_failure_does_not_panic_and_a_later_success_still_records() {
        let dir = tempfile::tempdir().unwrap();
        // Point the log at a path whose parent cannot be created (a file,
        // not a directory, sits where a directory is expected).
        let blocker = dir.path().join("not_a_dir");
        std::fs::write(&blocker, b"x").unwrap();
        let bad_path = blocker.join("transitions.jsonl");
        let mut log = TransitionLog::new(bad_path);

        // Must not panic despite the append being impossible.
        log.record(&world(AgentStatus::Working));

        // Recovery: repointing at a writable path still works, proving a
        // failed append never poisons in-memory state.
        let good_path = dir.path().join("transitions.jsonl");
        log.path = good_path.clone();
        log.record(&world(AgentStatus::Blocked));
        let contents = std::fs::read_to_string(&good_path).unwrap();
        assert_eq!(contents.lines().count(), 1);
        assert!(contents.contains("\"to\":\"blocked\""));
    }
}
