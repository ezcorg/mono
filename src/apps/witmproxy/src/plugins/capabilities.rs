use anyhow::{Result, anyhow};
use cel_cxx::{Env, Program};
use serde::{Deserialize, Serialize};

use crate::plugins::grants::{self, Grants, PluginKind};
use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
    Capability as WitCapability, CapabilityKind,
};
use icanhaz_broker::broker::{GrantStore, denied_text};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capability {
    pub inner: WitCapability,
    pub granted: bool,
    /// The compiled `when` program, for event capabilities: decides per event
    /// whether the plugin runs at all.
    #[serde(skip)]
    pub when: Option<Program<'static>>,
    /// The grant, for provider capabilities: every call on the granted
    /// resource is admitted through it against `allow`.
    #[serde(skip)]
    pub token: Option<String>,
}

impl Capability {
    /// Compile this capability's scope. Event kinds compile `when` against the
    /// event environment; provider kinds are issued as a grant to the plugin
    /// (an `installed-app` principal), which type-checks `allow` against the
    /// resource's interface (a clause naming an argument the interface does
    /// not have is refused here, at registration, never at the first call).
    /// Re-compiling a narrowed scope revokes the previous grant.
    pub fn compile_scope_expression(
        &mut self,
        env: &Env<'static>,
        grants: &Grants,
        plugin_id: &str,
    ) -> Result<()> {
        match grants::tag_of(&self.inner.kind) {
            None => {
                self.when = Some(env.compile(&self.inner.scope.when)?);
            }
            Some(_) => {
                let mut store = grants::lock(grants);
                if let Some(old) = self.token.take() {
                    store.revoke(&old);
                }
                // `when` has no event to bind to for a provider capability; only
                // `allow` is meaningful, evaluated per call.
                let scope = ezcap::Scope {
                    when: "true".to_string(),
                    allow: self.inner.scope.allow.clone(),
                };
                let token = store
                    .issue_scoped(
                        PluginKind(self.inner.kind),
                        scope,
                        format!("{} ({plugin_id})", self.inner.kind),
                        GrantStore::<PluginKind>::FOREVER,
                        grants::principal(plugin_id),
                    )
                    .map_err(|d| anyhow!("{} scope: {}", self.inner.kind, denied_text(&d)))?;
                self.token = Some(token);
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
