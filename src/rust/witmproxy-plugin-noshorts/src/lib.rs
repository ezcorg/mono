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
                let (mut tx, rx) = wit_stream::new();
                let logger = cap.logger().await.unwrap();

                logger
                    .info("[noshorts] START: Processing InboundContent event".into())
                    .await;

                let start_body_retrieval = std::time::Instant::now();
                let body = content.body().await;
                logger
                    .info(
                        format!(
                            "[noshorts] Body retrieved in {:?}",
                            start_body_retrieval.elapsed()
                        )
                        .into(),
                    )
                    .await;

                wit_bindgen::spawn(async move {
                    let start_collect = std::time::Instant::now();
                    // Collect all data (unavoidable with current API)
                    let data = body.collect().await;
                    logger
                        .info(
                            format!(
                                "[noshorts] Body collected ({} bytes) in {:?}",
                                data.len(),
                                start_collect.elapsed()
                            )
                            .into(),
                        )
                        .await;
                    // Write in chunks to reduce cross-boundary transfer overhead
                    const CHUNK_SIZE: usize = 65536; // 64KB chunks

                    let start_processing = std::time::Instant::now();
                    // Search for <head> tag
                    let head_search_start = std::time::Instant::now();
                    let head_pos_opt = data
                        .windows(5)
                        .position(|w| w.eq_ignore_ascii_case(b"<head"));
                    logger
                        .info(
                            format!(
                                "[noshorts] Head tag search completed in {:?}",
                                head_search_start.elapsed()
                            )
                            .into(),
                        )
                        .await;

                    let start_write = std::time::Instant::now();
                    if let Some(head_start) = head_pos_opt {
                        // Find the closing '>' of the head tag
                        if let Some(relative_close) =
                            data[head_start..].iter().position(|&b| b == b'>')
                        {
                            let injection_pos = head_start + relative_close + 1;
                            logger
                                .info(
                                    format!(
                                        "[noshorts] Injecting styles at position {}",
                                        injection_pos
                                    )
                                    .into(),
                                )
                                .await;

                            // Write everything before injection point
                            let before = &data[..injection_pos];
                            for chunk in before.chunks(CHUNK_SIZE) {
                                tx.write_all(chunk.to_vec()).await;
                            }

                            // Write styles
                            tx.write_all(STYLES.as_bytes().to_vec()).await;

                            // Write everything after injection point
                            let after = &data[injection_pos..];
                            for chunk in after.chunks(CHUNK_SIZE) {
                                tx.write_all(chunk.to_vec()).await;
                            }
                        } else {
                            // No closing '>', write original in chunks
                            logger
                                .info(
                                    "[noshorts] No head tag closing found, writing original".into(),
                                )
                                .await;
                            for chunk in data.chunks(CHUNK_SIZE) {
                                tx.write_all(chunk.to_vec()).await;
                            }
                        }
                    } else {
                        // No <head> tag, write original in chunks
                        logger
                            .info("[noshorts] No head tag found, writing original".into())
                            .await;
                        for chunk in data.chunks(CHUNK_SIZE) {
                            tx.write_all(chunk.to_vec()).await;
                        }
                    }
                    logger
                        .info(format!("[noshorts] All content written to stream in {:?} (total processing: {:?})", start_write.elapsed(), start_processing.elapsed()).into())
                        .await;
                });

                let start_set_body = std::time::Instant::now();
                content.set_body(rx).await;
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
