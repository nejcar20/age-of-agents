//! Finding the git repositories under the user's projects directories — the
//! raw material for the spec's "unsettled land" (§5.1).
//!
//! This module deliberately does NOT decide which of them are already
//! settled. That question can only be answered from the live world's pane
//! cwds (`world::state::IslandAgent::cwd`), and it is answered once, in the
//! frontend, against the world the UI already renders — see
//! `founding.ts`'s `subtractSettled`.

use crate::world::repo::normalize_path;
use serde::Serialize;
use std::path::{Path, PathBuf};

// Task 2 of Phase 0.5a: this whole module is the discovery logic Task 3's
// `list_unsettled` Tauri command calls to offer unsettled repos to found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnsettledRepo {
    pub path: String,
    pub name: String,
}

/// Every scanned repo, named and sorted — with NO settled/unsettled
/// subtraction.
///
/// FINAL WHOLE-BRANCH REVIEW, Critical: subtracting here is what created the
/// split-brain state. The settled set can only be derived honestly from the
/// pane cwds in the live world (see `world::state::IslandAgent::cwd`), and
/// the frontend already holds that world via `useWorld`. Rust keeps what
/// only Rust can do — canonicalizing paths and walking the filesystem — and
/// the subtraction happens once, in `founding.ts`'s `subtractSettled`,
/// against the same world the rest of the UI renders. That makes the list
/// re-derive itself whenever the world changes, instead of needing a
/// debounced refetch, an optimistic removal, and a session-long
/// `foundedPaths` memo to paper over the gap between two sources of truth.
pub fn scanned_repos(entries: &[PathBuf]) -> Vec<UnsettledRepo> {
    // Opus review, MINOR 6: `candidate_roots` can emit a root nested under
    // another (e.g. a settled repo's parent alongside a conventional
    // ancestor directory that already contains it), so `scan_roots` can
    // scan the same repository twice and hand it to us twice. Deduped by
    // path here — the same identity `Island.root`/`Island.id` already use —
    // so a repository is never offered to the player more than once, the
    // same guarantee `build_archipelago_for_roots` already gives its own
    // callers.
    let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut found: Vec<UnsettledRepo> = entries
        .iter()
        .filter_map(|entry| {
            let path = entry.to_string_lossy().to_string();
            if !seen_paths.insert(path.clone()) {
                return None;
            }
            Some(UnsettledRepo { name: entry.file_name()?.to_string_lossy().to_string(), path })
        })
        .collect();

    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

/// Directories worth scanning for repos, best signal first. `exists` is injected
/// so the ordering logic can be tested without touching the filesystem.
///
/// `settled_roots` is used ONLY as a hint about where this user keeps code —
/// it no longer decides what gets offered (see `scanned_repos` above).
pub fn candidate_roots(
    home: &Path,
    settled_roots: &[String],
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let push = |candidate: PathBuf, roots: &mut Vec<PathBuf>| {
        if !roots.contains(&candidate) {
            roots.push(candidate);
        }
    };

    // 1. Where the user demonstrably already keeps repos.
    //
    // FINAL WHOLE-BRANCH REVIEW, minor: restricted to parents UNDER the
    // user's home. Without the containment check, a herdr pane running in a
    // repo under `/tmp` (or `/var/folders/.../T/...`, where every macOS temp
    // checkout lives) added `/tmp` as a scan root, and the app then walked
    // two levels of the system temp directory offering scratch checkouts as
    // the user's projects. A repo outside home is not evidence about where
    // this user keeps code.
    for root in settled_roots {
        if let Some(parent) = Path::new(root).parent() {
            if parent != home && parent != Path::new("/") && parent.starts_with(home) {
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

    // 3. Last resort: home itself. Scanned exactly like any other root now
    // (`scan_roots` is unbounded and prunes the same heavy directories
    // everywhere), not "shallowly" as a pre-Phase-0.5b comment here used to
    // say.
    if roots.is_empty() {
        roots.push(home.to_path_buf());
    }
    roots
}

/// Directory names that are either enormous dependency/build trees or tool
/// config directories that never contain a user's own git repositories, so
/// descending into them during discovery only spends time without ever
/// finding a project.
///
/// **This is what makes an unbounded scan fast, not a depth cap.**
/// `scan_one` already never descends into a directory once it identifies it
/// as a repo (repos are leaves of the walk, see below) — that property alone
/// already bounded the old depth-capped scan, and it still bounds this one.
/// This list prunes the other, larger half of the cost: heavy non-repo
/// containers (`node_modules` alone can be tens of thousands of directories)
/// that a real project tree is full of. Measured on the author's own
/// `~/Projects` (152 real repositories): an unbounded scan with this list
/// completes in well under a second — depth was never the bottleneck.
///
/// Deliberately a separate list from `city::model::EXCLUDED_DIRS`, even
/// though the two overlap heavily: that list decides what counts as the
/// user's own content INSIDE a repository whose existence is already known;
/// this one decides where discovery — which is looking for repositories, not
/// content — should not bother descending at all. A vendored git repository
/// nested inside `node_modules` would in principle be invisible to this
/// list's pruning; that is an accepted, documented trade-off (such a
/// checkout is not the user's own work) rather than a silent one.
const PRUNED_DIR_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".build",
    "vendor",
    ".next",
    "__pycache__",
    "DerivedData",
    "ModuleCache",
    ".gradle",
    "Pods",
    "Carthage",
    ".venv",
    "venv",
    ".tox",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".turbo",
    ".parcel-cache",
    ".svelte-kit",
    ".terraform",
    ".cargo",
    ".stack-work",
    ".claude",
    ".cache",
    ".npm",
    ".rustup",
    "Library",
    ".Trash",
];

/// Repos under `roots`. No depth cap — see `PRUNED_DIR_NAMES`'s doc comment
/// for why that is honest AND fast: a depth cap made 79 of the author's 152
/// real repositories invisible to the app with no indication anything was
/// skipped (a repo three or four directories below a scan root is common —
/// `PhotoStudio/Utils/Flows`, `Optics/tests/nlos`), and the thing that
/// actually bounds the walk (never descending into a directory once it is
/// identified as a repo, plus the pruning above) does not need a depth
/// ceiling to work.
///
/// This is the ONLY discovery scan in the app — `commands::
/// unsettled_report_for`, `commands::repo_name_is_ambiguous`, and
/// `city::archipelago::build_archipelago` all resolve to this same function
/// via `discovery_plan`, on purpose: two scans disagreeing about which
/// repositories exist (a depth-2 settle list next to an unbounded ambiguity
/// check) is exactly the shape of bug this function exists to prevent from
/// recurring.
pub fn scan_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for root in roots {
        let canonical_root = normalize_path(root);
        let mut open_ancestors: Vec<PathBuf> = vec![canonical_root.clone()];
        scan_one(&canonical_root, root, &mut found, &mut open_ancestors);
    }
    found
}

/// `dir_canonical` is the fully-resolved identity of `dir_actual` (which may
/// itself be reached through a symlink); `open_ancestors` holds the canonical
/// identity of every directory currently being visited on THIS branch of the
/// walk, root included.
///
/// Cycle guard: a plain directory tree can never contain a cycle on its own —
/// only a symlink can point back at a directory that is already open higher
/// up the current branch, which would otherwise make an unbounded walk
/// recurse forever. `entry.file_type()` is the un-followed (`lstat`-style)
/// type, already free from the `read_dir` call above, so computing a child's
/// canonical identity is a plain, free path join for the overwhelming
/// majority of entries (ordinary directories); only an actual symlink pays
/// one `canonicalize` call, to learn what it really points at before
/// checking whether that is already an open ancestor.
fn scan_one(
    dir_canonical: &Path,
    dir_actual: &Path,
    found: &mut Vec<PathBuf>,
    open_ancestors: &mut Vec<PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(dir_actual) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join(".git").exists() {
            // A repo's subdirectories are never separate projects. Checked
            // BEFORE the pruned-name check below on purpose: a directory
            // that happens to be named `build`, `target`, `dist`... is a
            // perfectly plausible real repository (a build-tool project, a
            // `target/` monorepo package) and must never be excluded by name
            // alone. Pruning by name only applies to a directory once it is
            // known NOT to be a repo itself — see `PRUNED_DIR_NAMES`'s doc
            // comment for the one remaining honest trade-off this leaves
            // (a repo nested INSIDE a pruned directory, e.g. vendored under
            // `node_modules`, stays invisible; a repo named like one does
            // not).
            //
            // Normalized (canonicalized where possible) so this matches
            // `Island.root`, which is produced by the same
            // `world::repo::normalize_path` — otherwise a repo reached
            // through a symlinked directory would scan to a different
            // spelling than its own island's root and never register as
            // settled (see the symlink regression test below).
            found.push(normalize_path(&path));
            continue;
        }
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if PRUNED_DIR_NAMES.contains(&name) {
                continue;
            }
        }
        let is_symlink = entry.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        let child_canonical =
            if is_symlink { normalize_path(&path) } else { dir_canonical.join(entry.file_name()) };
        if open_ancestors.contains(&child_canonical) {
            continue; // a cycle: this directory is already open higher up this branch
        }
        open_ancestors.push(child_canonical.clone());
        scan_one(&child_canonical, &path, found, open_ancestors);
        open_ancestors.pop();
    }
}

/// The roots every discovery caller in this app resolves identically: an
/// explicit `config.project_roots` wins outright; otherwise `candidate_roots`
/// picks where this user demonstrably keeps code (falling back to home
/// itself only as a last resort).
///
/// Centralized so `commands::unsettled_report_for`, `commands::
/// repo_name_is_ambiguous`, and `city::archipelago::build_archipelago`
/// cannot silently drift out of sync with each other about which
/// directories are even candidates — three independent copies of this exact
/// match existed before this fix, which is also what let `build_archipelago`
/// alone pass an empty `settled_roots` (see that function's doc comment).
///
/// No depth is returned any more: every caller now walks these roots with
/// the same unbounded `scan_roots` (see its doc comment for why that is
/// honest AND fast). Before this fix, this function *also* handed out a
/// depth — 1 for the home fallback, 2 for a real root — and
/// `repo_name_is_ambiguous` was the one caller that had to remember to
/// discard it and re-scan unbounded itself; that asymmetry is exactly how a
/// settle list and an ambiguity check ended up disagreeing about which
/// repositories exist. One function, one scan, one answer.
pub fn discovery_plan(
    config: &crate::config::Config,
    home: &Path,
    settled_roots: &[String],
) -> Vec<PathBuf> {
    match &config.project_roots {
        Some(configured) => configured.iter().map(|root| expand_home(root, home)).collect(),
        None => candidate_roots(home, settled_roots, &|path| path.is_dir()),
    }
}

/// `~` and `~/…` in a hand-written config mean the home directory, the way
/// a shell reads them; without this, `"~/work"` was a relative path to a
/// folder literally named `~` and found nothing.
fn expand_home(root: &str, home: &Path) -> PathBuf {
    match root.strip_prefix('~') {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with('/') => home.join(&rest[1..]),
        _ => PathBuf::from(root),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn configured_roots_expand_a_leading_tilde_like_a_shell() {
        let config = crate::config::Config {
            project_roots: Some(vec!["~/work".into(), "~".into(), "/abs/code".into(), "~other/x".into()]),
            ..Default::default()
        };
        assert_eq!(
            discovery_plan(&config, Path::new("/Users/you"), &[]),
            paths(&["/Users/you/work", "/Users/you", "/abs/code", "~other/x"]),
        );
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap_or_else(|e| panic!("failed to spawn git {args:?} in {cwd:?}: {e}"));
        assert!(status.success(), "git {args:?} failed in {cwd:?}");
    }

    #[test]
    fn every_scanned_repo_is_reported_with_its_directory_name() {
        let found = scanned_repos(&paths(&["/p/api", "/p/web", "/p/docs"]));
        assert_eq!(
            found.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec!["api", "docs", "web"]
        );
        assert_eq!(found[0].path, "/p/api");
    }

    #[test]
    fn results_are_sorted_by_name_not_by_scan_order() {
        let found = scanned_repos(&paths(&["/p/zebra", "/p/apple"]));
        assert_eq!(found[0].name, "apple");
        assert_eq!(found[1].name, "zebra");
    }

    #[test]
    fn scanning_nothing_yields_nothing() {
        assert!(scanned_repos(&[]).is_empty());
    }

    /// Opus review, MINOR 6: `candidate_roots` can emit a root nested under
    /// another (e.g. a settled repo's parent alongside a conventional
    /// ancestor directory that already contains it), so `scan_roots` scans
    /// the same repository twice and `found` (its input here) can contain
    /// the SAME path more than once. The archipelago's own dedup
    /// (`build_archipelago_for_roots`, keyed by canonical path) already
    /// guards this; `scanned_repos` must offer the same repository only
    /// once too, not present it to the player twice.
    #[test]
    fn the_same_repo_path_discovered_twice_is_reported_only_once() {
        let found = scanned_repos(&paths(&["/p/api", "/p/api", "/p/web"]));
        assert_eq!(
            found.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
            vec!["/p/api", "/p/web"],
            "a duplicate scanned path must be offered only once"
        );
    }

    #[test]
    fn scan_finds_only_directories_containing_a_dot_git() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a-repo/.git")).unwrap();
        std::fs::create_dir_all(dir.path().join("not-a-repo/src")).unwrap();

        let found = scan_roots(&[dir.path().to_path_buf()]);

        assert_eq!(found.len(), 1, "only the repo should be found, got {found:?}");
        assert!(found[0].ends_with("a-repo"));
    }

    #[test]
    fn scan_finds_repos_nested_one_level_down() {
        // ~/code/work/thing is as common as ~/code/thing.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work/thing/.git")).unwrap();
        std::fs::create_dir_all(dir.path().join("personal/other/.git")).unwrap();

        let found = scan_roots(&[dir.path().to_path_buf()]);
        let mut names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();

        assert_eq!(names, vec!["other", "thing"]);
    }

    #[test]
    fn scan_finds_a_repo_nested_three_or_four_levels_below_the_root() {
        // The exact defect this test guards against: a depth cap made 79 of
        // the author's 152 real repositories invisible with no indication
        // anything was skipped. `PhotoStudio/Utils/Flows` (depth 3) and
        // `Optics/tests/nlos` (depth 4, one deeper still) are the real shapes
        // that motivated removing the cap entirely.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("PhotoStudio/Utils/Flows/.git")).unwrap();
        std::fs::create_dir_all(dir.path().join("Optics/tests/nlos/deep/.git")).unwrap();

        let found = scan_roots(&[dir.path().to_path_buf()]);
        let mut names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();

        assert_eq!(
            names,
            vec!["Flows", "deep"],
            "a repository 3 or 4 directories below the scan root must still be found, got {found:?}"
        );
    }

    #[test]
    fn scan_does_not_descend_into_a_repo_it_already_found() {
        // A repo's subdirectories are not separate projects, even when vendored
        // dependencies carry their own .git.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("outer/.git")).unwrap();
        std::fs::create_dir_all(dir.path().join("outer/vendor/inner/.git")).unwrap();

        let found = scan_roots(&[dir.path().to_path_buf()]);

        assert_eq!(found.len(), 1, "expected only the outer repo, got {found:?}");
        assert!(found[0].ends_with("outer"));
    }

    #[test]
    fn a_worktree_nested_inside_its_own_main_repo_is_not_double_counted() {
        // Nested repos and worktrees have bitten this project before (Phase
        // 0.5a's worktree hole). A worktree placed INSIDE its own main repo
        // (a real, common layout: `repo/.worktrees/feature`) must not be
        // scanned as a second project — the main repo's `.git` is a real
        // directory, so `scan_one` never descends past it at all, exactly as
        // it never descends into `outer/vendor/inner` above.
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["-c", "init.defaultBranch=main", "init", "-q", "."]);
        run_git(&repo, &["config", "user.email", "test@example.com"]);
        run_git(&repo, &["config", "user.name", "Test User"]);
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-q", "-m", "init"]);

        let worktree = repo.join(".worktrees/feature");
        std::fs::create_dir_all(repo.join(".worktrees")).unwrap();
        run_git(&repo, &["worktree", "add", "-q", "-b", "wt", worktree.to_str().unwrap()]);
        assert!(worktree.join(".git").is_file(), "precondition: a worktree's .git is a file");

        let found = scan_roots(&[tmp.path().to_path_buf()]);

        assert_eq!(
            found.len(),
            1,
            "a nested worktree must not be double-counted alongside its own main repo, got {found:?}"
        );
        assert!(found[0].ends_with("repo"));
    }

    #[test]
    fn scanning_a_missing_directory_is_empty_not_an_error() {
        assert!(scan_roots(&[PathBuf::from("/definitely/not/here")]).is_empty());
    }

    #[test]
    fn scan_prunes_heavy_non_repo_directories_by_name() {
        // The performance half of removing the depth cap: a heavy dependency
        // tree must never be descended into looking for repos, regardless of
        // how deep a real repo might otherwise sit inside it.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("app/node_modules/some-pkg/.git")).unwrap();
        std::fs::create_dir_all(dir.path().join("app/target/debug/.git")).unwrap();
        std::fs::create_dir_all(dir.path().join("app/src/.git")).unwrap();

        let found = scan_roots(&[dir.path().to_path_buf()]);

        assert_eq!(found.len(), 1, "only the non-pruned repo should be found, got {found:?}");
        assert!(found[0].ends_with("src"));
    }

    #[test]
    fn a_real_repo_named_like_a_pruned_directory_is_still_found() {
        // The pruning above must never win against the `.git` check: a
        // directory literally named `build` or `target` is a perfectly
        // plausible real repository (a build-tool project), and pruning it
        // by name alone would silently omit the user's real source exactly
        // like the depth cap this whole fix removes.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("build/.git")).unwrap();
        std::fs::create_dir_all(dir.path().join("target/.git")).unwrap();

        let mut names: Vec<String> = scan_roots(&[dir.path().to_path_buf()])
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["build", "target"], "a repo must never be excluded by name alone");
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_cycle_does_not_hang_the_scan() {
        // Only a symlink can make a plain directory tree contain a cycle.
        // With no depth cap, this must be guarded some other way or an
        // unbounded scan would never terminate.
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(a.join("repo/.git")).unwrap();
        // a/loop -> a (a cycle back to an ancestor).
        std::os::unix::fs::symlink(&a, a.join("loop")).unwrap();

        let found = scan_roots(&[dir.path().to_path_buf()]);

        assert_eq!(found.len(), 1, "the cycle must not cause duplicate or endless scanning");
        assert!(found[0].ends_with("repo"));
    }

    #[test]
    #[cfg(unix)]
    fn a_repo_reached_through_a_symlink_scans_to_its_canonical_path() {
        // Regression (Phase 0.5a fix round 1, still load-bearing after the
        // final review moved the subtraction to the frontend): the frontend
        // cannot canonicalize, so EVERY path it compares must already be
        // canonical when it leaves Rust. A repo reached through a symlinked
        // directory (iCloud Drive, Dropbox, a symlinked `~/code`, ...) must
        // therefore scan to the same spelling that
        // `world::state::IslandAgent::cwd` carries — both go through
        // `world::repo::normalize_path` — or an already-settled repo would
        // be offered as unsettled forever, letting the user found a second
        // workspace on top of an existing one.
        let dir = tempfile::tempdir().unwrap();
        let real_parent = dir.path().join("real");
        std::fs::create_dir_all(real_parent.join("repo/.git")).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real_parent, &link).unwrap();

        let canonical = std::fs::canonicalize(real_parent.join("repo")).unwrap();

        // Scanned via the symlinked root, as a real filesystem walk would
        // reach it if the user's projects directory is itself a symlink.
        let found = scanned_repos(&scan_roots(&[link]));

        assert_eq!(found.len(), 1, "got {found:?}");
        assert_eq!(
            found[0].path,
            canonical.to_string_lossy(),
            "the frontend compares this string against a canonical pane cwd"
        );
    }

    #[test]
    fn a_worktree_is_scanned_as_a_repo_because_its_dot_git_is_a_file() {
        // FINAL WHOLE-BRANCH REVIEW, Critical — the first half of the
        // worktree hole. A worktree's `.git` is a FILE, and `Path::exists`
        // is true for it, so the walk lists worktrees alongside main repos.
        // That is CORRECT and stays: herdr has first-class worktree support
        // and founding one is legitimate. What was wrong is what subtracted
        // them again (see `commands::existing_workspace_for` and
        // `founding.ts`'s `subtractSettled`).
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["-c", "init.defaultBranch=main", "init", "-q", "."]);
        run_git(&repo, &["config", "user.email", "test@example.com"]);
        run_git(&repo, &["config", "user.name", "Test User"]);
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-q", "-m", "init"]);

        let worktree = tmp.path().join("repo-wt");
        run_git(&repo, &["worktree", "add", "-q", "-b", "wt", worktree.to_str().unwrap()]);
        assert!(worktree.join(".git").is_file(), "precondition: a worktree's .git is a file");

        let mut names: Vec<String> =
            scanned_repos(&scan_roots(&[tmp.path().to_path_buf()])).into_iter().map(|r| r.name).collect();
        names.sort();
        assert_eq!(names, vec!["repo", "repo-wt"]);
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
    fn a_settled_repo_outside_home_does_not_turn_its_parent_into_a_scan_root() {
        // FINAL WHOLE-BRANCH REVIEW, minor: derived roots had no containment
        // check, so a herdr pane running in `/tmp/scratch` (or `/var/folders/
        // .../T/...`, which is where every macOS temp checkout lives) added
        // `/tmp` as a scan root and the app walked two levels of the system
        // temp directory looking for the user's projects. Only parents that
        // sit under the user's home are evidence of where THEY keep code.
        let roots = candidate_roots(
            Path::new("/home/u"),
            &["/tmp/scratch".to_string(), "/home/u/dev/api".to_string()],
            &|_| false,
        );
        assert_eq!(
            roots,
            vec![PathBuf::from("/home/u/dev")],
            "only the parent under home is a scan root"
        );
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

    // ---- Phase 0.5b discovery-depth fix: discovery_plan / scan_roots ----

    #[test]
    fn discovery_plan_prefers_a_configured_root_over_discovery() {
        let config = crate::config::Config {
            project_roots: Some(vec!["/configured/root".to_string()]),
            ..Default::default()
        };
        let roots = discovery_plan(&config, Path::new("/home/u"), &[]);
        assert_eq!(roots, vec![PathBuf::from("/configured/root")]);
    }

    #[test]
    fn discovery_plan_falls_back_to_home_only_as_a_last_resort() {
        let config = crate::config::Config::default();
        let roots = discovery_plan(&config, Path::new("/home/u"), &[]);
        assert_eq!(roots, vec![PathBuf::from("/home/u")]);
    }

    /// The regression this whole fix exists for: a scan that stops at a
    /// fixed depth answers "does repo X exist" differently depending on
    /// which caller asks, because a depth-2 settle-list scan and an
    /// unbounded ambiguity-check scan used to be two different functions.
    /// Now there is only one `scan_roots`, so every caller sees the same
    /// repo at any depth.
    #[test]
    fn a_repo_three_levels_deep_is_found_the_same_way_a_shallow_one_is() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("PhotoStudio/photo-studio-frontend/.git"))
            .unwrap();
        std::fs::create_dir_all(
            dir.path().join("PhotoStudio/photo-workspace/photo-studio-frontend/.git"),
        )
        .unwrap();

        let found = scan_roots(&[dir.path().to_path_buf()]);
        assert_eq!(found.len(), 2, "both same-named repos, at different depths, must be found");
    }

    /// Real-machine report (`#[ignore]`d so CI never depends on this
    /// developer's disk; run by hand with `cargo test --lib
    /// world::unsettled -- --ignored --nocapture`): how many repositories
    /// the single, unbounded `scan_roots` finds under the author's own
    /// project roots, how long that takes, and how many colliding basenames
    /// it reports — the same number `commands::repo_name_is_ambiguous`
    /// answers from now that both go through this one function.
    #[test]
    #[ignore = "walks the real project tree on this machine"]
    fn report_the_real_repo_count_and_timing_for_the_authors_tree() {
        let home = dirs::home_dir().expect("no home directory");
        let config = crate::config::Config::default();
        let roots = discovery_plan(&config, &home, &[]);

        let start = std::time::Instant::now();
        let scanned = scan_roots(&roots);
        let elapsed = start.elapsed();
        let repos = scanned_repos(&scanned);

        fn collisions(repos: &[UnsettledRepo]) -> std::collections::HashMap<String, Vec<String>> {
            let mut by_name: std::collections::HashMap<String, Vec<String>> = Default::default();
            for repo in repos {
                by_name.entry(repo.name.clone()).or_default().push(repo.path.clone());
            }
            by_name.retain(|_, paths| paths.len() > 1);
            by_name
        }
        let collisions = collisions(&repos);

        println!("\n=== unbounded discovery scan under {roots:?} ===");
        println!("{} repositories found in {elapsed:?}", repos.len());
        println!("{} colliding basenames:", collisions.len());
        for (name, paths) in &collisions {
            println!("  {name}: {paths:?}");
        }
    }
}
