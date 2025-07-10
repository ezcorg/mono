use super::{
    EventType, PluginAction, PluginMetadata, PluginState, RequestContext, WasmError, WasmResult,
};
use crate::wasm::host_functions::WasmState;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;
use wasmtime::*;

pub struct WasmPlugin {
    engine: Engine,
    module: Module,
    state: Arc<PluginState>,
}

impl std::fmt::Debug for WasmPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WasmPlugin")
            .field("state", &self.state)
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct PluginContext {
    pub request_id: String,
    pub client_ip: std::net::IpAddr,
    pub target_host: String,
}

#[derive(Debug, Clone)]
pub struct PluginEvent {
    pub event_type: EventType,
    pub context: PluginContext,
    pub data: Vec<u8>,
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
        config.async_support(true);

        // Security configurations
        config.consume_fuel(true);
        config.max_wasm_stack(1024 * 1024); // 1MB stack limit

        let engine = Engine::new(&config)?;
        let module = Module::from_binary(&engine, wasm_bytes)?;

        Ok(Self {
            engine,
            module,
            state,
        })
    }

    pub async fn execute_event(
        &self,
        event_type: EventType,
        context: &mut RequestContext,
    ) -> WasmResult<PluginAction> {
        let mut store = Store::new(
            &self.engine,
            WasmState {
                plugin_state: self.state.clone(),
                context: context.clone(),
            },
        );

        // Set fuel limit (prevents infinite loops)
        store.set_fuel(1_000_000)?;

        // Create linker with host functions
        let mut linker = Linker::new(&self.engine);
        // Skip WASI for now to get the build working
        // wasmtime_wasi::add_to_linker_sync(&mut linker, |state: &mut WasmState| &mut state.wasi)?;

        // Add custom host functions
        crate::wasm::host_functions::add_to_linker(&mut linker)?;

        // Instantiate the module
        let instance = linker.instantiate_async(&mut store, &self.module).await?;

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
        let func_name = format!("on_{}", event_type.as_str());

        // Try to get the event handler function
        let func = match instance.get_typed_func::<(i32, i32), i32>(&mut *store, &func_name) {
            Ok(f) => f,
            Err(_) => {
                // Function not found, plugin doesn't handle this event
                return Ok(PluginAction::Continue);
            }
        };

        // Serialize context to JSON and write to WASM memory
        let context_json =
            serde_json::to_vec(context).map_err(|e| WasmError::InvalidFormat(e.to_string()))?;

        let memory = instance
            .get_memory(&mut *store, "memory")
            .ok_or_else(|| WasmError::InvalidFormat("No memory export found".to_string()))?;

        // Allocate memory in WASM for the context
        let alloc_func = instance
            .get_typed_func::<i32, i32>(&mut *store, "alloc")
            .map_err(|_| WasmError::InvalidFormat("No alloc function found".to_string()))?;

        let context_ptr = alloc_func
            .call_async(&mut *store, context_json.len() as i32)
            .await?;

        // Write context data to WASM memory
        memory.write(&mut *store, context_ptr as usize, &context_json)?;

        // Call the event handler
        let result_ptr = func
            .call_async(&mut *store, (context_ptr, context_json.len() as i32))
            .await?;

        // Read result from WASM memory
        let result_action = self.read_plugin_result(&*store, &memory, result_ptr)?;

        // Free allocated memory
        let free_func = instance
            .get_typed_func::<i32, ()>(&mut *store, "free")
            .map_err(|_| WasmError::InvalidFormat("No free function found".to_string()))?;

        free_func.call_async(&mut *store, context_ptr).await?;
        if result_ptr != 0 {
            free_func.call_async(&mut *store, result_ptr).await?;
        }

        Ok(result_action)
    }

    fn read_plugin_result(
        &self,
        store: &Store<WasmState>,
        memory: &Memory,
        result_ptr: i32,
    ) -> WasmResult<PluginAction> {
        if result_ptr == 0 {
            return Ok(PluginAction::Continue);
        }

        // Read the result length first (4 bytes)
        let mut len_bytes = [0u8; 4];
        memory.read(store, result_ptr as usize, &mut len_bytes)?;
        let len = u32::from_le_bytes(len_bytes) as usize;

        // Read the result data
        let mut result_bytes = vec![0u8; len];
        memory.read(store, (result_ptr + 4) as usize, &mut result_bytes)?;

        // Deserialize the result
        let result: PluginResult = serde_json::from_slice(&result_bytes)
            .map_err(|e| WasmError::InvalidFormat(e.to_string()))?;

        match result {
            PluginResult::Continue => Ok(PluginAction::Continue),
            PluginResult::Block(reason) => Ok(PluginAction::Block(reason)),
            PluginResult::Redirect(url) => Ok(PluginAction::Redirect(url)),
            PluginResult::ModifyData(_data) => {
                // This would need more context about what's being modified
                Ok(PluginAction::Continue)
            }
        }
    }

    pub async fn get_metadata(&self) -> WasmResult<PluginMetadata> {
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
            },
        );

        let mut linker = Linker::new(&self.engine);
        // Skip WASI for now to get the build working
        // wasmtime_wasi::add_to_linker_sync(&mut linker, |state: &mut WasmState| &mut state.wasi)?;
        crate::wasm::host_functions::add_to_linker(&mut linker)?;

        let instance = linker.instantiate_async(&mut store, &self.module).await?;

        // Try to call get_metadata function
        let func = instance.get_typed_func::<(), i32>(&mut store, "get_metadata");

        match func {
            Ok(f) => {
                let result_ptr = f.call_async(&mut store, ()).await?;

                if result_ptr == 0 {
                    return Err(WasmError::InvalidFormat("No metadata returned".to_string()));
                }

                let memory = instance.get_memory(&mut store, "memory").ok_or_else(|| {
                    WasmError::InvalidFormat("No memory export found".to_string())
                })?;

                // Read metadata length
                let mut len_bytes = [0u8; 4];
                memory.read(&mut store, result_ptr as usize, &mut len_bytes)?;
                let len = u32::from_le_bytes(len_bytes) as usize;

                // Read metadata
                let mut metadata_bytes = vec![0u8; len];
                memory.read(&mut store, (result_ptr + 4) as usize, &mut metadata_bytes)?;

                let metadata: PluginMetadata = serde_json::from_slice(&metadata_bytes)
                    .map_err(|e| WasmError::InvalidFormat(e.to_string()))?;

                Ok(metadata)
            }
            Err(_) => Err(WasmError::InvalidFormat(
                "No get_metadata function found".to_string(),
            )),
        }
    }
}
