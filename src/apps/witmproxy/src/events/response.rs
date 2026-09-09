use anyhow::Result;
use wasmtime::Store;
use wasmtime_wasi_http::WasiHttpView;
use wasmtime_wasi_http::p3::Response;

use crate::events::Event;
use crate::plugins::cel::{CelRequest, CelResponse, CelTime};
use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
    ContextualResponse as WasiContextualResponse, RequestContext,
};
use crate::wasm::{
    Host,
    bindgen::{Event as WasmEvent, witmproxy::plugin::capabilities::EventKind},
};

pub struct ContextualResponse {
    pub request: RequestContext,
    pub response: Response,
}

impl Event for ContextualResponse {
    fn kind(&self) -> EventKind {
        EventKind::Response
    }

    fn into_event_data(self: Box<Self>, store: &mut Store<Host>) -> Result<WasmEvent> {
        let handle = store.data_mut().http().table.push(self.response)?;
        let response = WasiContextualResponse {
            request: self.request,
            response: handle,
        };
        Ok(WasmEvent::Response(response))
    }

    fn into_event_data_recoverable(
        self: Box<Self>,
        store: &mut Store<Host>,
        limit: u64,
        breaches: std::sync::Arc<crate::plugins::limits::BreachRecorder>,
    ) -> Result<(WasmEvent, Option<crate::events::recovery::EventShadow>)> {
        use crate::events::recovery::{EventShadow, TeeBody};
        use http_body_util::BodyExt;

        let Self { request, response } = *self;

        // Same round-trip as the request path: the body is inside an opaque
        // `wasi:http` resource, and both conversions are handle moves.
        let res = response
            .into_http(&mut *store, async { Ok(()) })
            .map_err(|e| anyhow::anyhow!("failed to unwrap response for recovery: {e:?}"))?;

        let (parts, body) = res.into_parts();
        let status = parts.status;
        let version = parts.version;
        let headers = parts.headers.clone();

        let body = body
            .map_err(crate::proxy::utils::wasi_error_to_code)
            .boxed_unsync();
        let (teed, recording) = TeeBody::wrap(body, limit, breaches);

        let mut rebuilt = hyper::Response::new(teed);
        *rebuilt.status_mut() = parts.status;
        *rebuilt.version_mut() = parts.version;
        *rebuilt.headers_mut() = parts.headers;

        let (wasi, _io) = Response::from_http(wasmtime_wasi_http::default_hooks(), rebuilt);
        let handle = store.data_mut().http().table.push(wasi)?;

        Ok((
            WasmEvent::Response(WasiContextualResponse {
                request: request.clone(),
                response: handle,
            }),
            Some(EventShadow::Response {
                status,
                version,
                headers,
                request,
                recording,
            }),
        ))
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
            .and_then(|a| {
                a.bind_variable("response", CelResponse::from(&self.response))
                    .ok()
            })
            .and_then(|a| a.bind_variable("time", CelTime::now()).ok())
    }
}
