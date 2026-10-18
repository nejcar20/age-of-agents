# Town workspace and terminal tools

The user approved all the proposed town and terminal improvements. Build a useful loop: search or click real code, inspect its contents and Git changes, give a selected agent a reviewed task scoped to that file/directory, watch the terminal, and review resulting changes.

## Town

- Persistent work panel with Files, Changes, and Harbor tabs. Search indexed file paths and fly to a selected building. Clicking buildings or districts opens the same inspector.
- Read-only file preview and separate staged/unstaged Git diffs. Binary, deleted, oversized, inaccessible, and directory paths must be explicit states. Read paths stay inside the selected repository after resolving symlinks; no shell interpolation, textconv, external diff, or file writes.
- Git changes are read from the working tree, refreshable, and shown as a list plus colored building markers. Deleted/unindexed paths remain in the list even when no building exists.
- A scoped task composer chooses a live local agent, explains file/directory context and the actual agent working tree, previews the full editable prompt, and sends only on an explicit click using expectedRoot. Stale receivers, offline state, duplicate sends, and send failures stay honest.
- Harbor lists existing incoming/outgoing trade routes with complete briefs and access to the receiving terminal and route composer. Never infer progress from a saved handoff.

## Terminal

- A persistent, resizable dock below or beside the town; the canvas resizes to fit the remaining area. Two independently selected terminals may share the dock. Only the active terminal handles global shortcuts; closing a dock pane only detaches the view.
- Search the currently available screen/scrollback output with match navigation. Do not invent historical output from repeated screen snapshots.
- A multiline prompt composer with explicit send, no automatic submission on Enter, preserved draft on errors, and existing pane/root validation.
- Investigate the installed Herdr API's ability to expose raw terminal streaming, viewport resize, mouse reporting, and attachment. Implement only supported behavior; record exact evidence if a true terminal bridge requires upstream work. Do not launch or manipulate real agents during development verification.

## Constraints

Preserve all existing uncommitted workspace/town/trade-route changes. No new external services, no synthetic agent/file activity, no dependency on demo fixtures in production. Keep the demo clearly labeled and all IPC writes blocked. No commits or live-agent sends as part of verification.
