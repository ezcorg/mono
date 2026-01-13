use encoding_rs::Encoding;
use lol_html::{AsciiCompatibleEncoding, HtmlRewriter, Settings, element};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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

    yt-thumbnail-view-model {
        display: none !important;
    }

    #dismissible {
        display: none !important;
    }

    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
    ytd-rich-item-renderer:has(ad-badge-view-model),
    ytd-rich-item-renderer:has([class*="Ad"]):has([class*="ad"])
    {
        display: none !important;
    }

    #masthead-ad {
        display: none !important;
    }

    .yt-lockup-metadata-view-model__avatar {
        display: none !important;
    }

    .yt-lockup-view-model__content-image {
        display: none !important;
    }

    #contents {
        flex-direction: column;
        gap: 4rem;
    }

    #contents > ytd-rich-item-renderer {
        margin: 0 0 0 3rem;
    }
</style>
"#;

impl Guest for Plugin {
    async fn manifest() -> PluginManifest {
        PluginManifest {
            name: "noshorts".to_string(),
            namespace: "witmproxy".to_string(),
            author: "Theodore Brockman".to_string(),
            version: "0.0.0".to_string(),
            description: "Blocks network requests for YouTube shorts, and hides all shorts-related content in YouTube HTML pages".to_string(),
            metadata: vec![],
            capabilities: vec![
                Capability {
                    kind: CapabilityKind::Annotator,
                    scope: CapabilityScope { expression: "true".into()}
                },
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
            license: "AGPLv3".to_string(),
            url: "https://joinez.co".to_string(),
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
                        "[noshorts] 🚀 START Processing HTML content (encoding: {})",
                        encoding.name()
                    ))
                    .await;

                let mut body = content.body().await;

                // Use a buffer to collect rewriter output without blocking
                // The buffer is shared between the rewriter callback and the async task
                let output_buffer: Arc<Mutex<VecDeque<Vec<u8>>>> =
                    Arc::new(Mutex::new(VecDeque::new()));
                let output_buffer_clone = Arc::clone(&output_buffer);

                // Diagnostic counters for performance analysis
                let total_bytes_read = Arc::new(AtomicUsize::new(0));
                let total_bytes_written = Arc::new(AtomicUsize::new(0));
                let read_count = Arc::new(AtomicUsize::new(0));
                let write_count = Arc::new(AtomicUsize::new(0));
                // Track timing: first read, first write (stored as micros since start)
                let first_read_at = Arc::new(AtomicU64::new(0));
                let first_write_at = Arc::new(AtomicU64::new(0));

                // Clone counters for the spawned task
                let total_bytes_read_clone = Arc::clone(&total_bytes_read);
                let total_bytes_written_clone = Arc::clone(&total_bytes_written);
                let read_count_clone = Arc::clone(&read_count);
                let write_count_clone = Arc::clone(&write_count);
                let first_read_at_clone = Arc::clone(&first_read_at);
                let first_write_at_clone = Arc::clone(&first_write_at);

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
                    let mut chunk = Vec::with_capacity(65536);
                    let start_time = std::time::Instant::now();

                    logger
                        .info("[noshorts] 📖 Spawned task started, beginning to read body".into())
                        .await;

                    loop {
                        let read_start = std::time::Instant::now();
                        let (status, buf) = body.read(chunk).await;
                        let read_duration = read_start.elapsed();
                        chunk = buf;

                        match status {
                            StreamResult::Complete(n_bytes_read) => {
                                // IMPORTANT: Only process if we actually read new data
                                // count=0 means no new bytes were read, chunk may contain stale data
                                // This prevents an infinite loop of reprocessing the same data
                                if n_bytes_read == 0 {
                                    chunk.clear();
                                    continue;
                                }

                                // Update diagnostic counters
                                let current_read_count =
                                    read_count_clone.fetch_add(1, Ordering::Relaxed);
                                total_bytes_read_clone.fetch_add(n_bytes_read, Ordering::Relaxed);

                                // Record first read time
                                if current_read_count == 0 {
                                    first_read_at_clone.store(
                                        start_time.elapsed().as_micros() as u64,
                                        Ordering::Relaxed,
                                    );
                                    logger
                                        .info(format!(
                                            "[noshorts] 📖 FIRST READ: {} bytes in {:?}",
                                            n_bytes_read, read_duration
                                        ))
                                        .await;
                                }

                                // Log every 10th read or if read took > 100ms
                                if current_read_count % 10 == 0 || read_duration.as_millis() > 100 {
                                    logger
                                        .info(format!(
                                            "[noshorts] 📖 Read #{}: {} bytes in {:?} (total: {} bytes)",
                                            current_read_count + 1,
                                            n_bytes_read,
                                            read_duration,
                                            total_bytes_read_clone.load(Ordering::Relaxed)
                                        ))
                                        .await;
                                }

                                if let Err(e) = rewriter.write(&chunk[..n_bytes_read]) {
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
                                            let data_len = data.len();
                                            let write_start = std::time::Instant::now();
                                            let mut remaining = data;
                                            loop {
                                                remaining = body_tx.write_all(remaining).await;
                                                if remaining.is_empty() {
                                                    break;
                                                }
                                            }
                                            let write_duration = write_start.elapsed();

                                            // Update write counters
                                            let current_write_count =
                                                write_count_clone.fetch_add(1, Ordering::Relaxed);
                                            total_bytes_written_clone
                                                .fetch_add(data_len, Ordering::Relaxed);

                                            // Record first write time
                                            if current_write_count == 0 {
                                                first_write_at_clone.store(
                                                    start_time.elapsed().as_micros() as u64,
                                                    Ordering::Relaxed,
                                                );
                                                logger
                                                    .info(format!(
                                                        "[noshorts] ✍️ FIRST WRITE: {} bytes in {:?}",
                                                        data_len, write_duration
                                                    ))
                                                    .await;
                                            }

                                            // Log if write took > 50ms (potential backpressure)
                                            if write_duration.as_millis() > 50 {
                                                logger
                                                    .info(format!(
                                                        "[noshorts] ✍️ SLOW WRITE #{}: {} bytes in {:?}",
                                                        current_write_count + 1, data_len, write_duration
                                                    ))
                                                    .await;
                                            }
                                        }
                                        None => break,
                                    }
                                }
                            }
                            StreamResult::Dropped => {
                                logger.info("[noshorts] ⚠️ Stream dropped".into()).await;
                                break;
                            }
                            StreamResult::Cancelled => {
                                logger.info("[noshorts] ⚠️ Stream cancelled".into()).await;
                                break;
                            }
                        }
                    }

                    let read_loop_duration = start_time.elapsed();
                    logger
                        .info(format!(
                            "[noshorts] 📖 Read loop complete in {:?}. Total reads: {}, Total bytes read: {}",
                            read_loop_duration,
                            read_count_clone.load(Ordering::Relaxed),
                            total_bytes_read_clone.load(Ordering::Relaxed)
                        ))
                        .await;

                    // Finalize the rewriter
                    let end_start = std::time::Instant::now();
                    if let Err(e) = rewriter.end() {
                        logger
                            .error(format!("[noshorts] HtmlRewriter end error: {:?}", e))
                            .await;
                    }
                    let end_duration = end_start.elapsed();
                    logger
                        .info(format!(
                            "[noshorts] 🏁 rewriter.end() completed in {:?}",
                            end_duration
                        ))
                        .await;

                    // Drain any remaining buffered output after end()
                    let final_drain_start = std::time::Instant::now();
                    let mut final_drain_count = 0;
                    let mut final_drain_bytes = 0;
                    loop {
                        let chunk_to_write = {
                            let mut buffer = output_buffer.lock().unwrap();
                            buffer.pop_front()
                        };
                        match chunk_to_write {
                            Some(data) => {
                                let data_len = data.len();
                                final_drain_bytes += data_len;
                                final_drain_count += 1;
                                let mut remaining = data;
                                loop {
                                    remaining = body_tx.write_all(remaining).await;
                                    if remaining.is_empty() {
                                        break;
                                    }
                                }
                                write_count_clone.fetch_add(1, Ordering::Relaxed);
                                total_bytes_written_clone.fetch_add(data_len, Ordering::Relaxed);
                            }
                            None => break,
                        }
                    }
                    let final_drain_duration = final_drain_start.elapsed();

                    if final_drain_count > 0 {
                        logger
                            .info(format!(
                                "[noshorts] 🚿 Final drain: {} writes, {} bytes in {:?}",
                                final_drain_count, final_drain_bytes, final_drain_duration
                            ))
                            .await;
                    }

                    // Drop body_tx to signal end of stream
                    drop(body_tx);

                    let total_duration = start_time.elapsed();
                    let first_read_micros = first_read_at_clone.load(Ordering::Relaxed);
                    let first_write_micros = first_write_at_clone.load(Ordering::Relaxed);

                    logger
                        .info(format!(
                            "[noshorts] ✅ HTML processing complete. Total time: {:?}, \
                            First read at: {}µs, First write at: {}µs, \
                            Total reads: {}, Total writes: {}, \
                            Bytes in: {}, Bytes out: {}",
                            total_duration,
                            first_read_micros,
                            first_write_micros,
                            read_count_clone.load(Ordering::Relaxed),
                            write_count_clone.load(Ordering::Relaxed),
                            total_bytes_read_clone.load(Ordering::Relaxed),
                            total_bytes_written_clone.load(Ordering::Relaxed)
                        ))
                        .await;
                });

                content.set_body(body_rx).await;
                cap.logger()
                    .await
                    .unwrap()
                    .info("[noshorts] 🔄 body_rx set, returning content".into())
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
        // TODO:
    }
}
