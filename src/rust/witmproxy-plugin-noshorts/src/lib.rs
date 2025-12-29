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
                let (mut tx, rx) = wit_stream::new();
                let logger = cap.logger().await.unwrap();

                logger
                    .info("[noshorts] START: Processing InboundContent event".into())
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

                wit_bindgen::spawn(async move {
                    let start_streaming = std::time::Instant::now();
                    let mut chunk = Vec::with_capacity(1024);
                    loop {
                        let (status, buf) = body.read(chunk).await;
                        chunk = buf;
                        match status {
                            StreamResult::Complete(_) => {
                                chunk = tx.write_all(chunk).await;
                                assert!(chunk.is_empty());
                            }
                            StreamResult::Dropped | StreamResult::Cancelled => break,
                        }
                    }
                    drop(tx);

                    logger
                        .info(format!(
                            "[noshorts] stream finished writing in {:?}",
                            start_streaming.elapsed()
                        ))
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
