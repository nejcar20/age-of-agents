# Age of Agents

A city-builder where the cities are your real git repositories and the villagers
are real AI coding agents.

![A repository as a town: every building is a file, as tall as its code](docs/media/town.jpg)

![An agent has finished, so its island glows green on the night sea](docs/media/sea.jpg)

Open it and you see your agent desk: projects on the left, agents ordered by
who needs you, and a live terminal one click away. The **World** view keeps the
archipelago: every repository is an island, sized by its actual code, and agents
appear as villagers on their islands.

## Working in the workspace

- Search projects, canonical paths, agent titles, or agent kinds with **⌘K**.
  Press Enter to open the first matching agent or project.
- Filter the agent desk to **Needs you** or **Working**. **Space** opens the next
  waiting agent when you are browsing; inside a focused terminal it remains Space.
- Select a project and **Start agent** using the existing launch/resume flow.
- Click an agent to open its terminal in the workspace, already focused for typing.
  Switch with the pane selector or **⌃⌥Tab** (add Shift to go backwards).
- **Split terminal** opens a second agent alongside the first. Only the active
  pane receives keyboard input. Closing a view leaves its agent running.
- Adjust terminal text with **A− / A+**; the size is remembered across sessions.
  **Fit pane** is optional. Use **Scrollback**, fullscreen, or **Focus external
  terminal** directly from the terminal controls. Keyboard details are under
  **Keyboard help**.
- Use **World** to explore the islands and open towns. Project navigation stays
  available alongside the map.

Docked terminals and terminals opened from an island start in **Direct control**, fitting the real pane to the available view
and streaming updates. **Return to mirror** keeps the external pane’s geometry
and displays snapshots; **Find output** searches its screen or available history.
Selecting terminal output automatically copies it in either mode (up to 1 MiB).
**Compose prompt** provides multiline editing: Enter adds a line, and Send
submits the whole task to the named agent.

**Direct control** uses Herdr's terminal attachment stream and an xterm emulator
for ANSI rendering, viewport resizing, and server-side scrolling. Attach is an
action requested by opening a terminal: it owns the terminal controller
while connected and may resume a pending agent. Its width and height also change
the linked external pane. It never forcibly takes over another controller. Release,
closing, or switching the pane detaches that connection. This requires a Herdr
version with `terminal session control` (verified against 0.8.0); an unsupported
CLI or occupied controller reports an error and leaves Mirror available.

Direct mode receives Herdr-generated ANSI frames, not the program's original PTY
byte stream. Arbitrary program mouse clicks are not supported by this CLI, and
output search is available in Mirror mode. Transport errors stop input without
replaying it. See [the transport notes](docs/superpowers/terminal-transport-findings.md)
for protocol details and validation limits.

It is a cockpit, not an autopilot. It does not do your work, decide anything for
you, or run your agents on its own. It replaces the thing you actually do all day:
cycling through four terminal tabs asking "is this one done yet?"

## How the world represents code

The whole design rests on one rule, and everything else is downstream of it:

> **The city is honest about the code.**
> It never draws something that is not on disk, and it never silently omits
> something that is.

Both directions are equally defects. A building you do not have is a lie; a
district quietly missing is the same lie wearing different clothes. In practice
this rule has been the most useful thing in the project — it decided every hard
call, and nearly every bug worth finding was a violation of it.

So: a building is a file, its height is that file's line count, its colour is what
kind of file it is. A district is a directory. A wall around a district means it
has tests. The town's shape is a deterministic function of the repository, cached
so it stays recognisably *your* city between sessions — add a file and nothing
moves.

Ground, water, sky and trees are scenery and are allowed to be decorative,
because nobody can mistake a tree for a file. Nothing decorative is ever allowed
to encode information.

At world scale, each island uses decorative cottage clusters proportional to
its measured district count. Visit a town to see the actual per-file buildings.
Coastlines, paths, and houses share a placement plan; agents stand on clear ground.

The other principles, in priority order, are in
[`docs/superpowers/specs/2026-09-16-age-of-agents-design.md`](docs/superpowers/specs/2026-09-16-age-of-agents-design.md).
Two worth stating here: **it is never slower than switching terminal tabs**, and
**nothing in it rewards being a worse engineer** — there are no scores, streaks or
counters that go up when you run more agents.

## What you can do

**In the sea**
- See every repository, sized by its real code, positioned stably between sessions
- See which agents are working, idle, or stopped and waiting for you, in
  Herdr's own colours: **orange** is working (the island glows orange too),
  **green** is finished work you have not looked at yet (green glow and
  beacon), and a **hollow green ring** is finished and seen. An agent counts
  as seen once you open its terminal here while the app is focused, or move
  Herdr's focus onto it
- Search by name, or filter to just the islands that need you
- Press Space to fly to whichever agent stopped first
- Click a villager to open that agent's terminal, right there — the same
  embedded terminal a town opens, with the same agent switcher (⌃⌥⇥). It used
  to raise your own iTerm window and throw you out of the app; that is now a
  button that says so
- Send a prompt to an agent, or read what it last said, without leaving
- Start an agent, resume a previous conversation, or settle a repository that has
  no workspace yet
- Found an entirely new project — directory, git repo, workspace and agent

**In a town**

- **⌘⇧F / Ctrl+Shift+F** opens **Search** for literal text inside repository
  files. Results are grouped by path and line; selecting one visits its building
  and highlights the matching line. **Aa** toggles case sensitivity. Search
  includes tracked and non-ignored untracked UTF-8 text, excluding symlinks and
  binary files; it reports skipped files and partial results. Limits are 250
  matching lines, 2 MiB per file, 32 MiB total, 10,000 candidates and a 5-second
  deadline. When a match falls beyond the bounded file preview, its search
  excerpt remains available. Queries and results survive switching town tools.
- Orbit, pan and zoom through your repository as a city
- Click a building or search **Files** to preview code and fly to its location.
  Open the file in its editor or reveal it in the file manager.
- Review **Changes**, with separate staged and working-tree diffs and colored
  markers on indexed buildings. Deleted and unindexed paths remain in the list.
  Refresh rescans the town and Git state; this is not a live filesystem watcher.
- **Ask an agent** about a file or select its district for a directory-scoped task.
  Review and edit the exact brief before sending. The brief names the receiving
  agent's worktree, so a town selection is resolved in that checkout.
- Use the **Harbor** to review incoming/outgoing trade briefs, open the receiving
  terminal, or establish another route.
- Click a villager or **Open terminal** to work in a resizable dock while keeping
  the town visible. Dock below or to the right; drag its divider or use arrow keys.
  Split panes stack when the available space is narrow.
- Start an agent, without going back to the sea first
- Watch the town grow while an agent works: it is re-measured every 5
  seconds, a building rises when its file crosses a height bucket, new files
  climb out of the ground, and every real line change floats a short-lived
  **+N** / **−N** over its building
- Every villager wears a badge with its state and the task Herdr reports for
  it, and the town glows orange or green like its island does. While an agent
  here is working, Git changes are re-read every 5 seconds and changed
  buildings pulse — changed, not "changed by this agent": Git cannot say who

Code inspection is read-only and bounded. Binary files, oversized previews,
missing paths, and Git errors are labeled; symlinks, special files, and `.git`
internals are not followed. Diff inspection does not run external diff or
text-conversion commands.

**On both**
- **⇧M** (or the ☀ button at sea) changes the time of day: day, golden hour
  or night. At night, windows are lit where agents are live and dark where
  nobody is. A soft bloom, vignette and — in recording mode — a tilt-shift
  finish every frame
- While an agent works in a town, the buildings it has changed stand in
  scaffolding, a crane works over them, and chimneys smoke; it all comes
  down when the agent stops
- **⇧R** toggles recording mode, for screen recordings: the world fills the
  window, every panel and every name (islands, task titles, paths) leaves the
  shot, and the camera slowly orbits. At sea, an agent finishing flies the
  camera to its island for a few seconds before easing back out
- Raise your own terminal window on a pane, when that is what you actually
  want — it is a button that says so, not what a click does. One button, one
  wording, the same place in the agent's own panel, on either screen
- Everything an agent's panel offers — its last output, a prompt box, the
  embedded terminal, the way out to the real one — is the same component in
  both places, so the two cannot drift apart

## Running it

Requires [Herdr](https://herdr.dev) — the terminal multiplexer this reads from —
plus Rust and Node. Install Herdr with `brew install herdr` (or
`curl -fsSL https://herdr.dev/install.sh | sh`) and start it by running `herdr`
in any terminal. Until it is running, the app shows these steps itself and
connects on its own once Herdr is up.

```sh
source "$HOME/.cargo/env"   # if cargo is not already on your PATH
npm install
npm run tauri dev
```

The app finds your repositories by scanning configured roots (defaulting to
sensible guesses; `~/.age-of-agents/config.json` overrides). It reads Herdr over
its unix socket and never speaks to anything else — no network, no telemetry.
Everything it stores lives in `~/.age-of-agents/`.

## Building a release

```sh
source "$HOME/.cargo/env"   # if cargo is not already on your PATH
npm run tauri build
```

Verified 2026-09-19 (first time this was ever run): it succeeds. A clean
release build — `tsc && vite build` for the frontend, then a release-profile
Rust compile of every dependency — took **1m 44s**; an incremental rebuild
after a config-only change took **~1m 20s**. Output lands in
`src-tauri/target/release/bundle/`: `macos/Age of Agents.app` (an ad-hoc-signed,
unnotarized app bundle — expect Gatekeeper's "unidentified developer" prompt on
first launch, not a crash) and `dmg/Age of Agents_<version>_aarch64.dmg`. Both
are gitignored (`src-tauri/.gitignore`'s `/target/`), so a build never leaves
anything to accidentally commit.

The only warning worth knowing about is from the frontend bundle
(`dist/assets/index-*.js` is ~1.2 MB, over Vite's 500 kB chunking heads-up) —
cosmetic for a desktop app that isn't served over a network, not a build
defect.

This is also the path that matters for native notifications:
`tauri-plugin-notification` deliberately shows dev-mode notifications under a
different (and, on this machine, unauthorized) identity — see the "Known gaps"
note below and `docs/superpowers/phase-0-followups.md` §1.1 for what that means
and what to check after building.

## Architecture

- **`src-tauri/`** — Rust. Talks to Herdr, walks repositories, builds the city
  model, lays out towns and the archipelago, owns every write.
- **`src/`** — React + three.js (via react-three-fiber). Renders the sea and the
  towns; holds no authority over what is true.
- **Herdr** — the source of truth for what agents exist and what they are doing.

The Rust side is deliberately the only thing that decides anything. The frontend
draws what it is told.

### What the app is permitted to do

This is a short list on purpose, and it is checked at every review:

| Allowed | Forbidden |
|---|---|
| `workspace.create`, `agent.start`, `agent.prompt`, `agent.focus`, `workspace.focus`, `pane.focus`, `notification.show`, `pane.send_text`, `pane.send_keys`, explicit terminal attach/input/resize/scroll/release, and the read-only `agent.read`, `pane.read` and `agent.list` | Everything else — notably `pane.run`, `workspace.close`, and forced terminal takeover |
| One `git init`, for a project you explicitly create | Every other git write |
| Writes inside `~/.age-of-agents/`, and the one directory you name when creating a project | Writes anywhere else |
| Reading the system clipboard when you press ⌘V in a focused terminal; copying output when you finish selecting it in that terminal | Unprompted clipboard reads or writes, and copying text from other app surfaces |

Prompts are composed and sent by you. The app never originates one, never
re-sends, never retries, and never sends in response to an agent's state.

`pane.send_text` and `pane.send_keys` were forbidden until the interactive
terminal existed, and they are the largest capability here: they put real
keystrokes into a real session. They are permitted only from a terminal
surface that has keyboard focus and that shows you which pane and repository
it is attached to. The app never synthesises input you did not type — no
macros, no replay, no auto-answering a prompt, not even a helpfully appended
newline.

What the terminal *does* do with a real gesture is translate it, the way any
terminal emulator does: the six keys Herdr has no word for (PageUp, PageDown,
Home, End, Delete, Insert) travel as the escape sequences your own terminal
sends for them, ⌘V pastes what is on your clipboard, and a wheel scrolls the
local viewport or the pane’s available history. Direct control routes wheel
gestures to Herdr; Mirror never converts a wheel gesture into a PageUp key. What it will
not do is send mouse clicks: that would mean guessing whether the program has
mouse reporting on, and guessing wrong puts garbage in your input line. So
clicks focus the terminal and select text, and completed selections copy automatically.
The terminal explains that program mouse actions are unavailable.

That embedded terminal is also the one place this app bends its own third
principle ("the terminal is never hidden"). It is acceptable only because it
is a true mirror: the same pane and session, visible identically in your own
terminal emulator at the same time. If it ever shows or does something the
real terminal cannot, the right fix is to take the capability away.

## Known gaps

- **"Seen" is this app's, not Herdr's.** Herdr's API reports finished and
  finished-and-seen agents alike as `idle`, so the filled/hollow split is
  tracked here and the two sidebars can briefly disagree. Agents already
  finished when the app starts show as seen, and one that finishes while it
  is already Herdr's focused pane stays "not seen" until focus moves onto it.

Kept honestly, because a list like this is more useful than a claim of
completeness. The long version is in
[`docs/superpowers/phase-0-followups.md`](docs/superpowers/phase-0-followups.md).

- **Notifications have never been *seen* to fire, though the reason dev mode
  never showed one is now confirmed rather than suspected.** `tauri-plugin-
  notification` literally hardcodes `com.apple.Terminal` as the posing identity
  whenever `tauri::is_dev()` is true, and uses this app's own bundle identifier
  (`dev.ageofagents.cockpit`) only in a release build. A release build now
  exists and runs the real code path under the real identity, but whether macOS
  actually renders a banner still depends on a per-app notification permission
  toggle no test or harness can flip — see
  `docs/superpowers/phase-0-followups.md` §1.1 for exactly what to check.
- **Mirror only scrolls history Herdr actually exposes.** If a full-screen agent
  has no history, wheel gestures remain local; they no longer inject PageUp into
  the program. Direct control uses Herdr's server-side scroll command instead;
  the program still determines which scroll gestures it handles.
- **Direct control has been verified with fake processes and protocol tests,
  not attached to an existing live agent during development.** Native controller
  ownership, resizing, and clipboard behavior still need a user session trial.
- **⌘V has never been tested in the real app.** The clipboard read goes
  through the platform rather than the webview's own Clipboard API precisely
  because the latter is unreliable inside a WKWebView, but nothing in this
  repository launches the app, so the only proof it works is the same kind
  of proof §9 is a list of counterexamples to.
- **A repository vendored inside a pruned directory** (`node_modules` and
  friends) will not be found. A deliberate trade for scan speed.
- **Cold load of the sea** is bounded by the single largest repository's file
  walk.
- **Nobody has lived with it yet.** Everything here is verified by tests, review
  and rendered screenshots. Whether it actually replaces tab-cycling is still an
  open question, and the only way to answer it is to use it for a week.

## Tests

```sh
npm test                                    # frontend
cd src-tauri && cargo test --lib            # rust
cd src-tauri && cargo clippy --all-targets  # lints
```

A note on what the tests are worth here: on this project, four separate honesty
defects were each found by a human looking at a rendered image while the suite was
green — a city that was 85% build cache, a repository drawn two and a half times,
every test file painted as source, and half the archipelago silently missing. The
suite is good at stopping regressions and has never once caught one of those
first. If you change how something looks or what it includes, **render it and look
at it.**

## Project trade routes

Use **Trade routes → Establish a route**, **Share project** in an agent's
terminal, or **Establish trade route** on an island. Choose a reference project,
a destination with a running agent, and a brief describing what to bring over.
The complete message is editable before the explicit send.

**Inspect & propose** asks for a plan before file changes; **Start implementing**
asks the receiving agent to adapt the code in its own working tree. The generated
brief treats the reference as read-only. It does not grant filesystem access or
change the agent's permissions; the agent must already be able to access both
local paths. An agent in a worktree receives that actual working directory as
well as the destination repository root.

Acknowledged sends are saved locally with the exact submitted message. They
appear as directional connections in World while both islands are present.
A saved route means **brief sent**, not integration completed or automatic
synchronization. Removing it does not cancel agent work or undo code changes.
Storage failures keep changes for the current session and display a warning.

Opening a receiving terminal checks the repository, working directory, pane,
and agent kind. Herdr does not expose a durable session identity here, so a
replacement of the same kind in the same pane cannot be distinguished from
the original session. No saved route automatically sends another message.

## Browser preview

For design inspection without touching live agent sessions:

```sh
npm run dev
# Open http://127.0.0.1:1420/townshot.html?workspace=1&fixture=workspace
```

This uses the labeled synthetic fixture in `fixtures/workspace.json`. The
existing screenshot harness rejects write commands and is excluded from the
production entry point. Native clipboard and live Herdr interaction must still
be checked in the desktop app.

Add `&terminalFixture=1` to render synthetic ANSI frames in the real terminal
emulator and check fitting/resizing without a live connection. For the world-map
popup, open
`http://127.0.0.1:1420/townshot.html?app=1&fixture=workspace&villagerClickPaneId=w1%3Ap1&terminalFixture=1`.
The preview labels its synthetic output and rejects terminal input and scrolling.

Add `&routes=1` to preview two sample trade routes, then open **World** or
**Trade routes**. These records use an isolated memory store and never enter
your saved history. Submitting prompts remains disabled in the preview.

To inspect a detailed town from this checkout, generate the local fixture:

```sh
cargo run --manifest-path src-tauri/Cargo.toml --bin city_fixture -- . fixtures/aoa-town.json
# Open http://127.0.0.1:1420/townshot.html?fixture=aoa-town
```

For the town work panel inside the full workspace, use
`http://127.0.0.1:1420/townshot.html?workspace=1&fixture=workspace&routes=1&openIslandRoot=%2Fdemo%2Fprojects%2FAgeOfAgents`
and click **World**. File previews and Git changes in this browser harness are
illustrative sample data; the desktop app reads the selected checkout.
