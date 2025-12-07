use anyhow::Result;
use cel_cxx::Activation;
use wasmtime::Store;

use crate::events::Event;
use crate::plugins::cel::CelConnect;
use crate::wasm::{
    Host,
    bindgen::{
        EventData,
        witmproxy::plugin::capabilities::{CapabilityKind, EventKind},
    },
};

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
}

impl From<&Connect> for CelConnect {
    fn from(connect: &Connect) -> Self {
        CelConnect {
            host: connect.host.clone(),
            port: connect.port,
        }
    }
}

impl Event for Connect {
    fn capability(&self) -> CapabilityKind {
        CapabilityKind::HandleEvent(EventKind::Connect)
    }

    fn event_data(self: Box<Self>, _store: &mut Store<Host>) -> Result<EventData> {
        // No EventData conversion, as Connect events don't result in WASM handling
        anyhow::bail!("Connect events don't currently support conversion to EventData")
    }

    fn register_in_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
    where
        Self: Sized,
    {
        let env = env
            .declare_variable::<CelConnect>("connect")?
            .register_member_function("host", CelConnect::host)?
            .register_member_function("port", CelConnect::port)?;
        Ok(env)
    }

    fn bind_to_cel_activation<'a>(&'a self, activation: Activation<'a>) -> Option<Activation<'a>> {
        activation
            .bind_variable("connect", CelConnect::from(self))
            .ok()
    }
}
