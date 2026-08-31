use anyhow::Result;
use cel_cxx::Activation;
use wasmtime::Store;

use crate::events::Event;
use crate::plugins::cel::CelTime;
use crate::wasm::{
    Host,
    bindgen::{
        Event as WasmEvent,
        witmproxy::plugin::capabilities::{EventKind, TimerContext},
    },
};

/// Timer event generated periodically by the host scheduler
pub struct TimerEvent {
    pub timestamp: u64,
}

impl TimerEvent {
    pub fn now() -> Self {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Self { timestamp }
    }
}

impl Event for TimerEvent {
    fn kind(&self) -> EventKind {
        EventKind::Timer
    }

    fn into_event_data(self: Box<Self>, _store: &mut Store<Host>) -> Result<WasmEvent> {
        Ok(WasmEvent::Timer(TimerContext {
            timestamp: self.timestamp,
        }))
    }

    fn into_event_data_recoverable(
        self: Box<Self>,
        store: &mut Store<Host>,
        _limit: u64,
        _breaches: std::sync::Arc<crate::plugins::limits::BreachRecorder>,
    ) -> Result<(
        WasmEvent,
        Option<crate::events::recovery::EventShadow>,
    )> {
        // A timer carries no stream and no resource, so it is always
        // recoverable at zero cost.
        let timestamp = self.timestamp;
        Ok((
            self.into_event_data(store)?,
            Some(crate::events::recovery::EventShadow::Timer { timestamp }),
        ))
    }

    fn register_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
    where
        Self: Sized,
    {
        // Timer events only expose the `time` variable in CEL
        Ok(env)
    }

    fn bind_cel_activation<'a>(&'a self, activation: Activation<'a>) -> Option<Activation<'a>> {
        activation.bind_variable("time", CelTime::now()).ok()
    }
}
