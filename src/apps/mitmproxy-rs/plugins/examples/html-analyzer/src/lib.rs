use mitm_plugin_sdk::*;

// Define plugin metadata
plugin_metadata!(
    "html-analyzer",
    "1.0.0",
    "Analyzes HTML content for security issues and extracts metadata",
    "MITM Proxy Team",
    &["response_body"]
);

// HTML handler for response analysis
fn handle_html_response(context: RequestContext, html_doc: HtmlDocument) -> PluginResult {
    log_info!("Analyzing HTML response from {}", context.request.url);

    // Analyze page structure
    analyze_page_structure(&context, &html_doc);

    // Check for security issues
    check_security_issues(&context, &html_doc);

    // Extract and log metadata
    extract_metadata(&context, &html_doc);

    // Monitor external resources
    monitor_external_resources(&context, &html_doc);

    PluginResult::Continue
}

// Register the HTML handler
html_handler!("handle_html_response_export", handle_html_response);

fn analyze_page_structure(context: &RequestContext, html_doc: &HtmlDocument) {
    log_info!("Page structure analysis for {}:", context.request.url);
    log_info!("  - Links: {}", html_doc.links.len());
    log_info!("  - Forms: {}", html_doc.forms.len());
    log_info!("  - Scripts: {}", html_doc.scripts.len());

    // Store page structure data
    PluginApi::storage_set(
        &format!("page_structure_{}", context.request_id),
        &serde_json::json!({
            "url": context.request.url,
            "links_count": html_doc.links.len(),
            "forms_count": html_doc.forms.len(),
            "scripts_count": html_doc.scripts.len(),
            "timestamp": PluginApi::get_timestamp()
        }),
    );
}

fn check_security_issues(context: &RequestContext, html_doc: &HtmlDocument) {
    let mut security_issues = Vec::new();

    // Check for forms without CSRF protection
    for form in &html_doc.forms {
        let has_csrf_token = form.inputs.iter().any(|input| {
            input.name.as_ref().map_or(false, |name| {
                name.contains("csrf") || name.contains("token") || name == "_token"
            })
        });

        if !has_csrf_token && form.method == "post" {
            security_issues.push(format!(
                "Form without CSRF token: {}",
                form.action.as_deref().unwrap_or("unknown")
            ));
        }
    }

    // Check for password fields without HTTPS
    if !context.request.url.starts_with("https://") {
        for form in &html_doc.forms {
            let has_password = form
                .inputs
                .iter()
                .any(|input| input.input_type == "password");

            if has_password {
                security_issues.push("Password field on non-HTTPS page".to_string());
            }
        }
    }

    // Check for external links without rel="noopener"
    for link in &html_doc.links {
        if link.href.starts_with("http")
            && !link.href.contains(&extract_domain(&context.request.url))
        {
            if let Some(rel) = &link.rel {
                if !rel.contains("noopener") {
                    security_issues.push(format!("External link without noopener: {}", link.href));
                }
            } else {
                security_issues.push(format!(
                    "External link without rel attribute: {}",
                    link.href
                ));
            }
        }
    }

    // Log security issues
    if !security_issues.is_empty() {
        log_warn!("Security issues found on {}:", context.request.url);
        for issue in &security_issues {
            log_warn!("  - {}", issue);
        }

        // Store security issues
        PluginApi::storage_set(
            &format!("security_issues_{}", context.request_id),
            &serde_json::json!({
                "url": context.request.url,
                "issues": security_issues,
                "timestamp": PluginApi::get_timestamp()
            }),
        );
    }
}

fn extract_metadata(context: &RequestContext, html_doc: &HtmlDocument) {
    let mut metadata = serde_json::Map::new();

    // Extract title
    if let Some(title) = &html_doc.title {
        metadata.insert(
            "title".to_string(),
            serde_json::Value::String(title.clone()),
        );
        log_info!("Page title: {}", title);
    }

    // Extract meta description
    if let Some(description) = html_doc.meta.get("description") {
        metadata.insert(
            "description".to_string(),
            serde_json::Value::String(description.clone()),
        );
    }

    // Count different types of elements
    metadata.insert(
        "links_count".to_string(),
        serde_json::Value::Number(html_doc.links.len().into()),
    );
    metadata.insert(
        "forms_count".to_string(),
        serde_json::Value::Number(html_doc.forms.len().into()),
    );
    metadata.insert(
        "scripts_count".to_string(),
        serde_json::Value::Number(html_doc.scripts.len().into()),
    );

    // Analyze form types
    let mut form_types = std::collections::HashMap::new();
    for form in &html_doc.forms {
        let method = &form.method;
        *form_types.entry(method.as_str()).or_insert(0) += 1;
    }
    metadata.insert(
        "form_methods".to_string(),
        serde_json::to_value(form_types).unwrap(),
    );

    // Store metadata
    PluginApi::storage_set(
        &format!("page_metadata_{}", context.request_id),
        &serde_json::Value::Object(metadata),
    );
}

fn monitor_external_resources(context: &RequestContext, html_doc: &HtmlDocument) {
    let current_domain = extract_domain(&context.request.url);
    let mut external_domains = std::collections::HashSet::new();

    // Check external links
    for link in &html_doc.links {
        if link.href.starts_with("http") {
            let domain = extract_domain(&link.href);
            if domain != current_domain {
                external_domains.insert(domain);
            }
        }
    }

    // Check external scripts
    for script in &html_doc.scripts {
        if script.starts_with("http") {
            let domain = extract_domain(script);
            if domain != current_domain {
                external_domains.insert(domain);
            }
        }
    }

    if !external_domains.is_empty() {
        log_info!("External domains referenced from {}:", context.request.url);
        for domain in &external_domains {
            log_info!("  - {}", domain);
        }

        // Store external domain references
        PluginApi::storage_set(
            &format!("external_domains_{}", context.request_id),
            &serde_json::json!({
                "url": context.request.url,
                "external_domains": external_domains.into_iter().collect::<Vec<_>>(),
                "timestamp": PluginApi::get_timestamp()
            }),
        );
    }
}

fn extract_domain(url: &str) -> String {
    if let Some(start) = url.find("://") {
        let after_protocol = &url[start + 3..];
        if let Some(end) = after_protocol.find('/') {
            after_protocol[..end].to_string()
        } else if let Some(end) = after_protocol.find('?') {
            after_protocol[..end].to_string()
        } else {
            after_protocol.to_string()
        }
    } else {
        url.to_string()
    }
}

// Traditional event handler for non-HTML content
plugin_event_handler!("response_body", handle_response_body);

fn handle_response_body(context: RequestContext) -> PluginResult {
    // This will only be called for non-HTML content since HTML is handled automatically
    if let Some(response) = &context.response {
        let unknown = "unknown".to_string();
        let content_type = response.headers.get("content-type").unwrap_or(&unknown);

        log_debug!("Non-HTML response body with content-type: {}", content_type);

        // Could handle other content types here (CSS, JavaScript, etc.)
        if content_type.contains("javascript") {
            log_info!("JavaScript content detected from {}", context.request.url);
        } else if content_type.contains("css") {
            log_info!("CSS content detected from {}", context.request.url);
        }
    }

    PluginResult::Continue
}
