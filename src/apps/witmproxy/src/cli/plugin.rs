use crate::{AppConfig, db::Db, plugins::registry::PluginRegistry, wasm::Runtime};
use anyhow::Result;
use cargo_generate::{GenerateArgs, TemplatePath, generate};
use clap::Subcommand;
use std::env;
use std::path::{Path, PathBuf};
use tracing::{debug, info};

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

        let db = Db::from_path(self.config.db.db_path.clone(), &self.config.db.db_password).await?;
        db.migrate().await?;

        // Create runtime and registry
        let runtime = Runtime::try_default()?;
        let mut registry = PluginRegistry::new(db, runtime)?;

        // Create plugin from component bytes (including signature verification)
        let mut plugin = registry.plugin_from_component(component_bytes).await?;
        // TODO: DON'T GRANT ALL THE THINGS ALWAYS
        plugin.capabilities.connect.granted = true;

        if let Some(ref mut r) = plugin.capabilities.request {
            r.granted = true
        };

        if let Some(ref mut r) = plugin.capabilities.response {
            r.granted = true
        };

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
        let db = Db::from_path(self.config.db.db_path.clone(), &self.config.db.db_password).await?;
        db.migrate().await?;

        let runtime = Runtime::try_default()?;
        let mut registry = PluginRegistry::new(db, runtime)?;

        let (name, namespace) = match plugin_name.split_once("/") {
            Some((ns, n)) => (n.to_string(), Some(ns.to_string())),
            None => (plugin_name.to_string(), None),
        };

        registry.remove_plugin(&name, namespace.as_deref()).await?;
        Ok(())
    }
}
