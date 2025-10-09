use bimap::BiMap;
use salvo::oapi::ToSchema;
use serde::{Deserialize, Serialize};
use lazy_static::lazy_static;

/// Represents the capabilities that a plugin can be granted.
/// 
/// Granted capabilities must be implemented by the host application.
/// 
/// Currently supported:
/// - None
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize, ToSchema)]
pub enum Capability {
    /// Allows reading and writing files in a filesystem
    Directory,
    /// Allows making outbound HTTP requests
    HTTP,
    /// Allows reading and writing to a key-value store
    KeyValueStore,
    /// Allows executing SQL queries against a SQL database
    SQL,
    /// Allows sending and receiving messages from a queue
    Queue,
    /// Allows annotating content and retrieving existing content annotations
    Annotator,
    /// Allows registering request handlers
    Request,
    /// Allows registering response handlers
    Response,
    /// Default
    None
}


lazy_static! {
    static ref BIMAP: BiMap<String, Capability> = {
        let mut m = BiMap::new();
        m.insert("directory".to_string(), Capability::Directory);
        m.insert("http".to_string(), Capability::HTTP);
        m.insert("kv".to_string(), Capability::KeyValueStore);
        m.insert("sql".to_string(), Capability::SQL);
        m.insert("queue".to_string(), Capability::Queue);
        m.insert("annotator".to_string(), Capability::Annotator);
        m.insert("request".to_string(), Capability::Request);
        m.insert("response".to_string(), Capability::Response);
        m.insert("none".to_string(), Capability::None);
        m
    };
}

impl From<String> for Capability {
    fn from(s: String) -> Self {
        match BIMAP.get_by_left(&s) {
            Some(cap) => cap.clone(),
            None => Capability::None,
        }
    }
}

impl Into<String> for Capability {
    fn into(self) -> String {
        match BIMAP.get_by_right(&self) {
            Some(cap) => cap.clone(),
            None => "none".to_string(),
        }
    }
}