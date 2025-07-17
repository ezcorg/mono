use wit_bindgen::generate;

// Generate bindings for our WASI world
generate!({
    world: "plugin",
    path: "./wit",
});

// Export the world
export!(Component);

struct Component;

impl Guest for Component {
    fn get_metadata() -> String {
        "minimal-wasi-plugin v0.1.0".to_string()
    }

    fn on_request(request: String) -> String {
        // Simple request processing - just add a prefix for this minimal example
        format!("[PROCESSED] {}", request)
    }

    fn on_response(response: String) -> String {
        // Simple response processing - just add a suffix for this minimal example
        format!("{} [PROCESSED]", response)
    }
}
