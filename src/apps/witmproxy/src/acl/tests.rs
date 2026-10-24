use super::*;

/// A resource from its display form, for tests only: the middleware builds
/// resources typed, and a colon in an id would be ambiguous here.
fn res(s: &str) -> Resource {
    let mut it = s.splitn(3, ':');
    let kind: Kind = it.next().unwrap().parse().unwrap();
    let id = it.next().unwrap();
    let action: Action = it.next().unwrap().parse().unwrap();
    Resource::new(kind, (id != "*").then(|| id.to_string()), action)
}

fn grant(s: &str) -> Permission {
    Permission::parse("grant", s).unwrap()
}

fn deny(s: &str) -> Permission {
    Permission::parse("deny", s).unwrap()
}

#[test]
fn empty_permissions_deny() {
    assert!(!evaluate(&[], &res("plugins:noshorts:read")));
}

#[test]
fn exact_match_grant() {
    assert!(evaluate(
        &[grant("plugins:noshorts:read")],
        &res("plugins:noshorts:read")
    ));
}

#[test]
fn exact_match_deny() {
    assert!(!evaluate(
        &[deny("plugins:noshorts:read")],
        &res("plugins:noshorts:read")
    ));
}

#[test]
fn wildcard_matching() {
    let perms = vec![grant("plugins:*:read")];
    assert!(evaluate(&perms, &res("plugins:noshorts:read")));
    assert!(evaluate(&perms, &res("plugins:adblock:read")));
    assert!(!evaluate(&perms, &res("plugins:noshorts:write")));
}

#[test]
fn specificity_more_specific_wins() {
    let perms = vec![grant("plugins:*:write"), deny("plugins:noshorts:write")];
    assert!(!evaluate(&perms, &res("plugins:noshorts:write")));
    assert!(evaluate(&perms, &res("plugins:adblock:write")));
}

#[test]
fn tie_breaking_deny_wins_at_equal_specificity() {
    let perms = vec![
        grant("plugins:noshorts:write"),
        deny("plugins:noshorts:write"),
    ];
    assert!(!evaluate(&perms, &res("plugins:noshorts:write")));
}

#[test]
fn multi_wildcard() {
    let perms = vec![grant("*:*:read")];
    assert!(evaluate(&perms, &res("plugins:noshorts:read")));
    assert!(evaluate(&perms, &res("tenants:abc:read")));
    assert!(!evaluate(&perms, &res("plugins:noshorts:write")));
}

#[test]
fn multi_group_permission_merging() {
    let all_perms = vec![
        grant("plugins:*:read"),
        grant("tenants:self:read"),
        grant("plugins:noshorts:write"),
        deny("plugins:adblock:write"),
    ];
    assert!(evaluate(&all_perms, &res("plugins:noshorts:read")));
    assert!(evaluate(&all_perms, &res("plugins:noshorts:write")));
    assert!(evaluate(&all_perms, &res("plugins:adblock:read")));
    assert!(!evaluate(&all_perms, &res("plugins:adblock:write")));
    assert!(evaluate(&all_perms, &res("tenants:self:read")));
    assert!(!evaluate(&all_perms, &res("tenants:self:write")));
}

#[test]
fn no_matching_resource_denies() {
    assert!(!evaluate(
        &[grant("plugins:noshorts:read")],
        &res("tenants:abc:read")
    ));
}

#[test]
fn grant_overrides_less_specific_deny() {
    let perms = vec![deny("plugins:*:write"), grant("plugins:noshorts:write")];
    assert!(evaluate(&perms, &res("plugins:noshorts:write")));
    assert!(!evaluate(&perms, &res("plugins:adblock:write")));
}

#[test]
fn all_wildcards_lowest_specificity() {
    let perms = vec![deny("*:*:*"), grant("plugins:*:read")];
    assert!(evaluate(&perms, &res("plugins:noshorts:read")));
    assert!(!evaluate(&perms, &res("plugins:noshorts:write")));
    assert!(!evaluate(&perms, &res("tenants:abc:read")));
}

#[test]
fn multiple_deny_at_same_specificity() {
    let perms = vec![
        deny("plugins:noshorts:write"),
        deny("plugins:noshorts:write"),
        grant("plugins:noshorts:write"),
    ];
    assert!(!evaluate(&perms, &res("plugins:noshorts:write")));
}

// The collection (listing every tenant) is covered by a wildcard id and by
// nothing narrower: a grant on one tenant does not list them all.
#[test]
fn the_collection_is_only_covered_by_a_wildcard() {
    let perms = vec![grant("tenants:abc:read")];
    assert!(!evaluate(
        &perms,
        &Resource::all(Kind::Tenants, Action::Read)
    ));
    let perms = vec![grant("tenants:*:read")];
    assert!(evaluate(
        &perms,
        &Resource::all(Kind::Tenants, Action::Read)
    ));
    assert!(evaluate(&perms, &res("tenants:abc:read")));
}

// An id is one field whatever it holds. A Tailscale tenant is ts:<login>:<node>;
// the administrator's *:*:* covers it, a grant on it reads back as itself, and a
// grant on one of its parts does not reach it.
#[test]
fn an_id_may_hold_colons() {
    let ts = Resource::new(
        Kind::Tenants,
        Some("ts:me@example.com:laptop"),
        Action::Configure,
    );
    assert!(evaluate(&[grant("*:*:*")], &ts));
    assert!(evaluate(&[grant("tenants:*:configure")], &ts));
    let exact = ResourcePattern::parse("tenants:ts:me@example.com:laptop:configure").unwrap();
    assert!(exact.matches(&ts));
    assert_eq!(
        exact.to_string(),
        "tenants:ts:me@example.com:laptop:configure"
    );
    assert!(!evaluate(&[grant("tenants:ts:configure")], &ts));
    assert!(!evaluate(&[grant("tenants:laptop:configure")], &ts));
    // Plugin ids hold a slash, which is nothing special either.
    let plugin = Resource::new(Kind::Plugins, Some("ezco/noop"), Action::Write);
    assert!(evaluate(&[grant("plugins:ezco/noop:write")], &plugin));
}

// A pattern is three fields with a known kind and action, or it is nothing.
#[test]
fn malformed_patterns_are_refused() {
    for bad in [
        "",
        "plugins",
        "plugins:noshorts",
        "plugins::read",
        ":x:read",
        "plugins:x:",
        "widgets:x:read",
        "plugins:x:fly",
    ] {
        assert!(ResourcePattern::parse(bad).is_err(), "{bad:?} parsed");
    }
    assert!(Permission::parse("maybe", "plugins:x:read").is_err());
    assert!(Permission::parse("grant", "plugins:x:read").is_ok());
}

#[test]
fn resource_pattern_display() {
    assert_eq!(
        ResourcePattern::parse("plugins:*:read")
            .unwrap()
            .to_string(),
        "plugins:*:read"
    );
    assert_eq!(
        ResourcePattern::parse("*:*:*").unwrap().to_string(),
        "*:*:*"
    );
    assert_eq!(res("tenants:abc:write").to_string(), "tenants:abc:write");
    assert_eq!(
        Resource::all(Kind::Groups, Action::Manage).to_string(),
        "groups:*:manage"
    );
}

#[test]
fn effect_display_and_parse() {
    assert_eq!(Effect::Grant.to_string(), "grant");
    assert_eq!(Effect::Deny.to_string(), "deny");
    assert_eq!("grant".parse::<Effect>().unwrap(), Effect::Grant);
    assert_eq!("deny".parse::<Effect>().unwrap(), Effect::Deny);
    assert!("maybe".parse::<Effect>().is_err());
    assert_eq!("plugins".parse::<Kind>().unwrap(), Kind::Plugins);
    assert_eq!("configure".parse::<Action>().unwrap(), Action::Configure);
}
