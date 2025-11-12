use crate::{exports::witmproxy::plugin::witm_plugin::{
    Capabilities, CapabilityProvider, Guest, HandleRequestResult, HandleResponseResult, PluginManifest, Request, Response
}, witmproxy::plugin::capabilities::{ConnectCapability, RequestCapability, ResponseCapability}};

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
            capabilities: Capabilities {
                connect: ConnectCapability {
                    filter: "true".to_string(),
                },
                request: Some(RequestCapability {
                    filter: "request.host != 'donotprocess.com' && !('skipthis' in request.headers && 'true' in request.headers['skipthis'])".to_string()
                }),
                response: Some(ResponseCapability {
                    filter: "request.host != 'donotprocess.com' && !('skipthis' in request.headers && 'true' in request.headers['skipthis'])".to_string()
                }),
            },
            license: "MIT".to_string(),
            url: "https://example.com".to_string(),
            publickey: PUBLIC_KEY_BYTES.to_vec(),
        }
    }

    fn handle_request(req: Request, cap: CapabilityProvider) -> HandleRequestResult {
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
        HandleRequestResult::Next(new_req)
    }

    fn handle_response(res: Response, cap: CapabilityProvider) -> HandleResponseResult {
        let headers = res.get_headers().clone();
        let val = "res".as_bytes().to_vec();
        let _ = headers.set("witmproxy", &[val]);
        let (_, result_rx) = wit_future::new(|| Ok(()));
        let (body, trailers) = Response::consume_body(res, result_rx);
        let (new_res, _) = Response::new(headers, Some(body), trailers);
        HandleResponseResult::Next(new_res)
    }
}

export!(Plugin);
