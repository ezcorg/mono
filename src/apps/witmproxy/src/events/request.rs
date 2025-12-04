use cel_cxx::Activation;
use wasmtime::component::Resource;
use wasmtime_wasi_http::p3::Request;
use crate::plugins::cel::CelRequest;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::EventData;
use anyhow::Result;
use crate::wasm::Host;
use wasmtime::Store;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::EventKind;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::CapabilityKind;
use crate::plugins::Event;
use wasmtime_wasi_http::p3::WasiHttpView;

impl Event for Request {
    fn capability() -> CapabilityKind {
        CapabilityKind::HandleEvent(EventKind::Request)
    }

    fn into_event_data(self, store: &mut Store<Host>) -> Result<EventData> {
        let handle: Resource<Request> = store.data_mut().http().table.push(self)?;
        Ok(EventData::Request(handle))
    }

    fn register_in_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>> {
        let env = env
            .declare_variable::<CelRequest>("request")?
            .register_member_function("scheme", CelRequest::scheme)?
            .register_member_function("host", CelRequest::host)?
            .register_member_function("path", CelRequest::path)?
            .register_member_function("query", CelRequest::query)?
            .register_member_function("method", CelRequest::method)?
            .register_member_function("headers", CelRequest::headers)?;
        Ok(env)
    }

    fn bind_to_cel_activation<'a>(&'a self, activation: Activation<'a>) -> Option<Activation<'a>> {
        activation.bind_variable("request", CelRequest::from(self)).ok()
    }
}
