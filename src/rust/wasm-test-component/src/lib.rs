use crate::{
    exports::witmproxy::plugin::witm_plugin::{
        Capability, CapabilityProvider, ConfigureError, Guest, GuestPlugin,
        Plugin as PluginResource, PluginManifest, UserInput,
    },
    witmproxy::plugin::capabilities::{
        CapabilityKind, CapabilityScope, ContextualResponse, Event, EventKind, Request, Response,
    },
};

wit_bindgen::generate!({
    world: "witmproxy:plugin/plugin",
    async: true,
    path: "../../apps/witmproxy/wit",
    generate_all
});

const PUBLIC_KEY_BYTES: &[u8] = include_bytes!("../key.public");

struct Component;

impl Guest for Component {
    type Plugin = PluginInstance;

    async fn manifest() -> PluginManifest {
        PluginManifest {
            name: "wasm-test-component".to_string(),
            namespace: "ezco".to_string(),
            author: "theo".to_string(),
            version: "0.0.1".to_string(),
            description: "A test plugin".to_string(),
            metadata: vec![],
            capabilities: vec![
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Connect),
                    scope: CapabilityScope {
                        expression: "true".to_string(),
                    }
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Request),
                    scope: CapabilityScope {
                        expression: "request.host() != 'donotprocess.com' && !('skipthis' in request.headers() && 'true' in request.headers()['skipthis'])".to_string(),
                    }
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Response),
                    scope: CapabilityScope {
                        expression: "request.host() != 'donotprocess.com' && !('skipthis' in request.headers() && 'true' in request.headers()['skipthis'])".to_string(),
                    }
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::InboundContent),
                    scope: CapabilityScope {
                        expression: "content.content_type() == 'text/html'".to_string(),
                    }
                }
            ],
            license: "MIT".to_string(),
            url: "https://example.com".to_string(),
            publickey: PUBLIC_KEY_BYTES.to_vec(),
            configuration: vec![],
        }
    }
}

struct PluginInstance {
    _config: Vec<UserInput>,
}

impl GuestPlugin for PluginInstance {
    async fn create(config: Vec<UserInput>) -> Result<PluginResource, ConfigureError> {
        Ok(PluginResource::new(PluginInstance { _config: config }))
    }

    async fn handle(&self, ev: Event, _cp: CapabilityProvider) -> Option<Event> {
        match ev {
            Event::Request(req) => {
                let authority = req.get_authority().await;
                let path_with_query = req.get_path_with_query().await;
                let scheme = req.get_scheme().await;
                let old_headers = req.get_headers().await;

                // Clone to get mutable headers
                let headers = old_headers.clone().await;
                let val = "req".as_bytes().to_vec();
                headers
                    .set("witmproxy".to_string(), [val].to_vec())
                    .await
                    .unwrap();

                let (_, result_rx) = wit_future::new(|| Ok(()));
                let (body, trailers) = Request::consume_body(req, result_rx).await;
                let (new_req, _) = Request::new(headers, Some(body), trailers, None).await;
                let _ = new_req.set_authority(authority).await;
                let _ = new_req.set_path_with_query(path_with_query).await;
                let _ = new_req.set_scheme(scheme).await;
                Some(Event::Request(new_req))
            }
            Event::Response(ContextualResponse { response, request }) => {
                let old_headers = response.get_headers().await;

                // Clone to get mutable headers
                let headers = old_headers.clone().await;
                let val = "res".as_bytes().to_vec();
                headers
                    .set("witmproxy".to_string(), [val].to_vec())
                    .await
                    .unwrap();

                let (_, result_rx) = wit_future::new(|| Ok(()));
                let (body, trailers) = Response::consume_body(response, result_rx).await;
                let (new_res, _) = Response::new(headers, Some(body), trailers).await;
                Some(Event::Response(ContextualResponse {
                    response: new_res,
                    request,
                }))
            }
            Event::InboundContent(content) => {
                let (mut tx, rx) = wit_stream::new();
                let data = content.body().await;

                // Spawn a task to prepend new_html to the original content
                // Because writing to `tx` will block until `rx` is read
                wit_bindgen::spawn(async move {
                    let new_html = "<!-- Processed by `wasm-test-component` plugin -->\n"
                        .as_bytes()
                        .to_vec();
                    let _ = tx.write_all(new_html).await;
                    let collected = data.collect().await;
                    let _ = tx.write_all(collected).await;
                });

                // Return the modified stream
                content.set_body(rx).await;
                Some(Event::InboundContent(content))
            }
        }
    }
}

export!(Component);
