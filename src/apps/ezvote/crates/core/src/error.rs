//! Error types for ezvote-core.

use thiserror::Error;

use crate::Hash;

/// Core errors.
#[derive(Debug, Error)]
pub enum Error {
    /// Entity not found in state.
    #[error("entity not found: {0}")]
    EntityNotFound(String),

    /// Code not found in state.
    #[error("code not found: {0}")]
    CodeNotFound(Hash),

    /// Invalid signature.
    #[error("invalid signature for entity: {0}")]
    InvalidSignature(String),

    /// Action parent state not found.
    #[error("parent state not found: {0}")]
    ParentNotFound(Hash),

    /// Consensus rejected the action.
    #[error("action rejected by consensus")]
    Rejected,

    /// Action is pending consensus.
    #[error("action pending consensus")]
    Pending,

    /// Code execution failed.
    #[error("execution error: {0}")]
    Execution(String),

    /// Serialization error.
    #[error("serialization error: {0}")]
    Serialization(String),

    /// Path not found.
    #[error("path not found: {0}")]
    PathNotFound(String),

    /// Invalid action.
    #[error("invalid action: {0}")]
    InvalidAction(String),

    /// Already voted.
    #[error("entity {0} already voted on action {1}")]
    AlreadyVoted(String, Hash),
}

impl From<ciborium::ser::Error<std::io::Error>> for Error {
    fn from(e: ciborium::ser::Error<std::io::Error>) -> Self {
        Error::Serialization(e.to_string())
    }
}

impl From<ciborium::de::Error<std::io::Error>> for Error {
    fn from(e: ciborium::de::Error<std::io::Error>) -> Self {
        Error::Serialization(e.to_string())
    }
}
