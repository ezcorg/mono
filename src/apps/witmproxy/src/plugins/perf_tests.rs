//! Performance-characteristic tests for the plugin execution path.

use crate::events::Event;
use crate::test_utils::{create_plugin_registry, test_component_path};
use bytes::Bytes;
use http_body_util::Full;
use hyper::{Method, Request};
use std::time::{Duration, Instant};
use wasmtime_wasi_http::p3::Request as WasiRequest;

/// Build a fresh Request event each call (events are consumed by handle_event).
fn make_request_event() -> Box<dyn Event> {
    let req = Request::builder()
        .method(Method::GET)
        .uri("https://example.com/test")
        .header("host", "example.com")
        .body(Full::new(Bytes::from("test body")))
        .unwrap();
    let (wasi_req, _io) = WasiRequest::from_http(wasmtime_wasi_http::default_hooks(), req);
    Box::new(wasi_req)
}

/// A plugin invoked many times must only pay component import-resolution
/// (`InstancePre` construction) ONCE — the expensive part of instantiation must
/// not be re-paid on every request. This asserts the resolution counter stays
/// at 1 across N events (it would equal N without the `InstancePre` cache), and
/// also observes that warm per-call latency is far below the cold first call.
#[tokio::test]
async fn instantiation_cost_is_not_repaid_per_event() {
    let (registry, _tmp) = create_plugin_registry().await.unwrap();
    let wasm_path = test_component_path().unwrap();
    let bytes = std::fs::read(&wasm_path).unwrap();
    let plugin = registry.plugin_from_component(bytes).await.unwrap();
    registry.register_plugin(plugin).await.unwrap();

    const N: usize = 25;
    let mut durations = Vec::new();
    for _ in 0..N {
        let event = make_request_event();
        let t = Instant::now();
        let _ = registry.handle_event(event).await.unwrap();
        durations.push(t.elapsed().as_micros());
    }

    let resolutions = registry.instance_pre_resolutions();
    let first = durations[0];
    let mut rest = durations[1..].to_vec();
    rest.sort_unstable();
    let median_rest = rest[rest.len() / 2];
    eprintln!(
        "instantiation: resolutions={resolutions} first={first}us median_rest={median_rest}us"
    );

    // The core guarantee: import resolution happens exactly once for a plugin,
    // regardless of how many events it handles. Without InstancePre caching this
    // would be N.
    assert_eq!(
        resolutions, 1,
        "expected exactly one import resolution across {N} events, got {resolutions}"
    );
}

/// A registry mutation (plugin upload/removal) must not serialize behind an
/// in-flight event, and — because a queued writer on a fair RwLock would also
/// block every NEW reader — must not stall new requests either. Production
/// shares the registry between the proxy request path (which uses it across
/// guest execution, bounded only by `plugins.timeout_ms`, default 1000ms) and
/// the web server's plugin-management endpoints.
///
/// This simulates an in-flight event holding a plugin-map snapshot (what
/// `handle_event` holds across guest execution) for 500ms and asserts a
/// concurrent registration completes promptly instead of waiting for the
/// in-flight event to finish. Before the lock-free registry this test held
/// `Arc<tokio::sync::RwLock<PluginRegistry>>`'s read side instead, and the
/// registration took the full ~450ms.
#[tokio::test]
async fn mutation_is_not_serialized_behind_inflight_event() {
    let (registry, _tmp) = create_plugin_registry().await.unwrap();
    let wasm_path = test_component_path().unwrap();
    let bytes = std::fs::read(&wasm_path).unwrap();

    // Share the registry the way production does (lib.rs / proxy / web server).
    let registry = std::sync::Arc::new(registry);

    // Parse/compile the plugin up front so only the registration itself is timed.
    let plugin = registry.plugin_from_component(bytes).await.unwrap();

    // Simulate an in-flight event: handle_event takes one snapshot of the
    // plugin map and uses it across guest execution.
    let inflight = {
        let registry = registry.clone();
        tokio::spawn(async move {
            let snapshot = registry.plugins();
            tokio::time::sleep(Duration::from_millis(500)).await;
            // The snapshot is isolated: the mutation that happened meanwhile
            // must not be visible to the in-flight event's view.
            assert!(
                snapshot.is_empty(),
                "in-flight snapshot must keep its consistent (pre-mutation) view"
            );
        })
    };
    // Let the in-flight task actually take its snapshot.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let t = Instant::now();
    registry.register_plugin(plugin).await.unwrap();
    let elapsed = t.elapsed();

    assert!(
        elapsed < Duration::from_millis(200),
        "plugin registration took {elapsed:?}; it serialized behind the in-flight event"
    );
    // A fresh snapshot (a new request) sees the registered plugin immediately,
    // even while the in-flight event is still running.
    assert_eq!(registry.plugins().len(), 1);
    inflight.await.unwrap();
}
