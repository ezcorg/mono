use crate::wasm::{Host, WitmProxy};
use anyhow::Result;
use wasmtime::{Config, Engine, component::Linker};
use wasmtime_wasi::p3::bindings::LinkOptions;

pub struct Runtime {
    pub engine: Engine,
    pub config: Config,
    pub linker: Linker<Host>,
}

impl Runtime {
    pub fn try_default() -> Result<Self> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        config.wasm_component_model_async(true);
        config.async_support(true);

        let engine = Engine::new(&config)?;

        let mut linker: Linker<Host> = Linker::new(&engine);

        // TODO: fix this
        // Add WASI CLI support (needed by the component)
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;

        // Add WASI HTTP support
        let options = LinkOptions::default();
        wasmtime_wasi::p3::add_to_linker_with_options(&mut linker, &options)?;

        // Add WASI HTTP support
        wasmtime_wasi_http::p3::add_to_linker(&mut linker)?;

        // Add our custom host capabilities using the wrapper pattern
        crate::wasm::add_to_linker(&mut linker, |host: &mut Host| {
            WitmProxy::new(&host.witmproxy_ctx, &mut host.table)
        })?;

        Ok(Self {
            engine,
            config,
            linker,
        })
    }
}
