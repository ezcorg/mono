use std::collections::HashMap;
use std::io::Cursor;
use std::pin::Pin;
use std::task::{Context, Poll};

use anyhow::Result;
use bytes::Bytes;
use http_body::Body as _;
use http_body_util::combinators::UnsyncBoxBody;
use wasmtime::component::{
    Destination, HasData, Resource, ResourceTable, StreamProducer, StreamReader, StreamResult,
};
use wasmtime::{Store, StoreContextMut};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::p3::bindings::http::types::ErrorCode;
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView, p3::Response};

mod runtime;

use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
    HostAnnotatorClient, HostCapabilityProvider, HostContent, HostLocalStorageClient, HostLogger,
};
pub use runtime::Runtime;

pub mod bindgen;

pub struct CapabilityProvider {}

impl Default for CapabilityProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl CapabilityProvider {
    pub fn new() -> Self {
        Self {}
    }

    pub fn logger(&self) -> Option<Logger> {
        Some(Logger {})
    }
}

pub struct AnnotatorClient {}

impl AnnotatorClient {
    pub fn annotate(&self, content: &InboundContent) {}
}

/// Custom StreamProducer for body streaming
struct BodyStreamProducer {
    body: UnsyncBoxBody<Bytes, ErrorCode>,
}

impl<D> StreamProducer<D> for BodyStreamProducer
where
    D: 'static,
{
    type Item = u8;
    type Buffer = Cursor<Bytes>;

    fn poll_produce<'a>(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        mut store: StoreContextMut<'a, D>,
        mut dst: Destination<'a, Self::Item, Self::Buffer>,
        _finish: bool,
    ) -> Poll<wasmtime::Result<StreamResult>> {
        use core::num::NonZeroUsize;

        let cap = match dst.remaining(&mut store).map(NonZeroUsize::new) {
            Some(Some(cap)) => Some(cap),
            Some(None) => {
                // On 0-length, check if the stream has ended
                if self.body.is_end_stream() {
                    return Poll::Ready(Ok(StreamResult::Dropped));
                } else {
                    return Poll::Ready(Ok(StreamResult::Completed));
                }
            }
            None => None,
        };

        match Pin::new(&mut self.body).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                // Try to extract data from the frame
                match frame.into_data() {
                    Ok(mut data_frame) => {
                        if let Some(cap) = cap {
                            let n = data_frame.len();
                            let cap_usize = cap.into();
                            if n > cap_usize {
                                // Data doesn't fit, buffer the rest
                                dst.set_buffer(Cursor::new(data_frame.split_off(cap_usize)));
                                let mut dst_direct = dst.as_direct(store, cap_usize);
                                dst_direct.remaining().copy_from_slice(&data_frame);
                                dst_direct.mark_written(cap_usize);
                            } else {
                                // Copy the whole frame
                                let mut dst_direct = dst.as_direct(store, n);
                                dst_direct.remaining()[..n].copy_from_slice(&data_frame);
                                dst_direct.mark_written(n);
                            }
                        } else {
                            // No capacity info, just buffer it
                            dst.set_buffer(Cursor::new(data_frame));
                        }
                        Poll::Ready(Ok(StreamResult::Completed))
                    }
                    Err(_frame) => {
                        // Frame is trailers or something else, we're done with data
                        Poll::Ready(Ok(StreamResult::Dropped))
                    }
                }
            }
            Poll::Ready(Some(Err(_err))) => Poll::Ready(Ok(StreamResult::Dropped)),
            Poll::Ready(None) => Poll::Ready(Ok(StreamResult::Dropped)),
            Poll::Pending => Poll::Pending,
        }
    }
}

pub struct InboundContent {
    response: Response,
}

/// [`InboundContent`] is a wrapper around a WASI HTTP [`Response`]
/// that provides a convenient interface for accessing and modifying
/// the content of the response (without worrying about any encoding or decoding).
impl InboundContent {
    pub fn new(response: Response) -> Self {
        Self { response }
    }

    /// Consumes the Content and returns the underlying Response
    pub fn consume_response(self) -> Response {
        self.response
    }

    pub fn content_type(&self) -> Option<String> {
        self.response.content_type()
    }

    fn body_to_stream_reader(self, store: &mut Store<Host>) -> Result<StreamReader<u8>> {
        // Create a result future for the response processing
        let result_fut = async { Ok(()) };

        // Convert Response to http::Response to access the body
        let http_response =
            self.response
                .into_http_with_getter(&mut *store, result_fut, host_getter)?;

        // Extract the body from the http::Response
        let (_parts, body) = http_response.into_parts();

        // Create a BodyStreamProducer to wrap the body
        let producer = BodyStreamProducer { body };

        // Create and return the StreamReader
        let reader = StreamReader::new(store, producer);
        Ok(reader)
    }

    pub fn text(self, store: &mut Store<Host>) -> Result<StreamReader<u8>> {
        self.body_to_stream_reader(store)
    }

    pub fn set_text(&mut self, _text: StreamReader<String>, store: &mut Store<Host>) {
        todo!()
    }
}

pub struct Logger {}

impl Logger {
    pub fn info(&self, message: String) {
        tracing::info!("{}", message);
    }

    pub fn warn(&self, message: String) {
        tracing::warn!("{}", message);
    }

    pub fn error(&self, message: String) {
        tracing::error!("{}", message);
    }

    pub fn debug(&self, message: String) {
        tracing::debug!("{}", message);
    }
}

#[derive(Default)]
pub struct LocalStorageClient {
    pub store: HashMap<String, Vec<u8>>,
}

impl LocalStorageClient {
    pub fn set(&mut self, key: String, value: Vec<u8>) {
        let _ = self.store.insert(key, value);
    }

    pub fn get(&self, key: String) -> Option<&Vec<u8>> {
        self.store.get(&key)
    }
    pub fn delete(&mut self, key: String) {
        let _ = self.store.remove(&key);
    }
}

/// Builder-style structure used to create a [`WitmProxyCtx`].
#[derive(Default)]
pub struct WitmProxyCtxBuilder {
    // Add any initial configuration here
}

impl WitmProxyCtxBuilder {
    /// Creates a builder for a new context with default parameters set.
    pub fn new() -> Self {
        Default::default()
    }

    /// Uses the configured context so far to construct the final [`WitmProxyCtx`].
    pub fn build(self) -> WitmProxyCtx {
        WitmProxyCtx {
            // Initialize context state
        }
    }
}

/// Capture the state necessary for use in the `witmproxy:plugin` API implementation.
pub struct WitmProxyCtx {
    // Add context state here
}

impl WitmProxyCtx {
    /// Convenience function for calling [`WitmProxyCtxBuilder::new`].
    pub fn builder() -> WitmProxyCtxBuilder {
        WitmProxyCtxBuilder::new()
    }
}

/// A wrapper capturing the needed internal `witmproxy:plugin` state.
pub struct WitmProxy<'a> {
    _ctx: &'a WitmProxyCtx,
    table: &'a mut ResourceTable,
}

impl<'a> WitmProxy<'a> {
    /// Create a new view into the `witmproxy:plugin` state.
    pub fn new(ctx: &'a WitmProxyCtx, table: &'a mut ResourceTable) -> Self {
        Self { _ctx: ctx, table }
    }
}

/// Minimal WASI host state for each Store.
pub struct Host {
    pub table: ResourceTable,
    pub wasi: WasiCtx,
    pub http: WasiHttpCtx,
    pub p3_http: P3Ctx,
    pub witmproxy_ctx: WitmProxyCtx,
}

impl Default for Host {
    fn default() -> Self {
        Self {
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
            http: WasiHttpCtx::new(),
            p3_http: P3Ctx {},
            witmproxy_ctx: WitmProxyCtxBuilder::new().build(),
        }
    }
}

/// Helper function to get WasiHttpCtxView from Host
fn host_getter(host: &mut Host) -> wasmtime_wasi_http::p3::WasiHttpCtxView<'_> {
    wasmtime_wasi_http::p3::WasiHttpCtxView {
        ctx: &mut host.p3_http,
        table: &mut host.table,
    }
}

#[derive(PartialEq, Eq)]
pub enum ContentEncoding {
    Gzip,    // gzip
    Deflate, // deflate
    Br,      // br
    Zstd,    // zstd
    None,    // identity
    // Dcb,
    // Dcz,
    Unknown,
}

pub trait Encoded {
    fn encoding(&self) -> ContentEncoding;
}

impl Encoded for Response {
    fn encoding(&self) -> ContentEncoding {
        for value in self.headers.get_all("content-encoding") {
            if let Ok(value_str) = value.to_str() {
                match value_str.to_lowercase().as_str() {
                    "gzip" => return ContentEncoding::Gzip,
                    "deflate" => return ContentEncoding::Deflate,
                    "br" => return ContentEncoding::Br,
                    "identity" => return ContentEncoding::None,
                    _ => return ContentEncoding::Unknown,
                }
            }
        }
        ContentEncoding::None
    }
}

pub trait ContentTyped {
    fn content_type(&self) -> Option<String>;
}

impl ContentTyped for Response {
    fn content_type(&self) -> Option<String> {
        let joined = self
            .headers
            .get_all("content-type")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .collect::<Vec<&str>>()
            .join(", ");

        if joined.is_empty() {
            None
        } else {
            Some(joined)
        }
    }
}

impl HostContent for WitmProxy<'_> {
    fn drop(&mut self, rep: wasmtime::component::Resource<InboundContent>) -> wasmtime::Result<()> {
        let _ = self.table.delete(rep);
        Ok(())
    }

    fn set_text(
        &mut self,
        self_: wasmtime::component::Resource<InboundContent>,
        text: StreamReader<String>,
    ) {
        todo!()
    }

    #[doc = " Returns the content as a stream of UTF-8 encoded text"]
    fn text(
        &mut self,
        self_: wasmtime::component::Resource<InboundContent>,
    ) -> StreamReader<String> {
        todo!()
    }

    #[doc = " Returns the content type of the content, ex: \"text/html; charset=utf-8\""]
    fn content_type(&mut self, self_: wasmtime::component::Resource<InboundContent>) -> String {
        todo!()
    }
}

// Implement the Host traits using the wrapper pattern
impl HostLocalStorageClient for WitmProxy<'_> {
    fn set(&mut self, self_: Resource<LocalStorageClient>, key: String, value: Vec<u8>) {
        let client = self.table.get_mut(&self_).unwrap();
        client.set(key, value);
    }

    fn get(&mut self, self_: Resource<LocalStorageClient>, key: String) -> Option<Vec<u8>> {
        let client = self.table.get(&self_).unwrap();
        client.get(key).cloned()
    }

    fn delete(&mut self, self_: Resource<LocalStorageClient>, key: String) {
        let client = self.table.get_mut(&self_).unwrap();
        client.delete(key);
    }

    fn drop(&mut self, rep: Resource<LocalStorageClient>) -> wasmtime::Result<()> {
        let _ = self.table.delete(rep);
        Ok(())
    }
}
impl HostAnnotatorClient for WitmProxy<'_> {
    fn annotate(&mut self, self_: Resource<AnnotatorClient>, content: Resource<InboundContent>) {
        let annotator = self.table.get(&self_).unwrap();
        let content = self.table.get(&content).unwrap();
        annotator.annotate(content)
    }

    fn drop(&mut self, rep: Resource<AnnotatorClient>) -> wasmtime::Result<()> {
        let _ = self.table.delete(rep);
        Ok(())
    }
}

impl HostLogger for WitmProxy<'_> {
    fn info(&mut self, self_: Resource<Logger>, message: String) {
        let logger = self.table.get(&self_).unwrap();
        logger.info(message);
    }

    fn warn(&mut self, self_: Resource<Logger>, message: String) {
        let logger = self.table.get(&self_).unwrap();
        logger.warn(message);
    }

    fn error(&mut self, self_: Resource<Logger>, message: String) {
        let logger = self.table.get(&self_).unwrap();
        logger.error(message);
    }

    fn debug(&mut self, self_: Resource<Logger>, message: String) {
        let logger = self.table.get(&self_).unwrap();
        logger.debug(message);
    }

    fn drop(&mut self, rep: Resource<Logger>) -> wasmtime::Result<()> {
        let _ = self.table.delete(rep);
        Ok(())
    }
}

impl HostCapabilityProvider for WitmProxy<'_> {
    fn logger(&mut self, _cap: Resource<CapabilityProvider>) -> Option<Resource<Logger>> {
        let logger = Logger {};
        Some(self.table.push(logger).unwrap())
    }

    fn local_storage(
        &mut self,
        _cap: Resource<CapabilityProvider>,
    ) -> Option<Resource<LocalStorageClient>> {
        let client = LocalStorageClient::default();
        Some(self.table.push(client).unwrap())
    }

    fn annotator(
        &mut self,
        _cap: Resource<CapabilityProvider>,
    ) -> Option<Resource<AnnotatorClient>> {
        let client = AnnotatorClient {};
        Some(self.table.push(client).unwrap())
    }

    fn drop(&mut self, rep: Resource<CapabilityProvider>) -> wasmtime::Result<()> {
        let _ = self.table.delete(rep);
        Ok(())
    }
}

// Implement the generated capabilities::Host trait
impl bindgen::witmproxy::plugin::capabilities::Host for WitmProxy<'_> {}

pub struct P3Ctx {}
impl wasmtime_wasi_http::p3::WasiHttpCtx for P3Ctx {}

impl WasiView for Host {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiHttpView for Host {
    fn ctx(&mut self) -> &mut WasiHttpCtx {
        &mut self.http
    }

    fn table(&mut self) -> &mut ResourceTable {
        &mut self.table
    }
}

impl wasmtime_wasi_http::p3::WasiHttpView for Host {
    fn http(&mut self) -> wasmtime_wasi_http::p3::WasiHttpCtxView<'_> {
        wasmtime_wasi_http::p3::WasiHttpCtxView {
            table: &mut self.table,
            ctx: &mut self.p3_http,
        }
    }
}

/// Add all the `witmproxy:plugin` world's interfaces to a [`wasmtime::component::Linker`].
pub fn add_to_linker<T: Send + 'static>(
    l: &mut wasmtime::component::Linker<T>,
    f: fn(&mut T) -> WitmProxy<'_>,
) -> Result<()> {
    bindgen::witmproxy::plugin::capabilities::add_to_linker::<_, HasWitmProxy>(l, f)?;
    Ok(())
}

struct HasWitmProxy;

impl HasData for HasWitmProxy {
    type Data<'a> = WitmProxy<'a>;
}
