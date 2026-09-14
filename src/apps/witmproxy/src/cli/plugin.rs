// The `Conf` / `Subcommands` derives generate public interfaces over these
// types, so they must stay `pub` even though this module is private and
// nothing outside the crate can name them. `pub(crate)` fails with E0446.
#![allow(unreachable_pub)]

use super::GlobalArgs;
use crate::cli::api_client::{ApiClient, DaemonAuthArgs, LocalDaemon};
use crate::{config::PluginScopedConfig, db::Db, plugins::registry::PluginRegistry, wasm::Runtime};
use anyhow::Result;
use conf::{Conf, Subcommands};
use std::path::{Path, PathBuf};
use tracing::{debug, info, warn};

/// Every leaf reads its config subset from the `[config]` file section: the
/// variants are all `serde(rename = "config")` and `Cli::parse_args` mirrors
/// the `[config]` table under this command's doc key (see
/// `mirror_config_for_nested_commands`).
#[derive(Subcommands)]
#[conf(serde)]
pub enum PluginCommands {
    /// List all installed plugins
    #[conf(serde(rename = "config"))]
    List(PluginListArgs),
    /// Create a new plugin from a template
    #[conf(serde(rename = "config"))]
    New(PluginNewArgs),
    /// Add a plugin from a local path or URL
    #[conf(serde(rename = "config"))]
    Add(PluginAddArgs),
    /// Remove a plugin by name or namespace/name
    #[conf(serde(rename = "config"))]
    Remove(PluginRemoveArgs),
    /// View or set configuration values for an installed plugin
    #[conf(serde(rename = "config"))]
    Configure(PluginConfigureArgs),
}

impl PluginCommands {
    /// The config scope + shared flags carried by whichever leaf was invoked.
    pub(crate) fn scope(&self) -> (&PluginScopedConfig, &GlobalArgs) {
        match self {
            PluginCommands::List(a) => (&a.config, &a.globals),
            PluginCommands::New(a) => (&a.config, &a.globals),
            PluginCommands::Add(a) => (&a.config, &a.globals),
            PluginCommands::Remove(a) => (&a.config, &a.globals),
            PluginCommands::Configure(a) => (&a.config, &a.globals),
        }
    }
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct PluginListArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten, serde(flatten))]
    pub config: PluginScopedConfig,
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct PluginNewArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten, serde(flatten))]
    pub config: PluginScopedConfig,

    /// Name of the plugin
    #[arg(pos)]
    pub plugin_name: String,
    /// Programming language for the plugin
    #[arg(short, long, default_value = "rust")]
    pub language: String,
    /// Destination directory for the generated plugin
    #[arg(short, long)]
    pub dest: Option<PathBuf>,
    /// Plugin namespace (used to scope the plugin's identity)
    #[arg(long)]
    pub namespace: Option<String>,
    /// Plugin author; defaults to `git config user.name`
    #[arg(long)]
    pub author: Option<String>,
    /// Short description of what the plugin does
    #[arg(long)]
    pub description: Option<String>,
    /// SPDX license identifier for the generated project
    #[arg(long)]
    pub license: Option<String>,
    /// Homepage URL for the plugin
    #[arg(long)]
    pub url: Option<String>,
    /// Overwrite files that already exist in the destination
    #[arg(long)]
    pub force: bool,
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct PluginAddArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten, serde(flatten))]
    pub config: PluginScopedConfig,
    #[conf(flatten)]
    pub auth: DaemonAuthArgs,

    /// Local .wasm file path or URL (https://...)
    #[arg(pos)]
    pub source: String,
    /// Path to a trusted public key file to verify the plugin was signed
    /// by a known author (not just self-signed)
    #[arg(short, long)]
    pub public_key: Option<PathBuf>,
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct PluginRemoveArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten, serde(flatten))]
    pub config: PluginScopedConfig,
    #[conf(flatten)]
    pub auth: DaemonAuthArgs,

    /// Plugin name or namespace/name to remove
    #[arg(pos)]
    pub plugin_name: String,
}

#[derive(Conf)]
#[conf(serde(allow_unknown_fields))]
pub struct PluginConfigureArgs {
    #[conf(flatten)]
    pub globals: GlobalArgs,
    #[conf(flatten, serde(flatten))]
    pub config: PluginScopedConfig,

    /// Plugin name or namespace/name (e.g. "@ezco/noop")
    #[arg(pos)]
    pub plugin_name: String,
    /// Set a configuration value (format: key=value), may be repeated
    #[arg(repeat, short = 's', long = "set")]
    pub set_values: Vec<String>,
}

/// Plugin command handler that contains the resolved configuration and verbose flag
pub struct PluginHandler {
    pub config: PluginScopedConfig,
}

impl PluginHandler {
    pub fn new(config: PluginScopedConfig, _verbose: bool) -> Self {
        Self { config }
    }

    pub async fn handle(&self, command: &PluginCommands) -> Result<()> {
        match command {
            PluginCommands::List(_) => self.list_plugins().await,
            PluginCommands::New(a) => self.create_new_plugin(a).await,
            PluginCommands::Add(a) => {
                self.add_plugin(&a.source, a.public_key.as_deref(), &a.auth)
                    .await
            }
            PluginCommands::Remove(a) => self.remove_plugin(&a.plugin_name, &a.auth).await,
            PluginCommands::Configure(a) => {
                self.configure_plugin(&a.plugin_name, &a.set_values).await
            }
        }
    }

    /// The management API client for this command, or `None` when no server
    /// is known (no login, no local daemon): callers then work on the
    /// database directly.
    fn daemon_client(&self, auth: &DaemonAuthArgs) -> Result<Option<ApiClient>> {
        ApiClient::resolve(auth, LocalDaemon::from_tls(&self.config.tls))
    }

    /// Turn a daemon reply into a result: `Ok(true)` on success, `Ok(false)`
    /// when the daemon could not be reached, and an error with a usable hint
    /// when it refused.
    async fn daemon_outcome(
        client: &ApiClient,
        sent: std::result::Result<reqwest::Response, anyhow::Error>,
        done: &str,
    ) -> Result<bool> {
        match sent {
            Ok(resp) if resp.status().is_success() => {
                info!("{done} via {}", client.base_url());
                Ok(true)
            }
            Ok(resp) => {
                let status = resp.status();
                if let Some(hint) = client.auth_hint(status) {
                    anyhow::bail!("{hint}");
                }
                let body = resp.text().await.unwrap_or_default();
                anyhow::bail!("Daemon returned {}: {}", status, body);
            }
            Err(e) => {
                let reqwest_err = e.downcast_ref::<reqwest::Error>();
                if reqwest_err.is_some_and(|e| e.is_connect() || e.is_timeout()) {
                    debug!("Daemon unreachable: {}", e);
                    Ok(false)
                } else {
                    Err(e)
                }
            }
        }
    }

    /// Try to add plugin via the running daemon's web API.
    /// Returns Ok(true) if successful, Ok(false) if the daemon is unreachable.
    async fn try_add_via_web(
        &self,
        wasm_bytes: &[u8],
        expected_key: Option<&[u8]>,
        auth: &DaemonAuthArgs,
    ) -> Result<bool> {
        let Some(client) = self.daemon_client(auth)? else {
            return Ok(false);
        };
        let part = reqwest::multipart::Part::bytes(wasm_bytes.to_vec())
            .file_name("plugin.wasm")
            .mime_str("application/wasm")?;
        let form = reqwest::multipart::Form::new().part("file", part);
        let headers: Vec<(&str, String)> = expected_key
            .map(|key| vec![("X-Expected-Public-Key", hex::encode(key))])
            .unwrap_or_default();

        let sent = client.post_multipart("/api/plugins", form, &headers).await;
        Self::daemon_outcome(&client, sent, "Plugin added").await
    }

    /// Try to remove plugin via the running daemon's web API.
    /// Returns Ok(true) if successful, Ok(false) if the daemon is unreachable.
    async fn try_remove_via_web(
        &self,
        name: &str,
        namespace: Option<&str>,
        auth: &DaemonAuthArgs,
    ) -> Result<bool> {
        let Some(client) = self.daemon_client(auth)? else {
            return Ok(false);
        };
        let ns = namespace.unwrap_or("default");
        let sent = client
            .delete(&format!("/api/plugins/{}/{}", ns, name))
            .await;
        Self::daemon_outcome(&client, sent, "Plugin removed").await
    }

    async fn list_plugins(&self) -> Result<()> {
        let db_password = self.config.db.resolve_password()?;
        let db = Db::from_path(self.config.db.db_path.clone(), db_password.expose()).await?;
        drop(db_password);
        db.migrate().await?;

        let rows = sqlx::query(
            "SELECT namespace, name, version, author, description, license, url, enabled FROM plugins ORDER BY namespace, name",
        )
        .fetch_all(&db.pool)
        .await?;

        if rows.is_empty() {
            println!("No plugins installed.");
            return Ok(());
        }

        println!("Installed plugins:\n");
        for row in &rows {
            let namespace: String = sqlx::Row::try_get(row, "namespace")?;
            let name: String = sqlx::Row::try_get(row, "name")?;
            let version: String = sqlx::Row::try_get(row, "version")?;
            let author: String = sqlx::Row::try_get(row, "author")?;
            let description: String = sqlx::Row::try_get(row, "description")?;
            let license: String = sqlx::Row::try_get(row, "license")?;
            let url: String = sqlx::Row::try_get(row, "url")?;
            let enabled: bool = sqlx::Row::try_get(row, "enabled")?;

            println!("  {}/{} v{}", namespace, name, version);
            if !description.is_empty() {
                println!("    {}", description);
            }
            if !author.is_empty() {
                println!("    Author:  {}", author);
            }
            if !license.is_empty() {
                println!("    License: {}", license);
            }
            if !url.is_empty() {
                println!("    URL:     {}", url);
            }
            println!("    Enabled: {}", if enabled { "yes" } else { "no" });

            // Show capabilities
            let cap_rows = sqlx::query(
                "SELECT capability, granted FROM plugin_capabilities WHERE namespace = ? AND name = ?",
            )
            .bind(&namespace)
            .bind(&name)
            .fetch_all(&db.pool)
            .await?;
            if !cap_rows.is_empty() {
                let caps: Vec<String> = cap_rows
                    .iter()
                    .map(|r| {
                        let cap: String = sqlx::Row::try_get(r, "capability").unwrap_or_default();
                        let granted: bool = sqlx::Row::try_get(r, "granted").unwrap_or(false);
                        if granted {
                            cap
                        } else {
                            format!("{} (denied)", cap)
                        }
                    })
                    .collect();
                println!("    Capabilities: {}", caps.join(", "));
            }
            println!();
        }

        println!("{} plugin(s) installed.", rows.len());
        Ok(())
    }

    /// Scaffold a new plugin project from the templates embedded in this binary.
    ///
    /// Previously this shelled out to `cargo-generate` to clone a template repo
    /// over git. That pulled libgit2, libssh2 and a second vendored OpenSSL into
    /// the dependency tree (behind the `plugin-new` feature) to do work that is,
    /// in substance, variable substitution over a handful of files. It also let
    /// the template drift from the host: the generated project got whatever WIT
    /// was on the template repo's `main`, which is not necessarily the WIT world
    /// this binary implements. The embedded templates vendor `wit/` from this
    /// build, so a scaffolded plugin always matches its host.
    async fn create_new_plugin(&self, args: &PluginNewArgs) -> Result<()> {
        use crate::cli::template::{ScaffoldOptions, scaffold};

        let destination = match &args.dest {
            Some(path) => std::fs::canonicalize(path).unwrap_or_else(|_| path.clone()),
            None => std::env::current_dir()?,
        };

        let opts = ScaffoldOptions {
            plugin_name: args.plugin_name.clone(),
            language: args.language.clone(),
            destination,
            namespace: args.namespace.clone(),
            author: args.author.clone(),
            description: args.description.clone(),
            license: args.license.clone(),
            url: args.url.clone(),
            force: args.force,
        };

        let root = scaffold(&opts)?;

        info!(
            plugin_name = %args.plugin_name,
            language = %args.language,
            path = %root.display(),
            "created new plugin project"
        );

        println!(
            "Created plugin `{}` at {}",
            args.plugin_name,
            root.display()
        );
        println!();
        println!("Next steps:");
        println!("  cd {}", root.display());
        println!("  make                 # generate signing keys, build, and sign");
        println!(
            "  witm plugin add target/wasm32-wasip2/release/{}.signed.wasm",
            args.plugin_name.replace('-', "_")
        );

        Ok(())
    }

    /// Fetch WASM bytes from a URL or local file path.
    async fn read_wasm_source(&self, source: &str) -> Result<Vec<u8>> {
        if source.starts_with("https://") || source.starts_with("http://") {
            eprintln!("Downloading plugin from {}...", source);
            let client = reqwest::Client::builder()
                .user_agent("witmproxy")
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()?;
            let resp = client.get(source).send().await?;
            if !resp.status().is_success() {
                anyhow::bail!("Download failed: HTTP {}", resp.status());
            }
            let bytes = resp.bytes().await?.to_vec();
            // Sanity check: WASM files start with \0asm
            if !bytes.starts_with(&[0x00, b'a', b's', b'm']) {
                anyhow::bail!("Downloaded file does not appear to be a valid WASM component");
            }
            eprintln!("Downloaded {} bytes.", bytes.len());
            Ok(bytes)
        } else {
            let path = Path::new(source);
            if !path.exists() {
                anyhow::bail!("File does not exist: {}", source);
            }
            if path.extension().is_none_or(|ext| ext != "wasm") {
                anyhow::bail!("Only .wasm files are supported");
            }
            Ok(std::fs::read(path)?)
        }
    }

    async fn add_plugin(
        &self,
        source: &str,
        public_key_path: Option<&Path>,
        auth: &DaemonAuthArgs,
    ) -> Result<()> {
        let component_bytes = self.read_wasm_source(source).await?;

        // Read expected public key if provided
        let expected_key = match public_key_path {
            Some(path) => {
                let key_bytes = std::fs::read(path)
                    .map_err(|e| anyhow::anyhow!("Failed to read public key {:?}: {}", path, e))?;
                Some(key_bytes)
            }
            None => None,
        };

        // Try the web API first (daemon may be running)
        match self
            .try_add_via_web(&component_bytes, expected_key.as_deref(), auth)
            .await
        {
            Ok(true) => return Ok(()),
            Ok(false) => {
                warn!("Daemon not reachable, falling back to direct DB access");
            }
            Err(e) => return Err(e),
        }

        // Fall back to direct DB access
        let db_password = self.config.db.resolve_password()?;
        let db = Db::from_path(self.config.db.db_path.clone(), db_password.expose()).await?;
        drop(db_password);
        db.migrate().await?;

        // Create runtime and registry
        let runtime = Runtime::try_default()?;
        let registry = PluginRegistry::new(db, runtime)?;

        // Create plugin from component bytes (including signature verification)
        let mut plugin = registry
            .plugin_from_component_with_key(component_bytes, expected_key.as_deref())
            .await?;
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

    /// Load the plugin's declared inputs by instantiating its stored component.
    ///
    /// The manifest is the only place the schema lives; it is not persisted.
    /// Instantiation costs a component compile (well under a second), which
    /// is fine for a command a person runs by hand.
    async fn input_schema_for(
        &self,
        db: &Db,
        namespace: &str,
        name: &str,
    ) -> Result<Option<Vec<crate::wasm::bindgen::InputSchema>>> {
        let row = sqlx::query("SELECT component FROM plugins WHERE namespace = ? AND name = ?")
            .bind(namespace)
            .bind(name)
            .fetch_optional(&db.pool)
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let component: Vec<u8> = sqlx::Row::try_get(&row, "component")?;
        let runtime = Runtime::try_default()?;
        let registry = PluginRegistry::new(db.clone(), runtime)?;
        let plugin = registry.plugin_from_component(component).await?;
        Ok(Some(plugin.input_schema))
    }

    async fn configure_plugin(&self, plugin_name: &str, set_values: &[String]) -> Result<()> {
        use crate::plugins::inputs::{coerce_input, display_input, display_type};
        use crate::wasm::bindgen::ActualInput;

        let (name, namespace) = match plugin_name.split_once("/") {
            Some((ns, n)) => (n.to_string(), ns.to_string()),
            None => (plugin_name.to_string(), "default".to_string()),
        };

        let db_password = self.config.db.resolve_password()?;
        let db = Db::from_path(self.config.db.db_path.clone(), db_password.expose()).await?;
        drop(db_password);
        db.migrate().await?;

        let Some(schema) = self.input_schema_for(&db, &namespace, &name).await? else {
            anyhow::bail!(
                "Plugin {}/{} is not installed (see `witm plugin list`)",
                namespace,
                name
            );
        };

        if set_values.is_empty() {
            // Describe: what the plugin declares, and what is currently set.
            let rows = sqlx::query(
                "SELECT input_name, input_value FROM plugin_configuration WHERE namespace = ? AND name = ?",
            )
            .bind(&namespace)
            .bind(&name)
            .fetch_all(&db.pool)
            .await?;
            let current: Vec<(String, String)> = rows
                .iter()
                .map(|row| {
                    let input_name: String =
                        sqlx::Row::try_get(row, "input_name").unwrap_or_default();
                    let input_value: String =
                        sqlx::Row::try_get(row, "input_value").unwrap_or_default();
                    let rendered = serde_json::from_str::<ActualInput>(&input_value)
                        .map(|v| display_input(&v))
                        .unwrap_or(input_value);
                    (input_name, rendered)
                })
                .collect();

            if schema.is_empty() {
                println!("{}/{} declares no configuration inputs.", namespace, name);
            } else {
                println!("Settings declared by {}/{}:\n", namespace, name);
                for input in &schema {
                    let set = current
                        .iter()
                        .find(|(n, _)| *n == input.name)
                        .map(|(_, v)| v);
                    let default = input.default.as_ref().map(display_input);
                    println!("  {} ({})", input.name, display_type(&input.input_type));
                    if let Some(desc) = &input.description {
                        println!("    {}", desc);
                    }
                    match (set, default) {
                        (Some(v), Some(d)) => println!("    current: {}  (default: {})", v, d),
                        (Some(v), None) => println!("    current: {}", v),
                        (None, Some(d)) => println!("    default: {}", d),
                        (None, None) => {}
                    }
                }
                println!();
            }
            let stray: Vec<&(String, String)> = current
                .iter()
                .filter(|(n, _)| !schema.iter().any(|s| s.name == *n))
                .collect();
            if !stray.is_empty() {
                println!("Stored values the plugin does not declare:");
                for (n, v) in stray {
                    println!("  {} = {}", n, v);
                }
                println!();
            }
            println!(
                "Change a value with: witm plugin configure {}/{} --set <name>=<value>",
                namespace, name
            );
        } else {
            // Set configuration values, typed as the plugin declared them.
            for kv in set_values {
                let (key, value) = kv.split_once('=').ok_or_else(|| {
                    anyhow::anyhow!("Invalid format '{}': expected key=value", kv)
                })?;

                let typed = match schema.iter().find(|s| s.name == key) {
                    Some(input) => coerce_input(input, value)?,
                    None if schema.is_empty() => {
                        // A plugin with no declared inputs can still read
                        // ad-hoc strings; there is nothing to check against.
                        warn!(
                            "{}/{} declares no inputs; storing `{}` as a string",
                            namespace, name, key
                        );
                        ActualInput::Str(value.to_string())
                    }
                    None => anyhow::bail!(
                        "{}/{} has no setting named `{}`. Declared settings: {}",
                        namespace,
                        name,
                        key,
                        schema
                            .iter()
                            .map(|s| s.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                };
                let value_json = serde_json::to_string(&typed)?;

                sqlx::query(
                    "INSERT OR REPLACE INTO plugin_configuration (namespace, name, input_name, input_value) VALUES (?, ?, ?, ?)",
                )
                .bind(&namespace)
                .bind(&name)
                .bind(key)
                .bind(&value_json)
                .execute(&db.pool)
                .await?;

                info!(
                    "Set {}/{} config: {} = {}",
                    namespace,
                    name,
                    key,
                    display_input(&typed)
                );
            }
            println!(
                "Configuration updated for {}/{}. Restart the daemon for changes to take effect.",
                namespace, name
            );
        }

        Ok(())
    }

    async fn remove_plugin(&self, plugin_name: &str, auth: &DaemonAuthArgs) -> Result<()> {
        let (name, namespace) = match plugin_name.split_once("/") {
            Some((ns, n)) => (n.to_string(), Some(ns.to_string())),
            None => (plugin_name.to_string(), None),
        };

        // Try the web API first (daemon may be running)
        match self
            .try_remove_via_web(&name, namespace.as_deref(), auth)
            .await
        {
            Ok(true) => return Ok(()),
            Ok(false) => {
                warn!("Daemon not reachable, falling back to direct DB access");
            }
            Err(e) => return Err(e),
        }

        // Fall back to direct DB access
        let db_password = self.config.db.resolve_password()?;
        let db = Db::from_path(self.config.db.db_path.clone(), db_password.expose()).await?;
        drop(db_password);
        db.migrate().await?;

        let runtime = Runtime::try_default()?;
        let registry = PluginRegistry::new(db, runtime)?;

        registry.remove_plugin(&name, namespace.as_deref()).await?;
        Ok(())
    }
}
