# Age of Agents workspace redesign

The product is a local workspace for supervising real coding agents. The city remains its distinctive view of the code; everyday work should take one click from a persistent list to a readable terminal.

## Direction

Default to a workbench with a 252px project sidebar, an attention queue, and an inline terminal. Keep the existing archipelago and towns available through a World view. Project rows include canonical paths for duplicate-name disambiguation. Search covers repository names, paths, agent titles and kinds. Filters never detach an open terminal. A disconnected backend is stated visibly; repository discovery errors are recoverable.

Use ocean #101f2b, harbor #172a38, slate #263d4b, mist #dce8eb, teal #80c8c2, and amber #e5b46b. System sans is the working UI, monospace only for actual terminal output and paths. A small geometric island mark carries identity. Flat navigation and spacious, distinct content regions replace chunky cream panels. Attention color describes real reported state.

## Terminal

Reuse the existing guarded Herdr pane transport and polling, preserving expected-root checks and explicit user input. Add an embedded presentation, deliberate focus on opening, fixed readable text size by default, adjustable zoom, optional fit-to-pane, fullscreen, and compact keyboard help. Do not infer cursor position, replay snapshots into an emulator, or fabricate scrollback. The source API remains a screen mirror; program mouse interaction and true PTY resizing require a different transport and are out of scope.

## Verification

Cover project joining and duplicate roots, searching, switching and disappearing panes, keyboard navigation, zoom persistence, and focused input. Run the frontend suite and production build. Inspect the production components through the existing browser harness, using explicitly synthetic local fixtures with all write calls disabled.
