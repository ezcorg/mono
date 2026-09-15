use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};

use anyhow::Result;
use bytes::Bytes;
use http_body::Body as _;
use http_body_util::BodyExt;
use http_body_util::combinators::UnsyncBoxBody;
use tokio::sync::{RwLock, mpsc};
use tokio_util::sync::PollSender;
use wasmtime::AsContextMut;
use wasmtime::StoreContextMut;
use wasmtime::component::{
    Accessor, Destination, HasData, Resource, ResourceTable, Source, StreamProducer, StreamReader,
    StreamResult,
};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::WasiHttpCtx;
use wasmtime_wasi_http::p3::bindings::http::types::ErrorCode;

mod runtime;

use crate::events::content::InboundContent;
use crate::plugins::capabilities::Capability;
use crate::plugins::limits::{BreachRecorder, LimitKind, ResolvedLimits};
use crate::plugins::membranes::Membranes;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
    CapabilityKind, HostAnnotatorClient, HostAnnotatorClientWithStore, HostCapabilityProvider,
    HostCapabilityProviderWithStore, HostClockClient, HostClockClientWithStore, HostContent,
    HostContentWithStore, HostLocalStorageClient, HostLocalStorageClientWithStore, HostLogger,
    HostLoggerWithStore,
};
use bindgen::ezco::ezcap::types::CapabilityError;
pub use runtime::Runtime;

pub mod bindgen;

/// The per-call admission handle a minted provider resource carries: which
/// membrane instance decides, under which capability tag, and who the caller
/// is (`caller.plugin` = the plugin id). `None` on a resource means no scope
/// was minted for it (test-built providers), and every call is admitted.
#[derive(Clone)]
pub struct Admission {
    membranes: Arc<Membranes>,
    tag: &'static str,
    instance: ezcap::InstanceId,
    caller: ezcap::Caller,
}

impl Admission {
    pub fn new(
        membranes: Arc<Membranes>,
        tag: &'static str,
        instance: ezcap::InstanceId,
        plugin_id: &str,
    ) -> Self {
        Self {
            membranes,
            tag,
            instance,
            caller: ezcap::Caller {
                plugin: Some(plugin_id.to_string()),
                ..Default::default()
            },
        }
    }
}

/// Admit one call on a resource: `method` is the WIT method name, `args` the
/// arguments to bind as `call.args.*`, `bytes` the payload size for
/// `call.bytes`/`state.bytes`. A missing admission handle admits everything.
fn admit(
    admission: &Option<Admission>,
    method: &str,
    args: Vec<(&str, ezcap::Val)>,
    bytes: i64,
) -> Result<(), CapabilityError> {
    let Some(a) = admission else { return Ok(()) };
    let mut call = ezcap::Call::new(method)
        .caller(a.caller.clone())
        .bytes(bytes);
    for (name, val) in args {
        call = call.arg(name, val);
    }
    match a.membranes.admit(a.tag, &a.instance, &call) {
        Ok(()) => Ok(()),
        Err(ezcap::CapabilityError::Denied(sentences)) => Err(CapabilityError::Denied(sentences)),
        Err(ezcap::CapabilityError::Unavailable) => Err(CapabilityError::Unavailable),
    }
}

/// A capability provider that holds the capability instances granted to a plugin.
/// The caller/builder is responsible for providing the necessary objects.
/// The provider simply returns what it has access to when called.
#[derive(Default)]
pub struct CapabilityProvider {
    logger: Option<Logger>,
    annotator: Option<AnnotatorClient>,
    local_storage: Option<LocalStorageClient>,
    clock: Option<ClockClient>,
}

impl CapabilityProvider {
    /// Create a new CapabilityProvider with no capabilities granted
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the logger capability
    pub fn with_logger(mut self, logger: Logger) -> Self {
        self.logger = Some(logger);
        self
    }

    /// Set the annotator capability
    pub fn with_annotator(mut self, annotator: AnnotatorClient) -> Self {
        self.annotator = Some(annotator);
        self
    }

    /// Set the local storage capability
    pub fn with_local_storage(mut self, local_storage: LocalStorageClient) -> Self {
        self.local_storage = Some(local_storage);
        self
    }

    /// Set the clock capability
    pub fn with_clock(mut self, clock: ClockClient) -> Self {
        self.clock = Some(clock);
        self
    }

    /// Returns a clone of the logger if granted
    pub fn logger(&self) -> Option<Logger> {
        self.logger.clone()
    }

    /// Returns a clone of the annotator client if granted
    pub fn annotator(&self) -> Option<AnnotatorClient> {
        self.annotator.clone()
    }

    /// Returns a clone of the local storage client if granted
    pub fn local_storage(&self) -> Option<LocalStorageClient> {
        self.local_storage.clone()
    }

    /// Returns a clone of the clock client if granted
    pub fn clock(&self) -> Option<ClockClient> {
        self.clock.clone()
    }
}

impl CapabilityProvider {
    /// Build a provider from a plugin's granted capabilities.
    ///
    /// `local_storage` is the plugin's PERSISTENT storage client (one per
    /// plugin, owned by the registry). A clone is handed to the provider so
    /// that writes survive across events for the same plugin. `None` disables
    /// the local-storage capability even if granted.
    pub fn build(
        capabilities: &[Capability],
        local_storage: Option<LocalStorageClient>,
        limits: &ResolvedLimits,
        breaches: Arc<BreachRecorder>,
        // The registry's membranes and the plugin id, so each minted resource
        // admits its calls through the capability's instance. `None` (tests)
        // admits everything.
        admission: Option<(&Arc<Membranes>, &str)>,
    ) -> Self {
        let mut provider = CapabilityProvider::new();
        for cap in capabilities {
            if !cap.granted {
                continue;
            }
            let adm =
                match (admission, Membranes::tag_of(&cap.inner.kind), &cap.instance) {
                    (Some((membranes, plugin_id)), Some(tag), Some(instance)) => Some(
                        Admission::new(Arc::clone(membranes), tag, instance.clone(), plugin_id),
                    ),
                    _ => None,
                };
            match &cap.inner.kind {
                CapabilityKind::Logger => {
                    // A fresh logger per provider, i.e. per event: the budget is
                    // a per-event budget by construction.
                    provider = provider.with_logger(
                        Logger::with_limits(limits, Arc::clone(&breaches)).with_admission(adm),
                    );
                }
                CapabilityKind::Annotator => {
                    provider = provider.with_annotator(AnnotatorClient::new().with_admission(adm));
                }
                CapabilityKind::LocalStorage => {
                    if let Some(client) = local_storage.clone() {
                        provider = provider.with_local_storage(client.with_admission(adm));
                    }
                }
                CapabilityKind::Clock => {
                    provider = provider.with_clock(ClockClient::new().with_admission(adm));
                }
                CapabilityKind::HandleEvent(_) => {
                    // Event handling capabilities are managed separately
                }
            }
        }
        provider
    }
}

impl From<&Vec<Capability>> for CapabilityProvider {
    fn from(capabilities: &Vec<Capability>) -> Self {
        // Fresh (non-persistent) local storage. Callers that need storage to
        // survive across events should use `CapabilityProvider::build` with a
        // persistent client instead.
        Self::build(
            capabilities,
            Some(LocalStorageClient::new()),
            &ResolvedLimits::DEFAULTS,
            BreachRecorder::new("<anonymous>"),
            None,
        )
    }
}

#[derive(Clone, Default)]
pub struct AnnotatorClient {
    admission: Option<Admission>,
}

impl AnnotatorClient {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_admission(mut self, admission: Option<Admission>) -> Self {
        self.admission = admission;
        self
    }

    pub fn annotate(&self, _content: &InboundContent) {}
}

/// Custom StreamProducer for body streaming
pub struct BodyStreamProducer {
    body: UnsyncBoxBody<Bytes, ErrorCode>,
    /// Remainder of a frame larger than the guest's read capacity.
    ///
    /// Held here rather than in wasmtime's host buffer. The previous code
    /// stored it with `Destination::set_buffer` and then called
    /// `as_direct(capacity)`, which in wasmtime 43 only resized the buffer when
    /// it was empty. In 48 `as_direct` resizes unconditionally, discarding it:
    ///
    /// ```text
    /// *buffer.marked_written = 0;
    /// buffer.dst.resize(capacity, 0);
    /// ```
    ///
    /// Every body larger than one guest read was therefore truncated after the
    /// first chunk. Owning the remainder keeps this correct regardless of how
    /// the host buffer behaves.
    pending: Option<Bytes>,
}

impl BodyStreamProducer {
    pub fn new(body: UnsyncBoxBody<Bytes, ErrorCode>) -> Self {
        Self {
            body,
            pending: None,
        }
    }

    /// Write up to `cap` bytes of `data` to `dst`, retaining any remainder.
    fn emit<D>(
        &mut self,
        store: StoreContextMut<'_, D>,
        dst: Destination<'_, u8, Bytes>,
        mut data: Bytes,
        cap: usize,
    ) {
        let n = data.len().min(cap);
        if data.len() > n {
            self.pending = Some(data.split_off(n));
        }
        let mut direct = dst.as_direct(store, n);
        if let Some(slice) = direct.remaining().get_mut(..n) {
            slice.copy_from_slice(&data);
        }
        direct.mark_written(n);
    }
}

impl<D> StreamProducer<D> for BodyStreamProducer
where
    D: 'static,
{
    type Item = u8;
    type Buffer = Bytes;

    fn poll_produce<'a>(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        mut store: StoreContextMut<'a, D>,
        mut dst: Destination<'a, Self::Item, Self::Buffer>,
        finish: bool,
    ) -> Poll<wasmtime::Result<StreamResult>> {
        use core::num::NonZeroUsize;

        let cap = match dst.remaining(&mut store).map(NonZeroUsize::new) {
            Some(Some(cap)) => Some(cap),
            Some(None) => {
                // Zero-length read: guest is checking readiness without consuming.
                // Return Completed (we may have data) or Dropped (stream ended).
                if self.body.is_end_stream() {
                    return Poll::Ready(Ok(StreamResult::Dropped));
                } else {
                    return Poll::Ready(Ok(StreamResult::Completed));
                }
            }
            None => None,
        };

        // Serve a retained remainder before pulling another frame, so a frame
        // larger than the guest's read capacity is delivered across as many
        // polls as it takes.
        if let Some(pending) = self.pending.take() {
            match cap {
                Some(cap) => {
                    self.emit(store, dst, pending, cap.into());
                    return Poll::Ready(Ok(StreamResult::Completed));
                }
                None => {
                    dst.set_buffer(pending);
                    return Poll::Ready(Ok(StreamResult::Completed));
                }
            }
        }

        // Loop to skip empty data frames from the HTTP body.
        // HTTP/2 can produce zero-length DATA frames which would cause
        // wasmtime to error with "Completed without producing any items"
        // if we returned without writing anything.
        loop {
            match Pin::new(&mut self.body).poll_frame(cx) {
                Poll::Ready(Some(Ok(frame))) => {
                    // Try to extract data from the frame
                    match frame.into_data().map_err(http_body::Frame::into_trailers) {
                        Ok(data_frame) => {
                            // Skip empty data frames and poll again
                            if data_frame.is_empty() {
                                continue;
                            }
                            if let Some(cap) = cap {
                                self.emit(store, dst, data_frame, cap.into());
                            } else {
                                // No capacity info, just buffer it
                                dst.set_buffer(data_frame);
                            }
                            return Poll::Ready(Ok(StreamResult::Completed));
                        }
                        Err(Ok(_trailers)) => {
                            // Trailers received - we're done with body data
                            return Poll::Ready(Ok(StreamResult::Dropped));
                        }
                        Err(Err(..)) => {
                            // Frame is neither data nor trailers - protocol error
                            return Poll::Ready(Ok(StreamResult::Dropped));
                        }
                    }
                }
                Poll::Ready(Some(Err(_err))) => return Poll::Ready(Ok(StreamResult::Dropped)),
                Poll::Ready(None) => return Poll::Ready(Ok(StreamResult::Dropped)),
                Poll::Pending if finish => return Poll::Ready(Ok(StreamResult::Cancelled)),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

/// Shared budget state. Held behind an `Arc` so every clone of a `Logger`
/// charges the SAME budget: `CapabilityProvider::logger()` hands out a clone on
/// every call, so a per-clone budget would be trivially bypassed by a guest
/// re-acquiring the capability in a loop.
#[derive(Debug)]
struct LogBudget {
    bytes_used: AtomicU64,
    messages_used: AtomicU64,
    /// `0` means unbounded.
    max_bytes: u64,
    /// `0` means unbounded.
    max_messages: u64,
    breaches: Arc<BreachRecorder>,
}

/// Per-event logging budget for one plugin.
///
/// Two problems are addressed here.
///
/// **Volume.** The log sink is backed by `tracing-appender` writing to disk, so
/// an unthrottled plugin can fill the operator's disk from inside the sandbox.
/// A plugin holding the `logger` capability is trusted to describe what it is
/// doing, not to decide how much of the host's disk it may consume, so the
/// budget is per event and is reset for every event.
///
/// **Injection.** The message is guest-controlled and was previously passed to
/// `tracing` verbatim. A message containing newlines can forge additional log
/// lines -- including lines that look like they came from the host -- which
/// corrupts exactly the audit trail an operator would use to investigate the
/// plugin. Control characters are escaped rather than dropped so the original
/// content is still recoverable.
#[derive(Clone)]
pub struct Logger {
    budget: Arc<LogBudget>,
    admission: Option<Admission>,
}

/// Longest single message admitted after escaping. Bounds one pathological
/// message independently of the per-event byte budget.
const MAX_LOG_MESSAGE_LEN: usize = 8 * 1024;

impl Logger {
    pub fn new() -> Self {
        Self::with_limits(&ResolvedLimits::DEFAULTS, BreachRecorder::new("<unknown>"))
    }

    pub fn with_limits(limits: &ResolvedLimits, breaches: Arc<BreachRecorder>) -> Self {
        Self {
            budget: Arc::new(LogBudget {
                bytes_used: AtomicU64::new(0),
                messages_used: AtomicU64::new(0),
                max_bytes: limits.max_log_bytes_per_event,
                max_messages: limits.max_log_messages_per_event,
                breaches,
            }),
            admission: None,
        }
    }

    /// Escape control characters so a guest cannot forge log lines, and bound
    /// the length of any single message.
    fn sanitize(message: &str) -> String {
        let mut out = String::with_capacity(message.len().min(MAX_LOG_MESSAGE_LEN));
        for ch in message.chars() {
            if out.len() >= MAX_LOG_MESSAGE_LEN {
                out.push_str("...[truncated]");
                break;
            }
            match ch {
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if c.is_control() => out.push_str(&format!("\\u{{{:04x}}}", c as u32)),
                c => out.push(c),
            }
        }
        out
    }

    /// Escape and bound a guest-supplied string for inclusion in an operator
    /// report (a log line, the management API).
    ///
    /// Guest error messages cross the same trust boundary as guest log
    /// messages and need the same treatment, so both go through here.
    pub fn sanitize_for_report(message: &str) -> String {
        Self::sanitize(message)
    }

    /// Test accessor for [`Self::sanitize`].
    #[cfg(test)]
    pub fn sanitize_for_test(message: &str) -> String {
        Self::sanitize(message)
    }

    /// Charge a message against the per-event budget.
    ///
    /// Returns the sanitized message when it may be emitted, or `None` when the
    /// budget is exhausted (recorded and reported to the operator).
    fn admit(&self, message: &str) -> Option<String> {
        let msg = Self::sanitize(message);

        let b = &*self.budget;
        if b.max_messages > 0 {
            let used = b.messages_used.fetch_add(1, Ordering::Relaxed) + 1;
            if used > b.max_messages {
                // Report only on the transition, so the breach report itself
                // cannot become the flood.
                if used == b.max_messages + 1 {
                    b.breaches
                        .record(LimitKind::LogMessages, used, b.max_messages);
                }
                return None;
            }
        }

        if b.max_bytes > 0 {
            let used =
                b.bytes_used.fetch_add(msg.len() as u64, Ordering::Relaxed) + msg.len() as u64;
            if used > b.max_bytes {
                if used.saturating_sub(msg.len() as u64) <= b.max_bytes {
                    b.breaches.record(LimitKind::LogBytes, used, b.max_bytes);
                }
                return None;
            }
        }

        Some(msg)
    }

    pub fn with_admission(mut self, admission: Option<Admission>) -> Self {
        self.admission = admission;
        self
    }

    /// The scope check for one log call: the grant's `allow` clause sees the
    /// level as `call.method` and the message as `call.args.message`.
    fn admitted(&self, level: &str, message: &str) -> Result<(), CapabilityError> {
        admit(
            &self.admission,
            level,
            vec![("message", ezcap::Val::from(message))],
            message.len() as i64,
        )
    }

    pub fn info(&self, message: String) {
        if let Some(m) = self.admit(&message) {
            tracing::info!(target: "plugins::guest", "{}", m);
        }
    }

    pub fn warn(&self, message: String) {
        if let Some(m) = self.admit(&message) {
            tracing::warn!(target: "plugins::guest", "{}", m);
        }
    }

    pub fn error(&self, message: String) {
        if let Some(m) = self.admit(&message) {
            tracing::error!(target: "plugins::guest", "{}", m);
        }
    }

    pub fn debug(&self, message: String) {
        if let Some(m) = self.admit(&message) {
            tracing::debug!(target: "plugins::guest", "{}", m);
        }
    }
}

impl Default for Logger {
    fn default() -> Self {
        Self::new()
    }
}

/// A local storage client with shared mutable state via Arc<RwLock<>>.
/// Clone is cheap (just Arc clone) and all clones share the same storage.
/// Uses Bytes internally for efficient storage and cheap cloning.
///
/// # Quotas
///
/// This map lives in HOST memory and persists for the lifetime of the plugin,
/// so it is not bounded by the store's `max_memory_mb` limit (which caps guest
/// linear memory only). Without an explicit quota a plugin could grow the
/// daemon's resident set without bound -- one `set()` per request is enough --
/// while staying entirely inside its guest memory cap.
///
/// The caps are held in atomics rather than captured at construction because
/// the client is persistent across events while the operator's configuration
/// can change; the registry refreshes them per event.
#[derive(Clone)]
pub struct LocalStorageClient {
    admission: Option<Admission>,
    store: Arc<RwLock<HashMap<String, Bytes>>>,
    /// Current total accounted size, in bytes (keys plus values).
    bytes_used: Arc<AtomicU64>,
    /// `0` means unbounded.
    max_bytes: Arc<AtomicU64>,
    /// `0` means unbounded.
    max_keys: Arc<AtomicU64>,
    breaches: Arc<BreachRecorder>,
}

impl Default for LocalStorageClient {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalStorageClient {
    pub fn new() -> Self {
        Self::with_limits(&ResolvedLimits::DEFAULTS, BreachRecorder::new("<unknown>"))
    }

    pub fn with_limits(limits: &ResolvedLimits, breaches: Arc<BreachRecorder>) -> Self {
        Self {
            store: Arc::new(RwLock::new(HashMap::new())),
            bytes_used: Arc::new(AtomicU64::new(0)),
            max_bytes: Arc::new(AtomicU64::new(limits.max_local_storage_bytes)),
            max_keys: Arc::new(AtomicU64::new(limits.max_local_storage_keys)),
            breaches,
            admission: None,
        }
    }

    pub fn with_admission(mut self, admission: Option<Admission>) -> Self {
        self.admission = admission;
        self
    }

    /// The scope check for one storage call (`set`/`get`/`delete`): the
    /// grant's `allow` clause sees the key as `call.args.key` and, for `set`,
    /// the value as `call.args.value`.
    fn admitted(
        &self,
        method: &str,
        key: &str,
        value: Option<&[u8]>,
    ) -> Result<(), CapabilityError> {
        let mut args = vec![("key", ezcap::Val::from(key))];
        if let Some(v) = value {
            args.push(("value", ezcap::Val::Bytes(v.to_vec())));
        }
        admit(
            &self.admission,
            method,
            args,
            value.map_or(0, |v| v.len() as i64),
        )
    }

    /// Refresh the quotas from the plugin's currently-effective limits.
    /// Called per event so a configuration change takes effect without a
    /// restart and without discarding the plugin's stored data.
    pub fn update_limits(&self, limits: &ResolvedLimits) {
        self.max_bytes
            .store(limits.max_local_storage_bytes, Ordering::Relaxed);
        self.max_keys
            .store(limits.max_local_storage_keys, Ordering::Relaxed);
    }

    /// Bytes currently accounted against the quota.
    pub fn bytes_used(&self) -> u64 {
        self.bytes_used.load(Ordering::Relaxed)
    }

    /// Set a key-value pair in the store (async).
    ///
    /// Returns `false` when the write was refused for exceeding a quota. The
    /// WIT signature returns nothing, so a refusal is invisible to the guest by
    /// design -- a plugin must not be able to probe the host's remaining
    /// headroom -- but it is recorded and logged for the operator.
    pub async fn set(&self, key: String, value: Vec<u8>) -> bool {
        let max_bytes = self.max_bytes.load(Ordering::Relaxed);
        let max_keys = self.max_keys.load(Ordering::Relaxed);

        // Account for the key as well as the value: many small keys are just as
        // effective at exhausting memory as one large value.
        let incoming = (key.len() as u64).saturating_add(value.len() as u64);

        let mut guard = self.store.write().await;
        let previous = guard
            .get(&key)
            .map(|v| (key.len() as u64).saturating_add(v.len() as u64));
        let is_new_key = previous.is_none();

        if max_keys > 0 && is_new_key && guard.len() as u64 >= max_keys {
            let attempted = (guard.len() as u64).saturating_add(1);
            drop(guard);
            self.breaches
                .record(LimitKind::LocalStorageKeys, attempted, max_keys);
            return false;
        }

        let projected = self
            .bytes_used
            .load(Ordering::Relaxed)
            .saturating_sub(previous.unwrap_or(0))
            .saturating_add(incoming);

        if max_bytes > 0 && projected > max_bytes {
            drop(guard);
            self.breaches
                .record(LimitKind::LocalStorageBytes, projected, max_bytes);
            return false;
        }

        guard.insert(key, Bytes::from(value));
        self.bytes_used.store(projected, Ordering::Relaxed);
        true
    }

    /// Get a value by key (async). Returns cloned Bytes which is cheap.
    pub async fn get(&self, key: &str) -> Option<Bytes> {
        self.store.read().await.get(key).cloned()
    }

    /// Delete a key from the store (async)
    pub async fn delete(&self, key: &str) {
        if let Some(removed) = self.store.write().await.remove(key) {
            let freed = (key.len() as u64).saturating_add(removed.len() as u64);
            let _ = self
                .bytes_used
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |cur| {
                    Some(cur.saturating_sub(freed))
                });
        }
    }
}

/// Decide whether a `set-body` chunk fits within the configured cap.
///
/// Split out of the stream consumer (a local struct inside `set_body`) purely
/// so the arithmetic is reachable from tests. `0` means unbounded.
pub(crate) fn body_chunk_admitted(written: u64, chunk_len: u64, max_bytes: u64) -> bool {
    if max_bytes == 0 {
        return true;
    }
    written.saturating_add(chunk_len) <= max_bytes
}

/// A clock client providing access to the current system time.
#[derive(Clone, Default)]
pub struct ClockClient {
    admission: Option<Admission>,
}

impl ClockClient {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_admission(mut self, admission: Option<Admission>) -> Self {
        self.admission = admission;
        self
    }

    fn admitted(&self, method: &str) -> Result<(), CapabilityError> {
        admit(&self.admission, method, Vec::new(), 0)
    }

    /// Returns the current time as a Unix timestamp in seconds
    pub fn now_seconds(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    /// Returns the current time as a Unix timestamp in milliseconds
    pub fn now_millis(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            // Saturates rather than wrapping; only reachable ~584 million
            // years past the epoch.
            .try_into()
            .unwrap_or(u64::MAX)
    }

    /// The host's local time zone offset from UTC in seconds, positive east
    /// of UTC. Exposed so guests can reason about the user's wall-clock time
    /// (working hours, day boundaries) without a time zone database.
    pub fn utc_offset_seconds(&self) -> i32 {
        use chrono::Offset;
        chrono::Local::now().offset().fix().local_minus_utc()
    }
}

/// Builder-style structure used to create a [`WitmProxyCtx`].
#[derive(Default)]
pub struct WitmProxyCtxBuilder {
    limits: Option<ResolvedLimits>,
    breaches: Option<Arc<BreachRecorder>>,
}

impl WitmProxyCtxBuilder {
    /// Creates a builder for a new context with default parameters set.
    pub fn new() -> Self {
        Default::default()
    }

    /// Uses the configured context so far to construct the final [`WitmProxyCtx`].
    /// Attach the effective per-plugin limits and breach recorder.
    pub fn with_limits(mut self, limits: ResolvedLimits, breaches: Arc<BreachRecorder>) -> Self {
        self.limits = Some(limits);
        self.breaches = Some(breaches);
        self
    }

    pub fn build(self) -> WitmProxyCtx {
        WitmProxyCtx {
            limits: self.limits.unwrap_or(ResolvedLimits::DEFAULTS),
            breaches: self
                .breaches
                .unwrap_or_else(|| BreachRecorder::new("<unknown>")),
        }
    }
}

/// Capture the state necessary for use in the `witmproxy:plugin` API implementation.
pub struct WitmProxyCtx {
    /// Effective limits for the plugin this store belongs to. Host capability
    /// implementations (which only see the store, not the registry) read these
    /// to enforce quotas on guest-driven work such as `content.set-body`.
    pub limits: ResolvedLimits,
    /// Breach recorder for the same plugin.
    pub breaches: Arc<BreachRecorder>,
}

impl WitmProxyCtx {
    /// Convenience function for calling [`WitmProxyCtxBuilder::new`].
    pub fn builder() -> WitmProxyCtxBuilder {
        WitmProxyCtxBuilder::new()
    }
}

/// A wrapper capturing the needed internal `witmproxy:plugin` state.
pub struct WitmProxyCtxView<'a> {
    ctx: &'a WitmProxyCtx,
    pub table: &'a mut ResourceTable,
}

impl<'a> WitmProxyCtxView<'a> {
    /// Create a new view into the `witmproxy:plugin` state.
    pub fn new(ctx: &'a WitmProxyCtx, table: &'a mut ResourceTable) -> Self {
        Self { ctx, table }
    }

    /// Effective limits for the plugin owning this store.
    pub fn limits(&self) -> &ResolvedLimits {
        &self.ctx.limits
    }

    /// Breach recorder for the plugin owning this store.
    pub fn breaches(&self) -> Arc<BreachRecorder> {
        Arc::clone(&self.ctx.breaches)
    }
}

/// Minimal WASI host state for each Store.
pub struct Host {
    pub table: ResourceTable,
    pub wasi: WasiCtx,
    pub http: WasiHttpCtx,
    pub witmproxy_ctx: WitmProxyCtx,
    /// Per-store resource limits (memory cap). Defaults to unbounded; the
    /// `Runtime` installs a real cap via `store.limiter(|h| &mut h.limits)`
    /// only when a memory limit is configured.
    pub limits: wasmtime::StoreLimits,
}

impl Host {
    /// Build host state carrying the effective limits and breach recorder for
    /// the plugin this store belongs to.
    pub fn with_context(limits: ResolvedLimits, breaches: Arc<BreachRecorder>) -> Self {
        Self {
            witmproxy_ctx: WitmProxyCtxBuilder::new()
                .with_limits(limits, breaches)
                .build(),
            ..Self::default()
        }
    }
}

impl Default for Host {
    fn default() -> Self {
        Self {
            table: ResourceTable::new(),
            wasi: {
                // Defence in depth. The linker registers the whole WASI p2/p3
                // surface, including `wasi:sockets`. A default `WasiCtx` denies
                // every address through its socket-address check, so a plugin
                // cannot actually connect -- but `allow_tcp` / `allow_udp`
                // default to true, which leaves the socket *machinery* reachable
                // and one future default change away from being useful. The
                // proxy grants plugins no outbound network capability by
                // design (note the deliberately omitted `wasi:http/client` in
                // `Runtime::build_linker`), so state that here explicitly
                // rather than relying on a default.
                let mut builder = WasiCtxBuilder::new();
                builder
                    .allow_tcp(false)
                    .allow_udp(false)
                    .allow_ip_name_lookup(false);
                builder.build()
            },
            http: WasiHttpCtx::new(),
            witmproxy_ctx: WitmProxyCtxBuilder::new().build(),
            limits: wasmtime::StoreLimits::default(),
        }
    }
}

impl<T> HostContentWithStore<T> for WitmProxy {
    async fn drop(
        accessor: &Accessor<T, Self>,
        rep: wasmtime::component::Resource<InboundContent>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            state.table.delete(rep)
        })?;
        Ok(())
    }

    async fn content_type(
        accessor: &Accessor<T, Self>,
        self_: wasmtime::component::Resource<InboundContent>,
    ) -> wasmtime::Result<String> {
        let content_type = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let content = state.table.get(&self_)?;
            Ok::<String, wasmtime::component::ResourceTableError>(content.content_type())
        })?;
        Ok(content_type)
    }

    async fn request_context(
        accessor: &Accessor<T, Self>,
        self_: wasmtime::component::Resource<InboundContent>,
    ) -> wasmtime::Result<bindgen::witmproxy::plugin::capabilities::RequestContext> {
        let request = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let content = state.table.get(&self_)?;
            Ok::<_, wasmtime::component::ResourceTableError>(content.request_context())
        })?;
        Ok(request)
    }

    /// Take the body, consuming the old handle and returning a fresh,
    /// body-less one alongside the stream.
    ///
    /// Deleting the old table entry is what makes a double-take
    /// unrepresentable: the guest no longer holds a handle it could call
    /// again. Previously this took the body out in place and a second call
    /// silently observed `None`.
    async fn consume_body(
        accessor: &wasmtime::component::Accessor<T, Self>,
        this: wasmtime::component::Resource<InboundContent>,
    ) -> wasmtime::Result<(
        wasmtime::component::StreamReader<u8>,
        wasmtime::component::Resource<InboundContent>,
    )> {
        let (body, remainder) = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            // Take ownership of the whole content, not just its body.
            let mut content = state.table.delete(this)?;
            let body = content.body().unwrap_or(None);
            Ok::<_, wasmtime::component::ResourceTableError>((body, content))
        })?;

        let body = body.ok_or_else(|| {
            // Reachable only if the host itself handed over a content whose
            // body was already taken, which would be a host bug rather than
            // guest misuse -- guest misuse is now a type error.
            wasmtime::Error::msg("content was handed to a guest with no body attached")
        })?;

        accessor.with(|mut access| {
            let handle = {
                let state: &mut WitmProxyCtxView = &mut access.get();
                state.table.push(remainder)?
            };
            let reader = {
                let store = &mut access.as_context_mut();
                StreamReader::new(store, BodyStreamProducer::new(body))?
            };
            Ok::<_, wasmtime::Error>((reader, handle))
        })
    }

    async fn set_body(
        accessor: &wasmtime::component::Accessor<T, Self>,
        self_: wasmtime::component::Resource<InboundContent>,
        content: wasmtime::component::StreamReader<u8>,
    ) -> wasmtime::Result<()> {
        // Convert StreamReader back to UnsyncBoxBody
        // This requires reading the stream and converting it to a body
        // using a channel-based approach

        use http_body::Frame;
        use http_body_util::StreamBody;

        // Create the channel within the ambient tokio runtime context
        let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, ErrorCode>>(65536);
        let body = StreamBody::new(tokio_stream::wrappers::ReceiverStream::new(rx)).boxed_unsync();

        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let content = state.table.get_mut(&self_)?;
            content.set_body(body);
            Ok::<(), wasmtime::component::ResourceTableError>(())
        })?;

        // Create a StreamConsumer that forwards data to the channel.
        //
        // The guest supplies this stream, so its length is guest-controlled and
        // unrelated to the size of the request that triggered the event: without
        // a cap, a plugin can answer a small request with an unbounded response
        // and turn the proxy into an amplifier.
        struct ChannelStreamConsumer {
            tx: PollSender<Result<Frame<Bytes>, ErrorCode>>,
            /// Bytes forwarded so far.
            written: u64,
            /// `0` means unbounded.
            max_bytes: u64,
            breaches: Arc<BreachRecorder>,
            /// Set once the cap trips, so the breach is reported exactly once
            /// even if the consumer is polled again.
            tripped: bool,
        }

        impl<D> wasmtime::component::StreamConsumer<D> for ChannelStreamConsumer {
            type Item = u8;

            fn poll_consume(
                mut self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                store: StoreContextMut<D>,
                source: Source<Self::Item>,
                finish: bool,
            ) -> Poll<wasmtime::Result<StreamResult>> {
                // First check if channel is ready to receive data
                match self.tx.poll_reserve(cx) {
                    Poll::Ready(Ok(())) => {
                        // Channel is ready, read from source
                        let mut src = source.as_direct(store);
                        let buf = src.remaining();
                        let n = buf.len();

                        // Only send frame if there's data
                        if n > 0 {
                            let max = self.max_bytes;
                            let projected = self.written.saturating_add(n as u64);

                            if !body_chunk_admitted(self.written, n as u64, max) {
                                // Fail the body rather than truncating it. A
                                // silently short body is worse than a failed
                                // one: truncated JSON or HTML can parse as
                                // valid-but-wrong downstream, whereas an error
                                // frame surfaces as a failed response.
                                if !self.tripped {
                                    self.tripped = true;
                                    self.breaches.record(
                                        LimitKind::ResponseBodyBytes,
                                        projected,
                                        max,
                                    );
                                }
                                let _ = self.tx.send_item(Err(ErrorCode::InternalError(Some(
                                    format!(
                                        "plugin response body exceeded the configured \
                                         limit of {max} bytes"
                                    ),
                                ))));
                                return Poll::Ready(Ok(StreamResult::Dropped));
                            }

                            let buf = Bytes::copy_from_slice(buf);
                            match self.tx.send_item(Ok(Frame::data(buf))) {
                                Ok(()) => {
                                    src.mark_read(n);
                                    self.written = projected;
                                    Poll::Ready(Ok(StreamResult::Completed))
                                }
                                Err(..) => {
                                    // Receiver dropped
                                    Poll::Ready(Ok(StreamResult::Dropped))
                                }
                            }
                        } else {
                            // No data available, signal completion
                            Poll::Ready(Ok(StreamResult::Completed))
                        }
                    }
                    Poll::Ready(Err(..)) => {
                        // Channel closed
                        Poll::Ready(Ok(StreamResult::Dropped))
                    }
                    Poll::Pending if finish => {
                        // Stream is finishing but channel not ready
                        Poll::Ready(Ok(StreamResult::Cancelled))
                    }
                    Poll::Pending => Poll::Pending,
                }
            }
        }

        // Pipe the stream reader to the channel consumer, carrying this
        // plugin's effective body cap.
        let poll_sender = PollSender::new(tx);
        accessor.with(|mut access| {
            let (max_bytes, breaches) = {
                let state: &mut WitmProxyCtxView = &mut access.get();
                (state.limits().max_response_body_bytes, state.breaches())
            };
            let _ = content.pipe(
                &mut access,
                ChannelStreamConsumer {
                    tx: poll_sender,
                    written: 0,
                    max_bytes,
                    breaches,
                    tripped: false,
                },
            );
        });

        Ok(())
    }
}

// Implement the Host traits using the accessor pattern
impl<T> HostLocalStorageClientWithStore<T> for WitmProxy {
    async fn set(
        accessor: &Accessor<T, Self>,
        self_: Resource<LocalStorageClient>,
        key: String,
        value: Vec<u8>,
    ) -> wasmtime::Result<Result<(), CapabilityError>> {
        // Clone the client (cheap Arc clone) to use outside the accessor closure
        let client = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let client = state.table.get(&self_)?;
            Ok::<LocalStorageClient, wasmtime::component::ResourceTableError>(client.clone())
        })?;
        if let Err(denied) = client.admitted("set", &key, Some(&value)) {
            return Ok(Err(denied));
        }
        // A quota refusal is reported, not swallowed: the plugin can tell a
        // dropped write from a stored one.
        Ok(if client.set(key, value).await {
            Ok(())
        } else {
            Err(CapabilityError::Denied(
                "local storage quota exceeded".to_string(),
            ))
        })
    }

    async fn get(
        accessor: &Accessor<T, Self>,
        self_: Resource<LocalStorageClient>,
        key: String,
    ) -> wasmtime::Result<Result<Option<Vec<u8>>, CapabilityError>> {
        let client = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let client = state.table.get(&self_)?;
            Ok::<LocalStorageClient, wasmtime::component::ResourceTableError>(client.clone())
        })?;
        if let Err(denied) = client.admitted("get", &key, None) {
            return Ok(Err(denied));
        }
        Ok(Ok(client.get(&key).await.map(|bytes| bytes.to_vec())))
    }

    async fn delete(
        accessor: &Accessor<T, Self>,
        self_: Resource<LocalStorageClient>,
        key: String,
    ) -> wasmtime::Result<Result<(), CapabilityError>> {
        let client = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let client = state.table.get(&self_)?;
            Ok::<LocalStorageClient, wasmtime::component::ResourceTableError>(client.clone())
        })?;
        if let Err(denied) = client.admitted("delete", &key, None) {
            return Ok(Err(denied));
        }
        client.delete(&key).await;
        Ok(Ok(()))
    }

    async fn drop(
        accessor: &Accessor<T, Self>,
        rep: Resource<LocalStorageClient>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            state.table.delete(rep)
        })?;
        Ok(())
    }
}

impl<T> HostAnnotatorClientWithStore<T> for WitmProxy {
    async fn annotate(
        accessor: &Accessor<T, Self>,
        self_: Resource<AnnotatorClient>,
        content: Resource<InboundContent>,
    ) -> wasmtime::Result<Result<(), CapabilityError>> {
        let res = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let annotator = state.table.get(&self_)?;
            let content = state.table.get(&content)?;
            Ok::<_, wasmtime::component::ResourceTableError>(
                match admit(&annotator.admission, "annotate", Vec::new(), 0) {
                    Ok(()) => {
                        annotator.annotate(content);
                        Ok(())
                    }
                    Err(denied) => Err(denied),
                },
            )
        })?;
        Ok(res)
    }

    async fn drop(
        accessor: &Accessor<T, Self>,
        rep: Resource<AnnotatorClient>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            state.table.delete(rep)
        })?;
        Ok(())
    }
}

/// One log level's host method: admit through the logger's scope, then log.
macro_rules! logger_level {
    ($name:ident) => {
        async fn $name(
            accessor: &Accessor<T, Self>,
            self_: Resource<Logger>,
            message: String,
        ) -> wasmtime::Result<Result<(), CapabilityError>> {
            let res = accessor.with(|mut access| {
                let state: &mut WitmProxyCtxView = &mut access.get();
                let logger = state.table.get(&self_)?;
                Ok::<_, wasmtime::component::ResourceTableError>(
                    match logger.admitted(stringify!($name), &message) {
                        Ok(()) => {
                            logger.$name(message);
                            Ok(())
                        }
                        Err(denied) => Err(denied),
                    },
                )
            })?;
            Ok(res)
        }
    };
}

impl<T> HostLoggerWithStore<T> for WitmProxy {
    logger_level!(info);
    logger_level!(warn);
    logger_level!(error);
    logger_level!(debug);

    async fn drop(accessor: &Accessor<T, Self>, rep: Resource<Logger>) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            state.table.delete(rep)
        })?;
        Ok(())
    }
}

/// One clock method: admit through the clock's scope, then read.
macro_rules! clock_method {
    ($name:ident, $wit:literal, $ty:ty) => {
        async fn $name(
            accessor: &Accessor<T, Self>,
            self_: Resource<ClockClient>,
        ) -> wasmtime::Result<Result<$ty, CapabilityError>> {
            let res = accessor.with(|mut access| {
                let state: &mut WitmProxyCtxView = &mut access.get();
                let client = state.table.get(&self_)?;
                Ok::<_, wasmtime::component::ResourceTableError>(
                    client.admitted($wit).map(|()| client.$name()),
                )
            })?;
            Ok(res)
        }
    };
}

impl<T> HostClockClientWithStore<T> for WitmProxy {
    clock_method!(now_seconds, "now-seconds", u64);
    clock_method!(now_millis, "now-millis", u64);
    clock_method!(utc_offset_seconds, "utc-offset-seconds", i32);

    async fn drop(
        accessor: &Accessor<T, Self>,
        rep: Resource<ClockClient>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            state.table.delete(rep)
        })?;
        Ok(())
    }
}

impl<T> HostCapabilityProviderWithStore<T> for WitmProxy {
    async fn logger(
        accessor: &Accessor<T, Self>,
        cap: Resource<CapabilityProvider>,
    ) -> wasmtime::Result<Option<Resource<Logger>>> {
        Ok(accessor
            .with(|mut access| {
                let state: &mut WitmProxyCtxView = &mut access.get();
                let provider = state.table.get(&cap)?;
                // Get a clone of the logger if granted (cheap clone)
                match provider.logger() {
                    Some(logger) => Ok::<
                        Option<Resource<Logger>>,
                        wasmtime::component::ResourceTableError,
                    >(Some(state.table.push(logger)?)),
                    None => Ok(None),
                }
            })
            .unwrap_or(None))
    }

    async fn local_storage(
        accessor: &Accessor<T, Self>,
        cap: Resource<CapabilityProvider>,
    ) -> wasmtime::Result<Option<Resource<LocalStorageClient>>> {
        Ok(accessor
            .with(|mut access| {
                let state: &mut WitmProxyCtxView = &mut access.get();
                let provider = state.table.get(&cap)?;
                // Get a clone of the local storage client if granted (cheap Arc clone)
                match provider.local_storage() {
                    Some(client) => Ok::<
                        Option<Resource<LocalStorageClient>>,
                        wasmtime::component::ResourceTableError,
                    >(Some(state.table.push(client)?)),
                    None => Ok(None),
                }
            })
            .unwrap_or(None))
    }

    async fn annotator(
        accessor: &Accessor<T, Self>,
        cap: Resource<CapabilityProvider>,
    ) -> wasmtime::Result<Option<Resource<AnnotatorClient>>> {
        Ok(accessor
            .with(|mut access| {
                let state: &mut WitmProxyCtxView = &mut access.get();
                let provider = state.table.get(&cap)?;
                // Get a clone of the annotator client if granted (cheap clone)
                match provider.annotator() {
                    Some(client) => Ok::<
                        Option<Resource<AnnotatorClient>>,
                        wasmtime::component::ResourceTableError,
                    >(Some(state.table.push(client)?)),
                    None => Ok(None),
                }
            })
            .unwrap_or(None))
    }

    async fn clock(
        accessor: &Accessor<T, Self>,
        cap: Resource<CapabilityProvider>,
    ) -> wasmtime::Result<Option<Resource<ClockClient>>> {
        Ok(accessor
            .with(|mut access| {
                let state: &mut WitmProxyCtxView = &mut access.get();
                let provider = state.table.get(&cap)?;
                match provider.clock() {
                    Some(client) => Ok::<
                        Option<Resource<ClockClient>>,
                        wasmtime::component::ResourceTableError,
                    >(Some(state.table.push(client)?)),
                    None => Ok(None),
                }
            })
            .unwrap_or(None))
    }

    async fn drop(
        accessor: &Accessor<T, Self>,
        rep: Resource<CapabilityProvider>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            state.table.delete(rep)
        })?;
        Ok(())
    }
}

// Implement the generated capabilities::Host trait
impl bindgen::witmproxy::plugin::capabilities::Host for WitmProxyCtxView<'_> {}

// Implement the non-WithStore traits for WitmProxyCtxView
impl HostContent for WitmProxyCtxView<'_> {}
impl HostCapabilityProvider for WitmProxyCtxView<'_> {}
impl HostLocalStorageClient for WitmProxyCtxView<'_> {}
impl HostAnnotatorClient for WitmProxyCtxView<'_> {}
impl HostLogger for WitmProxyCtxView<'_> {}
impl HostClockClient for WitmProxyCtxView<'_> {}

impl WasiView for Host {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl wasmtime_wasi_http::WasiHttpView for Host {
    fn http(&mut self) -> wasmtime_wasi_http::WasiHttpCtxView<'_> {
        wasmtime_wasi_http::WasiHttpCtxView {
            table: &mut self.table,
            ctx: &mut self.http,
            hooks: Default::default(),
        }
    }
}

/// Add all the `witmproxy:plugin` world's interfaces to a [`wasmtime::component::Linker`].
pub fn add_to_linker<T: Send + 'static>(
    l: &mut wasmtime::component::Linker<T>,
    f: fn(&mut T) -> WitmProxyCtxView<'_>,
) -> Result<()> {
    bindgen::witmproxy::plugin::capabilities::add_to_linker::<_, WitmProxy>(l, f)?;
    Ok(())
}

struct WitmProxy;

impl HasData for WitmProxy {
    type Data<'a> = WitmProxyCtxView<'a>;
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    use crate::plugins::membranes::Membranes;

    fn scoped(tag: &'static str, allow: &str) -> (Arc<Membranes>, Admission) {
        let membranes = Arc::new(Membranes::builtin().expect("environments"));
        let instance = membranes
            .mint(tag, &ezcap::Scope::allow(allow))
            .expect("scope compiles");
        let admission = Admission::new(Arc::clone(&membranes), tag, instance, "ezco/test");
        (membranes, admission)
    }

    #[test]
    fn a_scoped_logger_refuses_messages_outside_its_prefix() {
        let (_m, adm) = scoped("logger", r#"call.args.message.startsWith("[ok]")"#);
        let logger = Logger::new().with_admission(Some(adm));
        assert!(logger.admitted("info", "[ok] fine").is_ok());
        assert!(matches!(
            logger.admitted("info", "not fine"),
            Err(CapabilityError::Denied(_))
        ));
        // An unscoped logger admits everything.
        assert!(Logger::new().admitted("info", "anything").is_ok());
    }

    #[tokio::test]
    async fn a_scoped_storage_client_confines_keys_and_sees_the_caller() {
        let (_m, adm) = scoped(
            "local_storage",
            r#"caller.plugin == "ezco/test" && call.args.key.startsWith("seen/")"#,
        );
        let client = LocalStorageClient::new().with_admission(Some(adm));
        assert!(client.admitted("set", "seen/a", Some(b"v")).is_ok());
        assert!(client.admitted("delete", "other/a", None).is_err());
        // The clause binds `call.args.value` too: a size limit is expressible.
        let (_m2, adm2) = scoped("local_storage", "size(call.args.value) <= 2");
        let client = LocalStorageClient::new().with_admission(Some(adm2));
        assert!(client.admitted("set", "k", Some(b"ab")).is_ok());
        assert!(client.admitted("set", "k", Some(b"abc")).is_err());
    }

    #[test]
    fn a_budgeted_clock_stops_after_its_call_count() {
        let (_m, adm) = scoped("clock", "state.calls < 2");
        let clock = ClockClient::new().with_admission(Some(adm));
        assert!(clock.admitted("now-seconds").is_ok());
        assert!(clock.admitted("now-millis").is_ok());
        assert!(
            clock.admitted("now-seconds").is_err(),
            "third call exceeds the budget"
        );
    }
}
