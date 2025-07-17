wit_bindgen::generate!({
    world: "simple-handler",
});

use wasi::http::types::*;

struct Component;

impl exports::wasi::http::incoming_handler::Guest for Component {
    fn handle(request: IncomingRequest, response_out: ResponseOutparam) {
        let response = OutgoingResponse::new(Fields::new());

        response.set_status_code(200).unwrap();

        let body = response.body().unwrap();
        response_out.set(Ok(response));

        let output_stream = body.write().unwrap();
        output_stream
            .blocking_write_and_flush(b"Hello from Simple WASM Handler!")
            .unwrap();
        drop(output_stream);

        OutgoingBody::finish(body, None).unwrap();
    }
}

export!(Component);
