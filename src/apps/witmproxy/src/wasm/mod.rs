use std::collections::HashMap;
use std::io::Cursor;
use std::pin::Pin;
use std::task::{Context, Poll};

use anyhow::Result;
use bytes::Bytes;
use http_body::Body as _;
use http_body_util::BodyExt;
use http_body_util::combinators::UnsyncBoxBody;
use tokio::sync::mpsc;
use tokio_util::sync::PollSender;
use wasmtime::AsContextMut;
use wasmtime::StoreContextMut;
use wasmtime::component::{
    Accessor, Destination, HasData, Resource, ResourceTable, Source, StreamProducer, StreamReader,
    StreamResult,
};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::p3::bindings::http::types::ErrorCode;
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};

mod runtime;

use crate::events::content::InboundContent;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::{
    HostAnnotatorClient, HostAnnotatorClientWithStore, HostCapabilityProvider,
    HostCapabilityProviderWithStore, HostContent, HostContentWithStore, HostLocalStorageClient,
    HostLocalStorageClientWithStore, HostLogger, HostLoggerWithStore,
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
    pub fn annotate(&self, _content: &InboundContent) {}
}

/// Custom StreamProducer for body streaming
pub struct BodyStreamProducer {
    body: UnsyncBoxBody<Bytes, ErrorCode>,
}

impl BodyStreamProducer {
    pub fn new(body: UnsyncBoxBody<Bytes, ErrorCode>) -> Self {
        Self { body }
    }
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
        finish: bool,
    ) -> Poll<wasmtime::Result<StreamResult>> {
        use core::num::NonZeroUsize;

        let cap = match dst.remaining(&mut store).map(NonZeroUsize::new) {
            Some(Some(cap)) => Some(cap),
            Some(None) => {
                // On 0-length the best we can do is check that underlying stream has not
                // reached the end yet
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
                match frame.into_data().map_err(http_body::Frame::into_trailers) {
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
                    Err(Ok(_trailers)) => {
                        // Trailers received - we're done with body data
                        // Note: In a full implementation, trailers would be stored in the resource table
                        // For now, we just signal completion
                        Poll::Ready(Ok(StreamResult::Dropped))
                    }
                    Err(Err(..)) => {
                        // Frame is neither data nor trailers - protocol error
                        Poll::Ready(Ok(StreamResult::Dropped))
                    }
                }
            }
            Poll::Ready(Some(Err(_err))) => Poll::Ready(Ok(StreamResult::Dropped)),
            Poll::Ready(None) => Poll::Ready(Ok(StreamResult::Dropped)),
            Poll::Pending if finish => Poll::Ready(Ok(StreamResult::Cancelled)),
            Poll::Pending => Poll::Pending,
        }
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
pub struct WitmProxyCtxView<'a> {
    _ctx: &'a WitmProxyCtx,
    pub table: &'a mut ResourceTable,
}

impl<'a> WitmProxyCtxView<'a> {
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

impl HostContentWithStore for WitmProxy {
    async fn drop<T>(
        accessor: &Accessor<T, Self>,
        rep: wasmtime::component::Resource<InboundContent>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            state.table.delete(rep)
        })?;
        Ok(())
    }

    async fn content_type<T>(
        accessor: &Accessor<T, Self>,
        self_: wasmtime::component::Resource<InboundContent>,
    ) -> wasmtime::Result<String> {
        let content_type = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let content = state.table.get(&self_)?;
            Ok::<String, wasmtime::component::ResourceTableError>(content.content_type())
        })?;
        Ok(content_type)
    }

    async fn body<T>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        self_: wasmtime::component::Resource<InboundContent>,
    ) -> wasmtime::Result<wasmtime::component::StreamReader<u8>> {
        // Get mutable access to extract the data without consuming the resource
        let data = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let content = state.table.get_mut(&self_)?;
            // Take the data out, leaving None in its place
            // body() returns Result<Option<...>, Error> but we can unwrap the Result part
            Ok::<Option<UnsyncBoxBody<Bytes, ErrorCode>>, wasmtime::component::ResourceTableError>(
                content.body().unwrap_or(None),
            )
        })?;

        // If data is None, it was already taken
        let body = data.ok_or_else(|| {
            wasmtime::Error::msg(
                "Content data has already been consumed. Use set_data to refill it.",
            )
        })?;

        let reader = accessor.with(|mut access| {
            let store = &mut access.as_context_mut();
            let stream_reader = StreamReader::new(store, BodyStreamProducer::new(body));
            Ok::<wasmtime::component::StreamReader<u8>, wasmtime::component::ResourceTableError>(
                stream_reader,
            )
        })?;
        Ok(reader)
    }

    async fn set_body<T>(
        accessor: &wasmtime::component::Accessor<T, Self>,
        self_: wasmtime::component::Resource<InboundContent>,
        content: wasmtime::component::StreamReader<u8>,
    ) -> wasmtime::Result<()> {
        // Convert StreamReader back to UnsyncBoxBody
        // This requires reading the stream and converting it to a body
        // using a channel-based approach

        use http_body::Frame;
        use http_body_util::StreamBody;

        let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, ErrorCode>>(65536);
        let body = StreamBody::new(tokio_stream::wrappers::ReceiverStream::new(rx)).boxed_unsync();

        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let content = state.table.get_mut(&self_)?;
            content.set_body(body);
            Ok::<(), wasmtime::component::ResourceTableError>(())
        })?;

        // Create a StreamConsumer that forwards data to the channel
        struct ChannelStreamConsumer {
            tx: PollSender<Result<Frame<Bytes>, ErrorCode>>,
        }

        impl<D> wasmtime::component::StreamConsumer<D> for ChannelStreamConsumer {
            type Item = u8;

            fn poll_consume(
                mut self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                store: StoreContextMut<D>,
                source: Source<Self::Item>,
                finish: bool,
            ) -> Poll<wasmtime::Result<StreamResult>> {
                // First check if channel is ready to receive data
                match self.tx.poll_reserve(cx) {
                    Poll::Ready(Ok(())) => {
                        // Channel is ready, read from source
                        let mut src = source.as_direct(store);
                        let buf = src.remaining();
                        let n = buf.len();

                        // Only send frame if there's data
                        if n > 0 {
                            let buf = Bytes::copy_from_slice(buf);
                            match self.tx.send_item(Ok(Frame::data(buf))) {
                                Ok(()) => {
                                    src.mark_read(n);
                                    Poll::Ready(Ok(StreamResult::Completed))
                                }
                                Err(..) => {
                                    // Receiver dropped
                                    Poll::Ready(Ok(StreamResult::Dropped))
                                }
                            }
                        } else {
                            // No data available, signal completion
                            Poll::Ready(Ok(StreamResult::Completed))
                        }
                    }
                    Poll::Ready(Err(..)) => {
                        // Channel closed
                        Poll::Ready(Ok(StreamResult::Dropped))
                    }
                    Poll::Pending if finish => {
                        // Stream is finishing but channel not ready
                        Poll::Ready(Ok(StreamResult::Cancelled))
                    }
                    Poll::Pending => Poll::Pending,
                }
            }
        }

        // Pipe the stream reader to the channel consumer
        accessor.with(|mut access| {
            content.pipe(
                &mut access,
                ChannelStreamConsumer {
                    tx: PollSender::new(tx),
                },
            );
        });

        Ok(())
    }
}

// Implement the Host traits using the accessor pattern
impl HostLocalStorageClientWithStore for WitmProxy {
    async fn set<T>(
        accessor: &Accessor<T, Self>,
        self_: Resource<LocalStorageClient>,
        key: String,
        value: Vec<u8>,
    ) -> wasmtime::Result<()> {
        let _ = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let client = state.table.get_mut(&self_)?;
            client.set(key, value);
            Ok::<(), wasmtime::component::ResourceTableError>(())
        })?;
        Ok(())
    }

    async fn get<T>(
        accessor: &Accessor<T, Self>,
        self_: Resource<LocalStorageClient>,
        key: String,
    ) -> wasmtime::Result<Option<Vec<u8>>> {
        Ok(accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let client = state.table.get(&self_)?;
            Ok::<Option<Vec<u8>>, wasmtime::component::ResourceTableError>(client.get(key).cloned())
        })?)
    }

    async fn delete<T>(
        accessor: &Accessor<T, Self>,
        self_: Resource<LocalStorageClient>,
        key: String,
    ) -> wasmtime::Result<()> {
        let _ = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let client = state.table.get_mut(&self_)?;
            client.delete(key);
            Ok::<(), wasmtime::component::ResourceTableError>(())
        })?;
        Ok(())
    }

    async fn drop<T>(
        accessor: &Accessor<T, Self>,
        rep: Resource<LocalStorageClient>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            state.table.delete(rep)
        })?;
        Ok(())
    }
}

impl HostAnnotatorClientWithStore for WitmProxy {
    async fn annotate<T>(
        accessor: &Accessor<T, Self>,
        self_: Resource<AnnotatorClient>,
        content: Resource<InboundContent>,
    ) -> wasmtime::Result<()> {
        let _ = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let annotator = state.table.get(&self_)?;
            let content = state.table.get(&content)?;
            annotator.annotate(content);
            Ok::<(), wasmtime::component::ResourceTableError>(())
        });
        Ok(())
    }

    async fn drop<T>(
        accessor: &Accessor<T, Self>,
        rep: Resource<AnnotatorClient>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            state.table.delete(rep)
        })?;
        Ok(())
    }
}

impl HostLoggerWithStore for WitmProxy {
    async fn info<T>(
        accessor: &Accessor<T, Self>,
        self_: Resource<Logger>,
        message: String,
    ) -> wasmtime::Result<()> {
        let _ = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let logger = state.table.get(&self_)?;
            logger.info(message);
            Ok::<(), wasmtime::component::ResourceTableError>(())
        });
        Ok(())
    }

    async fn warn<T>(
        accessor: &Accessor<T, Self>,
        self_: Resource<Logger>,
        message: String,
    ) -> wasmtime::Result<()> {
        let _ = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let logger = state.table.get(&self_)?;
            logger.warn(message);
            Ok::<(), wasmtime::component::ResourceTableError>(())
        })?;
        Ok(())
    }

    async fn error<T>(
        accessor: &Accessor<T, Self>,
        self_: Resource<Logger>,
        message: String,
    ) -> wasmtime::Result<()> {
        let _ = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let logger = state.table.get(&self_)?;
            logger.error(message);
            Ok::<(), wasmtime::component::ResourceTableError>(())
        })?;
        Ok(())
    }

    async fn debug<T>(
        accessor: &Accessor<T, Self>,
        self_: Resource<Logger>,
        message: String,
    ) -> wasmtime::Result<()> {
        let _ = accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            let logger = state.table.get(&self_)?;
            logger.debug(message);
            Ok::<(), wasmtime::component::ResourceTableError>(())
        })?;
        Ok(())
    }

    async fn drop<T>(accessor: &Accessor<T, Self>, rep: Resource<Logger>) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            state.table.delete(rep)
        })?;
        Ok(())
    }
}

impl HostCapabilityProviderWithStore for WitmProxy {
    async fn logger<T>(
        accessor: &Accessor<T, Self>,
        _cap: Resource<CapabilityProvider>,
    ) -> wasmtime::Result<Option<Resource<Logger>>> {
        Ok(accessor
            .with(|mut access| {
                let state: &mut WitmProxyCtxView = &mut access.get();
                let logger = Logger {};
                Ok::<Option<Resource<Logger>>, wasmtime::component::ResourceTableError>(Some(
                    state.table.push(logger)?,
                ))
            })
            .unwrap_or(None))
    }

    async fn local_storage<T>(
        accessor: &Accessor<T, Self>,
        _cap: Resource<CapabilityProvider>,
    ) -> wasmtime::Result<Option<Resource<LocalStorageClient>>> {
        Ok(accessor
            .with(|mut access| {
                let state: &mut WitmProxyCtxView = &mut access.get();
                let client = LocalStorageClient::default();
                Ok::<Option<Resource<LocalStorageClient>>, wasmtime::component::ResourceTableError>(
                    Some(state.table.push(client)?),
                )
            })
            .unwrap_or(None))
    }

    async fn annotator<T>(
        accessor: &Accessor<T, Self>,
        _cap: Resource<CapabilityProvider>,
    ) -> wasmtime::Result<Option<Resource<AnnotatorClient>>> {
        Ok(accessor
            .with(|mut access| {
                let state: &mut WitmProxyCtxView = &mut access.get();
                let client = AnnotatorClient {};
                Ok::<Option<Resource<AnnotatorClient>>, wasmtime::component::ResourceTableError>(
                    Some(state.table.push(client)?),
                )
            })
            .unwrap_or(None))
    }

    async fn drop<T>(
        accessor: &Accessor<T, Self>,
        rep: Resource<CapabilityProvider>,
    ) -> wasmtime::Result<()> {
        accessor.with(|mut access| {
            let state: &mut WitmProxyCtxView = &mut access.get();
            state.table.delete(rep)
        })?;
        Ok(())
    }
}

// Implement the generated capabilities::Host trait
impl bindgen::witmproxy::plugin::capabilities::Host for WitmProxyCtxView<'_> {}

// Implement the non-WithStore traits for WitmProxyCtxView
impl HostContent for WitmProxyCtxView<'_> {}
impl HostCapabilityProvider for WitmProxyCtxView<'_> {}
impl HostLocalStorageClient for WitmProxyCtxView<'_> {}
impl HostAnnotatorClient for WitmProxyCtxView<'_> {}
impl HostLogger for WitmProxyCtxView<'_> {}

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
    f: fn(&mut T) -> WitmProxyCtxView<'_>,
) -> Result<()> {
    bindgen::witmproxy::plugin::capabilities::add_to_linker::<_, WitmProxy>(l, f)?;
    Ok(())
}

struct WitmProxy;

impl HasData for WitmProxy {
    type Data<'a> = WitmProxyCtxView<'a>;
}
