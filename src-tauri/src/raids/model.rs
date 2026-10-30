//! Data model for raids and the rule that turns scan results into a status.

use serde::{Deserialize, Serialize};

/// Declared lowest to highest so the derived `Ord` makes `Critical` the
/// greatest; sorting descending puts the worst attackers first. `Unknown`
/// sits just below `Moderate`, not below `Low`: it is drawn like moderate
/// (something is wrong, not how badly), and the frontend's `SEVERITY_RANK`
/// orders it the same way.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Low,
    Unknown,
    Moderate,
    High,
    Critical,
}

/// One known vulnerability affecting one package in one lockfile.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Finding {
    pub id: String,
    pub summary: String,
    pub severity: Severity,
    pub package: String,
    pub installed: Option<String>,
    pub fixed_in: Option<String>,
    /// Repo-relative, so reports stay meaningful if the repo moves.
    pub lockfile: String,
    pub url: String,
}

/// Content hash of a lockfile, used to tell when a stored report is stale.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LockfilePrint {
    /// Repo-relative.
    pub path: String,
    /// 16 hex chars.
    pub hash: String,
}

/// The tagged shape (`{ "kind": ... }`) is what the frontend switches on.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RaidStatus {
    Clean,
    Raided { findings: Vec<Finding> },
    Unscouted { reason: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RaidReport {
    pub root: String,
    /// Unix seconds.
    pub scanned_at: i64,
    /// "osv-scanner" or "npm-audit"; `None` when nothing could scan.
    pub scanner: Option<String>,
    pub covered: Vec<String>,
    pub uncovered: Vec<String>,
    pub fingerprint: Vec<LockfilePrint>,
    pub status: RaidStatus,
    /// Computed on read; whatever is on disk is never trusted.
    #[serde(default)]
    pub stale: bool,
}

pub fn severity_from_label(label: &str) -> Severity {
    match label.to_ascii_lowercase().as_str() {
        "critical" => Severity::Critical,
        "high" => Severity::High,
        "moderate" | "medium" => Severity::Moderate,
        "low" => Severity::Low,
        _ => Severity::Unknown,
    }
}

pub fn severity_from_cvss(score: f64) -> Severity {
    if score >= 9.0 {
        Severity::Critical
    } else if score >= 7.0 {
        Severity::High
    } else if score >= 4.0 {
        Severity::Moderate
    } else if score > 0.0 {
        Severity::Low
    } else {
        Severity::Unknown
    }
}

/// Scanners can report the same advisory several times (aliases, repeated
/// lockfile entries); one attacker per (advisory, package, lockfile) is enough.
pub fn dedup(findings: Vec<Finding>) -> Vec<Finding> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Finding> = findings
        .into_iter()
        .filter(|f| seen.insert((f.id.clone(), f.package.clone(), f.lockfile.clone())))
        .collect();
    out.sort_by(|a, b| b.severity.cmp(&a.severity).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Never reports `Clean` unless every lockfile was actually checked: a gap in
/// coverage must not look like safety.
pub fn decide_status(
    findings: Vec<Finding>,
    covered: &[String],
    uncovered: &[String],
) -> RaidStatus {
    if !findings.is_empty() {
        return RaidStatus::Raided {
            findings: dedup(findings),
        };
    }
    if covered.is_empty() {
        let reason = if uncovered.is_empty() {
            "no lockfile found"
        } else {
            "no scanner could read this repository's lockfiles"
        };
        return RaidStatus::Unscouted {
            reason: reason.into(),
        };
    }
    if !uncovered.is_empty() {
        return RaidStatus::Unscouted {
            reason: format!(
                "partly scouted: {} not checked (install osv-scanner)",
                uncovered.join(", ")
            ),
        };
    }
    RaidStatus::Clean
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(id: &str, sev: Severity, pkg: &str, lock: &str) -> Finding {
        Finding {
            id: id.into(),
            summary: "s".into(),
            severity: sev,
            package: pkg.into(),
            installed: Some("1.0.0".into()),
            fixed_in: None,
            lockfile: lock.into(),
            url: "https://osv.dev/x".into(),
        }
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn severity_labels_map_case_insensitively() {
        assert_eq!(severity_from_label("MODERATE"), Severity::Moderate);
        assert_eq!(severity_from_label("medium"), Severity::Moderate);
        assert_eq!(severity_from_label("High"), Severity::High);
        assert_eq!(severity_from_label("weird"), Severity::Unknown);
    }

    #[test]
    fn cvss_boundaries() {
        assert_eq!(severity_from_cvss(9.0), Severity::Critical);
        assert_eq!(severity_from_cvss(8.9), Severity::High);
        assert_eq!(severity_from_cvss(7.0), Severity::High);
        assert_eq!(severity_from_cvss(4.0), Severity::Moderate);
        assert_eq!(severity_from_cvss(0.1), Severity::Low);
        assert_eq!(severity_from_cvss(0.0), Severity::Unknown);
    }

    #[test]
    fn dedup_collapses_same_advisory_and_sorts_by_severity() {
        let out = dedup(vec![
            finding("B", Severity::Low, "a", "l"),
            finding("A", Severity::Critical, "a", "l"),
            finding("A", Severity::Low, "a", "l"),
            finding("A", Severity::Critical, "a", "other"),
        ]);
        let ids: Vec<_> = out
            .iter()
            .map(|f| (f.id.as_str(), f.severity, f.lockfile.as_str()))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("A", Severity::Critical, "l"),
                ("A", Severity::Critical, "other"),
                ("B", Severity::Low, "l"),
            ]
        );
    }

    #[test]
    fn unknown_severity_ranks_with_moderate_above_low() {
        // Drawn like moderate (we were told something is wrong, not how
        // badly), so it must never sort below a known-low finding.
        let out = dedup(vec![
            finding("L", Severity::Low, "a", "l"),
            finding("U", Severity::Unknown, "a", "l"),
            finding("M", Severity::Moderate, "a", "l"),
            finding("H", Severity::High, "a", "l"),
        ]);
        let ids: Vec<_> = out.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, ["H", "M", "U", "L"]);
    }

    #[test]
    fn status_raided_even_with_gaps() {
        let st = decide_status(
            vec![finding("A", Severity::High, "a", "l")],
            &[],
            &s(&["Cargo.lock"]),
        );
        assert!(matches!(st, RaidStatus::Raided { ref findings } if findings.len() == 1));
    }

    #[test]
    fn status_clean_requires_no_gaps() {
        assert_eq!(
            decide_status(vec![], &s(&["package-lock.json"]), &[]),
            RaidStatus::Clean
        );
    }

    #[test]
    fn status_partly_scouted_reason_names_the_gap() {
        let st = decide_status(vec![], &s(&["package-lock.json"]), &s(&["Cargo.lock"]));
        assert_eq!(
            st,
            RaidStatus::Unscouted {
                reason: "partly scouted: Cargo.lock not checked (install osv-scanner)".into()
            }
        );
    }

    #[test]
    fn status_no_lockfile() {
        assert_eq!(
            decide_status(vec![], &[], &[]),
            RaidStatus::Unscouted {
                reason: "no lockfile found".into()
            }
        );
        assert_eq!(
            decide_status(vec![], &[], &s(&["Cargo.lock"])),
            RaidStatus::Unscouted {
                reason: "no scanner could read this repository's lockfiles".into()
            }
        );
    }

    #[test]
    fn report_round_trips_through_json() {
        let report = RaidReport {
            root: "/r".into(),
            scanned_at: 1,
            scanner: Some("osv-scanner".into()),
            covered: s(&["package-lock.json"]),
            uncovered: vec![],
            fingerprint: vec![LockfilePrint {
                path: "package-lock.json".into(),
                hash: "0123456789abcdef".into(),
            }],
            status: RaidStatus::Raided {
                findings: vec![finding("A", Severity::Critical, "a", "l")],
            },
            stale: true,
        };
        let json = serde_json::to_string(&report).unwrap();
        let back: RaidReport = serde_json::from_str(&json).unwrap();
        assert_eq!(back, report);

        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["status"]["kind"], "raided");
        assert_eq!(v["status"]["findings"][0]["severity"], "critical");
        assert_eq!(
            serde_json::to_value(RaidStatus::Clean).unwrap(),
            serde_json::json!({ "kind": "clean" })
        );
        assert_eq!(
            serde_json::to_value(RaidStatus::Unscouted { reason: "x".into() }).unwrap(),
            serde_json::json!({ "kind": "unscouted", "reason": "x" })
        );
    }
}
