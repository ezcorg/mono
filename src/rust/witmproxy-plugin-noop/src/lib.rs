use crate::{
    exports::witmproxy::plugin::witm_plugin::{
        Capability, CapabilityProvider, Guest, PluginManifest,
    },
    witmproxy::plugin::capabilities::{
        EventData, EventSelector, Selector,
    },
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
                Capability::HandleEvent(EventSelector::Connect(
                    Selector {
                        expression: "true".to_string(),
                    }
                )),
                Capability::HandleEvent(EventSelector::Request(
                    Selector {
                        expression: "true".to_string(),
                    }
                )),
                Capability::HandleEvent(EventSelector::Response(
                    Selector {
                        expression: "true".to_string(),
                    }
                )),
            ],
            license: "MIT".to_string(),
            url: "https://example.com".to_string(),
            publickey: PUBLIC_KEY_BYTES.to_vec(),
        }
    }

    fn handle(ev: EventData, _cp: CapabilityProvider) -> Option<EventData> {
        Some(ev)
    }
}

export!(Plugin);
