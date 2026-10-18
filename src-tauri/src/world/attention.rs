use crate::herdr::snapshot::{AgentStatus, Pane, Snapshot};
use crate::world::repo::{normalize_path, RepoResolver};
use crate::world::state::{Island, IslandAgent, WorldState};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Attention {
    // Ord matters: an island takes the `max()` of its agents, so these are
    // ordered least to most urgent and Stopped sorts last.
    //
    // `Unknown` sits just above `Quiet` (FINAL REVIEW, important 2): a state
    // herdr cannot report is NOT the same as an idle agent with nothing to
    // do, and principle 4 forbids drawing a guess as a fact. It stays below
    // `Working` so a repo where something is demonstrably happening still
    // reads as working, and far below `Stopped` so it never competes with
    // the one marker that means "you are needed".
    Quiet,
    Unknown,
    Working,
    Stopped,
}

/// One pane's stop history, as far as we have observed it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct PaneStop {
    /// This pane has been seen `working` (or `blocked`) since the last time
    /// it went idle. This is what makes the NEXT `idle`/`done` a *stop*
    /// rather than an agent that was simply never started.
    seen_work: bool,
    /// Sticky: the pane stopped after work and has not gone back to work.
    stopped: bool,
}

/// Per-pane memory of which panes have *stopped*, as opposed to merely being
/// idle.
///
/// FINAL REVIEW, critical 1 — why this type exists at all. Spec §5.4 says
/// `blocked`, `done` and **idle-after-work** all collapse into one "stopped —
/// look at it" state. Mapping `Idle -> Quiet` (the pre-fix behavior)
/// implemented only two thirds of that, and the missing third is the common
/// case: live herdr's `pane report-agent --state` accepts only
/// `idle|working|blocked|unknown`, nothing observed ever emits `done`, and
/// `blocked` comes from screen-pattern matching the spec itself calls
/// unreliable. So an agent that simply FINISHES lands in `idle` — and before
/// this fix it rendered as a calm `·`, never notified, and was never a jump
/// target. The headline feature fired essentially only on `blocked`.
///
/// The promotion is deliberately HISTORY-AWARE rather than "idle is always
/// stopped":
///
/// - `working`/`blocked` -> `idle`/`done` promotes the pane to **Stopped**.
/// - On FIRST sight of a pane (nothing recorded yet) `idle` stays **Quiet**.
///   Otherwise every pane the user has already dealt with — and every
///   already-idle pane at launch — would nag forever, which is also why
///   Task 12 seeds already-stopped islands silently at startup.
/// - Once promoted, a pane STAYS Stopped for as long as it remains
///   idle/done. This is the subtle part: comparing only against the
///   immediately-previous status breaks on the very next re-snapshot (prior
///   is now `idle` too, so the transition "disappears" and the ❗ flickers
///   off). Hence `stopped` is a sticky flag, cleared only when the pane goes
///   back to `working` or disappears entirely.
/// - `blocked` and `done` remain Stopped unconditionally, with no history
///   needed.
///
/// `unknown` deliberately preserves whatever we already knew rather than
/// resetting it: "herdr cannot tell us" is not evidence that an agent
/// resumed work, so a `working -> unknown -> idle` sequence still promotes.
///
/// This mirrors the prior-status map `TransitionLog` keeps (`transitions.rs`)
/// — same idea, deliberately its own instance, so the evidence log and the
/// world-building path stay independent of each other.
///
/// SEEN. Herdr's sidebar splits "stopped" in two: a filled dot for finished
/// work nobody has looked at yet, a hollow ring once it has been seen. Its
/// API reports both as plain `idle`, so the split is tracked here: a stop is
/// cleared back to Quiet by `mark_seen` (the user opened it in this app) or
/// by herdr's focus MOVING onto the stopped pane. Merely being focused when
/// it stops does not count — herdr keeps a focused pane while the user is in
/// another app entirely. `blocked` and `done` stay Stopped regardless: they
/// never pass through the sticky flag this clears.
#[derive(Debug, Default)]
pub struct StopMemory {
    panes: HashMap<String, PaneStop>,
    /// Herdr's focused pane as of the previous snapshot, to tell a focus
    /// change from a focus that was already there.
    focused: Option<String>,
}

impl StopMemory {
    /// Folds one snapshot's panes into the memory. Panes absent from
    /// `panes` are forgotten, so a pane that closes and later reappears is
    /// treated as first-sight again.
    ///
    /// Only ever called with a real snapshot. A `WorldState::disconnected()`
    /// never reaches `build_world`, so a dropped herdr connection cannot be
    /// mistaken for "every pane went away" — the same reasoning
    /// `TransitionLog` and `stops_to_notify` already apply.
    fn observe(&mut self, panes: &[Pane], focused: Option<&str>) {
        let newly_focused = focused.filter(|id| self.focused.as_deref() != Some(*id));
        let mut next: HashMap<String, PaneStop> = HashMap::with_capacity(panes.len());
        for pane in panes {
            let prior = self.panes.get(&pane.pane_id).copied();
            let mut stop = advance(prior, pane.agent_status);
            if newly_focused == Some(pane.pane_id.as_str()) {
                stop.stopped = false;
            }
            next.insert(pane.pane_id.clone(), stop);
        }
        self.panes = next;
        self.focused = focused.map(str::to_owned);
    }

    /// The user has looked at this pane: a sticky stop goes back to Quiet
    /// until the pane works and stops again. Unknown panes are ignored.
    pub fn mark_seen(&mut self, pane_id: &str) {
        if let Some(stop) = self.panes.get_mut(pane_id) {
            *stop = PaneStop::default();
        }
    }

    fn has_stopped(&self, pane_id: &str) -> bool {
        self.panes.get(pane_id).is_some_and(|p| p.stopped)
    }
}

/// The state a pane is in after being observed at `status`, given what we
/// knew about it before (`None` = first sight).
fn advance(prior: Option<PaneStop>, status: AgentStatus) -> PaneStop {
    let prior = prior.unwrap_or_default();
    match status {
        // Working (or blocked, which is work that has paused for the user)
        // clears any sticky stop and arms the next one.
        AgentStatus::Working | AgentStatus::Blocked => {
            PaneStop { seen_work: true, stopped: false }
        }
        // Stop territory. Promoted only if work was seen first; once
        // promoted, stays promoted across identical re-snapshots.
        AgentStatus::Idle | AgentStatus::Done => {
            PaneStop { seen_work: false, stopped: prior.stopped || prior.seen_work }
        }
        // No information: keep what we had.
        AgentStatus::Unknown => prior,
    }
}

/// How urgently one pane wants the user, given its reported status and
/// whether `StopMemory` has promoted it. `has_stopped` is an explicit
/// parameter (rather than this being a `From<AgentStatus>` impl) precisely
/// so the history cannot be forgotten at a call site — that omission is what
/// critical 1 was.
pub(crate) fn attention_of(status: AgentStatus, has_stopped: bool) -> Attention {
    match status {
        AgentStatus::Blocked | AgentStatus::Done => Attention::Stopped,
        AgentStatus::Working => Attention::Working,
        AgentStatus::Idle => {
            if has_stopped {
                Attention::Stopped
            } else {
                Attention::Quiet
            }
        }
        AgentStatus::Unknown => Attention::Unknown,
    }
}

/// Builds the world from one snapshot.
///
/// Pure in the sense that matters for testing: its whole output is a
/// function of (`snapshot`, `resolver`, `stops`). `stops` carries the
/// cross-snapshot history the Stopped promotion needs and is threaded
/// through explicitly — it is deliberately NOT a global or a hidden
/// `thread_local`, so a test can drive a sequence of snapshots through a
/// memory it owns.
pub fn build_world(
    snapshot: &Snapshot,
    resolver: &mut RepoResolver,
    stops: &mut StopMemory,
) -> WorldState {
    stops.observe(&snapshot.panes, snapshot.focused_pane_id.as_deref());

    let mut grouped: BTreeMap<String, Island> = BTreeMap::new();

    for pane in &snapshot.panes {
        // GROUPING cwd — deliberately unchanged: `foreground_cwd` is where
        // work is visibly happening, and that is what decides which island a
        // pane is drawn on.
        let cwd = pane.foreground_cwd.as_ref().or(pane.cwd.as_ref());
        let Some(cwd) = cwd else { continue };
        let Some(repo) = resolver.resolve(Path::new(cwd)) else { continue };

        // SETTLED cwd — the pane's OWN cwd, which is where its workspace was
        // founded (`herdr::launch::create_workspace` passes it as `--cwd`).
        // The preference is the exact inverse of the grouping one above, and
        // that is the point: `foreground_cwd` drifts with every `cd` and
        // every pager, and a settled decision that drifts with it lets an
        // already-founded repo be founded a second time. Falls back to the
        // grouping cwd only when herdr reported no `cwd` at all, so this
        // field is never empty for a pane that made it this far.
        let own_cwd = pane.cwd.as_deref().unwrap_or(cwd.as_str());
        let own_cwd = normalize_path(Path::new(own_cwd)).to_string_lossy().to_string();

        let root = repo.root.to_string_lossy().to_string();
        let island = grouped.entry(root.clone()).or_insert_with(|| {
            let last_changed_at = resolver.last_changed(&repo.root);
            Island {
                id: root.clone(),
                name: repo.name.clone(),
                root,
                attention: Attention::Quiet,
                agents: Vec::new(),
                last_changed_at,
            }
        });

        // Computed once and carried onto the agent AND the island roll-up —
        // one source of truth (Task 2), rather than the roll-up computing it
        // and `IslandAgent` re-deriving it (or not having it at all).
        let attn = attention_of(pane.agent_status, stops.has_stopped(&pane.pane_id));
        island.attention = island.attention.max(attn);
        island.agents.push(IslandAgent {
            pane_id: pane.pane_id.clone(),
            workspace_id: pane.workspace_id.clone(),
            status: pane.agent_status,
            title: pane.terminal_title.clone(),
            // Carried, not re-derived and not defaulted: `agent_kind`
            // already collapses herdr's three "no agent" shapes to `None`,
            // and `None` must survive all the way to the panel as
            // "unknown" — see `IslandAgent::kind`.
            kind: pane.agent_kind(),
            is_worktree: repo.is_worktree,
            cwd: own_cwd,
            attention: attn,
        });
    }

    WorldState {
        islands: grouped.into_values().collect(),
        herdr_connected: true,
        herdr_version: snapshot.version.clone(),
        protocol_mismatch: snapshot.protocol != 19,
        // IMPORTANT 1: carried through from the wire rather than dropped, so
        // `commands::idle_pane_for` can see which pane the user is actually
        // looking at and refuse to reuse it. Not normalized/resolved to a
        // repo here — it stays exactly the pane id herdr reported, which is
        // all `idle_pane_for`'s equality check needs.
        focused_pane_id: snapshot.focused_pane_id.clone(),
    }
}

pub fn next_target<'a>(world: &'a WorldState, current: Option<&str>) -> Option<&'a Island> {
    let stopped: Vec<&Island> = world
        .islands
        .iter()
        .filter(|i| i.attention == Attention::Stopped)
        .collect();
    if stopped.is_empty() { return None; }

    let start = current
        .and_then(|id| stopped.iter().position(|i| i.id == id))
        .map(|pos| (pos + 1) % stopped.len())
        .unwrap_or(0);
    Some(stopped[start])
}

/// Decides which islands should trigger a native "stopped" notification for
/// one freshly observed `WorldState`, given the set of island ids already
/// notified as stopped. Returns `(ids to notify now, updated already-notified
/// set)` — the caller stores the updated set (in `AppState`, behind a
/// `Mutex`) and passes it back in on the next call.
///
/// Pure and GUI-free by design so the notify-once-per-transition logic can
/// be unit tested without a Tauri handle or a real notification.
///
/// `already_notified: None` means no *connected* snapshot has been observed
/// yet in this run of the app. That first connected snapshot is handled
/// specially (see Task 12 Amendment 4): its already-stopped islands are
/// folded into the notified set silently, with no notification fired. A
/// user launching the app to find three agents that have been sitting
/// blocked for hours does not need three notifications telling them so —
/// the window itself shows that instantly. Only islands that transition
/// into `Stopped` *after* that first snapshot are new information worth a
/// notification; that's also the case genuinely at risk of being missed
/// without one (a window in the background, not the file already visible
/// on screen).
///
/// A disconnected world (`herdr_connected == false`, therefore always zero
/// islands) is passed straight through with the already-notified set
/// unchanged. This mirrors `TransitionLog`'s handling of the same case: a
/// dropped connection is a transport fact, not evidence that every
/// previously stopped island has resumed. Without this, a herdr reconnect
/// would race a `WorldState::disconnected()` value onto the channel, wipe
/// the notified set to empty, and then the very next (connected) snapshot —
/// which just resends the same still-stopped islands — would look like a
/// fresh batch of transitions and re-fire every notification.
///
/// An island that recovers (leaves `Stopped`) is dropped from the updated
/// set on that snapshot, so if it stops again afterward it is treated as a
/// new transition and notifies again — this is a genuinely new event, not a
/// resend.
pub fn stops_to_notify(
    already_notified: &Option<HashSet<String>>,
    world: &WorldState,
) -> (Vec<String>, Option<HashSet<String>>) {
    if !world.herdr_connected {
        return (Vec::new(), already_notified.clone());
    }

    let currently_stopped: HashSet<String> = world
        .islands
        .iter()
        .filter(|i| i.attention == Attention::Stopped)
        .map(|i| i.id.clone())
        .collect();

    match already_notified {
        None => (Vec::new(), Some(currently_stopped)),
        Some(previously_notified) => {
            let to_notify: Vec<String> =
                currently_stopped.difference(previously_notified).cloned().collect();
            (to_notify, Some(currently_stopped))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::snapshot::{AgentStatus, Pane, Snapshot};
    use crate::world::repo::{GitProbe, RepoResolver};
    use std::path::{Path, PathBuf};

    struct EveryDirIsARepo;
    impl GitProbe for EveryDirIsARepo {
        fn toplevel(&self, cwd: &Path) -> Option<PathBuf> {
            if cwd.starts_with("/p") { Some(cwd.to_path_buf()) } else { None }
        }
        fn common_dir(&self, cwd: &Path) -> Option<PathBuf> {
            self.toplevel(cwd).map(|p| p.join(".git"))
        }
    }

    fn pane(id: &str, ws: &str, cwd: &str, status: AgentStatus) -> Pane {
        Pane {
            pane_id: id.into(), workspace_id: ws.into(),
            cwd: Some(cwd.into()), foreground_cwd: None,
            agent_status: status, terminal_title: None, agent: None,
        }
    }

    /// `pane`, but with herdr also naming the kind of agent running there —
    /// the `{"agent":"claude", …}` shape the live session sends.
    fn pane_running(id: &str, ws: &str, cwd: &str, status: AgentStatus, kind: &str) -> Pane {
        Pane { agent: Some(kind.into()), ..pane(id, ws, cwd, status) }
    }

    fn snapshot(panes: Vec<Pane>) -> Snapshot {
        Snapshot { version: "0.8.0".into(), protocol: 19, panes,
                   workspaces: vec![], focused_pane_id: None }
    }

    fn resolver() -> RepoResolver { RepoResolver::new(Box::new(EveryDirIsARepo)) }

    /// Builds one world with a throwaway memory — for the cases where no
    /// history is involved. Sequences that depend on history own their
    /// `StopMemory` and call `build_world` directly.
    fn build_once(snapshot: &Snapshot) -> WorldState {
        build_world(snapshot, &mut resolver(), &mut StopMemory::default())
    }

    #[test]
    fn blocked_and_done_both_mean_stopped() {
        assert_eq!(attention_of(AgentStatus::Blocked, false), Attention::Stopped);
        assert_eq!(attention_of(AgentStatus::Done, false), Attention::Stopped);
        assert_eq!(attention_of(AgentStatus::Working, false), Attention::Working);
        assert_eq!(attention_of(AgentStatus::Idle, false), Attention::Quiet);
        assert_eq!(
            attention_of(AgentStatus::Idle, true),
            Attention::Stopped,
            "spec §5.4: idle-after-work collapses into stopped"
        );
    }

    #[test]
    fn unknown_is_its_own_state_not_quiet() {
        // FINAL REVIEW, important 2: a state herdr cannot report must not be
        // drawn as the calm "nothing to do" (principle 4: honesty). It is
        // also not allowed to shout over a real stop.
        assert_eq!(attention_of(AgentStatus::Unknown, false), Attention::Unknown);
        assert_ne!(Attention::Unknown, Attention::Quiet);
        assert!(Attention::Unknown > Attention::Quiet);
        assert!(Attention::Unknown < Attention::Working);
        assert!(Attention::Unknown < Attention::Stopped);
    }

    // ---- The pane's agent KIND, carried rather than dropped ----

    /// The whole point of the field: two panes, two different kinds, both
    /// reported as what they actually are. Before this, `build_world` read
    /// `agent_status` off the pane and threw `agent` away, so a villager
    /// running `codex` was indistinguishable from one running `claude`.
    #[test]
    fn each_agents_own_kind_reaches_the_island_agent() {
        let world = build_once(&snapshot(vec![
            pane_running("w1:p1", "w1", "/p/api", AgentStatus::Working, "claude"),
            pane_running("w1:p2", "w1", "/p/api", AgentStatus::Blocked, "codex"),
        ]));
        let agents = &world.islands[0].agents;
        assert_eq!(agents[0].kind.as_deref(), Some("claude"));
        assert_eq!(agents[1].kind.as_deref(), Some("codex"));
    }

    /// A plain shell pane (herdr omits `agent` entirely — the live `w2:p1`
    /// shape) must arrive as `None`, and MUST NOT be back-filled with the
    /// configured default kind the way `start_agent` fills in what to
    /// LAUNCH. See `IslandAgent::kind` for why those two are different
    /// questions.
    #[test]
    fn a_pane_herdr_names_no_agent_for_stays_unknown_never_defaulted() {
        let world = build_once(&snapshot(vec![pane(
            "w2:p1", "w2", "/p/api", AgentStatus::Unknown,
        )]));
        assert_eq!(world.islands[0].agents[0].kind, None);
    }

    /// `Option<String>` must reach the webview as an explicit JSON `null`,
    /// never a missing key — the same wire discipline
    /// `Island::last_changed_at` documents, and what `world.ts`'s
    /// `kind: string | null` is typed against.
    #[test]
    fn an_unknown_kind_serializes_to_null_not_an_absent_key() {
        let world = build_once(&snapshot(vec![pane(
            "w2:p1", "w2", "/p/api", AgentStatus::Unknown,
        )]));
        let json = serde_json::to_value(&world.islands[0].agents[0]).unwrap();
        assert_eq!(json.get("kind"), Some(&serde_json::Value::Null));
    }

    // ---- Critical 1: the history-aware Stopped promotion ----

    #[test]
    fn a_pane_that_goes_working_then_idle_is_stopped() {
        // THE DEFECT. Nothing live ever reports `done`, and `blocked` is
        // screen-pattern guesswork, so an agent that FINISHES lands in
        // `idle`. Pre-fix that rendered as a calm `·` forever.
        let mut resolver = resolver();
        let mut stops = StopMemory::default();

        let working = snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Working)]);
        let idle = snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Idle)]);

        assert_eq!(
            build_world(&working, &mut resolver, &mut stops).islands[0].attention,
            Attention::Working
        );
        assert_eq!(
            build_world(&idle, &mut resolver, &mut stops).islands[0].attention,
            Attention::Stopped,
            "an agent that finished its work needs the user"
        );
    }

    #[test]
    fn an_idle_pane_seen_for_the_first_time_stays_quiet() {
        // "idle is always stopped" would nag forever about every agent the
        // user already dealt with, and would fire a burst of stale
        // notifications at launch. First sight is not evidence of a stop.
        let mut stops = StopMemory::default();
        let world = build_world(
            &snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Idle)]),
            &mut resolver(),
            &mut stops,
        );
        assert_eq!(world.islands[0].attention, Attention::Quiet);
    }

    #[test]
    fn a_promoted_pane_stays_stopped_across_identical_snapshots() {
        // The naive "compare against the immediately-previous status"
        // implementation passes the promotion test above and then breaks
        // here: on the next snapshot the prior status is `idle` too, so the
        // transition "disappears" and the ❗ flickers off. herdr re-snapshots
        // on every world-changing event (~39 in a reconnect burst), so this
        // is the normal case, not an edge case.
        let mut resolver = resolver();
        let mut stops = StopMemory::default();
        let working = snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Working)]);
        let idle = snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Idle)]);

        build_world(&working, &mut resolver, &mut stops);
        for round in 0..5 {
            assert_eq!(
                build_world(&idle, &mut resolver, &mut stops).islands[0].attention,
                Attention::Stopped,
                "still stopped on re-snapshot {round}"
            );
        }
    }

    fn focused(mut snapshot: Snapshot, pane_id: &str) -> Snapshot {
        snapshot.focused_pane_id = Some(pane_id.into());
        snapshot
    }

    #[test]
    fn a_stopped_pane_marked_seen_goes_quiet_until_it_works_again() {
        // Herdr's own sidebar: a filled green dot is "done, not looked at",
        // a hollow ring is "done and seen". Opening the agent in this app is
        // looking at it.
        let mut resolver = resolver();
        let mut stops = StopMemory::default();
        let working = snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Working)]);
        let idle = snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Idle)]);

        build_world(&working, &mut resolver, &mut stops);
        build_world(&idle, &mut resolver, &mut stops);
        stops.mark_seen("w1:p1");
        assert_eq!(build_world(&idle, &mut resolver, &mut stops).islands[0].attention, Attention::Quiet);
        assert_eq!(
            build_world(&idle, &mut resolver, &mut stops).islands[0].attention,
            Attention::Quiet,
            "seen stays seen across re-snapshots"
        );

        build_world(&working, &mut resolver, &mut stops);
        assert_eq!(
            build_world(&idle, &mut resolver, &mut stops).islands[0].attention,
            Attention::Stopped,
            "the next stop is new again"
        );
    }

    #[test]
    fn focusing_a_stopped_pane_in_herdr_marks_it_seen() {
        let mut resolver = resolver();
        let mut stops = StopMemory::default();
        let panes = |a, b| vec![pane("w1:p1", "w1", "/p/api", a), pane("w2:p1", "w2", "/p/web", b)];
        build_world(&focused(snapshot(panes(AgentStatus::Working, AgentStatus::Idle)), "w2:p1"), &mut resolver, &mut stops);
        let world = build_world(&focused(snapshot(panes(AgentStatus::Idle, AgentStatus::Idle)), "w2:p1"), &mut resolver, &mut stops);
        assert_eq!(world.islands[0].attention, Attention::Stopped);

        let world = build_world(&focused(snapshot(panes(AgentStatus::Idle, AgentStatus::Idle)), "w1:p1"), &mut resolver, &mut stops);
        assert_eq!(world.islands[0].attention, Attention::Quiet);
    }

    #[test]
    fn a_pane_that_stops_while_already_focused_still_needs_the_user() {
        // Herdr keeps a focused pane even while the user is in another app,
        // so "focused at the moment it stopped" is not evidence of looking.
        // Only a focus CHANGE onto the stopped pane is.
        let mut resolver = resolver();
        let mut stops = StopMemory::default();
        let working = focused(snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Working)]), "w1:p1");
        let idle = focused(snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Idle)]), "w1:p1");
        build_world(&working, &mut resolver, &mut stops);
        assert_eq!(build_world(&idle, &mut resolver, &mut stops).islands[0].attention, Attention::Stopped);
        assert_eq!(build_world(&idle, &mut resolver, &mut stops).islands[0].attention, Attention::Stopped);
    }

    #[test]
    fn seeing_a_blocked_pane_does_not_hide_it() {
        // Blocked is waiting on an answer, not finished work: looking at it
        // is not answering it.
        let mut resolver = resolver();
        let mut stops = StopMemory::default();
        let blocked = snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Blocked)]);
        build_world(&blocked, &mut resolver, &mut stops);
        stops.mark_seen("w1:p1");
        assert_eq!(build_world(&blocked, &mut resolver, &mut stops).islands[0].attention, Attention::Stopped);
    }

    #[test]
    fn going_back_to_work_clears_the_stop() {
        let mut resolver = resolver();
        let mut stops = StopMemory::default();
        let working = snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Working)]);
        let idle = snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Idle)]);

        build_world(&working, &mut resolver, &mut stops);
        build_world(&idle, &mut resolver, &mut stops);
        assert_eq!(
            build_world(&working, &mut resolver, &mut stops).islands[0].attention,
            Attention::Working
        );
        // ...and the very next idle is a NEW stop, not a leftover one.
        assert_eq!(
            build_world(&idle, &mut resolver, &mut stops).islands[0].attention,
            Attention::Stopped
        );
    }

    #[test]
    fn blocked_then_idle_also_promotes() {
        // herdr's `blocked` is a screen pattern: it drops away as soon as the
        // prompt scrolls or the agent redraws, leaving `idle` behind. That
        // must not silently un-need the user.
        let mut resolver = resolver();
        let mut stops = StopMemory::default();
        let blocked = snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Blocked)]);
        let idle = snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Idle)]);

        build_world(&blocked, &mut resolver, &mut stops);
        assert_eq!(
            build_world(&idle, &mut resolver, &mut stops).islands[0].attention,
            Attention::Stopped
        );
    }

    #[test]
    fn a_pane_that_disappears_is_forgotten_and_comes_back_quiet() {
        // A closed pane's stop is not owed to a different agent that later
        // reuses the slot: first sight of `idle` is first sight again.
        let mut resolver = resolver();
        let mut stops = StopMemory::default();
        build_world(
            &snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Working)]),
            &mut resolver,
            &mut stops,
        );
        build_world(&snapshot(vec![]), &mut resolver, &mut stops);
        let world = build_world(
            &snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Idle)]),
            &mut resolver,
            &mut stops,
        );
        assert_eq!(world.islands[0].attention, Attention::Quiet);
    }

    #[test]
    fn unknown_in_between_does_not_lose_a_pending_stop() {
        // "herdr cannot tell us" is not evidence the agent resumed working.
        let mut resolver = resolver();
        let mut stops = StopMemory::default();
        build_world(
            &snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Working)]),
            &mut resolver,
            &mut stops,
        );
        let unknown = build_world(
            &snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Unknown)]),
            &mut resolver,
            &mut stops,
        );
        assert_eq!(unknown.islands[0].attention, Attention::Unknown);
        let idle = build_world(
            &snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Idle)]),
            &mut resolver,
            &mut stops,
        );
        assert_eq!(idle.islands[0].attention, Attention::Stopped);
    }

    #[test]
    fn a_promoted_idle_island_notifies_like_any_other_stop() {
        // End-to-end with Task 12's notify-once logic: the whole point of
        // the promotion is that a finished agent actually reaches the user.
        let mut resolver = resolver();
        let mut stops = StopMemory::default();
        let working = build_world(
            &snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Working)]),
            &mut resolver,
            &mut stops,
        );
        let (_, seeded) = stops_to_notify(&None, &working);

        let idle = build_world(
            &snapshot(vec![pane("w1:p1", "w1", "/p/api", AgentStatus::Idle)]),
            &mut resolver,
            &mut stops,
        );
        let (to_notify, _) = stops_to_notify(&seeded, &idle);
        assert_eq!(to_notify, vec!["/p/api".to_string()]);
    }

    #[test]
    fn panes_in_one_repo_become_one_island() {
        let world = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/p/api", AgentStatus::Working),
            pane("w2:p1", "w2", "/p/api", AgentStatus::Idle),
        ]));
        assert_eq!(world.islands.len(), 1);
        assert_eq!(world.islands[0].agents.len(), 2);
        assert_eq!(world.islands[0].name, "api");
    }

    #[test]
    fn island_attention_takes_the_most_urgent_agent() {
        let world = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/p/api", AgentStatus::Working),
            pane("w1:p2", "w1", "/p/api", AgentStatus::Blocked),
        ]));
        assert_eq!(world.islands[0].attention, Attention::Stopped);
    }

    #[test]
    fn panes_outside_a_repo_are_ignored() {
        let world = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/home/u", AgentStatus::Working),
        ]));
        assert!(world.islands.is_empty());
    }

    #[test]
    fn next_target_cycles_through_stopped_islands_only() {
        let world = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/p/aaa", AgentStatus::Blocked),
            pane("w2:p1", "w2", "/p/bbb", AgentStatus::Working),
            pane("w3:p1", "w3", "/p/ccc", AgentStatus::Done),
        ]));

        assert_eq!(next_target(&world, None).unwrap().name, "aaa");
        assert_eq!(next_target(&world, Some("/p/aaa")).unwrap().name, "ccc");
        assert_eq!(next_target(&world, Some("/p/ccc")).unwrap().name, "aaa", "wraps around");
    }

    #[test]
    fn next_target_is_none_when_nothing_is_stopped() {
        let world = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/p/api", AgentStatus::Working),
        ]));
        assert!(next_target(&world, None).is_none());
    }

    #[test]
    fn next_target_advances_when_current_is_no_longer_stopped() {
        let world = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/p/aaa", AgentStatus::Blocked),
            pane("w2:p1", "w2", "/p/bbb", AgentStatus::Working),
            pane("w3:p1", "w3", "/p/ccc", AgentStatus::Done),
        ]));

        // "/p/bbb" is Working, not in the Stopped set anymore (e.g. the agent
        // we last jumped to went back to work). It must not be treated as a
        // valid cycle position: `position(...)` finds nothing, so we restart
        // at index 0 instead of sticking.
        assert_eq!(next_target(&world, Some("/p/bbb")).unwrap().name, "aaa");
    }

    #[test]
    fn next_target_advances_when_current_no_longer_exists() {
        let world = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/p/aaa", AgentStatus::Blocked),
            pane("w2:p1", "w2", "/p/bbb", AgentStatus::Working),
            pane("w3:p1", "w3", "/p/ccc", AgentStatus::Done),
        ]));

        // "/p/deleted" names no island at all (e.g. the pane closed). Must
        // fall back to the first Stopped island in stable order, not None.
        assert_eq!(next_target(&world, Some("/p/deleted")).unwrap().name, "aaa");
    }

    #[test]
    fn first_connected_snapshot_seeds_silently_without_notifying() {
        let world = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/p/aaa", AgentStatus::Blocked),
        ]));

        let (to_notify, updated) = stops_to_notify(&None, &world);
        assert!(to_notify.is_empty(), "already-stopped islands at launch must not notify");
        assert_eq!(updated, Some(HashSet::from(["/p/aaa".to_string()])));
    }

    #[test]
    fn a_new_stop_after_seeding_notifies_once() {
        let seeded = Some(HashSet::new());
        let world = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/p/aaa", AgentStatus::Blocked),
        ]));

        let (to_notify, updated) = stops_to_notify(&seeded, &world);
        assert_eq!(to_notify, vec!["/p/aaa".to_string()]);
        assert_eq!(updated, Some(HashSet::from(["/p/aaa".to_string()])));
    }

    #[test]
    fn a_resnapshot_of_an_already_notified_stop_does_not_renotify() {
        let already = Some(HashSet::from(["/p/aaa".to_string()]));
        let world = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/p/aaa", AgentStatus::Blocked),
        ]));

        let (to_notify, updated) = stops_to_notify(&already, &world);
        assert!(to_notify.is_empty(), "a herdr reconnect replaying the same stop must be silent");
        assert_eq!(updated, Some(HashSet::from(["/p/aaa".to_string()])));
    }

    #[test]
    fn a_disconnected_world_leaves_the_notified_set_untouched() {
        let already = Some(HashSet::from(["/p/aaa".to_string()]));
        let (to_notify, updated) = stops_to_notify(&already, &WorldState::disconnected());

        assert!(to_notify.is_empty());
        assert_eq!(
            updated, already,
            "a dropped connection must not be mistaken for every stop resolving"
        );
    }

    #[test]
    fn an_island_that_recovers_then_stops_again_notifies_again() {
        let already = Some(HashSet::from(["/p/aaa".to_string()]));

        // "/p/aaa" is now Working: it drops out of the notified set.
        let recovered = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/p/aaa", AgentStatus::Working),
        ]));
        let (to_notify, updated) = stops_to_notify(&already, &recovered);
        assert!(to_notify.is_empty());
        assert_eq!(updated, Some(HashSet::new()));

        // It stops again: this is a fresh transition, not a resend.
        let stopped_again = build_once(&snapshot(vec![
            pane("w1:p1", "w1", "/p/aaa", AgentStatus::Blocked),
        ]));
        let (to_notify, _) = stops_to_notify(&updated, &stopped_again);
        assert_eq!(to_notify, vec!["/p/aaa".to_string()]);
    }
}
