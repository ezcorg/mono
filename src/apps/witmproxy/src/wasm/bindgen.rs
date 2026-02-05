pub use crate::events::content::InboundContent;
pub use crate::wasm::bindgen::exports::witmproxy::plugin::witm_plugin::{Event, PluginManifest};
pub use crate::wasm::{AnnotatorClient, CapabilityProvider, LocalStorageClient, Logger};

wasmtime::component::bindgen!({
    world: "witmproxy:plugin/plugin",
    exports: { default: async | store | task_exit },
    imports: {
        "witmproxy:plugin/capabilities": async | store | trappable | tracing,
        default: trappable | tracing,
    },
    with: {
        "witmproxy:plugin/capabilities.capability-provider": CapabilityProvider,
        "witmproxy:plugin/capabilities.annotator-client": AnnotatorClient,
        "witmproxy:plugin/capabilities.local-storage-client": LocalStorageClient,
        "witmproxy:plugin/capabilities.logger": Logger,
        "witmproxy:plugin/capabilities.content": InboundContent,
        "wasi:http/types@0.3.0-rc-2026-01-06": wasmtime_wasi_http::p3::bindings::http::types,
    },
});

// Manual serde implementations for generated types
use serde::{Deserialize, Serialize};

impl Serialize for witmproxy::plugin::capabilities::Capability {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("Capability", 2)?;
        state.serialize_field("kind", &self.kind)?;
        state.serialize_field("scope", &self.scope)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for witmproxy::plugin::capabilities::Capability {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::{self, MapAccess, SeqAccess, Visitor};
        use std::fmt;

        #[derive(Deserialize)]
        #[serde(field_identifier, rename_all = "lowercase")]
        enum Field {
            Kind,
            Scope,
        }

        struct CapabilityVisitor;

        impl<'de> Visitor<'de> for CapabilityVisitor {
            type Value = witmproxy::plugin::capabilities::Capability;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("struct Capability")
            }

            fn visit_seq<V>(self, mut seq: V) -> Result<Self::Value, V::Error>
            where
                V: SeqAccess<'de>,
            {
                let kind = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(0, &self))?;
                let scope = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(1, &self))?;
                Ok(witmproxy::plugin::capabilities::Capability { kind, scope })
            }

            fn visit_map<V>(self, mut map: V) -> Result<Self::Value, V::Error>
            where
                V: MapAccess<'de>,
            {
                let mut kind = None;
                let mut scope = None;
                while let Some(key) = map.next_key()? {
                    match key {
                        Field::Kind => {
                            if kind.is_some() {
                                return Err(de::Error::duplicate_field("kind"));
                            }
                            kind = Some(map.next_value()?);
                        }
                        Field::Scope => {
                            if scope.is_some() {
                                return Err(de::Error::duplicate_field("scope"));
                            }
                            scope = Some(map.next_value()?);
                        }
                    }
                }
                let kind = kind.ok_or_else(|| de::Error::missing_field("kind"))?;
                let scope = scope.ok_or_else(|| de::Error::missing_field("scope"))?;
                Ok(witmproxy::plugin::capabilities::Capability { kind, scope })
            }
        }

        const FIELDS: &[&str] = &["kind", "scope"];
        deserializer.deserialize_struct("Capability", FIELDS, CapabilityVisitor)
    }
}

impl Serialize for witmproxy::plugin::capabilities::CapabilityScope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("CapabilityScope", 1)?;
        state.serialize_field("expression", &self.expression)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for witmproxy::plugin::capabilities::CapabilityScope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::{self, MapAccess, SeqAccess, Visitor};
        use std::fmt;

        #[derive(Deserialize)]
        #[serde(field_identifier, rename_all = "lowercase")]
        enum Field {
            Expression,
        }

        struct CapabilityScopeVisitor;

        impl<'de> Visitor<'de> for CapabilityScopeVisitor {
            type Value = witmproxy::plugin::capabilities::CapabilityScope;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("struct CapabilityScope")
            }

            fn visit_seq<V>(self, mut seq: V) -> Result<Self::Value, V::Error>
            where
                V: SeqAccess<'de>,
            {
                let expression = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::invalid_length(0, &self))?;
                Ok(witmproxy::plugin::capabilities::CapabilityScope { expression })
            }

            fn visit_map<V>(self, mut map: V) -> Result<Self::Value, V::Error>
            where
                V: MapAccess<'de>,
            {
                let mut expression = None;
                while let Some(key) = map.next_key()? {
                    match key {
                        Field::Expression => {
                            if expression.is_some() {
                                return Err(de::Error::duplicate_field("expression"));
                            }
                            expression = Some(map.next_value()?);
                        }
                    }
                }
                let expression =
                    expression.ok_or_else(|| de::Error::missing_field("expression"))?;
                Ok(witmproxy::plugin::capabilities::CapabilityScope { expression })
            }
        }

        const FIELDS: &[&str] = &["expression"];
        deserializer.deserialize_struct("CapabilityScope", FIELDS, CapabilityScopeVisitor)
    }
}

impl Serialize for witmproxy::plugin::capabilities::CapabilityKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            witmproxy::plugin::capabilities::CapabilityKind::HandleEvent(event) => {
                let s = format!("handle_event_{}", event.as_str());
                serializer.serialize_str(&s)
            }
            witmproxy::plugin::capabilities::CapabilityKind::Logger => {
                serializer.serialize_str("logger")
            }
            witmproxy::plugin::capabilities::CapabilityKind::Annotator => {
                serializer.serialize_str("annotator")
            }
            witmproxy::plugin::capabilities::CapabilityKind::LocalStorage => {
                serializer.serialize_str("local_storage")
            }
        }
    }
}

impl<'de> Deserialize<'de> for witmproxy::plugin::capabilities::CapabilityKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::{self, MapAccess, Visitor};
        use std::fmt;

        struct CapabilityKindVisitor;

        impl<'de> Visitor<'de> for CapabilityKindVisitor {
            type Value = witmproxy::plugin::capabilities::CapabilityKind;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("variant CapabilityKind")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                match value {
                    "logger" => Ok(witmproxy::plugin::capabilities::CapabilityKind::Logger),
                    "annotator" => Ok(witmproxy::plugin::capabilities::CapabilityKind::Annotator),
                    "local_storage" => {
                        Ok(witmproxy::plugin::capabilities::CapabilityKind::LocalStorage)
                    }

                    // New flat snake_case event handlers
                    "handle_event_connect" => Ok(
                        witmproxy::plugin::capabilities::CapabilityKind::HandleEvent(
                            witmproxy::plugin::capabilities::EventKind::Connect,
                        ),
                    ),
                    "handle_event_request" => Ok(
                        witmproxy::plugin::capabilities::CapabilityKind::HandleEvent(
                            witmproxy::plugin::capabilities::EventKind::Request,
                        ),
                    ),
                    "handle_event_response" => Ok(
                        witmproxy::plugin::capabilities::CapabilityKind::HandleEvent(
                            witmproxy::plugin::capabilities::EventKind::Response,
                        ),
                    ),
                    "handle_event_inbound_content" => Ok(
                        witmproxy::plugin::capabilities::CapabilityKind::HandleEvent(
                            witmproxy::plugin::capabilities::EventKind::InboundContent,
                        ),
                    ),

                    _ => Err(de::Error::unknown_variant(
                        value,
                        &[
                            "logger",
                            "annotator",
                            "local_storage",
                            "handle_event_connect",
                            "handle_event_request",
                            "handle_event_response",
                            "handle_event_inbound_content",
                        ],
                    )),
                }
            }

            fn visit_map<V>(self, _map: V) -> Result<Self::Value, V::Error>
            where
                V: MapAccess<'de>,
            {
                // Map-based input is deprecated and now treated as an unknown variant
                Err(de::Error::unknown_variant(
                    "map",
                    &[
                        "logger",
                        "annotator",
                        "local_storage",
                        "handle_event_connect",
                        "handle_event_request",
                        "handle_event_response",
                        "handle_event_inbound_content",
                    ],
                ))
            }
        }

        deserializer.deserialize_any(CapabilityKindVisitor)
    }
}

impl Serialize for witmproxy::plugin::capabilities::EventKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            witmproxy::plugin::capabilities::EventKind::Connect => {
                serializer.serialize_str("connect")
            }
            witmproxy::plugin::capabilities::EventKind::Request => {
                serializer.serialize_str("request")
            }
            witmproxy::plugin::capabilities::EventKind::Response => {
                serializer.serialize_str("response")
            }
            witmproxy::plugin::capabilities::EventKind::InboundContent => {
                serializer.serialize_str("inbound_content")
            }
        }
    }
}

impl<'de> Deserialize<'de> for witmproxy::plugin::capabilities::EventKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::{self, Visitor};
        use std::fmt;

        struct EventKindVisitor;

        impl<'de> Visitor<'de> for EventKindVisitor {
            type Value = witmproxy::plugin::capabilities::EventKind;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("variant EventKind")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                match value {
                    "connect" => Ok(witmproxy::plugin::capabilities::EventKind::Connect),
                    "request" => Ok(witmproxy::plugin::capabilities::EventKind::Request),
                    "response" => Ok(witmproxy::plugin::capabilities::EventKind::Response),
                    "inbound_content" => {
                        Ok(witmproxy::plugin::capabilities::EventKind::InboundContent)
                    }
                    _ => Err(de::Error::unknown_variant(
                        value,
                        &["connect", "request", "response", "inbound_content"],
                    )),
                }
            }
        }

        deserializer.deserialize_str(EventKindVisitor)
    }
}

// Added helper for unified snake_case serialization
impl witmproxy::plugin::capabilities::EventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            witmproxy::plugin::capabilities::EventKind::Connect => "connect",
            witmproxy::plugin::capabilities::EventKind::Request => "request",
            witmproxy::plugin::capabilities::EventKind::Response => "response",
            witmproxy::plugin::capabilities::EventKind::InboundContent => "inbound_content",
        }
    }
}

impl PartialEq for witmproxy::plugin::capabilities::EventKind {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (
                witmproxy::plugin::capabilities::EventKind::Connect,
                witmproxy::plugin::capabilities::EventKind::Connect,
            ) => true,
            (
                witmproxy::plugin::capabilities::EventKind::Request,
                witmproxy::plugin::capabilities::EventKind::Request,
            ) => true,
            (
                witmproxy::plugin::capabilities::EventKind::Response,
                witmproxy::plugin::capabilities::EventKind::Response,
            ) => true,
            (
                witmproxy::plugin::capabilities::EventKind::InboundContent,
                witmproxy::plugin::capabilities::EventKind::InboundContent,
            ) => true,
            _ => false,
        }
    }
}

impl PartialEq for witmproxy::plugin::capabilities::CapabilityKind {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (
                witmproxy::plugin::capabilities::CapabilityKind::HandleEvent(e1),
                witmproxy::plugin::capabilities::CapabilityKind::HandleEvent(e2),
            ) => e1 == e2,
            (
                witmproxy::plugin::capabilities::CapabilityKind::Logger,
                witmproxy::plugin::capabilities::CapabilityKind::Logger,
            ) => true,
            (
                witmproxy::plugin::capabilities::CapabilityKind::Annotator,
                witmproxy::plugin::capabilities::CapabilityKind::Annotator,
            ) => true,
            (
                witmproxy::plugin::capabilities::CapabilityKind::LocalStorage,
                witmproxy::plugin::capabilities::CapabilityKind::LocalStorage,
            ) => true,
            _ => false,
        }
    }
}
