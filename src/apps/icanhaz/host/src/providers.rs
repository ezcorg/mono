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
//! Configuration comes from the store (`providers` table) and from the
//! environment (`ICANHAZ_ANTHROPIC_API_KEY`, `ICANHAZ_OPENAI_API_KEY` with
//! `ICANHAZ_OPENAI_BASE_URL` and `ICANHAZ_OPENAI_MODELS`, `ICANHAZ_ECHO=1`);
//! environment entries let a headless daemon serve inference with no store.

use std::sync::RwLock;

use futures::Stream;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::UnboundedReceiverStream;
use wit_bindgen_wrpc::bytes::Bytes;

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

/// A completion request, provider-agnostic.
#[derive(Debug, Clone)]
pub struct Request {
    pub model: String,
    /// `(role, content)` turns; roles are `system`, `user`, `assistant`.
    pub messages: Vec<(String, String)>,
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

/// One declared configuration field: the host-side shape of
/// `ezco:ezcap/forms.input-schema`, for the consent app's provider form.
#[derive(Debug, Clone, Serialize)]
pub struct ConfigField {
    pub name: String,
    /// `str`, `secret`, or `select`.
    pub input_type: String,
    pub options: Vec<String>,
    pub description: String,
}

impl ConfigField {
    fn str(name: &str, description: &str) -> Self {
        Self {
            name: name.into(),
            input_type: "str".into(),
            options: Vec::new(),
            description: description.into(),
        }
    }
    fn secret(name: &str, description: &str) -> Self {
        Self {
            name: name.into(),
            input_type: "secret".into(),
            options: Vec::new(),
            description: description.into(),
        }
    }
    fn select(name: &str, options: &[&str], description: &str) -> Self {
        Self {
            name: name.into(),
            input_type: "select".into(),
            options: options.iter().map(|o| o.to_string()).collect(),
            description: description.into(),
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

    /// The declared configuration for one provider, as a `forms` schema the
    /// consent app renders: what a user fills in to add a backend.
    pub fn schema() -> Vec<ConfigField> {
        vec![
            ConfigField::select("kind", &["openai", "anthropic", "echo"], "Backend API: OpenAI-compatible (Ollama, LM Studio, OpenRouter, vLLM), Anthropic, or a loopback for demos."),
            ConfigField::str("base_url", "Base URL, e.g. http://127.0.0.1:11434/v1 or https://api.anthropic.com"),
            ConfigField::secret("api_key", "API key, if the backend needs one"),
            ConfigField::str("models", "Comma-separated model names this backend serves"),
        ]
    }

    /// Environment entries plus the store's configured providers (the store
    /// wins on a name clash).
    pub async fn load(store: Option<Store>) -> Self {
        let mut configs = Self::from_env();
        if let Some(store) = &store {
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
        Self::new(configs, store)
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
                    v.get("str")
                        .or_else(|| v.get("secret"))
                        .or_else(|| v.get("select"))
                        .and_then(|s| s.as_str())
                        .map(str::to_string)
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

    /// Write one provider's configuration to the store.
    pub async fn save(store: &Store, p: &ProviderConfig) -> anyhow::Result<()> {
        let owner = format!("{}{}", Self::OWNER_PREFIX, p.name);
        store
            .set_configuration(
                &owner,
                "kind",
                &serde_json::json!({"select": p.kind.as_str()}),
            )
            .await?;
        store
            .set_configuration(&owner, "base_url", &serde_json::json!({"str": p.base_url}))
            .await?;
        store
            .set_configuration(&owner, "api_key", &serde_json::json!({"secret": p.api_key}))
            .await?;
        store
            .set_configuration(
                &owner,
                "models",
                &serde_json::json!({"str": p.models.join(",")}),
            )
            .await?;
        Ok(())
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
    use super::{Frame, Request, Sink};

    pub fn run(request: &Request, tx: &Sink) -> Result<(), String> {
        let last = request
            .messages
            .iter()
            .rev()
            .find(|(role, _)| role == "user")
            .map(|(_, c)| c.clone())
            .unwrap_or_default();
        let input: u64 = request
            .messages
            .iter()
            .map(|(_, c)| c.split_whitespace().count() as u64)
            .sum();
        let mut output = 0u64;
        for word in last.split_inclusive(' ') {
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
    use super::{sse, Frame, ProviderConfig, Request, Sink};
    use futures::StreamExt as _;

    pub fn body(request: &Request) -> serde_json::Value {
        let mut messages: Vec<serde_json::Value> = Vec::new();
        if let Some(system) = &request.system {
            messages.push(serde_json::json!({"role": "system", "content": system}));
        }
        for (role, content) in &request.messages {
            messages.push(serde_json::json!({"role": role, "content": content}));
        }
        let mut body = serde_json::json!({
            "model": request.model,
            "messages": messages,
            "stream": true,
            "stream_options": {"include_usage": true},
        });
        if request.max_tokens > 0 {
            body["max_tokens"] = serde_json::json!(request.max_tokens);
        }
        if let Some(t) = request.temperature {
            body["temperature"] = serde_json::json!(t);
        }
        body
    }

    /// Frames in one `data:` payload; `[DONE]` yields nothing.
    pub fn frames(data: &str) -> Vec<Frame> {
        if data.trim() == "[DONE]" {
            return Vec::new();
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let text = v
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if !text.is_empty() {
            out.push(Frame::Text(text.to_string()));
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
        let mut body = resp.bytes_stream();
        let mut saw_usage = false;
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|e| format!("{}: {e}", provider.name))?;
            for data in parser.push(&String::from_utf8_lossy(&chunk)) {
                for frame in frames(&data) {
                    saw_usage |= matches!(frame, Frame::Usage { .. });
                    if tx.send(frame).is_err() {
                        return Ok(());
                    }
                }
            }
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
    use super::{sse, Frame, ProviderConfig, Request, Sink};
    use futures::StreamExt as _;

    pub fn body(request: &Request) -> serde_json::Value {
        let messages: Vec<serde_json::Value> = request
            .messages
            .iter()
            .filter(|(role, _)| role != "system")
            .map(|(role, content)| serde_json::json!({"role": role, "content": content}))
            .collect();
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
        let system: Vec<&str> = request
            .system
            .iter()
            .map(String::as_str)
            .chain(
                request
                    .messages
                    .iter()
                    .filter(|(r, _)| r == "system")
                    .map(|(_, c)| c.as_str()),
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
    /// `Usage` frame emitted at `message_stop`.
    #[derive(Default)]
    pub struct State {
        input: u64,
        output: u64,
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
            Some("content_block_delta") => v
                .pointer("/delta/text")
                .and_then(|t| t.as_str())
                .filter(|t| !t.is_empty())
                .map(|t| vec![Frame::Text(t.to_string())])
                .unwrap_or_default(),
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
        let delta = r#"{"choices":[{"delta":{"content":"Hel"}}]}"#;
        assert_eq!(openai::frames(delta), vec![Frame::Text("Hel".to_string())]);
        let usage = r#"{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#;
        assert_eq!(
            openai::frames(usage),
            vec![Frame::Usage {
                input_tokens: 7,
                output_tokens: 3
            }]
        );
        assert!(openai::frames("[DONE]").is_empty());
        let body = openai::body(&Request {
            model: "m".to_string(),
            messages: vec![("user".to_string(), "hi".to_string())],
            max_tokens: 5,
            temperature: None,
            system: Some("be brief".to_string()),
        });
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["max_tokens"], 5);
        assert_eq!(body["stream_options"]["include_usage"], true);
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
            messages: vec![
                ("system".to_string(), "rules".to_string()),
                ("user".to_string(), "hi".to_string()),
            ],
            max_tokens: 0,
            temperature: Some(0.2),
            system: None,
        });
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["system"], "rules");
        assert_eq!(body["messages"].as_array().map(Vec::len), Some(1));
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
                        ("user".to_string(), "first".to_string()),
                        ("user".to_string(), "two words".to_string()),
                    ],
                    max_tokens: 0,
                    temperature: None,
                    system: None,
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
