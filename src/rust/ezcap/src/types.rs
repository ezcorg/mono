//! Rust mirrors of `ezco:ezcap/types`.

use serde::{Deserialize, Serialize};
use std::fmt;

/// How a capability may be used: two CEL expressions. See `wit/ezcap.wit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scope {
    /// Evaluated once per event: should the holder run at all.
    pub when: String,
    /// Evaluated per call on the minted resource: may this call proceed.
    pub allow: String,
}

impl Scope {
    /// A scope that admits everything: a plain grant.
    pub fn unrestricted() -> Self {
        Scope {
            when: "true".to_string(),
            allow: "true".to_string(),
        }
    }

    /// Scope with only a call clause (the common case for non-event
    /// capabilities).
    pub fn allow(expr: impl Into<String>) -> Self {
        Scope {
            when: "true".to_string(),
            allow: expr.into(),
        }
    }

    /// The scope a child instance gets when this one is narrowed: every field
    /// is conjoined with the extra clause. Appending is the *only* way a scope
    /// changes, which is what makes containment syntactic.
    pub fn narrowed(&self, extra: &Narrowing) -> Scope {
        Scope {
            when: conjoin(&self.when, extra.when.as_deref()),
            allow: conjoin(&self.allow, extra.allow.as_deref()),
        }
    }
}

/// What a narrowing adds. `None` leaves that field as the parent's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Narrowing {
    pub when: Option<String>,
    pub allow: Option<String>,
}

impl Narrowing {
    pub fn allow(expr: impl Into<String>) -> Self {
        Narrowing {
            when: None,
            allow: Some(expr.into()),
        }
    }
    pub fn when(expr: impl Into<String>) -> Self {
        Narrowing {
            when: Some(expr.into()),
            allow: None,
        }
    }

    /// Nothing added.
    pub fn is_empty(&self) -> bool {
        self.when.as_deref().is_none_or(|s| s.trim().is_empty())
            && self.allow.as_deref().is_none_or(|s| s.trim().is_empty())
    }

    /// Both narrowings, in order: what a chain of appended clauses adds up to.
    pub fn and(&self, other: &Narrowing) -> Narrowing {
        let both = |a: Option<&str>, b: Option<&str>| -> Option<String> {
            match (a.map(str::trim).filter(|s| !s.is_empty()), b.map(str::trim).filter(|s| !s.is_empty())) {
                (None, None) => None,
                (Some(a), None) => Some(a.to_string()),
                (None, Some(b)) => Some(b.to_string()),
                (Some(a), Some(b)) => Some(conjoin(a, Some(b))),
            }
        };
        Narrowing {
            when: both(self.when.as_deref(), other.when.as_deref()),
            allow: both(self.allow.as_deref(), other.allow.as_deref()),
        }
    }
}

fn conjoin(base: &str, extra: Option<&str>) -> String {
    match extra.map(str::trim) {
        None | Some("") => base.to_string(),
        Some(extra) => {
            // `true && x` is `x`; keep the stored text tidy for the profile.
            if base.trim() == "true" {
                extra.to_string()
            } else {
                format!("({base}) && ({extra})")
            }
        }
    }
}

/// A WIT path naming an interface, a resource, or a method:
/// `ns:pkg/iface`, `ns:pkg/iface@0.1.0`, `ns:pkg/iface.resource`,
/// `ns:pkg/iface.resource.method`, `ns:pkg/iface.function`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Kind(pub String);

/// The parsed parts of a [`Kind`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindParts {
    /// `ns:pkg`
    pub package: String,
    /// `iface`
    pub interface: String,
    /// `0.1.0`, if given.
    pub version: Option<String>,
    /// Dotted path after the interface: `[]`, `[resource]`, `[resource, method]`, `[function]`.
    pub path: Vec<String>,
}

impl Kind {
    pub fn new(s: impl Into<String>) -> Self {
        Kind(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Split the path. Errors on anything that is not `ns:pkg/iface[@ver][.a[.b]]`.
    pub fn parse(&self) -> Result<KindParts, KindError> {
        let s = self.0.as_str();
        let (package, rest) = s.split_once('/').ok_or(KindError::MissingInterface)?;
        if !package.contains(':') || package.starts_with(':') || package.ends_with(':') {
            return Err(KindError::BadPackage);
        }
        // `iface`, then an optional `@MAJOR.MINOR.PATCH` (digits and dots; a
        // `-pre`/`+build` suffix is allowed only when nothing follows), then
        // an optional dotted path.
        let iface_end = rest.find(['@', '.']).unwrap_or(rest.len());
        let interface = &rest[..iface_end];
        if interface.is_empty() {
            return Err(KindError::MissingInterface);
        }
        let mut tail = &rest[iface_end..];
        let mut version = None;
        if let Some(v) = tail.strip_prefix('@') {
            let core_end = v
                .find(|c: char| !(c.is_ascii_digit() || c == '.'))
                .unwrap_or(v.len());
            let (core, after) = v.split_at(core_end);
            // The core may not end with a `.` that belongs to the path.
            let core = core.trim_end_matches('.');
            if core.is_empty() {
                return Err(KindError::BadPath);
            }
            if after.starts_with(['-', '+']) {
                version = Some(v.to_string());
                tail = "";
            } else {
                version = Some(core.to_string());
                tail = &v[core.len()..];
            }
        }
        let path: Vec<String> = match tail {
            "" => Vec::new(),
            t => t
                .strip_prefix('.')
                .ok_or(KindError::BadPath)?
                .split('.')
                .map(str::to_string)
                .collect(),
        };
        if path.len() > 2 || path.iter().any(String::is_empty) {
            return Err(KindError::BadPath);
        }
        Ok(KindParts {
            package: package.to_string(),
            interface: interface.to_string(),
            version,
            path,
        })
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KindError {
    #[error("kind must start with `ns:pkg/`")]
    BadPackage,
    #[error("kind names no interface")]
    MissingInterface,
    #[error("kind path may be `iface`, `iface.item` or `iface.resource.method`")]
    BadPath,
}

/// A request for, or description of, one capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capability {
    pub kind: Kind,
    pub scope: Scope,
}

impl Capability {
    pub fn new(kind: impl Into<String>, scope: Scope) -> Self {
        Capability {
            kind: Kind::new(kind),
            scope,
        }
    }
}

/// Why a call on a capability did not proceed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
pub enum CapabilityError {
    /// Never granted, or revoked.
    #[error("capability unavailable")]
    Unavailable,
    /// Granted, but outside `allow`. Carries the scope rendered as a sentence.
    #[error("denied: {0}")]
    Denied(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_parses_paths() {
        let k = Kind::new("witmproxy:plugin/capabilities.local-storage-client.set");
        let p = match k.parse() {
            Ok(p) => p,
            Err(e) => panic!("{e}"),
        };
        assert_eq!(p.package, "witmproxy:plugin");
        assert_eq!(p.interface, "capabilities");
        assert_eq!(p.version, None);
        assert_eq!(p.path, vec!["local-storage-client", "set"]);

        let k = Kind::new("icanhaz:nocap/fs@0.1.0");
        let p = match k.parse() {
            Ok(p) => p,
            Err(e) => panic!("{e}"),
        };
        assert_eq!(p.version.as_deref(), Some("0.1.0"));
        assert!(p.path.is_empty());

        let k = Kind::new("icanhaz:nocap/process@0.1.0.spawn");
        let p = match k.parse() {
            Ok(p) => p,
            Err(e) => panic!("{e}"),
        };
        assert_eq!(p.version.as_deref(), Some("0.1.0"));
        assert_eq!(p.path, vec!["spawn"]);

        let k = Kind::new("a:b/c@1.0.0-rc.1");
        let p = match k.parse() {
            Ok(p) => p,
            Err(e) => panic!("{e}"),
        };
        assert_eq!(p.version.as_deref(), Some("1.0.0-rc.1"));

        assert_eq!(Kind::new("nope").parse(), Err(KindError::MissingInterface));
        assert_eq!(Kind::new("a/b.c.d.e").parse(), Err(KindError::BadPackage));
        assert_eq!(Kind::new("a:b/c.d.e.f").parse(), Err(KindError::BadPath));
    }

    #[test]
    fn narrowing_appends_only() {
        let s = Scope::allow("a");
        let child = s.narrowed(&Narrowing::allow("b"));
        assert_eq!(child.allow, "(a) && (b)");
        assert_eq!(child.when, "true");
        let grandchild = child.narrowed(&Narrowing::when("w"));
        assert_eq!(grandchild.when, "w");
        assert_eq!(grandchild.allow, "(a) && (b)");
        let same = grandchild.narrowed(&Narrowing::default());
        assert_eq!(same, grandchild);
    }
}
