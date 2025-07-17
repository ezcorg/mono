#[allow(warnings)]
mod bindings;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::*;

struct Component;

impl Guest for Component {
    fn handle(request: IncomingRequest, response_out: ResponseOutparam) {
        // Get request details
        let method = request.method();
        let uri = request.path_with_query().unwrap_or("/".to_string());
        let headers = request.headers();

        // Read request body if present
        let request_body = match request.consume() {
            Ok(body) => {
                let input_stream = body.stream().unwrap();
                let mut body_content = Vec::new();

                // Read the body in chunks
                loop {
                    match input_stream.read(8192) {
                        Ok(chunk) => {
                            if chunk.is_empty() {
                                break;
                            }
                            body_content.extend_from_slice(&chunk);
                        }
                        Err(_) => break,
                    }
                }

                String::from_utf8_lossy(&body_content).to_string()
            }
            Err(_) => "".to_string(),
        };

        // Create response
        let response = OutgoingResponse::new(Fields::new());
        response.set_status_code(200).unwrap();

        // Set content type header
        let response_headers = response.headers();
        response_headers
            .set(&"content-type".to_string(), &[b"application/json".to_vec()])
            .unwrap();

        let response_body = response.body().unwrap();
        response_out.set(Ok(response));

        // Create echo response with request details
        let echo_response = format!(
            r#"{{
  "echo": {{
    "method": "{}",
    "uri": "{}",
    "headers": {{{}}},
    "body": "{}"
  }},
  "message": "Hello from Echo Handler WASM Component!"
}}"#,
            method_to_string(&method),
            uri,
            format_headers(&headers),
            request_body.replace('"', r#"\""#)
        );

        let output_stream = response_body.write().unwrap();
        output_stream
            .blocking_write_and_flush(echo_response.as_bytes())
            .unwrap();
        drop(output_stream);

        OutgoingBody::finish(response_body, None).unwrap();
    }
}

fn method_to_string(method: &Method) -> &str {
    match method {
        Method::Get => "GET",
        Method::Head => "HEAD",
        Method::Post => "POST",
        Method::Put => "PUT",
        Method::Delete => "DELETE",
        Method::Connect => "CONNECT",
        Method::Options => "OPTIONS",
        Method::Trace => "TRACE",
        Method::Patch => "PATCH",
        Method::Other(s) => s,
    }
}

fn format_headers(headers: &Fields) -> String {
    let mut header_strings = Vec::new();

    for name in headers.entries() {
        if let Ok(values) = headers.get(&name) {
            for value in values {
                if let Ok(value_str) = String::from_utf8(value.clone()) {
                    header_strings.push(format!(r#""{name}": "{value_str}""#));
                }
            }
        }
    }

    header_strings.join(", ")
}

bindings::export!(Component with_types_in bindings);
