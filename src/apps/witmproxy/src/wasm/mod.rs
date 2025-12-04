use std::collections::HashMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use wasmtime::component::{HasData, Resource, ResourceTable};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};

mod runtime;

use crate::wasm::bindgen::witmproxy::plugin::capabilities::{HostAnnotatorClient, HostCapabilityProvider, HostContent, HostLocalStorageClient, HostLogger
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
    pub fn annotate(&self, content: &Content) {}
}

pub struct Content {}

impl Content {
    pub fn body(&self) -> Vec<u8> {
        vec![]
    }

    pub fn content_type(&self) -> String {
        "text/plain; charset=utf-8".to_string()
    }

    pub fn text(&self) -> String {
        String::from_utf8(self.body()).unwrap_or_default()
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

impl HostContent for WitmProxy<'_> {

    fn body(
        &mut self,
        self_: wasmtime::component::Resource<bindgen::witmproxy::plugin::capabilities::Content>,
    ) -> wasmtime::component::StreamReader<wasmtime::component::__internal::Vec<u8>> {
        todo!()
    }

    fn drop(
        &mut self,
        rep: wasmtime::component::Resource<bindgen::witmproxy::plugin::capabilities::Content>,
    ) -> wasmtime::Result<()> {
        let _ = self.table.delete(rep);
        Ok(())
    }
    
    #[doc = " Returns the content as a stream of UTF-8 encoded text"]
    fn text(&mut self,self_:wasmtime::component::Resource<Content>,) -> wasmtime::component::StreamReader<wasmtime::component::__internal::String> {
        todo!()
    }
    
    #[doc = " Returns the content type of the content, ex: \"text/html; charset=utf-8\""]
    fn content_type(&mut self,self_:wasmtime::component::Resource<Content>,) -> wasmtime::component::__internal::String {
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
    fn annotate(
        &mut self,
        self_: Resource<AnnotatorClient>,
        content: Resource<Content>,
    ) {
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
