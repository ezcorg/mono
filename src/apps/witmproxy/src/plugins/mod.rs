use std::collections::HashMap;

use anyhow::Result;
use cel_cxx::Activation;
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Row, Sqlite, Transaction, query, sqlite::SqliteRow};
use tracing::error;
use wasmtime::Engine;
use wasmtime::component::Component;
pub use wasmtime_wasi_http::body::{HostIncomingBody, HyperIncomingBody};

use crate::events::Event;
use crate::{
    Runtime,
    db::{Db, Insert},
    plugins::capabilities::Capability,
    wasm::{
        Host,
        bindgen::{
            Plugin, PluginManifest, UserInput,
            exports::witmproxy::plugin::witm_plugin::Tag,
            witmproxy::plugin::capabilities::Capability as WitCapability,
        },
    },
};

pub mod capabilities;
pub mod cel;
pub mod registry;

#[derive(Serialize, Deserialize)]
pub struct WitmPlugin {
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub license: String,
    pub url: String,
    pub publickey: Vec<u8>,
    pub enabled: bool,
    // Plugin capabilities
    pub capabilities: Vec<Capability>,
    // Plugin metadata
    pub metadata: HashMap<String, String>,
    // User-supplied configuration values passed to plugin on each event
    pub configuration: Vec<UserInput>,
    // Compiled WASM component implementing the Plugin interface
    #[serde(skip)]
    pub component: Option<Component>,
    // Raw bytes of the WASM component for storage
    // TODO: stream this when receiving from API
    pub component_bytes: Vec<u8>,
}

impl WitmPlugin {
    fn make_id(namespace: &str, name: &str) -> String {
        format!("{}/{}", namespace, name)
    }

    pub fn id(&self) -> String {
        Self::make_id(&self.namespace, &self.name)
    }

    pub fn with_component(mut self, component: Component, component_bytes: Vec<u8>) -> Self {
        self.component = Some(component);
        self.component_bytes = component_bytes;
        self
    }

    pub fn compile_capability_scope_expressions(
        mut self,
        env: &'static cel_cxx::Env,
    ) -> Result<Self> {
        self.capabilities
            .iter_mut()
            .try_for_each(|c| c.compile_scope_expression(env))?;
        Ok(self)
    }

    /// Only needs the `component` column
    pub async fn from_db_row(
        plugin_row: SqliteRow,
        db: &mut Db,
        engine: &Engine,
        env: &'static cel_cxx::Env<'static>,
    ) -> Result<Self> {
        // TODO: consider failure modes (invalid/non-compiling component, etc.)
        let component_bytes: Vec<u8> = plugin_row.try_get("component")?;
        let component = Component::from_binary(engine, &component_bytes)?;
        let runtime = Runtime::try_default()?;
        let mut store = wasmtime::Store::new(engine, Host::default());
        let instance = runtime
            .linker
            .instantiate_async(&mut store, &component)
            .await?;
        let plugin_instance = Plugin::new(&mut store, &instance)?;
        let guest_result = store
            .run_concurrent(async move |store| {
                let (manifest, task) = match plugin_instance
                    .witmproxy_plugin_witm_plugin()
                    .call_manifest(store)
                    .await
                {
                    Ok(ok) => ok,
                    Err(e) => {
                        error!("Error calling manifest: {}", e);
                        return Err(e);
                    }
                };
                task.block(store).await;
                Ok(manifest)
            })
            .await??;

        let mut plugin = WitmPlugin::from(guest_result).with_component(component, component_bytes);
        let capabilities = query(
            "
            SELECT capability, config, granted
            FROM plugin_capabilities
            WHERE namespace = ? AND name = ?
            ",
        )
        .bind(&plugin.namespace)
        .bind(&plugin.name)
        .fetch_all(&db.pool)
        .await?;

        for row in capabilities {
            let config_str: String = row.try_get("config")?;
            let granted_flag: bool = row.try_get("granted")?;
            let config: WitCapability = serde_json::from_str(&config_str)?;
            let capability = Capability {
                inner: config,
                granted: granted_flag,
                cel: None,
            };
            plugin.capabilities.push(capability);
        }

        let config_rows = query(
            "
            SELECT input_name, input_value
            FROM plugin_configuration
            WHERE namespace = ? AND name = ?
            ",
        )
        .bind(&plugin.namespace)
        .bind(&plugin.name)
        .fetch_all(&db.pool)
        .await?;

        for row in config_rows {
            let input_name: String = row.try_get("input_name")?;
            let input_value_str: String = row.try_get("input_value")?;
            let value = serde_json::from_str(&input_value_str)?;
            plugin.configuration.push(UserInput {
                name: input_name,
                value,
            });
        }

        plugin = plugin.compile_capability_scope_expressions(env)?;
        Ok(plugin)
    }

    pub async fn all(
        db: &mut Db,
        engine: &wasmtime::Engine,
        env: &'static cel_cxx::Env<'static>,
    ) -> Result<Vec<Self>> {
        let rows = query(
            "
            SELECT component
            FROM plugins
            ",
        )
        .fetch_all(&db.pool)
        .await?;

        let mut plugins = Vec::new();
        for row in rows {
            match WitmPlugin::from_db_row(row, db, engine, env).await {
                Ok(plugin) => plugins.push(plugin),
                Err(e) => {
                    error!(
                        "Failed to load plugin from database row, dropping and continuing: {}",
                        e
                    );
                }
            }
        }
        Ok(plugins)
    }

    pub async fn delete(&self, db: &mut Db) -> Result<()> {
        let mut tx = db.pool.begin().await?;
        // Delete from plugins table
        sqlx::query("DELETE FROM plugins WHERE namespace = ? AND name = ?")
            .bind(&self.namespace)
            .bind(&self.name)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(())
    }

    pub fn can_handle(&self, event: &Box<dyn Event>) -> bool {
        self.capabilities
            .iter()
            // Have we been granted the associated event capability?
            .filter(|cap| cap.inner.kind == event.capability())
            .filter(|cap| cap.granted)
            .filter_map(|cap| {
                let program: &cel_cxx::Program<'_> = cap.cel.as_ref()?;
                Some(program)
            })
            // Are we interested in and permitted to handle this event?
            .any(|program| {
                let activation = match event.bind_cel_activation(Activation::new()) {
                    Some(a) => a,
                    None => return false,
                };

                match program.evaluate(activation) {
                    Ok(cel_cxx::Value::Bool(true)) => true,
                    Ok(_) => false,
                    Err(e) => {
                        error!("Error evaluating CEL filter: {}", e);
                        false
                    }
                }
            })
    }
}

impl From<PluginManifest> for WitmPlugin {
    fn from(manifest: PluginManifest) -> Self {
        let metadata = manifest
            .metadata
            .iter()
            .cloned()
            .map(|Tag { key, value }| (key, value))
            .collect::<HashMap<String, String>>();

        let capabilities = manifest
            .capabilities
            .iter()
            .cloned()
            .map(|c| Capability {
                inner: c,
                granted: true,
                cel: None,
            })
            .collect::<Vec<Capability>>();

        WitmPlugin {
            namespace: manifest.namespace,
            name: manifest.name,
            version: manifest.version,
            author: manifest.author,
            description: manifest.description,
            license: manifest.license,
            url: manifest.url,
            publickey: manifest.publickey,
            enabled: true,
            configuration: vec![],
            component: None,
            component_bytes: vec![],
            metadata,
            capabilities,
        }
    }
}

// Schema:
// `plugins` (namespace, name, version, author, description, license, url, publickey, component)
// `plugin_capabilities` (namespace, name, capability, granted)
// `plugin_metadata` (namespace, name, key, value)

impl Insert for WitmPlugin {
    async fn insert_tx(&self, db: &mut Db) -> Result<Transaction<'_, Sqlite>> {
        let mut tx: Transaction<'_, Sqlite> = db.pool.begin().await?;

        // Insert or replace into plugins table (triggers on delete for related tables)
        query(
            "
            INSERT OR REPLACE INTO plugins (namespace, name, version, author, description, license, url, publickey, enabled, component)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
        )
        .bind(self.namespace.clone())
        .bind(self.name.clone())
        .bind(self.version.clone())
        .bind(self.author.clone())
        .bind(self.description.clone())
        .bind(self.license.clone())
        .bind(self.url.clone())
        .bind(self.publickey.clone())
        .bind(self.enabled)
        .bind(self.component_bytes.clone())
        .execute(&mut *tx)
        .await?;

        let mut plugin_capabilities: Vec<(String, String, String, String, bool)> = vec![];

        self.capabilities.iter().for_each(|cap| {
            let cap_str = cap.inner.kind.to_string();
            let config_str = match serde_json::to_string(&cap.inner) {
                Ok(s) => s,
                Err(e) => {
                    error!(
                        "Failed to serialize capability config for plugin {}/{} capability {}: {}",
                        self.namespace, self.name, cap_str, e
                    );
                    "".to_string()
                }
            };
            plugin_capabilities.push((
                self.namespace.clone(),
                self.name.clone(),
                cap_str,
                config_str,
                cap.granted,
            ));
        });

        let mut query_builder: QueryBuilder<Sqlite> = QueryBuilder::new(
            "INSERT INTO plugin_capabilities (namespace, name, capability, config, granted) ",
        );

        query_builder.push_values(
            &plugin_capabilities,
            |mut b, (namespace, name, capability, config, granted)| {
                b.push_bind(namespace)
                    .push_bind(name)
                    .push_bind(capability)
                    .push_bind(config)
                    .push_bind(granted);
            },
        );

        query_builder.build().execute(&mut *tx).await?;

        // Bulk insert configuration
        if !self.configuration.is_empty() {
            let mut query_builder: QueryBuilder<Sqlite> = QueryBuilder::new(
                "INSERT INTO plugin_configuration (namespace, name, input_name, input_value) ",
            );

            query_builder.push_values(&self.configuration, |mut b, input| {
                let value_str = serde_json::to_string(&input.value).unwrap_or_default();
                b.push_bind(&self.namespace)
                    .push_bind(&self.name)
                    .push_bind(&input.name)
                    .push_bind(value_str);
            });

            query_builder.build().execute(&mut *tx).await?;
        }

        // Bulk insert metadata
        if !self.metadata.is_empty() {
            let mut query_builder: QueryBuilder<Sqlite> =
                QueryBuilder::new("INSERT INTO plugin_metadata (namespace, name, key, value) ");

            query_builder.push_values(&self.metadata, |mut b, (key, value)| {
                b.push_bind(&self.namespace)
                    .push_bind(&self.name)
                    .push_bind(key)
                    .push_bind(value);
            });

            query_builder.build().execute(&mut *tx).await?;
        }

        Ok(tx)
    }
}
