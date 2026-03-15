use crate::{
    AppConfig, CertificateAuthority, WitmProxy,
    config::{confique_app_config_layer::AppConfigLayer, expand_home_in_path},
    db::Db,
    plugins::registry::PluginRegistry,
    proxy::tenant_resolver,
    wasm::Runtime,
};
use auth::AuthCommands;
use service::ServiceCommands;
use group::GroupCommands;
use plugin::PluginCommands;
use proxy::ProxyCommands;
use tenant::TenantCommands;
use trust::CaCommands;

use anyhow::Result;
use clap::{Parser, Subcommand};
use confique::Config;
use notify::{Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher, event::ModifyKind};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::{RwLock, mpsc};
use tracing::{error, info, warn};

pub mod api_client;
pub mod auth;
pub mod service;
pub mod group;
mod plugin;
mod proxy;
pub mod tenant;
mod tailscale;
mod trust;

#[cfg(test)]
mod tests;

#[derive(Parser)]
#[command(name = "witmproxy")]
#[command(about = "A WASM-in-the-middle proxy")]
pub struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Configuration file path
    #[arg(short, long, default_value = "$HOME/.witmproxy/config.toml")]
    config_path: PathBuf,

    /// Configuration object
    #[command(flatten)]
    config: AppConfigLayer,

    /// Enable verbose logging
    #[arg(short, long)]
    verbose: bool,

    /// Directory to load plugins from, watched for changes (only applies when running the proxy)
    #[arg(long)]
    plugin_dir: Option<PathBuf>,

    /// Automatically trust the proxy CA and configure system proxy settings on startup (only applies when running the proxy)
    #[arg(long)]
    auto: bool,

    /// Detach from the daemon after starting, don't attach to logs (only applies to default startup behavior)
    #[arg(short, long)]
    detach: bool,
}

/// Internal helper struct that holds the resolved configuration
pub struct ResolvedCli {
    command: Option<Commands>,
    config: AppConfig,
    verbose: bool,
    plugin_dir: Option<PathBuf>,
    auto: bool,
    detach: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Plugin management commands
    Plugin {
        #[command(subcommand)]
        command: PluginCommands,
    },
    /// Certificate authority management commands
    Ca {
        #[command(subcommand)]
        command: CaCommands,
    },
    /// System proxy management commands
    Proxy {
        #[command(subcommand)]
        command: ProxyCommands,
    },
    /// Service management commands
    Service {
        #[command(subcommand)]
        command: ServiceCommands,
    },
    /// Authentication commands (for remote management)
    Auth {
        #[command(subcommand)]
        command: AuthCommands,
    },
    /// Tenant management commands (remote)
    Tenant {
        #[command(subcommand)]
        command: TenantCommands,
    },
    /// Group management commands (remote)
    Group {
        #[command(subcommand)]
        command: GroupCommands,
    },
    /// Run the proxy server directly in the foreground (no daemon)
    ///
    /// This starts the web and proxy servers directly in the current terminal.
    /// Useful for development, debugging, or when you don't want daemon overhead.
    /// Press Ctrl+C to stop the proxy.
    Run,
    /// Run the proxy server directly (used by the daemon, not typically called directly)
    Serve {
        /// Log file path for daemon mode (stdout/stderr will be redirected here)
        #[arg(long)]
        log_file: Option<PathBuf>,
    },
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Services {
    pub proxy: String,
    pub web: String,
}

impl Cli {
    pub async fn run(self) -> Result<()> {
        // Check if we're running the serve command (daemon mode)
        // In that case, we'll let run_serve initialize tracing with file output
        let is_serve_command = matches!(&self.command, Some(Commands::Serve { .. }));

        if !is_serve_command {
            let log_level = if self.verbose { "debug" } else { "info" };
            tracing_subscriber::fmt()
                .with_env_filter(format!("witmproxy={},{}", log_level, log_level))
                .init();
        }

        // Load and resolve configuration once at the beginning
        let resolved_cli = self.resolve_config().await?;

        // Handle subcommands first
        if let Some(ref command) = resolved_cli.command {
            return resolved_cli.handle_command(command).await;
        }

        // Default behavior - install and start daemon, then attach to logs
        resolved_cli.run_default().await
    }

    /// Load the configuration and resolve all $HOME placeholders
    async fn resolve_config(self) -> Result<ResolvedCli> {
        // Resolve home directory and config path
        let config_path = expand_home_in_path(&self.config_path)?;

        // Load configuration using confique
        let config = AppConfig::builder()
            .preloaded(self.config)
            .env()
            .file(&config_path)
            .load()?
            .with_resolved_paths()?;

        // Resolve plugin_dir path if provided
        let plugin_dir = if let Some(ref dir) = self.plugin_dir {
            Some(expand_home_in_path(dir)?)
        } else {
            None
        };

        Ok(ResolvedCli {
            command: self.command,
            config,
            verbose: self.verbose,
            plugin_dir,
            auto: self.auto,
            detach: self.detach,
        })
    }
}

impl ResolvedCli {
    async fn handle_command(&self, command: &Commands) -> Result<()> {
        match command {
            Commands::Plugin { command } => {
                let plugin_handler = plugin::PluginHandler::new(self.config.clone(), self.verbose);
                plugin_handler.handle(command).await
            }
            Commands::Ca { command } => {
                let ca_handler = trust::CaHandler::new(self.config.clone());
                ca_handler.handle(command).await
            }
            Commands::Proxy { command } => {
                let proxy_handler = proxy::ProxyHandler::new(self.config.clone());
                proxy_handler.handle(command).await
            }
            Commands::Service { command } => {
                let service_handler = service::ServiceHandler::new(
                    self.config.clone(),
                    self.verbose,
                    self.plugin_dir.clone(),
                    self.auto,
                );
                service_handler.handle(command).await
            }
            Commands::Auth { command } => {
                let auth_handler = auth::AuthHandler;
                auth_handler.handle(command).await
            }
            Commands::Tenant { command } => {
                let tenant_handler = tenant::TenantHandler;
                tenant_handler.handle(command).await
            }
            Commands::Group { command } => {
                let group_handler = group::GroupHandler;
                group_handler.handle(command).await
            }
            Commands::Run => self.run_foreground().await,
            Commands::Serve { log_file } => self.run_serve(log_file.clone()).await,
        }
    }

    /// Default behavior when no subcommand is provided:
    /// - Install (or reinstall) the service with current CLI arguments
    /// - Restart the daemon so it picks up current config and newly added plugins
    /// - Unless --detach is specified, attach to the daemon's logs
    async fn run_default(&self) -> Result<()> {
        let service_handler = service::ServiceHandler::new(
            self.config.clone(),
            self.verbose,
            self.plugin_dir.clone(),
            self.auto,
        );

        let was_installed = service_handler.is_service_installed();

        // Always (re)install the service to ensure the service file reflects
        // the current CLI arguments (e.g. --plugin-dir, --verbose, --auto)
        if !was_installed {
            println!("First run detected. Installing witmproxy as a daemon service...");
        }
        service_handler.install_service(true).await?;

        // Restart the service so it picks up the latest service file,
        // configuration, and any plugins added since the last start
        info!("Starting witmproxy service...");
        service_handler.restart_service().await?;

        // Wait a moment for the service to start
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

        // Check status
        service_handler.show_status().await?;

        // Unless --detach is specified, attach to the service logs
        if !self.detach {
            println!();
            service_handler.attach_to_logs().await?;
        } else {
            println!();
            println!("Service started in background. Use 'witm service logs -f' to view logs.");
        }

        Ok(())
    }

    /// Run the proxy server directly in the foreground (no daemon)
    ///
    /// This starts both the web and proxy servers directly in the current process.
    /// Logs are output to stdout. Press Ctrl+C to stop.
    /// Useful for development, debugging, or when daemon overhead is not desired.
    async fn run_foreground(&self) -> Result<()> {
        info!("Starting witmproxy in foreground mode (no daemon)");
        println!("Starting witmproxy in foreground mode...");
        println!("Press Ctrl+C to stop the proxy.\n");

        // Run the proxy directly - tracing is already initialized by Cli::run()
        match self.run_proxy_internal().await {
            Ok(()) => {
                info!("witmproxy stopped gracefully");
                Ok(())
            }
            Err(e) => {
                error!("witmproxy failed with error: {:#}", e);
                Err(e)
            }
        }
    }

    /// Run the proxy server directly (daemon mode)
    /// This method is called by the daemon service and writes logs to a file
    async fn run_serve(&self, log_file: Option<PathBuf>) -> Result<()> {
        // Set up file-based logging if a log file path is provided
        if let Some(ref log_path) = log_file {
            // Create parent directories if needed
            if let Some(parent) = log_path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            // Set up file-based tracing subscriber
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)?;

            let log_level = if self.verbose { "debug" } else { "info" };
            tracing_subscriber::fmt()
                .with_env_filter(format!("witmproxy={},{}", log_level, log_level))
                .with_writer(file)
                .with_ansi(false) // No ANSI colors in log file
                .init();

            info!("witmproxy daemon starting, logging to {:?}", log_path);
        }

        // Now run the proxy (same as run_proxy but without log initialization)
        // Wrap in catch to log any errors before the process exits
        match self.run_proxy_internal().await {
            Ok(()) => Ok(()),
            Err(e) => {
                error!("Daemon failed with error: {:#}", e);
                Err(e)
            }
        }
    }

    /// Internal proxy run method (used by both run_proxy and run_serve)
    async fn run_proxy_internal(&self) -> Result<()> {
        // Create app directory based on the resolved cert_dir parent
        let app_dir = self
            .config
            .tls
            .cert_dir
            .parent()
            .unwrap_or(&PathBuf::from("."))
            .to_path_buf();
        std::fs::create_dir_all(&app_dir)?;

        info!("Loaded proxy configuration");

        // Create certificate authority using pre-resolved cert_dir
        std::fs::create_dir_all(&self.config.tls.cert_dir)?;
        let ca = CertificateAuthority::new(self.config.tls.cert_dir.clone()).await?;
        info!("Certificate Authority initialized");

        // Handle --auto flag: trust CA if needed
        if self.auto {
            info!("Auto mode enabled: checking CA trust status");
            ca.install_root_certificate(true, false).await?;
        }

        // Initialize database using pre-resolved path
        if let Some(parent) = self.config.db.db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let db = Db::from_path(self.config.db.db_path.clone(), &self.config.db.db_password).await?;
        db.migrate().await?;
        info!(
            "Database initialized and migrated at: {}",
            self.config.db.db_path.display()
        );

        // Keep a pool handle for transparent proxy tenant resolution
        let db_pool = db.pool.clone();

        // Plugin registry which will be shared across the proxy and web server
        let plugin_registry = if self.config.plugins.enabled {
            let runtime = Runtime::try_default()?;
            let mut registry = PluginRegistry::new(db, runtime)?;
            registry.load_plugins().await?;
            info!("Number of plugins loaded: {}", registry.plugins().len());
            Some(Arc::new(RwLock::new(registry)))
        } else {
            None
        };

        // Clone for plugin_dir loading to transfer ownership
        let plugin_registry = plugin_registry;

        // If --plugin-dir is specified, load plugins from directory
        if let Some(ref plugin_dir) = self.plugin_dir {
            if let Some(ref registry) = plugin_registry {
                info!("Loading plugins from directory: {:?}", plugin_dir);
                std::fs::create_dir_all(plugin_dir)?;
                load_plugins_from_directory(plugin_dir, registry.clone()).await?;
            } else {
                warn!("--plugin-dir specified but plugins are disabled in configuration");
            }
        }

        let ca_for_proxy = CertificateAuthority::new(self.config.tls.cert_dir.clone()).await?;
        let mut proxy = WitmProxy::new(ca_for_proxy, plugin_registry.clone(), self.config.clone());
        proxy.start().await?;

        // Capture the bound addresses
        let proxy_addr = proxy
            .proxy_listen_addr()
            .ok_or_else(|| anyhow::anyhow!("Failed to get proxy listen address"))?;
        let web_addr = proxy
            .web_listen_addr()
            .ok_or_else(|| anyhow::anyhow!("Failed to get web listen address"))?;

        // Create services structure
        let services = Services {
            proxy: proxy_addr.to_string(),
            web: web_addr.to_string(),
        };

        // Write services.json to config root (app_dir)
        let services_path = app_dir.join("services.json");
        let services_json = serde_json::to_string_pretty(&services)?;
        std::fs::write(&services_path, services_json)?;
        info!("Services information written to: {:?}", services_path);

        // Detect Tailscale and display QR code for cert distribution
        tailscale::discover_and_display(web_addr).await;

        // Start transparent proxy if enabled
        let mut _transparent_proxy = None;
        if self.config.transparent.enabled {
            info!("Transparent proxy mode enabled, starting...");
            let resolver = tenant_resolver::build_resolver(
                &self.config.proxy.tenant_resolver,
                db_pool.clone(),
                self.config.proxy.tenant_header.clone(),
            );
            let upstream = crate::proxy::client(ca.clone())?;
            let shutdown_notify = Arc::new(tokio::sync::Notify::new());
            let mut tp = crate::proxy::transparent::TransparentProxy::new(
                Arc::new(ca),
                plugin_registry.clone(),
                resolver,
                upstream,
                self.config.transparent.clone(),
                shutdown_notify,
            );
            tp.start().await?;
            info!(
                "Transparent proxy listening on {}",
                tp.listen_addr().map(|a| a.to_string()).unwrap_or_default()
            );
            _transparent_proxy = Some(tp);
        }

        // Handle --auto flag: enable system proxy
        if self.auto {
            info!("Auto mode: enabling system proxy");
            let proxy_handler = proxy::ProxyHandler::new(self.config.clone());
            proxy_handler.enable_proxy_internal(false).await?;
        }

        // Set up file watcher for plugin directory if specified
        let _watcher = if let Some(ref plugin_dir) = self.plugin_dir {
            if let Some(ref registry) = plugin_registry {
                Some(setup_plugin_dir_watcher(
                    plugin_dir.clone(),
                    registry.clone(),
                )?)
            } else {
                None
            }
        } else {
            None
        };

        // Continue running the proxy
        proxy.join().await?;

        // Handle --auto flag: disable system proxy on shutdown
        if self.auto {
            info!("Auto mode: disabling system proxy on shutdown");
            let proxy_handler = proxy::ProxyHandler::new(self.config.clone());
            proxy_handler.disable_proxy_internal(false).await?;
        }

        proxy.shutdown().await;

        Ok(())
    }
}

/// Load all .wasm plugins from a directory into the registry
pub async fn load_plugins_from_directory(
    dir: &PathBuf,
    registry: Arc<RwLock<PluginRegistry>>,
) -> Result<()> {
    let entries = std::fs::read_dir(dir)?;

    for entry in entries {
        let entry = entry?;
        let path = entry.path();

        if path.is_file() && path.extension().is_some_and(|ext| ext == "wasm") {
            match load_plugin_from_file(&path, &registry).await {
                Ok(plugin_id) => {
                    info!("Loaded plugin from file: {:?} ({})", path, plugin_id);
                }
                Err(e) => {
                    warn!("Failed to load plugin from {:?}: {}", path, e);
                }
            }
        }
    }

    Ok(())
}

/// Load a single plugin from a .wasm file
async fn load_plugin_from_file(
    path: &PathBuf,
    registry: &Arc<RwLock<PluginRegistry>>,
) -> Result<String> {
    let component_bytes = std::fs::read(path)?;
    let mut registry = registry.write().await;
    let plugin = registry.plugin_from_component(component_bytes).await?;
    let plugin_id = plugin.id();
    registry.register_plugin(plugin).await?;
    Ok(plugin_id)
}

/// Set up a file watcher for the plugin directory
fn setup_plugin_dir_watcher(
    plugin_dir: PathBuf,
    registry: Arc<RwLock<PluginRegistry>>,
) -> Result<RecommendedWatcher> {
    let (tx, mut rx) = mpsc::channel::<notify::Result<NotifyEvent>>(100);

    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.blocking_send(res);
    })?;

    watcher.watch(&plugin_dir, RecursiveMode::NonRecursive)?;
    info!("Watching plugin directory for changes: {:?}", plugin_dir);

    // Track file -> plugin_id mapping for deletion handling
    let file_plugin_map: Arc<RwLock<HashMap<PathBuf, String>>> =
        Arc::new(RwLock::new(HashMap::new()));

    // Initialize the file map with current plugins
    let registry_clone = registry.clone();
    let plugin_dir_clone = plugin_dir.clone();
    let file_plugin_map_clone = file_plugin_map.clone();

    tokio::spawn(async move {
        // Initial scan to populate file_plugin_map
        if let Ok(entries) = std::fs::read_dir(&plugin_dir_clone) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file()
                    && path.extension().is_some_and(|ext| ext == "wasm")
                    && let Ok(component_bytes) = std::fs::read(&path)
                {
                    let reg = registry_clone.read().await;
                    if let Ok(plugin) = reg.plugin_from_component(component_bytes).await {
                        let mut map = file_plugin_map_clone.write().await;
                        map.insert(path, plugin.id());
                    }
                }
            }
        }
    });

    // Spawn task to handle file events
    let registry_for_handler = registry.clone();
    let file_plugin_map_for_handler = file_plugin_map;

    tokio::spawn(async move {
        while let Some(res) = rx.recv().await {
            match res {
                Ok(event) => {
                    handle_plugin_file_event(
                        event,
                        &registry_for_handler,
                        &file_plugin_map_for_handler,
                    )
                    .await;
                }
                Err(e) => {
                    error!("File watcher error: {}", e);
                }
            }
        }
    });

    Ok(watcher)
}

/// Handle a file system event for the plugin directory
async fn handle_plugin_file_event(
    event: NotifyEvent,
    registry: &Arc<RwLock<PluginRegistry>>,
    file_plugin_map: &Arc<RwLock<HashMap<PathBuf, String>>>,
) {
    use notify::EventKind;

    for path in event.paths {
        // Only handle .wasm files
        if path.extension().is_none_or(|ext| ext != "wasm") {
            continue;
        }

        match event.kind {
            EventKind::Create(_) | EventKind::Modify(ModifyKind::Data(_)) => {
                info!("Plugin file created/modified: {:?}", path);

                // Remove old plugin if it exists
                {
                    let map = file_plugin_map.read().await;
                    if let Some(old_plugin_id) = map.get(&path) {
                        let parts: Vec<&str> = old_plugin_id.split('/').collect();
                        if parts.len() == 2 {
                            let mut reg = registry.write().await;
                            match reg.remove_plugin(parts[1], Some(parts[0])).await {
                                Ok(removed) => {
                                    if !removed.is_empty() {
                                        info!("Removed old plugin version: {}", old_plugin_id);
                                    }
                                }
                                Err(e) => {
                                    warn!("Failed to remove old plugin {}: {}", old_plugin_id, e);
                                }
                            }
                        }
                    }
                }

                // Load new plugin
                match load_plugin_from_file(&path, registry).await {
                    Ok(plugin_id) => {
                        info!("Loaded/updated plugin: {} from {:?}", plugin_id, path);
                        let mut map = file_plugin_map.write().await;
                        map.insert(path.clone(), plugin_id);
                    }
                    Err(e) => {
                        warn!("Failed to load plugin from {:?}: {}", path, e);
                    }
                }
            }
            EventKind::Remove(_) => {
                info!("Plugin file removed: {:?}", path);

                let plugin_id = {
                    let mut map = file_plugin_map.write().await;
                    map.remove(&path)
                };

                if let Some(plugin_id) = plugin_id {
                    let parts: Vec<&str> = plugin_id.split('/').collect();
                    if parts.len() == 2 {
                        let mut reg = registry.write().await;
                        match reg.remove_plugin(parts[1], Some(parts[0])).await {
                            Ok(removed) => {
                                if !removed.is_empty() {
                                    info!("Removed plugin: {}", plugin_id);
                                }
                            }
                            Err(e) => {
                                warn!("Failed to remove plugin {}: {}", plugin_id, e);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}
