use crate::herdr::protocol::{ProtocolError, Request, Response};
use anyhow::{anyhow, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{oneshot, Mutex};

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Response>>>>;

pub struct HerdrClient {
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    pending: Pending,
    counter: AtomicU64,
    // `None` once the reader has observed the connection close. Wrapped so
    // the client can actually drop its own sender on disconnect — see the
    // reader task below — rather than holding one for the client's whole
    // lifetime, which would keep the broadcast channel open forever.
    events: StdMutex<Option<tokio::sync::broadcast::Sender<Value>>>,
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
            events: StdMutex::new(Some(events_tx.clone())),
        });

        let reader_client = Arc::clone(&client);
        tokio::spawn(async move {
            let mut lines = BufReader::new(read_half).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let value: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let has_error = value.get("error").is_some();
                let has_result = value.get("result").is_some();
                let is_reply = has_error || has_result;

                if is_reply && !id.is_empty() {
                    if let Some(tx) = reader_client.pending.lock().await.remove(&id) {
                        if let Ok(resp) = serde_json::from_value::<Response>(value) {
                            let _ = tx.send(resp);
                        }
                    } else {
                        // This is the one-time `subscription_started`
                        // acknowledgment for the `events.subscribe` request
                        // itself, which Herdr replies to using that
                        // request's own id. Fix-round finding 6: this is
                        // NOT true of ongoing event deliveries on the
                        // subscription — verified against real Herdr 0.8.0,
                        // those carry no `id` field at all and reach the
                        // bus via the untyped fallback branch below instead.
                        if let Some(sender) = reader_client.events.lock().unwrap().as_ref() {
                            let _ = sender.send(value);
                        }
                    }
                } else if is_reply && has_error {
                    // CRITICAL 1 fix: real Herdr replies to a request it
                    // couldn't deserialize/validate (unknown method, bad or
                    // missing params) with an EMPTY id, so it can't be
                    // correlated to any single pending call. Rather than
                    // drop it into the event stream (which previously left
                    // the real caller hanging for the full 10s timeout with
                    // no useful error), fail every in-flight call with it.
                    // This is deliberately coarse: a genuine error message
                    // delivered to the wrong (or every) waiter beats a
                    // silent 10s timeout that hides the real diagnosis, and
                    // an empty-id error is expected to be rare (Herdr sends
                    // it when the id itself couldn't be recovered).
                    if let Ok(resp) = serde_json::from_value::<Response>(value) {
                        let mut map = reader_client.pending.lock().await;
                        for (_, tx) in map.drain() {
                            let _ = tx.send(resp.clone());
                        }
                    }
                } else if let Some(sender) = reader_client.events.lock().unwrap().as_ref() {
                    let _ = sender.send(value);
                }
            }

            // IMPORTANT 5 fix: the socket closed (EOF or a read error).
            // Don't let in-flight callers sit out the full 10s timeout —
            // fail them immediately with a clear "connection closed" error.
            {
                let mut map = reader_client.pending.lock().await;
                for (_, tx) in map.drain() {
                    let _ = tx.send(Response {
                        result: None,
                        error: Some(ProtocolError {
                            code: "connection_closed".to_string(),
                            message: "herdr connection closed".to_string(),
                        }),
                    });
                }
            }

            // Drop every sender handle this client can reach — our own
            // `events_tx` (about to go out of scope) and the struct's
            // stored clone — so the broadcast channel actually closes.
            // Any receiver from `subscribe_events()` then gets
            // `Err(RecvError::Closed)` instead of awaiting forever.
            drop(events_tx);
            reader_client.events.lock().unwrap().take();
        });

        Ok(client)
    }

    /// Subscribe to out-of-band event deliveries (subscription pushes that
    /// aren't correlated to a pending `call()`).
    ///
    /// The underlying channel has a fixed capacity (256). If a subscriber
    /// falls behind, `recv()` returns `Err(Lagged(n))` rather than
    /// blocking or growing without bound. Callers MUST treat `Lagged` as
    /// "some events were dropped, resync/refetch state" and keep calling
    /// `recv()` — not as a fatal condition that ends the loop. Only
    /// `Err(Closed)` means the connection is gone for good.
    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<Value> {
        let guard = self.events.lock().unwrap();
        match guard.as_ref() {
            Some(tx) => tx.subscribe(),
            None => {
                // Connection already closed before this call: hand back a
                // receiver on a channel with no live sender, so `.recv()`
                // returns `Err(Closed)` immediately instead of hanging.
                let (tx, rx) = tokio::sync::broadcast::channel(1);
                drop(tx);
                rx
            }
        }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = format!("aoa-{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        // IMPORTANT 3 fix: bound the whole exchange — not just the reply
        // wait — in one timeout. Previously only `rx` was bounded, so a
        // call stuck acquiring the writer lock or in `write_all` (e.g. a
        // wedged socket) could hang forever and freeze the caller's loop.
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let request = Request { id: id.clone(), method: method.to_string(), params };
            let mut bytes = serde_json::to_vec(&request)?;
            bytes.push(b'\n');
            self.writer.lock().await.write_all(&bytes).await?;
            let response = rx.await.map_err(|_| {
                anyhow!("herdr connection closed while waiting for `{method}` reply")
            })?;
            Ok::<Response, anyhow::Error>(response)
        })
        .await;

        // IMPORTANT 4 fix: guarantee `pending` never leaks an entry,
        // whatever happened above. On timeout, a serialize/write failure,
        // or a closed channel, the reader never got to remove our id
        // itself. This is a harmless no-op on the happy path, where the
        // reader already removed it before we get here.
        self.pending.lock().await.remove(&id);

        let response = match outcome {
            Ok(Ok(response)) => response,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(anyhow!("herdr call `{method}` timed out")),
        };

        if let Some(err) = response.error {
            return Err(anyhow!("herdr error {}: {}", err.code, err.message));
        }
        response
            .result
            .ok_or_else(|| anyhow!("herdr returned no result for `{method}`"))
    }

    /// Mint an id for a subscription-style request sent via `send_raw`.
    ///
    /// IMPORTANT 7 fix: subscription ids live in a distinct `aoa-sub-N`
    /// namespace, separate from `call()`'s `aoa-N` ids, even though both
    /// are minted from the same shared counter. Herdr replies to the
    /// `events.subscribe` request itself with a one-time
    /// `subscription_started` acknowledgment that reuses this id — but
    /// (fix-round finding 6, corrected from this comment's earlier claim)
    /// that is the ONLY delivery that does: ongoing event pushes on the
    /// subscription carry no `id` field at all, verified against real
    /// Herdr 0.8.0. If a subscription id could collide with a later
    /// `call()` id, that one ack could be wrongly handed to an unrelated
    /// call as its reply, while the call's real reply leaked into the
    /// event stream. Distinct prefixes make that collision structurally
    /// impossible, and the separate id also lets a caller await its own
    /// subscription's ack (see `events::subscribe_world`).
    pub fn next_subscription_id(&self) -> String {
        format!("aoa-sub-{}", self.counter.fetch_add(1, Ordering::Relaxed))
    }

    pub async fn send_raw(&self, request: Request) -> Result<()> {
        let mut bytes = serde_json::to_vec(&request)?;
        bytes.push(b'\n');
        self.writer.lock().await.write_all(&bytes).await?;
        Ok(())
    }
}

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
        // The fake replies to an error with an EMPTY id, matching real
        // Herdr (CRITICAL 2). The client must still surface the code and
        // message to the one in-flight caller, rather than timing out.
        let fake = FakeHerdr::start(|_req| {
            Err(("not_found".to_string(), "pane not found".to_string()))
        })
        .await;

        let client = HerdrClient::connect(fake.path()).await.unwrap();
        let err = client.call("pane.get", json!({"pane_id": "w9:p9"})).await.unwrap_err();

        assert!(err.to_string().contains("not_found"));
        assert!(err.to_string().contains("pane not found"));
    }

    #[tokio::test]
    async fn concurrent_calls_correlate_replies_out_of_order() {
        // IMPORTANT 8: exercise real id-based correlation. Two calls are
        // in flight at once; the fake deliberately answers them in the
        // opposite order they were issued (via `_test_delay_ms`). If the
        // client used a fixed id, ignored ids, or matched by arrival
        // order instead of by id, this would fail.
        let fake = FakeHerdr::start(|req| match req.method.as_str() {
            "slow" => Ok(json!({ "which": "slow" })),
            "fast" => Ok(json!({ "which": "fast" })),
            other => panic!("unexpected method {other}"),
        })
        .await;

        let client = HerdrClient::connect(fake.path()).await.unwrap();

        let slow = client.call("slow", json!({ "_test_delay_ms": 50 }));
        let fast = client.call("fast", json!({ "_test_delay_ms": 0 }));
        let (slow_result, fast_result) = tokio::join!(slow, fast);

        assert_eq!(slow_result.unwrap()["which"], "slow");
        assert_eq!(fast_result.unwrap()["which"], "fast");
    }

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

    #[tokio::test]
    #[ignore = "requires a running herdr"]
    async fn real_herdr_surfaces_an_unknown_method_error_quickly() {
        // Regression check for CRITICAL 1 against the live daemon: an
        // unknown method should fail fast with a real error, not hang for
        // the full 10s timeout (which is what happened before the fix,
        // since real Herdr's error reply for this case carries an empty
        // id that didn't match any pending call).
        let home = dirs::home_dir().unwrap();
        let path = crate::herdr::socket_path::resolve(
            None, &crate::herdr::socket_path::RealEnv, &home);
        let client = HerdrClient::connect(&path).await.unwrap();

        let start = std::time::Instant::now();
        let err = client
            .call("definitely_not_a_real_method", serde_json::json!({}))
            .await
            .unwrap_err();
        let elapsed = start.elapsed();

        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "expected a fast error, took {elapsed:?} instead (looks like the 10s timeout bug)"
        );
        // The exact code/message text is server-defined; we only assert we
        // got a real error path at all, not a timeout error.
        assert!(!err.to_string().contains("timed out"), "got: {err}");
    }
}
