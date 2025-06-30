use mitm_plugin_sdk::*;

// Define plugin metadata
plugin_metadata!(
    "logger",
    "1.0.0",
    "Logs all HTTP requests and responses",
    "MITM Proxy Team",
    &[
        "request_start",
        "request_headers",
        "response_start",
        "response_headers"
    ]
);

// Request start event handler
plugin_event_handler!("request_start", handle_request_start);

fn handle_request_start(context: RequestContext) -> PluginResult {
    log_info!(
        "Request started: {} {} from {}",
        context.request.method,
        context.request.url,
        context.client_ip
    );

    // Store request start time
    let timestamp = PluginApi::get_timestamp();
    PluginApi::storage_set(
        &format!("request_start_{}", context.request_id),
        &serde_json::json!(timestamp),
    );

    PluginResult::Continue
}

// Request headers event handler
plugin_event_handler!("request_headers", handle_request_headers);

fn handle_request_headers(context: RequestContext) -> PluginResult {
    log_debug!(
        "Request headers for {}: {:?}",
        context.request.url,
        context.request.headers
    );

    // Log interesting headers
    if let Some(user_agent) = context.request.headers.get("user-agent") {
        log_info!("User-Agent: {}", user_agent);
    }

    if let Some(referer) = context.request.headers.get("referer") {
        log_info!("Referer: {}", referer);
    }

    // Count requests per host
    let host_key = format!("host_count_{}", context.target_host);
    let current_count = PluginApi::storage_get(&host_key)
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    PluginApi::storage_set(&host_key, &serde_json::json!(current_count + 1));

    PluginResult::Continue
}

// Response start event handler
plugin_event_handler!("response_start", handle_response_start);

fn handle_response_start(context: RequestContext) -> PluginResult {
    if let Some(response) = &context.response {
        log_info!(
            "Response started: {} for {}",
            response.status,
            context.request.url
        );

        // Calculate request duration
        if let Some(start_time) =
            PluginApi::storage_get(&format!("request_start_{}", context.request_id))
        {
            if let Some(start_timestamp) = start_time.as_i64() {
                let duration = PluginApi::get_timestamp() - start_timestamp;
                log_info!("Request duration: {}ms", duration);

                // Store duration for analytics
                PluginApi::storage_set(
                    &format!("request_duration_{}", context.request_id),
                    &serde_json::json!(duration),
                );
            }
        }
    }

    PluginResult::Continue
}

// Response headers event handler
plugin_event_handler!("response_headers", handle_response_headers);

fn handle_response_headers(context: RequestContext) -> PluginResult {
    if let Some(response) = &context.response {
        log_debug!(
            "Response headers for {}: {:?}",
            context.request.url,
            response.headers
        );

        // Log content type
        if let Some(content_type) = response.headers.get("content-type") {
            log_info!("Content-Type: {}", content_type);
        }

        // Log content length
        if let Some(content_length) = response.headers.get("content-length") {
            log_info!("Content-Length: {}", content_length);
        }

        // Warn about insecure headers
        if response.headers.get("strict-transport-security").is_none() {
            log_warn!("Missing HSTS header for {}", context.request.url);
        }

        if response.headers.get("x-frame-options").is_none() {
            log_warn!("Missing X-Frame-Options header for {}", context.request.url);
        }
    }

    PluginResult::Continue
}
