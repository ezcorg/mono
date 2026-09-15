//! A tag-keyed registry of [`Membrane`]s: the piece every host needs once it
//! has more than one capability kind. A host embeds the environments its
//! build script generated (see [`crate::build`]), then mints, narrows, admits
//! and revokes instances by kind tag. Interior locking, so it can be shared as
//! an `Arc` or nested inside a host's own store.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::env::CallEnv;
use crate::membrane::{Call, InstanceId, Membrane, MembraneError};
use crate::types::{Capability, CapabilityError, Narrowing, Scope};

pub struct Membranes {
    by_tag: Mutex<HashMap<String, Membrane>>,
}

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("no admission environment for `{0}` capabilities")]
    NoTag(String),
    #[error("embedded environments do not parse: {0}")]
    Json(String),
    #[error(transparent)]
    Membrane(#[from] MembraneError),
}

impl Membranes {
    /// Build from environments a build script generated with
    /// [`crate::build::write_envs`] and the host embedded with `include_str!`.
    /// `extra_counters` are host-maintained `state.*` integers every membrane
    /// declares (`tokens`, …).
    pub fn from_json(json: &str, extra_counters: &[&str]) -> Result<Self, RegistryError> {
        let envs: Vec<(String, CallEnv)> =
            serde_json::from_str(json).map_err(|e| RegistryError::Json(e.to_string()))?;
        Self::from_envs(envs, extra_counters)
    }

    pub fn from_envs(
        envs: Vec<(String, CallEnv)>,
        extra_counters: &[&str],
    ) -> Result<Self, RegistryError> {
        let mut by_tag = HashMap::new();
        for (tag, env) in envs {
            by_tag.insert(tag, Membrane::new(env, extra_counters)?);
        }
        Ok(Self {
            by_tag: Mutex::new(by_tag),
        })
    }

    fn with<T>(&self, tag: &str, f: impl FnOnce(&mut Membrane) -> T) -> Result<T, RegistryError> {
        let mut by_tag = self.by_tag.lock().unwrap_or_else(|e| e.into_inner());
        let membrane = by_tag
            .get_mut(tag)
            .ok_or_else(|| RegistryError::NoTag(tag.to_string()))?;
        Ok(f(membrane))
    }

    /// Whether `tag` has an environment.
    pub fn has(&self, tag: &str) -> bool {
        self.by_tag
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(tag)
    }

    /// A copy of the environment for `tag`, for documentation and tests.
    pub fn env(&self, tag: &str) -> Option<CallEnv> {
        self.with(tag, |m| m.env().clone()).ok()
    }

    /// Mint an instance for `scope` under `tag`. Compiling the scope against
    /// the kind's interface happens here, so a clause that names an argument
    /// the interface does not have is refused now.
    pub fn mint(&self, tag: &str, scope: &Scope) -> Result<InstanceId, RegistryError> {
        self.with(tag, |m| {
            let cap = Capability {
                kind: m.kind().clone(),
                scope: scope.clone(),
            };
            m.mint(&cap)
        })?
        .map_err(RegistryError::from)
    }

    /// Mint a child of `parent` whose scope is `parent && extra`.
    pub fn narrow(
        &self,
        tag: &str,
        parent: &InstanceId,
        extra: &Narrowing,
    ) -> Result<InstanceId, RegistryError> {
        self.with(tag, |m| m.narrow(parent, extra))?
            .map_err(RegistryError::from)
    }

    /// Admit one call. An unknown tag or instance is `unavailable`; a call
    /// outside `allow` is `denied(sentences)`.
    pub fn admit(&self, tag: &str, id: &InstanceId, call: &Call) -> Result<(), CapabilityError> {
        self.with(tag, |m| m.admit(id, call))
            .unwrap_or(Err(CapabilityError::Unavailable))
    }

    /// The grant-level check: `when` with nothing bound.
    pub fn admit_event(&self, tag: &str, id: &InstanceId) -> bool {
        self.with(tag, |m| m.admit_event(id, Ok)).unwrap_or(false)
    }

    /// A counter's current value on an instance (`calls`, `bytes`, or a host
    /// counter); `None` for an unknown tag or instance.
    pub fn counter(&self, tag: &str, id: &InstanceId, name: &str) -> Option<i64> {
        self.with(tag, |m| m.get(id).map(|i| i.counter(name)))
            .ok()
            .flatten()
    }

    /// Advance a host-defined counter after a call.
    pub fn charge(&self, tag: &str, id: &InstanceId, counter: &str, amount: i64) {
        let _ = self.with(tag, |m| m.charge(id, counter, amount));
    }

    /// Revoke an instance and everything narrowed from it.
    pub fn revoke(&self, tag: &str, id: &InstanceId) {
        let _ = self.with(tag, |m| m.revoke(id));
    }
}
