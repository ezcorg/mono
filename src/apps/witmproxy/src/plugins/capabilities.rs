use anyhow::Result;
use cel_cxx::{Env, Program};
use serde::{Deserialize, Serialize};

use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
    Capability as WitCapability, CapabilityKind,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capability {
    pub inner: WitCapability,
    pub granted: bool,
    /// Compiled CEL program
    #[serde(skip)]
    pub cel: Option<Program<'static>>,
}

impl Capability {
    pub fn compile_scope_expression(&mut self, env: &Env<'static>) -> Result<()> {
        self.cel = Some(env.compile(&self.inner.scope.expression)?);
        Ok(())
    }
}

impl std::fmt::Display for CapabilityKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CapabilityKind::Annotator => write!(f, "annotator"),
            CapabilityKind::Logger => write!(f, "logger"),
            CapabilityKind::LocalStorage => write!(f, "local_storage"),
            CapabilityKind::HandleEvent(event_kind) => {
                write!(f, "handle_event_{event_kind}")
            }
        }
    }
}
