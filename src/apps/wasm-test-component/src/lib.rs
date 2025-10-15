use crate::{exports::host::plugin::witm_plugin::{CapabilityProvider, Guest, HandleRequestResult, HandleResponseResult, Request, Response, PluginManifest}};

wit_bindgen::generate!({
    world: "host:plugin/plugin",
    path: "../witmproxy/wit",
    generate_all
});

struct Plugin;

impl Guest for Plugin {
    fn manifest() -> PluginManifest {
        PluginManifest {
            name: "wasm-test-component".to_string(),
            version: "0.0.1".to_string(),
            description: "A test plugin".to_string(),
            metadata: vec![],
            capabilities: vec![
                "request".to_string(),
                "response".to_string(),
            ],
            cel: "request.host != 'donotprocess.com' && !('skipthis' in request.headers && 'true' in request.headers['skipthis'])".to_string(),
            license: "MIT".to_string(),
            url: "https://example.com".to_string(),
            publickey: "todo".to_string(),
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