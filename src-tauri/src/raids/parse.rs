//! Parsers for scanner output. They only interpret a body; deciding whether a
//! scanner run succeeded (exit codes) is the runner's job, because both
//! scanners exit non-zero when they find something.
//
// Fixture provenance: `npm-audit-*.json` were captured from a real
// `npm audit --json --package-lock-only`. `osv-*.json` are HAND-WRITTEN from
// the osv-scanner v2 JSON schema (osv-scanner was not installed when this
// was written), so re-capture them from a real run when it is available.
// `osv-clean.json` has the shape `--all-packages` produces: a source is listed
// even when none of its packages has a vulnerability.

use std::path::Path;

use serde_json::Value;

use super::model::{severity_from_cvss, severity_from_label, Finding, Severity};

fn parse_json(json: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(json).map_err(|e| format!("unreadable scanner output: {e}"))
}

pub fn parse_npm_audit(json: &[u8], lockfile: &str) -> Result<Vec<Finding>, String> {
    let v = parse_json(json)?;
    if v.get("auditReportVersion").is_none() {
        return Err("npm audit output has no auditReportVersion".into());
    }
    let vulns = v
        .get("vulnerabilities")
        .and_then(Value::as_object)
        .ok_or("npm audit output has no vulnerabilities")?;

    let mut out = Vec::new();
    for vuln in vulns.values() {
        let fix = vuln.get("fixAvailable");
        let Some(via) = vuln.get("via").and_then(Value::as_array) else {
            continue;
        };
        for entry in via {
            // A bare string only names another vulnerable package; the
            // advisory itself is reported on that package.
            let Some(entry) = entry.as_object() else {
                continue;
            };
            let str_of = |k: &str| entry.get(k).and_then(Value::as_str);
            let url = str_of("url");
            let package = str_of("name").unwrap_or_default().to_string();
            let id = match url {
                Some(u) => u.rsplit('/').next().unwrap_or(u).to_string(),
                None => format!(
                    "npm-{}",
                    entry
                        .get("source")
                        .map(|s| s.to_string())
                        .unwrap_or_default()
                ),
            };
            // npm only names a version when the fix is for this very package;
            // otherwise it points at a parent that must be bumped instead.
            let fixed_in = fix
                .and_then(Value::as_object)
                .filter(|f| f.get("name").and_then(Value::as_str) == Some(package.as_str()))
                .and_then(|f| f.get("version"))
                .and_then(Value::as_str)
                .map(String::from);
            out.push(Finding {
                id,
                summary: str_of("title").unwrap_or_default().to_string(),
                severity: severity_from_label(str_of("severity").unwrap_or_default()),
                package,
                installed: None,
                fixed_in,
                lockfile: lockfile.to_string(),
                url: url.unwrap_or_default().to_string(),
            });
        }
    }
    Ok(out)
}

fn relative_to(path: &str, root: &Path) -> String {
    Path::new(path)
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

/// Group `max_severity` is a CVSS score string; used only when the advisory
/// itself carries no severity label.
fn group_severity(groups: &[Value], id: &str) -> Severity {
    groups
        .iter()
        .find(|g| {
            g.get("ids")
                .and_then(Value::as_array)
                .is_some_and(|ids| ids.iter().any(|i| i.as_str() == Some(id)))
        })
        .and_then(|g| g.get("max_severity"))
        .and_then(|m| {
            m.as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or(m.as_f64())
        })
        .map(severity_from_cvss)
        .unwrap_or(Severity::Unknown)
}

pub fn parse_osv(json: &[u8], root: &Path) -> Result<(Vec<Finding>, Vec<String>), String> {
    let v = parse_json(json)?;
    let results = v
        .get("results")
        .and_then(Value::as_array)
        .ok_or("osv-scanner output has no results")?;

    let mut findings = Vec::new();
    let mut covered = Vec::new();
    for result in results {
        let Some(path) = result.pointer("/source/path").and_then(Value::as_str) else {
            continue;
        };
        let lockfile = relative_to(path, root);
        covered.push(lockfile.clone());
        let empty = Vec::new();
        let groups = result
            .get("groups")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        for pkg in result
            .get("packages")
            .and_then(Value::as_array)
            .unwrap_or(&empty)
        {
            let name = pkg.pointer("/package/name").and_then(Value::as_str);
            let version = pkg.pointer("/package/version").and_then(Value::as_str);
            for vuln in pkg
                .get("vulnerabilities")
                .and_then(Value::as_array)
                .unwrap_or(&empty)
            {
                let Some(id) = vuln.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let severity = match vuln
                    .pointer("/database_specific/severity")
                    .and_then(Value::as_str)
                {
                    Some(label) => severity_from_label(label),
                    None => group_severity(groups, id),
                };
                // Only the affected entry for THIS package: one advisory can
                // name several packages, each fixed in its own version.
                let fixed_in = vuln
                    .get("affected")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|a| {
                        name.is_some() && a.pointer("/package/name").and_then(Value::as_str) == name
                    })
                    .filter_map(|a| a.get("ranges").and_then(Value::as_array))
                    .flatten()
                    .filter_map(|r| r.get("events").and_then(Value::as_array))
                    .flatten()
                    .find_map(|e| e.get("fixed").and_then(Value::as_str))
                    .map(String::from);
                findings.push(Finding {
                    id: id.to_string(),
                    summary: vuln
                        .get("summary")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    severity,
                    package: name.unwrap_or_default().to_string(),
                    installed: version.map(String::from),
                    fixed_in,
                    lockfile: lockfile.clone(),
                    url: format!("https://osv.dev/vulnerability/{id}"),
                });
            }
        }
    }
    // The same lockfile can appear in several results; report it once.
    covered.sort();
    covered.dedup();
    Ok((findings, covered))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NPM_VULN: &[u8] = include_bytes!("../../tests/fixtures/raids/npm-audit-vulnerable.json");
    const NPM_CLEAN: &[u8] = include_bytes!("../../tests/fixtures/raids/npm-audit-clean.json");
    const OSV_VULN: &[u8] = include_bytes!("../../tests/fixtures/raids/osv-vulnerable.json");
    const OSV_CLEAN: &[u8] = include_bytes!("../../tests/fixtures/raids/osv-clean.json");

    fn root() -> &'static Path {
        Path::new("/fake/repo")
    }

    #[test]
    fn npm_vulnerable_fixture_yields_findings_with_ghsa_ids() {
        let f = parse_npm_audit(NPM_VULN, "package-lock.json").unwrap();
        // 7 lodash advisories + 2 minimist advisories in the captured report.
        assert_eq!(f.len(), 9);
        let crit = f.iter().find(|x| x.id == "GHSA-jf85-cpcp-j695").unwrap();
        assert_eq!(crit.severity, Severity::Critical);
        assert_eq!(crit.package, "lodash");
        assert_eq!(crit.lockfile, "package-lock.json");
        assert_eq!(crit.installed, None);
        assert_eq!(
            crit.url,
            "https://github.com/advisories/GHSA-jf85-cpcp-j695"
        );
        // The captured report says `fixAvailable: true`, which names no version.
        assert_eq!(crit.fixed_in, None);
    }

    #[test]
    fn npm_fix_version_only_when_it_is_for_the_same_package() {
        let body = serde_json::json!({
            "auditReportVersion": 2,
            "vulnerabilities": {
                "a": {
                    "fixAvailable": { "name": "a", "version": "2.0.0" },
                    "via": [{ "source": 7, "name": "a", "title": "t", "severity": "high" }]
                },
                "b": {
                    "fixAvailable": { "name": "parent", "version": "9.0.0" },
                    "via": [{ "source": 8, "name": "b", "title": "t", "severity": "low",
                              "url": "https://github.com/advisories/GHSA-x" }]
                }
            }
        });
        let f = parse_npm_audit(body.to_string().as_bytes(), "l").unwrap();
        let a = f.iter().find(|x| x.package == "a").unwrap();
        assert_eq!(a.id, "npm-7");
        assert_eq!(a.fixed_in.as_deref(), Some("2.0.0"));
        let b = f.iter().find(|x| x.package == "b").unwrap();
        assert_eq!(b.id, "GHSA-x");
        assert_eq!(b.fixed_in, None);
    }

    #[test]
    fn npm_clean_fixture_yields_none() {
        assert!(parse_npm_audit(NPM_CLEAN, "package-lock.json")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn npm_transitive_string_via_is_skipped() {
        let body = br#"{"auditReportVersion":2,"vulnerabilities":{
            "parent":{"via":["child"],"fixAvailable":false},
            "child":{"via":[{"source":1,"name":"child","title":"t","severity":"moderate",
                "url":"https://github.com/advisories/GHSA-abcd"}],"fixAvailable":false}}}"#;
        let f = parse_npm_audit(body, "l").unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].package, "child");
    }

    #[test]
    fn osv_vulnerable_fixture_yields_findings_and_covered_lockfiles() {
        let (f, covered) = parse_osv(OSV_VULN, root()).unwrap();
        assert_eq!(f.len(), 3);
        let lodash = f.iter().find(|x| x.id == "GHSA-jf85-cpcp-j695").unwrap();
        assert_eq!(lodash.severity, Severity::Critical);
        assert_eq!(lodash.installed.as_deref(), Some("4.17.11"));
        assert_eq!(lodash.fixed_in.as_deref(), Some("4.17.12"));
        assert_eq!(lodash.package, "lodash");
        assert_eq!(
            lodash.url,
            "https://osv.dev/vulnerability/GHSA-jf85-cpcp-j695"
        );
        let min = f.iter().find(|x| x.package == "minimist").unwrap();
        assert_eq!(min.severity, Severity::Moderate);
        // Deduped and sorted even though package-lock.json appears twice.
        assert_eq!(
            covered,
            vec!["package-lock.json", "services/api/Cargo.lock"]
        );
    }

    #[test]
    fn osv_severity_falls_back_to_group_cvss() {
        let (f, _) = parse_osv(OSV_VULN, root()).unwrap();
        let rust = f.iter().find(|x| x.id == "RUSTSEC-2021-0003").unwrap();
        // No database_specific.severity; the group says 9.8.
        assert_eq!(rust.severity, Severity::Critical);
        assert_eq!(rust.fixed_in.as_deref(), Some("1.6.1"));
    }

    #[test]
    fn osv_unknown_severity_when_nothing_says_otherwise() {
        let body = br#"{"results":[{"source":{"path":"/r/a.lock"},"packages":[
            {"package":{"name":"p","version":"1"},"vulnerabilities":[{"id":"X-1"}]}]}]}"#;
        let (f, _) = parse_osv(body, Path::new("/r")).unwrap();
        assert_eq!(f[0].severity, Severity::Unknown);
        assert_eq!(f[0].fixed_in, None);
    }

    #[test]
    fn osv_fixed_in_comes_from_the_findings_own_package() {
        // One advisory can affect several packages; only the entry for THIS
        // package says which version fixes it here.
        let body = br#"{"results":[{"source":{"path":"/r/a.lock"},"packages":[
            {"package":{"name":"p","version":"1"},"vulnerabilities":[{"id":"X-1","affected":[
                {"package":{"name":"other"},"ranges":[{"events":[{"introduced":"0"},{"fixed":"9.9.9"}]}]},
                {"package":{"name":"p"},"ranges":[{"events":[{"introduced":"0"},{"fixed":"1.2.3"}]}]}]}]},
            {"package":{"name":"q","version":"1"},"vulnerabilities":[{"id":"X-2","affected":[
                {"package":{"name":"other"},"ranges":[{"events":[{"introduced":"0"},{"fixed":"9.9.9"}]}]}]}]}]}]}"#;
        let (f, _) = parse_osv(body, Path::new("/r")).unwrap();
        assert_eq!(f[0].fixed_in.as_deref(), Some("1.2.3"));
        assert_eq!(f[1].fixed_in, None);
    }

    #[test]
    fn osv_paths_are_repo_relative() {
        let (f, covered) = parse_osv(OSV_VULN, root()).unwrap();
        assert!(f.iter().all(|x| !x.lockfile.starts_with('/')));
        assert!(f.iter().any(|x| x.lockfile == "services/api/Cargo.lock"));
        assert!(covered.iter().all(|c| !c.starts_with('/')));
    }

    #[test]
    fn osv_clean_and_empty_results() {
        assert_eq!(
            parse_osv(br#"{"results": []}"#, root()).unwrap(),
            (vec![], vec![])
        );
        assert!(parse_osv(br#"{}"#, root()).is_err());
    }

    #[test]
    fn osv_source_without_vulnerabilities_still_counts_as_covered() {
        // Coverage is what lets a clean lockfile be Clean rather than "not
        // checked", so a listed source counts even with zero findings.
        assert_eq!(
            parse_osv(OSV_CLEAN, root()).unwrap(),
            (vec![], vec!["Cargo.lock".to_string()])
        );
    }

    #[test]
    fn truncated_json_is_an_error() {
        let half = &NPM_VULN[..NPM_VULN.len() / 2];
        assert!(parse_npm_audit(half, "l").is_err());
        let half = &OSV_VULN[..OSV_VULN.len() / 2];
        assert!(parse_osv(half, root()).is_err());
    }

    #[test]
    fn empty_and_garbage_are_errors() {
        for body in [&b""[..], b"not json", b"{}", b"[]"] {
            assert!(parse_npm_audit(body, "l").is_err());
            assert!(parse_osv(body, root()).is_err());
        }
        // npm audit reports registry failures as a JSON error object.
        assert!(parse_npm_audit(br#"{"error":{"code":"ENOTFOUND"}}"#, "l").is_err());
    }
}
