# Phase 0.5b — The First Island: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a repository into a city that looks like a city — and clear the two Phase 0/0.5a items that must be fixed before daily use.

**Architecture:** Rust owns the city model and its layout, because it already owns the filesystem walk and all path canonicalization, and because layout must be deterministic and testable without a renderer. The model is emitted as plain data. Two consumers read it: a standalone HTML preview (so the *look* can be judged from a screenshot, early and cheaply) and later the in-app 3D view. Tasks 1-2 are unrelated cleanup, deliberately first because they are small and unblock daily use.

**Tech Stack:** Rust (serde, existing `ignore`-free std walk), React + TypeScript, three.js via react-three-fiber, vitest.

**Spec:** `docs/superpowers/specs/2026-09-16-age-of-agents-design.md` — §3 visual direction, §4.1 the town screen, §4.2 layout, §10 Phase 0.5.

## Global Constraints

- **Rust 1.98.1 via rustup, NOT on a fresh shell's PATH.** Prefix cargo with `source "$HOME/.cargo/env" &&`; run cargo from `src-tauri/`.
- **Baseline to preserve:** 114 Rust tests + 6 ignored live, 30 frontend tests, `npx tsc --noEmit` clean, `cargo clippy --all-targets` clean.
- **Permitted Herdr writes remain exactly six:** `agent.focus`, `workspace.focus`, `pane.focus`, `notification.show`, `workspace.create`, `agent.start`. `pane.run`, `pane.send_text` and every git write stay forbidden. This phase adds NO new write.
- **Honest UI (principle 4).** The city may not invent structure. Every building corresponds to a real file; every wall to a real test file. Unknown is shown as unknown, never as absence.
- **Layout determinism (spec §4.2).** The same repo produces the same default layout on the same machine, and **adding a file must never move an existing building.** Hash-on-a-spiral is explicitly rejected — it produces a scatter plot, not a city. A real arrangement (a road grid with district plots) is the requirement.
- **Generated and vendored files are not architecture.** `node_modules`, `target`, `dist`, `.git`, lockfiles, `*.min.*`, and anything gitignored must not become buildings. A migrations folder must not become 400 identical huts.
- **Performance:** a repo with thousands of files must render without a frame-rate collapse; the renderer uses instanced meshes and `frameloop="demand"`.
- **Local only.** No network, no accounts.
- Every task ends with a passing test run and a commit.

---

### Task 1: Rescan the unsettled list without a restart

**Files:**
- Modify: `src/components/UnsettledList.tsx`, `src/founding.ts`, `src/founding.test.ts`, `src/styles.css`

**Interfaces:**
- Produces: `shouldRescan(trigger: "focus" | "manual" | "mount", lastScanAt: number, now: number): boolean` — pure, so the policy is testable without a DOM.

**Why:** the final review of Phase 0.5a flagged this as the one thing to fix before daily use. The list is fetched once on mount and the component only remounts when Herdr disconnects, so a repo cloned while the app runs never appears. The previous per-event refetch was removed for good reason — it caused ~279 filesystem scans in 15 seconds — so this must NOT reintroduce it.

- [ ] **Step 1: Write the failing tests**

```ts
// src/founding.test.ts — add
import { shouldRescan } from "./founding";

describe("shouldRescan", () => {
  it("always scans on mount", () => {
    expect(shouldRescan("mount", 0, 1_000)).toBe(true);
  });

  it("always scans when the user asks", () => {
    expect(shouldRescan("manual", 999_000, 1_000_000)).toBe(true);
  });

  it("scans on focus when the last scan is stale", () => {
    expect(shouldRescan("focus", 0, 30_000)).toBe(true);
  });

  it("ignores focus churn right after a scan", () => {
    // Clicking between windows must not re-walk the filesystem every time.
    expect(shouldRescan("focus", 10_000, 12_000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test`
Expected: FAIL — `shouldRescan` is not exported.

- [ ] **Step 3: Implement**

```ts
// src/founding.ts
/** Focus fires constantly while alt-tabbing; only a stale list is worth a filesystem walk. */
export const RESCAN_STALE_AFTER_MS = 10_000;

export function shouldRescan(
  trigger: "focus" | "manual" | "mount",
  lastScanAt: number,
  now: number,
): boolean {
  if (trigger === "mount" || trigger === "manual") return true;
  return now - lastScanAt >= RESCAN_STALE_AFTER_MS;
}
```

- [ ] **Step 4: Wire it in**

In `UnsettledList.tsx`: keep the existing mount fetch; add a `window` `focus` listener and a visible "rescan" button in the panel header, both routed through `shouldRescan`. Track `lastScanAt` when a fetch resolves. Remove the listener on unmount. Do NOT subscribe to `world-updated` for scanning — the subtraction already reacts to the world; only the filesystem walk needs a trigger.

- [ ] **Step 5: Verify**

Run: `npm test` (expected: the four new tests pass alongside the existing 30) and `npx tsc --noEmit`.
Then run the app, create a directory with `git init` under a scanned root while it is open, click rescan, and confirm the new repo appears. Remove the directory afterwards.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(ui): rescan the unsettled list on focus and on demand"
```

---

### Task 2: Jump to the agent that actually stopped

**Files:**
- Modify: `src-tauri/src/world/state.rs`, `src-tauri/src/world/attention.rs`, `src-tauri/src/commands.rs`, `src/world.ts`, `src/components/IslandGrid.tsx`

**Interfaces:**
- Produces: `IslandAgent.attention: Attention` (per-agent, alongside the existing per-island roll-up)
- Changes: `jump_target(island) -> Option<String>` selects the first agent whose own `attention` is `Stopped`, falling back to the island's first agent only when none is.

**Why:** Phase 0's review left this as a must-fix. `jump_target` currently guesses: it prefers a `Blocked`/`Done` agent, then falls back to "first agent". After the sticky-idle fix an island can be `Stopped` because of a *promoted idle* agent that is neither `Blocked` nor `Done`, so the fallback can focus a still-working pane — right repo, wrong terminal. The island roll-up already computes per-agent attention and then throws it away; carrying it through removes the guess entirely.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/commands.rs — in the tests module
#[test]
fn jump_target_picks_the_agent_that_is_itself_stopped() {
    use crate::herdr::snapshot::AgentStatus;
    use crate::world::attention::Attention;
    use crate::world::state::{Island, IslandAgent};

    let island = Island {
        id: "/p/api".into(), name: "api".into(), root: "/p/api".into(),
        attention: Attention::Stopped,
        agents: vec![
            IslandAgent { pane_id: "w1:p1".into(), workspace_id: "w1".into(),
                cwd: "/p/api".into(), status: AgentStatus::Working,
                attention: Attention::Working, title: None, is_worktree: false },
            // Promoted to Stopped by the sticky idle-after-work rule: neither
            // Blocked nor Done, so the old fallback would have missed it.
            IslandAgent { pane_id: "w1:p2".into(), workspace_id: "w1".into(),
                cwd: "/p/api".into(), status: AgentStatus::Idle,
                attention: Attention::Stopped, title: None, is_worktree: false },
        ],
    };

    assert_eq!(jump_target(&island), Some("w1:p2".to_string()));
}

#[test]
fn jump_target_never_prefers_a_working_agent_over_a_stopped_one() {
    use crate::herdr::snapshot::AgentStatus;
    use crate::world::attention::Attention;
    use crate::world::state::{Island, IslandAgent};

    let island = Island {
        id: "/p/api".into(), name: "api".into(), root: "/p/api".into(),
        attention: Attention::Stopped,
        agents: vec![
            IslandAgent { pane_id: "w1:p1".into(), workspace_id: "w1".into(),
                cwd: "/p/api".into(), status: AgentStatus::Working,
                attention: Attention::Working, title: None, is_worktree: false },
            IslandAgent { pane_id: "w1:p2".into(), workspace_id: "w1".into(),
                cwd: "/p/api".into(), status: AgentStatus::Blocked,
                attention: Attention::Stopped, title: None, is_worktree: false },
        ],
    };

    assert_eq!(jump_target(&island), Some("w1:p2".to_string()));
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd src-tauri && cargo test commands`
Expected: FAIL — `IslandAgent` has no `attention` field.

- [ ] **Step 3: Implement**

Add `pub attention: Attention` to `IslandAgent` in `world/state.rs`. In `attention.rs`, the per-pane attention is already computed for the roll-up — store it on the agent instead of discarding it. Then rewrite `jump_target`:

```rust
pub fn jump_target(island: &Island) -> Option<String> {
    island
        .agents
        .iter()
        .find(|agent| agent.attention == Attention::Stopped)
        .or_else(|| island.agents.first())
        .map(|agent| agent.pane_id.clone())
}
```

Update every `IslandAgent` construction in existing tests (they are struct literals and will fail to compile until they carry the new field — expected, mechanical).

- [ ] **Step 4: Surface it, honestly**

In `src/world.ts` add `attention` to the `Agent` type. In `IslandGrid.tsx`, when an island has more than one agent, show each agent's own marker rather than only the island roll-up — otherwise the UI still cannot tell the user *which* pane is waiting, which is the same guess moved to the human.

- [ ] **Step 5: Verify**

Run: `cd src-tauri && cargo test` (all pass, including the two new), `cargo clippy --all-targets`, `npm test`, `npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "fix: jump to the pane that actually stopped, not the island's first"
```

---

### Task 3: The city model

**Files:**
- Create: `src-tauri/src/city/mod.rs`, `src-tauri/src/city/model.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces:
  - `enum BuildingKind { Source, Test, Config, Docs, Asset, Data }`
  - `struct Building { path: String, name: String, kind: BuildingKind, lines: u32, height: u8 }`
  - `struct District { path: String, name: String, buildings: Vec<Building>, walled: bool, depth: u8 }`
  - `struct CityModel { root: String, name: String, districts: Vec<District>, skipped: u32 }`
  - `fn build_city(root: &Path, walker: &dyn FileSource) -> CityModel`
  - `trait FileSource { fn files(&self, root: &Path) -> Vec<(PathBuf, u32)>; }` (path + line count) with `RealFiles` implementing it

Injecting `FileSource` keeps the model pure and testable without a fixture tree, exactly as `GitProbe` and `EnvSource` already do elsewhere in this codebase.

**Rules the model must implement (these are the honesty requirements, not suggestions):**
- **Excluded entirely, counted in `skipped`:** anything under `.git`, `node_modules`, `target`, `dist`, `build`, `vendor`, `.next`, `__pycache__`; lockfiles (`*.lock`, `package-lock.json`, `Cargo.lock`, `yarn.lock`, `pnpm-lock.yaml`); minified files (`*.min.js`, `*.min.css`); anything over 50k lines (generated).
- **`height`** is a bucket, not a line count: 1 for <50 lines, 2 for <150, 3 for <400, 4 for <1000, 5 for anything larger. A city of five heights reads as a city; a city of five hundred reads as noise.
- **`kind`** from path and extension: `Test` when the path contains a test directory segment or the filename matches `*_test.*`/`*.test.*`/`test_*`; `Docs` for `*.md`/`*.txt`/`docs/`; `Config` for `*.json`/`*.toml`/`*.yaml`/`*.yml`/dotfiles; `Asset` for images/fonts/media; `Data` for `*.csv`/`*.sql`; `Source` otherwise.
- **`walled`** is true when a district contains at least one `Test` building, or a sibling test directory maps to it. This is presence-of-tests, NOT coverage — and §4.1's honesty rule means the UI must say so rather than implying coverage.
- **A district with more than 40 buildings is split** into numbered sub-plots, so a migrations folder becomes a terrace rather than 400 identical huts.
- Directories with no direct files contribute no district (their children still do).

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/city/model.rs
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    struct FakeFiles(Vec<(&'static str, u32)>);
    impl FileSource for FakeFiles {
        fn files(&self, _root: &Path) -> Vec<(PathBuf, u32)> {
            self.0.iter().map(|(p, n)| (PathBuf::from(p), *n)).collect()
        }
    }

    fn city(files: Vec<(&'static str, u32)>) -> CityModel {
        build_city(Path::new("/p/api"), &FakeFiles(files))
    }

    #[test]
    fn a_directory_becomes_a_district_and_its_files_become_buildings() {
        let model = city(vec![("/p/api/src/main.rs", 120), ("/p/api/src/lib.rs", 30)]);
        assert_eq!(model.districts.len(), 1);
        assert_eq!(model.districts[0].name, "src");
        assert_eq!(model.districts[0].buildings.len(), 2);
    }

    #[test]
    fn heights_are_buckets_so_the_skyline_reads_as_a_city() {
        let model = city(vec![
            ("/p/api/src/tiny.rs", 10),
            ("/p/api/src/big.rs", 5_000),
        ]);
        let heights: Vec<u8> = model.districts[0].buildings.iter().map(|b| b.height).collect();
        assert_eq!(heights, vec![1, 5]);
    }

    #[test]
    fn generated_and_vendored_files_are_skipped_not_built() {
        let model = city(vec![
            ("/p/api/node_modules/left-pad/index.js", 20),
            ("/p/api/Cargo.lock", 4_000),
            ("/p/api/dist/bundle.min.js", 900),
            ("/p/api/src/main.rs", 40),
        ]);
        assert_eq!(model.districts.len(), 1, "only src should survive");
        assert_eq!(model.skipped, 3);
    }

    #[test]
    fn a_district_with_tests_is_walled() {
        let model = city(vec![
            ("/p/api/src/main.rs", 40),
            ("/p/api/src/main_test.rs", 20),
        ]);
        assert!(model.districts[0].walled);
    }

    #[test]
    fn a_district_without_tests_is_not_walled() {
        let model = city(vec![("/p/api/src/main.rs", 40)]);
        assert!(!model.districts[0].walled);
    }

    #[test]
    fn a_huge_directory_is_split_into_sub_plots() {
        let files: Vec<(&'static str, u32)> = (0..90)
            .map(|_| ("/p/api/migrations/0001_init.sql", 10))
            .collect();
        let model = city(files);
        assert!(model.districts.len() >= 3, "90 files must not be one plot");
        assert!(model.districts.iter().all(|d| d.buildings.len() <= 40));
    }

    #[test]
    fn file_kinds_are_classified_from_the_path() {
        let model = city(vec![
            ("/p/api/src/main.rs", 10),
            ("/p/api/src/main.test.ts", 10),
            ("/p/api/README.md", 10),
            ("/p/api/tsconfig.json", 10),
        ]);
        let kinds: Vec<BuildingKind> = model
            .districts.iter().flat_map(|d| d.buildings.iter().map(|b| b.kind)).collect();
        assert!(kinds.contains(&BuildingKind::Source));
        assert!(kinds.contains(&BuildingKind::Test));
        assert!(kinds.contains(&BuildingKind::Docs));
        assert!(kinds.contains(&BuildingKind::Config));
    }
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd src-tauri && cargo test city::model`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the model**

Write `city/model.rs` to satisfy exactly those tests and the rules above. Keep `build_city` a pure function of `(root, FileSource)`. `RealFiles` walks the tree and counts lines (read the file, count `\n`; skip anything that fails to read as UTF-8 and count it in `skipped`). Add `pub mod city;` to `lib.rs` and `pub mod model;` to `city/mod.rs`.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test city::model`
Expected: 7 passed.

- [ ] **Step 5: Sanity-check against real repos**

Add an `#[ignore]`d test that builds a city from this repo and from two others under the user's projects directory, printing district and building counts plus `skipped`. Run it with `--nocapture` and put the numbers in your report. **Judge the output**: if one district holds 200 buildings, or `skipped` is implausibly low, or a `node_modules` slipped through, that is a finding — report it rather than adjusting the test to pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(city): turn a repository into districts and buildings"
```

---

### Task 4: A layout that looks like a city

**Files:**
- Create: `src-tauri/src/city/layout.rs`
- Modify: `src-tauri/src/city/mod.rs`

**Interfaces:**
- Produces:
  - `struct Plot { x: i32, z: i32, w: u32, d: u32 }` (grid cells, not world units)
  - `struct PlacedBuilding { building_index: usize, x: i32, z: i32, height: u8 }`
  - `struct PlacedDistrict { district_index: usize, plot: Plot, buildings: Vec<PlacedBuilding>, road_edges: Vec<(i32, i32)> }`
  - `struct CityLayout { districts: Vec<PlacedDistrict>, width: u32, depth: u32 }`
  - `fn layout_city(model: &CityModel) -> CityLayout`

**The requirement that matters:** this must not be a scatter plot. Districts are rectangular plots packed along a road grid, ordered deterministically (by district path, so the order is stable), each sized from its building count. Buildings fill their plot in rows, leaving a one-cell margin so roads read as roads.

**The invariant that matters more:** adding a file must not move an existing building. Placement is by sorted path within a district, and a district's plot is assigned from its sorted position among districts — so a new file appends, and a new district appends.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/city/layout.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::city::model::{build_city, CityModel, FileSource};
    use std::path::{Path, PathBuf};

    struct FakeFiles(Vec<(String, u32)>);
    impl FileSource for FakeFiles {
        fn files(&self, _root: &Path) -> Vec<(PathBuf, u32)> {
            self.0.iter().map(|(p, n)| (PathBuf::from(p), *n)).collect()
        }
    }

    fn model_of(paths: &[(&str, u32)]) -> CityModel {
        let files = FakeFiles(paths.iter().map(|(p, n)| (p.to_string(), *n)).collect());
        build_city(Path::new("/p/api"), &files)
    }

    #[test]
    fn the_same_model_always_lays_out_identically() {
        let model = model_of(&[("/p/api/src/a.rs", 10), ("/p/api/web/b.ts", 10)]);
        let first = layout_city(&model);
        let second = layout_city(&model);
        assert_eq!(first, second);
    }

    #[test]
    fn districts_do_not_overlap() {
        let model = model_of(&[
            ("/p/api/src/a.rs", 10), ("/p/api/web/b.ts", 10),
            ("/p/api/docs/c.md", 10), ("/p/api/infra/d.tf", 10),
        ]);
        let layout = layout_city(&model);
        for (i, a) in layout.districts.iter().enumerate() {
            for b in layout.districts.iter().skip(i + 1) {
                let disjoint = a.plot.x + a.plot.w as i32 <= b.plot.x
                    || b.plot.x + b.plot.w as i32 <= a.plot.x
                    || a.plot.z + a.plot.d as i32 <= b.plot.z
                    || b.plot.z + b.plot.d as i32 <= a.plot.z;
                assert!(disjoint, "plots overlap: {:?} vs {:?}", a.plot, b.plot);
            }
        }
    }

    #[test]
    fn adding_a_file_never_moves_an_existing_building() {
        let before = layout_city(&model_of(&[
            ("/p/api/src/a.rs", 10), ("/p/api/src/b.rs", 10),
        ]));
        let after = layout_city(&model_of(&[
            ("/p/api/src/a.rs", 10), ("/p/api/src/b.rs", 10), ("/p/api/src/c.rs", 10),
        ]));

        // a.rs and b.rs must sit exactly where they did.
        let first_two = |l: &CityLayout| -> Vec<(i32, i32)> {
            l.districts[0].buildings.iter().take(2).map(|b| (b.x, b.z)).collect()
        };
        assert_eq!(first_two(&before), first_two(&after));
    }

    #[test]
    fn adding_a_district_never_moves_an_existing_one() {
        let before = layout_city(&model_of(&[("/p/api/src/a.rs", 10)]));
        let after = layout_city(&model_of(&[
            ("/p/api/src/a.rs", 10), ("/p/api/zzz/b.rs", 10),
        ]));
        assert_eq!(before.districts[0].plot, after.districts[0].plot);
    }

    #[test]
    fn buildings_stay_inside_their_plot() {
        let model = model_of(&[
            ("/p/api/src/a.rs", 10), ("/p/api/src/b.rs", 10), ("/p/api/src/c.rs", 10),
        ]);
        let layout = layout_city(&model);
        for district in &layout.districts {
            for b in &district.buildings {
                assert!(b.x >= district.plot.x && b.x < district.plot.x + district.plot.w as i32);
                assert!(b.z >= district.plot.z && b.z < district.plot.z + district.plot.d as i32);
            }
        }
    }

    #[test]
    fn a_bigger_district_gets_a_bigger_plot() {
        let small = model_of(&[("/p/api/src/a.rs", 10)]);
        let big: Vec<(&str, u32)> = (0..20).map(|_| ("/p/api/src/a.rs", 10)).collect();
        let small_plot = layout_city(&small).districts[0].plot;
        let big_plot = layout_city(&model_of(&big)).districts[0].plot;
        assert!(big_plot.w * big_plot.d > small_plot.w * small_plot.d);
    }
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd src-tauri && cargo test city::layout`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Sort districts by path. Give each a plot sized to hold its buildings in a roughly square block plus a margin. Pack plots left to right into rows of a bounded width, starting a new row when the current one is full — a deterministic shelf packing, which reads as city blocks separated by roads. Within a plot, place buildings in row-major order by sorted filename. Emit `road_edges` as the plot's boundary cells so the renderer can draw streets.

`derive(PartialEq)` on the layout types so the determinism test can compare whole layouts.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test city::layout`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(city): pack districts onto a road grid, stably"
```

---

### Task 5: A preview I can actually look at

**Files:**
- Create: `src-tauri/src/city/preview.rs`, `src-tauri/src/bin/city_preview.rs`
- Modify: `src-tauri/src/city/mod.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `fn preview_svg(model: &CityModel, layout: &CityLayout) -> String` and a binary `city_preview <repo-path> <out.html>`

**Why this exists:** nobody in this loop can see the app's window. A standalone top-down SVG written to an HTML file *can* be opened in a browser and screenshotted, which makes the look reviewable before any 3D work is committed to. This is the iteration loop for the one risk the spec calls the top design risk.

- [ ] **Step 1: Write the failing test**

```rust
// src-tauri/src/city/preview.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::city::layout::layout_city;
    use crate::city::model::{build_city, FileSource};
    use std::path::{Path, PathBuf};

    struct FakeFiles(Vec<(&'static str, u32)>);
    impl FileSource for FakeFiles {
        fn files(&self, _root: &Path) -> Vec<(PathBuf, u32)> {
            self.0.iter().map(|(p, n)| (PathBuf::from(p), *n)).collect()
        }
    }

    #[test]
    fn the_svg_contains_one_rect_per_building_and_names_each_district() {
        let model = build_city(
            Path::new("/p/api"),
            &FakeFiles(vec![("/p/api/src/a.rs", 10), ("/p/api/src/b.rs", 400)]),
        );
        let svg = preview_svg(&model, &layout_city(&model));

        assert_eq!(svg.matches("class=\"building\"").count(), 2);
        assert!(svg.contains("src"), "district name must be labelled");
        assert!(svg.starts_with("<svg"));
    }

    #[test]
    fn taller_buildings_are_visually_distinct() {
        let model = build_city(
            Path::new("/p/api"),
            &FakeFiles(vec![("/p/api/src/tiny.rs", 5), ("/p/api/src/huge.rs", 9_000)]),
        );
        let svg = preview_svg(&model, &layout_city(&model));
        // Height must reach the output somehow — as a fill, an opacity or a size.
        assert!(svg.contains("h1") && svg.contains("h5"));
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd src-tauri && cargo test city::preview`
Expected: FAIL.

- [ ] **Step 3: Implement the SVG and the binary**

`preview_svg` draws, top-down: a pale ground, district plots as subtle blocks with their names, roads as gaps, and one rect per building with a class `building h<height>` and a fill by `kind`. Walled districts get a border. Keep the palette calm and consistent with §3 (soft, low-contrast, dark-friendly) — this preview is a proxy for the eventual look, so it is worth making it pleasant rather than diagnostic.

`src/bin/city_preview.rs` takes a repo path and an output path, builds model + layout with `RealFiles`, and writes an HTML file embedding the SVG plus a short caption (repo name, district count, building count, skipped count).

- [ ] **Step 4: Render real repos and LOOK at them**

```bash
cd src-tauri && source "$HOME/.cargo/env"
cargo run --bin city_preview -- /Users/you/Projects/AgeOfAgents /tmp/aoa-city.html
```

Render at least four repos of different shapes (this one; a large one; a small one; one with a deep nested tree). Then **open each in a browser and screenshot it**, and judge honestly against the spec: does it read as a city, or as a scatter plot? Are there 400 identical huts anywhere? Is one district swallowing everything? Put the screenshots' verdicts in your report, and if the answer is "this does not look like a city", say so plainly and propose what to change — a layout that fails this check is the finding, not the test.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(city): top-down SVG preview so the layout can be judged"
```

---

### Task 6: The town view in the app

**Files:**
- Create: `src/city.ts`, `src/city.test.ts`, `src/components/TownView.tsx`
- Modify: `src/App.tsx`, `src/styles.css`, `src-tauri/src/commands.rs`, `package.json`

**Interfaces:**
- Produces: command `city_for(path: String) -> Result<CityView, String>` returning model + layout together; `TownView` rendering it with react-three-fiber; clicking an island in the list opens its town, `Escape` returns.

- [ ] **Step 1: Add the renderer dependencies**

```bash
npm install three @react-three/fiber
npm install -D @types/three
```

- [ ] **Step 2: Write the failing test**

```ts
// src/city.test.ts
import { describe, expect, it } from "vitest";
import { worldUnits, buildingColor } from "./city";

describe("worldUnits", () => {
  it("maps grid cells to world units with a consistent scale", () => {
    expect(worldUnits(0)).toBe(0);
    expect(worldUnits(2)).toBe(worldUnits(1) * 2);
  });
});

describe("buildingColor", () => {
  it("gives every kind its own colour", () => {
    const kinds = ["Source", "Test", "Config", "Docs", "Asset", "Data"] as const;
    const colors = new Set(kinds.map(buildingColor));
    expect(colors.size).toBe(kinds.length);
  });

  it("is deterministic", () => {
    expect(buildingColor("Source")).toBe(buildingColor("Source"));
  });
});
```

- [ ] **Step 3: Run and watch it fail, then implement**

Run: `npm test` (expected FAIL), then write `src/city.ts` with the scale constant, the colour table matching the SVG preview's palette, and the `CityView` types mirroring the Rust structs verbatim in snake_case.

- [ ] **Step 4: Build `TownView`**

An orthographic camera at an isometric angle, soft directional plus ambient light, a ground plane, instanced boxes for buildings (one `instancedMesh` per `BuildingKind`, since colour is per-kind), thin boxes for district plots, and a border for walled districts. `frameloop="demand"` — this must not spin the GPU while the user reads it. Hovering a building shows its path; that is the only interaction in this task.

- [ ] **Step 5: Wire navigation**

Clicking an island row in `IslandGrid` opens its town; `Escape` returns to the archipelago list. Keep the jump hotkey working in the list view and disable it inside the town view so it cannot fire unseen.

- [ ] **Step 6: Verify**

`npm test`, `npx tsc --noEmit`, `cargo test`, `cargo clippy --all-targets`. Then run the app, open a town, and confirm from the process output that the model arrived and the scene mounted without a panic. State plainly in the report that the visual result needs a human's eyes — and include the building/district counts the view received so the numbers can be sanity-checked against Task 5's previews.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(ui): open a town and see its city"
```

---

## Exit criteria

1. A repo cloned while the app runs appears after a focus or a rescan click.
2. The jump lands on the pane that actually stopped, in a multi-agent island.
3. A city model excludes generated and vendored files, buckets heights, and splits oversized districts.
4. The same repo lays out identically every time, and adding a file moves nothing.
5. Four real repos have been rendered and *looked at*, with an honest verdict on whether they read as cities.
6. A town opens in the app from the island list.
7. The city contains no file the user's own git configuration calls ignorable, and
   a test file is never painted as source. (Added with Task 5b — see below.)

---

## Task 5b (inserted during execution): The city shows the code, not the workspace

Not in the original plan. It comes from criterion 5 doing its job: the rendered
previews were *looked at*, and two honesty defects turned up that every green
test suite had missed.

1. **Git-ignored files were rendered as buildings.** The largest district in
   AgeOfAgents' own city was `.superpowers/sdd/2026-09-17-phase-0-5b-first-island`
   — 25 of 90 buildings were agent scratch, and `.gitignore` line 1 is
   `.superpowers/`. Worse, `my-site-next` rendered as visibly the same city
   two and a half times (767 districts / 2,429 buildings against git's 450
   directories / 1,385 files), because a complete git worktree copy lives at
   `.claude/worktrees/` inside the repo and `.next/standalone/` holds a third
   partial copy. Phase 0.5a's follow-ups predicted exactly this: "worktrees will
   need a deliberate answer there too."

   The fix replaces a hardcoded list of guesses with the user's own declaration
   of what is not code: `git ls-files --cached --others --exclude-standard`,
   which is tracked files plus untracked-but-not-ignored ones — so a file
   created thirty seconds ago still appears, as §4.2 requires. The hardcoded
   `EXCLUDED_DIRS` stays as a second filter, because git says nothing about a
   committed `dist/` or a lockfile, and the tree walk stays as the fallback for
   a non-git directory.

   The decisive detail: `.claude/worktrees/` is excluded by `.git/info/exclude`,
   **not** `.gitignore`. Any implementation that parses `.gitignore` itself would
   drop `.next/` and then draw the entire worktree copy anyway. Only
   `--exclude-standard` covers `.gitignore`, `.git/info/exclude` and global
   excludes together.

2. **Test files were painted as source.** `classify_kind` reached `Test` only via
   directory segments exactly `test`/`tests`/`__tests__` and filenames
   `test_*`/`*_test.*`/`*.test.*`. So pocketAlarm's `AlarmCoreTests` — the single
   largest district in that city, 30 buildings — rendered entirely in Source
   blue, as would every Java, C# and Ruby `spec/` suite and Angular's very common
   `*.spec.ts`. Widened with case-sensitive `Test`/`Tests`/`Spec`/`Specs` stem and
   directory-suffix matching, chosen case-sensitive precisely so `latest.ts`,
   `Latest.swift`, `contest.rs`, `attestation.go` and `Protest/` keep classifying
   correctly.

This task is also a large performance win that Task 6 depends on: building the
AgeOfAgents city previously walked 106,211 files to produce 90 buildings, and
`city_for` runs on a user click.
