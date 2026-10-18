//! The direct herdr JSON-RPC write paths this app is built on: founding a
//! workspace, starting an agent in a pane (optionally resuming a prior
//! session via trailing args), and — as of Phase 0.6, on the author's
//! explicit authorization — submitting a prompt to a running agent and
//! reading back what it has said. Every call here opens its own connection,
//! because herdr serves exactly one request per connection.

use crate::herdr::client::HerdrClient;
use anyhow::{anyhow, Result};
use serde_json::json;
use std::path::Path;
use std::time::Duration;

// Task 1 of Phase 0.5a: these two functions are the write paths Task 3's
// `found_settlement` Tauri command calls to found a workspace from the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundedWorkspace {
    pub workspace_id: String,
    pub pane_id: String,
}

pub async fn create_workspace(path: &Path, cwd: &Path, label: &str) -> Result<FoundedWorkspace> {
    let client = HerdrClient::connect(path).await?;
    let result = client
        .call(
            "workspace.create",
            json!({ "cwd": cwd.to_string_lossy(), "label": label, "focus": false }),
        )
        .await?;

    let workspace_id = result["workspace"]["workspace_id"]
        .as_str()
        .ok_or_else(|| anyhow!("herdr workspace.create returned no workspace_id: {result}"))?
        .to_string();
    let pane_id = result["root_pane"]["pane_id"]
        .as_str()
        .ok_or_else(|| anyhow!("herdr workspace.create returned no root pane: {result}"))?
        .to_string();

    Ok(FoundedWorkspace { workspace_id, pane_id })
}

/// The agent names herdr already has in use, via the READ-ONLY `agent.list`.
///
/// Why this exists at all: herdr requires agent names to be GLOBALLY
/// UNIQUE, and it enforces that by refusing `agent.start` outright —
/// `{"code":"agent_name_taken","message":"agent name claude is already
/// used; candidates: ... pane_id=w2J:p1 ..."}`. Every call site in this app
/// used to pass the agent KIND as the name, so the very first `claude` this
/// app ever started claimed the name `claude` forever and every subsequent
/// start failed. `commands::resolve_agent_name` turns this list into a name
/// that is free right now; this function is the only honest way to know
/// what "free" means, because herdr has no reservation primitive and the
/// world snapshot this app subscribes to carries pane state, not agent
/// names.
///
/// Verified live against Herdr 0.8.0 on this machine (read-only, empty
/// params): `{"type":"agent_list","agents":[{"name":"claude",
/// "agent":"claude","pane_id":"w2J:p1", ...}]}` — the payload is at
/// `result.agents`, a flat array, each entry carrying its own `name`.
///
/// A missing or non-array `agents` is an ERROR, never an empty list: "I
/// could not find out what is taken" and "nothing is taken" are different
/// facts, and collapsing the first into the second is exactly how a caller
/// would go on to pick a name herdr already holds. Individual entries with
/// no string `name` are skipped rather than failing the call — an unnamed
/// agent cannot collide with a name we choose.
pub async fn list_agent_names(path: &Path) -> Result<Vec<String>> {
    let client = HerdrClient::connect(path).await?;
    let result = client.call("agent.list", json!({})).await?;

    let agents = match result["agents"].as_array() {
        Some(agents) => agents,
        None => {
            // Same discipline as `read_agent`: log the real shape for
            // whoever debugs this next, never let raw JSON escape as the
            // error text a UI might render verbatim.
            eprintln!("herdr agent.list: unexpected response shape: {result}");
            return Err(anyhow!("herdr agent.list returned an unexpected response shape"));
        }
    };

    Ok(agents.iter().filter_map(|a| a["name"].as_str().map(str::to_string)).collect())
}

/// How many times `start_agent` retries a pane that isn't an available shell
/// yet, and how long it waits between attempts.
///
/// Live probe against Herdr 0.8.0: calling `agent.start` on the `pane_id`
/// `workspace.create` just handed back, with no delay in between, reliably
/// fails with `{"code":"agent_pane_busy","message":"agent target pane ...
/// is not an available shell"}` — the freshly spawned pane's login shell has
/// not reached its interactive prompt yet. A slower caller (the `herdr` CLI
/// as a subprocess, or a Python script with socket/JSON overhead) clears
/// this window by accident; `HerdrClient`'s direct, back-to-back connect+call
/// does not. Every real caller of this pair (Task 3's "found a workspace and
/// start an agent in it" flow) calls these two functions back-to-back, so
/// this retry belongs here rather than being pushed onto every caller.
const PANE_READY_RETRIES: u32 = 20;
const PANE_READY_RETRY_DELAY: Duration = Duration::from_millis(100);

/// `name` MUST be globally unique across every agent herdr currently knows
/// about — it is not a label, it is herdr's own handle for the agent, and a
/// duplicate fails the whole call with `agent_name_taken` before anything
/// starts. It is deliberately a separate parameter from `kind` (see
/// `list_agent_names` above for what went wrong when the two were passed
/// the same string); callers get a free one from
/// `commands::resolve_agent_name`.
///
/// `args` are trailing arguments passed straight through to the agent's own
/// executable (herdr's `AgentStartParams.args`, the same field the `herdr
/// agent start <name> --kind <kind> --pane <id> -- <args>` CLI form fills) —
/// this is how resuming a prior conversation works (`["--resume"]` for
/// `claude`, `["resume"]` for `codex`), verified live against Herdr 0.8.0:
/// starting with `-- --resume` came back with `argv: ["claude", "--resume"]`
/// and a terminal title of `"claude --resume"`. An empty slice changes
/// nothing versus the pre-Phase-0.6 call shape.
pub async fn start_agent(
    path: &Path,
    pane_id: &str,
    name: &str,
    kind: &str,
    args: &[String],
) -> Result<()> {
    start_agent_with_retry(
        path,
        pane_id,
        name,
        kind,
        args,
        PANE_READY_RETRIES,
        PANE_READY_RETRY_DELAY,
    )
    .await
}

/// The actual retry loop, with attempt count and delay as parameters so a
/// test can drive it with e.g. 3 attempts x 1ms instead of the production
/// 20 x 100ms (~2s worst case, too slow to sleep through in a unit test).
/// `start_agent` is the only production caller, and always passes
/// `PANE_READY_RETRIES` / `PANE_READY_RETRY_DELAY` — this split changes
/// nothing about production behavior.
async fn start_agent_with_retry(
    path: &Path,
    pane_id: &str,
    name: &str,
    kind: &str,
    args: &[String],
    attempts: u32,
    delay: Duration,
) -> Result<()> {
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(delay).await;
        }
        // A fresh connection every attempt: herdr serves exactly one
        // request per connection, so retrying on the same connection would
        // just read EOF on the second try.
        let client = HerdrClient::connect(path).await?;
        match client
            .call(
                "agent.start",
                json!({ "pane_id": pane_id, "name": name, "kind": kind, "args": args }),
            )
            .await
        {
            Ok(_) => return Ok(()),
            // Only this specific, known-transient error is worth retrying.
            // Any other failure (bad kind, pane not found, ...) is real and
            // must surface immediately rather than being hidden behind a
            // ~2s retry loop.
            Err(e) if e.to_string().contains("agent_pane_busy") => last_err = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("herdr agent.start: pane never became ready")))
}

/// Submits a prompt to a running agent via herdr's own submission primitive,
/// `agent.prompt` — Phase 0.6's authorized addition to the write surface.
///
/// Deliberately does NOT pass `wait`: herdr's own docs (`herdr agent prompt
/// --help`) say a `--wait` first requires an observed state change within
/// 5000ms of submission or fails with `agent_prompt_stalled`, and that it
/// does not track turns (if the agent is already working, an unrelated
/// in-flight turn's completion can satisfy it). Waiting here would put a
/// multi-second stall on a Tauri command's return path for no information
/// the app doesn't already get for free from the live `WorldState` stream
/// (`herdr::events::run_connection_loop`), which reports the same
/// `agent_status` transition as soon as herdr's own event delivers it. So:
/// submit and return immediately: let the existing world-update stream
/// report the resulting state, exactly as it would for a prompt typed by
/// hand into the real terminal.
///
/// Verified live against Herdr 0.8.0: a `target` naming a pane with no agent
/// detected yet fails with `agent_not_found` (not a generic error), and a
/// successful submission returns `{"type": "agent_prompted", "agent": {...}}`
/// — this only checks the call did not error; the resulting agent snapshot is
/// not this function's job to interpret.
pub async fn send_prompt(path: &Path, target: &str, text: &str) -> Result<()> {
    let client = HerdrClient::connect(path).await?;
    client.call("agent.prompt", json!({ "target": target, "text": text })).await?;
    Ok(())
}

/// The successful result of `agent.read`. `text` is the transcript itself;
/// `truncated` says whether herdr could not fit the full requested read
/// into it, so a caller can tell the user rather than silently presenting a
/// clipped transcript as complete; `revision` is the pane's revision at the
/// time of this read — not consumed by anything yet, kept for a possible
/// future live-tail (poll `agent.read` again and compare revisions to know
/// whether there's anything new) rather than built out now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRead {
    pub text: String,
    pub truncated: bool,
    pub revision: u64,
}

/// Reads back an agent's recent terminal output via `agent.read`, the
/// read-only counterpart Phase 0.6 also authorizes.
///
/// `source: "recent"` (herdr's own CLI default) rather than `"visible"`
/// (only the current viewport, which for a pane the app itself never
/// scrolled is not necessarily where the interesting text is) or
/// `"detection"` (herdr's internal agent-detection heuristic text, not
/// meant for display). `strip_ansi: true` is herdr's own default for
/// `agent.read`, made explicit here rather than relied upon, so the
/// frontend is never hurled raw escape codes even if that default ever
/// changes upstream — this app owns no ANSI-rendering surface for the
/// villager dialogue this backs.
///
/// `lines: None` asks herdr for its own default amount of scrollback
/// (unbounded per the schema — `null` means "no limit"); `Some(n)` bounds it
/// to the caller's request.
///
/// The response nests the payload one level down, under `result.read`, NOT
/// at the top level — verified live against Herdr 0.8.0:
/// `{"type": "pane_read", "read": {"pane_id": ..., "text": ..., "revision":
/// ..., "truncated": ...}}`. An earlier version of this function read
/// `result["text"]` directly, which is always absent, so every real call
/// failed and the failure message (back then, `{result}` interpolated
/// straight into the error) ended up rendered verbatim in the UI. Fixed
/// here; the error path is also changed so a future shape mismatch can
/// never do that again — see the `Err` arm below.
pub async fn read_agent(path: &Path, target: &str, lines: Option<u32>) -> Result<AgentRead> {
    let client = HerdrClient::connect(path).await?;
    let result = client
        .call(
            "agent.read",
            json!({ "target": target, "source": "recent", "strip_ansi": true, "lines": lines }),
        )
        .await?;

    let read = &result["read"];
    let text = match read["text"].as_str() {
        Some(t) => t,
        None => {
            // Never let the raw wire response escape as the error text —
            // that is exactly how the original bug showed serialized JSON
            // inside the agent panel. Log the actual shape for whoever
            // debugs this next, and return a short, JSON-free message.
            eprintln!("herdr agent.read: unexpected response shape for {target}: {result}");
            return Err(anyhow!("herdr agent.read returned an unexpected response shape"));
        }
    };

    Ok(AgentRead {
        text: text.to_string(),
        truncated: read["truncated"].as_bool().unwrap_or(false),
        revision: read["revision"].as_u64().unwrap_or(0),
    })
}

/// The successful result of `pane.read`. Same three-field shape as
/// `AgentRead` (`text`, `truncated`, `revision`) — deliberately a distinct
/// type rather than a reuse of `AgentRead`, because the two calls are
/// authorized for different purposes (§5.6: `agent.read` is Phase 0.6's
/// "show what an agent has said" surface; `pane.read` is Phase 0.7's
/// interactive-terminal mirror) and their `commands.rs` callers should not
/// become interchangeable by an accidental shared type.
///
/// MEASURED LIVE against Herdr 0.8.0, on the author's real `w27:p1` and a
/// throwaway workspace this session created and closed: `revision` reads
/// back as `0` on every call, for every `source` (`visible`, `recent`,
/// `recent_unwrapped`, `detection`), before AND after the pane's visible
/// content demonstrably changed (new output written and read back
/// correctly). A local, non-remote Herdr session apparently never bumps
/// this counter — it is not the free "did anything change" signal its
/// presence in the schema suggests. It is still returned here, structured,
/// exactly as `agent.read`'s `revision` is (never spliced into `text`) —
/// it may become meaningful in a future Herdr build or a remote/session
/// mode this app doesn't exercise, and it costs nothing to pass through —
/// but `commands::pane_read`'s caller (the frontend mirror) MUST NOT use
/// `revision` alone to decide whether to re-render; compare the returned
/// `text` itself. See `read_pane`'s doc comment for the full measurement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneRead {
    pub text: String,
    pub truncated: bool,
    pub revision: u64,
}

/// Reads the CURRENT SCREEN of a pane via `pane.read` — Phase 0.7's
/// interactive-terminal mirror (§5.6): "the same pane, the same session,
/// the same output, visible identically in the user's own terminal
/// emulator at the same time."
///
/// `source: "visible"` (the current viewport), NOT `"recent"` (scrollback,
/// what `read_agent` above uses for showing what an agent recently said).
/// A mirror shows what the real terminal emulator is showing right now —
/// scrollback is a different, larger thing the user can already reach by
/// scrolling their own terminal, and principle 3 (the terminal is never
/// hidden) is satisfied by matching the visible screen exactly, not by
/// this app growing its own scrollback view.
///
/// `format: "ansi"` with `strip_ansi: false`, the opposite of
/// `read_agent`'s choice — this app DOES own an ANSI-rendering surface
/// here (an embedded terminal), specifically so colour, bold, and the
/// rest of an agent's real terminal output render identically to the
/// user's own emulator. `read_agent`'s `strip_ansi: true` is about
/// villager dialogue text with no rendering surface for escape codes;
/// this is the opposite case by design.
///
/// The response nests one level down under `result.read`, exactly like
/// `agent.read` (see that function's doc comment) — verified live against
/// Herdr 0.8.0 for `pane.read` specifically, not assumed from `agent.read`'s
/// shape: `{"type": "pane_read", "read": {"pane_id": ..., "text": ...,
/// "revision": 0, "truncated": false, ...}}`. Same defensive parse as
/// `read_agent`: a missing `read.text` never leaks the raw response as the
/// error text.
pub async fn read_pane(path: &Path, pane_id: &str) -> Result<PaneRead> {
    let client = HerdrClient::connect(path).await?;
    let result = client
        .call(
            "pane.read",
            json!({ "pane_id": pane_id, "source": "visible", "format": "ansi", "strip_ansi": false }),
        )
        .await?;

    let read = &result["read"];
    let text = match read["text"].as_str() {
        Some(t) => t,
        None => {
            eprintln!("herdr pane.read: unexpected response shape for {pane_id}: {result}");
            return Err(anyhow!("herdr pane.read returned an unexpected response shape"));
        }
    };

    Ok(PaneRead {
        text: text.to_string(),
        truncated: read["truncated"].as_bool().unwrap_or(false),
        revision: read["revision"].as_u64().unwrap_or(0),
    })
}

/// Reads a pane's SCROLLBACK via `pane.read` with `source: "recent"` — the
/// terminal-feel round's answer to "the terminal cannot be scrolled".
///
/// This is the same read-only call as `read_pane` above with one parameter
/// changed, and it is a separate function rather than a parameter on that
/// one because the two answer genuinely different questions and the poll
/// loop must never accidentally ask this one: `read_pane` is the live
/// mirror, called sixty times a second while someone types, and
/// `read_pane_recent` is a user-initiated, one-shot "what scrolled off the
/// top". `lines` bounds the answer (herdr's own `null` means unbounded).
///
/// MEASURED LIVE (terminal-feel round, against a throwaway workspace this
/// session created and closed, plus read-only reads of the author's real
/// panes) — this is the whole basis for the scrollback feature and for
/// knowing when there is none:
///
/// - A normal shell pane that has scrolled returns REAL scrollback here:
///   141 lines from `recent` against 23 from `visible`, after `seq 1 120`.
/// - A pane running a full-screen program (`less`, and every one of the
///   author's live `claude` panes) returns EXACTLY the visible screen —
///   23 lines from both sources. That is not a herdr limitation: the
///   alternate screen has no scrollback by definition.
/// - `PaneInfo.scroll.max_offset_from_bottom` is NOT the signal it looks
///   like. It read `0` on every pane probed, including the shell pane with
///   141 lines of genuine scrollback, so "is there anything above the
///   top of the screen" cannot be answered with `pane.get`. Comparing the
///   two sources' line counts can, and costs one extra read.
pub async fn read_pane_recent(path: &Path, pane_id: &str, lines: u32) -> Result<PaneRead> {
    let client = HerdrClient::connect(path).await?;
    let result = client
        .call(
            "pane.read",
            json!({
                "pane_id": pane_id,
                "source": "recent",
                "format": "ansi",
                "strip_ansi": false,
                "lines": lines
            }),
        )
        .await?;

    let read = &result["read"];
    let text = match read["text"].as_str() {
        Some(t) => t,
        None => {
            eprintln!("herdr pane.read (recent): unexpected response shape for {pane_id}: {result}");
            return Err(anyhow!("herdr pane.read returned an unexpected response shape"));
        }
    };

    Ok(PaneRead {
        text: text.to_string(),
        truncated: read["truncated"].as_bool().unwrap_or(false),
        revision: read["revision"].as_u64().unwrap_or(0),
    })
}

/// Sends literal text to a pane via `pane.send_text` — one of the two
/// writes Phase 0.7 authorizes for this purpose only (§5.6). Raw keystroke
/// injection, not a submission primitive: unlike `send_prompt`'s
/// `agent.prompt`, this has no submission semantics of its own — it is
/// exactly what a real terminal emulator does when the user types, which is
/// the entire point of a true mirror. It does not append Enter or any other
/// key; a caller that wants that sends it explicitly via `send_keys`.
///
/// Verified live against Herdr 0.8.0 on a throwaway workspace this session
/// created and closed (never against the author's real panes): a successful
/// call returns `{"type": "ok"}` with no payload worth interpreting.
///
/// IT TRANSMITS ESCAPE BYTES VERBATIM — measured, not assumed (terminal-
/// feel round). `pane.send_text` with a payload beginning `\x1b` was sent
/// to a throwaway pane running `cat -v`, which echoed `^[[5~`: the real
/// ESC byte reached the pty, not an escaped or literalised spelling of it.
/// Confirmed again end to end against `less` (a `\x1b[6~` payload paged
/// the view forward and `\x1b[5~` paged it back) and against zsh's line
/// editor (`\x1bOH` / `\x1bOF` / `\x1b[3~` moved the cursor home, to the
/// end, and deleted forward). That is what makes `terminalKeys.ts`'s
/// escape-sequence table possible at all: the six keys herdr's
/// `send_keys` rejects outright — PageUp, PageDown, Home, End, Delete,
/// Insert — have nowhere else to go.
pub async fn send_text(path: &Path, pane_id: &str, text: &str) -> Result<()> {
    let client = HerdrClient::connect(path).await?;
    client.call("pane.send_text", json!({ "pane_id": pane_id, "text": text })).await?;
    Ok(())
}

/// Sends key presses to a pane via `pane.send_keys` — the other write
/// Phase 0.7 authorizes (§5.6). `keys` are herdr's own logical key names
/// (`"esc"`, `"ctrl+c"`, `"up"`, ...) validated by Herdr itself before any
/// bytes are written to the pty — an unrecognized name fails the whole call
/// with `invalid_key` rather than sending anything.
///
/// See `commands::describe_herdr_failure` for how an `invalid_key` or
/// `pane_not_found` failure here is turned into a plain-language error
/// rather than surfacing herdr's raw error code.
pub async fn send_keys(path: &Path, pane_id: &str, keys: &[String]) -> Result<()> {
    let client = HerdrClient::connect(path).await?;
    client.call("pane.send_keys", json!({ "pane_id": pane_id, "keys": keys })).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::testing::FakeHerdr;
    use serde_json::json;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn create_workspace_sends_cwd_and_label_and_reads_ids() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.method, "workspace.create");
            assert_eq!(req.params["cwd"], "/repos/api");
            assert_eq!(req.params["label"], "api");
            Ok(json!({
                "type": "workspace_created",
                "workspace": { "workspace_id": "w7" },
                "root_pane": { "pane_id": "w7:p1" }
            }))
        })
        .await;

        let founded = create_workspace(fake.path(), Path::new("/repos/api"), "api")
            .await
            .unwrap();

        assert_eq!(founded.workspace_id, "w7");
        assert_eq!(founded.pane_id, "w7:p1");
    }

    #[tokio::test]
    async fn create_workspace_surfaces_a_herdr_error() {
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Err(("invalid_request".to_string(), "bad cwd".to_string()))
        })
        .await;

        let err = create_workspace(fake.path(), Path::new("/nope"), "nope")
            .await
            .unwrap_err()
            .to_string();

        assert!(err.contains("bad cwd"), "error must name the cause, got: {err}");
    }

    #[tokio::test]
    async fn start_agent_sends_name_kind_and_pane() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.method, "agent.start");
            assert_eq!(req.params["pane_id"], "w7:p1");
            // Name and kind are DIFFERENT strings here on purpose: passing
            // the kind as the name is the `agent_name_taken` bug, and this
            // fixture would go on passing if the two were ever collapsed
            // back into one parameter.
            assert_eq!(req.params["name"], "api");
            assert_eq!(req.params["kind"], "claude");
            assert_eq!(req.params["args"], json!([]));
            Ok(json!({ "type": "ok" }))
        })
        .await;

        start_agent(fake.path(), "w7:p1", "api", "claude", &[]).await.unwrap();
    }

    // ---- agent.list, the read-only lookup behind unique agent names ----
    //
    // Fixture shape taken from a live, read-only `agent.list` against the
    // author's running Herdr 0.8.0 (see `list_agent_names`'s doc comment),
    // not invented: `result.agents[]`, each entry with its own `name`.

    #[tokio::test]
    async fn list_agent_names_reads_every_name_herdr_reports() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.method, "agent.list");
            Ok(json!({
                "type": "agent_list",
                "agents": [
                    { "name": "claude", "agent": "claude", "pane_id": "w2J:p1" },
                    { "name": "webAdmin", "agent": "codex", "pane_id": "w2K:p1" }
                ]
            }))
        })
        .await;

        let names = list_agent_names(fake.path()).await.unwrap();
        assert_eq!(names, vec!["claude".to_string(), "webAdmin".to_string()]);
    }

    #[tokio::test]
    async fn list_agent_names_reads_an_empty_session_as_nothing_taken() {
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Ok(json!({ "type": "agent_list", "agents": [] }))
        })
        .await;

        assert!(list_agent_names(fake.path()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn list_agent_names_fails_rather_than_reporting_nothing_taken() {
        // THE LOAD-BEARING CASE. "I could not find out what is taken" must
        // never become "nothing is taken" — that is precisely how a caller
        // would go on to pick a name herdr already holds and hit
        // `agent_name_taken` all over again.
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Ok(json!({ "type": "agent_list" }))
        })
        .await;

        let err = list_agent_names(fake.path()).await.unwrap_err().to_string();
        assert!(err.contains("unexpected response shape"), "got: {err}");
        assert!(!err.contains('{'), "error must not embed raw JSON, got: {err}");
    }

    #[tokio::test]
    async fn list_agent_names_skips_an_entry_with_no_name() {
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Ok(json!({ "type": "agent_list", "agents": [{ "pane_id": "w1:p1" }, { "name": "api" }] }))
        })
        .await;

        assert_eq!(list_agent_names(fake.path()).await.unwrap(), vec!["api".to_string()]);
    }

    #[tokio::test]
    async fn list_agent_names_surfaces_a_herdr_error() {
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Err(("internal".to_string(), "herdr is unhappy".to_string()))
        })
        .await;

        let err = list_agent_names(fake.path()).await.unwrap_err().to_string();
        assert!(err.contains("herdr is unhappy"), "got: {err}");
    }

    #[tokio::test]
    #[ignore = "requires a running herdr"]
    async fn lists_the_real_agent_names() {
        // Read-only and non-destructive, same as `reads_a_real_agent_pane`.
        let home = dirs::home_dir().unwrap();
        let socket = crate::herdr::socket_path::resolve(
            None, &crate::herdr::socket_path::RealEnv, &home);

        let names = list_agent_names(&socket).await.unwrap();
        println!("herdr currently has these agent names: {names:?}");
    }

    #[tokio::test]
    async fn start_agent_sends_resume_args_when_given() {
        // Verified live against Herdr 0.8.0 (see `start_agent`'s doc
        // comment): `-- --resume` on the CLI came back with
        // `argv: ["claude", "--resume"]`, confirming trailing args land in
        // `AgentStartParams.args` and are appended after the executable.
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.params["args"], json!(["--resume"]));
            Ok(json!({ "type": "ok" }))
        })
        .await;

        start_agent(fake.path(), "w7:p1", "claude", "claude", &["--resume".to_string()])
            .await
            .unwrap();
    }

    // ---- start_agent's retry-on-agent_pane_busy loop ----
    //
    // FIX ROUND 1: none of the tests above ever produce `agent_pane_busy`
    // (`FakeHerdr` always answers Ok on the first request there), so the
    // retry loop, its 20-attempt exhaustion branch, and the "other errors
    // don't retry" branch had never actually executed anywhere — not in CI,
    // and not live either (the real race was measured resolving in 1-2
    // iterations). These three tests drive `start_agent_with_retry` directly
    // with a tiny attempt count / delay so the give-up path is fast to run
    // and actually exercised.

    #[tokio::test]
    async fn start_agent_retries_past_a_transient_pane_busy_then_succeeds() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_handler = calls.clone();
        let fake = FakeHerdr::start_one_request_per_connection(move |_req| {
            let n = calls_for_handler.fetch_add(1, Ordering::SeqCst);
            if n < 2 {
                Err(("agent_pane_busy".to_string(), "not an available shell".to_string()))
            } else {
                Ok(json!({ "type": "ok" }))
            }
        })
        .await;

        start_agent_with_retry(
            fake.path(),
            "w7:p1",
            "claude",
            "claude",
            &[],
            5,
            Duration::from_millis(1),
        )
        .await
        .unwrap();

        // 2 failures + 1 success: prove the retry actually ran, not that it
        // merely happened to succeed on the first try.
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn start_agent_gives_up_after_exhausting_retries() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_handler = calls.clone();
        let fake = FakeHerdr::start_one_request_per_connection(move |_req| {
            calls_for_handler.fetch_add(1, Ordering::SeqCst);
            Err(("agent_pane_busy".to_string(), "not an available shell".to_string()))
        })
        .await;

        let err = start_agent_with_retry(
            fake.path(),
            "w7:p1",
            "claude",
            "claude",
            &[],
            3,
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert!(
            err.to_string().contains("agent_pane_busy"),
            "error must name the real cause, got: {err}"
        );
    }

    #[tokio::test]
    async fn start_agent_does_not_retry_a_different_error() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_handler = calls.clone();
        let fake = FakeHerdr::start_one_request_per_connection(move |_req| {
            calls_for_handler.fetch_add(1, Ordering::SeqCst);
            Err(("pane_not_found".to_string(), "no such pane".to_string()))
        })
        .await;

        let err = start_agent_with_retry(
            fake.path(),
            "w7:p1",
            "claude",
            "claude",
            &[],
            5,
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        // A future edit that accidentally broadened the retry to swallow
        // real failures would call the handler more than once here.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(err.to_string().contains("pane_not_found"), "got: {err}");
    }

    #[tokio::test]
    #[ignore = "requires a running herdr"]
    async fn founds_a_real_workspace_and_starts_claude() {
        let home = dirs::home_dir().unwrap();
        let socket = crate::herdr::socket_path::resolve(
            None, &crate::herdr::socket_path::RealEnv, &home);
        let repo = home.join("Projects/AgeOfAgents");

        let founded = create_workspace(&socket, &repo, "aoa-launch-test").await.unwrap();
        println!("founded {founded:?}");

        // Run the rest so cleanup still happens even if an assertion or a
        // call fails partway through — otherwise a failure here would leak
        // a workspace into the user's real herdr session.
        let result: Result<()> = async {
            // A name nothing else can already hold: `"claude"` (the KIND)
            // is exactly the mistake `list_agent_names` exists to prevent,
            // and on any machine that has ever run this app it is already
            // taken, so this test would fail with `agent_name_taken`
            // through no fault of the code under test.
            start_agent(&socket, &founded.pane_id, "aoa-launch-test", "claude", &[]).await?;
            Ok(())
        }
        .await;

        let client = HerdrClient::connect(&socket).await.unwrap();
        client
            .call("workspace.close", serde_json::json!({ "workspace_id": founded.workspace_id }))
            .await
            .unwrap();

        result.unwrap();
    }

    #[tokio::test]
    async fn send_prompt_sends_target_and_text() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.method, "agent.prompt");
            assert_eq!(req.params["target"], "w7:p1");
            assert_eq!(req.params["text"], "hello there");
            // No `wait` field: `send_prompt` deliberately never asks herdr
            // to block on a resulting state (see its doc comment).
            assert!(req.params.get("wait").is_none() || req.params["wait"].is_null());
            Ok(json!({ "type": "agent_prompted", "agent": { "agent_status": "working" } }))
        })
        .await;

        send_prompt(fake.path(), "w7:p1", "hello there").await.unwrap();
    }

    #[tokio::test]
    async fn send_prompt_surfaces_agent_not_found() {
        // Verified live against Herdr 0.8.0: a target with no agent detected
        // yet fails this way, not with a generic error.
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Err(("agent_not_found".to_string(), "agent target w7:p1 not found".to_string()))
        })
        .await;

        let err = send_prompt(fake.path(), "w7:p1", "hi").await.unwrap_err().to_string();
        assert!(err.contains("agent_not_found") || err.contains("not found"), "got: {err}");
    }

    // The fixtures below use the REAL `agent.read` response shape, verified
    // live against a running Herdr 0.8.0 instance (see
    // `read_agent`'s doc comment): the payload nests under `result.read`,
    // not at the top level. The original bug shipped because the fixture
    // used to mirror the wrong (top-level `text`) assumption, so it "passed"
    // against the same mistake the production code made — deliberately not
    // repeating that here.
    #[tokio::test]
    async fn read_agent_sends_recent_source_and_reads_text() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.method, "agent.read");
            assert_eq!(req.params["target"], "w7:p1");
            assert_eq!(req.params["source"], "recent");
            assert_eq!(req.params["strip_ansi"], true);
            assert!(req.params["lines"].is_null());
            Ok(json!({
                "type": "pane_read",
                "read": {
                    "pane_id": "w7:p1",
                    "workspace_id": "w7",
                    "tab_id": "w7:p1",
                    "source": "recent",
                    "format": "text",
                    "text": "hello from the pane\n",
                    "revision": 3,
                    "truncated": false
                }
            }))
        })
        .await;

        let read = read_agent(fake.path(), "w7:p1", None).await.unwrap();
        assert_eq!(read.text, "hello from the pane\n");
        assert!(!read.truncated);
        assert_eq!(read.revision, 3);
    }

    #[tokio::test]
    async fn read_agent_sends_a_requested_line_limit() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.params["lines"], 50);
            Ok(json!({
                "type": "pane_read",
                "read": { "text": "", "revision": 0, "truncated": false }
            }))
        })
        .await;

        read_agent(fake.path(), "w7:p1", Some(50)).await.unwrap();
    }

    #[tokio::test]
    async fn read_agent_surfaces_truncation_instead_of_hiding_it() {
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Ok(json!({
                "type": "pane_read",
                "read": { "text": "only part of it", "revision": 7, "truncated": true }
            }))
        })
        .await;

        let read = read_agent(fake.path(), "w7:p1", None).await.unwrap();
        assert!(read.truncated);
        assert_eq!(read.revision, 7);
    }

    #[tokio::test]
    async fn read_agent_surfaces_a_herdr_error() {
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Err(("agent_not_found".to_string(), "agent target w7:p1 not found".to_string()))
        })
        .await;

        let err = read_agent(fake.path(), "w7:p1", None).await.unwrap_err().to_string();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[tokio::test]
    async fn read_agent_never_embeds_the_raw_response_in_its_error() {
        // Defect 2 from the bug report: a malformed/unexpected response
        // must never leak as serialized JSON in the error a caller might
        // display verbatim. Missing `read.text` entirely is the case that
        // actually happened in production (see this function's doc
        // comment).
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Ok(json!({ "type": "pane_read", "read": { "source": "recent" } }))
        })
        .await;

        let err = read_agent(fake.path(), "w27:p1", None).await.unwrap_err().to_string();
        assert!(!err.contains('{'), "error must not embed raw JSON, got: {err}");
        assert!(!err.contains("pane_id"), "error must not embed raw JSON, got: {err}");
    }

    #[tokio::test]
    #[ignore = "requires a running herdr"]
    async fn reads_a_real_agent_pane() {
        // Read-only and non-destructive: `agent.read` never mutates
        // anything, so this is safe to run against the author's live
        // session without touching w2/w16/w27.
        let home = dirs::home_dir().unwrap();
        let socket = crate::herdr::socket_path::resolve(
            None, &crate::herdr::socket_path::RealEnv, &home);

        let read = read_agent(&socket, "w27:p1", None).await.unwrap();
        println!(
            "w27:p1 read {} chars, truncated={}, revision={}",
            read.text.len(),
            read.truncated,
            read.revision
        );
        println!("--- text ---\n{}\n--- end text ---", read.text);
        assert!(!read.text.is_empty(), "w27:p1 is a real pane with real agent output");
    }

    // ---- pane.read / pane.send_text / pane.send_keys (Phase 0.7) ----
    //
    // Fixtures use the REAL `pane.read` response shape, verified live
    // against Herdr 0.8.0 by connecting to the author's actual socket
    // (`~/.config/herdr/herdr.sock`) and calling `pane.read` directly —
    // same nesting under `result.read` as `agent.read`, confirmed
    // independently rather than assumed from that sibling call.

    #[tokio::test]
    async fn read_pane_sends_visible_ansi_unstripped_and_reads_text() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.method, "pane.read");
            assert_eq!(req.params["pane_id"], "w7:p1");
            assert_eq!(req.params["source"], "visible");
            assert_eq!(req.params["format"], "ansi");
            assert_eq!(req.params["strip_ansi"], false);
            Ok(json!({
                "type": "pane_read",
                "read": {
                    "pane_id": "w7:p1",
                    "workspace_id": "w7",
                    "tab_id": "w7:p1",
                    "source": "visible",
                    "format": "ansi",
                    "text": "\u{1b}[32mhello\u{1b}[0m\n",
                    "revision": 0,
                    "truncated": false
                }
            }))
        })
        .await;

        let read = read_pane(fake.path(), "w7:p1").await.unwrap();
        assert_eq!(read.text, "\u{1b}[32mhello\u{1b}[0m\n");
        assert!(!read.truncated);
        assert_eq!(read.revision, 0);
    }

    #[tokio::test]
    async fn read_pane_recent_asks_for_scrollback_with_a_line_bound() {
        // The one call that differs from the live mirror, and the only
        // place `source: "recent"` is allowed to come from for a pane.
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.method, "pane.read");
            assert_eq!(req.params["pane_id"], "w7:p1");
            assert_eq!(req.params["source"], "recent");
            assert_eq!(req.params["format"], "ansi");
            assert_eq!(req.params["strip_ansi"], false);
            assert_eq!(req.params["lines"], 500);
            Ok(json!({
                "type": "pane_read",
                "read": {
                    "pane_id": "w7:p1",
                    "source": "recent",
                    "format": "ansi",
                    "text": "line 1\nline 2\nline 3\n",
                    "revision": 0,
                    "truncated": false
                }
            }))
        })
        .await;

        let read = read_pane_recent(fake.path(), "w7:p1", 500).await.unwrap();
        assert_eq!(read.text, "line 1\nline 2\nline 3\n");
    }

    #[tokio::test]
    async fn read_pane_recent_never_embeds_the_raw_response_in_its_error() {
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Ok(json!({ "type": "pane_read", "read": { "source": "recent" } }))
        })
        .await;

        let err = read_pane_recent(fake.path(), "w27:p1", 500).await.unwrap_err().to_string();
        assert!(!err.contains('{'), "error must not embed raw JSON, got: {err}");
        assert!(!err.contains("pane_id"), "error must not embed raw JSON, got: {err}");
    }

    #[tokio::test]
    async fn read_pane_surfaces_truncation() {
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Ok(json!({
                "type": "pane_read",
                "read": { "text": "only part", "revision": 0, "truncated": true }
            }))
        })
        .await;

        let read = read_pane(fake.path(), "w7:p1").await.unwrap();
        assert!(read.truncated);
    }

    #[tokio::test]
    async fn read_pane_surfaces_a_herdr_error() {
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Err(("pane_not_found".to_string(), "pane w7:p1 not found".to_string()))
        })
        .await;

        let err = read_pane(fake.path(), "w7:p1").await.unwrap_err().to_string();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[tokio::test]
    async fn read_pane_never_embeds_the_raw_response_in_its_error() {
        // Same defensive shape check as `read_agent_never_embeds_...`: a
        // missing `read.text` must never leak the raw JSON as the error.
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Ok(json!({ "type": "pane_read", "read": { "source": "visible" } }))
        })
        .await;

        let err = read_pane(fake.path(), "w27:p1").await.unwrap_err().to_string();
        assert!(!err.contains('{'), "error must not embed raw JSON, got: {err}");
        assert!(!err.contains("pane_id"), "error must not embed raw JSON, got: {err}");
    }

    #[tokio::test]
    async fn send_text_sends_pane_id_and_text() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.method, "pane.send_text");
            assert_eq!(req.params["pane_id"], "w7:p1");
            assert_eq!(req.params["text"], "echo hi");
            Ok(json!({ "type": "ok" }))
        })
        .await;

        send_text(fake.path(), "w7:p1", "echo hi").await.unwrap();
    }

    #[tokio::test]
    async fn send_text_surfaces_a_herdr_error() {
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Err(("pane_not_found".to_string(), "pane w7:p1 not found".to_string()))
        })
        .await;

        let err = send_text(fake.path(), "w7:p1", "hi").await.unwrap_err().to_string();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[tokio::test]
    async fn send_keys_sends_pane_id_and_the_key_list_in_order() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.method, "pane.send_keys");
            assert_eq!(req.params["pane_id"], "w7:p1");
            assert_eq!(req.params["keys"], json!(["ctrl+c", "enter"]));
            Ok(json!({ "type": "ok" }))
        })
        .await;

        send_keys(fake.path(), "w7:p1", &["ctrl+c".to_string(), "enter".to_string()])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn send_keys_surfaces_an_invalid_key_error() {
        // Verified live against Herdr 0.8.0: an unrecognized key name fails
        // the whole call with `invalid_key` before any bytes are written,
        // e.g. `herdr pane send-keys <pane> delete` ->
        // `{"code":"invalid_key","message":"unsupported key delete"}`.
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Err(("invalid_key".to_string(), "unsupported key delete".to_string()))
        })
        .await;

        let err = send_keys(fake.path(), "w7:p1", &["delete".to_string()]).await.unwrap_err().to_string();
        assert!(err.contains("invalid_key") || err.contains("unsupported key"), "got: {err}");
    }

    #[tokio::test]
    #[ignore = "requires a running herdr"]
    async fn reads_the_real_visible_screen_of_an_agent_pane() {
        // Read-only and non-destructive, same as `reads_a_real_agent_pane`:
        // safe against the author's live session without touching
        // w2/w16/w27.
        let home = dirs::home_dir().unwrap();
        let socket = crate::herdr::socket_path::resolve(
            None, &crate::herdr::socket_path::RealEnv, &home);

        let read = read_pane(&socket, "w27:p1").await.unwrap();
        println!(
            "w27:p1 visible screen: {} chars, truncated={}, revision={}",
            read.text.len(),
            read.truncated,
            read.revision
        );
        assert!(!read.text.is_empty(), "w27:p1 is a real pane with a real visible screen");
    }

    #[tokio::test]
    #[ignore = "requires a running herdr"]
    async fn sends_text_and_keys_to_a_real_throwaway_pane_then_closes_it() {
        // Proves the send path end to end against real Herdr 0.8.0 WITHOUT
        // ever touching the author's real workspaces: mints its own
        // throwaway workspace (a plain shell, `create_workspace`, same as
        // `founds_a_real_workspace_and_starts_claude` above), sends into
        // THAT pane only, reads back to confirm the bytes actually landed,
        // then closes the workspace it created — w2/w16/w27 are never named
        // here.
        let home = dirs::home_dir().unwrap();
        let socket = crate::herdr::socket_path::resolve(
            None, &crate::herdr::socket_path::RealEnv, &home);
        let tmp = std::env::temp_dir();

        let founded = create_workspace(&socket, &tmp, "aoa-send-test").await.unwrap();

        let result: Result<()> = async {
            send_text(&socket, &founded.pane_id, "echo aoa_send_probe").await?;
            send_keys(&socket, &founded.pane_id, &["enter".to_string()]).await?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let read = read_pane(&socket, &founded.pane_id).await?;
            assert!(
                read.text.contains("aoa_send_probe"),
                "expected the echoed text back from the throwaway pane, got: {}",
                read.text
            );
            Ok(())
        }
        .await;

        let client = HerdrClient::connect(&socket).await.unwrap();
        client
            .call("workspace.close", serde_json::json!({ "workspace_id": founded.workspace_id }))
            .await
            .unwrap();

        result.unwrap();
    }
}
