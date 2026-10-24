//! Inference providers: the backends the host is configured with, their
//! credentials, and streaming clients for them. A caller never sees any of
//! this; it holds a grant and names a model, and the model name picks the
//! provider.
//!
//! Two real backends and one loopback:
//! - `openai`: any OpenAI-compatible chat-completions endpoint (Ollama, LM
//!   Studio, OpenRouter, vLLM, OpenAI itself).
//! - `anthropic`: the Anthropic Messages API.
//! - `echo`: streams the last user message back, with a usage record sized to
//!   it. For demos without keys, and for tests.
//!
//! Configuration comes from the store (`inference/<name>` owners in the
//! generic `configuration` table, declared by [`Providers::declared`]) and from the
//! environment (`ICANHAZ_ANTHROPIC_API_KEY`, `ICANHAZ_OPENAI_API_KEY` with
//! `ICANHAZ_OPENAI_BASE_URL` and `ICANHAZ_OPENAI_MODELS`, `ICANHAZ_ECHO=1`);
//! environment entries let a headless daemon serve inference with no store.

use std::sync::RwLock;

use futures::Stream;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::UnboundedReceiverStream;
use wit_bindgen_wrpc::bytes::Bytes;

use crate::configuration::{Declared, Field, InputType, UserInput, Value};
use crate::store::Store;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    OpenAi,
    Anthropic,
    Echo,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "openai",
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::Echo => "echo",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "openai" => Some(ProviderKind::OpenAi),
            "anthropic" => Some(ProviderKind::Anthropic),
            "echo" => Some(ProviderKind::Echo),
            _ => None,
        }
    }
}

/// One configured backend. `api_key` is a secret: redacted in `Debug`, never
/// serialised by the daemon's own APIs.
#[derive(Clone)]
pub struct ProviderConfig {
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub api_key: String,
    /// The models this provider serves. A request names one of these.
    pub models: Vec<String>,
}

impl std::fmt::Debug for ProviderConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderConfig")
            .field("name", &self.name)
            .field("kind", &self.kind)
            .field("base_url", &self.base_url)
            .field("api_key", &"[REDACTED]")
            .field("models", &self.models)
            .finish()
    }
}

/// A tool the model may call (`inference.tool`). `parameters` is JSON Schema text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: String,
}

/// A call the model made (`inference.tool-call`). `arguments` is JSON text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// One chat turn (`inference.message`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Message {
    /// `system`, `user`, `assistant` or `tool`.
    pub role: String,
    pub content: String,
    /// Calls an `assistant` turn made.
    pub tool_calls: Vec<ToolCall>,
    /// For a `tool` turn: the call it answers.
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn new(role: &str, content: &str) -> Self {
        Message {
            role: role.to_string(),
            content: content.to_string(),
            ..Default::default()
        }
    }
}

/// A completion request, provider-agnostic.
#[derive(Debug, Clone, Default)]
pub struct Request {
    pub model: String,
    pub messages: Vec<Message>,
    /// Tools the model may call this turn.
    pub tools: Vec<Tool>,
    /// `0` = the provider's default.
    pub max_tokens: u32,
    pub temperature: Option<f32>,
    pub system: Option<String>,
}

/// One frame of a streamed completion. See `inference.wit` for the wire form.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Text(String),
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    Error(String),
    /// The model stopped to call a tool; the caller runs it and continues
    /// with a `tool` turn. A usage frame still follows.
    ToolCall(ToolCall),
}

impl Frame {
    /// `[kind: u8] [len: u32 BE] [payload]`.
    pub fn encode(&self) -> Bytes {
        let (kind, payload): (u8, String) = match self {
            Frame::Text(t) => (0, t.clone()),
            Frame::Usage {
                input_tokens,
                output_tokens,
            } => (
                1,
                format!("{{\"input_tokens\":{input_tokens},\"output_tokens\":{output_tokens}}}"),
            ),
            Frame::Error(e) => (2, e.clone()),
            Frame::ToolCall(call) => (3, serde_json::to_string(call).unwrap_or_default()),
        };
        let bytes = payload.as_bytes();
        let mut buf = Vec::with_capacity(5 + bytes.len());
        buf.push(kind);
        buf.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        buf.extend_from_slice(bytes);
        Bytes::from(buf)
    }

    /// Tokens this frame charges: the sum of a usage record, else zero.
    pub fn tokens(&self) -> i64 {
        match self {
            Frame::Usage {
                input_tokens,
                output_tokens,
            } => i64::try_from(input_tokens + output_tokens).unwrap_or(i64::MAX),
            _ => 0,
        }
    }
}

/// The configured providers and an HTTP client.
pub struct Providers {
    configs: RwLock<Vec<ProviderConfig>>,
    http: reqwest::Client,
    store: Option<Store>,
}

impl Providers {
    pub fn new(configs: Vec<ProviderConfig>, store: Option<Store>) -> Self {
        Self {
            configs: RwLock::new(configs),
            http: reqwest::Client::new(),
            store,
        }
    }

    /// The owner prefix under which providers are configured in the store:
    /// `inference/<name>` with `kind`, `base_url`, `api_key` (secret) and
    /// `models` rows, as `forms.actual-input` values.
    pub const OWNER_PREFIX: &'static str = "inference/";

    /// The configuration one backend is filled in against: the `forms` schema
    /// the consent app renders, registered in the capability registry.
    pub fn declared() -> Declared {
        Declared::new(
            "inference",
            "backend",
            vec![
                Field::new(
                    "kind",
                    InputType::Select(vec!["openai".into(), "anthropic".into(), "echo".into()]),
                    "Backend API: OpenAI-compatible (Ollama, LM Studio, OpenRouter, vLLM), Anthropic, or a loopback for demos.",
                ),
                Field::new(
                    "base_url",
                    InputType::Str,
                    "Base URL, e.g. http://127.0.0.1:11434/v1 or https://api.anthropic.com",
                )
                .optional(),
                Field::new("api_key", InputType::Secret, "API key, if the backend needs one").optional(),
                Field::new("models", InputType::Str, "Comma-separated model names this backend serves"),
            ],
        )
    }

    /// Environment entries plus the store's configured providers (the store
    /// wins on a name clash).
    pub async fn load(store: Option<Store>) -> Self {
        let providers = Self::new(Vec::new(), store);
        providers.reload().await;
        providers
    }

    /// Re-read the environment and the store, after configuration changed.
    pub async fn reload(&self) {
        let mut configs = Self::from_env();
        if let Some(store) = &self.store {
            match Self::from_store(store).await {
                Ok(rows) => {
                    for row in rows {
                        configs.retain(|c| c.name != row.name);
                        configs.push(row);
                    }
                }
                Err(e) => tracing::warn!(error = %e, "could not read providers from the store"),
            }
        }
        self.set(configs);
    }

    /// Providers from the store's `inference/<name>` configuration owners.
    pub async fn from_store(store: &Store) -> anyhow::Result<Vec<ProviderConfig>> {
        let mut out = Vec::new();
        for owner in store.owners(Self::OWNER_PREFIX).await? {
            let name = owner
                .strip_prefix(Self::OWNER_PREFIX)
                .unwrap_or(&owner)
                .to_string();
            let rows = store.configuration(&owner).await?;
            let get = |field: &str| -> Option<String> {
                rows.iter().find(|(n, _)| n == field).and_then(|(_, v)| {
                    serde_json::from_value::<Value>(v.clone())
                        .ok()
                        .and_then(|v| v.text().map(str::to_string))
                })
            };
            let Some(kind) = get("kind").and_then(|k| ProviderKind::parse(&k)) else {
                tracing::warn!(owner, "provider has no valid `kind`; skipped");
                continue;
            };
            out.push(ProviderConfig {
                name,
                kind,
                base_url: get("base_url").unwrap_or_default(),
                api_key: get("api_key").unwrap_or_default(),
                models: get("models")
                    .unwrap_or_default()
                    .split(',')
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                    .map(str::to_string)
                    .collect(),
            });
        }
        Ok(out)
    }

    /// Write one provider's configuration to the store, through the declared
    /// schema (so it is validated exactly as the consent app's form is).
    pub async fn save(store: &Store, p: &ProviderConfig) -> anyhow::Result<()> {
        let input = |name: &str, value: Value| UserInput {
            name: name.to_string(),
            value,
        };
        Self::declared()
            .set(
                store,
                &p.name,
                &[
                    input("kind", Value::Select(p.kind.as_str().to_string())),
                    input("base_url", Value::Str(p.base_url.clone())),
                    input("api_key", Value::Secret(p.api_key.clone())),
                    input("models", Value::Str(p.models.join(","))),
                ],
            )
            .await
    }

    /// Today's token spend through `provider`, from the state store.
    pub async fn day_tokens(store: &Store, provider: &str, day: i64) -> anyhow::Result<i64> {
        store
            .state_counter(Self::STATE_OWNER, &format!("budget:{provider}:{day}"))
            .await
    }

    /// Record spend through `provider` today; returns the new day total.
    pub async fn add_day_tokens(
        store: &Store,
        provider: &str,
        day: i64,
        tokens: i64,
    ) -> anyhow::Result<i64> {
        store
            .state_add(
                Self::STATE_OWNER,
                &format!("budget:{provider}:{day}"),
                tokens,
            )
            .await
    }

    /// The state owner for everything the inference capability persists.
    pub const STATE_OWNER: &'static str = "inference";

    /// Providers described by `ICANHAZ_*` environment variables.
    pub fn from_env() -> Vec<ProviderConfig> {
        let mut out = Vec::new();
        let list = |var: &str, default: &str| -> Vec<String> {
            std::env::var(var)
                .unwrap_or_else(|_| default.to_string())
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        };
        if let Ok(key) = std::env::var("ICANHAZ_ANTHROPIC_API_KEY") {
            out.push(ProviderConfig {
                name: "anthropic".to_string(),
                kind: ProviderKind::Anthropic,
                base_url: std::env::var("ICANHAZ_ANTHROPIC_BASE_URL")
                    .unwrap_or_else(|_| "https://api.anthropic.com".to_string()),
                api_key: key,
                models: list("ICANHAZ_ANTHROPIC_MODELS", "claude-haiku-4-5-20251001"),
            });
        }
        if let Ok(base_url) = std::env::var("ICANHAZ_OPENAI_BASE_URL") {
            out.push(ProviderConfig {
                name: "openai".to_string(),
                kind: ProviderKind::OpenAi,
                base_url,
                api_key: std::env::var("ICANHAZ_OPENAI_API_KEY").unwrap_or_default(),
                models: list("ICANHAZ_OPENAI_MODELS", ""),
            });
        }
        if std::env::var("ICANHAZ_ECHO").is_ok_and(|v| v == "1" || v == "true") {
            out.push(ProviderConfig {
                name: "echo".to_string(),
                kind: ProviderKind::Echo,
                base_url: String::new(),
                api_key: String::new(),
                models: vec!["echo".to_string()],
            });
        }
        out
    }

    pub fn store(&self) -> Option<&Store> {
        self.store.as_ref()
    }

    /// Every `(provider, model)` the host can serve.
    pub fn models(&self) -> Vec<(String, String)> {
        let configs = self.configs.read().unwrap_or_else(|e| e.into_inner());
        configs
            .iter()
            .flat_map(|c| c.models.iter().map(move |m| (c.name.clone(), m.clone())))
            .collect()
    }

    /// The provider that serves `model`, if any.
    pub fn resolve(&self, model: &str) -> Option<ProviderConfig> {
        let configs = self.configs.read().unwrap_or_else(|e| e.into_inner());
        configs
            .iter()
            .find(|c| c.models.iter().any(|m| m == model))
            .cloned()
    }

    /// Replace the configured set (after the store changed).
    pub fn set(&self, configs: Vec<ProviderConfig>) {
        *self.configs.write().unwrap_or_else(|e| e.into_inner()) = configs;
    }

    /// Stream a completion through `provider`. The stream always ends with
    /// either a `Usage` or an `Error` frame.
    pub fn complete(
        &self,
        provider: &ProviderConfig,
        request: Request,
    ) -> impl Stream<Item = Frame> + Send + 'static {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Frame>();
        let http = self.http.clone();
        let provider = provider.clone();
        tokio::spawn(async move {
            let result = match provider.kind {
                ProviderKind::Echo => echo::run(&request, &tx),
                ProviderKind::OpenAi => openai::run(&http, &provider, &request, &tx).await,
                ProviderKind::Anthropic => anthropic::run(&http, &provider, &request, &tx).await,
            };
            if let Err(e) = result {
                let _ = tx.send(Frame::Error(e));
            }
        });
        UnboundedReceiverStream::new(rx)
    }
}

type Sink = tokio::sync::mpsc::UnboundedSender<Frame>;

/// Server-sent events: split a byte stream into the `data:` payloads of each
/// event (multi-line `data:` joined with `\n`; comments and other fields
/// dropped).
pub mod sse {
    /// Incremental parser: feed chunks, take complete events.
    #[derive(Default)]
    pub struct Parser {
        buf: String,
    }

    impl Parser {
        pub fn push(&mut self, chunk: &str) -> Vec<String> {
            self.buf.push_str(chunk);
            let mut out = Vec::new();
            while let Some(end) = self.buf.find("\n\n") {
                let event = self.buf[..end].to_string();
                self.buf.drain(..end + 2);
                let data: Vec<&str> = event
                    .lines()
                    .filter_map(|l| l.strip_prefix("data:"))
                    .map(|d| d.strip_prefix(' ').unwrap_or(d))
                    .collect();
                if !data.is_empty() {
                    out.push(data.join("\n"));
                }
            }
            out
        }
    }
}

mod echo {
    use super::{Frame, Message, Request, Sink, ToolCall};

    /// Streams the last user turn back. With tools offered and no `tool`
    /// answer yet, it instead calls the first tool with
    /// `{"input": <last user turn>}`; once a `tool` turn is present, it
    /// streams that turn's content back. Deterministic, for tests and demos.
    pub fn run(request: &Request, tx: &Sink) -> Result<(), String> {
        let last = |role: &str| -> Option<&Message> {
            request.messages.iter().rev().find(|m| m.role == role)
        };
        let input: u64 = request
            .messages
            .iter()
            .map(|m| m.content.split_whitespace().count() as u64)
            .sum();
        let answered = last("tool");
        let reply = match (request.tools.first(), answered) {
            (Some(tool), None) => {
                let user = last("user").map(|m| m.content.as_str()).unwrap_or("");
                let call = ToolCall {
                    id: "call-1".to_string(),
                    name: tool.name.clone(),
                    arguments: serde_json::json!({ "input": user }).to_string(),
                };
                let _ = tx.send(Frame::ToolCall(call));
                let _ = tx.send(Frame::Usage {
                    input_tokens: input,
                    output_tokens: 1,
                });
                return Ok(());
            }
            (_, Some(answer)) => answer.content.clone(),
            (None, None) => last("user").map(|m| m.content.clone()).unwrap_or_default(),
        };
        let mut output = 0u64;
        for word in reply.split_inclusive(' ') {
            output += 1;
            if tx.send(Frame::Text(word.to_string())).is_err() {
                return Ok(());
            }
        }
        let _ = tx.send(Frame::Usage {
            input_tokens: input,
            output_tokens: output,
        });
        Ok(())
    }
}

mod openai {
    use super::{sse, Frame, ProviderConfig, Request, Sink, ToolCall};
    use futures::StreamExt as _;

    fn schema(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap_or_else(|_| serde_json::json!({"type": "object"}))
    }

    pub fn body(request: &Request) -> serde_json::Value {
        let mut messages: Vec<serde_json::Value> = Vec::new();
        if let Some(system) = &request.system {
            messages.push(serde_json::json!({"role": "system", "content": system}));
        }
        for m in &request.messages {
            let mut turn = serde_json::json!({"role": m.role, "content": m.content});
            if !m.tool_calls.is_empty() {
                turn["tool_calls"] = m
                    .tool_calls
                    .iter()
                    .map(|c| {
                        serde_json::json!({
                            "id": c.id,
                            "type": "function",
                            "function": {"name": c.name, "arguments": c.arguments},
                        })
                    })
                    .collect();
            }
            if let Some(id) = &m.tool_call_id {
                turn["tool_call_id"] = serde_json::json!(id);
            }
            messages.push(turn);
        }
        let mut body = serde_json::json!({
            "model": request.model,
            "messages": messages,
            "stream": true,
            "stream_options": {"include_usage": true},
        });
        if !request.tools.is_empty() {
            body["tools"] = request
                .tools
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": schema(&t.parameters),
                        },
                    })
                })
                .collect();
        }
        if request.max_tokens > 0 {
            body["max_tokens"] = serde_json::json!(request.max_tokens);
        }
        if let Some(t) = request.temperature {
            body["temperature"] = serde_json::json!(t);
        }
        body
    }

    /// Tool calls stream as deltas keyed by index (id and name first, then
    /// argument fragments); they are emitted whole when the choice finishes.
    #[derive(Default)]
    pub struct State {
        calls: Vec<ToolCall>,
    }

    /// Frames in one `data:` payload; `[DONE]` yields nothing.
    pub fn frames(state: &mut State, data: &str) -> Vec<Frame> {
        if data.trim() == "[DONE]" {
            return Vec::new();
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let choice = v.get("choices").and_then(|c| c.get(0));
        let delta = choice.and_then(|c| c.get("delta"));
        let text = delta
            .and_then(|d| d.get("content"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if !text.is_empty() {
            out.push(Frame::Text(text.to_string()));
        }
        for tc in delta
            .and_then(|d| d.get("tool_calls"))
            .and_then(|t| t.as_array())
            .into_iter()
            .flatten()
        {
            let index = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
            while state.calls.len() <= index {
                state.calls.push(ToolCall {
                    id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
                });
            }
            if let Some(call) = state.calls.get_mut(index) {
                if let Some(id) = tc.get("id").and_then(|s| s.as_str()) {
                    call.id = id.to_string();
                }
                if let Some(name) = tc.pointer("/function/name").and_then(|s| s.as_str()) {
                    call.name.push_str(name);
                }
                if let Some(args) = tc.pointer("/function/arguments").and_then(|s| s.as_str()) {
                    call.arguments.push_str(args);
                }
            }
        }
        if choice
            .and_then(|c| c.get("finish_reason"))
            .is_some_and(|r| !r.is_null())
        {
            for call in state.calls.drain(..) {
                out.push(Frame::ToolCall(call));
            }
        }
        if let Some(usage) = v.get("usage").filter(|u| !u.is_null()) {
            out.push(Frame::Usage {
                input_tokens: usage
                    .get("prompt_tokens")
                    .and_then(|n| n.as_u64())
                    .unwrap_or(0),
                output_tokens: usage
                    .get("completion_tokens")
                    .and_then(|n| n.as_u64())
                    .unwrap_or(0),
            });
        }
        out
    }

    pub async fn run(
        http: &reqwest::Client,
        provider: &ProviderConfig,
        request: &Request,
        tx: &Sink,
    ) -> Result<(), String> {
        let url = format!(
            "{}/chat/completions",
            provider.base_url.trim_end_matches('/')
        );
        let mut req = http.post(&url).json(&body(request));
        if !provider.api_key.is_empty() {
            req = req.bearer_auth(&provider.api_key);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("{}: {e}", provider.name))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("{}: HTTP {status}: {text}", provider.name));
        }
        let mut parser = sse::Parser::default();
        let mut state = State::default();
        let mut body = resp.bytes_stream();
        let mut saw_usage = false;
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|e| format!("{}: {e}", provider.name))?;
            for data in parser.push(&String::from_utf8_lossy(&chunk)) {
                for frame in frames(&mut state, &data) {
                    saw_usage |= matches!(frame, Frame::Usage { .. });
                    if tx.send(frame).is_err() {
                        return Ok(());
                    }
                }
            }
        }
        // Calls never finalised by a finish_reason still go out before usage.
        for call in state.calls.drain(..) {
            let _ = tx.send(Frame::ToolCall(call));
        }
        if !saw_usage {
            // A server without `stream_options` support: charge nothing rather
            // than guess, but still terminate the stream properly.
            let _ = tx.send(Frame::Usage {
                input_tokens: 0,
                output_tokens: 0,
            });
        }
        Ok(())
    }
}

mod anthropic {
    use super::{sse, Frame, ProviderConfig, Request, Sink, ToolCall};
    use futures::StreamExt as _;

    fn json_or_object(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap_or_else(|_| serde_json::json!({}))
    }

    pub fn body(request: &Request) -> serde_json::Value {
        let mut messages: Vec<serde_json::Value> = Vec::new();
        for m in request.messages.iter().filter(|m| m.role != "system") {
            let turn = match m.role.as_str() {
                // A tool's answer is a `tool_result` block on a user turn.
                "tool" => serde_json::json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                        "content": m.content,
                    }],
                }),
                "assistant" if !m.tool_calls.is_empty() => {
                    let mut blocks: Vec<serde_json::Value> = Vec::new();
                    if !m.content.is_empty() {
                        blocks.push(serde_json::json!({"type": "text", "text": m.content}));
                    }
                    for c in &m.tool_calls {
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": c.id,
                            "name": c.name,
                            "input": json_or_object(&c.arguments),
                        }));
                    }
                    serde_json::json!({"role": "assistant", "content": blocks})
                }
                _ => serde_json::json!({"role": m.role, "content": m.content}),
            };
            messages.push(turn);
        }
        // Anthropic requires max_tokens; a request that left it to the provider
        // gets a sensible bound rather than a 400.
        let max_tokens = if request.max_tokens == 0 {
            1024
        } else {
            request.max_tokens
        };
        let mut body = serde_json::json!({
            "model": request.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": true,
        });
        if !request.tools.is_empty() {
            body["tools"] = request
                .tools
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": serde_json::from_str::<serde_json::Value>(&t.parameters)
                            .unwrap_or_else(|_| serde_json::json!({"type": "object"})),
                    })
                })
                .collect();
        }
        let system: Vec<&str> = request
            .system
            .iter()
            .map(String::as_str)
            .chain(
                request
                    .messages
                    .iter()
                    .filter(|m| m.role == "system")
                    .map(|m| m.content.as_str()),
            )
            .collect();
        if !system.is_empty() {
            body["system"] = serde_json::json!(system.join("\n\n"));
        }
        if let Some(t) = request.temperature {
            body["temperature"] = serde_json::json!(t);
        }
        body
    }

    /// Frames in one event payload. Input tokens arrive on `message_start`,
    /// output tokens on `message_delta`; both are combined into the single
    /// `Usage` frame emitted at `message_stop`. A `tool_use` block starts
    /// with its id and name, streams `input_json_delta` fragments, and is
    /// emitted whole at `content_block_stop`.
    #[derive(Default)]
    pub struct State {
        input: u64,
        output: u64,
        call: Option<ToolCall>,
    }

    pub fn frames(state: &mut State, data: &str) -> Vec<Frame> {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
            return Vec::new();
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("message_start") => {
                state.input = v
                    .pointer("/message/usage/input_tokens")
                    .and_then(|n| n.as_u64())
                    .unwrap_or(0);
                Vec::new()
            }
            Some("content_block_start") => {
                if v.pointer("/content_block/type").and_then(|t| t.as_str()) == Some("tool_use") {
                    state.call = Some(ToolCall {
                        id: v
                            .pointer("/content_block/id")
                            .and_then(|s| s.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        name: v
                            .pointer("/content_block/name")
                            .and_then(|s| s.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        arguments: String::new(),
                    });
                }
                Vec::new()
            }
            Some("content_block_delta") => {
                if let Some(json) = v.pointer("/delta/partial_json").and_then(|t| t.as_str()) {
                    if let Some(call) = state.call.as_mut() {
                        call.arguments.push_str(json);
                    }
                    return Vec::new();
                }
                v.pointer("/delta/text")
                    .and_then(|t| t.as_str())
                    .filter(|t| !t.is_empty())
                    .map(|t| vec![Frame::Text(t.to_string())])
                    .unwrap_or_default()
            }
            Some("content_block_stop") => match state.call.take() {
                Some(mut call) => {
                    if call.arguments.is_empty() {
                        call.arguments = "{}".to_string();
                    }
                    vec![Frame::ToolCall(call)]
                }
                None => Vec::new(),
            },
            Some("message_delta") => {
                if let Some(n) = v.pointer("/usage/output_tokens").and_then(|n| n.as_u64()) {
                    state.output = n;
                }
                Vec::new()
            }
            Some("message_stop") => vec![Frame::Usage {
                input_tokens: state.input,
                output_tokens: state.output,
            }],
            Some("error") => vec![Frame::Error(
                v.pointer("/error/message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("provider error")
                    .to_string(),
            )],
            _ => Vec::new(),
        }
    }

    pub async fn run(
        http: &reqwest::Client,
        provider: &ProviderConfig,
        request: &Request,
        tx: &Sink,
    ) -> Result<(), String> {
        let url = format!("{}/v1/messages", provider.base_url.trim_end_matches('/'));
        let resp = http
            .post(&url)
            .header("x-api-key", &provider.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body(request))
            .send()
            .await
            .map_err(|e| format!("{}: {e}", provider.name))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("{}: HTTP {status}: {text}", provider.name));
        }
        let mut parser = sse::Parser::default();
        let mut state = State::default();
        let mut body = resp.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|e| format!("{}: {e}", provider.name))?;
            for data in parser.push(&String::from_utf8_lossy(&chunk)) {
                for frame in frames(&mut state, &data) {
                    let done = matches!(frame, Frame::Usage { .. } | Frame::Error(_));
                    if tx.send(frame).is_err() || done {
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt as _;

    #[test]
    fn sse_parser_splits_events_and_joins_data_lines() {
        let mut p = sse::Parser::default();
        assert!(p.push("event: ping\n\n").is_empty());
        let got = p.push("data: a\ndata: b\n\ndata: [DO");
        assert_eq!(got, vec!["a\nb"]);
        assert_eq!(p.push("NE]\n\n"), vec!["[DONE]"]);
    }

    #[test]
    fn openai_frames_carry_text_and_usage() {
        let mut st = openai::State::default();
        let delta = r#"{"choices":[{"delta":{"content":"Hel"}}]}"#;
        assert_eq!(
            openai::frames(&mut st, delta),
            vec![Frame::Text("Hel".to_string())]
        );
        let usage = r#"{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#;
        assert_eq!(
            openai::frames(&mut st, usage),
            vec![Frame::Usage {
                input_tokens: 7,
                output_tokens: 3
            }]
        );
        assert!(openai::frames(&mut st, "[DONE]").is_empty());
        let body = openai::body(&Request {
            model: "m".to_string(),
            messages: vec![Message::new("user", "hi")],
            max_tokens: 5,
            system: Some("be brief".to_string()),
            ..Default::default()
        });
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["max_tokens"], 5);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn openai_tool_calls_accumulate_by_index_and_flush_on_finish() {
        let mut st = openai::State::default();
        let a = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search","arguments":"{\"q\":"}}]}}]}"#;
        assert!(openai::frames(&mut st, a).is_empty());
        let b = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]}}]}"#;
        assert!(openai::frames(&mut st, b).is_empty());
        let fin = r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#;
        assert_eq!(
            openai::frames(&mut st, fin),
            vec![Frame::ToolCall(ToolCall {
                id: "c1".into(),
                name: "search".into(),
                arguments: r#"{"q":"x"}"#.into(),
            })]
        );
        // The request side: tools, an assistant turn with calls, a tool answer.
        let body = openai::body(&Request {
            model: "m".to_string(),
            tools: vec![Tool {
                name: "search".into(),
                description: "find".into(),
                parameters: r#"{"type":"object","properties":{"q":{"type":"string"}}}"#.into(),
            }],
            messages: vec![
                Message::new("user", "find x"),
                Message {
                    role: "assistant".into(),
                    tool_calls: vec![ToolCall {
                        id: "c1".into(),
                        name: "search".into(),
                        arguments: r#"{"q":"x"}"#.into(),
                    }],
                    ..Default::default()
                },
                Message {
                    role: "tool".into(),
                    content: "found".into(),
                    tool_call_id: Some("c1".into()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        assert_eq!(body["tools"][0]["function"]["parameters"]["type"], "object");
        assert_eq!(
            body["messages"][1]["tool_calls"][0]["function"]["name"],
            "search"
        );
        assert_eq!(body["messages"][2]["tool_call_id"], "c1");
        let f = Frame::ToolCall(ToolCall {
            id: "c1".into(),
            name: "n".into(),
            arguments: "{}".into(),
        })
        .encode();
        assert_eq!(f[0], 3);
    }

    #[test]
    fn anthropic_frames_accumulate_usage_until_stop() {
        let mut st = anthropic::State::default();
        assert!(anthropic::frames(
            &mut st,
            r#"{"type":"message_start","message":{"usage":{"input_tokens":11}}}"#
        )
        .is_empty());
        assert_eq!(
            anthropic::frames(
                &mut st,
                r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}"#
            ),
            vec![Frame::Text("Hi".to_string())]
        );
        assert!(anthropic::frames(
            &mut st,
            r#"{"type":"message_delta","usage":{"output_tokens":4}}"#
        )
        .is_empty());
        assert_eq!(
            anthropic::frames(&mut st, r#"{"type":"message_stop"}"#),
            vec![Frame::Usage {
                input_tokens: 11,
                output_tokens: 4
            }]
        );
        let body = anthropic::body(&Request {
            model: "m".to_string(),
            messages: vec![Message::new("system", "rules"), Message::new("user", "hi")],
            max_tokens: 0,
            temperature: Some(0.2),
            ..Default::default()
        });
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["system"], "rules");
        assert_eq!(body["messages"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn anthropic_tool_use_blocks_become_tool_call_frames_and_turns() {
        let mut st = anthropic::State::default();
        let start = r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"search","input":{}}}"#;
        assert!(anthropic::frames(&mut st, start).is_empty());
        let d1 = r#"{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"q\""}}"#;
        let d2 = r#"{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":":\"x\"}"}}"#;
        assert!(anthropic::frames(&mut st, d1).is_empty());
        assert!(anthropic::frames(&mut st, d2).is_empty());
        assert_eq!(
            anthropic::frames(&mut st, r#"{"type":"content_block_stop","index":1}"#),
            vec![Frame::ToolCall(ToolCall {
                id: "tu1".into(),
                name: "search".into(),
                arguments: r#"{"q":"x"}"#.into(),
            })]
        );
        let body = anthropic::body(&Request {
            model: "m".to_string(),
            tools: vec![Tool {
                name: "search".into(),
                description: "find".into(),
                parameters: r#"{"type":"object"}"#.into(),
            }],
            messages: vec![
                Message::new("user", "find x"),
                Message {
                    role: "assistant".into(),
                    tool_calls: vec![ToolCall {
                        id: "tu1".into(),
                        name: "search".into(),
                        arguments: r#"{"q":"x"}"#.into(),
                    }],
                    ..Default::default()
                },
                Message {
                    role: "tool".into(),
                    content: "found".into(),
                    tool_call_id: Some("tu1".into()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(body["messages"][1]["content"][0]["input"]["q"], "x");
        assert_eq!(body["messages"][2]["role"], "user");
        assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "tu1");
    }

    #[test]
    fn frames_encode_with_a_kind_and_length_prefix() {
        let f = Frame::Text("héllo".to_string()).encode();
        assert_eq!(f[0], 0);
        assert_eq!(u32::from_be_bytes([f[1], f[2], f[3], f[4]]), 6);
        assert_eq!(&f[5..], "héllo".as_bytes());
        let u = Frame::Usage {
            input_tokens: 1,
            output_tokens: 2,
        };
        assert_eq!(u.tokens(), 3);
        assert_eq!(u.encode()[0], 1);
    }

    #[tokio::test]
    async fn echo_streams_the_last_user_turn_and_a_usage_frame() {
        let providers = Providers::new(
            vec![ProviderConfig {
                name: "echo".to_string(),
                kind: ProviderKind::Echo,
                base_url: String::new(),
                api_key: String::new(),
                models: vec!["echo".to_string()],
            }],
            None,
        );
        let provider = providers.resolve("echo").expect("configured");
        let frames: Vec<Frame> = providers
            .complete(
                &provider,
                Request {
                    model: "echo".to_string(),
                    messages: vec![
                        Message::new("user", "first"),
                        Message::new("user", "two words"),
                    ],
                    max_tokens: 0,
                    temperature: None,
                    system: None,
                    ..Default::default()
                },
            )
            .collect()
            .await;
        assert_eq!(
            frames,
            vec![
                Frame::Text("two ".to_string()),
                Frame::Text("words".to_string()),
                Frame::Usage {
                    input_tokens: 3,
                    output_tokens: 2
                }
            ]
        );
        assert!(providers.resolve("nope").is_none());
    }
}
