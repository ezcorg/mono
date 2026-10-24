//! End-to-end tests: the signed component running inside a real witmproxy,
//! fronting a stand-in "YouTube" on 127.0.0.1.
//!
//! The manifest scopes the plugin to youtube.com; these tests widen the
//! event scopes to the loopback fixture and tell the plugin (via its `hosts`
//! setting) to manage 127.0.0.1. Everything else is the shipped component.

use std::sync::Arc;

use anyhow::Result;
use witmproxy::plugins::registry::PluginRegistry;
use witmproxy::test_utils::{
    Protocol, ServerHandle, create_client, create_html_server_with_body, create_witmproxy,
    noshorts_plugin_path,
};
use witmproxy::wasm::bindgen::exports::witmproxy::plugin::witm_plugin::{ActualInput, UserInput};
use witmproxy::wasm::bindgen::witmproxy::plugin::capabilities::{CapabilityKind, EventKind};
use witmproxy::{CertificateAuthority, WitmProxy};

const FIXTURE: &str = include_str!("fixtures/youtube.html");

struct Env {
    _proxy: WitmProxy,
    _registry: Arc<PluginRegistry>,
    _ca: CertificateAuthority,
    _tmp: tempfile::TempDir,
    server: ServerHandle,
    client: reqwest::Client,
    origin: String,
    proxy_addr: String,
}

/// Starts a proxy with the plugin registered and configured, plus a fixture
/// server on 127.0.0.1 answering every path with the stand-in page.
async fn start(config: &[(&str, &str)]) -> Result<Env> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();

    let (mut proxy, registry, ca, _config, tmp) = create_witmproxy().await?;
    proxy.start().await?;

    let bytes = std::fs::read(noshorts_plugin_path()?)?;
    let mut plugin = registry.plugin_from_component(bytes).await?;
    for cap in plugin.capabilities.iter_mut() {
        let expr = &mut cap.inner.scope.when;
        match cap.inner.kind {
            CapabilityKind::HandleEvent(EventKind::Connect | EventKind::Request) => {
                *expr = "true".to_string();
            }
            CapabilityKind::HandleEvent(EventKind::InboundContent) => {
                *expr = "content.content_type().startsWith('text/html') && !request.path().startsWith('/__witm/')"
                    .to_string();
            }
            _ => {}
        }
    }
    // Test defaults first; a test's own entries override them by name.
    let mut inputs: Vec<(&str, &str)> = vec![("hosts", "127.0.0.1"), ("work_days", "none")];
    for (name, value) in config {
        inputs.retain(|(n, _)| n != name);
        inputs.push((name, value));
    }
    plugin.configuration = inputs
        .into_iter()
        .map(|(name, value)| UserInput {
            name: name.to_string(),
            value: ActualInput::Str(value.to_string()),
        })
        .collect();
    registry.register_plugin(plugin).await?;

    let server = create_html_server_with_body(
        "127.0.0.1",
        None,
        ca.clone(),
        Protocol::Http1,
        FIXTURE.to_string(),
    )
    .await;
    let proxy_addr = proxy
        .proxy_listen_addr()
        .expect("proxy started")
        .to_string();
    let client = create_client(ca.clone(), &format!("http://{proxy_addr}"), Protocol::Http1).await;
    let origin = format!("https://127.0.0.1:{}", server.listen_addr().port());

    Ok(Env {
        _proxy: proxy,
        _registry: registry,
        _ca: ca,
        _tmp: tmp,
        server,
        client,
        origin,
        proxy_addr,
    })
}

impl Env {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.origin)
    }

    async fn get_html(&self, path: &str) -> reqwest::Response {
        self.client
            .get(self.url(path))
            .header("accept", "text/html,application/xhtml+xml")
            .header("sec-fetch-dest", "document")
            .send()
            .await
            .expect("request through proxy")
    }

    async fn get_json(&self, path: &str) -> reqwest::Response {
        self.client
            .get(self.url(path))
            .header("accept", "application/json")
            .send()
            .await
            .expect("request through proxy")
    }

    async fn status(&self) -> serde_json::Value {
        self.get_json("/__witm/noshorts/status")
            .await
            .json()
            .await
            .unwrap()
    }

    async fn shutdown(self) {
        self.server.shutdown().await;
    }
}

fn reason(resp: &reqwest::Response) -> Option<String> {
    resp.headers()
        .get("x-witm-noshorts")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

#[tokio::test]
async fn manifest_declares_typed_settings() -> Result<()> {
    use witmproxy::wasm::bindgen::InputType;
    let (_proxy, registry, _ca, _config, _tmp) = create_witmproxy().await?;
    let bytes = std::fs::read(noshorts_plugin_path()?)?;
    let plugin = registry.plugin_from_component(bytes).await?;
    let find = |name: &str| {
        plugin
            .input_schema
            .iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("{name} is declared"))
    };
    assert!(matches!(
        find("daily_budget_minutes").input_type,
        InputType::Number
    ));
    assert!(matches!(
        find("block_shorts").input_type,
        InputType::Boolean
    ));
    assert!(matches!(find("work_hours").input_type, InputType::Str));
    assert!(matches!(
        find("daily_budget_minutes").default,
        Some(ActualInput::Number(n)) if n == 30.0
    ));
    assert!(
        find("work_hours")
            .description
            .as_deref()
            .unwrap_or("")
            .contains("HH:MM")
    );
    Ok(())
}

#[tokio::test]
async fn managed_html_gets_css_and_agent_frame() -> Result<()> {
    let env = start(&[]).await?;
    let resp = env.get_html("/").await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        reason(&resp),
        None,
        "a passthrough response carries no plugin header"
    );
    let body = resp.text().await?;
    assert!(
        body.contains("Hello from the stand-in YouTube"),
        "original content survives"
    );
    assert!(
        body.contains("id=\"witm-noshorts-css\""),
        "CSS injected: {body}"
    );
    assert!(
        body.contains("ytd-reel-shelf-renderer"),
        "shorts selectors present"
    );
    assert!(
        body.contains("id=\"witm-noshorts-agent\""),
        "agent frame injected"
    );
    assert!(body.contains("src=\"/__witm/noshorts/agent\""));
    let head_end = body.find("</head>").unwrap();
    assert!(
        body.find("witm-noshorts-css").unwrap() < head_end,
        "style lives in <head>"
    );
    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn hide_shorts_ui_can_be_switched_off() -> Result<()> {
    let env = start(&[("hide_shorts_ui", "false")]).await?;
    let body = env.get_html("/").await.text().await?;
    assert!(!body.contains("witm-noshorts-css"));
    assert!(
        body.contains("witm-noshorts-agent"),
        "the agent is still needed for metering"
    );
    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn agent_document_is_served_by_the_plugin_and_left_alone() -> Result<()> {
    let env = start(&[("heartbeat_seconds", "3")]).await?;
    let resp = env.get_html("/__witm/noshorts/agent").await;
    assert_eq!(resp.status(), 200);
    assert_eq!(reason(&resp).as_deref(), Some("agent"));
    assert!(
        resp.headers()["content-type"]
            .to_str()?
            .starts_with("text/html")
    );
    let body = resp.text().await?;
    assert!(body.contains("\"heartbeatMs\":3000"), "{body}");
    assert!(body.contains("\"prefix\":\"/__witm/noshorts/\""));
    assert!(
        !body.contains("witm-noshorts-agent"),
        "the agent page must not embed itself"
    );
    assert!(
        !body.contains("Hello from the stand-in"),
        "never reached the origin"
    );
    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn shorts_pages_and_playback_api_are_refused() -> Result<()> {
    let env = start(&[]).await?;

    let resp = env.get_html("/shorts/abc123").await;
    assert_eq!(resp.status(), 403);
    assert_eq!(reason(&resp).as_deref(), Some("shorts"));
    let body = resp.text().await?;
    assert!(body.contains("Shorts are off"), "{body}");
    assert!(body.contains("How to turn this off"));
    assert!(!body.contains("witm plugin"), "instructions stay vague");
    assert!(
        !body.contains("witm-noshorts-agent"),
        "block pages are not rewritten"
    );

    let resp = env
        .client
        .post(env.url("/youtubei/v1/reel/reel_item_watch?prettyPrint=false"))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await?;
    assert_eq!(resp.status(), 403);
    assert_eq!(reason(&resp).as_deref(), Some("shorts"));
    let json: serde_json::Value = resp.json().await?;
    assert_eq!(json["blocked"], true);
    assert_eq!(json["reason"], "shorts");

    // Everything else on the site is still fine.
    assert_eq!(env.get_html("/watch?v=plain").await.status(), 200);
    assert_eq!(env.get_json("/youtubei/v1/browse").await.status(), 200);
    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn shorts_blocking_can_be_switched_off() -> Result<()> {
    let env = start(&[("block_shorts", "false")]).await?;
    assert_eq!(env.get_html("/shorts/abc123").await.status(), 200);
    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn working_hours_block_the_whole_site() -> Result<()> {
    // A window around "now" in UTC, with the offset pinned to UTC so the
    // test does not depend on the host's zone.
    use chrono::Timelike;
    let now = chrono::Utc::now();
    let minute = now.hour() * 60 + now.minute();
    let hhmm = |m: u32| format!("{:02}:{:02}", (m / 60) % 24, m % 60);
    let window = format!(
        "{}-{}",
        hhmm((minute + 24 * 60 - 2) % (24 * 60)),
        hhmm((minute + 3) % (24 * 60))
    );

    let env = start(&[
        ("work_hours", &window),
        ("work_days", "all"),
        ("utc_offset_minutes", "0"),
    ])
    .await?;

    let resp = env.get_html("/").await;
    assert_eq!(resp.status(), 403);
    assert_eq!(reason(&resp).as_deref(), Some("work-hours"));
    let body = resp.text().await?;
    assert!(body.contains("Not during working hours"), "{body}");
    assert!(body.contains("the block lifts at"));

    let resp = env.get_json("/youtubei/v1/browse").await;
    assert_eq!(resp.status(), 403);
    let json: serde_json::Value = resp.json().await?;
    assert_eq!(json["reason"], "work-hours");

    let status = env.status().await;
    assert_eq!(status["blocked"], true);
    assert_eq!(status["reason"], "work-hours");
    assert_eq!(status["utc_offset_seconds"], 0);

    // The agent endpoints keep working so the overlay can show.
    assert_eq!(env.get_html("/__witm/noshorts/agent").await.status(), 200);
    env.shutdown().await;

    // Outside the window (or on a non-work day) the site is reachable.
    let env = start(&[("work_hours", &window), ("work_days", "none")]).await?;
    assert_eq!(env.get_html("/").await.status(), 200);
    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn heartbeats_meter_active_time_against_the_budget() -> Result<()> {
    // Three seconds of budget, one-second heartbeats.
    let env = start(&[("daily_budget_minutes", "0.05"), ("heartbeat_seconds", "1")]).await?;

    let tick = |active: u8, dt: u32| {
        let env = &env;
        async move {
            env.get_json(&format!("/__witm/noshorts/tick?active={active}&dt={dt}"))
                .await
                .json::<serde_json::Value>()
                .await
                .unwrap()
        }
    };

    let t = tick(0, 1).await;
    assert_eq!(t["credited"], 0, "inactive tabs cost nothing: {t}");
    assert_eq!(t["blocked"], false);

    let t = tick(1, 1).await;
    assert_eq!(t["credited"], 1, "{t}");
    assert_eq!(t["used_seconds"], 1);
    assert_eq!(t["remaining_seconds"], 2);

    // A claim far beyond the heartbeat, immediately: bounded by the clock.
    let t = tick(1, 3600).await;
    assert_eq!(t["credited"], 0, "{t}");

    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let t = tick(1, 1).await;
    assert_eq!(t["credited"], 1, "{t}");
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let t = tick(1, 1).await;
    assert_eq!(t["used_seconds"], 3, "{t}");
    assert_eq!(t["blocked"], true);
    assert_eq!(t["reason"], "budget");

    let resp = env.get_html("/watch?v=plain").await;
    assert_eq!(resp.status(), 403);
    assert_eq!(reason(&resp).as_deref(), Some("budget"));
    let body = resp.text().await?;
    assert!(body.contains("That is enough YouTube for today"), "{body}");
    assert!(body.contains("<dd>3s</dd>"), "shows what was used: {body}");
    assert!(
        !body.contains("<script"),
        "top-level block page has no script"
    );

    let embedded = env
        .get_html("/__witm/noshorts/blocked?reason=budget&embedded=1")
        .await
        .text()
        .await?;
    assert!(
        embedded.contains("<script"),
        "embedded block page keeps the parent paused"
    );

    // Shorts still report as shorts even once the budget is spent.
    assert_eq!(
        reason(&env.get_html("/shorts/x").await).as_deref(),
        Some("shorts")
    );
    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn zero_budget_blocks_immediately() -> Result<()> {
    let env = start(&[("daily_budget_minutes", "0")]).await?;
    let resp = env.get_html("/").await;
    assert_eq!(resp.status(), 403);
    assert_eq!(reason(&resp).as_deref(), Some("budget"));
    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn score_endpoint_flags_clickbait() -> Result<()> {
    let env = start(&[("filter_keywords", "election")]).await?;
    let resp = env
        .client
        .post(env.url("/__witm/noshorts/score"))
        .header("content-type", "application/json")
        .body(
            r#"{"items":[
                {"id":"a","title":"Building a bookshelf from scrap oak"},
                {"id":"b","title":"YOU WON'T BELIEVE WHAT HAPPENED NEXT!!! 🤯🔥"},
                {"id":"c","title":"Election night coverage, hour 3"}
            ]}"#,
        )
        .send()
        .await?;
    assert_eq!(resp.status(), 200);
    let json: serde_json::Value = resp.json().await?;
    let items = json["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["hide"], false, "{json}");
    assert_eq!(items[1]["hide"], true, "{json}");
    assert!(
        items[1]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r == "bait phrase")
    );
    assert_eq!(items[2]["hide"], true, "operator keyword: {json}");
    env.shutdown().await;

    let env = start(&[("filter_enabled", "false")]).await?;
    let json: serde_json::Value = env
        .client
        .post(env.url("/__witm/noshorts/score"))
        .body(r#"{"items":[{"id":"b","title":"YOU WON'T BELIEVE THIS!!!"}]}"#)
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(json["items"][0]["hide"], false);
    assert!(json["items"][0]["score"].as_f64().unwrap() > 0.5);
    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn unmanaged_hosts_are_not_policed() -> Result<()> {
    let env = start(&[("hosts", "youtube.com"), ("daily_budget_minutes", "0")]).await?;
    // 127.0.0.1 is not youtube.com here, so a zero budget changes nothing.
    assert_eq!(env.get_html("/shorts/abc").await.status(), 200);
    env.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn bad_configuration_is_reported_not_swallowed() -> Result<()> {
    let env = start(&[("work_hours", "nine to five")]).await?;
    // The host fails closed on a configure error: the request does not go
    // through as if the plugin were absent.
    let resp = env.get_html("/").await;
    assert!(resp.status().is_server_error(), "got {}", resp.status());
    env.shutdown().await;
    Ok(())
}

/// Drives real Chrome through the proxy. Skips (with a warning) when `node`,
/// `puppeteer-core` (pnpm store at the repo root) or Chrome (puppeteer's
/// cache, or `CHROME_PATH`) is missing.
#[tokio::test]
async fn browser_agent_meters_time_hides_bait_and_engages_the_overlay() -> Result<()> {
    if which_node().is_none() {
        tracing::warn!("node not found on PATH; skipping browser test");
        return Ok(());
    }
    let env = start(&[
        ("daily_budget_minutes", "0.05"),
        ("heartbeat_seconds", "1"),
        ("idle_seconds", "30"),
    ])
    .await?;

    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/puppeteer/noshorts.mjs");
    let repo = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        tokio::process::Command::new("node")
            .arg(script)
            .args(["--proxy", &env.proxy_addr])
            .args(["--origin", &env.origin])
            .args(["--repo", repo])
            .output(),
    )
    .await
    .expect("puppeteer run finished in time")?;
    env.shutdown().await;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.starts_with('{'))
        .unwrap_or_else(|| {
            panic!("no JSON result from puppeteer script.\nstdout: {stdout}\nstderr: {stderr}")
        });
    let report: serde_json::Value = serde_json::from_str(line)?;
    if let Some(why) = report["skipped"].as_str() {
        tracing::warn!("browser test skipped: {why}");
        return Ok(());
    }
    assert_eq!(
        report["ok"],
        true,
        "browser run failed:\n{}\nstderr: {stderr}",
        serde_json::to_string_pretty(&report)?
    );
    Ok(())
}

fn which_node() -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|d| d.join("node"))
            .find(|p| p.is_file())
    })
}

/// Reaches the real YouTube through the proxy with the shipped manifest and
/// default settings. Needs the network, so it is opt-in:
/// `cargo test -p witmproxy-plugin-noshorts -- --ignored real_youtube`.
#[tokio::test]
#[ignore]
async fn real_youtube_is_rewritten_or_blocked() -> Result<()> {
    let (mut proxy, registry, ca, _config, _tmp) = create_witmproxy().await?;
    proxy.start().await?;
    let bytes = std::fs::read(noshorts_plugin_path()?)?;
    let plugin = registry.plugin_from_component(bytes).await?;
    registry.register_plugin(plugin).await?;
    let client = create_client(
        ca,
        &format!(
            "http://{}",
            proxy.proxy_listen_addr().expect("proxy started")
        ),
        Protocol::Http2,
    )
    .await;

    let resp = client
        .get("https://www.youtube.com/")
        .header("accept", "text/html")
        .header("sec-fetch-dest", "document")
        .send()
        .await?;
    let status = resp.status();
    let why = reason(&resp);
    let body = resp.text().await?;
    match status.as_u16() {
        200 => {
            assert!(
                body.contains("witm-noshorts-agent"),
                "agent frame injected into the real page"
            );
            assert!(body.contains("witm-noshorts-css"));
        }
        403 => {
            assert!(why.is_some(), "a 403 from us carries the reason header");
            assert!(body.contains("How to turn this off"));
        }
        other => panic!("unexpected status {other}"),
    }

    let resp = client
        .get("https://www.youtube.com/shorts/dQw4w9WgXcQ")
        .header("accept", "text/html")
        .send()
        .await?;
    assert_eq!(resp.status(), 403);
    Ok(())
}
