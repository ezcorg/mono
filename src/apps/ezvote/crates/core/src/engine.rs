//! The ezvote engine: processes actions and maintains state.

use crate::{Action, Error, Hash, Path, State, Value, Vote, VoteValue};
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Result of consensus check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsensusResult {
    Accept,
    Reject,
    Pending,
}

/// A mutation to state.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Mutation {
    Set(Path, Value),
    Delete(Path),
}

/// Trait for executing code.
pub trait CodeExecutor: Send + Sync {
    /// Execute code with input against state, returning mutations.
    fn execute(
        &self,
        code: &[u8],
        input: &[u8],
        state: &State,
    ) -> Result<Vec<Mutation>, Error>;
}

/// The ezvote engine.
pub struct Engine {
    /// Current state.
    state: State,

    /// Action history (in order of application).
    history: Vec<Action>,

    /// Pending actions awaiting consensus.
    pending: BTreeMap<Hash, (Action, Vec<Vote>)>,

    /// Code executor.
    executor: Box<dyn CodeExecutor>,
}

impl Engine {
    /// Create a new engine with initial state and executor.
    pub fn new(state: State, executor: Box<dyn CodeExecutor>) -> Self {
        Self {
            state,
            history: Vec::new(),
            pending: BTreeMap::new(),
            executor,
        }
    }

    /// Get the current state.
    pub fn state(&self) -> &State {
        &self.state
    }

    /// Get a mutable reference to the current state.
    pub fn state_mut(&mut self) -> &mut State {
        &mut self.state
    }

    /// Get the action history.
    pub fn history(&self) -> &[Action] {
        &self.history
    }

    /// Get pending actions.
    pub fn pending(&self) -> &BTreeMap<Hash, (Action, Vec<Vote>)> {
        &self.pending
    }

    /// Get the current state hash.
    pub fn state_hash(&self) -> Hash {
        self.state.hash()
    }

    /// Look up an entity's public key from state.
    pub fn get_entity_public_key(&self, entity_id: &str) -> Option<VerifyingKey> {
        let path = ["entities", entity_id, "public_key"];
        let key_bytes = self.state.get(&path)?;

        if key_bytes.len() != 32 {
            return None;
        }

        let bytes: [u8; 32] = key_bytes.as_slice().try_into().ok()?;
        VerifyingKey::from_bytes(&bytes).ok()
    }

    /// Verify an action's signature.
    pub fn verify_action_signature(&self, action: &Action) -> Result<(), Error> {
        let public_key = self
            .get_entity_public_key(&action.author)
            .ok_or_else(|| Error::EntityNotFound(action.author.clone()))?;

        if !action.verify_signature(&public_key) {
            return Err(Error::InvalidSignature(action.author.clone()));
        }

        Ok(())
    }

    /// Verify a vote's signature.
    pub fn verify_vote_signature(&self, vote: &Vote) -> Result<(), Error> {
        let public_key = self
            .get_entity_public_key(&vote.voter)
            .ok_or_else(|| Error::EntityNotFound(vote.voter.clone()))?;

        if !vote.verify_signature(&public_key) {
            return Err(Error::InvalidSignature(vote.voter.clone()));
        }

        Ok(())
    }

    /// Get the consensus mechanism code.
    fn get_consensus_mechanism(&self) -> Result<Vec<u8>, Error> {
        let hash_bytes = self
            .state
            .get(&["consensus", "mechanism"])
            .ok_or_else(|| Error::PathNotFound("/consensus/mechanism".to_string()))?;

        let hash = Hash::from_hex(&String::from_utf8_lossy(hash_bytes))
            .ok_or_else(|| Error::PathNotFound("/consensus/mechanism (invalid hash)".to_string()))?;

        let code_path = format!("code/{}", hash.to_hex());
        let parts: Vec<&str> = code_path.split('/').collect();

        self.state
            .get(&parts)
            .cloned()
            .ok_or(Error::CodeNotFound(hash))
    }

    /// Check consensus for an action.
    pub fn check_consensus(&self, action: &Action, votes: &[Vote]) -> Result<ConsensusResult, Error> {
        let mechanism = self.get_consensus_mechanism()?;

        // Encode the input: (action, votes, state_ref)
        let input = ConsensusInput {
            action_id: action.id,
            author: &action.author,
            votes: votes.iter().map(|v| VoteInfo {
                voter: &v.voter,
                value: v.value,
            }).collect(),
        };

        let mut input_bytes = Vec::new();
        ciborium::into_writer(&input, &mut input_bytes)?;

        // Execute the consensus mechanism
        let result = self.executor.execute(&mechanism, &input_bytes, &self.state)?;

        // Parse result - expect a single mutation that's the result
        // For now, just interpret the first byte of the code output
        if result.is_empty() {
            return Ok(ConsensusResult::Pending);
        }

        // The consensus code should emit a "result" mutation
        // For simplicity, we'll look for a specific pattern
        for mutation in result {
            if let Mutation::Set(path, value) = mutation {
                if path == vec!["_result".to_string()] {
                    return match value.as_slice() {
                        b"accept" => Ok(ConsensusResult::Accept),
                        b"reject" => Ok(ConsensusResult::Reject),
                        _ => Ok(ConsensusResult::Pending),
                    };
                }
            }
        }

        Ok(ConsensusResult::Pending)
    }

    /// Submit an action.
    pub fn submit_action(&mut self, mut action: Action) -> Result<(), Error> {
        // Ensure id is computed
        action.refresh_id();

        // Verify signature
        self.verify_action_signature(&action)?;

        // Verify code exists
        let code_path = format!("code/{}", action.transition.code.to_hex());
        let parts: Vec<&str> = code_path.split('/').collect();
        if self.state.get(&parts).is_none() {
            return Err(Error::CodeNotFound(action.transition.code));
        }

        // Add to pending
        self.pending.insert(action.id, (action, Vec::new()));

        Ok(())
    }

    /// Submit a vote on an action.
    pub fn submit_vote(&mut self, vote: Vote) -> Result<(), Error> {
        // Verify the vote signature
        self.verify_vote_signature(&vote)?;

        // Find the pending action
        let (action, votes) = self
            .pending
            .get_mut(&vote.action)
            .ok_or_else(|| Error::InvalidAction("action not pending".to_string()))?;

        // Check for duplicate vote
        if votes.iter().any(|v| v.voter == vote.voter) {
            return Err(Error::AlreadyVoted(vote.voter.clone(), vote.action));
        }

        votes.push(vote);

        // Check if consensus is reached
        let action_clone = action.clone();
        let votes_clone = votes.clone();

        match self.check_consensus(&action_clone, &votes_clone)? {
            ConsensusResult::Accept => {
                // Remove from pending and apply
                self.pending.remove(&action_clone.id);
                self.apply_action(action_clone)?;
            }
            ConsensusResult::Reject => {
                // Remove from pending
                self.pending.remove(&action_clone.id);
                return Err(Error::Rejected);
            }
            ConsensusResult::Pending => {
                // Keep waiting
            }
        }

        Ok(())
    }

    /// Apply an action (after consensus is reached).
    fn apply_action(&mut self, action: Action) -> Result<(), Error> {
        // Get the transition code
        let code_path = format!("code/{}", action.transition.code.to_hex());
        let parts: Vec<&str> = code_path.split('/').collect();
        let code = self
            .state
            .get(&parts)
            .cloned()
            .ok_or(Error::CodeNotFound(action.transition.code))?;

        // Execute the code
        let mutations = self.executor.execute(&code, &action.transition.input, &self.state)?;

        // Apply mutations
        for mutation in mutations {
            match mutation {
                Mutation::Set(path, value) => {
                    // Skip internal results
                    if path.first().map(|s| s.as_str()) == Some("_result") {
                        continue;
                    }
                    self.state.set_path(&path, value);
                }
                Mutation::Delete(path) => {
                    self.state.delete_path(&path);
                }
            }
        }

        // Record in history
        let action_bytes = {
            let mut buf = Vec::new();
            ciborium::into_writer(&action, &mut buf)?;
            buf
        };

        let history_path = format!("history/{}", action.id.to_hex());
        let parts: Vec<&str> = history_path.split('/').collect();
        self.state.set(&parts, action_bytes);

        self.history.push(action);

        Ok(())
    }

    /// Directly apply mutations (for testing/bootstrap).
    pub fn apply_mutations(&mut self, mutations: Vec<Mutation>) {
        for mutation in mutations {
            match mutation {
                Mutation::Set(path, value) => {
                    self.state.set_path(&path, value);
                }
                Mutation::Delete(path) => {
                    self.state.delete_path(&path);
                }
            }
        }
    }
}

/// Input to consensus mechanism.
#[derive(Serialize)]
struct ConsensusInput<'a> {
    action_id: Hash,
    author: &'a str,
    votes: Vec<VoteInfo<'a>>,
}

#[derive(Serialize)]
struct VoteInfo<'a> {
    voter: &'a str,
    value: VoteValue,
}

/// A simple executor that interprets a basic instruction set.
/// This is for testing - a real implementation would use WASM.
#[allow(dead_code)]
pub struct SimpleExecutor;

impl CodeExecutor for SimpleExecutor {
    fn execute(
        &self,
        code: &[u8],
        input: &[u8],
        _state: &State,
    ) -> Result<Vec<Mutation>, Error> {
        // Very simple: interpret code as JSON instructions
        // Format: [{"op": "set", "path": [...], "value": "..."}, ...]

        let instructions: Vec<Instruction> = serde_json::from_slice(code)
            .map_err(|e| Error::Execution(format!("invalid code: {}", e)))?;

        let mut mutations = Vec::new();

        for instr in instructions {
            match instr.op.as_str() {
                "set" => {
                    let path = instr.path.ok_or_else(|| Error::Execution("set requires path".to_string()))?;
                    let value = instr.value.ok_or_else(|| Error::Execution("set requires value".to_string()))?;
                    mutations.push(Mutation::Set(path, value.into_bytes()));
                }
                "delete" => {
                    let path = instr.path.ok_or_else(|| Error::Execution("delete requires path".to_string()))?;
                    mutations.push(Mutation::Delete(path));
                }
                "result" => {
                    // Special: emit consensus result
                    let value = instr.value.ok_or_else(|| Error::Execution("result requires value".to_string()))?;
                    mutations.push(Mutation::Set(vec!["_result".to_string()], value.into_bytes()));
                }
                "copy_input" => {
                    // Copy input to a path (useful for debugging)
                    let path = instr.path.ok_or_else(|| Error::Execution("copy_input requires path".to_string()))?;
                    mutations.push(Mutation::Set(path, input.to_vec()));
                }
                "accept_all" => {
                    // Always accept (for testing)
                    mutations.push(Mutation::Set(vec!["_result".to_string()], b"accept".to_vec()));
                }
                _ => {
                    return Err(Error::Execution(format!("unknown op: {}", instr.op)));
                }
            }
        }

        Ok(mutations)
    }
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct Instruction {
    op: String,
    path: Option<Path>,
    value: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    fn setup_genesis() -> State {
        let mut state = State::new();

        // Create genesis entity
        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = signing_key.verifying_key();
        state.set(
            &["entities", "genesis", "public_key"],
            public_key.to_bytes().to_vec(),
        );
        state.set(
            &["entities", "genesis", "tags", "root"],
            b"true".to_vec(),
        );

        // Create "accept all" consensus mechanism
        let accept_all_code = br#"[{"op": "accept_all"}]"#;
        let code_hash = Hash::of(accept_all_code);
        state.set(
            &["code", &code_hash.to_hex()],
            accept_all_code.to_vec(),
        );
        state.set(
            &["consensus", "mechanism"],
            code_hash.to_hex().into_bytes(),
        );

        // Create a simple "set_value" action
        let set_value_code = br#"[{"op": "set", "path": ["test", "key"], "value": "test_value"}]"#;
        let action_hash = Hash::of(set_value_code);
        state.set(
            &["code", &action_hash.to_hex()],
            set_value_code.to_vec(),
        );
        state.set(
            &["actions", "set_value"],
            action_hash.to_hex().into_bytes(),
        );

        state
    }

    #[test]
    fn engine_creation() {
        let state = setup_genesis();
        let engine = Engine::new(state, Box::new(SimpleExecutor));

        assert!(!engine.state().is_empty());
        assert!(engine.history().is_empty());
    }

    #[test]
    fn state_enumeration() {
        let state = setup_genesis();
        let engine = Engine::new(state, Box::new(SimpleExecutor));

        let all_paths = engine.state().enumerate_all();
        assert!(all_paths.len() >= 4); // entities, code, consensus, actions

        // SE-01: Can enumerate all paths
        for path in &all_paths {
            assert!(engine.state().get_path(path).is_some());
        }
    }

    #[test]
    fn action_code_exists() {
        let state = setup_genesis();
        let engine = Engine::new(state, Box::new(SimpleExecutor));

        // SE-03: Can discover actions
        let action_paths = engine.state().enumerate(&["actions"]);
        assert!(!action_paths.is_empty());

        for path in action_paths {
            let code_hash_bytes = engine.state().get_path(&path).unwrap();
            let code_hash = Hash::from_hex(&String::from_utf8_lossy(code_hash_bytes)).unwrap();

            let code_path = vec!["code".to_string(), code_hash.to_hex()];
            assert!(engine.state().get_path(&code_path).is_some(), "code should exist for action");
        }
    }
}
