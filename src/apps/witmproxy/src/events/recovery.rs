//! Bounded duplication of event bodies, so a failed guest can be recovered from.
//!
//! # Why this is not free
//!
//! An event's body is a *linear* resource: a stream is readable exactly once,
//! which is why `wasi:http` models taking it as a move. Once a guest has read
//! part of a body, the host no longer holds what it handed over, so continuing
//! the chain would forward something neither peer asked for. That is why
//! [`RecoveryPolicy::FailClosed`] is the default.
//!
//! [`RecoveryPolicy::FailOpen`] buys the ability to continue by having the host
//! keep a copy of whatever the guest actually consumed. The copy is built
//! lazily: bytes are recorded as the guest pulls them, so a plugin that only
//! inspects headers costs nothing, and a plugin that streams a gigabyte is
//! stopped at `max_event_recovery_buffer_bytes` rather than being allowed to
//! turn recovery into a memory-exhaustion vector.
//!
//! # What recovery does and does not restore
//!
//! It restores the *event payload*. It does not undo side effects: a plugin
//! that wrote to local storage or emitted log lines before failing has still
//! done so. Recovery means "the next plugin sees what this one was given", not
//! "nothing happened".
//!
//! [`RecoveryPolicy::FailClosed`]: crate::plugins::limits::RecoveryPolicy::FailClosed
//! [`RecoveryPolicy::FailOpen`]: crate::plugins::limits::RecoveryPolicy::FailOpen

use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use bytes::Bytes;
// The `http` crate is not a direct dependency; it reaches us through hyper.
use hyper::http;
use http_body::{Body, Frame};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, StreamBody};
use wasmtime_wasi_http::p3::bindings::http::types::ErrorCode;

use crate::plugins::limits::{BreachRecorder, LimitKind};

/// The body type carried throughout the event pipeline.
pub type EventBody = UnsyncBoxBody<Bytes, ErrorCode>;

/// Shared state behind a [`TeeBody`]: what the guest has consumed so far, plus
/// the not-yet-consumed remainder.
struct Recorder {
    /// Frames the guest has already pulled, retained so they can be replayed.
    recorded: Vec<Bytes>,
    /// Bytes in `recorded`.
    bytes: u64,
    /// `0` means unbounded.
    limit: u64,
    /// Set once the budget is exceeded. Recording stops and recovery becomes
    /// unavailable -- retaining a partial prefix would let us rebuild a
    /// *truncated* event, which is worse than admitting we cannot rebuild one.
    overflowed: bool,
    /// The body itself. Held here rather than inside the guest's resource so
    /// that a guest dropping the resource does not destroy the remainder.
    remainder: Option<EventBody>,
    breaches: Arc<BreachRecorder>,
}

/// Handle to a body being recorded as a guest consumes it.
#[derive(Clone)]
pub struct BodyRecording(Arc<Mutex<Recorder>>);

impl BodyRecording {
    /// True when the whole body is still recoverable.
    pub fn is_recoverable(&self) -> bool {
        !self.lock().overflowed
    }

    /// Bytes retained so far.
    pub fn recorded_bytes(&self) -> u64 {
        self.lock().bytes
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Recorder> {
        // The guard is never held across an await -- `poll_frame` is
        // synchronous -- so a poisoned lock can only mean a panic elsewhere
        // left the buffer mid-append. Recovering it is safe because the
        // subsequent `overflowed` check is what gates correctness.
        match self.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Rebuild the body as it was before the guest touched it: everything
    /// recorded, followed by everything not yet consumed.
    ///
    /// Returns `None` when the recording overflowed its budget, in which case
    /// the caller must fail closed.
    pub fn rebuild(&self) -> Option<EventBody> {
        use futures::StreamExt;

        let mut guard = self.lock();
        if guard.overflowed {
            return None;
        }
        let recorded = std::mem::take(&mut guard.recorded);
        guard.bytes = 0;
        let remainder = guard.remainder.take();
        drop(guard);

        let replayed = futures::stream::iter(
            recorded
                .into_iter()
                .map(|b| Ok::<_, ErrorCode>(Frame::data(b))),
        );
        match remainder {
            Some(rest) => Some(
                StreamBody::new(replayed.chain(http_body_util::BodyStream::new(rest)))
                    .boxed_unsync(),
            ),
            None => Some(StreamBody::new(replayed).boxed_unsync()),
        }
    }
}

/// A body that records what passes through it, up to a budget.
pub struct TeeBody {
    shared: BodyRecording,
}

impl TeeBody {
    /// Wrap `body`, returning the tee to hand onward and the recording handle
    /// to keep. `limit` of `0` means unbounded.
    pub fn wrap(
        body: EventBody,
        limit: u64,
        breaches: Arc<BreachRecorder>,
    ) -> (EventBody, BodyRecording) {
        let shared = BodyRecording(Arc::new(Mutex::new(Recorder {
            recorded: Vec::new(),
            bytes: 0,
            limit,
            overflowed: false,
            remainder: Some(body),
            breaches,
        })));
        let tee = TeeBody {
            shared: shared.clone(),
        };
        (tee.boxed_unsync(), shared)
    }
}

impl Body for TeeBody {
    type Data = Bytes;
    type Error = ErrorCode;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let mut guard = self.shared.lock();
        let Some(body) = guard.remainder.as_mut() else {
            return Poll::Ready(None);
        };

        match Pin::new(body).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    let len = data.len() as u64;
                    let projected = guard.bytes.saturating_add(len);
                    if guard.limit > 0 && projected > guard.limit && !guard.overflowed {
                        guard.overflowed = true;
                        // Drop what we have: a partial prefix would let us
                        // rebuild a truncated event, which is worse than
                        // admitting recovery is unavailable.
                        guard.recorded.clear();
                        guard.bytes = 0;
                        let limit = guard.limit;
                        guard.breaches.record(
                            LimitKind::EventRecoveryBufferBytes,
                            projected,
                            limit,
                        );
                    } else if !guard.overflowed {
                        guard.recorded.push(data.clone());
                        guard.bytes = projected;
                    }
                }
                Poll::Ready(Some(Ok(frame)))
            }
            other => other,
        }
    }

    fn is_end_stream(&self) -> bool {
        let guard = self.shared.lock();
        match guard.remainder.as_ref() {
            Some(b) => b.is_end_stream(),
            None => true,
        }
    }

    fn size_hint(&self) -> http_body::SizeHint {
        let guard = self.shared.lock();
        match guard.remainder.as_ref() {
            Some(b) => b.size_hint(),
            None => http_body::SizeHint::with_exact(0),
        }
    }
}

/// Enough to rebuild an event after a guest failed part-way through it.
///
/// Holds owned host-side data, never a resource index: the previous
/// implementation captured a table rep and resurrected it with
/// `Resource::new_own`, which could alias a different resource once the guest
/// dropped the original and the table reused the slot.
///
/// Metadata is snapshotted eagerly (it is small and cheap to clone); the body
/// is recorded lazily by [`TeeBody`] as the guest reads it.
pub enum EventShadow {
    Request {
        method: http::Method,
        uri: http::Uri,
        version: http::Version,
        headers: http::HeaderMap,
        recording: BodyRecording,
    },
    Response {
        status: http::StatusCode,
        version: http::Version,
        headers: http::HeaderMap,
        request: crate::wasm::bindgen::witmproxy::plugin::capabilities::RequestContext,
        recording: BodyRecording,
    },
    InboundContent {
        status: http::StatusCode,
        version: http::Version,
        headers: http::HeaderMap,
        content_type: String,
        recording: BodyRecording,
    },
    /// Timers carry no consumable resource, so recovery is free and always
    /// available.
    Timer { timestamp: u64 },
}

impl EventShadow {
    /// True when the event can still be rebuilt. False once a body recording
    /// has exceeded its budget.
    pub fn is_recoverable(&self) -> bool {
        match self {
            Self::Timer { .. } => true,
            Self::Request { recording, .. }
            | Self::Response { recording, .. }
            | Self::InboundContent { recording, .. } => recording.is_recoverable(),
        }
    }

    /// Rebuild the event as the failing plugin received it.
    pub fn rebuild(self) -> anyhow::Result<Box<dyn super::Event>> {
        match self {
            Self::Timer { timestamp } => {
                Ok(Box::new(crate::events::timer::TimerEvent { timestamp }))
            }
            Self::Request {
                method,
                uri,
                version,
                headers,
                recording,
            } => {
                let body = recording
                    .rebuild()
                    .ok_or_else(|| anyhow::anyhow!("request body is no longer recoverable"))?;
                let mut req = http::Request::new(body);
                *req.method_mut() = method;
                *req.uri_mut() = uri;
                *req.version_mut() = version;
                *req.headers_mut() = headers;
                let (wasi, _io) =
                    wasmtime_wasi_http::p3::Request::from_http(
                        wasmtime_wasi_http::default_hooks(),
                        req,
                    );
                Ok(Box::new(wasi))
            }
            Self::Response {
                status,
                version,
                headers,
                request,
                recording,
            } => {
                let body = recording
                    .rebuild()
                    .ok_or_else(|| anyhow::anyhow!("response body is no longer recoverable"))?;
                let mut res = http::Response::new(body);
                *res.status_mut() = status;
                *res.version_mut() = version;
                *res.headers_mut() = headers;
                let (wasi, _io) = wasmtime_wasi_http::p3::Response::from_http(
                    wasmtime_wasi_http::default_hooks(),
                    res,
                );
                Ok(Box::new(crate::events::response::ContextualResponse {
                    request,
                    response: wasi,
                }))
            }
            Self::InboundContent {
                status,
                version,
                headers,
                content_type,
                recording,
            } => {
                let body = recording
                    .rebuild()
                    .ok_or_else(|| anyhow::anyhow!("content body is no longer recoverable"))?;
                let mut res = http::Response::new(());
                *res.status_mut() = status;
                *res.version_mut() = version;
                *res.headers_mut() = headers;
                let (parts, ()) = res.into_parts();
                Ok(Box::new(crate::events::content::InboundContent::from_decoded(
                    parts,
                    content_type,
                    body,
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::Full;

    fn body(data: &[u8]) -> EventBody {
        Full::new(Bytes::copy_from_slice(data))
            .map_err(|_| ErrorCode::InternalError(None))
            .boxed_unsync()
    }

    async fn drain(b: EventBody) -> Vec<u8> {
        b.collect().await.map(|c| c.to_bytes().to_vec()).unwrap_or_default()
    }

    #[tokio::test]
    async fn untouched_body_rebuilds_identically() {
        let rec = BreachRecorder::new("t");
        let (tee, recording) = TeeBody::wrap(body(b"hello world"), 1024, rec);
        // Nothing consumed the tee: the whole body is still the remainder.
        drop(tee);
        let rebuilt = recording.rebuild().expect("recoverable");
        assert_eq!(drain(rebuilt).await, b"hello world");
    }

    #[tokio::test]
    async fn fully_consumed_body_rebuilds_from_the_recording() {
        let rec = BreachRecorder::new("t");
        let (tee, recording) = TeeBody::wrap(body(b"hello world"), 1024, rec);
        assert_eq!(drain(tee).await, b"hello world");
        assert!(recording.is_recoverable());
        let rebuilt = recording.rebuild().expect("recoverable");
        assert_eq!(drain(rebuilt).await, b"hello world");
    }

    /// The budget exists so recovery cannot itself become a memory-exhaustion
    /// vector; exceeding it must give up cleanly rather than retain a prefix.
    #[tokio::test]
    async fn exceeding_the_budget_makes_recovery_unavailable() {
        let rec = BreachRecorder::new("t");
        let (tee, recording) = TeeBody::wrap(body(&[0u8; 4096]), 128, Arc::clone(&rec));
        let _ = drain(tee).await;
        assert!(!recording.is_recoverable(), "must give up past the budget");
        assert!(recording.rebuild().is_none());
        assert_eq!(rec.count(), 1, "the operator must be told");
        assert_eq!(
            recording.recorded_bytes(),
            0,
            "a truncated prefix must not be retained"
        );
    }

    #[tokio::test]
    async fn zero_budget_means_unbounded() {
        let rec = BreachRecorder::new("t");
        let (tee, recording) = TeeBody::wrap(body(&[7u8; 64 * 1024]), 0, Arc::clone(&rec));
        let _ = drain(tee).await;
        assert!(recording.is_recoverable());
        assert_eq!(rec.count(), 0);
        assert_eq!(drain(recording.rebuild().unwrap()).await.len(), 64 * 1024);
    }
}
