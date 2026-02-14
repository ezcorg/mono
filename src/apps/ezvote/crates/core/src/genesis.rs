//! Genesis state creation.
//!
//! The genesis state contains the minimum needed to bootstrap:
//! - One entity (the genesis entity)
//! - A consensus mechanism (liquid democracy)
//! - Core action types

use crate::{Hash, State};
use ed25519_dalek::VerifyingKey;

/// Parameters for creating a genesis state.
pub struct GenesisParams {
    /// The genesis entity's public key.
    pub genesis_public_key: VerifyingKey,
    /// Optional additional entities to include.
    pub additional_entities: Vec<(String, VerifyingKey)>,
}

/// Create a genesis state from parameters.
pub fn create_genesis(params: GenesisParams) -> State {
    let mut state = State::new();

    // 1. Create genesis entity
    state.set(
        &["entities", "genesis", "public_key"],
        params.genesis_public_key.to_bytes().to_vec(),
    );
    state.set(&["entities", "genesis", "tags", "root"], b"true".to_vec());

    // 2. Add additional entities
    for (id, pubkey) in params.additional_entities {
        state.set(
            &["entities", &id, "public_key"],
            pubkey.to_bytes().to_vec(),
        );
    }

    // 3. Register the liquid democracy consensus mechanism
    let consensus_code = LIQUID_DEMOCRACY_CODE;
    let consensus_hash = Hash::of(consensus_code.as_bytes());
    state.set(
        &["code", &consensus_hash.to_hex()],
        consensus_code.as_bytes().to_vec(),
    );
    state.set(
        &["consensus", "mechanism"],
        consensus_hash.to_hex().into_bytes(),
    );

    // 4. Register core action types
    register_action(&mut state, "set_value", SET_VALUE_CODE);
    register_action(&mut state, "delete_value", DELETE_VALUE_CODE);
    register_action(&mut state, "create_entity", CREATE_ENTITY_CODE);
    register_action(&mut state, "delegate", DELEGATE_CODE);
    register_action(&mut state, "undelegate", UNDELEGATE_CODE);
    register_action(&mut state, "register_code", REGISTER_CODE_CODE);
    register_action(&mut state, "register_action", REGISTER_ACTION_CODE);

    state
}

fn register_action(state: &mut State, name: &str, code: &str) {
    let hash = Hash::of(code.as_bytes());
    state.set(&["code", &hash.to_hex()], code.as_bytes().to_vec());
    state.set(&["actions", name], hash.to_hex().into_bytes());
}

// =============================================================================
// Core Action Code (JSON instruction format)
// =============================================================================

/// Liquid democracy consensus mechanism.
///
/// This is a simple implementation that:
/// 1. Counts votes weighted by delegation
/// 2. Accepts if accept_power > reject_power and accept_power > 0
/// 3. Rejects if reject_power > accept_power
/// 4. Stays pending otherwise
pub const LIQUID_DEMOCRACY_CODE: &str = r#"[
    {"op": "liquid_democracy"}
]"#;

/// Set a value at a path.
/// Input: { "path": [...], "value": "..." }
pub const SET_VALUE_CODE: &str = r#"[
    {"op": "set_from_input"}
]"#;

/// Delete a value at a path.
/// Input: { "path": [...] }
pub const DELETE_VALUE_CODE: &str = r#"[
    {"op": "delete_from_input"}
]"#;

/// Create a new entity.
/// Input: { "id": "...", "public_key": [...] }
pub const CREATE_ENTITY_CODE: &str = r#"[
    {"op": "create_entity_from_input"}
]"#;

/// Delegate voting power to another entity.
/// Input: { "to": "..." }
pub const DELEGATE_CODE: &str = r#"[
    {"op": "delegate_from_input"}
]"#;

/// Remove delegation.
/// Input: {}
pub const UNDELEGATE_CODE: &str = r#"[
    {"op": "undelegate_from_input"}
]"#;

/// Register new code.
/// Input: { "code": "..." }
pub const REGISTER_CODE_CODE: &str = r#"[
    {"op": "register_code_from_input"}
]"#;

/// Register a new action type.
/// Input: { "name": "...", "code_hash": "..." }
pub const REGISTER_ACTION_CODE: &str = r#"[
    {"op": "register_action_from_input"}
]"#;

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    #[test]
    fn genesis_has_required_paths() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let params = GenesisParams {
            genesis_public_key: signing_key.verifying_key(),
            additional_entities: vec![],
        };

        let state = create_genesis(params);

        // Check required paths exist
        assert!(state.get(&["entities", "genesis", "public_key"]).is_some());
        assert!(state.get(&["entities", "genesis", "tags", "root"]).is_some());
        assert!(state.get(&["consensus", "mechanism"]).is_some());

        // Check core actions exist
        assert!(state.get(&["actions", "set_value"]).is_some());
        assert!(state.get(&["actions", "delete_value"]).is_some());
        assert!(state.get(&["actions", "create_entity"]).is_some());
        assert!(state.get(&["actions", "delegate"]).is_some());

        // Check that action code exists
        let action_hash = state.get(&["actions", "set_value"]).unwrap();
        let hash_str = String::from_utf8_lossy(action_hash);
        assert!(state.get(&["code", &hash_str]).is_some());
    }

    #[test]
    fn genesis_with_additional_entities() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let alice_key = SigningKey::generate(&mut OsRng);

        let params = GenesisParams {
            genesis_public_key: signing_key.verifying_key(),
            additional_entities: vec![("alice".to_string(), alice_key.verifying_key())],
        };

        let state = create_genesis(params);

        assert!(state.get(&["entities", "alice", "public_key"]).is_some());
    }

    #[test]
    fn genesis_is_minimal() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let params = GenesisParams {
            genesis_public_key: signing_key.verifying_key(),
            additional_entities: vec![],
        };

        let state = create_genesis(params);
        let paths = state.enumerate_all();

        // Should have:
        // - entities/genesis/public_key
        // - entities/genesis/tags/root
        // - consensus/mechanism
        // - code/* (8 entries: consensus + 7 actions)
        // - actions/* (7 entries)
        // Total: 2 + 1 + 8 + 7 = 18

        println!("Genesis paths ({}):", paths.len());
        for path in &paths {
            println!("  /{}", path.join("/"));
        }

        assert!(paths.len() < 25, "genesis should have < 25 paths");
    }
}
