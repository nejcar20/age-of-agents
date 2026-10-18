use crate::herdr::client::HerdrClient;
use crate::herdr::protocol::Request;
use crate::herdr::snapshot::{fetch_snapshot, Snapshot};
use crate::world::attention::{build_world, StopMemory};
use crate::world::repo::{RealGit, RepoResolver};
use crate::world::state::WorldState;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast::{error::RecvError, Receiver};
use tokio::sync::Notify;

/// Global event types — every one of these requires only `type`, so they
/// all go into every `events.subscribe` unconditionally.
///
/// `pane.agent_status_changed` is deliberately excluded because it requires
/// a concrete `pane_id` and cannot be subscribed globally. Fix-rounds 1-3
/// assumed the lifecycle events here covered agent state well enough; they
/// do not, and `PANE_STATUS_EVENT` below is how fix-round 4 covers it.
pub const WORLD_EVENTS: [&str; 12] = [
    "pane.created",
    "pane.closed",
    "pane.updated",
    "pane.exited",
    "pane.agent_detected",
    "workspace.created",
    "workspace.closed",
    "workspace.updated",
    "worktree.created",
    // Focus moving onto a stopped pane is how herdr marks it seen (see
    // `StopMemory`). Which of the three fires for a given user action is
    // herdr's business, so all three wake a resnapshot.
    "pane.focused",
    "tab.focused",
    "workspace.focused",
];

/// Panes the user opened in this app since the last world build, and a way
/// to wake the connection loop so the build happens now rather than at
/// herdr's next event. Written by `commands::mark_agent_seen`, drained into
/// `StopMemory::mark_seen` right before each build — the memory itself is
/// owned by the loop and never shared.
#[derive(Clone, Default)]
pub struct SeenInbox {
    panes: Arc<Mutex<HashSet<String>>>,
    wake: Arc<Notify>,
}

impl SeenInbox {
    pub fn mark(&self, pane_id: &str) {
        self.panes.lock().unwrap().insert(pane_id.to_owned());
        self.wake.notify_one();
    }

    fn take(&self) -> HashSet<String> {
        std::mem::take(&mut *self.panes.lock().unwrap())
    }

    async fn wait(&self) {
        self.wake.notified().await;
    }
}

/// The one event type that CANNOT be subscribed globally: it requires a
/// concrete `pane_id`, so one subscription entry is needed per pane.
///
/// FIX-ROUND 4 (the defect this round exists to fix): verified against live
/// Herdr 0.8.0 with raw socket probes — when a pane goes working → blocked
/// or blocked → done, the global subscription above receives ABSOLUTELY
/// NOTHING. `pane.updated` does not fire; the only global delivery ever
/// observed for agent state was a single `pane_agent_detected` on the very
/// first detection. A per-pane subscription
/// `{"type":"pane.agent_status_changed","pane_id":"<id>"}` delivers EVERY
/// transition (working, blocked and done were all observed in sequence).
/// Without this, the ❗ "needs you" marker — the entire point of Phase 0 —
/// essentially never appeared.
pub const PANE_STATUS_EVENT: &str = "pane.agent_status_changed";

/// Sends one `events.subscribe` covering every `WORLD_EVENTS` type PLUS one
/// `PANE_STATUS_EVENT` entry per pane in `pane_ids`, and returns the request
/// id used, so the caller can match it against the `subscription_started`
/// acknowledgment (see `await_subscription_ack`).
///
/// Fix-round finding 1: `send_raw` only reports whether the bytes made it
/// onto the socket, not whether Herdr accepted the subscription — a
/// malformed subscription list is rejected wholesale with an
/// empty-id error reply, which cannot be correlated back to this call at
/// all. Returning the id (rather than swallowing it) is what makes it
/// possible for the caller to actually confirm acceptance afterward.
///
/// FIX-ROUND 4: the globals and the per-pane entries go out in ONE
/// `events.subscribe`, not two. Herdr serves exactly one request per
/// connection (subscribe excepted, whose connection then streams forever),
/// so a second `events.subscribe` on the same connection would hit EOF and
/// a broken pipe. Adding a pane therefore means a whole new connection —
/// see `run_subscription_attempt`.
pub async fn subscribe_world(client: &HerdrClient, pane_ids: &[String]) -> Result<String> {
    let id = client.next_subscription_id();
    let mut subscriptions: Vec<Value> = WORLD_EVENTS.iter().map(|t| json!({ "type": t })).collect();
    subscriptions.extend(
        pane_ids
            .iter()
            .map(|pane_id| json!({ "type": PANE_STATUS_EVENT, "pane_id": pane_id })),
    );
    client
        .send_raw(Request {
            id: id.clone(),
            method: "events.subscribe".to_string(),
            params: json!({ "subscriptions": subscriptions }),
        })
        .await?;
    Ok(id)
}

const SUBSCRIPTION_ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// Waits for the `subscription_started` acknowledgment matching `sub_id`,
/// or fails if Herdr rejects the subscription or the connection drops
/// first.
///
/// Fix-round finding 1: without this, a bad subscription (e.g. a future
/// Herdr renaming one of the `WORLD_EVENTS` types) dies silently — the
/// socket stays open (so `recv()` blocks forever instead of ever seeing
/// `Closed`), and the UI freezes on its initial snapshot with no signal
/// at all. Real Herdr rejects a bad subscription list with
/// `{"id":"","error":{...}}` — an EMPTY id — which `HerdrClient`'s reader
/// task already routes to "fail every in-flight call"; since there are no
/// pending `call()`s at subscribe time, that error would otherwise be
/// dropped on the floor with nothing to observe it. Bounding this wait
/// with a timeout is a last-resort defense in case Herdr sends neither an
/// ack nor an error nor closes the socket.
async fn await_subscription_ack(events: &mut Receiver<Value>, sub_id: &str) -> Result<()> {
    await_subscription_ack_within(events, sub_id, SUBSCRIPTION_ACK_TIMEOUT).await
}

/// Same as `await_subscription_ack`, but with the timeout as a parameter so
/// tests can exercise the timeout branch without actually waiting 5 real
/// seconds. Production always calls this via `await_subscription_ack` with
/// `SUBSCRIPTION_ACK_TIMEOUT`.
async fn await_subscription_ack_within(
    events: &mut Receiver<Value>,
    sub_id: &str,
    timeout: Duration,
) -> Result<()> {
    let wait = async {
        loop {
            match events.recv().await {
                Ok(event) => {
                    let id = event.get("id").and_then(Value::as_str).unwrap_or_default();
                    // FIX-ROUND 4: a REJECTION does not come back under the
                    // request's own id. Probed live against Herdr 0.8.0: a
                    // subscription list containing one bad per-pane entry is
                    // rejected wholesale under a DERIVED id naming the
                    // offending entry —
                    //   {"id":"aoa-sub-0:sub:1:probe",
                    //    "error":{"code":"pane_not_found",
                    //             "message":"pane wZZ:p99 not found"}}
                    // — and Herdr then closes the connection. Matching only
                    // the exact id would skip that error, fall through to
                    // the subsequent EOF, and report the useless
                    // "connection closed while awaiting subscription ack"
                    // instead of the actual `pane_not_found` diagnosis.
                    // Accept our id or any id derived from it.
                    let is_ours =
                        id == sub_id || id.strip_prefix(sub_id).is_some_and(|r| r.starts_with(':'));
                    if !is_ours {
                        // Not our ack. Real event deliveries carry no `id`
                        // at all (fix-round finding 6), so this branch in
                        // practice only matters if some other id shows up
                        // first; either way, keep waiting for our own.
                        continue;
                    }
                    return match event.get("error") {
                        Some(err) => Err(anyhow!("herdr rejected events.subscribe: {err}")),
                        None => Ok(()),
                    };
                }
                // Essentially impossible this early (nothing but our own
                // subscribe request has been sent yet), but don't treat it
                // as fatal if it somehow happens — keep waiting for the ack.
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => {
                    return Err(anyhow!("connection closed while awaiting subscription ack"))
                }
            }
        }
    };
    tokio::time::timeout(timeout, wait)
        .await
        .unwrap_or_else(|_| Err(anyhow!("timed out waiting for events.subscribe ack")))
}

/// Extracts the event-type string from a raw delivery on the event bus.
///
/// AMENDMENT 3 finding: the brief guessed the type would live at either
/// `event.type` (nested) or top-level `type`, using the same dotted
/// spelling (`"pane.updated"`) as the `events.subscribe` filter. Neither
/// guess matches what real Herdr 0.8.0 sends. A genuine subscription
/// delivery looks like:
///
/// ```json
/// {"event":"pane_updated","data":{"pane":{...},"type":"pane_updated"}}
/// ```
///
/// i.e. the type lives at the **top-level `event` key as a bare string**
/// (also duplicated at `data.type`), and it is spelled with an
/// **underscore** (`pane_updated`), not the dot (`pane.updated`) used in
/// the subscribe request's filter list. The brief's guessed shapes are
/// kept as defensive fallbacks in case a future protocol version nests
/// things differently, but the real shape is checked first.
fn raw_event_type(event: &Value) -> Option<&str> {
    event
        .get("event")
        .and_then(Value::as_str) // real shape: top-level `event` is a bare string
        .or_else(|| event.get("data").and_then(|d| d.get("type")).and_then(Value::as_str))
        .or_else(|| event.get("event").and_then(|e| e.get("type")).and_then(Value::as_str))
        .or_else(|| event.get("type").and_then(Value::as_str))
}

/// True if the delivered type string `delivered` names the subscription
/// filter type `filter`, in either spelling.
///
/// Real global deliveries use `pane_updated`; WORLD_EVENTS (and the
/// subscribe filter) use `pane.updated`. Normalize the filter to the
/// underscore spelling rather than guessing at splitting the delivered
/// string, since every filter type has exactly one dot separating
/// "category" from "action".
///
/// FIX-ROUND 4: both spellings genuinely occur in the wild, so neither can
/// be assumed. Global deliveries arrive underscored (`pane_created`), but
/// per-pane `pane.agent_status_changed` deliveries were observed arriving
/// with the DOTTED name verbatim. Checking both costs one string compare.
fn matches_event_type(filter: &str, delivered: &str) -> bool {
    filter == delivered || filter.replace('.', "_") == delivered
}

pub fn is_world_changing(event: &Value) -> bool {
    match raw_event_type(event) {
        Some(t) => {
            WORLD_EVENTS.iter().any(|w| matches_event_type(w, t))
                // FIX-ROUND 4: `pane.agent_status_changed` is not in
                // WORLD_EVENTS (it can only be subscribed per-pane, so it
                // must not go into the global filter list), but it is very
                // much world-changing — it is THE event that tells us an
                // agent now needs the user.
                || matches_event_type(PANE_STATUS_EVENT, t)
        }
        None => false,
    }
}

/// Opens a brand-new connection, performs exactly one `session.snapshot`
/// call on it, and leaves it for Herdr to close afterward.
///
/// FIX-ROUND 3 (architecture): raw socket probes against live Herdr 0.8.0
/// showed that a connection serves EXACTLY ONE request and then Herdr
/// closes it — a second request on the same connection reads EOF and the
/// following write fails with a broken pipe. The sole exception is
/// `events.subscribe`, whose connection Herdr keeps open indefinitely to
/// stream deliveries. `run_connection_loop` originally called
/// `fetch_snapshot` on the SAME connection it had just used for
/// `events.subscribe` — every one of those snapshot calls silently failed
/// (a second request on a subscription connection), `proven` was never
/// reached, and the UI never received a world with any islands (Task 8
/// wired the whole pipeline up correctly and still saw nothing, for
/// exactly this reason). Every snapshot fetch — the initial one, every
/// re-snapshot after a world-changing event, and every lag resync — MUST
/// go through this helper instead of reusing the subscription's client.
async fn fetch_snapshot_fresh(path: &Path) -> Result<Snapshot> {
    let client = HerdrClient::connect(path).await?;
    fetch_snapshot(&client).await
}

/// The identity of a snapshot's pane set: every `pane_id`, sorted and
/// deduplicated, so two snapshots listing the same panes in a different
/// order compare equal.
///
/// FIX-ROUND 4: this normalization is the whole anti-re-subscribe-loop
/// mechanism. Re-subscribing makes Herdr replay a backlog (~39 events in
/// ~0.1s, measured), each world-changing replay forces a re-snapshot, and
/// if a re-snapshot could ever *look* like a pane-set change we would
/// re-subscribe forever. Comparing normalized identity — not snapshot
/// contents, not pane count, not order — means a replay burst over an
/// unchanged pane set is provably a no-op.
fn pane_set(snapshot: &Snapshot) -> Vec<String> {
    let mut ids: Vec<String> = snapshot.panes.iter().map(|p| p.pane_id.clone()).collect();
    ids.sort();
    ids.dedup();
    ids
}

/// How one subscription attempt ended.
enum Attempt {
    /// The connection failed, was rejected, or closed. Back off and retry.
    Reconnect,
    /// Same as `Reconnect`, but the per-pane subscription list is itself
    /// suspect and must be dropped before retrying.
    ///
    /// FIX-ROUND 4, probed live against Herdr 0.8.0: a subscription list
    /// containing a `pane_id` that no longer exists is rejected WHOLESALE
    /// (`pane_not_found`) — the valid global entries are not honored either,
    /// and the connection is closed. Pane ids come from a snapshot taken
    /// moments earlier, so a pane closing inside that race window would
    /// otherwise wedge the app permanently: every retry would resend the
    /// same stale list and be rejected the same way, forever, with the UI
    /// stuck on `disconnected()`. Falling back to a globals-only
    /// subscription always succeeds, and its snapshot re-derives a live
    /// pane set for the attempt after it.
    ReconnectWithoutPerPane,
    /// The known pane set changed, so the per-pane subscriptions are stale.
    /// Re-subscribe immediately (no backoff — nothing is wrong) with this
    /// set. See `RESUBSCRIBE_THROTTLE` for the one delay that does apply.
    Resubscribe(Vec<String>),
}

/// A floor on how fast back-to-back re-subscribes can happen.
///
/// FIX-ROUND 4: `Attempt::Resubscribe` deliberately skips the reconnect
/// backoff, because a pane-set change is normal operation rather than a
/// fault, and the user should see a newly-created agent's blocked state
/// promptly. `pane_set` identity already guarantees the sequence settles
/// for any stable pane set. This throttle only bounds the pathological
/// case that identity cannot rule out — a pane set genuinely oscillating
/// (something outside the app creating and destroying panes in a tight
/// loop) — to a handful of connections per second instead of as fast as
/// Herdr can answer. It costs one extra sixth of a second on the single
/// startup re-subscribe (globals-only → globals + the first panes).
const RESUBSCRIBE_THROTTLE: Duration = Duration::from_millis(150);

/// Runs `build_world` on a blocking-pool thread rather than the tokio task
/// that owns this event loop.
///
/// `build_world` (`world::attention::build_world`) calls into
/// `RepoResolver`, which on a cache miss shells out to real `git` via
/// `RealGit::run`/`RealGit::last_commit_epoch` — bounded by
/// `RealGit::DEFAULT_TIMEOUT` (10s), but still a SYNCHRONOUS subprocess
/// wait. Calling it inline here, as this loop always did before this fix,
/// blocks whichever tokio worker thread is running this future for up to
/// that whole ceiling on every cache miss (a cold cwd, a repo whose TTL on
/// `last_changed` just expired) — during which no herdr event anywhere in
/// the process is dequeued, which is the exact hazard `docs/superpowers/
/// phase-0-followups.md` §6 flags as the one remaining gap in the timeout
/// fix. `tauri::async_runtime::spawn_blocking` is the same mechanism
/// `commands::city_for` already uses for the same reason (see its doc
/// comment) — moving the blocking call to a dedicated blocking-pool thread
/// frees this task's worker thread to keep servicing everything else (other
/// Tauri commands, other tokio tasks) while git runs.
///
/// `snapshot`, `resolver` and `stops` are taken BY VALUE and handed back in
/// the result, rather than passed as `&mut`, because `spawn_blocking`'s
/// closure must be `'static`: a borrow tied to `run_subscription_attempt`'s
/// stack frame cannot be moved onto a different thread. Every caller
/// `.await`s this before doing anything else with the values it hands back,
/// which preserves exactly the two properties that matter here and would be
/// silently lost by a fire-and-forget `tokio::spawn` instead:
///
/// 1. **No concurrent `RepoResolver`/`StopMemory` access.** One build fully
///    finishes — including every mutation it makes to the resolver's caches
///    and to the stop-promotion history — before the next one is even
///    started. There is never a moment where two world-builds are resolving
///    the same repo, or reading `last_changed_cache`/`StopMemory` while
///    another build is writing it, so moving this work to another thread
///    changes WHERE the blocking happens, never the ordering of WHAT
///    happens or WHAT it can see.
/// 2. **No world renders ahead of its own git resolution.** `on_state` (see
///    every call site below) is still invoked only after this returns, so
///    the sequence stays "resolve every island's repo, THEN emit the
///    world" — never "emit a world, then silently correct an island's repo
///    a moment later," which is exactly the case the task brief calls out
///    (an agent visibly jumping between cities on screen).
async fn build_world_off_thread(
    snapshot: Snapshot,
    mut resolver: RepoResolver,
    mut stops: StopMemory,
    seen: &SeenInbox,
) -> (WorldState, Snapshot, RepoResolver, StopMemory) {
    let seen = seen.take();
    tauri::async_runtime::spawn_blocking(move || {
        for pane_id in &seen {
            stops.mark_seen(pane_id);
        }
        let world = build_world(&snapshot, &mut resolver, &mut stops);
        (world, snapshot, resolver, stops)
    })
    .await
    .expect("build_world panicked")
}

/// Keeps one live subscription to Herdr's global world events, re-fetching
/// a full snapshot whenever something world-changing happens, and
/// reconnecting with backoff if the connection is ever lost.
///
/// FIX-ROUND 3 (architecture) — per-connection cost and storm guarding:
/// every snapshot fetch now opens a brand-new connection (see
/// `fetch_snapshot_fresh`), and each fresh `events.subscribe` on
/// reconnect appears to make Herdr replay a backlog of recent events (seen
/// empirically: a stale delivery from a much earlier, already-closed
/// workspace reappeared verbatim on a brand-new subscription during
/// testing). Deliberately NOT adding a debounce/coalescing guard for
/// Phase 0, for two reasons: (1) event processing here is single-consumer
/// and sequential — `events.recv().await` is not polled again until the
/// current re-snapshot's `fetch_snapshot_fresh` call has fully returned,
/// so a burst of world-changing deliveries (a backlog replay or a flurry
/// of real activity) can only ever produce ONE snapshot connection
/// in-flight at a time, never an unbounded concurrent storm; and (2) the
/// outer reconnect loop is still governed by the existing exponential
/// backoff (1s → 2s → 4s → capped at 30s), so a *connection*-level flap
/// cannot spin faster than that regardless of how many events a given
/// subscription attempt replays. The known cost this leaves on the table
/// — a burst of N world-changing deliveries still does N sequential fresh
/// connections/snapshots even though only the last one's result matters —
/// matches the brief's own explicit call: "Fetching a fresh
/// `session.snapshot` on every world-changing event is simpler and cannot
/// drift. Revisit only if profiling says so." Nothing here indicates
/// Phase 0 needs that revisit yet.
///
/// FIX-ROUND 4 (per-pane status subscriptions) — the shape of this loop:
/// there are now TWO reasons a subscription ends, and they must not be
/// conflated. `Attempt::Reconnect` means something is wrong (connect
/// failed, subscribe rejected, socket closed) and is governed by the
/// exponential backoff. `Attempt::Resubscribe` means nothing is wrong at
/// all — the pane set changed, so the per-pane subscription entries are
/// stale and a fresh connection must carry the new list. Putting a
/// pane-set change through the backoff would be wrong twice over: it would
/// delay the user's view of a brand-new agent, and it would ratchet the
/// backoff up on a purely healthy event.
pub async fn run_connection_loop<F>(path: PathBuf, seen: SeenInbox, on_state: F) -> !
where
    F: Fn(WorldState) + Send + 'static,
{
    let mut backoff = Duration::from_secs(1);
    // The pane set the NEXT subscription attempt will name per-pane. Starts
    // empty because we have not taken a snapshot yet: the first attempt
    // subscribes to the globals only, its snapshot reveals the panes, and
    // that mismatch drives exactly one immediate re-subscribe.
    let mut pane_ids: Vec<String> = Vec::new();
    // NOTE (fix-round finding 5): `RepoResolver` memoizes per cwd for the
    // entire lifetime of this loop (it's created once, outside the
    // reconnect loop below) and is never invalidated. If a repo is
    // deleted, moved, or `git init`ed for the first time after we've
    // already resolved a given cwd, this resolver keeps returning its
    // original (now possibly wrong or missing) answer until the whole
    // process restarts. Acceptable for Phase 0's scope; revisit if it
    // becomes a real problem.
    let mut resolver = RepoResolver::new(Box::new(RealGit::default()));
    // FINAL REVIEW, critical 1: the cross-snapshot history behind the
    // "idle-after-work means STOPPED" promotion (see `StopMemory`). Like
    // `resolver`, it is created ONCE here, outside the reconnect loop, and
    // deliberately survives reconnects: a dropped herdr connection is a
    // transport fact, not evidence that every stopped agent resumed work.
    // Losing it on reconnect would silently downgrade every already-stopped
    // island back to a calm `·` until its agent happened to work again.
    let mut stops = StopMemory::default();

    loop {
        let (attempt, next_resolver, next_stops) = run_subscription_attempt(
            &path,
            &pane_ids,
            &on_state,
            &seen,
            resolver,
            stops,
            &mut backoff,
        )
        .await;
        resolver = next_resolver;
        stops = next_stops;
        match attempt {
            Attempt::Resubscribe(next_pane_ids) => {
                // Healthy path: no backoff, no `disconnected()` — the world
                // we just emitted is current and correct, we merely need a
                // connection whose subscription list names the new panes.
                // Guaranteed to settle: `next_pane_ids` is what the latest
                // snapshot actually contains, so the very next attempt's
                // snapshot matches it unless the pane set changed AGAIN in
                // the meantime, which is real news and deserves another
                // re-subscribe.
                pane_ids = next_pane_ids;
                tokio::time::sleep(RESUBSCRIBE_THROTTLE).await;
            }
            Attempt::ReconnectWithoutPerPane => {
                pane_ids.clear();
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
            Attempt::Reconnect => {
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}

/// One subscription's whole life: connect, subscribe (globals + one
/// `PANE_STATUS_EVENT` entry per id in `pane_ids`), confirm the ack, take
/// the initial snapshot, then stream events until the connection dies or
/// the pane set moves out from under the subscription.
///
/// `backoff` is reset to the 1s floor here — and ONLY here — at the moment
/// the connection is proven (ack confirmed AND a real snapshot in hand),
/// exactly as before this fix round.
///
/// `resolver` and `stops` are taken and returned BY VALUE, rather than as
/// `&mut`, purely so the git-resolving parts of this function's body can
/// hand them to `build_world_off_thread` (whose `spawn_blocking` closure
/// must own `'static` data — see that function's doc comment) and get them
/// back again; every `return` below hands them straight back unchanged when
/// this attempt never got as far as resolving anything.
async fn run_subscription_attempt<F>(
    path: &Path,
    pane_ids: &[String],
    on_state: &F,
    seen: &SeenInbox,
    resolver: RepoResolver,
    stops: StopMemory,
    backoff: &mut Duration,
) -> (Attempt, RepoResolver, StopMemory)
where
    F: Fn(WorldState) + Send + 'static,
{
    // FIX-ROUND 3 (architecture): `sub_client` is used for exactly one
    // thing — sending `events.subscribe` and then reading deliveries via
    // `events` below. It must NEVER be used to make a `call()`; every
    // snapshot fetch goes through `fetch_snapshot_fresh(path)`, which opens
    // its own connection. See `fetch_snapshot_fresh`'s doc comment for why
    // (real Herdr allows exactly one request per connection, subscribe
    // excepted). FIX-ROUND 4 leans on the same rule from the other side:
    // because a second `events.subscribe` cannot be sent on this
    // connection, changing the per-pane subscription list means dropping
    // `sub_client` and starting over — which is what returning
    // `Attempt::Resubscribe` does.
    let sub_client = match HerdrClient::connect(path).await {
        Ok(client) => client,
        Err(e) => {
            eprintln!("herdr events: connect failed: {e}");
            on_state(WorldState::disconnected());
            return (Attempt::Reconnect, resolver, stops);
        }
    };
    let mut events = sub_client.subscribe_events();

    let subscribed = match subscribe_world(&sub_client, pane_ids).await {
        Ok(sub_id) => match await_subscription_ack(&mut events, &sub_id).await {
            Ok(()) => true,
            Err(e) => {
                eprintln!("herdr events: subscription not confirmed: {e}");
                false
            }
        },
        Err(e) => {
            eprintln!("herdr events: failed to send events.subscribe: {e}");
            false
        }
    };

    // Fix-round-2 finding: a subscription that can never be established
    // (e.g. a future Herdr renaming one of the `WORLD_EVENTS` types) must
    // not retry silently. Without this, the round-1 fix stopped the hang
    // but still left the UI showing the last-known-good world as if it were
    // live, forever, with only an `eprintln!` as a trace. Symmetric with
    // the initial-snapshot-failure case below: say the world is unusable
    // rather than let it look stale-but-live.
    if !subscribed {
        on_state(WorldState::disconnected());
        // FIX-ROUND 4: if we named any panes, assume the rejection was
        // about one of them and retry without them rather than resending an
        // identical, identically-doomed list. See `ReconnectWithoutPerPane`.
        let attempt = if pane_ids.is_empty() {
            Attempt::Reconnect
        } else {
            Attempt::ReconnectWithoutPerPane
        };
        return (attempt, resolver, stops);
    }

    // FIX-ROUND 3 DECISION: a failed *initial* snapshot is still treated as
    // "this whole connection attempt failed" — `sub_client` is dropped on
    // return and we fall through to backoff/reconnect, which re-subscribes
    // from scratch next time. This is deliberate, not an oversight: we have
    // never proven this connection, so we have no live world to protect
    // from a false "disconnected" signal — the UI genuinely has nothing to
    // show, so saying so is honest. This is DIFFERENT from a re-snapshot or
    // lag-resync failure below, which happens only once the subscription is
    // already proven and actively delivering events on a demonstrably live
    // connection; tearing the whole thing down for one failed call
    // connection there would be dishonest in the other direction.
    let snapshot = match fetch_snapshot_fresh(path).await {
        Ok(snapshot) => snapshot,
        Err(e) => {
            // Fix-round finding 3: don't leave the UI lying about the
            // last-known-good world when the very first snapshot on this
            // connection fails (e.g. a wedged herdr — `call()`'s own 10s
            // timeout means this isn't instant, but it does eventually
            // return an error rather than hang forever). Say so explicitly.
            eprintln!("herdr events: initial snapshot failed: {e}");
            on_state(WorldState::disconnected());
            return (Attempt::Reconnect, resolver, stops);
        }
    };

    // Fix-round finding 2: only treat the connection as proven (and reset
    // backoff) once we've actually confirmed the subscription AND pulled a
    // real snapshot — not merely on a successful `connect()`. A socket that
    // accepts and then immediately EOFs (herdr mid-restart) would otherwise
    // pin the retry cycle at the 1s floor forever.
    //
    // `build_world_off_thread` moves this (potentially git-shelling-out)
    // work to a blocking-pool thread — see its doc comment for why and for
    // the ordering/concurrency properties `.await`ing it here preserves.
    let (world, snapshot, mut resolver, mut stops) =
        build_world_off_thread(snapshot, resolver, stops, seen).await;
    on_state(world);
    *backoff = Duration::from_secs(1);

    // FIX-ROUND 4: emit the world FIRST (it is correct and the user should
    // see it now), and only then notice that our per-pane subscriptions
    // don't cover it. On the very first attempt this always fires once,
    // because we necessarily subscribed before we knew any pane ids.
    let observed = pane_set(&snapshot);
    if observed != pane_ids {
        return (Attempt::Resubscribe(observed), resolver, stops);
    }

    loop {
        // A seen-wake arrives as `Value::Null`: it changes the world exactly
        // like a herdr event would, so it takes the same resnapshot path.
        let received = tokio::select! {
            received = events.recv() => received,
            () = seen.wait() => Ok(Value::Null),
        };
        match received {
            Ok(event) => {
                if event.is_null() || is_world_changing(&event) {
                    // FIX-ROUND 3 DECISION: a failing call connection here
                    // does NOT tear down the subscription and does NOT call
                    // `disconnected()`. The subscription connection
                    // (`events.recv()` above just succeeded) is demonstrably
                    // alive; only this one independent snapshot
                    // connection/call failed. That is not "we cannot see
                    // herdr" — it's "one call hiccuped while we can still
                    // see herdr fine" — so log and wait for the next event,
                    // which may well succeed.
                    match fetch_snapshot_fresh(path).await {
                        Ok(snapshot) => {
                            let (world, snapshot, next_resolver, next_stops) =
                                build_world_off_thread(snapshot, resolver, stops, seen).await;
                            resolver = next_resolver;
                            stops = next_stops;
                            on_state(world);
                            let observed = pane_set(&snapshot);
                            if observed != pane_ids {
                                return (Attempt::Resubscribe(observed), resolver, stops);
                            }
                        }
                        Err(e) => {
                            eprintln!("herdr events: resnapshot after event failed: {e}")
                        }
                    }
                }
            }
            Err(RecvError::Lagged(n)) => {
                // We fell behind the broadcast channel's 256-slot buffer
                // (the loop body awaits `fetch_snapshot_fresh`, which can
                // take seconds). State is now uncertain, so force a full
                // resync rather than silently exiting the loop — see
                // `HerdrClient::subscribe_events`'s doc comment. Same
                // fix-round-3 decision as above: a failed resync call is
                // logged only, not `disconnected()`. FIX-ROUND 4: the
                // dropped events may well have included a pane creation, so
                // the resync snapshot's pane set is checked here too —
                // otherwise a lag could permanently blind us to a new pane's
                // status changes.
                eprintln!(
                    "herdr events: lagged, dropped {n} event(s); resyncing via snapshot"
                );
                match fetch_snapshot_fresh(path).await {
                    Ok(snapshot) => {
                        let (world, snapshot, next_resolver, next_stops) =
                            build_world_off_thread(snapshot, resolver, stops, seen).await;
                        resolver = next_resolver;
                        stops = next_stops;
                        on_state(world);
                        let observed = pane_set(&snapshot);
                        if observed != pane_ids {
                            return (Attempt::Resubscribe(observed), resolver, stops);
                        }
                    }
                    Err(e) => {
                        eprintln!("herdr events: resync snapshot after lag failed: {e}")
                    }
                }
            }
            Err(RecvError::Closed) => {
                // Fix-round-2 finding: the connection was confirmed and
                // alive (we only reach this loop once proven) and has now
                // genuinely gone away. The UI was shown a live world on this
                // connection, so it must be told that world is no longer
                // current before we fall through to reconnect — otherwise a
                // closed-then-reconnecting herdr leaves stale data on screen
                // with zero signal, silently.
                eprintln!("herdr events: connection closed; reconnecting");
                on_state(WorldState::disconnected());
                return (Attempt::Reconnect, resolver, stops);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::snapshot::AgentStatus;
    use crate::herdr::testing::FakeHerdr;
    use crate::world::repo::GitProbe;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};

    #[test]
    fn subscribes_to_every_global_world_event() {
        assert!(WORLD_EVENTS.contains(&"pane.updated"));
        assert!(WORLD_EVENTS.contains(&"pane.created"));
        assert!(WORLD_EVENTS.contains(&"pane.closed"));
        assert!(WORLD_EVENTS.contains(&"pane.exited"));
        assert!(WORLD_EVENTS.contains(&"pane.agent_detected"));
        assert!(WORLD_EVENTS.contains(&"workspace.created"));
        assert!(WORLD_EVENTS.contains(&"workspace.closed"));
        assert!(
            !WORLD_EVENTS.contains(&PANE_STATUS_EVENT),
            "that event requires a concrete pane_id and cannot be subscribed globally"
        );
    }

    #[tokio::test]
    async fn subscribe_world_adds_one_per_pane_entry_per_pane() {
        let seen: Arc<StdMutex<Vec<Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let seen_for_handler = seen.clone();
        let fake = FakeHerdr::start_one_request_per_connection(move |req| {
            seen_for_handler
                .lock()
                .unwrap()
                .push(req.params.get("subscriptions").cloned().unwrap_or(Value::Null));
            Ok(json!({"type": "subscription_started"}))
        })
        .await;

        let client = HerdrClient::connect(fake.path()).await.unwrap();
        let mut events = client.subscribe_events();
        let sub_id =
            subscribe_world(&client, &["w1:p1".to_string(), "w1:p2".to_string()]).await.unwrap();
        await_subscription_ack(&mut events, &sub_id).await.unwrap();

        let recorded = seen.lock().unwrap();
        let entries = recorded[0].as_array().unwrap();
        // Every global is still there — per-pane entries are additive, they
        // never replace the lifecycle subscription.
        for global in WORLD_EVENTS {
            assert!(
                entries.iter().any(|e| e["type"] == global && e.get("pane_id").is_none()),
                "global {global} missing from {recorded:?}"
            );
        }
        assert_eq!(per_pane_ids(&recorded[0]), vec!["w1:p1".to_string(), "w1:p2".to_string()]);
    }

    #[test]
    fn a_status_change_is_world_changing_in_both_spellings() {
        // The delivered spelling cannot be assumed. Global deliveries are
        // underscored (`pane_created`), but live Herdr 0.8.0 delivers the
        // per-pane one with the DOTTED name verbatim — captured live:
        //   {"event":"pane.agent_status_changed",
        //    "data":{"agent":"claude","agent_status":"blocked",
        //            "pane_id":"wP:p1","workspace_id":"wP"}}
        assert!(is_world_changing(&json!({
            "event": "pane.agent_status_changed",
            "data": {"agent_status": "blocked", "pane_id": "wP:p1"}
        })));
        assert!(is_world_changing(&json!({"event": "pane_agent_status_changed"})));
        assert!(is_world_changing(&json!({"data": {"type": "pane.agent_status_changed"}})));
        assert!(is_world_changing(&json!({"type": "pane.agent_status_changed"})));
    }

    #[test]
    fn pane_set_identity_ignores_order_and_duplicates() {
        // This is what stops a re-subscribe loop, so pin it down directly.
        fn snap(ids: &[&str]) -> Snapshot {
            Snapshot {
                version: "0.8.0".into(),
                protocol: 19,
                panes: ids
                    .iter()
                    .map(|id| crate::herdr::snapshot::Pane {
                        pane_id: (*id).into(),
                        workspace_id: "w1".into(),
                        cwd: None,
                        foreground_cwd: None,
                        agent_status: AgentStatus::Working,
                        terminal_title: None, agent: None,
                    })
                    .collect(),
                workspaces: vec![],
                focused_pane_id: None,
            }
        }
        assert_eq!(pane_set(&snap(&["w1:p2", "w1:p1"])), pane_set(&snap(&["w1:p1", "w1:p2"])));
        assert_eq!(pane_set(&snap(&["w1:p1", "w1:p1"])), vec!["w1:p1".to_string()]);
        // Only a genuine membership change compares unequal.
        assert_ne!(pane_set(&snap(&["w1:p1"])), pane_set(&snap(&["w1:p1", "w1:p2"])));
        // ...including a status-only change, which must NOT re-subscribe:
        // pane_set reads only ids, so two snapshots differing solely in
        // agent_status are identical here by construction.
    }

    #[test]
    fn world_changing_events_are_recognised() {
        // Real Herdr 0.8.0 shape, captured live (amendment 3): the type is
        // a bare string at top-level `event`, spelled with an underscore,
        // and duplicated at `data.type`.
        assert!(is_world_changing(&json!({
            "event": "pane_updated",
            "data": {"type": "pane_updated", "pane": {"pane_id": "w1:p1"}}
        })));
        assert!(is_world_changing(&json!({"event": "pane_created"})));
        assert!(is_world_changing(&json!({"event": "workspace_created"})));
        // `pane.agent_detected` has an internal underscore in its "action"
        // half too — must still normalize correctly against `pane_agent_detected`.
        assert!(is_world_changing(&json!({"event": "pane_agent_detected"})));
        // Defensive fallbacks for the brief's originally-guessed shapes,
        // kept in case a future protocol version nests things that way.
        assert!(is_world_changing(&json!({"event":{"type":"pane.updated"}})));
        assert!(is_world_changing(&json!({"type":"pane.created"})));
    }

    #[test]
    fn unrelated_events_are_ignored() {
        assert!(!is_world_changing(&json!({"event": "pane_scroll_changed"})));
        assert!(!is_world_changing(&json!({"result":{"type":"pong"}})));
        // The subscription-started ack: real shape, but not a world event.
        assert!(!is_world_changing(&json!({"id":"aoa-sub-0","result":{"type":"subscription_started"}})));
    }

    // Fix-round finding 1 coverage for `await_subscription_ack`.

    #[tokio::test]
    async fn await_subscription_ack_succeeds_on_matching_result() {
        let (tx, mut rx) = tokio::sync::broadcast::channel(4);
        tx.send(json!({"id": "aoa-sub-0", "result": {"type": "subscription_started"}}))
            .unwrap();
        await_subscription_ack(&mut rx, "aoa-sub-0").await.unwrap();
    }

    #[tokio::test]
    async fn await_subscription_ack_skips_unrelated_deliveries_first() {
        // A real world event delivered before our ack must not be mistaken
        // for it, or be lost — it's simply skipped while we keep waiting.
        let (tx, mut rx) = tokio::sync::broadcast::channel(4);
        tx.send(json!({"event": "pane_updated", "data": {"type": "pane_updated"}}))
            .unwrap();
        tx.send(json!({"id": "aoa-sub-0", "result": {"type": "subscription_started"}}))
            .unwrap();
        await_subscription_ack(&mut rx, "aoa-sub-0").await.unwrap();
    }

    #[tokio::test]
    async fn await_subscription_ack_fails_on_rejection() {
        // Real Herdr rejects a bad subscription list with an error reply.
        let (tx, mut rx) = tokio::sync::broadcast::channel(4);
        tx.send(json!({
            "id": "aoa-sub-0",
            "error": {"code": "invalid_request", "message": "unknown event type"}
        }))
        .unwrap();
        let err = await_subscription_ack(&mut rx, "aoa-sub-0").await.unwrap_err();
        assert!(err.to_string().contains("rejected"), "got: {err}");
    }

    #[tokio::test]
    async fn await_subscription_ack_fails_on_a_rejection_under_a_derived_id() {
        // Real shape, probed live against Herdr 0.8.0: a per-pane entry
        // naming a pane that no longer exists rejects the WHOLE
        // subscription under an id derived from ours, not our id itself.
        let (tx, mut rx) = tokio::sync::broadcast::channel(4);
        tx.send(json!({
            "id": "aoa-sub-0:sub:1:probe",
            "error": {"code": "pane_not_found", "message": "pane wZZ:p99 not found"}
        }))
        .unwrap();
        let err = await_subscription_ack(&mut rx, "aoa-sub-0").await.unwrap_err();
        assert!(err.to_string().contains("pane_not_found"), "got: {err}");
        // A DIFFERENT subscription's id must not be swallowed as ours.
        let (tx2, mut rx2) = tokio::sync::broadcast::channel(4);
        tx2.send(json!({"id": "aoa-sub-00", "result": {"type": "subscription_started"}})).unwrap();
        tx2.send(json!({"id": "aoa-sub-0", "result": {"type": "subscription_started"}})).unwrap();
        await_subscription_ack(&mut rx2, "aoa-sub-0").await.unwrap();
    }

    #[tokio::test]
    async fn a_rejected_per_pane_subscription_falls_back_to_globals_only_and_recovers() {
        // The race this closes: pane ids come from a snapshot taken moments
        // earlier, so a pane can close between the snapshot and the
        // subscribe. Live Herdr rejects the WHOLE list for one stale
        // pane_id, so without a fallback the loop would resend the same
        // doomed list forever and the UI would sit on `disconnected()`.
        //
        // The fake models exactly that: it rejects any subscription naming
        // the ghost pane, and its snapshot lists the ghost only once.
        let ghost_gone = Arc::new(AtomicUsize::new(0));
        let ghost_gone_for_handler = ghost_gone.clone();
        let subs: Arc<StdMutex<Vec<Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let subs_for_handler = subs.clone();

        let fake = FakeHerdr::start_one_request_per_connection(move |req| {
            match req.method.as_str() {
                "events.subscribe" => {
                    let entries = req.params["subscriptions"].clone();
                    subs_for_handler.lock().unwrap().push(entries.clone());
                    if per_pane_ids(&entries).iter().any(|id| id == "w1:ghost") {
                        return Err((
                            "pane_not_found".to_string(),
                            "pane w1:ghost not found".to_string(),
                        ));
                    }
                    Ok(json!({"type": "subscription_started"}))
                }
                "session.snapshot" => {
                    let mut panes = vec![json!({
                        "pane_id": "w1:p1", "workspace_id": "w1",
                        "cwd": REPO_CWD, "agent_status": "working",
                    })];
                    // The ghost appears in the first snapshot only, then
                    // closes — just as it would in the real race.
                    if ghost_gone_for_handler.fetch_add(1, Ordering::SeqCst) == 0 {
                        panes.push(json!({
                            "pane_id": "w1:ghost", "workspace_id": "w1",
                            "cwd": REPO_CWD, "agent_status": "working",
                        }));
                    }
                    Ok(json!({
                        "version": "0.8.0", "protocol": 19,
                        "panes": panes, "workspaces": [],
                    }))
                }
                other => panic!("unexpected method {other}"),
            }
        })
        .await;

        let states: Arc<StdMutex<Vec<WorldState>>> = Arc::new(StdMutex::new(Vec::new()));
        let states_for_cb = states.clone();
        let path = fake.path().to_path_buf();
        tokio::spawn(run_connection_loop(path, SeenInbox::default(), move |world| {
            states_for_cb.lock().unwrap().push(world);
        }));

        // It must end up on a healthy per-pane subscription for the pane
        // that actually exists, never wedged on the rejected list. (One
        // backoff sleep of 1s is in the way, hence the generous wait.)
        assert!(
            eventually(|| {
                subs.lock().unwrap().iter().any(|s| per_pane_ids(s) == vec!["w1:p1".to_string()])
            })
            .await,
            "never recovered to a valid per-pane subscription; tried: {:?}",
            subs.lock().unwrap()
        );
        // And the fallback attempt in between must have carried no per-pane
        // entries at all, so it could actually be accepted.
        assert!(
            subs.lock().unwrap().iter().any(|s| per_pane_ids(s).is_empty()),
            "expected a globals-only fallback subscription"
        );
        assert!(
            states.lock().unwrap().iter().any(|w| w.herdr_connected),
            "the UI must end up seeing a live world, not a permanent disconnect"
        );
    }

    #[tokio::test]
    async fn await_subscription_ack_fails_when_connection_closes_first() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<Value>(4);
        drop(tx);
        let err = await_subscription_ack(&mut rx, "aoa-sub-0").await.unwrap_err();
        assert!(err.to_string().contains("closed"), "got: {err}");
    }

    #[tokio::test]
    async fn await_subscription_ack_times_out_when_no_ack_ever_arrives() {
        // Fix-round-2 minor: exercise the timeout branch without actually
        // waiting the production 5s — drive the parameterized helper with a
        // short timeout instead. `tx` is kept alive (not dropped) for the
        // whole wait so this genuinely exercises "channel open, but
        // silent", not the already-covered `Closed` case.
        let (tx, mut rx) = tokio::sync::broadcast::channel::<Value>(4);
        let err = await_subscription_ack_within(&mut rx, "aoa-sub-0", Duration::from_millis(20))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
        drop(tx);
    }

    // Fix-round-3 (architecture) regression coverage: real Herdr allows
    // exactly one request per connection, subscribe excepted. These tests
    // use `FakeHerdr::start_one_request_per_connection`, which enforces
    // that, and fail if any code under test reuses a subscription
    // connection to make a call — exactly the bug this fix round exists to
    // close, and exactly the untested combination that let it ship with a
    // fully green suite (the original, more forgiving `FakeHerdr::start`
    // happily answers many requests on one connection).

    #[tokio::test]
    async fn a_call_after_subscribing_opens_its_own_connection_and_succeeds() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| match req.method.as_str() {
            "events.subscribe" => Ok(json!({"type": "subscription_started"})),
            "session.snapshot" => {
                Ok(json!({"version": "0.8.0", "protocol": 19, "panes": [], "workspaces": []}))
            }
            other => panic!("unexpected method {other}"),
        })
        .await;

        let sub_client = HerdrClient::connect(fake.path()).await.unwrap();
        let mut events = sub_client.subscribe_events();
        let sub_id = subscribe_world(&sub_client, &[]).await.unwrap();
        await_subscription_ack(&mut events, &sub_id).await.unwrap();

        // This MUST open its own connection. Reusing `sub_client` here
        // (the pre-fix behavior) would read EOF against this fake, exactly
        // as it silently failed against real Herdr.
        let snapshot = fetch_snapshot_fresh(fake.path()).await.unwrap();
        assert_eq!(snapshot.protocol, 19);
    }

    #[tokio::test]
    async fn run_connection_loop_reaches_a_connected_world_and_resnapshots_on_events() {
        // End-to-end regression test for the exact failure Task 8 hit:
        // wiring `run_connection_loop` up correctly still produced no
        // world with islands, because the loop's own initial snapshot call
        // silently failed on the subscription's connection. This drives
        // the real `run_connection_loop` against the one-request-per-
        // connection fake and asserts it actually reaches a connected
        // world, and that a pushed delivery triggers exactly one more
        // snapshot call on its own connection.
        let snapshot_calls = Arc::new(AtomicUsize::new(0));
        let calls_for_handler = snapshot_calls.clone();
        let fake = FakeHerdr::start_one_request_per_connection(move |req| match req.method.as_str()
        {
            "events.subscribe" => Ok(json!({"type": "subscription_started"})),
            "session.snapshot" => {
                calls_for_handler.fetch_add(1, Ordering::Relaxed);
                Ok(json!({"version": "0.8.0", "protocol": 19, "panes": [], "workspaces": []}))
            }
            other => panic!("unexpected method {other}"),
        })
        .await;

        let states: Arc<StdMutex<Vec<WorldState>>> = Arc::new(StdMutex::new(Vec::new()));
        let states_for_cb = states.clone();
        let path = fake.path().to_path_buf();
        tokio::spawn(run_connection_loop(path, SeenInbox::default(), move |world| {
            states_for_cb.lock().unwrap().push(world);
        }));

        // Wait for the initial snapshot to land.
        for _ in 0..100 {
            if !states.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        {
            let seen = states.lock().unwrap();
            assert!(
                seen.iter().any(|w| w.herdr_connected),
                "expected a connected world after the initial snapshot, got: {seen:?}"
            );
        }
        assert_eq!(
            snapshot_calls.load(Ordering::Relaxed),
            1,
            "expected exactly one snapshot call for the initial connect"
        );

        // A world-changing delivery on the subscription connection must
        // trigger exactly one more snapshot call, on its own connection.
        fake.push_event(json!({"event": "pane_created", "data": {"type": "pane_created"}})).await;
        for _ in 0..100 {
            if snapshot_calls.load(Ordering::Relaxed) >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            snapshot_calls.load(Ordering::Relaxed),
            2,
            "expected a resnapshot after the world-changing event"
        );
    }

    // ---- Fix-round 4: per-pane `pane.agent_status_changed` subscriptions ----

    /// The app's own `RepoResolver` runs `RealGit`, so a fake pane's cwd has
    /// to be a genuine git repo or `build_world` drops it and produces no
    /// island at all. `src-tauri/` inside this very checkout always is one.
    const REPO_CWD: &str = env!("CARGO_MANIFEST_DIR");

    /// Polls `cond` for up to ~6s. Returns false if it never held.
    async fn eventually<F: FnMut() -> bool>(mut cond: F) -> bool {
        for _ in 0..600 {
            if cond() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    /// Every `pane_id` named by a `pane.agent_status_changed` entry in one
    /// recorded `events.subscribe` params payload, sorted.
    fn per_pane_ids(subscriptions: &Value) -> Vec<String> {
        let mut ids: Vec<String> = subscriptions
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|e| e.get("type").and_then(Value::as_str) == Some(PANE_STATUS_EVENT))
                    .filter_map(|e| e.get("pane_id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        ids.sort();
        ids
    }

    fn statuses_in(world: &WorldState) -> Vec<AgentStatus> {
        world.islands.iter().flat_map(|i| i.agents.iter().map(|a| a.status)).collect()
    }

    #[tokio::test]
    async fn a_pane_status_change_alone_reaches_on_state() {
        // THE DEFECT, in one test. An agent that is already known and
        // already working goes blocked. Herdr emits NOTHING on the global
        // subscription for that (verified against live Herdr 0.8.0) — the
        // only delivery is `pane.agent_status_changed`, and only to a
        // subscriber that named this pane_id explicitly. Before fix-round 4
        // the loop neither subscribed per-pane nor recognised that event
        // type, so the ❗ marker never appeared and the whole feature was
        // dead. This test drives exactly that sequence and demands the new
        // status reach `on_state`.
        let status = Arc::new(StdMutex::new("working"));
        let status_for_handler = status.clone();
        let fake = FakeHerdr::start_one_request_per_connection(move |req| {
            match req.method.as_str() {
                "events.subscribe" => Ok(json!({"type": "subscription_started"})),
                "session.snapshot" => Ok(json!({
                    "version": "0.8.0",
                    "protocol": 19,
                    "panes": [{
                        "pane_id": "w1:p1",
                        "workspace_id": "w1",
                        "cwd": REPO_CWD,
                        "agent_status": *status_for_handler.lock().unwrap(),
                    }],
                    "workspaces": [],
                })),
                other => panic!("unexpected method {other}"),
            }
        })
        .await;

        let states: Arc<StdMutex<Vec<WorldState>>> = Arc::new(StdMutex::new(Vec::new()));
        let states_for_cb = states.clone();
        let path = fake.path().to_path_buf();
        tokio::spawn(run_connection_loop(path, SeenInbox::default(), move |world| {
            states_for_cb.lock().unwrap().push(world);
        }));

        assert!(
            eventually(|| states
                .lock()
                .unwrap()
                .iter()
                .any(|w| statuses_in(w).contains(&AgentStatus::Working)))
            .await,
            "expected an initial world showing the pane working"
        );

        // Once the pane is known, the loop must re-subscribe so that
        // `pane.agent_status_changed` for it is actually covered. Wait for
        // that second subscription connection so the push below lands on
        // the live one. Bounded, so a loop that never re-subscribes (the
        // pre-fix behavior) still reaches the assertion instead of hanging.
        eventually(|| fake.subscription_generation() >= 2).await;

        *status.lock().unwrap() = "blocked";
        fake.push_event(json!({
            "event": PANE_STATUS_EVENT,
            "data": {
                "type": PANE_STATUS_EVENT,
                "pane_id": "w1:p1",
                "agent_status": "blocked",
            }
        }))
        .await;

        assert!(
            eventually(|| states
                .lock()
                .unwrap()
                .iter()
                .any(|w| statuses_in(w).contains(&AgentStatus::Blocked)))
            .await,
            "a pane going working -> blocked never reached on_state; seen: {:?}",
            states.lock().unwrap().iter().map(statuses_in).collect::<Vec<_>>()
        );
    }

    /// Creates a REAL git repository at `dir`, with everything the test
    /// depends on pinned locally so it cannot be knocked over by the
    /// machine's global git config: an explicit default branch name and a
    /// local `user.name`/`user.email`.
    fn init_real_repo(dir: &Path) {
        fn git(cwd: &Path, args: &[&str]) {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .status()
                .unwrap_or_else(|e| panic!("failed to spawn git {args:?} in {cwd:?}: {e}"));
            assert!(status.success(), "git {args:?} failed in {cwd:?}");
        }
        std::fs::create_dir_all(dir).unwrap();
        // `-c` is a global git option and must precede the subcommand.
        git(dir, &["-c", "init.defaultBranch=main", "init", "-q", "."]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "user.name", "Test User"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", "init"]);
    }

    #[tokio::test]
    async fn a_pane_in_a_real_git_repo_becomes_a_correctly_named_island() {
        // FINAL REVIEW, important 6: the biggest remaining test hole. Every
        // other loop test hands out `/p/...` paths that only the
        // `EveryDirIsARepo` fake can resolve, or points at this checkout's
        // own `src-tauri/`. Neither exercises the socket -> island half of
        // the pipeline against a repository the test itself created, so
        // repo resolution and island grouping inside the running loop were
        // proven only by the five `#[ignore]`d live tests — i.e. not in CI,
        // and not in the normal `cargo test` run.
        //
        // This drives the real `run_connection_loop` against a fake Herdr
        // whose pane cwd is inside a real, freshly `git init`ed temporary
        // repo, and demands a correctly NAMED island (the repo's directory
        // name, resolved through `RealGit`) comes out the far end.
        let tmp = tempfile::tempdir().expect("tempdir");
        // A distinctive name, so the assertion cannot accidentally pass on
        // some other island that wandered in.
        let repo = tmp.path().join("aoa-island-under-test");
        init_real_repo(&repo);
        // A subdirectory, so `RepoResolver` really has to walk up to the
        // repo root rather than being handed it.
        let pane_cwd = repo.join("src/deep");
        std::fs::create_dir_all(&pane_cwd).unwrap();
        let pane_cwd = pane_cwd.to_str().unwrap().to_string();

        let fake = FakeHerdr::start_one_request_per_connection(move |req| match req.method.as_str()
        {
            "events.subscribe" => Ok(json!({"type": "subscription_started"})),
            "session.snapshot" => Ok(json!({
                "version": "0.8.0",
                "protocol": 19,
                "panes": [{
                    "pane_id": "w1:p1",
                    "workspace_id": "w1",
                    "cwd": pane_cwd,
                    "agent_status": "working",
                }],
                "workspaces": [],
            })),
            other => panic!("unexpected method {other}"),
        })
        .await;

        let states: Arc<StdMutex<Vec<WorldState>>> = Arc::new(StdMutex::new(Vec::new()));
        let states_for_cb = states.clone();
        let path = fake.path().to_path_buf();
        tokio::spawn(run_connection_loop(path, SeenInbox::default(), move |world| {
            states_for_cb.lock().unwrap().push(world);
        }));

        assert!(
            eventually(|| {
                states.lock().unwrap().iter().any(|w| {
                    w.islands.iter().any(|i| {
                        i.name == "aoa-island-under-test"
                            && i.attention == crate::world::attention::Attention::Working
                            && i.agents.iter().any(|a| a.pane_id == "w1:p1" && !a.is_worktree)
                    })
                })
            })
            .await,
            "a pane inside a real git repo never produced its island; seen: {:?}",
            states
                .lock()
                .unwrap()
                .iter()
                .map(|w| w.islands.iter().map(|i| i.name.clone()).collect::<Vec<_>>())
                .collect::<Vec<_>>()
        );
        drop(tmp);
    }

    #[tokio::test]
    async fn a_pane_set_change_resubscribes_with_the_new_pane_and_then_settles() {
        // Per-pane subscriptions must track the pane set: a newly created
        // pane is useless to us until a subscription names it. And the
        // re-subscribe must SETTLE — Herdr replays a backlog on every fresh
        // subscribe (~39 events measured live), each replay triggers a
        // re-snapshot, and if a re-snapshot were mistaken for another
        // pane-set change we would re-subscribe forever.
        let pane_count = Arc::new(AtomicUsize::new(1));
        let pane_count_for_handler = pane_count.clone();
        let subs: Arc<StdMutex<Vec<Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let subs_for_handler = subs.clone();

        let fake = FakeHerdr::start_one_request_per_connection(move |req| {
            match req.method.as_str() {
                "events.subscribe" => {
                    subs_for_handler
                        .lock()
                        .unwrap()
                        .push(req.params.get("subscriptions").cloned().unwrap_or(Value::Null));
                    Ok(json!({"type": "subscription_started"}))
                }
                "session.snapshot" => {
                    let panes: Vec<Value> = (1..=pane_count_for_handler.load(Ordering::SeqCst))
                        .map(|n| {
                            json!({
                                "pane_id": format!("w1:p{n}"),
                                "workspace_id": "w1",
                                "cwd": REPO_CWD,
                                "agent_status": "working",
                            })
                        })
                        .collect();
                    Ok(json!({
                        "version": "0.8.0", "protocol": 19,
                        "panes": panes, "workspaces": [],
                    }))
                }
                other => panic!("unexpected method {other}"),
            }
        })
        .await;

        let path = fake.path().to_path_buf();
        tokio::spawn(run_connection_loop(path, SeenInbox::default(), |_world| {}));

        // First subscribe happens before any snapshot, so it can only carry
        // the globals. The snapshot then reveals w1:p1, which differs from
        // the (empty) subscribed set, so exactly one re-subscribe follows —
        // and this time it names the pane.
        assert!(
            eventually(|| subs.lock().unwrap().len() >= 2).await,
            "expected a re-subscription once the first pane became known"
        );
        {
            let recorded = subs.lock().unwrap();
            assert_eq!(per_pane_ids(&recorded[0]), Vec::<String>::new());
            assert_eq!(per_pane_ids(&recorded[1]), vec!["w1:p1".to_string()]);
        }

        // A second pane appears. The re-subscribe must cover BOTH panes —
        // dropping the old one would silently blind us to the agent we were
        // already watching.
        pane_count.store(2, Ordering::SeqCst);
        eventually(|| fake.subscription_generation() >= 2).await;
        fake.push_event(json!({"event": "pane_created", "data": {"type": "pane_created"}})).await;

        assert!(
            eventually(|| subs.lock().unwrap().len() >= 3).await,
            "expected a re-subscription after the pane set grew"
        );
        assert_eq!(
            per_pane_ids(&subs.lock().unwrap()[2]),
            vec!["w1:p1".to_string(), "w1:p2".to_string()]
        );

        // Now the settling proof: stand in for Herdr's replay backlog by
        // pushing a burst of world-changing deliveries with the pane set
        // unchanged. Each one forces a re-snapshot; none may be read as a
        // pane-set change.
        eventually(|| fake.subscription_generation() >= 3).await;
        for _ in 0..5 {
            fake.push_event(json!({"event": "pane_updated", "data": {"type": "pane_updated"}}))
                .await;
            fake.push_event(json!({"event": PANE_STATUS_EVENT, "data": {"type": PANE_STATUS_EVENT}}))
                .await;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            subs.lock().unwrap().len(),
            3,
            "the loop re-subscribed again on a replay burst that did not change the pane set"
        );
        assert_eq!(
            fake.subscription_generation(),
            3,
            "no extra subscription connections should have been opened"
        );
    }

    #[tokio::test]
    #[ignore = "requires a running herdr"]
    async fn live_loop_observes_a_blocked_transition() {
        // FIX-ROUND 4 LIVE PROOF, fully automated against real Herdr 0.8.0.
        //
        // Drives the actual `run_connection_loop` while a real pane is
        // pushed working -> blocked via `herdr pane report-agent`, and
        // requires the blocked status to reach `on_state`. This is the one
        // transition the global subscription never reports; before this fix
        // round the loop sat silent through it and the ❗ marker never
        // appeared.
        //
        // The CLI calls here are TEST SCAFFOLDING, not app behavior: Phase
        // 0's write budget (`agent.focus`, `workspace.focus`, `pane.focus`,
        // `notification.show`) constrains what the app sends, and the app
        // still sends none of these. Everything this test creates is torn
        // down before it returns.
        fn herdr(args: &[&str]) -> String {
            let home = dirs::home_dir().unwrap();
            let out = std::process::Command::new(home.join(".local/bin/herdr"))
                .args(args)
                .output()
                .expect("failed to run the herdr CLI");
            assert!(out.status.success(), "herdr {args:?} failed: {out:?}");
            String::from_utf8(out.stdout).unwrap()
        }

        fn status_of(world: &WorldState, pane_id: &str) -> Option<AgentStatus> {
            world
                .islands
                .iter()
                .flat_map(|i| i.agents.iter())
                .find(|a| a.pane_id == pane_id)
                .map(|a| a.status)
        }

        let home = dirs::home_dir().unwrap();
        let path =
            crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
        let repo_root = Path::new(REPO_CWD).parent().unwrap().to_path_buf();

        let states: Arc<StdMutex<Vec<WorldState>>> = Arc::new(StdMutex::new(Vec::new()));
        let states_for_cb = states.clone();
        let loop_path = path.clone();
        tokio::spawn(run_connection_loop(loop_path, SeenInbox::default(), move |world| {
            states_for_cb.lock().unwrap().push(world);
        }));

        assert!(
            eventually(|| states.lock().unwrap().iter().any(|w| w.herdr_connected)).await,
            "the loop never reached a connected world against live herdr"
        );

        let created: Value = serde_json::from_str(&herdr(&[
            "workspace",
            "create",
            "--cwd",
            repo_root.to_str().unwrap(),
            "--label",
            "aoa-fix4",
        ]))
        .unwrap();
        let workspace_id = created["result"]["workspace_id"]
            .as_str()
            .or_else(|| created["result"]["workspace"]["workspace_id"].as_str())
            .unwrap_or_else(|| panic!("no workspace_id in {created}"))
            .to_string();
        println!("created workspace {workspace_id}: {created}");

        // Everything from here on must run to the cleanup, so failures are
        // recorded rather than panicked.
        let mut failure: Option<String> = None;
        let mut pane_id = String::new();

        for _ in 0..100 {
            if let Ok(snapshot) = fetch_snapshot_fresh(&path).await {
                if let Some(p) = snapshot.panes.iter().find(|p| p.workspace_id == workspace_id) {
                    pane_id = p.pane_id.clone();
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if pane_id.is_empty() {
            failure = Some(format!("no pane ever appeared for workspace {workspace_id}"));
        }

        if failure.is_none() {
            println!("pane {pane_id}; reporting --state working");
            herdr(&[
                "pane",
                "report-agent",
                &pane_id,
                "--source",
                "aoa-fix4",
                "--agent",
                "claude",
                "--state",
                "working",
            ]);
            let saw_working = eventually(|| {
                states
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|w| status_of(w, &pane_id) == Some(AgentStatus::Working))
            })
            .await;
            if !saw_working {
                failure = Some("the loop never observed the pane going working".to_string());
            }
        }

        if failure.is_none() {
            // THE transition this whole fix round exists for. The global
            // subscription reports NOTHING here.
            let before = states.lock().unwrap().len();
            println!("reporting --state blocked (worlds so far: {before})");
            herdr(&[
                "pane",
                "report-agent",
                &pane_id,
                "--source",
                "aoa-fix4",
                "--agent",
                "claude",
                "--state",
                "blocked",
            ]);
            let saw_blocked = eventually(|| {
                states
                    .lock()
                    .unwrap()
                    .iter()
                    .skip(before)
                    .any(|w| status_of(w, &pane_id) == Some(AgentStatus::Blocked))
            })
            .await;
            if !saw_blocked {
                failure = Some(format!(
                    "the loop never observed pane {pane_id} going blocked — this is the defect"
                ));
            } else {
                let world = states
                    .lock()
                    .unwrap()
                    .iter()
                    .skip(before)
                    .rfind(|w| status_of(w, &pane_id) == Some(AgentStatus::Blocked))
                    .cloned()
                    .unwrap();
                let island = world
                    .islands
                    .iter()
                    .find(|i| i.agents.iter().any(|a| a.pane_id == pane_id))
                    .unwrap();
                println!(
                    "OBSERVED BLOCKED: island {:?} attention={:?} pane={pane_id}",
                    island.name, island.attention
                );
                assert_eq!(
                    island.attention,
                    crate::world::attention::Attention::Stopped,
                    "a blocked pane must make its island want attention"
                );
            }
        }

        println!("{}", herdr(&["workspace", "close", &workspace_id]));
        println!("{}", herdr(&["workspace", "list"]));

        if let Some(message) = failure {
            panic!("{message}");
        }
    }

    #[tokio::test]
    #[ignore = "requires a running herdr"]
    async fn live_only_a_per_pane_subscription_delivers_status_changes() {
        // FIX-ROUND 4 ISOLATION PROOF, and a correction to a too-easy
        // conclusion. `live_loop_observes_a_blocked_transition` above passes
        // end to end — but when it was re-run with the per-pane
        // subscriptions deliberately disabled as a negative control, it
        // STILL passed. The reason: that scenario's workspace has exactly
        // one pane, so the pane's status change also moves the WORKSPACE's
        // aggregate `agent_status`, and `workspace.updated` IS in
        // `WORLD_EVENTS`. The global subscription therefore happened to
        // cover that particular case by accident, via a coarser event.
        //
        // That accident is not something to rely on. It disappears as soon
        // as a workspace holds more than one pane (the aggregate stops
        // moving for most per-pane transitions) and it tells us nothing
        // about which pane changed. So this test drops to the protocol level
        // and compares two subscriptions running side by side over the same
        // transitions: one with the globals only, one with the globals plus
        // a `pane.agent_status_changed` entry for the pane under test. Only
        // the second may see the per-pane event.
        fn herdr(args: &[&str]) -> String {
            let home = dirs::home_dir().unwrap();
            let out = std::process::Command::new(home.join(".local/bin/herdr"))
                .args(args)
                .output()
                .expect("failed to run the herdr CLI");
            assert!(out.status.success(), "herdr {args:?} failed: {out:?}");
            String::from_utf8(out.stdout).unwrap()
        }

        /// Drains everything currently on the bus into `sink`, forever.
        fn drain(mut events: Receiver<Value>, sink: Arc<StdMutex<Vec<Value>>>) {
            tokio::spawn(async move {
                while let Ok(event) = events.recv().await {
                    sink.lock().unwrap().push(event);
                }
            });
        }

        let home = dirs::home_dir().unwrap();
        let path =
            crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
        let repo_root = Path::new(REPO_CWD).parent().unwrap().to_path_buf();

        let created: Value = serde_json::from_str(&herdr(&[
            "workspace",
            "create",
            "--cwd",
            repo_root.to_str().unwrap(),
            "--label",
            "aoa-fix4",
        ]))
        .unwrap();
        let workspace_id = created["result"]["workspace"]["workspace_id"].as_str().unwrap().to_string();
        let pane_id = created["result"]["root_pane"]["pane_id"].as_str().unwrap().to_string();
        println!("workspace {workspace_id}, pane {pane_id}");

        let global_only: Arc<StdMutex<Vec<Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let with_per_pane: Arc<StdMutex<Vec<Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let mut failure: Option<String> = None;

        {
            // Both subscriptions are established BEFORE any transition, on
            // their own connections, and both stay open across all of them.
            let a = HerdrClient::connect(&path).await.unwrap();
            let mut a_events = a.subscribe_events();
            let a_id = subscribe_world(&a, &[]).await.unwrap();
            await_subscription_ack(&mut a_events, &a_id).await.unwrap();

            let b = HerdrClient::connect(&path).await.unwrap();
            let mut b_events = b.subscribe_events();
            let b_id = subscribe_world(&b, std::slice::from_ref(&pane_id)).await.unwrap();
            await_subscription_ack(&mut b_events, &b_id).await.unwrap();

            drain(a_events, global_only.clone());
            drain(b_events, with_per_pane.clone());

            for state in ["working", "blocked", "idle"] {
                herdr(&[
                    "pane",
                    "report-agent",
                    &pane_id,
                    "--source",
                    "aoa-fix4",
                    "--agent",
                    "claude",
                    "--state",
                    state,
                ]);
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;

            let count = |sink: &Arc<StdMutex<Vec<Value>>>| {
                sink.lock()
                    .unwrap()
                    .iter()
                    .filter(|e| {
                        raw_event_type(e).is_some_and(|t| matches_event_type(PANE_STATUS_EVENT, t))
                    })
                    .count()
            };
            let global_count = count(&global_only);
            let per_pane_count = count(&with_per_pane);
            println!(
                "status-change deliveries — globals-only: {global_count}, with per-pane: {per_pane_count}"
            );
            for e in with_per_pane.lock().unwrap().iter() {
                if raw_event_type(e).is_some_and(|t| matches_event_type(PANE_STATUS_EVENT, t)) {
                    println!("  per-pane delivery: {e}");
                }
            }

            if per_pane_count < 3 {
                failure = Some(format!(
                    "expected one status-change delivery per transition (3), got {per_pane_count}"
                ));
            } else if global_count != 0 {
                failure = Some(format!(
                    "the globals-only subscription unexpectedly saw {global_count} status-change \
                     deliveries — WORLD_EVENTS may now cover this and the per-pane entries could \
                     be reconsidered"
                ));
            }
        }

        println!("{}", herdr(&["workspace", "close", &workspace_id]));
        println!("{}", herdr(&["workspace", "list"]));

        if let Some(message) = failure {
            panic!("{message}");
        }
    }

    #[tokio::test]
    #[ignore = "requires a running herdr"]
    async fn receives_at_least_one_real_event() {
        let home = dirs::home_dir().unwrap();
        let path = crate::herdr::socket_path::resolve(None, &crate::herdr::socket_path::RealEnv, &home);
        let client = HerdrClient::connect(&path).await.unwrap();
        let mut events = client.subscribe_events();
        let sub_id = subscribe_world(&client, &[]).await.unwrap();
        println!("Now switch panes or start an agent in herdr…");

        // Fix-round finding 4: the first delivery on the bus is the
        // `subscription_started` ack for `sub_id`, not a real event — a
        // test that asserted on it (or asserted nothing at all) could pass
        // even with a completely broken `is_world_changing` accessor. Skip
        // acks and anything else that isn't world-changing, and require
        // that we actually see one that is, so this test can catch real
        // shape drift.
        let event = loop {
            let event = tokio::time::timeout(Duration::from_secs(30), events.recv())
                .await
                .expect("no event within 30s")
                .unwrap();
            if event.get("id").and_then(Value::as_str) == Some(sub_id.as_str()) {
                println!("(skipping subscription ack: {event})");
                continue;
            }
            if !is_world_changing(&event) {
                println!("(skipping non-world-changing event: {event})");
                continue;
            }
            break event;
        };
        println!("event: {event}");
        assert!(is_world_changing(&event), "expected a world-changing event, got {event}");

        // Fix-round-3 (architecture): the crux of this whole fix round is
        // that a snapshot call must succeed on ITS OWN fresh connection
        // while the subscription connection (`client`/`events` above) is
        // still open and has just delivered a real event — proving the two
        // roles actually coexist against real Herdr, not merely against
        // the fake. Reusing `client` here (the pre-fix behavior) would
        // fail exactly as it silently did before this fix round.
        let snapshot = fetch_snapshot_fresh(&path).await.unwrap();
        println!(
            "post-event snapshot: protocol={} panes={}",
            snapshot.protocol,
            snapshot.panes.len()
        );
        assert!(!snapshot.panes.is_empty(), "expected at least one pane in the post-event snapshot");
    }

    // ---- spawn_blocking regression: the event-loop task must stay free ----

    /// A `GitProbe` whose `toplevel` blocks the CALLING OS THREAD for
    /// `delay` via `std::thread::sleep` — standing in for a real `git`
    /// subprocess wait, which is likewise a synchronous, thread-blocking
    /// operation (see `RealGit`'s own doc comment on why `run_with_timeout`
    /// exists at all).
    struct BlockingProbe {
        delay: Duration,
    }
    impl GitProbe for BlockingProbe {
        fn toplevel(&self, cwd: &Path) -> Option<PathBuf> {
            std::thread::sleep(self.delay);
            Some(cwd.to_path_buf())
        }
        fn common_dir(&self, cwd: &Path) -> Option<PathBuf> {
            Some(cwd.join(".git"))
        }
    }

    /// Regression test for the fix this task exists to make: before it,
    /// `build_world` (and therefore its `RepoResolver`, and therefore any
    /// slow `RealGit` call inside it) ran INLINE on whatever tokio task was
    /// running `run_subscription_attempt` — the same task that owns the
    /// whole Herdr event loop. A slow git call — a cold filesystem cache, a
    /// held index lock, a network mount — stalled that task, and therefore
    /// the event loop, for up to its full timeout.
    ///
    /// This proves the fix with the runtime itself, not with a mock: it
    /// runs on a `current_thread` runtime, which gives the async side of
    /// this test exactly ONE worker thread. A concurrently spawned "ticker"
    /// task can only advance if that one thread is free to run it — i.e.
    /// only if nothing else scheduled on it is synchronously blocked.
    /// `spawn_blocking`'s whole reason to exist is that it runs on a
    /// SEPARATE thread pool, independent of the async worker thread(s), on
    /// every tokio runtime flavor including `current_thread` — so if
    /// `build_world_off_thread` really moved the slow probe call off this
    /// task, the ticker keeps ticking throughout the "git" call. If a
    /// future edit inlines `build_world(&snapshot, &mut resolver, &mut
    /// stops)` back into the caller (reverting this fix), the probe's
    /// `thread::sleep` would run ON that single worker thread instead,
    /// starving the ticker's timer for the same span — this test fails the
    /// instant that regresses, without needing a real slow `git` or a
    /// multi-second wait.
    #[tokio::test(flavor = "current_thread")]
    async fn build_world_off_thread_does_not_stall_the_calling_task() {
        let ticks = Arc::new(AtomicUsize::new(0));
        let ticks_for_task = ticks.clone();
        let ticker = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(5)).await;
                ticks_for_task.fetch_add(1, Ordering::SeqCst);
            }
        });

        let snapshot = Snapshot {
            version: "0.8.0".into(),
            protocol: 19,
            panes: vec![crate::herdr::snapshot::Pane {
                pane_id: "w1:p1".into(),
                workspace_id: "w1".into(),
                cwd: Some("/tmp/build-world-off-thread-probe".into()),
                foreground_cwd: None,
                agent_status: AgentStatus::Working,
                terminal_title: None, agent: None,
            }],
            workspaces: vec![],
            focused_pane_id: None,
        };
        let resolver =
            RepoResolver::new(Box::new(BlockingProbe { delay: Duration::from_millis(300) }));
        let stops = StopMemory::default();

        build_world_off_thread(snapshot, resolver, stops, &SeenInbox::default()).await;

        ticker.abort();
        let seen = ticks.load(Ordering::SeqCst);
        assert!(
            seen >= 20,
            "the ticker task only advanced {seen} times while the 300ms-blocking probe ran; \
             expected ~60 — this means the blocking git-probing call is running on the same \
             single-threaded runtime's worker thread as everything else, exactly the event-loop \
             stall this fix exists to close"
        );
    }
}
