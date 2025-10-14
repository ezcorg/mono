use crate::{exports::host::plugin::event_handler::{CapabilityProvider, Guest, HandleRequestResult, HandleResponseResult, Request, Response}, wasi::http::types::Fields};

wit_bindgen::generate!({
    world: "host:plugin/plugin",
    path: "../witmproxy/wit",
    generate_all
});

struct Plugin;

impl Guest for Plugin {
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