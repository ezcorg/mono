use anyhow::Result;
use cel_cxx::Activation;
use wasmtime::Store;

use crate::wasm::{
    Host,
    bindgen::{
        EventData,
        witmproxy::plugin::capabilities::{CapabilityKind, EventKind},
    },
};

pub mod connect;
pub mod content;
pub mod request;
pub mod response;

pub trait Event: Send {
    /// Returns the [CapabilityKind] required to handle events of this type
    fn capability(&self) -> CapabilityKind;

    /// Returns the [EventKind] associated with this event type
    fn kind(&self) -> EventKind {
        match self.capability() {
            CapabilityKind::HandleEvent(kind) => kind,
            _ => panic!("Event capability must be of HandleEvent kind"),
        }
    }

    /// Converts into EventData by consuming the event and storing it in the provided Store
    fn event_data(self: Box<Self>, store: &mut Store<Host>) -> Result<EventData>;

    /// Register event-specific variables and functions with the CEL environment
    fn register_in_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
    where
        Self: Sized;

    /// Bind all event-specific variables into CEL activation
    fn bind_to_cel_activation<'a>(&'a self, a: Activation<'a>) -> Option<Activation<'a>>;
}

impl EventKind {
    pub fn validate_output(&self, event_data: &EventData) -> bool {
        match self {
            EventKind::Request => {
                matches!(event_data, EventData::Request(_) | EventData::Response(_))
            }
            EventKind::Response => matches!(event_data, EventData::Response(_)),
            EventKind::Connect => false, // Connect events do not return EventData (no guest handling)
            EventKind::InboundContent => matches!(event_data, EventData::InboundContent(_)),
        }
    }
}

impl ToString for EventKind {
    fn to_string(&self) -> String {
        match self {
            EventKind::Request => "request".to_string(),
            EventKind::Response => "response".to_string(),
            EventKind::Connect => "connect".to_string(),
            EventKind::InboundContent => "inbound_content".to_string(),
        }
    }
}
