use crate::events::Event;
use crate::plugins::cel::{CelRequest, CelTime};
use crate::wasm::Host;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::Event as WasmEvent;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::EventKind;
use anyhow::Result;
use cel_cxx::Activation;
use http_body::Body;
use hyper::Request;
use wasmtime::Store;
use wasmtime::component::Resource;
use wasmtime_wasi_http::p3::Request as WasiRequest;
use wasmtime_wasi_http::WasiHttpView;

impl Event for WasiRequest {
    fn kind(&self) -> EventKind {
        EventKind::Request
    }

    fn into_event_data(self: Box<Self>, store: &mut Store<Host>) -> Result<WasmEvent> {
        let handle: Resource<WasiRequest> = store.data_mut().http().table.push(*self)?;
        Ok(WasmEvent::Request(handle))
    }

    fn into_event_data_recoverable(
        self: Box<Self>,
        store: &mut Store<Host>,
        limit: u64,
        breaches: std::sync::Arc<crate::plugins::limits::BreachRecorder>,
    ) -> Result<(WasmEvent, Option<crate::events::recovery::EventShadow>)> {
        use crate::events::recovery::{EventShadow, TeeBody};
        use http_body_util::BodyExt;

        // The request's body lives inside an opaque `wasi:http` resource, so
        // the tee is installed by round-tripping through `http::Request`:
        // both directions are handle moves, not copies.
        let (req, _options) = (*self)
            .into_http(&mut *store, async { Ok(()) })
            .map_err(|e| anyhow::anyhow!("failed to unwrap request for recovery: {e:?}"))?;

        let (parts, body) = req.into_parts();
        let method = parts.method.clone();
        let uri = parts.uri.clone();
        let version = parts.version;
        let headers = parts.headers.clone();

        let body = body
            .map_err(crate::proxy::utils::wasi_error_to_code)
            .boxed_unsync();
        let (teed, recording) = TeeBody::wrap(body, limit, breaches);

        let mut rebuilt = hyper::Request::new(teed);
        *rebuilt.method_mut() = parts.method;
        *rebuilt.uri_mut() = parts.uri;
        *rebuilt.version_mut() = parts.version;
        *rebuilt.headers_mut() = parts.headers;

        let (wasi, _io) =
            WasiRequest::from_http(wasmtime_wasi_http::default_hooks(), rebuilt);
        let handle: Resource<WasiRequest> = store.data_mut().http().table.push(wasi)?;

        Ok((
            WasmEvent::Request(handle),
            Some(EventShadow::Request {
                method,
                uri,
                version,
                headers,
                recording,
            }),
        ))
    }

    fn register_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>> {
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

    fn bind_cel_activation<'a>(&'a self, activation: Activation<'a>) -> Option<Activation<'a>> {
        activation
            .bind_variable("request", CelRequest::from(self))
            .ok()
            .and_then(|a| a.bind_variable("time", CelTime::now()).ok())
    }
}

impl<T> Event for Request<T>
where
    T: Body<Data = bytes::Bytes> + Send + Sync + 'static,
{
    fn kind(&self) -> EventKind {
        EventKind::Request
    }

    fn into_event_data(
        self: Box<Self>,
        _store: &mut Store<Host>,
    ) -> Result<crate::wasm::bindgen::Event> {
        anyhow::bail!(
            "Conversion from Request<T> to Event is possible, but not supported. Use `wasmtime_wasi_http::p3::Request` instead."
        );
    }

    fn register_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
    where
        Self: Sized,
    {
        // No-op as this is handled by WasiRequest
        Ok(env)
    }

    fn bind_cel_activation<'a>(&'a self, activation: Activation<'a>) -> Option<Activation<'a>> {
        activation
            .bind_variable("request", CelRequest::from(self))
            .ok()
            .and_then(|a| a.bind_variable("time", CelTime::now()).ok())
    }
}
