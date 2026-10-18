//! Shared low-level cache-file I/O helpers used by every persisted cache in
//! this codebase (`city::layout::LayoutCache`, `city::archipelago::
//! ArchipelagoCache`) so there is exactly one atomic-write mechanism and one
//! per-path lock, not a second copy silently drifting out of sync with the
//! first.
//!
//! ## Why atomic writes (Opus review, Important 1)
//!
//! `std::fs::write` opens its target with `O_TRUNC`, so a plain `fs::write`
//! is two separate steps from the filesystem's point of view: truncate to
//! zero, then write the new bytes. Two callers racing to save the SAME path
//! (the concrete case this exists to close: two overlapping archipelago or
//! layout scans, since Tauri commands run concurrently and the frontend
//! fires `get_archipelago` on both mount and every window focus with no
//! in-flight guard) can interleave those steps arbitrarily — one call's
//! truncate can land after another's write has already started, or their
//! write syscalls can interleave — leaving a file on disk that matches
//! NEITHER writer's content, often not even valid JSON. `LayoutCache::load`/
//! `ArchipelagoCache::load` then honestly degrade a torn file to
//! `Default::default()` (never a panic, never trusting nonsense numbers) —
//! but for a cache whose entire purpose is REMEMBERING a stable layout,
//! "degrade to default" means every district (or every island) reshuffles,
//! and the very next successful save persists that reshuffle permanently.
//!
//! `atomic_write` closes this by writing to a uniquely-named temp file in
//! the SAME directory as the target (so the final `rename` stays on one
//! filesystem, which is what makes it atomic on every platform this app
//! ships on) and renaming it into place. `rename` either fully lands or
//! doesn't happen at all — a reader can only ever observe the complete OLD
//! file or the complete NEW one, never a byte in between.
//!
//! ## Why a per-path lock too
//!
//! Atomicity alone stops CORRUPTION; it does not stop a LOST UPDATE. Two
//! overlapping scans of the same repo (or of the whole archipelago) each
//! load the cache, compute an updated version in memory, and save it back —
//! if both loads happen before either save, the second save simply
//! overwrites the first outright, and the first save's update (computed
//! from a since-superseded read) is silently discarded even though each
//! individual write is now perfectly atomic. `with_cache_lock` serializes
//! the WHOLE load-compute-save cycle for a given path within this process,
//! so a second caller for the same path always starts its own load only
//! after the first caller's save has landed, and therefore builds on top of
//! it instead of clobbering it. Different paths (two different
//! repositories' `towns/<hash>.json`, scanned by two different worker
//! threads in the same `build_archipelago_for_roots` call) never contend
//! with each other — only same-path callers ever wait, which keeps the
//! archipelago scan's cross-repository parallelism intact.
//!
//! This is a process-local lock, not a cross-process file lock: it guards
//! against the concurrency this app actually has (multiple Tauri command
//! invocations inside the same running app), not against a second copy of
//! the app running at the same time — which this codebase does not attempt
//! to guard against anywhere else either.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Writes `contents` to `path` atomically: a temp file in the same
/// directory is written in full, then renamed over `path`. A reader can
/// only ever observe the complete previous file or the complete new one —
/// never a torn mix of both (see the module doc's "Why atomic writes").
///
/// Creates `path`'s parent directory if needed, mirroring the plain
/// `fs::write`-based `save()` this replaces.
pub fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;

    let tmp_path = dir.join(format!(
        ".{}.tmp-{}-{}-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("cache"),
        std::process::id(),
        thread_discriminator(),
        next_counter(),
    ));

    if let Err(e) = std::fs::write(&tmp_path, contents) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    Ok(())
}

/// A process-wide, ever-increasing counter folded into `atomic_write`'s temp
/// file name so two writes to the same path from the same process (however
/// unlikely given `with_cache_lock` already serializes them, and given the
/// thread discriminator below) can never collide on the same temp name.
fn next_counter() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// A cheap, non-cryptographic per-thread discriminator for `atomic_write`'s
/// temp file name — belt-and-suspenders alongside `next_counter` in case a
/// future caller ever writes the same path without going through
/// `with_cache_lock`.
fn thread_discriminator() -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::thread::current().id().hash(&mut hasher);
    hasher.finish()
}

/// Runs `f` while holding the in-process lock for `path` — see the module
/// doc's "Why a per-path lock too" section. Every caller that reads,
/// modifies in memory, and writes back the SAME cache path must wrap the
/// whole cycle in this, not just the final write, or the lock does nothing
/// to prevent a lost update.
pub fn with_cache_lock<T>(path: &Path, f: impl FnOnce() -> T) -> T {
    let lock = lock_for(path);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f()
}

fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    map.entry(path.to_path_buf()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Barrier;

    #[test]
    fn atomic_write_round_trips_and_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("cache.json");
        atomic_write(&path, b"{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");

        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "atomic_write must not leave temp files behind: {leftovers:?}");
    }

    /// The concrete failure the Opus review worked out: run A's file is
    /// bigger than run B's (an agent added a file mid-scan), both truncate
    /// to zero and write from the start, and with a plain `fs::write` the
    /// loser's tail can survive onto the winner's shorter content, leaving
    /// invalid JSON on disk. Two threads race `atomic_write` on the SAME
    /// path with payloads of very different sizes (mirroring the reviewer's
    /// 340,100 vs. 338,069 byte example) while a third thread continuously
    /// reads the file; every read that observes a non-empty file must
    /// parse as valid, complete JSON — one writer's content or the other's,
    /// never a torn mix.
    #[test]
    fn concurrent_atomic_writes_of_differently_sized_payloads_never_produce_a_torn_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("towns").join("race.json");

        // Two distinguishable, non-trivially-sized JSON payloads (a couple
        // hundred KB each) so a write spans multiple internal write()
        // syscalls, giving the OS real scheduling opportunities to
        // interleave under the old non-atomic `fs::write` implementation.
        let big = format!("{{\"tag\":\"big\",\"pad\":\"{}\"}}", "a".repeat(340_000));
        let small = format!("{{\"tag\":\"small\",\"pad\":\"{}\"}}", "b".repeat(338_000));

        let stop = Arc::new(AtomicBool::new(false));
        let start = Arc::new(Barrier::new(3));

        std::thread::scope(|scope| {
            for payload in [&big, &small] {
                let path = &path;
                let stop = Arc::clone(&stop);
                let start = Arc::clone(&start);
                scope.spawn(move || {
                    start.wait();
                    while !stop.load(Ordering::Relaxed) {
                        let _ = atomic_write(path, payload.as_bytes());
                    }
                });
            }

            let path = &path;
            let stop = Arc::clone(&stop);
            let start = Arc::clone(&start);
            let reader = scope.spawn(move || {
                start.wait();
                for _ in 0..300 {
                    if let Ok(text) = std::fs::read_to_string(path) {
                        if !text.is_empty() {
                            assert!(
                                serde_json::from_str::<serde_json::Value>(&text).is_ok(),
                                "a reader observed a torn (invalid JSON) cache file: {} bytes",
                                text.len()
                            );
                        }
                    }
                }
                stop.store(true, Ordering::Relaxed);
            });
            reader.join().unwrap();
        });
    }

    #[test]
    fn with_cache_lock_serializes_overlapping_read_modify_write_cycles() {
        // Two "callers" each load the current counter, add one, and save it
        // back — the classic lost-update shape. Without the lock around the
        // WHOLE cycle (not just the final write), both could load `0` and
        // both save `1`, losing one increment. `with_cache_lock` around the
        // full load-modify-save cycle must make this race-free.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("counter.json");
        atomic_write(&path, b"0").unwrap();

        let start = Arc::new(Barrier::new(10));
        std::thread::scope(|scope| {
            for _ in 0..10 {
                let path = &path;
                let start = Arc::clone(&start);
                scope.spawn(move || {
                    start.wait();
                    with_cache_lock(path, || {
                        let current: i64 =
                            std::fs::read_to_string(path).unwrap().trim().parse().unwrap();
                        // Give a concurrent, unsynchronized racer a real
                        // chance to interleave if the lock weren't held.
                        std::thread::yield_now();
                        atomic_write(path, (current + 1).to_string().as_bytes()).unwrap();
                    });
                });
            }
        });

        let total: i64 = std::fs::read_to_string(&path).unwrap().trim().parse().unwrap();
        assert_eq!(total, 10, "every increment must be preserved under the shared lock");
    }
}
