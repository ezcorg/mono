use std::collections::HashMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use wasmtime::component::{HasData, Resource, ResourceTable, StreamReader};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};

mod runtime;

use crate::wasm::generated::witmproxy::plugin::capabilities::{
    HostAnnotatorClient, HostCapabilityProvider, HostContent, HostLocalStorageClient, HostLogger,
};
pub use runtime::Runtime;

pub mod generated {

    pub use crate::wasm::generated::exports::witmproxy::plugin::witm_plugin::{
        EventData, PluginManifest,
    };
    pub use crate::wasm::{AnnotatorClient, CapabilityProvider, LocalStorageClient, Logger};

    wasmtime::component::bindgen!({
        world: "witmproxy:plugin/plugin",
        exports: { default: async | store | task_exit },
        with: {
            "witmproxy:plugin/capabilities.capability-provider": CapabilityProvider,
            "witmproxy:plugin/capabilities.annotator-client": AnnotatorClient,
            "witmproxy:plugin/capabilities.local-storage-client": LocalStorageClient,
            "witmproxy:plugin/capabilities.logger": Logger,
            "wasi:http/types@0.3.0-rc-2025-09-16": wasmtime_wasi_http::p3::bindings::http::types,
        },
    });
}

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
    pub fn annotate(&self, _content_type: String, _data: StreamReader<Vec<u8>>) {}
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
        self_: wasmtime::component::Resource<generated::witmproxy::plugin::capabilities::Content>,
    ) -> wasmtime::component::StreamReader<wasmtime::component::__internal::Vec<u8>> {
        todo!()
    }

    fn drop(
        &mut self,
        rep: wasmtime::component::Resource<generated::witmproxy::plugin::capabilities::Content>,
    ) -> wasmtime::Result<()> {
        let _ = self.table.delete(rep);
        Ok(())
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
        content_type: String,
        data: StreamReader<Vec<u8>>,
    ) {
        let annotator = self.table.get(&self_).unwrap();
        annotator.annotate(content_type, data)
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
impl generated::witmproxy::plugin::capabilities::Host for WitmProxy<'_> {}

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
    generated::witmproxy::plugin::capabilities::add_to_linker::<_, HasWitmProxy>(l, f)?;
    Ok(())
}

struct HasWitmProxy;

impl HasData for HasWitmProxy {
    type Data<'a> = WitmProxy<'a>;
}

// Implement Serialize and Deserialize for the generated Capability type
impl Serialize for generated::witmproxy::plugin::capabilities::Capability {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use generated::witmproxy::plugin::capabilities::Capability::*;
        match self {
            HandleEvent(event_selector) => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("handle-event", event_selector)?;
                map.end()
            }
            Logger => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("logger", &())?;
                map.end()
            }
            Annotator => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("annotator", &())?;
                map.end()
            }
            LocalStorage => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("local-storage", &())?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for generated::witmproxy::plugin::capabilities::Capability {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::{MapAccess, Visitor};
        use std::fmt;

        struct CapabilityVisitor;

        impl<'de> Visitor<'de> for CapabilityVisitor {
            type Value = generated::witmproxy::plugin::capabilities::Capability;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a capability variant")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                use generated::witmproxy::plugin::capabilities::Capability::*;
                use serde::de::Error;

                if let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "handle-event" => {
                            let event_selector = map.next_value()?;
                            Ok(HandleEvent(event_selector))
                        }
                        "logger" => {
                            let _: () = map.next_value()?;
                            Ok(Logger)
                        }
                        "annotator" => {
                            let _: () = map.next_value()?;
                            Ok(Annotator)
                        }
                        "local-storage" => {
                            let _: () = map.next_value()?;
                            Ok(LocalStorage)
                        }
                        _ => Err(A::Error::unknown_variant(
                            &key,
                            &["handle-event", "logger", "annotator", "local-storage"],
                        )),
                    }
                } else {
                    Err(A::Error::invalid_length(0, &"a non-empty map"))
                }
            }
        }

        deserializer.deserialize_map(CapabilityVisitor)
    }
}

// Implement Serialize and Deserialize for EventSelector
impl Serialize for generated::witmproxy::plugin::capabilities::EventSelector {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use generated::witmproxy::plugin::capabilities::EventSelector::*;
        match self {
            Connect(selector) => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("connect", selector)?;
                map.end()
            }
            Request(selector) => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("request", selector)?;
                map.end()
            }
            Response(selector) => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("response", selector)?;
                map.end()
            }
            InboundContent(selector) => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("inbound-content", selector)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for generated::witmproxy::plugin::capabilities::EventSelector {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::{MapAccess, Visitor};
        use std::fmt;

        struct EventSelectorVisitor;

        impl<'de> Visitor<'de> for EventSelectorVisitor {
            type Value = generated::witmproxy::plugin::capabilities::EventSelector;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("an event selector variant")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                use generated::witmproxy::plugin::capabilities::EventSelector::*;
                use serde::de::Error;

                if let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "connect" => {
                            let selector = map.next_value()?;
                            Ok(Connect(selector))
                        }
                        "request" => {
                            let selector = map.next_value()?;
                            Ok(Request(selector))
                        }
                        "response" => {
                            let selector = map.next_value()?;
                            Ok(Response(selector))
                        }
                        "inbound-content" => {
                            let selector = map.next_value()?;
                            Ok(InboundContent(selector))
                        }
                        _ => Err(A::Error::unknown_variant(
                            &key,
                            &["connect", "request", "response", "inbound-content"],
                        )),
                    }
                } else {
                    Err(A::Error::invalid_length(0, &"a non-empty map"))
                }
            }
        }

        deserializer.deserialize_map(EventSelectorVisitor)
    }
}

// Implement Serialize and Deserialize for Selector
impl Serialize for generated::witmproxy::plugin::capabilities::Selector {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("Selector", 1)?;
        state.serialize_field("expression", &self.expression)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for generated::witmproxy::plugin::capabilities::Selector {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::{MapAccess, Visitor};
        use std::fmt;

        #[derive(Deserialize)]
        #[serde(field_identifier, rename_all = "lowercase")]
        enum Field {
            Expression,
        }

        struct SelectorVisitor;

        impl<'de> Visitor<'de> for SelectorVisitor {
            type Value = generated::witmproxy::plugin::capabilities::Selector;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("struct Selector")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut expression = None;
                while let Some(key) = map.next_key()? {
                    match key {
                        Field::Expression => {
                            if expression.is_some() {
                                return Err(serde::de::Error::duplicate_field("expression"));
                            }
                            expression = Some(map.next_value()?);
                        }
                    }
                }
                let expression =
                    expression.ok_or_else(|| serde::de::Error::missing_field("expression"))?;
                Ok(generated::witmproxy::plugin::capabilities::Selector { expression })
            }
        }

        const FIELDS: &'static [&'static str] = &["expression"];
        deserializer.deserialize_struct("Selector", FIELDS, SelectorVisitor)
    }
}
