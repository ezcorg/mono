use anyhow::{Context, Result};
use wasmtime::component::{Accessor, TaskExit};
use wasmtime_wasi::{ResourceTable, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};

mod runtime;

pub use runtime::Runtime;

pub mod generated {
    pub use crate::wasm::{AnnotatorClient, CapabilityProvider};

    wasmtime::component::bindgen!({
        world: "host:plugin/plugin",
        exports: { default: async | store | task_exit },
        with: {
            "host:plugin/capabilities/capability-provider": CapabilityProvider,
            "host:plugin/capabilities/annotator-client": AnnotatorClient,
            "wasi:http/types@0.3.0-rc-2025-09-16": wasmtime_wasi_http::p3::bindings::http::types,
        }
    });
}

use crate::wasm::generated::host::plugin::capabilities::{HostAnnotatorClient, HostCapabilityProvider};
use crate::wasm::generated::Plugin;
use crate::wasm::generated::exports::host::plugin::event_handler::{HandleRequestResult};


pub struct CapabilityProvider {}

impl CapabilityProvider {
    pub fn new() -> Self {
        Self {}
    }
}

pub struct AnnotatorClient {}

impl AnnotatorClient {
    pub fn annotate(&self, _data: Vec<u8>) {}
}

/// Minimal WASI host state for each Store.
pub struct Host {
    pub table: ResourceTable,
    pub wasi: WasiCtx,
    pub http: WasiHttpCtx,
    pub p3_http: P3Ctx,
}

impl Default for Host {
    fn default() -> Self {
        Self {
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
            http: WasiHttpCtx::new(),
            p3_http: P3Ctx {},
        }
    }
}

// TODO: real implementation
impl HostAnnotatorClient for Host {
    fn annotate(&mut self, self_: wasmtime::component::Resource<AnnotatorClient>, data: Vec<u8>) {
        let annotator = self.table.get(&self_).unwrap();
        annotator.annotate(data)
    }

    fn drop(
        &mut self,
        rep: wasmtime::component::Resource<AnnotatorClient>,
    ) -> wasmtime::Result<()> {
        self.table.delete(rep);
        Ok(())
    }
}

// TODO: real implementation
impl HostCapabilityProvider for Host {
    fn new(&mut self) -> wasmtime::component::Resource<CapabilityProvider> {
        let provider = CapabilityProvider::new();
        self.table.push(provider).unwrap()
    }

    fn annotator(
        &mut self,
        _self_: wasmtime::component::Resource<CapabilityProvider>,
    ) -> Option<wasmtime::component::Resource<AnnotatorClient>> {
        // TODO: real implementation
        let client = AnnotatorClient {};
        Some(self.table.push(client).unwrap())
    }

    fn drop(
        &mut self,
        rep: wasmtime::component::Resource<CapabilityProvider>,
    ) -> wasmtime::Result<()> {
        self.table.delete(rep);
        Ok(())
    }
}

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

impl Plugin {
    pub async fn handle_request(
        &self,
        store: &Accessor<impl wasmtime_wasi_http::p3::WasiHttpView>,
        req: impl Into<wasmtime_wasi_http::p3::Request>,
    ) -> Result<(HandleRequestResult, TaskExit)> {
        // Push the incoming request into the p3 HTTP table and get a WIT handle
        let req = store.with(|mut store| {
            store
                .data_mut()
                .http()
                .table
                .push(req.into())
                .context("failed to push request to table")
        })?;

        // Allocate a CapabilityProvider in the component resource table
        let cap_res = store.with(|mut store| {
            let provider = CapabilityProvider::new();
            store.data_mut().http().table.push(provider)
        })?;

        // Invoke the component's handler with the event type, data, and capability provider resource
        self
            .host_plugin_event_handler()
            .call_handle_request(store, req, cap_res)
            .await
    }
}