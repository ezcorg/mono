use std::collections::{HashMap, HashSet};

use anyhow::Result;
use sqlx::{query, sqlite::SqliteRow, Sqlite, Transaction, Row};
use wasmsign2::reexports::hmac_sha256::Hash;
use wasmtime::component::Component;
use wasmtime::Engine;
pub use wasmtime_wasi_http::body::{HostIncomingBody, HyperIncomingBody};

use crate::{
    db::{Db, Insert},
    plugins::capability::Capability,
};

mod capability;
pub mod registry;

pub struct MitmPlugin {
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
    pub granted: HashSet<Capability>,
    pub requested: HashSet<Capability>,
    // Plugin metadata
    pub metadata: HashMap<String, String>,
    // Compiled WASM component implementing the Plugin interface
    pub component: Component,
    // Raw bytes of the WASM component for storage
    pub component_bytes: Vec<u8>,
}

impl MitmPlugin {
    fn make_id(namespace: &str, name: &str) -> String {
        format!("{}/{}", namespace, name)
    }

    pub fn id(&self) -> String {
        Self::make_id(&self.namespace, &self.name)
    }

    pub async fn from_plugin_row(plugin_row: SqliteRow, db: &mut Db, engine: &Engine) -> Result<Self> {
        // TODO: consider failure modes (invalid/non-compiling component, etc.)
        let component_bytes: Vec<u8> = plugin_row.try_get("component")?;
        let component = Component::from_binary(engine, &component_bytes)?;
        let namespace = plugin_row.try_get::<String, _>("namespace")?;
        let name = plugin_row.try_get::<String, _>("name")?;
        let id = Self::make_id(&namespace, &name);

        let capabilities = query(
            "
            SELECT capability, granted
            FROM plugin_capabilities
            WHERE plugin_id = ?
            ",
        )
        .bind(&id)
        .fetch_all(&db.pool)
        .await?;
        let mut granted: HashSet<Capability> = HashSet::new();
        let mut requested: HashSet<Capability> = HashSet::new();
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
            WHERE plugin_id = ?
            ",
        )
        .bind(&id)
        .fetch_all(&db.pool)
        .await?;
        
        let mut metadata: HashMap<String, String> = HashMap::new();
        for row in metadata_rows {
            let key: String = row.try_get("key")?;
            let value: String = row.try_get("value")?;
            metadata.insert(key, value);
        }

        Ok(MitmPlugin {
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
        })
    }

    pub async fn all(db: &mut Db, engine: &wasmtime::Engine) -> Result<Vec<Self>> {
        let rows = query(
            "
            SELECT namespace, name, version, author, description, license, url, publickey, component
            FROM plugins
            "
        )
        .fetch_all(&db.pool)
        .await?;

        let mut plugins = Vec::new();
        for row in rows {
            plugins.push(MitmPlugin::from_plugin_row(row, db, engine).await?);
        }
        Ok(plugins)
    }
}

// Schema:
// `plugins` (namespace, name, version, author, description, license, url, publickey, component)
// `plugin_capabilities` (plugin_id, capability, granted)
// `plugin_metadata` (plugin_id, key, value)

impl Insert for MitmPlugin {
    async fn insert_tx(&self, db: &mut Db) -> Result<Transaction<'_, Sqlite>> {
        let mut tx: Transaction<'_, Sqlite> = db.pool.begin().await?;
        
        let plugin_id = self.id();
        
        // Insert into plugins table
        query(
            "
            INSERT INTO plugins (namespace, name, version, author, description, license, url, publickey, component)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        .bind(self.component_bytes.clone())
        .execute(&mut *tx)
        .await?;

        // Insert granted capabilities
        for capability in &self.granted {
            query(
                "
                INSERT INTO plugin_capabilities (plugin_id, capability, granted)
                VALUES (?, ?, ?)
                ",
            )
            .bind(plugin_id.clone())
            .bind(format!("{:?}", capability))
            .bind(true)
            .execute(&mut *tx)
            .await?;
        }

        // Insert requested capabilities
        for capability in &self.requested {
            // Only insert if not already granted (avoid duplicates)
            if !self.granted.contains(capability) {
                query(
                    "
                    INSERT INTO plugin_capabilities (plugin_id, capability, granted)
                    VALUES (?, ?, ?)
                    ",
                )
                .bind(plugin_id.clone())
                .bind(format!("{:?}", capability))
                .bind(false)
                .execute(&mut *tx)
                .await?;
            }
        }

        // Insert metadata
        for (key, value) in &self.metadata {
            query(
                "
                INSERT INTO plugin_metadata (plugin_id, key, value)
                VALUES (?, ?, ?)
                ",
            )
            .bind(plugin_id.clone())
            .bind(key.clone())
            .bind(value.clone())
            .execute(&mut *tx)
            .await?;
        }

        Ok(tx)
    }
}
