use crate::exports::host::plugin::event_handler::{Guest, Request, Response, HandleRequestResult, HandleResponseResult, CapabilityProvider};

wit_bindgen::generate!({
    world: "host:plugin/plugin",
    path: "../witmproxy/wit",
    generate_all
});

struct Plugin;

impl Guest for Plugin {
    fn handle_request(req: Request, cap: CapabilityProvider) -> HandleRequestResult {
        let headers = req.get_headers();
        let val = "req".as_bytes().to_vec();
        headers.set("witmproxy", &[val]);
        HandleRequestResult::Next(req)
    }

    fn handle_response(res: Response, cap: CapabilityProvider) -> HandleResponseResult {
        let headers = res.get_headers();
        let val = "res".as_bytes().to_vec();
        headers.set("witmproxy", &[val]);
        HandleResponseResult::Next(res)
    }
}

export!(Plugin);