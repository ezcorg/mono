pub use crate::events::content::InboundContent;
pub use crate::wasm::bindgen::exports::witmproxy::plugin::witm_plugin::{
    ActualInput, ConfigureError, Event, InputSchema, InputType, PluginManifest, UserInput,
};
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
        matches!(
            (self, other),
            (
                witmproxy::plugin::capabilities::EventKind::Connect,
                witmproxy::plugin::capabilities::EventKind::Connect,
            ) | (
                witmproxy::plugin::capabilities::EventKind::Request,
                witmproxy::plugin::capabilities::EventKind::Request,
            ) | (
                witmproxy::plugin::capabilities::EventKind::Response,
                witmproxy::plugin::capabilities::EventKind::Response,
            ) | (
                witmproxy::plugin::capabilities::EventKind::InboundContent,
                witmproxy::plugin::capabilities::EventKind::InboundContent,
            )
        )
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

// Serde implementations for witm-plugin configuration types

impl Serialize for exports::witmproxy::plugin::witm_plugin::InputType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use exports::witmproxy::plugin::witm_plugin::InputType;
        use serde::ser::SerializeMap;
        match self {
            InputType::Str => serializer.serialize_str("str"),
            InputType::Boolean => serializer.serialize_str("boolean"),
            InputType::Number => serializer.serialize_str("number"),
            InputType::Select(options) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("select", options)?;
                map.end()
            }
            InputType::Datetime => serializer.serialize_str("datetime"),
            InputType::Daterange => serializer.serialize_str("daterange"),
        }
    }
}

impl<'de> Deserialize<'de> for exports::witmproxy::plugin::witm_plugin::InputType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use exports::witmproxy::plugin::witm_plugin::InputType;
        use serde::de::{self, MapAccess, Visitor};
        use std::fmt;

        struct InputTypeVisitor;

        impl<'de> Visitor<'de> for InputTypeVisitor {
            type Value = InputType;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("variant InputType")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                match value {
                    "str" => Ok(InputType::Str),
                    "boolean" => Ok(InputType::Boolean),
                    "number" => Ok(InputType::Number),
                    "datetime" => Ok(InputType::Datetime),
                    "daterange" => Ok(InputType::Daterange),
                    _ => Err(de::Error::unknown_variant(
                        value,
                        &[
                            "str",
                            "boolean",
                            "number",
                            "select",
                            "datetime",
                            "daterange",
                        ],
                    )),
                }
            }

            fn visit_map<V>(self, mut map: V) -> Result<Self::Value, V::Error>
            where
                V: MapAccess<'de>,
            {
                let key: String = map
                    .next_key()?
                    .ok_or_else(|| de::Error::invalid_length(0, &self))?;
                match key.as_str() {
                    "select" => {
                        let options: Vec<String> = map.next_value()?;
                        Ok(InputType::Select(options))
                    }
                    _ => Err(de::Error::unknown_variant(
                        &key,
                        &[
                            "str",
                            "boolean",
                            "number",
                            "select",
                            "datetime",
                            "daterange",
                        ],
                    )),
                }
            }
        }

        deserializer.deserialize_any(InputTypeVisitor)
    }
}

impl Serialize for exports::witmproxy::plugin::witm_plugin::ActualInput {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use exports::witmproxy::plugin::witm_plugin::ActualInput;
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(1))?;
        match self {
            ActualInput::Str(v) => map.serialize_entry("str", v)?,
            ActualInput::Boolean(v) => map.serialize_entry("boolean", v)?,
            ActualInput::Number(v) => map.serialize_entry("number", v)?,
            ActualInput::Select(v) => map.serialize_entry("select", v)?,
            ActualInput::Datetime(v) => map.serialize_entry("datetime", v)?,
            ActualInput::Daterange(v) => map.serialize_entry("daterange", v)?,
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for exports::witmproxy::plugin::witm_plugin::ActualInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use exports::witmproxy::plugin::witm_plugin::ActualInput;
        use serde::de::{self, MapAccess, Visitor};
        use std::fmt;

        struct ActualInputVisitor;

        impl<'de> Visitor<'de> for ActualInputVisitor {
            type Value = ActualInput;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("variant ActualInput")
            }

            fn visit_map<V>(self, mut map: V) -> Result<Self::Value, V::Error>
            where
                V: MapAccess<'de>,
            {
                let key: String = map
                    .next_key()?
                    .ok_or_else(|| de::Error::invalid_length(0, &self))?;
                match key.as_str() {
                    "str" => Ok(ActualInput::Str(map.next_value()?)),
                    "boolean" => Ok(ActualInput::Boolean(map.next_value()?)),
                    "number" => Ok(ActualInput::Number(map.next_value()?)),
                    "select" => Ok(ActualInput::Select(map.next_value()?)),
                    "datetime" => Ok(ActualInput::Datetime(map.next_value()?)),
                    "daterange" => Ok(ActualInput::Daterange(map.next_value()?)),
                    _ => Err(de::Error::unknown_variant(
                        &key,
                        &[
                            "str",
                            "boolean",
                            "number",
                            "select",
                            "datetime",
                            "daterange",
                        ],
                    )),
                }
            }
        }

        deserializer.deserialize_map(ActualInputVisitor)
    }
}

impl Serialize for exports::witmproxy::plugin::witm_plugin::UserInput {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("UserInput", 2)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("value", &self.value)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for exports::witmproxy::plugin::witm_plugin::UserInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use exports::witmproxy::plugin::witm_plugin::{ActualInput, UserInput};
        use serde::de::{self, MapAccess, Visitor};
        use std::fmt;

        #[derive(Deserialize)]
        #[serde(field_identifier, rename_all = "lowercase")]
        enum Field {
            Name,
            Value,
        }

        struct UserInputVisitor;

        impl<'de> Visitor<'de> for UserInputVisitor {
            type Value = UserInput;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("struct UserInput")
            }

            fn visit_map<V>(self, mut map: V) -> Result<Self::Value, V::Error>
            where
                V: MapAccess<'de>,
            {
                let mut name: Option<String> = None;
                let mut value: Option<ActualInput> = None;
                while let Some(key) = map.next_key()? {
                    match key {
                        Field::Name => {
                            if name.is_some() {
                                return Err(de::Error::duplicate_field("name"));
                            }
                            name = Some(map.next_value()?);
                        }
                        Field::Value => {
                            if value.is_some() {
                                return Err(de::Error::duplicate_field("value"));
                            }
                            value = Some(map.next_value()?);
                        }
                    }
                }
                let name = name.ok_or_else(|| de::Error::missing_field("name"))?;
                let value = value.ok_or_else(|| de::Error::missing_field("value"))?;
                Ok(UserInput { name, value })
            }
        }

        const FIELDS: &[&str] = &["name", "value"];
        deserializer.deserialize_struct("UserInput", FIELDS, UserInputVisitor)
    }
}

impl Serialize for exports::witmproxy::plugin::witm_plugin::ConfigureError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use exports::witmproxy::plugin::witm_plugin::ConfigureError;
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(1))?;
        match self {
            ConfigureError::InvalidInputs(inputs) => {
                map.serialize_entry("invalid_inputs", inputs)?
            }
            ConfigureError::Other(msg) => map.serialize_entry("other", msg)?,
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for exports::witmproxy::plugin::witm_plugin::ConfigureError {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use exports::witmproxy::plugin::witm_plugin::ConfigureError;
        use serde::de::{self, MapAccess, Visitor};
        use std::fmt;

        struct ConfigureErrorVisitor;

        impl<'de> Visitor<'de> for ConfigureErrorVisitor {
            type Value = ConfigureError;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("variant ConfigureError")
            }

            fn visit_map<V>(self, mut map: V) -> Result<Self::Value, V::Error>
            where
                V: MapAccess<'de>,
            {
                let key: String = map
                    .next_key()?
                    .ok_or_else(|| de::Error::invalid_length(0, &self))?;
                match key.as_str() {
                    "invalid_inputs" => Ok(ConfigureError::InvalidInputs(map.next_value()?)),
                    "other" => Ok(ConfigureError::Other(map.next_value()?)),
                    _ => Err(de::Error::unknown_variant(
                        &key,
                        &["invalid_inputs", "other"],
                    )),
                }
            }
        }

        deserializer.deserialize_map(ConfigureErrorVisitor)
    }
}

impl Serialize for exports::witmproxy::plugin::witm_plugin::InputSchema {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("InputSchema", 5)?;
        state.serialize_field("name", &self.name)?;
        state.serialize_field("input_type", &self.input_type)?;
        state.serialize_field("optional", &self.optional)?;
        state.serialize_field("default", &self.default)?;
        state.serialize_field("description", &self.description)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for exports::witmproxy::plugin::witm_plugin::InputSchema {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use exports::witmproxy::plugin::witm_plugin::{ActualInput, InputSchema, InputType};
        use serde::de::{self, MapAccess, Visitor};
        use std::fmt;

        #[derive(Deserialize)]
        #[serde(field_identifier, rename_all = "lowercase")]
        enum Field {
            Name,
            #[serde(rename = "input_type")]
            InputType,
            Optional,
            Default,
            Description,
        }

        struct InputSchemaVisitor;

        impl<'de> Visitor<'de> for InputSchemaVisitor {
            type Value = InputSchema;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("struct InputSchema")
            }

            fn visit_map<V>(self, mut map: V) -> Result<Self::Value, V::Error>
            where
                V: MapAccess<'de>,
            {
                let mut name: Option<String> = None;
                let mut input_type: Option<InputType> = None;
                let mut optional: Option<bool> = None;
                let mut default: Option<Option<ActualInput>> = None;
                let mut description: Option<Option<String>> = None;
                while let Some(key) = map.next_key()? {
                    match key {
                        Field::Name => {
                            if name.is_some() {
                                return Err(de::Error::duplicate_field("name"));
                            }
                            name = Some(map.next_value()?);
                        }
                        Field::InputType => {
                            if input_type.is_some() {
                                return Err(de::Error::duplicate_field("input_type"));
                            }
                            input_type = Some(map.next_value()?);
                        }
                        Field::Optional => {
                            if optional.is_some() {
                                return Err(de::Error::duplicate_field("optional"));
                            }
                            optional = Some(map.next_value()?);
                        }
                        Field::Default => {
                            if default.is_some() {
                                return Err(de::Error::duplicate_field("default"));
                            }
                            default = Some(map.next_value()?);
                        }
                        Field::Description => {
                            if description.is_some() {
                                return Err(de::Error::duplicate_field("description"));
                            }
                            description = Some(map.next_value()?);
                        }
                    }
                }
                let name = name.ok_or_else(|| de::Error::missing_field("name"))?;
                let input_type =
                    input_type.ok_or_else(|| de::Error::missing_field("input_type"))?;
                let optional = optional.ok_or_else(|| de::Error::missing_field("optional"))?;
                let default = default.unwrap_or(None);
                let description = description.unwrap_or(None);
                Ok(InputSchema {
                    name,
                    input_type,
                    optional,
                    default,
                    description,
                })
            }
        }

        const FIELDS: &[&str] = &["name", "input_type", "optional", "default", "description"];
        deserializer.deserialize_struct("InputSchema", FIELDS, InputSchemaVisitor)
    }
}
