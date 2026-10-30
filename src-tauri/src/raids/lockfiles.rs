//! Finding the lockfiles a repo ships, deciding which the scanner covers, and
//! fingerprinting them so a stored report can be recognised as stale.

use super::model::LockfilePrint;
use crate::process::run_bounded;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

pub const LOCKFILE_NAMES: &[&str] = &[
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "poetry.lock",
    "go.sum",
    "Gemfile.lock",
];

const LIST_DEADLINE: Duration = Duration::from_secs(10);
const LIST_LIMIT: usize = 4 * 1024 * 1024;

/// Repo-relative lockfile paths (tracked or untracked, never ignored), sorted.
pub fn discover_lockfiles(root: &Path) -> Result<Vec<String>, String> {
    let mut command = Command::new("git");
    command
        .args(["ls-files", "-co", "--exclude-standard", "-z"])
        .current_dir(root);
    let output = run_bounded(command, LIST_LIMIT, Instant::now() + LIST_DEADLINE, "Git")?;
    // A partial list could hide a lockfile and wrongly allow a Clean verdict.
    if output.truncated {
        return Err("too many files to list".into());
    }
    if !output.status.success() {
        return Err("git could not list files".into());
    }
    let mut found: Vec<String> = output
        .stdout
        .split(|b| *b == 0)
        .filter(|raw| !raw.is_empty())
        .map(|raw| String::from_utf8_lossy(raw).replace('\\', "/"))
        .filter(|path| {
            let mut parts = path.split('/');
            let name = parts.next_back().unwrap_or("");
            LOCKFILE_NAMES.contains(&name) && !parts.any(|p| p == "node_modules")
        })
        .collect();
    found.sort();
    found.dedup();
    Ok(found)
}

/// npm audit only runs at the repo root, so nested lockfiles stay uncovered.
pub fn npm_audit_coverage(lockfiles: &[String]) -> (Vec<String>, Vec<String>) {
    lockfiles
        .iter()
        .cloned()
        .partition(|path| path == "package-lock.json")
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub fn fingerprint(root: &Path, lockfiles: &[String]) -> Vec<LockfilePrint> {
    lockfiles
        .iter()
        .map(|path| LockfilePrint {
            path: path.clone(),
            hash: match std::fs::read(root.join(path)) {
                Ok(bytes) => format!("{:016x}", fnv1a(&bytes)),
                Err(_) => "unreadable".into(),
            },
        })
        .collect()
}

pub fn is_stale(stored: &[LockfilePrint], current: &[LockfilePrint]) -> bool {
    let index = |prints: &[LockfilePrint]| -> HashMap<String, String> {
        prints
            .iter()
            .map(|p| (p.path.clone(), p.hash.clone()))
            .collect()
    };
    index(stored) != index(current)
}

/// Sibling manifest of a lockfile; unknown paths come back unchanged.
pub fn manifest_for_lockfile(lockfile: &str) -> String {
    let (dir, name) = match lockfile.rfind('/') {
        Some(i) => (&lockfile[..=i], &lockfile[i + 1..]),
        None => ("", lockfile),
    };
    let manifest = match name {
        "package-lock.json" | "yarn.lock" | "pnpm-lock.yaml" => "package.json",
        "Cargo.lock" => "Cargo.toml",
        "poetry.lock" => "pyproject.toml",
        "go.sum" => "go.mod",
        "Gemfile.lock" => "Gemfile",
        _ => return lockfile.to_string(),
    };
    format!("{dir}{manifest}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn repository() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        let output = Command::new("git")
            .args(["init", "-b", "raids-test"])
            .current_dir(dir.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(output.status.success());
        dir
    }

    fn write(root: &Path, path: &str, body: &str) {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, body).unwrap();
    }

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }

    #[test]
    fn discovers_tracked_and_untracked_lockfiles_but_not_ignored_or_node_modules() {
        let repo = repository();
        let root = repo.path();
        write(root, ".gitignore", "ignored/\n");
        write(root, "Cargo.lock", "a");
        write(root, "web/yarn.lock", "b");
        write(root, "ignored/go.sum", "c");
        write(root, "node_modules/x/package-lock.json", "d");
        write(root, "README.md", "e");
        assert_eq!(
            discover_lockfiles(root).unwrap(),
            s(&["Cargo.lock", "web/yarn.lock"])
        );
    }

    #[test]
    fn npm_coverage_only_covers_root_package_lock() {
        let (covered, uncovered) = npm_audit_coverage(&s(&[
            "Cargo.lock",
            "package-lock.json",
            "web/package-lock.json",
        ]));
        assert_eq!(covered, s(&["package-lock.json"]));
        assert_eq!(uncovered, s(&["Cargo.lock", "web/package-lock.json"]));
    }

    #[test]
    fn fingerprint_changes_when_lockfile_bytes_change() {
        let repo = repository();
        let root = repo.path();
        write(root, "Cargo.lock", "one");
        let files = s(&["Cargo.lock", "missing.lock"]);
        let first = fingerprint(root, &files);
        assert_eq!(first[0].hash.len(), 16);
        assert_eq!(first[1].hash, "unreadable");
        write(root, "Cargo.lock", "two");
        let second = fingerprint(root, &files);
        assert_ne!(first[0].hash, second[0].hash);
        assert!(is_stale(&first, &second));
        assert!(!is_stale(&second, &second.clone()));
    }

    #[test]
    fn stale_when_a_lockfile_is_added_or_removed() {
        let a = LockfilePrint {
            path: "a".into(),
            hash: "1".into(),
        };
        let b = LockfilePrint {
            path: "b".into(),
            hash: "2".into(),
        };
        assert!(is_stale(&[a.clone()], &[a.clone(), b.clone()]));
        assert!(is_stale(&[a.clone(), b.clone()], &[a.clone()]));
        assert!(!is_stale(&[a.clone(), b.clone()], &[b, a]));
    }

    #[test]
    fn manifest_mapping_keeps_directory() {
        assert_eq!(manifest_for_lockfile("web/yarn.lock"), "web/package.json");
        assert_eq!(manifest_for_lockfile("Cargo.lock"), "Cargo.toml");
        assert_eq!(manifest_for_lockfile("a/b/go.sum"), "a/b/go.mod");
        assert_eq!(manifest_for_lockfile("other.txt"), "other.txt");
    }
}
