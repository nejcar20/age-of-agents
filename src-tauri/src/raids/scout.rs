//! Scouting: running whichever scanner is installed against one island root,
//! remembering the report, and the Tauri commands the frontend calls.

use super::lockfiles::{discover_lockfiles, fingerprint, is_stale, npm_audit_coverage};
use super::model::{decide_status, RaidReport, RaidStatus};
use super::parse::{parse_npm_audit, parse_osv};
use crate::commands::AppState;
use crate::process::{resolve_executable, run_bounded, BoundedOutput};
use crate::world::repo::normalize_path;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

/// Per-scan budget (Global Constraints). Advisory lookups hit the network, so
/// the timeout is generous; the cap only guards against a runaway process.
const SCAN_DEADLINE: Duration = Duration::from_secs(120);
const SCAN_LIMIT: usize = 16 * 1024 * 1024;

/// `scout_all` never runs more than this many scanners at once: each one is
/// a network-bound child process, and a hundred islands must not mean a
/// hundred of them.
const SCOUT_CONCURRENCY: usize = 2;

const OSV: &str = "osv-scanner";
const NPM_AUDIT: &str = "npm-audit";

pub struct Scanners {
    pub osv: Option<PathBuf>,
    pub npm: Option<PathBuf>,
}

/// Looked up fresh on every call, so installing osv-scanner while the app is
/// open takes effect on the next scout without a restart.
pub fn detect_scanners() -> Scanners {
    Scanners {
        osv: resolve_executable("osv-scanner"),
        npm: resolve_executable("npm"),
    }
}

/// What one scanner run produced, before the honest status rule is applied.
enum Scan {
    Done {
        findings: Vec<super::model::Finding>,
        covered: Vec<String>,
    },
    Failed(String),
}

/// `run_bounded` words its errors for Git inspection ("<tool> inspection
/// timed out"); the scout sheet shows the spec's reasons instead.
fn failure_reason(error: &str) -> String {
    if error.ends_with("timed out") {
        "timed out".into()
    } else {
        format!("scan failed: {error}")
    }
}

/// Runs `command` and hands back its stdout only when `accepted` says the
/// exit code means "scanned" — both scanners exit non-zero when they FIND
/// something, so success is per tool, not `status.success()`.
fn run_scanner(
    command: Command,
    accepted: &[i32],
    run: &dyn Fn(Command) -> Result<BoundedOutput, String>,
) -> Result<(i32, Vec<u8>), String> {
    let output = run(command).map_err(|e| failure_reason(&e))?;
    // Half a JSON document must never be half-parsed into findings.
    if output.truncated {
        return Err("output too large".into());
    }
    match output.status.code() {
        Some(code) if accepted.contains(&code) => Ok((code, output.stdout)),
        code => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let first = stderr.lines().map(str::trim).find(|l| !l.is_empty());
            Err(match (first, code) {
                (Some(line), _) => format!("scan failed: {line}"),
                (None, Some(code)) => format!("scan failed: exit status {code}"),
                (None, None) => "scan failed: killed by a signal".into(),
            })
        }
    }
}

fn scan_osv(
    root: &Path,
    osv: &Path,
    run: &dyn Fn(Command) -> Result<BoundedOutput, String>,
) -> Scan {
    let mut command = Command::new(osv);
    // osv-scanner v2 syntax; v1 spelled this `--format json -r <root>`.
    // `--all-packages` (v1: `--experimental-all-packages`) makes the JSON list
    // every source it read, not only those with vulnerabilities; without it a
    // clean lockfile is indistinguishable from an unread one and Clean could
    // never be reached.
    command
        .args([
            "scan",
            "source",
            "--format",
            "json",
            "--all-packages",
            "--recursive",
        ])
        .arg(root);
    match run_scanner(command, &[0, 1, 128], run) {
        // 128 is "no packages found": a successful run that read nothing, so
        // every discovered lockfile stays uncovered rather than looking clean.
        Ok((128, _)) => Scan::Done {
            findings: vec![],
            covered: vec![],
        },
        Ok((_, stdout)) => match parse_osv(&stdout, root) {
            Ok((findings, mut covered)) => {
                covered.sort();
                covered.dedup();
                Scan::Done { findings, covered }
            }
            Err(e) => Scan::Failed(format!("scan failed: {e}")),
        },
        Err(reason) => Scan::Failed(reason),
    }
}

fn scan_npm(
    root: &Path,
    npm: &Path,
    lockfile: &str,
    run: &dyn Fn(Command) -> Result<BoundedOutput, String>,
) -> Scan {
    let mut command = Command::new(npm);
    // `--package-lock-only` audits the lockfile as written, without needing
    // (or touching) node_modules.
    command
        .args(["audit", "--json", "--package-lock-only"])
        .current_dir(root);
    match run_scanner(command, &[0, 1], run) {
        Ok((_, stdout)) => match parse_npm_audit(&stdout, lockfile) {
            Ok(findings) => Scan::Done {
                findings,
                covered: vec![lockfile.to_string()],
            },
            Err(e) => Scan::Failed(format!("scan failed: {e}")),
        },
        Err(reason) => Scan::Failed(reason),
    }
}

/// Scouts one CANONICAL root (the `IslandView.root` spelling): `parse_osv`
/// relativises lockfile paths against it, and the cache is keyed by it.
/// `run` is injected so tests can stand in for the scanners.
pub fn scout_root(
    root: &Path,
    scanners: &Scanners,
    now: i64,
    run: &dyn Fn(Command) -> Result<BoundedOutput, String>,
) -> RaidReport {
    let mut report = RaidReport {
        root: root.to_string_lossy().into_owned(),
        scanned_at: now,
        scanner: None,
        covered: vec![],
        uncovered: vec![],
        fingerprint: vec![],
        status: RaidStatus::Unscouted {
            reason: String::new(),
        },
        stale: false,
    };
    let discovered = match discover_lockfiles(root) {
        Ok(found) => found,
        Err(e) => {
            report.status = RaidStatus::Unscouted {
                reason: format!("could not list files: {e}"),
            };
            return report;
        }
    };
    report.fingerprint = fingerprint(root, &discovered);
    if discovered.is_empty() {
        report.status = decide_status(vec![], &[], &[]);
        return report;
    }

    let npm_covers = npm_audit_coverage(&discovered).0;
    let scan = if let Some(osv) = &scanners.osv {
        report.scanner = Some(OSV.into());
        scan_osv(root, osv, run)
    } else if let (Some(npm), Some(lockfile)) = (&scanners.npm, npm_covers.first()) {
        report.scanner = Some(NPM_AUDIT.into());
        scan_npm(root, npm, lockfile, run)
    } else {
        Scan::Failed("no scanner installed (install osv-scanner)".into())
    };

    match scan {
        Scan::Done { findings, covered } => {
            report.uncovered = discovered
                .iter()
                .filter(|path| !covered.contains(path))
                .cloned()
                .collect();
            report.status = decide_status(findings, &covered, &report.uncovered);
            report.covered = covered;
        }
        Scan::Failed(reason) => report.status = RaidStatus::Unscouted { reason },
    }
    report
}

/// The real runner: the Global Constraints budget, fresh per scan.
fn run_scan(command: Command) -> Result<BoundedOutput, String> {
    let tool = Path::new(command.get_program())
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "scanner".into());
    run_bounded(command, SCAN_LIMIT, Instant::now() + SCAN_DEADLINE, &tool)
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn scout_now(root: &Path) -> RaidReport {
    scout_root(root, &detect_scanners(), unix_now(), &run_scan)
}

fn cache_path() -> PathBuf {
    crate::config::data_path("raids.json")
}

/// A missing or torn file is an empty cache: the worst case is that islands
/// show as never scouted until the user scouts again. `stale` is reset here
/// and only `raid_reports` sets it, from the lockfiles as they are now.
fn load_reports_from(path: &Path) -> HashMap<String, RaidReport> {
    let mut reports: HashMap<String, RaidReport> = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    for report in reports.values_mut() {
        report.stale = false;
    }
    reports
}

/// Load-modify-save under the cache lock, so the two `scout_all` workers
/// finishing together cannot drop each other's report.
fn save_report_to(path: &Path, report: &RaidReport) {
    crate::cache_io::with_cache_lock(path, || {
        let mut reports = load_reports_from(path);
        reports.insert(report.root.clone(), report.clone());
        // Logged, not returned: the scan itself succeeded and its report is
        // still emitted; only remembering it across restarts failed.
        let saved = serde_json::to_vec(&reports)
            .map_err(|e| e.to_string())
            .and_then(|json| crate::cache_io::atomic_write(path, &json).map_err(|e| e.to_string()));
        if let Err(e) = saved {
            eprintln!("raids: failed to save the report for {}: {e}", report.root);
        }
    });
}

pub fn load_reports() -> HashMap<String, RaidReport> {
    load_reports_from(&cache_path())
}

pub fn save_report(report: &RaidReport) {
    save_report_to(&cache_path(), report)
}

/// A report describes the lockfiles as they were when scouted; if they have
/// changed (or the repo is gone, or can no longer be listed) its ships and
/// flag must not be read as current.
fn with_freshness(mut report: RaidReport) -> RaidReport {
    let root = Path::new(&report.root);
    report.stale = match root.is_dir().then(|| discover_lockfiles(root)) {
        Some(Ok(current)) => is_stale(&report.fingerprint, &fingerprint(root, &current)),
        _ => true,
    };
    report
}

fn sorted_with_freshness(reports: HashMap<String, RaidReport>) -> Vec<RaidReport> {
    let mut out: Vec<RaidReport> = reports.into_values().map(with_freshness).collect();
    out.sort_by(|a, b| a.root.cmp(&b.root));
    out
}

#[derive(serde::Serialize)]
pub struct ScannersView {
    pub osv: bool,
    pub npm: bool,
}

#[tauri::command]
pub async fn raid_scanners() -> ScannersView {
    let scanners = detect_scanners();
    ScannersView {
        osv: scanners.osv.is_some(),
        npm: scanners.npm.is_some(),
    }
}

/// Every remembered report, with `stale` recomputed from the lockfiles on
/// disk now, sorted by root so the order never depends on `HashMap`
/// iteration. Off the async runtime: it lists files in every scouted repo.
#[tauri::command]
pub async fn raid_reports() -> Result<Vec<RaidReport>, String> {
    tauri::async_runtime::spawn_blocking(|| sorted_with_freshness(load_reports()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scout_island(app: AppHandle, root: String) -> Result<RaidReport, String> {
    let report = tauri::async_runtime::spawn_blocking(move || {
        // Same canonicalisation as every other command, so the cache key is
        // exactly `IslandView.root`.
        let root = normalize_path(Path::new(&root));
        let report = scout_now(&root);
        save_report(&report);
        report
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = app.emit("raid-report", &report);
    Ok(report)
}

static SCOUTING: AtomicBool = AtomicBool::new(false);

/// Holds the "a scout_all is running" flag and releases it on drop, so an
/// early error or a panicking scan can never leave scouting locked out.
struct ScoutingGuard;

impl ScoutingGuard {
    fn acquire() -> Option<Self> {
        SCOUTING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| ScoutingGuard)
    }
}

impl Drop for ScoutingGuard {
    fn drop(&mut self) {
        SCOUTING.store(false, Ordering::Release);
    }
}

/// Emits `raid-scout-done` when dropped, so the frontend's "Scouting d/N"
/// state is cleared on every exit path, including a panicking scan.
struct DoneSignal(AppHandle);

impl Drop for DoneSignal {
    fn drop(&mut self) {
        let _ = self.0.emit("raid-scout-done", ());
    }
}

/// Scouts every island `get_archipelago` draws, in the background, and
/// returns how many there are right away; ships arrive per island through
/// `raid-report` events, then one `raid-scout-done`.
#[tauri::command]
pub async fn scout_all(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let guard = ScoutingGuard::acquire().ok_or("already scouting")?;
    let (config, home, settled_roots) = crate::commands::archipelago_inputs(&state)?;
    let roots: Vec<String> = tauri::async_runtime::spawn_blocking(move || {
        crate::city::archipelago::build_archipelago(&config, home, &settled_roots)
            .islands
            .into_iter()
            .map(|island| island.root)
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?;
    let count = roots.len();

    tauri::async_runtime::spawn_blocking(move || {
        // Declared before the guard so it drops after it: the flag is clear
        // by the time the frontend hears "done" and may scout again.
        let _done = DoneSignal(app.clone());
        let _guard = guard;
        let queue = Mutex::new(VecDeque::from(roots));
        let scanners = detect_scanners();
        std::thread::scope(|scope| {
            for _ in 0..SCOUT_CONCURRENCY {
                scope.spawn(|| loop {
                    let Some(root) = queue.lock().unwrap_or_else(|p| p.into_inner()).pop_front()
                    else {
                        break;
                    };
                    let report = scout_root(Path::new(&root), &scanners, unix_now(), &run_scan);
                    save_report(&report);
                    let _ = app.emit("raid-report", &report);
                });
            }
        });
    });
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::super::model::{RaidStatus, Severity};
    use super::*;
    use std::fs;
    use std::process::ExitStatus;
    use tempfile::TempDir;

    const OSV_VULN: &str = include_str!("../../tests/fixtures/raids/osv-vulnerable.json");
    const OSV_CLEAN: &str = include_str!("../../tests/fixtures/raids/osv-clean.json");
    const NPM_VULN: &[u8] = include_bytes!("../../tests/fixtures/raids/npm-audit-vulnerable.json");

    /// A git repo holding `lockfiles`, plus its canonical root — the same
    /// spelling `IslandView.root` uses (macOS temp dirs live behind
    /// `/var` -> `/private/var`).
    fn repository(lockfiles: &[&str]) -> (TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let status = Command::new("git")
            .args(["init", "-q", "-b", "raids-test"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        assert!(status.success());
        for lockfile in lockfiles {
            let path = dir.path().join(lockfile);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, format!("contents of {lockfile}")).unwrap();
        }
        let root = dir.path().canonicalize().unwrap();
        (dir, root)
    }

    #[cfg(unix)]
    fn exit(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    fn exit(code: i32) -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(code as u32)
    }

    fn output(code: i32, stdout: &[u8], stderr: &str, truncated: bool) -> BoundedOutput {
        BoundedOutput {
            status: exit(code),
            stdout: stdout.to_vec(),
            stderr: stderr.as_bytes().to_vec(),
            truncated,
        }
    }

    fn osv_only() -> Scanners {
        Scanners {
            osv: Some(PathBuf::from("/opt/homebrew/bin/osv-scanner")),
            npm: None,
        }
    }

    fn npm_only() -> Scanners {
        Scanners {
            osv: None,
            npm: Some(PathBuf::from("/opt/homebrew/bin/npm")),
        }
    }

    fn reason(report: &RaidReport) -> &str {
        match &report.status {
            RaidStatus::Unscouted { reason } => reason,
            other => panic!("expected unscouted, got {other:?}"),
        }
    }

    #[test]
    fn osv_exit_1_with_findings_is_raided() {
        let (_dir, root) = repository(&["package-lock.json", "services/api/Cargo.lock"]);
        let body = OSV_VULN.replace("/fake/repo", &root.to_string_lossy());
        let seen = std::cell::RefCell::new(Vec::new());
        let run = |command: Command| {
            seen.borrow_mut().push(
                command
                    .get_args()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect::<Vec<_>>(),
            );
            Ok(output(1, body.as_bytes(), "", false))
        };
        let report = scout_root(&root, &osv_only(), 42, &run);

        assert_eq!(
            seen.borrow()[0][..5],
            ["scan", "source", "--format", "json", "--all-packages"]
        );
        assert_eq!(report.scanner.as_deref(), Some("osv-scanner"));
        assert_eq!(report.scanned_at, 42);
        assert_eq!(report.root, root.to_string_lossy());
        assert_eq!(
            report.covered,
            ["package-lock.json", "services/api/Cargo.lock"]
        );
        assert!(report.uncovered.is_empty());
        assert_eq!(report.fingerprint.len(), 2);
        let RaidStatus::Raided { findings } = &report.status else {
            panic!("expected raided, got {:?}", report.status);
        };
        assert_eq!(findings[0].severity, Severity::Critical);
        assert_eq!(findings[0].lockfile, "package-lock.json");
    }

    #[test]
    fn osv_exit_0_all_clean_is_clean() {
        let (_dir, root) = repository(&["Cargo.lock"]);
        let body = OSV_CLEAN.replace("/fake/repo", &root.to_string_lossy());
        let run = |_: Command| Ok(output(0, body.as_bytes(), "", false));
        let report = scout_root(&root, &osv_only(), 1, &run);
        assert_eq!(report.covered, ["Cargo.lock"]);
        assert!(report.uncovered.is_empty());
        assert_eq!(report.status, RaidStatus::Clean);
    }

    #[test]
    fn osv_exit_128_with_lockfiles_present_is_unscouted_not_clean() {
        let (_dir, root) = repository(&["package-lock.json"]);
        let run = |_: Command| Ok(output(128, b"", "No package sources found", false));
        let report = scout_root(&root, &osv_only(), 1, &run);
        assert!(report.covered.is_empty());
        assert_eq!(report.uncovered, ["package-lock.json"]);
        assert_eq!(
            reason(&report),
            "no scanner could read this repository's lockfiles"
        );
    }

    #[test]
    fn osv_crash_exit_2_is_unscouted_with_stderr_reason() {
        let (_dir, root) = repository(&["package-lock.json"]);
        let run = |_: Command| {
            Ok(output(
                2,
                b"",
                "unknown flag: --recursive\nusage: ...",
                false,
            ))
        };
        let report = scout_root(&root, &osv_only(), 1, &run);
        assert_eq!(reason(&report), "scan failed: unknown flag: --recursive");
        assert_eq!(report.scanner.as_deref(), Some("osv-scanner"));
        // Still fingerprinted, so a later lockfile change marks it stale too.
        assert_eq!(report.fingerprint.len(), 1);

        // The runner's own wording ("osv-scanner inspection timed out") is
        // never shown; the spec's reasons are.
        let timeout = |_: Command| Err("osv-scanner inspection timed out".to_string());
        let report = scout_root(&root, &osv_only(), 1, &timeout);
        assert_eq!(reason(&report), "timed out");
    }

    #[test]
    fn truncated_output_is_unscouted() {
        let (_dir, root) = repository(&["package-lock.json"]);
        let body = OSV_VULN.replace("/fake/repo", &root.to_string_lossy());
        let run = |_: Command| Ok(output(1, body.as_bytes(), "", true));
        let report = scout_root(&root, &osv_only(), 1, &run);
        assert_eq!(reason(&report), "output too large");

        let run = |_: Command| Ok(output(0, &[b'{'; 10], "", true));
        let report = scout_root(&root, &npm_only(), 1, &run);
        assert_eq!(reason(&report), "output too large");
    }

    #[test]
    fn npm_only_with_cargo_lock_is_partly_scouted() {
        let (_dir, root) = repository(&["Cargo.lock", "package-lock.json"]);
        let clean = br#"{"auditReportVersion":2,"vulnerabilities":{}}"#;
        let run = |_: Command| Ok(output(0, clean, "", false));
        let report = scout_root(&root, &npm_only(), 1, &run);
        assert_eq!(report.scanner.as_deref(), Some("npm-audit"));
        assert_eq!(report.covered, ["package-lock.json"]);
        assert_eq!(report.uncovered, ["Cargo.lock"]);
        assert_eq!(
            reason(&report),
            "partly scouted: Cargo.lock not checked (install osv-scanner)"
        );
    }

    #[test]
    fn npm_exit_1_is_a_successful_scan() {
        let (_dir, root) = repository(&["package-lock.json"]);
        let dir_seen = std::cell::RefCell::new(None);
        let run = |command: Command| {
            *dir_seen.borrow_mut() = command.get_current_dir().map(Path::to_path_buf);
            Ok(output(1, NPM_VULN, "", false))
        };
        let report = scout_root(&root, &npm_only(), 1, &run);
        assert_eq!(dir_seen.borrow().as_deref(), Some(root.as_path()));
        let RaidStatus::Raided { findings } = &report.status else {
            panic!("expected raided, got {:?}", report.status);
        };
        assert_eq!(findings.len(), 9);

        let run = |_: Command| Ok(output(2, b"", "npm ERR! network", false));
        let report = scout_root(&root, &npm_only(), 1, &run);
        assert_eq!(reason(&report), "scan failed: npm ERR! network");
    }

    #[test]
    fn no_scanner_is_unscouted_with_install_hint() {
        let (_dir, root) = repository(&["Cargo.lock"]);
        let never = |_: Command| -> Result<BoundedOutput, String> { panic!("nothing should run") };
        let none = Scanners {
            osv: None,
            npm: None,
        };
        let report = scout_root(&root, &none, 1, &never);
        assert_eq!(
            reason(&report),
            "no scanner installed (install osv-scanner)"
        );
        assert_eq!(report.scanner, None);
        // npm alone cannot read a Cargo.lock, so it is never run for one.
        let report = scout_root(&root, &npm_only(), 1, &never);
        assert_eq!(
            reason(&report),
            "no scanner installed (install osv-scanner)"
        );

        let (_empty, bare) = repository(&[]);
        let report = scout_root(&bare, &osv_only(), 1, &never);
        assert_eq!(reason(&report), "no lockfile found");
    }

    fn report_for(root: &str) -> RaidReport {
        RaidReport {
            root: root.into(),
            scanned_at: 7,
            scanner: Some("osv-scanner".into()),
            covered: vec!["package-lock.json".into()],
            uncovered: vec![],
            fingerprint: vec![],
            status: RaidStatus::Clean,
            stale: true,
        }
    }

    #[test]
    fn cache_round_trip_keyed_by_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("raids.json");
        save_report_to(&path, &report_for("/a"));
        save_report_to(&path, &report_for("/b"));
        let mut newer = report_for("/a");
        newer.scanned_at = 8;
        save_report_to(&path, &newer);

        let loaded = load_reports_from(&path);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded["/a"].scanned_at, 8);
        assert_eq!(loaded["/b"].root, "/b");
        // Staleness is recomputed on read, never trusted from disk.
        assert!(!loaded["/b"].stale);
    }

    #[test]
    fn torn_cache_loads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("raids.json");
        assert!(load_reports_from(&path).is_empty());
        fs::write(&path, b"{\"/a\": {\"root\": \"/a\", \"scann").unwrap();
        assert!(load_reports_from(&path).is_empty());
        // A torn file does not stop the next save from starting afresh.
        save_report_to(&path, &report_for("/b"));
        assert_eq!(load_reports_from(&path).len(), 1);
    }

    #[test]
    fn freshness_is_recomputed_from_the_lockfiles_now() {
        let (dir, root) = repository(&["package-lock.json"]);
        let none = Scanners {
            osv: None,
            npm: None,
        };
        let never = |_: Command| -> Result<BoundedOutput, String> { panic!("nothing should run") };
        let mut report = scout_root(&root, &none, 1, &never);
        report.stale = true;
        assert!(!with_freshness(report.clone()).stale);

        fs::write(root.join("package-lock.json"), "upgraded").unwrap();
        assert!(with_freshness(report.clone()).stale);

        drop(dir);
        report.stale = false;
        assert!(with_freshness(report).stale);
    }

    #[test]
    fn only_one_scout_all_at_a_time_and_the_flag_always_clears() {
        let first = ScoutingGuard::acquire().expect("nothing else is scouting");
        assert!(ScoutingGuard::acquire().is_none());
        drop(first);
        let panicked = std::panic::catch_unwind(|| {
            let _guard = ScoutingGuard::acquire().unwrap();
            panic!("a scan blew up");
        });
        assert!(panicked.is_err());
        assert!(ScoutingGuard::acquire().is_some());
    }

    #[test]
    fn reports_come_back_sorted_by_root() {
        let reports =
            HashMap::from(["/c", "/a", "/b"].map(|root| (root.to_string(), report_for(root))));
        let roots: Vec<String> = sorted_with_freshness(reports)
            .into_iter()
            .map(|r| r.root)
            .collect();
        assert_eq!(roots, ["/a", "/b", "/c"]);
    }
}
