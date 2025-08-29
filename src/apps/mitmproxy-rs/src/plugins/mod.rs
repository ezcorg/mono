use std::collections::{HashMap, HashSet};

use either::Either;

use crate::plugins::capability::Capability;

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

pub struct PluginCapabilities {
    pub granted: HashSet<Capability>,
    pub requested: HashSet<Capability>,
}

pub struct Plugin {
    handlers: HashMap<Box<dyn SystemEvent>, Vec<Box<dyn EventHandler<dyn SystemEvent>>>>,
    capabilities: PluginCapabilities,
    metadata: PluginMetadata,
}

impl Plugin {
    fn id(&self) -> String {
        format!("{}/{}", self.metadata.namespace, self.metadata.name)
    }
}

pub trait EventHandler<T>: Send + Sync
where
    T: SystemEvent,
{
    fn priority(&self) -> Either<u32, String>;
    fn handle(&self, event: Event<T>) -> Option<EventAction<T>>;
}

pub enum EventAction<T: SystemEvent> {
    /// Modify/keep the event and pass onto future handlers
    Next(Event<T>),
    /// Stop processing the event, optionally do not pass it on by returning None
    Done(Option<Event<T>>),
}

pub struct Event<T: SystemEvent> {
    data: T,
}

pub trait SystemEvent {}
