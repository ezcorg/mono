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

/// A parsed resource pattern with colon-delimited segments supporting `*` wildcards.
/// E.g. `plugins:noshorts:write` or `plugins:*:read`.
#[derive(Debug, Clone)]
pub struct ResourcePattern {
    segments: Vec<String>,
}

impl ResourcePattern {
    pub fn parse(pattern: &str) -> Self {
        Self {
            segments: pattern.split(':').map(|s| s.to_string()).collect(),
        }
    }

    /// Count of non-wildcard segments (used for specificity ranking).
    fn specificity(&self) -> usize {
        self.segments.iter().filter(|s| *s != "*").count()
    }

    /// Check if this pattern matches a resource string segment-by-segment.
    /// `*` matches any single segment. Segment count must match exactly.
    fn matches(&self, resource: &ResourcePattern) -> bool {
        if self.segments.len() != resource.segments.len() {
            return false;
        }
        self.segments
            .iter()
            .zip(resource.segments.iter())
            .all(|(pattern_seg, resource_seg)| pattern_seg == "*" || pattern_seg == resource_seg)
    }
}

impl fmt::Display for ResourcePattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.segments.join(":"))
    }
}

#[derive(Debug, Clone)]
pub struct Permission {
    pub effect: Effect,
    pub resource: ResourcePattern,
}

impl Permission {
    pub fn new(effect: Effect, resource: &str) -> Self {
        Self {
            effect,
            resource: ResourcePattern::parse(resource),
        }
    }

    pub fn grant(resource: &str) -> Self {
        Self::new(Effect::Grant, resource)
    }

    pub fn deny(resource: &str) -> Self {
        Self::new(Effect::Deny, resource)
    }
}

/// Evaluate permissions against a resource string.
///
/// Algorithm:
/// 1. Collect all matching rules (segment-by-segment, `*` matches any single segment)
/// 2. Rank by specificity (count of non-wildcard segments)
/// 3. Most-specific wins; deny breaks ties at equal specificity
/// 4. Default deny if no rules match
pub fn evaluate(permissions: &[Permission], resource: &str) -> bool {
    let resource_pattern = ResourcePattern::parse(resource);

    let matching: Vec<&Permission> = permissions
        .iter()
        .filter(|p| p.resource.matches(&resource_pattern))
        .collect();

    if matching.is_empty() {
        return false; // default deny
    }

    // Find the maximum specificity among matching rules
    let max_specificity = matching
        .iter()
        .map(|p| p.resource.specificity())
        .max()
        .unwrap();

    // Filter to only the most-specific rules
    let most_specific: Vec<&&Permission> = matching
        .iter()
        .filter(|p| p.resource.specificity() == max_specificity)
        .collect();

    // If any deny exists at the most specific level, deny wins (tie-breaking)
    let has_deny = most_specific.iter().any(|p| p.effect == Effect::Deny);
    if has_deny {
        return false;
    }

    // All most-specific rules are grants
    true
}
