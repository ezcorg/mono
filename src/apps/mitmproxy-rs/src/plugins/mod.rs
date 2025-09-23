use std::collections::{HashMap, HashSet};

use anyhow::Result;
use http_body_util::Full;
use hyper::{body::{Incoming}, Request, Response};
use bytes::Bytes;
use sqlx::{query, Sqlite, Transaction};

use crate::{
    db::{Db, Insert},
    plugins::capability::Capability,
};

mod capability;
pub mod registry;

/// Types of events that plugins can handle
#[derive(Clone, Eq, Hash, PartialEq)]
pub enum EventType {
    Request,
    Response,
}

/// Data associated with each given event
pub enum EventData {
    Request(Request<Incoming>),
    Response(Response<Full<Bytes>>),
}

/// Result of processing an event by a plugin
pub enum EventResult {
    Next(EventData),
    Done(Option<EventData>),
}

impl EventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            EventType::Request => "request {todo:}",
            EventType::Response => "response {todo:}",
        }
    }
}

#[derive(Hash, PartialEq, Eq)]
pub struct EventHandler {
    pub plugin_id: String,
    pub event_type: String,
    pub wasm: Vec<u8>,
}

pub struct Plugin {
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
    // Plugin event handlers
    pub handlers: HashMap<EventType, HashSet<EventHandler>>,
}

impl Plugin {
    fn id(&self) -> String {
        format!("{}/{}", self.namespace, self.name)
    }
}

// Schema:
// plugin_id = `${namespace}/${name}`
// `plugins` (namespace, name, version, author, description, license, url, publickey)
// `plugin_event_handlers` (plugin_id, event_type, wasm, digest)
// `plugin_capabilities` (plugin_id, capability, granted)
// `plugin_metadata` (plugin_id, key, value)

impl Insert for Plugin {
    async fn insert(&self, db: &mut Db) -> Result<()> {
        let mut tx: Transaction<'_, Sqlite> = db.pool.begin().await?;
        query(
            "
            INSERT INTO plugins (namespace, name, version, author, description, license, url, publickey)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ")
            .bind(self.namespace.clone())
            .bind(self.name.clone())
            .bind(self.version.clone())
            .bind(self.author.clone())
            .bind(self.description.clone())
            .bind(self.license.clone())
            .bind(self.url.clone())
            .bind(self.publickey.clone()
        ).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
}
