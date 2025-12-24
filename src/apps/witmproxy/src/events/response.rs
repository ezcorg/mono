use anyhow::Result;
use wasmtime::Store;
use wasmtime_wasi_http::p3::{Response, WasiHttpView};

use crate::events::Event;
use crate::plugins::cel::{CelRequest, CelResponse};
use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
    ContextualResponse as WasiContextualResponse, RequestContext,
};
use crate::wasm::{
    Host,
    bindgen::{
        Event as WasmEvent,
        witmproxy::plugin::capabilities::{CapabilityKind, EventKind},
    },
};

pub struct ContextualResponse {
    pub request: RequestContext,
    pub response: Response,
}

impl Event for ContextualResponse {
    fn capability(&self) -> CapabilityKind {
        CapabilityKind::HandleEvent(EventKind::Response)
    }

    fn into_event_data(self: Box<Self>, store: &mut Store<Host>) -> Result<WasmEvent> {
        let handle = store.data_mut().http().table.push(self.response)?;
        let response = WasiContextualResponse {
            request: self.request,
            response: handle,
        };
        Ok(WasmEvent::Response(response))
    }

    fn register_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
    where
        Self: Sized,
    {
        let env = env
            .declare_variable::<CelResponse>("response")?
            .register_member_function("status", CelResponse::status)?
            .register_member_function("headers", CelResponse::headers)?;
        Ok(env)
    }

    fn bind_cel_activation<'a>(
        &'a self,
        activation: cel_cxx::Activation<'a>,
    ) -> Option<cel_cxx::Activation<'a>> {
        activation
            .bind_variable("request", CelRequest::from(&self.request))
            .ok()
            .and_then(|activation| {
                activation
                    .bind_variable("response", CelResponse::from(&self.response))
                    .ok()
            })
    }
}
