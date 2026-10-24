//! Who may do what to the management API.
//!
//! A permission names a resource as three fields: what kind of thing, which
//! one, and the action. They are three fields and not a string, because an
//! id can hold anything the operator or a resolver puts in it (a Tailscale
//! tenant is `ts:<login>:<node>`), and a string joined with the character
//! that separates the fields reads such an id as more fields: every
//! permission check about that tenant then fails, for an administrator too.
//! The stored form is still `kind:id:action`, read with the id as everything
//! between the first colon and the last.

use std::fmt;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Grant,
    Deny,
}

impl fmt::Display for Effect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Effect::Grant => write!(f, "grant"),
            Effect::Deny => write!(f, "deny"),
        }
    }
}

impl std::str::FromStr for Effect {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "grant" => Ok(Effect::Grant),
            "deny" => Ok(Effect::Deny),
            _ => Err(anyhow::anyhow!("Invalid effect: {}", s)),
        }
    }
}

/// What kind of thing a resource is. A closed set: a request the API cannot
/// place is `Unknown`, which only an all-wildcard grant reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Plugins,
    Tenants,
    Groups,
    Unknown,
}

impl Kind {
    const ALL: [Kind; 4] = [Kind::Plugins, Kind::Tenants, Kind::Groups, Kind::Unknown];

    fn as_str(self) -> &'static str {
        match self {
            Kind::Plugins => "plugins",
            Kind::Tenants => "tenants",
            Kind::Groups => "groups",
            Kind::Unknown => "unknown",
        }
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Kind {
    type Err = InvalidResource;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Kind::ALL
            .into_iter()
            .find(|k| k.as_str() == s)
            .ok_or_else(|| {
                InvalidResource(format!(
                    "{s:?} is not a resource kind (plugins, tenants, groups)"
                ))
            })
    }
}

/// What is being done to a resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Read,
    Write,
    Delete,
    Configure,
    Manage,
}

impl Action {
    const ALL: [Action; 5] = [
        Action::Read,
        Action::Write,
        Action::Delete,
        Action::Configure,
        Action::Manage,
    ];

    fn as_str(self) -> &'static str {
        match self {
            Action::Read => "read",
            Action::Write => "write",
            Action::Delete => "delete",
            Action::Configure => "configure",
            Action::Manage => "manage",
        }
    }
}

impl fmt::Display for Action {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Action {
    type Err = InvalidResource;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Action::ALL
            .into_iter()
            .find(|a| a.as_str() == s)
            .ok_or_else(|| {
                InvalidResource(format!(
                    "{s:?} is not an action (read, write, delete, configure, manage)"
                ))
            })
    }
}

/// A resource a request is about: the kind, which one (`None` for the kind's
/// collection, as in listing every tenant), and the action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resource {
    pub kind: Kind,
    pub id: Option<String>,
    pub action: Action,
}

impl Resource {
    pub fn new(kind: Kind, id: Option<impl Into<String>>, action: Action) -> Self {
        Self {
            kind,
            id: id.map(Into::into),
            action,
        }
    }

    /// The collection of a kind: every tenant, every group.
    pub fn all(kind: Kind, action: Action) -> Self {
        Self::new(kind, None::<String>, action)
    }
}

impl fmt::Display for Resource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{}:{}",
            self.kind,
            self.id.as_deref().unwrap_or("*"),
            self.action
        )
    }
}

/// A stored pattern that could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidResource(String);

impl fmt::Display for InvalidResource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidResource {}

/// One field of a pattern: anything, or exactly this.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Field<T> {
    Any,
    Is(T),
}

impl<T: PartialEq> Field<T> {
    fn covers(&self, value: Option<&T>) -> bool {
        match self {
            Field::Any => true,
            Field::Is(want) => value == Some(want),
        }
    }

    fn is_exact(&self) -> bool {
        matches!(self, Field::Is(_))
    }
}

/// A permission's pattern over resources: each field exact or `*`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourcePattern {
    kind: Field<Kind>,
    id: Field<String>,
    action: Field<Action>,
}

impl ResourcePattern {
    /// Reads the stored form `kind:id:action`. The kind and the action are
    /// single tokens or `*`; the id is everything between the first colon
    /// and the last, so it may hold colons of its own. Fewer than three
    /// parts, or a kind or action that is not one, is not a pattern.
    pub fn parse(pattern: &str) -> Result<Self, InvalidResource> {
        let (kind, rest) = pattern
            .split_once(':')
            .ok_or_else(|| InvalidResource(format!("{pattern:?} is not kind:id:action")))?;
        let (id, action) = rest
            .rsplit_once(':')
            .ok_or_else(|| InvalidResource(format!("{pattern:?} is not kind:id:action")))?;
        if kind.is_empty() || id.is_empty() || action.is_empty() {
            return Err(InvalidResource(format!("{pattern:?} has an empty field")));
        }
        let field = |s: &str| -> Field<String> {
            if s == "*" {
                Field::Any
            } else {
                Field::Is(s.to_string())
            }
        };
        Ok(Self {
            kind: match kind {
                "*" => Field::Any,
                k => Field::Is(k.parse()?),
            },
            id: field(id),
            action: match action {
                "*" => Field::Any,
                a => Field::Is(a.parse()?),
            },
        })
    }

    /// Count of exact fields, for specificity ranking.
    fn specificity(&self) -> usize {
        [
            self.kind.is_exact(),
            self.id.is_exact(),
            self.action.is_exact(),
        ]
        .into_iter()
        .filter(|b| *b)
        .count()
    }

    /// Whether this pattern covers a resource. `*` covers any value of a
    /// field, the collection included; an exact id covers that one thing.
    pub fn matches(&self, resource: &Resource) -> bool {
        self.kind.covers(Some(&resource.kind))
            && self.id.covers(resource.id.as_ref())
            && self.action.covers(Some(&resource.action))
    }
}

impl fmt::Display for ResourcePattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fn show<T: fmt::Display>(field: &Field<T>) -> String {
            match field {
                Field::Any => "*".to_string(),
                Field::Is(v) => v.to_string(),
            }
        }
        write!(
            f,
            "{}:{}:{}",
            show(&self.kind),
            show(&self.id),
            show(&self.action)
        )
    }
}

#[derive(Debug, Clone)]
pub struct Permission {
    pub effect: Effect,
    pub resource: ResourcePattern,
}

impl Permission {
    pub fn new(effect: Effect, resource: ResourcePattern) -> Self {
        Self { effect, resource }
    }

    /// From the stored forms.
    pub fn parse(effect: &str, resource: &str) -> anyhow::Result<Self> {
        Ok(Self::new(
            effect.parse()?,
            ResourcePattern::parse(resource)?,
        ))
    }
}

/// Evaluate permissions against a resource.
///
/// Algorithm:
/// 1. Collect all matching rules (field by field, `*` matches any value)
/// 2. Rank by specificity (count of exact fields)
/// 3. Most-specific wins; deny breaks ties at equal specificity
/// 4. Default deny if no rules match
pub fn evaluate(permissions: &[Permission], resource: &Resource) -> bool {
    let matching: Vec<&Permission> = permissions
        .iter()
        .filter(|p| p.resource.matches(resource))
        .collect();

    if matching.is_empty() {
        return false; // default deny
    }

    let max_specificity = matching
        .iter()
        .map(|p| p.resource.specificity())
        .max()
        .unwrap_or(0);

    let most_specific: Vec<&&Permission> = matching
        .iter()
        .filter(|p| p.resource.specificity() == max_specificity)
        .collect();

    // If any deny exists at the most specific level, deny wins (tie-breaking)
    !most_specific.iter().any(|p| p.effect == Effect::Deny)
}
