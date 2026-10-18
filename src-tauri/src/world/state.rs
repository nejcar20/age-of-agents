use crate::herdr::snapshot::AgentStatus;
use crate::world::attention::Attention;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct IslandAgent {
    pub pane_id: String,
    pub workspace_id: String,
    pub status: AgentStatus,
    pub title: Option<String>,
    /// WHICH KIND of agent is running in this pane — `"claude"`, `"codex"`,
    /// whatever herdr named — straight from `herdr::snapshot::Pane::
    /// agent_kind` (herdr's own `PaneInfo.agent`). The author runs more
    /// than one kind at once, and without this a villager gives no clue
    /// which is which; herdr states the fact plainly, so dropping it is
    /// the "silently omits something that is there" half of the honesty
    /// rule.
    ///
    /// `None` means GENUINELY UNKNOWN — herdr sent no kind for this pane
    /// (the key absent, `null`, or blank; see `Pane::agent_kind` for all
    /// three, each observed or schema-permitted) — and is serialized as
    /// JSON `null`, never an absent key, exactly like
    /// `Island::last_changed_at`. It is NEVER a fabricated stand-in: not
    /// `"claude"`, not the configured `default_agent`, not the terminal
    /// title guessed at. `commands::start_agent`'s own
    /// `config.default_agent.unwrap_or("claude")` is deliberately NOT
    /// mirrored here — defaulting what to LAUNCH is a choice that comes
    /// true; defaulting what is ALREADY RUNNING is a claim about the
    /// author's machine with nothing behind it. Every reader must render
    /// `None` as nothing-known rather than filling the gap.
    pub kind: Option<String>,
    pub is_worktree: bool,
    /// This agent's OWN attention, computed by the exact same
    /// `world::attention::attention_of` call that feeds the island roll-up
    /// (`Island.attention`) — never a second, independent derivation.
    ///
    /// Carried through so `jump_target` can pick the pane that is itself
    /// `Stopped` instead of guessing from raw `status` (Task 2, Phase 0's
    /// carried must-fix): an island can be `Stopped` because of a *promoted
    /// idle* agent (`working|blocked -> idle`, sticky — see `StopMemory`),
    /// which is neither `Blocked` nor `Done`, so a guess based on `status`
    /// alone can land on a still-`Working` pane in the same island.
    pub attention: Attention,
    /// This pane's OWN working directory, canonicalized by
    /// `world::repo::normalize_path` — the same normalization every other
    /// path in this app goes through.
    ///
    /// FINAL WHOLE-BRANCH REVIEW, Critical: this is deliberately NOT
    /// `Island.root`. `root` is where the pane RESOLVES TO after
    /// `world::repo` collapses worktrees onto their main repository (Phase
    /// 0's one-island-per-repository rule), which is right for drawing the
    /// world and wrong for deciding what has already been founded: a
    /// workspace founded on `/p/repo-wt` lives on the island rooted at
    /// `/p/repo`. Deriving "already settled" from `root` therefore hid the
    /// main repo (which has no workspace) and kept offering the worktree
    /// (which has one).
    ///
    /// `cwd` is where the workspace was actually founded, so it is the
    /// honest input for that decision — for both the frontend's subtraction
    /// (`founding.ts`'s `subtractSettled`) and the backend's idempotency
    /// guard (`commands::existing_workspace_for`). It also does not drift
    /// when `foreground_cwd` does (see `attention::build_world`).
    ///
    /// Canonicalized in Rust because the webview cannot canonicalize: every
    /// path the frontend compares must already be canonical when it leaves
    /// here.
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Island {
    pub id: String,
    pub name: String,
    pub root: String,
    pub attention: Attention,
    pub agents: Vec<IslandAgent>,
    /// The Unix timestamp (seconds) of `root`'s most recent commit, per
    /// `world::repo::RepoResolver::last_changed` — `None` when that is
    /// genuinely unknown (no commits yet, not a repository, or the git call
    /// failed/timed out), never a fabricated stand-in like "now" or the
    /// epoch. Lets the frontend sort islands by recency (the author's own
    /// request) while still rendering an honest "unknown" for a repo this
    /// can't answer for, rather than silently sorting a guess to either end.
    pub last_changed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorldState {
    pub islands: Vec<Island>,
    pub herdr_connected: bool,
    pub herdr_version: String,
    pub protocol_mismatch: bool,
    /// The pane id herdr reports as currently focused — i.e. the terminal
    /// the author is actually looking at (and, plausibly, typing into) right
    /// now. `None` when herdr isn't connected or reported no focus.
    ///
    /// IMPORTANT 1: `herdr::snapshot::Snapshot::focused_pane_id` was already
    /// parsed off the wire but dropped before it reached `WorldState`, so
    /// nothing downstream could ever tell "the pane the user is looking at"
    /// from any other pane. Carried through here so `commands::idle_pane_for`
    /// can refuse to reuse it — the whole point of the fix (principle 1: the
    /// user keeps full control; the app must never seize a terminal the
    /// author is using).
    pub focused_pane_id: Option<String>,
}

impl WorldState {
    pub fn disconnected() -> Self {
        WorldState {
            islands: Vec::new(),
            herdr_connected: false,
            herdr_version: String::new(),
            protocol_mismatch: false,
            focused_pane_id: None,
        }
    }
}
