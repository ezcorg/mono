use anyhow::Result;
use cel_cxx::Activation;
use wasmtime::{Store};

use crate::events::Event;
use crate::plugins::{cel::CelConnect};
use crate::wasm::{Host, bindgen::{EventData, witmproxy::plugin::capabilities::{CapabilityKind, EventKind}}};

/// Connect event represents a connection attempt to a host:port
#[derive(Debug, Clone)]
pub struct Connect {
    pub host: String,
    pub port: u16,
}

impl Connect {
    pub fn new(host: String, port: u16) -> Self {
        Self { host, port }
    }
    
    pub fn from_cel_connect(cel_connect: &CelConnect) -> Self {
        Self {
            host: cel_connect.host.clone(),
            port: cel_connect.port,
        }
    }
    
    pub fn to_cel_connect(&self) -> CelConnect {
        CelConnect {
            host: self.host.clone(),
            port: self.port,
        }
    }
}

impl Event for Connect {
    fn capability() -> CapabilityKind {
        CapabilityKind::HandleEvent(EventKind::Connect)
    }

    fn data(self, store: &mut Store<Host>) -> Result<EventData> {
        // For Connect events, we don't have a WASI resource to store
        // Instead, we can create a synthetic EventData representation
        // TODO: This might need to be adjusted based on the actual WASM interface requirements
        anyhow::bail!("Connect events don't currently support conversion to EventData")
    }

    fn register_in_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
        where Self: Sized {
        let env = env
            .declare_variable::<CelConnect>("connect")?
            .register_member_function("host", CelConnect::host)?
            .register_member_function("port", CelConnect::port)?;
        Ok(env)
    }

    fn bind_to_cel_activation<'a>(&'a self, activation: Activation<'a>) -> Option<Activation<'a>> {
        let cel_connect = self.to_cel_connect();
        activation.bind_variable("connect", &cel_connect).ok()
    }
}
