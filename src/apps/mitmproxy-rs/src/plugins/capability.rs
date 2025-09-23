use crate::plugins::EventType;

/// Represents the capabilities that a plugin can be granted.
/// 
/// Granted capabilities must be implemented by the host application.
/// 
/// Currently supported:
/// - None
#[derive(Eq, Hash, PartialEq)]
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
    /// Allows running in response to system events (e.g. on HTTP request/response, on startup, etc.)
    Event(EventType),
}
