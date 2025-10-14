use anyhow::{Result};
use wasmtime::{component::{Linker, HasSelf}, Config, Engine};
use wasmtime_wasi_http::{p3::WasiHttp};
use wasmtime_wasi::p3::bindings::LinkOptions;
use wasmtime_wasi_http::p3::WasiHttpView;
use crate::{wasm::{Host}};

pub struct Runtime {
    pub engine: Engine,
    pub config: Config,
    pub linker: Linker<Host>
}

impl Runtime {
    pub fn default() -> Result<Self> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        config.wasm_component_model_async(true);
        config.async_support(true);

        let engine = Engine::new(&config)?;

        let mut linker: Linker<Host> = Linker::new(&engine);

        // Add WASI CLI support (needed by the component)
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;

        // Add WASI HTTP support
        let options = LinkOptions::default();
        wasmtime_wasi::p3::add_to_linker_with_options(&mut linker, &options)?;

        // Add WASI HTTP support
        wasmtime_wasi_http::p3::add_to_linker(&mut linker)?;
        
        // Add our custom host capabilities
        crate::wasm::generated::host::plugin::capabilities::add_to_linker::<Host, HasSelf<Host>>(&mut linker, |host: &mut Host| -> &mut Host { host })?;

        Ok(Self { engine, config, linker })
    }
}
