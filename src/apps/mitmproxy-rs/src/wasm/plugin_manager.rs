use super::{
    EventType, PluginAction, PluginConfig, PluginMetadata, PluginState, RequestContext,
    WasmError, WasmResult, WasmPlugin,
};
use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

#[derive(Debug, Clone)]
pub struct PluginManager {
    plugins: Arc<RwLock<HashMap<String, LoadedPlugin>>>,
    plugin_dir: PathBuf,
    state: Arc<PluginState>,
}

struct LoadedPlugin {
    plugin: WasmPlugin,
    metadata: PluginMetadata,
    config: PluginConfig,
    enabled: bool,
}

impl std::fmt::Debug for LoadedPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadedPlugin")
            .field("metadata", &self.metadata)
            .field("config", &self.config)
            .field("enabled", &self.enabled)
            .finish()
    }
}

impl PluginManager {
    pub async fn new<P: AsRef<Path>>(plugin_dir: P) -> Result<Self> {
        let plugin_dir = plugin_dir.as_ref().to_path_buf();
        
        // Create plugin directory if it doesn't exist
        fs::create_dir_all(&plugin_dir).await?;
        
        let manager = Self {
            plugins: Arc::new(RwLock::new(HashMap::new())),
            plugin_dir,
            state: Arc::new(PluginState::new()),
        };
        
        // Load all plugins from directory
        manager.load_plugins().await?;
        
        Ok(manager)
    }
    
    async fn load_plugins(&self) -> Result<()> {
        let mut entries = fs::read_dir(&self.plugin_dir).await?;
        let mut loaded_count = 0;
        
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            
            if path.is_file() && path.extension().map_or(false, |ext| ext == "wasm") {
                match self.load_plugin(&path).await {
                    Ok(plugin_name) => {
                        info!("Loaded plugin: {}", plugin_name);
                        loaded_count += 1;
                    }
                    Err(e) => {
                        warn!("Failed to load plugin {:?}: {}", path, e);
                    }
                }
            }
        }
        
        info!("Loaded {} plugins from {:?}", loaded_count, self.plugin_dir);
        Ok(())
    }
    
    async fn load_plugin(&self, path: &Path) -> WasmResult<String> {
        let wasm_bytes = fs::read(path).await?;
        let plugin = WasmPlugin::new(&wasm_bytes, self.state.clone()).await?;
        
        // Try to get plugin metadata
        let metadata = match plugin.get_metadata().await {
            Ok(meta) => meta,
            Err(_) => {
                // Create default metadata if not available
                let name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                
                PluginMetadata {
                    name: name.clone(),
                    version: "1.0.0".to_string(),
                    description: "No description available".to_string(),
                    author: "Unknown".to_string(),
                    events: vec![],
                    config_schema: None,
                }
            }
        };
        
        // Load plugin configuration if it exists
        let config_path = path.with_extension("toml");
        let config = if config_path.exists() {
            let config_content = fs::read_to_string(&config_path).await?;
            toml::from_str(&config_content).unwrap_or_default()
        } else {
            PluginConfig::default()
        };
        
        let plugin_name = metadata.name.clone();
        let loaded_plugin = LoadedPlugin {
            plugin,
            metadata,
            config: config.clone(),
            enabled: config.enabled,
        };
        
        let mut plugins = self.plugins.write().await;
        plugins.insert(plugin_name.clone(), loaded_plugin);
        
        Ok(plugin_name)
    }
    
    pub async fn execute_event(
        &self,
        event_type: EventType,
        context: &mut RequestContext,
    ) -> WasmResult<Vec<PluginAction>> {
        let plugins = self.plugins.read().await;
        let mut actions = Vec::new();
        
        // Get plugins that handle this event type, sorted by priority
        let mut event_plugins: Vec<_> = plugins
            .values()
            .filter(|p| {
                p.enabled
                    && p.metadata
                        .events
                        .contains(&event_type.as_str().to_string())
            })
            .collect();
        
        event_plugins.sort_by_key(|p| p.config.priority);
        
        for loaded_plugin in event_plugins {
            debug!(
                "Executing plugin {} for event {}",
                loaded_plugin.metadata.name,
                event_type.as_str()
            );
            
            match loaded_plugin
                .plugin
                .execute_event(event_type.clone(), context)
                .await
            {
                Ok(action) => {
                    actions.push(action);
                }
                Err(e) => {
                    error!(
                        "Plugin {} failed to execute event {}: {}",
                        loaded_plugin.metadata.name,
                        event_type.as_str(),
                        e
                    );
                    
                    // Log the error to plugin state
                    self.state
                        .log(
                            super::LogLevel::Error,
                            &loaded_plugin.metadata.name,
                            &format!("Event execution failed: {}", e),
                        )
                        .await;
                }
            }
        }
        
        Ok(actions)
    }
    
    pub async fn reload_plugin(&self, plugin_name: &str) -> WasmResult<()> {
        let plugin_path = self.plugin_dir.join(format!("{}.wasm", plugin_name));
        
        if !plugin_path.exists() {
            return Err(WasmError::NotFound(plugin_name.to_string()));
        }
        
        // Remove existing plugin
        {
            let mut plugins = self.plugins.write().await;
            plugins.remove(plugin_name);
        }
        
        // Reload plugin
        self.load_plugin(&plugin_path).await?;
        info!("Reloaded plugin: {}", plugin_name);
        
        Ok(())
    }
    
    pub async fn enable_plugin(&self, plugin_name: &str) -> WasmResult<()> {
        let mut plugins = self.plugins.write().await;
        
        if let Some(plugin) = plugins.get_mut(plugin_name) {
            plugin.enabled = true;
            plugin.config.enabled = true;
            info!("Enabled plugin: {}", plugin_name);
            Ok(())
        } else {
            Err(WasmError::NotFound(plugin_name.to_string()))
        }
    }
    
    pub async fn disable_plugin(&self, plugin_name: &str) -> WasmResult<()> {
        let mut plugins = self.plugins.write().await;
        
        if let Some(plugin) = plugins.get_mut(plugin_name) {
            plugin.enabled = false;
            plugin.config.enabled = false;
            info!("Disabled plugin: {}", plugin_name);
            Ok(())
        } else {
            Err(WasmError::NotFound(plugin_name.to_string()))
        }
    }
    
    pub async fn get_plugin_list(&self) -> Vec<PluginInfo> {
        let plugins = self.plugins.read().await;
        
        plugins
            .values()
            .map(|p| PluginInfo {
                name: p.metadata.name.clone(),
                version: p.metadata.version.clone(),
                description: p.metadata.description.clone(),
                author: p.metadata.author.clone(),
                enabled: p.enabled,
                events: p.metadata.events.clone(),
            })
            .collect()
    }
    
    pub async fn get_plugin_config(&self, plugin_name: &str) -> Option<PluginConfig> {
        let plugins = self.plugins.read().await;
        plugins.get(plugin_name).map(|p| p.config.clone())
    }
    
    pub async fn update_plugin_config(
        &self,
        plugin_name: &str,
        config: PluginConfig,
    ) -> WasmResult<()> {
        let mut plugins = self.plugins.write().await;
        
        if let Some(plugin) = plugins.get_mut(plugin_name) {
            plugin.config = config.clone();
            plugin.enabled = config.enabled;
            
            // Save config to file
            let config_path = self.plugin_dir.join(format!("{}.toml", plugin_name));
            let config_content = toml::to_string_pretty(&config)
                .map_err(|e| WasmError::InvalidFormat(e.to_string()))?;
            
            fs::write(&config_path, config_content).await?;
            
            info!("Updated config for plugin: {}", plugin_name);
            Ok(())
        } else {
            Err(WasmError::NotFound(plugin_name.to_string()))
        }
    }
    
    pub async fn plugin_count(&self) -> usize {
        let plugins = self.plugins.read().await;
        plugins.len()
    }
    
    pub async fn get_plugin_logs(&self) -> Vec<super::LogEntry> {
        self.state.get_logs().await
    }
    
    pub async fn clear_plugin_logs(&self) {
        let mut logs = self.state.logs.write().await;
        logs.clear();
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PluginInfo {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub enabled: bool,
    pub events: Vec<String>,
}