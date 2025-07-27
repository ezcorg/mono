use super::{
    EventType, PluginAction, PluginMetadata, PluginState, RequestContext, WasmError, WasmResult,
};
use crate::wasm::host_functions::WasmState;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;
use wasmtime::component::ResourceTable;
use wasmtime::component::{Component, Instance, Linker};
use wasmtime::{Config, Engine, Store, WasmBacktraceDetails};
use wasmtime_wasi::p2::WasiCtxBuilder;

pub struct WasmPlugin {
    engine: Engine,
    component: Component,
    state: Arc<PluginState>,
}

impl std::fmt::Debug for WasmPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WasmPlugin")
            .field("state", &self.state)
            .finish()
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
pub enum PluginResult {
    Continue,
    Block(String),
    Redirect(String),
    ModifyData(Vec<u8>),
}

impl WasmPlugin {
    pub async fn new(wasm_bytes: &[u8], state: Arc<PluginState>) -> WasmResult<Self> {
        let mut config = Config::new();
        config.wasm_backtrace_details(WasmBacktraceDetails::Enable);
        config.wasm_multi_memory(true);
        config.async_support(false);
        config.wasm_component_model(true);

        // Security configurations
        config.consume_fuel(true);
        config.max_wasm_stack(1024 * 1024); // 1MB stack limit

        let engine = Engine::new(&config)?;
        let component = Component::from_binary(&engine, wasm_bytes)?;

        Ok(Self {
            engine,
            component,
            state,
        })
    }

    pub async fn execute_event(
        &self,
        event_type: EventType,
        context: &mut RequestContext,
    ) -> WasmResult<PluginAction> {
        let wasi = WasiCtxBuilder::new().inherit_stdio().build();

        let mut store = Store::new(
            &self.engine,
            WasmState {
                plugin_state: self.state.clone(),
                context: context.clone(),
                wasi,
                table: ResourceTable::new(),
            },
        );

        // Set fuel limit (prevents infinite loops)
        store.set_fuel(1_000_000)?;

        // Create component linker with WASI support
        let mut linker = Linker::new(&self.engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;

        // Instantiate the component
        let instance = linker.instantiate(&mut store, &self.component)?;

        // Execute the event handler with timeout
        let result = timeout(
            Duration::from_millis(5000), // 5 second timeout
            self.call_event_handler(&mut store, &instance, event_type, context),
        )
        .await
        .map_err(|_| WasmError::Timeout)??;

        Ok(result)
    }

    async fn call_event_handler(
        &self,
        store: &mut Store<WasmState>,
        instance: &Instance,
        event_type: EventType,
        context: &RequestContext,
    ) -> WasmResult<PluginAction> {
        // For now, return Continue as we need to implement the component interface properly
        // This is a placeholder until we define the proper WIT interface
        tracing::info!("WASI preview2 event handler called for: {:?}", event_type);
        Ok(PluginAction::Continue)
    }

    pub async fn get_metadata(&self) -> WasmResult<PluginMetadata> {
        let wasi = WasiCtxBuilder::new().inherit_stdio().build();

        let mut store = Store::new(
            &self.engine,
            WasmState {
                plugin_state: self.state.clone(),
                context: RequestContext {
                    request_id: "metadata".to_string(),
                    client_ip: "127.0.0.1".parse().unwrap(),
                    target_host: "localhost".to_string(),
                    request: super::HttpRequest {
                        method: "GET".to_string(),
                        url: "/".to_string(),
                        headers: std::collections::HashMap::new(),
                        body: Vec::new(),
                    },
                    response: None,
                },
                wasi,
                table: ResourceTable::new(),
            },
        );

        let mut linker = Linker::new(&self.engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;

        let instance = linker.instantiate(&mut store, &self.component)?;

        // Get the plugin interface from the instantiated component
        let plugin = Plugin::new(&mut store, &instance)?;

        // Call the get_metadata function from the WASI component
        let metadata_string = plugin.call_get_metadata(&mut store)?;

        // Parse the metadata string and return a PluginMetadata struct
        Ok(PluginMetadata {
            name: metadata_string,
            version: "0.1.0".to_string(),
            description: "A plugin using WASI preview2".to_string(),
            author: "Unknown".to_string(),
            events: vec!["request_start".to_string(), "response_start".to_string()],
            config_schema: None,
        })
    }
}
