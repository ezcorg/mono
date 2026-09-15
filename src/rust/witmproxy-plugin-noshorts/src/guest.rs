//! The component: WIT bindings, the manifest, and event handling.

use std::cell::RefCell;
use std::rc::Rc;

use wit_bindgen::StreamResult;

use crate::config::{InputKind, Settings, Value, schema};
use crate::pages::{PageFacts, agent_page, blocked_page, body_injection, head_injection};
use crate::policy::{
    AGENT_PREFIX, AgentRoute, Ledger, PathKind, Reason, classify_path, decide, time_verdict,
};
use crate::rewrite::{charset_of, injecting_rewriter};
use crate::score::score_title;
use crate::time::LocalTime;

wit_bindgen::generate!({
    world: "witmproxy:plugin/plugin",
    path: "../../apps/witmproxy/wit",
    generate_all
});

use self::ezco::ezcap::types::Scope;

use exports::witmproxy::plugin::witm_plugin::{
    ActualInput, Capability, CapabilityProvider, ConfigureError, Guest, GuestPlugin, InputSchema,
    InputType, Plugin as PluginResource, PluginError, PluginManifest, UserInput,
};
use wasi::http::types::{Fields, Method, Scheme};
use witmproxy::plugin::capabilities::{
    CapabilityKind, ClockClient, Content, ContextualResponse, Event, EventKind, LocalStorageClient,
    Request, RequestContext, Response,
};

const PUBLIC_KEY_BYTES: &[u8] = include_bytes!("../key.public");

/// The hosts this plugin is interested in, as a CEL fragment over `host`.
fn host_scope(var: &str) -> String {
    format!(
        "({var}.endsWith('youtube.com') || {var}.endsWith('youtu.be') || {var}.endsWith('youtube-nocookie.com'))"
    )
}

struct Component;

impl Guest for Component {
    type Plugin = PluginInstance;

    async fn manifest() -> PluginManifest {
        let configuration = schema()
            .into_iter()
            .map(|spec| InputSchema {
                name: spec.name.to_string(),
                input_type: match spec.kind {
                    InputKind::Str => InputType::Str,
                    InputKind::Bool => InputType::Boolean,
                    InputKind::Num => InputType::Number,
                },
                optional: true,
                default: Some(match spec.default {
                    Value::Str(s) => ActualInput::Str(s),
                    Value::Bool(b) => ActualInput::Boolean(b),
                    Value::Num(n) => ActualInput::Number(n),
                }),
                description: Some(spec.description.to_string()),
            })
            .collect();

        PluginManifest {
            name: "noshorts".to_string(),
            namespace: "witmproxy".to_string(),
            author: "Theodore Brockman".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            description: env!("CARGO_PKG_DESCRIPTION").to_string(),
            metadata: vec![],
            capabilities: vec![
                Capability {
                    kind: CapabilityKind::Logger,
                    scope: Scope {
                        when: "true".into(),
                        allow: "true".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::LocalStorage,
                    scope: Scope {
                        when: "true".into(),
                        allow: "true".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::Clock,
                    scope: Scope {
                        when: "true".into(),
                        allow: "true".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Connect),
                    scope: Scope {
                        when: host_scope("connect.host()"),
                        allow: "true".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::Request),
                    scope: Scope {
                        when: host_scope("request.host()"),
                        allow: "true".into(),
                    },
                },
                Capability {
                    kind: CapabilityKind::HandleEvent(EventKind::InboundContent),
                    scope: Scope {
                        when: format!(
                            "content.content_type().startsWith('text/html') && !request.path().startsWith('{AGENT_PREFIX}') && {}",
                            host_scope("request.host()")
                        ),
                        allow: "true".into(),
                    },
                },
            ],
            license: env!("CARGO_PKG_LICENSE").to_string(),
            url: "https://witmproxy.rs".to_string(),
            publickey: PUBLIC_KEY_BYTES.to_vec(),
            configuration,
        }
    }
}

struct PluginInstance {
    settings: Settings,
}

impl GuestPlugin for PluginInstance {
    async fn create(config: Vec<UserInput>) -> Result<PluginResource, ConfigureError> {
        let inputs: Vec<(String, Value)> = config
            .into_iter()
            .filter_map(|input| {
                let value = match input.value {
                    ActualInput::Str(s) | ActualInput::Select(s) | ActualInput::Datetime(s) => {
                        Value::Str(s)
                    }
                    ActualInput::Boolean(b) => Value::Bool(b),
                    ActualInput::Number(n) => Value::Num(n),
                    _ => return None,
                };
                Some((input.name, value))
            })
            .collect();
        let settings = Settings::from_inputs(&inputs).map_err(ConfigureError::Other)?;
        Ok(PluginResource::new(PluginInstance { settings }))
    }

    async fn handle(
        &self,
        ev: Event,
        cap: CapabilityProvider,
    ) -> Result<Option<Event>, PluginError> {
        match ev {
            Event::Request(req) => self.on_request(req, &cap).await,
            Event::InboundContent(content) => self.on_content(content, &cap).await,
            other => Ok(Some(other)),
        }
    }
}

// --- per-event host access --------------------------------------------------

/// The clock and storage the plugin needs for any decision, plus the local
/// time they yield. Fetched once per event.
struct Host {
    clock: ClockClient,
    storage: LocalStorageClient,
    now: LocalTime,
}

impl Host {
    async fn acquire(cap: &CapabilityProvider, settings: &Settings) -> Result<Self, PluginError> {
        let clock = cap
            .clock()
            .await
            .ok_or(PluginError::CapabilityUnavailable(CapabilityKind::Clock))?;
        let storage = cap
            .local_storage()
            .await
            .ok_or(PluginError::CapabilityUnavailable(
                CapabilityKind::LocalStorage,
            ))?;
        let epoch = clock
            .now_seconds()
            .await
            .map_err(|_| PluginError::CapabilityUnavailable(CapabilityKind::Clock))?;
        let offset = match settings.utc_offset_override_secs {
            Some(o) => o,
            None => clock
                .utc_offset_seconds()
                .await
                .map_err(|_| PluginError::CapabilityUnavailable(CapabilityKind::Clock))?,
        };
        Ok(Host {
            clock,
            storage,
            now: LocalTime::new(epoch, offset),
        })
    }

    fn ledger_key(day: &str) -> String {
        format!("ledger:{day}")
    }

    async fn load_ledger(&self) -> Ledger {
        match self
            .storage
            .get(Self::ledger_key(&self.now.date_string()))
            .await
            .ok()
            .flatten()
        {
            Some(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            None => Ledger::default(),
        }
    }

    async fn save_ledger(&self, ledger: &Ledger) {
        let bytes = serde_json::to_vec(ledger).unwrap_or_default();
        // A refused or over-quota write is not fatal to the page: the ledger
        // simply does not advance.
        let _ = self
            .storage
            .set(Self::ledger_key(&self.now.date_string()), bytes)
            .await;
        // Yesterday's entry is never read again; keep the store to one key.
        let yesterday = LocalTime::new(
            self.now
                .epoch_secs()
                .saturating_sub(crate::time::SECS_PER_DAY as u64),
            self.now.offset_secs(),
        );
        let _ = self
            .storage
            .delete(Self::ledger_key(&yesterday.date_string()))
            .await;
    }
}

async fn log_info(cap: &CapabilityProvider, msg: String) {
    if let Some(logger) = cap.logger().await {
        let _ = logger.info(format!("[noshorts] {msg}")).await;
    }
}

// --- request handling ---------------------------------------------------------

impl PluginInstance {
    async fn on_request(
        &self,
        req: Request,
        cap: &CapabilityProvider,
    ) -> Result<Option<Event>, PluginError> {
        let ctx = request_context(&req);
        if !self.settings.is_managed_host(&ctx.host) {
            return Ok(Some(Event::Request(req)));
        }
        let kind = classify_path(&ctx.path);
        let host = Host::acquire(cap, &self.settings).await?;
        let mut ledger = host.load_ledger().await;

        if let PathKind::Agent(route) = kind {
            let response = self.serve_agent(route, req, &ctx, &host, &mut ledger).await;
            return Ok(Some(Event::Response(ContextualResponse {
                response,
                request: ctx,
            })));
        }

        match decide(&self.settings, &host.now, kind, ledger.used_secs) {
            None => Ok(Some(Event::Request(req))),
            Some(reason) => {
                log_info(
                    cap,
                    format!(
                        "blocked {} {}{} ({})",
                        ctx.method,
                        ctx.host,
                        ctx.path,
                        reason.code()
                    ),
                )
                .await;
                let response = if wants_html(&ctx) {
                    let page = blocked_page(
                        &reason,
                        &PageFacts {
                            now: &host.now,
                            settings: &self.settings,
                            used_secs: ledger.used_secs,
                            embedded: false,
                        },
                    );
                    html_response(403, page, Some(reason.code()))
                } else {
                    json_response(
                        403,
                        serde_json::json!({ "blocked": true, "reason": reason.code() }),
                        Some(reason.code()),
                    )
                };
                Ok(Some(Event::Response(ContextualResponse {
                    response,
                    request: ctx,
                })))
            }
        }
    }

    async fn serve_agent(
        &self,
        route: AgentRoute,
        req: Request,
        ctx: &RequestContext,
        host: &Host,
        ledger: &mut Ledger,
    ) -> Response {
        let s = &self.settings;
        match route {
            AgentRoute::Agent => html_response(200, agent_page(s), None),
            AgentRoute::Tick => {
                let active = query_value(ctx, "active").is_some_and(|v| v == "1" || v == "true");
                let dt: u64 = query_value(ctx, "dt")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(s.heartbeat_secs);
                let credited = if active {
                    let now_ms = host.clock.now_millis().await.unwrap_or_default();
                    let c = ledger.credit(now_ms, dt, s.heartbeat_secs);
                    if c > 0 {
                        host.save_ledger(ledger).await;
                    }
                    c
                } else {
                    0
                };
                let verdict = time_verdict(s, &host.now, ledger.used_secs);
                json_response(
                    200,
                    serde_json::json!({
                        "blocked": verdict.is_some(),
                        "reason": verdict.as_ref().map(Reason::code),
                        "credited": credited,
                        "used_seconds": ledger.used_secs,
                        "budget_seconds": s.daily_budget_secs,
                        "remaining_seconds": ledger.remaining(s.daily_budget_secs),
                    }),
                    None,
                )
            }
            AgentRoute::Score => {
                let body = read_body(req).await;
                let items = serde_json::from_slice::<ScoreRequest>(&body)
                    .map(|r| r.items)
                    .unwrap_or_default();
                let scored: Vec<serde_json::Value> = items
                    .into_iter()
                    .map(|item| {
                        let v = score_title(&item.title, &s.filter_keywords);
                        serde_json::json!({
                            "id": item.id,
                            "score": v.score,
                            "hide": s.filter_enabled && v.score >= s.filter_threshold,
                            "reasons": v.reasons,
                        })
                    })
                    .collect();
                json_response(200, serde_json::json!({ "items": scored }), None)
            }
            AgentRoute::Blocked => {
                let reason = match query_value(ctx, "reason").as_deref() {
                    Some("shorts") => Reason::Shorts,
                    Some("work-hours") => Reason::WorkHours {
                        until: s.work_window.end_hhmm(),
                        now: host.now.hhmm(),
                    },
                    Some("budget") => Reason::Budget {
                        used_secs: ledger.used_secs,
                        budget_secs: s.daily_budget_secs,
                        resets_in_secs: host.now.secs_until_midnight(),
                    },
                    _ => time_verdict(s, &host.now, ledger.used_secs).unwrap_or(Reason::Shorts),
                };
                let embedded = query_value(ctx, "embedded").is_some();
                let page = blocked_page(
                    &reason,
                    &PageFacts {
                        now: &host.now,
                        settings: s,
                        used_secs: ledger.used_secs,
                        embedded,
                    },
                );
                html_response(403, page, Some(reason.code()))
            }
            AgentRoute::Status => {
                let verdict = time_verdict(s, &host.now, ledger.used_secs);
                json_response(
                    200,
                    serde_json::json!({
                        "date": host.now.date_string(),
                        "local_time": host.now.hhmm(),
                        "weekday": host.now.weekday(),
                        "utc_offset_seconds": host.now.offset_secs(),
                        "blocked": verdict.is_some(),
                        "reason": verdict.as_ref().map(Reason::code),
                        "used_seconds": ledger.used_secs,
                        "budget_seconds": s.daily_budget_secs,
                        "remaining_seconds": ledger.remaining(s.daily_budget_secs),
                        "work_hours": format!("{}-{}", s.work_window.start_hhmm(), s.work_window.end_hhmm()),
                        "work_day_today": s.work_days.contains(host.now.weekday()),
                        "block_shorts": s.block_shorts,
                        "filter_enabled": s.filter_enabled,
                        "version": env!("CARGO_PKG_VERSION"),
                    }),
                    None,
                )
            }
        }
    }

    // --- content handling ---------------------------------------------------

    async fn on_content(
        &self,
        content: Content,
        _cap: &CapabilityProvider,
    ) -> Result<Option<Event>, PluginError> {
        let ctx = content.request_context().await;
        // The scope expression excludes these already; a user-edited scope
        // must not be able to make the agent frame nest inside itself.
        if ctx.path.starts_with(AGENT_PREFIX) {
            return Ok(Some(Event::InboundContent(content)));
        }
        let head = head_injection(&self.settings);
        let body = body_injection();
        let encoding = charset_of(&content.content_type().await);

        let (mut stream, content) = Content::consume_body(content).await;
        let (mut tx, rx) = wit_stream::new();

        // lol_html delivers output synchronously into a sink; the sink fills
        // a buffer that the task drains into the async stream between writes.
        let pending: Rc<RefCell<Vec<u8>>> = Rc::new(RefCell::new(Vec::new()));
        let sink_buf = Rc::clone(&pending);
        let rewriter = injecting_rewriter(encoding, head, body, move |chunk: &[u8]| {
            sink_buf.borrow_mut().extend_from_slice(chunk)
        });

        wit_bindgen::spawn_local(async move {
            let mut rewriter = rewriter;
            let mut chunk: Vec<u8> = Vec::with_capacity(64 * 1024);
            loop {
                let (status, buf) = stream.read(chunk).await;
                chunk = buf;
                match status {
                    StreamResult::Complete(n) => {
                        if n == 0 {
                            chunk.clear();
                            continue;
                        }
                        match rewriter.as_mut() {
                            Some(rw) => {
                                if rw.write(&chunk[..n]).is_err() {
                                    break;
                                }
                            }
                            None => pending.borrow_mut().extend_from_slice(&chunk[..n]),
                        }
                        chunk.clear();
                        if !flush(&pending, &mut tx).await {
                            return;
                        }
                    }
                    StreamResult::Dropped | StreamResult::Cancelled => break,
                }
            }
            if let Some(rw) = rewriter.take() {
                let _ = rw.end();
            }
            flush(&pending, &mut tx).await;
            drop(tx);
        });

        content.set_body(rx).await;
        Ok(Some(Event::InboundContent(content)))
    }
}

/// Moves whatever the rewriter produced into the outgoing stream. `false`
/// when the reader has gone away.
async fn flush(
    pending: &Rc<RefCell<Vec<u8>>>,
    tx: &mut wit_bindgen::rt::async_support::StreamWriter<u8>,
) -> bool {
    let data = std::mem::take(&mut *pending.borrow_mut());
    if data.is_empty() {
        return true;
    }
    let mut remaining = data;
    while !remaining.is_empty() {
        let before = remaining.len();
        remaining = tx.write_all(remaining).await;
        if remaining.len() == before {
            // Nothing was accepted: the other side is gone.
            return false;
        }
    }
    true
}

// --- wire helpers --------------------------------------------------------------

#[derive(serde::Deserialize)]
struct ScoreRequest {
    #[serde(default)]
    items: Vec<ScoreItem>,
}

#[derive(serde::Deserialize)]
struct ScoreItem {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
}

/// A request's context, as the host would describe it, built from the
/// guest-side resource so it can travel with a synthesised response.
fn request_context(req: &Request) -> RequestContext {
    let method = match req.get_method() {
        Method::Get => "GET".to_string(),
        Method::Head => "HEAD".to_string(),
        Method::Post => "POST".to_string(),
        Method::Put => "PUT".to_string(),
        Method::Delete => "DELETE".to_string(),
        Method::Connect => "CONNECT".to_string(),
        Method::Options => "OPTIONS".to_string(),
        Method::Trace => "TRACE".to_string(),
        Method::Patch => "PATCH".to_string(),
        Method::Other(m) => m,
    };
    let scheme = match req.get_scheme() {
        Some(Scheme::Http) => "http".to_string(),
        Some(Scheme::Https) | None => "https".to_string(),
        Some(Scheme::Other(s)) => s,
    };
    let host = req.get_authority().unwrap_or_default();
    let path_with_query = req.get_path_with_query().unwrap_or_else(|| "/".to_string());
    let (path, query_str) = match path_with_query.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (path_with_query.clone(), String::new()),
    };
    let query = group(
        form_urlencoded::parse(query_str.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())),
    );
    let headers = group(
        req.get_headers()
            .copy_all()
            .into_iter()
            .map(|(k, v)| (k, String::from_utf8_lossy(&v).into_owned())),
    );
    RequestContext {
        scheme,
        host,
        path,
        query,
        method,
        headers,
    }
}

fn group(pairs: impl Iterator<Item = (String, String)>) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for (k, v) in pairs {
        let k = k.to_ascii_lowercase();
        match out.iter_mut().find(|(name, _)| *name == k) {
            Some((_, values)) => values.push(v),
            None => out.push((k, vec![v])),
        }
    }
    out
}

fn query_value(ctx: &RequestContext, name: &str) -> Option<String> {
    ctx.query
        .iter()
        .find(|(k, _)| k == name)
        .and_then(|(_, v)| v.first().cloned())
}

fn header_value<'a>(ctx: &'a RequestContext, name: &str) -> Option<&'a str> {
    ctx.headers
        .iter()
        .find(|(k, _)| k == name)
        .and_then(|(_, v)| v.first().map(String::as_str))
}

/// Whether the client will render an HTML body: a navigation, a frame, or
/// anything that says it accepts HTML.
fn wants_html(ctx: &RequestContext) -> bool {
    if let Some(dest) = header_value(ctx, "sec-fetch-dest") {
        return matches!(dest, "document" | "iframe" | "frame" | "embed" | "object");
    }
    header_value(ctx, "accept").is_some_and(|a| a.contains("text/html"))
}

async fn read_body(req: Request) -> Vec<u8> {
    let (_done_tx, done_rx) = wit_future::new(|| Ok(()));
    let (body, _trailers) = Request::consume_body(req, done_rx);
    body.collect().await
}

fn html_response(status: u16, body: String, reason: Option<&str>) -> Response {
    synthesize(
        status,
        "text/html; charset=utf-8",
        body.into_bytes(),
        reason,
    )
}

fn json_response(status: u16, body: serde_json::Value, reason: Option<&str>) -> Response {
    synthesize(
        status,
        "application/json",
        body.to_string().into_bytes(),
        reason,
    )
}

/// Builds a complete response the proxy will return to the client instead
/// of forwarding the request.
fn synthesize(status: u16, content_type: &str, body: Vec<u8>, reason: Option<&str>) -> Response {
    let headers = Fields::new();
    let set = |k: &str, v: &str| {
        let _ = headers.set(&k.to_string(), &[v.as_bytes().to_vec()]);
    };
    set("content-type", content_type);
    set("content-length", &body.len().to_string());
    set("cache-control", "no-store");
    set("x-witm-noshorts", reason.unwrap_or("agent"));
    if content_type.starts_with("text/html") {
        set("x-content-type-options", "nosniff");
    }

    let (mut tx, rx) = wit_stream::new();
    let (_trailers_tx, trailers_rx) = wit_future::new(|| Ok(None));
    let (response, _done) = Response::new(headers, Some(rx), trailers_rx);
    let _ = response.set_status_code(status);
    wit_bindgen::spawn_local(async move {
        let mut remaining = body;
        while !remaining.is_empty() {
            let before = remaining.len();
            remaining = tx.write_all(remaining).await;
            if remaining.len() == before {
                break;
            }
        }
        drop(tx);
    });
    response
}

export!(Component);
