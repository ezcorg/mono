use crate::exports::witmproxy::plugin::witm_plugin::{Capability, CapabilityProvider, EventData, EventResult, Guest, PluginManifest};
use crate::witmproxy::plugin::capabilities::{Selector, EventSelector};

wit_bindgen::generate!({
    world: "witmproxy:plugin/plugin",
    generate_all
});

const PUBLIC_KEY_BYTES: &[u8] = include_bytes!("../key.public");

struct Plugin;

impl Guest for Plugin {

    fn manifest() -> PluginManifest {
        PluginManifest {
            name: "witmproxy-plugin-noshorts".to_string(),
            namespace: "Theodore Brockman".to_string(),
            author: "Theodore Brockman".to_string(),
            version: "0.0.0".to_string(),
            description: "Blocks requests for YouTube shorts".to_string(),
            metadata: vec![],
            capabilities: vec![
                Capability::HandleEvent(EventSelector::Connect(Selector {
                    expression: "YouTube.com Request Handler".to_string(),
                })),
                Capability::HandleEvent(EventSelector::InboundHtml(Selector {
                    expression: "YouTube.com Request Handler".to_string(),
                })),
            ],
            license: "MIT".to_string(),
            url: "https://example.com".to_string(),
            publickey: PUBLIC_KEY_BYTES.to_vec(),
        }
    }

    fn handle(ev: EventData, cap: CapabilityProvider) -> Result<EventResult, ()> {
        Ok(EventResult::None)
    }
}

export!(Plugin);