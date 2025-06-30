use super::{LogLevel, PluginState, RequestContext, WasmError, WasmResult};
use std::sync::Arc;
use wasmtime::*;

// Host state that plugins can access
pub struct WasmState {
    pub plugin_state: Arc<PluginState>,
    pub context: RequestContext,
}

pub fn add_to_linker(linker: &mut Linker<WasmState>) -> WasmResult<()> {
    // Logging functions
    linker.func_wrap(
        "env",
        "host_log",
        |mut caller: Caller<'_, WasmState>,
         level: i32,
         ptr: i32,
         len: i32|
         -> Result<(), wasmtime::Error> {
            let memory = caller
                .get_export("memory")
                .and_then(|e| e.into_memory())
                .ok_or_else(|| wasmtime::Error::msg("No memory export"))?;

            let mut message_bytes = vec![0u8; len as usize];
            memory
                .read(&caller, ptr as usize, &mut message_bytes)
                .map_err(|e| wasmtime::Error::msg(format!("Memory read error: {}", e)))?;

            let message = String::from_utf8_lossy(&message_bytes);
            let log_level = match level {
                0 => LogLevel::Error,
                1 => LogLevel::Warn,
                2 => LogLevel::Info,
                3 => LogLevel::Debug,
                _ => LogLevel::Trace,
            };

            // Note: This is a simplified sync version - in production you'd want async
            tracing::info!("Plugin log [{}]: {}", level, message);

            Ok(())
        },
    )?;

    // Simplified storage functions (sync versions)
    linker.func_wrap(
        "env",
        "host_storage_set",
        |caller: Caller<'_, WasmState>,
         _key_ptr: i32,
         _key_len: i32,
         _value_ptr: i32,
         _value_len: i32|
         -> Result<(), wasmtime::Error> {
            // Simplified implementation - just log for now
            tracing::info!("Plugin storage set called");
            Ok(())
        },
    )?;

    linker.func_wrap(
        "env",
        "host_storage_get",
        |caller: Caller<'_, WasmState>,
         _key_ptr: i32,
         _key_len: i32|
         -> Result<i32, wasmtime::Error> {
            // Simplified implementation - return 0 (not found)
            Ok(0)
        },
    )?;

    // Utility functions
    linker.func_wrap(
        "env",
        "host_get_timestamp",
        |_caller: Caller<'_, WasmState>| -> i64 { chrono::Utc::now().timestamp_millis() },
    )?;

    Ok(())
}
