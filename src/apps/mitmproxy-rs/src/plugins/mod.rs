use std::collections::{HashMap, HashSet};

use anyhow::Result;
use either::Either;
use sqlx::{query, Sqlite, Transaction};

use crate::{
    db::{Db, Insert},
    plugins::capability::Capability,
};

mod capability;
mod registry;

pub struct PluginMetadata {
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub license: String,
    pub url: String,
    pub publickey: String,
}

use std::any::TypeId;

pub struct Plugin {
    handlers: HashMap<TypeId, Vec<Box<dyn EventHandler<dyn SystemEvent>>>>,
    pub granted: HashSet<Capability>,
    pub requested: HashSet<Capability>,
    pub metadata: PluginMetadata,
}

impl Plugin {
    fn id(&self) -> String {
        format!("{}/{}", self.metadata.namespace, self.metadata.name)
    }
}

impl Insert for Plugin {
    async fn insert(&self, db: &mut Db) -> Result<()> {
        let mut tx: Transaction<'_, Sqlite> = db.pool.begin().await?;
        query("INSERT INTO plugins (id, namespace, name, version, author, description, license, url, publickey) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(self.id())
            .bind(self.metadata.namespace.clone())
            .bind(self.metadata.name.clone())
            .bind(self.metadata.version.clone())
            .bind(self.metadata.author.clone())
            .bind(self.metadata.description.clone())
            .bind(self.metadata.license.clone())
            .bind(self.metadata.url.clone())
            .bind(self.metadata.publickey.clone())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

pub trait EventHandler<EventType>: Send + Sync
where
    EventType: SystemEvent,
{
    fn priority(&self) -> Either<u32, String>;
    fn handle(
        &self,
        event: Event<EventType>,
        capabilities: HashSet<Capability>,
    ) -> Option<EventAction<EventType>>;
}

pub enum EventAction<T: SystemEvent> {
    /// Modify/keep the event and pass onto future handlers
    Next(Event<T>),
    /// Stop processing the event, optionally do not pass it on by returning None
    Done(Option<Event<T>>),
}

pub struct Event<T: SystemEvent> {
    id: String,
    data: T,
}

pub trait SystemEvent {}
