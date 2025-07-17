#[allow(warnings)]
mod bindings;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::*;

struct Component;

impl Guest for Component {
    fn handle(request: IncomingRequest, response_out: ResponseOutparam) {
        let method = request.method();
        let uri = request.path_with_query().unwrap_or("/".to_string());

        // Route based on path and method
        let (status_code, response_body) = match (method_to_string(&method), uri.as_str()) {
            ("GET", "/api/users") => (200, get_users()),
            ("GET", path) if path.starts_with("/api/users/") => {
                let id = path.strip_prefix("/api/users/").unwrap_or("");
                (200, get_user(id))
            }
            ("POST", "/api/users") => {
                let body = read_request_body(&request);
                (201, create_user(&body))
            }
            ("GET", "/api/health") => (200, health_check()),
            ("GET", "/") => (200, api_info()),
            _ => (404, not_found()),
        };

        // Create response
        let response = OutgoingResponse::new(Fields::new());
        response.set_status_code(status_code).unwrap();

        // Set headers
        let response_headers = response.headers();
        response_headers
            .set(&"content-type".to_string(), &[b"application/json".to_vec()])
            .unwrap();
        response_headers
            .set(
                &"x-powered-by".to_string(),
                &[b"WASI-HTTP-Component".to_vec()],
            )
            .unwrap();

        let body = response.body().unwrap();
        response_out.set(Ok(response));

        let output_stream = body.write().unwrap();
        output_stream
            .blocking_write_and_flush(response_body.as_bytes())
            .unwrap();
        drop(output_stream);

        OutgoingBody::finish(body, None).unwrap();
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

fn read_request_body(request: &IncomingRequest) -> String {
    match request.consume() {
        Ok(body) => {
            let input_stream = body.stream().unwrap();
            let mut body_content = Vec::new();

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
    }
}

fn get_users() -> String {
    r#"{
  "users": [
    {"id": "1", "name": "Alice", "email": "alice@example.com"},
    {"id": "2", "name": "Bob", "email": "bob@example.com"},
    {"id": "3", "name": "Charlie", "email": "charlie@example.com"}
  ],
  "total": 3
}"#
    .to_string()
}

fn get_user(id: &str) -> String {
    match id {
        "1" => r#"{"id": "1", "name": "Alice", "email": "alice@example.com", "role": "admin"}"#
            .to_string(),
        "2" => {
            r#"{"id": "2", "name": "Bob", "email": "bob@example.com", "role": "user"}"#.to_string()
        }
        "3" => r#"{"id": "3", "name": "Charlie", "email": "charlie@example.com", "role": "user"}"#
            .to_string(),
        _ => r#"{"error": "User not found", "code": 404}"#.to_string(),
    }
}

fn create_user(body: &str) -> String {
    // Simple mock creation - in real implementation you'd parse the JSON
    format!(
        r#"{{
  "message": "User created successfully",
  "id": "4",
  "received_data": {}
}}"#,
        if body.is_empty() {
            "null".to_string()
        } else {
            format!("\"{}\"", body.replace('"', r#"\""#))
        }
    )
}

fn health_check() -> String {
    r#"{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00Z",
  "version": "1.0.0",
  "component": "json-api-handler"
}"#
    .to_string()
}

fn api_info() -> String {
    r#"{
  "name": "JSON API Handler",
  "version": "1.0.0",
  "description": "A simple JSON API implemented as a WASI HTTP component",
  "endpoints": {
    "GET /": "API information",
    "GET /api/health": "Health check",
    "GET /api/users": "List all users",
    "GET /api/users/{id}": "Get user by ID",
    "POST /api/users": "Create new user"
  }
}"#
    .to_string()
}

fn not_found() -> String {
    r#"{
  "error": "Not Found",
  "message": "The requested endpoint does not exist",
  "code": 404
}"#
    .to_string()
}

bindings::export!(Component with_types_in bindings);
