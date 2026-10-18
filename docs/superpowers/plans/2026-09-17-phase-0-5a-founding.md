# Phase 0.5a — Founding a Settlement: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user start a new Herdr workspace and agent from inside Age of Agents, so Herdr becomes invisible plumbing rather than a tool they must adopt and drive by hand.

**Architecture:** Two new write paths over the Herdr socket (`workspace.create`, `agent.start`), each on its own fresh connection like every other call. A pure "unsettled land" discovery function lists git repos under the projects dir that have no Herdr workspace yet. The UI adds an unsettled list plus a native folder picker, and every founding passes through a confirm sheet that shows the exact calls before anything runs.

**Tech Stack:** Tauri 2, Rust (tokio, serde, anyhow), React + TypeScript, vitest, `tauri-plugin-dialog`.

**Spec:** `docs/superpowers/specs/2026-09-16-age-of-agents-design.md` (§5.1 founding a town, §5.6 control contract)

## Global Constraints

- **Herdr 0.8.0, protocol 19.** Socket path resolution already exists in `herdr::socket_path::resolve`.
- **ONE request per connection.** `herdr.sock` closes after a single request; only `events.subscribe` streams. Every call in this plan opens its own connection via the existing `HerdrClient::connect` pattern (see `fetch_snapshot_fresh` in `herdr/events.rs`).
- **PERMITTED WRITES — this plan widens the list.** Phase 0 allowed only `agent.focus`, `workspace.focus`, `pane.focus`, `notification.show`. This phase adds exactly **`workspace.create`** and **`agent.start`**. Nothing else. Still forbidden: `pane.run`, `pane.send_text`, and any git write.
- **Full control (spec principle 1).** Nothing is created without the user pressing a key on a confirm sheet that names the exact calls and arguments. No auto-founding, no background creation.
- **Never slower than the terminal (principle 2).** No animation on the founding path.
- **Honest UI (principle 4).** A failed founding must say so; it must never leave the user believing a workspace exists.
- **Local only (principle 7).** No network, no accounts.
- `agent.start` params: `{name: string, kind: string, pane_id: string, args?: string[], timeout_ms?: u64}` — `timeout_ms` must be >3000 and <=300000.
- `workspace.create` params: `{cwd?: string, label?: string, focus?: bool, env?: map}`; the reply carries `workspace.workspace_id` and `root_pane.pane_id`.
- Installed agents on this machine: `claude` and `codex`, both in `~/.local/bin`.
- Rust 1.98.1 via rustup, NOT on a fresh shell's PATH: prefix cargo with `source "$HOME/.cargo/env" &&`, run from `src-tauri/`.
- Baseline to preserve: 78 Rust tests + 5 ignored live, 10 frontend tests, `tsc --noEmit` and `cargo clippy` clean.
- Every task ends with a passing test run and a commit.

---

### Task 1: Founding calls over the socket

**Files:**
- Create: `src-tauri/src/herdr/launch.rs`
- Modify: `src-tauri/src/herdr/mod.rs`

**Interfaces:**
- Consumes: `HerdrClient::connect`, `HerdrClient::call`.
- Produces:
  - `struct FoundedWorkspace { workspace_id: String, pane_id: String }`
  - `async fn create_workspace(path: &Path, cwd: &Path, label: &str) -> Result<FoundedWorkspace>` — `path` is the socket path
  - `async fn start_agent(path: &Path, pane_id: &str, name: &str, kind: &str) -> Result<()>`

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/herdr/launch.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::testing::FakeHerdr;
    use serde_json::json;
    use std::path::Path;

    #[tokio::test]
    async fn create_workspace_sends_cwd_and_label_and_reads_ids() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.method, "workspace.create");
            assert_eq!(req.params["cwd"], "/repos/api");
            assert_eq!(req.params["label"], "api");
            Ok(json!({
                "type": "workspace_created",
                "workspace": { "workspace_id": "w7" },
                "root_pane": { "pane_id": "w7:p1" }
            }))
        })
        .await;

        let founded = create_workspace(fake.path(), Path::new("/repos/api"), "api")
            .await
            .unwrap();

        assert_eq!(founded.workspace_id, "w7");
        assert_eq!(founded.pane_id, "w7:p1");
    }

    #[tokio::test]
    async fn create_workspace_surfaces_a_herdr_error() {
        let fake = FakeHerdr::start_one_request_per_connection(|_req| {
            Err(("invalid_request".to_string(), "bad cwd".to_string()))
        })
        .await;

        let err = create_workspace(fake.path(), Path::new("/nope"), "nope")
            .await
            .unwrap_err()
            .to_string();

        assert!(err.contains("bad cwd"), "error must name the cause, got: {err}");
    }

    #[tokio::test]
    async fn start_agent_sends_name_kind_and_pane() {
        let fake = FakeHerdr::start_one_request_per_connection(|req| {
            assert_eq!(req.method, "agent.start");
            assert_eq!(req.params["pane_id"], "w7:p1");
            assert_eq!(req.params["name"], "claude");
            assert_eq!(req.params["kind"], "claude");
            Ok(json!({ "type": "ok" }))
        })
        .await;

        start_agent(fake.path(), "w7:p1", "claude", "claude").await.unwrap();
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd src-tauri && source "$HOME/.cargo/env" && cargo test herdr::launch`
Expected: FAIL — `create_workspace` does not exist.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/herdr/launch.rs
//! The only two write paths this phase adds: founding a workspace and starting
//! an agent in it. Both open their own connection, because herdr serves exactly
//! one request per connection.

use crate::herdr::client::HerdrClient;
use anyhow::{anyhow, Result};
use serde_json::json;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundedWorkspace {
    pub workspace_id: String,
    pub pane_id: String,
}

pub async fn create_workspace(path: &Path, cwd: &Path, label: &str) -> Result<FoundedWorkspace> {
    let client = HerdrClient::connect(path).await?;
    let result = client
        .call(
            "workspace.create",
            json!({ "cwd": cwd.to_string_lossy(), "label": label, "focus": false }),
        )
        .await?;

    let workspace_id = result["workspace"]["workspace_id"]
        .as_str()
        .ok_or_else(|| anyhow!("herdr workspace.create returned no workspace_id: {result}"))?
        .to_string();
    let pane_id = result["root_pane"]["pane_id"]
        .as_str()
        .ok_or_else(|| anyhow!("herdr workspace.create returned no root pane: {result}"))?
        .to_string();

    Ok(FoundedWorkspace { workspace_id, pane_id })
}

pub async fn start_agent(path: &Path, pane_id: &str, name: &str, kind: &str) -> Result<()> {
    let client = HerdrClient::connect(path).await?;
    client
        .call(
            "agent.start",
            json!({ "pane_id": pane_id, "name": name, "kind": kind }),
        )
        .await?;
    Ok(())
}
```

Add `pub mod launch;` to `src-tauri/src/herdr/mod.rs`.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test herdr::launch`
Expected: 3 passed.

- [ ] **Step 5: Prove it against real Herdr**

Add this ignored test and run it:

```rust
#[tokio::test]
#[ignore = "requires a running herdr"]
async fn founds_a_real_workspace_and_starts_claude() {
    let home = dirs::home_dir().unwrap();
    let socket = crate::herdr::socket_path::resolve(
        None, &crate::herdr::socket_path::RealEnv, &home);
    let repo = home.join("Projects/AgeOfAgents");

    let founded = create_workspace(&socket, &repo, "aoa-launch-test").await.unwrap();
    println!("founded {founded:?}");
    start_agent(&socket, &founded.pane_id, "claude", "claude").await.unwrap();

    // Clean up so the user's session is left as we found it.
    let client = HerdrClient::connect(&socket).await.unwrap();
    client.call("workspace.close",
        serde_json::json!({ "workspace_id": founded.workspace_id })).await.unwrap();
}
```

Run: `cargo test founds_a_real_workspace_and_starts_claude -- --ignored --nocapture`
Expected: PASS. **If `agent.start`'s `kind` rejects `"claude"`, find the accepted value** (`herdr api schema --json`, or `herdr server agent-manifests`) and fix both the test and the caller. Report what the accepted kinds are.
Afterwards confirm `~/.local/bin/herdr workspace list` shows only the user's own workspaces.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(herdr): create a workspace and start an agent in it"
```

---

### Task 2: Unsettled land discovery

**Files:**
- Create: `src-tauri/src/world/unsettled.rs`
- Modify: `src-tauri/src/world/mod.rs`

**Interfaces:**
- Consumes: `WorldState` (for the islands that already exist).
- Produces:
  - `struct UnsettledRepo { path: String, name: String }`
  - `fn unsettled_repos(entries: &[PathBuf], settled_roots: &[String]) -> Vec<UnsettledRepo>` — pure, sorted by name
  - `fn candidate_roots(home: &Path, settled_roots: &[String], exists: &dyn Fn(&Path) -> bool) -> Vec<PathBuf>` — pure, ordered, deduped
  - `fn scan_roots(roots: &[PathBuf], max_depth: usize) -> Vec<PathBuf>` — repos found under those roots

Keeping the filtering pure and the filesystem walk separate is what makes this testable without a fixture tree.

**NO HARDCODED `~/Projects`.** That is one person's habit, not a convention. Where the
user keeps code is discovered, in this priority order:

1. **Where they already work.** Every existing island's repo root has a parent
   directory; those parents are the strongest possible signal, because the user
   demonstrably keeps repos there. This needs no guessing and no config.
2. **Common conventions that actually exist on this machine** — checked, not assumed:
   `Projects`, `code`, `Code`, `src`, `dev`, `Developer`, `repos`, `git`, `work`,
   `workspace`, all relative to home. Include only the ones that exist.
3. **Home itself**, if nothing else turned up — scanned at depth 1 only, so it stays cheap.

A configured `project_roots` list, when present, replaces all of that. And "browse…"
in the UI always works for anything outside every root, so discovery never becomes a
cage.

Nested layouts (`~/code/work/thing`, `~/code/personal/thing`) are common, so scanning
goes **two levels deep** and stops descending as soon as it finds a repo — a repo's
subdirectories are never themselves separate projects.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/world/unsettled.rs
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn lists_repos_that_have_no_workspace_yet() {
        let found = unsettled_repos(
            &paths(&["/p/api", "/p/web", "/p/docs"]),
            &["/p/web".to_string()],
        );
        assert_eq!(
            found.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec!["api", "docs"]
        );
    }

    #[test]
    fn results_are_sorted_by_name_not_by_scan_order() {
        let found = unsettled_repos(&paths(&["/p/zebra", "/p/apple"]), &[]);
        assert_eq!(found[0].name, "apple");
        assert_eq!(found[1].name, "zebra");
    }

    #[test]
    fn everything_settled_yields_nothing() {
        let found = unsettled_repos(&paths(&["/p/api"]), &["/p/api".to_string()]);
        assert!(found.is_empty());
    }

    #[test]
    fn scan_finds_only_directories_containing_a_dot_git() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a-repo/.git")).unwrap();
        std::fs::create_dir_all(dir.path().join("not-a-repo/src")).unwrap();

        let found = scan_roots(&[dir.path().to_path_buf()], 2);

        assert_eq!(found.len(), 1, "only the repo should be found, got {found:?}");
        assert!(found[0].ends_with("a-repo"));
    }

    #[test]
    fn scan_finds_repos_nested_one_level_down() {
        // ~/code/work/thing is as common as ~/code/thing.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work/thing/.git")).unwrap();
        std::fs::create_dir_all(dir.path().join("personal/other/.git")).unwrap();

        let found = scan_roots(&[dir.path().to_path_buf()], 2);
        let mut names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();

        assert_eq!(names, vec!["other", "thing"]);
    }

    #[test]
    fn scan_does_not_descend_into_a_repo_it_already_found() {
        // A repo's subdirectories are not separate projects, even when vendored
        // dependencies carry their own .git.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("outer/.git")).unwrap();
        std::fs::create_dir_all(dir.path().join("outer/vendor/inner/.git")).unwrap();

        let found = scan_roots(&[dir.path().to_path_buf()], 2);

        assert_eq!(found.len(), 1, "expected only the outer repo, got {found:?}");
        assert!(found[0].ends_with("outer"));
    }

    #[test]
    fn scanning_a_missing_directory_is_empty_not_an_error() {
        assert!(scan_roots(&[PathBuf::from("/definitely/not/here")], 2).is_empty());
    }

    #[test]
    fn candidates_prefer_the_parents_of_repos_the_user_already_works_in() {
        let roots = candidate_roots(
            Path::new("/home/u"),
            &["/home/u/dev/api".to_string(), "/home/u/dev/web".to_string()],
            &|_| false, // nothing conventional exists on this machine
        );
        assert_eq!(roots, vec![PathBuf::from("/home/u/dev")], "deduped to one parent");
    }

    #[test]
    fn candidates_include_conventional_directories_that_actually_exist() {
        let roots = candidate_roots(
            Path::new("/home/u"),
            &[],
            &|path| path == Path::new("/home/u/code"),
        );
        assert_eq!(roots, vec![PathBuf::from("/home/u/code")]);
    }

    #[test]
    fn candidates_fall_back_to_home_when_nothing_else_is_found() {
        let roots = candidate_roots(Path::new("/home/u"), &[], &|_| false);
        assert_eq!(roots, vec![PathBuf::from("/home/u")]);
    }

    #[test]
    fn a_repo_parent_is_not_repeated_when_it_is_also_conventional() {
        let roots = candidate_roots(
            Path::new("/home/u"),
            &["/home/u/code/api".to_string()],
            &|path| path == Path::new("/home/u/code"),
        );
        assert_eq!(roots, vec![PathBuf::from("/home/u/code")], "no duplicates");
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd src-tauri && cargo test world::unsettled`
Expected: FAIL — `unsettled_repos` does not exist.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/world/unsettled.rs
//! Git repositories under the projects directory that have no herdr workspace
//! yet — the spec's "unsettled land" (§5.1).

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnsettledRepo {
    pub path: String,
    pub name: String,
}

pub fn unsettled_repos(entries: &[PathBuf], settled_roots: &[String]) -> Vec<UnsettledRepo> {
    let mut found: Vec<UnsettledRepo> = entries
        .iter()
        .filter(|entry| {
            let as_str = entry.to_string_lossy();
            !settled_roots.iter().any(|root| root.as_str() == as_str)
        })
        .filter_map(|entry| {
            Some(UnsettledRepo {
                name: entry.file_name()?.to_string_lossy().to_string(),
                path: entry.to_string_lossy().to_string(),
            })
        })
        .collect();

    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

/// Directories worth scanning for repos, best signal first. `exists` is injected
/// so the ordering logic can be tested without touching the filesystem.
pub fn candidate_roots(
    home: &Path,
    settled_roots: &[String],
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push = |candidate: PathBuf, roots: &mut Vec<PathBuf>| {
        if !roots.contains(&candidate) {
            roots.push(candidate);
        }
    };

    // 1. Where the user demonstrably already keeps repos.
    for root in settled_roots {
        if let Some(parent) = Path::new(root).parent() {
            if parent != home && parent != Path::new("/") {
                push(parent.to_path_buf(), &mut roots);
            }
        }
    }

    // 2. Conventional names, but only the ones that really exist here.
    const CONVENTIONAL: [&str; 10] = [
        "Projects", "code", "Code", "src", "dev", "Developer", "repos", "git", "work",
        "workspace",
    ];
    for name in CONVENTIONAL {
        let candidate = home.join(name);
        if exists(&candidate) {
            push(candidate, &mut roots);
        }
    }

    // 3. Last resort: home itself, scanned shallowly by the caller.
    if roots.is_empty() {
        roots.push(home.to_path_buf());
    }
    roots
}

/// Repos under `roots`, descending at most `max_depth` levels and never
/// descending into a directory that is itself a repo.
pub fn scan_roots(roots: &[PathBuf], max_depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for root in roots {
        scan_one(root, max_depth, &mut found);
    }
    found
}

fn scan_one(dir: &Path, depth_left: usize, found: &mut Vec<PathBuf>) {
    if depth_left == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join(".git").exists() {
            // A repo's subdirectories are never separate projects.
            found.push(path);
        } else {
            scan_one(&path, depth_left - 1, found);
        }
    }
}
```

Add `pub mod unsettled;` to `src-tauri/src/world/mod.rs`.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test world::unsettled`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(world): list git repos that have no herdr workspace yet"
```

---

### Task 3: Config, commands, and the widened write policy

**Files:**
- Modify: `src-tauri/src/config.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Modify: `docs/superpowers/specs/2026-09-16-age-of-agents-design.md`

**Interfaces:**
- Consumes: Task 1's `create_workspace`/`start_agent`, Task 2's `unsettled_repos`/`scan_projects_dir`.
- Produces:
  - `Config.project_roots: Option<Vec<String>>` (unset means discover, see Task 2) and `Config.default_agent: Option<String>` (default: `"claude"`)
  - Command `list_unsettled() -> UnsettledReport { roots: Vec<String>, repos: Vec<UnsettledRepo> }` — the UI shows which roots were scanned, so discovery is never a black box
  - Command `found_settlement(path: String, start_agent: bool) -> Result<String, String>` returning the new workspace id

- [ ] **Step 1: Write the failing config tests**

```rust
// src-tauri/src/config.rs — add to the existing tests module
#[test]
fn project_roots_and_agent_default_to_none_meaning_discover() {
    let dir = tempfile::tempdir().unwrap();
    let config = Config::load(&dir.path().join("missing.json"));
    assert_eq!(config.project_roots, None);
    assert_eq!(config.default_agent, None);
}

#[test]
fn explicit_project_roots_and_agent_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let config = Config {
        terminal_app: None,
        notify_on_stop: true,
        project_roots: Some(vec!["/work".into(), "/side".into()]),
        default_agent: Some("codex".into()),
    };
    config.save(&path).unwrap();
    let loaded = Config::load(&path);
    assert_eq!(
        loaded.project_roots,
        Some(vec!["/work".to_string(), "/side".to_string()])
    );
    assert_eq!(loaded.default_agent.as_deref(), Some("codex"));
}

#[test]
fn a_config_written_before_this_feature_still_loads() {
    // Old files have no project_roots key at all; they must not fail to parse.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    std::fs::write(&path, r#"{"terminal_app":"iTerm","notify_on_stop":false}"#).unwrap();
    let loaded = Config::load(&path);
    assert_eq!(loaded.terminal_app.as_deref(), Some("iTerm"));
    assert_eq!(loaded.project_roots, None);
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd src-tauri && cargo test config`
Expected: FAIL — no `projects_dir` field.

- [ ] **Step 3: Add the fields**

Add to `Config` (keeping the existing `#[serde(default)]` style so old config files still load):

```rust
    #[serde(default)]
    pub project_roots: Option<Vec<String>>,
    #[serde(default)]
    pub default_agent: Option<String>,
```

Add matching `None` entries to `Default for Config`. `None` for `project_roots` means
discover (Task 2's `candidate_roots`), NOT a hardcoded directory. `default_agent`
falls back to `"claude"`.

- [ ] **Step 4: Add the commands**

```rust
// src-tauri/src/commands.rs
#[derive(serde::Serialize)]
pub struct UnsettledReport {
    /// The directories actually scanned, so the UI can show its working.
    pub roots: Vec<String>,
    pub repos: Vec<UnsettledRepo>,
}

#[tauri::command]
pub fn list_unsettled(state: tauri::State<'_, AppState>) -> UnsettledReport {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));

    let settled: Vec<String> = {
        let world = state.world.lock().unwrap();
        world.islands.iter().map(|island| island.root.clone()).collect()
    };

    // A configured list wins; otherwise discover where this user keeps code.
    let roots: Vec<PathBuf> = match &state.config.project_roots {
        Some(configured) => configured.iter().map(PathBuf::from).collect(),
        None => candidate_roots(&home, &settled, &|path| path.is_dir()),
    };

    // Home as a last-resort root is scanned shallowly; real roots go two deep.
    let depth = if roots.as_slice() == [home.clone()] { 1 } else { 2 };

    UnsettledReport {
        roots: roots.iter().map(|r| r.to_string_lossy().to_string()).collect(),
        repos: unsettled_repos(&scan_roots(&roots, depth), &settled),
    }
}

#[tauri::command]
pub async fn found_settlement(
    state: tauri::State<'_, AppState>,
    path: String,
    start_agent: bool,
) -> Result<String, String> {
    let repo = PathBuf::from(&path);
    let label = repo
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| format!("not a directory: {path}"))?;
    if !repo.join(".git").exists() {
        return Err(format!("{label} is not a git repository"));
    }

    let agent = state.config.default_agent.clone().unwrap_or_else(|| "claude".to_string());
    let home = dirs::home_dir().ok_or("no home directory")?;
    let socket = crate::herdr::socket_path::resolve(
        None, &crate::herdr::socket_path::RealEnv, &home);

    let founded = crate::herdr::launch::create_workspace(&socket, &repo, &label)
        .await
        .map_err(|e| e.to_string())?;

    if start_agent {
        crate::herdr::launch::start_agent(&socket, &founded.pane_id, &agent, &agent)
            .await
            .map_err(|e| format!("workspace created, but the agent did not start: {e}"))?;
    }

    Ok(founded.workspace_id)
}
```

Register both in `lib.rs`'s `generate_handler!`. Note the error text when the agent fails: the workspace DOES exist at that point, and principle 4 requires saying so rather than implying nothing happened.

- [ ] **Step 5: Record the policy change in the spec**

In `docs/superpowers/specs/2026-09-16-age-of-agents-design.md` §5.6, the control contract's "Explicit action" row must now read that Phase 0.5a additionally permits `workspace.create` and `agent.start`, each only behind a confirm sheet that displays the exact call. Add one sentence saying `pane.run`, `pane.send_text` and git writes remain forbidden.

- [ ] **Step 6: Run everything**

Run: `cd src-tauri && cargo test` (expected: all pass, including the new config tests) and `cargo clippy --all-targets` (expected: clean).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: found a settlement from the app, behind the control contract"
```

---

### Task 4: The founding UI

**Files:**
- Create: `src/components/UnsettledList.tsx`, `src/founding.ts`, `src/founding.test.ts`
- Modify: `src/App.tsx`, `src/world.ts`, `src/styles.css`, `package.json`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `list_unsettled`, `found_settlement`.
- Produces:
  - `type Unsettled = { path: string; name: string }`
  - `foundingSummary(repo: Unsettled, agent: string, startAgent: boolean): string[]` — the exact lines the confirm sheet shows

- [ ] **Step 1: Write the failing test**

```ts
// src/founding.test.ts
import { describe, expect, it } from "vitest";
import { foundingSummary } from "./founding";

const repo = { path: "/Users/me/Projects/api", name: "api" };

describe("foundingSummary", () => {
  it("names the exact herdr calls, so nothing runs unseen", () => {
    expect(foundingSummary(repo, "claude", true)).toEqual([
      'workspace.create  cwd="/Users/me/Projects/api"  label="api"',
      'agent.start       name="claude"  kind="claude"',
    ]);
  });

  it("omits the agent line when only a shell is wanted", () => {
    expect(foundingSummary(repo, "claude", false)).toEqual([
      'workspace.create  cwd="/Users/me/Projects/api"  label="api"',
    ]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — cannot resolve `./founding`.

- [ ] **Step 3: Implement the summary**

```ts
// src/founding.ts
export type Unsettled = { path: string; name: string };

export function foundingSummary(
  repo: Unsettled,
  agent: string,
  startAgent: boolean,
): string[] {
  const lines = [
    `workspace.create  cwd="${repo.path}"  label="${repo.name}"`,
  ];
  if (startAgent) {
    lines.push(`agent.start       name="${agent}"  kind="${agent}"`);
  }
  return lines;
}
```

- [ ] **Step 4: Run the test**

Run: `npm test`
Expected: the two new tests pass alongside the existing 10.

- [ ] **Step 5: Add the dialog plugin for "browse…"**

```bash
npm install @tauri-apps/plugin-dialog
cd src-tauri && source "$HOME/.cargo/env" && cargo add tauri-plugin-dialog
```

Register it in `lib.rs` (`.plugin(tauri_plugin_dialog::init())`) and add `"dialog:allow-open"` to `src-tauri/capabilities/default.json`. Folder selection uses `open({ directory: true })`.

- [ ] **Step 6: Build the list and the confirm sheet**

`UnsettledList.tsx` renders the repos returned by `list_unsettled` under a heading that makes their status obvious ("Unsettled — no herdr workspace yet"), each row a button. Clicking one, or choosing a folder via "browse…", opens a confirm sheet that renders `foundingSummary(...)` in a monospace block with a checkbox for "start <agent>" (default on, per the chosen design) and a "Found settlement" button.

**Show which directories were scanned.** The report's `roots` go in a quiet line under
the heading ("looked in ~/code, ~/dev"). Discovery that cannot be seen is discovery the
user cannot correct, and on a machine with an unusual layout the honest outcome is an
empty list plus a visible reason — never a silent nothing. When the list is empty, say
so in terms of the roots scanned and point at "browse…".

Requirements the sheet must meet:
- Nothing is called until the button is pressed (principle 1).
- No animation on this path (principle 2).
- On failure, show the error text verbatim — especially the "workspace created, but the agent did not start" case, which must not read as a clean failure (principle 4).
- Refresh the unsettled list after a successful founding; the new island arrives on its own via `world-updated`.

- [ ] **Step 7: Verify against the real app**

Run `source "$HOME/.cargo/env" && npm run tauri dev`. Confirm: the unsettled list shows real repos from `~/Projects` and excludes any that already have a workspace; founding one makes an island appear within about a second; the agent actually starts in that pane (check with `~/.local/bin/herdr api snapshot`).
Clean up every workspace created during testing, and leave `~/.local/bin/herdr workspace list` showing only the user's own.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(ui): found a settlement from the unsettled list or a chosen folder"
```

---

## Exit criteria

1. The unsettled list shows real repos and hides ones already settled.
2. Founding creates a workspace and starts the configured agent, and the island appears without a restart.
3. Nothing is created without the confirm sheet, and the sheet names the exact calls.
4. A failed agent start says the workspace exists anyway.
5. The spec's control contract records the two newly permitted writes.
