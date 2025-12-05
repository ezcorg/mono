use anyhow::Result;
use hyper::Response;
use wasmtime::{Store, component::Resource};
use wasmtime_wasi_http::p3::Response as WasiResponse;
use wasmtime_wasi_http::p3::WasiHttpView;

use crate::events::Event;
use crate::plugins::cel::CelRequest;
use crate::plugins::cel::CelResponse;
use crate::{wasm::{Host, bindgen::{EventData, witmproxy::plugin::capabilities::{CapabilityKind, EventKind}}}};

pub enum ResponseEnum<T>
where
    T: http_body::Body + Send + Sync + 'static,
{
    WasiResponse(WasiResponse),
    HyperResponse(Response<T>),
}

pub struct ResponseWithRequestContext<T>
where
    T: http_body::Body<Data = bytes::Bytes> + Send + Sync + 'static,
{
    pub request_ctx: CelRequest,
    pub response: ResponseEnum<T>
}

impl<T> Event for ResponseWithRequestContext<T>
where
    T: http_body::Body<Data = bytes::Bytes> + Send + Sync + 'static,
{
    fn capability() -> CapabilityKind {
        CapabilityKind::HandleEvent(EventKind::Response)
    }

    fn data(self, store: &mut Store<Host>) -> Result<EventData> {
        match self.response {
            ResponseEnum::WasiResponse(wasi_response) => {
                let handle: Resource<WasiResponse> = store.data_mut().http().table.push(wasi_response)?;
                Ok(EventData::Response(handle))
            },
            ResponseEnum::HyperResponse(_) => {
                anyhow::bail!("Conversion from Response<T> to EventData is not supported")
            }
        }
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
        activation.bind_variable("request", &self.request_ctx).ok().and_then(|activation| {
            activation.bind_variable("response", CelResponse::from(&self.response)).ok()
        })
    }
}