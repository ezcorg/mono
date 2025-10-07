use std::collections::{HashMap, HashSet};

use anyhow::Result;
use sqlx::{query, Sqlite, Transaction};
use wasmtime::component::Component;
pub use wasmtime_wasi_http::body::{HostIncomingBody, HyperIncomingBody};

use crate::{
    db::{Db, Insert},
    plugins::capability::Capability,
};

mod capability;
pub mod registry;

pub struct ProxyPlugin {
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub license: String,
    pub url: String,
    pub publickey: String,
    // Plugin capabilities
    pub granted: HashSet<Capability>,
    pub requested: HashSet<Capability>,
    // Plugin metadata
    pub metadata: HashMap<String, String>,
    pub component: Component
}

impl ProxyPlugin {
    pub fn id(&self) -> String {
        format!("{}/{}", self.namespace, self.name)
    }
}

// Schema:
// `plugins` (namespace, name, version, author, description, license, url, publickey)
// `plugin_event_handlers` (plugin_id, event_type, wasm)
// `plugin_capabilities` (plugin_id, capability, granted)
// `plugin_metadata` (plugin_id, key, value)

impl Insert for ProxyPlugin {
    async fn insert(&self, db: &mut Db) -> Result<()> {
        let mut tx: Transaction<'_, Sqlite> = db.pool.begin().await?;
        query(
            "
            INSERT INTO plugins (namespace, name, version, author, description, license, url, publickey)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
}
