use anyhow::Result;
use cel_cxx::Activation;
use wasmtime::Store;

use crate::events::Event;
use crate::plugins::cel::{CelConnect, CelTime};
use crate::wasm::{
    Host,
    bindgen::{Event as WasmEvent, witmproxy::plugin::capabilities::EventKind},
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
    fn kind(&self) -> EventKind {
        EventKind::Connect
    }

    fn into_event_data(self: Box<Self>, _store: &mut Store<Host>) -> Result<WasmEvent> {
        // Connect events gate interception; they are never handed to a guest.
        // That is a caller contract rather than a type-level guarantee, so
        // report it instead of aborting the process.
        anyhow::bail!("connect events are not passed to plugins and cannot be converted")
    }

    fn register_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
    where
        Self: Sized,
    {
        let env = env
            .declare_variable::<CelConnect>("connect")?
            .register_member_function("host", CelConnect::host)?
            .register_member_function("port", CelConnect::port)?;
        Ok(env)
    }

    fn bind_cel_activation<'a>(&'a self, activation: Activation<'a>) -> Option<Activation<'a>> {
        activation
            .bind_variable("connect", CelConnect::from(self))
            .ok()
            .and_then(|a| a.bind_variable("time", CelTime::now()).ok())
    }
}
