use std::collections::HashMap;

use anyhow::Result;
use salvo::oapi::ToSchema;
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Row, Sqlite, Transaction, query, sqlite::SqliteRow};
use tracing::error;
use wasmtime::Engine;
use wasmtime::component::Component;
pub use wasmtime_wasi_http::body::{HostIncomingBody, HyperIncomingBody};

use crate::{
    Runtime, db::{Db, Insert}, plugins::capabilities::{Capabilities, Capability, Filterable}, wasm::{Host, generated::Plugin}
};

pub mod cel;
pub mod registry;
pub mod capabilities;

#[derive(Serialize, Deserialize, ToSchema)]
#[salvo(extract(default_source(from = "body")))]
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
    pub capabilities: Capabilities,
    // Plugin metadata
    pub metadata: HashMap<String, String>,
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

    /// Only needs the `component` column
    pub async fn from_db_row(plugin_row: SqliteRow, db: &mut Db, engine: &Engine) -> Result<Self> {
        // TODO: consider failure modes (invalid/non-compiling component, etc.)
        let component_bytes: Vec<u8> = plugin_row.try_get("component")?;
        let component = Component::from_binary(engine, &component_bytes)?;
        let runtime = Runtime::default()?;
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
            SELECT capability, granted
            FROM plugin_capabilities
            WHERE namespace = ? AND name = ?
            ",
        )
        .bind(&plugin.namespace)
        .bind(&plugin.name)
        .fetch_all(&db.pool)
        .await?;

        for row in capabilities {
            let cap_str: String = row.try_get("capability")?;
            let config_str: String = row.try_get("config")?;
            let granted_flag: bool = row.try_get("granted")?;

            match cap_str.as_str() {
                "connect" => {
                    let config: Filterable = serde_json::from_str(&config_str)?;
                    plugin.capabilities.connect = Capability {
                        config,
                        granted: granted_flag,
                    };
                }
                "request" => {
                    let config: Filterable = serde_json::from_str(&config_str)?;
                    plugin.capabilities.request = Some(Capability {
                        config,
                        granted: granted_flag,
                    });
                }
                "response" => {
                    let config: Filterable = serde_json::from_str(&config_str)?;
                    plugin.capabilities.response = Some(Capability {
                        config,
                        granted: granted_flag,
                    });
                }
                _ => {
                    error!(
                        "Unknown capability '{}' for plugin '{}'",
                        cap_str,
                        plugin.id()
                    );
                }
            }
        }
        Ok(plugin)
    }

    pub async fn all(db: &mut Db, engine: &wasmtime::Engine) -> Result<Vec<Self>> {
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
            match WitmPlugin::from_db_row(row, db, engine).await {
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
            INSERT OR REPLACE INTO plugins (namespace, name, version, author, description, license, url, publickey, enabled, component, cel_filter)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

        plugin_capabilities.push((
            self.namespace.clone(),
            self.name.clone(),
            "connect".to_string(),
            serde_json::to_string(&self.capabilities.connect.config)?,
            self.capabilities.connect.granted,
        ));

        if let Some(request) = &self.capabilities.request {
            plugin_capabilities.push((
                self.namespace.clone(),
                self.name.clone(),
                "request".to_string(),
                serde_json::to_string(&request.config)?,
                request.granted,
            ));
        }

        if let Some(response) = &self.capabilities.response {
            plugin_capabilities.push((
                self.namespace.clone(),
                self.name.clone(),
                "response".to_string(),
                serde_json::to_string(&response.config)?,
                response.granted,
            ));
        }

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
