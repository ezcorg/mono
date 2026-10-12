//! Who may dial what: the policy a witmproxy applies to every connection it
//! makes on a client's behalf.
//!
//! A forward proxy reaches whatever its host reaches. witmproxy began as one
//! person's tool, fronting their own traffic, and that is still the default:
//! a witmproxy with no policy permits every dial. Fronting clients that may
//! reach less than the host (a VM whose only way out is this proxy, a device
//! on a tailnet) needs the proxy to decline, itself, to go where they may
//! not. Policy is that: rules as data, written by the operator in the
//! instance's `policy.toml` and by whoever configures a tenant at the
//! management API, evaluated by the proxy at the moment of each dial. Plugins
//! do not take part.
//!
//! **The algebra is Cedar's.** A policy is an unordered set of rules, each
//! `permit` or `forbid`. For a dial: any matching `forbid` denies; else any
//! matching `permit` allows; else the tenant's `default`, else the instance's,
//! else permit. No priorities and no first-match, so an instance's `forbid`
//! is a floor no tenant's `permit` can undo, and adding a `permit` can only
//! widen what nothing forbids.
//!
//! **Rules have Tailscale's shape**: sources, `host:port` destinations, named
//! sets and `checks` that are evaluated when the policy loads.
//!
//! **A name is not an address.** A dial carries the name the client asked for
//! and the addresses it resolved to. A name pattern matches the name; a CIDR
//! matches each resolved address; a literal address is both. So `permit
//! api.example.com:443` beside `forbid @private:*` lets the name through to
//! its public addresses only, and a name that resolves only to private
//! addresses nowhere.

use std::collections::BTreeMap;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::ops::RangeInclusive;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// The document: what is written in policy.toml and sent to the API
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, salvo::oapi::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    Permit,
    Forbid,
}

impl fmt::Display for Effect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Effect::Permit => "permit",
            Effect::Forbid => "forbid",
        })
    }
}

/// A policy as written: TOML in an instance's `policy.toml`, JSON at
/// `PUT /api/manage/tenants/{id}/policy`. Compiled by [`Policy::compile`],
/// which is where the grammar of each string is checked.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, salvo::oapi::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyDoc {
    /// What a dial no rule matches gets. Unset: the layer below decides (a
    /// tenant's policy falls back to the instance's), and an instance with
    /// nothing set permits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Effect>,
    /// Named sets of hosts, referenced from a rule's `dst` as `@name:port`.
    /// Each entry is a host pattern: a name, `*.suffix`, an address or a
    /// CIDR.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sets: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<RuleDoc>,
    /// Assertions about the policy, evaluated when it loads; one that fails
    /// refuses the whole policy. By name only: no lookup is made.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<CheckDoc>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, salvo::oapi::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RuleDoc {
    pub effect: Effect,
    /// Who the rule is about: `*`, `tenant:<id>`, `ip:<address or CIDR>`; in
    /// a tenant's own policy only `self`. Empty means `*` at the instance
    /// and `self` for a tenant.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub src: Vec<String>,
    /// `host:port` each. host: `*`, a name, `*.suffix`, an address, a CIDR
    /// (IPv6 in brackets: `[fd00::]/8`), or `@set`. port: `*`, a number, a
    /// range `8000-8100`, or a list `80,443`.
    pub dst: Vec<String>,
    /// Reserved. Only `tcp` exists; absent means any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proto: Option<Vec<String>>,
    /// Free text, shown to the client and logged when the rule decides a
    /// dial.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, salvo::oapi::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckDoc {
    /// As a rule's `src` entry; `ip:` takes one address. Unset is `*` at the
    /// instance and `self` for a tenant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    /// `host:port` each, one port, that the policy must permit for `src`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permit: Vec<String>,
    /// `host:port` each, one port, that the policy must forbid for `src`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forbid: Vec<String>,
}

/// Where a policy comes from, which decides what `self` means and what a
/// rule may say about its source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Origin {
    /// The instance's own, from `policy.toml` and `--upstream-deny`.
    Instance,
    /// A tenant's, set at the management API. Its rules are about that
    /// tenant's traffic and nothing else's.
    Tenant(String),
}

impl fmt::Display for Origin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Origin::Instance => f.write_str("instance"),
            Origin::Tenant(id) => write!(f, "tenant {id}"),
        }
    }
}

/// A policy that could not be compiled or that fails its own checks. The
/// text names the rule and the string that was wrong; it is for whoever
/// wrote the policy.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PolicyError(String);

fn err<T>(msg: impl Into<String>) -> Result<T, PolicyError> {
    Err(PolicyError(msg.into()))
}

// ---------------------------------------------------------------------------
// Compiled forms
// ---------------------------------------------------------------------------

/// A network, as `addr/prefix`; a bare address is a /32 or /128.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Net {
    addr: IpAddr,
    prefix: u8,
}

impl Net {
    pub fn parse(s: &str) -> Result<Net, PolicyError> {
        let bare = s
            .strip_prefix('[')
            .and_then(|h| h.split_once(']'))
            .map(|(inner, rest)| format!("{inner}{rest}"))
            .unwrap_or_else(|| s.to_string());
        let (addr, prefix) = match bare.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (bare.as_str(), None),
        };
        let addr: IpAddr = match addr.parse() {
            Ok(a) => a,
            Err(e) => return err(format!("{s:?} is not an address or CIDR: {e}")),
        };
        let bits = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            Some(p) => match p.parse::<u8>().ok().filter(|p| *p <= bits) {
                Some(p) => p,
                None => return err(format!("{s:?}: prefix length must be 0..={bits}")),
            },
            None => bits,
        };
        Ok(Net {
            addr: normalize_ip(addr),
            prefix,
        })
    }

    /// Whether `ip` is in the network. An IPv4 address carried inside IPv6
    /// (`::ffff:10.0.0.1`) is judged as the IPv4 address it is.
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, normalize_ip(ip)) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - u32::from(self.prefix))
                };
                (u32::from(net) & mask) == (u32::from(ip) & mask)
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u128::MAX << (128 - u32::from(self.prefix))
                };
                (u128::from(net) & mask) == (u128::from(ip) & mask)
            }
            _ => false,
        }
    }
}

/// An IPv4 address inside IPv6 is that IPv4 address.
pub fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    }
}

/// Lowercase, without a trailing dot: the form names are compared in.
pub fn normalize_name(name: &str) -> String {
    name.trim_end_matches('.').to_ascii_lowercase()
}

/// An address literal as a host: `10.0.0.1`, `::1`, `[::1]`.
pub fn parse_literal(host: &str) -> Option<IpAddr> {
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    bare.parse::<Ipv4Addr>()
        .map(IpAddr::V4)
        .or_else(|_| bare.parse::<Ipv6Addr>().map(IpAddr::V6))
        .ok()
        .map(normalize_ip)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum HostPattern {
    Any,
    /// A name, exactly.
    Exact(String),
    /// `*.suffix`: the suffix itself and every name under it.
    Suffix(String),
    /// Matches a resolved address, or a literal one.
    Net(Net),
    /// A named set, resolved at evaluation.
    Set(String),
}

impl HostPattern {
    fn parse(host: &str) -> Result<HostPattern, PolicyError> {
        if host == "*" {
            return Ok(HostPattern::Any);
        }
        if let Some(set) = host.strip_prefix('@') {
            return if set.is_empty() {
                err("a set reference is @<name>")
            } else {
                Ok(HostPattern::Set(set.to_string()))
            };
        }
        let before_prefix = host
            .strip_prefix('[')
            .and_then(|h| h.split_once(']'))
            .map(|(inner, _)| inner.to_string())
            .unwrap_or_else(|| host.split('/').next().unwrap_or(host).to_string());
        if before_prefix.parse::<IpAddr>().is_ok() {
            return Net::parse(host).map(HostPattern::Net);
        }
        if let Some(suffix) = host.strip_prefix("*.") {
            return Ok(HostPattern::Suffix(validate_name(suffix)?));
        }
        Ok(HostPattern::Exact(validate_name(host)?))
    }

    /// Whether the pattern covers a dial. A name pattern looks at the name;
    /// a network looks at the address (or at the name when the name is an
    /// address literal); a set at each of its members.
    fn matches(&self, dial: &Dial<'_>, sets: &dyn Fn(&str) -> Option<Vec<HostPattern>>) -> bool {
        match self {
            HostPattern::Any => true,
            HostPattern::Exact(want) => dial.name == Some(want.as_str()),
            HostPattern::Suffix(suffix) => dial.name.is_some_and(|n| {
                n == suffix
                    || n.strip_suffix(suffix.as_str())
                        .is_some_and(|rest| rest.ends_with('.'))
            }),
            HostPattern::Net(net) => dial.addr.is_some_and(|a| net.contains(a)),
            HostPattern::Set(name) => sets(name)
                .unwrap_or_default()
                .iter()
                .any(|member| member.matches(dial, sets)),
        }
    }
}

fn validate_name(name: &str) -> Result<String, PolicyError> {
    let lower = normalize_name(name);
    let ok = !lower.is_empty()
        && !lower.starts_with('.')
        && !lower.contains("..")
        && lower
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_'));
    if ok {
        Ok(lower)
    } else {
        err(format!(
            "{name:?} is not a host: a name (letters, digits, '.', '-', '_'), `*.suffix`, \
             an address, a CIDR, `@set` or `*`"
        ))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Ports(Vec<RangeInclusive<u16>>);

impl Ports {
    fn parse(spec: &str) -> Result<Ports, PolicyError> {
        if spec == "*" {
            let any: RangeInclusive<u16> = 0..=u16::MAX;
            return Ok(Ports(vec![any]));
        }
        let mut ranges = Vec::new();
        for part in spec.split(',') {
            let part = part.trim();
            let range = match part.split_once('-') {
                Some((lo, hi)) => match (lo.trim().parse::<u16>(), hi.trim().parse::<u16>()) {
                    (Ok(lo), Ok(hi)) if lo <= hi => lo..=hi,
                    _ => return err(format!("{spec:?}: {part:?} is not a port range")),
                },
                None => match part.parse::<u16>() {
                    Ok(p) => p..=p,
                    Err(_) => {
                        return err(format!(
                            "{spec:?}: {part:?} is not a port (a number, `lo-hi`, a list or `*`)"
                        ));
                    }
                },
            };
            ranges.push(range);
        }
        if ranges.is_empty() {
            return err(format!("{spec:?}: no port"));
        }
        Ok(Ports(ranges))
    }

    fn contains(&self, port: u16) -> bool {
        self.0.iter().any(|r| r.contains(&port))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Dst {
    host: HostPattern,
    ports: Ports,
}

/// `host:port`, with an IPv6 host in brackets. The port is after the last
/// colon, so a bracketed CIDR reads `[fd00::]/8:*`.
fn split_host_port(text: &str) -> Result<(String, String), PolicyError> {
    let no_port = || {
        err(format!(
            "{text:?}: a destination is host:port; `:*` is any port"
        ))
    };
    if let Some(rest) = text.strip_prefix('[') {
        let Some((inner, after)) = rest.split_once(']') else {
            return err(format!("{text:?}: unclosed `[`"));
        };
        let Some((prefix, ports)) = after.rsplit_once(':') else {
            return no_port();
        };
        return Ok((format!("[{inner}]{prefix}"), ports.to_string()));
    }
    let Some((host, ports)) = text.rsplit_once(':') else {
        return no_port();
    };
    if host.contains(':') {
        return err(format!(
            "{text:?}: an IPv6 address goes in brackets, as [fd00::1]:443"
        ));
    }
    Ok((host.to_string(), ports.to_string()))
}

impl Dst {
    fn parse(text: &str) -> Result<Dst, PolicyError> {
        let (host, ports) = split_host_port(text.trim())?;
        Ok(Dst {
            host: HostPattern::parse(&host)?,
            ports: Ports::parse(&ports)?,
        })
    }

    fn matches(&self, dial: &Dial<'_>, sets: &dyn Fn(&str) -> Option<Vec<HostPattern>>) -> bool {
        self.ports.contains(dial.port) && self.host.matches(dial, sets)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Src {
    Any,
    Tenant(String),
    Ip(Net),
}

impl Src {
    fn parse(text: &str, origin: &Origin) -> Result<Src, PolicyError> {
        let text = text.trim();
        match (text, origin) {
            ("*", Origin::Instance) => Ok(Src::Any),
            ("self", Origin::Tenant(id)) => Ok(Src::Tenant(id.clone())),
            ("self", Origin::Instance) => {
                err("`self` means nothing at the instance: name a tenant, an ip or `*`")
            }
            (_, Origin::Tenant(_)) => err(format!(
                "{text:?}: a tenant's rules are about its own traffic; src is `self` or absent"
            )),
            (_, Origin::Instance) => {
                if let Some(id) = text.strip_prefix("tenant:") {
                    if id.is_empty() {
                        return err("tenant: needs an id");
                    }
                    Ok(Src::Tenant(id.to_string()))
                } else if let Some(cidr) = text.strip_prefix("ip:") {
                    Ok(Src::Ip(Net::parse(cidr)?))
                } else {
                    err(format!(
                        "{text:?} is not a source: `*`, `tenant:<id>` or `ip:<address or CIDR>`"
                    ))
                }
            }
        }
    }

    fn matches(&self, dial: &Dial<'_>) -> bool {
        match self {
            Src::Any => true,
            Src::Tenant(id) => dial.tenant == Some(id.as_str()),
            Src::Ip(net) => dial.src_ip.is_some_and(|ip| net.contains(ip)),
        }
    }
}

/// What `src` an empty list means.
fn implied_src(origin: &Origin) -> Src {
    match origin {
        Origin::Instance => Src::Any,
        Origin::Tenant(id) => Src::Tenant(id.clone()),
    }
}

#[derive(Clone, Debug)]
pub struct Rule {
    pub effect: Effect,
    src: Vec<Src>,
    dst: Vec<Dst>,
    /// Whether the rule applies to TCP, the only protocol there is.
    tcp: bool,
    pub comment: Option<String>,
    /// The rule as written, for the log and the client's error.
    text: String,
}

impl Rule {
    fn compile(doc: &RuleDoc, origin: &Origin) -> Result<Rule, PolicyError> {
        let src = if doc.src.is_empty() {
            vec![implied_src(origin)]
        } else {
            doc.src
                .iter()
                .map(|s| Src::parse(s, origin))
                .collect::<Result<_, _>>()?
        };
        if doc.dst.is_empty() {
            return err("a rule needs at least one dst");
        }
        let dst = doc
            .dst
            .iter()
            .map(|d| Dst::parse(d))
            .collect::<Result<_, _>>()?;
        let tcp = match &doc.proto {
            None => true,
            Some(protos) => {
                for p in protos {
                    if p != "tcp" {
                        return err(format!("proto {p:?}: only tcp exists"));
                    }
                }
                protos.iter().any(|p| p == "tcp")
            }
        };
        let src_text = if doc.src.is_empty() {
            match origin {
                Origin::Instance => "*".to_string(),
                Origin::Tenant(_) => "self".to_string(),
            }
        } else {
            doc.src.join(",")
        };
        Ok(Rule {
            effect: doc.effect,
            src,
            dst,
            tcp,
            comment: doc.comment.clone(),
            text: format!("{} {} -> {}", doc.effect, src_text, doc.dst.join(",")),
        })
    }

    fn matches(&self, dial: &Dial<'_>, sets: &dyn Fn(&str) -> Option<Vec<HostPattern>>) -> bool {
        self.tcp
            && self.src.iter().any(|s| s.matches(dial))
            && self.dst.iter().any(|d| d.matches(dial, sets))
    }

    /// The rule as written, with its comment.
    pub fn describe(&self) -> String {
        match &self.comment {
            Some(c) => format!("{} ({c})", self.text),
            None => self.text.clone(),
        }
    }
}

#[derive(Clone, Debug)]
struct Check {
    src: Src,
    src_ip: Option<IpAddr>,
    permit: Vec<(String, u16)>,
    forbid: Vec<(String, u16)>,
}

fn parse_check_dst(text: &str) -> Result<(String, u16), PolicyError> {
    let (host, port) = split_host_port(text.trim())?;
    let port: u16 = match port.parse() {
        Ok(p) => p,
        Err(_) => return err(format!("{text:?}: a check names one port")),
    };
    if host == "*" || host.starts_with('@') || host.starts_with("*.") {
        return err(format!("{text:?}: a check names one host, not a pattern"));
    }
    Ok((host, port))
}

impl Check {
    fn compile(doc: &CheckDoc, origin: &Origin) -> Result<Check, PolicyError> {
        let (src, src_ip) = match &doc.src {
            None => (implied_src(origin), None),
            Some(s) => match Src::parse(s, origin)? {
                Src::Ip(net) if net.prefix == 32 || net.prefix == 128 => {
                    (Src::Ip(net), Some(net.addr))
                }
                Src::Ip(_) => return err(format!("{s:?}: a check's ip: is one address")),
                other => (other, None),
            },
        };
        Ok(Check {
            src,
            src_ip,
            permit: doc
                .permit
                .iter()
                .map(|d| parse_check_dst(d))
                .collect::<Result<_, _>>()?,
            forbid: doc
                .forbid
                .iter()
                .map(|d| parse_check_dst(d))
                .collect::<Result<_, _>>()?,
        })
    }
}

/// A compiled policy: one layer of the stack a dial is judged against.
#[derive(Clone, Debug)]
pub struct Policy {
    pub origin: Origin,
    default: Option<Effect>,
    sets: BTreeMap<String, Vec<HostPattern>>,
    rules: Vec<Rule>,
    checks: Vec<Check>,
}

impl Policy {
    /// A policy that says nothing: no rules, no default.
    pub fn empty(origin: Origin) -> Policy {
        Policy {
            origin,
            default: None,
            sets: BTreeMap::new(),
            rules: Vec::new(),
            checks: Vec::new(),
        }
    }

    /// Compile a document. Every string is checked here; what comes back
    /// evaluates without failing. Set references and checks are verified by
    /// [`Policy::validate`], which needs the layer below.
    pub fn compile(doc: &PolicyDoc, origin: Origin) -> Result<Policy, PolicyError> {
        let mut sets = BTreeMap::new();
        for (name, members) in &doc.sets {
            if name.is_empty() || name.starts_with('@') || name.contains(':') {
                return err(format!("set {name:?}: a set name has no '@' or ':'"));
            }
            let mut compiled = Vec::with_capacity(members.len());
            for member in members {
                let pattern = HostPattern::parse(member.trim())
                    .map_err(|e| PolicyError(format!("set {name}: {e}")))?;
                if matches!(pattern, HostPattern::Set(_)) {
                    return err(format!("set {name}: a set holds hosts, not other sets"));
                }
                compiled.push(pattern);
            }
            sets.insert(name.clone(), compiled);
        }
        let rules = doc
            .rules
            .iter()
            .enumerate()
            .map(|(i, r)| {
                Rule::compile(r, &origin).map_err(|e| PolicyError(format!("rule {}: {e}", i + 1)))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let checks = doc
            .checks
            .iter()
            .enumerate()
            .map(|(i, c)| {
                Check::compile(c, &origin).map_err(|e| PolicyError(format!("check {}: {e}", i + 1)))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Policy {
            origin,
            default: doc.default,
            sets,
            rules,
            checks,
        })
    }

    /// Parse and compile TOML, the file form.
    pub fn from_toml(text: &str, origin: Origin) -> Result<Policy, PolicyError> {
        let doc: PolicyDoc = toml::from_str(text).map_err(|e| PolicyError(e.to_string()))?;
        Policy::compile(&doc, origin)
    }

    /// The instance-level shorthand `--upstream-deny a,b,c`: one `forbid`
    /// from everyone to the listed networks on any port.
    pub fn upstream_deny(spec: &str) -> Result<Policy, PolicyError> {
        let mut dst: Vec<String> = Vec::new();
        for cidr in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            // A list of networks, nothing else: a name here is a mistake.
            Net::parse(cidr)?;
            dst.push({
                if cidr.contains(':') && !cidr.starts_with('[') {
                    // The grammar wants IPv6 in brackets, prefix outside.
                    match cidr.split_once('/') {
                        Some((addr, prefix)) => format!("[{addr}]/{prefix}:*"),
                        None => format!("[{cidr}]:*"),
                    }
                } else {
                    format!("{cidr}:*")
                }
            });
        }
        if dst.is_empty() {
            return Ok(Policy::empty(Origin::Instance));
        }
        let doc = PolicyDoc {
            rules: vec![RuleDoc {
                effect: Effect::Forbid,
                src: vec![],
                dst,
                proto: None,
                comment: Some("--upstream-deny".to_string()),
            }],
            ..Default::default()
        };
        Policy::compile(&doc, Origin::Instance)
    }

    /// This policy with `other`'s sets and rules added. For an instance whose
    /// floor comes from both `policy.toml` and `--upstream-deny`.
    pub fn merged_with(mut self, other: Policy) -> Policy {
        self.sets.extend(other.sets);
        self.rules.extend(other.rules);
        self.checks.extend(other.checks);
        if self.default.is_none() {
            self.default = other.default;
        }
        self
    }

    /// Whether the policy decides nothing: no rules and no default. A dial
    /// judged against only empty policies is permitted, and the proxy skips
    /// the resolution it would otherwise do before answering a CONNECT.
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty() && self.default.is_none()
    }

    pub fn default_effect(&self) -> Option<Effect> {
        self.default
    }

    pub fn rules(&self) -> &[Rule] {
        &self.rules
    }

    /// Verify the policy against the layer it will sit on: every `@set` a
    /// rule names exists in this policy or `below`, and every check holds.
    /// A check is a dial by name (or by address, for a literal) on the stack
    /// `[below, self]`.
    pub fn validate(&self, below: Option<&Policy>) -> Result<(), PolicyError> {
        let stack: Vec<&Policy> = below.into_iter().chain(std::iter::once(self)).collect();
        for rule in &self.rules {
            for dst in &rule.dst {
                if let HostPattern::Set(name) = &dst.host
                    && lookup_set(&stack, name).is_none()
                {
                    return err(format!("{}: no set named {name:?}", rule.text));
                }
            }
        }
        let mut failures = Vec::new();
        for (i, check) in self.checks.iter().enumerate() {
            let tenant = match &check.src {
                Src::Tenant(id) => Some(id.as_str()),
                _ => None,
            };
            for (want, list) in [
                (Effect::Permit, &check.permit),
                (Effect::Forbid, &check.forbid),
            ] {
                for (host, port) in list {
                    let literal = parse_literal(host);
                    let name = if literal.is_none() {
                        Some(normalize_name(host))
                    } else {
                        None
                    };
                    let dial = Dial {
                        tenant,
                        src_ip: check.src_ip,
                        name: name.as_deref(),
                        addr: literal,
                        port: *port,
                    };
                    let got = decide(&stack, &dial);
                    if got.effect != want {
                        failures.push(format!(
                            "check {}: expected {want} for {host}:{port}, got {}",
                            i + 1,
                            got
                        ));
                    }
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            err(failures.join("; "))
        }
    }
}

fn lookup_set(stack: &[&Policy], name: &str) -> Option<Vec<HostPattern>> {
    stack.iter().rev().find_map(|p| p.sets.get(name).cloned())
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/// One connection the proxy is about to make, as the rules see it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dial<'a> {
    /// The tenant the client resolved to, if any.
    pub tenant: Option<&'a str>,
    /// The client's address.
    pub src_ip: Option<IpAddr>,
    /// The name the client asked for, normalized; `None` for a literal.
    pub name: Option<&'a str>,
    /// The address about to be dialed; `None` before resolution.
    pub addr: Option<IpAddr>,
    pub port: u16,
}

/// What the policy stack said about a dial, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub effect: Effect,
    /// The rule that decided, as written, with its origin; `None` when a
    /// default did.
    pub rule: Option<String>,
}

impl Decision {
    pub fn is_permit(&self) -> bool {
        self.effect == Effect::Permit
    }
}

impl fmt::Display for Decision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.rule {
            Some(rule) => write!(f, "{} by {rule}", self.effect),
            None => write!(f, "{} by default", self.effect),
        }
    }
}

/// Judge a dial against a stack of policies, the instance's first and a
/// tenant's above it: any matching forbid, else any matching permit, else
/// the uppermost default that is set, else permit.
pub fn decide(stack: &[&Policy], dial: &Dial<'_>) -> Decision {
    let sets = |name: &str| lookup_set(stack, name);
    let mut permit: Option<String> = None;
    for policy in stack {
        for rule in &policy.rules {
            if !rule.matches(dial, &sets) {
                continue;
            }
            let text = format!("{} rule `{}`", policy.origin, rule.describe());
            match rule.effect {
                Effect::Forbid => {
                    return Decision {
                        effect: Effect::Forbid,
                        rule: Some(text),
                    };
                }
                Effect::Permit => {
                    if permit.is_none() {
                        permit = Some(text);
                    }
                }
            }
        }
    }
    if let Some(rule) = permit {
        return Decision {
            effect: Effect::Permit,
            rule: Some(rule),
        };
    }
    let effect = stack
        .iter()
        .rev()
        .find_map(|p| p.default)
        .unwrap_or(Effect::Permit);
    Decision { effect, rule: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance(toml: &str) -> Policy {
        Policy::from_toml(toml, Origin::Instance).unwrap_or_else(|e| panic!("{e}"))
    }

    fn tenant(id: &str, json: &str) -> Policy {
        let doc: PolicyDoc = serde_json::from_str(json).unwrap();
        Policy::compile(&doc, Origin::Tenant(id.to_string())).unwrap_or_else(|e| panic!("{e}"))
    }

    fn dial<'a>(
        tenant: Option<&'a str>,
        name: Option<&'a str>,
        addr: Option<&str>,
        port: u16,
    ) -> Dial<'a> {
        Dial {
            tenant,
            src_ip: None,
            name,
            addr: addr.map(|a| a.parse().unwrap()),
            port,
        }
    }

    const FLOOR: &str = r#"
[sets]
private = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "[fc00::]/7", "[::1]"]

[[rules]]
effect = "forbid"
dst = ["@private:*"]
comment = "this host's own networks"
"#;

    #[test]
    fn destinations_parse_and_nonsense_is_refused() {
        for ok in [
            "*:*",
            "api.example.com:443",
            "*.example.com:443",
            "10.0.0.0/8:*",
            "10.0.0.5:22",
            "[fd00::1]:443",
            "[fc00::]/7:*",
            "@private:*",
            "example.com:80,443",
            "example.com:8000-8100",
            "1password.com:443",
        ] {
            Dst::parse(ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
        for bad in [
            "example.com",
            "fd00::1:443",
            "10.0.0.0/33:*",
            "@:443",
            "ex ample.com:443",
            "example.com:x",
            "example.com:9-1",
            "example.com:",
            "*.:443",
        ] {
            assert!(Dst::parse(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn sources_depend_on_the_origin() {
        let inst = Origin::Instance;
        let ten = Origin::Tenant("t1".into());
        assert_eq!(Src::parse("*", &inst).unwrap(), Src::Any);
        assert_eq!(
            Src::parse("tenant:rig:vm", &inst).unwrap(),
            Src::Tenant("rig:vm".into())
        );
        assert!(matches!(
            Src::parse("ip:10.207.0.5", &inst).unwrap(),
            Src::Ip(_)
        ));
        assert!(Src::parse("self", &inst).is_err());
        assert!(Src::parse("bogus", &inst).is_err());
        assert_eq!(Src::parse("self", &ten).unwrap(), Src::Tenant("t1".into()));
        assert!(Src::parse("*", &ten).is_err());
        assert!(Src::parse("tenant:t2", &ten).is_err());
        assert!(Src::parse("ip:10.0.0.1", &ten).is_err());
    }

    #[test]
    fn nothing_said_means_permit() {
        let p = instance("");
        assert!(p.is_empty());
        let d = decide(
            &[&p],
            &dial(None, Some("example.com"), Some("93.184.216.34"), 443),
        );
        assert_eq!(d.effect, Effect::Permit);
        assert_eq!(d.rule, None);
        assert_eq!(d.to_string(), "permit by default");
    }

    #[test]
    fn a_forbid_by_network_judges_the_address_not_the_name() {
        let floor = instance(FLOOR);
        let stack = [&floor];
        // A public address of any name is fine.
        assert!(
            decide(
                &stack,
                &dial(None, Some("example.com"), Some("93.184.216.34"), 443)
            )
            .is_permit()
        );
        // A private one is not, whatever it was called.
        let d = decide(
            &stack,
            &dial(None, Some("gateway.lan"), Some("192.168.1.1"), 443),
        );
        assert_eq!(d.effect, Effect::Forbid);
        assert!(
            d.rule
                .as_deref()
                .unwrap()
                .contains("this host's own networks"),
            "{d}"
        );
        // IPv4 inside IPv6 is IPv4; IPv6 private too.
        assert!(!decide(&stack, &dial(None, None, Some("::ffff:10.0.0.1"), 22)).is_permit());
        assert!(!decide(&stack, &dial(None, None, Some("fd7a:115c:a1e0::1"), 22)).is_permit());
        assert!(!decide(&stack, &dial(None, None, Some("::1"), 80)).is_permit());
        // Before resolution a name matches no network rule.
        assert!(decide(&stack, &dial(None, Some("gateway.lan"), None, 443)).is_permit());
    }

    #[test]
    fn a_tenant_permits_by_name_under_a_floor_it_cannot_lift() {
        let floor = instance(FLOOR);
        let t = tenant(
            "rig:vm",
            r#"{"default": "forbid",
                "rules": [{"effect": "permit", "dst": ["api.example.com:443", "*.cache.example.org:443"]}]}"#,
        );
        let stack = [&floor, &t];
        let vm = Some("rig:vm");
        let ok = decide(
            &stack,
            &dial(vm, Some("api.example.com"), Some("93.184.216.34"), 443),
        );
        assert!(ok.is_permit());
        assert!(
            ok.rule
                .as_deref()
                .unwrap()
                .starts_with("tenant rig:vm rule `permit self -> "),
            "{ok}"
        );
        // Other port, other host, same host elsewhere: the tenant's default.
        let d = decide(
            &stack,
            &dial(vm, Some("api.example.com"), Some("93.184.216.34"), 80),
        );
        assert_eq!((d.effect, d.rule), (Effect::Forbid, None));
        assert!(
            !decide(
                &stack,
                &dial(vm, Some("other.example.com"), Some("93.184.216.34"), 443)
            )
            .is_permit()
        );
        // The suffix covers the apex and anything under it.
        assert!(
            decide(
                &stack,
                &dial(vm, Some("cache.example.org"), Some("93.184.216.34"), 443)
            )
            .is_permit()
        );
        assert!(
            decide(
                &stack,
                &dial(
                    vm,
                    Some("a.b.cache.example.org"),
                    Some("93.184.216.34"),
                    443
                )
            )
            .is_permit()
        );
        assert!(
            !decide(
                &stack,
                &dial(vm, Some("notcache.example.org"), Some("93.184.216.34"), 443)
            )
            .is_permit()
        );
        // The permitted name pointed at a private address: the floor wins.
        let d = decide(
            &stack,
            &dial(vm, Some("api.example.com"), Some("10.0.0.5"), 443),
        );
        assert_eq!(d.effect, Effect::Forbid);
        assert!(
            d.rule.as_deref().unwrap().starts_with("instance rule"),
            "{d}"
        );
        // Another tenant's stack is the floor and its own policy, never this
        // one's: it gets none of these permits and none of this default.
        assert!(
            decide(
                &[&floor],
                &dial(
                    Some("other"),
                    Some("other.example.com"),
                    Some("93.184.216.34"),
                    443
                )
            )
            .is_permit()
        );
        assert!(
            decide(
                &[&floor],
                &dial(None, Some("other.example.com"), Some("93.184.216.34"), 443)
            )
            .is_permit()
        );
        // Were it in the stack, its rules would not match another tenant.
        let d = decide(
            &stack,
            &dial(
                Some("other"),
                Some("api.example.com"),
                Some("93.184.216.34"),
                443,
            ),
        );
        assert_eq!(d.rule, None);
    }

    #[test]
    fn an_instance_rule_may_name_a_tenant_or_an_address() {
        let floor = instance(
            r#"
default = "forbid"
[[rules]]
effect = "permit"
src = ["ip:10.207.0.5"]
dst = ["api.example.com:443"]
[[rules]]
effect = "permit"
src = ["tenant:lab"]
dst = ["*:443"]
"#,
        );
        let stack = [&floor];
        let from = |ip: &str, tenant: Option<&'static str>, name: &'static str| Dial {
            tenant,
            src_ip: Some(ip.parse().unwrap()),
            name: Some(name),
            addr: Some("93.184.216.34".parse().unwrap()),
            port: 443,
        };
        assert!(decide(&stack, &from("10.207.0.5", None, "api.example.com")).is_permit());
        assert!(!decide(&stack, &from("10.207.0.6", None, "api.example.com")).is_permit());
        assert!(!decide(&stack, &from("10.207.0.5", None, "www.example.com")).is_permit());
        assert!(decide(&stack, &from("10.207.0.6", Some("lab"), "www.example.com")).is_permit());
    }

    #[test]
    fn checks_hold_or_refuse_the_policy() {
        let floor = instance(FLOOR);
        let good = tenant(
            "t",
            r#"{"default": "forbid",
                "rules": [{"effect": "permit", "dst": ["api.example.com:443"]}],
                "checks": [{"permit": ["api.example.com:443"],
                            "forbid": ["api.example.com:80", "example.com:443", "10.0.0.5:22"]}]}"#,
        );
        good.validate(Some(&floor)).unwrap();
        let bad = tenant(
            "t",
            r#"{"default": "forbid",
                "rules": [{"effect": "permit", "dst": ["api.example.com:443"]}],
                "checks": [{"forbid": ["api.example.com:443"]}]}"#,
        );
        let e = bad.validate(Some(&floor)).unwrap_err().to_string();
        assert!(
            e.contains("check 1: expected forbid for api.example.com:443, got permit"),
            "{e}"
        );
        // A set the floor does not define.
        let orphan = tenant(
            "t",
            r#"{"rules": [{"effect": "forbid", "dst": ["@nowhere:*"]}]}"#,
        );
        let e = orphan.validate(Some(&floor)).unwrap_err().to_string();
        assert!(e.contains("no set named \"nowhere\""), "{e}");
        // A set the floor does define is fine from a tenant.
        tenant(
            "t",
            r#"{"rules": [{"effect": "forbid", "dst": ["@private:*"]}]}"#,
        )
        .validate(Some(&floor))
        .unwrap();
    }

    #[test]
    fn documents_are_strict() {
        assert!(Policy::from_toml("bogus = 1", Origin::Instance).is_err());
        assert!(Policy::from_toml("[[rules]]\neffect = \"permit\"", Origin::Instance).is_err());
        assert!(
            Policy::from_toml(
                "[[rules]]\neffect = \"allow\"\ndst = [\"*:*\"]",
                Origin::Instance
            )
            .is_err()
        );
        assert!(
            Policy::from_toml(
                "[[rules]]\neffect = \"permit\"\ndst = [\"*:*\"]\nproto = [\"udp\"]",
                Origin::Instance
            )
            .is_err()
        );
        let e = Policy::from_toml(
            "[[rules]]\neffect = \"permit\"\ndst = [\"example.com\"]",
            Origin::Instance,
        )
        .unwrap_err()
        .to_string();
        assert!(e.starts_with("rule 1: "), "{e}");
        assert!(Policy::from_toml("[sets]\n\"@x\" = [\"a.b\"]", Origin::Instance).is_err());
        assert!(Policy::from_toml("[sets]\nx = [\"@y\"]", Origin::Instance).is_err());
    }

    #[test]
    fn upstream_deny_is_a_forbid_from_everyone() {
        let p = Policy::upstream_deny("10.0.0.0/8, 127.0.0.1,fc00::/7,::1/128").unwrap();
        assert_eq!(p.rules.len(), 1);
        assert_eq!(
            p.rules[0].text,
            "forbid * -> 10.0.0.0/8:*,127.0.0.1:*,[fc00::]/7:*,[::1]/128:*"
        );
        let stack = [&p];
        assert!(!decide(&stack, &dial(None, None, Some("10.1.2.3"), 1)).is_permit());
        assert!(!decide(&stack, &dial(None, None, Some("fd00::1"), 1)).is_permit());
        assert!(!decide(&stack, &dial(None, None, Some("::1"), 1)).is_permit());
        assert!(decide(&stack, &dial(None, None, Some("8.8.8.8"), 1)).is_permit());
        assert!(Policy::upstream_deny(" , ").unwrap().is_empty());
        assert!(Policy::upstream_deny("example.com").is_err());
    }

    #[test]
    fn names_compare_case_insensitively_and_without_the_root_dot() {
        assert_eq!(normalize_name("API.Example.COM."), "api.example.com");
        let p = instance(
            "default = \"forbid\"\n[[rules]]\neffect = \"permit\"\ndst = [\"API.example.com:443\"]",
        );
        assert!(decide(&[&p], &dial(None, Some("api.example.com"), None, 443)).is_permit());
    }
}
