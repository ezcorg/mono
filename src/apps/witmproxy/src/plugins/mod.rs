use std::collections::{HashMap, HashSet};

use ::cel::Program;
use anyhow::Result;
use salvo::oapi::ToSchema;
use serde::{Deserialize, Serialize};
use sqlx::{query, sqlite::SqliteRow, QueryBuilder, Row, Sqlite, Transaction};
// use wasmsign2::reexports::hmac_sha256::Hash;
use wasmtime::component::Component;
use wasmtime::Engine;
pub use wasmtime_wasi_http::body::{HostIncomingBody, HyperIncomingBody};

use crate::{
    db::{Db, Insert},
    plugins::capability::Capability,
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

    pub async fn from_plugin_row(
        plugin_row: SqliteRow,
        db: &mut Db,
        engine: &Engine,
    ) -> Result<Self> {
        // TODO: consider failure modes (invalid/non-compiling component, etc.)
        let component_bytes: Vec<u8> = plugin_row.try_get("component")?;
        let component = Some(Component::from_binary(engine, &component_bytes)?);

        let cel_source: String = plugin_row.try_get("cel_filter")?;
        let cel_filter = if !cel_source.is_empty() {
            Some(Program::compile(&cel_source)?)
        } else {
            None
        };
        let namespace = plugin_row.try_get::<String, _>("namespace")?;
        let name = plugin_row.try_get::<String, _>("name")?;

        let capabilities = query(
            "
            SELECT capability, granted
            FROM plugin_capabilities
            WHERE namespace = ? AND name = ?
            ",
        )
        .bind(&namespace)
        .bind(&name)
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

        let metadata_rows = query(
            "
            SELECT key, value
            FROM plugin_metadata
            WHERE namespace = ? AND name = ?
            ",
        )
        .bind(&namespace)
        .bind(&name)
        .fetch_all(&db.pool)
        .await?;

        let mut metadata: HashMap<String, String> = HashMap::new();
        for row in metadata_rows {
            let key: String = row.try_get("key")?;
            let value: String = row.try_get("value")?;
            metadata.insert(key, value);
        }

        Ok(WitmPlugin {
            namespace: plugin_row.try_get("namespace")?,
            name: plugin_row.try_get("name")?,
            version: plugin_row.try_get("version")?,
            author: plugin_row.try_get("author")?,
            description: plugin_row.try_get("description")?,
            license: plugin_row.try_get("license")?,
            url: plugin_row.try_get("url")?,
            publickey: plugin_row.try_get("publickey")?,
            enabled: plugin_row.try_get("enabled")?,
            component_bytes,
            component,
            granted,
            requested,
            metadata,
            cel_filter,
            cel_source,
        })
    }

    pub async fn all(db: &mut Db, engine: &wasmtime::Engine) -> Result<Vec<Self>> {
        let rows = query(
            "
            SELECT namespace, name, version, author, description, license, url, publickey, component
            FROM plugins
            ",
        )
        .fetch_all(&db.pool)
        .await?;

        let mut plugins = Vec::new();
        for row in rows {
            plugins.push(WitmPlugin::from_plugin_row(row, db, engine).await?);
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
