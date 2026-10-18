# Workspace redesign implementation plan

**Goal:** Make real agent work directly accessible in a coherent, readable desktop workspace.
**Architecture:** A Workbench hosts the existing terminal attachment/stage and start-agent flows. The existing App scene remains an optional atlas. Pure project joining/search helpers keep repository discovery separate from live agent truth.
**Tech stack:** Existing React, TypeScript, CSS and Tauri APIs; no added runtime dependencies.
**Spec:** docs/superpowers/specs/2026-09-21-workspace-design.md

## Constraints

All agents/status/output derive from existing backend state. No new backend write capability. Retain canonical-root safety. No command is sent without a user gesture. Keep the existing map/town and founding features reachable. Browser fixtures are dev-only and cannot send to real panes.

## Tasks

- [x] Add workspace data helpers and regression tests: merge discovery with live world by canonical root, preserve duplicate names, search title/path/kind, filter current agent attention.
- [x] Build Workbench and its CSS: persistent project navigation, attention queue, selected-project agent launcher, inline terminal attachment, map switch, disconnected/error/empty states, keyboard search and next-agent navigation. Test direct terminal opening, search without detaching, and vanished panes.
- [x] Improve Terminal: embedded layout, readable persistent zoom/fit selection, fullscreen, explicit scrollback access, compact help, focus on opening from Workbench. Preserve input routing and snapshot semantics. Test zoom persistence and focus.
- [x] Wire default app and dev harness, create a labeled synthetic fixture, inspect overview/terminal/map in browser.
- [x] Run full frontend suite/build; fix failures and document actual limitations. Update README with new workflow and shortcuts.

## Verification notes

The production UI was inspected in Chrome with a clearly labeled synthetic fixture, at desktop, 1100×720 (the native default) and 390×844. Verified direct terminal opening, zoom persistence across switching, and responsive project access. Review identified and resolved Ctrl+K interception, search Escape propagation, modal focus/input isolation and stale scrollback font sizing. Native Herdr writes and clipboard integration were not exercised.
