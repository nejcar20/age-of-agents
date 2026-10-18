use crate::city::archipelago::{build_archipelago, Archipelago};
use crate::city::layout::{layout_city_persisted_from_root, CityLayout};
use crate::city::model::{CityModel, RealFiles, RealGitFiles};
use crate::herdr::snapshot::AgentStatus;
use crate::transitions::TransitionLog;
use crate::world::attention::{next_target, Attention};
use crate::world::repo::normalize_path;
use crate::world::state::{Island, IslandAgent, WorldState};
use crate::world::unsettled::{discovery_plan, scan_roots, scanned_repos, UnsettledRepo};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct AppState {
    pub world: Mutex<WorldState>,
    pub last_jump: Mutex<Option<String>>,
    /// The evidence log (see `transitions.rs`). Guarded by its own `Mutex` so
    /// `on_world_state`'s closure — which must stay `Fn`, not `FnMut`, per
    /// `run_connection_loop`'s signature — can record into it through
    /// interior mutability. The lock is taken only for the `record()` call
    /// itself and dropped immediately after (see `on_world_state` in
    /// `lib.rs`), never held across `handle.emit(..)` or any `.await`.
    pub transitions: Mutex<TransitionLog>,
    /// Ids of islands already notified as stopped, per
    /// `world::attention::stops_to_notify` — `None` until the first
    /// *connected* `WorldState` has been observed (see that function's doc
    /// comment and Task 12 Amendment 4 for why the first snapshot is
    /// seeded silently rather than notified). Same locking discipline as
    /// `transitions`: the guard is held only long enough to read/replace
    /// this value, never across `handle.emit(..)`, a notification call, or
    /// any `.await`.
    pub notified_stopped: Mutex<Option<HashSet<String>>>,
    /// The user's config, read from disk EXACTLY ONCE, at startup.
    ///
    /// FINAL REVIEW minor: it used to be `Config::load`ed on every notifying
    /// world state and on every jump. A herdr reconnect replays ~39 events,
    /// each of which can produce a world, so a single reconnect burst could
    /// mean dozens of reads of the same tiny file. It is also not
    /// `Mutex`-wrapped: nothing mutates it, so a plain shared value is
    /// enough. The cost of caching it is that editing `config.json` needs an
    /// app restart to take effect, which is the right trade for a file the
    /// app never writes and the user rarely touches.
    pub config: crate::config::Config,
    /// Last `(herdr_connected, island count)` actually printed by
    /// `on_world_state`'s stdout trace, so that trace can log on CHANGE
    /// rather than on every world (see `lib.rs`).
    pub last_logged: Mutex<Option<(bool, usize)>>,
    /// Pane ids this app itself created via `herdr::launch::create_workspace`
    /// (`found_settlement`, `start_agent`, `create_project`), for as long as
    /// this process has been running.
    ///
    /// IMPORTANT 1: `start_agent`'s "reuse an idle pane" path used to accept
    /// ANY pane herdr reported as `AgentStatus::Unknown` — but `Unknown` also
    /// means "no agent detected", which is exactly what an ordinary login
    /// shell sitting at a prompt reports. `island.agents` contains every pane
    /// Herdr sees, not only ones this app started, so that let "start
    /// another agent" seize a terminal the author was typing in. Restricting
    /// reuse to pane ids THIS app minted closes that: a plain shell the
    /// author opened by hand was never returned by our own `workspace.create`
    /// call, so it can never appear in this set.
    ///
    /// Grows for the life of the process and is never pruned when a
    /// workspace closes — the same "append-only, never evict" choice
    /// `city::layout`'s plot cache already makes for the same reason: herdr
    /// is the only source of truth for whether a pane still exists, and
    /// `idle_pane_for`'s other two conditions (the pane must still be in the
    /// live world, AND still report `Unknown`) already do the real
    /// membership check on every call — a stale entry here for a pane that
    /// has since closed simply never matches anything in `WorldState.islands`
    /// again. KNOWN RESIDUAL: if herdr ever reuses that exact `w<N>:p1`
    /// string for an unrelated, user-created workspace on the SAME
    /// repository while it still reports `Unknown` (before any agent is
    /// detected in it), this set cannot tell the two apart — the same class
    /// of pane-id-reuse risk `commands::find_live_pane` documents for
    /// Important 3, considered and accepted there for the identical reason:
    /// closing it needs herdr to hand back a pane's creation identity, which
    /// it does not do today.
    pub app_created_panes: Mutex<HashSet<String>>,
    /// Shared with `herdr::events::run_connection_loop`: `mark_agent_seen`
    /// drops a pane id in, the loop rebuilds the world with it seen.
    pub seen: crate::herdr::events::SeenInbox,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            world: Mutex::new(WorldState::disconnected()),
            last_jump: Mutex::new(None),
            transitions: Mutex::new(TransitionLog::new(crate::config::data_path(
                "transitions.jsonl",
            ))),
            notified_stopped: Mutex::new(None),
            config: crate::config::Config::load(&crate::config::data_path("config.json")),
            last_logged: Mutex::new(None),
            app_created_panes: Mutex::new(HashSet::new()),
            seen: crate::herdr::events::SeenInbox::default(),
        }
    }

    pub fn replace_world(&self, next: WorldState) {
        *self.world.lock().unwrap() = next;
    }
}

#[tauri::command]
pub fn get_world(state: tauri::State<'_, AppState>) -> WorldState {
    state.world.lock().unwrap().clone()
}

/// Picks which pane within `island` to focus: the first agent whose OWN
/// `attention` is `Stopped`, falling back to the island's first agent at all
/// only if none is (e.g. the island's `Stopped` attention came from an agent
/// that has since moved on — `next_target` still found this island by id,
/// but its per-agent state may already be stale).
///
/// Task 2, Phase 0's carried must-fix: this used to guess from raw `status`
/// (`Blocked`/`Done`, then "first agent at all"). An island can be `Stopped`
/// because a pane went `working -> idle` (spec §5.4's idle-after-work — see
/// `world::attention::StopMemory`), and nothing live ever reports `done`, so
/// that is in fact the COMMON way to reach this function — such an agent is
/// neither `Blocked` nor `Done`, so the old fallback could focus a pane that
/// is still `Working` one row down. `IslandAgent::attention` now carries the
/// exact same per-pane computation that produced the island's own `Stopped`
/// roll-up (`world::attention::build_world`), so this is no longer a guess.
pub fn jump_target(island: &Island) -> Option<String> {
    island
        .agents
        .iter()
        .find(|agent| agent.attention == Attention::Stopped)
        .or_else(|| island.agents.first())
        .map(|agent| agent.pane_id.clone())
}

/// Jumps to the next island that needs attention: focuses its most urgent
/// agent's pane in herdr and raises the terminal app hosting it. Cycles
/// through `Stopped` islands using `AppState.last_jump` so repeated
/// presses advance rather than stick on the same island.
///
/// Deliberately instant (principle 2: no animation, no artificial delay on
/// this path) — the only latency is the one real network round-trip to
/// herdr's `agent.focus`.
///
/// This opens its OWN short-lived connection rather than reusing the
/// connection loop's subscription client: real Herdr 0.8.0 serves exactly
/// one request per connection and then closes it (see
/// `herdr::events::fetch_snapshot_fresh`'s doc comment) — issuing a second
/// request on an existing connection reads EOF and then fails with a
/// broken pipe.
///
/// A `std::sync::MutexGuard` must never be held across an `.await` (the
/// resulting future would no longer be `Send`, and this would not
/// compile), so `target_pane`/`island_id`/`island_name` are copied out of
/// `state.world`/`state.last_jump` inside the scoped block below, and both
/// locks are dropped before the first `.await`.
#[tauri::command]
pub async fn jump_to_next(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let (target_pane, island_id, island_name) = {
        let world = state.world.lock().unwrap();
        let last = state.last_jump.lock().unwrap().clone();
        match next_target(&world, last.as_deref()) {
            Some(island) => match jump_target(island) {
                Some(pane) => (pane, island.id.clone(), island.name.clone()),
                None => return Ok(None),
            },
            None => return Ok(None),
        }
    };

    let home = dirs::home_dir().ok_or("no home directory")?;
    let path =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
    let client = crate::herdr::client::HerdrClient::connect(&path)
        .await
        .map_err(|e| e.to_string())?;
    client
        .call("agent.focus", serde_json::json!({ "target": target_pane }))
        .await
        .map_err(|e| e.to_string())?;

    // Best-effort: a missing/misdetected terminal app must not undo the
    // agent.focus call that already landed in herdr.
    raise_terminal(&state.config);
    *state.last_jump.lock().unwrap() = Some(island_id);
    Ok(Some(island_name))
}

/// Raises the terminal app hosting herdr, honoring the user's explicit
/// `terminal_app` config override before falling back to detection (Task 12
/// Amendment 1) — an unset value is `None`, not a defaulted "Terminal"
/// literal, so detection only ever runs when nothing was configured.
///
/// Best-effort BY DESIGN, not by omission: every caller has already made its
/// real herdr write (`agent.focus`/`workspace.focus`) before reaching this,
/// so a missing or misdetected terminal app must never be reported back as
/// if that write had failed — the call landed in herdr regardless of
/// whether a human window came forward to show it.
///
/// Shared by every command that focuses something and then needs the
/// terminal window itself raised — originally `jump_to_next` and
/// `focus_pane`'s own inline copies of these two lines, pulled out here so
/// `focus_workspace` (Task: Phase 0.6 actions) reuses the exact same logic
/// rather than a third copy.
fn raise_terminal(config: &crate::config::Config) {
    let terminal_app =
        config.terminal_app.clone().unwrap_or_else(crate::platform::detect_terminal_app);
    let _ = crate::platform::activate_terminal(&terminal_app);
}

/// Finds the island and agent for a live pane id in the CURRENT world, or
/// `None` if no pane in the world has this id right now.
///
/// IMPORTANT 3: herdr reuses `w<N>:p1`-style pane ids once a workspace
/// closes (a fresh workspace can be handed the exact same id a closed one
/// used), so a pane id the frontend is still holding from before that close
/// can, after the reuse, name a completely different agent in a completely
/// different repository. `send_prompt` and `focus_pane` used to pass the
/// frontend's string straight to herdr with no cross-check against the live
/// world (unlike `focus_workspace`, which already resolves through
/// `existing_workspace_for`) — a stale id would silently deliver the user's
/// composed prompt to a different agent and still return `Ok`. Both commands
/// now look the id up here FIRST and refuse before making any herdr call at
/// all.
///
/// KNOWN RESIDUAL, same shape as `AppState.app_created_panes`'s: if herdr
/// reuses a pane id for a NEW agent in the exact SAME repository between the
/// moment the frontend last saw the world and the moment this call resolves,
/// this lookup still finds a match — it can only prove the id currently
/// names *some* live pane, not that it is still the same conversation the
/// user was looking at when they composed the prompt. Closing that
/// completely would need herdr to expose a per-pane creation identity, which
/// it does not today; the repository-level check `validate_send_prompt`
/// layers on top (an optional `expected_root`) narrows this further for the
/// case that matters most — a prompt aimed at one island landing in another.
fn find_live_pane<'a>(world: &'a WorldState, pane_id: &str) -> Option<(&'a Island, &'a IslandAgent)> {
    world
        .islands
        .iter()
        .find_map(|island| island.agents.iter().find(|a| a.pane_id == pane_id).map(|a| (island, a)))
}

/// Focuses one specific pane in herdr and raises the terminal hosting it —
/// the archipelago's villager click (Item 4 of the archipelago scene). Unlike
/// `jump_to_next`, the caller already knows exactly which pane to focus
/// (having clicked one villager standing on one island, joined from
/// `Island.agents` by `root` on the frontend): there is no island lookup, no
/// `Stopped`-cycling decision, and no `AppState.last_jump` bookkeeping to
/// update — this is the thin "focus THIS pane" primitive `jump_to_next`
/// already builds on, exposed directly.
///
/// IMPORTANT 3: `pane_id` is validated against the live `WorldState` before
/// anything is sent to herdr (see `find_live_pane`'s doc comment) — a stale
/// id the frontend is still holding, after herdr has reused it for an
/// unrelated pane, must be refused rather than silently raising the wrong
/// terminal.
///
/// Deliberately instant (principle 2, same as `jump_to_next`): the frontend
/// fires this immediately on click and never gates a camera animation on its
/// result — the only latency here is the one real network round-trip to
/// herdr's `agent.focus`.
///
/// Opens its own short-lived herdr connection rather than reusing the
/// connection loop's subscription client, for the same reason `jump_to_next`
/// does: real Herdr 0.8.0 serves exactly one request per connection and then
/// closes it.
///
/// The user opened this agent's terminal in the app, so a finished agent is
/// now "seen": Herdr's hollow ring instead of its filled dot (see
/// `StopMemory`). Local state only — nothing is written to herdr, which
/// keeps its own notion of seen for its own sidebar.
#[tauri::command]
pub fn mark_agent_seen(state: tauri::State<'_, AppState>, pane_id: String) {
    state.seen.mark(&pane_id);
}

/// Uses the exact same permitted write (`agent.focus`) as `jump_to_next` —
/// this command adds no new herdr method to the permitted write surface.
#[tauri::command]
pub async fn focus_pane(state: tauri::State<'_, AppState>, pane_id: String) -> Result<(), String> {
    {
        let world = state.world.lock().unwrap();
        find_live_pane(&world, &pane_id).ok_or_else(|| {
            format!(
                "{pane_id} is not a pane in the current world — it may have closed, or herdr may \
                 have reused its id for a different agent"
            )
        })?;
    }

    let home = dirs::home_dir().ok_or("no home directory")?;
    let path =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
    let client = crate::herdr::client::HerdrClient::connect(&path)
        .await
        .map_err(|e| e.to_string())?;
    client
        .call("agent.focus", serde_json::json!({ "target": pane_id }))
        .await
        .map_err(|e| e.to_string())?;

    // Best-effort, same as `jump_to_next`: a missing/misdetected terminal app
    // must not undo the `agent.focus` call that already landed in herdr.
    raise_terminal(&state.config);
    Ok(())
}

/// What `list_unsettled` hands the frontend: every git repo found under the
/// user's project roots, plus the directories actually scanned to find them
/// — so discovery is never a black box (spec §5.1).
#[derive(serde::Serialize)]
pub struct UnsettledReport {
    /// The directories actually scanned, so the UI can show its working.
    pub roots: Vec<String>,
    /// EVERY scanned repo, canonically spelled — settled ones included.
    ///
    /// FINAL WHOLE-BRANCH REVIEW, Critical: this deliberately does not
    /// subtract. The settled set can only be derived honestly from the pane
    /// cwds in the live world (`world::state::IslandAgent::cwd`), and the
    /// frontend already holds that world; subtracting here as well meant two
    /// sources of truth for one question, which is what produced the
    /// worktree hole and the two async races the frontend had grown guards
    /// for. The frontend now subtracts once, in `founding.ts`'s
    /// `subtractSettled`, against the world it renders — so the list
    /// re-derives itself whenever the world changes.
    pub repos: Vec<UnsettledRepo>,
    /// The user's home directory, normalized the same way as `roots` and
    /// `repos[].path`. The frontend has no other way to learn this (there is
    /// no Node-style `os.homedir()` in a Tauri webview), and it needs it to
    /// render every path the same way a shell prompt would — `~/Projects/api`
    /// rather than `/Users/name/Projects/api` — for both `roots` and
    /// `repos[].path` consistently (see `unsettled_report_for`'s doc comment
    /// on the carried root/repo spelling mismatch).
    pub home: String,
    /// The agent `found_settlement` will actually start (its own
    /// `config.default_agent.unwrap_or("claude")` fallback, resolved here so
    /// the confirm sheet names the real call instead of a guess — the sheet
    /// exists specifically so nothing runs unseen (principle 1), which
    /// includes not silently assuming "claude" when the user configured
    /// something else).
    pub default_agent: String,
}

/// Repos under the user's project roots that have no herdr workspace yet.
///
/// Read-only: this command only inspects the current world and the
/// filesystem, it makes no herdr calls, so it stays synchronous rather than
/// `async` (there is nothing to `.await` and thus no `MutexGuard`-across-await
/// hazard to design around, unlike `found_settlement` below).
#[tauri::command]
pub fn list_unsettled(state: tauri::State<'_, AppState>) -> UnsettledReport {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let world = state.world.lock().unwrap();
    unsettled_report_for(&state.config, &world, home)
}

/// The logic behind `list_unsettled`, pulled out as a plain function so it's
/// testable without standing up a `tauri::State` — the same split the
/// `jump_to_next`/`jump_target` pair already uses above.
fn unsettled_report_for(
    config: &crate::config::Config,
    world: &WorldState,
    home: PathBuf,
) -> UnsettledReport {
    // Used ONLY as a hint about where this user keeps code — it no longer
    // decides what is offered (see `world::unsettled::scanned_repos` and
    // `UnsettledReport.repos` below). `island.root` is already produced by
    // `world::repo::normalize_path` when the island is built, so the
    // re-canonicalization that used to happen here was a redundant `stat`
    // per island on every call (FINAL WHOLE-BRANCH REVIEW, minor).
    let settled_roots: Vec<String> =
        world.islands.iter().map(|island| island.root.clone()).collect();

    // A configured list wins; otherwise discover where this user keeps code.
    // No depth cap: `scan_roots` is unbounded (see its doc comment for why
    // that is honest AND fast), and it is the ONLY discovery scan in the
    // app — shared with `repo_name_is_ambiguous` and `build_archipelago` via
    // `discovery_plan`, so this list, the ambiguity check, and the
    // archipelago can never again disagree about which repositories exist.
    let roots = discovery_plan(config, &home, &settled_roots);
    let repos = scanned_repos(&scan_roots(&roots));

    // The frontend renders both this list and each repo's own path (which
    // comes out of `scan_one`/`normalize_path` already canonicalized), and a
    // human reads them together as "looked in X" / "found Y under X". If a
    // root is itself reached through a symlink (a symlinked `~/Projects`, an
    // iCloud/Dropbox mount, ...) the raw, un-canonicalized root here would
    // spell differently than the canonical repo paths scanned through it,
    // and the two lines would look unrelated even though one is literally
    // inside the other. Normalizing roots the same way fixes the data itself
    // rather than papering over it with display-only tricks (carried
    // finding from Task 3's review).
    let roots = roots.iter().map(|r| normalize_path(r).to_string_lossy().to_string()).collect();
    let home = normalize_path(&home).to_string_lossy().to_string();
    let default_agent = default_agent(config);

    UnsettledReport { roots, repos, home, default_agent }
}

/// True when `cwd` is `repo` itself, or a directory inside it.
///
/// Segment-aware on purpose: a plain `starts_with` on the string would make
/// `/p/api-docs` look like it sits inside `/p/api` and hide a real,
/// unfounded repo forever. `Path::starts_with` compares whole components,
/// which is exactly the rule the frontend's `subtractSettled` implements on
/// its side (`cwd === path || cwd.startsWith(path + "/")`).
///
/// "Inside it" counts because a workspace whose pane sits several
/// directories down is still a workspace for that repository, and Phase 0
/// draws it as one island — matching only on exact equality would re-offer
/// the repo and invite a second workspace. The known corner of that rule is
/// a worktree placed INSIDE its own main repo (`/p/repo/wt/feature`), which
/// makes `/p/repo` look settled; that is unchanged from the pre-fix
/// behaviour (such a pane collapsed onto `/p/repo`'s island anyway) and is
/// consistent with one-island-per-repository.
///
/// Both sides must already be canonical.
fn cwd_settles(cwd: &str, repo: &Path) -> bool {
    Path::new(cwd).starts_with(repo)
}

/// If any pane in the world is working in `repo` — or in a directory inside
/// it — returns that pane's workspace id. `None` means no match was found,
/// which includes the case where `world.islands` is empty (herdr not yet
/// reporting) — this function does not distinguish "no" from "don't know
/// yet", so callers must not treat `None` as proof the repo is unsettled,
/// only as "nothing to refuse on".
///
/// FINAL WHOLE-BRANCH REVIEW, Critical: this used to compare `repo` against
/// `island.root`, which is where a pane RESOLVES TO after `world::repo`
/// collapses worktrees onto their main repository. That made the guard blind
/// to exactly the case it most needed to catch: a workspace founded on
/// `/p/repo-wt` lives on the island rooted at `/p/repo`, so asking "does
/// `/p/repo-wt` have a workspace?" answered no and a second workspace was
/// created on the same worktree. It also inverted the answer for the main
/// repo, refusing `/p/repo` — which has no workspace at all.
///
/// Comparing against each agent's own canonical `cwd` (where the workspace
/// was actually founded) fixes both, and additionally survives
/// `foreground_cwd` drift: a `cd` inside a founded pane moves the island,
/// but not the pane's own cwd.
///
/// Pulled out as a plain function, in the same spirit as `jump_target` and
/// `unsettled_report_for`, so the idempotency guard in `found_settlement`
/// (fix round 1, Critical 2) is testable without a live herdr connection.
fn existing_workspace_for(world: &WorldState, repo: &Path) -> Option<String> {
    let canonical_repo = normalize_path(repo);
    world
        .islands
        .iter()
        .flat_map(|island| island.agents.iter())
        .find(|agent| cwd_settles(&agent.cwd, &canonical_repo))
        .map(|agent| agent.workspace_id.clone())
}

/// Validates that `repo` is something that can be founded, returning the
/// workspace label (the directory's own name) on success and the exact user
/// -facing refusal on failure.
///
/// IMPORTANT 4: extracted from `found_settlement` so the `.git` check and
/// the label derivation are actually asserted somewhere. The check is
/// deliberately "is there a `.git` here", not "is there a `.git`
/// DIRECTORY" — a worktree's `.git` is a file, and founding a worktree is
/// legitimate (herdr has first-class worktree support).
fn foundable_label(repo: &Path) -> Result<String, String> {
    let label = repo
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| format!("not a valid path: {}", repo.display()))?;
    if !repo.join(".git").exists() {
        return Err(format!("{label} is not a git repository"));
    }
    Ok(label)
}

/// The message for the one outcome that MUST NOT be misread (principle 4):
/// `workspace.create` succeeded and `agent.start` did not, so the workspace
/// EXISTS in herdr. A user who reads a bare "the agent did not start" as
/// "nothing happened" and retries ends up with two workspaces for one repo —
/// the exact failure the idempotency guard exists to prevent. The workspace
/// id is in the text because it is the only handle the user has for finding
/// or closing the orphan.
///
/// The trailing clause was added after the author hit this for real, four
/// times in one sitting (`w2K`, `w2M`, `w2N`, `w2P`, every one of them an
/// `agent_name_taken`). The message already named the workspace; what it
/// did not say is that the half-built thing on his screen was LEFT THERE
/// DELIBERATELY. This app is not permitted to call `workspace.close` (spec
/// §5.6's write surface does not include it) and tidying up by destroying
/// something the user can see would be worse than leaving it — but silence
/// about that reads as a bug rather than as a decision, so it is said out
/// loud.
fn partial_failure_message(workspace_id: &str, label: &str, error: &str) -> String {
    format!(
        "workspace {workspace_id} ({label}) was created, but the agent did not start: {error} \
         — the workspace and its pane still exist and were deliberately not removed"
    )
}

/// The idempotency guard's refusal, naming the workspace that already exists
/// so the user can go look at it rather than guessing.
fn already_founded_message(label: &str, workspace_id: &str) -> String {
    format!("{label} already has a workspace ({workspace_id}) — refusing to create a second one")
}

/// Canonicalizes `path` the same way every path produced by `list_unsettled`
/// already is (`world::repo::normalize_path`).
///
/// FINAL WHOLE-BRANCH REVIEW, minor: `browse…` hands the frontend a raw
/// dialog path, which on macOS routinely reaches a repo through a symlink
/// (`/tmp`, an iCloud/Dropbox mount, a symlinked `~/code`). The frontend has
/// no way to canonicalize it, so without this it would compare a
/// non-canonical path against canonical pane cwds, never match, and offer a
/// confirm sheet for a repo that already has a workspace.
#[tauri::command]
pub fn canonical_path(path: String) -> String {
    normalize_path(Path::new(&path)).to_string_lossy().to_string()
}

/// What the town view renders: a repository's `CityModel` and its resolved
/// `CityLayout` together, produced by the exact same
/// `layout_city_persisted_from_root` call `city_preview`/`city_fixture`
/// use — so the interactive 3D town and Task 5's top-down SVG preview are
/// provably showing the same city, never two different derivations of
/// "the same" repository.
#[derive(serde::Serialize)]
pub struct CityView {
    pub model: CityModel,
    pub layout: CityLayout,
}

/// Builds and lays out `path`'s city for the town view.
///
/// `layout_city_persisted_from_root` asks `git` for the repository's file
/// set and then reads every surviving file to count its lines — on a large
/// repository (task-6-design-inputs.md §7.2 calls out the user's own
/// `pocketAlarm`) that is thousands of files, so this must never run on the
/// UI thread: principle 2 ("never slower than the terminal") means a click
/// that opens a town must not freeze the window while the walk finishes.
/// `spawn_blocking` moves the whole build+layout pair onto a
/// blocking-friendly thread; the join only fails if that closure panics,
/// which nothing here is expected to do, but surfacing it as an error
/// string rather than `.unwrap()`ing keeps a bug there from taking the
/// whole async runtime down with it.
///
/// Deliberately takes whatever path the frontend passes as `path` — the
/// frontend's own obligation (task-6-design-inputs.md §7.1) is to always
/// pass `Island.root`, never an individual agent's `cwd`: `root` is the one
/// canonical repository a worktree pane's island already collapsed onto,
/// while `cwd` is where that specific pane was founded and can name a
/// different (worktree) directory than the island it renders as part of.
///
/// Calls `layout_city_persisted_from_root` (city::layout, "Fix round 6"),
/// not the older `build_city` + `layout_city_persisted` pair: that pair
/// built the model BEFORE loading this repo's persisted cache, so an
/// over-full directory's split-slot membership was resolved with no memory
/// of which numbered slot each file already had — see
/// `docs/superpowers/phase-0-followups.md`.
#[tauri::command]
pub async fn city_for(path: String) -> Result<CityView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(path);
        let (model, layout) =
            layout_city_persisted_from_root(&root, &RealFiles::new(Box::new(RealGitFiles::default())));
        CityView { model, layout }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Returns the whole archipelago — every repository under the user's
/// project roots, laid out as an island in a shared sea (see
/// `city::archipelago` for the layout/caching design).
///
/// Deliberately mirrors `city_for`'s reasoning for running on a dedicated
/// blocking-pool thread rather than inline: `build_archipelago` discovers
/// every repository under the user's project roots and, for any repository
/// whose city was not already cached under its current last-commit epoch,
/// runs the same `git ls-files` + per-file line count `build_city` does —
/// on `my-site-next` alone (1,057 buildings) that is real, measurable
/// work (see the fix report). None of that may run on the async runtime's
/// own worker thread, which is what schedules every other Tauri command and
/// the herdr event loop.
#[tauri::command]
pub async fn get_archipelago(state: tauri::State<'_, AppState>) -> Result<Archipelago, String> {
    let config = state.config.clone();
    let home = dirs::home_dir().ok_or("no home directory")?;
    // ALSO FIX IF CHEAP: `build_archipelago` used to be handed `&[]` for
    // `settled_roots` while `list_unsettled`/`repo_history` pass the real
    // set — two root sets silently answering the same "what should we scan"
    // question. Gathered under the same lock-then-drop-before-`.await`
    // discipline `repo_history` already uses.
    let settled_roots: Vec<String> = {
        let world = state.world.lock().unwrap();
        world.islands.iter().map(|island| island.root.clone()).collect()
    };
    tauri::async_runtime::spawn_blocking(move || build_archipelago(&config, home, &settled_roots))
        .await
        .map_err(|e| e.to_string())
}

/// A repository's readable transition history (see `history` module docs) —
/// the small timeline an island panel wants: when it worked, when it
/// stopped, how many sessions, when it was last active.
///
/// `root` must be a canonical repository root, the same identity everything
/// else keys an island by (`Island.root`) — mirrors `city_for`'s contract of
/// "always pass a canonical root, never a raw pane cwd".
///
/// Mirrors `city_for`'s and `get_archipelago`'s reasoning for `spawn_blocking`:
/// parsing a log that grows without bound over months of real use is real
/// I/O and CPU work with no business running on the async runtime's own
/// worker thread, which also owns the herdr event loop.
///
/// Legacy rows (written before `transitions::TransitionLog` started recording
/// `repo_root`) can only be matched to a repository by its display name, and
/// a name can collide across differently-located repositories. Whether that
/// makes THIS repo's name ambiguous is answered honestly here, from the
/// user's actual repository set — the same discovery `list_unsettled` uses
/// (`candidate_roots` + `scan_roots`) — never assumed one way or the other.
#[tauri::command]
pub async fn repo_history(
    state: tauri::State<'_, AppState>,
    root: String,
) -> Result<crate::history::RepoHistory, String> {
    let config = state.config.clone();
    let home = dirs::home_dir().ok_or("no home directory")?;
    let settled_roots: Vec<String> = {
        let world = state.world.lock().unwrap();
        world.islands.iter().map(|island| island.root.clone()).collect()
    };

    tauri::async_runtime::spawn_blocking(move || {
        let root = normalize_path(Path::new(&root)).to_string_lossy().to_string();
        let name = Path::new(&root)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.clone());
        let name_ambiguous = repo_name_is_ambiguous(&config, &home, &settled_roots, &name);
        let log_path = crate::config::data_path("transitions.jsonl");
        crate::history::build_repo_history(&log_path, &root, &name, name_ambiguous)
    })
    .await
    .map_err(|e| e.to_string())
}

/// True if more than one of the user's real repositories (discovered the
/// same way `list_unsettled` discovers unsettled repos, plus whatever is
/// already settled in the live world) share `name` as a basename — the
/// signal `repo_history` needs to decide whether a legacy, name-only log row
/// can be trusted or must be excluded (see `history` module docs).
///
/// MINOR 6 (Phase 0.5b): this used to answer from a depth-2, nested-pruned
/// scan that could not honestly answer "is this name unique" — a repo the
/// scan simply never reached is not evidence of uniqueness, it is an
/// unanswered question. Confirmed live against this author's own
/// `~/Projects`: the old depth-2 scan reported zero basename collisions
/// where the real, unbounded set has three (`StrategyTrader_v2`,
/// `padel-court-api`, `space-guardian`) across 152 real repositories — 79 of
/// which the depth-2 scan never saw at all. `scan_roots` is now unbounded
/// for every caller (see its doc comment), so this and `list_unsettled` and
/// `build_archipelago` all answer from the exact same scan.
fn repo_name_is_ambiguous(
    config: &crate::config::Config,
    home: &Path,
    settled_roots: &[String],
    name: &str,
) -> bool {
    let roots = discovery_plan(config, home, settled_roots);
    let known_repos = scan_roots(&roots);

    let mut distinct_roots_with_name: HashSet<String> = settled_roots
        .iter()
        .filter(|root| Path::new(root).file_name().map(|n| n.to_string_lossy() == name).unwrap_or(false))
        .cloned()
        .collect();
    for repo in &known_repos {
        if repo.file_name().map(|n| n.to_string_lossy() == name).unwrap_or(false) {
            distinct_roots_with_name.insert(repo.to_string_lossy().to_string());
        }
    }
    distinct_roots_with_name.len() > 1
}

/// What `found_settlement` returns. It used to return the bare workspace
/// id; the pane id is now returned alongside it for one specific, honest
/// reason (the terminal-polish round: starting an agent should land you in
/// its terminal immediately).
///
/// The frontend opens the interactive terminal on the pane an agent was
/// actually started in, and the ONLY way to know which pane that is, is for
/// the command that created it to say so. Guessing — "the newest pane on
/// this island", "the one that appeared after we called" — would point the
/// user's keyboard at whatever pane happened to show up next, which is
/// precisely the failure spec §5.6's terminal constraints exist to prevent.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FoundedSettlement {
    /// The workspace herdr's `workspace.create` minted — everything this
    /// command used to return bare.
    pub workspace_id: String,
    /// The root pane of that workspace: the pane `agent.start` was called
    /// on when `start_agent` was true, and an agentless shell pane when it
    /// was false.
    pub pane_id: String,
    /// The NAME the agent was actually started under (`resolve_agent_name`),
    /// or `None` when no agent was started.
    ///
    /// Returned rather than left implicit because the confirm sheet prints
    /// a name BEFORE the call runs and `resolve_agent_name` documents a
    /// race it cannot close (herdr has no name reservation). This is the
    /// after-the-fact truth: whatever the sheet predicted, this is what
    /// herdr was told, so the UI can say so instead of the user having to
    /// go and look.
    pub agent_name: Option<String>,
}

/// Resolves the agent kind a founding/starting command will actually use:
/// whatever the caller explicitly chose, or — only when the caller chose
/// nothing — the one configured default (`default_agent`).
///
/// One function for all three commands that take an optional kind
/// (`found_settlement`, `start_agent`, `create_project`), for the same
/// reason `default_agent` itself was collapsed out of five copies: the
/// confirm sheet prints the name it believes will be used, and every extra
/// hand-written `unwrap_or_else` is another place that belief can quietly
/// stop being true. Tested directly in
/// `an_explicit_kind_always_wins_and_only_its_absence_falls_back`.
fn resolved_kind(config: &crate::config::Config, kind: Option<String>) -> String {
    kind.unwrap_or_else(|| default_agent(config))
}

// ============================================================================
// Agent NAMES — herdr's globally-unique handle, which is not the kind
// ============================================================================
//
// THE BUG THIS FIXES, in the author's own words from live use:
//
//   "also workspace w2M (AgeOfAgents) was created, but the agent did not
//    start: herdr error agent_name_taken: agent name claude is already
//    used; candidates: ... pane_id=w2J:p1 ... status=Idle"
//
// All three `agent.start` call sites in this file passed the KIND as the
// NAME (`start_agent(&socket, &pane, &kind, &kind, &args)`). herdr requires
// names to be globally unique, so the first `claude` this app ever started
// claimed the name `claude` for the life of that herdr session and every
// later start — of any kind, on any repository — failed. It cost the author
// four orphaned workspaces (`w2K` helpDesk, `w2M` AgeOfAgents, `w2N`
// WebGallery, `w2P` photostudio-webpage) before it was diagnosed,
// and it broke BOTH paths: founding a settlement and "Start agent…" on an
// island that already has one.
//
// THE SCHEME: the repository's own directory name, because that is how the
// author thinks about his agents and it is what he reads in herdr's own
// list ("AgeOfAgents", "helpDesk", "webAdmin" — not "claude" four
// times, and not a UUID he has to live with). The kind stays the kind:
// herdr already shows it in its own column, so repeating it in the name
// would be noise in the overwhelmingly common one-agent-per-repo case.
//
// Repository basenames are NOT unique on this machine — the archipelago
// work found three colliding basenames across 152 repos — so the name is
// derived AND THEN CHECKED against a read-only `agent.list`, never assumed.

/// The starting point for a repository's agent name: its directory name,
/// reduced to characters that read cleanly as a handle in herdr's own UI
/// and on a herdr command line.
///
/// herdr's hard limit on an agent name's length, from the same error
/// message quoted on [`agent_name_base`]. The whole name must fit, suffix
/// included — see `first_free_agent_name`.
const AGENT_NAME_MAX: usize = 32;

/// HERDR'S ACTUAL RULE, quoted from the error it returns (0.9.0) rather
/// than inferred: *"agent name must start with a lowercase letter and
/// contain only lowercase letters, digits, '-' or '_' (1-32 characters)"*.
///
/// The first version of this function guessed `[A-Za-z0-9._-]` capped at
/// 64 and was wrong on three counts at once — uppercase, `.`, and the
/// length. The author hit it immediately on `WebGallery`, whose
/// capital `S` alone is disqualifying, and lost a workspace to it
/// (`invalid_agent_name`, `w2S`). The lesson is the one this project keeps
/// relearning: a constraint belonging to another system is discoverable,
/// and guessing it is a decision to be wrong later. Nothing here may be
/// relaxed without re-reading that message.
///
/// So: lowercased, anything outside `[a-z0-9_-]` becomes `-`, runs of `-`
/// collapse, and leading/trailing `-`/`_` are trimmed. Note `.` is NOT
/// permitted by herdr and is therefore mapped out, not kept. Two of these
/// substitutions matter beyond looks: `/` and `:` would make a name that
/// reads like a path or a pane id (`w2J:p1`), and herdr resolves an agent
/// TARGET by name or pane id, so a name shaped like the other thing is an
/// ambiguity waiting to be hit.
///
/// **Must start with a lowercase letter.** A repository whose name begins
/// with a digit (`2048`) or punctuation would otherwise produce a name
/// herdr rejects, so those get a `repo-` prefix — chosen over dropping the
/// leading characters, which would turn `2048` into `agent` and throw away
/// the only part that identifies it.
///
/// Capped at [`AGENT_NAME_MAX`] characters. The cap is applied to the BASE
/// here; `first_free_agent_name` shortens it further when it has to append
/// a `-N`, so a disambiguated name is still within herdr's limit.
///
/// A path with nothing usable in its last component (`/`, or a directory
/// named `---`) falls back to `"agent"` rather than producing an empty
/// name herdr would reject — the collision loop then makes it unique like
/// any other base.
fn agent_name_base(repo: &Path) -> String {
    let raw = repo.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

    let mut cleaned = String::with_capacity(raw.len());
    for ch in raw.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
            cleaned.push(ch);
        } else if !cleaned.ends_with('-') {
            cleaned.push('-');
        }
    }
    let trimmed = cleaned.trim_matches(['-', '_']).to_string();

    if trimmed.is_empty() {
        return "agent".to_string();
    }

    // herdr requires the FIRST character to be a lowercase letter; keep the
    // identifying part rather than discarding it.
    let prefixed = if trimmed.starts_with(|c: char| c.is_ascii_lowercase()) {
        trimmed
    } else {
        format!("repo-{trimmed}")
    };

    let capped: String = prefixed.chars().take(AGENT_NAME_MAX).collect();
    // Truncation can expose a trailing `-`/`_`; trimming again can never
    // empty the string, because the first character is a lowercase letter.
    capped.trim_end_matches(['-', '_']).to_string()
}

/// The first name in the sequence `base`, `base-2`, `base-3`, … that is not
/// in `taken`, or `None` if somehow every candidate is.
///
/// Three properties this has to have, all of them testable right here
/// without a herdr:
///
/// - **It terminates.** The loop is bounded by `taken.len() + 2`, and that
///   bound is provably enough rather than merely generous: the candidates
///   are `base` plus `base-2 ..= base-(n+2)`, which is `n + 2` DISTINCT
///   strings, while `taken` holds only `n`. At least two candidates are
///   therefore free, always.
/// - **It is deterministic.** Given the same `base` and the same taken set
///   it returns the same name every time — no clock, no randomness, no
///   process id. This is what lets the confirm sheet print the name the
///   call is about to use instead of a paraphrase.
/// - **It never silently reuses a taken name.** The impossible case returns
///   `None` so the caller can refuse out loud, rather than falling through
///   to a name herdr already holds and reproducing the very failure this
///   function exists to prevent.
fn first_free_agent_name(base: &str, taken: &HashSet<String>) -> Option<String> {
    if !taken.contains(base) {
        return Some(base.to_string());
    }
    for n in 2..=(taken.len() + 2) {
        // herdr caps the WHOLE name at `AGENT_NAME_MAX`, so the suffix has
        // to come out of the base rather than be added on top of a base
        // that already fills the budget — otherwise a long repository name
        // would produce a first candidate herdr accepts and a second one it
        // rejects, which is a far worse failure than a shortened name.
        let suffix = format!("-{n}");
        let room = AGENT_NAME_MAX.saturating_sub(suffix.len());
        let stem: String = base.chars().take(room).collect();
        let stem = stem.trim_end_matches(['-', '_']);
        let candidate = format!("{stem}{suffix}");
        if !taken.contains(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// The name this app will hand `agent.start` for an agent in `repo`: the
/// repository's own name, made unique against the names herdr reports right
/// now.
///
/// Read-only: the only herdr call it makes is `agent.list`. It is run
/// BEFORE `workspace.create` on every path that creates one, so a failure
/// to work out a name leaves nothing half-built behind.
///
/// A KNOWN, UNAVOIDABLE RACE, stated rather than papered over: herdr has no
/// way to reserve a name, so between this lookup and the `agent.start` that
/// uses the answer, another herdr client could claim it. The confirm sheet
/// therefore shows the name resolved by THIS function at the moment the
/// sheet was opened, and the command resolves again with this same function
/// at the moment the user confirms. In the disagreeing case the command
/// uses the name that is actually free (never one that is taken) and herdr
/// itself remains the final arbiter — `agent_name_taken` is still surfaced
/// verbatim through `partial_failure_message` if it ever fires.
async fn resolve_agent_name(socket: &Path, repo: &Path) -> Result<String, String> {
    let taken: HashSet<String> = crate::herdr::launch::list_agent_names(socket)
        .await
        .map_err(|e| format!("could not ask herdr which agent names are already in use: {e}"))?
        .into_iter()
        .collect();

    let base = agent_name_base(repo);
    first_free_agent_name(&base, &taken).ok_or_else(|| {
        format!("could not find an unused agent name based on {base:?} — refusing to reuse one")
    })
}

/// The name a confirm sheet should print for an agent about to be started
/// in `root` — the exact string `found_settlement`/`start_agent`/
/// `create_project` will send, produced by the one function all of them
/// call (`resolve_agent_name`), never a second derivation that could drift.
///
/// Read-only (`agent.list` and nothing else), and safe to call from the
/// mere act of opening a sheet: spec §5.6 forbids anything running before
/// the confirm button, and looking up what names exist is Free-tier "read
/// herdr state", the same tier as the world snapshot this app already
/// subscribes to.
#[tauri::command]
pub async fn proposed_agent_name(root: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
    resolve_agent_name(&socket, Path::new(&root)).await
}

/// Founds a new herdr workspace at `path` and, if `start_agent` is true,
/// starts an agent of `kind` (or the configured default when `kind` is
/// `None`) in its root pane. Returns the new workspace and pane ids.
///
/// `kind` was added by the terminal-polish round. Before it, this command
/// took no kind at all and always used `config.default_agent`, so the
/// unsettled path — the one a user hits on any repo without a workspace —
/// silently gave them "claude" while the settled path had offered a kind
/// picker all along (the author, on hitting exactly this: "where cna i
/// choose which claude od codex?"). It is `Option` rather than required so
/// the fallback stays in ONE place (`resolved_kind`/`default_agent`) rather
/// than being re-derived by every caller.
///
/// HONESTY REQUIREMENT (principle 4): if `create_workspace` succeeds and the
/// subsequent `start_agent` fails, the workspace EXISTS in herdr regardless.
/// The error text below says so explicitly rather than letting the caller
/// assume nothing happened — a user who assumed that and retried would end
/// up with two workspaces for the same repo.
///
/// This opens its own short-lived herdr connections (via `create_workspace`/
/// `start_agent`, one connection per call) rather than reusing the
/// connection loop's subscription client, for the same reason `jump_to_next`
/// does: real Herdr 0.8.0 serves exactly one request per connection.
///
/// A `std::sync::MutexGuard` must never be held across an `.await`, so
/// `state.config.default_agent` is cloned out of the (non-`Mutex`) config
/// before the first `.await`, and `state.world`'s lock (taken by
/// `existing_workspace_for`, below) is scoped to a block that drops it
/// before the idempotency check's result is even inspected, let alone
/// before any `.await`.
#[tauri::command]
pub async fn found_settlement(
    state: tauri::State<'_, AppState>,
    path: String,
    start_agent: bool,
    kind: Option<String>,
) -> Result<FoundedSettlement, String> {
    let repo = PathBuf::from(&path);
    // ALSO FIX IF CHEAP: `foundable_label` does a `.exists()` filesystem
    // check; moved onto the blocking pool so an unresponsive mount (a
    // network drive, a sleeping external disk) cannot stall the tokio task
    // that also owns the herdr event loop.
    let label = {
        let repo = repo.clone();
        tauri::async_runtime::spawn_blocking(move || foundable_label(&repo))
            .await
            .map_err(|e| e.to_string())??
    };

    // IDEMPOTENCY GUARD (fix round 1, Critical 2 — controller ruling,
    // overriding an earlier review that called this "not a finding" on the
    // grounds that the UI only ever offers unsettled repos): the UI's
    // settled/unsettled split and this command both read the same
    // asynchronously-updated world, so a row the user clicks can be stale
    // — the world may not yet have learned about a workspace that already
    // exists. The UI must not be the only defense against a second
    // workspace for the same repo, so this checks again here, at the point
    // of truth, using the same pane-cwd comparison the frontend's
    // `subtractSettled` uses (`existing_workspace_for`, above) — which,
    // since the final review, can actually see worktrees.
    //
    // Refuses ONLY on a positive match: `state.world.islands` can
    // legitimately be empty (herdr just started, hasn't reported yet, or
    // is briefly disconnected), and refusing on "I don't know yet" would
    // block every founding attempt during that window — strictly worse
    // than the rare double-founding this guard exists to prevent.
    let existing_workspace = {
        let world = state.world.lock().unwrap();
        existing_workspace_for(&world, &repo)
    };
    if let Some(existing) = existing_workspace {
        return Err(already_founded_message(&label, &existing));
    }

    let agent = resolved_kind(&state.config, kind);
    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);

    // The agent's NAME (not its kind — see `resolve_agent_name`) is worked
    // out BEFORE `workspace.create`, deliberately. It is a read-only
    // `agent.list`, so if it fails, nothing has been created and the user
    // gets a plain refusal instead of an orphaned workspace. Skipped
    // entirely when no agent is being started: this path then makes no
    // herdr call it does not need.
    let agent_name = if start_agent {
        Some(resolve_agent_name(&socket, &repo).await?)
    } else {
        None
    };

    let founded = crate::herdr::launch::create_workspace(&socket, &repo, &label)
        .await
        .map_err(|e| e.to_string())?;
    // IMPORTANT 1: this pane was minted by OUR OWN `workspace.create` call,
    // so it is a legitimate candidate for `idle_pane_for` to reuse later —
    // see `AppState.app_created_panes`'s doc comment.
    state.app_created_panes.lock().unwrap().insert(founded.pane_id.clone());

    if let Some(name) = &agent_name {
        crate::herdr::launch::start_agent(&socket, &founded.pane_id, name, &agent, &[])
            .await
            // The workspace id must be in the message: it is the only way
            // the user can find or close the orphaned workspace this failure
            // leaves behind (fix round 1, Important 2). The exact wording is
            // asserted in `the_partial_failure_message_says_the_workspace_
            // exists_and_names_it`.
            .map_err(|e| partial_failure_message(&founded.workspace_id, &label, &e.to_string()))?;
    }

    Ok(FoundedSettlement {
        workspace_id: founded.workspace_id,
        pane_id: founded.pane_id,
        agent_name,
    })
}

// ============================================================================
// Phase 0.5b / 0.6 — the action layer: starting agents, founding brand-new
// projects, revealing files, raising a workspace's terminal, and (Phase 0.6,
// on the author's explicit authorization) prompting a running agent and
// reading back what it said.
// ============================================================================

/// The herdr agent `kind`s Herdr 0.8.0's `agent.start`/`herdr agent start
/// --kind` accepts, in the exact order `herdr agent start --help` lists them
/// (verified live on this machine, Herdr 0.8.0, 2026-09-18).
///
/// This is a CONSTANT, not something asked of herdr at runtime, and that is
/// a considered choice, not a shortcut: `herdr api schema --json` — the
/// bundled protocol schema, the one place this app could ask herdr about
/// itself without spawning a process it has never otherwise spawned — types
/// `AgentStartParams.kind` as a bare `{"type": "string"}`, with no enum.
/// (`IntegrationTarget`, a schema enum that looked promising, is a different,
/// smaller set used by `herdr integration install`/`uninstall` — 16 kinds,
/// missing `pi`/`agy`/`kiro`/`amp`/`maki` — and is not what `agent.start`
/// validates against.) The CLI's own `--kind <KIND>` help text does list all
/// 21 values, because `clap` renders its own hardcoded enum, but shelling
/// out to `herdr --help` and parsing its text would add a whole new kind of
/// dependency this app has never had (every other herdr interaction in this
/// codebase is a socket call, never a spawned CLI process) merely to recover
/// what the protocol schema already proves is not a runtime-queryable fact.
/// A reviewed constant, kept in sync by hand against a version herdr itself
/// reports (see `list_unsettled`'s `default_agent` precedent for "name the
/// real thing rather than a guess"), is the honest option actually on offer.
const AGENT_KINDS: &[&str] = &[
    "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode",
    "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli",
    "maki",
];

/// Moves `default` to the front of `kinds` (de-duplicating it if already
/// present), so a caller sees "the one that will actually run" first without
/// silently dropping any other option. Pulled out as a plain function so the
/// ordering is testable without a live `AppState`.
fn ordered_with_default_first(kinds: &[&str], default: &str) -> Vec<String> {
    let mut ordered = vec![default.to_string()];
    ordered.extend(kinds.iter().filter(|k| **k != default).map(|k| k.to_string()));
    ordered
}

/// The agent kind every "start an agent" path falls back to when the caller
/// named none: `config.default_agent`, or `"claude"`.
///
/// One function rather than the same `unwrap_or_else` expression copied
/// into five places, because the frontend now depends on those five places
/// agreeing. The start-agent-anywhere round unified the UI's language so a
/// repo with no herdr workspace offers the same "Start agent…" action as
/// one that has a workspace already; the confirm sheet it opens prints
/// `agent.start name="<x>"`, where `<x>` comes from `agent_kinds()[0]`, and
/// promises `found_settlement` will start THAT agent. Those are two
/// separate commands reading the same config. If their fallbacks ever
/// drifted apart, the one screen whose whole job is to name the exact call
/// before it runs (spec §5.6) would name a different one — which is why
/// `every_start_an_agent_path_resolves_the_same_default_agent` pins it
/// against the real functions rather than against a mocked `invoke`.
fn default_agent(config: &crate::config::Config) -> String {
    config.default_agent.clone().unwrap_or_else(|| "claude".to_string())
}

/// The agent kinds this herdr accepts, with the user's configured default
/// (`default_agent`, above) moved to the front, so the UI can preselect the
/// kind that will actually run rather than whatever sorts first in
/// `AGENT_KINDS`.
#[tauri::command]
pub async fn agent_kinds(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(ordered_with_default_first(AGENT_KINDS, &default_agent(&state.config)))
}

/// Resume-argument defaults verified directly against this machine's
/// installed CLIs (`claude --help`, `codex --help`, 2026-09-18) — see
/// `config::Config::resume_args`'s doc comment for why the other 19 kinds
/// `AGENT_KINDS` lists are deliberately absent rather than guessed: which
/// flag a tool accepts is knowledge about that tool, and a wrong guess would
/// silently start a fresh session while `resumable_agent_kinds` told the UI
/// it genuinely resumes.
///
/// `codex`'s entry is a positional SUBCOMMAND (`codex resume`), not a flag —
/// `herdr agent start`'s trailing `args` are passed straight through to the
/// executable positionally, so this map holds exactly the argv tail each
/// tool expects, whatever shape that is for that tool.
fn builtin_resume_args() -> HashMap<String, Vec<String>> {
    let mut map = HashMap::new();
    map.insert("claude".to_string(), vec!["--resume".to_string()]);
    map.insert("codex".to_string(), vec!["resume".to_string()]);
    map
}

/// The trailing args to pass to `agent.start` to resume `kind`'s existing
/// conversation, or `None` if this app does not (yet) know how.
///
/// A user's own `~/.age-of-agents/config.json` `resume_args` entry for
/// `kind` always wins over the built-in default for that same kind — so a
/// wrong guess is correctable, and a kind this app couldn't verify is
/// addable, without a rebuild.
fn resume_args_for(config: &crate::config::Config, kind: &str) -> Option<Vec<String>> {
    if let Some(args) = config.resume_args.as_ref().and_then(|overrides| overrides.get(kind)) {
        return Some(args.clone());
    }
    builtin_resume_args().get(kind).cloned()
}

/// Which of `AGENT_KINDS` have a known resume invocation right now (built-in
/// defaults plus the user's own config overrides/additions), in
/// `AGENT_KINDS`'s own order.
///
/// This exists so the frontend can offer a "resume" control only where it
/// will genuinely do what it says — the same honesty discipline as naming
/// the real default agent in `UnsettledReport` rather than assuming
/// `"claude"`. A kind absent from this list can still be started fresh via
/// `start_agent(resume: false)`; it just cannot honestly claim to resume
/// anything yet.
#[tauri::command]
pub async fn resumable_agent_kinds(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(AGENT_KINDS
        .iter()
        .filter(|kind| resume_args_for(&state.config, kind).is_some())
        .map(|k| k.to_string())
        .collect())
}

/// Finds an existing pane belonging to `repo` (by the same canonical-cwd
/// matching `existing_workspace_for` uses) that herdr has detected no agent
/// in yet — `AgentStatus::Unknown` — AND that this app itself created, AND
/// that is not the pane the user is currently looking at.
///
/// IMPORTANT 1 — this used to accept ANY pane herdr reported as `Unknown`.
/// But `Unknown` means "no agent detected", and `island.agents` contains
/// EVERY pane herdr sees for a repo (`world::attention::build_world` pushes
/// one `IslandAgent` per snapshot pane, not only ones with a detected
/// agent) — including a plain login shell the author opened by hand and is
/// sitting at a prompt in. `Unknown` is also exactly what a freshly founded
/// workspace's root pane reports immediately after `workspace.create` and
/// before any `agent.start` (confirmed live against Herdr 0.8.0), which is
/// the ONLY case this reuse path is meant to catch. Before this fix, "start
/// another agent" could launch `claude` directly into a terminal the author
/// was mid-command in — a real intrusion into a shell the user controls,
/// violating principle 1.
///
/// Two conditions now gate reuse, both required:
/// - `app_created_panes.contains(&agent.pane_id)` — this exact pane id was
///   returned by OUR OWN `herdr::launch::create_workspace` at some point in
///   this process's lifetime (see `AppState.app_created_panes`'s doc
///   comment for the residual risk of herdr reusing a pane id, and why it is
///   accepted). A pane the user opened themselves was never returned by that
///   call and can never be in this set.
/// - `world.focused_pane_id != Some(agent.pane_id)` — even a pane THIS app
///   created is never reused while the user is actively looking at it. The
///   author may well be typing into a freshly founded pane by hand before an
///   agent ever starts in it; seizing the terminal they are currently
///   focused on is exactly the intrusion this whole fix exists to prevent,
///   regardless of who originally created the pane.
///
/// `None` means no such pane exists — either because every app-created pane
/// for this repo is occupied by a detected agent, the repo has no
/// app-created workspace at all yet, or the only candidate is the one the
/// user is currently focused on. Every one of those cases means the same
/// thing to the caller: found a brand new workspace. Better an extra
/// workspace than an intrusion into a terminal the author is using.
fn idle_pane_for(
    world: &WorldState,
    repo: &Path,
    app_created_panes: &HashSet<String>,
) -> Option<String> {
    let canonical_repo = normalize_path(repo);
    world
        .islands
        .iter()
        .flat_map(|island| island.agents.iter())
        .find(|agent| {
            cwd_settles(&agent.cwd, &canonical_repo)
                && agent.status == AgentStatus::Unknown
                && app_created_panes.contains(&agent.pane_id)
                && world.focused_pane_id.as_deref() != Some(agent.pane_id.as_str())
        })
        .map(|agent| agent.pane_id.clone())
}

/// Starts a new agent for an existing repository, additively: unlike
/// `found_settlement` (which refuses a second workspace for an
/// already-founded repo), this command's whole job is to make ANOTHER agent
/// exist for `root`, and always tries to succeed at that rather than
/// refusing on "already settled".
///
/// Reuses `foundable_label` (validation + workspace label) and
/// `herdr::launch::create_workspace`/`start_agent` exactly as
/// `found_settlement` does; `partial_failure_message` is reused verbatim for
/// the one outcome that must not be misread — a freshly founded workspace
/// existing in herdr even though the agent inside it failed to start.
///
/// `resume: true` asks for the kind's own resume invocation
/// (`resume_args_for`) as trailing `agent.start` args; if this app does not
/// know one for the resolved kind, this refuses outright rather than
/// silently starting a fresh session while claiming to resume — the same
/// class of quiet dishonesty `resumable_agent_kinds` exists to prevent the
/// UI from offering in the first place.
#[tauri::command]
pub async fn start_agent(
    state: tauri::State<'_, AppState>,
    root: String,
    kind: Option<String>,
    resume: bool,
) -> Result<String, String> {
    let repo = PathBuf::from(&root);
    // ALSO FIX IF CHEAP: moved onto the blocking pool, same reasoning as
    // `found_settlement`'s identical call.
    let label = {
        let repo = repo.clone();
        tauri::async_runtime::spawn_blocking(move || foundable_label(&repo))
            .await
            .map_err(|e| e.to_string())??
    };
    let kind = resolved_kind(&state.config, kind);

    let args = if resume {
        resume_args_for(&state.config, &kind).ok_or_else(|| {
            format!(
                "{kind} has no known resume invocation — add one under \"resume_args\" in \
                 ~/.age-of-agents/config.json (e.g. {{\"{kind}\": [\"--resume\"]}}), or start a \
                 fresh agent instead"
            )
        })?
    } else {
        Vec::new()
    };

    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);

    // Before anything is created — same ordering, and the same reason, as
    // `found_settlement`. This path is where the author's SECOND report
    // came from ("agent did not start in pane w2N:p1: herdr error
    // agent_name_taken"), which is also the recovery route out of an
    // orphaned workspace, so it is exactly as load-bearing as founding.
    let name = resolve_agent_name(&socket, &repo).await?;

    let idle_pane = {
        let world = state.world.lock().unwrap();
        let created = state.app_created_panes.lock().unwrap();
        idle_pane_for(&world, &repo, &created)
    };

    let (pane_id, created_workspace) = match idle_pane {
        Some(pane_id) => (pane_id, None),
        None => {
            let founded = crate::herdr::launch::create_workspace(&socket, &repo, &label)
                .await
                .map_err(|e| e.to_string())?;
            // IMPORTANT 1: remember this pane as one WE minted, so a later
            // `start_agent` call for this same repo may reuse it.
            state.app_created_panes.lock().unwrap().insert(founded.pane_id.clone());
            (founded.pane_id, Some(founded.workspace_id))
        }
    };

    let start_result =
        crate::herdr::launch::start_agent(&socket, &pane_id, &name, &kind, &args).await;

    match (start_result, created_workspace) {
        (Ok(()), _) => Ok(pane_id),
        // Same linchpin as `found_settlement`: the workspace EXISTS in herdr
        // regardless of whether the agent inside it started.
        (Err(e), Some(workspace_id)) => {
            Err(partial_failure_message(&workspace_id, &label, &e.to_string()))
        }
        // No workspace was created this call (an existing idle pane was
        // reused), so there is no orphan to name — but the pane and the
        // workspace around it are still there, untouched, and saying so is
        // the difference between "this failed and left a mess" and "this
        // failed and changed nothing."
        (Err(e), None) => Err(format!(
            "agent did not start in pane {pane_id}: {e} — that pane and its workspace are \
             unchanged"
        )),
    }
}

/// Validates a would-be project directory NAME for `create_project`: refuses
/// an empty name, a name containing a path separator (which would let
/// `parent.join(name)` name something other than a direct child of
/// `parent`), and a name containing `..` (a traversal component even
/// without a separator, e.g. the literal name `..`) — "refuse rather than
/// guess", applied to a name the caller invents rather than an existing
/// path, which is why this is a separate check from `foundable_label`.
fn validate_project_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("project name must not be empty".to_string());
    }
    if name.contains('/') || name.contains(std::path::MAIN_SEPARATOR) {
        return Err(format!("project name {name:?} must not contain a path separator"));
    }
    if name.contains("..") {
        return Err(format!("project name {name:?} must not contain \"..\""));
    }
    Ok(())
}

/// Validates `parent` for `create_project`: it must exist and must be a
/// directory. Checked before anything is created — `create_project`'s
/// "refuse rather than guess" contract depends on every refusal happening
/// before the first filesystem write.
fn validate_parent_dir(parent: &Path) -> Result<(), String> {
    if !parent.exists() {
        return Err(format!("{} does not exist", parent.display()));
    }
    if !parent.is_dir() {
        return Err(format!("{} is not a directory", parent.display()));
    }
    Ok(())
}

/// Runs `git init -q .` in `dir`, bounded by the same
/// `world::repo::run_with_timeout` every other git subprocess call in this
/// app is bounded by — a stalled credential helper or a stuck filesystem
/// must not hang the blocking-pool thread `create_project` runs this on
/// forever.
///
/// Deliberately NOT added to `world::repo`'s `GitProbe` trait or `RealGit`:
/// that type is a read-only PROBE consumed by `RepoResolver` on the herdr
/// event loop's own hot path, reused across every polling tick for every
/// repo the user has — its whole contract, spelled out in its own docs, is
/// read-only. `git init` is a one-shot, user-triggered WRITE that runs
/// exactly once per founded project. Bolting a write onto a type whose
/// entire point is "read-only by design" would blur the very line those docs
/// draw, for no benefit: the bounded-subprocess mechanism that write
/// actually needs (`run_with_timeout`) is already `pub(crate)` and reusable
/// as-is, without touching `GitProbe`/`RealGit` at all.
fn git_init(dir: &Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(["init", "-q", "."]).current_dir(dir);
    let output = crate::world::repo::run_with_timeout(cmd, std::time::Duration::from_secs(10))
        .ok_or_else(|| {
            "git init could not be started (missing directory or missing `git`?) or did not \
             complete within 10s"
                .to_string()
        })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// What `create_project` returns: the new project's canonical path, plus
/// (IMPORTANT 4) an honest answer to "will the archipelago actually show
/// this".
#[derive(serde::Serialize)]
pub struct CreatedProject {
    /// The new project's canonical path. This is everything the command used
    /// to return bare.
    pub path: String,
    /// `None` when the SAME discovery scan `list_unsettled`/
    /// `get_archipelago` use will find this project, so it will appear as an
    /// island. `Some(reason)` when the project was founded successfully in
    /// full — directory, git repo, herdr workspace, and (if requested) an
    /// agent all real and running — but this scan will NOT find it, so the
    /// archipelago will never draw an island for it: a villager with no
    /// land. See `discoverability_check`'s doc comment for why this is
    /// checked rather than silently widened.
    pub undiscoverable_reason: Option<String>,
}

/// After founding, checks whether `target` is reachable by the SAME
/// discovery scan `list_unsettled`/`get_archipelago` use (`discovery_plan` +
/// `scan_roots`) — the check IMPORTANT 4 exists for.
///
/// `scan_roots` is unbounded (Phase 0.5b: the old depth cap made 79 of the
/// author's 152 real repositories invisible with no indication anything was
/// skipped — see that function's doc comment), so a `parent` several levels
/// below a scan root is no longer a way to fail this check. Two ways remain:
/// `scan_one` never descends into a directory that is already a repo (a real
/// subdirectory the reviewer found on this machine,
/// `~/Projects/PhotoStudio/photo-workspace`, sits inside one), and `target`
/// can simply be outside every root `discovery_plan` would ever scan (outside
/// every configured `project_roots` entry, or — with no config — outside
/// every directory this user demonstrably keeps code in and outside home
/// itself). Either way, `build_archipelago` — which deliberately does not
/// consult `WorldState` (see its own doc comment) — would never draw an
/// island for a directory, git repo, herdr workspace and running agent that
/// are all real. Telling the truth about what already happened (principle 4)
/// is the honest option actually on offer.
fn discoverability_check(
    config: &crate::config::Config,
    home: &Path,
    settled_roots: &[String],
    target: &Path,
) -> Option<String> {
    let roots = discovery_plan(config, home, settled_roots);
    let scanned = scan_roots(&roots);
    if scanned.iter().any(|p| p == target) {
        return None;
    }
    let roots_display: Vec<String> = roots.iter().map(|r| r.display().to_string()).collect();
    Some(format!(
        "{} was founded successfully, but the app's current project scan (looked in: {}) will not \
         find it — it will not appear on the archipelago until you move it under a scanned root, \
         add its parent to \"project_roots\" in ~/.age-of-agents/config.json, or open it directly",
        target.display(),
        roots_display.join(", "),
    ))
}

/// Founds a brand-new project: creates `parent/name`, `git init`s it, and
/// founds a herdr workspace there — optionally starting an agent, reusing
/// the exact same `create_workspace` + `agent.start` pair `found_settlement`
/// and `start_agent` already use. Returns the new project's canonical path
/// plus (IMPORTANT 4) whether the archipelago will actually be able to find
/// it.
///
/// HONESTY REQUIREMENT, sharper here than anywhere else in this file: this
/// command's whole job is to write to the user's real filesystem, so every
/// validation (`validate_project_name`, `validate_parent_dir`, the
/// already-exists check below) runs BEFORE the first write, and every
/// failure AFTER that first write says exactly what already happened — a
/// half-created project the user does not know about is worse than a clean
/// failure.
///
/// Deliberately does NOT try to delete `target` if a later step fails: an
/// automatic rollback is itself another write, one that can itself fail,
/// and on balance the honest choice is to leave what was actually created
/// exactly where the error says it is, for the user to inspect or remove
/// themselves — not to make it quietly disappear again without them having
/// seen it. `create_dir` (not `create_dir_all`) is used for the same reason
/// `git_init` is bounded: this command's job is to create exactly one new
/// directory, no more, no less, and `parent` is already required to exist.
///
/// No initial commit. An empty repository is itself honest — nothing is
/// asserted about content that does not exist — and the user may have their
/// own conventions (a `.gitignore` template, a license, a first commit
/// message style, a monorepo scaffold) that a fabricated "init" commit would
/// only get in the way of. Argued the other way: a repo with zero commits
/// cannot yet be given a herdr `last_commit_epoch` (`RealGit::last_commit_
/// epoch` already returns `None` for that, honestly) and cannot be branched
/// from — but neither is a reason to invent content on the user's behalf,
/// and both resolve themselves the moment the user (or an agent they start)
/// makes their own first commit.
#[tauri::command]
pub async fn create_project(
    state: tauri::State<'_, AppState>,
    parent: String,
    name: String,
    start_agent: bool,
    kind: Option<String>,
) -> Result<CreatedProject, String> {
    // ALSO FIX IF CHEAP: `validate_project_name`/`validate_parent_dir` (an
    // `.exists()`/`.is_dir()` pair) and the canonicalize+exists check below
    // used to run directly on the async task, before the ONE spawn_blocking
    // this command made (for `create_dir`+`git init`). All of it now runs on
    // the blocking pool together — an unresponsive mount must not stall the
    // tokio task that also owns the herdr event loop, for a refusal check
    // any more than for the write itself.
    //
    // Everything in this closure is a pure refusal check or the actual first
    // write; nothing is written before `validate_project_name`/
    // `validate_parent_dir`/the already-exists check all pass.
    let target = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        validate_project_name(&name)?;
        let parent_path = PathBuf::from(&parent);
        validate_parent_dir(&parent_path)?;

        // Canonical BEFORE the join: `parent` is real and a directory (just
        // validated), so this is a genuine canonicalization, not the
        // fallback branch. `name` was just proven to contain no separator
        // and no `..`, so `join` cannot name anything other than a direct
        // child of `canonical_parent` — `git_init` below can never run
        // outside `parent`.
        let canonical_parent = normalize_path(&parent_path);
        let target = canonical_parent.join(&name);
        if target.exists() {
            return Err(format!("{} already exists — refusing to overwrite it", target.display()));
        }

        // ---- everything above is a pure refusal check; nothing has been
        // written yet. From here on, every failure must say what already
        // happened. ----
        std::fs::create_dir(&target)
            .map_err(|e| format!("could not create {}: {e}", target.display()))?;
        git_init(&target).map_err(|e| {
            format!(
                "created {} but `git init` failed: {e} — the directory exists but is not (yet) \
                 a git repository",
                target.display()
            )
        })?;
        Ok(target)
    })
    .await
    .map_err(|e| e.to_string())??;

    let kind = resolved_kind(&state.config, kind);
    let canonical_target = normalize_path(&target);
    let label = canonical_target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let home = dirs::home_dir().ok_or_else(|| {
        format!(
            "created {} and ran git init, but could not find a home directory to reach herdr — \
             the project exists on disk with no herdr workspace",
            canonical_target.display()
        )
    })?;
    let socket =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);

    // Read-only, and before `workspace.create`, exactly as in the other two
    // paths. The directory and its `git init` already happened by this
    // point, so the failure text has to keep saying so.
    let agent_name = if start_agent {
        Some(resolve_agent_name(&socket, &canonical_target).await.map_err(|e| {
            format!(
                "created {} and ran git init, but {e} — the project exists on disk with no \
                 herdr workspace",
                canonical_target.display()
            )
        })?)
    } else {
        None
    };

    let founded = crate::herdr::launch::create_workspace(&socket, &canonical_target, &label)
        .await
        .map_err(|e| {
            format!(
                "created {} and ran git init, but founding a herdr workspace failed: {e} — the \
                 project exists on disk with no herdr workspace",
                canonical_target.display()
            )
        })?;
    // IMPORTANT 1: minted by our own `workspace.create`, so `idle_pane_for`
    // may legitimately reuse it for a later `start_agent` on this same repo.
    state.app_created_panes.lock().unwrap().insert(founded.pane_id.clone());

    if let Some(name) = &agent_name {
        crate::herdr::launch::start_agent(&socket, &founded.pane_id, name, &kind, &[])
            .await
            .map_err(|e| {
                format!(
                    "created {} and founded workspace {} ({label}), but the agent did not \
                     start: {e} — both were left in place, not removed",
                    canonical_target.display(),
                    founded.workspace_id
                )
            })?;
    }

    // IMPORTANT 4: the project is fully founded at this point — verify the
    // archipelago will actually be able to find it, and say so plainly in
    // the result rather than letting a villager end up with no land, silently.
    let config = state.config.clone();
    let settled_roots: Vec<String> = {
        let world = state.world.lock().unwrap();
        world.islands.iter().map(|island| island.root.clone()).collect()
    };
    let target_for_scan = canonical_target.clone();
    let undiscoverable_reason = tauri::async_runtime::spawn_blocking(move || {
        discoverability_check(&config, &home, &settled_roots, &target_for_scan)
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(CreatedProject {
        path: canonical_target.to_string_lossy().to_string(),
        undiscoverable_reason,
    })
}

/// Reveals `path` in the system file manager — Finder on macOS, Explorer on
/// Windows — selecting it there rather than merely opening its parent
/// directory or opening the file itself with its default app.
///
/// This is a genuine reveal, not "open" wearing a reveal's name:
/// `tauri_plugin_opener::reveal_item_in_dir` (checked against the plugin's
/// own source, `tauri-plugin-opener-2.5.5/src/reveal_item_in_dir.rs`) calls
/// macOS's `NSWorkspace activateFileViewerSelecting:` (and the platform
/// equivalents on Windows/Linux) — the same mechanism as Finder's own
/// "Reveal in Finder", not `open_path`'s "hand this to the default
/// application". The plugin was registered but unused before this task
/// (`lib.rs`'s existing comment on `tauri_plugin_opener::init()`); this is
/// its first real caller.
///
/// Runs on a blocking-pool thread: the call canonicalizes the path (a
/// filesystem operation) and then talks to the OS's file manager
/// synchronously — neither belongs on the async runtime's own worker
/// thread.
#[tauri::command]
pub async fn reveal_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let normalized = normalize_path(Path::new(&path));
        tauri_plugin_opener::reveal_item_in_dir(&normalized)
            .map_err(|e| format!("failed to reveal {}: {e}", normalized.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Raises the terminal for a repository's herdr workspace, without
/// targeting any specific pane inside it — the island-level equivalent of
/// `focus_pane`'s pane-level focus, for a click on the island itself rather
/// than on one of its villagers.
///
/// Reuses `existing_workspace_for` (the exact canonical-cwd lookup
/// `found_settlement`'s idempotency guard already uses) to find the
/// workspace, herdr's `workspace.focus` (already on the permitted write
/// surface) to raise it in herdr, and `raise_terminal` (this file, shared
/// with `jump_to_next`/`focus_pane`) to raise the terminal app itself.
///
/// A repository that already has several workspaces (possible since
/// `start_agent` above) has no one canonical "the" workspace; this picks
/// the first one `existing_workspace_for` finds, the same pick-first
/// convention `jump_target` already uses when an island has more than one
/// agent, rather than inventing a new rule for this command alone.
#[tauri::command]
pub async fn focus_workspace(state: tauri::State<'_, AppState>, root: String) -> Result<(), String> {
    let repo = PathBuf::from(&root);
    let workspace_id = {
        let world = state.world.lock().unwrap();
        existing_workspace_for(&world, &repo)
    }
    .ok_or_else(|| format!("{} has no herdr workspace", normalize_path(&repo).display()))?;

    let home = dirs::home_dir().ok_or("no home directory")?;
    let path =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
    let client = crate::herdr::client::HerdrClient::connect(&path)
        .await
        .map_err(|e| e.to_string())?;
    client
        .call("workspace.focus", serde_json::json!({ "workspace_id": workspace_id }))
        .await
        .map_err(|e| e.to_string())?;

    raise_terminal(&state.config);
    Ok(())
}

/// The longest prompt `send_prompt` will submit, in `char`s. Arbitrarily
/// generous but finite: long enough for any prompt a human plausibly
/// composes and edits by hand in the confirm box (multi-paragraph
/// instructions, a pasted stack trace, a chunk of a log file), short enough
/// to refuse a pasted multi-megabyte blob outright rather than silently
/// forwarding it into a terminal. Refusing loudly here, with a reason the
/// user can act on, is strictly better than letting herdr (or the agent's
/// own CLI) choke on it later with a far less legible failure — the "decide
/// and document sane behaviour" half of IMPORTANT 3's length concern.
const MAX_PROMPT_CHARS: usize = 20_000;

/// On embedded newlines, deliberately: `text` is passed to herdr's
/// `agent.prompt` as ONE value in ONE JSON-RPC call — this app never splits
/// it, never loops, and never issues a second call based on its contents.
/// `agent.prompt` is Herdr's own submission primitive specifically BECAUSE it
/// has defined submission semantics rather than being raw keystroke
/// injection (see this function's other doc comment); whether herdr's own
/// implementation treats an embedded `\n` as part of the message or as an
/// intermediate submit is Herdr's documented behaviour to change, not a
/// choice this app makes by chunking `text` itself. "No chains, no
/// auto-retry" (spec §5.6) is therefore unconditionally true of this
/// function's own behaviour regardless of what `text` contains; the length
/// cap above is this app's actual lever for "refuse rather than do something
/// surprising with a giant paste".
fn validate_prompt_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("prompt must not be empty".to_string());
    }
    let len = text.chars().count();
    if len > MAX_PROMPT_CHARS {
        return Err(format!(
            "prompt is too long ({len} characters; the limit is {MAX_PROMPT_CHARS}) — shorten it \
             and send again"
        ));
    }
    Ok(())
}

/// Refuses to act on a pane before any herdr connection is attempted, so the
/// pure decision is testable without a live herdr (in the same spirit as
/// `jump_target`/`existing_workspace_for`/`idle_pane_for` above). Shared by
/// every command that touches a specific pane — `send_prompt`, `pane_read`,
/// `pane_send_text`, and `pane_send_keys` — so there is exactly one place
/// that decides whether a pane id is safe to act on, not one copy per write.
///
/// IMPORTANT 3: validates `pane_id` against the CURRENT world (see
/// `find_live_pane`'s doc comment — herdr reuses `w<N>:p1`-style ids once a
/// workspace closes, so a stale id must never be silently delivered to
/// whatever agent now sits behind it) and, when the caller names the
/// repository they aimed the action at (`expected_root` — the frontend's own
/// `Island.root` for whichever island the user clicked into), refuses if the
/// pane no longer belongs to it. The user aimed an action at an island, and
/// that intent is worth enforcing, not just the bare "does this pane exist".
///
/// This matters MORE for `pane_send_text`/`pane_send_keys` than it did for
/// `send_prompt`: a misdirected prompt lands as one message an agent reads;
/// misdirected keystrokes can edit a file, submit a form, or kill a process
/// in the wrong repository's session with no confirmation step at all — the
/// exact risk §5.6's Phase 0.7 section calls "considerably worse."
pub(crate) fn validate_live_pane(
    world: &WorldState,
    pane_id: &str,
    expected_root: Option<&str>,
) -> Result<(), String> {
    let (island, _agent) = find_live_pane(world, pane_id).ok_or_else(|| {
        format!(
            "{pane_id} is not a pane in the current world — it may have closed, and herdr can \
             reuse the id for a different agent"
        )
    })?;
    if let Some(expected) = expected_root {
        let expected_norm = normalize_path(Path::new(expected)).to_string_lossy().to_string();
        if island.root != expected_norm {
            return Err(format!(
                "{pane_id} now belongs to {}, not {expected_norm} — refusing to act on a pane \
                 aimed at a different repository",
                island.root
            ));
        }
    }
    Ok(())
}

/// `send_prompt`'s own validation: the shared pane-liveness/root check above,
/// plus the prompt-text-specific rules (`validate_prompt_text`) that have
/// nothing to do with any other pane command.
fn validate_send_prompt(
    world: &WorldState,
    pane_id: &str,
    text: &str,
    expected_root: Option<&str>,
) -> Result<(), String> {
    validate_prompt_text(text)?;
    validate_live_pane(world, pane_id, expected_root)
}

/// Submits `text` as a prompt to the agent in `pane_id`, via herdr's own
/// submission primitive `agent.prompt` — Phase 0.6's authorized widening of
/// the write surface (2026-09-18, the author: *"app can send to terminal,
/// but through us.. so yes sure"*). `pane.send_text` remains forbidden;
/// `agent.prompt` has defined submission semantics rather than being raw
/// keystroke injection, which is the entire reason this was authorized and
/// that one was not — see `herdr::launch::send_prompt`'s doc comment for why
/// this never asks herdr to `--wait` on a resulting state.
///
/// The user composes and sends every prompt themselves (§5.6): this command
/// is reached only from that one deliberate action, never something the app
/// originates on its own in response to an agent's state.
///
/// `expected_root` is optional (IMPORTANT 3) — pass the island's `root` the
/// prompt was composed for and a stale pane id that herdr has since reused
/// for a different repository is refused rather than delivered there. This
/// widens the command's signature; existing callers that omit it still get
/// the pane-liveness check, just not the repository cross-check.
#[tauri::command]
pub async fn send_prompt(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    text: String,
    expected_root: Option<String>,
) -> Result<(), String> {
    {
        let world = state.world.lock().unwrap();
        validate_send_prompt(&world, &pane_id, &text, expected_root.as_deref())?;
    }

    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
    crate::herdr::launch::send_prompt(&socket, &pane_id, &text)
        .await
        .map_err(|e| describe_herdr_failure("send the prompt to", &pane_id, &e))
}

/// Turns a `herdr::launch` failure into one short, human sentence for
/// display in the UI — never the technical detail itself, which is instead
/// logged (`eprintln!`, this codebase's existing convention — see e.g.
/// `herdr/events.rs`) for whoever needs to debug it. This is defect 2 from
/// the `read_agent` bug report: a serialized wire response, or even a bare
/// herdr error code, is not something a player of a game should ever see
/// inside an agent panel.
///
/// `send_prompt`, `read_agent`, `pane_read`, `pane_send_text`, and
/// `pane_send_keys` are all built on `herdr::launch` functions that open a
/// fresh connection and make exactly one `agent.*`/`pane.*` call, so they
/// share the same small set of ways that can fail: the named pane's agent
/// isn't there (`agent_not_found`), the pane itself is gone
/// (`pane_not_found` — reachable here despite `validate_live_pane` already
/// checking the pane against `WorldState`, if herdr closes it in the narrow
/// window between that check and this call landing), an unrecognized key
/// name in a `pane_send_keys` call (`invalid_key` — herdr validates every
/// key before writing any bytes, so this means NONE of the keys in that
/// call were sent, not just the bad one), herdr observed no state change
/// from a `--wait`-style submission in time (`agent_prompt_stalled` — not
/// reachable today since `send_prompt` never asks herdr to wait, but
/// handled defensively since herdr owns that decision, not this app), the
/// call itself timed out or the connection dropped mid-flight, or (`
/// read_agent`/`pane_read` only) the response didn't have the shape this
/// app expects. Anything else falls back to a generic sentence naming the
/// pane and the attempted action rather than the raw cause.
fn describe_herdr_failure(action: &str, pane_id: &str, e: &anyhow::Error) -> String {
    eprintln!("herdr call failed ({action} {pane_id}): {e:#}");
    let detail = e.to_string();
    if detail.contains("agent_not_found") {
        format!("no agent found in {pane_id} anymore — it may have closed")
    } else if detail.contains("pane_not_found") {
        format!("{pane_id} isn't a live pane anymore — it may have closed")
    } else if detail.contains("invalid_key") {
        // herdr's own message names the specific bad key (e.g. "unsupported
        // key delete") — plain English naming the actual cause, not a raw
        // protocol code or JSON blob, so it is safe to surface as-is rather
        // than falling back to the generic sentence below.
        let message = detail.rsplit_once(": ").map(|(_, m)| m).unwrap_or("one of those keys");
        format!("herdr didn't recognize a key you sent to {pane_id}: {message}")
    } else if detail.contains("agent_prompt_stalled") {
        format!("{pane_id}'s agent didn't respond in time — it may still be busy")
    } else if detail.contains("timed out") {
        format!("herdr didn't respond in time for {pane_id} — is it still running?")
    } else if detail.contains("connection closed") || detail.contains("connection_closed") {
        "lost connection to herdr — is it still running?".to_string()
    } else if detail.contains("unexpected response shape") {
        format!("couldn't make sense of {pane_id}'s output — herdr sent back something unexpected")
    } else {
        format!("couldn't {action} {pane_id} right now")
    }
}

/// `read_agent`'s result. MINOR 5: this used to be a bare `String`, with the
/// truncation caveat spliced in-band as literal text ahead of the agent's
/// own output — indistinguishable, to the frontend, from something the agent
/// itself printed (and an agent COULD print that exact line). `truncated` is
/// now a structured field the UI renders itself, so the app's own words and
/// the untrusted agent's own words can never be confused for each other.
#[derive(serde::Serialize)]
pub struct ReadAgentResult {
    pub text: String,
    pub truncated: bool,
}

/// Reads back an agent's recent terminal output via the read-only
/// `agent.read`, Phase 0.6's other addition — for showing the user what an
/// agent has recently said without needing to raise the real terminal.
///
/// See `herdr::launch::read_agent`'s doc comment for why `source: "recent"`
/// and `strip_ansi: true` are used: `recent` (herdr's own CLI default)
/// rather than `visible` (only the current viewport) or `detection`
/// (herdr's internal heuristic text, not meant for display); `strip_ansi`
/// so the frontend is never handed raw escape codes to render — this app
/// owns no ANSI-rendering surface.
#[tauri::command]
pub async fn read_agent(pane_id: String, lines: Option<u32>) -> Result<ReadAgentResult, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
    let read = crate::herdr::launch::read_agent(&socket, &pane_id, lines)
        .await
        .map_err(|e| describe_herdr_failure("read", &pane_id, &e))?;

    if read.truncated {
        // Logged rather than silently showing a clipped transcript as though
        // it were complete (the bug report's ask) — the caveat itself now
        // travels to the frontend as the `truncated` field below, never
        // spliced into `text`. `revision` isn't used for anything yet beyond
        // this log line — kept for a possible future live-tail that polls
        // `agent.read` and compares revisions.
        eprintln!(
            "read_agent: {pane_id} response was truncated at revision {}",
            read.revision
        );
    }

    Ok(ReadAgentResult { text: read.text, truncated: read.truncated })
}

/// `pane_read`'s result. Same three structured fields as `ReadAgentResult`
/// plus `revision`, kept as its own type for the same reason
/// `herdr::launch::PaneRead` is kept distinct from `AgentRead` — see that
/// type's doc comment. `revision` is included here, structured, never
/// spliced into `text` — but see the IMPORTANT note on it below.
///
/// IMPORTANT — measured, not assumed: live-probed against Herdr 0.8.0
/// (the author's real `w27:p1`, and a throwaway workspace this session
/// created and closed), `revision` was `0` on every read regardless of
/// whether the pane's visible content had actually changed since the last
/// read. It is exposed here because it is part of the honest wire shape —
/// silently dropping a field herdr sends would be its own small dishonesty
/// — but the frontend mirror MUST decide whether to re-render by comparing
/// the returned `text` (and `truncated`) to what it last rendered, not by
/// comparing `revision`. See `herdr::launch::PaneRead`'s doc comment for
/// the full measurement and `herdr::launch::read_pane`'s for why `source:
/// "visible"` and unstripped ANSI were chosen for this call.
#[derive(serde::Serialize)]
pub struct PaneReadResult {
    pub text: String,
    pub revision: u64,
    pub truncated: bool,
}

/// Reads the current screen of a pane via the read-only `pane.read` —
/// Phase 0.7's interactive-terminal mirror (§5.6). This is the one call an
/// embedded terminal's poll loop repeats: connect, read, compare `text` to
/// what was last rendered, re-render only on a difference, disconnect.
/// There is no push/stream primitive in herdr's socket API for pane
/// content (verified against the bundled API schema — `herdr api schema`
/// lists only `pane_output_matched` (requires a specific match pattern,
/// not "anything changed"), `pane_agent_status_changed`, and
/// `pane_scroll_changed` as subscribable pane events), so polling this
/// command is the actual mechanism, not a placeholder for a nicer one —
/// see this app's terminal-backend report for the measured per-call cost
/// and the polling interval chosen.
///
/// IMPORTANT 3, same as `send_prompt`/`focus_pane`: `pane_id` is validated
/// against the live `WorldState` before any herdr call, and `expected_root`
/// (optional — the frontend's `Island.root` for whichever island's terminal
/// is open) is checked when given, via the shared `validate_live_pane`.
/// This is a read, so a stale/reused id here cannot inject anything into
/// the wrong pane — but it can still show the user someone else's terminal
/// output under a title that says otherwise, which the terminal surface
/// must never do (§5.6: "the user can always see where their keys are
/// going").
#[tauri::command]
pub async fn pane_read(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    expected_root: Option<String>,
) -> Result<PaneReadResult, String> {
    {
        let world = state.world.lock().unwrap();
        validate_live_pane(&world, &pane_id, expected_root.as_deref())?;
    }

    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
    let read = crate::herdr::launch::read_pane(&socket, &pane_id)
        .await
        .map_err(|e| describe_herdr_failure("read", &pane_id, &e))?;

    Ok(PaneReadResult { text: read.text, revision: read.revision, truncated: read.truncated })
}

/// The most scrollback lines this app will ask herdr for in one
/// `pane_read_scrollback`. 2000 rows is roughly 85 screens of a 23-row
/// pane — more history than anyone scrolls back through in a sitting, and
/// a bound rather than herdr's own unbounded default, because this text
/// is rendered whole into the DOM and an unbounded answer from a pane that
/// has been running for a week would be a browser-sized problem, not a
/// terminal-sized one. `truncated` comes back from herdr when the answer
/// hit a limit and the frontend says so out loud.
const MAX_SCROLLBACK_LINES: u32 = 2000;

/// Reads a pane's SCROLLBACK (`pane.read` with `source: "recent"`) — the
/// terminal-feel round's half of "the terminal cannot be scrolled".
///
/// Read-only, the same tier and the same `validate_live_pane` check as
/// `pane_read`, and deliberately a SEPARATE command rather than a
/// parameter on it: `pane_read` is the live mirror the poll loop calls at
/// one-frame intervals while someone types, and nothing on that path
/// should be able to ask for a 2000-line answer by passing the wrong
/// argument. This one is called only when the user actually scrolls.
///
/// What it is FOR, measured (see `herdr::launch::read_pane_recent`): a
/// shell pane that has scrolled returns real scrollback here (141 lines
/// against `visible`'s 23), and a pane running a full-screen program —
/// every one of the author's live `claude` panes — returns exactly the
/// visible screen, because the alternate screen has no scrollback. The
/// frontend compares the two and tells the user which case it is in
/// rather than silently doing nothing.
#[tauri::command]
pub async fn pane_read_scrollback(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    expected_root: Option<String>,
) -> Result<PaneReadResult, String> {
    {
        let world = state.world.lock().unwrap();
        validate_live_pane(&world, &pane_id, expected_root.as_deref())?;
    }

    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
    let read = crate::herdr::launch::read_pane_recent(&socket, &pane_id, MAX_SCROLLBACK_LINES)
        .await
        .map_err(|e| describe_herdr_failure("read the scrollback of", &pane_id, &e))?;

    Ok(PaneReadResult { text: read.text, revision: read.revision, truncated: read.truncated })
}

/// Reads the system clipboard as text — the paste half of the terminal-feel
/// round, and a genuinely new capability, so it is worth being explicit
/// about what it is and is not.
///
/// It is called from exactly one place: the embedded terminal's own
/// `keydown` handler, when the user presses ⌘V on a focused terminal
/// surface. The app never reads the clipboard on its own — not on mount,
/// not on a timer, not when a pane changes state. The returned text is
/// handed straight back to the frontend, which sends it with the ordinary
/// `pane_send_text` the user's own typing already uses; nothing here sends
/// anything, so the read and the write stay two separately audited steps.
///
/// WHY IT IS IN RUST AT ALL. The web `navigator.clipboard.readText()` is
/// the obvious answer and is not a reliable one inside a Tauri WKWebView:
/// the Clipboard API needs a secure context the custom `tauri://` scheme
/// does not straightforwardly provide, and WebKit gates clipboard reads
/// behind a permission prompt of its own. A paste that sometimes silently
/// does nothing is worse than no paste, and this is the daily operation of
/// someone who uses this terminal for real work. So the read goes through
/// the platform, via `tauri-plugin-clipboard-manager`, where it either
/// works or returns an error this command turns into a sentence.
///
/// The plugin is registered in `lib.rs` but is deliberately NOT granted to
/// the frontend in `capabilities/default.json`: the webview cannot invoke
/// the plugin's own commands, only this one, which is the app's own audited
/// surface.
#[tauri::command]
pub fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .read_text()
        .map_err(|e| format!("could not read the clipboard: {e}"))
}

fn validate_clipboard_write(text: &str) -> Result<(), String> {
    if text.is_empty() { return Err("Select terminal output to copy.".into()); }
    if text.len() > 1024 * 1024 { return Err("Selection exceeds the 1 MiB clipboard limit. Select a smaller section.".into()); }
    Ok(())
}

/// Copies output explicitly selected by the user. The frontend calls this only
/// after a completed selection within a terminal, never on incoming frames.
#[tauri::command]
pub fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    validate_clipboard_write(&text)?;
    app.clipboard().write_text(text).map_err(|e| format!("could not copy the selection: {e}"))
}

#[cfg(test)]
mod clipboard_write_tests {
    use super::validate_clipboard_write;

    #[test]
    fn selected_output_is_bounded_by_bytes_without_altering_whitespace() {
        assert!(validate_clipboard_write("  selected output\n").is_ok());
        assert!(validate_clipboard_write(&"é".repeat(524_288)).is_ok());
        assert!(validate_clipboard_write(&"é".repeat(524_289)).is_err());
        assert!(validate_clipboard_write("").is_err());
    }
}

/// The longest single `pane_send_text` payload this app will forward, in
/// `char`s. Same reasoning as `MAX_PROMPT_CHARS`: generous enough for any
/// real paste into a terminal, finite enough to refuse a runaway multi-
/// megabyte blob outright rather than forwarding it byte-for-byte into a
/// pty. This is NOT content policing (§5.6 already draws that line: only
/// what the user actually typed or pasted is ever sent) — it is the same
/// "decide and document sane behaviour" instinct as the prompt cap.
const MAX_PANE_TEXT_CHARS: usize = 20_000;

fn validate_pane_text(text: &str) -> Result<(), String> {
    let len = text.chars().count();
    if len > MAX_PANE_TEXT_CHARS {
        return Err(format!(
            "that's too much text to send at once ({len} characters; the limit is \
             {MAX_PANE_TEXT_CHARS}) — send it in smaller pieces"
        ));
    }
    Ok(())
}

/// Sends literal text to a pane via the newly authorized `pane.send_text` —
/// Phase 0.7 (§5.6), for this purpose (a real interactive terminal) only.
/// Unlike `send_prompt`'s `agent.prompt`, this is raw keystroke injection
/// with no submission semantics of its own: it does not append Enter, does
/// not wait for anything, and does not know or care whether a pane holds an
/// agent, a shell, or anything else. That is exactly what a terminal
/// emulator's own "user typed a character" path looks like, which is the
/// entire justification for lifting the earlier prohibition — see §5.6's
/// Phase 0.7 section for the constraints this sits under: keystrokes must
/// travel only from a focused terminal surface, never synthesized by the
/// app itself.
///
/// `pane_id` is validated against the live `WorldState` (`validate_live_pane`)
/// before any herdr call, same as `send_prompt`/`pane_read` — considerably
/// more important here, per §5.6, because a stale or reused id delivering
/// prompts to the wrong agent is bad, but delivering raw keystrokes to the
/// wrong pane is worse: no submission semantics to fail loudly, just bytes
/// landing wherever the id now points.
#[tauri::command]
pub async fn pane_send_text(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    text: String,
    expected_root: Option<String>,
) -> Result<(), String> {
    {
        let world = state.world.lock().unwrap();
        validate_live_pane(&world, &pane_id, expected_root.as_deref())?;
    }
    validate_pane_text(&text)?;

    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
    crate::herdr::launch::send_text(&socket, &pane_id, &text)
        .await
        .map_err(|e| describe_herdr_failure("send text to", &pane_id, &e))
}

/// The most key names this app will forward in a single `pane_send_keys`
/// call. A real keypress (or a short chord like `ctrl+shift+p`) is one or
/// two names; a call carrying dozens is the app assembling something closer
/// to a macro than a keypress, which §5.6 forbids outright ("no macros, no
/// replay"). This caps the blast radius of a malformed frontend call rather
/// than trying to prove intent — the frontend is the thing that must never
/// synthesize input the user did not type.
const MAX_KEYS_PER_CALL: usize = 32;

fn validate_pane_keys(keys: &[String]) -> Result<(), String> {
    if keys.is_empty() {
        return Err("no keys given".to_string());
    }
    if keys.len() > MAX_KEYS_PER_CALL {
        return Err(format!(
            "too many keys in one call ({} keys; the limit is {MAX_KEYS_PER_CALL})",
            keys.len()
        ));
    }
    Ok(())
}

/// Sends key presses to a pane via the newly authorized `pane.send_keys` —
/// Phase 0.7's other write (§5.6). `keys` are herdr's own logical key names
/// (`"esc"`, `"ctrl+c"`, `"up"`, ...); herdr validates every name in the
/// call before writing any bytes, so an unrecognized key fails the whole
/// call rather than partially applying it (see `describe_herdr_failure`'s
/// `invalid_key` branch). This app's terminal-backend report lists the
/// specific key names verified live against Herdr 0.8.0.
///
/// Same `validate_live_pane` check as `pane_send_text`, for the same reason:
/// keystrokes must never land on a pane the frontend merely believes is
/// still the one the user is looking at.
#[tauri::command]
pub async fn pane_send_keys(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    keys: Vec<String>,
    expected_root: Option<String>,
) -> Result<(), String> {
    {
        let world = state.world.lock().unwrap();
        validate_live_pane(&world, &pane_id, expected_root.as_deref())?;
    }
    validate_pane_keys(&keys)?;

    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket =
        crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
    crate::herdr::launch::send_keys(&socket, &pane_id, &keys)
        .await
        .map_err(|e| describe_herdr_failure("send keys to", &pane_id, &e))
}

/// Defect 2 from the `read_agent` bug report, pinned down at the unit
/// level: whatever `herdr::launch` fails with, the sentence handed back to
/// the UI must read like English, never like a serialized wire response or
/// a bare herdr error code.
#[cfg(test)]
mod describe_herdr_failure_tests {
    use super::describe_herdr_failure;
    use anyhow::anyhow;

    fn assert_plain_sentence(msg: &str) {
        assert!(!msg.contains('{'), "leaked raw JSON: {msg}");
        assert!(!msg.contains("\"read\""), "leaked raw JSON: {msg}");
    }

    #[test]
    fn agent_not_found_reads_as_a_sentence() {
        let e = anyhow!("herdr error agent_not_found: agent target w27:p1 not found");
        let msg = describe_herdr_failure("read", "w27:p1", &e);
        assert_plain_sentence(&msg);
        assert!(msg.contains("w27:p1"));
    }

    #[test]
    fn agent_prompt_stalled_reads_as_a_sentence() {
        let e = anyhow!("herdr error agent_prompt_stalled: no state change observed");
        let msg = describe_herdr_failure("send the prompt to", "w2:p1", &e);
        assert_plain_sentence(&msg);
        assert!(msg.to_lowercase().contains("busy") || msg.to_lowercase().contains("respond"));
    }

    #[test]
    fn a_timeout_reads_as_a_sentence() {
        let e = anyhow!("herdr call `agent.read` timed out");
        let msg = describe_herdr_failure("read", "w16:p1", &e);
        assert_plain_sentence(&msg);
    }

    #[test]
    fn a_dropped_connection_reads_as_a_sentence() {
        let e = anyhow!("herdr connection closed while waiting for `agent.prompt` reply");
        let msg = describe_herdr_failure("send the prompt to", "w2:p1", &e);
        assert_plain_sentence(&msg);
    }

    #[test]
    fn an_unexpected_shape_never_leaks_the_response_it_describes() {
        // This is the literal failure from the bug report: the raw wire
        // response must never reach this string, only a description of it.
        let e = anyhow!("herdr agent.read returned an unexpected response shape");
        let msg = describe_herdr_failure("read", "w27:p1", &e);
        assert_plain_sentence(&msg);
    }

    #[test]
    fn an_unrecognized_failure_still_falls_back_to_a_sentence() {
        let e = anyhow!("No such file or directory (os error 2)");
        let msg = describe_herdr_failure("read", "w27:p1", &e);
        assert_plain_sentence(&msg);
        assert!(msg.contains("w27:p1"));
    }

    #[test]
    fn pane_not_found_reads_as_a_sentence() {
        let e = anyhow!("herdr error pane_not_found: pane w7:p1 not found");
        let msg = describe_herdr_failure("read", "w7:p1", &e);
        assert_plain_sentence(&msg);
        assert!(msg.contains("w7:p1"));
    }

    #[test]
    fn invalid_key_names_the_actual_bad_key_without_leaking_the_error_code() {
        // Verified live against Herdr 0.8.0: `herdr pane send-keys <pane>
        // delete` fails with exactly this code/message pair.
        let e = anyhow!("herdr error invalid_key: unsupported key delete");
        let msg = describe_herdr_failure("send keys to", "w7:p1", &e);
        assert_plain_sentence(&msg);
        assert!(msg.contains("delete"), "must name the actual bad key, got: {msg}");
        assert!(!msg.contains("invalid_key"), "must not leak the raw error code, got: {msg}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::snapshot::AgentStatus;
    use crate::world::state::WorldState;

    #[test]
    fn app_state_starts_disconnected() {
        let state = AppState::new();
        let world = state.world.lock().unwrap();
        assert!(!world.herdr_connected);
        assert!(world.islands.is_empty());
    }

    #[test]
    fn replacing_the_world_is_visible_to_readers() {
        let state = AppState::new();
        state.replace_world(WorldState {
            herdr_connected: true,
            herdr_version: "0.8.0".into(),
            protocol_mismatch: false,
            islands: vec![],
            focused_pane_id: None,
        });
        assert!(state.world.lock().unwrap().herdr_connected);
    }

    #[test]
    fn jump_target_picks_the_first_stopped_agent_in_the_island() {
        use crate::herdr::snapshot::AgentStatus;
        use crate::world::attention::Attention;
        use crate::world::state::{Island, IslandAgent};

        let island = Island {
            id: "/p/api".into(), name: "api".into(), root: "/p/api".into(),
            attention: Attention::Stopped,
            last_changed_at: None,
            agents: vec![
                IslandAgent { pane_id: "w1:p1".into(), workspace_id: "w1".into(),
                              status: AgentStatus::Working, attention: Attention::Working,
                              title: None, kind: None, is_worktree: false, cwd: "/p/api".into() },
                IslandAgent { pane_id: "w1:p2".into(), workspace_id: "w1".into(),
                              status: AgentStatus::Blocked, attention: Attention::Stopped,
                              title: None, kind: None, is_worktree: false, cwd: "/p/api".into() },
            ],
        };
        assert_eq!(jump_target(&island), Some("w1:p2".to_string()));
    }

    #[test]
    fn jump_target_picks_the_agent_that_is_itself_stopped() {
        use crate::herdr::snapshot::AgentStatus;
        use crate::world::attention::Attention;
        use crate::world::state::{Island, IslandAgent};

        let island = Island {
            id: "/p/api".into(), name: "api".into(), root: "/p/api".into(),
            attention: Attention::Stopped,
            last_changed_at: None,
            agents: vec![
                IslandAgent { pane_id: "w1:p1".into(), workspace_id: "w1".into(),
                    cwd: "/p/api".into(), status: AgentStatus::Working,
                    attention: Attention::Working, title: None, kind: None, is_worktree: false },
                // Promoted to Stopped by the sticky idle-after-work rule: neither
                // Blocked nor Done, so the old fallback would have missed it.
                IslandAgent { pane_id: "w1:p2".into(), workspace_id: "w1".into(),
                    cwd: "/p/api".into(), status: AgentStatus::Idle,
                    attention: Attention::Stopped, title: None, kind: None, is_worktree: false },
            ],
        };

        assert_eq!(jump_target(&island), Some("w1:p2".to_string()));
    }

    #[test]
    fn jump_target_never_prefers_a_working_agent_over_a_stopped_one() {
        use crate::herdr::snapshot::AgentStatus;
        use crate::world::attention::Attention;
        use crate::world::state::{Island, IslandAgent};

        let island = Island {
            id: "/p/api".into(), name: "api".into(), root: "/p/api".into(),
            attention: Attention::Stopped,
            last_changed_at: None,
            agents: vec![
                IslandAgent { pane_id: "w1:p1".into(), workspace_id: "w1".into(),
                    cwd: "/p/api".into(), status: AgentStatus::Working,
                    attention: Attention::Working, title: None, kind: None, is_worktree: false },
                IslandAgent { pane_id: "w1:p2".into(), workspace_id: "w1".into(),
                    cwd: "/p/api".into(), status: AgentStatus::Blocked,
                    attention: Attention::Stopped, title: None, kind: None, is_worktree: false },
            ],
        };

        assert_eq!(jump_target(&island), Some("w1:p2".to_string()));
    }

    #[test]
    fn jump_target_does_not_prefer_a_quiet_idle_agent_in_a_calm_island() {
        // Without any agent whose OWN attention is Stopped, jump_target must
        // fall back to the first agent at all: an idle pane that was never
        // promoted (this island isn't Stopped) is not a stop.
        use crate::herdr::snapshot::AgentStatus;
        use crate::world::attention::Attention;
        use crate::world::state::{Island, IslandAgent};

        let island = Island {
            id: "/p/api".into(), name: "api".into(), root: "/p/api".into(),
            attention: Attention::Working,
            last_changed_at: None,
            agents: vec![
                IslandAgent { pane_id: "w1:p1".into(), workspace_id: "w1".into(),
                              status: AgentStatus::Working, attention: Attention::Working,
                              title: None, kind: None, is_worktree: false, cwd: "/p/api".into() },
                IslandAgent { pane_id: "w1:p2".into(), workspace_id: "w1".into(),
                              status: AgentStatus::Idle, attention: Attention::Quiet,
                              title: None, kind: None, is_worktree: false, cwd: "/p/api".into() },
            ],
        };
        assert_eq!(jump_target(&island), Some("w1:p1".to_string()));
    }

    #[test]
    fn jump_target_falls_back_to_the_first_agent() {
        use crate::herdr::snapshot::AgentStatus;
        use crate::world::attention::Attention;
        use crate::world::state::{Island, IslandAgent};

        let island = Island {
            id: "/p/api".into(), name: "api".into(), root: "/p/api".into(),
            attention: Attention::Working,
            last_changed_at: None,
            agents: vec![IslandAgent { pane_id: "w1:p1".into(), workspace_id: "w1".into(),
                         status: AgentStatus::Working, attention: Attention::Working,
                         title: None, kind: None, is_worktree: false, cwd: "/p/api".into() }],
        };
        assert_eq!(jump_target(&island), Some("w1:p1".to_string()));
    }

    #[test]
    fn unsettled_report_normalizes_a_symlinked_root_the_same_way_as_its_repos() {
        // Carried finding from Task 3's review: `repos[].path` is
        // canonicalized (via `normalize_path` inside `scan_one`), but
        // `UnsettledReport.roots` used to be the raw, possibly-symlinked
        // root string. For a user whose project directory is itself a
        // symlink (iCloud Drive, Dropbox, a symlinked `~/Projects`, ...)
        // the "looked in ..." line and an individual repo's path would then
        // disagree in spelling even though one is literally inside the
        // other. `unsettled_report_for` must normalize `roots` the same
        // way, so the two lines the frontend renders agree.
        let dir = tempfile::tempdir().unwrap();
        let real_project = dir.path().join("real_projects");
        std::fs::create_dir_all(real_project.join("api/.git")).unwrap();
        let link = dir.path().join("projects_link");
        std::os::unix::fs::symlink(&real_project, &link).unwrap();

        let config = crate::config::Config {
            project_roots: Some(vec![link.to_string_lossy().to_string()]),
            ..Default::default()
        };
        let world = WorldState::disconnected();

        let report = unsettled_report_for(&config, &world, dir.path().to_path_buf());

        let canonical_home = std::fs::canonicalize(dir.path()).unwrap().to_string_lossy().to_string();
        assert_eq!(report.home, canonical_home);

        let canonical_root = std::fs::canonicalize(&real_project).unwrap().to_string_lossy().to_string();
        assert_eq!(report.roots, vec![canonical_root.clone()]);
        assert_eq!(report.repos.len(), 1);
        // The repo's path must literally be nested under the displayed
        // root once both are normalized — the whole point of the fix.
        assert!(
            report.repos[0].path.starts_with(&canonical_root),
            "repo path {:?} does not sit under the normalized root {:?}",
            report.repos[0].path,
            canonical_root,
        );
        assert_eq!(report.default_agent, "claude");
    }

    #[test]
    fn unsettled_report_names_the_configured_agent_not_a_hardcoded_one() {
        // The confirm sheet's whole reason to exist is to name the exact
        // call before it runs (principle 1). If this always said "claude"
        // it would lie for anyone who set `default_agent` in config.json.
        let config = crate::config::Config {
            default_agent: Some("codex".to_string()),
            ..Default::default()
        };
        let world = WorldState::disconnected();
        let dir = tempfile::tempdir().unwrap();

        let report = unsettled_report_for(&config, &world, dir.path().to_path_buf());
        assert_eq!(report.default_agent, "codex");
    }

    #[test]
    fn existing_workspace_for_finds_a_match_through_a_symlink() {
        // Fix round 1, Critical 2 (controller ruling): `found_settlement`
        // must refuse a repo that already has a workspace, using the same
        // canonicalized comparison as `list_unsettled` — including when the
        // path the caller passes in reaches the repo through a symlink.
        use crate::world::state::{Island, IslandAgent};

        let dir = tempfile::tempdir().unwrap();
        let real_repo = dir.path().join("real/repo");
        std::fs::create_dir_all(&real_repo).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(dir.path().join("real"), &link).unwrap();

        let canonical_root = std::fs::canonicalize(&real_repo).unwrap().to_string_lossy().to_string();
        let mut world = WorldState::disconnected();
        world.islands.push(Island {
            id: canonical_root.clone(),
            name: "repo".into(),
            root: canonical_root.clone(),
            attention: crate::world::attention::Attention::Quiet,
            last_changed_at: None,
            agents: vec![IslandAgent {
                pane_id: "w5:p1".into(),
                workspace_id: "w5".into(),
                status: AgentStatus::Idle,
                attention: crate::world::attention::Attention::Quiet,
                title: None,
                kind: None, is_worktree: false,
                // As `world::attention::build_world` produces it: already
                // canonical when it leaves Rust.
                cwd: canonical_root,
            }],
        });

        // Reached via the symlink, as `found_settlement`'s caller might.
        let via_symlink = link.join("repo");
        assert_eq!(existing_workspace_for(&world, &via_symlink), Some("w5".to_string()));
    }

    /// Runs a helper git command in `cwd`, panicking with useful context on failure.
    #[cfg(test)]
    fn run_git(cwd: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap_or_else(|e| panic!("failed to spawn git {args:?} in {cwd:?}: {e}"));
        assert!(status.success(), "git {args:?} failed in {cwd:?}");
    }

    #[cfg(test)]
    fn init_repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        run_git(dir, &["-c", "init.defaultBranch=main", "init", "-q", "."]);
        run_git(dir, &["config", "user.email", "test@example.com"]);
        run_git(dir, &["config", "user.name", "Test User"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        run_git(dir, &["add", "."]);
        run_git(dir, &["commit", "-q", "-m", "init"]);
    }

    /// FINAL WHOLE-BRANCH REVIEW, Critical — the third double-founding hole.
    ///
    /// A git worktree's `.git` is a FILE, not a directory, and `Path::exists`
    /// is true for it, so `world::unsettled::scan_roots` lists a worktree as
    /// a scannable repo. But `world::repo` deliberately collapses a worktree
    /// pane onto the MAIN repo root (Phase 0's one-island-per-repository
    /// rule), so the island built from a pane sitting in `/p/repo-wt` has
    /// `root == /p/repo`.
    ///
    /// Deriving the settled set from `island.root` therefore gets it exactly
    /// backwards on both counts:
    ///   * `/p/repo` — which has NO workspace — looks settled and becomes
    ///     unfoundable, and
    ///   * `/p/repo-wt` — which HAS one — is offered again, and the
    ///     idempotency guard cannot see it, so the second founding goes
    ///     through.
    ///
    /// The fix derives it from the pane's OWN canonical cwd instead. This
    /// test builds a real `git worktree add` under a temp dir and drives a
    /// real `RepoResolver` so the collapse actually happens, rather than
    /// asserting against a hand-built `Island` that assumes it.
    #[test]
    fn a_founded_worktree_is_refused_while_its_main_repo_is_still_foundable() {
        use crate::herdr::snapshot::{Pane, Snapshot};
        use crate::world::attention::{build_world, StopMemory};
        use crate::world::repo::{RealGit, RepoResolver};

        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        let worktree = tmp.path().join("repo-wt");
        run_git(
            &repo,
            &["worktree", "add", "-q", "-b", "wt-branch", worktree.to_str().unwrap()],
        );

        // The user founded a workspace on the WORKTREE, not the main repo.
        let snapshot = Snapshot {
            version: "0.8.0".into(),
            protocol: 19,
            panes: vec![Pane {
                pane_id: "w7:p1".into(),
                workspace_id: "w7".into(),
                cwd: Some(worktree.to_string_lossy().to_string()),
                foreground_cwd: None,
                agent_status: AgentStatus::Idle,
                terminal_title: None, agent: None,
            }],
            workspaces: vec![],
            focused_pane_id: None,
        };
        let world = build_world(
            &snapshot,
            &mut RepoResolver::new(Box::new(RealGit::default())),
            &mut StopMemory::default(),
        );

        // Precondition: the one-island-per-repository rule really did collapse
        // the worktree pane onto the main repo. This is correct and must NOT
        // change — it is exactly why `island.root` is the wrong input for the
        // settled set.
        assert_eq!(world.islands.len(), 1);
        assert_eq!(
            world.islands[0].root,
            normalize_path(&repo).to_string_lossy(),
            "a worktree pane must still collapse onto the main repo's island"
        );

        // The worktree is scanned as a repo in its own right (its `.git` is a
        // file, and `exists()` is true for it) — so it WILL be offered unless
        // something subtracts it.
        let scanned = crate::world::unsettled::scan_roots(&[tmp.path().to_path_buf()]);
        let scanned: Vec<String> =
            scanned.iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert!(
            scanned.contains(&normalize_path(&worktree).to_string_lossy().to_string()),
            "the worktree is a scannable repo, got {scanned:?}"
        );

        // The guard must refuse a SECOND founding of the worktree...
        assert_eq!(
            existing_workspace_for(&world, &worktree),
            Some("w7".to_string()),
            "the worktree already has workspace w7 — founding it again must be refused"
        );
        // ...and must NOT refuse the main repo, which has no workspace at all.
        assert_eq!(
            existing_workspace_for(&world, &repo),
            None,
            "the main repo has no workspace of its own and must stay foundable"
        );
    }

    /// IMPORTANT 3, `foreground_cwd` drift. `build_world` PREFERS
    /// `foreground_cwd` over `cwd` when grouping panes into islands (which
    /// stays as it is — that choice is about where work is visibly
    /// happening). So a `cd` inside a founded pane moves the island, and any
    /// settled decision derived from `island.root` moves with it: the
    /// founded repo reappears as unsettled and the guard has nothing to
    /// refuse on.
    ///
    /// Keying the settled comparison off the pane's OWN `cwd` — which is
    /// where the workspace was founded and does not drift — fixes this for
    /// free, with no change to grouping.
    ///
    /// KNOWN RESIDUAL, deliberately not fixed here: if `foreground_cwd`
    /// drifts to a directory that is not in ANY repo (`cd /tmp`),
    /// `build_world` drops the pane before an `IslandAgent` is ever built,
    /// so the world genuinely does not know the pane exists and the guard
    /// correctly degrades to "nothing to refuse on". Closing that would mean
    /// changing which cwd island grouping uses, which is out of scope for
    /// this fix wave.
    #[test]
    fn a_foreground_cwd_that_wandered_into_another_repo_does_not_unguard_the_founded_one() {
        use crate::herdr::snapshot::{Pane, Snapshot};
        use crate::world::attention::{build_world, StopMemory};
        use crate::world::repo::{RealGit, RepoResolver};

        let tmp = tempfile::tempdir().unwrap();
        let founded = tmp.path().join("founded");
        init_repo(&founded);
        let elsewhere = tmp.path().join("elsewhere");
        init_repo(&elsewhere);

        let snapshot = Snapshot {
            version: "0.8.0".into(),
            protocol: 19,
            panes: vec![Pane {
                pane_id: "w8:p1".into(),
                workspace_id: "w8".into(),
                // The workspace was founded here.
                cwd: Some(founded.to_string_lossy().to_string()),
                // ...but the user ran `cd ../elsewhere`, so the island moved.
                foreground_cwd: Some(elsewhere.to_string_lossy().to_string()),
                agent_status: AgentStatus::Idle,
                terminal_title: None, agent: None,
            }],
            workspaces: vec![],
            focused_pane_id: None,
        };
        let world = build_world(
            &snapshot,
            &mut RepoResolver::new(Box::new(RealGit::default())),
            &mut StopMemory::default(),
        );

        // The island really did drift onto the other repo.
        assert_eq!(world.islands.len(), 1);
        assert_eq!(
            world.islands[0].root,
            normalize_path(&elsewhere).to_string_lossy(),
            "grouping still follows foreground_cwd — that is not what this fix changes"
        );

        // The guard must nonetheless still know `founded` has a workspace.
        assert_eq!(
            existing_workspace_for(&world, &founded),
            Some("w8".to_string()),
            "a drifting foreground_cwd must not unguard an already-founded repo"
        );
    }

    #[test]
    fn existing_workspace_for_never_refuses_on_i_dont_know_yet() {
        // An empty world (herdr not yet reporting, or briefly disconnected)
        // must not be read as "this repo has no workspace" — `None` here
        // means "nothing to refuse on", not "confirmed unsettled".
        let dir = tempfile::tempdir().unwrap();
        let world = WorldState::disconnected();
        assert_eq!(existing_workspace_for(&world, &dir.path().join("anything")), None);
    }

    // ---- IMPORTANT 4: `found_settlement`'s own body, now testable ----

    #[test]
    fn a_repo_validates_to_its_directory_name_as_the_workspace_label() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("api");
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        assert_eq!(foundable_label(&repo), Ok("api".to_string()));
    }

    #[test]
    fn a_directory_with_no_dot_git_is_refused_by_name() {
        let tmp = tempfile::tempdir().unwrap();
        let plain = tmp.path().join("notes");
        std::fs::create_dir_all(&plain).unwrap();

        assert_eq!(foundable_label(&plain), Err("notes is not a git repository".to_string()));
    }

    #[test]
    fn a_worktree_whose_dot_git_is_a_file_is_still_foundable() {
        // A worktree's `.git` is a FILE. The check must be "is there a
        // `.git` here", not "is there a `.git` DIRECTORY here" — herdr has
        // first-class worktree support and founding one is legitimate.
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        let worktree = tmp.path().join("repo-wt");
        run_git(
            &repo,
            &["worktree", "add", "-q", "-b", "wt-label", worktree.to_str().unwrap()],
        );
        assert!(worktree.join(".git").is_file(), "precondition: a worktree's .git is a file");

        assert_eq!(foundable_label(&worktree), Ok("repo-wt".to_string()));
    }

    #[test]
    fn a_path_with_no_final_component_is_refused() {
        assert_eq!(foundable_label(Path::new("/")), Err("not a valid path: /".to_string()));
    }

    // ---- agent names (the `agent_name_taken` fix) ----

    fn taken(names: &[&str]) -> HashSet<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn an_agent_is_named_after_its_repository_not_after_its_kind() {
        // THE BUG, stated as a test. Passing the kind as the name is what
        // made the first `claude` claim the name `claude` forever.
        assert_eq!(agent_name_base(Path::new("/Users/j/Projects/AgeOfAgents")), "ageofagents");
        assert_eq!(agent_name_base(Path::new("/Users/j/Projects/webAdmin")), "webadmin");
        assert_eq!(agent_name_base(Path::new("/p/photo-studio-frontend")), "photo-studio-frontend");
        // `.` is not in herdr's permitted set, so it becomes `-`.
        assert_eq!(agent_name_base(Path::new("/p/speech.cpp")), "speech-cpp");
    }

    #[test]
    fn an_agent_name_never_reads_like_a_path_or_a_pane_id() {
        // herdr resolves an agent target by NAME or by PANE ID, so a name
        // shaped like the other one is an ambiguity waiting to be hit.
        assert_eq!(agent_name_base(Path::new("/p/my repo")), "my-repo");
        assert_eq!(agent_name_base(Path::new("/p/w2J:p1")), "w2j-p1");
        assert_eq!(agent_name_base(Path::new("/p/a  b")), "a-b");
        assert_eq!(agent_name_base(Path::new("/p/über-repo")), "ber-repo");
    }

    #[test]
    fn a_repository_with_no_usable_name_still_gets_a_real_one() {
        // Never an empty name (herdr would reject it) and never a panic.
        assert_eq!(agent_name_base(Path::new("/")), "agent");
        assert_eq!(agent_name_base(Path::new("/p/---")), "agent");
        assert_eq!(agent_name_base(Path::new("/p/...")), "agent");
    }

    #[test]
    fn an_agent_name_is_capped_so_it_stays_readable_in_herdrs_own_list() {
        let long = format!("/p/{}", "a".repeat(200));
        let name = agent_name_base(Path::new(&long));
        assert_eq!(name.len(), AGENT_NAME_MAX);
        // Deterministic truncation, not a hash: the same path always gives
        // the same name.
        assert_eq!(name, agent_name_base(Path::new(&long)));
    }

    /// herdr's rule, quoted from the error it returns: "agent name must
    /// start with a lowercase letter and contain only lowercase letters,
    /// digits, '-' or '_' (1-32 characters)".
    fn is_valid_herdr_agent_name(name: &str) -> bool {
        !name.is_empty()
            && name.len() <= AGENT_NAME_MAX
            && name.starts_with(|c: char| c.is_ascii_lowercase())
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    }

    #[test]
    fn every_name_this_app_can_produce_is_one_herdr_accepts() {
        // THE SECOND BUG, stated as a test. The first version of
        // `agent_name_base` GUESSED herdr's charset as `[A-Za-z0-9._-]`
        // capped at 64, and was wrong about uppercase, `.`, and the length
        // all at once. `WebGallery` failed on its capital S and cost
        // the author a workspace (`invalid_agent_name`, w2S).
        //
        // These are his real repository names, plus the shapes that broke
        // it and the shapes most likely to break it next.
        let repos = [
            "WebGallery", "AgeOfAgents", "webAdmin", "helpDesk",
            "photostudio-webpage", "photo-studio-frontend", "speech.cpp",
            "my-site-next", "label-studio", "pocketAlarm", "atlas",
            "my repo", "w2J:p1", "über-repo", "---", "...", "2048",
            "-leading-dash", "_leading_underscore", ".hidden", "9lives",
            "UPPER", "MiXeD.Case", &"a".repeat(200), &"A".repeat(200),
        ];
        for repo in repos {
            let name = agent_name_base(Path::new(&format!("/p/{repo}")));
            assert!(
                is_valid_herdr_agent_name(&name),
                "agent_name_base({repo:?}) produced {name:?}, which herdr rejects"
            );
        }
        // And the root, which has no last component at all.
        assert!(is_valid_herdr_agent_name(&agent_name_base(Path::new("/"))));
    }

    #[test]
    fn a_disambiguated_name_still_fits_herdrs_limit() {
        // The suffix has to come OUT of the budget, not be added on top of
        // it: a long repository name whose first candidate is valid and
        // whose second is not would fail only on the second agent — the
        // exact shape of the bug this whole area exists to fix.
        let base = agent_name_base(Path::new(&format!("/p/{}", "a".repeat(200))));
        let mut taken: HashSet<String> = HashSet::new();
        taken.insert(base.clone());
        for _ in 0..40 {
            let name = first_free_agent_name(&base, &taken).expect("a free name exists");
            assert!(
                is_valid_herdr_agent_name(&name),
                "{name:?} is longer than herdr allows or otherwise invalid"
            );
            assert!(taken.insert(name), "the same name was handed out twice");
        }
    }

    #[test]
    fn a_name_that_cannot_start_with_a_letter_keeps_what_identifies_it() {
        // Dropping the leading characters would turn `2048` into `agent`
        // and throw away the only part that says which repository it is.
        assert_eq!(agent_name_base(Path::new("/p/2048")), "repo-2048");
        assert_eq!(agent_name_base(Path::new("/p/9lives")), "repo-9lives");
    }

    #[test]
    fn a_free_name_is_used_as_is() {
        assert_eq!(
            first_free_agent_name("ageofagents", &taken(&["claude"])),
            Some("ageofagents".to_string())
        );
    }

    #[test]
    fn a_taken_name_gets_the_first_free_numeric_suffix() {
        // Repository basenames are NOT unique on this machine (the
        // archipelago work found three colliding basenames across 152
        // repos), and a second agent on the SAME repo is a thing the author
        // does deliberately — so the suffix has to be a real, ordinary
        // outcome, not an error path.
        assert_eq!(
            first_free_agent_name("api", &taken(&["api"])),
            Some("api-2".to_string())
        );
        assert_eq!(
            first_free_agent_name("api", &taken(&["api", "api-2", "api-3"])),
            Some("api-4".to_string())
        );
        // Gaps are filled, not skipped past — the answer is the FIRST free
        // one, which is what makes it predictable.
        assert_eq!(
            first_free_agent_name("api", &taken(&["api", "api-3"])),
            Some("api-2".to_string())
        );
    }

    #[test]
    fn choosing_a_name_is_deterministic_and_terminates_and_never_reuses() {
        // The three properties `first_free_agent_name` promises, checked
        // together against a densely-packed taken set: the loop's bound
        // (`taken.len() + 2`) has to be enough for EVERY shape of input,
        // not just the tidy ones.
        let mut names: Vec<String> = vec!["api".to_string()];
        names.extend((2..=60).map(|n| format!("api-{n}")));
        let packed = names.iter().cloned().collect::<HashSet<String>>();

        let chosen = first_free_agent_name("api", &packed).expect("a free name must exist");
        assert_eq!(chosen, "api-61");
        assert!(!packed.contains(&chosen), "never returns a name already in use");
        // Deterministic: same inputs, same answer, no clock and no
        // randomness anywhere in the derivation.
        assert_eq!(first_free_agent_name("api", &packed), Some(chosen));
    }

    #[test]
    fn a_name_is_still_found_when_unrelated_agents_crowd_the_session() {
        // The author's actual machine at the time of the report: one agent
        // named `claude` (on `w2J:p1`, webAdmin), and three repositories
        // whose workspaces exist with no agent in them.
        let live = taken(&["claude"]);
        assert_eq!(first_free_agent_name("helpDesk", &live), Some("helpDesk".to_string()));
        assert_eq!(first_free_agent_name("AgeOfAgents", &live), Some("AgeOfAgents".to_string()));
        assert_eq!(
            first_free_agent_name("WebGallery", &live),
            Some("WebGallery".to_string())
        );
        // And the name that WAS taken is still refused, rather than being
        // handed out a second time.
        assert_eq!(first_free_agent_name("claude", &live), Some("claude-2".to_string()));
    }

    #[test]
    fn the_partial_failure_message_says_the_workspace_exists_and_names_it() {
        // THE PRINCIPLE-4 LINCHPIN. `create_workspace` succeeded and
        // `agent.start` did not: the workspace EXISTS in herdr. A user who
        // reads this as "nothing happened" and retries ends up with two
        // workspaces for one repo — the exact failure the whole idempotency
        // effort exists to prevent. The wording is asserted verbatim because
        // the workspace id is the only handle the user has for finding or
        // closing the orphan.
        assert_eq!(
            partial_failure_message("w7", "api", "agent_pane_busy"),
            "workspace w7 (api) was created, but the agent did not start: agent_pane_busy \
             — the workspace and its pane still exist and were deliberately not removed",
        );
    }

    #[test]
    fn the_partial_failure_message_carries_herdrs_own_reason_verbatim() {
        // What the author actually saw, four times. The herdr error code
        // and its candidate list are the only things that told anyone what
        // was wrong, so they must reach the UI untouched — never summarized
        // into "the agent did not start" and dropped.
        let herdr = "herdr error agent_name_taken: agent name claude is already used; \
                     candidates: terminal_id=term_65bd74dc2d4fd54 pane_id=w2J:p1";
        let message = partial_failure_message("w2M", "AgeOfAgents", herdr);
        assert!(message.contains("w2M"), "must name the orphaned workspace: {message}");
        assert!(message.contains("AgeOfAgents"), "must name the repository: {message}");
        assert!(message.contains(herdr), "must carry herdr's own reason: {message}");
        assert!(
            message.contains("not removed"),
            "must say the workspace was left in place on purpose: {message}"
        );
    }

    #[test]
    fn the_refusal_message_names_the_workspace_that_already_exists() {
        assert_eq!(
            already_founded_message("api", "w3"),
            "api already has a workspace (w3) — refusing to create a second one",
        );
    }

    #[test]
    fn existing_workspace_for_ignores_an_unrelated_island() {
        use crate::world::state::{Island, IslandAgent};

        let mut world = WorldState::disconnected();
        world.islands.push(Island {
            id: "/p/other".into(),
            name: "other".into(),
            root: "/p/other".into(),
            attention: crate::world::attention::Attention::Quiet,
            last_changed_at: None,
            agents: vec![IslandAgent {
                pane_id: "w9:p1".into(),
                workspace_id: "w9".into(),
                status: AgentStatus::Idle,
                attention: crate::world::attention::Attention::Quiet,
                title: None,
                kind: None, is_worktree: false,
                cwd: "/p/other".into(),
            }],
        });

        let dir = tempfile::tempdir().unwrap();
        assert_eq!(existing_workspace_for(&world, &dir.path().join("mine")), None);
    }

    // ---- Task: Phase 0.6 action layer ----

    #[test]
    fn agent_kinds_is_the_full_verified_herdr_08_list() {
        // Verified live: `herdr agent start --help` on this machine lists
        // exactly these 21 values for `--kind`, in this order.
        assert_eq!(AGENT_KINDS.len(), 21);
        assert!(AGENT_KINDS.contains(&"claude"));
        assert!(AGENT_KINDS.contains(&"codex"));
        assert!(AGENT_KINDS.contains(&"pi"));
        assert!(AGENT_KINDS.contains(&"maki"));
        // No duplicates.
        let mut sorted = AGENT_KINDS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), AGENT_KINDS.len());
    }

    // ---- Task: start-agent-anywhere (the unsettled repo's "Start agent…") ----

    /// The invariant the unified "Start agent…" entry point rests on.
    ///
    /// A repo with no herdr workspace now offers the SAME action as one
    /// that has a workspace, and the confirm sheet it opens
    /// (`FoundingSheet`) prints the exact calls that will run:
    ///
    ///     workspace.create  cwd="…"  label="…"
    ///     agent.start       name="claude"  kind="claude"
    ///
    /// That name comes from `agent_kinds()[0]` on the frontend. The agent
    /// actually started comes from `found_settlement`. Two separate
    /// commands, the same config, and nothing but convention keeping their
    /// fallbacks in step — until this test. Written against the real
    /// functions on purpose: a frontend test can only assert what a mocked
    /// `invoke` was told to return, so it could never have caught these two
    /// drifting apart.
    #[test]
    fn every_start_an_agent_path_resolves_the_same_default_agent() {
        // Configured: whatever the user set wins, everywhere.
        let configured = crate::config::Config {
            default_agent: Some("codex".to_string()),
            ..Default::default()
        };
        assert_eq!(default_agent(&configured), "codex");
        // What `agent_kinds()` preselects (its first entry) — the name the
        // sheet prints — must be the same one `found_settlement` will use.
        assert_eq!(ordered_with_default_first(AGENT_KINDS, &default_agent(&configured))[0], "codex");
        // And the same one the HUD list's own sheet quotes.
        let world = WorldState::disconnected();
        let dir = tempfile::tempdir().unwrap();
        let report = unsettled_report_for(&configured, &world, dir.path().to_path_buf());
        assert_eq!(report.default_agent, "codex");

        // Unconfigured: one shared fallback, not five independent ones.
        let bare = crate::config::Config::default();
        assert_eq!(default_agent(&bare), "claude");
        assert_eq!(ordered_with_default_first(AGENT_KINDS, &default_agent(&bare))[0], "claude");
    }

    /// The terminal-polish round's Item 4: `found_settlement` now takes a
    /// kind, so the unsettled path can offer the same picker the settled
    /// one always had. The property that must hold for all three commands
    /// that accept one (`found_settlement`, `start_agent`,
    /// `create_project`) is the same, and it is why they share
    /// `resolved_kind`: what the user picked is what runs, and the
    /// configured default is consulted ONLY when they picked nothing.
    ///
    /// The failure this guards against is concrete and was real before the
    /// picker existed: a sheet printing `agent.start name="codex"` while
    /// the command started `claude` (or the reverse) — a confirm sheet
    /// naming a call other than the one that runs.
    #[test]
    fn an_explicit_kind_always_wins_and_only_its_absence_falls_back() {
        let configured = crate::config::Config {
            default_agent: Some("codex".to_string()),
            ..Default::default()
        };
        // Explicitly chosen wins, even when it IS the default, and even
        // when it differs from it.
        assert_eq!(resolved_kind(&configured, Some("claude".to_string())), "claude");
        assert_eq!(resolved_kind(&configured, Some("codex".to_string())), "codex");
        // Nothing chosen: the one shared fallback, never a second literal.
        assert_eq!(resolved_kind(&configured, None), default_agent(&configured));
        let bare = crate::config::Config::default();
        assert_eq!(resolved_kind(&bare, None), default_agent(&bare));
        assert_eq!(resolved_kind(&bare, Some("gemini".to_string())), "gemini");
    }

    #[test]
    fn ordered_with_default_first_moves_the_default_to_the_front_without_dropping_anyone() {
        let kinds = ["pi", "claude", "codex"];
        let ordered = ordered_with_default_first(&kinds, "codex");
        assert_eq!(ordered, vec!["codex", "pi", "claude"]);
    }

    #[test]
    fn ordered_with_default_first_does_not_duplicate_a_default_already_present() {
        let kinds = ["pi", "claude", "codex"];
        let ordered = ordered_with_default_first(&kinds, "pi");
        assert_eq!(ordered, vec!["pi", "claude", "codex"]);
    }

    #[test]
    fn builtin_resume_args_covers_only_the_kinds_verified_on_this_machine() {
        // `claude --help` and `codex --help` were checked directly; every
        // other kind is deliberately absent rather than guessed.
        let builtin = builtin_resume_args();
        assert_eq!(builtin.get("claude"), Some(&vec!["--resume".to_string()]));
        // `codex resume` is a subcommand, not a flag — the map holds
        // whatever argv tail the tool actually expects.
        assert_eq!(builtin.get("codex"), Some(&vec!["resume".to_string()]));
        assert_eq!(builtin.get("gemini"), None);
    }

    #[test]
    fn resume_args_for_falls_back_to_the_builtin_default() {
        let config = crate::config::Config::default();
        assert_eq!(resume_args_for(&config, "claude"), Some(vec!["--resume".to_string()]));
        assert_eq!(resume_args_for(&config, "gemini"), None);
    }

    #[test]
    fn resume_args_for_lets_a_user_override_correct_a_builtin_default() {
        let mut overrides = HashMap::new();
        overrides.insert("claude".to_string(), vec!["--continue".to_string()]);
        let config =
            crate::config::Config { resume_args: Some(overrides), ..Default::default() };
        assert_eq!(resume_args_for(&config, "claude"), Some(vec!["--continue".to_string()]));
    }

    #[test]
    fn resume_args_for_lets_a_user_add_a_kind_this_app_never_verified() {
        let mut overrides = HashMap::new();
        overrides.insert("gemini".to_string(), vec!["--resume".to_string()]);
        let config =
            crate::config::Config { resume_args: Some(overrides), ..Default::default() };
        assert_eq!(resume_args_for(&config, "gemini"), Some(vec!["--resume".to_string()]));
    }

    #[test]
    fn idle_pane_for_finds_an_app_created_pane_with_no_detected_agent() {
        use crate::world::state::{Island, IslandAgent};

        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("api");
        std::fs::create_dir_all(&repo).unwrap();
        let canonical = normalize_path(&repo).to_string_lossy().to_string();

        let mut world = WorldState::disconnected();
        world.islands.push(Island {
            id: canonical.clone(),
            name: "api".into(),
            root: canonical.clone(),
            attention: Attention::Quiet,
            last_changed_at: None,
            agents: vec![
                IslandAgent {
                    pane_id: "w1:p1".into(),
                    workspace_id: "w1".into(),
                    status: AgentStatus::Working,
                    attention: Attention::Working,
                    title: None,
                    kind: None, is_worktree: false,
                    cwd: canonical.clone(),
                },
                IslandAgent {
                    pane_id: "w1:p2".into(),
                    workspace_id: "w1".into(),
                    status: AgentStatus::Unknown,
                    attention: Attention::Quiet,
                    title: None,
                    kind: None, is_worktree: false,
                    cwd: canonical,
                },
            ],
        });
        let app_created: HashSet<String> = ["w1:p2".to_string()].into_iter().collect();

        assert_eq!(idle_pane_for(&world, &repo, &app_created), Some("w1:p2".to_string()));
    }

    /// IMPORTANT 1, THE HEADLINE FIX. `w1:p2` is `Unknown` — herdr's exact
    /// report for a plain login shell sitting at a prompt, indistinguishable
    /// from a freshly founded pane awaiting `agent.start`. This app never
    /// created it (it is absent from `app_created_panes`), so it must never
    /// be offered for reuse — "start another agent" must not be able to
    /// launch an agent into a terminal the author is typing in.
    #[test]
    fn idle_pane_for_never_selects_a_bare_shell_this_app_did_not_create() {
        use crate::world::state::{Island, IslandAgent};

        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("api");
        std::fs::create_dir_all(&repo).unwrap();
        let canonical = normalize_path(&repo).to_string_lossy().to_string();

        let mut world = WorldState::disconnected();
        world.islands.push(Island {
            id: canonical.clone(),
            name: "api".into(),
            root: canonical.clone(),
            attention: Attention::Quiet,
            last_changed_at: None,
            // A bare shell at a prompt: `Unknown` is exactly what herdr
            // reports for "no agent detected", which a plain login shell
            // satisfies just as well as a freshly founded, empty pane.
            agents: vec![IslandAgent {
                pane_id: "w9:p1".into(),
                workspace_id: "w9".into(),
                status: AgentStatus::Unknown,
                attention: Attention::Quiet,
                title: None,
                kind: None, is_worktree: false,
                cwd: canonical,
            }],
        });
        // Deliberately empty: this app never founded w9.
        let app_created: HashSet<String> = HashSet::new();

        assert_eq!(
            idle_pane_for(&world, &repo, &app_created),
            None,
            "a pane this app did not create must never be reused, regardless of its status"
        );
    }

    /// IMPORTANT 1's second condition: even a pane THIS app created is never
    /// reused while the user is currently focused on it — the author may be
    /// typing into a freshly founded pane by hand before any agent starts.
    #[test]
    fn idle_pane_for_never_selects_the_currently_focused_pane_even_if_app_created() {
        use crate::world::state::{Island, IslandAgent};

        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("api");
        std::fs::create_dir_all(&repo).unwrap();
        let canonical = normalize_path(&repo).to_string_lossy().to_string();

        let mut world = WorldState::disconnected();
        world.focused_pane_id = Some("w1:p2".to_string());
        world.islands.push(Island {
            id: canonical.clone(),
            name: "api".into(),
            root: canonical.clone(),
            attention: Attention::Quiet,
            last_changed_at: None,
            agents: vec![IslandAgent {
                pane_id: "w1:p2".into(),
                workspace_id: "w1".into(),
                status: AgentStatus::Unknown,
                attention: Attention::Quiet,
                title: None,
                kind: None, is_worktree: false,
                cwd: canonical,
            }],
        });
        let app_created: HashSet<String> = ["w1:p2".to_string()].into_iter().collect();

        assert_eq!(
            idle_pane_for(&world, &repo, &app_created),
            None,
            "the pane the user is currently looking at must never be seized"
        );
    }

    #[test]
    fn idle_pane_for_is_none_when_every_pane_already_has_a_detected_agent() {
        use crate::world::state::{Island, IslandAgent};

        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("api");
        std::fs::create_dir_all(&repo).unwrap();
        let canonical = normalize_path(&repo).to_string_lossy().to_string();

        let mut world = WorldState::disconnected();
        world.islands.push(Island {
            id: canonical.clone(),
            name: "api".into(),
            root: canonical.clone(),
            attention: Attention::Working,
            last_changed_at: None,
            agents: vec![IslandAgent {
                pane_id: "w1:p1".into(),
                workspace_id: "w1".into(),
                status: AgentStatus::Working,
                attention: Attention::Working,
                title: None,
                kind: None, is_worktree: false,
                cwd: canonical,
            }],
        });
        let app_created: HashSet<String> = ["w1:p1".to_string()].into_iter().collect();

        assert_eq!(idle_pane_for(&world, &repo, &app_created), None);
    }

    #[test]
    fn idle_pane_for_is_none_when_the_repo_has_no_workspace_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let world = WorldState::disconnected();
        assert_eq!(idle_pane_for(&world, &dir.path().join("nothing-here"), &HashSet::new()), None);
    }

    // ---- IMPORTANT 3: send_prompt / focus_pane pane-id validation ----

    fn island_with_one_agent(root: &str, pane_id: &str, cwd: &str) -> Island {
        Island {
            id: root.into(),
            name: Path::new(root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            root: root.into(),
            attention: Attention::Working,
            last_changed_at: None,
            agents: vec![IslandAgent {
                pane_id: pane_id.into(),
                workspace_id: "w".into(),
                status: AgentStatus::Working,
                attention: Attention::Working,
                title: None,
                kind: None, is_worktree: false,
                cwd: cwd.into(),
            }],
        }
    }

    #[test]
    fn find_live_pane_finds_a_pane_that_exists_in_the_world() {
        let mut world = WorldState::disconnected();
        world.islands.push(island_with_one_agent("/p/api", "w7:p1", "/p/api"));
        let (island, agent) = find_live_pane(&world, "w7:p1").unwrap();
        assert_eq!(island.root, "/p/api");
        assert_eq!(agent.pane_id, "w7:p1");
    }

    #[test]
    fn find_live_pane_is_none_for_a_pane_id_not_in_the_world() {
        let world = WorldState::disconnected();
        assert!(find_live_pane(&world, "w7:p1").is_none());
    }

    #[test]
    fn validate_prompt_text_refuses_an_empty_prompt() {
        let err = validate_prompt_text("").unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn validate_prompt_text_refuses_a_prompt_over_the_length_cap() {
        let huge = "a".repeat(MAX_PROMPT_CHARS + 1);
        let err = validate_prompt_text(&huge).unwrap_err();
        assert!(err.contains("too long"), "got: {err}");
    }

    #[test]
    fn validate_prompt_text_accepts_an_ordinary_prompt() {
        assert_eq!(validate_prompt_text("fix the bug in main.rs"), Ok(()));
    }

    #[test]
    fn validate_send_prompt_refuses_a_stale_pane_id_not_in_the_current_world() {
        // THE Important 3 SCENARIO: the frontend is still holding a pane id
        // from before its workspace closed. `w7:p1` names nothing in the
        // current world at all.
        let world = WorldState::disconnected();
        let err = validate_send_prompt(&world, "w7:p1", "hello", None).unwrap_err();
        assert!(err.contains("w7:p1"), "got: {err}");
    }

    #[test]
    fn validate_send_prompt_refuses_when_herdr_reused_the_id_for_a_different_repository() {
        // `w7:p1` used to be this app's pane for `/p/old-repo`. That
        // workspace closed, and herdr later reused the exact same pane id for
        // an unrelated workspace on `/p/other-repo`. The frontend, composing
        // a prompt against the OLD island it still had on screen, must be
        // refused rather than have its prompt delivered to the new occupant.
        let mut world = WorldState::disconnected();
        world.islands.push(island_with_one_agent("/p/other-repo", "w7:p1", "/p/other-repo"));

        let err =
            validate_send_prompt(&world, "w7:p1", "hello", Some("/p/old-repo")).unwrap_err();
        assert!(err.contains("other-repo"), "got: {err}");
    }

    #[test]
    fn validate_send_prompt_accepts_a_live_pane_with_a_matching_expected_root() {
        let mut world = WorldState::disconnected();
        world.islands.push(island_with_one_agent("/p/api", "w7:p1", "/p/api"));

        assert_eq!(validate_send_prompt(&world, "w7:p1", "hello", Some("/p/api")), Ok(()));
    }

    #[test]
    fn validate_send_prompt_accepts_a_live_pane_when_no_expected_root_is_given() {
        let mut world = WorldState::disconnected();
        world.islands.push(island_with_one_agent("/p/api", "w7:p1", "/p/api"));

        assert_eq!(validate_send_prompt(&world, "w7:p1", "hello", None), Ok(()));
    }

    #[test]
    fn validate_send_prompt_refuses_an_overlong_prompt_even_for_a_live_pane() {
        let mut world = WorldState::disconnected();
        world.islands.push(island_with_one_agent("/p/api", "w7:p1", "/p/api"));
        let huge = "a".repeat(MAX_PROMPT_CHARS + 1);

        let err = validate_send_prompt(&world, "w7:p1", &huge, None).unwrap_err();
        assert!(err.contains("too long"), "got: {err}");
    }

    // ---- Phase 0.7: validate_live_pane, shared by pane_read/pane_send_text/
    // pane_send_keys, and validate_pane_text/validate_pane_keys ----

    #[test]
    fn validate_live_pane_refuses_a_stale_pane_id_not_in_the_current_world() {
        let world = WorldState::disconnected();
        let err = validate_live_pane(&world, "w7:p1", None).unwrap_err();
        assert!(err.contains("w7:p1"), "got: {err}");
    }

    #[test]
    fn validate_live_pane_refuses_when_herdr_reused_the_id_for_a_different_repository() {
        let mut world = WorldState::disconnected();
        world.islands.push(island_with_one_agent("/p/other-repo", "w7:p1", "/p/other-repo"));

        let err = validate_live_pane(&world, "w7:p1", Some("/p/old-repo")).unwrap_err();
        assert!(err.contains("other-repo"), "got: {err}");
    }

    #[test]
    fn validate_live_pane_accepts_a_live_pane_with_a_matching_expected_root() {
        let mut world = WorldState::disconnected();
        world.islands.push(island_with_one_agent("/p/api", "w7:p1", "/p/api"));

        assert_eq!(validate_live_pane(&world, "w7:p1", Some("/p/api")), Ok(()));
    }

    #[test]
    fn validate_live_pane_accepts_a_live_pane_when_no_expected_root_is_given() {
        let mut world = WorldState::disconnected();
        world.islands.push(island_with_one_agent("/p/api", "w7:p1", "/p/api"));

        assert_eq!(validate_live_pane(&world, "w7:p1", None), Ok(()));
    }

    #[test]
    fn validate_pane_text_accepts_ordinary_text() {
        assert_eq!(validate_pane_text("echo hi"), Ok(()));
    }

    #[test]
    fn validate_pane_text_accepts_empty_text() {
        // Unlike a prompt, an empty `pane_send_text` isn't a meaningless
        // no-op worth refusing outright — sending nothing is harmless, and
        // the frontend is the thing responsible for only calling this on an
        // actual keystroke/paste (§5.6).
        assert_eq!(validate_pane_text(""), Ok(()));
    }

    #[test]
    fn validate_pane_text_refuses_a_runaway_paste() {
        let huge = "a".repeat(MAX_PANE_TEXT_CHARS + 1);
        let err = validate_pane_text(&huge).unwrap_err();
        assert!(err.contains("too much text"), "got: {err}");
    }

    #[test]
    fn validate_pane_keys_refuses_an_empty_list() {
        let err = validate_pane_keys(&[]).unwrap_err();
        assert!(err.contains("no keys"), "got: {err}");
    }

    #[test]
    fn validate_pane_keys_accepts_an_ordinary_chord() {
        assert_eq!(validate_pane_keys(&["ctrl+c".to_string()]), Ok(()));
    }

    #[test]
    fn validate_pane_keys_refuses_a_call_shaped_like_a_macro() {
        let keys: Vec<String> = (0..MAX_KEYS_PER_CALL + 1).map(|_| "a".to_string()).collect();
        let err = validate_pane_keys(&keys).unwrap_err();
        assert!(err.contains("too many keys"), "got: {err}");
    }

    // ---- IMPORTANT 4: create_project's discoverability check ----

    #[test]
    fn discoverability_check_is_none_when_the_scan_would_find_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("Projects");
        let target = projects.join("new-project");
        std::fs::create_dir_all(target.join(".git")).unwrap();

        let config = crate::config::Config {
            project_roots: Some(vec![projects.to_string_lossy().to_string()]),
            ..Default::default()
        };
        let canonical_target = normalize_path(&target);

        assert_eq!(
            discoverability_check(&config, dir.path(), &[], &canonical_target),
            None
        );
    }

    #[test]
    fn discoverability_check_is_none_for_a_project_several_levels_below_the_scan_root() {
        // Phase 0.5b: this used to be the exact IMPORTANT 4 failure shape —
        // a parent three levels below the scan root, invisible to the old
        // depth-2 cap. `scan_roots` is unbounded now, so this must be found.
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("Projects");
        let target = projects.join("Group/Sub/new-project");
        std::fs::create_dir_all(target.join(".git")).unwrap();

        let config = crate::config::Config {
            project_roots: Some(vec![projects.to_string_lossy().to_string()]),
            ..Default::default()
        };
        let canonical_target = normalize_path(&target);

        assert_eq!(
            discoverability_check(&config, dir.path(), &[], &canonical_target),
            None,
            "an unbounded scan must find a project at any depth below the scan root"
        );
    }

    #[test]
    fn discoverability_check_names_the_problem_when_the_target_is_outside_every_scan_root() {
        // The remaining, honest way this check can fail once the scan is
        // unbounded: `target` was founded somewhere `discovery_plan` would
        // never even look, because the user's configured `project_roots`
        // does not cover it.
        let dir = tempfile::tempdir().unwrap();
        let configured_root = dir.path().join("Elsewhere");
        std::fs::create_dir_all(&configured_root).unwrap();
        let target = dir.path().join("Projects/new-project");
        std::fs::create_dir_all(target.join(".git")).unwrap();

        let config = crate::config::Config {
            project_roots: Some(vec![configured_root.to_string_lossy().to_string()]),
            ..Default::default()
        };
        let canonical_target = normalize_path(&target);

        let reason = discoverability_check(&config, dir.path(), &[], &canonical_target).unwrap();
        assert!(reason.contains(&canonical_target.display().to_string()), "got: {reason}");
    }

    #[test]
    fn discoverability_check_names_the_problem_for_a_parent_inside_an_existing_repo() {
        // The other IMPORTANT 4 shape: `parent` sits inside a directory that
        // is ALREADY a repo (`photo-workspace` is not one, but its own parent
        // `PhotoStudio` already having `.git` means `scan_one` never
        // descends past it at all).
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("Projects");
        std::fs::create_dir_all(projects.join("PhotoStudio/.git")).unwrap();
        let parent = projects.join("PhotoStudio/photo-workspace");
        let target = parent.join("new-project");
        std::fs::create_dir_all(&target).unwrap();

        let config = crate::config::Config {
            project_roots: Some(vec![projects.to_string_lossy().to_string()]),
            ..Default::default()
        };
        let canonical_target = normalize_path(&target);

        assert!(discoverability_check(&config, dir.path(), &[], &canonical_target).is_some());
    }

    // ---- create_project's refusal paths — the part that matters most,
    // because they stand between a typo and a directory appearing
    // somewhere unexpected on the author's real machine. ----

    #[test]
    fn validate_project_name_refuses_an_empty_name() {
        assert_eq!(
            validate_project_name(""),
            Err("project name must not be empty".to_string())
        );
    }

    #[test]
    fn validate_project_name_refuses_a_name_with_a_slash() {
        let err = validate_project_name("foo/bar").unwrap_err();
        assert!(err.contains("path separator"), "got: {err}");
    }

    #[test]
    fn validate_project_name_refuses_a_bare_dotdot() {
        let err = validate_project_name("..").unwrap_err();
        assert!(err.contains(".."), "got: {err}");
    }

    #[test]
    fn validate_project_name_refuses_a_name_containing_dotdot_without_a_separator() {
        // No path separator here at all, but ".." is still a traversal
        // component the task explicitly calls out as refused.
        let err = validate_project_name("foo..bar").unwrap_err();
        assert!(err.contains(".."), "got: {err}");
    }

    #[test]
    fn validate_project_name_accepts_an_ordinary_name() {
        assert_eq!(validate_project_name("my-new-project"), Ok(()));
    }

    #[test]
    fn validate_parent_dir_refuses_a_path_that_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        let err = validate_parent_dir(&missing).unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
    }

    #[test]
    fn validate_parent_dir_refuses_a_path_that_is_a_file_not_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a-file");
        std::fs::write(&file, "hi").unwrap();
        let err = validate_parent_dir(&file).unwrap_err();
        assert!(err.contains("is not a directory"), "got: {err}");
    }

    #[test]
    fn validate_parent_dir_accepts_a_real_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(validate_parent_dir(dir.path()), Ok(()));
    }

    #[test]
    fn git_init_creates_a_real_dot_git_directory() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("fresh");
        std::fs::create_dir_all(&repo).unwrap();

        git_init(&repo).unwrap();

        assert!(repo.join(".git").is_dir(), "git init must produce a real .git directory");
    }

    #[test]
    fn git_init_surfaces_a_failure_instead_of_pretending_to_succeed() {
        // A directory that does not exist: `git init` itself fails (rather
        // than the process failing to spawn at all), so this exercises the
        // "ran, but git said no" branch specifically.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        let err = git_init(&missing);
        assert!(err.is_err(), "git init in a nonexistent directory must not report success");
    }

    /// End-to-end proof that `create_project`'s actual write sequence works
    /// against a real herdr — the same building blocks the command itself
    /// calls (`validate_project_name`, `validate_parent_dir`, `git_init`,
    /// `herdr::launch::create_workspace`), run here directly because
    /// `tauri::State` cannot be constructed outside a running Tauri `App`
    /// (its inner field is private to the `tauri` crate) — the same reason
    /// `found_settlement` itself has no direct unit test in this file and
    /// relies on `herdr::launch`'s own live test for its round trip.
    ///
    /// Everything happens under a `tempfile::tempdir()` — never under
    /// `~/Projects` — and the founded workspace is closed in a `finally`-
    /// style block so a failed assertion still cleans up rather than
    /// leaking a workspace into the author's real herdr session.
    #[tokio::test]
    #[ignore = "requires a running herdr; writes to a real temp directory"]
    async fn create_project_creates_a_real_project_end_to_end() {
        let parent = tempfile::tempdir().unwrap();
        let name = "aoa-create-project-test";

        validate_project_name(name).unwrap();
        validate_parent_dir(parent.path()).unwrap();

        let canonical_parent = normalize_path(parent.path());
        let target = canonical_parent.join(name);
        assert!(!target.exists(), "precondition: the target must not already exist");

        std::fs::create_dir(&target).unwrap();
        git_init(&target).unwrap();

        assert!(target.is_dir(), "the project directory must exist");
        assert!(target.join(".git").is_dir(), "the project must be a real git repository");

        let home = dirs::home_dir().unwrap();
        let socket =
            crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);

        let founded = crate::herdr::launch::create_workspace(&socket, &target, name).await.unwrap();
        println!("founded {founded:?}");

        // Prove the workspace really exists in herdr (not just that the RPC
        // call returned without erroring) before cleaning it up.
        let get_client = crate::herdr::client::HerdrClient::connect(&socket).await.unwrap();
        let workspace = get_client
            .call(
                "workspace.get",
                serde_json::json!({ "workspace_id": founded.workspace_id }),
            )
            .await
            .unwrap();
        assert_eq!(workspace["workspace"]["workspace_id"], founded.workspace_id);
        println!("herdr confirms workspace exists: {workspace}");

        // Clean up the workspace and the directory regardless of what
        // happened above, exactly as `founds_a_real_workspace_and_starts_
        // claude` already does for the same reason: a failing assertion
        // must not leak state into the author's real herdr session.
        let close_client = crate::herdr::client::HerdrClient::connect(&socket).await.unwrap();
        close_client
            .call("workspace.close", serde_json::json!({ "workspace_id": founded.workspace_id }))
            .await
            .unwrap();
        std::fs::remove_dir_all(&target).unwrap();
    }
}
