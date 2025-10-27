use std::collections::{HashMap, HashSet};

use ::cel::Program;
use anyhow::Result;
use salvo::oapi::ToSchema;
use serde::{Deserialize, Serialize};
use sqlx::{query, sqlite::SqliteRow, QueryBuilder, Row, Sqlite, Transaction};
use tracing::error;
// use wasmsign2::reexports::hmac_sha256::Hash;
use wasmtime::component::Component;
use wasmtime::Engine;
pub use wasmtime_wasi_http::body::{HostIncomingBody, HyperIncomingBody};

use crate::{
    db::{Db, Insert},
    plugins::capability::Capability,
    wasm::{generated::Plugin, Host},
    Runtime,
};

pub mod capability;
pub mod cel;
pub mod registry;

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
    pub publickey: String,
    pub enabled: bool,
    // Plugin capabilities
    pub granted: CapabilitySet,
    pub requested: CapabilitySet,
    // Plugin metadata
    pub metadata: HashMap<String, String>,
    // Compiled WASM component implementing the Plugin interface
    #[serde(skip)]
    pub component: Option<Component>,
    // Raw bytes of the WASM component for storage
    // TODO: stream this when receiving from API
    pub component_bytes: Vec<u8>,
    #[serde(skip)]
    pub cel_filter: Option<Program>,
    /// Source code for the CEL selector
    pub cel_source: String,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct CapabilitySet(HashSet<Capability>);

impl CapabilitySet {
    pub fn new() -> Self {
        Self(HashSet::new())
    }

    pub fn insert(&mut self, cap: Capability) {
        self.0.insert(cap);
    }

    pub fn contains(&self, cap: &Capability) -> bool {
        self.0.contains(cap)
    }
}

impl<'a> IntoIterator for &'a CapabilitySet {
    type Item = &'a Capability;
    type IntoIter = std::collections::hash_set::Iter<'a, Capability>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

impl WitmPlugin {
    fn make_id(namespace: &str, name: &str) -> String {
        format!("{}/{}", namespace, name)
    }

    pub fn id(&self) -> String {
        Self::make_id(&self.namespace, &self.name)
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
                    .host_plugin_witm_plugin()
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

        let mut plugin = WitmPlugin::from(guest_result);
        plugin.cel_filter = if !plugin.cel_source.is_empty() {
            Some(Program::compile(&plugin.cel_source)?)
        } else {
            None
        };

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
        let mut granted = CapabilitySet::new();
        let mut requested = CapabilitySet::new();
        for row in capabilities {
            let cap_str: String = row.try_get("capability")?;
            let cap = Capability::from(cap_str);
            let granted_flag: bool = row.try_get("granted")?;
            if granted_flag {
                granted.insert(cap);
            } else {
                requested.insert(cap);
            }
        }
        plugin.granted = granted;
        plugin.requested = requested;
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
}

// Schema:
// `plugins` (namespace, name, version, author, description, license, url, publickey, component)
// `plugin_capabilities` (namespace, name, capability, granted)
// `plugin_metadata` (namespace, name, key, value)

impl Insert for WitmPlugin {
    async fn insert_tx(&self, db: &mut Db) -> Result<Transaction<'_, Sqlite>> {
        let mut tx: Transaction<'_, Sqlite> = db.pool.begin().await?;

        // Insert into plugins table
        query(
            "
            INSERT INTO plugins (namespace, name, version, author, description, license, url, publickey, enabled, component, cel_filter)
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
        .bind(self.cel_source.clone())
        .execute(&mut *tx)
        .await?;

        // Bulk insert capabilities
        if !self.requested.0.is_empty() {
            let mut query_builder: QueryBuilder<Sqlite> = QueryBuilder::new(
                "INSERT INTO plugin_capabilities (namespace, name, capability, granted) ",
            );

            query_builder.push_values(&self.requested, |mut b, capability| {
                let granted = self.granted.contains(capability);
                b.push_bind(&self.namespace)
                    .push_bind(&self.name)
                    .push_bind(format!("{:?}", capability))
                    .push_bind(granted);
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
