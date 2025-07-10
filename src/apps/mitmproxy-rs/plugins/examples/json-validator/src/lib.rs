use mitm_plugin_sdk::*;

// Define plugin metadata
plugin_metadata!(
    "json-validator",
    "1.0.0",
    "Validates and processes JSON requests/responses automatically",
    "MITM Proxy Team",
    &["request_body", "response_body"]
);

// JSON handler for request validation
fn handle_json_request(context: RequestContext, json_data: serde_json::Value) -> PluginResult {
    log_info!("Processing JSON request to {}", context.request.url);

    // Example validation: check for sensitive data
    if let Some(obj) = json_data.as_object() {
        // Check for potentially sensitive fields
        let sensitive_fields = ["password", "secret", "token", "api_key", "credit_card"];

        for field in sensitive_fields.iter() {
            if obj.contains_key(*field) {
                log_warn!(
                    "Detected sensitive field '{}' in JSON request to {}",
                    field,
                    context.request.url
                );

                // Store detection for analytics
                PluginApi::storage_set(
                    &format!("sensitive_detection_{}", context.request_id),
                    &serde_json::json!({
                        "field": field,
                        "url": context.request.url,
                        "timestamp": PluginApi::get_timestamp()
                    }),
                );
            }
        }

        // Example: Block requests with specific patterns
        if let Some(action) = obj.get("action") {
            if action == "delete_all" {
                log_error!("Blocking dangerous delete_all action");
                return PluginResult::Block("Dangerous action blocked".to_string());
            }
        }

        // Example: Validate required fields for API endpoints
        if context.request.url.contains("/api/") {
            let required_fields = ["user_id", "timestamp"];
            for field in required_fields.iter() {
                if !obj.contains_key(*field) {
                    log_warn!("Missing required field '{}' in API request", field);
                }
            }
        }
    }

    PluginResult::Continue
}

// Register the JSON handler for requests
json_handler!("handle_json_request_export", handle_json_request);

// JSON handler for response processing
fn handle_json_response(context: RequestContext, json_data: serde_json::Value) -> PluginResult {
    log_info!("Processing JSON response from {}", context.request.url);

    if let Some(obj) = json_data.as_object() {
        // Example: Log error responses
        if let Some(error) = obj.get("error") {
            log_warn!("API error response from {}: {}", context.request.url, error);

            // Store error for monitoring
            PluginApi::storage_set(
                &format!("api_error_{}", context.request_id),
                &serde_json::json!({
                    "url": context.request.url,
                    "error": error,
                    "timestamp": PluginApi::get_timestamp()
                }),
            );
        }

        // Example: Extract and log user data
        if let Some(user_data) = obj.get("user") {
            if let Some(user_id) = user_data.get("id") {
                log_info!("User {} accessed {}", user_id, context.request.url);
            }
        }

        // Example: Monitor data size
        let response_size = serde_json::to_string(&json_data).unwrap_or_default().len();
        if response_size > 1024 * 1024 {
            // 1MB
            log_warn!(
                "Large JSON response ({} bytes) from {}",
                response_size,
                context.request.url
            );
        }

        // Example: Check for sensitive data in responses
        if obj.contains_key("credit_card") || obj.contains_key("ssn") {
            log_error!(
                "Sensitive data detected in response from {}",
                context.request.url
            );

            // Could modify response to remove sensitive data
            // For now, just log and continue
        }
    }

    PluginResult::Continue
}

// Register the JSON handler for responses
json_handler!("handle_json_response_export", handle_json_response);

// Traditional event handlers for non-JSON content
plugin_event_handler!("request_body", handle_request_body);

fn handle_request_body(context: RequestContext) -> PluginResult {
    // This will only be called for non-JSON content since JSON is handled automatically
    let unknown = "unknown".to_string();
    let content_type = context
        .request
        .headers
        .get("content-type")
        .unwrap_or(&unknown);

    log_debug!("Non-JSON request body with content-type: {}", content_type);
    PluginResult::Continue
}

plugin_event_handler!("response_body", handle_response_body);

fn handle_response_body(context: RequestContext) -> PluginResult {
    // This will only be called for non-JSON content since JSON is handled automatically
    if let Some(response) = &context.response {
        let unknown = "unknown".to_string();
        let content_type = response.headers.get("content-type").unwrap_or(&unknown);

        log_debug!("Non-JSON response body with content-type: {}", content_type);
    }

    PluginResult::Continue
}
