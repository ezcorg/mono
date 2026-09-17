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

use crate::broker::{denied_text, AdmitCall, GrantStore};
use crate::providers::{Frame, Providers, Request};
use crate::store::today;

pub(crate) mod bindings {
    wit_bindgen_wrpc::generate!({
        world: "inference-client",
        path: "../wit",
    });
}

/// The generated wRPC **client** stub for the inference capability.
pub use bindings::icanhaz::nocap::inference as client;

#[derive(Clone)]
pub struct InferenceProvider {
    store: Arc<Mutex<GrantStore>>,
    providers: Arc<Providers>,
    /// Other brokers, for grants that proxy a remote one.
    remotes: Option<crate::remote::Remotes>,
}

impl InferenceProvider {
    pub fn new(store: Arc<Mutex<GrantStore>>, providers: Arc<Providers>) -> Self {
        Self {
            store,
            providers,
            remotes: None,
        }
    }

    pub fn with_remotes(mut self, remotes: crate::remote::Remotes) -> Self {
        self.remotes = Some(remotes);
        self
    }

    /// Stream a completion from `provider`, charging the usage frame to the
    /// grant as it passes; the stream ends with the grant.
    fn native_complete(
        &self,
        grant: &str,
        provider: &crate::providers::ProviderConfig,
        req: Request,
    ) -> crate::session::ByteStream {
        let mut frames = self.providers.complete(provider, req);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
        let grants = self.store.clone();
        let providers = self.providers.clone();
        let provider_name = provider.name.clone();
        let token = grant.to_string();
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
        let revocation = self.store.lock().unwrap().revocation(grant);
        crate::session::grant_scoped(Box::pin(UnboundedReceiverStream::new(rx)), revocation, ())
    }

    /// The raw completion and model listing (`icanhaz:nocap/providers`): for
    /// any live `inference` grant, or a component grant one was lent to. The
    /// token is resolved, the grant's model list and clauses applied
    /// (`call.args.request.model`, `call.args.request.max_tokens`, today's
    /// spend), and a grant held at another broker forwarded there.
    pub fn native_for_grants(&self) -> (crate::raw::NativeComplete, crate::raw::NativeModels) {
        let me = self.clone();
        let complete: crate::raw::NativeComplete = Arc::new(move |token, request| {
            let me = me.clone();
            Box::pin(async move {
                let (token, allowed) = {
                    let g = me.store.lock().unwrap();
                    let token = g.delegated_for(&token, "inference").ok_or_else(|| {
                        "inference denied: no inference grant for this call".to_string()
                    })?;
                    let allowed = g
                        .validate_inference(&token)
                        .map_err(|d| format!("inference denied: {d:?}"))?;
                    (token, allowed)
                };
                if !allowed.models.is_empty() && !allowed.models.contains(&request.model) {
                    return Err(format!(
                        "inference denied: this grant covers {}, not `{}`",
                        allowed.models.join(", "),
                        request.model
                    ));
                }
                let remote = me.store.lock().unwrap().remote_of(&token);
                let provider = if remote.is_none() {
                    Some(me.providers.resolve(&request.model).ok_or_else(|| {
                        format!(
                            "inference: no configured provider serves `{}`",
                            request.model
                        )
                    })?)
                } else {
                    None
                };
                if let Some(provider) = &provider {
                    me.sync_day_tokens(&token, &provider.name).await;
                }
                let admit = AdmitCall::new("complete")
                    .arg("request.model", request.model.clone())
                    .arg("request.max_tokens", i64::from(request.max_tokens));
                me.store
                    .lock()
                    .unwrap()
                    .admit(&token, admit)
                    .map_err(|d| format!("inference denied: {}", denied_text(&d)))?;
                match (remote, provider) {
                    (Some(remote), _) => me.complete_remote(&token, remote, request).await,
                    (None, Some(provider)) => {
                        Ok(me.native_complete(&token, &provider, from_client_request(request)))
                    }
                    (None, None) => unreachable!("a local grant resolves its provider"),
                }
            })
        });
        let me = self.clone();
        let models: crate::raw::NativeModels = Arc::new(move |token| {
            let me = me.clone();
            Box::pin(async move {
                let (token, allowed) = {
                    let g = me.store.lock().unwrap();
                    let token = g.delegated_for(&token, "inference").ok_or_else(|| {
                        "inference denied: no inference grant for this call".to_string()
                    })?;
                    let allowed = g
                        .validate_inference(&token)
                        .map_err(|d| format!("inference denied: {d:?}"))?;
                    (token, allowed)
                };
                let remote = me.store.lock().unwrap().remote_of(&token);
                if let Some(remote) = remote {
                    return me.models_remote(remote).await;
                }
                Ok(me
                    .providers
                    .models()
                    .into_iter()
                    .filter(|(_, model)| {
                        allowed.models.is_empty() || allowed.models.contains(model)
                    })
                    .map(|(provider, model)| crate::raw::ModelInfo { provider, model })
                    .collect())
            })
        });
        (complete, models)
    }

    /// Forward a completion to the broker that holds the real grant. The
    /// remote enforces its scope; the frames come back as they are, and the
    /// usage frame is charged here too so local budget clauses see it.
    async fn complete_remote(
        &self,
        grant: &str,
        remote: crate::broker::Remote,
        request: crate::raw::ClientRequest,
    ) -> Result<crate::session::ByteStream, String> {
        let Some(remotes) = &self.remotes else {
            return Err("inference: no peer transport for a remote grant".to_string());
        };
        let client = remotes
            .client(&remote.locator)
            .await
            .map_err(|e| format!("inference: {}: {e:#}", remote.locator))?;
        let session = client::open(&client, (), &remote.token)
            .await
            .map_err(|e| format!("inference: {}: {e:#}", remote.locator))??;
        let request = to_client(request);
        let (res, io) = client::Session::complete(&client, (), &session.as_borrow(), &request)
            .await
            .map_err(|e| format!("inference: {}: {e:#}", remote.locator))?;
        // The session served one completion; the frames come on their own stream.
        crate::remote::release(&client, AsRef::<Bytes>::as_ref(&session).clone()).await;
        if let Some(io) = io {
            tokio::spawn(async move {
                if let Err(err) = io.await {
                    tracing::debug!(?err, "remote inference io driver ended");
                }
            });
        }
        let upstream = res?;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
        let grants = self.store.clone();
        let token = grant.to_string();
        tokio::spawn(async move {
            let mut upstream = upstream;
            let mut decoder = FrameDecoder::default();
            while let Some(chunk) = upstream.next().await {
                for tokens in decoder.usage_in(&chunk) {
                    let mut g = grants.lock().unwrap();
                    g.charge(&token, "tokens", tokens);
                    g.charge(&token, "day_tokens", tokens);
                }
                if tx.send(chunk).is_err() {
                    break;
                }
            }
        });
        let revocation = self.store.lock().unwrap().revocation(grant);
        Ok(crate::session::grant_scoped(
            Box::pin(UnboundedReceiverStream::new(rx)),
            revocation,
            (),
        ))
    }

    /// The models a grant held at another broker may use, as that broker lists them.
    async fn models_remote(
        &self,
        remote: crate::broker::Remote,
    ) -> Result<Vec<crate::raw::ModelInfo>, String> {
        let Some(remotes) = &self.remotes else {
            return Err("inference: no peer transport for a remote grant".to_string());
        };
        let client = remotes
            .client(&remote.locator)
            .await
            .map_err(|e| format!("inference: {}: {e:#}", remote.locator))?;
        let session = client::open(&client, (), &remote.token)
            .await
            .map_err(|e| format!("inference: {}: {e:#}", remote.locator))??;
        let list = client::Session::models(&client, (), &session.as_borrow()).await;
        crate::remote::release(&client, AsRef::<Bytes>::as_ref(&session).clone()).await;
        let list = list.map_err(|e| format!("inference: {}: {e:#}", remote.locator))??;
        Ok(list
            .into_iter()
            .map(|m| crate::raw::ModelInfo {
                provider: m.provider,
                model: m.model,
            })
            .collect())
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

/// The raw-layer request as the wRPC client's type, for forwarding.
fn to_client(
    r: crate::raw::ClientRequest,
) -> bindings::icanhaz::nocap::inference::CompletionRequest {
    use bindings::icanhaz::nocap::inference as c;
    c::CompletionRequest {
        model: r.model,
        messages: r
            .messages
            .into_iter()
            .map(|m| c::Message {
                role: m.role,
                content: m.content,
                tool_calls: m
                    .tool_calls
                    .into_iter()
                    .map(|t| c::ToolCall {
                        id: t.id,
                        name: t.name,
                        arguments: t.arguments,
                    })
                    .collect(),
                tool_call_id: m.tool_call_id,
            })
            .collect(),
        tools: r
            .tools
            .into_iter()
            .map(|t| c::Tool {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            })
            .collect(),
        max_tokens: r.max_tokens,
        temperature: r.temperature,
        system: r.system,
    }
}

/// The raw-layer request as a provider request.
fn from_client_request(r: crate::raw::ClientRequest) -> Request {
    Request {
        model: r.model,
        messages: r
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
        tools: r
            .tools
            .into_iter()
            .map(|t| crate::providers::Tool {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            })
            .collect(),
        max_tokens: r.max_tokens,
        temperature: r.temperature,
        system: r.system,
    }
}

/// Finds usage frames (`[1][len u32 BE][json]`) in a byte stream that may
/// split frames across chunks, and yields the tokens they report.
#[derive(Default)]
struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    fn usage_in(&mut self, chunk: &[u8]) -> Vec<i64> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            if self.buf.len() < 5 {
                break;
            }
            let kind = self.buf[0];
            let len =
                u32::from_be_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
            if self.buf.len() < 5 + len {
                break;
            }
            if kind == 1 {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&self.buf[5..5 + len]) {
                    let n = v.get("input_tokens").and_then(|n| n.as_i64()).unwrap_or(0)
                        + v.get("output_tokens").and_then(|n| n.as_i64()).unwrap_or(0);
                    if n > 0 {
                        out.push(n);
                    }
                }
            }
            self.buf.drain(..5 + len);
        }
        out
    }
}
