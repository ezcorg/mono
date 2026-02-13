use super::Services;
use crate::cert::ca::get_root_cert_path;
use crate::{AppConfig, db::Db, plugins::registry::PluginRegistry, wasm::Runtime};
use anyhow::Result;
use cargo_generate::{GenerateArgs, TemplatePath, generate};
use clap::Subcommand;
use std::env;
use std::path::{Path, PathBuf};
use tracing::{debug, info, warn};

#[derive(Subcommand)]
pub enum PluginCommands {
    /// Create a new plugin from a template
    New {
        /// Name of the plugin
        plugin_name: String,
        /// Programming language for the plugin
        #[arg(short, long, default_value = "rust")]
        language: String,
        /// Destination directory for the generated plugin
        #[arg(short, long)]
        dest: Option<PathBuf>,
    },
    /// Add a plugin from local path, remote URL, or plugin name
    Add {
        /// Local path, remote URL, or plugin name
        source: String,
    },
    /// Remove a plugin by name or namespace/name
    Remove {
        /// Plugin name or namespace/name to remove
        plugin_name: String,
    },
}

/// Plugin command handler that contains the resolved configuration and verbose flag
pub struct PluginHandler {
    pub config: AppConfig,
    pub verbose: bool,
}

impl PluginHandler {
    pub fn new(config: AppConfig, verbose: bool) -> Self {
        Self { config, verbose }
    }

    pub async fn handle(&self, command: &PluginCommands) -> Result<()> {
        match command {
            PluginCommands::New {
                plugin_name,
                language,
                dest,
            } => self.create_new_plugin(plugin_name, language, dest).await,
            PluginCommands::Add { source } => self.add_plugin(source).await,
            PluginCommands::Remove { plugin_name } => self.remove_plugin(plugin_name).await,
        }
    }

    /// Try to read the web server URL from services.json
    fn get_web_url(&self) -> Option<String> {
        let app_dir = self
            .config
            .tls
            .cert_dir
            .parent()
            .unwrap_or(&PathBuf::from("."))
            .to_path_buf();

        let services_path = app_dir.join("services.json");
        let services_content = std::fs::read_to_string(&services_path).ok()?;
        let services: Services = serde_json::from_str(&services_content).ok()?;

        Some(services.web)
    }

    /// Build a reqwest client that trusts our CA certificate
    fn build_client(&self) -> Result<reqwest::Client> {
        let ca_cert_path = get_root_cert_path(&self.config.tls.cert_dir);
        let ca_cert_pem = std::fs::read(&ca_cert_path)?;
        let ca_cert = reqwest::Certificate::from_pem(&ca_cert_pem)?;

        Ok(reqwest::Client::builder()
            .add_root_certificate(ca_cert)
            .build()?)
    }

    /// Try to add plugin via the running daemon's web API.
    /// Returns Ok(true) if successful, Ok(false) if the daemon is unreachable.
    async fn try_add_via_web(&self, wasm_bytes: &[u8]) -> Result<bool> {
        let web_addr = match self.get_web_url() {
            Some(addr) => addr,
            None => return Ok(false),
        };

        let client = match self.build_client() {
            Ok(c) => c,
            Err(e) => {
                debug!("Failed to build HTTP client: {}", e);
                return Ok(false);
            }
        };

        let url = format!("https://{}/api/plugins", web_addr);
        let part = reqwest::multipart::Part::bytes(wasm_bytes.to_vec())
            .file_name("plugin.wasm")
            .mime_str("application/wasm")?;
        let form = reqwest::multipart::Form::new().part("file", part);

        match client.post(&url).multipart(form).send().await {
            Ok(resp) => {
                if resp.status().is_success() {
                    info!("Plugin added via running daemon");
                    Ok(true)
                } else {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    anyhow::bail!("Daemon returned {}: {}", status, body);
                }
            }
            Err(e) if e.is_connect() || e.is_timeout() => {
                debug!("Daemon unreachable: {}", e);
                Ok(false)
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Try to remove plugin via the running daemon's web API.
    /// Returns Ok(true) if successful, Ok(false) if the daemon is unreachable.
    async fn try_remove_via_web(&self, name: &str, namespace: Option<&str>) -> Result<bool> {
        let web_addr = match self.get_web_url() {
            Some(addr) => addr,
            None => return Ok(false),
        };

        let client = match self.build_client() {
            Ok(c) => c,
            Err(e) => {
                debug!("Failed to build HTTP client: {}", e);
                return Ok(false);
            }
        };

        let ns = namespace.unwrap_or("default");
        let url = format!("https://{}/api/plugins/{}/{}", web_addr, ns, name);

        match client.delete(&url).send().await {
            Ok(resp) => {
                if resp.status().is_success() {
                    info!("Plugin removed via running daemon");
                    Ok(true)
                } else {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    anyhow::bail!("Daemon returned {}: {}", status, body);
                }
            }
            Err(e) if e.is_connect() || e.is_timeout() => {
                debug!("Daemon unreachable: {}", e);
                Ok(false)
            }
            Err(e) => Err(e.into()),
        }
    }

    // TODO: LLM garbage here
    async fn create_new_plugin(
        &self,
        plugin_name: &str,
        language: &str,
        dest: &Option<PathBuf>,
    ) -> Result<()> {
        let template_path = match language {
            "rust" => TemplatePath {
                auto_path: None,
                subfolder: None,
                test: false,
                git: Some("https://github.com/ezcorg/witmproxy-plugin-template-rust".to_string()),
                branch: Some("main".to_string()),
                tag: None,
                revision: None,
                path: None,
                favorite: None,
            },
            _ => {
                anyhow::bail!(
                    "Unsupported language: {}. Currently supported: rust",
                    language
                );
            }
        };
        // Resolve destination path
        let destination = match dest {
            Some(path) => std::fs::canonicalize(path).unwrap_or_else(|_| path.clone()),
            None => env::current_dir()?,
        };
        std::fs::create_dir_all(destination.as_path())?;

        info!(
            "Creating new plugin '{}' using {} template at destination: {:?}",
            plugin_name, language, destination
        );

        let args = GenerateArgs {
            template_path,
            list_favorites: false,
            name: Some(plugin_name.to_string()),
            force: false,
            verbose: self.verbose,
            quiet: false,
            continue_on_error: false,
            template_values_file: None,
            silent: false,
            config: None,
            vcs: None,
            lib: true,
            bin: false,
            ssh_identity: None,
            gitconfig: None,
            define: vec![format!("plugin-name={}", plugin_name)],
            init: false,
            destination: Some(destination),
            force_git_init: false,
            allow_commands: false,
            overwrite: false,
            skip_submodules: false,
            other_args: None,
            no_workspace: false,
        };

        generate(args)?;

        Ok(())
    }

    async fn add_plugin(&self, source: &str) -> Result<()> {
        // For now, only handle local WASM files
        let path = Path::new(source);
        if !path.exists() {
            anyhow::bail!("File does not exist: {}", source);
        }

        if path.extension().is_none_or(|ext| ext != "wasm") {
            anyhow::bail!("Only .wasm files are supported for local installation");
        }

        // Read the WASM file
        let component_bytes = std::fs::read(path)?;

        // Try the web API first (daemon may be running)
        match self.try_add_via_web(&component_bytes).await {
            Ok(true) => return Ok(()),
            Ok(false) => {
                warn!("Daemon not reachable, falling back to direct DB access");
            }
            Err(e) => return Err(e),
        }

        // Fall back to direct DB access
        let db = Db::from_path(self.config.db.db_path.clone(), &self.config.db.db_password).await?;
        db.migrate().await?;

        // Create runtime and registry
        let runtime = Runtime::try_default()?;
        let mut registry = PluginRegistry::new(db, runtime)?;

        // Create plugin from component bytes (including signature verification)
        let mut plugin = registry.plugin_from_component(component_bytes).await?;
        // TODO: DON'T GRANT ALL THE THINGS ALWAYS
        plugin
            .capabilities
            .iter_mut()
            .for_each(|cap| cap.granted = true);

        debug!(
            "Received plugin: {}/{}:{}",
            plugin.namespace, plugin.name, plugin.version
        );

        // Register the plugin
        registry.register_plugin(plugin).await?;

        info!("Plugin successfully added from {}", source);
        Ok(())
    }

    async fn remove_plugin(&self, plugin_name: &str) -> Result<()> {
        let (name, namespace) = match plugin_name.split_once("/") {
            Some((ns, n)) => (n.to_string(), Some(ns.to_string())),
            None => (plugin_name.to_string(), None),
        };

        // Try the web API first (daemon may be running)
        match self.try_remove_via_web(&name, namespace.as_deref()).await {
            Ok(true) => return Ok(()),
            Ok(false) => {
                warn!("Daemon not reachable, falling back to direct DB access");
            }
            Err(e) => return Err(e),
        }

        // Fall back to direct DB access
        let db = Db::from_path(self.config.db.db_path.clone(), &self.config.db.db_password).await?;
        db.migrate().await?;

        let runtime = Runtime::try_default()?;
        let mut registry = PluginRegistry::new(db, runtime)?;

        registry.remove_plugin(&name, namespace.as_deref()).await?;
        Ok(())
    }
}
