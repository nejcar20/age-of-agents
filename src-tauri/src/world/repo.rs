use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub root: PathBuf,
    pub name: String,
    pub is_worktree: bool,
}

pub trait GitProbe {
    fn toplevel(&self, cwd: &Path) -> Option<PathBuf>;
    fn common_dir(&self, cwd: &Path) -> Option<PathBuf>;

    /// The Unix timestamp (seconds) of `root`'s most recent commit, or
    /// `None` if that can't be determined honestly — no commits yet, `root`
    /// isn't a repository, or the underlying git call failed/timed out.
    /// `None` must never be papered over with a fabricated value ("now", the
    /// epoch, ...): a caller that wants to *sort* by this has to be able to
    /// tell "genuinely unknown" apart from "very old" or "just changed".
    ///
    /// Defaulted to `None` so every existing `GitProbe` test double (none of
    /// which care about this) keeps compiling unchanged; `RealGit` is the
    /// only implementation that overrides it.
    fn last_commit_epoch(&self, _root: &Path) -> Option<i64> {
        None
    }
}

/// Important 5 (Phase 0.5b final-fix review): unlike `city::model`'s
/// `RealGitFiles`, which only ever runs on a user click, `RealGit::run` is
/// called synchronously from `build_world` on the tokio task that owns
/// Herdr's event loop (`herdr::events::build_world`, reached from the
/// pane-scan timer). The previous implementation used `.output()` with no
/// bound at all: a stalled credential-helper prompt, an index lock held by
/// another process, or a stuck network mount would freeze the whole app
/// forever, with no recovery — exactly the "never slower than a terminal"
/// hazard `run_with_timeout` was built to close on the `city::model` click
/// path. `timeout` is a field (with `DEFAULT_TIMEOUT` as the production
/// default via `Default`, mirroring `RealGitFiles`) rather than a
/// hardcoded constant specifically so the expiry path is testable.
pub struct RealGit {
    timeout: Duration,
}

impl RealGit {
    /// Same bound and rationale as `RealGitFiles::DEFAULT_TIMEOUT`: a real
    /// repository answers `rev-parse` in milliseconds, so this ceiling only
    /// ever matters when something has genuinely gone wrong. `RepoResolver`
    /// memoizes per cwd, so this cost is paid at most once per distinct
    /// cwd, not on every event-loop tick.
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

    pub fn new(timeout: Duration) -> Self {
        RealGit { timeout }
    }

    /// Runs `git <args>` in `cwd`, bounded by `self.timeout`, and returns its
    /// trimmed stdout as text — the shared core both `run` (which further
    /// interprets the text as a path) and `last_commit_epoch` (which parses
    /// it as an integer) build on, so there is exactly one race-free,
    /// timeout-bounded subprocess mechanism in this type, not two.
    fn run_text(&self, cwd: &Path, args: &[&str]) -> Option<String> {
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(cwd);
        let out = run_with_timeout(cmd, self.timeout)?;
        if !out.status.success() { return None; }
        let text = String::from_utf8(out.stdout).ok()?;
        let trimmed = text.trim();
        if trimmed.is_empty() { return None; }
        Some(trimmed.to_string())
    }

    fn run(&self, cwd: &Path, args: &[&str]) -> Option<PathBuf> {
        let trimmed = self.run_text(cwd, args)?;
        let path = PathBuf::from(&trimmed);
        Some(if path.is_absolute() { path } else { cwd.join(path) })
    }
}

impl Default for RealGit {
    fn default() -> Self {
        RealGit::new(Self::DEFAULT_TIMEOUT)
    }
}

/// Runs `cmd` to completion and returns its output, unless it takes longer
/// than `timeout` — in which case the child is killed and this returns
/// `None`, exactly like a spawn failure.
///
/// Moved here (Phase 0.5b final-fix review, Important 5) from
/// `city::model`, its original home, so both `city::model::RealGitFiles`
/// (the click-path `git ls-files` invocation) and `RealGit` here (the
/// hot-path `git rev-parse` invocation reached from Herdr's event loop)
/// share the exact same race-free timeout-and-kill mechanism rather than a
/// second, drifting reimplementation. `city::model` already depends on
/// `world::repo` (see `normalize_path`), so this direction of sharing adds
/// no new dependency edge.
///
/// The properties this relies on, preserved unchanged from the original:
/// - `child` is kept in the CALLING thread for its entire life. As long as
///   nobody has reaped it, its PID cannot have been recycled onto an
///   unrelated process, so `child.kill()` on the still-owned `Child` is
///   race-free — no PID lookup, no window for the OS to hand that PID to
///   something else (a real hazard on the user's own, currently-in-use
///   machine, however unlikely).
/// - `stdout`/`stderr` are drained concurrently by their own reader
///   threads from the moment the child is spawned. Polling `try_wait`
///   alone never reads either pipe; a child that writes more than the OS
///   pipe buffer (commonly 64KiB — `git ls-files` on a repository the size
///   of the user's own `my-site-next`, ~55KB, sits close enough to that
///   limit to matter) would otherwise block on its own `write()` forever,
///   silently turning a fast, successful call into a bogus full-length
///   timeout.
pub(crate) fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<std::process::Output> {
    use std::io::Read;

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;

    let mut stdout_pipe = child.stdout.take();
    let stdout_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let mut stderr_pipe = child.stderr.take();
    let stderr_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });

    const POLL_INTERVAL: Duration = Duration::from_millis(10);
    let deadline = std::time::Instant::now() + timeout;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() < deadline => thread::sleep(POLL_INTERVAL),
            Ok(None) | Err(_) => break None,
        }
    };

    let Some(status) = exit_status else {
        // Timed out (or `try_wait` itself errored). `child` is still
        // exclusively ours — nothing has reaped it — so killing and
        // waiting through the `Child` value directly is race-free by
        // construction, unlike a PID-based kill from another thread.
        let _ = child.kill();
        let _ = child.wait();
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        return None;
    };

    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    Some(std::process::Output { status, stdout, stderr })
}

impl GitProbe for RealGit {
    fn toplevel(&self, cwd: &Path) -> Option<PathBuf> {
        self.run(cwd, &["rev-parse", "--show-toplevel"])
    }
    fn common_dir(&self, cwd: &Path) -> Option<PathBuf> {
        self.run(cwd, &["rev-parse", "--git-common-dir"])
    }

    /// `git log -1 --format=%ct` — the committer date (`%ct`, already Unix
    /// epoch seconds, no locale-dependent formatting to parse) of the most
    /// recent commit reachable from `HEAD`. Cheap (a single lookup, no
    /// history walk beyond the first entry) and honest: a repo with zero
    /// commits, or any failed/timed-out git call, prints nothing and this
    /// returns `None` rather than guessing — never "now", never the epoch.
    ///
    /// Deliberately the committer date, not a filesystem walk for the
    /// newest mtime: `build_world` runs on Herdr's event-loop task (see this
    /// type's own doc comment on why `run_with_timeout` exists at all), and
    /// walking a whole working tree there for every island on every
    /// world-changing event would reintroduce exactly the "freeze the app"
    /// hazard that timeout was built to close — a real repo the size of the
    /// user's own `pocketAlarm` (task-6-design-inputs.md §7.2) makes that a
    /// non-starter, not a theoretical worry. The commit clock is also the
    /// more STABLE signal for a sort: a working tree with no commits yet
    /// legitimately has no honest "last changed" answer at all, whereas a
    /// dirty-but-uncommitted repo simply keeps whatever its last commit's
    /// time was until it's committed, rather than the sort order jittering
    /// on every keystroke a running agent happens to save mid-edit.
    fn last_commit_epoch(&self, root: &Path) -> Option<i64> {
        self.run_text(root, &["log", "-1", "--format=%ct"])?.parse().ok()
    }
}

pub struct RepoResolver {
    probe: Box<dyn GitProbe + Send + Sync>,
    cache: HashMap<PathBuf, Option<RepoRef>>,
    /// `(fetched_at, value)` per repo root — see `last_changed` for why this
    /// is time-bounded rather than permanent like `cache` above: a repo's
    /// last-commit time is expected to actually change while the app runs
    /// (that's the whole point of exposing it), so memoizing it forever
    /// would freeze every island's sort position at whatever it was when
    /// first observed.
    last_changed_cache: HashMap<PathBuf, (Instant, Option<i64>)>,
}

impl RepoResolver {
    /// How long a `last_changed` answer is trusted before re-asking git.
    /// `build_world` runs once per world-changing herdr event (see
    /// `herdr::events`), which can fire in rapid bursts (a reconnect, a
    /// flurry of agent status changes) — without this, every one of those
    /// would spawn a `git log` per open island. A real commit landing up to
    /// this long ago before it's reflected is an acceptable trade for not
    /// re-invoking git on every burst; `resolve`'s own cache above is the
    /// more aggressive (permanent) version of the same idea for the part of
    /// the answer that genuinely never changes for a given cwd.
    const LAST_CHANGED_CACHE_TTL: Duration = Duration::from_secs(15);

    pub fn new(probe: Box<dyn GitProbe + Send + Sync>) -> Self {
        RepoResolver { probe, cache: HashMap::new(), last_changed_cache: HashMap::new() }
    }

    /// The Unix timestamp (seconds) `root`'s most recent commit landed at,
    /// or `None` if that's genuinely unknown (see `GitProbe::last_commit_
    /// epoch`) — cached per root for `LAST_CHANGED_CACHE_TTL` so a burst of
    /// `build_world` calls in quick succession doesn't spawn a `git log` per
    /// island per call.
    pub fn last_changed(&mut self, root: &Path) -> Option<i64> {
        if let Some((fetched_at, value)) = self.last_changed_cache.get(root) {
            if fetched_at.elapsed() < Self::LAST_CHANGED_CACHE_TTL {
                return *value;
            }
        }
        let value = self.probe.last_commit_epoch(root);
        self.last_changed_cache.insert(root.to_path_buf(), (Instant::now(), value));
        value
    }

    pub fn resolve(&mut self, cwd: &Path) -> Option<RepoRef> {
        if let Some(hit) = self.cache.get(cwd) {
            return hit.clone();
        }
        let resolved = self.compute(cwd);
        self.cache.insert(cwd.to_path_buf(), resolved.clone());
        resolved
    }

    fn compute(&self, cwd: &Path) -> Option<RepoRef> {
        let toplevel = self.probe.toplevel(cwd)?;
        // `--git-common-dir` points at the main repo's .git even from a worktree.
        // NOTE: real git prints this RELATIVE to cwd when cwd is not already the
        // repo/worktree root (e.g. "../../../.git" three levels down). `RealGit::run`
        // joins that onto cwd with `Path::join`, which does NOT collapse `..`
        // components, so `common` can be something like
        // "/repo/src/deep/nested/../../../.git" here. We must normalize before
        // taking `.parent()` and before comparing against `toplevel`, or a plain
        // nested checkout gets misclassified as a worktree and, worse, the same
        // repository resolves to a different `root` (and thus a different island
        // id) depending on how deep the pane's cwd happens to be.
        let root = match self.probe.common_dir(cwd) {
            Some(common) if common.file_name().map(|n| n == ".git").unwrap_or(false) => {
                common.parent().map(Path::to_path_buf).unwrap_or_else(|| toplevel.clone())
            }
            _ => toplevel.clone(),
        };
        let toplevel = normalize_path(&toplevel);
        let root = normalize_path(&root);
        let name = root.file_name()?.to_string_lossy().to_string();
        Some(RepoRef { is_worktree: root != toplevel, root, name })
    }
}

/// Normalizes a path for equality comparison.
///
/// Prefers `std::fs::canonicalize`, which both collapses `.`/`..` components
/// and resolves symlinks (important on macOS, where e.g. `/tmp` is itself a
/// symlink to `/private/tmp` and home directories are commonly symlinked
/// too — canonicalizing only one side of a comparison would just trade one
/// mismatch bug for another).
///
/// `canonicalize` requires the path to exist on disk, which real repo/worktree
/// paths always do, but unit tests exercise `compute()` with synthetic
/// `GitProbe` paths that are never present on the filesystem, and a deleted
/// cwd must still degrade to `None` cleanly rather than panicking. So on
/// failure this falls back to a purely lexical collapse of `.` and `..`
/// path components (no filesystem access), which is enough to make
/// comparisons correct for those cases too.
///
/// `pub(crate)` because `world::unsettled` and `commands::list_unsettled`
/// reuse it (Phase 0.5a fix round 1): `Island.root` is produced by this
/// function, so any path compared against it — scanned repo paths, the
/// settled-roots list — must go through the exact same normalization or a
/// repo reached through a symlinked directory (iCloud Drive, Dropbox, a
/// symlinked `~/code`, ...) spells differently on each side and never
/// matches, silently offering an already-settled repo as unsettled forever.
pub(crate) fn normalize_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return canonical;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct FakeGit {
        toplevel: HashMap<PathBuf, PathBuf>,
        common: HashMap<PathBuf, PathBuf>,
        calls: Arc<AtomicUsize>,
    }
    impl GitProbe for FakeGit {
        fn toplevel(&self, cwd: &Path) -> Option<PathBuf> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.toplevel.get(cwd).cloned()
        }
        fn common_dir(&self, cwd: &Path) -> Option<PathBuf> {
            self.common.get(cwd).cloned()
        }
    }

    fn resolver(calls: Arc<AtomicUsize>) -> RepoResolver {
        let mut toplevel = HashMap::new();
        let mut common = HashMap::new();
        // A normal checkout.
        toplevel.insert(PathBuf::from("/p/api/src"), PathBuf::from("/p/api"));
        common.insert(PathBuf::from("/p/api/src"), PathBuf::from("/p/api/.git"));
        // A worktree of the same repo.
        toplevel.insert(PathBuf::from("/p/api-wt"), PathBuf::from("/p/api-wt"));
        common.insert(PathBuf::from("/p/api-wt"), PathBuf::from("/p/api/.git"));
        RepoResolver::new(Box::new(FakeGit { toplevel, common, calls }))
    }

    #[test]
    fn resolves_a_subdirectory_to_the_repo_root() {
        let r = resolver(Arc::new(AtomicUsize::new(0)))
            .resolve(Path::new("/p/api/src")).unwrap();
        assert_eq!(r.root, PathBuf::from("/p/api"));
        assert_eq!(r.name, "api");
        assert!(!r.is_worktree);
    }

    #[test]
    fn worktrees_collapse_onto_the_main_repo() {
        let r = resolver(Arc::new(AtomicUsize::new(0)))
            .resolve(Path::new("/p/api-wt")).unwrap();
        assert_eq!(r.root, PathBuf::from("/p/api"), "worktree must map to the main repo");
        assert!(r.is_worktree);
    }

    #[test]
    fn non_repo_paths_resolve_to_none() {
        assert!(resolver(Arc::new(AtomicUsize::new(0)))
            .resolve(Path::new("/tmp/nowhere")).is_none());
    }

    #[test]
    fn results_are_memoized_per_cwd() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut r = resolver(calls.clone());
        r.resolve(Path::new("/p/api/src"));
        r.resolve(Path::new("/p/api/src"));
        assert_eq!(calls.load(Ordering::Relaxed), 1, "git must be probed once per cwd");
    }

    /// Regression test for the `RealGit::run` relative-path branch, which none
    /// of the tests above actually exercise: `FakeGit` above always returns an
    /// ALREADY-ABSOLUTE common-dir (e.g. "/p/api/.git"), but real git only does
    /// that when cwd is already the repo/worktree root. From a nested
    /// subdirectory, `git rev-parse --git-common-dir` prints a path RELATIVE to
    /// cwd (verified empirically: one level down -> "../.git", three levels
    /// down -> "../../../.git"), which `RealGit::run` then joins onto cwd
    /// WITHOUT collapsing the `..` components. This test reproduces that exact
    /// shape via `FakeGit` and must fail against the pre-fix `compute()`, which
    /// compared the un-normalized joined path directly against `toplevel`.
    #[test]
    fn resolves_a_deeply_nested_subdirectory_via_relative_common_dir() {
        let cwd = PathBuf::from("/p/api/src/deep/nested");
        let mut toplevel = HashMap::new();
        toplevel.insert(cwd.clone(), PathBuf::from("/p/api"));
        let mut common = HashMap::new();
        // Mirrors exactly what `RealGit::run` produces for real git's relative
        // "../../../.git" output three levels below the repo root: cwd joined
        // (not normalized) with the relative common-dir path.
        common.insert(cwd.clone(), cwd.join("../../../.git"));

        let mut r = RepoResolver::new(Box::new(FakeGit {
            toplevel,
            common,
            calls: Arc::new(AtomicUsize::new(0)),
        }));
        let resolved = r.resolve(&cwd).expect("should resolve to a repo");

        assert_eq!(
            resolved.root,
            PathBuf::from("/p/api"),
            "a deeply nested pane must collapse onto the same repo root as the repo root itself"
        );
        assert!(!resolved.is_worktree, "an ordinary nested checkout is not a worktree");
    }

    /// Runs a helper git command in `cwd`, panicking with useful context on failure.
    fn run_git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap_or_else(|e| panic!("failed to spawn git {:?} in {:?}: {e}", args, cwd));
        assert!(status.success(), "git {:?} failed in {:?}", args, cwd);
    }

    fn init_repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        // `-c` is a global git option and must precede the subcommand.
        run_git(dir, &["-c", "init.defaultBranch=main", "init", "-q", "."]);
        run_git(dir, &["config", "user.email", "test@example.com"]);
        run_git(dir, &["config", "user.name", "Test User"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        run_git(dir, &["add", "."]);
        run_git(dir, &["commit", "-q", "-m", "init"]);
    }

    /// Regression guard for the island-id invariant this task exists to
    /// guarantee: the SAME repository must resolve to the SAME `root` (and
    /// therefore the same island id in Task 6) whether a pane's cwd is the
    /// repo root or a subdirectory several levels deep, against REAL git
    /// (not `FakeGit`). All filesystem work happens under a `tempfile`
    /// temp directory, never inside this project's own repo.
    #[test]
    fn real_git_resolves_root_and_nested_subdirectory_to_the_same_root() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        let nested = repo.join("src-tauri/src/herdr");
        std::fs::create_dir_all(&nested).unwrap();

        let mut resolver = RepoResolver::new(Box::new(RealGit::default()));
        let from_root = resolver.resolve(&repo).expect("resolve from repo root");
        let from_nested = resolver.resolve(&nested).expect("resolve from nested subdir");

        assert_eq!(
            from_root.root, from_nested.root,
            "the same repository must yield the same island id regardless of pane depth"
        );
        assert!(!from_root.is_worktree);
        assert!(!from_nested.is_worktree);
    }

    /// Optional (but attempted) coverage: a real `git worktree add` checkout
    /// must collapse onto the main repo's root with `is_worktree == true`.
    #[test]
    fn real_git_worktree_collapses_onto_the_main_repo_root() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        let worktree = tmp.path().join("repo-wt");
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "wt-branch",
                worktree.to_str().unwrap(),
            ],
        );

        let mut resolver = RepoResolver::new(Box::new(RealGit::default()));
        let from_root = resolver.resolve(&repo).expect("resolve from repo root");
        let from_worktree = resolver.resolve(&worktree).expect("resolve from worktree");

        assert_eq!(
            from_root.root, from_worktree.root,
            "a worktree must collapse onto the same island as the main repo"
        );
        assert!(!from_root.is_worktree);
        assert!(from_worktree.is_worktree);
    }

    /// `RealGit::last_commit_epoch` against a real repository: a fresh repo
    /// with one commit reports that commit's own committer time (`%ct`),
    /// verified against `git log -1 --format=%ct` run independently, not
    /// just "returns Some".
    #[test]
    fn real_git_reports_the_last_commit_time() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = tmp.path().join("repo");
        init_repo(&repo);

        let expected = String::from_utf8(
            Command::new("git")
                .args(["log", "-1", "--format=%ct"])
                .current_dir(&repo)
                .output()
                .expect("git log")
                .stdout,
        )
        .unwrap()
        .trim()
        .parse::<i64>()
        .unwrap();

        let got = RealGit::default().last_commit_epoch(&repo);
        assert_eq!(got, Some(expected));
    }

    /// A repository with no commits yet (a fresh `git init`, nothing
    /// committed) must report `None`, not a fabricated "now" or "0" — this
    /// is the honesty requirement the caller (`Island.last_changed_at`)
    /// depends on to render "unknown" rather than sorting a lie.
    #[test]
    fn real_git_reports_no_last_commit_time_for_a_repo_with_no_commits() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["-c", "init.defaultBranch=main", "init", "-q", "."]);

        assert_eq!(RealGit::default().last_commit_epoch(&repo), None);
    }

    /// A directory that isn't a git repository at all must also degrade to
    /// `None`, exactly like `toplevel`/`common_dir` already do.
    #[test]
    fn real_git_reports_no_last_commit_time_for_a_non_repository() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(RealGit::default().last_commit_epoch(tmp.path()), None);
    }

    /// `RepoResolver::last_changed` must not spawn a fresh git call on every
    /// invocation for the same root within the TTL window — the whole
    /// reason it exists is to survive a burst of `build_world` calls (a
    /// herdr reconnect, several rapid status changes) without one `git log`
    /// per island per call.
    #[test]
    fn last_changed_is_cached_across_repeated_calls_for_the_same_root() {
        struct CountingGit {
            calls: Arc<AtomicUsize>,
        }
        impl GitProbe for CountingGit {
            fn toplevel(&self, _cwd: &Path) -> Option<PathBuf> {
                None
            }
            fn common_dir(&self, _cwd: &Path) -> Option<PathBuf> {
                None
            }
            fn last_commit_epoch(&self, _root: &Path) -> Option<i64> {
                self.calls.fetch_add(1, Ordering::Relaxed);
                Some(1_700_000_000)
            }
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let mut resolver = RepoResolver::new(Box::new(CountingGit { calls: calls.clone() }));
        let root = Path::new("/p/api");

        assert_eq!(resolver.last_changed(root), Some(1_700_000_000));
        assert_eq!(resolver.last_changed(root), Some(1_700_000_000));
        assert_eq!(resolver.last_changed(root), Some(1_700_000_000));
        assert_eq!(calls.load(Ordering::Relaxed), 1, "must probe git at most once within the TTL");
    }

    /// A `GitProbe` that cannot answer (the default `None`, or a real
    /// failure) must come through `RepoResolver::last_changed` as `None`
    /// too — the cache must never turn "unknown" into a fabricated value.
    #[test]
    fn last_changed_is_none_when_the_probe_does_not_know() {
        let mut resolver = resolver(Arc::new(AtomicUsize::new(0)));
        assert_eq!(resolver.last_changed(Path::new("/p/api")), None);
    }

    /// Regression test for Important 5 (Phase 0.5b final-fix review):
    /// `RealGit::run` used to call `.output()` directly with no bound at
    /// all, so a hung `git` (a stalled credential-helper prompt, an index
    /// lock, a stuck network mount) would freeze `build_world`'s tokio task
    /// — and therefore the whole app — forever, with no recovery.
    /// `RealGit::new` now threads a configurable timeout through to the
    /// same `run_with_timeout` mechanism `RealGitFiles` already relies on
    /// (whose own kill/drain/no-PID-race properties are exhaustively
    /// tested where that function lives — this test only needs to prove
    /// `RealGit` actually wires a real subprocess call through it).
    ///
    /// Rather than contriving an actual multi-second hang (nothing can
    /// reliably make a real `git` hang to order), this uses a timeout of
    /// one nanosecond against a real, freshly-initialized repository: by
    /// the time the poll loop's first `try_wait` call runs, the deadline
    /// has unconditionally already passed, so this deterministically
    /// exercises the exact same expiry-and-kill branch a genuine multi-
    /// second hang would — without the test itself taking anywhere near
    /// that long, and without needing a fake `git` on `PATH` (which would
    /// race every other test in this binary that shells out to the real
    /// one).
    #[test]
    fn a_real_git_call_that_exceeds_its_timeout_reports_none_promptly() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = tmp.path().join("repo");
        init_repo(&repo);

        let git = RealGit::new(Duration::from_nanos(1));
        let start = std::time::Instant::now();
        let result = git.toplevel(&repo);
        let elapsed = start.elapsed();

        assert!(
            result.is_none(),
            "an expired timeout must be reported as failure, not the real (eventual) answer"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "must return promptly rather than waiting for the real git invocation to finish \
             ({elapsed:?} elapsed)"
        );
    }
}
