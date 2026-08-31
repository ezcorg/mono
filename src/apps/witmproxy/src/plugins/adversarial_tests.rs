//! Adversarial tests: hostile plugin behaviour exercised against the host.
//!
//! Split into two layers.
//!
//! * **Unit tests** drive the quota machinery directly. They are fast and
//!   deterministic, and they pin the exact accounting rules -- including the
//!   ones an attacker would probe for, such as whether re-acquiring a
//!   capability resets its budget.
//! * **Integration tests** run the real `witmproxy-plugin-adversarial`
//!   component through the registry. They are the ones that would catch a
//!   regression in how the limits are *wired*, as opposed to how they are
//!   computed. They build the component on demand.
//!
//! Every case asserts two things: the host survives, and the operator can tell
//! it happened.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use bytes::Bytes;
use http_body_util::Full;
use hyper::{Method, Request};
use wasmtime_wasi_http::p3::Request as WasiRequest;

use crate::events::Event;
use crate::plugins::limits::{BreachRecorder, LimitOverrides, RecoveryPolicy, ResolvedLimits};
use crate::plugins::{WitmPlugin, capabilities::Capability};
use crate::test_utils::{adversarial_component_path, create_plugin_registry};
use crate::wasm::bindgen::exports::witmproxy::plugin::witm_plugin::{ActualInput, UserInput};
use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
    Capability as WitCapability, CapabilityKind, CapabilityScope, EventKind,
};
use crate::wasm::{LocalStorageClient, Logger, body_chunk_admitted};

// ---------------------------------------------------------------------------
// Unit: local storage quotas
//
// This map lives in HOST memory and outlives any single event, so it is not
// covered by the guest linear-memory cap. Before these quotas existed a plugin
// could grow the daemon's resident set without bound while staying entirely
// inside `max_memory_mb`.
// ---------------------------------------------------------------------------

fn storage_with(max_bytes: u64, max_keys: u64) -> (LocalStorageClient, Arc<BreachRecorder>) {
    let limits = ResolvedLimits {
        max_local_storage_bytes: max_bytes,
        max_local_storage_keys: max_keys,
        ..ResolvedLimits::DEFAULTS
    };
    let rec = BreachRecorder::new("test/adversarial");
    (
        LocalStorageClient::with_limits(&limits, Arc::clone(&rec)),
        rec,
    )
}

#[tokio::test]
async fn storage_refuses_writes_past_the_byte_quota() {
    let (store, breaches) = storage_with(1024, 0);

    assert!(store.set("k1".into(), vec![0u8; 500]).await);
    assert!(store.set("k2".into(), vec![0u8; 400]).await);
    // Would take the total past 1024.
    assert!(
        !store.set("k3".into(), vec![0u8; 500]).await,
        "write past the byte quota must be refused"
    );

    assert!(store.bytes_used() <= 1024, "quota must hold");
    assert_eq!(breaches.count(), 1, "the breach must be recorded");
    assert!(store.get("k3").await.is_none(), "refused write must not land");
    assert!(store.get("k1").await.is_some(), "earlier writes survive");
}

#[tokio::test]
async fn storage_refuses_writes_past_the_key_quota() {
    let (store, breaches) = storage_with(0, 2);

    assert!(store.set("a".into(), vec![1]).await);
    assert!(store.set("b".into(), vec![1]).await);
    assert!(
        !store.set("c".into(), vec![1]).await,
        "write past the key quota must be refused"
    );
    assert_eq!(breaches.count(), 1);

    // Overwriting an EXISTING key is not a new key and must still be allowed:
    // otherwise a plugin at its key limit could never update its own state.
    assert!(
        store.set("a".into(), vec![2, 2]).await,
        "overwriting an existing key is not a new allocation"
    );
}

#[tokio::test]
async fn storage_accounting_survives_overwrite_and_delete() {
    let (store, _) = storage_with(1024, 0);

    assert!(store.set("k".into(), vec![0u8; 500]).await);
    let after_first = store.bytes_used();

    // An overwrite must replace, not accumulate; otherwise a plugin could
    // exhaust the quota by rewriting one key in a loop.
    assert!(store.set("k".into(), vec![0u8; 500]).await);
    assert_eq!(
        store.bytes_used(),
        after_first,
        "overwrite must not double-count"
    );

    store.delete("k").await;
    assert_eq!(store.bytes_used(), 0, "delete must release the accounting");

    // ...and the freed budget is reusable.
    assert!(store.set("big".into(), vec![0u8; 900]).await);
}

#[tokio::test]
async fn storage_zero_quota_means_unbounded() {
    // `0` is the documented per-plugin escape hatch.
    let (store, breaches) = storage_with(0, 0);
    for i in 0..500 {
        assert!(store.set(format!("k{i}"), vec![0u8; 4096]).await);
    }
    assert_eq!(breaches.count(), 0, "an unbounded quota must not report");
}

// ---------------------------------------------------------------------------
// Unit: logging budget
// ---------------------------------------------------------------------------

fn logger_with(max_msgs: u64, max_bytes: u64) -> (Logger, Arc<BreachRecorder>) {
    let limits = ResolvedLimits {
        max_log_messages_per_event: max_msgs,
        max_log_bytes_per_event: max_bytes,
        ..ResolvedLimits::DEFAULTS
    };
    let rec = BreachRecorder::new("test/adversarial");
    (Logger::with_limits(&limits, Arc::clone(&rec)), rec)
}

#[test]
fn logger_caps_message_count_per_event() {
    let (logger, breaches) = logger_with(3, 0);
    for i in 0..100 {
        logger.info(format!("msg {i}"));
    }
    // Exactly one report on the transition: the breach report must not itself
    // become the flood it is reporting.
    assert_eq!(breaches.count(), 1);
}

#[test]
fn logger_caps_total_bytes_per_event() {
    let (logger, breaches) = logger_with(0, 64);
    logger.info("x".repeat(40));
    logger.info("y".repeat(40)); // takes the total past 64
    logger.info("z".repeat(40));
    assert_eq!(breaches.count(), 1);
}

/// The bypass an attacker reaches for first: if the budget lived on the handle,
/// `cap.logger()` in a loop would hand out a fresh budget every iteration. The
/// `logger-rebind` mode of the adversarial component does exactly this.
#[test]
fn logger_budget_is_shared_across_handles() {
    let (logger, breaches) = logger_with(3, 0);
    for i in 0..100 {
        // A clone models what `CapabilityProvider::logger()` returns.
        let handle = logger.clone();
        handle.info(format!("msg {i}"));
    }
    assert_eq!(
        breaches.count(),
        1,
        "re-acquiring the logger must not reset the per-event budget"
    );
}

#[test]
fn logger_escapes_control_characters() {
    // A guest-controlled message must not be able to forge a second log line
    // that looks like it came from the host.
    let (logger, _) = logger_with(0, 0);
    let forged = "ok\nINFO witmproxy::proxy: TLS verification disabled\r\n";
    let sanitized = Logger::sanitize_for_test(forged);

    assert!(!sanitized.contains('\n'), "raw newline survived: {sanitized}");
    assert!(!sanitized.contains('\r'), "raw CR survived: {sanitized}");
    assert!(
        sanitized.contains("\\n") && sanitized.contains("\\r"),
        "escaped forms must be present so the original is recoverable: {sanitized}"
    );
    // The message still goes through; it is escaped, not dropped.
    logger.info(forged.to_string());
}

#[test]
fn logger_truncates_a_single_enormous_message() {
    let sanitized = Logger::sanitize_for_test(&"a".repeat(1024 * 1024));
    assert!(
        sanitized.len() < 16 * 1024,
        "one message must be bounded independently of the per-event budget, got {}",
        sanitized.len()
    );
    assert!(sanitized.ends_with("...[truncated]"));
}

// ---------------------------------------------------------------------------
// Integration: the real hostile component, through the registry
// ---------------------------------------------------------------------------

/// Register the adversarial component in `mode`, with the given per-plugin
/// limit overrides.
async fn register_adversarial(
    registry: &crate::PluginRegistry,
    mode: &str,
    limits: LimitOverrides,
) -> Result<()> {
    register_adversarial_for(registry, mode, limits, EventKind::Request).await
}

async fn register_adversarial_for(
    registry: &crate::PluginRegistry,
    mode: &str,
    limits: LimitOverrides,
    event_kind: EventKind,
) -> Result<()> {
    let component_bytes = std::fs::read(adversarial_component_path()?)?;
    let component = Some(wasmtime::component::Component::from_binary(
        &registry.runtime.engine,
        &component_bytes,
    )?);

    let cap = |kind| Capability {
        granted: true,
        inner: WitCapability {
            kind,
            scope: CapabilityScope {
                expression: "true".into(),
            },
        },
        cel: None,
    };

    let plugin = WitmPlugin {
        limits,
        namespace: "test".into(),
        name: "adversarial".into(),
        version: "0.0.1".into(),
        author: "test".into(),
        description: "hostile".into(),
        license: "AGPL-3.0-only".into(),
        url: "https://example.invalid".into(),
        publickey: vec![],
        enabled: true,
        capabilities: vec![
            cap(CapabilityKind::Logger),
            cap(CapabilityKind::LocalStorage),
            cap(CapabilityKind::HandleEvent(event_kind)),
        ],
        metadata: std::collections::HashMap::new(),
        configuration: vec![UserInput {
            name: "mode".into(),
            value: ActualInput::Str(mode.into()),
        }],
        component,
        component_bytes,
    };
    // Must go through the test registration helper: `can_handle` needs the
    // capability scope expressions compiled, and without that the plugin is
    // silently never executed and every assertion below passes vacuously.
    registry.register_plugin_for_test(plugin).await
}

/// Assert the registered plugin actually matches the event about to be sent.
///
/// Guards against the failure mode these tests hit during development: with no
/// compiled CEL program `can_handle` returns false, the plugin is silently
/// never executed, and every containment assertion passes vacuously. Any test
/// that does not otherwise prove the guest ran (e.g. by timing) must call this.
fn assert_plugin_will_run(registry: &crate::PluginRegistry, event: &dyn Event) {
    let plugins = registry.plugins();
    assert!(
        plugins.values().any(|p| p.can_handle(event)),
        "no registered plugin matches this event, so the test would pass vacuously"
    );
}

fn sample_request() -> Box<dyn Event> {
    let req = Request::builder()
        .method(Method::GET)
        .uri("https://example.com/adversarial")
        .header("host", "example.com")
        .body(Full::new(Bytes::from("body")))
        .expect("static request builds");
    let (wasi_req, _io) = WasiRequest::from_http(wasmtime_wasi_http::default_hooks(), req);
    Box::new(wasi_req)
}

/// The headline case. A guest spinning in a tight loop never yields, so
/// cancelling the future that drives it cannot stop it; only the epoch deadline
/// can. Before epoch interruption was enabled this pinned a tokio worker
/// thread until fuel ran out -- and forever when fuel was configured as
/// unlimited (`max_fuel = 0`, a documented setting).
///
/// `max_fuel: 0` here is deliberate: it removes the fuel backstop so the test
/// fails if the epoch deadline is what actually stops the guest.
#[tokio::test]
async fn spinning_plugin_is_interrupted_and_the_host_survives() -> Result<()> {
    let (mut registry, _tmp) = create_plugin_registry().await?;
    registry.set_limits(ResolvedLimits {
        max_fuel: 0,
        timeout_ms: 500,
        ..ResolvedLimits::DEFAULTS
    });

    register_adversarial(&registry, "spin", LimitOverrides::default()).await?;

    let event = sample_request();
    assert_plugin_will_run(&registry, &*event);

    let started = Instant::now();
    let result = registry.handle_event(event).await;
    let elapsed = started.elapsed();

    assert!(
        elapsed >= Duration::from_millis(400),
        "the guest must actually have run and spun until the deadline; \
         {elapsed:?} is too fast, which means the plugin was skipped and this \
         test would be passing vacuously"
    );
    assert!(
        elapsed < Duration::from_secs(10),
        "a non-yielding guest must be interrupted, took {elapsed:?}"
    );
    // Fail-closed: the event ends rather than proceeding with state the
    // trapped guest may have consumed. The host surviving is demonstrated by
    // this test returning at all, within the bound asserted above.
    assert!(
        result.is_err(),
        "a guest that trips a limit must fail the event closed, not continue it"
    );
    Ok(())
}

/// A per-plugin timeout must be able to constrain one plugin more tightly than
/// the global default -- the escape hatch working in the tightening direction.
#[tokio::test]
async fn per_plugin_timeout_overrides_a_looser_global() -> Result<()> {
    let (mut registry, _tmp) = create_plugin_registry().await?;
    registry.set_limits(ResolvedLimits {
        max_fuel: 0,
        timeout_ms: 60_000, // deliberately far too generous globally
        ..ResolvedLimits::DEFAULTS
    });

    register_adversarial(
        &registry,
        "spin",
        LimitOverrides {
            timeout_ms: Some(300),
            ..Default::default()
        },
    )
    .await?;

    let event = sample_request();
    assert_plugin_will_run(&registry, &*event);

    let started = Instant::now();
    let _ = registry.handle_event(event).await;
    let elapsed = started.elapsed();

    assert!(
        elapsed >= Duration::from_millis(200),
        "the guest must actually have run; {elapsed:?} means it was skipped"
    );
    assert!(
        elapsed < Duration::from_secs(30),
        "the per-plugin override must win over the 60s global, took {elapsed:?}"
    );
    Ok(())
}

/// A plugin writing 1 MiB per key in a loop must not be able to grow host
/// memory past its quota, and must not take the request down either.
#[tokio::test]
async fn storage_bomb_is_contained() -> Result<()> {
    let (mut registry, _tmp) = create_plugin_registry().await?;
    registry.set_limits(ResolvedLimits {
        max_local_storage_bytes: 4 * 1024 * 1024,
        timeout_ms: 5_000,
        ..ResolvedLimits::DEFAULTS
    });

    register_adversarial(&registry, "storage-bomb", LimitOverrides::default()).await?;

    let event = sample_request();
    assert_plugin_will_run(&registry, &*event);

    let result = registry.handle_event(event).await;
    assert!(
        result.is_err(),
        "exhausting the storage quota must not let the event proceed"
    );
    Ok(())
}

/// Guest memory growth is bounded by the store limiter; the trap must end the
/// event rather than killing the proxy.
#[tokio::test]
async fn memory_bomb_is_contained() -> Result<()> {
    let (mut registry, _tmp) = create_plugin_registry().await?;
    registry.set_limits(ResolvedLimits {
        max_memory_mb: 64,
        timeout_ms: 5_000,
        ..ResolvedLimits::DEFAULTS
    });

    register_adversarial(&registry, "memory-bomb", LimitOverrides::default()).await?;

    let event = sample_request();
    assert_plugin_will_run(&registry, &*event);

    let result = registry.handle_event(event).await;
    assert!(
        result.is_err(),
        "a memory-exhausting guest must fail the event closed"
    );
    Ok(())
}

/// The log-flood and logger-rebind modes must both terminate within the event
/// budget rather than writing 100k lines to the operator's disk.
#[tokio::test]
async fn log_flood_is_contained() -> Result<()> {
    for mode in ["log-flood", "logger-rebind"] {
        let (mut registry, _tmp) = create_plugin_registry().await?;
        registry.set_limits(ResolvedLimits {
            max_log_messages_per_event: 16,
            timeout_ms: 5_000,
            ..ResolvedLimits::DEFAULTS
        });
        register_adversarial(&registry, mode, LimitOverrides::default()).await?;

        let event = sample_request();
        assert_plugin_will_run(&registry, &*event);

        let result = registry.handle_event(event).await;
        assert!(
            result.is_err(),
            "mode {mode}: exhausting the log budget must fail the event closed"
        );
    }
    Ok(())
}

/// A well-behaved event must still pass cleanly through the same machinery:
/// the limits must not be costing correctness on the happy path.
#[tokio::test]
async fn passthrough_plugin_still_works_under_limits() -> Result<()> {
    let (mut registry, _tmp) = create_plugin_registry().await?;
    registry.set_limits(ResolvedLimits::DEFAULTS);
    register_adversarial(&registry, "passthrough", LimitOverrides::default()).await?;

    let event = sample_request();
    assert_plugin_will_run(&registry, &*event);

    let result = registry.handle_event(event).await;
    assert!(result.is_ok(), "a benign plugin must not be impeded");

    let _ = HashSet::<String>::new(); // keep the import honest if trimmed later
    Ok(())
}

// ---------------------------------------------------------------------------
// Response body amplification
//
// The stream handed to `content.set-body` is guest-controlled and unrelated to
// the size of the request that triggered the event, so without a cap a plugin
// can answer a small request with an unbounded response.
// ---------------------------------------------------------------------------

#[test]
fn body_cap_admits_up_to_the_limit_and_no_further() {
    assert!(body_chunk_admitted(0, 100, 100), "exactly at the cap fits");
    assert!(!body_chunk_admitted(0, 101, 100), "one past the cap does not");
    assert!(body_chunk_admitted(90, 10, 100), "a chunk that lands on the cap fits");
    assert!(!body_chunk_admitted(90, 11, 100), "a chunk that crosses it does not");
}

#[test]
fn body_cap_zero_means_unbounded() {
    // The documented per-plugin escape hatch.
    assert!(body_chunk_admitted(u64::MAX - 1, u64::MAX, 0));
}

#[test]
fn body_cap_arithmetic_saturates() {
    // A guest-supplied length must not be able to wrap the accounting into
    // looking like it fits.
    assert!(
        !body_chunk_admitted(u64::MAX, u64::MAX, 1024),
        "saturating add must not wrap around into an admitted chunk"
    );
}

/// End-to-end: a plugin streaming ~1 GiB into `set-body` under a small cap must
/// not take the host down, and the event must still complete.
#[tokio::test]
async fn body_bomb_is_contained() -> Result<()> {
    use crate::events::content::InboundContent;
    use http_body_util::BodyExt;

    let (mut registry, _tmp) = create_plugin_registry().await?;
    registry.set_limits(ResolvedLimits {
        max_response_body_bytes: 64 * 1024,
        timeout_ms: 10_000,
        ..ResolvedLimits::DEFAULTS
    });

    register_adversarial_for(
        &registry,
        "body-bomb",
        LimitOverrides::default(),
        EventKind::InboundContent,
    )
    .await?;

    let (parts, _) = hyper::Response::new(()).into_parts();
    let body = http_body_util::Full::new(Bytes::from_static(b"<html>original</html>"))
        .map_err(|_| {
            wasmtime_wasi_http::p3::bindings::http::types::ErrorCode::InternalError(None)
        })
        .boxed_unsync();
    let content = InboundContent::new(parts, "text/html".to_string(), body)?;

    let event: Box<dyn Event> = Box::new(content);
    assert_plugin_will_run(&registry, &*event);

    let result = registry.handle_event(event).await;
    assert!(
        result.is_err(),
        "an oversized replacement body must fail the event closed rather than \
         streaming an unbounded response"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Recovery policy
// ---------------------------------------------------------------------------

/// `handle` returning `none` means "abandon further processing", not "pass the
/// event through". The implementation previously did the latter, contradicting
/// the WIT's own doc comment; a plugin that simply does not care about an event
/// says so by returning the event unchanged.
#[tokio::test]
async fn returning_none_terminates_handling() -> Result<()> {
    let (mut registry, _tmp) = create_plugin_registry().await?;
    registry.set_limits(ResolvedLimits::DEFAULTS);
    register_adversarial(&registry, "terminate", LimitOverrides::default()).await?;

    let event = sample_request();
    assert_plugin_will_run(&registry, &*event);

    let result = registry.handle_event(event).await;
    assert!(
        result.is_err(),
        "`none` must end the event, not continue the chain with it"
    );
    Ok(())
}

/// A plugin that returns the event unchanged is saying "not for me" and must
/// pass straight through. This is the case that would break if `none` and
/// "unchanged" were ever conflated again.
#[tokio::test]
async fn returning_the_event_unchanged_passes_through() -> Result<()> {
    let (mut registry, _tmp) = create_plugin_registry().await?;
    registry.set_limits(ResolvedLimits::DEFAULTS);
    register_adversarial(&registry, "passthrough", LimitOverrides::default()).await?;

    let event = sample_request();
    assert_plugin_will_run(&registry, &*event);

    assert!(
        registry.handle_event(event).await.is_ok(),
        "an unchanged event must continue the chain"
    );
    Ok(())
}

/// `fail-open` is configurable but unimplemented. Selecting it must be safe:
/// the host degrades to fail-closed and says so, rather than attempting a
/// recovery it has no machinery for.
#[tokio::test]
async fn fail_open_degrades_safely_until_implemented() -> Result<()> {
    let (mut registry, _tmp) = create_plugin_registry().await?;
    registry.set_limits(ResolvedLimits {
        max_fuel: 0,
        timeout_ms: 300,
        recovery: RecoveryPolicy::FailOpen,
        ..ResolvedLimits::DEFAULTS
    });
    register_adversarial(&registry, "spin", LimitOverrides::default()).await?;

    let event = sample_request();
    assert_plugin_will_run(&registry, &*event);

    let result = registry.handle_event(event).await;
    assert!(
        result.is_err(),
        "fail-open has no implementation yet and must degrade to fail-closed"
    );
    Ok(())
}

/// The recovery policy is per-plugin overridable, like every other dimension.
#[test]
fn recovery_policy_is_per_plugin_overridable() {
    let global = ResolvedLimits {
        recovery: RecoveryPolicy::FailClosed,
        ..ResolvedLimits::DEFAULTS
    };
    let overrides = LimitOverrides {
        recovery: Some(RecoveryPolicy::FailOpen),
        ..Default::default()
    };
    assert_eq!(overrides.resolve(&global).recovery, RecoveryPolicy::FailOpen);
    // ...and the default still inherits.
    assert_eq!(
        LimitOverrides::default().resolve(&global).recovery,
        RecoveryPolicy::FailClosed
    );
}

/// Fail-closed must be what you get without asking, including from an
/// unrecognised configuration value.
#[test]
fn recovery_defaults_to_fail_closed() {
    assert_eq!(RecoveryPolicy::default(), RecoveryPolicy::FailClosed);
    assert_eq!(ResolvedLimits::DEFAULTS.recovery, RecoveryPolicy::FailClosed);
}

// ---------------------------------------------------------------------------
// Structured plugin errors
//
// Reporting failure is data, not a capability: a plugin used to need `logger`
// to say anything, which an operator can decline to grant -- so it fell silent
// exactly when it was least trusted.
// ---------------------------------------------------------------------------

async fn error_from_mode(mode: &str) -> Result<String> {
    let (mut registry, _tmp) = create_plugin_registry().await?;
    registry.set_limits(ResolvedLimits::DEFAULTS);
    register_adversarial(&registry, mode, LimitOverrides::default()).await?;

    let event = sample_request();
    assert_plugin_will_run(&registry, &*event);

    let err = registry
        .handle_event(event)
        .await
        .err()
        .unwrap_or_else(|| panic!("mode {mode}: a reported plugin error must fail the event"));
    Ok(format!("{err:#}"))
}

#[tokio::test]
async fn invalid_configuration_is_reported_by_variant() -> Result<()> {
    let msg = error_from_mode("error-config").await?;
    assert!(
        msg.contains("invalid-configuration"),
        "the variant must be named so it can be matched on, not just described: {msg}"
    );
    Ok(())
}

/// The host has the schema for `capability-kind`, so a plugin can say exactly
/// which grant it is missing and the operator can act on it.
#[tokio::test]
async fn capability_unavailable_names_the_capability() -> Result<()> {
    let msg = error_from_mode("error-capability").await?;
    assert!(msg.contains("capability-unavailable"), "{msg}");
    assert!(
        msg.to_lowercase().contains("annotator"),
        "the missing capability must be identified: {msg}"
    );
    Ok(())
}

/// The message is guest-controlled and crosses the same trust boundary as a log
/// message, so it gets the same escaping. Otherwise closing the logger
/// injection channel would just have moved it.
#[tokio::test]
async fn internal_error_message_is_escaped() -> Result<()> {
    let msg = error_from_mode("error-internal").await?;
    assert!(msg.contains("internal-error"), "{msg}");
    assert!(
        !msg.contains('\n') && !msg.contains('\r'),
        "raw newlines from a guest must not reach the log: {msg:?}"
    );
    assert!(
        !msg.contains('\u{1b}'),
        "escape sequences must not reach a terminal: {msg:?}"
    );
    assert!(
        msg.contains("\\n"),
        "the original content must remain recoverable in escaped form: {msg}"
    );
    Ok(())
}

/// A plugin that reports an error must not be able to keep the event going;
/// the reason is for the operator, and the event still fails closed.
#[tokio::test]
async fn a_reported_error_still_fails_closed() -> Result<()> {
    for mode in ["error-config", "error-capability", "error-internal"] {
        let msg = error_from_mode(mode).await?;
        assert!(
            msg.contains("could not handle"),
            "mode {mode}: the event must fail closed with the reason attached: {msg}"
        );
    }
    Ok(())
}
