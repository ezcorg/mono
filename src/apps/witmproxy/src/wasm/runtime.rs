use crate::plugins::limits::{BreachRecorder, ResolvedLimits};
use crate::wasm::{Host, WitmProxyCtxView, bindgen::Plugin};
use anyhow::Result;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use wasmtime::{
    Config, Engine, Store, StoreLimitsBuilder,
    component::{Component, InstancePre, Linker},
};
use wasmtime_wasi::p3::bindings::LinkOptions;
use wasmtime_wasi_http::WasiHttpView;

/// Epoch tick granularity. Wall-clock timeouts are rounded up to a multiple of
/// this, so it bounds both timeout precision and the ticker's overhead.
const EPOCH_TICK_MS: u64 = 10;

/// Deadline used to mean "no epoch bound".
///
/// Not `u64::MAX`: wasmtime computes the absolute deadline as
/// `current_epoch + ticks_beyond_current`, which overflows and panics on a
/// debug build. Half the range is ~2.9e9 years at `EPOCH_TICK_MS`, which is
/// unbounded for every practical purpose.
const EPOCH_DEADLINE_UNBOUNDED: u64 = u64::MAX / 2;

/// Drives `Engine::increment_epoch` on a background thread so that epoch-based
/// deadlines actually fire.
///
/// A plain OS thread rather than a tokio task on purpose: the ticker must keep
/// running even when every tokio worker is blocked, which is precisely the
/// situation a runaway guest creates -- and it is exactly then that the
/// deadline needs to fire. It also lets `Runtime` be constructed outside a
/// tokio context (tests, CLI paths).
struct EpochTicker {
    stop: Arc<AtomicBool>,
}

impl EpochTicker {
    fn spawn(engine: &Engine) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let engine = engine.weak();
        let flag = Arc::clone(&stop);
        // The handle is intentionally dropped: the ticker runs for the life of
        // the engine and is stopped through the `stop` flag in `Drop`.
        drop(
            std::thread::Builder::new()
            .name("witm-epoch-ticker".into())
            .spawn(move || {
                while !flag.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(EPOCH_TICK_MS));
                    // A weak handle means this thread does not keep the engine
                    // alive; once the engine is dropped the ticker winds down.
                    match engine.upgrade() {
                        Some(engine) => engine.increment_epoch(),
                        None => break,
                    }
                }
            })
            // A failure to spawn would leave epoch deadlines permanently
            // unarmed, silently disabling the timeout. Surfacing it as a log at
            // error level is the best we can do without failing startup.
            .inspect_err(|e| {
                tracing::error!(
                    target: "plugins::limits",
                    error = %e,
                    "failed to spawn the epoch ticker; plugin wall-clock timeouts \
                     will not be enforceable against a non-yielding guest"
                );
            })
            .ok(),
        );
        Self { stop }
    }
}

impl Drop for EpochTicker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub struct Runtime {
    pub engine: Engine,
    pub linker: Linker<Host>,
    /// Global baseline limits. Per-plugin overrides are resolved against these
    /// by the registry; see [`crate::plugins::limits`].
    pub limits: ResolvedLimits,
    /// Kept alive for as long as the runtime is; dropping it stops the ticker.
    _epoch_ticker: Arc<EpochTicker>,
}

impl Runtime {
    pub fn try_default() -> Result<Self> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        config.wasm_component_model_async(true);
        // Fuel bounds pure computation. With this enabled every store starts
        // with 0 fuel and would trap immediately, so `new_store` MUST set it.
        config.consume_fuel(true);
        // Epoch interruption bounds *wall clock*, which fuel cannot: fuel does
        // not advance while a guest is parked in a host call, and cancelling
        // the future that drives a guest does not stop a guest that never
        // yields. Without this, `timeout_ms` is unenforceable against a plugin
        // spinning in a tight loop -- it would pin the worker thread until fuel
        // ran out, or forever when fuel is configured as unbounded.
        config.epoch_interruption(true);

        let engine = Engine::new(&config)?;
        Self::from_engine(engine)
    }

    /// Build a [`Runtime`] that reuses an existing [`Engine`] (a cheap `Arc`
    /// clone), building the linker from that same engine. Reusing the engine
    /// avoids the cross-`Engine` hazard of instantiating a component in a store
    /// whose engine differs from the linker's engine.
    pub fn from_engine(engine: Engine) -> Result<Self> {
        let linker = Self::build_linker(&engine)?;
        let ticker = Arc::new(EpochTicker::spawn(&engine));
        Ok(Self {
            engine,
            linker,
            limits: ResolvedLimits::default(),
            _epoch_ticker: ticker,
        })
    }

    /// Attach the global baseline limits to this runtime.
    pub fn with_limits(mut self, limits: ResolvedLimits) -> Self {
        self.limits = limits;
        self
    }

    /// Construct the linker for the `witmproxy:plugin` world.
    ///
    /// Note: we deliberately register ONLY `wasi:http/types` (so plugins can
    /// inspect/mutate the in-flight request/response) and NOT the outbound
    /// `wasi:http/client` handler — plugins must not be able to make outbound
    /// network requests.
    pub fn build_linker(engine: &Engine) -> Result<Linker<Host>> {
        let mut linker: Linker<Host> = Linker::new(engine);

        // WASI p2 support. This is NOT vestigial after the move to WASI 0.3:
        // guest components built with wit-bindgen still import `wasi:io/poll`
        // at version 0.2.x through the Rust runtime's shims, so removing this
        // fails instantiation with "component imports instance
        // `wasi:io/poll@0.2.6`, but a matching implementation was not found".
        // Verified by removing it and running the suite. Revisit when the
        // guest toolchain no longer emits p2 imports.
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;

        // Add WASI p3 support (clocks, random, io, ...)
        let options = LinkOptions::default();
        wasmtime_wasi::p3::add_to_linker_with_options(&mut linker, &options)?;

        // Add ONLY the `wasi:http/types` interface (request/response resource
        // methods). We intentionally omit `wasi:http/client` (the outbound
        // handler) so plugins cannot make outbound HTTP requests.
        wasmtime_wasi_http::p3::bindings::http::types::add_to_linker::<
            _,
            wasmtime_wasi_http::WasiHttp,
        >(&mut linker, <Host as WasiHttpView>::http)?;

        // Add our custom host capabilities using the wrapper pattern
        crate::wasm::add_to_linker(&mut linker, |host: &mut Host| {
            WitmProxyCtxView::new(&host.witmproxy_ctx, &mut host.table)
        })?;

        Ok(linker)
    }

    /// Create a store carrying `limits`.
    ///
    /// Unlike the previous version this installs a limiter unconditionally, so
    /// the table/instance dimensions are bounded even when no memory cap is
    /// configured. Table and instance growth is host allocation that a linear
    /// memory cap does not cover, so leaving them unbounded left a way to
    /// exhaust host memory while staying inside `max_memory_mb`.
    pub fn new_store(
        &self,
        limits: &ResolvedLimits,
        breaches: Arc<BreachRecorder>,
    ) -> Result<Store<Host>> {
        // The limits travel with the store so that host capability
        // implementations -- which see only the store, never the registry --
        // can enforce quotas on guest-driven work such as `content.set-body`.
        let mut store = Store::new(&self.engine, Host::with_context(*limits, breaches));

        // Give every store an unbounded fuel baseline; the real per-call cap is
        // applied by `apply_call_limits` right before invoking guest functions,
        // so host-side work (instantiation, manifest calls) is never metered.
        // `set_fuel` only fails when fuel metering is disabled engine-wide,
        // which `try_default` guarantees it is not.
        store
            .set_fuel(u64::MAX)
            .map_err(|e| anyhow::anyhow!("failed to set store fuel baseline: {e}"))?;

        // Same for the epoch deadline, and for the same reason. With
        // `epoch_interruption` enabled a store begins with its deadline already
        // in the past, so without this baseline the very first guest call --
        // including the `manifest()` call made while *loading* a plugin --
        // traps with `wasm trap: interrupt` before executing an instruction.
        store.set_epoch_deadline(EPOCH_DEADLINE_UNBOUNDED);

        let mut builder = StoreLimitsBuilder::new();
        if limits.max_memory_mb > 0 {
            let bytes = usize::try_from(limits.max_memory_mb)
                .unwrap_or(usize::MAX)
                .saturating_mul(1024 * 1024);
            builder = builder.memory_size(bytes);
        }
        if limits.max_table_elements > 0 {
            builder =
                builder.table_elements(usize::try_from(limits.max_table_elements).unwrap_or(usize::MAX));
        }
        if limits.max_instances > 0 {
            builder = builder.instances(usize::try_from(limits.max_instances).unwrap_or(usize::MAX));
        }
        store.data_mut().limits = builder.build();
        store.limiter(|host| &mut host.limits);

        Ok(store)
    }

    /// Apply per-call budgets to a store immediately before invoking a guest
    /// function: fuel for compute, an epoch deadline for wall clock.
    ///
    /// `0` means unbounded for either dimension.
    pub fn apply_call_limits(&self, store: &mut Store<Host>, limits: &ResolvedLimits) -> Result<()> {
        let fuel = if limits.max_fuel == 0 {
            u64::MAX
        } else {
            limits.max_fuel
        };
        store
            .set_fuel(fuel)
            .map_err(|e| anyhow::anyhow!("failed to apply per-call fuel budget: {e}"))?;

        if limits.timeout_ms == 0 {
            // Unbounded: push the deadline far enough out that it never fires.
            store.set_epoch_deadline(EPOCH_DEADLINE_UNBOUNDED);
        } else {
            // Round up so a sub-tick timeout still gets at least one tick.
            let ticks = limits.timeout_ms.div_ceil(EPOCH_TICK_MS).max(1);
            store.set_epoch_deadline(ticks);
        }
        // Exceeding the deadline traps the guest, which surfaces to the caller
        // as an error and is handled by the fail-open path.
        store.epoch_deadline_trap();

        Ok(())
    }

    pub async fn instantiate_plugin_component(
        &self,
        component: &Component,
    ) -> Result<(Plugin, Store<Host>)> {
        self.instantiate_plugin_component_with_limits(
            component,
            &self.limits,
            BreachRecorder::new("<loading>"),
        )
        .await
    }

    pub async fn instantiate_plugin_component_with_limits(
        &self,
        component: &Component,
        limits: &ResolvedLimits,
        breaches: Arc<BreachRecorder>,
    ) -> Result<(Plugin, Store<Host>)> {
        let mut store = self.new_store(limits, breaches)?;
        let instance = self.linker.instantiate_async(&mut store, component).await?;
        let plugin = Plugin::new(&mut store, &instance)?;
        Ok((plugin, store))
    }

    /// Resolve and type-check a component's imports against the linker once,
    /// producing a reusable [`InstancePre`]. This is the expensive part of
    /// instantiation; callers should cache the result per component and reuse
    /// it across events via [`Runtime::instantiate_from_pre`].
    pub fn build_instance_pre(&self, component: &Component) -> Result<InstancePre<Host>> {
        Ok(self.linker.instantiate_pre(component)?)
    }

    /// Instantiate a plugin from a pre-resolved [`InstancePre`] into a fresh
    /// store. This skips import resolution (already done in `build_instance_pre`)
    /// and only performs the per-event instantiation.
    pub async fn instantiate_from_pre(
        &self,
        pre: &InstancePre<Host>,
        limits: &ResolvedLimits,
        breaches: Arc<BreachRecorder>,
    ) -> Result<(Plugin, Store<Host>)> {
        let mut store = self.new_store(limits, breaches)?;
        let instance = pre.instantiate_async(&mut store).await?;
        let plugin = Plugin::new(&mut store, &instance)?;
        Ok((plugin, store))
    }
}
