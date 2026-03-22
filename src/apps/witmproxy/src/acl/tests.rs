use super::*;

#[test]
fn empty_permissions_deny() {
    assert!(!evaluate(&[], "plugins:noshorts:read"));
}

#[test]
fn exact_match_grant() {
    let perms = vec![Permission::grant("plugins:noshorts:read")];
    assert!(evaluate(&perms, "plugins:noshorts:read"));
}

#[test]
fn exact_match_deny() {
    let perms = vec![Permission::deny("plugins:noshorts:read")];
    assert!(!evaluate(&perms, "plugins:noshorts:read"));
}

#[test]
fn wildcard_matching() {
    let perms = vec![Permission::grant("plugins:*:read")];
    assert!(evaluate(&perms, "plugins:noshorts:read"));
    assert!(evaluate(&perms, "plugins:adblock:read"));
    assert!(!evaluate(&perms, "plugins:noshorts:write"));
}

#[test]
fn specificity_more_specific_wins() {
    // Wildcard grants read for all plugins, but specific deny for noshorts write
    let perms = vec![
        Permission::grant("plugins:*:write"),
        Permission::deny("plugins:noshorts:write"),
    ];
    // noshorts:write denied by more-specific rule (specificity 3 vs 2)
    assert!(!evaluate(&perms, "plugins:noshorts:write"));
    // adblock:write allowed by wildcard (no more-specific deny)
    assert!(evaluate(&perms, "plugins:adblock:write"));
}

#[test]
fn tie_breaking_deny_wins_at_equal_specificity() {
    let perms = vec![
        Permission::grant("plugins:noshorts:write"),
        Permission::deny("plugins:noshorts:write"),
    ];
    // Same specificity (3), deny wins
    assert!(!evaluate(&perms, "plugins:noshorts:write"));
}

#[test]
fn segment_count_mismatch_no_match() {
    let perms = vec![Permission::grant("plugins:noshorts:read")];
    // Too few segments
    assert!(!evaluate(&perms, "plugins:noshorts"));
    // Too many segments
    assert!(!evaluate(&perms, "plugins:noshorts:read:extra"));
}

#[test]
fn multi_wildcard() {
    let perms = vec![Permission::grant("*:*:read")];
    assert!(evaluate(&perms, "plugins:noshorts:read"));
    assert!(evaluate(&perms, "tenants:abc:read"));
    assert!(!evaluate(&perms, "plugins:noshorts:write"));
}

#[test]
fn multi_group_permission_merging() {
    // Simulate permissions from multiple groups merged into one list
    let group_a = vec![
        Permission::grant("plugins:*:read"),
        Permission::grant("tenants:self:read"),
    ];
    let group_b = vec![
        Permission::grant("plugins:noshorts:write"),
        Permission::deny("plugins:adblock:write"),
    ];

    let all_perms: Vec<Permission> = group_a.into_iter().chain(group_b).collect();

    assert!(evaluate(&all_perms, "plugins:noshorts:read"));
    assert!(evaluate(&all_perms, "plugins:noshorts:write"));
    assert!(evaluate(&all_perms, "plugins:adblock:read"));
    assert!(!evaluate(&all_perms, "plugins:adblock:write"));
    assert!(evaluate(&all_perms, "tenants:self:read"));
    assert!(!evaluate(&all_perms, "tenants:self:write"));
}

#[test]
fn no_matching_resource_denies() {
    let perms = vec![Permission::grant("plugins:noshorts:read")];
    assert!(!evaluate(&perms, "tenants:abc:read"));
}

#[test]
fn grant_overrides_less_specific_deny() {
    let perms = vec![
        Permission::deny("plugins:*:write"),
        Permission::grant("plugins:noshorts:write"),
    ];
    // Specific grant (specificity 3) overrides wildcard deny (specificity 2)
    assert!(evaluate(&perms, "plugins:noshorts:write"));
    // Other plugins still denied by wildcard
    assert!(!evaluate(&perms, "plugins:adblock:write"));
}

#[test]
fn all_wildcards_lowest_specificity() {
    let perms = vec![
        Permission::deny("*:*:*"),
        Permission::grant("plugins:*:read"),
    ];
    // plugins:*:read (specificity 2) beats *:*:* (specificity 0)
    assert!(evaluate(&perms, "plugins:noshorts:read"));
    // Everything else still denied
    assert!(!evaluate(&perms, "plugins:noshorts:write"));
    assert!(!evaluate(&perms, "tenants:abc:read"));
}

#[test]
fn resource_pattern_display() {
    let pattern = ResourcePattern::parse("plugins:noshorts:write");
    assert_eq!(pattern.to_string(), "plugins:noshorts:write");
}

#[test]
fn effect_display_and_parse() {
    assert_eq!(Effect::Grant.to_string(), "grant");
    assert_eq!(Effect::Deny.to_string(), "deny");
    assert_eq!("grant".parse::<Effect>().unwrap(), Effect::Grant);
    assert_eq!("deny".parse::<Effect>().unwrap(), Effect::Deny);
    assert!("invalid".parse::<Effect>().is_err());
}

#[test]
fn wildcard_in_middle_segment() {
    let perms = vec![Permission::grant("plugins:*:configure")];
    assert!(evaluate(&perms, "plugins:noshorts:configure"));
    assert!(evaluate(&perms, "plugins:adblock:configure"));
    assert!(!evaluate(&perms, "plugins:noshorts:read"));
}

#[test]
fn multiple_deny_at_same_specificity() {
    let perms = vec![
        Permission::deny("plugins:noshorts:write"),
        Permission::deny("plugins:noshorts:write"),
        Permission::grant("plugins:noshorts:write"),
    ];
    // Deny wins at equal specificity even if outnumbered by grants
    assert!(!evaluate(&perms, "plugins:noshorts:write"));
}
