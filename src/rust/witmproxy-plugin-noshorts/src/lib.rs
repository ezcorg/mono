use encoding_rs::Encoding;
use lol_html::{AsciiCompatibleEncoding, HtmlRewriter, Settings, element};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use wit_bindgen::StreamResult;

use crate::exports::witmproxy::plugin::witm_plugin::{
    Capability, CapabilityProvider, Event, Guest, PluginManifest,
};
use crate::witmproxy::plugin::capabilities::{CapabilityKind, CapabilityScope, EventKind};

wit_bindgen::generate!({
    world: "witmproxy:plugin/plugin",
    async: true,
    generate_all
});

const PUBLIC_KEY_BYTES: &[u8] = include_bytes!("../key.public");

struct Plugin;

pub const STYLES: &str = r#"
<style>
    a[href*="shorts"] {
        display: none !important;
    }

    [is-shorts="true"] {
        display: none !important;
    }

    ytd-guide-entry-renderer a[title="Shorts"] {
        display: none !important;
    }
</style>
"#;

pub fn inject_styles_into_html(original_html: &str, head_pos: usize) -> String {
    let (before_head, after_head) = original_html.split_at(head_pos);
    let mut modified_html =
        String::with_capacity(before_head.len() + STYLES.len() + after_head.len());
    modified_html.push_str(before_head);
    modified_html.push_str(STYLES);
    modified_html.push_str(after_head);
    modified_html
}

impl Guest for Plugin {
    async fn manifest() -> PluginManifest {
        PluginManifest {
            name: "witmproxy-plugin-noshorts".to_string(),
            namespace: "Theodore Brockman".to_string(),
            author: "Theodore Brockman".to_string(),
            version: "0.0.0".to_string(),
            description: "Blocks network requests for YouTube shorts, and hides all shorts-related content in YouTube HTML pages".to_string(),
            metadata: vec![],
            capabilities: vec![
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Connect),
                    scope: CapabilityScope {
                        expression: "connect.host().contains('youtube.com')".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::InboundContent),
                    scope: CapabilityScope {
                        expression: "content.content_type().startsWith('text/html')".into(),
                    },
                },
            ],
            license: "MIT".to_string(),
            url: "https://example.com".to_string(),
            publickey: PUBLIC_KEY_BYTES.to_vec(),
        }
    }

    async fn handle(ev: Event, cap: CapabilityProvider) -> Option<Event> {
        match ev {
            Event::InboundContent(content) => {
                let (body_tx, body_rx) = wit_stream::new();
                let logger = cap.logger().await.unwrap();

                logger
                    .info("[noshorts] START: Processing InboundContent event".into())
                    .await;

                // Extract charset from content-type header
                let content_type = content.content_type().await;
                let encoding = extract_charset_from_content_type(&content_type);

                logger
                    .info(
                        format!(
                            "[noshorts] Content-Type: {}, Encoding: {}",
                            content_type,
                            encoding.name()
                        )
                        .into(),
                    )
                    .await;

                let start_body_retrieval = std::time::Instant::now();
                let mut body = content.body().await;
                logger
                    .info(
                        format!(
                            "[noshorts] Body retrieved in {:?}",
                            start_body_retrieval.elapsed()
                        )
                        .into(),
                    )
                    .await;

                // Use a buffer to collect rewriter output without blocking
                // The buffer is shared between the rewriter callback and the async task
                let output_buffer: Arc<Mutex<VecDeque<Vec<u8>>>> =
                    Arc::new(Mutex::new(VecDeque::new()));
                let output_buffer_clone = Arc::clone(&output_buffer);

                // Create HTML rewriter to inject styles
                let mut rewriter = HtmlRewriter::new(
                    Settings {
                        element_content_handlers: vec![
                            // Inject styles into <head>
                            element!("head", |el| {
                                el.append(STYLES, lol_html::html_content::ContentType::Html);
                                Ok(())
                            }),
                        ],
                        encoding: AsciiCompatibleEncoding::new(encoding).unwrap(),
                        ..Settings::default()
                    },
                    move |c: &[u8]| {
                        // Buffer the output instead of using block_on
                        // This avoids deadlock with the async runtime
                        if !c.is_empty() {
                            let mut buffer = output_buffer_clone.lock().unwrap();
                            buffer.push_back(c.to_vec());
                        }
                    },
                );

                wit_bindgen::spawn(async move {
                    let start_streaming = std::time::Instant::now();
                    let mut body_tx = body_tx;

                    let mut chunk = Vec::with_capacity(1024);
                    loop {
                        let (status, buf) = body.read(chunk).await;
                        chunk = buf;

                        match status {
                            StreamResult::Complete(_) => {
                                if let Err(e) = rewriter.write(&chunk) {
                                    logger
                                        .error(format!(
                                            "[noshorts] HtmlRewriter write error: {:?}",
                                            e
                                        ))
                                        .await;
                                }

                                // Drain any buffered output and write it asynchronously
                                loop {
                                    let chunk_to_write = {
                                        let mut buffer = output_buffer.lock().unwrap();
                                        buffer.pop_front()
                                    };
                                    match chunk_to_write {
                                        Some(data) => {
                                            let mut remaining = data;
                                            loop {
                                                remaining = body_tx.write_all(remaining).await;
                                                if remaining.is_empty() {
                                                    break;
                                                }
                                            }
                                        }
                                        None => break,
                                    }
                                }
                            }
                            StreamResult::Dropped | StreamResult::Cancelled => {
                                logger.info("[noshorts] Input stream ended".into()).await;
                                break;
                            }
                        }
                    }

                    // Finalize the rewriter
                    if let Err(e) = rewriter.end() {
                        logger
                            .error(format!("[noshorts] HtmlRewriter end error: {:?}", e))
                            .await;
                    }

                    // Drain any remaining buffered output after end()
                    loop {
                        let chunk_to_write = {
                            let mut buffer = output_buffer.lock().unwrap();
                            buffer.pop_front()
                        };
                        match chunk_to_write {
                            Some(data) => {
                                let mut remaining = data;
                                loop {
                                    remaining = body_tx.write_all(remaining).await;
                                    if remaining.is_empty() {
                                        break;
                                    }
                                }
                            }
                            None => break,
                        }
                    }

                    // Drop body_tx to signal end of stream
                    drop(body_tx);

                    logger
                        .info(format!(
                            "[noshorts] stream finished writing in {:?}",
                            start_streaming.elapsed()
                        ))
                        .await;
                });

                let start_set_body = std::time::Instant::now();
                content.set_body(body_rx).await;
                let logger = cap.logger().await.unwrap();
                logger
                    .info(
                        format!(
                            "[noshorts] set_body completed in {:?}",
                            start_set_body.elapsed()
                        )
                        .into(),
                    )
                    .await;

                logger
                    .info("[noshorts] END: Returning InboundContent event".into())
                    .await;
                Some(Event::InboundContent(content))
            }
            _ => Some(ev),
        }
    }
}

export!(Plugin);

/// Extract charset from Content-Type header
/// e.g., "text/html; charset=utf-8" -> UTF_8
/// Defaults to UTF-8 if not specified
fn extract_charset_from_content_type(content_type: &str) -> &'static Encoding {
    // Look for charset parameter in content-type
    for part in content_type.split(';') {
        let part = part.trim();
        if part.to_lowercase().starts_with("charset=") {
            let charset = part[8..].trim().trim_matches('"');
            if let Some(encoding) = Encoding::for_label(charset.as_bytes()) {
                return encoding;
            }
        }
    }
    // Default to UTF-8
    encoding_rs::UTF_8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inject_styles_into_html_simple() {
        let html = r#"<html><head><title>Test</title></head><body>Hello</body></html>"#;
        let head_tag_start = html.find("<head>").unwrap();
        let head_pos = head_tag_start + html[head_tag_start..].find(">").unwrap() + 1; // Position after <head>
        let result = inject_styles_into_html(html, head_pos);

        assert!(result.contains(STYLES));
        assert!(result.contains("<title>Test</title>"));

        // Verify styles are injected in the result
        let styles_pos = result.find(STYLES).unwrap();
        let head_end_pos = result.find("<head>").unwrap() + 6;
        assert!(
            styles_pos >= head_end_pos,
            "Styles should be after <head> tag"
        );
    }
}
