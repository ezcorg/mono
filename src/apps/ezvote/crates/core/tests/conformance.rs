//! Conformance tests for the ezvote protocol.
//!
//! These tests verify the properties defined in tests/CONFORMANCE.md.

use ed25519_dalek::SigningKey;
use ezvote_core::{Action, CodeExecutor, Engine, Error, Hash, Mutation, Path, State, Transition};
use rand::rngs::OsRng;

// =============================================================================
// Test Utilities
// =============================================================================

/// Generate a new signing keypair.
fn generate_keypair() -> (SigningKey, ed25519_dalek::VerifyingKey) {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    (signing_key, verifying_key)
}

/// Create a minimal genesis state with one entity and consensus mechanism.
fn genesis_state() -> (State, SigningKey) {
    let mut state = State::new();

    // Create genesis entity
    let (signing_key, verifying_key) = generate_keypair();
    state.set(
        &["entities", "genesis", "public_key"],
        verifying_key.to_bytes().to_vec(),
    );
    state.set(&["entities", "genesis", "tags", "root"], b"true".to_vec());

    // Create "accept all" consensus mechanism (for testing)
    let accept_all_code = br#"[{"op": "accept_all"}]"#;
    let code_hash = Hash::of(accept_all_code);
    state.set(&["code", &code_hash.to_hex()], accept_all_code.to_vec());
    state.set(
        &["consensus", "mechanism"],
        code_hash.to_hex().into_bytes(),
    );

    // Create core actions
    let set_value_code = br#"[{"op": "copy_input", "path": ["_input"]}]"#;
    let set_value_hash = Hash::of(set_value_code);
    state.set(&["code", &set_value_hash.to_hex()], set_value_code.to_vec());
    state.set(
        &["actions", "set_value"],
        set_value_hash.to_hex().into_bytes(),
    );

    (state, signing_key)
}

/// Simple executor for testing.
struct TestExecutor;

impl CodeExecutor for TestExecutor {
    fn execute(
        &self,
        code: &[u8],
        input: &[u8],
        _state: &State,
    ) -> Result<Vec<Mutation>, Error> {
        #[derive(serde::Deserialize)]
        struct Instruction {
            op: String,
            path: Option<Path>,
            value: Option<String>,
        }

        let instructions: Vec<Instruction> = serde_json::from_slice(code)
            .map_err(|e| Error::Execution(format!("invalid code: {}", e)))?;

        let mut mutations = Vec::new();

        for instr in instructions {
            match instr.op.as_str() {
                "set" => {
                    let path = instr
                        .path
                        .ok_or_else(|| Error::Execution("set requires path".into()))?;
                    let value = instr
                        .value
                        .ok_or_else(|| Error::Execution("set requires value".into()))?;
                    mutations.push(Mutation::Set(path, value.into_bytes()));
                }
                "delete" => {
                    let path = instr
                        .path
                        .ok_or_else(|| Error::Execution("delete requires path".into()))?;
                    mutations.push(Mutation::Delete(path));
                }
                "accept_all" => {
                    mutations.push(Mutation::Set(
                        vec!["_result".to_string()],
                        b"accept".to_vec(),
                    ));
                }
                "copy_input" => {
                    let path = instr
                        .path
                        .ok_or_else(|| Error::Execution("copy_input requires path".into()))?;
                    mutations.push(Mutation::Set(path, input.to_vec()));
                }
                _ => {
                    return Err(Error::Execution(format!("unknown op: {}", instr.op)));
                }
            }
        }

        Ok(mutations)
    }
}

// =============================================================================
// SE: State Exposure Tests
// =============================================================================

/// SE-01: Enumerate All Paths
///
/// Property: All state is enumerable.
#[test]
fn se_01_enumerate_all_paths() {
    let (mut state, _) = genesis_state();

    // Add some additional state
    state.set(&["custom", "value1"], b"v1".to_vec());
    state.set(&["custom", "nested", "value2"], b"v2".to_vec());
    state.set(&["entities", "alice", "public_key"], vec![0u8; 32]);

    // Enumerate all paths
    let all_paths = state.enumerate_all();

    // Verify we can read every enumerated path
    for path in &all_paths {
        let value = state.get_path(path);
        assert!(
            value.is_some(),
            "enumerated path should be readable: {:?}",
            path
        );
    }

    // Verify specific paths are included
    let path_strs: Vec<String> = all_paths.iter().map(|p| p.join("/")).collect();

    assert!(
        path_strs.iter().any(|p| p.contains("entities/genesis")),
        "should include genesis entity"
    );
    assert!(
        path_strs.iter().any(|p| p.contains("consensus/mechanism")),
        "should include consensus mechanism"
    );
    assert!(
        path_strs.iter().any(|p| p.contains("custom/value1")),
        "should include custom values"
    );
}

/// SE-02: Read Any Value
///
/// Property: Any value in state is readable.
#[test]
fn se_02_read_any_value() {
    let (state, _) = genesis_state();

    // Get all paths
    let all_paths = state.enumerate_all();

    // Verify each path returns a value (not "access denied" or hidden)
    for path in all_paths {
        let result = state.get_path(&path);
        assert!(
            result.is_some(),
            "path {:?} should be readable, got None",
            path
        );
    }
}

/// SE-03: Action Discovery
///
/// Property: Valid actions are discoverable.
#[test]
fn se_03_action_discovery() {
    let (state, _) = genesis_state();

    // List all actions
    let action_paths = state.enumerate(&["actions"]);
    assert!(!action_paths.is_empty(), "should have at least one action");

    // For each action, verify the code exists
    for action_path in action_paths {
        let code_hash_bytes = state
            .get_path(&action_path)
            .expect("action path should be readable");

        let code_hash_str = String::from_utf8_lossy(code_hash_bytes);
        let code_hash =
            Hash::from_hex(&code_hash_str).expect("action should reference valid hash");

        let code_path = vec!["code".to_string(), code_hash.to_hex()];
        let code = state.get_path(&code_path);

        assert!(
            code.is_some(),
            "code for action {:?} should exist at {:?}",
            action_path,
            code_path
        );
    }
}

/// SE-04: No Hidden State
///
/// Property: State hash covers ALL state.
#[test]
fn se_04_no_hidden_state() {
    let (mut state, _) = genesis_state();

    let hash1 = state.hash();

    // Modify any value
    state.set(&["new", "path"], b"new_value".to_vec());

    let hash2 = state.hash();

    // Hash must have changed
    assert_ne!(hash1, hash2, "state hash should change when state changes");

    // Delete the value
    state.delete(&["new", "path"]);

    // Verify we're back (or at least hash reflects deletion)
    let hash3 = state.hash();
    assert_ne!(hash2, hash3, "state hash should change on delete");
}

// =============================================================================
// TA: Transparency/Auditability Tests
// =============================================================================

/// TA-05: Signature Verification
///
/// Property: Invalid signatures are rejected.
#[test]
fn ta_05_signature_verification() {
    let (state, signing_key) = genesis_state();
    let engine = Engine::new(state, Box::new(TestExecutor));

    // Get the set_value action code hash
    let code_hash_bytes = engine.state().get(&["actions", "set_value"]).unwrap();
    let code_hash = Hash::from_hex(&String::from_utf8_lossy(code_hash_bytes)).unwrap();

    // Create a valid action
    let action = Action::new(
        "genesis".to_string(),
        vec![engine.state_hash()],
        Transition {
            code: code_hash,
            input: b"test".to_vec(),
        },
        &signing_key,
    );

    // Verify signature is valid
    let public_key = engine.get_entity_public_key("genesis").unwrap();
    assert!(action.verify_signature(&public_key), "valid signature should verify");

    // Create action with corrupted signature
    let mut bad_action = action.clone();
    bad_action.signature[0] ^= 0xFF; // Flip bits

    assert!(
        !bad_action.verify_signature(&public_key),
        "corrupted signature should not verify"
    );
}

/// TA-06: Cannot Spoof Author
///
/// Property: Cannot submit action as another entity.
#[test]
fn ta_06_cannot_spoof_author() {
    let (mut state, genesis_key) = genesis_state();

    // Create a second entity
    let (_alice_key, alice_pubkey) = generate_keypair();
    state.set(
        &["entities", "alice", "public_key"],
        alice_pubkey.to_bytes().to_vec(),
    );

    let engine = Engine::new(state, Box::new(TestExecutor));

    let code_hash_bytes = engine.state().get(&["actions", "set_value"]).unwrap();
    let code_hash = Hash::from_hex(&String::from_utf8_lossy(code_hash_bytes)).unwrap();

    // Try to create action claiming to be alice, but sign with genesis key
    let spoofed_action = Action::new(
        "alice".to_string(), // Claim to be alice
        vec![engine.state_hash()],
        Transition {
            code: code_hash,
            input: b"test".to_vec(),
        },
        &genesis_key, // But sign with genesis key
    );

    // The signature verification should fail
    let alice_public_key = engine.get_entity_public_key("alice").unwrap();
    assert!(
        !spoofed_action.verify_signature(&alice_public_key),
        "spoofed action should not verify with claimed author's key"
    );
}

// =============================================================================
// VS: Versioned State Tests
// =============================================================================

/// VS-04: State Hash Stability
///
/// Property: Same state always produces same hash.
#[test]
fn vs_04_state_hash_stability() {
    let (state1, _) = genesis_state();

    // Serialize and deserialize
    let mut buf = Vec::new();
    ciborium::into_writer(&state1, &mut buf).unwrap();
    let state2: State = ciborium::from_reader(&buf[..]).unwrap();

    // Hashes should match
    assert_eq!(
        state1.hash(),
        state2.hash(),
        "serialized/deserialized state should have same hash"
    );
}

/// VS-02: Fork Creation (simplified)
///
/// Property: Can create divergent forks.
#[test]
fn vs_02_fork_creation() {
    let (state, _) = genesis_state();
    let original_hash = state.hash();

    // Create two different mutations from the same state
    let mut state1 = state.clone();
    state1.set(&["fork", "value"], b"1".to_vec());

    let mut state2 = state.clone();
    state2.set(&["fork", "value"], b"2".to_vec());

    // Both should have different hashes from original and each other
    assert_ne!(state1.hash(), original_hash);
    assert_ne!(state2.hash(), original_hash);
    assert_ne!(state1.hash(), state2.hash());

    // Both forks are valid
    assert_eq!(state1.get(&["fork", "value"]), Some(&b"1".to_vec()));
    assert_eq!(state2.get(&["fork", "value"]), Some(&b"2".to_vec()));
}

// =============================================================================
// SP: Simplicity Tests
// =============================================================================

/// SP-03: Genesis Simplicity
///
/// Property: Genesis state is minimal.
#[test]
fn sp_03_genesis_simplicity() {
    let (state, _) = genesis_state();
    let paths = state.enumerate_all();

    // Genesis should have a small number of paths
    // Currently: genesis entity (public_key, tags/root), consensus/mechanism, code/*, actions/*
    assert!(
        paths.len() < 20,
        "genesis should have < 20 paths, got {}",
        paths.len()
    );

    // Print paths for debugging
    println!("Genesis has {} paths:", paths.len());
    for path in &paths {
        println!("  /{}", path.join("/"));
    }
}

/// SP-04: Composition Works
///
/// Property: Complex behavior emerges from simple primitives.
#[test]
fn sp_04_composition() {
    let (mut state, _) = genesis_state();

    // Delegation is NOT a primitive - it's just a value at a path
    state.set(&["entities", "alice", "delegate"], b"genesis".to_vec());

    // Verify we can read it back
    let delegate = state.get(&["entities", "alice", "delegate"]);
    assert_eq!(delegate, Some(&b"genesis".to_vec()));

    // Voting power is computed, not stored
    // Permissions are tags, not special types
    state.set(&["entities", "alice", "tags", "voter"], b"true".to_vec());

    let is_voter = state.get(&["entities", "alice", "tags", "voter"]);
    assert_eq!(is_voter, Some(&b"true".to_vec()));
}

// =============================================================================
// CG: Consensus-Gated Actions Tests
// =============================================================================

/// CG-02: Liquid Democracy Basic
///
/// Property: Direct votes work.
#[test]
fn cg_02_liquid_democracy_basic() {
    use ezvote_core::StandardExecutor;

    // Create state with three entities
    let mut state = State::new();
    state.set(&["entities", "alice", "public_key"], vec![0u8; 32]);
    state.set(&["entities", "bob", "public_key"], vec![0u8; 32]);
    state.set(&["entities", "carol", "public_key"], vec![0u8; 32]);

    let executor = StandardExecutor;
    let code = br#"[{"op": "liquid_democracy"}]"#;

    // Alice and Bob vote Accept, Carol votes Reject
    let input = br#"{
        "votes": [
            {"voter": "alice", "value": "Accept"},
            {"voter": "bob", "value": "Accept"},
            {"voter": "carol", "value": "Reject"}
        ]
    }"#;

    let mutations = executor.execute(code, input, &state).unwrap();
    let result = find_result(&mutations);

    // 2 Accept > 1 Reject
    assert_eq!(result, Some("accept".to_string()));
}

/// CG-03: Liquid Democracy Delegation
///
/// Property: Delegation transfers voting power.
#[test]
fn cg_03_liquid_democracy_delegation() {
    use ezvote_core::StandardExecutor;

    // Create state: A, B, C, D where B->A, C->B (transitively to A)
    let mut state = State::new();
    state.set(&["entities", "alice", "public_key"], vec![0u8; 32]);
    state.set(&["entities", "bob", "public_key"], vec![0u8; 32]);
    state.set(&["entities", "bob", "delegate"], b"alice".to_vec());
    state.set(&["entities", "carol", "public_key"], vec![0u8; 32]);
    state.set(&["entities", "carol", "delegate"], b"bob".to_vec());
    state.set(&["entities", "dave", "public_key"], vec![0u8; 32]);

    let executor = StandardExecutor;
    let code = br#"[{"op": "liquid_democracy"}]"#;

    // Alice votes Accept (power = 3: A + B + C), Dave votes Reject (power = 1)
    let input = br#"{
        "votes": [
            {"voter": "alice", "value": "Accept"},
            {"voter": "dave", "value": "Reject"}
        ]
    }"#;

    let mutations = executor.execute(code, input, &state).unwrap();
    let result = find_result(&mutations);

    // 3 > 1
    assert_eq!(result, Some("accept".to_string()));
}

/// CG-04: Delegation Override
///
/// Property: Direct vote overrides delegation.
#[test]
fn cg_04_delegation_override() {
    use ezvote_core::StandardExecutor;

    // B delegates to A, but B also votes directly
    let mut state = State::new();
    state.set(&["entities", "alice", "public_key"], vec![0u8; 32]);
    state.set(&["entities", "bob", "public_key"], vec![0u8; 32]);
    state.set(&["entities", "bob", "delegate"], b"alice".to_vec());

    let executor = StandardExecutor;
    let code = br#"[{"op": "liquid_democracy"}]"#;

    // Alice votes Accept, Bob votes Reject (overriding delegation)
    let input = br#"{
        "votes": [
            {"voter": "alice", "value": "Accept"},
            {"voter": "bob", "value": "Reject"}
        ]
    }"#;

    let mutations = executor.execute(code, input, &state).unwrap();
    let result = find_result(&mutations);

    // Both have power 1 (B's direct vote overrides delegation)
    // Tie goes to reject
    assert_eq!(result, Some("reject".to_string()));
}

/// CG-06: Circular Delegation
///
/// Property: Circular delegation is handled gracefully.
#[test]
fn cg_06_circular_delegation() {
    use ezvote_core::StandardExecutor;

    // A -> B -> C -> A (cycle)
    let mut state = State::new();
    state.set(&["entities", "alice", "public_key"], vec![0u8; 32]);
    state.set(&["entities", "alice", "delegate"], b"bob".to_vec());
    state.set(&["entities", "bob", "public_key"], vec![0u8; 32]);
    state.set(&["entities", "bob", "delegate"], b"carol".to_vec());
    state.set(&["entities", "carol", "public_key"], vec![0u8; 32]);
    state.set(&["entities", "carol", "delegate"], b"alice".to_vec());
    state.set(&["entities", "dave", "public_key"], vec![0u8; 32]);

    let executor = StandardExecutor;
    let code = br#"[{"op": "liquid_democracy"}]"#;

    // Dave votes, nobody in the cycle votes
    let input = br#"{
        "votes": [
            {"voter": "dave", "value": "Accept"}
        ]
    }"#;

    // Should not crash, should produce a result
    let result = executor.execute(code, input, &state);
    assert!(result.is_ok(), "should handle circular delegation without crashing");

    let mutations = result.unwrap();
    let outcome = find_result(&mutations);
    assert!(outcome.is_some(), "should produce a consensus result");
}

/// CG-01: No Action Without Consensus
///
/// Property: State doesn't change without consensus.
#[test]
fn cg_01_no_action_without_consensus() {
    use ezvote_core::StandardExecutor;

    // Create state with liquid democracy
    let mut state = State::new();
    state.set(&["entities", "alice", "public_key"], vec![0u8; 32]);
    state.set(&["entities", "bob", "public_key"], vec![0u8; 32]);

    let executor = StandardExecutor;
    let code = br#"[{"op": "liquid_democracy"}]"#;

    // No votes at all
    let input = br#"{"votes": []}"#;

    let mutations = executor.execute(code, input, &state).unwrap();
    let result = find_result(&mutations);

    // With no votes, should be pending
    assert_eq!(result, Some("pending".to_string()));
}

/// Helper to extract result from mutations.
fn find_result(mutations: &[Mutation]) -> Option<String> {
    mutations.iter().find_map(|m| match m {
        Mutation::Set(path, value) if path == &vec!["_result".to_string()] => {
            Some(String::from_utf8_lossy(value).to_string())
        }
        _ => None,
    })
}

// =============================================================================
// DT: Dynamic Trust Tests
// =============================================================================

/// DT-02: Trust From State Only
///
/// Property: Entity privileges come only from state.
#[test]
fn dt_02_trust_from_state_only() {
    let (mut state, _) = genesis_state();

    // Alice starts with no special tags
    state.set(&["entities", "alice", "public_key"], vec![0u8; 32]);

    // Check alice has no admin tag
    assert!(state.get(&["entities", "alice", "tags", "admin"]).is_none());

    // Give alice admin tag
    state.set(&["entities", "alice", "tags", "admin"], b"true".to_vec());

    // Now alice has admin
    assert_eq!(
        state.get(&["entities", "alice", "tags", "admin"]),
        Some(&b"true".to_vec())
    );

    // Remove admin tag
    state.delete(&["entities", "alice", "tags", "admin"]);

    // Alice no longer has admin
    assert!(state.get(&["entities", "alice", "tags", "admin"]).is_none());

    // Privileges follow tags, not identity
}

/// DT-01: No Hardcoded Root
///
/// Property: "Root" entity can be demoted.
#[test]
fn dt_01_no_hardcoded_root() {
    let (mut state, _) = genesis_state();

    // Verify genesis has root tag
    assert_eq!(
        state.get(&["entities", "genesis", "tags", "root"]),
        Some(&b"true".to_vec())
    );

    // Remove root tag
    state.delete(&["entities", "genesis", "tags", "root"]);

    // Genesis no longer has root tag
    assert!(state.get(&["entities", "genesis", "tags", "root"]).is_none());

    // The system should continue to function (genesis is now a regular entity)
    // This is a conceptual test - in practice, this would require consensus
}

// =============================================================================
// Additional Core Tests
// =============================================================================

/// Test that state hash is deterministic regardless of insertion order.
#[test]
fn state_hash_order_independent() {
    let mut s1 = State::new();
    s1.set(&["a"], b"1".to_vec());
    s1.set(&["b"], b"2".to_vec());
    s1.set(&["c"], b"3".to_vec());

    let mut s2 = State::new();
    s2.set(&["c"], b"3".to_vec());
    s2.set(&["a"], b"1".to_vec());
    s2.set(&["b"], b"2".to_vec());

    assert_eq!(s1.hash(), s2.hash());
}

/// Test path enumeration with nested structures.
#[test]
fn enumerate_nested_paths() {
    let mut state = State::new();
    state.set(&["a", "b", "c"], b"1".to_vec());
    state.set(&["a", "b", "d"], b"2".to_vec());
    state.set(&["a", "e"], b"3".to_vec());
    state.set(&["f"], b"4".to_vec());

    let all = state.enumerate_all();
    assert_eq!(all.len(), 4);

    let under_a = state.enumerate(&["a"]);
    assert_eq!(under_a.len(), 3);

    let under_ab = state.enumerate(&["a", "b"]);
    assert_eq!(under_ab.len(), 2);
}

/// Test that code executor produces expected mutations.
#[test]
fn test_executor_set() {
    let executor = TestExecutor;
    let state = State::new();

    let code = br#"[{"op": "set", "path": ["test", "key"], "value": "hello"}]"#;
    let mutations = executor.execute(code, &[], &state).unwrap();

    assert_eq!(mutations.len(), 1);
    match &mutations[0] {
        Mutation::Set(path, value) => {
            assert_eq!(path, &vec!["test".to_string(), "key".to_string()]);
            assert_eq!(value, b"hello");
        }
        _ => panic!("expected Set mutation"),
    }
}

/// Test consensus accept_all mechanism.
#[test]
fn test_consensus_accept_all() {
    let executor = TestExecutor;
    let state = State::new();

    let code = br#"[{"op": "accept_all"}]"#;
    let mutations = executor.execute(code, &[], &state).unwrap();

    assert!(mutations.iter().any(|m| matches!(
        m,
        Mutation::Set(path, value) if path == &vec!["_result".to_string()] && value == b"accept"
    )));
}
