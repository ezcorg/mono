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

impl ToString for CapabilityKind {
    fn to_string(&self) -> String {
        match self {
            CapabilityKind::Annotator => "annotator".to_string(),
            CapabilityKind::Logger => "logger".to_string(),
            CapabilityKind::LocalStorage => "local-storage".to_string(),
            CapabilityKind::HandleEvent(event_kind) => match event_kind {
                crate::wasm::bindgen::witmproxy::plugin::capabilities::EventKind::Connect => {
                    "handle-connect".to_string()
                }
                crate::wasm::bindgen::witmproxy::plugin::capabilities::EventKind::Request => {
                    "handle-request".to_string()
                }
                crate::wasm::bindgen::witmproxy::plugin::capabilities::EventKind::Response => {
                    "handle-response".to_string()
                }
                crate::wasm::bindgen::witmproxy::plugin::capabilities::EventKind::InboundContent => {
                    "handle-inbound-content".to_string()
                }
            },
        }
    }
}
