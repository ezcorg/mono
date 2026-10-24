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

    /// Whether `other` admits no more than this scope: field by field, the
    /// same text, or this field with clauses conjoined onto it the way
    /// [`Scope::narrowed`] conjoins them. Containment is syntactic, which
    /// appending makes sound: `(left) && (right)` with both sides closed
    /// expressions is one conjunction, so it admits a subset of what `left`
    /// does whatever `right` says. An unrestricted field (`true`) contains
    /// every field. Nothing is inferred about the expressions' meaning: a
    /// clause rewritten to an equivalent text is not recognised as contained,
    /// and needs a fresh decision.
    pub fn contains(&self, other: &Scope) -> bool {
        clause_contains(&self.when, &other.when) && clause_contains(&self.allow, &other.allow)
    }
}

/// See [`Scope::contains`]: `other` is `base`, or `(left) && (right)` with
/// `left` contained in `base` and both sides closed.
fn clause_contains(base: &str, other: &str) -> bool {
    let base = base.trim();
    let other = other.trim();
    if base == "true" || base == other {
        return true;
    }
    let Some(inner) = other.strip_prefix('(').and_then(|s| s.strip_suffix(')')) else {
        return false;
    };
    // Every `) && (` is a candidate split; only one where both halves are
    // closed is a top-level conjunction (a split inside a literal or a
    // bracket leaves a half unbalanced or unterminated).
    const AND: &str = ") && (";
    let mut from = 0;
    while let Some(pos) = inner[from..].find(AND) {
        let at = from + pos;
        let left = &inner[..at];
        let right = &inner[at + AND.len()..];
        if clause_is_closed(left) && clause_is_closed(right) && clause_contains(base, left) {
            return true;
        }
        from = at + 1;
    }
    false
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

    /// Whether every clause is a *closed* expression: one that `(clause)`
    /// wraps as a single CEL primary, so conjoining it cannot reach outside
    /// its own parentheses. See [`clause_is_closed`].
    pub fn is_closed(&self) -> bool {
        self.when.as_deref().is_none_or(clause_is_closed)
            && self.allow.as_deref().is_none_or(clause_is_closed)
    }

    /// Both narrowings, in order: what a chain of appended clauses adds up to.
    pub fn and(&self, other: &Narrowing) -> Narrowing {
        let both = |a: Option<&str>, b: Option<&str>| -> Option<String> {
            match (
                a.map(str::trim).filter(|s| !s.is_empty()),
                b.map(str::trim).filter(|s| !s.is_empty()),
            ) {
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

/// Whether `expr` is a closed CEL expression at the token level: its `()`,
/// `[]` and `{}` balance outside string literals. Conjunction is textual
/// (`(base) && (extra)`), so an unbalanced `extra` such as `true) || (true`
/// would otherwise escape its parentheses and widen the result. A closed
/// clause wrapped in parentheses is one primary to the parser, whatever else
/// is in it; a clause that is not closed is refused before it is conjoined.
///
/// String literals follow CEL's lexer: `"…"`, `'…'`, the triple-quoted forms,
/// `r`/`R` raw prefixes (no escapes) and `b`/`B` bytes prefixes. CEL has no
/// comment syntax, so nothing else can hide a bracket.
pub fn clause_is_closed(expr: &str) -> bool {
    let chars: Vec<char> = expr.chars().collect();
    let mut stack: Vec<char> = Vec::new();
    let mut i = 0;
    while let Some(&c) = chars.get(i) {
        // A string literal, with up to two prefix letters (`r`, `b`, `rb`, `br`).
        let mut j = i;
        let mut raw = false;
        while j - i < 2
            && let Some(&p) = chars.get(j)
            && matches!(p, 'r' | 'R' | 'b' | 'B')
        {
            raw |= matches!(p, 'r' | 'R');
            j += 1;
        }
        // A prefix only counts when it is not the tail of an identifier.
        let prefix_ok = j == i
            || !chars
                .get(i.wrapping_sub(1))
                .is_some_and(|&p| is_ident_char(p));
        if prefix_ok
            && let Some(&quote) = chars.get(j)
            && matches!(quote, '"' | '\'')
        {
            let triple = chars.get(j + 1) == Some(&quote) && chars.get(j + 2) == Some(&quote);
            let mut k = if triple { j + 3 } else { j + 1 };
            loop {
                let Some(&ch) = chars.get(k) else {
                    return false; // unterminated literal
                };
                if !raw && ch == '\\' {
                    k += 2;
                    continue;
                }
                if ch == quote {
                    if !triple {
                        k += 1;
                        break;
                    }
                    if chars.get(k + 1) == Some(&quote) && chars.get(k + 2) == Some(&quote) {
                        k += 3;
                        break;
                    }
                }
                k += 1;
            }
            i = k;
            continue;
        }
        match c {
            '(' | '[' | '{' => stack.push(c),
            ')' | ']' | '}' => {
                let want = match c {
                    ')' => '(',
                    ']' => '[',
                    _ => '{',
                };
                if stack.pop() != Some(want) {
                    return false;
                }
            }
            _ => {}
        }
        i += 1;
    }
    stack.is_empty()
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
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
    fn closed_clauses_balance_outside_string_literals() {
        for ok in [
            "true",
            "",
            r#"call.args.key.startsWith("seen/")"#,
            r#"call.args.key == ")" || call.args.key == "(""#,
            "call.args.key == ')'",
            r#"call.args.key == r"\)""#,
            r#"call.args.key == b"(""#,
            r#"call.args.key in ["a", "b"]"#,
            r#"{"a": 1}["a"] == 1"#,
            r#"call.args.key == """)""""#,
            r#"call.args.key == "\")""#,
            "size(call.args.key) < (1 + 2)",
            "b == 1 && r == 2",
        ] {
            assert!(clause_is_closed(ok), "{ok:?} should be closed");
        }
        for bad in [
            "true) || (true",
            "(true",
            "true)",
            r#"true) || ("" == ""#,
            r#"true) || (1 == 1 || "" == ""#,
            "[1, 2)",
            r#"call.args.key == "unterminated"#,
            "a(]",
        ] {
            assert!(!clause_is_closed(bad), "{bad:?} should not be closed");
        }
        assert!(Narrowing::allow("x").is_closed());
        assert!(!Narrowing::allow("x) || (true").is_closed());
        assert!(!Narrowing::when("x) || (true").is_closed());
        assert!(Narrowing::default().is_closed());
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

    #[test]
    fn containment_is_by_appended_clauses() {
        let base = Scope::allow(r#"call.args.path.startsWith("/a")"#);
        assert!(base.contains(&base), "a scope contains itself");
        assert!(
            Scope::unrestricted().contains(&base),
            "unrestricted contains everything"
        );
        assert!(
            !base.contains(&Scope::unrestricted()),
            "nothing else contains unrestricted"
        );

        let child = base.narrowed(&Narrowing::allow(r#"call.method == "read""#));
        assert!(base.contains(&child), "a narrowed scope is contained");
        assert!(!child.contains(&base), "containment is not symmetric");
        let grandchild = child.narrowed(&Narrowing::when("caller.id == 'x'"));
        assert!(base.contains(&grandchild));
        assert!(child.contains(&grandchild));
        assert!(!grandchild.contains(&child));

        // An unrelated clause, or an equivalent rewrite, is not recognised.
        assert!(!base.contains(&Scope::allow(r#"call.method == "read""#)));
        assert!(!base.contains(&Scope::allow(r#"(call.args.path.startsWith("/a"))"#)));

        // Text that only looks like a conjunction: the right side escapes its
        // parentheses and widens, so it is not contained.
        let widened = Scope::allow(format!("({}) && (true) || (true)", base.allow));
        assert!(!base.contains(&widened));
        let literal = Scope::allow(format!(r#"({}) && (") && (true"#, base.allow));
        assert!(!base.contains(&literal));
    }
}
