mod bindings {
    wit_bindgen::generate!({
        world: "wasi:http/proxy",
        async: true,
        generate_all
    });

    use super::Component;
    export!(Component);
}

use bindings::exports::wasi::http::incoming_handler::Guest;
pub use bindings::wasi::http::types::{
    Fields, IncomingRequest, OutgoingBody, OutgoingResponse, ResponseOutparam,
};

struct Component;

impl Guest for Component {
    async fn handle(_request: IncomingRequest, outparam: ResponseOutparam) {
        let hdrs = Fields::new().await;
        let resp = OutgoingResponse::new(hdrs).await;
        let body = resp.body().await.expect("outgoing response");

        ResponseOutparam::set(outparam, Ok(resp)).await;

        let out = body.write().await.expect("outgoing stream");
        out.blocking_write_and_flush(b"Hello, wasi:http/proxy world!\n".to_vec())
            .await
            .expect("writing response");

        drop(out);
        OutgoingBody::finish(body, None).await.unwrap();
    }
}
