//! The **consent surface** — how a *backgrounded* daemon asks a human to approve a
//! request, when there's no console to prompt at.
//!
//! The key property: the decision is made on a surface **the daemon controls**,
//! never the requesting site's. The site is the adversary in its own consent
//! decision — if it rendered the dialog it would click "approve" itself. So:
//!
//!  1. an OS **notification** alerts the human ("`<origin>` wants `<cap>`");
//!  2. the decision happens on a page the daemon serves at **its own loopback
//!     origin** (`http://127.0.0.1:<port>`), which the requesting site cannot
//!     script or read (same-origin policy) — so it can't auto-approve;
//!  3. the decide endpoint is **CSRF-hardened**: a per-run nonce embedded in the
//!     daemon's page (unreadable cross-origin) plus an `Origin` check, so a site
//!     can't blind-fire an approval either.
//!
//! [`PendingConsent`] is the registry the broker parks requests in; this module
//! also serves the tiny HTTP approval UI that lists them and resolves decisions.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Context as _;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

/// Grant-lifetime bounds for the surface: the human picks a TTL on the page, and a
/// malformed / hostile POST is clamped into this range (the broker honours the value).
const DEFAULT_TTL_SECS: u64 = 3600; // 1 hour
const MIN_TTL_SECS: u64 = 60; // 1 minute
const MAX_TTL_SECS: u64 = 7 * 24 * 3600; // 1 week

/// A request awaiting the human's decision — what the approval UI displays.
#[derive(Clone)]
pub struct PendingRequest {
    pub id: String,
    /// Who is asking (the principal label — a web origin, or "a local peer").
    pub requester: String,
    /// The capability, human-legibly ("terminal (your login shell)").
    pub summary: String,
    /// The requestor's stated reason (website-supplied — untrusted text).
    pub reason: String,
    /// The structured capability requested — what a rich (native) surface renders as
    /// editable controls and attenuates. The loopback page ignores it (approve-as-is).
    pub want: crate::broker::CapabilityKind,
}

/// The human's approval, carrying an optional **attenuated** grant. `grant: None`
/// means "approve exactly as requested" (the loopback page, which has no attenuation
/// UI); `Some(g)` is the narrowed capability a rich surface produced — the broker
/// clamps it to a subset of the request regardless.
pub struct Approval {
    pub grant: Option<crate::broker::CapabilityKind>,
    pub remember: bool,
    pub ttl_secs: u64,
}

struct Waiting {
    info: PendingRequest,
    /// `None` = deny; `Some(Approval)` = approve (with the optional narrowed grant,
    /// the "remember this site" choice, and the human-chosen grant lifetime).
    decide: oneshot::Sender<Option<Approval>>,
}

/// The registry of requests awaiting a decision, shared between the broker (which
/// parks into it) and whatever surface resolves out of it — the loopback page, or the
/// native app's consent window. `notifier` is how a freshly-parked request alerts the
/// human: the loopback surface posts an OS notification pointing at its URL; the native
/// app shows + focuses its window (and posts a native notification).
#[derive(Clone)]
pub struct PendingConsent {
    inner: Arc<Mutex<HashMap<String, Waiting>>>,
    notifier: Arc<dyn Fn(&PendingRequest) + Send + Sync>,
}

impl PendingConsent {
    /// The loopback surface: alert by posting an OS notification pointing at `approve_url`.
    pub fn new(approve_url: impl Into<Arc<str>>) -> Self {
        let url: Arc<str> = approve_url.into();
        Self::with_notifier(move |req| notify(req, &url))
    }

    /// A custom surface: `notifier` runs whenever a request is parked (e.g. the native
    /// app shows its window + posts a native notification).
    pub fn with_notifier(notifier: impl Fn(&PendingRequest) + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            notifier: Arc::new(notifier),
        }
    }

    /// Alert the human that `req` is waiting (invokes the configured notifier).
    pub fn alert(&self, req: &PendingRequest) {
        (self.notifier)(req);
    }

    /// Park a request and hand back the receiver the broker awaits. Resolving it
    /// (via the approval UI) delivers the human's decision.
    pub(crate) fn park(&self, info: PendingRequest) -> oneshot::Receiver<Option<Approval>> {
        let (tx, rx) = oneshot::channel();
        self.inner
            .lock()
            .unwrap()
            .insert(info.id.clone(), Waiting { info, decide: tx });
        rx
    }

    /// Drop a parked request (the broker calls this on timeout).
    pub(crate) fn remove(&self, id: &str) {
        self.inner.lock().unwrap().remove(id);
    }

    /// The requests currently awaiting a decision — what a surface renders.
    pub fn list(&self) -> Vec<PendingRequest> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .map(|w| w.info.clone())
            .collect()
    }

    /// Deliver a decision to a parked request. Returns whether one matched.
    pub fn resolve(&self, id: &str, decision: Option<Approval>) -> bool {
        match self.inner.lock().unwrap().remove(id) {
            Some(w) => {
                let _ = w.decide.send(decision);
                true
            }
            None => false,
        }
    }
}

/// Best-effort alert that a request is waiting. The notification is only the
/// *attention* — the decision is made on the approval page. On macOS we post a
/// real notification via `osascript`; everywhere it's logged (so a foregrounded
/// daemon still surfaces it).
pub fn notify(req: &PendingRequest, approve_url: &str) {
    let body = format!(
        "{} wants {} — approve at {}",
        req.requester, req.summary, approve_url
    );
    tracing::info!(requester = %req.requester, summary = %req.summary, %approve_url, "consent requested (surface)");
    #[cfg(target_os = "macos")]
    {
        // Strip quotes/newlines so the AppleScript string can't be broken out of.
        let safe = body.replace('"', "'").replace(['\n', '\r'], " ");
        let script =
            format!("display notification \"{safe}\" with title \"icanhaz — consent requested\"");
        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .spawn();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = body;
}

/// Open the approval page in the human's browser (best-effort, `open`/`xdg-open`).
/// Called once when a backgrounded daemon starts in surface mode, so the page is
/// already up (polling `/pending`) when a request + its notification arrive.
pub fn open_approval_page(url: &str) {
    let opener = if cfg!(target_os = "macos") {
        Some("open")
    } else if cfg!(target_os = "linux") {
        Some("xdg-open")
    } else {
        None
    };
    if let Some(bin) = opener {
        if let Err(err) = std::process::Command::new(bin).arg(url).spawn() {
            tracing::debug!(?err, url, "could not open the approval page");
        }
    }
}

/// Serve the loopback approval UI on `listener` until cancelled. `nonce` gates the
/// decide endpoint (the page embeds it; a cross-origin site can't read it).
pub async fn serve_approval(
    listener: TcpListener,
    pending: PendingConsent,
    nonce: String,
) -> anyhow::Result<()> {
    let nonce: Arc<str> = nonce.into();
    loop {
        let (stream, _addr) = listener.accept().await.context("approval accept")?;
        let pending = pending.clone();
        let nonce = Arc::clone(&nonce);
        tokio::spawn(async move {
            if let Err(err) = handle(stream, &pending, &nonce).await {
                tracing::debug!(?err, "approval connection error");
            }
        });
    }
}

async fn handle(
    mut stream: TcpStream,
    pending: &PendingConsent,
    nonce: &str,
) -> anyhow::Result<()> {
    let (rd, mut wr) = stream.split();
    let mut rd = BufReader::new(rd);

    // Request line: METHOD PATH VERSION
    let mut line = String::new();
    rd.read_line(&mut line).await?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();

    // Headers until the blank line.
    let mut headers: HashMap<String, String> = HashMap::new();
    loop {
        let mut h = String::new();
        if rd.read_line(&mut h).await? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    // Body (by Content-Length).
    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    if len > 0 {
        rd.read_exact(&mut body).await?;
    }

    let resp = route(&method, &path, &headers, &body, pending, nonce);
    wr.write_all(&resp).await?;
    wr.flush().await?;
    Ok(())
}

fn route(
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
    pending: &PendingConsent,
    nonce: &str,
) -> Vec<u8> {
    match (method, path) {
        ("GET", "/") | ("GET", "/approve") => http_ok(
            "text/html; charset=utf-8",
            PAGE.replace("__NONCE__", nonce).into_bytes(),
        ),
        ("GET", "/pending") => http_ok("application/json", pending_json(pending).into_bytes()),
        ("POST", "/decide") => decide(headers, body, pending, nonce),
        _ => http_status(404, "Not Found"),
    }
}

fn decide(
    headers: &HashMap<String, String>,
    body: &[u8],
    pending: &PendingConsent,
    nonce: &str,
) -> Vec<u8> {
    // CSRF: the page's nonce (a cross-origin site can't read it), plus — defence
    // in depth — an `Origin` that is our own loopback (a site's POST carries its
    // own origin, or none for a form, and lacks the nonce regardless).
    let csrf_ok = headers.get("x-csrf").map(|v| v == nonce).unwrap_or(false);
    let origin_ok = match headers.get("origin") {
        Some(o) => o.starts_with("http://127.0.0.1:") || o.starts_with("http://localhost:"),
        None => true,
    };
    if !csrf_ok || !origin_ok {
        return http_status(403, "Forbidden");
    }

    let body = String::from_utf8_lossy(body);
    let mut id = "";
    let mut allow = false;
    let mut remember = false;
    let mut ttl_secs = DEFAULT_TTL_SECS;
    for kv in body.split('&') {
        match kv.split_once('=') {
            Some(("id", v)) => id = v,
            Some(("allow", v)) => allow = v == "true",
            Some(("remember", v)) => remember = v == "1" || v == "true",
            Some(("ttl", v)) => ttl_secs = v.parse().unwrap_or(DEFAULT_TTL_SECS),
            _ => {}
        }
    }
    if id.is_empty() {
        return http_status(400, "Bad Request");
    }
    // Clamp the client-supplied lifetime into range (the broker honours this value).
    let ttl_secs = ttl_secs.clamp(MIN_TTL_SECS, MAX_TTL_SECS);
    // The loopback page approves as-requested (no attenuation UI) ⇒ `grant: None`.
    let decision = if allow {
        Some(Approval {
            grant: None,
            remember,
            ttl_secs,
        })
    } else {
        None
    };
    if pending.resolve(id, decision) {
        http_ok("application/json", b"{\"ok\":true}".to_vec())
    } else {
        http_status(404, "Not Found")
    }
}

fn pending_json(pending: &PendingConsent) -> String {
    let mut s = String::from("[");
    for (i, it) in pending.list().iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"id\":{},\"requester\":{},\"summary\":{},\"reason\":{}}}",
            json_str(&it.id),
            json_str(&it.requester),
            json_str(&it.summary),
            json_str(&it.reason),
        ));
    }
    s.push(']');
    s
}

/// JSON-escape a string (the `reason` is website-supplied — escape it properly).
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn http_ok(content_type: &str, body: Vec<u8>) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len(),
    )
    .into_bytes();
    out.extend_from_slice(&body);
    out
}

fn http_status(code: u16, reason: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reason}",
        reason.len(),
    )
    .into_bytes()
}

/// The approval page. Polls `/pending`, renders each request, and posts decisions
/// with the embedded nonce. `esc()` keeps website-supplied text out of the DOM as
/// markup. `__NONCE__` is substituted server-side per run.
const PAGE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>icanhaz — consent</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.1rem; } .dim { opacity: .6; }
  .req { border: 1px solid #8886; border-radius: 10px; padding: .8rem 1rem; margin: .8rem 0; }
  .req code { background: #8882; padding: 0 .3rem; border-radius: 4px; }
  .reason { opacity: .8; margin: .3rem 0 .6rem; }
  button { font: inherit; padding: .35rem .9rem; border-radius: 8px; border: 1px solid #8886; cursor: pointer; margin-right: .5rem; }
  .yes { background: #1c7c3c; color: #fff; border-color: #1c7c3c; } .no { background: #8881; }
  select.ttl { font: inherit; padding: .3rem; border-radius: 8px; border: 1px solid #8886; margin-right: .5rem; }
</style></head><body>
<h1>icanhaz <span class="dim">— pending consent</span></h1>
<p class="dim">Requests reaching your machine. Approve only what you recognise.</p>
<div id="list" class="dim">(loading…)</div>
<script>
const NONCE = "__NONCE__";
function esc(s){ const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
async function decide(id, allow, remember, ttl){
  await fetch("/decide", { method:"POST",
    headers:{ "X-Csrf": NONCE, "Content-Type":"application/x-www-form-urlencoded" },
    body:`id=${encodeURIComponent(id)}&allow=${allow}&remember=${remember?1:0}&ttl=${ttl||0}` });
  refresh();
}
async function refresh(){
  let items = [];
  try { items = await (await fetch("/pending")).json(); } catch { return; }
  const list = document.getElementById("list");
  if (!items.length){ list.className="dim"; list.textContent="No pending requests."; return; }
  list.className=""; list.innerHTML="";
  for (const it of items){
    const div = document.createElement("div"); div.className="req";
    div.innerHTML = `<div><b>${esc(it.requester)}</b> wants <code>${esc(it.summary)}</code></div>`
      + `<div class="reason">${esc(it.reason)}</div>`;
    const ttl = document.createElement("select"); ttl.className="ttl";
    for (const [label, secs] of [["10 min",600],["1 hour",3600],["8 hours",28800],["1 day",86400]]){
      const o = document.createElement("option"); o.value=secs; o.textContent="for "+label;
      if (secs===3600) o.selected=true; ttl.append(o);
    }
    const once = document.createElement("button"); once.className="yes"; once.textContent="Approve once";
    once.onclick = () => decide(it.id, true, false, ttl.value);
    const rem = document.createElement("button"); rem.className="yes"; rem.textContent="Approve & remember";
    rem.onclick = () => decide(it.id, true, true, ttl.value);
    const no = document.createElement("button"); no.className="no"; no.textContent="Deny";
    no.onclick = () => decide(it.id, false, false, 0);
    div.append(ttl, once, rem, no); list.append(div);
  }
}
setInterval(refresh, 1000); refresh();
</script></body></html>
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use core::net::SocketAddr;
    use core::time::Duration;

    async fn http_get(addr: SocketAddr, path: &str) -> String {
        let mut s = TcpStream::connect(addr).await.unwrap();
        let req = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        s.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    }

    async fn http_post(
        addr: SocketAddr,
        path: &str,
        body: &str,
        csrf: Option<&str>,
        origin: Option<&str>,
    ) -> String {
        let mut s = TcpStream::connect(addr).await.unwrap();
        let csrf = csrf.map(|n| format!("X-Csrf: {n}\r\n")).unwrap_or_default();
        let origin = origin
            .map(|o| format!("Origin: {o}\r\n"))
            .unwrap_or_default();
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n{csrf}{origin}Connection: close\r\n\r\n{body}",
            body.len(),
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    }

    #[tokio::test]
    async fn approval_surface_resolves_and_resists_csrf() {
        let pending = PendingConsent::new("http://127.0.0.1:7779");
        let nonce = "secret-nonce-xyz".to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_approval(listener, pending.clone(), nonce.clone()));
        tokio::time::sleep(Duration::from_millis(150)).await;

        // The broker parks a request (website-supplied reason with a quote, to
        // exercise JSON-escaping).
        let rx = pending.park(PendingRequest {
            id: "req-1".to_string(),
            requester: "https://notes.example.com".to_string(),
            summary: "terminal (your login shell)".to_string(),
            reason: "open a \"shell\"".to_string(),
            want: crate::broker::CapabilityKind::Terminal(crate::broker::TerminalRequest {
                shell: None,
                jailed: false,
            }),
        });

        // It shows up on the surface.
        let listing = http_get(addr, "/pending").await;
        assert!(listing.contains("req-1"), "missing id:\n{listing}");
        assert!(listing.contains("https://notes.example.com"));
        assert!(
            listing.contains(r#"open a \"shell\""#),
            "reason not escaped:\n{listing}"
        );

        // CSRF: a decide with no nonce is refused (the cross-origin attacker case).
        let r = http_post(addr, "/decide", "id=req-1&allow=true", None, None).await;
        assert!(
            r.starts_with("HTTP/1.1 403"),
            "no-nonce decide should 403:\n{r}"
        );
        // CSRF: nonce but a foreign Origin is refused (defence in depth).
        let r = http_post(
            addr,
            "/decide",
            "id=req-1&allow=true",
            Some(&nonce),
            Some("https://evil.com"),
        )
        .await;
        assert!(
            r.starts_with("HTTP/1.1 403"),
            "foreign-origin decide should 403:\n{r}"
        );

        // The request is still pending after the rejected attempts.
        assert!(http_get(addr, "/pending").await.contains("req-1"));

        // A legitimate decide (page nonce, same-origin) approves it, and the
        // broker's parked future resolves.
        let r = http_post(
            addr,
            "/decide",
            "id=req-1&allow=true&remember=1&ttl=28800",
            Some(&nonce),
            None,
        )
        .await;
        assert!(
            r.starts_with("HTTP/1.1 200"),
            "valid decide should 200:\n{r}"
        );
        let approval = rx.await.unwrap().expect("approved");
        assert!(approval.grant.is_none(), "loopback approves as-requested");
        assert!(approval.remember);
        assert_eq!(approval.ttl_secs, 28800);

        // And it's gone from the surface.
        assert!(!http_get(addr, "/pending").await.contains("req-1"));

        server.abort();
    }
}
