//! ezvote-core: Core types and state machine for the ezvote protocol.
//!
//! This crate implements the three primitives from PROTOCOL.md:
//! - `State`: A tree of values addressable by path
//! - `Action`: A proposal to transition state
//! - `Consensus`: Determines which actions are accepted

mod state;
mod action;
mod hash;
mod error;
mod engine;
pub mod genesis;
mod executor;

pub use state::{State, Path, Value, Node};
pub use action::{Action, Transition, Vote, VoteValue, EntityId};
pub use hash::Hash;
pub use error::Error;
pub use engine::{Engine, CodeExecutor, Mutation, ConsensusResult};
pub use executor::StandardExecutor;

/// Re-export for convenience
pub use ed25519_dalek::{SigningKey, VerifyingKey, Signature};
