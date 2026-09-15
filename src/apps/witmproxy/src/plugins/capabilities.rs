use anyhow::{Result, anyhow};
use cel_cxx::{Env, Program};
use serde::{Deserialize, Serialize};

use crate::plugins::membranes::Membranes;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
    Capability as WitCapability, CapabilityKind,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capability {
    pub inner: WitCapability,
    pub granted: bool,
    /// The compiled `when` program, for event capabilities: decides per event
    /// whether the plugin runs at all.
    #[serde(skip)]
    pub when: Option<Program<'static>>,
    /// The membrane instance, for provider capabilities: admits every call on
    /// the granted resource against `allow`.
    #[serde(skip)]
    pub instance: Option<ezcap::InstanceId>,
}

impl Capability {
    /// Compile this capability's scope. Event kinds compile `when` against the
    /// event environment; provider kinds are minted as a membrane instance,
    /// which type-checks `allow` against the resource's interface (a clause
    /// naming an argument the interface does not have is refused here, at
    /// registration, never at the first call). Re-compiling a narrowed scope
    /// revokes the previous instance.
    pub fn compile_scope_expression(
        &mut self,
        env: &Env<'static>,
        membranes: &Membranes,
    ) -> Result<()> {
        match Membranes::tag_of(&self.inner.kind) {
            None => {
                self.when = Some(env.compile(&self.inner.scope.when)?);
            }
            Some(tag) => {
                if let Some(old) = self.instance.take() {
                    membranes.revoke(tag, &old);
                }
                // `when` has no event to bind to for a provider capability; only
                // `allow` is meaningful, evaluated per call.
                let scope = ezcap::Scope {
                    when: "true".to_string(),
                    allow: self.inner.scope.allow.clone(),
                };
                self.instance = Some(
                    membranes
                        .mint(tag, &scope)
                        .map_err(|e| anyhow!("{} scope: {e}", self.inner.kind))?,
                );
            }
        }
        Ok(())
    }
}

impl std::fmt::Display for CapabilityKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CapabilityKind::Annotator => write!(f, "annotator"),
            CapabilityKind::Logger => write!(f, "logger"),
            CapabilityKind::LocalStorage => write!(f, "local_storage"),
            CapabilityKind::Clock => write!(f, "clock"),
            CapabilityKind::HandleEvent(event_kind) => {
                write!(f, "handle_event_{event_kind}")
            }
        }
    }
}
