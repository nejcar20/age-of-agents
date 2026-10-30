# Raids: known vulnerabilities as attacks on islands

Turn each repository's known dependency vulnerabilities into something you can
see in the world: pirate ships circling the island at sea, raiders at the
walls in town. Like everything else in Age of Agents, nothing is decoration:
every ship is one real advisory, and a clean scan is shown as clean.

## Why

The archipelago already tells you at a glance which repos have agents working
or waiting. It says nothing about which repos are *in danger*. Dependency
advisories are easy to ignore in a terminal; a warship parked off your
biggest island is not. And because agents already live on the islands, the
natural response to a raid is to send one to defend.

## Goals

- Scan every island for known vulnerable dependencies, on demand.
- Show each finding as an attacker, scaled by severity, at sea and in town.
- Let you inspect any attacker and see the real advisory.
- Let you hand the fix to an agent on that island in one confirmed step.
- Remember results between sessions until the next scan.

## Non-goals (this version)

- Secret scanning, static analysis (semgrep etc.), container/IaC scanning.
  A later version may add these as a different attacker (spies).
- Automatic or continuous scanning (on save, on focus, on a timer).
- Automatically fixing anything or sending anything to an agent without the
  user confirming.
- Installing scanners for the user.

## Anti-goals (would make it a failure even if it "works")

- **Showing an island as safe when it wasn't checked.** A missing scanner, an
  unsupported ecosystem, or a failed scan is "unscouted", never "clean".
- Invented or decorative threats. Ship count/size map 1:1 to real findings.
- Making the sea unreadable: dozens of ships on one island must be capped
  visually (show a count) so the existing orange/green attention glow stays
  the most legible signal.
- Blocking the UI while scanning; scans run in the background with progress.

## Scanners

Run per island root, in the backend (Rust, new `src-tauri/src/raids/` module),
using the same bounded-process discipline as `inspection.rs` (`run_bounded`:
timeout, output cap, no shell):

| Scanner | When used | Command |
| --- | --- | --- |
| `osv-scanner` | if on PATH; preferred, covers npm, Cargo, PyPI, Go, Maven, etc. | `osv-scanner scan source --format json -r <root>` (verify flags against installed version) |
| `npm audit` | if `osv-scanner` is absent and the root has `package-lock.json` | `npm audit --json` in `<root>` |

If neither applies, the island is **unscouted** with a reason
("no scanner installed", "no lockfile found", "scan failed: …", "timed out").
The scout action's sheet says which scanners were found and suggests
`brew install osv-scanner` when it is missing. It does not run it.

Both outputs are normalised into one model:

```
Finding {
  id            // advisory id, e.g. GHSA-xxxx / RUSTSEC-… / CVE-…
  summary       // one line
  severity      // critical | high | moderate | low | unknown
  package       // name
  installed     // version found
  fixed_in      // Option<version>
  manifest      // repo-relative path of the lockfile/manifest it came from
  url           // advisory link
}
RaidReport {
  root, scanned_at, scanner ("osv-scanner" | "npm-audit"),
  status: Clean | Raided(Vec<Finding>) | Unscouted { reason }
}
```

Severity mapping: npm's `critical/high/moderate/low` as-is; OSV uses the
`database_specific.severity` or CVSS score (≥9 critical, ≥7 high, ≥4
moderate, else low), otherwise `unknown` (drawn like moderate). Duplicates of
the same advisory id + package collapse to one finding.

Reports persist in one cache file (`raids.json`) via `cache_io::atomic_write`
and `with_cache_lock`, keyed by canonical root. A report is never shown as
current for a root other than its own.

## Commands

- `scout_island(root) -> RaidReport` scans one root.
- `scout_all() -> ()` scans every known island with limited concurrency
  (2 at a time). It emits a `raid-report` event per island as each finishes,
  so ships appear progressively.
- `raid_reports() -> Vec<RaidReport>` returns the cached reports, loaded on startup.

Scans hit the network (advisory databases); that's stated on the scout sheet.

## At sea

- **Entry point:** a "Scout for threats" button in the sea HUD, next to the
  search/filter bar. It opens a confirm sheet listing the scanners found and
  the number of islands, then starts `scout_all`. While running: a small
  "Scouting 3/9…" indicator. Per-island "Scout" is also in the island panel.
- **Pirate ships:** one ship per finding, on a loop around the island outside
  the existing scenery boats' route (`Boats.tsx` loops are reused for the
  motion, but ships are visibly different: dark hulls, sails coloured by
  severity).
  - low: small rowboat, pale sail
  - moderate/unknown: sloop, amber sail
  - high: brigantine, red sail
  - critical: black-sailed warship, slightly larger, slower
- **Cap:** at most 6 ships per island, highest severities first. If there are
  more, a small floating "+N" badge appears near the island.
- **Smoke:** an island with any critical or 3+ high findings gets a thin
  smoke column. It is drawn subtly so it never competes with the attention glow.
- **Clean:** a small white flag on the island after a clean scan.
- **Unscouted:** nothing drawn (absence is the default state). The island panel
  explains why.
- **Filter:** add "Under attack" to the existing state filter
  (`StateFilter` in `archipelago.ts`), matching islands with ≥1 finding.

## In town

- Raiders (small hostile figures with torches, coloured by their worst
  severity) gather at the town edge nearest the building for each finding's
  `manifest` file (e.g. `package-lock.json`, `Cargo.lock`). One group per
  manifest, sized by finding count (capped). If the manifest isn't a building
  in the town (filtered out, not found), the raiders gather at the town gate
  or coast instead.
- Clicking a raider group or a pirate ship opens the **Raid panel** (same
  family as `IslandPanel`/`BuildingPanel`). It lists findings sorted by
  severity. Each row shows: severity, advisory id (link opens in the browser
  via the existing opener), summary, package `installed → fixed_in`, and
  manifest. The header shows scanner and `scanned_at` ("scouted 2 days ago").

## Defending

The Raid panel has **"Send an agent to defend"**:

- If the island has an agent, it opens a composer modelled on
  `ScopedTaskComposer`. It pre-fills an editable prompt listing the selected
  findings (all by default, checkboxes per row) and asks the agent to upgrade
  each package to a fixed version, run the project's tests, and report what
  couldn't be fixed. Sending goes through the existing `send_prompt` with
  `expectedRoot`. Nothing is sent without the explicit send click.
- If the island has no agent, the button reads "Start an agent first" and
  opens the existing Start Agent flow. Defending is then available once
  the agent exists.
- After the agent finishes, the user rescouts that island (button in the
  panel). Ships for findings no longer present **sink** (short sinking
  animation on the next render after the new report), and the flag goes up
  if clean. No automatic rescans.

## Browser preview / fixtures

Like the rest of the app, the browser (non-Tauri) preview uses fixture data:
add a fixture raid report set covering clean, raided (all severities,
>6 findings), and unscouted islands. Scouting and sending are disabled in
the browser preview.

## Validation

- Rust: parser tests for real captured `npm audit --json` and `osv-scanner`
  JSON samples (including empty, malformed, truncated). Severity mapping,
  dedup, unscouted reasons (missing binary, no lockfile, non-zero exit,
  timeout), cache round-trip and root keying.
- TS: pure functions for ship selection/cap, smoke rule, raider grouping by
  manifest, prompt building, and the "Under attack" filter.
- Manual: run against a repo with a known-vulnerable lockfile, then check that
  the ships appear, the panel matches the scanner output, the defend prompt is
  correct, and a rescan after fixing sinks the ships.

## Decisions settled after review (Claude's calls; the user delegated these)

1. **Which checkout is scanned.** A raid belongs to the island's main root
   (`Island.root`), because the island is about what's on the main checkout.
   Reports are keyed by canonical root. Defending can target an agent whose
   `cwd` is a worktree. In that case the composer says so plainly: "this agent
   works in `<worktree>`; the ships sink once the fix reaches `<root>`". The
   rescout button always scans `Island.root`. Worktrees are not scanned
   separately in this version.
2. **Where raiders stand.** Lockfiles are deliberately not buildings
   (`is_lockfile` in `city/model.rs`), so each finding's lockfile maps to the
   sibling manifest building in the same directory:
   - `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml` → `package.json`
   - `Cargo.lock` → `Cargo.toml`
   - `poetry.lock` → `pyproject.toml`
   - `go.sum` → `go.mod`
   - `Gemfile.lock` → `Gemfile`

   Only if that building is also missing do raiders fall back to the coast.
   The town layout is unchanged.
3. **Partial coverage.** `RaidReport` records `covered` (lockfiles the scanner
   actually read) and `uncovered` (lockfiles or manifests found in the repo
   that no available scanner handles). The status rule:
   - `Raided` if there is any finding, even with gaps; the panel lists the gaps.
   - `Clean` only when there are no findings and `uncovered` is empty.
   - `Unscouted` when nothing was covered.
   - No findings plus some gaps is `Unscouted` with the reason "partly
     scouted: Cargo.lock not checked (install osv-scanner)". There's no white flag.
4. **Staleness.** Each report stores a fingerprint: the content hash of every
   lockfile it covered, plus the list of lockfile paths present. When an
   island is shown, the backend recomputes it cheaply. If it differs, the
   report is **stale**:
   - ships are drawn desaturated, with no smoke and no white flag
   - the panel says "the lockfiles changed since this scout — rescout"

   No automatic rescan.

Builder's own calls, confirmed:
- Non-zero exit codes are interpreted per tool, because both scanners exit
  non-zero when they find vulnerabilities.
- When an island has several agents, the composer gets an agent picker as in
  `ScopedTaskComposer`.
- "Known islands" means the islands in the current `get_archipelago` result.

## Left to the builder

Exact meshes, colours, animation timings, panel layout, prompt wording,
module/file names, and concurrency tuning, within the constraints above
and the existing visual style.
