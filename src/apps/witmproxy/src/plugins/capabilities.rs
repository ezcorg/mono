use anyhow::Result;
use cel_cxx::{Env, Program};
use serde::{Deserialize, Serialize};

use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
    Capability as WitCapability, CapabilityKind
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

impl ToString for CapabilityKind {
    fn to_string(&self) -> String {
        match self {
            CapabilityKind::Annotator => "annotator".to_string(),
            CapabilityKind::Logger => "logger".to_string(),
            CapabilityKind::LocalStorage => "local_storage".to_string(),
            CapabilityKind::HandleEvent(event_kind) => format!("handle_event_{}", event_kind.to_string()),
        }
    }
}
