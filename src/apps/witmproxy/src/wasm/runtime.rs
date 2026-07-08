use crate::wasm::{Host, WitmProxyCtxView, bindgen::Plugin};
use anyhow::Result;
use wasmtime::{
    Config, Engine, Store, StoreLimitsBuilder,
    component::{Component, Linker},
};
use wasmtime_wasi::p3::bindings::LinkOptions;
use wasmtime_wasi_http::p3::WasiHttpView;

/// Per-plugin resource limits sourced from `PluginConfig`.
///
/// A value of `0` for any field means "no limit" for that dimension:
/// - `max_fuel == 0`      => fuel is left effectively unbounded for the store
/// - `max_memory_mb == 0` => no memory cap is installed
/// - `timeout_ms == 0`    => guest calls are not wrapped in a timeout
#[derive(Clone, Copy, Debug, Default)]
pub struct PluginLimits {
    pub max_fuel: u64,
    pub max_memory_mb: u64,
    pub timeout_ms: u64,
}

pub struct Runtime {
    pub engine: Engine,
    pub linker: Linker<Host>,
    pub limits: PluginLimits,
}

impl Runtime {
    pub fn try_default() -> Result<Self> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        config.wasm_component_model_async(true);
        // Enable fuel metering so per-store fuel limits can bound runaway guest
        // compute. With this enabled every store starts with 0 fuel and would
        // trap immediately, so `new_store` MUST call `set_fuel`.
        config.consume_fuel(true);

        let engine = Engine::new(&config)?;
        Self::from_engine(engine)
    }

    /// Build a [`Runtime`] that reuses an existing [`Engine`] (a cheap `Arc`
    /// clone), building the linker from that same engine. Reusing the engine
    /// avoids the cross-`Engine` hazard of instantiating a component in a store
    /// whose engine differs from the linker's engine.
    pub fn from_engine(engine: Engine) -> Result<Self> {
        let linker = Self::build_linker(&engine)?;
        Ok(Self {
            engine,
            linker,
            limits: PluginLimits::default(),
        })
    }

    /// Attach per-plugin resource limits to this runtime.
    pub fn with_limits(mut self, limits: PluginLimits) -> Self {
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

        // Add WASI CLI support (needed by the component)
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;

        // Add WASI p3 support (clocks, random, io, ...)
        let options = LinkOptions::default();
        wasmtime_wasi::p3::add_to_linker_with_options(&mut linker, &options)?;

        // Add ONLY the `wasi:http/types` interface (request/response resource
        // methods). We intentionally omit `wasi:http/client` (the outbound
        // handler) so plugins cannot make outbound HTTP requests.
        wasmtime_wasi_http::p3::bindings::http::types::add_to_linker::<
            _,
            wasmtime_wasi_http::p3::WasiHttp,
        >(&mut linker, <Host as WasiHttpView>::http)?;

        // Add our custom host capabilities using the wrapper pattern
        crate::wasm::add_to_linker(&mut linker, |host: &mut Host| {
            WitmProxyCtxView::new(&host.witmproxy_ctx, &mut host.table)
        })?;

        Ok(linker)
    }

    pub fn new_store(&self) -> Store<Host> {
        let mut store = Store::new(&self.engine, Host::default());
        // Fuel metering is enabled engine-wide; a store starts with 0 fuel and
        // would trap immediately. Give every store an unbounded baseline here;
        // the actual per-call cap is applied by `apply_call_limits` right before
        // invoking guest functions, so host-side work (instantiation, manifest
        // calls) is never metered.
        store
            .set_fuel(u64::MAX)
            .expect("fuel consumption is enabled in the Runtime config");

        // Install a memory cap for the store's whole lifetime when configured.
        // `max_memory_mb == 0` means "no limit": leave the default (unbounded).
        if self.limits.max_memory_mb > 0 {
            let bytes = (self.limits.max_memory_mb as usize).saturating_mul(1024 * 1024);
            store.data_mut().limits = StoreLimitsBuilder::new().memory_size(bytes).build();
            store.limiter(|host| &mut host.limits);
        }

        store
    }

    /// Apply the configured per-call fuel budget to a store immediately before
    /// invoking a guest function. `max_fuel == 0` means unbounded.
    pub fn apply_call_limits(&self, store: &mut Store<Host>) {
        let fuel = if self.limits.max_fuel == 0 {
            u64::MAX
        } else {
            self.limits.max_fuel
        };
        store
            .set_fuel(fuel)
            .expect("fuel consumption is enabled in the Runtime config");
    }

    pub async fn instantiate_plugin_component(
        &self,
        component: &Component,
    ) -> Result<(Plugin, Store<Host>)> {
        let mut store = self.new_store();
        let instance = self.linker.instantiate_async(&mut store, component).await?;
        let plugin = Plugin::new(&mut store, &instance)?;
        Ok((plugin, store))
    }
}
