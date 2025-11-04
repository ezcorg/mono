use std::collections::HashMap;

use wasmtime_wasi::{ResourceTable, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};

mod runtime;

use crate::wasm::generated::exports::witmproxy::plugin::witm_plugin::Tag;
use crate::{
    plugins::{CapabilitySet, WitmPlugin},
    wasm::generated::{
        witmproxy::plugin::capabilities::{
            HostAnnotatorClient, HostCapabilityProvider, HostLocalStorageClient,
        },
        PluginManifest,
    },
};
pub use runtime::Runtime;

pub mod generated {
    pub use crate::wasm::generated::exports::witmproxy::plugin::witm_plugin::PluginManifest;
    pub use crate::wasm::{AnnotatorClient, CapabilityProvider, LocalStorageClient};

    wasmtime::component::bindgen!({
        world: "witmproxy:plugin/plugin",
        exports: { default: async | store | task_exit },
        with: {
            "witmproxy:plugin/capabilities.capability-provider": CapabilityProvider,
            "witmproxy:plugin/capabilities.annotator-client": AnnotatorClient,
            "witmproxy:plugin/capabilities.local-storage-client": LocalStorageClient,
            "wasi:http/types@0.3.0-rc-2025-09-16": wasmtime_wasi_http::p3::bindings::http::types,
        }
    });
}

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

impl HostLocalStorageClient for Host {
    fn set(
        &mut self,
        self_: wasmtime::component::Resource<LocalStorageClient>,
        key: String,
        value: Vec<u8>,
    ) {
        let client = self.table.get_mut(&self_).unwrap();
        client.set(key, value);
    }

    fn get(
        &mut self,
        self_: wasmtime::component::Resource<LocalStorageClient>,
        key: String,
    ) -> Option<Vec<u8>> {
        let client = self.table.get(&self_).unwrap();
        client.get(key).cloned()
    }

    fn delete(&mut self, self_: wasmtime::component::Resource<LocalStorageClient>, key: String) {
        let client = self.table.get_mut(&self_).unwrap();
        client.delete(key);
    }

    fn drop(
        &mut self,
        rep: wasmtime::component::Resource<LocalStorageClient>,
    ) -> wasmtime::Result<()> {
        let _ = self.table.delete(rep);
        Ok(())
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
        let _ = self.table.delete(rep);
        Ok(())
    }
}

// TODO: real implementation
impl HostCapabilityProvider for Host {
    fn local_storage(
        &mut self,
        _self: wasmtime::component::Resource<CapabilityProvider>,
    ) -> Option<
        wasmtime::component::Resource<
            generated::witmproxy::plugin::capabilities::LocalStorageClient,
        >,
    > {
        let client = LocalStorageClient::default();
        Some(self.table.push(client).unwrap())
    }

    fn annotator(
        &mut self,
        _self: wasmtime::component::Resource<CapabilityProvider>,
    ) -> Option<wasmtime::component::Resource<AnnotatorClient>> {
        // TODO: real implementation
        let client = AnnotatorClient {};
        Some(self.table.push(client).unwrap())
    }

    fn drop(
        &mut self,
        rep: wasmtime::component::Resource<CapabilityProvider>,
    ) -> wasmtime::Result<()> {
        let _ = self.table.delete(rep);
        Ok(())
    }
}

// Implement the generated capabilities::Host trait
impl generated::witmproxy::plugin::capabilities::Host for Host {}

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

impl From<PluginManifest> for WitmPlugin {
    fn from(manifest: PluginManifest) -> Self {
        let metadata = manifest
            .metadata
            .iter()
            .cloned()
            .map(|Tag { key, value }| (key, value))
            .collect::<HashMap<String, String>>();

        WitmPlugin {
            namespace: manifest.namespace,
            name: manifest.name,
            version: manifest.version,
            author: manifest.author,
            description: manifest.description,
            license: manifest.license,
            url: manifest.url,
            publickey: manifest.publickey,
            enabled: true,
            granted: CapabilitySet::new(),
            requested: CapabilitySet::new(),
            component: None,
            component_bytes: vec![],
            metadata,
            cel_filter: None,
            cel_source: manifest.cel,
        }
    }
}
