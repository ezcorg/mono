//! Code executor implementation.
//!
//! The StandardExecutor interprets a simple JSON instruction set.
//! This is for the reference implementation - a production system
//! would use WASM for better sandboxing and portability.

use crate::{CodeExecutor, Error, Hash, Mutation, Path, State, VoteValue};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

/// Standard executor that interprets JSON instructions.
pub struct StandardExecutor;

impl CodeExecutor for StandardExecutor {
    fn execute(
        &self,
        code: &[u8],
        input: &[u8],
        state: &State,
    ) -> Result<Vec<Mutation>, Error> {
        let instructions: Vec<Instruction> = serde_json::from_slice(code)
            .map_err(|e| Error::Execution(format!("invalid code: {}", e)))?;

        let input_data: serde_json::Value = if input.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(input)
                .map_err(|e| Error::Execution(format!("invalid input: {}", e)))?
        };

        let mut mutations = Vec::new();

        for instr in instructions {
            self.execute_instruction(&instr, &input_data, state, &mut mutations)?;
        }

        Ok(mutations)
    }
}

impl StandardExecutor {
    fn execute_instruction(
        &self,
        instr: &Instruction,
        input: &serde_json::Value,
        state: &State,
        mutations: &mut Vec<Mutation>,
    ) -> Result<(), Error> {
        match instr.op.as_str() {
            // Basic operations
            "set" => {
                let path = instr
                    .path
                    .clone()
                    .ok_or_else(|| Error::Execution("set requires path".into()))?;
                let value = instr
                    .value
                    .clone()
                    .ok_or_else(|| Error::Execution("set requires value".into()))?;
                mutations.push(Mutation::Set(path, value.into_bytes()));
            }

            "delete" => {
                let path = instr
                    .path
                    .clone()
                    .ok_or_else(|| Error::Execution("delete requires path".into()))?;
                mutations.push(Mutation::Delete(path));
            }

            "result" => {
                let value = instr
                    .value
                    .clone()
                    .ok_or_else(|| Error::Execution("result requires value".into()))?;
                mutations.push(Mutation::Set(
                    vec!["_result".to_string()],
                    value.into_bytes(),
                ));
            }

            // Testing operations
            "accept_all" => {
                mutations.push(Mutation::Set(
                    vec!["_result".to_string()],
                    b"accept".to_vec(),
                ));
            }

            "reject_all" => {
                mutations.push(Mutation::Set(
                    vec!["_result".to_string()],
                    b"reject".to_vec(),
                ));
            }

            // Input-based operations
            "set_from_input" => {
                let path = input["path"]
                    .as_array()
                    .ok_or_else(|| Error::Execution("input.path must be array".into()))?
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .ok_or_else(|| Error::Execution("path segments must be strings".into()))
                            .map(|s| s.to_string())
                    })
                    .collect::<Result<Path, _>>()?;

                let value = input["value"]
                    .as_str()
                    .ok_or_else(|| Error::Execution("input.value must be string".into()))?;

                mutations.push(Mutation::Set(path, value.as_bytes().to_vec()));
            }

            "delete_from_input" => {
                let path = input["path"]
                    .as_array()
                    .ok_or_else(|| Error::Execution("input.path must be array".into()))?
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .ok_or_else(|| Error::Execution("path segments must be strings".into()))
                            .map(|s| s.to_string())
                    })
                    .collect::<Result<Path, _>>()?;

                mutations.push(Mutation::Delete(path));
            }

            "create_entity_from_input" => {
                let id = input["id"]
                    .as_str()
                    .ok_or_else(|| Error::Execution("input.id must be string".into()))?;

                let public_key = input["public_key"]
                    .as_array()
                    .ok_or_else(|| Error::Execution("input.public_key must be array".into()))?
                    .iter()
                    .map(|v| {
                        v.as_u64()
                            .ok_or_else(|| Error::Execution("public_key must be bytes".into()))
                            .map(|n| n as u8)
                    })
                    .collect::<Result<Vec<u8>, _>>()?;

                mutations.push(Mutation::Set(
                    vec!["entities".into(), id.into(), "public_key".into()],
                    public_key,
                ));

                // Copy any tags
                if let Some(tags) = input["tags"].as_object() {
                    for (key, value) in tags {
                        if let Some(v) = value.as_str() {
                            mutations.push(Mutation::Set(
                                vec!["entities".into(), id.into(), "tags".into(), key.clone()],
                                v.as_bytes().to_vec(),
                            ));
                        }
                    }
                }
            }

            "delegate_from_input" => {
                // Get author from consensus input
                let author = input["_author"]
                    .as_str()
                    .ok_or_else(|| Error::Execution("_author required for delegate".into()))?;

                let to = input["to"]
                    .as_str()
                    .ok_or_else(|| Error::Execution("input.to must be string".into()))?;

                mutations.push(Mutation::Set(
                    vec!["entities".into(), author.into(), "delegate".into()],
                    to.as_bytes().to_vec(),
                ));
            }

            "undelegate_from_input" => {
                let author = input["_author"]
                    .as_str()
                    .ok_or_else(|| Error::Execution("_author required for undelegate".into()))?;

                mutations.push(Mutation::Delete(vec![
                    "entities".into(),
                    author.into(),
                    "delegate".into(),
                ]));
            }

            "register_code_from_input" => {
                let code_str = input["code"]
                    .as_str()
                    .ok_or_else(|| Error::Execution("input.code must be string".into()))?;

                let hash = Hash::of(code_str.as_bytes());
                mutations.push(Mutation::Set(
                    vec!["code".into(), hash.to_hex()],
                    code_str.as_bytes().to_vec(),
                ));

                // Return the hash
                mutations.push(Mutation::Set(
                    vec!["_output".into(), "hash".into()],
                    hash.to_hex().into_bytes(),
                ));
            }

            "register_action_from_input" => {
                let name = input["name"]
                    .as_str()
                    .ok_or_else(|| Error::Execution("input.name must be string".into()))?;

                let code_hash = input["code_hash"]
                    .as_str()
                    .ok_or_else(|| Error::Execution("input.code_hash must be string".into()))?;

                // Verify code exists
                let code_path = vec!["code".to_string(), code_hash.to_string()];
                if state.get_path(&code_path).is_none() {
                    return Err(Error::Execution(format!("code {} not found", code_hash)));
                }

                mutations.push(Mutation::Set(
                    vec!["actions".into(), name.into()],
                    code_hash.as_bytes().to_vec(),
                ));
            }

            // Liquid democracy consensus
            "liquid_democracy" => {
                self.execute_liquid_democracy(input, state, mutations)?;
            }

            _ => {
                return Err(Error::Execution(format!("unknown op: {}", instr.op)));
            }
        }

        Ok(())
    }

    /// Execute liquid democracy consensus mechanism.
    ///
    /// Rules:
    /// 1. Each entity has base voting power of 1
    /// 2. If entity A delegates to entity B, and A does not vote directly,
    ///    then B's vote counts for both A and B
    /// 3. Delegation is transitive: if A->B->C and only C votes, C gets power 3
    /// 4. Direct votes override delegation: if A->B but A votes, A's vote counts
    ///    independently and B does not get A's power
    fn execute_liquid_democracy(
        &self,
        input: &serde_json::Value,
        state: &State,
        mutations: &mut Vec<Mutation>,
    ) -> Result<(), Error> {
        // Parse votes from input
        let votes: BTreeMap<String, VoteValue> = input["votes"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|v| {
                let voter = v["voter"].as_str()?;
                let value = match v["value"].as_str()? {
                    "Accept" => VoteValue::Accept,
                    "Reject" => VoteValue::Reject,
                    _ => return None,
                };
                Some((voter.to_string(), value))
            })
            .collect();

        // Get all entities
        let entity_paths = state.enumerate(&["entities"]);
        let entities: BTreeSet<String> = entity_paths
            .iter()
            .filter_map(|p| p.get(1).cloned())
            .collect();

        // Build delegation graph
        let mut delegations: BTreeMap<String, String> = BTreeMap::new();
        for entity in &entities {
            if let Some(delegate_bytes) = state.get(&["entities", entity, "delegate"]) {
                if let Ok(delegate) = String::from_utf8(delegate_bytes.clone()) {
                    if entities.contains(&delegate) {
                        delegations.insert(entity.clone(), delegate);
                    }
                }
            }
        }

        // For each entity, determine their effective vote:
        // - If they voted directly, use their vote
        // - If they didn't vote but have a delegate chain that leads to a voter, use that vote
        // - Otherwise, they abstain
        let mut accept_power = 0u64;
        let mut reject_power = 0u64;

        for entity in &entities {
            let effective_vote = if let Some(vote) = votes.get(entity) {
                // Direct vote
                Some(*vote)
            } else {
                // Follow delegation chain to find a voter
                self.find_delegated_vote(entity, &delegations, &votes)
            };

            match effective_vote {
                Some(VoteValue::Accept) => accept_power += 1,
                Some(VoteValue::Reject) => reject_power += 1,
                None => {} // Abstain
            }
        }

        // Determine result
        let result = if accept_power > reject_power && accept_power > 0 {
            "accept"
        } else if reject_power > 0 && reject_power >= accept_power {
            "reject"
        } else {
            "pending"
        };

        mutations.push(Mutation::Set(
            vec!["_result".to_string()],
            result.as_bytes().to_vec(),
        ));

        Ok(())
    }

    /// Follow delegation chain to find how an entity's vote is cast.
    fn find_delegated_vote(
        &self,
        entity: &str,
        delegations: &BTreeMap<String, String>,
        votes: &BTreeMap<String, VoteValue>,
    ) -> Option<VoteValue> {
        let mut current = entity;
        let mut visited = BTreeSet::new();

        loop {
            // If current entity voted, return their vote
            if let Some(vote) = votes.get(current) {
                return Some(*vote);
            }

            // If current entity has a delegate, follow it
            if let Some(delegate) = delegations.get(current) {
                if visited.contains(delegate.as_str()) {
                    return None; // Cycle detected
                }
                visited.insert(current);
                current = delegate;
            } else {
                return None; // No delegate, no vote
            }
        }
    }
}

#[derive(Deserialize)]
struct Instruction {
    op: String,
    path: Option<Path>,
    value: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_set_instruction() {
        let executor = StandardExecutor;
        let state = State::new();
        let code = br#"[{"op": "set", "path": ["a", "b"], "value": "hello"}]"#;

        let mutations = executor.execute(code, &[], &state).unwrap();

        assert_eq!(mutations.len(), 1);
        match &mutations[0] {
            Mutation::Set(path, value) => {
                assert_eq!(path, &vec!["a".to_string(), "b".to_string()]);
                assert_eq!(value, b"hello");
            }
            _ => panic!("expected Set"),
        }
    }

    #[test]
    fn test_accept_all() {
        let executor = StandardExecutor;
        let state = State::new();
        let code = br#"[{"op": "accept_all"}]"#;

        let mutations = executor.execute(code, &[], &state).unwrap();

        assert!(mutations.iter().any(|m| matches!(
            m,
            Mutation::Set(path, value) if path == &vec!["_result".to_string()] && value == b"accept"
        )));
    }

    #[test]
    fn test_set_from_input() {
        let executor = StandardExecutor;
        let state = State::new();
        let code = br#"[{"op": "set_from_input"}]"#;
        let input = br#"{"path": ["test", "key"], "value": "world"}"#;

        let mutations = executor.execute(code, input, &state).unwrap();

        assert_eq!(mutations.len(), 1);
        match &mutations[0] {
            Mutation::Set(path, value) => {
                assert_eq!(path, &vec!["test".to_string(), "key".to_string()]);
                assert_eq!(value, b"world");
            }
            _ => panic!("expected Set"),
        }
    }

    #[test]
    fn test_liquid_democracy_simple() {
        let executor = StandardExecutor;

        // Create state with two entities
        let mut state = State::new();
        state.set(&["entities", "alice", "public_key"], vec![0u8; 32]);
        state.set(&["entities", "bob", "public_key"], vec![0u8; 32]);

        let code = br#"[{"op": "liquid_democracy"}]"#;
        let input = br#"{
            "votes": [
                {"voter": "alice", "value": "Accept"},
                {"voter": "bob", "value": "Reject"}
            ]
        }"#;

        let mutations = executor.execute(code, input, &state).unwrap();

        // Tie should be pending or reject (depending on implementation)
        let result = mutations.iter().find_map(|m| match m {
            Mutation::Set(path, value) if path == &vec!["_result".to_string()] => {
                Some(String::from_utf8_lossy(value).to_string())
            }
            _ => None,
        });

        assert!(result.is_some());
        // With equal votes, reject wins (reject_power >= accept_power)
        assert_eq!(result.unwrap(), "reject");
    }

    #[test]
    fn test_liquid_democracy_with_delegation() {
        let executor = StandardExecutor;

        // Create state with three entities, bob delegates to alice
        let mut state = State::new();
        state.set(&["entities", "alice", "public_key"], vec![0u8; 32]);
        state.set(&["entities", "bob", "public_key"], vec![0u8; 32]);
        state.set(&["entities", "bob", "delegate"], b"alice".to_vec());
        state.set(&["entities", "carol", "public_key"], vec![0u8; 32]);

        let code = br#"[{"op": "liquid_democracy"}]"#;
        let input = br#"{
            "votes": [
                {"voter": "alice", "value": "Accept"},
                {"voter": "carol", "value": "Reject"}
            ]
        }"#;

        let mutations = executor.execute(code, input, &state).unwrap();

        let result = mutations.iter().find_map(|m| match m {
            Mutation::Set(path, value) if path == &vec!["_result".to_string()] => {
                Some(String::from_utf8_lossy(value).to_string())
            }
            _ => None,
        });

        // Alice has power 2 (herself + bob's delegation), carol has power 1
        // 2 > 1, so accept
        assert_eq!(result.unwrap(), "accept");
    }

    #[test]
    fn test_liquid_democracy_transitive_delegation() {
        let executor = StandardExecutor;

        // alice <- bob <- carol (carol delegates to bob, bob delegates to alice)
        let mut state = State::new();
        state.set(&["entities", "alice", "public_key"], vec![0u8; 32]);
        state.set(&["entities", "bob", "public_key"], vec![0u8; 32]);
        state.set(&["entities", "bob", "delegate"], b"alice".to_vec());
        state.set(&["entities", "carol", "public_key"], vec![0u8; 32]);
        state.set(&["entities", "carol", "delegate"], b"bob".to_vec());
        state.set(&["entities", "dave", "public_key"], vec![0u8; 32]);

        let code = br#"[{"op": "liquid_democracy"}]"#;
        let input = br#"{
            "votes": [
                {"voter": "alice", "value": "Accept"},
                {"voter": "dave", "value": "Reject"}
            ]
        }"#;

        let mutations = executor.execute(code, input, &state).unwrap();

        let result = mutations.iter().find_map(|m| match m {
            Mutation::Set(path, value) if path == &vec!["_result".to_string()] => {
                Some(String::from_utf8_lossy(value).to_string())
            }
            _ => None,
        });

        // Alice has power 3 (herself + bob + carol), dave has power 1
        // 3 > 1, so accept
        assert_eq!(result.unwrap(), "accept");
    }
}
