//! `ezcap`: the shared capability scope model behind `ezco:ezcap@0.1.0`.
//!
//! Three things live here, used by every host that grants capabilities
//! (icanhaz's broker, witmproxy's plugin registry):
//!
//! - [`env`]: a CEL *environment* generated from a WIT interface, so a scope
//!   clause like `call.args.key.startsWith("seen/")` is type-checked against
//!   the real method signature at load time.
//! - [`profile`]: a recogniser over the common clause shapes that renders each
//!   one as a sentence for consent windows and audit logs. Clauses outside the
//!   profile are still enforced; they render as raw CEL.
//! - [`registry`]: a tag-keyed set of membranes, one per capability kind, with
//!   [`build`] generating the environments from a host's WIT at build time.
//! - [`membrane`]: the runtime that mints capability *instances*, narrows them
//!   by conjunction (append-only, so containment is structural), evaluates
//!   `allow` per call, keeps per-instance counters, and produces
//!   `capability-error::denied(sentence)` when a call falls outside scope.
//!
//! The WIT package itself is at `wit/ezcap.wit`; [`types`] mirrors it.

pub mod bind;
pub mod build;
pub mod env;
pub mod membrane;
pub mod profile;
pub mod registry;
pub mod shape;
pub mod types;

pub use bind::Val;
pub use env::CallEnv;
pub use membrane::{Call, Caller, Instance, InstanceId, Membrane};
pub use profile::{Sentence, render};
pub use registry::{Membranes, RegistryError};
pub use shape::{Decl, Shape};
pub use types::{Capability, CapabilityError, Kind, Narrowing, Scope};
