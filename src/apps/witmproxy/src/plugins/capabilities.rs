use anyhow::Result;
use cel_cxx::{Env, Program};
use serde::{Deserialize, Serialize};

use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
    Capability as WitCapability,
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

// impl ToString for Capability {
//     fn to_string(&self) -> String {
//         match &self.inner {
//             WitCapability::HandleEvent(EventSelector::Connect(_)) => "handle-connect".to_string(),
//             WitCapability::HandleEvent(EventSelector::Request(_)) => "handle-request".to_string(),
//             WitCapability::HandleEvent(EventSelector::Response(_)) => "handle-response".to_string(),
//             WitCapability::HandleEvent(EventSelector::InboundContent(_)) => {
//                 "handle-inbound-content".to_string()
//             }
//             WitCapability::Annotator => "annotator".to_string(),
//             WitCapability::Logger => "logger".to_string(),
//             WitCapability::LocalStorage => "local-storage".to_string(),
//             _ => "unknown".to_string(),
//         }
//     }
// }
