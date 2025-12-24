use crate::{
    exports::witmproxy::plugin::witm_plugin::{
        Capability, CapabilityProvider, Guest, PluginManifest,
    },
    witmproxy::plugin::capabilities::{CapabilityKind, CapabilityScope, Event, EventKind},
};

wit_bindgen::generate!({
    world: "witmproxy:plugin/plugin",
    generate_all
});

const PUBLIC_KEY_BYTES: &[u8] = include_bytes!("../key.public");

struct Plugin;

impl Guest for Plugin {
    fn manifest() -> PluginManifest {
        PluginManifest {
            name: "witmproxy-plugin-noop".to_string(),
            namespace: "Theodore Brockman".to_string(),
            author: "Theodore Brockman".to_string(),
            version: "0.0.0".to_string(),
            description: "noop".to_string(),
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
        }
    }

    fn handle(ev: Event, _cp: CapabilityProvider) -> Option<Event> {
        Some(ev)
    }
}

export!(Plugin);
