use crate::{
    exports::witmproxy::plugin::witm_plugin::{
        Capability, CapabilityProvider, Guest, PluginManifest
    },
    witmproxy::plugin::capabilities::{CapabilityKind, CapabilityScope, EventData, EventKind, Request, Response, ContextualResponse},
};

wit_bindgen::generate!({
    world: "witmproxy:plugin/plugin",
    path: "../../apps/witmproxy/wit",
    generate_all
});

const PUBLIC_KEY_BYTES: &[u8] = include_bytes!("../key.public");

struct Plugin;

impl Guest for Plugin {
    fn manifest() -> PluginManifest {
        PluginManifest {
            name: "wasm-test-component".to_string(),
            namespace: "ezco".to_string(),
            author: "theo".to_string(),
            version: "0.0.1".to_string(),
            description: "A test plugin".to_string(),
            metadata: vec![],
            capabilities: vec![
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Connect),
                    scope: CapabilityScope {
                        expression: "true".to_string(),
                    }
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Request),
                    scope: CapabilityScope {
                        expression: "request.host() != 'donotprocess.com' && !('skipthis' in request.headers() && 'true' in request.headers()['skipthis'])".to_string(),
                    }
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Response),
                    scope: CapabilityScope {
                        expression: "request.host() != 'donotprocess.com' && !('skipthis' in request.headers() && 'true' in request.headers()['skipthis'])".to_string(),
                    }
                },
            ],
            license: "MIT".to_string(),
            url: "https://example.com".to_string(),
            publickey: PUBLIC_KEY_BYTES.to_vec(),
        }
    }

    fn handle(ev: EventData, _cp: CapabilityProvider) -> Option<EventData> {
        match ev {
            EventData::Request(req) => {
                let authority = req.get_authority().clone();
                let path_with_query = req.get_path_with_query().clone();
                let scheme = req.get_scheme().clone();
                let headers = req.get_headers().clone();
                let val = "req".as_bytes().to_vec();
                let _ = headers.set("witmproxy", &[val]);
                let (_, result_rx) = wit_future::new(|| Ok(()));
                let (body, trailers) = Request::consume_body(req, result_rx);
                let (new_req, _) = Request::new(headers, Some(body), trailers, None);
                let _ = new_req.set_authority(authority.as_deref());
                let _ = new_req.set_path_with_query(path_with_query.as_deref());
                let _ = new_req.set_scheme(scheme.as_ref());
                Some(EventData::Request(new_req))
            }
            EventData::Response(ContextualResponse { response, request }) => {

                let headers = response.get_headers().clone();
                let val = "res".as_bytes().to_vec();
                let _ = headers.set("witmproxy", &[val]);
                let (_, result_rx) = wit_future::new(|| Ok(()));
                let (body, trailers) = Response::consume_body(response, result_rx);
                let (new_res, _) = Response::new(headers, Some(body), trailers);
                Some(EventData::Response(ContextualResponse { response: new_res, request }))
            }
            _ => {
                None
            }
        }
    }
}

export!(Plugin);
