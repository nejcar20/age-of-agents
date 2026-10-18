//! Local, optional user configuration.
//!
//! Lives at `~/.age-of-agents/config.json`, alongside Task 11's
//! `transitions.jsonl`. Local only, never uploaded — the product has no
//! backend by design. Missing or malformed files silently yield defaults
//! (`load` never panics and never fails): a broken config file must not
//! stop the app from launching.
//!
//! ## `terminal_app` is `Option<String>`, not a defaulted `String`
//!
//! Task 10 added `platform::detect_terminal_app()`, which inspects running
//! processes to find the terminal that actually hosts herdr (e.g. this
//! user runs iTerm2, not Apple Terminal — raising "Terminal" would open an
//! empty new app window instead of the real one). If `terminal_app`
//! defaulted to the literal `"Terminal"`, that default would be
//! indistinguishable from a user explicitly choosing Apple Terminal, and it
//! would always win over detection — recreating exactly the bug Task 10
//! fixed. Making the field `Option<String>` with a `None` default lets the
//! call site (`commands::jump_to_next`) tell "unset" apart from "set", and
//! only fall back to detection when the user has not configured anything:
//! `config.terminal_app.clone().unwrap_or_else(platform::detect_terminal_app)`.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Path to `file` inside the app's local data directory,
/// `~/.age-of-agents` (falling back to the working directory if there is no
/// home directory at all, which is also what the callers did before).
///
/// FINAL REVIEW minor: this join was spelled out in three separate places
/// (`config.json` twice, `transitions.jsonl` once), which is three chances
/// for the app to write its evidence log somewhere the user isn't looking.
pub fn data_path(file: &str) -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".age-of-agents").join(file)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Config {
    /// Explicit terminal app override, e.g. `"iTerm"` or `"Ghostty"`, in the
    /// form `open -a` expects. `None` means "not set" — the caller should
    /// fall back to `platform::detect_terminal_app()`.
    #[serde(default)]
    pub terminal_app: Option<String>,
    #[serde(default = "default_true")]
    pub notify_on_stop: bool,
    /// Explicit roots to scan for unsettled repos (Phase 0.5a). `None` means
    /// "not set" — the caller should discover roots itself via
    /// `world::unsettled::candidate_roots` rather than assuming a hardcoded
    /// directory. Same "unset vs. defaulted" discipline as `terminal_app`
    /// above, for the same reason: a defaulted `Vec` would be indistinguishable
    /// from the user explicitly choosing it.
    #[serde(default)]
    pub project_roots: Option<Vec<String>>,
    /// The herdr `agent.start` `kind`/`name` to use when founding a
    /// settlement, e.g. `"claude"` or `"codex"`. `None` means "not set" —
    /// callers fall back to `"claude"`.
    #[serde(default)]
    pub default_agent: Option<String>,
    /// User-corrected or user-added trailing arguments for "resume the
    /// existing conversation", keyed by herdr agent `kind` (Phase 0.6).
    ///
    /// `commands::builtin_resume_args()` seeds a SMALL default map covering
    /// only the kinds verified directly against this machine's installed
    /// CLI (`claude --resume`, `codex resume`) — the other 19 herdr accepts
    /// are deliberately absent rather than guessed, because a wrong flag
    /// would silently start a fresh session while `resumable_agent_kinds()`
    /// told the UI it genuinely resumes. This field lets the user correct a
    /// wrong guess or add a kind we could not verify, without a rebuild: an
    /// entry here for a given kind wins over the built-in default for that
    /// same kind (see `commands::resume_args_for`), and kinds absent from
    /// both maps report as non-resumable rather than silently doing
    /// nothing.
    #[serde(default)]
    pub resume_args: Option<HashMap<String, Vec<String>>>,
}

fn default_true() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Config {
            terminal_app: None,
            notify_on_stop: default_true(),
            project_roots: None,
            default_agent: None,
            resume_args: None,
        }
    }
}

impl Config {
    /// Loads config from `path`. A missing file, an unreadable file, or a
    /// file that fails to parse as `Config` JSON all silently yield
    /// `Config::default()` — never a panic, never an error the caller has
    /// to handle.
    pub fn load(path: &Path) -> Config {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Writes this config to `path`, creating the directory if needed.
    ///
    /// FINAL REVIEW minor — deliberately kept despite being dead in the
    /// shipping binary (clippy flags it; hence the `allow`). **The app never
    /// writes `~/.age-of-agents/config.json`: in Phase 0 that file is
    /// hand-written by the user, and nothing in the UI creates or edits it.**
    /// This method exists so the round-trip (including the `terminal_app:
    /// null` shape that Task 10's bug depended on) stays under test, and so
    /// the first settings UI has a writer that is already proven. Delete it
    /// only together with those tests, and only if config stays read-only
    /// forever.
    #[allow(dead_code)]
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::load(&dir.path().join("nope.json"));
        assert_eq!(config.terminal_app, None);
        assert!(config.notify_on_stop);
    }

    #[test]
    fn malformed_file_yields_defaults_without_panicking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{ not json").unwrap();
        let config = Config::load(&path);
        assert_eq!(config.terminal_app, None);
        assert!(config.notify_on_stop);
    }

    #[test]
    fn saved_config_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let config = Config {
            terminal_app: Some("Ghostty".into()),
            notify_on_stop: false,
            project_roots: None,
            default_agent: None,
            resume_args: None,
        };
        config.save(&path).unwrap();
        let loaded = Config::load(&path);
        assert_eq!(loaded.terminal_app, Some("Ghostty".to_string()));
        assert!(!loaded.notify_on_stop);
    }

    #[test]
    fn unset_terminal_app_serializes_and_round_trips_as_none() {
        // Guards the exact bug Task 10 fixed: an unset override must not
        // silently become the literal string "Terminal" anywhere in the
        // load/save round trip.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        Config::default().save(&path).unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("\"terminal_app\": null"), "got: {contents}");
        assert_eq!(Config::load(&path).terminal_app, None);
    }

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
            resume_args: None,
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

    #[test]
    fn resume_args_defaults_to_none_and_round_trips_when_set() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            Config::load(&dir.path().join("missing.json")).resume_args,
            None,
            "a config with no resume_args key must not silently invent one"
        );

        let path = dir.path().join("config.json");
        let mut overrides = HashMap::new();
        overrides.insert("claude".to_string(), vec!["--resume".to_string()]);
        overrides.insert("mytool".to_string(), vec!["--continue-session".to_string()]);
        let config = Config { resume_args: Some(overrides), ..Config::default() };
        config.save(&path).unwrap();

        let loaded = Config::load(&path);
        let loaded_map = loaded.resume_args.expect("resume_args must round-trip");
        assert_eq!(loaded_map.get("claude"), Some(&vec!["--resume".to_string()]));
        assert_eq!(loaded_map.get("mytool"), Some(&vec!["--continue-session".to_string()]));
    }

    #[test]
    fn a_config_written_before_resume_args_existed_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"default_agent":"codex"}"#).unwrap();
        let loaded = Config::load(&path);
        assert_eq!(loaded.default_agent.as_deref(), Some("codex"));
        assert_eq!(loaded.resume_args, None);
    }
}
