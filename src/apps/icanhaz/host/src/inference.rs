//! The **inference** capability — LLM completions through the host's configured
//! providers, served over wRPC. `complete(grant, request) -> stream<u8>` streams
//! text deltas and ends with a usage record; `models(grant)` lists what the
//! grant may use.
//!
//! Gated twice: the grant must be a live `inference` grant whose `models` list
//! admits the request's model, and the grant's `allow` clause must hold with
//! `call.args.request.model`, `call.args.request.max_tokens`, `caller.*`,
//! `state.tokens` (this grant's spend) and `state.day_tokens` (today's spend
//! through the chosen provider, kept in the store's generic per-owner state
//! like a plugin's local-storage) bound. After the provider reports usage,
//! both counters are charged and the day total is written back, so a budget
//! clause holds across restarts.

use std::sync::{Arc, Mutex};

use futures::StreamExt as _;
use tokio_stream::wrappers::UnboundedReceiverStream;
use wit_bindgen_wrpc::bytes::Bytes;

use crate::broker::{caller_of, denied_text, AdmitCall, GrantStore};
use crate::providers::{Frame, Providers, Request};
use crate::store::today;
use crate::AsOrigin;

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "inference-wrpc",
        path: "../wit",
    });
}

use bindings::exports::icanhaz::nocap::inference::{CompletionRequest, ModelInfo};
/// The generated wRPC **client** stub for the inference capability.
pub use bindings::icanhaz::nocap::inference as client;

#[derive(Clone)]
pub struct InferenceProvider {
    store: Arc<Mutex<GrantStore>>,
    providers: Arc<Providers>,
}

impl InferenceProvider {
    pub fn new(store: Arc<Mutex<GrantStore>>, providers: Arc<Providers>) -> Self {
        Self { store, providers }
    }

    /// Bring `state.day_tokens` on the grant's instance up to today's persisted
    /// total for `provider`, so the clause sees the spend of every grant that
    /// used the provider today, not just this one.
    async fn sync_day_tokens(&self, grant: &str, provider: &str) {
        let Some(store) = self.providers.store() else {
            return;
        };
        if let Ok(total) = Providers::day_tokens(store, provider, today()).await {
            let mut grants = self.store.lock().unwrap();
            let current = grants.counter(grant, "day_tokens").unwrap_or(0);
            grants.charge(grant, "day_tokens", total - current);
        }
    }
}

impl<C: AsOrigin + Send + Sync + 'static> bindings::exports::icanhaz::nocap::inference::Handler<C>
    for InferenceProvider
{
    async fn complete(
        &self,
        cx: C,
        grant: String,
        request: CompletionRequest,
    ) -> anyhow::Result<Result<crate::session::ByteStream, String>> {
        // Consent gate: a live inference grant that lists this model (or any).
        let allowed = match self.store.lock().unwrap().validate_inference(&grant) {
            Ok(req) => req,
            Err(denied) => return Ok(Err(format!("inference denied: {}", denied_text(&denied)))),
        };
        if !allowed.models.is_empty() && !allowed.models.contains(&request.model) {
            return Ok(Err(format!(
                "inference denied: this grant covers {}, not `{}`",
                allowed.models.join(", "),
                request.model
            )));
        }
        let Some(provider) = self.providers.resolve(&request.model) else {
            return Ok(Err(format!(
                "inference: no configured provider serves `{}`",
                request.model
            )));
        };

        // Admission: the grant's `allow` clause sees the model, the requested
        // bound, the caller, this grant's spend and today's spend.
        self.sync_day_tokens(&grant, &provider.name).await;
        let admit = AdmitCall::new("complete")
            .arg("request.model", request.model.clone())
            .arg("request.max_tokens", i64::from(request.max_tokens))
            .caller(caller_of(&cx));
        if let Err(denied) = self.store.lock().unwrap().admit(&grant, admit) {
            return Ok(Err(format!("inference denied: {}", denied_text(&denied))));
        }

        let req = Request {
            model: request.model,
            messages: request
                .messages
                .into_iter()
                .map(|m| crate::providers::Message {
                    role: m.role,
                    content: m.content,
                    tool_calls: m
                        .tool_calls
                        .into_iter()
                        .map(|c| crate::providers::ToolCall {
                            id: c.id,
                            name: c.name,
                            arguments: c.arguments,
                        })
                        .collect(),
                    tool_call_id: m.tool_call_id,
                })
                .collect(),
            tools: request
                .tools
                .into_iter()
                .map(|t| crate::providers::Tool {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                })
                .collect(),
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            system: request.system,
        };
        let mut frames = self.providers.complete(&provider, req);

        // Relay frames onto the wire; charge the usage when it arrives.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
        let grants = self.store.clone();
        let providers = self.providers.clone();
        let provider_name = provider.name.clone();
        let token = grant.clone();
        tokio::spawn(async move {
            while let Some(frame) = frames.next().await {
                let tokens = frame.tokens();
                if tokens > 0 {
                    {
                        let mut g = grants.lock().unwrap();
                        g.charge(&token, "tokens", tokens);
                        g.charge(&token, "day_tokens", tokens);
                    }
                    if let Some(store) = providers.store() {
                        if let Err(e) =
                            Providers::add_day_tokens(store, &provider_name, today(), tokens).await
                        {
                            tracing::warn!(error = %e, provider = %provider_name, "could not persist token spend");
                        }
                    }
                }
                let done = matches!(frame, Frame::Usage { .. } | Frame::Error(_));
                if tx.send(frame.encode()).is_err() || done {
                    break;
                }
            }
        });

        let revocation = self.store.lock().unwrap().revocation(&grant);
        let out = UnboundedReceiverStream::new(rx);
        Ok(Ok(crate::session::grant_scoped(
            Box::pin(out),
            revocation,
            (),
        )))
    }

    async fn models(&self, cx: C, grant: String) -> anyhow::Result<Result<Vec<ModelInfo>, String>> {
        let allowed = match self.store.lock().unwrap().validate_inference(&grant) {
            Ok(req) => req,
            Err(denied) => return Ok(Err(format!("inference denied: {}", denied_text(&denied)))),
        };
        let admit = AdmitCall::new("models").caller(caller_of(&cx));
        if let Err(denied) = self.store.lock().unwrap().admit(&grant, admit) {
            return Ok(Err(format!("inference denied: {}", denied_text(&denied))));
        }
        Ok(Ok(self
            .providers
            .models()
            .into_iter()
            .filter(|(_, model)| allowed.models.is_empty() || allowed.models.contains(model))
            .map(|(provider, model)| ModelInfo { provider, model })
            .collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::bindings::exports::icanhaz::nocap::inference::{Handler as _, Message};
    use super::*;
    use crate::broker::{anonymous_principal, CapabilityKind, InferenceRequest};
    use crate::providers::{ProviderConfig, ProviderKind};
    use std::time::Duration;

    fn echo_providers(store: Option<crate::store::Store>) -> Arc<Providers> {
        Arc::new(Providers::new(
            vec![ProviderConfig {
                name: "echo".to_string(),
                kind: ProviderKind::Echo,
                base_url: String::new(),
                api_key: String::new(),
                models: vec!["echo".to_string(), "echo-large".to_string()],
            }],
            store,
        ))
    }

    fn grant(store: &Arc<Mutex<GrantStore>>, models: &[&str], allow: &str) -> String {
        store
            .lock()
            .unwrap()
            .issue_scoped(
                CapabilityKind::Inference(InferenceRequest {
                    models: models.iter().map(|m| m.to_string()).collect(),
                }),
                ezcap::Scope::allow(allow),
                "inference".to_string(),
                Duration::from_secs(60),
                anonymous_principal(),
            )
            .expect("scope compiles")
    }

    fn request(model: &str, text: &str, max_tokens: u32) -> CompletionRequest {
        CompletionRequest {
            model: model.to_string(),
            messages: vec![Message {
                role: "user".to_string(),
                content: text.to_string(),
                tool_calls: vec![],
                tool_call_id: None,
            }],
            tools: vec![],
            max_tokens,
            temperature: None,
            system: None,
        }
    }

    /// Decode `[kind][len u32][payload]` frames.
    fn decode(bytes: &[u8]) -> Vec<(u8, String)> {
        let mut out = Vec::new();
        let mut i = 0;
        while i + 5 <= bytes.len() {
            let kind = bytes[i];
            let len = u32::from_be_bytes([bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]])
                as usize;
            let payload = String::from_utf8_lossy(&bytes[i + 5..i + 5 + len]).into_owned();
            out.push((kind, payload));
            i += 5 + len;
        }
        out
    }

    async fn collect(stream: crate::session::ByteStream) -> Vec<(u8, String)> {
        let chunks: Vec<Bytes> = stream.collect().await;
        decode(&chunks.concat())
    }

    #[tokio::test]
    async fn streams_text_then_usage_and_charges_the_grant() {
        let store = GrantStore::shared();
        let p = InferenceProvider::new(store.clone(), echo_providers(None));
        let token = grant(&store, &["echo"], "true");
        let stream = p
            .complete((), token.clone(), request("echo", "hello there", 0))
            .await
            .unwrap()
            .expect("admitted");
        let frames = collect(stream).await;
        assert_eq!(frames[0], (0, "hello ".to_string()));
        assert_eq!(frames[1], (0, "there".to_string()));
        assert_eq!(frames[2].0, 1);
        assert!(frames[2].1.contains("\"output_tokens\":2"));
        // input 2 + output 2 = 4 tokens charged to the grant.
        assert_eq!(store.lock().unwrap().counter(&token, "tokens"), Some(4));
    }

    #[tokio::test]
    async fn a_tool_call_frame_then_the_tool_turn_completes_the_loop() {
        use super::bindings::exports::icanhaz::nocap::inference::{Tool, ToolCall};
        let store = GrantStore::shared();
        let p = InferenceProvider::new(store.clone(), echo_providers(None));
        let token = grant(&store, &["echo"], "true");
        let mut req = request("echo", "find x", 0);
        req.tools.push(Tool {
            name: "search".to_string(),
            description: "find things".to_string(),
            parameters: r#"{"type":"object"}"#.to_string(),
        });
        let frames = collect(
            p.complete((), token.clone(), req.clone())
                .await
                .unwrap()
                .expect("admitted"),
        )
        .await;
        assert_eq!(frames[0].0, 3, "{frames:?}");
        let call: serde_json::Value = serde_json::from_str(&frames[0].1).unwrap();
        assert_eq!(call["name"], "search");
        assert_eq!(call["arguments"], r#"{"input":"find x"}"#);
        assert_eq!(frames[1].0, 1);

        // The caller ran the tool; the assistant's call and the answer go back.
        req.messages.push(Message {
            role: "assistant".to_string(),
            content: String::new(),
            tool_calls: vec![ToolCall {
                id: "call-1".to_string(),
                name: "search".to_string(),
                arguments: call["arguments"].as_str().unwrap().to_string(),
            }],
            tool_call_id: None,
        });
        req.messages.push(Message {
            role: "tool".to_string(),
            content: "found it".to_string(),
            tool_calls: vec![],
            tool_call_id: Some("call-1".to_string()),
        });
        let frames = collect(p.complete((), token, req).await.unwrap().expect("admitted")).await;
        assert_eq!(frames[0], (0, "found ".to_string()));
        assert_eq!(frames[1], (0, "it".to_string()));
        assert_eq!(frames[2].0, 1);
    }

    #[tokio::test]
    async fn the_grants_model_list_and_allow_clause_both_gate_the_model() {
        let store = GrantStore::shared();
        let p = InferenceProvider::new(store.clone(), echo_providers(None));
        let token = grant(&store, &["echo"], r#"call.args.request.model == "echo""#);
        assert!(p
            .complete((), token.clone(), request("echo-large", "x", 0))
            .await
            .unwrap()
            .is_err());
        assert!(p
            .complete((), token.clone(), request("echo", "x", 0))
            .await
            .unwrap()
            .is_ok());
        // Any model by the grant, but the clause narrows it.
        let token = grant(&store, &[], r#"call.args.request.model == "echo""#);
        let denied = p
            .complete((), token.clone(), request("echo-large", "x", 0))
            .await
            .unwrap();
        assert!(denied.err().expect("denied").contains("out of scope"));
        // `models` lists only what the grant covers.
        let listed = p
            .models((), grant(&store, &["echo-large"], "true"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].model, "echo-large");
    }

    #[tokio::test]
    async fn a_budget_clause_denies_once_the_grant_has_spent_enough() {
        let store = GrantStore::shared();
        let p = InferenceProvider::new(store.clone(), echo_providers(None));
        let token = grant(
            &store,
            &["echo"],
            "state.tokens + call.args.request.max_tokens <= 6",
        );
        let s = p
            .complete((), token.clone(), request("echo", "one two", 2))
            .await
            .unwrap()
            .expect("first call fits");
        let _ = collect(s).await; // charges 2 + 2 = 4
                                  // 4 spent + 2 requested = 6: still allowed.
        let s = p
            .complete((), token.clone(), request("echo", "one two", 2))
            .await
            .unwrap()
            .expect("second call fits");
        let _ = collect(s).await; // 8 spent
        let denied = p
            .complete((), token.clone(), request("echo", "one", 1))
            .await
            .unwrap();
        assert!(
            denied.err().expect("denied").contains("out of scope"),
            "budget exhausted"
        );
    }

    #[tokio::test]
    async fn day_tokens_persist_across_grants_through_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let source = ezdb::KeySource::File(dir.path().join("k"));
        let db = crate::store::Store::open_with(dir.path().join("icanhaz.db"), &source)
            .await
            .unwrap();
        let store = GrantStore::shared();
        let p = InferenceProvider::new(store.clone(), echo_providers(Some(db.clone())));

        let first = grant(&store, &["echo"], "state.day_tokens < 5");
        let s = p
            .complete((), first, request("echo", "a b c", 0))
            .await
            .unwrap()
            .expect("day fresh");
        let _ = collect(s).await; // 3 + 3 = 6 tokens today
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            Providers::day_tokens(&db, "echo", today()).await.unwrap(),
            6
        );

        // A brand-new grant sees today's spend and is refused.
        let second = grant(&store, &["echo"], "state.day_tokens < 5");
        let denied = p
            .complete((), second, request("echo", "x", 0))
            .await
            .unwrap();
        assert!(denied.err().expect("denied").contains("out of scope"));
    }
}
