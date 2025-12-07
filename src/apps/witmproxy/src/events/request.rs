use crate::events::Event;
use crate::plugins::cel::CelRequest;
use crate::wasm::Host;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::CapabilityKind;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::EventData;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::EventKind;
use anyhow::Result;
use cel_cxx::Activation;
use http_body::Body;
use hyper::Request;
use wasmtime::Store;
use wasmtime::component::Resource;
use wasmtime_wasi_http::p3::Request as WasiRequest;
use wasmtime_wasi_http::p3::WasiHttpView;

impl Event for WasiRequest {
    fn capability(&self) -> CapabilityKind {
        CapabilityKind::HandleEvent(EventKind::Request)
    }

    fn event_data(self: Box<Self>, store: &mut Store<Host>) -> Result<EventData> {
        let handle: Resource<WasiRequest> = store.data_mut().http().table.push(*self)?;
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
        activation
            .bind_variable("request", CelRequest::from(self))
            .ok()
    }
}

impl<T> Event for Request<T>
where
    T: Body<Data = bytes::Bytes> + Send + Sync + 'static,
{
    fn capability(&self) -> CapabilityKind {
        CapabilityKind::HandleEvent(EventKind::Request)
    }

    fn event_data(
        self: Box<Self>,
        store: &mut Store<Host>,
    ) -> Result<crate::wasm::bindgen::EventData> {
        anyhow::bail!("Conversion from Request<T> to EventData is not supported")
    }

    fn register_in_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
    where
        Self: Sized,
    {
        // No-op as this is handled by WasiRequest
        Ok(env)
    }

    fn bind_to_cel_activation<'a>(&'a self, activation: Activation<'a>) -> Option<Activation<'a>> {
        activation
            .bind_variable("request", CelRequest::from(self))
            .ok()
    }
}
