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

                // Extract charset from content-type header
                let content_type = content.content_type().await;
                let encoding = extract_charset_from_content_type(&content_type);

                logger
                    .info(format!(
                        "[noshorts] Processing HTML content (encoding: {})",
                        encoding.name()
                    ))
                    .await;

                let mut body = content.body().await;

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
                    let mut body_tx = body_tx;
                    let mut chunk = Vec::with_capacity(1024);

                    loop {
                        let (status, buf) = body.read(chunk).await;
                        chunk = buf;

                        // Extract the actual byte count from the status
                        let count = match &status {
                            StreamResult::Complete(c) => *c,
                            _ => 0,
                        };

                        match status {
                            StreamResult::Complete(_) => {
                                // IMPORTANT: Only process if we actually read new data
                                // count=0 means no new bytes were read, chunk may contain stale data
                                // This prevents an infinite loop of reprocessing the same data
                                if count == 0 {
                                    chunk.clear();
                                    continue;
                                }

                                // Only write the newly read bytes (chunk[..count])
                                if let Err(e) = rewriter.write(&chunk[..count]) {
                                    logger
                                        .error(format!(
                                            "[noshorts] HtmlRewriter write error: {:?}",
                                            e
                                        ))
                                        .await;
                                }

                                // Clear the chunk after processing for clean next read
                                chunk.clear();

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
                        .info("[noshorts] HTML processing complete".into())
                        .await;
                });

                content.set_body(body_rx).await;
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
        // TODO:
    }
}
