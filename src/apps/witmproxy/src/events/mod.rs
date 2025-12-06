use anyhow::Result;
use cel_cxx::Activation;
use wasmtime::Store;

use crate::wasm::{Host, bindgen::{EventData, witmproxy::plugin::capabilities::{CapabilityKind, EventKind}}};

pub mod request;
pub mod response;
pub mod connect;
pub mod content;

pub trait Event
{
    /// Returns the [CapabilityKind] required to handle events of this type
    fn capability() -> CapabilityKind
        where Self: Sized;

    /// Returns the [EventKind] associated with this event type
    fn kind() -> EventKind
        where Self: Sized {
            match Self::capability() {
                CapabilityKind::HandleEvent(kind) => kind,
                _ => panic!("Event capability must be of HandleEvent kind"),
            }
        }

    /// Converts into EventData by consuming the event and storing it in the provided Store
    fn event_data(self, store: &mut Store<Host>) -> Result<EventData>;
    
    /// Register event-specific variables and functions with the CEL environment
    fn register_in_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
        where Self: Sized;

    /// Bind all event-specific variables into CEL activation
    fn bind_to_cel_activation<'a>(&'a self, a: Activation<'a>) -> Option<Activation<'a>>;
}

impl EventKind {
    pub fn validate_output(&self, event_data: &EventData) -> bool {
        match self {
            EventKind::Request => matches!(event_data, EventData::Request(_) | EventData::Response(_)),
            EventKind::Response => matches!(event_data, EventData::Response(_)),
            EventKind::Connect => false, // Connect events do not return EventData (no guest handling)
            EventKind::InboundContent => matches!(event_data, EventData::InboundContent(_)),
        }
    }
}