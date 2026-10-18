use crate::herdr::client::HerdrClient;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Pane {
    pub pane_id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub foreground_cwd: Option<String>,
    #[serde(default = "unknown_status")]
    pub agent_status: AgentStatus,
    #[serde(default)]
    pub terminal_title: Option<String>,
    /// WHICH KIND of agent herdr says is running in this pane (`"claude"`,
    /// `"codex"`, …) — herdr's own `PaneInfo.agent`, kept under the wire's
    /// name here so this struct stays a literal transcription of what
    /// arrives. Read through `Pane::agent_kind` rather than directly: the
    /// wire has THREE ways of saying "no agent" and only one of them is
    /// this field holding a value.
    #[serde(default)]
    pub agent: Option<String>,
}

fn unknown_status() -> AgentStatus { AgentStatus::Unknown }

impl Pane {
    /// The pane's agent kind, or `None` when herdr is not claiming one.
    ///
    /// Verified against the author's live session on 2026-09-19: a pane
    /// running an agent reports `"agent":"claude"` alongside
    /// `"agent_status":"blocked"`, and a pane running a plain shell OMITS
    /// THE KEY ENTIRELY (`{"agent_status":"unknown", "cwd":…}` — no
    /// `agent`). herdr's own schema additionally permits an explicit
    /// `null` (`PaneInfo.agent` is `["string","null"]` and is not in
    /// `required`), so all three shapes — absent, `null`, and a string —
    /// are real. An empty/whitespace-only string is folded in too: it is
    /// not the name of any agent, so reporting it would be reporting a
    /// blank as though it were a fact.
    ///
    /// Every one of those collapses to `None`, and `None` is rendered as
    /// "we do not know," NEVER back-filled with the configured default
    /// kind. `commands::start_agent`'s `config.default_agent.unwrap_or
    /// ("claude")` is a different question with a different honest answer:
    /// choosing what to LAUNCH may fall back to a default, because the
    /// fallback is what actually gets run. Describing what is ALREADY
    /// running may not — a guess there is a claim about the author's
    /// machine that nothing on the wire supports.
    pub fn agent_kind(&self) -> Option<String> {
        let kind = self.agent.as_deref()?.trim();
        if kind.is_empty() { None } else { Some(kind.to_string()) }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Workspace {
    pub workspace_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "unknown_status")]
    pub agent_status: AgentStatus,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Snapshot {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub protocol: u32,
    #[serde(default)]
    pub panes: Vec<Pane>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub focused_pane_id: Option<String>,
}

fn extract_snapshot(result: Value) -> Result<Snapshot> {
    // First try the nested shape: {"snapshot": {...}}
    if let Some(snapshot_value) = result.get("snapshot") {
        return Ok(serde_json::from_value(snapshot_value.clone())?);
    }

    // Fall back to bare snapshot object if it has identifying fields
    if result.is_object() {
        let obj = result.as_object().unwrap();
        if obj.contains_key("panes") || obj.contains_key("workspaces") || obj.contains_key("protocol") {
            return Ok(serde_json::from_value(result)?);
        }
    }

    // Otherwise, error with diagnostic info about what we found
    let keys: Vec<&str> = result
        .as_object()
        .map(|o| o.keys().map(|k| k.as_str()).collect())
        .unwrap_or_default();
    let keys_str = if keys.is_empty() {
        "no fields".to_string()
    } else {
        format!("[{}]", keys.join(", "))
    };

    Err(anyhow!(
        "herdr session.snapshot returned an unrecognised shape: no `snapshot` key and no snapshot-like fields (found: {})",
        keys_str
    ))
}

pub async fn fetch_snapshot(client: &HerdrClient) -> Result<Snapshot> {
    let result = client.call("session.snapshot", json!({})).await?;
    extract_snapshot(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/snapshot.json");

    #[test]
    fn parses_the_real_fixture() {
        let snap: Snapshot = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(snap.protocol, 19);
        assert!(!snap.panes.is_empty());
        assert!(snap.panes.iter().all(|p| !p.pane_id.is_empty()));
    }

    #[test]
    fn unknown_status_strings_do_not_fail_parsing() {
        let json = r#"{"version":"0.9.0","protocol":20,"panes":[
            {"pane_id":"w1:p1","workspace_id":"w1","cwd":"/tmp","agent_status":"meditating"}],
            "workspaces":[]}"#;
        let snap: Snapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snap.panes[0].agent_status, AgentStatus::Unknown);
    }

    #[test]
    fn missing_optional_fields_are_tolerated() {
        let json = r#"{"version":"0.8.0","protocol":19,"panes":[
            {"pane_id":"w1:p1","workspace_id":"w1","agent_status":"working"}],
            "workspaces":[]}"#;
        let snap: Snapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snap.panes[0].cwd, None);
        assert_eq!(snap.panes[0].agent_status, AgentStatus::Working);
    }

    /// The exact three shapes the live session and herdr's own schema
    /// produce (see `Pane::agent_kind`): a real kind, the key omitted
    /// entirely (what `w2:p1`, a plain shell, actually sends), and an
    /// explicit `null`. Only the first is a fact about what is running.
    #[test]
    fn agent_kind_is_carried_when_present_and_unknown_in_every_other_shape() {
        let json = r#"{"version":"0.9.0","protocol":19,"panes":[
            {"pane_id":"w27:p1","workspace_id":"w27","agent":"claude","agent_status":"blocked"},
            {"pane_id":"w2:p1","workspace_id":"w2","agent_status":"unknown"},
            {"pane_id":"w3:p1","workspace_id":"w3","agent":null,"agent_status":"unknown"},
            {"pane_id":"w4:p1","workspace_id":"w4","agent":"   ","agent_status":"unknown"}],
            "workspaces":[]}"#;
        let snap: Snapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snap.panes[0].agent_kind().as_deref(), Some("claude"));
        assert_eq!(snap.panes[1].agent_kind(), None, "an absent key is unknown");
        assert_eq!(snap.panes[2].agent_kind(), None, "an explicit null is unknown");
        assert_eq!(snap.panes[3].agent_kind(), None, "a blank string is unknown");
    }

    /// A kind this app has never heard of is still reported verbatim: the
    /// honest answer to "who is working here" is whatever herdr named, not
    /// "unknown" (which would omit a fact herdr stated plainly) and not
    /// some recognised stand-in (which would invent one).
    #[test]
    fn an_unrecognised_agent_kind_is_reported_verbatim_not_dropped() {
        let json = r#"{"version":"0.9.0","protocol":19,"panes":[
            {"pane_id":"w9:p1","workspace_id":"w9","agent":"aider","agent_status":"working"}],
            "workspaces":[]}"#;
        let snap: Snapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snap.panes[0].agent_kind().as_deref(), Some("aider"));
    }

    #[test]
    fn nested_shape_with_snapshot_key_parses() {
        let json = json!({
            "snapshot": {
                "version": "0.8.0",
                "protocol": 19,
                "panes": [],
                "workspaces": []
            }
        });
        let snap = extract_snapshot(json).unwrap();
        assert_eq!(snap.protocol, 19);
        assert_eq!(snap.version, "0.8.0");
    }

    #[test]
    fn bare_snapshot_object_without_snapshot_key_parses_via_fallback() {
        let json = json!({
            "version": "0.8.0",
            "protocol": 19,
            "panes": [],
            "workspaces": []
        });
        let snap = extract_snapshot(json).unwrap();
        assert_eq!(snap.protocol, 19);
        assert_eq!(snap.version, "0.8.0");
    }

    #[test]
    fn unrecognized_shape_returns_error_with_diagnostic_keys() {
        let json = json!({
            "type": "session_snapshot",
            "unexpected": 1
        });
        let result = extract_snapshot(json);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("unrecognised shape"));
        assert!(err_msg.contains("type"));
        assert!(err_msg.contains("unexpected"));
    }
}
