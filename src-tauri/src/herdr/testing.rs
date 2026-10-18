use crate::herdr::protocol::Request;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixListener;
use tokio::sync::Mutex;

pub struct FakeHerdr {
    path: PathBuf,
    _dir: tempfile::TempDir,
    // Only populated (and only meaningful) for `start_one_request_per_connection`:
    // the write half of the most recently accepted `events.subscribe`
    // connection, parked here so `push_event` can stream a delivery on it,
    // tagged with the generation number of that subscription.
    //
    // FIX-ROUND 4: the generation tag exists because the app now tears down
    // its subscription connection and opens a NEW one whenever the known
    // pane set changes, so two subscription connections briefly overlap.
    // Without a tag, the OLD connection's cleanup (which runs when its
    // reader finally sees EOF, possibly AFTER the new one has already
    // parked itself) would clear the NEW connection's writer and make
    // `push_event` panic or silently push into the void. A connection now
    // only clears the slot if the slot still holds its own generation.
    subscription_writer: Arc<Mutex<Option<(u64, OwnedWriteHalf)>>>,
    subscription_generation: Arc<AtomicU64>,
}

impl FakeHerdr {
    pub fn path(&self) -> &Path { &self.path }

    /// How many `events.subscribe` connections this fake has parked so far
    /// (0 before the first one). A test that re-subscribes can wait for this
    /// to reach the generation it expects before calling `push_event`, so
    /// the delivery lands on the current subscription rather than on one
    /// that is about to be torn down.
    pub fn subscription_generation(&self) -> u64 {
        self.subscription_generation.load(Ordering::SeqCst)
    }

    /// Handler returns Ok(result) or Err((code, message)).
    ///
    /// Error replies are sent with an EMPTY `id`, matching real Herdr
    /// (verified live: a request it can't deserialize/validate gets back
    /// `{"id":"","error":{...}}`, not the request's own id) — see
    /// `client.rs`'s reader for how the client handles that.
    ///
    /// Each reply is written from its own spawned task, after waiting an
    /// optional `_test_delay_ms` found in the request's `params`. This
    /// lets a test deliberately produce out-of-order replies (answer a
    /// later request before an earlier one) to verify the client
    /// correlates replies by id rather than by arrival order.
    pub async fn start<F>(handler: F) -> FakeHerdr
    where
        F: Fn(&RequestView) -> Result<Value, (String, String)> + Send + Sync + 'static,
    {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("herdr.sock");
        let listener = UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (read_half, write_half) = stream.into_split();
                let write_half = Arc::new(Mutex::new(write_half));
                let mut lines = BufReader::new(read_half).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let parsed: Value = serde_json::from_str(&line).unwrap();
                    let view = RequestView {
                        id: parsed["id"].as_str().unwrap_or_default().to_string(),
                        method: parsed["method"].as_str().unwrap_or_default().to_string(),
                        params: parsed["params"].clone(),
                    };
                    let delay_ms = parsed["params"]["_test_delay_ms"].as_u64().unwrap_or(0);
                    let reply = match handler(&view) {
                        Ok(result) => json!({ "id": view.id, "result": result }),
                        Err((code, message)) => {
                            // Empty id: matches real Herdr's error framing.
                            json!({ "id": "", "error": { "code": code, "message": message } })
                        }
                    };
                    let write_half = write_half.clone();
                    tokio::spawn(async move {
                        if delay_ms > 0 {
                            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        }
                        let mut bytes = serde_json::to_vec(&reply).unwrap();
                        bytes.push(b'\n');
                        let _ = write_half.lock().await.write_all(&bytes).await;
                    });
                }
            }
        });
        FakeHerdr {
            path,
            _dir: dir,
            subscription_writer: Arc::new(Mutex::new(None)),
            subscription_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Models real Herdr's ACTUAL connection semantics (fix-round-3
    /// architecture finding, verified via raw socket probes against Herdr
    /// 0.8.0): a connection serves EXACTLY ONE request, and Herdr then
    /// closes it — a second request on the same connection reads EOF and
    /// the following write fails with a broken pipe. The sole exception is
    /// `events.subscribe`, whose connection Herdr keeps open indefinitely
    /// to stream deliveries; use `push_event` to send one on it.
    ///
    /// `start` above is deliberately more forgiving (many requests per
    /// connection) — that permissiveness is exactly what let a
    /// one-request-per-connection design bug ship with a fully green
    /// suite. Any test that cares about connection-reuse semantics (i.e.
    /// most tests of `events::run_connection_loop` and its helpers) should
    /// use this constructor instead.
    pub async fn start_one_request_per_connection<F>(handler: F) -> FakeHerdr
    where
        F: Fn(&RequestView) -> Result<Value, (String, String)> + Send + Sync + 'static,
    {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("herdr.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let handler = Arc::new(handler);
        let subscription_writer: Arc<Mutex<Option<(u64, OwnedWriteHalf)>>> =
            Arc::new(Mutex::new(None));
        let subscription_generation = Arc::new(AtomicU64::new(0));
        let subscription_writer_for_task = subscription_writer.clone();
        let subscription_generation_for_task = subscription_generation.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let handler = handler.clone();
                let subscription_writer = subscription_writer_for_task.clone();
                let subscription_generation = subscription_generation_for_task.clone();
                tokio::spawn(async move {
                    let (read_half, mut write_half) = stream.into_split();
                    let mut lines = BufReader::new(read_half).lines();
                    let Ok(Some(line)) = lines.next_line().await else { return };
                    let parsed: Value = serde_json::from_str(&line).unwrap();
                    let view = RequestView {
                        id: parsed["id"].as_str().unwrap_or_default().to_string(),
                        method: parsed["method"].as_str().unwrap_or_default().to_string(),
                        params: parsed["params"].clone(),
                    };
                    let is_subscribe = view.method == "events.subscribe";
                    let handled = handler(&view);
                    // FIX-ROUND 4: a REJECTED subscribe is not just "an
                    // error reply" — probed live against Herdr 0.8.0, a
                    // subscription list with one bad per-pane entry comes
                    // back under an id DERIVED from the request's
                    // (`aoa-sub-0:sub:1:probe`, naming the offending entry)
                    // rather than under the request id or the empty id used
                    // for malformed requests, and Herdr then CLOSES the
                    // connection instead of streaming. Model both, or a test
                    // of the rejection path exercises neither the real id
                    // shape nor the real teardown.
                    let rejected_subscribe = is_subscribe && handled.is_err();
                    let reply = match handled {
                        Ok(result) => json!({ "id": view.id, "result": result }),
                        Err((code, message)) if rejected_subscribe => json!({
                            "id": format!("{}:sub:1", view.id),
                            "error": { "code": code, "message": message }
                        }),
                        Err((code, message)) => {
                            json!({ "id": "", "error": { "code": code, "message": message } })
                        }
                    };
                    let mut bytes = serde_json::to_vec(&reply).unwrap();
                    bytes.push(b'\n');
                    if write_half.write_all(&bytes).await.is_err() {
                        return;
                    }

                    if is_subscribe && !rejected_subscribe {
                        // Real Herdr keeps this connection open indefinitely.
                        // Park the write half for `push_event`, then idle:
                        // a correctly-behaving client never sends a second
                        // request on its subscription connection, so
                        // reaching EOF here just means the test dropped it.
                        let generation = subscription_generation.fetch_add(1, Ordering::SeqCst) + 1;
                        *subscription_writer.lock().await = Some((generation, write_half));
                        while let Ok(Some(_)) = lines.next_line().await {}
                        // Only clear the slot if it still holds OUR
                        // generation — a newer subscription may already have
                        // replaced it (see the field's doc comment).
                        let mut guard = subscription_writer.lock().await;
                        if guard.as_ref().map(|(g, _)| *g) == Some(generation) {
                            guard.take();
                        }
                    }
                    // Non-subscribe: falling off the end here drops both
                    // halves, closing the connection — the "exactly one
                    // request per connection" behavior this constructor
                    // exists to model.
                });
            }
        });
        FakeHerdr { path, _dir: dir, subscription_writer, subscription_generation }
    }

    /// Pushes a raw JSON delivery on the most recently accepted
    /// `events.subscribe` connection opened against a fake started with
    /// `start_one_request_per_connection`.
    ///
    /// Panics if no subscription connection is currently parked — a test
    /// using this must complete a subscribe (and its ack) first.
    pub async fn push_event(&self, value: Value) {
        let mut guard = self.subscription_writer.lock().await;
        let (_generation, writer) = guard
            .as_mut()
            .expect("push_event: no active subscription connection to push on");
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        writer.write_all(&bytes).await.unwrap();
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
