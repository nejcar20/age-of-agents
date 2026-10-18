//! The city model: a pure translation of a repository's file tree into
//! districts (directories) and buildings (files).
//!
//! Generation quality is called out in the Phase 0.5b spec as the top
//! design risk of the whole product: a city that reads as a scatter plot,
//! or where a `migrations` folder becomes 400 identical huts, or a
//! lockfile becomes the tallest tower, fails regardless of how good the
//! renderer is. The rules enforced here (exclusion, height buckets, the
//! per-district building cap) are that design, not incidental filtering.
//!
//! All filesystem access is isolated behind the `FileSource` trait (see
//! `RealFiles` below), exactly the way `world::repo::GitProbe` isolates
//! `git` and `herdr::socket_path::EnvSource` isolates the environment
//! elsewhere in this codebase. `build_city` itself never touches disk, so
//! it is fully exercised by the `FakeFiles`-based tests with no fixture
//! tree required.

use crate::world::repo::{normalize_path, run_with_timeout};
use serde::Serialize;
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Anything found under one of these directory names, at any depth, is
/// generated or vendored and must never become a building — counted in
/// `CityModel::skipped` instead.
///
/// Fix round (Task 5 review): the original list caught `build` but not
/// `.build` — Xcode's own DerivedData/SwiftPM build tree — so a Swift repo's
/// city was mostly a picture of its compiler cache (`ModuleCache`, per-arch
/// `arm64`/`x86_64` object dirs, hashed `.xcbuilddata` blobs) rather than of
/// the user's code, which is exactly the "a lockfile becomes the tallest
/// tower" failure spec principle 4 warns against, just at the directory
/// level instead of the file level. Extended to cover the equivalent
/// build/dependency/cache directory for every other toolchain this repo is
/// likely to meet, not just the one real repo that surfaced the gap.
const EXCLUDED_DIRS: &[&str] = &[
    ".git",
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
];

/// Like `EXCLUDED_DIRS`, but only when the name is the REPO ROOT's own
/// immediate child directory — not matched at any deeper segment.
///
/// Fix round (Task 5 review, SMALL 2): `out` and `coverage` are genuinely
/// ambiguous names, unlike `.build` or `ModuleCache` — a real
/// `src/formatters/out/` module or a fixtures directory literally named
/// `coverage` is plausible source, and `EXCLUDED_DIRS`'s any-depth match
/// would have silently swallowed either with no way for the user to
/// notice. Both names are common ONLY as a build/test-report directory
/// sitting directly at a repo's root, so that's the only place they're
/// excluded; the same name nested deeper survives untouched.
const EXCLUDED_ROOT_ONLY_DIRS: &[&str] = &["out", "coverage"];

/// Directory-name segments that mark a directory as a test directory, for
/// both `BuildingKind::Test` classification and `test_target_names` below.
const TEST_DIR_SEGMENTS: &[&str] = &["test", "tests", "__tests__"];

/// Above this many buildings a district reads as a scatter plot rather
/// than a place a person could stand in. Carried as a controller ruling
/// into this task: the split is mandatory here, not deferred to Task 4's
/// plot sizing, because Task 4's own tests would still pass while a real
/// repository produced one monstrous plot.
const MAX_BUILDINGS_PER_DISTRICT: usize = 40;

/// Files with more lines than this are generated/vendored artifacts (e.g.
/// a checked-in bundle or a data dump), not hand-authored buildings,
/// regardless of where they live.
const MAX_LINES: u32 = 50_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum BuildingKind {
    Source,
    Test,
    Config,
    Docs,
    Asset,
    Data,
}

#[derive(Debug, Clone, Serialize)]
pub struct Building {
    pub path: String,
    pub name: String,
    pub kind: BuildingKind,
    pub lines: u32,
    pub height: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct District {
    pub path: String,
    pub name: String,
    pub buildings: Vec<Building>,
    pub walled: bool,
    pub depth: u8,
    /// The identity `city::layout`'s persisted cache keys on — see
    /// `split_into_plots`'s doc comment for why this is NOT always equal to
    /// `path`. Never shown to the player and never used for anything other
    /// than a `LayoutCache` lookup key.
    pub cache_key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CityModel {
    pub root: String,
    pub name: String,
    pub districts: Vec<District>,
    pub skipped: u32,
    /// Git submodules found at `root` — a "gitlink" entry in git's file
    /// listing, pointing at what is, on disk, a separate repository's own
    /// checkout directory, never a text file. Counted separately from
    /// `skipped` on purpose: a submodule is not an unreadable/broken file
    /// (which is what `skipped` means), it is a deliberate exclusion of
    /// someone else's pinned repository — see `RealFiles::files` for why
    /// drawing its contents as part of THIS city would be the exact
    /// `node_modules` problem this task exists to fix, just one level up.
    pub submodules: u32,
    /// Which mechanism actually produced this model's file list — see
    /// `CitySource`. Important 3 (Phase 0.5b final-fix review): before
    /// this field existed, a degraded `RealFiles` run (git missing, the
    /// index locked, the 10s `ls_files` timeout expiring) silently
    /// rendered a materially different city — a raw filesystem walk,
    /// gitignored build output and all — through the exact same shape as
    /// a healthy one, with nothing in the model or the rendered SVG
    /// telling the user which they were looking at.
    pub source: CitySource,
}

/// Which of `RealFiles`'s two paths produced a `CityModel`'s file list.
///
/// `RealFiles` prefers to ask `git` (`GitFiles::ls_files`) and only falls
/// back to a raw filesystem walk when `root` isn't a git repository, `git`
/// is missing, or the call otherwise failed (including the `RealGitFiles`
/// 10s timeout expiring). The two are NOT interchangeable: the walk applies
/// only `EXCLUDED_DIRS` — so gitignored build output, `.env` files, and
/// other generated sources can appear as buildings — silently drops
/// symlinks, and never detects submodules (`CityModel::submodules` reads
/// `0` even if the repo has real ones). See `CityModel::source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum CitySource {
    /// `git`'s own answer: `GitFiles::ls_files` succeeded.
    Git,
    /// A best-effort filesystem guess, taken only because the git path was
    /// unavailable this time.
    Walk,
}

/// Injected file discovery, mirroring `world::repo::GitProbe` and
/// `herdr::socket_path::EnvSource`: `build_city` depends only on this
/// trait, never on the filesystem directly.
pub trait FileSource {
    /// Every file under `root`, as `(path, line_count)`. `None` means the
    /// file could not be read as UTF-8 text (a binary artifact, or an I/O
    /// error) — `build_city` counts it in `skipped` and builds no
    /// building for it, rather than defaulting to `0` lines and rendering
    /// a substantial file (a `.wasm`, a `.db`, a compiled artifact) as a
    /// trivial one.
    ///
    /// Implementations are free to report `Some(0)` as a placeholder for
    /// paths they already know `build_city` will exclude by path alone —
    /// see `RealFiles` below.
    fn files(&self, root: &Path) -> Vec<(PathBuf, Option<u32>)>;

    /// How many git submodules ("gitlink" entries) `files` found and
    /// excluded from its result during its most recent call for this same
    /// `root` — see `CityModel::submodules`. Reported through a SEPARATE
    /// method rather than a third state on `files`'s `Option<u32>` (which
    /// would force every implementation, including every `FakeFiles` test
    /// double in this codebase and `city::layout`'s own, to learn about a
    /// concept that is meaningless to them) — the default implementation
    /// is simply "none", so nothing with no concept of submodules needs
    /// to change. `build_city` always calls this immediately after
    /// `files` for the same `root`, so an implementation that tracks this
    /// per-call (like `RealFiles`) can rely on that ordering.
    fn submodules(&self, _root: &Path) -> u32 {
        0
    }

    /// Which `CitySource` produced `files`'s most recent answer for this
    /// same `root` — see `CityModel::source`. Reported the same way as
    /// `submodules`: a separate method, called immediately after `files`,
    /// rather than a third state threaded through `files`'s own return
    /// type, so every implementation with no concept of "degraded"
    /// (every test double in this codebase, and `city::layout`'s own)
    /// needs no change at all. The default answer is `Git`: every
    /// `FileSource` other than `RealFiles` already reports a repo's real,
    /// complete file set with nothing silently substituted for it.
    fn source(&self, _root: &Path) -> CitySource {
        CitySource::Git
    }
}

/// Injected `git ls-files` invocation, mirroring `world::repo::GitProbe`:
/// isolates the actual `git` call so `RealFiles`'s git-aware fast path —
/// and its fallback when `git` fails or `root` isn't a repository at all —
/// are both testable without a real repository, or a failing `git`
/// binary, on disk.
pub trait GitFiles {
    /// Every path git considers part of `root`'s working tree — tracked
    /// files plus untracked-but-not-ignored ones — as paths relative to
    /// `root`. This is `git ls-files --cached --others --exclude-standard`
    /// (`-C root`, `-z`): the union of "committed" and "new but not
    /// ignored", which is exactly "the user's real code" — a hand-rolled
    /// `.gitignore` parser would miss `.git/info/exclude` and global
    /// excludes entirely (see the Task 5b brief's Appendix on nested git
    /// worktrees, which are excluded that way, not via `.gitignore`).
    ///
    /// `None` means `root` is not (inside) a git repository, or the
    /// invocation otherwise failed (e.g. `git` not installed): the caller
    /// must fall back to a full filesystem walk in that case rather than
    /// treat `None` as "empty repository" — an empty city would be a false
    /// claim that the repo has no code.
    fn ls_files(&self, root: &Path) -> Option<Vec<PathBuf>>;
}

/// The real `git` invocation used in production.
///
/// Review finding: `city_for` (the next task) runs this on a user click,
/// so a `git` that never returns — a stalled credential-helper prompt, an
/// index lock held by another process, a stuck network mount — must never
/// block forever. `timeout` bounds the wait; past it the child is killed
/// and `ls_files` reports failure exactly like any other invocation
/// problem, so `RealFiles` falls back to the ordinary walk. It is a field
/// (with `DEFAULT_TIMEOUT` as the production default via `Default`)
/// rather than a hardcoded constant specifically so the expiry path is
/// testable: a test can build a `RealGitFiles` with a tiny timeout.
pub struct RealGitFiles {
    timeout: Duration,
}

impl RealGitFiles {
    /// Generous but finite: real repositories on a real disk finish in
    /// milliseconds, so this ceiling only ever matters when something has
    /// genuinely gone wrong (see the struct doc comment).
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

    pub fn new(timeout: Duration) -> Self {
        RealGitFiles { timeout }
    }
}

impl Default for RealGitFiles {
    fn default() -> Self {
        RealGitFiles::new(Self::DEFAULT_TIMEOUT)
    }
}

impl GitFiles for RealGitFiles {
    fn ls_files(&self, root: &Path) -> Option<Vec<PathBuf>> {
        let mut cmd = Command::new("git");
        cmd.args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
        cmd.current_dir(root);
        let out = run_with_timeout(cmd, self.timeout)?;
        if !out.status.success() {
            return None;
        }
        // `-z` NUL-delimits entries instead of newline-delimiting and
        // quoting them: a filename may itself contain a newline, which
        // git would otherwise quote in a way that's easy to corrupt by
        // splitting naively. The trailing split segment after the final
        // NUL is empty and filtered out.
        Some(
            out.stdout
                .split(|&b| b == 0)
                .filter(|chunk| !chunk.is_empty())
                .map(bytes_to_relative_path)
                .collect(),
        )
    }
}

// `run_with_timeout` — the race-free kill/drain-while-polling mechanism
// `ls_files` above delegates to — used to live here. Phase 0.5b final-fix
// review, Important 5: `world::repo::RealGit` (the `git rev-parse` probe
// run synchronously on Herdr's event-loop task) needed the exact same
// protection against a hung `git`, so the function moved to
// `crate::world::repo` (which this module already depends on, via
// `normalize_path`) and both call sites now share one implementation
// instead of a second, drifting copy. See it there for the full doc
// comment and its dedicated tests.

/// Converts one NUL-delimited `git ls-files -z` entry back into a path
/// without round-tripping it through `String`/UTF-8 validation, which
/// would corrupt (or silently drop) a path containing bytes that are not
/// valid UTF-8. This app currently only targets macOS, so the unix
/// byte-for-byte reinterpretation is exact; elsewhere a lossy fallback is
/// acceptable rather than pulling in wide-string handling for a platform
/// this app doesn't run on.
fn bytes_to_relative_path(bytes: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
    }
}

/// The real, disk-backed `FileSource`.
///
/// Asks `git` for the file set whenever `root` is inside a git repository
/// (see `GitFiles`): `git ls-files --cached --others --exclude-standard`
/// is exactly "everything in the working tree the user's own `.gitignore`
/// (plus `.git/info/exclude` and global excludes) does not hide" — a far
/// better and more honest declaration of "this is not my code" than any
/// hardcoded list can be, and it also means we no longer need to walk
/// `node_modules`/`target`/etc. at all (a large performance win: on this
/// project's own repo, replacing a 106k-file walk with one `git` call).
///
/// `EXCLUDED_DIRS`/`EXCLUDED_ROOT_ONLY_DIRS`/lockfile/minified-bundle
/// exclusion still applies to git's answer: git says nothing about a
/// *committed* `dist/`, a lockfile, or a minified bundle, and those rules
/// still earn their keep on tracked files.
///
/// Falls back to walking the *entire* tree, including excluded
/// directories, when `root` is not a git repository (or `git` fails for
/// any other reason) so that `CityModel::skipped` can still reflect an
/// honest per-file count rather than silently undercounting whatever a
/// non-git directory buries under `node_modules`/`target`. Either path
/// skips *reading the content* of a file it already knows `build_city`
/// will exclude by path or name alone (an excluded-directory file, a
/// lockfile, a minified bundle) — those never need a line count, and a
/// real repository can put tens of thousands of files under
/// `node_modules` alone, so avoiding that read matters.
pub struct RealFiles {
    git: Box<dyn GitFiles + Send + Sync>,
    /// How many git submodules `files` excluded during its most recent
    /// call — see `FileSource::submodules`. A `Cell` (not thread-shared
    /// state; `RealFiles` is only ever used by reference from a single
    /// call site at a time) rather than a return value because `files`'s
    /// signature is shared with every other `FileSource`, most of which
    /// have no submodules to report at all.
    submodule_count: Cell<u32>,
    /// Which `CitySource` the most recent `files` call actually used —
    /// see `FileSource::source`. Same `Cell`-not-return-value reasoning as
    /// `submodule_count`.
    source: Cell<CitySource>,
}

impl RealFiles {
    pub fn new(git: Box<dyn GitFiles + Send + Sync>) -> Self {
        RealFiles { git, submodule_count: Cell::new(0), source: Cell::new(CitySource::Git) }
    }
}

impl FileSource for RealFiles {
    fn files(&self, root: &Path) -> Vec<(PathBuf, Option<u32>)> {
        if let Some(relative_paths) = self.git.ls_files(root) {
            let mut submodules = 0u32;
            let mut out = Vec::with_capacity(relative_paths.len());
            // Critical 1 (Phase 0.5b final-fix review): `git ls-files`
            // emits an UNMERGED (conflicted) path once PER STAGE — a `UU`
            // conflict prints the same path three times, one per stage
            // 1/2/3 — so without this, one real conflicted file would
            // become three identical `Building`s in the same district,
            // placed at three different cells by `gnomon_position`, and
            // `count_lines` would read the file three times over. A merge
            // conflict is exactly when a stopped agent's town is most
            // likely to be opened, so this is not an edge case. Git has
            // no single portable flag for this across the versions this
            // app might run against (a plain `--deduplicate` exists on
            // newer git but isn't relied on here), so it's deduplicated
            // on our own side instead: a `HashSet` of paths already seen,
            // preserving first-seen order and never touching two
            // genuinely distinct paths that merely share no relation to
            // each other.
            let mut seen: HashSet<PathBuf> = HashSet::with_capacity(relative_paths.len());
            for relative in relative_paths {
                if !seen.insert(relative.clone()) {
                    continue;
                }
                let path = root.join(&relative);
                // Review finding: a git submodule is reported by
                // `ls-files` as one ordinary-looking path (a "gitlink"),
                // but on disk that path is the submodule's OWN checkout
                // directory — never a text file. Detecting that up front
                // (rather than discovering it when `count_lines`'s
                // `read_to_string` fails on a directory) makes this a
                // deliberate, distinctly-counted decision instead of a
                // silent accident laundered through `skipped` (which
                // means "an unreadable/broken file", not "a whole
                // separate repository"). The exclusion itself is
                // intentional and correct: a submodule is someone else's
                // pinned repository, not this city's code — drawing its
                // contents here would be exactly the `node_modules`
                // problem this task exists to fix, one level up. It gets
                // its own city when the user opens it directly, not a
                // silent absorption into this one.
                if is_gitlink_directory(&path) {
                    submodules += 1;
                    continue;
                }
                let lines = if is_excluded_path(root, &path)
                    || is_lockfile(&path)
                    || is_minified(&path)
                {
                    Some(0)
                } else {
                    count_lines(&path)
                };
                out.push((path, lines));
            }
            self.submodule_count.set(submodules);
            self.source.set(CitySource::Git);
            return out;
        }
        self.submodule_count.set(0);
        self.source.set(CitySource::Walk);
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out
    }

    fn submodules(&self, _root: &Path) -> u32 {
        self.submodule_count.get()
    }

    fn source(&self, _root: &Path) -> CitySource {
        self.source.get()
    }
}

/// True only for an actual directory at `path` — a real submodule
/// checkout — and never for a symlink to one.
///
/// Review finding (round 2): `Path::is_dir()` goes through `fs::metadata`,
/// which FOLLOWS symlinks. A git-tracked symlink that happens to point at
/// a directory is listed by `ls-files` as an ordinary blob (mode
/// `120000`), so `is_dir()` on it would return `true` — silently dropping
/// a real tracked file from the city AND inflating `submodules` with a
/// submodule that does not exist, both failure directions of this task at
/// once. `symlink_metadata` uses `lstat` semantics (does not follow the
/// final symlink), so a symlink-to-a-directory correctly reports `false`
/// here and falls through to `count_lines`, which fails to read a
/// directory as text and lands it in `skipped` — honest either way (never
/// silently dropped, never drawn as if it were the submodule it merely
/// points at), in the same spirit as the plain filesystem walk's own
/// refusal to draw a symlink as a building at all (see `walk` below).
fn is_gitlink_directory(path: &Path) -> bool {
    path.symlink_metadata().map(|m| m.file_type().is_dir()).unwrap_or(false)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(PathBuf, Option<u32>)>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            // Never follow symlinks: avoids cycles and double-counted files.
            continue;
        }
        if file_type.is_dir() {
            walk(root, &path, out);
        } else if file_type.is_file() {
            let lines = if is_excluded_path(root, &path) || is_lockfile(&path) || is_minified(&path)
            {
                Some(0)
            } else {
                count_lines(&path)
            };
            out.push((path, lines));
        }
    }
}

/// Reads `path` and counts `\n` bytes. Returns `None` when the file fails
/// to read as UTF-8 text (or fails to read at all) — a binary artifact
/// (`.wasm`, `.db`, a compiled blob) must be counted in `skipped`, not
/// rendered as a trivial height-1 building.
fn count_lines(path: &Path) -> Option<u32> {
    match std::fs::read_to_string(path) {
        Ok(content) => Some(content.matches('\n').count() as u32),
        Err(_) => None,
    }
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// Segments of `path`'s *ancestor directories*, RELATIVE TO `root` — i.e.
/// everything between `root` and the file name itself. Used for every
/// "lives under a directory named X" rule so a file that merely happens to
/// be named like a directory (e.g. a file literally called `test`) is
/// never misclassified.
///
/// Critical 2 (Phase 0.5b final-fix review): this used to scan `path`'s
/// entire ABSOLUTE path, including everything ABOVE `root` — segments the
/// repository has no say over and the user did not name as part of their
/// project. Two consequences, both verified live: a repo checked out
/// under `~/Projects/Tests/speech.cpp` had every file misclassified
/// `Test` (the ancestor segment `Tests` satisfies `ends_with("Tests")` in
/// `is_test_dir_segment_for_classification`), turning the whole city
/// Test-green and, since `build_city` walls any district owning a Test
/// building, giving every district a fabricated wall; a repo checked out
/// under `~/build/myrepo` had every file excluded (`build` is in
/// `EXCLUDED_DIRS`), rendering as bare land while `skipped` claimed the
/// repo had nothing in it. Deriving segments from `path.strip_prefix(root)`
/// instead means only directories genuinely inside the repository can ever
/// match. `path` not actually being under `root` degrades safely (falls
/// back to scanning `path` as given) rather than panicking — defensive
/// only; every real caller derives `path` from walking `root` itself.
fn ancestor_segments<'a>(root: &Path, path: &'a Path) -> impl Iterator<Item = &'a str> {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative
        .parent()
        .into_iter()
        .flat_map(|p| p.components())
        .filter_map(|c| c.as_os_str().to_str())
}

/// `root`-only names (`EXCLUDED_ROOT_ONLY_DIRS`) are checked separately
/// from the any-depth `EXCLUDED_DIRS`: only `path`'s FIRST path segment
/// relative to `root` is compared against that list, so a nested
/// `src/formatters/out/` (whose first segment relative to root is `src`,
/// not `out`) is never touched by it — see that constant's doc comment.
/// A `path` that isn't actually under `root` (defensive; should not
/// happen given every caller derives `path` from walking `root` itself)
/// simply skips the root-only check rather than panicking.
///
/// Task 5b review finding (defect 3): the first relative component is only
/// an eligible match when it is an ANCESTOR DIRECTORY of `path` — i.e. it
/// is not the relative path's only/final component. Without that check, a
/// root-level FILE literally named `out` or `coverage` (no extension)
/// would match `rel.components().next()` too, even though it is a file,
/// not a directory — the any-depth `EXCLUDED_DIRS` rule above never
/// excludes a file by its own basename, only by an ancestor directory's
/// name, and this rule must keep that same distinction.
fn is_excluded_path(root: &Path, path: &Path) -> bool {
    if ancestor_segments(root, path).any(|seg| EXCLUDED_DIRS.contains(&seg)) {
        return true;
    }
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    let mut components = rel.components();
    let Some(first) = components.next() else {
        return false;
    };
    if components.next().is_none() {
        // Only one component: `first` IS the file itself, not an
        // ancestor directory — never excluded by this rule.
        return false;
    }
    first.as_os_str().to_str().is_some_and(|first| EXCLUDED_ROOT_ONLY_DIRS.contains(&first))
}

fn is_lockfile(path: &Path) -> bool {
    let name = file_name(path);
    name.ends_with(".lock")
        || name == "package-lock.json"
        || name == "Cargo.lock"
        || name == "yarn.lock"
        || name == "pnpm-lock.yaml"
}

fn is_minified(path: &Path) -> bool {
    let name = file_name(path);
    name.ends_with(".min.js") || name.ends_with(".min.css")
}

fn is_test_dir_segment(seg: &str) -> bool {
    TEST_DIR_SEGMENTS.contains(&seg)
}

/// Directory-segment test detection for `BuildingKind::Test`
/// classification ONLY — deliberately a wider, SEPARATE predicate from
/// `is_test_dir_segment`/`TEST_DIR_SEGMENTS`, which also drives
/// `test_candidate_paths`'s walled-district naming/mirroring rule.
///
/// Task 5b, defect 2: pocketAlarm's biggest district, `AlarmCoreTests/`
/// (the Swift/Java/C# `<Module>Tests` convention), was drawn entirely in
/// Source blue because neither list recognized it. Widening
/// `TEST_DIR_SEGMENTS` itself to fix that would also widen
/// `test_candidate_paths`'s marker detection, and that breaks something
/// real: for a TOP-LEVEL `AlarmCoreTests/Foo.swift`, the marker would be
/// the segment at index 0, making `scope == root` and `rest_dirs` EMPTY —
/// which `test_candidate_paths` turns into a candidate of `scope` itself,
/// i.e. the repository ROOT. That reintroduces exactly the "root
/// spuriously walled" regression `a_qualifying_test_file_does_not_
/// spuriously_wall_the_repository_root_district` guards against. A
/// directory whose own files classify as `Test` already walls itself
/// through `build_city`'s direct "owns a Test building" rule, with no
/// naming/mirroring contribution required — so this predicate only needs
/// to feed classification, never the marker search.
fn is_test_dir_segment_for_classification(seg: &str) -> bool {
    is_test_dir_segment(seg)
        || seg == "spec"
        || seg == "specs"
        // Case-sensitive on purpose: `Protest`/`contest`-style names must
        // never match. `Tests`/`Test` as an exact suffix with that exact
        // capitalization is the Swift/Java/C# `<Module>Tests` convention
        // (`AlarmCoreTests`, `FooTest`); an all-lowercase name ending in
        // "test" (`latest`, `contest`) does not share that capital-T
        // convention and must stay unmatched.
        || seg.ends_with("Tests")
        || seg.ends_with("Test")
}

fn is_test_filename(lower_name: &str) -> bool {
    lower_name.starts_with("test_")
        || lower_name.contains("_test.")
        || lower_name.contains(".test.")
}

/// Filename test detection for `BuildingKind::Test` classification ONLY —
/// see `is_test_dir_segment_for_classification` for why this is kept
/// separate from the lowercase `is_test_filename` (also reused, via the
/// same literal `_test.`/`.test.`/`test_` patterns, by
/// `test_candidate_paths`'s stem extraction): a colocated
/// `AlarmEngineTests.swift` classifies as Test through this rule directly
/// and walls its OWN directory (if it has one) via the direct-Test-
/// building rule — it needs no naming/mirroring contribution either.
///
/// `name` (original case) is required alongside `lower_name`: the
/// `Test`/`Tests`/`Spec`/`Specs` stem suffix must be matched
/// case-sensitively, or `latest.ts`/`Latest.swift`/`contest.rs`/
/// `attestation.go`/`manifest.json` would all incorrectly match a
/// lowercase `ends_with("test")`/`ends_with("spec")`.
fn is_test_filename_for_classification(name: &str, lower_name: &str) -> bool {
    if is_test_filename(lower_name) {
        return true;
    }
    // RSpec (`*_spec.rb`) and Angular's `*.spec.ts`.
    if lower_name.contains("_spec.") || lower_name.contains(".spec.") {
        return true;
    }
    let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    stem.ends_with("Test") || stem.ends_with("Tests") || stem.ends_with("Spec") || stem.ends_with("Specs")
}

fn classify_kind(root: &Path, path: &Path) -> BuildingKind {
    let name = file_name(path);
    let lower = name.to_lowercase();

    // A prose file is documentation wherever it lives: Task 5b review
    // finding — widening `is_test_dir_segment_for_classification` to
    // accept bare `spec`/`specs` at any depth (for RSpec/monorepo test
    // directories) meant `docs/superpowers/specs/design.md` — a design
    // document, not a test suite — was classified Test purely because
    // one of its ancestor segments is named `specs`. Checked BEFORE the
    // test-directory check (not folded into the docs block below, which
    // ALSO matches a `docs`/`doc` ancestor segment — hoisting that whole
    // block would turn `tests/docs/helper.py` into Docs too): only the
    // extension half of "is this Docs" is prose-first here, and prose is
    // never test code regardless of which directory happens to contain
    // it.
    if lower.ends_with(".md") || lower.ends_with(".txt") {
        return BuildingKind::Docs;
    }

    if ancestor_segments(root, path).any(is_test_dir_segment_for_classification)
        || is_test_filename_for_classification(&name, &lower)
    {
        return BuildingKind::Test;
    }

    if ancestor_segments(root, path).any(|s| s == "docs" || s == "doc") {
        return BuildingKind::Docs;
    }

    let is_dotfile = name.starts_with('.') && name != "." && name != "..";
    if is_dotfile
        || lower.ends_with(".json")
        || lower.ends_with(".toml")
        || lower.ends_with(".yaml")
        || lower.ends_with(".yml")
    {
        return BuildingKind::Config;
    }

    const ASSET_EXTS: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "ttf", "otf", "woff", "woff2",
        "mp3", "mp4", "wav", "mov", "avi",
    ];
    if let Some(ext) = Path::new(&lower).extension().and_then(|e| e.to_str()) {
        if ASSET_EXTS.contains(&ext) {
            return BuildingKind::Asset;
        }
    }

    if lower.ends_with(".csv") || lower.ends_with(".sql") {
        return BuildingKind::Data;
    }

    BuildingKind::Source
}

/// A bucket, not a line count: a city of five heights reads as a city; a
/// city of five hundred reads as noise.
fn height_of(lines: u32) -> u8 {
    if lines < 50 {
        1
    } else if lines < 150 {
        2
    } else if lines < 400 {
        3
    } else if lines < 1000 {
        4
    } else {
        5
    }
}

fn is_excluded(root: &Path, path: &Path, lines: u32) -> bool {
    is_excluded_path(root, path) || is_lockfile(path) || is_minified(path) || lines > MAX_LINES
}

fn depth_of(root: &Path, dir: &Path) -> u8 {
    match dir.strip_prefix(root) {
        Ok(rel) => rel.components().count().min(u8::MAX as usize) as u8,
        Err(_) => 0,
    }
}

/// Source-tree segment names a test path's remainder may be re-rooted
/// under to find the code it mirrors — e.g. `tests/auth/...` mirroring
/// `src/auth/...`. Fix round 3: this list (plus the exact-match rule
/// below) replaces name-plus-containment matching entirely.
const SOURCE_SEGMENTS: &[&str] = &["src", "lib", "app", "packages", "crates"];

/// Computes every directory a test file's path, taken as a MIRROR of the
/// code it tests, could possibly be about — as exact, fully-qualified
/// directory paths. A district is walled by naming only if its own path
/// is one of these EXACTLY (see `build_city`): no `starts_with`, no bare
/// basename comparison, anywhere.
///
/// Fix round 3, Important — the third appearance of one bug class.
/// Rounds 1 and 2 both matched by NAME with a containment check
/// (round 1: repo-wide; round 2: "under the scope"), and both were still
/// too loose: with a root-level `tests/auth/handler_test.rs`, round 2's
/// "under scope" check made `scope == repo root`, so `dir.starts_with(root)`
/// was trivially true for `src/auth` — but ALSO for a totally unrelated
/// `deeply/nested/other/auth`, reintroducing the original over-reach one
/// level down (verified live by the reviewer). Matching exact directory
/// paths instead of "name plus is-it-under-here" removes the loophole
/// structurally rather than narrowing it again.
///
/// For a test file at `<scope>/<marker>/<rest…>` (`marker` is
/// `test`/`tests`/`__tests__`; `scope` is the directory directly
/// containing it — the repo root for `tests/auth/...`, or `X` for
/// `X/tests/...`): the candidate directories are
/// - `<scope>/<rest-dirs…>` (the directory portion of `<rest…>`, dropping
///   the filename) — this degenerates to `<scope>` itself when `<rest…>`
///   has no directories, e.g. `X/tests/foo_test.rs` or
///   `src/lib/ponudba/__tests__/x.test.ts`;
/// - `<scope>/<one of SOURCE_SEGMENTS>/<rest-dirs…>` — the same remainder
///   re-rooted under a conventional source directory, so
///   `tests/auth/handler_test.rs` also reaches `src/auth`.
///
/// A test filename that names its subject by stem (`auth_test.rs`,
/// `test_auth.py`, `auth.test.ts`) contributes the stem as one more
/// trailing path component, applied to BOTH forms above (so
/// `scripts/ponudba/tests/test_x.py` also considers
/// `scripts/ponudba/x` and `scripts/ponudba/src/x` — harmless unless a
/// district genuinely exists there).
///
/// Returns an empty list when `path` has no test-directory-marker
/// ancestor (e.g. a colocated `auth_test.go` right next to `auth.go`) —
/// such a file already walls its own district via the direct-Test-building
/// rule and must contribute no candidate at all.
fn test_candidate_paths(root: &Path, path: &Path) -> Vec<PathBuf> {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let dir_relative = match relative.parent() {
        Some(p) => p,
        None => return Vec::new(),
    };
    let segments: Vec<&str> =
        dir_relative.components().filter_map(|c| c.as_os_str().to_str()).collect();
    let marker_index = match segments.iter().position(|seg| is_test_dir_segment(seg)) {
        Some(i) => i,
        None => return Vec::new(),
    };

    let scope: PathBuf =
        segments[..marker_index].iter().fold(root.to_path_buf(), |acc, seg| acc.join(seg));
    let rest_dirs: Vec<String> =
        segments[marker_index + 1..].iter().map(|s| s.to_string()).collect();

    // Filename-stem forms: each recognized stem is one more trailing
    // path component, tried as an alternative to (not instead of) the
    // plain `rest_dirs`.
    let lower = file_name(path).to_lowercase();
    let mut stems: Vec<String> = Vec::new();
    if let Some(rest) = lower.strip_prefix("test_") {
        if let Some(base) = rest.split('.').next() {
            if !base.is_empty() {
                stems.push(base.to_string());
            }
        }
    }
    if let Some(pos) = lower.find("_test.") {
        stems.push(lower[..pos].to_string());
    }
    if let Some(pos) = lower.find(".test.") {
        stems.push(lower[..pos].to_string());
    }

    let mut rest_variants: Vec<Vec<String>> = vec![rest_dirs.clone()];
    for stem in &stems {
        let mut extended = rest_dirs.clone();
        extended.push(stem.clone());
        rest_variants.push(extended);
    }

    let mut candidates = Vec::new();
    for variant in &rest_variants {
        candidates.push(variant.iter().fold(scope.clone(), |acc, seg| acc.join(seg)));
        // The source-segment re-rooting only means something when there is
        // an actual remainder to re-root: applied to an EMPTY variant it
        // degenerates to `<scope>/<src-segment>` itself, which mirrors
        // nothing this specific test said anything about. Left
        // unconditional, a bare `tests/whatever_test.py` sitting directly
        // in a top-level `tests/` dir (`scope` = repo root, empty
        // rest-dirs) would spuriously generate `<root>/src`, `<root>/lib`,
        // `<root>/app`... as candidates purely because those names are on
        // `SOURCE_SEGMENTS` — walling a repo's real top-level `lib/`
        // whenever it happens to also have a flat `tests/` folder, with no
        // correspondence at all. (Caught by the existing
        // `a_sibling_tests_directory_that_names_nothing_does_not_wall_unrelated_districts`
        // regression test while implementing this fix.)
        if !variant.is_empty() {
            for src_seg in SOURCE_SEGMENTS {
                candidates.push(variant.iter().fold(scope.join(src_seg), |acc, seg| acc.join(seg)));
            }
        }
    }
    candidates
}

fn district_name(root: &Path, dir: &Path, root_name: &str) -> String {
    if dir == root {
        root_name.to_string()
    } else {
        file_name(dir)
    }
}

/// One repository's persisted split-slot memory: directory path -> (file
/// path -> stable global index within that directory). See
/// `split_into_plots`'s "Fix round 6" doc comment for how the index decides
/// which numbered slot a file lands in, and
/// `city::layout::LayoutCache::split_membership` for how this round-trips
/// to disk alongside `cells`/`plots`.
pub type SplitMembership = BTreeMap<String, BTreeMap<String, usize>>;

/// The smallest index not present in `occupied` — mirrors
/// `city::layout::lowest_free` one level up: a directory's "next free
/// split slot" is just its next free global index, floor-divided by
/// `MAX_BUILDINGS_PER_DISTRICT`.
fn lowest_free_index(occupied: &BTreeSet<usize>) -> usize {
    let mut expected = 0usize;
    for &value in occupied {
        if value != expected {
            break;
        }
        expected += 1;
    }
    expected
}

/// Resolves one directory's CURRENT files to a stable, persisted global
/// index (0-based) — the split-membership analogue, one level up, of
/// `city::layout::resolve_cells`'s per-building cell stability. A file
/// already in `existing` keeps its index exactly, regardless of where it
/// now falls in sorted order; a brand-new file takes the lowest index not
/// currently occupied, in sorted-path order (deterministic when several
/// files appear in the same call) — which is also, automatically, the
/// LOWEST-NUMBERED split slot with room, since a slot's index range is
/// only ever full once every index in it is taken. A file no longer
/// present is simply left out, releasing its index immediately: the same
/// "release immediately, not held forever" choice `city::layout` makes for
/// a building's cell, and for the identical reason — a rename is a delete
/// plus an add (the path is the only identity available), and holding
/// every vacated index forever would grow a churny directory's slot count
/// without bound even while its file count stays flat.
fn resolve_split_indices(
    existing: &BTreeMap<String, usize>,
    sorted_paths: &[&String],
) -> BTreeMap<String, usize> {
    let mut indices: BTreeMap<String, usize> = BTreeMap::new();
    let mut occupied: BTreeSet<usize> = BTreeSet::new();

    // Every still-present path keeps its existing index exactly.
    for &path in sorted_paths {
        if let Some(&i) = existing.get(path) {
            indices.insert(path.clone(), i);
            occupied.insert(i);
        }
    }
    // Every brand-new path takes the lowest index not already occupied.
    for &path in sorted_paths {
        if !indices.contains_key(path) {
            let i = lowest_free_index(&occupied);
            occupied.insert(i);
            indices.insert(path.clone(), i);
        }
    }
    indices
}

/// Splits an over-full directory's buildings into numbered sub-plots of
/// at most `MAX_BUILDINGS_PER_DISTRICT` each, so a `migrations` folder
/// with hundreds of files becomes a terrace rather than one monstrous
/// plot (or, worse, 400 identical huts).
///
/// **Cache-key aliasing (see `docs/superpowers/phase-0-followups.md`,
/// "Crossing the 40-file split boundary orphans a cache entry").** The
/// district's displayed `path`/`name` are renamed `dir` -> `dir#1`/`dir#2`/…
/// the instant the count crosses the threshold, and back again the instant
/// it drops below — but `city::layout`'s persisted cache must not see that
/// as two unrelated places. `cache_key` gives slot 1 (whichever of `dir` or
/// `dir#1` currently represents it — the two are never both present at
/// once, since a directory is either wholly unsplit or wholly split) the
/// SAME key the bare directory has always used, so growing past the
/// threshold or shrinking back below it is, for the cache, a no-op for the
/// bulk of the directory's content: `dir#1` inherits `dir`'s cached plot
/// (and, via `LayoutCache::cells`, every building's cell) instead of being
/// treated as a brand-new district and jumping to the packing frontier.
/// Every other slot (`dir#2`, `dir#3`, …) is genuinely new content the
/// first time it appears — those key on their own numbered name, same as
/// `path`, and correctly get a fresh plot. `path` itself is untouched:
/// callers that display or match on it (tests included) see the exact same
/// `dir#N` naming as before this fix.
///
/// **Fix round 6: WHICH slot, not just which cache entry
/// (`docs/superpowers/phase-0-followups.md`, "`split_into_plots` chunks a
/// directory's buildings by POSITIONAL insertion order").** Round 5 fixed
/// `city::layout`'s cache from losing a directory's plot/cells the instant
/// it crossed the split boundary, but this function itself still decided
/// *membership* — which file lands in `dir#1` vs `dir#2` — by
/// `buildings.chunks(40)` over whatever order the caller's `Vec` happened
/// to be in, which shifts every later file's chunk the moment an
/// earlier-sorting file is added or removed anywhere in the directory. The
/// fix gives every file a STABLE global index via `resolve_split_indices`
/// (persisted, by path, in `existing_membership` — the same shape and the
/// same "release immediately" policy as `city::layout::LayoutCache::cells`,
/// one level up): a file's slot is `index / MAX_BUILDINGS_PER_DISTRICT`,
/// so it changes ONLY when the file's own index changes, which only
/// happens when the file itself is added (assigned a fresh index) or
/// removed (its index released). An unrelated file appearing anywhere else
/// in sorted order can no longer bump anything.
///
/// Indices — and therefore slot membership — are resolved for EVERY file
/// in the directory, not merely once it exceeds the threshold: this is
/// what makes shrinking back to a single unsplit district and later
/// re-growing past the threshold again land every surviving file back in
/// the slot it already had, rather than restarting from a positional
/// assignment. Below the threshold the resolved indices are simply
/// unused for grouping (there is only one district), but they are still
/// returned so the caller can persist them — continuity across a
/// temporary dip below the threshold, exactly the way a district's own
/// `Plot`/`cells` entries are never dropped just because the district is
/// briefly absent.
fn split_into_plots(
    dir: &Path,
    name: &str,
    buildings: Vec<Building>,
    walled: bool,
    depth: u8,
    existing_membership: &BTreeMap<String, usize>,
) -> (Vec<District>, BTreeMap<String, usize>) {
    let dir_path = dir.to_string_lossy().to_string();

    // Stable per-file identity: which slot a file belongs to is resolved
    // by PATH, never by its position in `buildings` — see the doc comment
    // above and `docs/superpowers/phase-0-followups.md`.
    let mut order: Vec<usize> = (0..buildings.len()).collect();
    order.sort_by(|&a, &b| buildings[a].path.cmp(&buildings[b].path));
    let sorted_paths: Vec<&String> = order.iter().map(|&i| &buildings[i].path).collect();
    let indices = resolve_split_indices(existing_membership, &sorted_paths);

    if buildings.len() <= MAX_BUILDINGS_PER_DISTRICT {
        return (
            vec![District {
                path: dir_path.clone(),
                name: name.to_string(),
                buildings,
                walled,
                depth,
                cache_key: dir_path,
            }],
            indices,
        );
    }

    // Group by each file's resolved slot (`index / MAX_BUILDINGS_PER_
    // DISTRICT`), not by position in `buildings`. A `BTreeMap` keeps
    // slots in ascending order and — deliberately — never renumbers a
    // gap: if every file in an early slot is later deleted while a later
    // slot survives, the later slot keeps its own number rather than
    // sliding down, the same "never compact, never evict" discipline
    // `city::layout::LayoutCache::plots` already applies to a whole
    // district's plot.
    let mut chunks: BTreeMap<usize, Vec<Building>> = BTreeMap::new();
    for building in buildings {
        let index = indices[&building.path];
        let chunk = index / MAX_BUILDINGS_PER_DISTRICT;
        chunks.entry(chunk).or_default().push(building);
    }

    let districts = chunks
        .into_iter()
        .map(|(chunk, chunk_buildings)| {
            let slot = chunk + 1;
            let cache_key = if slot == 1 { dir_path.clone() } else { format!("{dir_path}#{slot}") };
            District {
                path: format!("{dir_path}#{slot}"),
                name: format!("{name} ({slot})"),
                buildings: chunk_buildings,
                walled,
                depth,
                cache_key,
            }
        })
        .collect();
    (districts, indices)
}

/// Builds a `CityModel` from `root` using `walker` for file discovery, and
/// resolves every over-full directory's split-slot membership using
/// `membership` — see `split_into_plots`'s "Fix round 6" doc comment.
/// Returns the model alongside the UPDATED membership map (every directory
/// touched this call gets its freshly resolved `path -> index` map; a
/// directory absent from `membership` starts fresh; a directory present in
/// `membership` but absent from this call's file listing is left
/// untouched by the caller, the same "never evicted" treatment
/// `city::layout::LayoutCache` gives a vanished district's `Plot`/`cells`).
/// Pure aside from the one injected `walker` call — no disk I/O happens
/// here; persisting `membership` across calls is `city::layout`'s job.
pub fn build_city_with_membership(
    root: &Path,
    walker: &dyn FileSource,
    membership: &SplitMembership,
) -> (CityModel, SplitMembership) {
    let root_norm = normalize_path(root);
    let root_name = root_norm
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root_norm.to_string_lossy().to_string());

    let mut skipped: u32 = 0;
    // Grouped by directory, preserving first-seen order so district
    // ordering is deterministic for a given input.
    let mut by_dir: BTreeMap<PathBuf, Vec<Building>> = BTreeMap::new();
    let mut dir_order: Vec<PathBuf> = Vec::new();
    // Every exact directory path a `Test` building's path/filename
    // mirrors — see `test_candidate_paths`. This is the ONLY input
    // (besides a district's own buildings) `walled` may draw on; a
    // district absent from both is honestly left unwalled. Fix round 3:
    // membership is checked by EXACT path equality, never `starts_with`
    // or a bare name match — those both let an unrelated, differently
    // located same-named (or merely nested-under-the-same-scope)
    // directory get walled by a test that never touches it.
    let mut named_by_tests: HashSet<PathBuf> = HashSet::new();

    for (path, lines) in walker.files(root) {
        let path = normalize_path(&path);
        let lines = match lines {
            Some(lines) => lines,
            None => {
                // Unreadable as UTF-8 text (binary artifact or I/O error):
                // counted honestly as skipped, never defaulted to a
                // trivial height-1 building.
                skipped += 1;
                continue;
            }
        };
        if is_excluded(&root_norm, &path, lines) {
            skipped += 1;
            continue;
        }
        let kind = classify_kind(&root_norm, &path);
        // Only a test file that actually lives under a recognized test
        // directory contributes candidates — a colocated `auth_test.go`
        // sitting right next to `auth.go` already walls its own district
        // via the direct-Test-building rule below, and must NOT also
        // register a candidate: doing so would let it wrongly wall an
        // unrelated directory that happens to share its name elsewhere in
        // the tree. `test_candidate_paths` returns an empty list for
        // exactly that case (no test-directory-marker ancestor), so this
        // naturally excludes it without a separate check.
        if kind == BuildingKind::Test {
            named_by_tests.extend(test_candidate_paths(&root_norm, &path));
        }
        let dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| root_norm.clone());
        let building = Building {
            path: path.to_string_lossy().to_string(),
            name: file_name(&path),
            kind,
            lines,
            height: height_of(lines),
        };
        if !by_dir.contains_key(&dir) {
            dir_order.push(dir.clone());
        }
        by_dir.entry(dir).or_default().push(building);
    }

    let mut districts: Vec<District> = Vec::new();
    let mut updated_membership: SplitMembership = membership.clone();
    for dir in &dir_order {
        let buildings = by_dir.remove(dir).unwrap_or_default();
        let depth = depth_of(&root_norm, dir);
        let name = district_name(&root_norm, dir, &root_name);
        let walled = buildings.iter().any(|b| b.kind == BuildingKind::Test)
            || named_by_tests.contains(dir);
        let dir_path = dir.to_string_lossy().to_string();
        let existing = membership.get(&dir_path).cloned().unwrap_or_default();
        let (split_districts, indices) = split_into_plots(dir, &name, buildings, walled, depth, &existing);
        updated_membership.insert(dir_path, indices);
        districts.extend(split_districts);
    }

    // Always read immediately after `files`, for the same `root` — see
    // `FileSource::submodules`'s doc comment on why that ordering matters.
    let submodules = walker.submodules(root);
    let source = walker.source(root);

    let model = CityModel {
        root: root_norm.to_string_lossy().to_string(),
        name: root_name,
        districts,
        skipped,
        submodules,
        source,
    };
    (model, updated_membership)
}

/// Builds a `CityModel` from `root` using `walker` for file discovery, with
/// NO memory of any previous call — every over-full directory's split-slot
/// membership is resolved fresh from this call's own sorted order (see
/// `build_city_with_membership`). Kept, unchanged, for every existing
/// caller/test that only cares about the pure translation and does not
/// need split-membership to survive across calls; `city::layout`'s real,
/// persisted entry point (`layout_city_persisted_from_root`) uses
/// `build_city_with_membership` instead, threading the SAME memory
/// `LayoutCache::cells`/`plots` already get. Pure aside from that one
/// injected call.
pub fn build_city(root: &Path, walker: &dyn FileSource) -> CityModel {
    build_city_with_membership(root, walker, &SplitMembership::new()).0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    struct FakeFiles(Vec<(&'static str, u32)>);
    impl FileSource for FakeFiles {
        fn files(&self, _root: &Path) -> Vec<(PathBuf, Option<u32>)> {
            self.0.iter().map(|(p, n)| (PathBuf::from(p), Some(*n))).collect()
        }
    }

    fn city(files: Vec<(&'static str, u32)>) -> CityModel {
        build_city(Path::new("/p/api"), &FakeFiles(files))
    }

    /// Like `FakeFiles`, but reports `CitySource::Walk` — for pinning that
    /// `build_city` actually reads `FileSource::source` and threads it
    /// onto `CityModel::source`, rather than only `RealFiles` itself
    /// tracking it correctly with nothing downstream using it.
    struct FakeWalkFiles(Vec<(&'static str, u32)>);
    impl FileSource for FakeWalkFiles {
        fn files(&self, _root: &Path) -> Vec<(PathBuf, Option<u32>)> {
            self.0.iter().map(|(p, n)| (PathBuf::from(p), Some(*n))).collect()
        }
        fn source(&self, _root: &Path) -> CitySource {
            CitySource::Walk
        }
    }

    #[test]
    fn build_city_reports_the_file_sources_own_source_on_the_model() {
        let git_model = city(vec![("/p/api/src/main.rs", 10)]);
        assert_eq!(git_model.source, CitySource::Git, "the default FileSource::source is Git");

        let walk_model =
            build_city(Path::new("/p/api"), &FakeWalkFiles(vec![("/p/api/src/main.rs", 10)]));
        assert_eq!(walk_model.source, CitySource::Walk);
    }

    /// Like `FakeFiles`, but lets a test simulate a file that could not be
    /// read as UTF-8 text (`None`) alongside ordinary readable ones.
    struct FakeFilesWithUnreadable(Vec<(&'static str, Option<u32>)>);
    impl FileSource for FakeFilesWithUnreadable {
        fn files(&self, _root: &Path) -> Vec<(PathBuf, Option<u32>)> {
            self.0.iter().map(|(p, n)| (PathBuf::from(p), *n)).collect()
        }
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

    /// Fix round 2, Important 2, confirmation: a real-repo re-review
    /// suspected an excluded directory (`.next`) could survive when
    /// nested several levels deep rather than as a leading path segment.
    /// Investigating directly (an explicit scan of every district path in
    /// 4 real repos, including the one where the leak was reported) found
    /// no such district anywhere — `is_excluded_path` already walks every
    /// ancestor segment via `ancestor_segments`, not just the immediate
    /// parent, so a nested `node_modules` was already excluded. This test
    /// pins that directly rather than relying on the real-repo scan alone.
    #[test]
    fn a_deeply_nested_excluded_directory_is_skipped_not_built() {
        let model = city(vec![
            ("/p/api/a/b/node_modules/pkg/index.js", 20),
            ("/p/api/src/main.rs", 40),
        ]);
        assert_eq!(model.districts.len(), 1, "only src should survive");
        assert_eq!(model.skipped, 1);
    }

    /// Task 5 review finding: a real Swift repo's city was mostly Xcode's
    /// own build cache — `.build/checkouts/.../ModuleCache/arm64/...` — not
    /// the user's code, because `EXCLUDED_DIRS` caught `build` but not
    /// `.build`. Pins that a `.build` tree (with a `ModuleCache` directory
    /// nested inside it, both independently excluded) is fully skipped no
    /// matter how deep, the same way `node_modules` already was.
    #[test]
    fn a_nested_dot_build_tree_is_skipped_not_built() {
        let model = city(vec![
            (
                "/p/api/.build/checkouts/Yowl/ModuleCache/arm64/x86_64/4475ef67.xcbuilddata",
                50,
            ),
            ("/p/api/src/main.swift", 40),
        ]);
        assert_eq!(model.districts.len(), 1, "only src should survive");
        assert_eq!(model.skipped, 1);
    }

    /// Fix round (Task 5 review, SMALL 2): `out` and `coverage` are
    /// genuinely ambiguous names — plausible as real source directories,
    /// unlike `.build` or `ModuleCache` — so they're excluded only at the
    /// repo ROOT, not at any depth. A root-level `out/`/`coverage/` is a
    /// build/test-report artifact and must still be skipped; the same name
    /// nested under real source (`src/formatters/out/`) must survive.
    #[test]
    fn root_only_excluded_dirs_are_skipped_at_root_but_not_when_nested() {
        let model = city(vec![
            ("/p/api/out/bundle.js", 20),
            ("/p/api/coverage/lcov.info", 20),
            ("/p/api/src/formatters/out/writer.rs", 30),
            ("/p/api/src/coverage/report.rs", 30),
        ]);
        let names: Vec<&str> = model.districts.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"out"), "src/formatters/out must survive as a district");
        assert!(names.contains(&"coverage"), "src/coverage must survive as a district");
        assert_eq!(model.districts.len(), 2, "only the two nested dirs should survive");
        assert_eq!(model.skipped, 2, "the two ROOT-level out/coverage files must be skipped");
    }

    /// Task 5b review finding (defect 3): `EXCLUDED_ROOT_ONLY_DIRS`'s check
    /// used to compare against `rel.components().next()` alone, which is
    /// the relative path's FIRST component — not necessarily a directory.
    /// A repo-root FILE literally named `out` or `coverage` (no extension)
    /// would therefore have been wrongly excluded, unlike the any-depth
    /// `EXCLUDED_DIRS` rule, which never excludes a file by its own
    /// basename. Both must survive as ordinary buildings in the root
    /// district.
    #[test]
    fn a_root_level_file_literally_named_out_or_coverage_is_not_excluded() {
        let model = city(vec![
            ("/p/api/out", 20),
            ("/p/api/coverage", 20),
            ("/p/api/src/main.rs", 10),
        ]);
        let root_district = model.districts.iter().find(|d| d.name == "api").unwrap();
        let building_names: Vec<&str> =
            root_district.buildings.iter().map(|b| b.name.as_str()).collect();
        assert!(building_names.contains(&"out"), "a root FILE named 'out' must not be excluded");
        assert!(
            building_names.contains(&"coverage"),
            "a root FILE named 'coverage' must not be excluded"
        );
        assert_eq!(model.skipped, 0, "neither root file should be skipped");
    }

    /// Fix round 1, Important: a file `FileSource` reports as unreadable
    /// (`None`, e.g. a binary artifact that fails to decode as UTF-8) must
    /// be counted in `skipped`, never defaulted to a `0`-line, height-1
    /// building — that would misrepresent a substantial file as trivial.
    #[test]
    fn an_unreadable_file_is_skipped_not_built() {
        let model = build_city(
            Path::new("/p/api"),
            &FakeFilesWithUnreadable(vec![
                ("/p/api/src/main.rs", Some(40)),
                ("/p/api/src/photo.bin", None),
            ]),
        );
        assert_eq!(model.districts.len(), 1);
        assert_eq!(
            model.districts[0].buildings.len(),
            1,
            "the unreadable file must not become a building"
        );
        assert_eq!(model.skipped, 1);
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

    /// Fix round 1, Critical, reproduction: with a `src/` that has its own
    /// test, a `lib/` that has none, and a root `tests/` whose contents
    /// name neither `lib` nor anything related to it, `lib/` must stay
    /// unwalled. The previous `has_sibling_test_dir` rule walled every
    /// sibling of ANY `tests/` directory purely by proximity — this must
    /// be red against that code and green against the fix.
    #[test]
    fn a_sibling_tests_directory_that_names_nothing_does_not_wall_unrelated_districts() {
        let model = city(vec![
            ("/p/api/src/main.rs", 40),
            ("/p/api/src/main_test.rs", 20),
            ("/p/api/lib/util.rs", 30),
            ("/p/api/tests/misc_test.rs", 10),
        ]);
        let src = model.districts.iter().find(|d| d.name == "src").unwrap();
        let lib = model.districts.iter().find(|d| d.name == "lib").unwrap();
        assert!(src.walled, "src has its own test file");
        assert!(!lib.walled, "nothing under tests/ names lib — it must not be walled");
    }

    /// Fix round 1, Critical: a test file that explicitly names a district
    /// (`tests/auth/...`) walls exactly that district — not an unrelated
    /// sibling with no corresponding tests.
    #[test]
    fn a_test_directory_naming_a_district_walls_only_that_district() {
        let model = city(vec![
            ("/p/api/src/auth/handler.rs", 40),
            ("/p/api/src/billing/invoice.rs", 40),
            ("/p/api/tests/auth/handler_test.rs", 20),
        ]);
        let auth = model.districts.iter().find(|d| d.name == "auth").unwrap();
        let billing = model.districts.iter().find(|d| d.name == "billing").unwrap();
        assert!(auth.walled, "tests/auth/... explicitly names the auth district");
        assert!(!billing.walled, "no test names billing");
    }

    /// A colocated test file (no `tests/`/`__tests__` ancestor) walls only
    /// its own district via the direct-Test-building rule; it must not
    /// also register a repo-wide naming candidate that could wall an
    /// unrelated, same-named directory living somewhere else entirely.
    #[test]
    fn a_colocated_test_does_not_wall_an_unrelated_same_named_directory_elsewhere() {
        let model = city(vec![
            ("/p/api/src/auth/auth.rs", 40),
            ("/p/api/src/auth/auth_test.rs", 20),
            ("/p/api/other/auth/handler.rs", 40),
        ]);
        let districts: Vec<_> =
            model.districts.iter().filter(|d| d.name == "auth").collect();
        assert_eq!(districts.len(), 2, "two unrelated 'auth' directories");
        let colocated = districts.iter().find(|d| d.path.contains("/src/auth")).unwrap();
        let unrelated = districts.iter().find(|d| d.path.contains("/other/auth")).unwrap();
        assert!(colocated.walled, "has its own colocated test");
        assert!(!unrelated.walled, "an unrelated directory sharing the name 'auth' must not be walled by it");
    }

    /// Regression: the repository root itself must never be spuriously
    /// walled just because SOME qualifying test file exists anywhere in
    /// the tree. Before scoping `test_target_names` to paths relative to
    /// `root`, every ancestor segment of the ABSOLUTE path was a naming
    /// candidate — and the root is an ancestor of every file in it, so
    /// the root district's own name (here "api", from root `/p/api`)
    /// always appeared among those candidates, walling the root
    /// unconditionally whenever any test file anywhere qualified.
    #[test]
    fn a_qualifying_test_file_does_not_spuriously_wall_the_repository_root_district() {
        let model = city(vec![
            ("/p/api/README.md", 10),
            ("/p/api/src/auth/handler.rs", 40),
            ("/p/api/tests/auth/handler_test.rs", 20),
        ]);
        let root_district = model.districts.iter().find(|d| d.name == "api").unwrap();
        assert!(
            !root_district.walled,
            "the repo root must not be walled merely because some test exists somewhere in the tree"
        );
    }

    /// Fix round 2, Important, reproduction: verified live on
    /// `my-site-next` — `scripts/ponudba/tests/...` (an `X/tests/...`
    /// test naming its own parent `X = scripts/ponudba`) was walling an
    /// entirely unrelated `ponudba` directory living elsewhere in the
    /// repository (there: `.next/standalone/scripts/ponudba`, `.agents/
    /// skills/ponudba`, `.claude/skills/ponudba`), none of which contain
    /// any test. Naming must be scoped to the marker's parent directory:
    /// `scripts/ponudba/tests/...` may wall `scripts/ponudba`, never a
    /// same-named `other/ponudba` the test's own tree never touches.
    #[test]
    fn naming_is_scoped_to_the_markers_parent_not_global() {
        let model = city(vec![
            ("/p/api/scripts/ponudba/handler.rs", 40),
            ("/p/api/scripts/ponudba/tests/handler_test.rs", 20),
            ("/p/api/other/ponudba/handler.rs", 40),
        ]);
        let scoped = model
            .districts
            .iter()
            .find(|d| d.name == "ponudba" && d.path.contains("/scripts/"))
            .unwrap();
        let unrelated = model
            .districts
            .iter()
            .find(|d| d.name == "ponudba" && d.path.contains("/other/"))
            .unwrap();
        assert!(scoped.walled, "scripts/ponudba/tests/... names scripts/ponudba itself");
        assert!(
            !unrelated.walled,
            "other/ponudba is outside scripts/ponudba/tests/...'s scope and must not be walled"
        );
    }

    /// Fix round 3, Important, the reviewer's own reproduction: round 2's
    /// "under scope" check folded `scope` to the repo root for a
    /// root-level `tests/`, and `starts_with(root)` is trivially true for
    /// EVERY directory in the repository — reintroducing the original
    /// over-reach one level down. `tests/auth/handler_test.rs` must wall
    /// `src/auth` (mirroring under a conventional source segment) and the
    /// root-level `auth` (the direct mirror), but a same-named `auth`
    /// nested somewhere else entirely must not be touched just because it
    /// is technically "under the root".
    #[test]
    fn exact_path_mirroring_does_not_wall_an_unrelated_same_named_directory_under_root() {
        let model = city(vec![
            ("/p/api/tests/auth/handler_test.rs", 20),
            ("/p/api/auth/handler.rs", 40),
            ("/p/api/src/auth/handler.rs", 40),
            ("/p/api/deeply/nested/other/auth/handler.rs", 40),
        ]);
        let root_auth = model
            .districts
            .iter()
            .find(|d| d.path.ends_with("/p/api/auth"))
            .unwrap();
        let src_auth = model
            .districts
            .iter()
            .find(|d| d.path.ends_with("/src/auth"))
            .unwrap();
        let unrelated_auth = model
            .districts
            .iter()
            .find(|d| d.path.ends_with("/deeply/nested/other/auth"))
            .unwrap();
        assert!(root_auth.walled, "tests/auth/... directly mirrors the root-level auth");
        assert!(src_auth.walled, "tests/auth/... mirrors src/auth via the source-segment form");
        assert!(
            !unrelated_auth.walled,
            "deeply/nested/other/auth is a different directory that merely shares the name \
             'auth' — being under the repo root is not mirroring"
        );
    }

    /// Fix round 3, case 2 from the brief: a colocated `__tests__` names
    /// its own parent directory exactly (the scope itself), and nothing
    /// else that happens to share that directory's name elsewhere.
    #[test]
    fn a_colocated_tests_dir_walls_its_exact_parent_and_nothing_else_named_the_same() {
        let model = city(vec![
            ("/p/api/src/lib/ponudba/handler.rs", 40),
            ("/p/api/src/lib/ponudba/__tests__/x.test.ts", 20),
            ("/p/api/other/ponudba/handler.rs", 40),
        ]);
        let scoped = model.districts.iter().find(|d| d.path.ends_with("/src/lib/ponudba")).unwrap();
        let unrelated = model.districts.iter().find(|d| d.path.ends_with("/other/ponudba")).unwrap();
        assert!(scoped.walled, "src/lib/ponudba/__tests__/... walls its exact parent");
        assert!(!unrelated.walled, "other/ponudba shares only a name, not the tested path");
    }

    /// Fix round 3, case 3 from the brief: a `test_<name>.*` file directly
    /// inside a nested `tests/` dir walls exactly that `tests/` dir's own
    /// parent, not a same-named directory elsewhere.
    #[test]
    fn a_test_prefixed_filename_in_a_nested_tests_dir_walls_only_its_own_parent() {
        let model = city(vec![
            ("/p/api/scripts/ponudba/handler.py", 40),
            ("/p/api/scripts/ponudba/tests/test_x.py", 20),
            ("/p/api/other/ponudba/handler.py", 40),
        ]);
        let scoped = model.districts.iter().find(|d| d.path.ends_with("/scripts/ponudba")).unwrap();
        let unrelated = model.districts.iter().find(|d| d.path.ends_with("/other/ponudba")).unwrap();
        assert!(scoped.walled, "scripts/ponudba/tests/test_x.py walls scripts/ponudba");
        assert!(!unrelated.walled, "other/ponudba is untouched by this test file");
    }

    /// Fix round 3, case 4 from the brief: owning a `Test` building
    /// directly still walls a district regardless of naming — unchanged
    /// by the exact-path-mirroring rewrite. (Also covered by
    /// `a_district_with_tests_is_walled` above; pinned again here
    /// explicitly so all four round-3 cases are self-contained together.)
    #[test]
    fn owning_a_test_building_still_walls_regardless_of_naming() {
        let model = city(vec![
            ("/p/api/src/main.rs", 40),
            ("/p/api/src/main_test.rs", 20),
        ]);
        assert!(model.districts[0].walled, "a district with its own Test building is always walled");
    }

    #[test]
    fn a_huge_directory_is_split_into_sub_plots() {
        // Distinct paths (fix round 6 resolves split membership by PATH,
        // so 90 buildings sharing one literal path would collapse to a
        // single membership entry instead of actually exercising the
        // split).
        let files: Vec<(String, u32)> =
            (0..90).map(|i| (format!("/p/api/migrations/{i:03}_init.sql"), 10)).collect();
        let model = build_city(Path::new("/p/api"), &FakeFilesOwned(files));
        assert!(model.districts.len() >= 3, "90 files must not be one plot");
        assert!(model.districts.iter().all(|d| d.buildings.len() <= 40));
    }

    /// Like `FakeFiles`, but owns its strings — needed for tests (like the
    /// split cache-key ones below) that generate many DISTINCT paths rather
    /// than reusing one `&'static str` literal.
    struct FakeFilesOwned(Vec<(String, u32)>);
    impl FileSource for FakeFilesOwned {
        fn files(&self, _root: &Path) -> Vec<(PathBuf, Option<u32>)> {
            self.0.iter().map(|(p, n)| (PathBuf::from(p), Some(*n))).collect()
        }
    }

    /// `docs/superpowers/phase-0-followups.md`, "Crossing the 40-file split
    /// boundary orphans a cache entry": `city::layout`'s persisted cache is
    /// keyed by district identity, and the fix lives here, in
    /// `split_into_plots`, where the split naming itself is decided. Slot
    /// 1 — whichever of `dir` (unsplit) or `dir#1` (split) currently
    /// represents the directory's first 40-or-fewer files, the two never
    /// coexisting — must carry the SAME `cache_key` as the bare directory
    /// always has, so `city::layout` sees a cache HIT instead of a
    /// brand-new district the instant a directory crosses the threshold (or
    /// drops back below it). Slot 2 and beyond are genuinely new content
    /// and key on their own numbered name, same as `path`.
    #[test]
    fn a_directorys_first_split_slot_shares_the_unsplit_directorys_cache_key() {
        let unsplit = city(vec![("/p/api/big/f0.rs", 10)]);
        assert_eq!(unsplit.districts.len(), 1);
        assert_eq!(unsplit.districts[0].path, "/p/api/big");
        assert_eq!(
            unsplit.districts[0].cache_key, unsplit.districts[0].path,
            "an unsplit directory's cache key is just its own path"
        );

        let files: Vec<(String, u32)> =
            (0..45).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let split = build_city(Path::new("/p/api"), &FakeFilesOwned(files));
        assert_eq!(split.districts.len(), 2, "45 files must split into exactly two sub-plots");
        let slot1 = split.districts.iter().find(|d| d.path == "/p/api/big#1").unwrap();
        let slot2 = split.districts.iter().find(|d| d.path == "/p/api/big#2").unwrap();

        assert_eq!(
            slot1.cache_key, "/p/api/big",
            "slot 1 must key on the pre-split directory path so it inherits `dir`'s cached plot"
        );
        assert_eq!(
            slot1.cache_key, unsplit.districts[0].cache_key,
            "slot 1's cache key must be identical to the unsplit directory's own key"
        );
        assert_eq!(
            slot2.cache_key, "/p/api/big#2",
            "slot 2 is genuinely new content and keys on its own numbered name, like `path`"
        );
    }

    /// **THE regression test for the split-membership bug**
    /// (`docs/superpowers/phase-0-followups.md`, "`split_into_plots` chunks
    /// a directory's buildings by POSITIONAL insertion order, not by a
    /// stable per-file identity"). 41 sorted files (`f001..f041`) split
    /// into `big#1` (`f001..f040`) and `big#2` (`f041`) alone. Adding
    /// `f000.rs` — which sorts BEFORE every existing file — must NOT bump
    /// `f040.rs` out of `big#1`: with fix round 6's stable per-path index,
    /// `f000.rs` is brand new and takes the lowest FREE index (41, since
    /// 0..40 are already taken), landing it in `big#2` alongside `f041.rs`
    /// while `big#1`'s membership stays byte-identical. Before this round's
    /// fix (chunking by `buildings.chunks(40)` over freshly re-sorted
    /// input), `f000.rs` sorting first would shift the whole chunk boundary
    /// down by one, bumping `f040.rs` into `big#2` even though `f040.rs`'s
    /// own path never changed — confirmed red against that code before this
    /// fix (see the fix report).
    #[test]
    fn adding_an_earlier_sorting_file_does_not_move_existing_files_between_split_slots() {
        let before: Vec<(String, u32)> =
            (1..=41).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let (before_model, membership) =
            build_city_with_membership(Path::new("/p/api"), &FakeFilesOwned(before.clone()), &SplitMembership::new());
        assert_eq!(before_model.districts.len(), 2, "41 files must split into two sub-plots");
        let slot1_before: HashSet<String> = before_model
            .districts
            .iter()
            .find(|d| d.path == "/p/api/big#1")
            .unwrap()
            .buildings
            .iter()
            .map(|b| b.path.clone())
            .collect();
        assert_eq!(slot1_before.len(), 40);

        // Add f000.rs, which sorts BEFORE every file already present — and
        // sort the whole listing by path afterwards, mirroring what a real
        // `git ls-files` (via `RealFiles`) always returns, so this test
        // exercises the same file ORDER the walker hands `build_city` in
        // production, not an insertion-order artifact of this test's own
        // `Vec::push`.
        let mut after = before;
        after.push(("/p/api/big/f000.rs".to_string(), 10));
        after.sort_by(|a, b| a.0.cmp(&b.0));
        let (after_model, _membership) =
            build_city_with_membership(Path::new("/p/api"), &FakeFilesOwned(after), &membership);
        assert_eq!(after_model.districts.len(), 2, "42 files must still be exactly two sub-plots");
        let slot1_after: HashSet<String> = after_model
            .districts
            .iter()
            .find(|d| d.path == "/p/api/big#1")
            .unwrap()
            .buildings
            .iter()
            .map(|b| b.path.clone())
            .collect();

        assert_eq!(
            slot1_before, slot1_after,
            "big#1's membership must be byte-identical after adding an earlier-sorting file"
        );
        let slot2_after: HashSet<String> = after_model
            .districts
            .iter()
            .find(|d| d.path == "/p/api/big#2")
            .unwrap()
            .buildings
            .iter()
            .map(|b| b.path.clone())
            .collect();
        assert!(
            slot2_after.contains("/p/api/big/f000.rs"),
            "the new arrival should fill the lowest-numbered slot with room (big#2), not big#1"
        );
    }

    /// A deleted file's split-slot index is released immediately, mirroring
    /// `city::layout::resolve_cells`'s "release immediately, not held
    /// forever" policy one level up: removing a file from a full slot frees
    /// exactly one spot in THAT slot for the next new file, rather than the
    /// new file being pushed into a fresh slot.
    #[test]
    fn a_removed_files_split_slot_is_reclaimed_by_the_next_new_file() {
        let at_41: Vec<(String, u32)> =
            (1..=41).map(|i| (format!("/p/api/big/f{i:03}.rs"), 10)).collect();
        let (_model, membership) =
            build_city_with_membership(Path::new("/p/api"), &FakeFilesOwned(at_41.clone()), &SplitMembership::new());

        // Remove f001.rs (the lowest-indexed file in big#1) and add
        // f999.rs, a brand-new file.
        let mut next: Vec<(String, u32)> = at_41.into_iter().filter(|(p, _)| p != "/p/api/big/f001.rs").collect();
        next.push(("/p/api/big/f999.rs".to_string(), 10));
        let (model, _membership) =
            build_city_with_membership(Path::new("/p/api"), &FakeFilesOwned(next), &membership);
        assert_eq!(model.districts.len(), 2, "still 41 files total: two sub-plots");
        let slot1: HashSet<String> = model
            .districts
            .iter()
            .find(|d| d.path == "/p/api/big#1")
            .unwrap()
            .buildings
            .iter()
            .map(|b| b.path.clone())
            .collect();
        assert!(
            slot1.contains("/p/api/big/f999.rs"),
            "f999.rs should reclaim f001.rs's freed slot-1 index rather than landing in big#2"
        );
        assert!(!slot1.contains("/p/api/big/f001.rs"));
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

    /// Task 5b, defect 2: `classify_kind` missed the Swift/Java/C#
    /// `<Module>Tests` directory/filename convention, RSpec's `*_spec.rb`,
    /// and Angular's `*.spec.ts` — so pocketAlarm's biggest district,
    /// `AlarmCoreTests/`, was drawn entirely as Source. Table-driven over
    /// (path, expected kind) so the false-positive half — the half that
    /// actually needs care, since a mislabelled SOURCE file is the same
    /// defect in reverse — sits right next to the positive cases it
    /// exists to guard against. Every path is exercised directly through
    /// `classify_kind`, which only looks at the path, not at file
    /// content or a walked tree.
    #[test]
    fn test_classification_catches_new_conventions_without_misclassifying_lookalikes() {
        let cases: &[(&str, BuildingKind)] = &[
            // --- positives: must classify as Test ---
            ("/p/api/AlarmCoreTests/AlarmEngineTests.swift", BuildingKind::Test),
            ("/p/api/AlarmCoreTests/helpers.swift", BuildingKind::Test),
            ("/p/api/src/AlarmEngineTests.swift", BuildingKind::Test),
            ("/p/api/src/FooTest.java", BuildingKind::Test),
            ("/p/api/spec/user_spec.rb", BuildingKind::Test),
            ("/p/api/specs/widget.rs", BuildingKind::Test),
            ("/p/api/src/app.spec.ts", BuildingKind::Test),
            ("/p/api/src/user_spec.rb", BuildingKind::Test),
            ("/p/api/src/SearchSpec.swift", BuildingKind::Test),
            ("/p/api/src/WidgetSpecs.kt", BuildingKind::Test),
            // Existing conventions must keep working alongside the new ones.
            ("/p/api/tests/test_x.py", BuildingKind::Test),
            ("/p/api/src/main.test.ts", BuildingKind::Test),
            ("/p/api/src/main_test.rs", BuildingKind::Test),
            ("/p/api/spec/models/user_spec.rb", BuildingKind::Test),
            ("/p/api/tests/docs/helper.py", BuildingKind::Test),
            // --- negatives: must stay non-Test (the half that matters) ---
            // Coordinator review finding: a prose file is documentation
            // wherever it lives, even under a `spec`/`specs`/`tests`
            // ancestor — `docs/superpowers/specs/design.md` is a design
            // document, not a test suite, and `tests/README.md` is this
            // project's own convention for "how to run the tests", not a
            // test itself.
            ("/p/api/docs/superpowers/specs/design.md", BuildingKind::Docs),
            ("/p/api/tests/README.md", BuildingKind::Docs),
            ("/p/api/src/latest.ts", BuildingKind::Source),
            ("/p/api/src/Latest.swift", BuildingKind::Source),
            ("/p/api/src/contest.rs", BuildingKind::Source),
            ("/p/api/src/attestation.go", BuildingKind::Source),
            ("/p/api/manifest.json", BuildingKind::Config),
            ("/p/api/src/Protest/handler.rs", BuildingKind::Source),
            ("/p/api/src/manifest.json", BuildingKind::Config),
        ];
        for (path, expected) in cases {
            let actual = classify_kind(Path::new("/p/api"), Path::new(path));
            assert_eq!(
                actual, *expected,
                "expected {path} to classify as {expected:?}, got {actual:?}"
            );
        }
    }

    /// Coordinator review finding (regression introduced by defect 2's
    /// fix): `docs/superpowers/specs/design.md` was classified `Test`
    /// (bare `specs` ancestor segment) BEFORE the `.md` prose check ran,
    /// and `build_city` walls a district if ANY of its buildings is
    /// `Test` — so a single misclassified markdown file also silently
    /// walled its district. One classification defect, two visible
    /// symptoms (wrong color AND a wrongly drawn wall); this pins the
    /// wall consequence directly, which is the assertion that would have
    /// caught the original bug.
    #[test]
    fn a_district_whose_only_test_ish_file_is_prose_is_not_walled() {
        let model = city(vec![("/p/api/docs/superpowers/specs/design.md", 40)]);
        let specs = model.districts.iter().find(|d| d.name == "specs").unwrap();
        assert_eq!(specs.buildings[0].kind, BuildingKind::Docs, "a design doc is Docs, not Test");
        assert!(
            !specs.walled,
            "a district whose only test-ish-NAMED file is actually prose must not be walled"
        );
    }

    /// Critical 2 (Phase 0.5b final-fix review), verified live by the
    /// reviewer against `/Users/you/Projects/Tests/speech.cpp/
    /// src/main.cpp`: a repository checked out under a directory whose
    /// name (here, `Tests`, an ancestor of `root` itself, not of any file
    /// inside the repo) happens to satisfy
    /// `is_test_dir_segment_for_classification`'s `ends_with("Tests")`
    /// rule used to misclassify EVERY file in the repository as `Test`,
    /// because `ancestor_segments` scanned `path`'s whole absolute path
    /// instead of stopping at `root`. Every existing model test roots at
    /// `/p/api`, which has no such segment above it, so nothing caught
    /// this. Also pins the `build_city`-level consequence: a district
    /// wrongly walled because every one of its buildings reads as Test.
    #[test]
    fn a_repo_root_segment_named_tests_does_not_turn_source_files_into_test_buildings() {
        let model = build_city(
            Path::new("/Users/u/Projects/Tests/speech.cpp"),
            &FakeFiles(vec![("/Users/u/Projects/Tests/speech.cpp/src/main.cpp", 40)]),
        );
        assert_eq!(model.districts.len(), 1);
        let src = &model.districts[0];
        assert_eq!(
            src.buildings[0].kind,
            BuildingKind::Source,
            "a `Tests` segment ABOVE the repo root must not leak into classification"
        );
        assert!(!src.walled, "no district should be walled by a phantom Test building");
    }

    /// Critical 2 (Phase 0.5b final-fix review), the other direction,
    /// verified live by the reviewer against a repo checked out under
    /// `/Users/u/build/myrepo`: `build` is one of `EXCLUDED_DIRS`, so the
    /// same absolute-path bug in `ancestor_segments` used to exclude
    /// EVERY file in the repository — 0 districts, 0 buildings, all of it
    /// counted `skipped` — a bare-land render that `App.tsx` explicitly
    /// treats as a forbidden false claim of an empty repository.
    #[test]
    fn a_repo_root_segment_named_build_does_not_exclude_the_whole_repo() {
        let model = build_city(
            Path::new("/Users/u/build/myrepo"),
            &FakeFiles(vec![("/Users/u/build/myrepo/src/main.rs", 10)]),
        );
        let building_count: usize = model.districts.iter().map(|d| d.buildings.len()).sum();
        assert_eq!(
            building_count, 1,
            "a `build` segment ABOVE the repo root must not exclude everything under it"
        );
        assert_eq!(model.skipped, 0);
    }

    /// Task 5b, defect 2: widening test detection for classification must
    /// NOT widen `test_candidate_paths`'s marker search — doing so would
    /// let a TOP-LEVEL `AlarmCoreTests/` directory (whose `scope` folds to
    /// the repo root with an EMPTY remainder) generate the repo root
    /// itself as a naming candidate, spuriously walling it. Pin that a
    /// district's OWN `AlarmCoreTests`-style test building walls only that
    /// district directly, and the repository root stays unwalled.
    #[test]
    fn a_module_tests_style_directory_walls_only_itself_not_the_repository_root() {
        let model = city(vec![
            ("/p/api/README.md", 10),
            ("/p/api/AlarmCore/Engine.swift", 40),
            ("/p/api/AlarmCoreTests/EngineTests.swift", 20),
        ]);
        let tests_district = model.districts.iter().find(|d| d.name == "AlarmCoreTests").unwrap();
        let root_district = model.districts.iter().find(|d| d.name == "api").unwrap();
        assert!(tests_district.walled, "AlarmCoreTests owns Test buildings directly");
        assert!(
            !root_district.walled,
            "a top-level <Module>Tests directory must not spuriously wall the repo root"
        );
        let engine_kind = model
            .districts
            .iter()
            .find(|d| d.name == "AlarmCore")
            .unwrap()
            .buildings
            .iter()
            .find(|b| b.name == "Engine.swift")
            .unwrap()
            .kind;
        assert_eq!(engine_kind, BuildingKind::Source, "AlarmCore itself is source, not test");
    }

    /// Task 5b, defect 1: `RealFiles`'s git-aware fast path. `FakeGitFiles`
    /// stands in for `GitFiles` (mirroring `FakeGit`/`GitProbe` in
    /// `world::repo`'s tests), so these exercise `RealFiles::files` itself
    /// — real reads happen against a real `tempfile` directory, but which
    /// paths git "sees" is entirely controlled by the fake, with no real
    /// `git` binary or repository required.
    mod real_files_git_integration {
        use super::*;
        use std::fs;
        use std::thread;

        struct FakeGitFiles(Option<Vec<PathBuf>>);
        impl GitFiles for FakeGitFiles {
            fn ls_files(&self, _root: &Path) -> Option<Vec<PathBuf>> {
                self.0.clone()
            }
        }

        /// A path git reports (tracked or untracked-but-not-ignored) must
        /// become a building candidate even when a gitignored file with
        /// real content sits right next to it on disk — proving exclusion
        /// is driven by git's answer, not by re-walking the filesystem.
        #[test]
        fn a_path_git_reports_is_present_and_an_ignored_path_git_omits_is_absent() {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            fs::create_dir_all(root.join("src")).unwrap();
            fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
            fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
            fs::write(root.join("node_modules/pkg/index.js"), "ignored content").unwrap();

            // Simulates git's real answer: it names src/main.rs but never
            // mentions the gitignored node_modules file, even though both
            // exist on disk.
            let git = FakeGitFiles(Some(vec![PathBuf::from("src/main.rs")]));
            let real = RealFiles::new(Box::new(git));
            let files = real.files(root);

            assert!(
                files.iter().any(|(p, _)| p.ends_with("src/main.rs")),
                "a path git reports must be present"
            );
            assert!(
                !files.iter().any(|(p, _)| p.to_string_lossy().contains("node_modules")),
                "a path git never mentions must never appear, even though it exists on disk"
            );
        }

        /// The `--others` half of the git invocation matters specifically
        /// because brand-new, not-yet-committed work must still appear —
        /// otherwise a file created seconds ago would be invisible until
        /// committed.
        #[test]
        fn an_untracked_but_not_ignored_path_git_reports_is_present() {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            fs::write(root.join("brand_new.rs"), "fn x() {}\n").unwrap();

            let git = FakeGitFiles(Some(vec![PathBuf::from("brand_new.rs")]));
            let real = RealFiles::new(Box::new(git));
            let files = real.files(root);

            assert!(files.iter().any(|(p, lines)| p.ends_with("brand_new.rs") && *lines == Some(1)));
        }

        /// A failing (or absent) `git` must fall back to the plain
        /// filesystem walk, never to an empty file list — an empty city
        /// would be a false claim that the repository has no code.
        ///
        /// Important 3 (Phase 0.5b final-fix review): also pins that this
        /// fallback is REPORTED, not silent — `CityModel::source`/
        /// `FileSource::source` must read `Walk`, so the UI and the SVG
        /// caption can say plainly that this is a filesystem guess, not
        /// git's own answer.
        #[test]
        fn a_failing_git_invocation_falls_back_to_the_walk_rather_than_an_empty_city() {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            fs::create_dir_all(root.join("src")).unwrap();
            fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();

            let git = FakeGitFiles(None); // not a repo, or `git` failed/missing
            let real = RealFiles::new(Box::new(git));
            let files = real.files(root);

            assert!(
                !files.is_empty(),
                "a failed git call must fall back to the walk, not report an empty repo"
            );
            assert!(files.iter().any(|(p, _)| p.ends_with("src/main.rs")));
            assert_eq!(
                real.source(root),
                CitySource::Walk,
                "a degraded (filesystem-walk) run must report itself as such"
            );
        }

        /// The healthy git path must report itself as `Git` — the
        /// complement of the fallback test above, so a regression that
        /// always reports `Walk` (or always reports `Git`) is equally
        /// caught.
        #[test]
        fn a_successful_git_invocation_reports_git_as_its_source() {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();

            let git = FakeGitFiles(Some(vec![PathBuf::from("main.rs")]));
            let real = RealFiles::new(Box::new(git));
            real.files(root);

            assert_eq!(real.source(root), CitySource::Git);
        }

        /// A path containing a space must survive the NUL-delimited
        /// round-trip intact, unmangled by any newline/quote-based
        /// splitting.
        #[test]
        fn a_path_containing_a_space_is_handled_correctly() {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            fs::create_dir_all(root.join("my dir")).unwrap();
            fs::write(root.join("my dir/a file.rs"), "fn x() {}\n").unwrap();

            let git = FakeGitFiles(Some(vec![PathBuf::from("my dir/a file.rs")]));
            let real = RealFiles::new(Box::new(git));
            let files = real.files(root);

            assert_eq!(files.len(), 1);
            assert!(files[0].0.ends_with("my dir/a file.rs"));
            assert_eq!(files[0].1, Some(1));
        }

        /// EXCLUDED_DIRS/lockfile/minified-bundle exclusion must still
        /// apply to a path git DOES report — git only knows about
        /// `.gitignore`, not about this app's own "generated/vendored"
        /// judgement calls, so a *committed* lockfile must still be
        /// excluded.
        #[test]
        fn a_committed_lockfile_git_reports_is_still_excluded() {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            fs::write(root.join("Cargo.lock"), "committed lockfile content\nmore\n").unwrap();

            let git = FakeGitFiles(Some(vec![PathBuf::from("Cargo.lock")]));
            let real = RealFiles::new(Box::new(git));
            let files = real.files(root);

            assert_eq!(files.len(), 1);
            assert_eq!(files[0].1, Some(0), "a known-excluded path is short-circuited to 0 lines");
        }

        /// Coordinator review, Item 1: a submodule ("gitlink") entry must
        /// be detected explicitly (by `is_gitlink_directory`), not
        /// discovered via a failed `read_to_string` — and must produce no
        /// building, must
        /// NOT increment `skipped` (it isn't an unreadable/broken file,
        /// it's a deliberately excluded separate repository), must
        /// increment `submodules`, and must not panic even though the
        /// submodule directory genuinely has real files inside it on
        /// disk.
        #[test]
        fn a_gitlink_entry_is_reported_as_a_submodule_not_an_unreadable_file() {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            // The submodule's own checkout, exactly as it would look on
            // disk: `git ls-files` reports ONE path, "libs/sub", for the
            // whole thing, but that path is a directory containing real
            // files that must never be surfaced as OUR buildings.
            fs::create_dir_all(root.join("libs/sub")).unwrap();
            fs::write(root.join("libs/sub/inside.rs"), "fn hidden() {}\n").unwrap();
            fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();

            let git =
                FakeGitFiles(Some(vec![PathBuf::from("libs/sub"), PathBuf::from("main.rs")]));
            let real = RealFiles::new(Box::new(git));
            let files = real.files(root);

            assert_eq!(files.len(), 1, "the gitlink path must not appear in files() at all");
            assert!(files[0].0.ends_with("main.rs"));
            assert_eq!(real.submodules(root), 1, "the gitlink must be counted as a submodule");

            // And at the `build_city` level: no building, no `skipped`,
            // one `submodules`, no panic.
            let model = build_city(root, &real);
            assert_eq!(model.submodules, 1);
            assert_eq!(model.skipped, 0, "a submodule is not an unreadable file — must not be skipped");
            let building_count: usize = model.districts.iter().map(|d| d.buildings.len()).sum();
            assert_eq!(building_count, 1, "only main.rs should become a building");
            assert!(
                model.districts.iter().all(|d| d.name != "sub"),
                "the submodule must not become its own district"
            );
        }

        /// Coordinator review round 2, Item 1: a git-tracked SYMLINK that
        /// happens to point at a directory must NOT be mistaken for a
        /// submodule. `Path::is_dir()` follows symlinks (`fs::metadata`,
        /// i.e. `stat`), so it can't tell the two apart; `is_gitlink_directory`
        /// must use `symlink_metadata` (`lstat`) instead. Getting this
        /// wrong is both failure directions at once: a real tracked file
        /// (the symlink itself) silently vanishes from the city, AND a
        /// submodule that does not exist gets counted.
        #[test]
        #[cfg(unix)]
        fn a_symlink_to_a_directory_is_not_mistaken_for_a_submodule() {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            fs::create_dir_all(root.join("real_dir")).unwrap();
            fs::write(root.join("real_dir/inside.rs"), "fn x() {}\n").unwrap();
            // A git-tracked symlink pointing at that directory — git lists
            // this as an ordinary blob (mode 120000), not a gitlink.
            std::os::unix::fs::symlink(root.join("real_dir"), root.join("link_to_dir")).unwrap();

            let git = FakeGitFiles(Some(vec![PathBuf::from("link_to_dir")]));
            let real = RealFiles::new(Box::new(git));
            let files = real.files(root);

            assert_eq!(files.len(), 1, "the symlink must still appear in files(), not vanish");
            assert!(files[0].0.ends_with("link_to_dir"));
            assert_eq!(
                real.submodules(root),
                0,
                "a symlink to a directory must never be counted as a submodule"
            );

            // It's not readable as UTF-8 text (it resolves to a
            // directory), so it must land honestly in `skipped` — visible
            // and accounted for, not silently dropped and not miscounted.
            let model = build_city(root, &real);
            assert_eq!(model.submodules, 0);
            assert_eq!(
                model.skipped, 1,
                "a directory-symlink is unreadable as text, not a submodule — it belongs in skipped"
            );
        }

        /// Runs a helper git command in `cwd`, panicking with useful
        /// context on failure (mirrors `world::repo`'s test helper of the
        /// same shape).
        fn run_git(cwd: &Path, args: &[&str]) {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .status()
                .unwrap_or_else(|e| panic!("failed to spawn git {:?} in {:?}: {e}", args, cwd));
            assert!(status.success(), "git {:?} failed in {:?}", args, cwd);
        }

        /// The detail the Task 5b brief's Appendix insists on: a
        /// hand-rolled `.gitignore` parser would miss `.git/info/exclude`
        /// entirely (that's exactly how `my-site-next`'s nested
        /// `.claude/worktrees/...` copy is actually excluded, per the
        /// brief's own investigation) and reproduce most of the bug while
        /// looking fixed. This test runs REAL `git`, against a REAL
        /// tempdir repository, and proves `--exclude-standard` honours
        /// both `.gitignore` AND `.git/info/exclude` together, while
        /// `--others` still surfaces a brand-new untracked file.
        #[test]
        fn real_git_honours_both_gitignore_and_git_info_exclude_but_keeps_untracked_files() {
            let tmp = tempfile::tempdir().expect("tempdir");
            let root = tmp.path();
            run_git(root, &["-c", "init.defaultBranch=main", "init", "-q", "."]);
            run_git(root, &["config", "user.email", "test@example.com"]);
            run_git(root, &["config", "user.name", "Test User"]);

            fs::write(root.join(".gitignore"), "ignored_by_gitignore.txt\n").unwrap();
            fs::write(root.join("tracked.rs"), "fn a() {}\n").unwrap();
            fs::write(root.join("ignored_by_gitignore.txt"), "nope").unwrap();
            run_git(root, &["add", "tracked.rs", ".gitignore"]);
            run_git(root, &["commit", "-q", "-m", "init"]);

            // Brand-new, never-added: --others must still surface this.
            fs::write(root.join("brand_new_untracked.rs"), "fn b() {}\n").unwrap();

            // Excluded via .git/info/exclude, NOT .gitignore — the exact
            // mechanism the Appendix's nested-worktree case relies on.
            fs::write(root.join(".git/info/exclude"), "excluded_by_info_exclude/\n").unwrap();
            fs::create_dir_all(root.join("excluded_by_info_exclude")).unwrap();
            fs::write(root.join("excluded_by_info_exclude/inner.rs"), "fn c() {}\n").unwrap();

            let listed =
                RealGitFiles::default().ls_files(root).expect("git ls-files must succeed in a real repo");
            let names: Vec<String> =
                listed.iter().map(|p| p.to_string_lossy().to_string()).collect();

            assert!(names.contains(&"tracked.rs".to_string()));
            assert!(
                names.contains(&"brand_new_untracked.rs".to_string()),
                "--others must surface a brand-new untracked file"
            );
            assert!(
                !names.iter().any(|n| n.contains("ignored_by_gitignore")),
                ".gitignore must be honoured"
            );
            assert!(
                !names.iter().any(|n| n.contains("excluded_by_info_exclude")),
                ".git/info/exclude must be honoured too, not just .gitignore — a hand-rolled \
                 .gitignore parser would miss this and reproduce most of the bug"
            );
        }

        /// Critical 1 (Phase 0.5b final-fix review), verified live by the
        /// reviewer: `git ls-files --cached --others --exclude-standard -z`
        /// emits an UNMERGED path once PER STAGE, so a single real `UU`
        /// merge conflict prints the same relative path three times over.
        /// Before deduplication in `RealFiles::files`, that meant three
        /// identical `Building`s in one district (placed at three
        /// different cells by `gnomon_position`, since it indexes by
        /// position in the list, not by path) for a file that does not
        /// exist three times on disk — and a merge conflict is exactly
        /// the moment a stopped agent's town is most likely to be opened.
        /// This runs against a REAL git repository with a REAL conflict
        /// (not a hand-rolled fake list), confirms the underlying premise
        /// live (git really does list the path more than once), then
        /// proves `RealFiles` + `build_city` together produce exactly one
        /// building for it. The pre-existing git-integration tests in this
        /// module all use a clean repository, which is why none of them
        /// caught this.
        #[test]
        fn a_merge_conflict_produces_exactly_one_building_not_one_per_stage() {
            let tmp = tempfile::tempdir().expect("tempdir");
            let root = tmp.path();
            run_git(root, &["-c", "init.defaultBranch=main", "init", "-q", "."]);
            run_git(root, &["config", "user.email", "test@example.com"]);
            run_git(root, &["config", "user.name", "Test User"]);

            fs::write(root.join("f.txt"), "base\n").unwrap();
            run_git(root, &["add", "f.txt"]);
            run_git(root, &["commit", "-q", "-m", "base"]);

            run_git(root, &["checkout", "-q", "-b", "branch-a"]);
            fs::write(root.join("f.txt"), "from branch a\n").unwrap();
            run_git(root, &["commit", "-q", "-am", "branch a"]);

            run_git(root, &["checkout", "-q", "main"]);
            fs::write(root.join("f.txt"), "from main\n").unwrap();
            run_git(root, &["commit", "-q", "-am", "from main"]);

            // `git merge` exits non-zero on a real conflict, which
            // `run_git`'s helper would treat as a test failure, so this
            // invokes it directly and asserts the conflict actually
            // happened instead (a clean merge would silently defeat the
            // whole point of this test).
            let status = std::process::Command::new("git")
                .args(["merge", "-q", "branch-a"])
                .current_dir(root)
                .status()
                .expect("failed to spawn git merge");
            assert!(!status.success(), "the merge must produce a real conflict for this test to mean anything");

            // Confirm the premise this fix depends on: real git really
            // does list the conflicted path more than once.
            let raw = RealGitFiles::default().ls_files(root).expect("git ls-files must succeed even mid-conflict");
            let raw_count = raw.iter().filter(|p| p.ends_with("f.txt")).count();
            assert!(
                raw_count > 1,
                "expected git to report the conflicted path more than once (per-stage), got {raw_count}"
            );

            let real = RealFiles::new(Box::new(RealGitFiles::default()));
            let model = build_city(root, &real);
            let building_count: usize = model.districts.iter().map(|d| d.buildings.len()).sum();
            assert_eq!(
                building_count, 1,
                "a merge conflict must not fabricate duplicate buildings for one real file"
            );
        }

        /// A directory with no `.git` anywhere in its ancestry: real `git
        /// ls-files` must fail (non-zero exit), and `RealGitFiles::ls_files`
        /// must report that as `None`, not panic or return an empty `Vec`.
        #[test]
        fn real_git_reports_none_for_a_non_repository_directory() {
            let tmp = tempfile::tempdir().expect("tempdir");
            assert!(
                RealGitFiles::default().ls_files(tmp.path()).is_none(),
                "a plain non-git directory must report None, not an empty listing"
            );
        }

        /// Coordinator review, Item 2: a hung `git` must never block
        /// `build_city` forever — `city_for` runs this on a user click.
        /// `run_with_timeout` is the extracted mechanism `RealGitFiles`
        /// delegates to; testing it directly against the universally
        /// available `sleep` command (rather than trying to make a real
        /// `git` invocation hang to order, which nothing can reliably
        /// arrange) proves the actual expiry-and-kill path fires, not
        /// just that the type-checks compile.
        #[test]
        fn run_with_timeout_kills_a_hung_child_and_returns_none_promptly() {
            let mut cmd = std::process::Command::new("sleep");
            cmd.arg("5"); // must NOT actually be waited out below

            let start = std::time::Instant::now();
            let result = run_with_timeout(cmd, Duration::from_millis(100));
            let elapsed = start.elapsed();

            assert!(result.is_none(), "a timed-out command must be treated as a failure");
            assert!(
                elapsed < Duration::from_secs(2),
                "must return promptly on timeout, not wait for the full sleep ({elapsed:?} elapsed)"
            );
        }

        /// Coordinator review round 2, Item 3: the previous test only
        /// proves the CALL returns quickly — that outcome follows from the
        /// timeout arm alone and says nothing about whether the process
        /// was actually killed. If `child.kill()` were deleted, wrong, or
        /// silently swallowing an error, this test's predecessor would
        /// still pass while `sleep` ran to completion in the background,
        /// leaking an orphaned process on every timeout. This test
        /// captures the real OS pid (via a shell that `exec`s into
        /// `sleep`, so the recorded pid is exactly the one
        /// `run_with_timeout`'s `child` wraps — not an intermediate shell
        /// pid) and polls for that pid actually being gone afterward.
        ///
        /// Verified by mutation while writing this: commenting out the
        /// `child.kill()` call in `run_with_timeout` turns this test red
        /// (it fails the "process is still alive" assertion) while the
        /// call-returns-promptly test above stays green — confirming the
        /// two tests check genuinely different things.
        #[test]
        #[cfg(unix)]
        fn run_with_timeout_actually_terminates_the_process_not_just_the_call() {
            let tmp = tempfile::tempdir().unwrap();
            let pid_file = tmp.path().join("pid");
            let mut cmd = std::process::Command::new("sh");
            // `exec` replaces the shell in place, so the pid written here
            // is the SAME pid `run_with_timeout`'s `Child` represents —
            // not a parent shell whose own death would tell us nothing
            // about whether the actual long-running process was reached.
            cmd.arg("-c").arg(format!("echo $$ > {} && exec sleep 5", pid_file.display()));

            let result = run_with_timeout(cmd, Duration::from_millis(150));
            assert!(result.is_none(), "must report the hung command as a failure");

            let pid_text = std::fs::read_to_string(&pid_file)
                .expect("the child must have started and recorded its own pid before exec'ing");
            let pid: u32 = pid_text.trim().parse().expect("pid file must contain a plain integer");

            // Poll rather than assert once: `kill()`+`wait()` inside
            // `run_with_timeout` already reaps it before returning, but a
            // short retry keeps this robust against OS scheduling jitter
            // rather than asserting on a razor's-edge timing assumption.
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                let still_alive = std::process::Command::new("kill")
                    .arg("-0")
                    .arg(pid.to_string())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if !still_alive {
                    return;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "process {pid} is still alive well after run_with_timeout returned \
                     — the kill did not actually terminate it"
                );
                thread::sleep(Duration::from_millis(20));
            }
        }

        /// The non-hanging case must still work through the same
        /// mechanism: a command that finishes well within the timeout
        /// reports its real output.
        #[test]
        fn run_with_timeout_returns_output_for_a_command_that_finishes_in_time() {
            let mut cmd = std::process::Command::new("echo");
            cmd.arg("hello");
            let result = run_with_timeout(cmd, Duration::from_secs(5));
            let output = result.expect("a fast command must not be treated as a timeout");
            assert!(output.status.success());
            assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hello");
        }

        /// Coordinator review round 2, Item 2 (THE TRAP): polling
        /// `try_wait` in the calling thread means nothing reads
        /// stdout/stderr unless dedicated reader threads do it
        /// concurrently. A child that writes more than the OS pipe
        /// buffer (commonly 64KiB) blocks on its own `write()` call until
        /// something drains the pipe — if that never happens, `try_wait`
        /// never observes the process exiting, and a command that would
        /// have finished in milliseconds instead silently eats the ENTIRE
        /// timeout. `git ls-files` on the user's own `my-site-next`
        /// (1,385 NUL-delimited paths, ~55KB) sits close enough to that
        /// limit that this is a live risk on a real repository, not a
        /// hypothetical one — this test uses `yes` piped through `head`
        /// equivalent (via a shell one-liner) to produce comfortably over
        /// 64KiB on stdout well within a generous timeout, and asserts
        /// the full output arrives AND the call does not degrade into a
        /// bogus timeout.
        #[test]
        #[cfg(unix)]
        fn stdout_larger_than_the_pipe_buffer_does_not_deadlock_or_time_out() {
            const WANT_BYTES: usize = 200_000; // well over any common 64KiB pipe buffer
            let mut cmd = std::process::Command::new("sh");
            cmd.arg("-c").arg(format!(
                "yes 0123456789abcdef | head -c {WANT_BYTES}"
            ));

            let start = std::time::Instant::now();
            let result = run_with_timeout(cmd, Duration::from_secs(10));
            let elapsed = start.elapsed();

            let output = result.expect(
                "a large-output command that exits promptly must not be treated as a timeout",
            );
            assert!(output.status.success());
            assert_eq!(
                output.stdout.len(),
                WANT_BYTES,
                "the full output must arrive, not be truncated by an unread, full pipe buffer"
            );
            assert!(
                elapsed < Duration::from_secs(5),
                "a fast command must not be slowed down anywhere near the 10s timeout \
                 ({elapsed:?} elapsed) — that would mean the pipe-buffer deadlock is back"
            );
        }
    }

    /// Step 5: sanity-check against real repositories on this machine.
    /// `#[ignore]`d because it depends on the developer's `~/Projects`
    /// layout; run explicitly with:
    ///   cargo test city::model::real_repos_sanity_check -- --ignored --nocapture
    ///
    /// This does not assert much beyond "it doesn't panic" — the actual
    /// judgement (is any district absurd, did node_modules slip through,
    /// is the height distribution sane, are tests classified as tests) is
    /// made by reading the printed output, per the task brief: adjusting
    /// this test to force a pass would defeat its entire purpose.
    #[test]
    #[ignore]
    fn real_repos_sanity_check() {
        let home = std::env::var("HOME").expect("HOME must be set");
        let candidates = [
            format!("{home}/Projects/AgeOfAgents"),
            format!("{home}/Projects/clients/picks"),
            format!("{home}/Projects/Old"),
            format!("{home}/Projects/my-site-next"),
            format!("{home}/Projects/pocketAlarm"),
        ];

        for root in candidates {
            let root = PathBuf::from(root);
            if !root.exists() {
                println!("=== {} === SKIPPED (not present)", root.display());
                continue;
            }
            let model = build_city(&root, &RealFiles::new(Box::new(RealGitFiles::default())));
            println!("=== {} ===", model.root);
            println!(
                "districts: {}, total buildings: {}, skipped: {}",
                model.districts.len(),
                model.districts.iter().map(|d| d.buildings.len()).sum::<usize>(),
                model.skipped
            );
            let mut by_height = [0u32; 6];
            let mut test_kind_count = 0u32;
            let mut walled_by_own_test = 0u32;
            let mut walled_by_naming = 0u32;
            let mut max_district = 0usize;
            let mut max_district_name = String::new();
            for d in &model.districts {
                if d.buildings.len() > max_district {
                    max_district = d.buildings.len();
                    max_district_name = d.name.clone();
                }
                if d.walled {
                    if d.buildings.iter().any(|b| b.kind == BuildingKind::Test) {
                        walled_by_own_test += 1;
                    } else {
                        walled_by_naming += 1;
                    }
                }
                for b in &d.buildings {
                    by_height[b.height as usize] += 1;
                    if b.kind == BuildingKind::Test {
                        test_kind_count += 1;
                    }
                }
            }
            println!("height distribution (1..5): {:?}", &by_height[1..=5]);
            println!(
                "test-kind buildings: {test_kind_count}, walled districts: {} (by own Test building: {walled_by_own_test}, by naming only: {walled_by_naming})",
                walled_by_own_test + walled_by_naming
            );
            println!("largest district: '{max_district_name}' with {max_district} buildings");
            println!(
                "sample district names: {:?}",
                model.districts.iter().take(10).map(|d| d.name.as_str()).collect::<Vec<_>>()
            );

            // Fix round 2, investigation: an excluded directory must never
            // appear as ANY segment of a surviving district's path, not
            // just as a leading one.
            let leaked: Vec<&str> = model
                .districts
                .iter()
                .filter(|d| {
                    Path::new(&d.path)
                        .components()
                        .filter_map(|c| c.as_os_str().to_str())
                        .any(|seg| EXCLUDED_DIRS.contains(&seg))
                })
                .map(|d| d.path.as_str())
                .collect();
            println!("districts with an excluded segment anywhere in their path (must be empty): {leaked:?}");
        }
    }
}
