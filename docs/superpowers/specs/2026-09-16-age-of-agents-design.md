# Age of Agents — Design

**Date:** 2026-09-16
**Status:** Approved design, ready for implementation planning
**Revision:** 2 — incorporates external design review (see §13)

## 1. What this is

A city-building game whose cities are your real software projects, and whose
villagers are your real coding agents.

**The thesis, honestly stated.** [Herdr](https://herdr.dev) already routes
attention: it shows which agent is blocked and notifies you. Age of Agents is
not a faster router. It is two things Herdr does not do:

1. **A strategy layer.** You can supervise about four agents and you have
   thirty projects. Deciding where to point those agents is a real
   allocation problem you currently solve badly, in your head, across four
   terminal tabs. This game makes it a move on a map.
2. **A place to think when nothing is running.** Your repos as a living world
   you want to look at, plan in, and return to.

The game layer is real, but it never drives. The user gives every order.

**Audience:** developers who run multiple coding agents at once. Single player,
fully local.

## 2. Principles

In priority order. These decide arguments later.

1. **The user has full control.** Nothing happens in a repo that the user did
   not press a key for. No autonomous dispatch, no auto-commit, no auto-retry.
2. **Never slower than the terminal.** Jumps cut instantly — no camera flight
   on the attention path. Keyboard first; the mouse is for shaping the city,
   not for working.
3. **The terminal is never hidden.** A real Herdr pane is one key away from
   everywhere. Herdr is the truth; the game is a layer over it.
4. **The city is honest about the code.** It never misrepresents the state of
   a repo. What exists and its condition come from the code; only *layout* is
   the player's.
5. **Nothing rewards being a worse engineer.** No reward for speed of response,
   volume of output, or tokens spent.
6. **Threats attack the code, never your attendance.** Pressure about a CVE is
   honest. Guilt about a weekend is not. No decay of earned progress, no
   streaks, no busywork.
7. **Local by default.** V1 has no accounts and no backend. Code never leaves
   the machine.

## 3. Visual direction

Stylized low-poly 3D in the spirit of Townscaper, Islanders and Dorfromantik.
Calm, soft palette, small figures, gentle camera when browsing — but instant
cuts on the attention path (principle 2).

**Sound is a feature, not flavor.** Distinct audio cues for "builder finished",
"builder waiting", and "fire started" mean you can hear the state of your
agents from another window.

## 4. The world

### 4.1 Three screens

**Archipelago (zoomed out).** Every project is an island:

- Flying banner: agents working here.
- ❗ marker: an agent has stopped and needs you (see §5.3 on why this is one
  state, not three).
- Smoke: tests or build failing, as of the last verified run.
- Blight: dependency rot, spreading.
- Vines: dormant project.

One hotkey cuts to the next island needing attention.

**Town (zoomed in).** One project as a city:

| Repo concept | City |
|---|---|
| Directory | District |
| File / module | Building (height from lines of code, style from file type) |
| Tests covering a directory | Walls around that district |
| Agent working in a path | Villager hammering on that building |
| Aging TODO/FIXME clusters | Ruins, spreading |
| Outdated / vulnerable dependencies | Blight, spreading |
| Time since last commit | Weathering, vines |
| Unverified work | Scaffolding |

**The Keep (overlay).** The report queue with a diff viewer, where stopped
agents are answered (§5.4).

### 4.2 Layout: deterministic default, player-owned final

The earlier promise of "same repo, same city on every machine, forever" is
**cut**. It conflicted with both an improving generator and with player agency.

- The generator produces a **default** layout from the repo: districts from
  directories, placed by a real layout algorithm (road network / adjacency
  rules — *not* hash-on-a-spiral, which produces a scatter plot).
- The player may **re-zone**: move districts, shape the island, place
  decoration and monuments. This is saved per user in
  `~/.age-of-agents/towns/<repo-hash>.json` and always wins.
- New files land in their district's next free plot. Deleted files leave a
  plot that the player can rebuild on.

**Honesty is preserved** because the code decides *what exists and its
condition*; the player only decides *where it sits*. You cannot place a wall
that is not a real test.

**Generation quality is the top design risk.** Lockfiles and generated JSON
must not become skyscrapers; a migrations folder must not become 400 identical
huts. The generator needs explicit rules for generated/vendored files, and
needs iterating against real repos (see §10, Phase 0.5).

## 5. The game

### 5.1 Layer 1 — Allocation under scarcity (the core verb)

The scarce resource is **your attention and your agent slots**, not currency.
Four agents, thirty projects, competing needs. This is the Age of Empires
villager-reassignment loop, and here it is the real decision.

**Assigning builders is the primary dispatch verb:**

1. Drag a builder onto a district (or press its hotkey).
2. The prompt box opens, pre-filled with path context ("Work in
   `src/payments/`…") and the district's known problems.
3. The user types the task and presses enter.
4. The text is sent to the real pane via `pane.send_text`, so it also appears
   in the terminal.

This is faster than a cold prompt because the context is pre-written, and it
satisfies principle 1 because the user always types and confirms.

### 5.2 Layer 2 — Zoning (player expression)

See §4.2. Re-zoning, decorating and monument placement are the quiet-day
activity and the reason a city feels like yours rather than a render.

### 5.3 Layer 3 — Entropy (the opponent)

Opposition is real, never fabricated:

| Threat | Real signal | Behavior |
|---|---|---|
| **Blight** | Outdated dependencies, especially with known CVEs | Creeps outward from the importing district |
| **Fire** | Failing tests or a red build, as last verified | Burns until put out |
| **Ruins** | Aging TODO/FIXME and dead code | Spread slowly |
| **Overgrowth** | Months without a commit | Quiet, reversible, never punished |

Bounded by principle 6: threats attack the code, never the user's attendance.
An abandoned project is allowed to be peacefully overgrown.

**Staleness rule (principle 4).** Fire state is only as fresh as the last
verified run. The UI must show fire state with its timestamp ("tests last
verified 2h ago"), never as a live claim.

### 5.4 The core loop

```
Survey the archipelago
  → assign builders to districts (user writes and confirms every prompt)
  → work happens in real time
  → stopped agents queue at the Keep
  → user reviews the diff and gives a verdict
  → the city changes
  → survey again
```

**Founding a town.** The user picks a spot, names it, picks a stack template,
and describes the project. The game creates the directory, runs `git init`,
creates a Herdr workspace (`workspace.create --cwd`), shows the scaffold prompt
for editing, sends it on confirm, and the first commit completes the Town
Center. This doubles as the tutorial.

**Discovering existing land.** On first launch, scan the projects directory
(default `~/Projects`, configurable) and generate a town per repo. Generation
is **lazy and progressive** — scanning 30 repos' history is not instant (§12).

**The Keep.** When an agent stops, a messenger arrives with a scroll
containing: the agent's summary, **the diff**, the last verified test state,
and the files touched.

**A diff viewer is a Phase 1 requirement.** Without it, Accept is either blind
(violating principle 5) or forces a drop to the terminal (making the Keep a
redundant confirm dialog). Read-only unified diff per file, keyboard
navigation.

**One attention state, not three.** Herdr's `blocked` detection is
screen-pattern matching; an agent that asks a question in prose reads as
`idle`. So `blocked`, `done` and `idle`-after-work collapse into **"stopped —
look at it"**. The scroll shows what Herdr thinks, but the UI never depends on
the distinction being right.

**Verdicts**, one key each:

- **Accept** — commit or merge. Exact git command shown first.
- **Verify** — run the project's test command and read the **real exit code**
  (see §8.3; this is spawned by the Tauri core, not sent to the agent's pane).
- **Continue** — back to the agent with notes, suggestions drawn from the diff,
  always editable.
- **Raze** — discard, command shown first.
- **Enter the terminal** — the raw Herdr pane, full screen.

### 5.5 The quest board (core, not garnish)

The move list. Generated from repo analysis and ranked:

- "The east quarter has no walls" — a directory with no tests.
- "Blight in the north" — a vulnerable dependency.
- "Ruins in the old town" — TODOs older than six months.

Each quest is a prepared prompt; accepting opens it for editing, then
dispatches. This is where the strategy layer becomes concrete, and it is the
main reason to open the app when nothing is running.

### 5.6 Control contract

| Tier | Actions | Rule |
|---|---|---|
| **Free** | Read Herdr state, git, file tree; render | Read-only |
| **One keypress** | Dispatch a prompt | Editable box first, then typed into the real pane |
| **Explicit action** | commit, push, merge, revert, delete branch | Exact command shown. No batching. |

No autonomous dispatch in v1. No chains, no auto-retry.

**Phase 0.5a widens this by exactly two writes:** `workspace.create` and
`agent.start` (founding a settlement, and optionally starting an agent in it),
each gated behind a confirm sheet that shows the exact call before anything
runs — same "explicit action" discipline as the row above, not a new tier.
`pane.run`, `pane.send_text`, and all git writes remain forbidden.

**Phase 0.6 widens it by one more write, on the author's explicit
authorization** (2026-09-18, in his words: *"app can send to terminal, but
through us.. so yes sure"*). The app may submit a prompt to a running agent
using Herdr's first-class **`agent.prompt`**, plus the read-only
**`agent.read`** for showing what an agent has said.

The authorization is for prompts that travel *through the app's own UI*, and it
does not relax the principle it sits under — the user keeps full control:

- **Every prompt is composed and sent by the user.** The editable box in the
  "one keypress" row above is now literal: text appears in a box the user can
  read and change, and nothing leaves it without a deliberate send.
- **No autonomous dispatch, no chains, no auto-retry.** Unchanged from v1. The
  app never originates a prompt, never re-sends one, and never sends on the
  user's behalf in response to an agent's state.
- **The prompt is visible in the real terminal.** `agent.prompt` submits to the
  actual pane, so the terminal remains the source of truth and the app is
  never a hidden second channel (principle 3: the terminal is never hidden).
- **`pane.send_text` stays forbidden**, along with `pane.run` and every git
  write. `agent.prompt` is the sanctioned path because it is Herdr's own
  submission primitive, with defined submission semantics and state waiting,
  rather than raw keystroke injection into a terminal.

The permitted write surface is therefore exactly seven methods —
`workspace.create`, `agent.start`, `agent.prompt`, `agent.focus`,
`workspace.focus`, `pane.focus`, `notification.show` — plus the read-only
`agent.read`.

**Phase 0.7 widens it again, on the author's explicit request** (2026-09-19:
an interactive terminal). The app may run a real interactive
terminal against a pane, which requires **`pane.send_text`** and
**`pane.send_keys`** for input and **`pane.read`** for output. Those two writes
were forbidden by every earlier revision of this section; that prohibition is
lifted for this purpose and this purpose only.

This is the largest capability the app has, so the constraints are tighter
rather than looser:

- **Keystrokes travel only from a focused terminal surface.** The app must
  never synthesise input the user did not type. No macros, no replay, no
  auto-answering a prompt, no "helpfully" sending a newline. If the user did
  not press it, it is not sent.
- **The user can always see where their keys are going.** The terminal
  surface shows which pane and which repository it is attached to, and it is
  unambiguous when it holds keyboard focus — because the alternative is
  typing into an agent's session believing you are typing into the game.
- **No autonomous dispatch, still.** Unchanged since v1 and unchanged by this.
  The app originates nothing, retries nothing, and sends nothing in response
  to an agent's state.
- **`pane.run` stays forbidden**, along with every git write. Running a
  command *as the app* is a different act from the user typing one, and the
  earlier reasoning for that prohibition (§8: it returns no exit code and an
  agent pane would read it as a prompt) is untouched.

Note what this costs, honestly: principle 3 said "the terminal is never
hidden", meaning the app must never become a second, hidden channel to the
agent. An embedded terminal makes the app *a* terminal. That is acceptable
only because it is a true mirror — the same pane, the same session, the same
output, visible identically in the user's own terminal emulator at the same
time. The moment the app's terminal can show or do something the real one
cannot, that principle is broken and this capability should be withdrawn.

The permitted write surface is therefore nine methods, plus three reads:
`workspace.create`, `agent.start`, `agent.prompt`, `agent.focus`,
`workspace.focus`, `pane.focus`, `notification.show`, `pane.send_text`,
`pane.send_keys`, with read-only `agent.read`, `pane.read` and `agent.list`.

**`agent.list` widens nothing.** It is a Free-tier read — the same tier as
the `session.snapshot` subscription the app has always held — and it is
named here only because `agent.start` turned out to need it. herdr requires
agent NAMES to be globally unique and refuses a duplicate outright
(`agent_name_taken`); this app was passing the agent *kind* as the name, so
the first `claude` it ever started claimed that name for the whole herdr
session and every subsequent start failed, on both paths, leaving the
author with four workspaces he could not populate. A name is now derived
from the repository and checked against `agent.list` before it is used. The
lookup also runs when a confirm sheet opens, so the sheet can print the
actual name — still nothing running before the button, which is what that
tier means.

**`workspace.close` is still not on this list**, and that is what makes the
failure above recoverable rather than tidy. When `workspace.create`
succeeds and `agent.start` does not, the app says so — naming the
workspace, quoting herdr's own reason, and saying the workspace was left in
place deliberately. It does not delete what the user can see in order to
make its own error go away.

**Resuming a conversation** uses no new write. `agent.start` accepts trailing
agent arguments (`herdr agent start <name> --kind <kind> --pane <id> -- <args>`),
so resuming is starting the agent the user already uses with its own resume
flag — `claude --resume`, `codex resume`, and so on. The app must not invent
these flags: which flag an agent kind supports is knowledge about that tool, so
it belongs in configuration the user can correct, not hardcoded in a way that
silently does the wrong thing for an agent we guessed about.

**The terminal-feel amendment** (2026-09-20, on the author's report that the
terminal could not be scrolled or clicked, and needed to feel like iTerm2 or
Ghostty). This section says the app "must never synthesise input the user did
not type". That sentence was read, reasonably, as forbidding the app from ever
constructing a byte sequence — which left the embedded terminal unable to send
a PageUp, unable to paste, and unable to do anything at all with a wheel. The
line is drawn here instead:

> **Translating one real user gesture into the byte sequence a terminal
> emulator would send for that gesture is not synthesis — it is what a
> terminal emulator IS.** The prohibition exists to stop the app acting on
> its own: macros, replay, auto-answering prompts, retries, anything the
> user did not do. A keypress or a wheel tick is the user acting.

**Permitted under that reading**, each only from a surface that holds keyboard
focus, and each disclosed in the UI:

- **Escape sequences for keys herdr's `send_keys` has no word for.** herdr
  rejects `pageup`, `pagedown`, `home`, `end`, `delete` and `insert` outright
  (§8.4 of the followups), so those six keys did nothing but produce an error.
  They now travel through `pane.send_text` as the sequences this machine's own
  `infocmp xterm-256color` declares — `\e[5~`, `\e[6~`, `\eOH`, `\eOF`,
  `\e[3~`, `\e[2~` — because herdr launches panes with `TERM=xterm-256color`.
  `pane.send_text` was verified to carry the real ESC byte rather than
  literalising it (a pane running `cat -v` echoed `^[[5~`), and each sequence
  was verified to do its job against `less` and zsh. Only the UNMODIFIED press
  is translated; ctrl+Home and friends still go to herdr and still come back
  as herdr's own honest "unsupported key", because xterm's modifier encoding
  is a guess this app does not make.
- **The mouse wheel, translated to the scroll key the program expects**, one
  gesture to one translation, capped and never repeated beyond what the user
  did. This is what iTerm2 and Ghostty do in alternate-screen mode. It applies
  only when the pane has no scrollback to show; when it has, the app shows the
  real thing instead.
- **Paste** (⌘V → the system clipboard → `pane.send_text`), which needs one
  genuinely new capability: **the app may read the system clipboard**, from
  the terminal's own keydown handler and nowhere else. Never on mount, never
  on a timer, never in response to an agent's state. The read and the send
  stay two separately audited steps.
- **Copy and select-all** (⌘C, ⌘A), which are pure DOM and touch herdr not at
  all — and which required *removing* something: ⌘C, ⌘V and ⌘A used to be
  forwarded to the pane as `meta+c`/`meta+v`/`meta+a`, which herdr accepts
  without complaint. On macOS no terminal emulator forwards ⌘ to the pty, so
  that was the mirror being wrong, not the fix. Those three chords now have
  no path to a pane at all, proved mechanically in `terminalKeys.test.ts`.
  Every other ⌘ chord is unchanged.

**Still forbidden, unchanged:**

- **Mouse-position escape sequences** (DECSET 1000/1002/1006 click reporting).
  They are mode-dependent: if the foreground program has not enabled mouse
  reporting, the bytes land as garbage in the user's input line, and the app
  cannot know which mode the program is in. A click therefore still does
  nothing to the program, and the terminal's footer says so.
- **Anything the user did not initiate.** No auto-scroll-to-bottom that fights
  them, no synthesised Enter, no retries. The scrollback view is left exactly
  where the reader put it until the reader moves it.
- `pane.run`, `workspace.close`, and every git write.

**What this costs, honestly.** Three things.

First, the wheel translation can be *inert*. The key chosen is PageUp rather
than the arrow keys iTerm2 defaults to, because arrows were measured doing the
wrong thing: sent to a live `claude` pane, ↑ opened its history and put a
previous message into the prompt box, while PageUp did nothing at all. A
gesture that means "scroll" must not rewrite what the user was about to send,
so the app prefers a key that is ignored to one that is misunderstood — and
says out loud that it may be ignored, rather than looking broken.

Second, reading the clipboard is a real widening of what the app can see. It
is bounded to one gesture and one call site, and it is on this list so that it
is auditable rather than incidental.

Third, the scrollback view **pauses the live mirror** while it is up, and
therefore stops being a mirror for as long as it is open. That is stated in
amber across the top of the terminal the entire time, because a terminal that
has quietly stopped updating looks exactly like an agent that has quietly
stopped working, and telling those two apart is the whole product. Any
keystroke, or scrolling back to the bottom, returns it to live.

The permitted write surface is unchanged at nine herdr methods; the reads are
now `agent.read`, `pane.read` (in both its `visible` and `recent` sources) and
`agent.list`, plus the system clipboard.

**The town amendment** (2026-09-20, on the author's report that opening a
town showed only the town: no terminal, nothing to act with). The
terminal surface, the agent switcher, the prompt box and "start an agent" now
exist over a **town** as well as over the sea. **This widens nothing.** It is
the same `Terminal` component, the same `pane.read`/`pane.send_text`/
`pane.send_keys`, the same focus boundary, and the same shared start-agent
flow — reached from a second screen. No herdr method is added, and the
conditions above bind identically:

- **The surface still says which pane and which repository it is attached
  to**, which matters more here, not less: the switcher can move a town's
  terminal to an agent in a *different* repository, and when it does, the
  header and the tab strip name that repository while the town behind the
  dialog is still the one you opened. The terminal's own attachment line is
  the authority on where the keyboard is pointed, and it is never hidden.
- **Escape is resolved by depth, not by precedence:** with the pane surface
  focused it goes to the agent and nowhere else; with the terminal open but
  the surface unfocused it closes the terminal only; then it closes the
  villager panel; then it leaves the town. Each step is one press, and no
  press ever does two of them.
- **What a click on a villager does changed, and that is the point.** It used
  to call `pane.focus`, which raises the user's own terminal and ejects them
  from the app. `pane.focus` remains permitted and remains offered — as a
  button that says it leaves the app — but it is no longer what the most
  natural gesture in the product silently does.

**The sea/town consistency amendment** (2026-09-21). The paragraph above was
implemented for a **town** only, which left the same gesture meaning two
different things on two screens: a click on a villager in the **sea** still
called `pane.focus` and still ejected the user from the app. It now does
what a town does — opens that agent's terminal, in the app, from the same
`Terminal`, the same attachment state, the same switcher and the same focus
boundary. **This widens nothing:** no herdr method is added or removed, and
every condition in this section binds identically on both screens.

Two consequences worth recording here rather than only in a commit:

- **`pane.focus` is now one button, in one place, on both screens** — the
  agent's own panel, with one label ("Focus external terminal ↗") and one
  tooltip that says it leaves the app. It used to exist twice: as a town
  button and as the sea's silent click. The island-level `workspace.focus`
  keeps its own, distinct wording, because it is a different call with a
  different scope and a shared label would have made one of the two a lie.
- **Escape is resolved by depth on both screens, not by precedence** — with
  the pane surface focused it goes to the agent and nowhere else; then it
  closes the terminal only; then the panel; then (in a town) it leaves the
  town. One press, one step, verified in a real browser on both screens.

### 5.7 Scaffolding: exact semantics

Scaffolding marks work not yet verified. Because one test run verifies a whole
repo, scaffolding is tracked per **change set**, not per building; buildings
touched by an unverified change set wear it.

- **Human edits count as unverified too.** The watcher cannot distinguish them,
  and pretending otherwise would be dishonest. Uncommitted work is unverified
  work, whoever wrote it.
- **On first install**, an already-dirty repo shows scaffolding with an
  explanatory first-run note, not as an accusation.
- **Walls are presence of tests mapped to paths**, which is an approximation,
  and the UI says so rather than claiming coverage.

## 6. The quiet game (no agents running)

Explicitly rejected: minigames, farming, tapping, or any loop that fills time
without producing something real.

1. **Zoning and decoration** (§5.2).
2. **Restoring ruins.** Dormant projects surface as overgrown towns; one click
   adopts one as a restoration project.
3. **The Chronicle.** Replay a project's git history as a time-lapse of the
   city building itself. Exports as video — the outward-facing artifact, and
   the audience that makes cosmetics worth earning.
4. **The Chronicle Hall.** Empire statistics, monuments, agent histories.
5. **Planning tomorrow.** Pin quests in order; nothing dispatches until the
   user presses go.

**While away:** changes made outside the app replay as news on next open.
Closing the app is never punished.

## 7. Progression and economy

### 7.1 Two tracks

- **The city** reflects reality and moves both ways.
- **The ruler** only moves up. Levels, ages, unlocks and monuments are
  permanent.

### 7.2 Resources

Resources never gate real work; they buy vanity only (decoration, monuments,
district styles, banners, agent titles).

| Resource | Earned from |
|---|---|
| **Stone** | Verified work: tests pass, scaffolding cleared |
| **Gold** | Shipped work: releases, tags, merges into the trunk from a branch |

Timber is **cut** — a currency that buys nothing is noise.

For trunk-based solo work where every commit lands on main, gold comes from
tags and releases rather than merges, so it stays rare.

### 7.3 Ages (per town, permanent once reached)

All milestones are detectable locally, from filesystem and git alone.

| Age | Local signal |
|---|---|
| Settlement | git history non-empty |
| Village | roughly 10+ commits |
| Town | test files present **and** at least one locally verified green run |
| City | a semver tag, a release, or a detected deploy config plus a tag |
| Capital | 6+ months of history, active in the last 60 days, no outstanding scaffolding |

CI config presence is a *bonus signal*, never a requirement — many real
projects have none.

### 7.4 Achievements

- **Clear Skies** — a week with no scaffolding in a town.
- **The Restorer** — bring a dormant project back to green.
- **Stonemason** — 100 buildings verified by tests.
- **The Great Demolition** — delete 1,000 lines net, excluding test files.

Nothing rewards speed, volume, or tokens.

### 7.5 Agents as characters

Agents keep a name and earn a cosmetic title from what they did. Identity is
stored in the app's own registry keyed by Herdr session identity, because
Herdr's pane names do not survive a closed pane. Per-file attribution is
approximate and the UI must not overclaim it.

## 8. Technical design

### 8.1 Stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 (Rust core, web frontend) |
| Rendering | Three.js via react-three-fiber, `frameloop="demand"` |
| Terminal (later phases) | xterm.js over a PTY running `herdr terminal attach` |
| Git | gix / libgit2 |
| Assets | Kenney low-poly kits initially |

### 8.2 Repos, worktrees and branches

Running several agents on one repo means **git worktrees**, and Herdr has a
first-class `worktree.*` API (`worktree.create/open/list/remove`, plus
`worktree.created/opened/removed` events).

- **One island per repository**, not per checkout.
- Worktrees are **encampments** on that island: visible, attributed, each with
  its own branch and its own scaffolding.
- The town's committed state renders from the primary checkout's HEAD.
- Accept always states the branch it will act on.
- When two panes share a cwd, edits are attributed to the encampment, not
  guessed per agent.

### 8.3 Herdr integration

Socket path resolution must follow Herdr's own order: `--session` →
`HERDR_SOCKET_PATH` → `HERDR_SESSION` → default `~/.config/herdr/herdr.sock`
(named sessions live under `~/.config/herdr/sessions/<name>/herdr.sock`).
Newline-delimited JSON.

| Need | Mechanism | Gotcha |
|---|---|---|
| Full state at startup | `herdr api snapshot` / `session.snapshot` | — |
| Live agent state | `events.subscribe` on `pane.agent_status_changed`, plus `pane.agent_detected`, `pane.exited`, `workspace.*`, `worktree.*` | Detection is heuristic (§9) |
| Dispatch a prompt | `pane.send_text` / `agent.prompt` | Avoids the `terminal attach` bracketed-paste defect |
| Found a town | `workspace.create --cwd` | — |
| Jump to an agent | `agent.focus` / `workspace.focus` | — |
| Read output | `pane.read` | Returns `agent_not_idle` on alternate-screen reads while working or blocked — cannot be relied on as a live view |
| Wait | prefer `events.subscribe` | `agent.wait` timeout is clamped to ≤300s |
| **Run tests** | **Tauri core spawns the command itself** | **Never `pane.run` into an agent pane — the agent would receive it as a prompt, and `pane.run` returns no exit code** |

At startup, check `herdr api schema --json` for version drift rather than
discovering it at runtime. All of this sits behind one adapter module, which
also leaves room for a plain-tmux backend later.

**Prior art to review before building the terminal-embedding phase:**
`missuo/herdrm`, a native macOS Herdr console using `herdr terminal attach`.

### 8.4 State flow

Three read sources feed one world-state reducer: Herdr socket (agent state),
git (history, diffs, branches), file watcher (live edits). The renderer draws
world state and never talks to Herdr, so it is testable without a running
agent.

### 8.5 Performance

- `frameloop="demand"`: render on state change, not continuously. This runs
  beside four agents on a laptop all day.
- Instanced meshes; archipelago uses low-detail proxies; only the focused town
  renders in full.
- Layout and history scans are cached per repo and updated incrementally.
- First launch generates lazily with visible progress.

## 9. Risks

Ranked, after review:

1. **Generation quality.** If generated cities look like scatter plots, the
   product fails. Mitigated by Phase 0.5 iterating on real repos before
   anything is built on top.
2. **Herdr detection churn.** `blocked`/`done` come from screen-pattern
   matching that breaks when agent UIs change. Mitigated by collapsing to one
   attention state (§5.4) and by measuring false negatives during Phase 0.
3. **Is the loop used on day five?** The only real test is a playtest (§12).
4. **Terminal embedding.** Deferred entirely until a later phase; Phase 0 uses
   `agent.focus` into the user's existing terminal, so this risk is not taken
   on early. Includes an untested dual-attach question (two clients on one
   pane, differing sizes).
5. **Herdr API churn.** Pre-1.0, single maintainer. Mitigated by the adapter.
6. **Rendering scale.** 30 repos, thousands of files. Mitigated in §8.5.

## 10. Build order

**Phase 0 — Thin cockpit (about a week).** Tauri window; reads `api snapshot`;
subscribes to `pane.agent_status_changed`; one island (or simple shape) per
workspace cwd; hotkey cuts to the next stopped agent and calls `agent.focus`,
raising the user's existing Herdr terminal. **No embedded terminal, no
generator.** Tests the daily-use thesis and measures detection reliability.

**Phase 0.5 — The generator.** Static city from one repo, iterated against real
repos until it looks good. No history, no time-lapse.

**Phase 1 — The game.** Archipelago of all projects, drag-to-assign dispatch,
the Keep with diff viewer and Accept / Verify / Continue / Raze, quest board,
scaffolding, threats, zoning.

**Phase 2 — Depth.** Chronicle time-lapse and video export, restoration,
resources, ages, monuments, Chronicle Hall, embedded terminal if Phase 0 proves
window-switching is the bottleneck.

**Phase 3 — Outward.** Cosmetics, cloud sync, mobile notifications, teams.

## 11. Out of scope for v1

Leaderboards, leagues, visiting other players' cities, purchasable cosmetics,
team kingdoms, and any backend.

## 12. Open items to resolve during implementation

- **Desktop notifications** in Phase 0/1 — the real answer to "which one needs
  me" when the app isn't focused. Must not be worse than Herdr's own.
- **Degraded mode when Herdr isn't running**, and when no agents exist.
- **Monorepos and submodules** — one island or many?
- **Commit authorship** on Accept: message source and branch.
- **Renames** — `git log --follow` is expensive across 30 repos; decide how
  much history fidelity is worth.
- **Playtest plan** — five developers, one week, one question: "did you open
  it on day five, and why?" For a game, this is the acceptance test.

## 13. Review history

**Rev 2 (2026-09-16)** after external design review. Accepted: no diff viewer
(critical), `pane.run` misuse for tests (critical), heuristic `blocked`
detection, missing worktree model, determinism/caching contradiction,
hash-spiral layout quality, scaffolding semantics, timber deletion, phase
inversion vs. stated top risk, `frameloop`, socket session resolution,
`agent.wait` clamp, `pane.read` alternate-screen limits, prior art.

Rejected: that a currency only the player can see is exploitable in a
single-player offline game; that the product is redundant with Herdr's sidebar
(the strategy and quiet-mode layers are not in Herdr); that player-placed
buildings are the only route to agency (allocation is the stronger verb, and
zoning provides expression without dishonesty).
