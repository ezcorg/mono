use std::collections::{HashMap, HashSet};

use anyhow::Result;
use sqlx::{query, Sqlite, Transaction};

use crate::{
    db::{Db, Insert},
    plugins::capability::Capability,
};

mod capability;
pub mod registry;

pub enum Event {
    Request,
    Response,
}

impl Event {
    pub fn as_str(&self) -> &'static str {
        match self {
            Event::Request => "request",
            Event::Response => "response",
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
    pub handlers: HashMap<Event, HashSet<EventHandler>>,
}

impl Plugin {
    fn id(&self) -> String {
        format!("{}/{}", self.namespace, self.name)
    }
}

// Schema:
// `plugins` (namespace, name, version, author, description, license, url, publickey)
// `plugin_event_handlers` (plugin_id, event_type, wasm)
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

// pub trait EventHandler<EventType>: Send + Sync
// where
//     EventType: SystemEvent,
// {
//     fn priority(&self) -> Either<u32, String>;
//     fn handle(
//         &self,
//         event: Event<EventType>,
//         capabilities: HashSet<Capability>,
//     ) -> Option<EventAction<EventType>>;
// }

// pub enum EventAction<T: SystemEvent> {
//     /// Modify/keep the event and pass onto future handlers
//     Next(Event<T>),
//     /// Stop processing the event, optionally do not pass it on by returning None
//     Done(Option<Event<T>>),
// }

// pub struct Event<T: SystemEvent> {
//     id: String,
//     data: T,
// }

// pub trait SystemEvent {}
