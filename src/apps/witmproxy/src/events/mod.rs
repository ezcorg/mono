use anyhow::{Result, bail};
use cel_cxx::Activation;
use wasmtime::Store;

use crate::wasm::{
    Host,
    bindgen::{
        Event as WasmEvent,
        witmproxy::plugin::capabilities::{CapabilityKind, EventKind},
    },
};

pub mod connect;
pub mod content;
pub mod recovery;
pub mod request;
pub mod response;
pub mod timer;

/// Trait representing an event that can be handled by the plugin system
pub trait Event: Send {
    /// Returns the [EventKind] this event represents.
    fn kind(&self) -> EventKind;

    /// Returns the [CapabilityKind] required to handle events of this type.
    ///
    /// Derived from [`Self::kind`] rather than declared separately: the two
    /// were previously independent, so `kind()` had to panic on a capability
    /// that was not a `HandleEvent`. Deriving it makes that state
    /// unrepresentable.
    fn capability(&self) -> CapabilityKind {
        CapabilityKind::HandleEvent(self.kind())
    }

    /// Converts into Event by consuming the event and storing it in the provided Store
    fn into_event_data(self: Box<Self>, store: &mut Store<Host>) -> Result<WasmEvent>;

    /// Like [`Self::into_event_data`], but installs a bounded tee on the
    /// event's body so the event can be rebuilt if the guest fails.
    ///
    /// Only called under `RecoveryPolicy::FailOpen`; the default implementation
    /// hands the event over unchanged and reports that recovery is
    /// unavailable, which is the correct answer for an event type whose
    /// payload the host cannot duplicate.
    fn into_event_data_recoverable(
        self: Box<Self>,
        store: &mut Store<Host>,
        _limit: u64,
        _breaches: std::sync::Arc<crate::plugins::limits::BreachRecorder>,
    ) -> Result<(WasmEvent, Option<crate::events::recovery::EventShadow>)> {
        Ok((self.into_event_data(store)?, None))
    }

    /// Register event-specific variables and functions with the CEL environment
    fn register_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
    where
        Self: Sized;

    /// Bind all event-specific variables for the CEL activation
    fn bind_cel_activation<'a>(&'a self, a: Activation<'a>) -> Option<Activation<'a>>;
}

macro_rules! ensure_matches {
    ($expr:expr, $pat:pat $(if $guard:expr)? $(,)?) => {
        match $expr {
            $pat $(if $guard)? => Ok(()),
            _ => Err(anyhow::anyhow!(
                "pattern did not match, expected to find one of: {}",
                stringify!($pat)
            )),
        }
    };
}

impl EventKind {
    /// Validates that the received Event is a valid output variant for this EventKind
    pub fn validate_output(&self, event_data: &WasmEvent) -> Result<()> {
        match self {
            EventKind::Request => {
                ensure_matches!(event_data, WasmEvent::Request(_) | WasmEvent::Response(_))
            }
            EventKind::Response => ensure_matches!(event_data, WasmEvent::Response(_)),
            EventKind::Connect => {
                bail!("Connect events do not return Event (no guest handling)")
            }
            EventKind::InboundContent => ensure_matches!(event_data, WasmEvent::InboundContent(_)),
            EventKind::Timer => ensure_matches!(event_data, WasmEvent::Timer(_)),
        }
    }
}

impl std::fmt::Display for EventKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EventKind::Request => write!(f, "request"),
            EventKind::Response => write!(f, "response"),
            EventKind::Connect => write!(f, "connect"),
            EventKind::InboundContent => write!(f, "inbound_content"),
            EventKind::Timer => write!(f, "timer"),
        }
    }
}
