use anyhow::Result;
use wasmtime::{Store, component::Resource};
use wasmtime_wasi_http::p3::Response;
use wasmtime_wasi_http::p3::WasiHttpView;

use crate::plugins::cel::CelResponse;
use crate::{plugins::Event, wasm::{Host, bindgen::{EventData, witmproxy::plugin::capabilities::{CapabilityKind, EventKind}}}};

impl Event for Response {
    fn capability() -> CapabilityKind {
        CapabilityKind::HandleEvent(EventKind::Response)
    }

    fn into_event_data(self, store: &mut Store<Host>) -> Result<EventData> {
        let handle: Resource<Response> = store.data_mut().http().table.push(self)?;
        Ok(EventData::Response(handle))
    }
    
    fn register_in_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
            where Self: Sized {
        let env = env
            .declare_variable::<CelResponse>("response")?
            .register_member_function("status", CelResponse::status)?
            .register_member_function("headers", CelResponse::headers)?;
        Ok(env)
    }

    fn bind_to_cel_activation<'a>(&'a self, activation: cel_cxx::Activation<'a>) -> Option<cel_cxx::Activation<'a>> {
        activation.bind_variable("response", CelResponse::from(self)).ok()
    }
}