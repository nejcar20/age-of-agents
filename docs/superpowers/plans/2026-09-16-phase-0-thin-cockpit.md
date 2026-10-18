# Age of Agents — Phase 0: Thin Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri desktop window that shows one island per git repository with live agent state read from Herdr, and a hotkey that instantly jumps to the next repo whose agent has stopped, focusing it in the user's existing Herdr terminal.

**Architecture:** A Rust core owns a persistent connection to the Herdr unix socket, folds `session.snapshot` plus a global event subscription into a `WorldState`, and pushes that state to a lightweight web frontend. Panes are grouped into islands by resolving each pane's `cwd` to its git repository root (worktrees map back to their main repo). No embedded terminal, no city generator, no 3D — those are Phase 0.5 and Phase 1. This phase exists to prove the daily-use thesis and to measure how reliable Herdr's agent-state detection actually is.

**Tech Stack:** Tauri 2, Rust (stable), tokio, serde/serde_json, React + TypeScript + Vite, vitest.

**Spec:** `docs/superpowers/specs/2026-09-16-age-of-agents-design.md`

## Global Constraints

- **Target Herdr version:** 0.8.0, socket protocol `19`. Verify at startup; warn (do not crash) on mismatch.
- **Socket path resolution order, exactly:** `--session <name>` → `$HERDR_SOCKET_PATH` → `$HERDR_SESSION` (→ `~/.config/herdr/sessions/<name>/herdr.sock`) → default `~/.config/herdr/herdr.sock`.
- **Protocol:** newline-delimited JSON. Request: `{"id":"<unique>","method":"<m>","params":{...}}`. Success: `{"id":..,"result":{...}}`. Error: `{"id":..,"error":{"code":..,"message":..}}`.
- **Writes to Herdr allowed in Phase 0:** `agent.focus`, `workspace.focus`, `pane.focus`, `notification.show` only. No `pane.send_text`, no `pane.run`, no git writes. Phase 0 is read-and-route only (spec §5.6).
- **Never call `pane.run` in an agent pane** — the agent receives it as a prompt (spec §8.3).
- **`pane.agent_status_changed` requires a concrete `pane_id`** and cannot be subscribed globally. Use the global `pane.updated` / `pane.created` / `pane.closed` / `pane.exited` events, which carry pane state including `agent_status`.
- **Agent status enum:** `idle | working | blocked | done | unknown`.
- **Attention model:** `blocked`, `done`, and `idle`-after-work collapse into one state, `Stopped` (spec §5.4). Never build UI copy on the distinction.
- **Principle 2 — never slower than the terminal:** the jump action cuts instantly. No animation on the attention path.
- **Principle 7 — local only:** no network calls, no telemetry upload, no accounts.
- **Platform:** macOS (darwin 25.5, Apple Silicon). Node v26.5.0 is installed; Rust is NOT yet installed (Task 1).
- Every task ends with a passing test run and a commit.

---

### Task 1: Toolchain, Tauri scaffold, and a running window

**Files:**
- Create: `package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable Tauri 2 app; `cargo test` and `npm test` both runnable from the repo root.

- [ ] **Step 1: Install Rust (requires the user; it modifies the shell profile)**

Ask the user to run this in their terminal:

```
! curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

Then verify:

```bash
source "$HOME/.cargo/env" && rustc --version && cargo --version
```

Expected: both print a version. Do not continue until they do.

- [ ] **Step 2: Scaffold the Tauri app**

```bash
cd /Users/you/Projects/AgeOfAgents
npm create tauri-app@latest . -- --template react-ts --manager npm --yes
npm install
```

If the scaffolder refuses because the directory is not empty, scaffold into `/tmp/aoa-scaffold` and copy everything except `docs/` and `.git/` across.

- [ ] **Step 3: Set app identity in `src-tauri/tauri.conf.json`**

```json
{
  "productName": "Age of Agents",
  "identifier": "dev.ageofagents.app",
  "app": {
    "windows": [
      { "title": "Age of Agents", "width": 1100, "height": 720, "resizable": true }
    ]
  }
}
```

- [ ] **Step 4: Verify the window runs**

Run: `npm run tauri dev`
Expected: a window titled "Age of Agents" opens. Close it.

- [ ] **Step 5: Add vitest and confirm both test runners work**

```bash
npm install -D vitest
npm pkg set scripts.test="vitest run"
```

Run: `npm test` (expected: "No test files found" and exit 0 — acceptable here only, every later task adds real tests) and `cd src-tauri && cargo test` (expected: 0 tests, exit 0).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Tauri 2 app with React and vitest"
```

---

### Task 2: Socket path resolution

**Files:**
- Create: `src-tauri/src/herdr/mod.rs`, `src-tauri/src/herdr/socket_path.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod herdr;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `herdr::socket_path::resolve(session: Option<&str>, env: &dyn EnvSource, home: &Path) -> PathBuf` and `trait EnvSource { fn get(&self, key: &str) -> Option<String>; }`, plus `struct RealEnv;` implementing it.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/herdr/socket_path.rs
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    struct MapEnv(HashMap<String, String>);
    impl EnvSource for MapEnv {
        fn get(&self, key: &str) -> Option<String> { self.0.get(key).cloned() }
    }
    fn env(pairs: &[(&str, &str)]) -> MapEnv {
        MapEnv(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }
    fn home() -> PathBuf { PathBuf::from("/home/u") }

    #[test]
    fn explicit_session_wins_over_everything() {
        let e = env(&[("HERDR_SOCKET_PATH", "/tmp/x.sock"), ("HERDR_SESSION", "other")]);
        assert_eq!(
            resolve(Some("work"), &e, &home()),
            PathBuf::from("/home/u/.config/herdr/sessions/work/herdr.sock")
        );
    }

    #[test]
    fn socket_path_env_wins_over_session_env() {
        let e = env(&[("HERDR_SOCKET_PATH", "/tmp/x.sock"), ("HERDR_SESSION", "other")]);
        assert_eq!(resolve(None, &e, &home()), PathBuf::from("/tmp/x.sock"));
    }

    #[test]
    fn session_env_maps_to_sessions_dir() {
        let e = env(&[("HERDR_SESSION", "other")]);
        assert_eq!(
            resolve(None, &e, &home()),
            PathBuf::from("/home/u/.config/herdr/sessions/other/herdr.sock")
        );
    }

    #[test]
    fn default_is_config_herdr_sock() {
        let e = env(&[]);
        assert_eq!(resolve(None, &e, &home()), PathBuf::from("/home/u/.config/herdr/herdr.sock"));
    }
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd src-tauri && cargo test socket_path`
Expected: FAIL — `resolve` and `EnvSource` do not exist.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/herdr/socket_path.rs
use std::path::{Path, PathBuf};

pub trait EnvSource {
    fn get(&self, key: &str) -> Option<String>;
}

pub struct RealEnv;
impl EnvSource for RealEnv {
    fn get(&self, key: &str) -> Option<String> { std::env::var(key).ok() }
}

fn session_socket(home: &Path, name: &str) -> PathBuf {
    home.join(".config/herdr/sessions").join(name).join("herdr.sock")
}

pub fn resolve(session: Option<&str>, env: &dyn EnvSource, home: &Path) -> PathBuf {
    if let Some(name) = session {
        return session_socket(home, name);
    }
    if let Some(p) = env.get("HERDR_SOCKET_PATH") {
        return PathBuf::from(p);
    }
    if let Some(name) = env.get("HERDR_SESSION") {
        return session_socket(home, &name);
    }
    home.join(".config/herdr/herdr.sock")
}
```

```rust
// src-tauri/src/herdr/mod.rs
pub mod socket_path;
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test socket_path`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/herdr
git commit -m "feat(herdr): resolve socket path in documented precedence order"
```

---

### Task 3: Socket client — request/response over newline-delimited JSON

**Files:**
- Create: `src-tauri/src/herdr/protocol.rs`, `src-tauri/src/herdr/client.rs`, `src-tauri/src/herdr/testing.rs`
- Modify: `src-tauri/src/herdr/mod.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `socket_path::resolve`.
- Produces:
  - `protocol::Request { id: String, method: String, params: serde_json::Value }`
  - `protocol::Response { id: String, result: Option<Value>, error: Option<ProtocolError> }`
  - `protocol::ProtocolError { code: String, message: String }`
  - `client::HerdrClient::connect(path: &Path) -> anyhow::Result<HerdrClient>`
  - `HerdrClient::call(&self, method: &str, params: Value) -> anyhow::Result<Value>`
  - `testing::FakeHerdr::start(handler) -> FakeHerdr` with `.path() -> PathBuf`

- [ ] **Step 1: Add dependencies**

```toml
# src-tauri/Cargo.toml — under [dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "io-util", "sync", "time"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
```

- [ ] **Step 2: Write the failing test**

```rust
// src-tauri/src/herdr/client.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::testing::FakeHerdr;
    use serde_json::json;

    #[tokio::test]
    async fn call_returns_result_payload() {
        let fake = FakeHerdr::start(|req| {
            assert_eq!(req.method, "ping");
            Ok(json!({ "type": "pong" }))
        })
        .await;

        let client = HerdrClient::connect(fake.path()).await.unwrap();
        let result = client.call("ping", json!({})).await.unwrap();

        assert_eq!(result["type"], "pong");
    }

    #[tokio::test]
    async fn call_surfaces_protocol_errors() {
        let fake = FakeHerdr::start(|_req| {
            Err(("not_found".to_string(), "pane not found".to_string()))
        })
        .await;

        let client = HerdrClient::connect(fake.path()).await.unwrap();
        let err = client.call("pane.get", json!({"pane_id": "w9:p9"})).await.unwrap_err();

        assert!(err.to_string().contains("not_found"));
        assert!(err.to_string().contains("pane not found"));
    }
}
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd src-tauri && cargo test herdr::client`
Expected: FAIL — `HerdrClient` and `FakeHerdr` do not exist.

- [ ] **Step 4: Implement the protocol types**

```rust
// src-tauri/src/herdr/protocol.rs
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct Request {
    pub id: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Response {
    pub id: String,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<ProtocolError>,
}
```

- [ ] **Step 5: Implement the fake server**

```rust
// src-tauri/src/herdr/testing.rs
use crate::herdr::protocol::Request;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

pub struct FakeHerdr {
    path: PathBuf,
    _dir: tempfile::TempDir,
}

impl FakeHerdr {
    pub fn path(&self) -> &Path { &self.path }

    /// Handler returns Ok(result) or Err((code, message)).
    pub async fn start<F>(handler: F) -> FakeHerdr
    where
        F: Fn(&RequestView) -> Result<Value, (String, String)> + Send + Sync + 'static,
    {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("herdr.sock");
        let listener = UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (read_half, mut write_half) = stream.into_split();
                let mut lines = BufReader::new(read_half).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let parsed: Value = serde_json::from_str(&line).unwrap();
                    let view = RequestView {
                        id: parsed["id"].as_str().unwrap_or_default().to_string(),
                        method: parsed["method"].as_str().unwrap_or_default().to_string(),
                        params: parsed["params"].clone(),
                    };
                    let reply = match handler(&view) {
                        Ok(result) => json!({ "id": view.id, "result": result }),
                        Err((code, message)) => {
                            json!({ "id": view.id, "error": { "code": code, "message": message } })
                        }
                    };
                    let mut bytes = serde_json::to_vec(&reply).unwrap();
                    bytes.push(b'\n');
                    let _ = write_half.write_all(&bytes).await;
                }
            }
        });
        FakeHerdr { path, _dir: dir }
    }
}

pub struct RequestView {
    pub id: String,
    pub method: String,
    pub params: Value,
}

// Silence the unused-import warning when Request is only used by consumers.
#[allow(unused)]
fn _assert_request_is_serializable(r: &Request) -> String { serde_json::to_string(r).unwrap() }
```

Add to `src-tauri/Cargo.toml`: `tempfile = "3"` under `[dev-dependencies]`.

- [ ] **Step 6: Implement the client**

```rust
// src-tauri/src/herdr/client.rs
use crate::herdr::protocol::{Request, Response};
use anyhow::{anyhow, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{oneshot, Mutex};

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Response>>>>;

pub struct HerdrClient {
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    pending: Pending,
    counter: AtomicU64,
    events: tokio::sync::broadcast::Sender<Value>,
}

impl HerdrClient {
    pub async fn connect(path: &Path) -> Result<Arc<HerdrClient>> {
        let stream = UnixStream::connect(path).await?;
        let (read_half, write_half) = stream.into_split();
        let (events_tx, _) = tokio::sync::broadcast::channel(256);
        let client = Arc::new(HerdrClient {
            writer: Arc::new(Mutex::new(write_half)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            counter: AtomicU64::new(0),
            events: events_tx.clone(),
        });

        let pending = client.pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(read_half).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let value: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let id = value.get("id").and_then(|v| v.as_str()).map(str::to_string);
                let is_reply = value.get("result").is_some() || value.get("error").is_some();
                match (id, is_reply) {
                    (Some(id), true) => {
                        if let Some(tx) = pending.lock().await.remove(&id) {
                            if let Ok(resp) = serde_json::from_value::<Response>(value) {
                                let _ = tx.send(resp);
                            }
                        } else {
                            // Subscription deliveries reuse the subscribe id.
                            let _ = events_tx.send(value);
                        }
                    }
                    _ => { let _ = events_tx.send(value); }
                }
            }
        });

        Ok(client)
    }

    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = format!("aoa-{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        let request = Request { id: id.clone(), method: method.to_string(), params };
        let mut bytes = serde_json::to_vec(&request)?;
        bytes.push(b'\n');
        self.writer.lock().await.write_all(&bytes).await?;

        let response = tokio::time::timeout(std::time::Duration::from_secs(10), rx)
            .await
            .map_err(|_| anyhow!("herdr call `{method}` timed out"))??;

        if let Some(err) = response.error {
            return Err(anyhow!("herdr error {}: {}", err.code, err.message));
        }
        response.result.ok_or_else(|| anyhow!("herdr returned no result for `{method}`"))
    }

    pub async fn send_raw(&self, request: Request) -> Result<()> {
        let mut bytes = serde_json::to_vec(&request)?;
        bytes.push(b'\n');
        self.writer.lock().await.write_all(&bytes).await?;
        Ok(())
    }
}
```

Update `src-tauri/src/herdr/mod.rs`:

```rust
pub mod client;
pub mod protocol;
pub mod socket_path;
#[cfg(test)]
pub mod testing;
```

- [ ] **Step 7: Run the tests**

Run: `cd src-tauri && cargo test herdr::client`
Expected: 2 passed.

- [ ] **Step 8: Verify against the real socket**

```bash
cd src-tauri && cargo test -- --ignored --nocapture
```

Add this test first:

```rust
#[tokio::test]
#[ignore = "requires a running herdr"]
async fn pings_the_real_herdr() {
    let home = dirs::home_dir().unwrap();
    let path = crate::herdr::socket_path::resolve(
        None, &crate::herdr::socket_path::RealEnv, &home);
    let client = HerdrClient::connect(&path).await.unwrap();
    let result = client.call("ping", serde_json::json!({})).await.unwrap();
    assert_eq!(result["type"], "pong");
}
```

Add `dirs = "5"` to `[dependencies]`.
Expected: PASS against the live Herdr 0.8.0.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(herdr): newline-delimited JSON socket client with request correlation"
```

---

### Task 4: Snapshot model

**Files:**
- Create: `src-tauri/src/herdr/snapshot.rs`
- Create: `src-tauri/tests/fixtures/snapshot.json`
- Modify: `src-tauri/src/herdr/mod.rs`

**Interfaces:**
- Consumes: `HerdrClient::call`.
- Produces:
  - `enum AgentStatus { Idle, Working, Blocked, Done, Unknown }` (serde: lowercase, unknown strings deserialize to `Unknown`)
  - `struct Pane { pane_id: String, workspace_id: String, cwd: Option<String>, foreground_cwd: Option<String>, agent_status: AgentStatus, terminal_title: Option<String> }`
  - `struct Workspace { workspace_id: String, label: String, agent_status: AgentStatus }`
  - `struct Snapshot { version: String, protocol: u32, panes: Vec<Pane>, workspaces: Vec<Workspace>, focused_pane_id: Option<String> }`
  - `fn fetch_snapshot(client: &HerdrClient) -> Result<Snapshot>`

- [ ] **Step 1: Save a real fixture**

```bash
mkdir -p src-tauri/tests/fixtures
herdr api snapshot | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['result']['snapshot'], indent=1))" > src-tauri/tests/fixtures/snapshot.json
head -c 200 src-tauri/tests/fixtures/snapshot.json
```

Expected: valid JSON beginning with `{ "agents": [...`.

- [ ] **Step 2: Write the failing tests**

```rust
// src-tauri/src/herdr/snapshot.rs
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
}
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd src-tauri && cargo test herdr::snapshot`
Expected: FAIL — `Snapshot` does not exist.

- [ ] **Step 4: Implement**

```rust
// src-tauri/src/herdr/snapshot.rs
use crate::herdr::client::HerdrClient;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::json;

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
}

fn unknown_status() -> AgentStatus { AgentStatus::Unknown }

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

pub async fn fetch_snapshot(client: &HerdrClient) -> Result<Snapshot> {
    let result = client.call("session.snapshot", json!({})).await?;
    let snapshot = result.get("snapshot").cloned().unwrap_or(result);
    Ok(serde_json::from_value(snapshot)?)
}
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test herdr::snapshot`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(herdr): typed session snapshot model tolerant of version drift"
```

---

### Task 5: Repository resolution (islands)

**Files:**
- Create: `src-tauri/src/world/mod.rs`, `src-tauri/src/world/repo.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod world;`)

**Interfaces:**
- Consumes: nothing (shells out to `git`).
- Produces:
  - `struct RepoRef { root: PathBuf, name: String, is_worktree: bool }`
  - `trait GitProbe { fn common_dir(&self, cwd: &Path) -> Option<PathBuf>; fn toplevel(&self, cwd: &Path) -> Option<PathBuf>; }`
  - `struct RealGit;` implementing it
  - `struct RepoResolver::new(probe: Box<dyn GitProbe + Send + Sync>) -> RepoResolver`
  - `RepoResolver::resolve(&mut self, cwd: &Path) -> Option<RepoRef>` (memoized per cwd)

**Why `common_dir`:** `git rev-parse --git-common-dir` in a worktree points at the *main* repo's `.git`, which is how several worktrees collapse onto one island (spec §8.2).

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/world/repo.rs
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
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd src-tauri && cargo test world::repo`
Expected: FAIL — `RepoResolver` does not exist.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/world/repo.rs
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub root: PathBuf,
    pub name: String,
    pub is_worktree: bool,
}

pub trait GitProbe {
    fn toplevel(&self, cwd: &Path) -> Option<PathBuf>;
    fn common_dir(&self, cwd: &Path) -> Option<PathBuf>;
}

pub struct RealGit;

impl RealGit {
    fn run(cwd: &Path, args: &[&str]) -> Option<PathBuf> {
        let out = Command::new("git").args(args).current_dir(cwd).output().ok()?;
        if !out.status.success() { return None; }
        let text = String::from_utf8(out.stdout).ok()?;
        let trimmed = text.trim();
        if trimmed.is_empty() { return None; }
        let path = PathBuf::from(trimmed);
        Some(if path.is_absolute() { path } else { cwd.join(path) })
    }
}

impl GitProbe for RealGit {
    fn toplevel(&self, cwd: &Path) -> Option<PathBuf> {
        Self::run(cwd, &["rev-parse", "--show-toplevel"])
    }
    fn common_dir(&self, cwd: &Path) -> Option<PathBuf> {
        Self::run(cwd, &["rev-parse", "--git-common-dir"])
    }
}

pub struct RepoResolver {
    probe: Box<dyn GitProbe + Send + Sync>,
    cache: HashMap<PathBuf, Option<RepoRef>>,
}

impl RepoResolver {
    pub fn new(probe: Box<dyn GitProbe + Send + Sync>) -> Self {
        RepoResolver { probe, cache: HashMap::new() }
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
        let root = match self.probe.common_dir(cwd) {
            Some(common) if common.file_name().map(|n| n == ".git").unwrap_or(false) => {
                common.parent().map(Path::to_path_buf).unwrap_or(toplevel.clone())
            }
            _ => toplevel.clone(),
        };
        let name = root.file_name()?.to_string_lossy().to_string();
        Some(RepoRef { is_worktree: root != toplevel, root, name })
    }
}
```

```rust
// src-tauri/src/world/mod.rs
pub mod repo;
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test world::repo`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(world): resolve pane cwd to repo root, collapsing worktrees"
```

---

### Task 6: Attention model — islands and the jump order

**Files:**
- Create: `src-tauri/src/world/attention.rs`, `src-tauri/src/world/state.rs`
- Modify: `src-tauri/src/world/mod.rs`

**Interfaces:**
- Consumes: `Snapshot`, `Pane`, `AgentStatus`, `RepoResolver`, `RepoRef`.
- Produces:
  - `enum Attention { Stopped, Working, Quiet }`
  - `struct IslandAgent { pane_id: String, workspace_id: String, status: AgentStatus, title: Option<String>, is_worktree: bool }`
  - `struct Island { id: String, name: String, root: String, attention: Attention, agents: Vec<IslandAgent> }`
  - `struct WorldState { islands: Vec<Island>, herdr_connected: bool, herdr_version: String, protocol_mismatch: bool }`
  - `fn build_world(snapshot: &Snapshot, resolver: &mut RepoResolver) -> WorldState`
  - `fn next_target(world: &WorldState, current: Option<&str>) -> Option<&Island>`

**Rules (from spec §5.4 and the Global Constraints):**
- `Blocked`, `Done` → `Stopped`. `Working` → `Working`. `Idle`, `Unknown` → `Quiet`.
- An island's attention is the most urgent of its agents: `Stopped` > `Working` > `Quiet`.
- Panes whose cwd is not in a git repo are dropped in Phase 0.
- Prefer `foreground_cwd` when present, else `cwd`.
- `next_target` cycles through `Stopped` islands in stable order, starting after `current`.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/world/attention.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::snapshot::{AgentStatus, Pane, Snapshot};
    use crate::world::repo::{GitProbe, RepoResolver};
    use std::path::{Path, PathBuf};

    struct EveryDirIsARepo;
    impl GitProbe for EveryDirIsARepo {
        fn toplevel(&self, cwd: &Path) -> Option<PathBuf> {
            if cwd.starts_with("/p") { Some(cwd.to_path_buf()) } else { None }
        }
        fn common_dir(&self, cwd: &Path) -> Option<PathBuf> {
            self.toplevel(cwd).map(|p| p.join(".git"))
        }
    }

    fn pane(id: &str, ws: &str, cwd: &str, status: AgentStatus) -> Pane {
        Pane {
            pane_id: id.into(), workspace_id: ws.into(),
            cwd: Some(cwd.into()), foreground_cwd: None,
            agent_status: status, terminal_title: None,
        }
    }

    fn snapshot(panes: Vec<Pane>) -> Snapshot {
        Snapshot { version: "0.8.0".into(), protocol: 19, panes,
                   workspaces: vec![], focused_pane_id: None }
    }

    fn resolver() -> RepoResolver { RepoResolver::new(Box::new(EveryDirIsARepo)) }

    #[test]
    fn blocked_and_done_both_mean_stopped() {
        assert_eq!(Attention::from(AgentStatus::Blocked), Attention::Stopped);
        assert_eq!(Attention::from(AgentStatus::Done), Attention::Stopped);
        assert_eq!(Attention::from(AgentStatus::Working), Attention::Working);
        assert_eq!(Attention::from(AgentStatus::Idle), Attention::Quiet);
        assert_eq!(Attention::from(AgentStatus::Unknown), Attention::Quiet);
    }

    #[test]
    fn panes_in_one_repo_become_one_island() {
        let world = build_world(&snapshot(vec![
            pane("w1:p1", "w1", "/p/api", AgentStatus::Working),
            pane("w2:p1", "w2", "/p/api", AgentStatus::Idle),
        ]), &mut resolver());
        assert_eq!(world.islands.len(), 1);
        assert_eq!(world.islands[0].agents.len(), 2);
        assert_eq!(world.islands[0].name, "api");
    }

    #[test]
    fn island_attention_takes_the_most_urgent_agent() {
        let world = build_world(&snapshot(vec![
            pane("w1:p1", "w1", "/p/api", AgentStatus::Working),
            pane("w1:p2", "w1", "/p/api", AgentStatus::Blocked),
        ]), &mut resolver());
        assert_eq!(world.islands[0].attention, Attention::Stopped);
    }

    #[test]
    fn panes_outside_a_repo_are_ignored() {
        let world = build_world(&snapshot(vec![
            pane("w1:p1", "w1", "/home/u", AgentStatus::Working),
        ]), &mut resolver());
        assert!(world.islands.is_empty());
    }

    #[test]
    fn next_target_cycles_through_stopped_islands_only() {
        let world = build_world(&snapshot(vec![
            pane("w1:p1", "w1", "/p/aaa", AgentStatus::Blocked),
            pane("w2:p1", "w2", "/p/bbb", AgentStatus::Working),
            pane("w3:p1", "w3", "/p/ccc", AgentStatus::Done),
        ]), &mut resolver());

        assert_eq!(next_target(&world, None).unwrap().name, "aaa");
        assert_eq!(next_target(&world, Some("/p/aaa")).unwrap().name, "ccc");
        assert_eq!(next_target(&world, Some("/p/ccc")).unwrap().name, "aaa", "wraps around");
    }

    #[test]
    fn next_target_is_none_when_nothing_is_stopped() {
        let world = build_world(&snapshot(vec![
            pane("w1:p1", "w1", "/p/api", AgentStatus::Working),
        ]), &mut resolver());
        assert!(next_target(&world, None).is_none());
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd src-tauri && cargo test world::attention`
Expected: FAIL — `Attention` does not exist.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/world/attention.rs
use crate::herdr::snapshot::{AgentStatus, Snapshot};
use crate::world::repo::RepoResolver;
use crate::world::state::{Island, IslandAgent, WorldState};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Attention {
    // Ord matters: Stopped is the most urgent, so it sorts last and `max()` finds it.
    Quiet,
    Working,
    Stopped,
}

impl From<AgentStatus> for Attention {
    fn from(status: AgentStatus) -> Self {
        match status {
            AgentStatus::Blocked | AgentStatus::Done => Attention::Stopped,
            AgentStatus::Working => Attention::Working,
            AgentStatus::Idle | AgentStatus::Unknown => Attention::Quiet,
        }
    }
}

pub fn build_world(snapshot: &Snapshot, resolver: &mut RepoResolver) -> WorldState {
    let mut grouped: BTreeMap<String, Island> = BTreeMap::new();

    for pane in &snapshot.panes {
        let cwd = pane.foreground_cwd.as_ref().or(pane.cwd.as_ref());
        let Some(cwd) = cwd else { continue };
        let Some(repo) = resolver.resolve(Path::new(cwd)) else { continue };

        let root = repo.root.to_string_lossy().to_string();
        let island = grouped.entry(root.clone()).or_insert_with(|| Island {
            id: root.clone(),
            name: repo.name.clone(),
            root,
            attention: Attention::Quiet,
            agents: Vec::new(),
        });

        island.attention = island.attention.max(Attention::from(pane.agent_status));
        island.agents.push(IslandAgent {
            pane_id: pane.pane_id.clone(),
            workspace_id: pane.workspace_id.clone(),
            status: pane.agent_status,
            title: pane.terminal_title.clone(),
            is_worktree: repo.is_worktree,
        });
    }

    WorldState {
        islands: grouped.into_values().collect(),
        herdr_connected: true,
        herdr_version: snapshot.version.clone(),
        protocol_mismatch: snapshot.protocol != 19,
    }
}

pub fn next_target<'a>(world: &'a WorldState, current: Option<&str>) -> Option<&'a Island> {
    let stopped: Vec<&Island> = world
        .islands
        .iter()
        .filter(|i| i.attention == Attention::Stopped)
        .collect();
    if stopped.is_empty() { return None; }

    let start = current
        .and_then(|id| stopped.iter().position(|i| i.id == id))
        .map(|pos| (pos + 1) % stopped.len())
        .unwrap_or(0);
    Some(stopped[start])
}
```

```rust
// src-tauri/src/world/state.rs
use crate::herdr::snapshot::AgentStatus;
use crate::world::attention::Attention;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct IslandAgent {
    pub pane_id: String,
    pub workspace_id: String,
    pub status: AgentStatus,
    pub title: Option<String>,
    pub is_worktree: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Island {
    pub id: String,
    pub name: String,
    pub root: String,
    pub attention: Attention,
    pub agents: Vec<IslandAgent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorldState {
    pub islands: Vec<Island>,
    pub herdr_connected: bool,
    pub herdr_version: String,
    pub protocol_mismatch: bool,
}

impl WorldState {
    pub fn disconnected() -> Self {
        WorldState {
            islands: Vec::new(),
            herdr_connected: false,
            herdr_version: String::new(),
            protocol_mismatch: false,
        }
    }
}
```

Update `src-tauri/src/world/mod.rs`:

```rust
pub mod attention;
pub mod repo;
pub mod state;
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test world::`
Expected: 10 passed (4 from Task 5, 6 here).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(world): island grouping, one attention state, jump ordering"
```

---

### Task 7: Live event subscription and reconnect

**Files:**
- Create: `src-tauri/src/herdr/events.rs`
- Modify: `src-tauri/src/herdr/mod.rs`

**Interfaces:**
- Consumes: `HerdrClient`, `Request`.
- Produces:
  - `const WORLD_EVENTS: [&str; 9]`
  - `fn subscribe_world(client: &HerdrClient) -> Result<()>` — sends one `events.subscribe` with all global event types
  - `fn is_world_changing(event: &Value) -> bool` — true when an event should trigger a resnapshot
  - `async fn run_connection_loop(path: PathBuf, on_state: impl Fn(WorldState)) -> !` — connects, snapshots, subscribes, re-snapshots on events, reconnects with backoff 1s → 2s → 4s → capped at 30s

**Why re-snapshot rather than patch:** `pane.agent_status_changed` cannot be subscribed globally, and Phase 0's data volume is tiny. Fetching a fresh `session.snapshot` on every world-changing event is simpler and cannot drift. Revisit only if profiling says so.

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/herdr/events.rs
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn subscribes_to_every_global_world_event() {
        assert!(WORLD_EVENTS.contains(&"pane.updated"));
        assert!(WORLD_EVENTS.contains(&"pane.created"));
        assert!(WORLD_EVENTS.contains(&"pane.closed"));
        assert!(WORLD_EVENTS.contains(&"pane.exited"));
        assert!(WORLD_EVENTS.contains(&"pane.agent_detected"));
        assert!(WORLD_EVENTS.contains(&"workspace.created"));
        assert!(WORLD_EVENTS.contains(&"workspace.closed"));
        assert!(
            !WORLD_EVENTS.contains(&"pane.agent_status_changed"),
            "that event requires a concrete pane_id and cannot be subscribed globally"
        );
    }

    #[test]
    fn world_changing_events_are_recognised() {
        assert!(is_world_changing(&json!({"event":{"type":"pane.updated"}})));
        assert!(is_world_changing(&json!({"type":"pane.created"})));
    }

    #[test]
    fn unrelated_events_are_ignored() {
        assert!(!is_world_changing(&json!({"event":{"type":"pane.scroll_changed"}})));
        assert!(!is_world_changing(&json!({"result":{"type":"pong"}})));
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd src-tauri && cargo test herdr::events`
Expected: FAIL — `WORLD_EVENTS` does not exist.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/herdr/events.rs
use crate::herdr::client::HerdrClient;
use crate::herdr::protocol::Request;
use crate::herdr::snapshot::fetch_snapshot;
use crate::world::attention::build_world;
use crate::world::repo::{RealGit, RepoResolver};
use crate::world::state::WorldState;
use anyhow::Result;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

/// Global event types — every one of these requires only `type`.
pub const WORLD_EVENTS: [&str; 9] = [
    "pane.created",
    "pane.closed",
    "pane.updated",
    "pane.exited",
    "pane.agent_detected",
    "workspace.created",
    "workspace.closed",
    "workspace.updated",
    "worktree.created",
];

pub async fn subscribe_world(client: &HerdrClient) -> Result<()> {
    let subscriptions: Vec<Value> = WORLD_EVENTS.iter().map(|t| json!({ "type": t })).collect();
    client.send_raw(Request {
        id: "aoa-world-sub".to_string(),
        method: "events.subscribe".to_string(),
        params: json!({ "subscriptions": subscriptions }),
    }).await
}

pub fn is_world_changing(event: &Value) -> bool {
    let event_type = event
        .get("event").and_then(|e| e.get("type"))
        .or_else(|| event.get("type"))
        .and_then(Value::as_str);
    match event_type {
        Some(t) => WORLD_EVENTS.contains(&t),
        None => false,
    }
}

pub async fn run_connection_loop<F>(path: PathBuf, on_state: F) -> !
where
    F: Fn(WorldState) + Send + 'static,
{
    let mut backoff = Duration::from_secs(1);
    let mut resolver = RepoResolver::new(Box::new(RealGit));

    loop {
        match HerdrClient::connect(&path).await {
            Ok(client) => {
                backoff = Duration::from_secs(1);
                let mut events = client.subscribe_events();
                let _ = subscribe_world(&client).await;

                if let Ok(snapshot) = fetch_snapshot(&client).await {
                    on_state(build_world(&snapshot, &mut resolver));
                }

                while let Ok(event) = events.recv().await {
                    if is_world_changing(&event) {
                        if let Ok(snapshot) = fetch_snapshot(&client).await {
                            on_state(build_world(&snapshot, &mut resolver));
                        }
                    }
                }
            }
            Err(_) => {
                on_state(WorldState::disconnected());
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test herdr::events`
Expected: 3 passed.

- [ ] **Step 5: Verify against the real Herdr**

Add and run this ignored test:

```rust
#[tokio::test]
#[ignore = "requires a running herdr"]
async fn receives_at_least_one_real_event() {
    let home = dirs::home_dir().unwrap();
    let path = crate::herdr::socket_path::resolve(
        None, &crate::herdr::socket_path::RealEnv, &home);
    let client = HerdrClient::connect(&path).await.unwrap();
    let mut events = client.subscribe_events();
    subscribe_world(&client).await.unwrap();
    println!("Now switch panes or start an agent in herdr…");
    let event = tokio::time::timeout(Duration::from_secs(30), events.recv())
        .await.expect("no event within 30s").unwrap();
    println!("event: {event}");
}
```

Run: `cd src-tauri && cargo test receives_at_least_one_real_event -- --ignored --nocapture`, then interact with Herdr.
Expected: an event prints. **Record its exact shape** — if the `type` is nested differently than `is_world_changing` assumes, fix the accessor and the test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(herdr): global event subscription with resnapshot and backoff reconnect"
```

---

### Task 8: Tauri wiring — state to the frontend

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `run_connection_loop`, `WorldState`, `next_target`.
- Produces:
  - Tauri managed state `AppState { world: Mutex<WorldState>, last_jump: Mutex<Option<String>> }`
  - Command `get_world() -> WorldState`
  - Event `"world-updated"` emitted to the frontend with the `WorldState` payload

- [ ] **Step 1: Write the failing test**

```rust
// src-tauri/src/commands.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::state::WorldState;

    #[test]
    fn app_state_starts_disconnected() {
        let state = AppState::new();
        let world = state.world.lock().unwrap();
        assert!(!world.herdr_connected);
        assert!(world.islands.is_empty());
    }

    #[test]
    fn replacing_the_world_is_visible_to_readers() {
        let state = AppState::new();
        state.replace_world(WorldState {
            herdr_connected: true,
            herdr_version: "0.8.0".into(),
            protocol_mismatch: false,
            islands: vec![],
        });
        assert!(state.world.lock().unwrap().herdr_connected);
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd src-tauri && cargo test commands`
Expected: FAIL — `AppState` does not exist.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/commands.rs
use crate::world::state::WorldState;
use std::sync::Mutex;

pub struct AppState {
    pub world: Mutex<WorldState>,
    pub last_jump: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            world: Mutex::new(WorldState::disconnected()),
            last_jump: Mutex::new(None),
        }
    }

    pub fn replace_world(&self, next: WorldState) {
        *self.world.lock().unwrap() = next;
    }
}

#[tauri::command]
pub fn get_world(state: tauri::State<'_, AppState>) -> WorldState {
    state.world.lock().unwrap().clone()
}
```

```rust
// src-tauri/src/lib.rs
mod commands;
mod herdr;
mod world;

use commands::AppState;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .setup(|app| {
            let handle = app.handle().clone();
            let home = dirs::home_dir().expect("no home directory");
            let path = herdr::socket_path::resolve(None, &herdr::socket_path::RealEnv, &home);

            tauri::async_runtime::spawn(async move {
                herdr::events::run_connection_loop(path, move |world| {
                    let state = handle.state::<AppState>();
                    state.replace_world(world.clone());
                    let _ = handle.emit("world-updated", world);
                })
                .await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::get_world])
        .run(tauri::generate_context!())
        .expect("error while running Age of Agents");
}
```

- [ ] **Step 4: Run the tests and the app**

Run: `cd src-tauri && cargo test` (expected: all pass), then `npm run tauri dev` (expected: the window opens and does not crash).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire herdr connection loop into Tauri state and events"
```

---

### Task 9: The island view

**Files:**
- Create: `src/world.ts`, `src/useWorld.ts`, `src/components/IslandGrid.tsx`, `src/styles.css`
- Create: `src/useWorld.test.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: the `get_world` command and the `world-updated` event.
- Produces:
  - `type Attention = "stopped" | "working" | "quiet"`
  - `type Island = { id: string; name: string; root: string; attention: Attention; agents: Agent[] }`
  - `type World = { islands: Island[]; herdr_connected: boolean; herdr_version: string; protocol_mismatch: boolean }` — snake_case, because serde serializes the Rust field names verbatim
  - `useWorld(): World`
  - `sortIslands(islands: Island[]): Island[]` — stopped first, then working, then quiet; alphabetical within a group

**Visual note:** Phase 0 is deliberately flat DOM, not 3D. The generator and the Townscaper look arrive in Phase 0.5/1 (spec §10). Keep it calm and legible: a card per island, a clear ❗ marker, no animation on the attention path.

- [ ] **Step 1: Write the failing test**

```ts
// src/useWorld.test.ts
import { describe, expect, it } from "vitest";
import { sortIslands } from "./world";
import type { Island } from "./world";

const island = (name: string, attention: Island["attention"]): Island => ({
  id: `/p/${name}`, name, root: `/p/${name}`, attention, agents: [],
});

describe("sortIslands", () => {
  it("puts stopped islands first, then working, then quiet", () => {
    const sorted = sortIslands([
      island("quiet-one", "quiet"),
      island("working-one", "working"),
      island("stopped-one", "stopped"),
    ]);
    expect(sorted.map((i) => i.name)).toEqual(["stopped-one", "working-one", "quiet-one"]);
  });

  it("sorts alphabetically within a group", () => {
    const sorted = sortIslands([island("beta", "stopped"), island("alpha", "stopped")]);
    expect(sorted.map((i) => i.name)).toEqual(["alpha", "beta"]);
  });

  it("does not mutate its input", () => {
    const input = [island("b", "quiet"), island("a", "stopped")];
    sortIslands(input);
    expect(input.map((i) => i.name)).toEqual(["b", "a"]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — cannot resolve `./world`.

- [ ] **Step 3: Implement the types and sorting**

```ts
// src/world.ts
export type Attention = "stopped" | "working" | "quiet";
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type Agent = {
  pane_id: string;
  workspace_id: string;
  status: AgentStatus;
  title: string | null;
  is_worktree: boolean;
};

export type Island = {
  id: string;
  name: string;
  root: string;
  attention: Attention;
  agents: Agent[];
};

export type World = {
  islands: Island[];
  herdr_connected: boolean;
  herdr_version: string;
  protocol_mismatch: boolean;
};

const RANK: Record<Attention, number> = { stopped: 0, working: 1, quiet: 2 };

export function sortIslands(islands: Island[]): Island[] {
  return [...islands].sort(
    (a, b) => RANK[a.attention] - RANK[b.attention] || a.name.localeCompare(b.name),
  );
}

export const EMPTY_WORLD: World = {
  islands: [], herdr_connected: false, herdr_version: "", protocol_mismatch: false,
};
```

- [ ] **Step 4: Run the test**

Run: `npm test`
Expected: 3 passed.

- [ ] **Step 5: Implement the hook and the view**

```ts
// src/useWorld.ts
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EMPTY_WORLD, type World } from "./world";

export function useWorld(): World {
  const [world, setWorld] = useState<World>(EMPTY_WORLD);

  useEffect(() => {
    invoke<World>("get_world").then(setWorld).catch(() => setWorld(EMPTY_WORLD));
    const unlisten = listen<World>("world-updated", (event) => setWorld(event.payload));
    return () => { unlisten.then((f) => f()); };
  }, []);

  return world;
}
```

```tsx
// src/components/IslandGrid.tsx
import { sortIslands, type Island } from "../world";

const MARKER: Record<Island["attention"], string> = {
  stopped: "❗",
  working: "⚒",
  quiet: "·",
};

export function IslandGrid({ islands }: { islands: Island[] }) {
  if (islands.length === 0) {
    return <p className="empty">No agents in a git repository yet.</p>;
  }
  return (
    <ul className="islands">
      {sortIslands(islands).map((island) => (
        <li key={island.id} className={`island island--${island.attention}`}>
          <span className="island__marker">{MARKER[island.attention]}</span>
          <span className="island__name">{island.name}</span>
          <span className="island__agents">
            {island.agents.length} agent{island.agents.length === 1 ? "" : "s"}
          </span>
        </li>
      ))}
    </ul>
  );
}
```

```tsx
// src/App.tsx
import { IslandGrid } from "./components/IslandGrid";
import { useWorld } from "./useWorld";
import "./styles.css";

export default function App() {
  const world = useWorld();
  return (
    <main className="app">
      <header className="app__header">
        <h1>Age of Agents</h1>
        <span className={world.herdr_connected ? "status status--ok" : "status status--off"}>
          {world.herdr_connected ? `herdr ${world.herdr_version}` : "herdr not running"}
        </span>
      </header>
      {world.protocol_mismatch && (
        <p className="warning">
          This Herdr speaks a different protocol than expected. Some state may be wrong.
        </p>
      )}
      <IslandGrid islands={world.islands} />
    </main>
  );
}
```

```css
/* src/styles.css */
:root { color-scheme: dark; }
body { margin: 0; font: 14px/1.5 -apple-system, system-ui, sans-serif; background: #12161c; color: #e6e9ef; }
.app { padding: 20px; }
.app__header { display: flex; align-items: baseline; gap: 12px; }
.app__header h1 { font-size: 16px; font-weight: 600; margin: 0 0 16px; }
.status { font-size: 12px; opacity: .7; }
.status--off { color: #e0a44b; }
.warning { color: #e0a44b; font-size: 12px; }
.islands { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.island { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 10px; background: #1a1f27; border-left: 3px solid transparent; }
.island--stopped { border-left-color: #e0a44b; background: #241f1a; }
.island--working { border-left-color: #4b93e0; }
.island__name { font-weight: 600; }
.island__agents { margin-left: auto; opacity: .55; font-size: 12px; }
.empty { opacity: .6; }
```

- [ ] **Step 6: Verify in the running app**

Run: `npm run tauri dev`, then in Herdr start an agent in one of your project directories.
Expected: an island appears for that repo and its marker changes as the agent works and stops.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ui): island list with attention ordering and connection status"
```

---

### Task 10: Jump to the next stopped agent

**Files:**
- Create: `src-tauri/src/platform/mod.rs`, `src-tauri/src/platform/macos.rs`
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/App.tsx`
- Create: `src/useHotkey.ts`

**Interfaces:**
- Consumes: `next_target`, `HerdrClient::call`, `AppState.last_jump`.
- Produces:
  - Command `jump_to_next() -> Result<Option<String>, String>` returning the island name jumped to
  - `platform::activate_terminal(app_name: &str) -> Result<()>`

**Behavior:** pick the next `Stopped` island (cycling), call `agent.focus` with its first stopped agent's `pane_id` as `target`, then raise the terminal app. Record the island id in `last_jump` so the next press advances. Instant — no animation (principle 2).

- [ ] **Step 1: Write the failing test**

```rust
// src-tauri/src/commands.rs — inside mod tests
#[test]
fn jump_target_picks_the_first_stopped_agent_in_the_island() {
    use crate::herdr::snapshot::AgentStatus;
    use crate::world::attention::Attention;
    use crate::world::state::{Island, IslandAgent};

    let island = Island {
        id: "/p/api".into(), name: "api".into(), root: "/p/api".into(),
        attention: Attention::Stopped,
        agents: vec![
            IslandAgent { pane_id: "w1:p1".into(), workspace_id: "w1".into(),
                          status: AgentStatus::Working, title: None, is_worktree: false },
            IslandAgent { pane_id: "w1:p2".into(), workspace_id: "w1".into(),
                          status: AgentStatus::Blocked, title: None, is_worktree: false },
        ],
    };
    assert_eq!(jump_target(&island), Some("w1:p2".to_string()));
}

#[test]
fn jump_target_falls_back_to_the_first_agent() {
    use crate::herdr::snapshot::AgentStatus;
    use crate::world::attention::Attention;
    use crate::world::state::{Island, IslandAgent};

    let island = Island {
        id: "/p/api".into(), name: "api".into(), root: "/p/api".into(),
        attention: Attention::Working,
        agents: vec![IslandAgent { pane_id: "w1:p1".into(), workspace_id: "w1".into(),
                     status: AgentStatus::Working, title: None, is_worktree: false }],
    };
    assert_eq!(jump_target(&island), Some("w1:p1".to_string()));
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd src-tauri && cargo test commands`
Expected: FAIL — `jump_target` does not exist.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/commands.rs — add
use crate::herdr::snapshot::AgentStatus;
use crate::world::attention::next_target;
use crate::world::state::Island;

pub fn jump_target(island: &Island) -> Option<String> {
    island
        .agents
        .iter()
        .find(|a| matches!(a.status, AgentStatus::Blocked | AgentStatus::Done))
        .or_else(|| island.agents.first())
        .map(|a| a.pane_id.clone())
}
```

```rust
// src-tauri/src/platform/macos.rs
use anyhow::{anyhow, Result};
use std::process::Command;

/// Raise the terminal application that hosts herdr.
pub fn activate_terminal(app_name: &str) -> Result<()> {
    let status = Command::new("open").arg("-a").arg(app_name).status()?;
    if status.success() { Ok(()) } else { Err(anyhow!("could not activate {app_name}")) }
}
```

```rust
// src-tauri/src/platform/mod.rs
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub use macos::activate_terminal;

#[cfg(not(target_os = "macos"))]
pub fn activate_terminal(_app_name: &str) -> anyhow::Result<()> { Ok(()) }
```

Add the command (it needs its own short-lived client; the connection loop owns the long-lived one):

```rust
// src-tauri/src/commands.rs — add
#[tauri::command]
pub async fn jump_to_next(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let (target_pane, island_id, island_name) = {
        let world = state.world.lock().unwrap();
        let last = state.last_jump.lock().unwrap().clone();
        match next_target(&world, last.as_deref()) {
            Some(island) => match jump_target(island) {
                Some(pane) => (pane, island.id.clone(), island.name.clone()),
                None => return Ok(None),
            },
            None => return Ok(None),
        }
    };

    let home = dirs::home_dir().ok_or("no home directory")?;
    let path = crate::herdr::socket_path::resolve(
        None, &crate::herdr::socket_path::RealEnv, &home);
    let client = crate::herdr::client::HerdrClient::connect(&path)
        .await.map_err(|e| e.to_string())?;
    client
        .call("agent.focus", serde_json::json!({ "target": target_pane }))
        .await
        .map_err(|e| e.to_string())?;

    let _ = crate::platform::activate_terminal("Terminal");
    *state.last_jump.lock().unwrap() = Some(island_id);
    Ok(Some(island_name))
}
```

Register it in `lib.rs`: `tauri::generate_handler![commands::get_world, commands::jump_to_next]`, and add `mod platform;`.

- [ ] **Step 4: Add the hotkey in the frontend**

```ts
// src/useHotkey.ts
import { useEffect } from "react";

export function useHotkey(key: string, handler: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === key && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, handler]);
}
```

In `src/App.tsx`, inside the component:

```tsx
import { invoke } from "@tauri-apps/api/core";
import { useHotkey } from "./useHotkey";

useHotkey(" ", () => { void invoke("jump_to_next"); });
```

- [ ] **Step 5: Verify by hand**

Run `npm run tauri dev`, start an agent in Herdr, wait until it stops, focus the Age of Agents window and press space.
Expected: Herdr focuses that agent's pane and the terminal app comes to the front. **If the terminal app is not Apple Terminal, note the real name — Task 12 makes it configurable.**

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: jump to the next stopped agent and raise the terminal"
```

---

### Task 11: Detection telemetry (measures spec risk 9.2)

**Files:**
- Create: `src-tauri/src/telemetry.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/herdr/events.rs`

**Interfaces:**
- Consumes: `WorldState`.
- Produces:
  - `struct TransitionLog::new(path: PathBuf) -> TransitionLog`
  - `TransitionLog::record(&mut self, world: &WorldState)` — appends one JSONL line per changed pane status
  - Log file: `~/.age-of-agents/transitions.jsonl`, local only, never uploaded

**Purpose:** Phase 0's second deliverable is evidence. After a week we can answer: how often did an agent stop without Herdr reporting `blocked` or `done`? That number decides how much of Phase 1 can lean on detection.

- [ ] **Step 1: Write the failing test**

```rust
// src-tauri/src/telemetry.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::snapshot::AgentStatus;
    use crate::world::attention::Attention;
    use crate::world::state::{Island, IslandAgent, WorldState};

    fn world(status: AgentStatus) -> WorldState {
        WorldState {
            herdr_connected: true, herdr_version: "0.8.0".into(), protocol_mismatch: false,
            islands: vec![Island {
                id: "/p/api".into(), name: "api".into(), root: "/p/api".into(),
                attention: Attention::from(status),
                agents: vec![IslandAgent {
                    pane_id: "w1:p1".into(), workspace_id: "w1".into(),
                    status, title: None, is_worktree: false,
                }],
            }],
        }
    }

    #[test]
    fn records_one_line_per_status_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transitions.jsonl");
        let mut log = TransitionLog::new(path.clone());

        log.record(&world(AgentStatus::Working));
        log.record(&world(AgentStatus::Working)); // unchanged — no line
        log.record(&world(AgentStatus::Blocked));

        let contents = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2, "only changes are recorded");
        assert!(lines[0].contains("\"to\":\"working\""));
        assert!(lines[1].contains("\"to\":\"blocked\""));
        assert!(lines[1].contains("\"from\":\"working\""));
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd src-tauri && cargo test telemetry`
Expected: FAIL — `TransitionLog` does not exist.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/telemetry.rs
use crate::herdr::snapshot::AgentStatus;
use crate::world::state::WorldState;
use serde_json::json;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

pub struct TransitionLog {
    path: PathBuf,
    last: HashMap<String, AgentStatus>,
}

impl TransitionLog {
    pub fn new(path: PathBuf) -> Self {
        TransitionLog { path, last: HashMap::new() }
    }

    pub fn record(&mut self, world: &WorldState) {
        let mut lines: Vec<String> = Vec::new();

        for island in &world.islands {
            for agent in &island.agents {
                let previous = self.last.get(&agent.pane_id).copied();
                if previous == Some(agent.status) { continue; }
                lines.push(json!({
                    "at": chrono::Utc::now().to_rfc3339(),
                    "pane_id": agent.pane_id,
                    "repo": island.name,
                    "from": previous.map(status_name),
                    "to": status_name(agent.status),
                }).to_string());
                self.last.insert(agent.pane_id.clone(), agent.status);
            }
        }

        if lines.is_empty() { return; }
        if let Some(parent) = self.path.parent() { let _ = std::fs::create_dir_all(parent); }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&self.path) {
            for line in lines { let _ = writeln!(file, "{line}"); }
        }
    }
}

fn status_name(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Idle => "idle",
        AgentStatus::Working => "working",
        AgentStatus::Blocked => "blocked",
        AgentStatus::Done => "done",
        AgentStatus::Unknown => "unknown",
    }
}
```

Add `chrono = "0.4"` to `[dependencies]`.

Wire it into the connection loop in `lib.rs`'s setup closure by wrapping `on_state`:

```rust
let mut log = crate::telemetry::TransitionLog::new(
    home.join(".age-of-agents/transitions.jsonl"));
// inside the on_state closure, before emitting:
log.record(&world);
```

Note: `on_state` is `Fn`, so wrap the log in `std::sync::Mutex` to mutate it from the closure.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(telemetry): local JSONL log of agent status transitions"
```

---

### Task 12: Config, degraded mode, and notification on stop

**Files:**
- Create: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, `src/App.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `struct Config { terminal_app: String, notify_on_stop: bool }` with `Default` = `{ terminal_app: "Terminal", notify_on_stop: true }`
  - `Config::load(path: &Path) -> Config` (missing or malformed file yields defaults)
  - `Config::save(&self, path: &Path) -> Result<()>`
  - Config file: `~/.age-of-agents/config.json`

- [ ] **Step 1: Write the failing tests**

```rust
// src-tauri/src/config.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::load(&dir.path().join("nope.json"));
        assert_eq!(config.terminal_app, "Terminal");
        assert!(config.notify_on_stop);
    }

    #[test]
    fn malformed_file_yields_defaults_without_panicking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(Config::load(&path).terminal_app, "Terminal");
    }

    #[test]
    fn saved_config_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let config = Config { terminal_app: "Ghostty".into(), notify_on_stop: false };
        config.save(&path).unwrap();
        let loaded = Config::load(&path);
        assert_eq!(loaded.terminal_app, "Ghostty");
        assert!(!loaded.notify_on_stop);
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd src-tauri && cargo test config`
Expected: FAIL — `Config` does not exist.

- [ ] **Step 3: Implement**

```rust
// src-tauri/src/config.rs
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_terminal")]
    pub terminal_app: String,
    #[serde(default = "default_true")]
    pub notify_on_stop: bool,
}

fn default_terminal() -> String { "Terminal".to_string() }
fn default_true() -> bool { true }

impl Default for Config {
    fn default() -> Self {
        Config { terminal_app: default_terminal(), notify_on_stop: default_true() }
    }
}

impl Config {
    pub fn load(path: &Path) -> Config {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}
```

- [ ] **Step 4: Use the configured terminal in the jump command**

In `jump_to_next`, replace the hardcoded name:

```rust
let config = crate::config::Config::load(&home.join(".age-of-agents/config.json"));
let _ = crate::platform::activate_terminal(&config.terminal_app);
```

- [ ] **Step 5: Notify when an island becomes stopped**

In the `on_state` closure in `lib.rs`, compare against the previous world and, for each island that newly became `Stopped`, emit a native notification when `config.notify_on_stop` is true:

```rust
// add to Cargo.toml: tauri-plugin-notification = "2"
// and in the builder: .plugin(tauri_plugin_notification::init())
use tauri_plugin_notification::NotificationExt;

// inside on_state, for each newly stopped island:
let _ = handle.notification().builder()
    .title(format!("{} needs you", island.name))
    .body("An agent has stopped.")
    .show();
```

Track previously-stopped island ids in the same `Mutex` used for the telemetry log so a notification fires once per transition, not on every resnapshot.

- [ ] **Step 6: Degraded mode in the UI**

`App.tsx` already renders "herdr not running" when disconnected. Add the actionable hint:

```tsx
{!world.herdr_connected && (
  <p className="empty">
    Start herdr, then this window will fill in on its own.
  </p>
)}
```

- [ ] **Step 7: Verify**

Run: `cd src-tauri && cargo test` (all pass), then `npm run tauri dev`, quit Herdr and confirm the window says "herdr not running" without crashing, then restart Herdr and confirm it reconnects on its own within 30 seconds.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: config file, terminal app selection, stop notifications, degraded mode"
```

---

## Phase 0 exit criteria

Phase 0 is done when all of the following are true. These are the questions the phase exists to answer (spec §9, §12):

1. The window lists one island per repo with live status, updating without polling.
2. Pressing the hotkey focuses the right pane in Herdr and raises the terminal, instantly.
3. Herdr can be stopped and restarted without restarting the app.
4. `~/.age-of-agents/transitions.jsonl` has a week of real data.
5. **The judgment call:** after a week of daily use, does the user reach for this window instead of cycling tabs? And how often did an agent stop without Herdr saying `blocked` or `done`?

If answer 5 is "no", the design changes before Phase 0.5 — that's what this phase is for.
