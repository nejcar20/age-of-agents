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

/// One reply from herdr.
///
/// FINAL REVIEW minor: there is deliberately no `id` field. Replies are
/// correlated to their pending `call()` in `HerdrClient`'s reader task,
/// which reads the id straight off the untyped `serde_json::Value` (it has
/// to: an id that fails to deserialize still needs routing, and an EMPTY id
/// means "fail every in-flight call"). By the time a `Response` is built the
/// routing decision is already made, so a typed `id` here was only ever
/// written and never read — clippy said so, and it was right.
#[derive(Debug, Clone, Deserialize)]
pub struct Response {
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<ProtocolError>,
}
