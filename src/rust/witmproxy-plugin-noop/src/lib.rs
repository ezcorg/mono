use crate::{
    exports::witmproxy::plugin::witm_plugin::{
        Capability, CapabilityProvider, ConfigureError, Guest, GuestPlugin,
        Plugin as PluginResource, PluginManifest, UserInput,
    },
    witmproxy::plugin::capabilities::{CapabilityKind, CapabilityScope, Event, EventKind},
};

wit_bindgen::generate!({
    world: "witmproxy:plugin/plugin",
    generate_all
});

const PUBLIC_KEY_BYTES: &[u8] = include_bytes!("../key.public");

struct Component;

impl Guest for Component {
    type Plugin = PluginInstance;

    fn manifest() -> PluginManifest {
        PluginManifest {
            name: "noop".to_string(),
            namespace: "witmproxy".to_string(),
            author: "Theodore Brockman".to_string(),
            version: "0.0.0".to_string(),
            description: "an example plugin which does nothing".to_string(),
            metadata: vec![],
            capabilities: vec![
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Connect),
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Request),
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Response),
                    scope: CapabilityScope {
                        expression: "true".into(),
                    },
                },
            ],
            license: "MIT".to_string(),
            url: "https://example.com".to_string(),
            publickey: PUBLIC_KEY_BYTES.to_vec(),
            configuration: vec![],
        }
    }
}

struct PluginInstance;

impl GuestPlugin for PluginInstance {
    fn create(_config: Vec<UserInput>) -> Result<PluginResource, ConfigureError> {
        Ok(PluginResource::new(PluginInstance))
    }

    fn handle(&self, ev: Event, _cp: CapabilityProvider) -> Option<Event> {
        Some(ev)
    }
}

export!(Component);
