use anyhow::Result;
use clap::{Parser, Subcommand};
use confique::Config;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::RwLock;
use tracing::info;
use crate::{
    config::confique_partial_app_config::PartialAppConfig, db::Db,
    plugins::registry::PluginRegistry, wasm::Runtime, AppConfig, CertificateAuthority, WitmProxy,
};
use cargo_generate::{generate, GenerateArgs, TemplatePath};
use std::env;

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
    config: PartialAppConfig,

    /// Enable verbose logging
    #[arg(short, long)]
    verbose: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Plugin management commands
    Plugin {
        #[command(subcommand)]
        command: PluginCommands,
    },
}

#[derive(Subcommand)]
enum PluginCommands {
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

impl Cli {
    pub async fn run(&self) -> Result<()> {

        let log_level = if self.verbose {
            "debug"
        } else {
            "info"
        };
        tracing_subscriber::fmt()
            .with_env_filter(format!("witmproxy={},{}", log_level, log_level))
            .init();
        
        // Handle subcommands first
        if let Some(command) = &self.command {
            return self.handle_command(command).await;
        }

        // Default behavior - run the proxy
        self.run_proxy().await
    }

    async fn handle_command(&self, command: &Commands) -> Result<()> {
        match command {
            Commands::Plugin { command } => self.handle_plugin_command(command).await,
        }
    }

    async fn handle_plugin_command(&self, command: &PluginCommands) -> Result<()> {
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
            Some(path) => {
                std::fs::canonicalize(path).unwrap_or_else(|_| path.clone())
            }
            None => env::current_dir()?
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
            define: vec![
                format!("plugin-name={}", plugin_name),
            ],
            init: false,
            destination: Some(destination),
            force_git_init: true,
            allow_commands: false,
            overwrite: false,
            skip_submodules: false,
            other_args: None,
        };

        generate(args)?;

        Ok(())
    }

    async fn add_plugin(&self, source: &str) -> Result<()> {
        use std::path::Path;
        
        // For now, only handle local WASM files
        let path = Path::new(source);
        if !path.exists() {
            anyhow::bail!("File does not exist: {}", source);
        }
        
        if !path.extension().map_or(false, |ext| ext == "wasm") {
            anyhow::bail!("Only .wasm files are supported for local installation");
        }

        // Read the WASM file
        let component_bytes = std::fs::read(path)?;
        info!("Read WASM component from: {}", source);

        // Initialize database
        let home_dir = dirs::home_dir().unwrap_or(".".into());
        let config_path = self
            .config_path
            .to_str()
            .unwrap_or("")
            .replace("$HOME", home_dir.to_str().unwrap_or("."));
        let config_path = PathBuf::from(config_path);
        let config = AppConfig::builder()
            .preloaded(self.config.clone())
            .env()
            .file(&config_path)
            .load()?;

        let db_file_path = config
            .db
            .db_path
            .to_str()
            .unwrap_or("")
            .replace("$HOME", home_dir.to_str().unwrap_or("."));

        if let Some(parent) = PathBuf::from(&db_file_path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db_path = format!("sqlite://{}", db_file_path);

        let db = Db::from_path(&db_path, &config.db.db_password).await?;
        db.migrate().await?;

        // Create runtime and registry
        let runtime = Runtime::default()?;
        let mut registry = PluginRegistry::new(db, runtime);

        // Create plugin from component bytes (including signature verification)
        let plugin = registry.plugin_from_component(component_bytes).await?;
        
        info!("Created plugin: {} ({}:{})", plugin.name, plugin.namespace, plugin.version);

        // Register the plugin
        registry.register_plugin(plugin).await?;
        
        println!("Plugin successfully added from {}", source);
        Ok(())
    }

    async fn remove_plugin(&self, plugin_name: &str) -> Result<()> {
        // Initialize database
        let home_dir = dirs::home_dir().unwrap_or(".".into());
        let config_path = self
            .config_path
            .to_str()
            .unwrap_or("")
            .replace("$HOME", home_dir.to_str().unwrap_or("."));
        let config_path = PathBuf::from(config_path);
        let config = AppConfig::builder()
            .preloaded(self.config.clone())
            .env()
            .file(&config_path)
            .load()?;

        let db_file_path = config
            .db
            .db_path
            .to_str()
            .unwrap_or("")
            .replace("$HOME", home_dir.to_str().unwrap_or("."));

        if let Some(parent) = PathBuf::from(&db_file_path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db_path = format!("sqlite://{}", db_file_path);

        let db = Db::from_path(&db_path, &config.db.db_password).await?;
        db.migrate().await?;

        // Create runtime and registry
        let runtime = Runtime::default()?;
        let mut registry = PluginRegistry::new(db, runtime);
        registry.load_plugins().await?;

        // Check if plugin_name contains a slash (indicating namespace/name format)
        let matching_plugin_ids = if plugin_name.contains('/') {
            // Direct namespace/name format - look for exact match
            let plugin_id = plugin_name.to_string();
            if registry.plugins.contains_key(&plugin_id) {
                vec![plugin_id]
            } else {
                Vec::new()
            }
        } else {
            // Just name provided - find all plugins with matching name
            registry.plugins
                .iter()
                .filter(|(_, p)| p.name == plugin_name)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>()
        };

        if matching_plugin_ids.is_empty() {
            anyhow::bail!("No plugin found with name '{}'", plugin_name);
        }

        if matching_plugin_ids.len() > 1 {
            println!("Multiple plugins found with name '{}'. Please specify with namespace:", plugin_name);
            for plugin_id in &matching_plugin_ids {
                println!("  {}", plugin_id);
            }
            anyhow::bail!("Please re-run the command with a specific namespace/name");
        }

        let plugin_id_to_remove = &matching_plugin_ids[0];
        let plugin_to_remove = registry.plugins.get(plugin_id_to_remove)
            .ok_or_else(|| anyhow::anyhow!("Plugin not found in registry"))?;
        
        info!("Removing plugin: {} ({}:{})", plugin_to_remove.name, plugin_to_remove.namespace, plugin_to_remove.version);

        // Remove from database
        plugin_to_remove.delete(&mut registry.db).await?;
        
        // Remove from in-memory registry
        registry.plugins.remove(plugin_id_to_remove);
        
        println!("Plugin '{}' successfully removed", plugin_id_to_remove);
        Ok(())
    }

    async fn run_proxy(&self) -> Result<()> {
        // Resolve home and app directory
        let home_dir = dirs::home_dir().unwrap_or(".".into());
        let app_dir = home_dir.join(".witmproxy");
        std::fs::create_dir_all(&app_dir)?;

        let config_path = self
            .config_path
            .to_str()
            .unwrap_or("")
            .replace("$HOME", home_dir.to_str().unwrap_or("."));
        let config_path = PathBuf::from(config_path);
        let config = AppConfig::builder()
            .preloaded(self.config.clone())
            .env()
            .file(&config_path)
            .load()?;

        info!("Loaded proxy configuration");

        // Create certificate authority
        let cert_dir: PathBuf = config
            .tls
            .cert_dir
            .clone()
            .to_str()
            .unwrap_or("")
            .replace("$HOME", home_dir.to_str().unwrap_or("."))
            .parse()?;
        std::fs::create_dir_all(&cert_dir)?;

        let ca = CertificateAuthority::new(cert_dir).await?;
        info!("Certificate Authority initialized");

        // Initialize the database and perform any necessary migrations
        let db_file_path = config
            .db
            .db_path
            .to_str()
            .unwrap_or("")
            .replace("$HOME", home_dir.to_str().unwrap_or("."));

        // Create the parent directory of the database file
        if let Some(parent) = PathBuf::from(&db_file_path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db_path = format!("sqlite://{}", db_file_path);

        let db = Db::from_path(&db_path, &config.db.db_password).await?;
        db.migrate().await?;
        info!("Database initialized and migrated at: {}", db_path);

        // Plugin registry which will be shared across the proxy and web server
        let plugin_registry = if config.plugins.enabled {
            let runtime = Runtime::default()?;
            let mut registry = PluginRegistry::new(db, runtime);
            registry.load_plugins().await?;
            info!("Loaded {} plugins", registry.plugins.len());
            Some(Arc::new(RwLock::new(registry)))
        } else {
            None
        };

        let mut proxy = WitmProxy::new(
            ca,
            plugin_registry,
            config
        );
        proxy.run().await?;

        Ok(())
    }
}