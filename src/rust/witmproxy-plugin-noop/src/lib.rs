use crate::{exports::witmproxy::plugin::witm_plugin::{CapabilityProvider, Guest, HandleRequestResult, HandleResponseResult, PluginManifest, Request, Response}, witmproxy::plugin::capabilities::{Capabilities, ConnectCapability, RequestCapability, ResponseCapability}};

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
            capabilities: Capabilities {
                connect: ConnectCapability {
                    filter: "true".to_string(),
                },
                request: Some(RequestCapability {
                    filter: "true".to_string()
                }),
                response: Some(ResponseCapability {
                    filter: "true".to_string()
                }),
            },
            license: "MIT".to_string(),
            url: "https://example.com".to_string(),
            publickey: PUBLIC_KEY_BYTES.to_vec(),
        }
    }

    fn handle_request(req: Request, cap: CapabilityProvider) -> HandleRequestResult {
        HandleRequestResult::Next(req)
    }

    fn handle_response(res: Response, cap: CapabilityProvider) -> HandleResponseResult {
        HandleResponseResult::Next(res)
    }
}

export!(Plugin);