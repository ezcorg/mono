//! The native consent surface's IPC layer: serde DTOs mirroring the NoCap capability
//! types (the generated wRPC types aren't `serde`), plus the Tauri commands the consent
//! window calls — `list_pending` to render, `decide` to resolve.
//!
//! `decide` carries an optional **attenuated** capability the human narrowed to; the
//! broker clamps it to a subset of the request regardless (see `broker::narrow`), so a
//! bug (or a compromised webview) can only ever tighten a grant, never widen it.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use icanhaz_host::approve::{Approval, PendingConsent};
use icanhaz_host::broker::{
    CapabilityKind, FsRequest, FsRights, GrantStore, GrantView, Hosts, Pairings, PathGrant,
    ProcessRequest, TerminalRequest,
};

/// Reflect the pending-request count on the tray (menubar badge + tooltip). Driven by
/// a backend poll loop (see `lib.rs`) so it stays correct even when the window is hidden
/// and its JS timers are throttled.
pub fn set_tray_badge(app: &AppHandle, pending_count: usize) {
    if let Some(tray) = app.tray_by_id("icanhaz") {
        let _ = tray.set_tooltip(Some(format!("icanhaz — {pending_count} pending")));
        // `Some("")` force-clears the badge at zero — `set_title(None)` doesn't always
        // clear a previously-set title on macOS (the source of the stale count).
        let title = if pending_count > 0 {
            pending_count.to_string()
        } else {
            String::new()
        };
        let _ = tray.set_title(Some(title));
    }
}

/// A capability, as the consent window sees + edits it.
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CapabilityDto {
    Filesystem {
        roots: Vec<PathGrantDto>,
    },
    Process {
        image: String,
        args: Vec<String>,
        guest_chooses_argv: bool,
    },
    Terminal {
        shell: Option<String>,
        jailed: bool,
    },
    Sockets {
        endpoints: Vec<String>,
        may_listen: bool,
    },
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PathGrantDto {
    pub path: String,
    pub rights: FsRightsDto,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FsRightsDto {
    pub read: bool,
    pub write: bool,
    pub create: bool,
    pub delete: bool,
    pub watch: bool,
}

impl From<&CapabilityKind> for CapabilityDto {
    fn from(k: &CapabilityKind) -> Self {
        match k {
            CapabilityKind::Filesystem(fs) => CapabilityDto::Filesystem {
                roots: fs
                    .roots
                    .iter()
                    .map(|r| PathGrantDto {
                        path: r.path.clone(),
                        rights: FsRightsDto {
                            read: r.rights.contains(FsRights::READ),
                            write: r.rights.contains(FsRights::WRITE),
                            create: r.rights.contains(FsRights::CREATE),
                            delete: r.rights.contains(FsRights::DELETE),
                            watch: r.rights.contains(FsRights::WATCH),
                        },
                    })
                    .collect(),
            },
            CapabilityKind::Process(p) => CapabilityDto::Process {
                image: p.image.clone(),
                args: p.args.clone(),
                guest_chooses_argv: p.guest_chooses_argv,
            },
            CapabilityKind::Terminal(t) => CapabilityDto::Terminal {
                shell: t.shell.clone(),
                jailed: t.jailed,
            },
            CapabilityKind::Sockets(s) => CapabilityDto::Sockets {
                endpoints: s
                    .allow
                    .iter()
                    .map(|e| format!("{}:{}-{} ({:?})", e.host, e.lo_port, e.hi_port, e.proto))
                    .collect(),
                may_listen: s.may_listen,
            },
        }
    }
}

impl CapabilityDto {
    /// The attenuated capability the human produced, or `None` to approve as-requested.
    /// Sockets have no editing UI (no provider yet), so they always defer to the original.
    pub fn into_capability(self) -> Option<CapabilityKind> {
        match self {
            CapabilityDto::Filesystem { roots } => Some(CapabilityKind::Filesystem(FsRequest {
                roots: roots
                    .into_iter()
                    .map(|r| {
                        let mut rights = FsRights::empty();
                        if r.rights.read {
                            rights |= FsRights::READ;
                        }
                        if r.rights.write {
                            rights |= FsRights::WRITE;
                        }
                        if r.rights.create {
                            rights |= FsRights::CREATE;
                        }
                        if r.rights.delete {
                            rights |= FsRights::DELETE;
                        }
                        if r.rights.watch {
                            rights |= FsRights::WATCH;
                        }
                        PathGrant {
                            path: r.path,
                            rights,
                        }
                    })
                    .collect(),
            })),
            CapabilityDto::Process {
                image,
                args,
                guest_chooses_argv,
            } => Some(CapabilityKind::Process(ProcessRequest {
                image,
                args,
                guest_chooses_argv,
            })),
            CapabilityDto::Terminal { shell, jailed } => {
                Some(CapabilityKind::Terminal(TerminalRequest { shell, jailed }))
            }
            CapabilityDto::Sockets { .. } => None,
        }
    }
}

/// A request awaiting the human's decision, as the consent window renders it.
#[derive(Serialize, Clone)]
pub struct PendingDto {
    pub id: String,
    pub requester: String,
    pub summary: String,
    pub reason: String,
    pub capability: CapabilityDto,
}

/// The requests currently awaiting a decision (the window polls this). Also refreshes
/// the tray badge, so the menubar count tracks the live poll.
#[tauri::command]
pub fn list_pending(app: AppHandle, pending: State<'_, PendingConsent>) -> Vec<PendingDto> {
    let out: Vec<PendingDto> = pending
        .list()
        .into_iter()
        .map(|r| PendingDto {
            id: r.id,
            requester: r.requester,
            summary: r.summary,
            reason: r.reason,
            capability: (&r.want).into(),
        })
        .collect();
    set_tray_badge(&app, out.len());
    out
}

/// Every live grant, for the app's audit view.
#[tauri::command]
pub fn list_grants(grants: State<'_, Arc<Mutex<GrantStore>>>) -> Vec<GrantView> {
    grants.lock().unwrap().active_grants()
}

/// Revoke a live grant by id (the "Revoke" button). Also **forgets the site's durable
/// pairing** for that capability, so it must re-consent instead of silently re-pairing
/// on its next request (a page refresh). Returns whether one was live.
#[tauri::command]
pub fn revoke_grant(
    grants: State<'_, Arc<Mutex<GrantStore>>>,
    pairings: State<'_, Arc<Mutex<Pairings>>>,
    id: String,
) -> bool {
    icanhaz_host::broker::revoke_and_unpair(grants.inner(), pairings.inner(), &id)
}

/// An installed capability, for the Capabilities tab.
#[derive(Serialize)]
pub struct CapabilityView {
    pub id: String,
    pub icon: String,
    pub description: String,
}

/// The installed host capabilities, described in `lang` (else the host locale).
#[tauri::command]
pub fn list_capabilities(lang: Option<String>) -> Vec<CapabilityView> {
    icanhaz_host::capabilities::registry()
        .iter()
        .map(|c| CapabilityView {
            id: c.id.to_string(),
            icon: c.icon.to_string(),
            description: c.describe(lang.as_deref()).to_string(),
        })
        .collect()
}

/// A site with durable pairing trust: origin + the capability kinds it covers.
#[derive(Serialize)]
pub struct SiteView {
    pub origin: String,
    pub kinds: Vec<String>,
}

#[tauri::command]
pub fn list_pairings(pairings: State<'_, Arc<Mutex<Pairings>>>) -> Vec<SiteView> {
    pairings
        .lock()
        .unwrap()
        .list()
        .into_iter()
        .map(|(origin, kinds)| SiteView { origin, kinds })
        .collect()
}

/// Forget all durable trust for a site (the "Sites" section's Forget button).
#[tauri::command]
pub fn forget_pairing(pairings: State<'_, Arc<Mutex<Pairings>>>, origin: String) {
    pairings.lock().unwrap().revoke_origin(&origin);
}

/// The approved-hosts allowlist (origins allowed to initiate requests).
#[tauri::command]
pub fn list_hosts(hosts: State<'_, Arc<Mutex<Hosts>>>) -> Vec<String> {
    hosts.lock().unwrap().list()
}

/// Origins that have requested while unapproved — surfaced (no notification was sent)
/// so the user can approve them here. Each carries the capability kinds it asked for.
#[tauri::command]
pub fn list_unknown_hosts(hosts: State<'_, Arc<Mutex<Hosts>>>) -> Vec<SiteView> {
    hosts
        .lock()
        .unwrap()
        .list_unknown()
        .into_iter()
        .map(|(origin, kinds)| SiteView { origin, kinds })
        .collect()
}

#[tauri::command]
pub fn add_host(hosts: State<'_, Arc<Mutex<Hosts>>>, origin: String) {
    hosts.lock().unwrap().add(origin.trim());
}

#[tauri::command]
pub fn remove_host(hosts: State<'_, Arc<Mutex<Hosts>>>, origin: String) {
    hosts.lock().unwrap().remove(&origin);
}

// ---- in-app error surface --------------------------------------------------

/// A small ring of recent operational errors, surfaced as a dismissible banner in the
/// window (e.g. the daemon failing to bind a port). Managed as Tauri state; pushed to
/// from the backend, read + dismissed by the UI — so failures aren't lost to stderr.
#[derive(Clone)]
pub struct AppErrors(Arc<Mutex<AppErrorsInner>>);

struct AppErrorsInner {
    next_id: u64,
    entries: VecDeque<ErrorEntry>,
}

#[derive(Clone, Serialize)]
pub struct ErrorEntry {
    pub id: u64,
    pub message: String,
}

impl AppErrors {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(AppErrorsInner {
            next_id: 1,
            entries: VecDeque::new(),
        })))
    }

    /// Record an error (also logged); keeps the most recent ~20.
    pub fn push(&self, message: impl Into<String>) {
        let message = message.into();
        eprintln!("icanhaz: {message}");
        let mut inner = self.0.lock().unwrap();
        let id = inner.next_id;
        inner.next_id += 1;
        inner.entries.push_back(ErrorEntry { id, message });
        while inner.entries.len() > 20 {
            inner.entries.pop_front();
        }
    }
}

#[tauri::command]
pub fn list_errors(errors: State<'_, AppErrors>) -> Vec<ErrorEntry> {
    errors.0.lock().unwrap().entries.iter().cloned().collect()
}

#[tauri::command]
pub fn dismiss_error(errors: State<'_, AppErrors>, id: u64) {
    errors.0.lock().unwrap().entries.retain(|e| e.id != id);
}

// ---- settings --------------------------------------------------------------

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub ws: String,
    pub wt: String,
    pub root: String,
}

/// Read-only info for the Settings tab (bind addresses + jail root + version).
#[tauri::command]
pub fn app_info() -> AppInfo {
    let env_or = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        ws: env_or("ICANHAZ_WS_BIND", "127.0.0.1:7777"),
        wt: env_or("ICANHAZ_WT_BIND", "127.0.0.1:7778"),
        root: std::env::var("ICANHAZ_ROOT").unwrap_or_else(|_| {
            std::env::temp_dir()
                .join("icanhaz-demo-root")
                .display()
                .to_string()
        }),
    }
}

/// Forget every remembered site (durable pairings).
#[tauri::command]
pub fn clear_pairings(pairings: State<'_, Arc<Mutex<Pairings>>>) {
    pairings.lock().unwrap().clear();
}

/// Remove every approved host.
#[tauri::command]
pub fn clear_hosts(hosts: State<'_, Arc<Mutex<Hosts>>>) {
    hosts.lock().unwrap().clear();
}

/// Resolve a parked request. `allow=false` denies; otherwise approve with the optional
/// attenuated `grant` (null ⇒ as-requested), the "remember this site" choice, and TTL.
/// Returns whether a request matched (false ⇒ it already timed out / was resolved).
#[tauri::command]
pub fn decide(
    pending: State<'_, PendingConsent>,
    id: String,
    allow: bool,
    grant: Option<CapabilityDto>,
    remember: bool,
    ttl_secs: u64,
) -> bool {
    let decision = if allow {
        Some(Approval {
            grant: grant.and_then(CapabilityDto::into_capability),
            remember,
            ttl_secs,
        })
    } else {
        None
    };
    pending.resolve(&id, decision)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fs_dto_round_trips_rights_and_paths() {
        let orig = CapabilityKind::Filesystem(FsRequest {
            roots: vec![PathGrant {
                path: "/proj".into(),
                rights: FsRights::READ | FsRights::WRITE,
            }],
        });
        let dto: CapabilityDto = (&orig).into();
        match &dto {
            CapabilityDto::Filesystem { roots } => {
                assert_eq!(roots[0].path, "/proj");
                assert!(roots[0].rights.read && roots[0].rights.write);
                assert!(!roots[0].rights.delete && !roots[0].rights.watch);
            }
            _ => panic!("wrong kind"),
        }
        // The editable form converts back faithfully (Phase D relies on this).
        match dto.into_capability().unwrap() {
            CapabilityKind::Filesystem(fs) => {
                assert_eq!(fs.roots[0].path, "/proj");
                assert_eq!(fs.roots[0].rights, FsRights::READ | FsRights::WRITE);
            }
            _ => panic!("wrong kind"),
        }
    }

    #[test]
    fn process_and_terminal_round_trip() {
        let p = CapabilityKind::Process(ProcessRequest {
            image: "rust-analyzer".into(),
            args: vec!["--stdio".into()],
            guest_chooses_argv: true,
        });
        match CapabilityDto::from(&p).into_capability().unwrap() {
            CapabilityKind::Process(got) => {
                assert_eq!(got.image, "rust-analyzer");
                assert_eq!(got.args, vec!["--stdio".to_string()]);
                assert!(got.guest_chooses_argv);
            }
            _ => panic!(),
        }
        let t = CapabilityKind::Terminal(TerminalRequest {
            shell: Some("/bin/zsh".into()),
            jailed: true,
        });
        match CapabilityDto::from(&t).into_capability().unwrap() {
            CapabilityKind::Terminal(got) => {
                assert_eq!(got.shell.as_deref(), Some("/bin/zsh"));
                assert!(got.jailed);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn sockets_defer_to_the_original() {
        // No editing UI for sockets ⇒ decide should approve as-requested (None).
        let dto = CapabilityDto::Sockets {
            endpoints: vec![],
            may_listen: false,
        };
        assert!(dto.into_capability().is_none());
    }
}
