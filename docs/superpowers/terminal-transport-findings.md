# Herdr terminal transport findings

Investigated 2026-09-22 for town-workspace Task 3. Installed executable: `~/.local/bin/herdr`, reporting **0.8.0**, bundled API protocol **19**, schema version **1**.

**A supported live terminal connection exists.** Use `herdr terminal session control` or `observe` through ordinary subprocess pipes. They are separate from the JSON socket API used by the current `pane.read` implementation. The stream carries server-generated ANSI screen updates, not original child PTY output. This is suitable for a persistent terminal renderer, provided frames remain ordered and server-owned scrollback is not replaced with invented local history.

Only executable metadata/help, bundled schema, local application code, and official upstream sources were inspected. No live pane reads, launches, attachments, inputs, resizes, scrolling, focus changes, or ownership changes were performed. Runtime behavior remains source-verified rather than exercised against the user's agents.

## Installed metadata evidence

These commands were run successfully and do not attach to a session:

```sh
command -v herdr
herdr --version
herdr --help
herdr --skill
herdr api --help
herdr api schema --help
herdr api schema --json
herdr pane --help
herdr pane read --help
herdr pane resize --help
herdr pane send-text --help
herdr pane send-keys --help
herdr session attach --help
herdr agent --help
herdr agent attach --help
herdr terminal --help
herdr terminal attach --help
herdr terminal session --help
herdr terminal session control --help
herdr terminal session observe --help
```

`herdr api schema` without `--json` had previously produced no output. Its nested help documents `--json`, which prints the full bundled schema. Likewise, the custom top-level help omits `terminal`, but its nested help lists the implemented transport commands. Absence from that top-level summary or the JSON API schema is not evidence that terminal attachment is unavailable.

Installed help confirms these argument shapes:

```text
herdr terminal session control <TARGET> [--takeover] [--cols N] [--rows N]
herdr terminal session observe <TARGET> [--cols N] [--rows N]
herdr terminal attach <TERMINAL_ID> [--takeover]
herdr agent attach <TARGET> [--takeover]
```

The [official CLI reference](https://herdr.dev/docs/cli-reference/#direct-terminal-attach) documents control/observe as the integration surface, NDJSON output, control commands, and multiple observers. This is not an inferred private wire API. No general cross-version compatibility promise was found; capability detection and surfaced startup errors remain appropriate. Details below are checked against the **v0.8.0 tag**, rather than assuming the current website's newer examples describe the installed binary exactly.

## What the JSON socket API exposes

Evidence: `herdr api schema --json`, JSON pointers under `/schemas`.

| Capability | Exact installed schema finding |
| --- | --- |
| Screen reads | `request/$defs/PaneReadParams`: `pane_id`, `source`, optional `lines`, `format`, `strip_ansi`. Sources: `visible`, `recent`, `recent_unwrapped`, `detection`; formats: `text`, `ansi`. |
| Read result | `success_response/$defs/PaneReadResult`: `text`, `revision`, `truncated`, source/format and pane/workspace/tab IDs. No byte cursor, continuation token, mode state, or stream. |
| Output event | `event/$defs/EventData`: `pane_output_changed` contains only pane ID, workspace ID, revision. It contains no terminal bytes. |
| Output subscriptions | `request/$defs/Subscription`: `pane.output_matched` returns a matching snapshot. `pane.output_changed` is not an accepted subscription variant; `events.wait` has an output-change match. Neither supplies a raw byte stream. |
| Split resize | `request/$defs/PaneResizeParams`: direction and optional amount/pane ID. It changes Herdr's native split, not a requested row/column terminal viewport. |
| Input | `pane.send_text`, `pane.send_keys`, `pane.send_input`; no typed mouse-button method. |
| Scroll metadata | `PaneInfo.scroll` / `PaneScrollInfo`: `offset_from_bottom`, `max_offset_from_bottom`, `viewport_rows`; subscription `pane.scroll_changed`. There is no JSON API `pane.scroll` mutation. |

The existing `src-tauri/src/herdr/launch.rs` read functions and `src/components/Terminal.tsx` correctly treat `pane.read` as replacement snapshots. Keep that behavior whenever the snapshot fallback is in use. Never pass those complete text snapshots to an emulator as appended output.

## Headless transport contract

The [v0.8.0 CLI implementation](https://github.com/herdrdev/herdr/blob/v0.8.0/src/cli.rs#L483) dispatches control/observe into the client transport. A target can resolve to a pane, terminal, or agent. Dimensions default to 120 columns and 40 rows; accepted values are nonzero `u16`. Pass explicit dimensions. A native `terminal attach` process configures its own host terminal; the session commands avoid that setup and are the smaller embedding interface.

The [v0.8.0 client implementation](https://github.com/herdrdev/herdr/blob/v0.8.0/src/client/mod.rs#L793) uses the client socket and normal buffered stdin/stdout. No PTY is required. Stdout contains NDJSON:

```json
{"type":"terminal.frame","seq":1,"encoding":"ansi","width":120,"height":40,"full":true,"bytes":"BASE64"}
{"type":"terminal.closed","reason":"detached"}
```

Control stdin accepts one JSON object per line:

| `type` | Fields |
| --- | --- |
| `terminal.input` | `text` UTF-8 string **or** `bytes` standard base64, never both |
| `terminal.resize` | `cols`, `rows`; optional `cell_width_px`, `cell_height_px` defaulting to zero |
| `terminal.scroll` | `direction`: `up`/`down`; positive `lines`; optional `source`: `wheel` (default)/`page_key`; optional `column`, `row`, `modifiers` |
| `terminal.release` | No additional fields |

Malformed commands are reported on stderr and ignored. Stdin EOF sends detach. Stdout EOF can occur without `terminal.closed`; treat it as disconnection. Other server messages, including graphics and input-mode metadata, are not emitted by this CLI output loop. There is no per-input acknowledgment record. A successful pipe write therefore means queued to the CLI, not acknowledged by the pane.

## Frames and replay

The [wire definition](https://github.com/herdrdev/herdr/blob/v0.8.0/src/protocol/wire.rs#L568) identifies `seq` as a per-client sequence and `full` as a complete redraw. The bytes are already encoded for terminal rendering. The [server render stream](https://github.com/herdrdev/herdr/blob/v0.8.0/src/server/render_stream.rs#L59) maintains a separate encoder baseline per connection, skips unchanged frames, and advances sequence after committing a sent frame. It renders the terminal's current viewport rather than exporting historical PTY traffic.

The [ANSI encoder](https://github.com/herdrdev/herdr/blob/v0.8.0/src/protocol/render_ansi.rs) paints all cells initially and subsequently paints changed cells with cursor-position/style sequences. `full` also occurs on size changes or repaint. Only the initial baseline necessarily emits a clear-screen sequence; a later full frame is still valid terminal byte output. It is not an instruction to append rows to history or a reason to reset the emulator on every frame.

Integration recommendation: create a fresh emulator for a new connection; require an initial full frame, apply its reported dimensions, decode bytes, then process every subsequent frame in order. For size changes, resize locally before applying that frame. Do not clear before every ordinary diff. On a missing/reordered frame, stop input and reconnect for a new baseline rather than guessing the missing state. There is no resume-offset/replay command in the CLI contract. Do not replay input after reconnect.

## Ownership, resizing, scrollback and mouse limits

The [v0.8.0 server](https://github.com/herdrdev/herdr/blob/v0.8.0/src/server/headless.rs) establishes the following behavior:

- Control resolves the target once, claims direct-attach ownership, takes a resize lock, and resizes the real terminal. Existing ownership causes rejection unless `--takeover` is supplied. Attachment can also start a pending agent resume.
- Observe takes no ownership or resize lock, leaves the runtime size unchanged, and can coexist with control. Its dimensions describe rendering. Its CLI has no input reader; it cannot drive scrolling or subsequent resizes.
- Releasing/disconnecting control clears its lock; the foreground Herdr client can determine pane size again.
- Structured wheel scrolling uses the live terminal mode to choose host scrollback, application mouse-wheel reporting, or alternate-scroll keys. Page-key routing also uses terminal state. Normal input returns the viewport to the bottom.
- Raw input reaches the PTY after resetting host scroll position. The CLI stream does not deliver the child's mouse-protocol state.

Relevant source functions are `observe_terminal_client`, `attach_terminal_client`, `apply_terminal_attach_scroll`, `apply_terminal_attach_input`, and the `ClientResize` event branch. Upstream tests cover observer coexistence, controller conflicts, detach, pane exit, and scroll routing.

Consequences for AgeOfAgents: use `terminal.scroll` for actual server-owned history; set emulator local scrollback to zero so redraws cannot become a fabricated transcript. General click/drag reporting remains unproven: the stream repaints cells and does not replay the child's DECSET input modes. Keep selection local and do not inject guessed mouse reports. A complete mouse/keyboard-mode-aware client needs additional upstream mode metadata or a richer supported input contract. This limit does not prevent streaming rendering, explicit resize, typing, or server-routed wheel/page scrolling.

## Exact process targeting

Recommended argv, supplied as literal process arguments rather than a shell command:

```text
["terminal", "session", "control", validatedPaneId, "--cols", columns, "--rows", rows]
```

Use `observe` in place of `control` for a read-only view. Never silently add `--takeover`. Bind the process lifetime to a backend-generated attachment ID and the validated pane/root pair; do not allow frontend-supplied executable paths or arbitrary command JSON.

The [v0.8.0 socket-path implementation](https://github.com/herdrdev/herdr/blob/v0.8.0/src/server/socket_paths.rs#L12) derives the client socket from `HERDR_SOCKET_PATH`: `herdr.sock` becomes sibling `herdr-client.sock`, and `custom.sock` becomes `custom-client.sock`. Explicit CLI session selection precedes this override. `HERDR_CLIENT_SOCKET_PATH` is only a fallback when the API override is absent; otherwise the active session directory applies.

Recommendation: pass AgeOfAgents' already-resolved API socket path explicitly in the child environment as `HERDR_SOCKET_PATH`, so API validation and terminal attachment address the same server. Avoid relying on the GUI application's PATH or an unrelated inherited session. Resolve the installed executable through trusted backend configuration/discovery, and surface missing executable/protocol mismatch/connection errors. Do not launch or update Herdr automatically.

## Smallest viable integration and verification

This section is an implementation recommendation, not a claim that these changes are already present.

1. Add an opt-in **Direct terminal control** action next to the existing snapshot view. Explain that it fits the real pane to the dock. Opening the existing view alone should not acquire control. Refuse conflicting ownership with Herdr's actual reason; offer the normal snapshot view after failure.
2. A Rust module owns a bounded child process, stdin writer, stdout/stderr readers, cancellation, and final reaping. Validate the live pane and `expectedRoot` at opening and before user mutations. Disable it for fixture/demo mode. Register Tauri channels/listeners before spawning so the initial full frame cannot be lost.
3. Send validated frames over an ordered channel, preserving connection ID and sequence. Bound record size and pending bytes; fail clearly rather than dropping diffs under backpressure. Read stderr independently to avoid blocking the process. A closed record, EOF, protocol error, pane disappearance or view teardown must stop input and dispose the attachment.
4. A persistent emulator consumes only this transport's decoded ANSI bytes. Focus/active ownership gates keyboard input; an input queue preserves key order. Route wheel and plain page keys to the structured scroll command. Coalesce geometry changes, retaining nonzero bounds. Keep prompt composition on the existing guarded `sendPrompt` path.
5. Close by sending `terminal.release`, closing stdin, and reaping only the child CLI process, with bounded forced cleanup if it fails to exit. Never close/kill the agent pane. Scope cancellation so an old pane's cleanup cannot close a newer connection.

Use a fake executable and fake world state for automated verification, with no real attachments: assert argv/env and no takeover; incremental/full frame ordering and binary decoding; dimension changes; wrong-root and stale-pane rejection; inactive-pane input isolation; unsupported/malformed/oversized records; controller rejection and stderr; EOF without a closed record; release, startup cancellation, and process cleanup. Render a fixed frame sequence into a headless emulator to verify cursor rewrites change cells without accumulating output. Verify wheel commands rather than expecting local history. A later isolated runtime check can exercise actual resize/scroll ownership only when live manipulation is explicitly permitted.

## Implemented backend boundary

`src-tauri/src/terminal_transport.rs` implements the control path above using ordinary process pipes and a separate managed `TerminalTransportState`. It resolves an executable in absolute PATH entries, then `~/.local/bin/herdr`; passes the resolved API socket override explicitly; binds each generated lease to the pane, exact repository root, and initial working directory; and revalidates the live world before enqueueing every input, resize, or scroll. A changed working directory closes the connection even when the pane remains grouped under the same repository. No shell, takeover, live CLI fallback, input replay, or reconnect is used.

The public Tauri commands are `terminal_attach`, `terminal_ack`, `terminal_write`, `terminal_resize`, `terminal_scroll`, and `terminal_detach`. Attach takes a channel before spawning and returns a lease ID; frames can arrive before that promise resolves. Validated CLI frame/closed records keep their original shape. Startup refusal, malformed records, broken sequences, and local transport failures produce `{"type":"terminal.error","message":"..."}`. A write's success means accepted by the local queue, not acknowledged by the pane.

Limits: four simultaneous helpers, 500 columns × 200 rows, 64 KiB per input string, 16 pending command records, 4 MiB per stdout record, 8 KiB diagnostic tail, 1–200 lines per structured scroll, and a ten-second initial-frame deadline. Full input queues or invalid streams close the lease; diffs are never silently dropped.

Native output additionally reserves a per-lease limit of 128 unacknowledged frames and 4 MiB of serialized frame payload **before** calling the Tauri channel. Overflow closes the transport without sending the overflowing frame. The locally installed Tauri 2.11.5 `src/ipc/channel.rs` defines `MAX_JSON_DIRECT_EXECUTE_THRESHOLD = 8192` and inserts larger payloads into `ChannelDataIpcQueue` before JavaScript fetches them. Successful `Channel::send` therefore does not establish consumption and cannot by itself bound pending native data. The transport cannot reclaim Tauri's private payload entries already queued for an abandoned view, but it limits additional frames from that lease and releases its Herdr ownership.

`terminal_ack({leaseId, paneId, expectedRoot, seq})` is a cumulative acknowledgment, issued after the emulator's write callback. It validates lease identity and the current pane/root/working directory, rejects sequences before the latest acknowledgment or beyond the latest emitted frame, and releases the acknowledged native budget. Repeating the latest rendered sequence every five seconds is the idle heartbeat. Either 15 seconds without a valid acknowledgment/heartbeat, or an oldest pending frame remaining unrendered for 15 seconds, closes the helper. Thus heartbeats cannot hide a stalled rendering queue, and an idle lost view cannot retain control indefinitely. Acknowledgments received before the lease promise resolves must be deferred by the frontend. The frontend also bounds its own rendering and acknowledgment queues.

Detach closes the lease, discards unsent input, attempts `terminal.release`, closes stdin, and gives the helper 300 ms before killing/reaping only that helper. Natural exit, stdout EOF, invalid frames, failed channel delivery, and managed-state drop use the same cleanup. No agent process or Herdr server is killed. Missing executable/spawn failures reject attach immediately; CLI ownership/connection errors arrive asynchronously through the channel. Existing API world validation cannot provide an atomic cross-process pane identity check; Herdr resolves the target when accepting the attachment. Reuse of the same pane/root/working-directory tuple cannot be detected without an upstream creation identity.

Focused verification command (fake executables and synthetic worlds only):

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib terminal_transport::tests -- --nocapture
```

Fifteen tests pass: target/root/disconnection guards, dimensions/input/scroll bounds and explicit wheel/page-key routing, full/sequence/base64 frame checks, bounded line/diagnostic reads, stale-world/backpressure closure, exact process argv/env and command ordering, controller refusal, malformed stream cleanup, EOF without close, channel-failure/app-drop reaping, cumulative render acknowledgments, native byte/frame backlog limits, and stalled-renderer/idle-heartbeat expiry. Deadline tests advance transport timestamps rather than waiting 15 seconds. No live Herdr attachment was exercised.


## Implemented frontend boundary

Following the user’s width/latency feedback on 2026-09-22, opening a docked terminal or the world-map island terminal requests Direct control and fits the actual pane to the available view. The base Terminal component retains Mirror as its default for other callers. The mode strip explains the linked-pane resize and offers **Return to mirror** after ownership/CLI errors. Xterm loads lazily. Mirror retains output search and the multiline prompt composer is available in both modes. Frame dimensions are applied before ordered emulator writes, local emulator scrollback is zero, and acknowledgments are sent only after parsing each write. An early rendered frame waits for its lease ID before acknowledgment. The latest rendered sequence is acknowledged every five seconds while mounted. Closing, switching, errors, and abandoned StrictMode effects release or avoid acquiring the lease; input is never replayed.

The frontend caps pending rendering at 8 MiB/128 frames, pending acknowledgments at 128, and all queued/in-flight user commands at 64 with a separate 64 KiB byte limit. PageUp/PageDown explicitly send `source: "page_key"`; wheel gestures send `source: "wheel"`, preserving Herdr's different routing for application terminals. Mouse selection stays local; completing an output selection copies its text through the bounded native clipboard_write_text command (1 MiB). Selection gestures in the composer, search, other panes or other app surfaces do not copy terminal output. Failures are visible. Command-V reads the native clipboard only for that gesture and rechecks focus, active pane, and mount state before pasting. A receiving prompt still uses the established agent prompt API.

Native controller interaction was verified with fake processes, and emulator integration with mocked lifecycle tests. The browser harness rejects terminal attachment unless `terminalFixture=1` explicitly enables an in-memory synthetic stream for real xterm layout checks. That fixture never contacts Herdr and rejects terminal input/scrolling. No live agent was attached, resized, scrolled, or sent input during this implementation.


## Width, latency, scroll and selection follow-up — 2026-09-22

Mirror screen snapshots preserve the external pane’s column geometry; CSS scaling
cannot reflow the running program. Dock startup therefore now requests direct
control, with no forced takeover and an explicit mirror fallback. Mirror input
wakes polling when input dispatch starts, without waiting for its acknowledgment
and without drawing synthetic echo. Its wheel consumes local overflow first,
preserves position when opening available history, and no longer sends PageUp
when a full-screen program has no history.

Direct wheel bursts are batched for 16 ms and coalesced behind pending IPC.
Keyboard input flushes older wheel gestures before sending the key. Reconnecting
the same pane waits for any preceding owned attachment and native release to
finish; no input is retried. These interleavings have fake-transport regressions.

The town’s Cmd/Ctrl+Shift+F content search is reserved by both terminal modes.
It moves keyboard focus to the town work panel, deactivating the dock’s input.
Native clipboard and real controller behavior were not exercised against the
user’s sessions during development.
