use anyhow::{Result};
use wasmtime::{component::{Linker}, Config, Engine};

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
        config.async_support(true);

        let engine = Engine::new(&config)?;

        let mut linker: Linker<Host> = Linker::new(&engine);

        // TODO: restrict this further after testing
        wasmtime_wasi_http::p3::add_to_linker(&mut linker)?;

        Ok(Self { engine, config, linker })
    }
}