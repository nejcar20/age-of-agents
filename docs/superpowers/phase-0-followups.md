# Phase 0 / 0.5a — follow-ups and open questions

> **Phase 0.5a (founding) is recorded in §5 at the end of this file.** Everything
> above it is Phase 0 and still stands unless noted.

# Phase 0 — follow-ups and open questions

**Date:** 2026-09-17
**Branch:** `phase-0-thin-cockpit` (22 implementation commits + 1 final fix wave)
**State:** 78 Rust tests + 5 ignored live tests, 10 frontend tests, `tsc` and `clippy` clean.

Phase 0 is the thin cockpit described in
`specs/2026-09-16-age-of-agents-design.md` §10. It exists to answer one question:
**does the user reach for this window instead of cycling terminal tabs?**

This file records what a reviewer flagged and we deliberately did not fix, and what
only a human can check. It replaces the throwaway run ledger.

## 1. Things only a human can verify

These blocked no task; no subagent can settle them.

1. **Does a notification banner actually appear?** *(Updated 2026-09-19, first
   release build.)* Confirmed at the source level, not guessed: `tauri-plugin-
   notification` 2.4.0's macOS `show()` (`desktop.rs`) literally does
   ```rust
   let _ = notify_rust::set_application(if tauri::is_dev() {
       "com.apple.Terminal"
   } else {
       &self.identifier
   });
   ```
   so dev mode really does hardcode `com.apple.Terminal` — that part of this
   note was correct, not speculation. A release build (`tauri::is_dev() ==
   false`) instead poses as this app's own bundle identifier, which is now
   `dev.ageofagents.cockpit` (renamed from `dev.ageofagents.app`, which
   `tauri build` itself warned ends with `.app` and "conflicts with the
   application bundle extension on macOS" — fixed in the same pass as this
   finding, before anyone had relied on the old identity).

   `npm run tauri build` now succeeds (see the README's "Building a release"
   section) and produces a real, ad-hoc-signed `Age of Agents.app`. Building it
   registered `dev.ageofagents.cockpit` with macOS Launch Services
   (`lsregister -dump` lists it), which the old identity never was.

   What was actually exercised, without touching the author's live herdr
   session or `~/.age-of-agents/` data: a standalone harness binary (not part
   of this repo) reproduced the plugin's exact macOS call sequence —
   `notify_rust::set_application("dev.ageofagents.cockpit")` then
   `Notification::show()` — outside of any herdr connection. Both calls
   returned `Ok(())`. That proves the code path runs clean under the new
   identity; it does **not** prove a banner rendered on screen — `show()`
   returning `Ok` is exactly as uninformative as the original note said,
   whether authorization is granted or denied. Confirming the banner requires
   either eyes on the screen at the moment it fires, or Full Disk Access to
   read `~/Library/Group Containers/group.com.apple.usernoted/db2/db` (both
   attempts to query that database from this session were refused by macOS
   with "authorization denied" — no shortcut around a human here).

   **What you need to click:** launch the real app once — open
   `src-tauri/target/release/bundle/macos/Age of Agents.app` (or a fresh
   `npm run tauri build` after this identifier change), then check **System
   Settings → Notifications → Age of Agents**. If it is not listed yet, launch
   it once more with a real agent running so a `Stopped` transition actually
   fires `show()` — that first delivery is what causes macOS to create the
   entry. Make sure "Allow Notifications" is on. Everything upstream of that
   toggle is now verified; the toggle itself only a human can flip.
2. **Does anything in your setup ever emit `agent_status: "done"`?** `herdr pane
   report-agent --state` accepts only `idle|working|blocked|unknown`; `done` exists
   only in the JSON schema. This is why the Stopped promotion is history-aware
   (`working|blocked → idle` counts as stopped). If your agent integration does emit
   `done`, the promotion still works, but the evidence in `transitions.jsonl` will
   look different.
3. **Does `blocked` fire reliably for the agents you actually run?** This is spec
   risk #2 and the reason `~/.age-of-agents/transitions.jsonl` exists. After a week,
   count how often a pane went `working → idle` versus `working → blocked`.
4. **The hotkey is window-scoped, not a global shortcut.** It listens on the app
   window, so reaching it means focusing Age of Agents first — arguably the
   tab-switching this phase exists to replace. Decide whether that biases the
   week-long trial before you start it; a global shortcut is a small change.
5. **Does raising iTerm actually surface the right window to a human?**
   `agent.focus` was verified at protocol level (`focused_pane_id` really moves), but
   whether the correct iTerm window/tab comes forward was never seen by anyone.
6. **`foreground_cwd` semantics.** Island resolution prefers `foreground_cwd` over
   `cwd`. If Herdr reports a transient child's cwd (a pager, a `cd /tmp` subshell),
   an island could silently move or vanish mid-session. Never probed.

## 2. Fix before the week-long evidence run

Small, and all about not poisoning the evidence or the diagnostics.

- **Wrong-pane jump inside a multi-idle island.** `jump_target` picks the first
  `Idle` agent in snapshot order. An island can hold a promoted idle pane next to a
  never-worked first-sight idle pane; if the never-worked one sorts first, the jump
  lands on the right repo but the wrong terminal. Strictly better than the previous
  behavior (which could focus a still-working pane). The clean fix is to carry
  per-agent attention through `WorldState` instead of recomputing a guess.

## 3. Deliberately deferred

Each was raised by a reviewer, judged, and left. None is load-bearing for Phase 0.

**Structure**
- `world/attention.rs` now does three jobs (island grouping, jump ordering,
  notification bookkeeping) and no longer matches its filename. `herdr/events.rs` is
  ~1500 lines including tests — the largest file in the tree.
- Package name is still the scaffolder's `tauri-app` in `package.json` and
  `Cargo.toml`; `productName` is correct. `README.md` is still scaffolder boilerplate.
- `tauri.conf.json` sets `"csp": null`. (The `opener` plugin, previously granted but
  unused, was registered and put to work in the town view's interaction pass —
  `BuildingPanel`'s "Open file" button calls `openPath` directly; see
  `interaction-report.md`.)

**Behavior**
- Each re-subscribe triggers Herdr's ~39-event backlog replay, and each replayed
  world-changing event does its own sequential snapshot. Measured at ~116ms for 40
  snapshots, so it was left alone; revisit only if profiling says so.
- A pane Herdr permanently rejects would flap globals-only ↔ per-pane at roughly the
  1s backoff floor. The only known trigger is a snapshot→subscribe race that resolves
  in one cycle. Cheap fix if it bites: parse the offending pane id out of
  `pane_not_found` and exclude just that one.
- Editing `config.json` needs an app restart (config is read once at startup, and
  nothing in the app ever writes it).
- A first-sight `done` records as not-stopped, so a pane whose very first observation
  is `done` and then reports `idle` would drop from ❗ to `·`. Unreachable while
  nothing emits `done`.
- A pane id reused after a close that no snapshot observed (close+create collapsed
  into one `Lagged` resync) would inherit a stale sticky-stopped flag. Requires Herdr
  to recycle pane ids; not observed.

**Tests**
- `FakeHerdr` still does not model: the backlog replay Herdr sends on every subscribe,
  a delivery arriving between subscribe and ack, an `agent_status` change within one
  connection's snapshot sequence, or `foreground_cwd`. Its permissive
  many-requests-per-connection constructor also still exists and is used by the client
  tests — that permissiveness hid a real design bug twice.
- No test covers `IslandGrid`'s disconnected branch (type-checked only).
- `RealGit::run` returns un-normalized paths; normalization is centralized in
  `compute()`. Fine today, a trap for a future direct caller.
- Smaller: telemetry mutex `.unwrap()` could poison on a future panic; the
  last-known-status map never evicts closed panes; protocol `19` is hardcoded rather
  than a shared constant.

## 4. Three plan defects found by live probing

Recorded because the lesson generalizes: **every one of these passed a green test
suite, and only contact with the real Herdr exposed them.**

1. **One request per connection.** The plan assumed a single connection could carry
   the event subscription and repeated snapshot calls. Herdr closes a connection after
   one request, except `events.subscribe`, which then streams. The loop subscribed,
   tried to snapshot on the same connection, and never produced a world — the app
   wired up perfectly and displayed nothing. Fixed: the subscription owns a connection
   used for nothing else; every call opens a fresh one.
2. **Status changes need per-pane subscriptions.** The global subscription never
   delivers `working → blocked` or `blocked → done`; only a per-pane
   `pane.agent_status_changed` subscription does. The app would have lit up when an
   agent started working and then gone silent at exactly the moment the user was
   needed. Fixed: per-pane subscriptions, re-subscribed when the pane set changes.
3. **`idle` is where finished agents land.** The spec said `blocked`, `done` and
   idle-after-work all mean "stopped"; the plan contradicted itself and the code
   implemented only the first two — and nothing can actually emit `done`. A finishing
   agent rendered as a calm `·` forever. Fixed: history-aware sticky promotion.

The corresponding lesson for later phases: the fake server was twice too forgiving,
and each time a green suite shipped a design the real server rejects. Prefer a fake
that is stricter than reality, and probe the real thing before trusting an assumption
about it.

---

## 5. Phase 0.5a — Founding a settlement

The app can now create a Herdr workspace and start an agent for a repo that has none,
so Herdr is no longer something you must adopt and drive by hand first. Repos you
have not settled appear as a list; founding one is gated behind a confirm sheet that
names the exact `workspace.create` and `agent.start` calls.

**Permitted Herdr writes widened from four methods to six** — `workspace.create` and
`agent.start` joined `agent.focus`, `workspace.focus`, `pane.focus` and
`notification.show`. `pane.run`, `pane.send_text` and every git write remain
forbidden; the final review verified the production method surface is exactly those
six. The spec's §5.6 control contract records this.

### Fix before daily use

- **No rescan while the app runs.** The unsettled list is fetched once on mount and
  the component only remounts when Herdr disconnects, so a repo cloned while the app
  is open never appears until you reconnect or restart. `browse…` still reaches any
  path if you know it. The fix is a refetch on window focus or a visible rescan
  button — deliberately *not* the per-event refetch that was removed, which caused
  ~279 filesystem scans in 15 seconds.
- Phase 0's wrong-pane jump (§2 above) matters more now, because founding creates
  more multi-pane islands.

### Deliberately parked

- A pane whose foreground process leaves every repo (`cd /tmp`) drops out of the
  world, so the duplicate-founding guard degrades to "don't know" for as long as that
  shell sits outside. Self-healing on `cd` back; documented in the code.
- A short window right after a successful founding where the row is still shown.
  Bounded by one Herdr round-trip plus the 150ms resubscribe throttle, and the
  backend guard refuses before a second confirm could realistically land.
- The at-or-inside path rule is implemented twice, in Rust and TypeScript — inherent
  to Rust owning canonicalization while the frontend does the subtraction. Both are
  tested and cross-referenced, and a reviewer checked them against 13 adversarial
  cases (`/p/repo-backup` vs `/p/repo`, `//`, macOS case) with no reachable
  disagreement. Worth a shared fixture table asserted on both sides, because the
  dangerous direction — TypeScript stricter than Rust, silently making a repo
  unfoundable — is the same class as the worktree bug below.
- `found_settlement`'s guard-before-create *ordering* is structurally visible but not
  asserted by a test.

### The fourth plan defect: worktrees

Two individually correct decisions produced a bug where they met. Phase 0 collapses a
worktree's pane onto its main repo (one island per repository — right). Phase 0.5a
listed anything containing `.git` as foundable, and a worktree's `.git` is a file that
exists (also right). Together: founding a worktree made the **wrong** row disappear —
the main repo, which had no workspace, became unfoundable — while the worktree stayed
listed, and after a restart the guard could not see it either, so the same worktree
could be founded twice.

The root cause was that "settled" was derived from where panes *resolve to* rather
than where workspaces were *founded*. The fix derives it from each pane's own
canonical cwd, which also deleted `foundedPaths`, a 300ms debounce, an optimistic
removal and a stale-fetch race — three earlier patches replaced by one correct
design. Worth remembering when the city generator lands: worktrees will need a
deliberate answer there too.

---

## 6. Phase 0.5b — The first island (in progress)

Rescan-on-focus, per-agent attention carried through `WorldState`, and the city
generator: a repository becomes a `CityModel` (districts from directories,
buildings from files, height bucketed from line count), laid out by a
shelf-packing algorithm whose result is cached per repo at
`~/.age-of-agents/towns/<repo-hash>.json` so a city never reshuffles.

This section is written while the phase is still open, because the items below
were found during it and would otherwise live only in the run ledger — which is
git-ignored scratch that gets deleted when the phase's final review passes.

### Carried forward, NOT fixed in this phase

- **`RealGit::run` is bounded but still synchronous on the event-loop task.**
  The final review's fix gave it a 10s timeout, closing the "hangs forever"
  hazard, but it still blocks the tokio task that owns the Herdr event loop for
  up to that ceiling. `RepoResolver` memoization limits how often that is paid.
  Moving it to `spawn_blocking` is the complete fix.
- **Two districts can share one cache identity, and that is the only way
  found to break the no-overlap invariant.** A real directory literally named
  `foo#2` sitting beside a `foo` that splits into three-or-more sub-plots
  produces two districts with the same numbered path/cache key; `layout.rs`
  reads `cache.plots` rather than the live map, so both reuse the same cached
  plot and overlap exactly. Contrived, but it is the sole remaining route to
  an overlap — the final review confirmed zero overlaps across all 465 plots
  in the four real cache files on this machine. (Updated by the split-
  boundary cache-key fix below: `#1` no longer collides this way — a real
  `foo#1` now keys on its own path, distinct from `foo`'s slot 1, which keys
  on the pre-split `foo` itself — but `#2`, `#3`, … still key on their own
  numbered path exactly as `path` reads, so the collision risk described
  here is unchanged for every slot past the first.)
- **The layout cache never evicts.** A district that is deleted or renamed keeps
  its plot forever, by design, so a returning district reclaims its place. The
  cost is that the cache grows monotonically and the reported land area inflates:
  `dist-townshot` is still a plot in the live AgeOfAgents cache even though this
  phase gitignored it.
- **`read_to_string` runs before the 50k-line check**, so a checked-in 200MB
  text dump is fully loaded into memory and then discarded.

- **`RealGit::run` still returns un-normalized paths** (carried from Phase 0
  §3). `world::repo::normalize_path` is the only canonicalization path in the
  codebase and inconsistent path representations caused three separate bugs this
  phase; a future direct caller of `run` will make it four.

- **`GRID_PITCH` in `src/city.ts` is a hand-copied mirror of `city::layout`'s
  `SPACING`, and nothing enforces that they agree.** It exists so
  `worstCaseGap` can be closed-form and testable in TypeScript. The test built
  on it guarantees that two adjacent buildings' walls and roofs keep ≥ 0.2
  world units of clearance even with every jitter component at its ceiling —
  but that guarantee is computed against the *duplicated* pitch, so changing
  `SPACING` on the Rust side silently makes the TypeScript claim false while
  the test still passes green. This matters immediately, because letting
  buildings abut (below) is precisely a `SPACING` change. The durable fix is to
  carry the pitch in `CityView` from Rust rather than restating it, so it
  cannot drift.

### Fixed since this section was first written

- **§4.2's "adding a file moves nothing" was overstated, and its guarding
  test only exercised the case that already worked.** `layout.rs` used to
  sort a district's buildings by path and key `gnomon_position` off the
  *sorted index*, so inserting a file that did not sort last moved every
  building after it: with `src/{b.rs,c.rs}` at gnomon cells `0,1`, adding
  `a.rs` used to bump both of them to `1,2`. The guarding test added `c.rs`,
  which sorts last — so it passed while the module doc claimed the property
  held "for every transition". **Fixed:** `LayoutCache` now also remembers
  each district's `path -> cell index` map (`cells`, alongside `plots`), so a
  file's cell is resolved once, by its own path, and never re-derived from
  its position in a sorted list. A new file takes its district's lowest
  currently-unoccupied cell (the literal "next free plot"); a deleted file's
  cell is released immediately, not held forever the way a district's whole
  `Plot` is — renaming a file (a delete plus an add, since the path is the
  only identity available) is common enough in an actively-edited directory
  that holding every vacated cell forever would grow that directory's
  footprint without bound even while its file count stayed flat. `layout.rs`
  §"Fix round 4" has the full design and the "release immediately, not held
  forever" reasoning; `LAYOUT_CACHE_VERSION` bumped 3 -> 4 since the on-disk
  shape gained this field. Verified against the concrete `b.rs`/`c.rs`/`a.rs`
  example above, end to end, on a throwaway repo: `b.rs` and `c.rs` render at
  byte-identical SVG coordinates before and after `a.rs` is added, and the
  persisted cache shows `a.rs` alone taking a new cell index.

- **Crossing the 40-file split boundary orphaned a cache entry — the single
  largest remaining city-stability hole once plot overlap was fixed.** A
  directory growing past the split threshold is renamed `dir` →
  `dir#1`/`dir#2` by `model::split_into_plots`. The cache used to be keyed by
  district *path*, so neither new name matched the cached entry for `dir`,
  and the whole directory jumped to the packing frontier — usually to the far
  edge of the city, and usually a directory under active development, which
  is the one the user is most likely to be looking at. **Fixed:** `District`
  gained a `cache_key`, separate from its display `path`, that
  `split_into_plots` computes directly: slot 1 (whichever of the bare `dir`
  or the split `dir#1` currently represents the directory's first
  40-or-fewer files — the two never coexist) always gets the SAME key the
  bare directory has always used, so `city::layout`'s `plots`/`cells` maps
  see a cache HIT, not a new district, the instant a directory crosses the
  threshold in either direction. Slot 2 and beyond key on their own numbered
  name, same as `path`, since that content is genuinely new the first time
  it appears. `layout.rs` §"Fix round 5" has the full design reasoning
  (including why a single-row-packed, isolated-directory property test is
  the only way to make "never moves" a *provable* invariant rather than a
  usually-true one); `LAYOUT_CACHE_VERSION` bumped 4 -> 5 since a pre-fix
  cache's `dir#1`/`dir#2`-keyed entries are no longer the keys this version
  looks up.
  **The per-building `cells` map — fix round 4's own stable-cell
  mechanism — had the identical bug, unnoticed until this round:** it was
  ALSO keyed by district path, so a building's carefully preserved cell was
  abandoned at the exact same crossing that orphaned the plot, silently
  re-deriving every cell from scratch (harmless-looking in a screenshot,
  since the newly-fixed plot is already correctly sized and positioned, but
  exactly the "not wrong, just not remembered" regression round 4 exists to
  prevent). One `cache_key` fixes both, since both maps share the same
  aliasing rule.
  Verified end to end on a real repository (a temp copy of `jiri-kocica`,
  never the read-only original): `components/ui` at 39 files laid out with
  plot `{x:5, z:8, w:9, d:8}`; after adding 2 files (41 total, splitting into
  `components/ui#1` (40) + `components/ui#2` (1)), `components/ui#1`'s plot
  was byte-identical, `{x:5, z:8, w:9, d:8}`, and `components/ui#2` took a
  fresh, non-overlapping plot at `{x:4, z:20, w:4, d:3}` — see
  `.superpowers/sdd/2026-09-17-phase-0-5b-first-island/split-stability-report.md`
  for the full before/after numbers and test summary.

- **`split_into_plots` chunked a directory's buildings by POSITIONAL
  insertion order, not by a stable per-file identity — the instability the
  split-boundary cache-key fix above found but deliberately did not fix.**
  A split directory's numbered sub-plots (`dir#1`, `dir#2`, …) were
  `buildings.chunks(40)` over whatever order `FileSource::files` happened
  to report that call. For `RealFiles` that order is `git ls-files`'s own
  sorted-by-path order, so adding a file that sorts into the MIDDLE of an
  already-split directory (not appended at the end) shifted every chunk
  boundary after it: a file that was building #40 in `dir#1` could be
  bumped into `dir#2` even though its own path never changed — and because
  `dir#1`/`dir#2` are different districts with different plots (the
  cache-key fix above only makes each SLOT's plot stable, not WHICH slot a
  file lands in), that bump was a teleport across the whole city, not a
  one-cell shift. **Fixed:** `model::split_into_plots` now resolves every
  file in a directory to a stable, persisted global index
  (`model::resolve_split_indices`, the same "keep it if present, else
  lowest free, release immediately" policy `city::layout::resolve_cells`
  already uses for a building's cell) BEFORE deciding slots; a file's slot
  is simply `index / MAX_BUILDINGS_PER_DISTRICT`, so it changes only when
  the file's own index changes — i.e. only when the file itself is added
  or removed. `city::layout::LayoutCache` gained a `split_membership` field
  (directory path -> file path -> index) to persist this alongside `cells`;
  `LAYOUT_CACHE_VERSION` bumped 5 -> 6. A new real entry point,
  `layout_city_persisted_from_root`, loads this cache BEFORE building the
  model (the old `build_city` + `layout_city_persisted` pair built the
  model first, which had already fixed each file's slot positionally by
  the time any cache was consulted — a `CityModel`'s directories are fixed
  `District` entries the instant `build_city` returns, and nothing
  downstream can move a building from one to another after the fact); every
  production caller (`city_for`, the archipelago's `describe_city`,
  `city_fixture`, `city_preview`) now calls it instead. How the two fixes
  compose: `split_membership` decides, per file, which numbered slot it
  belongs to; `cache_key` (the round above) then decides, per slot, which
  persisted `Plot`/`cells` entry that slot reuses — independent and
  stacked, with membership resolved before any `District` (and therefore
  any `cache_key`) exists.
  Verified end to end on a real repository (a fresh temp copy of
  `jiri-kocica`, never the read-only original): `components/ui` grown to 41
  files (`components/ui#1` at 40, `components/ui#2` at 1); adding one more
  file, `0-early.tsx`, which sorts before all 41 existing files, left every
  one of those 41 buildings' district, cache key, plot, and absolute
  position byte-identical, with only `0-early.tsx` itself landing in
  `components/ui#2` (the slot with room) — see
  `.superpowers/sdd/2026-09-17-phase-0-5b-first-island/chunk-stability-report.md`
  for the full before/after numbers and test summary.

### The town view, and what is deliberately still open

The 3D town reads as an island town rather than a site plan: real height gives
it a skyline, `road_edges` are drawn as paved streets, walled test districts get
brick walls, and the land sits in water. Two things are knowingly unfinished,
both deferred to a Phase 0.6 proposal so a human can judge them from renders
rather than from a description:

1. **Plot interiors read sparse.** `SPACING = 2` puts an empty cell between
   every pair of buildings, so a district reads as detached objects rather than
   as a block. Letting buildings abut is honest — where a building sits is still
   a deterministic function of the code, and the honesty rule forbids
   fabricating content, not choosing a pitch — but it reshapes every existing
   city, interacts with the 40-building split and the growth headroom, and is a
   look-and-feel decision. See the `GRID_PITCH` note above before touching it.
2. **Same-kind neighbours share one colour,** so with tight gaps their
   silhouettes merge and a viewer cannot count them. Deterministic per-building
   shade variation derived from the file path would fix it and stay honest
   (colour still encodes kind; the variation is a function of the code, exactly
   as the layout is).

**Human-verify:** the live Tauri window has never been opened, so `city_for`'s
IPC round-trip and the click-to-open / Escape-to-return wiring are unverified in
a real window. This machine has no attached display, so no agent can close this
one — it needs `source "$HOME/.cargo/env" && npm run tauri dev` and a minute.

### What the city generator taught us, worth keeping

- **Numbers cannot see a picture.** The city model's tests were green and every
  metric looked healthy — district counts, building counts, heights, skip counts
  — while the actual render read as a *treemap*, not a city: height was encoded
  as opacity and was invisible, plots were drawn at their reserved extent so
  growth headroom showed as empty margins, and every gap was the same width.
  None of that was reachable from the numbers. The SVG preview
  (`city::preview`, `bin/city_preview`) exists solely so a reviewer can look,
  and it paid for itself immediately.
- **A city can be dishonest by including too much.** Looking at the render
  revealed that one real repo's "city" was overwhelmingly Xcode's build cache —
  districts named `.build`, `ModuleCache`, `arm64`, `x86_64`, `…xcbuilddata`.
  The exclusion list caught `build` but not `.build` or `DerivedData`.
  Extending it dropped that repo from 694 districts to 74. Picturing a compiler
  intermediate as the user's work violates principle 4 as squarely as inventing
  a wall does, and only the image exposed it.
- **Exclusions can be dishonest in the other direction too.** `out` and
  `coverage` are plausible real source directory names (`src/formatters/out/`),
  so they are matched at the repo ROOT only while every other entry matches at
  any depth. Over-reporting a city is visible and reportable; silently deleting
  someone's source directory is not.
- **Generated property tests beat hand-picked cases for geometry.** The
  plot-overlap bug class recurred four times and was missed by hand-written
  cases every time; a generated random-history property test found a violating
  seed in 0.26s, and the permanent version now guards it. When the invariant is
  spatial, generate the histories.
- **A property test's PRNG is part of the test.** The first version drew with
  `% n` on raw LCG output, which has a period-4 cycle in the low bits (lag-4
  autocorrelation 1.0) and made the target shape structurally unreachable — the
  test passed because it could not produce the input that breaks the code. Draw
  from the high bits.

### The final review, and the one lesson worth carrying forward

The whole-branch review returned **"not yet"** with two Criticals, and both are
worth remembering for the shape of the mistake rather than the mistake itself.

`ancestor_segments` scanned the whole **absolute** path, not the path inside the
repository, and it fed both classification and exclusion. Every file in every
repo under a `~/Projects/Tests/` ancestor classified as `Test`, turning those
cities entirely green and giving **123 of 127 districts a fabricated brick
wall**; any repository beneath a directory named `build` rendered as zero
districts on bare land while asserting it had no content. The fix was one line
(`strip_prefix(root)`). After it, on the real `speech.cpp`: Test-classified
buildings fell from 398/464 to 14/464, and walled districts from 123/127 to
12/127.

`git ls-files --cached` emits an unmerged path **once per stage**, so a single
conflicted file became three identical buildings in three different cells.
Twenty conflicted files drew forty buildings that were not on disk — at exactly
the moment a stopped agent makes you open that town.

Neither was reachable by the test suite, and the reason is the lesson: **every
model test rooted at `/p/api`, and every git test used a clean repository.** The
fixtures agreed with each other about what a repository looks like, so a whole
class of real-world shape — a repo nested under an unfortunate directory name, a
repo mid-conflict — was outside everything the suite could express. A green
suite proved only that the code handled the situations someone had already
thought of.

That is the same finding as §6's, arrived at from a different direction: on this
pipeline, evidence comes from real repositories and rendered images. Four
honesty defects were found by looking at a picture; two more by running the code
against the author's actual disk. Zero were found by the suite before the fact.
The suite's value here is regression-locking what looking has already found —
which is real value, and not the same thing as confidence.

---

## 7. Two open questions, answered from the real transition log

`~/.age-of-agents/transitions.jsonl` was added in Phase 0 specifically to settle
spec risk #2 by observation rather than argument. It now holds 112 transitions
across five repositories (AgeOfAgents 54, atlas 42, probe-repo 10, picks 3,
TestVoiceClone 3), spanning 2026-09-16 to 2026-09-18 — two days of real use, not
the week §1.3 asked for, so treat this as strong early evidence rather than a
settled verdict.

**§1.3 — "Does `blocked` fire reliably for the agents you actually run?"**
**Yes.** 46 of 112 transitions land in `blocked`, and every observed transition
*out of* `working` went to `blocked` (2 of 2) — none went to `idle`.

That is the opposite of the risk the design feared. The history-aware sticky
promotion (treating `working → idle` as stopped, built because we expected
`blocked` to be unreliable) is therefore belt-and-braces rather than the primary
path. Keep it — it costs nothing and covers agents that behave differently — but
the attention signal does not depend on it for the agents in use here.

**§1.2 — "Does anything in your setup ever emit `agent_status: done`?"**
**Yes, once.** The log contains a single `done`. Phase 0 recorded that `herdr
pane report-agent --state` accepts only `idle|working|blocked|unknown` and that
`done` existed only in the JSON schema, so this is worth knowing: something in
the real pipeline does emit it. One occurrence is not enough to characterise
when, so the first-sight-`done` edge case noted in §3 stays open rather than
being declared unreachable.

Full distribution of destination states: `unknown` 58, `blocked` 46, `idle` 5,
`working` 2, `done` 1. The `unknown` count is inflated by first-sight
observations (`from: null`), which are recorded whenever a pane is first seen.

## 8. Phase 0.7 — Four facts about Herdr, measured not assumed

These came out of building the interactive terminal's backend (`89e7713`).
Each contradicts or sharpens something we had been assuming, and each was
established by probing the running Herdr 0.8.0 rather than by reading its
schema. They are recorded here because the SDD workspace they were first
written in is git-ignored scratch that gets deleted with the branch.

**8.1 — `pane.read`'s `revision` field does not move.** It returned `0` on
every read, against every `source` (`visible`, `recent`, `recent_unwrapped`,
`detection`), before and after the pane's visible content demonstrably
changed. `pane.get`'s separate `PaneInfo.revision` sat at `1` and was equally
inert. The design brief had assumed the opposite — "the revision field exists
precisely so you can skip work when nothing changed" — and building the
terminal's change detection on it would have meant the mirror silently froze
after its first paint, in a way no test would catch. **Diff the text.** The
field is still returned, and still documented at all three layers as
not-to-be-trusted-alone, because a future Herdr may well start populating it.

**8.2 — There is no content-change subscription to be found.**
`pane.wait_for_output` requires a `match` field: a literal or regex the caller
must already know to look for. There is no block-until-anything-changes mode
and no revision-since parameter. The subscribable event kinds
(`pane_output_matched`, `pane_agent_status_changed`, `pane_scroll_changed`)
include no generic content push either. Polling is not a shortcut we took; it
is the only mechanism the API offers.

**8.3 — Polling is nearly free, so the cost lives elsewhere.** A direct
unix-socket `pane.read` round trip against a real pane measured a **median of
0.15ms** (max 0.32ms over 20 calls). Note this is the socket, not the CLI —
`herdr` as a subprocess carries ~100ms of process startup, which is why
nothing on the hot path shells out. At that price the poll interval is not
bounded by Herdr at all; it is bounded by re-render cost and timer wakeups,
which is a frontend decision and should be argued as one.

**8.4 — A single keystroke can destroy a workspace.** `ctrl+z` passes key
validation, but sent to a shell sitting at an idle prompt with no foreground
job, it suspended the shell and **Herdr closed the entire workspace** —
confirmed by `herdr workspace list` before and after. This is the sharp edge
of raw keystroke injection made concrete: a key that is entirely safe in one
program state (a REPL, an editor, a running build) kills the pane in another,
and the app cannot know which state the pane is in.

The ruling was **not to filter it.** A real terminal passes `ctrl+z`, the same
thing happens if the user types it in their own emulator, and a terminal that
quietly swallows keys is no longer the true mirror §5.6 permits it to be — the
condition that section names for withdrawing the capability entirely is the
app's terminal doing something the real one cannot, and that cuts both ways.
What the app owes instead is the guarantee that a keystroke can only ever
reach a pane from a surface that genuinely holds keyboard focus. That boundary
is the thing worth testing; key filtering would have been a comfortable
substitute for testing it.

Also worth knowing: Herdr 0.8.0's logical-key vocabulary has real gaps.
`delete`, `home`, `end`, `pageup`, `pagedown` and `insert` are all rejected
with `unsupported key <name>`, under every spelling tried. Enter, Tab,
Backspace, Escape, arrows, function keys, and Ctrl/Alt/Shift/Cmd combinations
are all accepted. A terminal UI has to decide what to do with the keys that
have nowhere to go, rather than assuming a full keyboard is available.

**8.5 — herdr's socket is one request per connection.** A second request
written to a connection that has already been answered gets `EPIPE`; the
server closes after every reply. `herdr::launch`'s habit of opening a fresh
`HerdrClient` per call is therefore the protocol, not an inefficiency to
tidy up later. It costs nothing worth counting: the connect is 0.07–0.4ms,
inside the 0.2ms a whole `pane.read` takes.

**8.6 — 8.3 was half the story: herdr stalls for ~105ms, in bursts.** The
0.2ms round trip is the *usual* case, not the distribution. Re-measured over
hundreds of read-only calls against live panes, the answer time is bimodal:
most calls come back in ~0.2ms, and a minority take **100.7–105.95ms** — a
suspiciously fixed figure. It is entirely server-side (splitting connect from
request→reply puts every millisecond of it after the write), it is not screen
capture (`pane.get`, which captures nothing, stalls identically), and it does
not depend on how fast we ask (inter-request gaps from 2ms to 400ms gave
stall rates from 8% to 88%, with no trend). Cause unknown.

This is now the largest single term in the embedded terminal's typing
latency — larger than anything left on this side of the socket after the
typing-latency round — and no amount of polling can remove it. Worth raising
with herdr. It also means "polling is nearly free" should be read as "a poll
usually costs 0.2ms and occasionally costs 105ms", which is still cheap, but
is a different sentence when something is waiting on the answer.

## 9. Phase 0.7 — What live use found that the suite never could

The author ran the app and, within minutes, hit three defects that every
check in this repository was structurally incapable of catching. They are
recorded together because they share one cause, and that cause is the most
useful thing on this page.

**The cause: nothing we run is the actual app.** The frontend tests mock
`invoke`, so they never reach the Tauri runtime. The screenshot harness
renders React with no Rust behind it. `cargo test` exercises the command
layer without a webview. Each layer is well tested and the seams between
them are not tested at all — which is exactly where these three lived.

**9.1 — `cargo run` could not determine which binary to run.** Adding the
`city_preview` / `city_fixture` bins broke `tauri dev` for everyone. Fixed
with `default-run = "tauri-app"`. Nobody caught it because no check ever
launches the app. This was the author's very first launch.

**9.2 — "Open file" had never worked.** `opener:allow-open-path` enables the
command but, in its own ACL manifest's words, "without any pre-configured
scope" — so the allowed-path list was empty and the Tauri runtime rejected
every `open_path` call. Fixed in `3109f08` by scoping to `$HOME/**`.

Two things worth keeping: "Reveal in Finder" was unaffected because it goes
through our own Rust command rather than the plugin, which is why the app
appeared *partly* working; and **a repository outside `$HOME` will still be
refused.** That is a deliberate trade — `**` would make the app a
general-purpose "open any path on this machine" surface — but it is a real
limitation, not a solved problem. If the author ever keeps repositories
outside his home directory, this needs revisiting rather than silently
failing.

**9.3 — The primary action was named for the metaphor, not the act.** On a
repository with no workspace the only button read "Found a settlement" and
never used the word "agent", so the author reported they could not start one.
They could; the name was wrong. Fixed in `c617b71` and `50a137b`.

The instructive part is the second-order failure: the first fix renamed only
the *settled* branch, leaving two independent string literals free to drift —
and they immediately did. The durable fix was one shared constant used by
both branches, with a test asserting it. A label duplicated across two code
paths is a defect waiting for someone to edit one of them.

**9.4 — Herdr has no mouse API.** Searched the full 0.9.0 schema while
answering the author's request to pass clicks through to the agent. The input
surface is exactly `pane.send_text`, `pane.send_keys`, `pane.send_input` —
there is no mouse event method and no mouse field anywhere.

Ruling: **not implementable, and not to be faked.** The only route would be
synthesising xterm mouse escape sequences, which requires guessing whether
the foreground program has mouse reporting enabled and injecting bytes the
user never typed — precisely what §5.6 forbids, and the constraint the
embedded terminal's existence is conditional on. Revisit only if Herdr grows
a real mouse method.

Related, and also ruled out: `pane.resize` **does** exist. It is deliberately
not used. The app's terminal showing a small pane inside a large panel is an
honest mirror of a genuinely small pane; resizing the author's real terminal
so our window looks better would be the app rearranging his session for its
own convenience. Scale the rendering instead.

## 10. Terminal feel — five more facts about Herdr and one about claude

From the round that answered the report that the terminal could not be
scrolled or clicked. Every one of these was established against a throwaway workspace this
session created and closed (`w2W`), plus read-only reads of the author's live
panes. Three of them contradict something the previous round had recorded, so
they are written down rather than left in a commit message.

**10.1 — `pane.send_text` carries real escape bytes.** This was the open
question the whole round hung on, and the answer is yes. A payload beginning
`\x1b` sent to a pane running `cat -v` echoed `^[[5~` — the ESC byte reached
the pty, not a literalised spelling of it. Confirmed end to end afterwards:
`\x1b[6~` and `\x1b[5~` paged `less` forward and back, and `\x1bOH`,
`\x1bOF`, `\x1b[3~` moved zsh's cursor home, to the end, and deleted forward.
So the six keys §8.4 found `send_keys` rejecting — PageUp, PageDown, Home,
End, Delete, Insert — do have somewhere to go after all.

The specific bytes are not invented and not remembered. herdr launches panes
with `TERM=xterm-256color` (read out of a live pane with `echo TERM=$TERM`),
and that terminfo entry declares exactly them: `kpp=\E[5~`, `knp=\E[6~`,
`khome=\EOH`, `kend=\EOF`, `kdch1=\E[3~`, `kich1=\E[2~`.

**10.2 — `scroll.max_offset_from_bottom` does not mean "there is
scrollback".** It reads `0` on every pane, including a shell pane with 141
lines of genuine scrollback sitting behind the top of the screen. It is the
viewport's current offset in herdr's own UI, not a measure of what exists
above it. A previous note took its being `0` everywhere as evidence that no
pane has scrollback; the field simply does not answer that question.

**10.3 — `pane.read --source recent` DOES return real scrollback.** Against a
shell pane that had scrolled: 141 rows from `recent` against 23 from
`visible`, after `seq 1 120`. The earlier measurement that `recent` "returns
exactly the 23 visible rows" was true of the panes it was taken on and not
true in general — every one of those panes was running claude.

**10.4 — The alternate screen is the whole explanation.** `less`, and every
one of the author's live `claude` panes, return exactly the visible screen
from BOTH sources: 23 rows each. That is not herdr withholding anything — the
alternate screen has no scrollback by definition. Comparing the two sources'
row counts is therefore the only way to tell "this pane has history" from
"this program owns the screen", and it costs one extra read.

**10.5 — herdr accepts `meta+c` and `cmd+c` without complaint.** Both pass
key validation and are delivered. This is why ⌘C in the embedded terminal
used to put bytes into the author's live session instead of copying his
selection: the app was faithfully forwarding a chord that, on macOS, no
terminal emulator forwards. Not a herdr defect — a reminder that "herdr
accepted it" is not the same as "a terminal would have sent it".

**10.6 — claude's TUI ignores PageUp and treats ↑ as history.** Measured
against a claude session started in the throwaway workspace and exited
immediately afterwards. With the prompt box focused, `\x1b[5~` changed the
screen not at all; `up` opened `─── History 1/1 ───` and put the previous
message into the prompt.

That single measurement decided the wheel translation. iTerm2 and Ghostty
both send arrow keys for a wheel in alternate-screen mode, and copying them
would have meant a scroll gesture silently rewriting what the author was
about to send. PageUp is the less faithful choice and the right one: in a
pager or an editor it scrolls, and in a program that does not understand it,
nothing happens — which the terminal says out loud rather than leaving it to
look broken.
