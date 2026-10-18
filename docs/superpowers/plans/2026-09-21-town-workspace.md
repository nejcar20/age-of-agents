# Town Workspace Implementation Plan

> Execute the independent backend and terminal tasks using the parallel-agent skill; integrate and verify in the existing shared workspace. Prior changes are uncommitted and must be preserved.

**Goal:** Make the town a usable code-review and agent-work surface, with docked terminals and honest file/Git data.

**Architecture:** Rust read-only inspection commands expose bounded file text and Git status/diffs. A TownWorkspace component combines the existing TownView with a work panel and shared TerminalDock. Existing sendPrompt and trade-route context provide all agent handoffs. Terminal output search/composition stays in the reusable Terminal component.

**Tech Stack:** Existing React/TypeScript, Three.js, Rust/Tauri, Git CLI, Vitest/Rust tests.

**Spec:** ../specs/2026-09-21-town-workspace.md

## Global constraints

- During development verification: no live-agent sends, native pane manipulation, commits, external services, or fabricated file activity.
- Preserve existing edits. Keep backend calls read-only and bounded; never run Git external-diff/textconv hooks.
- Canonicalize and confine inspected paths to the selected repository. Preserve expectedRoot on every agent send.
- All new dialogs must own keyboard input; split terminals must never both forward a keystroke.

## Task 1: Repository inspection backend

Files: new `src-tauri/src/inspection.rs`, register module/commands in `src-tauri/src/lib.rs`.

Interfaces (snake_case JSON):

```ts
type RepoChanges = { root: string; branch: string | null; entries: ChangeEntry[]; truncated: boolean };
type ChangeEntry = { path: string; previous_path: string | null; status: 'modified'|'added'|'deleted'|'renamed'|'untracked'|'conflicted'|'typechanged'; staged: boolean; unstaged: boolean };
type FileInspection = { path: string; kind: 'text'|'binary'|'directory'|'missing'; content: string | null; truncated: boolean; staged_diff: string; unstaged_diff: string; diff_truncated: boolean };
// invoke('repo_changes', {root}) and invoke('inspect_project_path', {root,path})
```

- [x] Write failing Rust coverage using temporary Git repositories: staged vs unstaged changes, untracked/deleted/renamed paths, spaces, text/binary/oversized file states, traversal/symlink rejection.
- [x] Implement bounded read-only commands with `spawn_blocking` and literal process arguments. Diff against index and cached diff separately. Reject `.git` internals and special files. Return errors rather than empty success.
- [x] Run scoped Rust tests and report exact command results. Review before full integration.

## Task 2: Terminal output tools and input ownership

Files: `src/components/Terminal.tsx`, `src/terminal.css`, new focused components/helpers/tests as appropriate.

Interface: add optional `active?: boolean` (default true) to Terminal. All window-level keyboard handlers and autofocus obey it. Existing embedded behavior remains intact.

- [x] Write failing coverage for output search navigation and multiline explicit send, preservation after failure, and inactive terminal shortcut isolation.
- [x] Add Find output UI over available output and a separate multiline agent prompt composer using existing `sendPrompt(paneId,text,root)`. Keep Enter as newline and provide an explicit send button.
- [x] Keep normal pane typing/selection behavior intact, no fake output accumulation. Run terminal tests.

## Task 3: True-terminal capability investigation and direct control

- [x] Read the locally installed Herdr API/schema/source/docs, without invoking writes. Identify whether terminal bytes, attachment, viewport sizing, and mouse events are available.
- [x] Record exact findings and the smallest feasible next integration in `docs/superpowers/terminal-transport-findings.md`. If no supported raw stream exists, preserve the honest snapshot path and describe upstream requirements.

Herdr 0.8.0 exposes a supported terminal session control stream, so the approved terminal improvement includes an explicit Direct control mode. It uses a managed native helper and xterm renderer, separate from the default mirror.

- [x] Implement leased attach/input/resize/scroll/release with exact root, pane, and launch-directory validation; no takeover or automatic replay.
- [x] Bound transport and render queues; acknowledge parsed frames and expire missing acknowledgments/heartbeats. Test lifecycle, controller rejection, StrictMode, inactive input, clipboard focus checks, and cleanup with fakes.

## Task 4: Town work panel, file actions, and harbor

Files: new `src/inspection.ts`, helpers/tests, `src/components/TownWorkspace.tsx`, `src/components/ScopedTaskComposer.tsx`, `src/townWorkspace.css`; modify `TownView.tsx` and `App.tsx` integration.

TownView adds selection callbacks, an external focus request `{path,seq}`, optional change paths, and optional suppression of its built-in inspector. Requests select real indexed buildings/districts and move the existing camera controls. Missing paths do not invent buildings.

- [x] Test file indexing, search, change matching and scoped prompts (including worktree context).
- [x] Implement Files/Changes/Harbor panel, stale-request cancellation, loading/error/empty states, explicit refresh and selected-file inspection.
- [x] Connect selection from map and list to inspector, add Git markers and camera focus; retain standalone TownView behavior for older callers.
- [x] Implement reviewed task composer with agent validation and duplicate-send guard. Add browser fixture handlers for read-only inspection only.

## Task 5: Dock and split terminal integration

Files: new `src/components/TerminalDock.tsx` and tests/CSS; modify `App.tsx` and `Workbench.tsx`.

- [x] Build dock with right/bottom layout, pointer and keyboard resizing, live target selection, close controls and optional second pane.
- [x] Scope each terminal's switchTo to its own slot; activate on focus/click and pass active state. Detach stale panes without sending keys.
- [x] Use the dock inside the town and workspace; keep terminal stage/scene claims honest and avoid remounting the town when opening/closing docks.

## Task 6: Verification and handoff

- [x] Run full frontend tests/build and scoped backend tests, then broader Rust tests if backend changes warrant it.
- [x] Inspect browser desktop/narrow layouts: search and camera flight, file and diff views, changes markers/list, harbor, task review, dock resizing/splits/search/composer. No live sends.
- [x] Request independent code review; fix important findings and rerun affected checks.
- [x] Update README and plan completion notes with observed limits, including the terminal transport investigation.


## Completion evidence — 2026-09-22

- `npm test`: 57 files, 736 tests passed.
- `npm run build`: passed (existing large-main-chunk warning; emulator loads separately).
- `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib --quiet`: 395 passed, 16 deliberately ignored; no failures. Inspection 20, terminal transport 15 focused tests included.
- Browser checked 1800×1043, 1000×850, 390×844: file search/camera navigation, building click and refresh, staged/working/deleted diffs, task draft/review, harbor receiver, terminal split/pickers, pointer/keyboard resize, output search, multiline editing, direct failure and mirror recovery. Viewport reset.
- Independent town, native, and terminal frontend reviews completed. Fixed checkout-root prompt resolution, stale focus requests/scan races, Git lazy fetch and remote-helper execution, descriptor-based file confinement, native frame acknowledgment budget/timeout, PageUp routing, and bounded user-command queues. Reviewers confirmed reported issues resolved.
- The preview uses labeled sample data. Native terminal transport was tested with fake helpers and mocked emulator lifecycle, with no live attachments, sends, scrolling, or resizing. A user trial of real controller/clipboard behavior remains an explicit validation limit.

## Follow-up: terminal feel and content search — 2026-09-22

User feedback: the mirror occupied the dock but retained a narrow terminal;
input felt slightly delayed, scrolling was poor, selection should auto-copy,
and the town needed Cmd+Shift+F search inside file contents.

- [x] Docked terminals request Direct control by default, using real pane geometry
  and streamed updates; the mode strip explains the resize and provides mirror
  recovery. Standalone terminals retain their existing mirror default.
- [x] Mirror refresh begins as soon as input is dispatched. Wheel movement first
  uses the local viewport, never injects PageUp when history is unavailable,
  preserves reading position on entry to history, and follows the prompt across
  viewport resizes only when already pinned to the bottom.
- [x] Direct wheel events are batched/coalesced with bounded pending commands.
  Older wheel gestures flush before keyboard input. A remounted pane waits for
  its previous pending attach/release, without takeover or replay.
- [x] Completed output selections auto-copy in both modes through a native
  wrapper capped at 1 MiB. Composer/search/outside/cross-pane selections are
  excluded; failures are shown. Program mouse clicks remain unsupported.
- [x] Town Search searches literal text in tracked and non-ignored untracked
  files, with optional case sensitivity, grouped file/line results, highlighted
  snippets and matching-line navigation. Cmd/Ctrl+Shift+F takes focus from the
  terminal and respects open dialogs. Search survives tab/panel changes and
  serializes scans, discarding stale/obsolete queries.
- [x] Native search retains descriptor-based path confinement and bounds files,
  bytes, output, and time. Binary/symlink/special files are skipped; partial
  results are explicit. A match outside the bounded preview shows its search
  excerpt with an explanation.

Verification:

- `npm test`: **58 files / 770 tests passed**.
- `npm run build`: passed; existing large-main-chunk warning remains.
- `cargo test --offline --lib --quiet`: **408 passed / 16 ignored**, no failures.
- `git diff --check`: passed.
- Browser: Cmd+Shift+F focus, result→building/line, mirror recovery, completed
  selection→clipboard command (harness rejects writes), desktop/narrow/mobile
  layouts, and resize bottom pinning. The reproduced resize left scrollTop at
  343 for a 50px viewport; after the fix the resized mirror remained exactly at
  the bottom (`scrollHeight - clientHeight == scrollTop`). Viewport restored.
- Independent search/clipboard and terminal reviews completed. The release and
  wheel-order races identified in review now have regression coverage; reviewer
  rechecked the fixes and found no remaining important issue.
- Terminal tests used fake native helpers and mocked transports/emulators.
  End-to-end live controller/clipboard behavior and perceived latency still need
  a native user session trial; no performance improvement percentage is claimed.

## World terminal follow-up — 2026-09-22

The next screenshot exposed a missed opening path: IslandPanel still selected
Mirror. It also exposed Drei HTML labels escaping the scene's stacking context.

- [x] Island terminals now request Direct control on opening and switching panes,
  matching the dock. A regression test failed with the old default and passed
  after this change; existing Mirror interaction tests select that mode explicitly.
- [x] Both map Canvas wrappers isolate their HTML labels beneath interface panels.
- [x] Excluded xterm's own `.terminal` class from the app's popup centering rule.
  Replaced measurement-host padding with margins: FitAddon reads its computed
  border-box size without subtracting that padding, previously overestimating cells.
- [x] Added an opt-in, dev-only synthetic terminal stream for actual emulator
  layout checks; no live connection, input, or scrolling is available in it.

Verification:

- Full frontend suite: **58 files / 771 tests passed**. After final copy changes,
  the four affected terminal suites also passed (**126 tests**).
- Production build and `git diff --check` passed. Existing bundle-size warning
  remains. Production output contains neither `terminalFixture` nor the synthetic
  preview label.
- Real browser/xterm, synthetic frames: popup host 1170px / screen 1165px (129
  columns); fullscreen 1770px / 1761px (195); narrower fullscreen 970px / 966px
  (107); increased font 970px / 963px (100); docked 720px / 713px (79). Cells
  stayed within each measured host and changed with viewport/font adjustments.
- Closed terminal, moved the world camera, reopened: labels still had depth
  z-indices above 11 million but remained behind the terminal inside the isolated
  scene. Checked 1800×1043 and 1000×850; restored the viewport afterward.
- Independent scoped review found no correctness issue. Native code unchanged;
  no live Herdr agent was attached, resized, scrolled, or sent input.
