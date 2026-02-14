//! Action and vote types.
//!
//! From PROTOCOL.md:
//! ```text
//! Action {
//!   id         : Hash          // Content hash of this action
//!   author     : EntityId      // Who is proposing
//!   parents    : List<Hash>    // Previous state(s) this builds on
//!   transition : Transition    // What change to make
//!   signature  : Signature     // Proof of authorship
//!   timestamp  : Timestamp     // When proposed
//! }
//! ```

use crate::Hash;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// An entity identifier (the hash of their public key).
pub type EntityId = String;

/// An action proposes a state transition.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Action {
    /// Content hash (computed, not stored in serialization for hashing).
    #[serde(skip)]
    pub id: Hash,

    /// Who is proposing this action.
    pub author: EntityId,

    /// Previous state hash(es) this builds on.
    pub parents: Vec<Hash>,

    /// What change to make.
    pub transition: Transition,

    /// Ed25519 signature over the action content.
    pub signature: Vec<u8>,

    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
}

/// A state transition: code + input.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transition {
    /// Hash of the code to execute (stored at /code/<hash>).
    pub code: Hash,

    /// Input data for the code.
    pub input: Vec<u8>,
}

impl Action {
    /// Create a new action and sign it.
    pub fn new(
        author: EntityId,
        parents: Vec<Hash>,
        transition: Transition,
        signing_key: &SigningKey,
    ) -> Self {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let mut action = Self {
            id: Hash::ZERO,
            author,
            parents,
            transition,
            signature: Vec::new(),
            timestamp,
        };

        // Sign the action (without id and signature fields)
        let content = action.signable_content();
        let signature = signing_key.sign(&content);
        action.signature = signature.to_bytes().to_vec();

        // Compute the content hash
        action.id = action.compute_id();

        action
    }

    /// Get the content to be signed (excludes id and signature).
    fn signable_content(&self) -> Vec<u8> {
        let signable = SignableAction {
            author: &self.author,
            parents: &self.parents,
            transition: &self.transition,
            timestamp: self.timestamp,
        };

        let mut buf = Vec::new();
        ciborium::into_writer(&signable, &mut buf).expect("serialization should not fail");
        buf
    }

    /// Compute the content hash of this action.
    pub fn compute_id(&self) -> Hash {
        Hash::of(&self.signable_content())
    }

    /// Verify the action's signature against a public key.
    pub fn verify_signature(&self, public_key: &VerifyingKey) -> bool {
        if self.signature.len() != 64 {
            return false;
        }

        let sig_bytes: [u8; 64] = self.signature.clone().try_into().unwrap();
        let signature = match Signature::from_bytes(&sig_bytes) {
            sig => sig,
        };

        let content = self.signable_content();
        public_key.verify(&content, &signature).is_ok()
    }

    /// Recompute and set the id field.
    pub fn refresh_id(&mut self) {
        self.id = self.compute_id();
    }
}

/// Helper struct for signing (excludes mutable fields).
#[derive(Serialize)]
struct SignableAction<'a> {
    author: &'a EntityId,
    parents: &'a Vec<Hash>,
    transition: &'a Transition,
    timestamp: u64,
}

/// A vote on an action.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Vote {
    /// The action being voted on.
    pub action: Hash,

    /// The entity casting the vote.
    pub voter: EntityId,

    /// Accept or reject.
    pub value: VoteValue,

    /// Signature over the vote content.
    pub signature: Vec<u8>,

    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
}

/// The vote value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum VoteValue {
    Accept,
    Reject,
}

impl Vote {
    /// Create and sign a new vote.
    pub fn new(
        action: Hash,
        voter: EntityId,
        value: VoteValue,
        signing_key: &SigningKey,
    ) -> Self {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let mut vote = Self {
            action,
            voter,
            value,
            signature: Vec::new(),
            timestamp,
        };

        let content = vote.signable_content();
        let signature = signing_key.sign(&content);
        vote.signature = signature.to_bytes().to_vec();

        vote
    }

    /// Get the content to be signed.
    fn signable_content(&self) -> Vec<u8> {
        let signable = SignableVote {
            action: &self.action,
            voter: &self.voter,
            value: &self.value,
            timestamp: self.timestamp,
        };

        let mut buf = Vec::new();
        ciborium::into_writer(&signable, &mut buf).expect("serialization should not fail");
        buf
    }

    /// Verify the vote's signature against a public key.
    pub fn verify_signature(&self, public_key: &VerifyingKey) -> bool {
        if self.signature.len() != 64 {
            return false;
        }

        let sig_bytes: [u8; 64] = self.signature.clone().try_into().unwrap();
        let signature = Signature::from_bytes(&sig_bytes);

        let content = self.signable_content();
        public_key.verify(&content, &signature).is_ok()
    }
}

#[derive(Serialize)]
struct SignableVote<'a> {
    action: &'a Hash,
    voter: &'a EntityId,
    value: &'a VoteValue,
    timestamp: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    fn generate_keypair() -> (SigningKey, VerifyingKey) {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        (signing_key, verifying_key)
    }

    #[test]
    fn action_signature_valid() {
        let (signing_key, verifying_key) = generate_keypair();

        let action = Action::new(
            "alice".to_string(),
            vec![Hash::ZERO],
            Transition {
                code: Hash::of(b"some_code"),
                input: b"input".to_vec(),
            },
            &signing_key,
        );

        assert!(action.verify_signature(&verifying_key));
    }

    #[test]
    fn action_signature_invalid_wrong_key() {
        let (signing_key, _) = generate_keypair();
        let (_, other_verifying_key) = generate_keypair();

        let action = Action::new(
            "alice".to_string(),
            vec![Hash::ZERO],
            Transition {
                code: Hash::of(b"some_code"),
                input: b"input".to_vec(),
            },
            &signing_key,
        );

        assert!(!action.verify_signature(&other_verifying_key));
    }

    #[test]
    fn action_id_deterministic() {
        let (signing_key, _) = generate_keypair();

        let action1 = Action::new(
            "alice".to_string(),
            vec![Hash::ZERO],
            Transition {
                code: Hash::of(b"code"),
                input: b"input".to_vec(),
            },
            &signing_key,
        );

        // Same content should have same signable content
        // (but different timestamps, so ids will differ in practice)
        // This test just verifies compute_id is consistent
        let id1 = action1.compute_id();
        let id2 = action1.compute_id();
        assert_eq!(id1, id2);
    }

    #[test]
    fn vote_signature_valid() {
        let (signing_key, verifying_key) = generate_keypair();
        let action_hash = Hash::of(b"some_action");

        let vote = Vote::new(action_hash, "alice".to_string(), VoteValue::Accept, &signing_key);

        assert!(vote.verify_signature(&verifying_key));
    }

    #[test]
    fn vote_signature_invalid() {
        let (signing_key, _) = generate_keypair();
        let (_, other_key) = generate_keypair();
        let action_hash = Hash::of(b"some_action");

        let vote = Vote::new(action_hash, "alice".to_string(), VoteValue::Accept, &signing_key);

        assert!(!vote.verify_signature(&other_key));
    }
}
