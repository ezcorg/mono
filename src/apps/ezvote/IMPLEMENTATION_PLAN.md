# ezvote: Implementation Plan

Reference implementation of the ezvote protocol.

**Related documents:**
- [PROTOCOL.md](./PROTOCOL.md) — Protocol specification (the source of truth)
- [tests/CONFORMANCE.md](./tests/CONFORMANCE.md) — Conformance test specifications

---

## Guiding Principles

This implementation is driven by the protocol's desiderata, not by technology choices. We choose technologies only where they help satisfy the properties.

| Property | Implication for Implementation |
|----------|-------------------------------|
| Self-modifying | No hardcoded logic; everything is state |
| Total state exposure | State is a simple tree; no private fields |
| Transparent/auditable | All mutations go through action log |
| Dynamic trust | No special-cased entities in code |
| Versioned state | Content-addressed storage; DAG structure |
| Consensus-gated | No mutation without consensus check |
| Robust | Gossip protocol; eventual consistency |
| Simple | Minimal primitives; <10000 LOC core |

---

## Phase 0: Minimal Viable Protocol

**Goal:** Implement the absolute minimum to pass conformance tests.

### 0.1 The Three Primitives

From PROTOCOL.md, we need only:

```
State     : Path -> Value
Action    : { author, parents, transition, signature }
Consensus : (State, Action, Votes) -> Accept | Reject | Pending
```

### 0.2 Minimal Implementation

```rust
// src/lib.rs — The entire core in one file

use std::collections::BTreeMap;

/// Path is a list of segments
pub type Path = Vec<String>;

/// Value is just bytes
pub type Value = Vec<u8>;

/// State is a tree
#[derive(Clone, Default)]
pub struct State {
    root: BTreeMap<String, Node>,
}

enum Node {
    Value(Value),
    Tree(BTreeMap<String, Node>),
}

impl State {
    pub fn get(&self, path: &Path) -> Option<&Value> { /* ... */ }
    pub fn set(&mut self, path: &Path, value: Value) { /* ... */ }
    pub fn delete(&mut self, path: &Path) { /* ... */ }
    pub fn enumerate(&self, prefix: &Path) -> Vec<Path> { /* ... */ }
    pub fn hash(&self) -> [u8; 32] { /* ... */ }
}

/// Action proposes a state transition
pub struct Action {
    pub id: [u8; 32],
    pub author: String,
    pub parents: Vec<[u8; 32]>,
    pub transition: Transition,
    pub signature: Vec<u8>,
    pub timestamp: u64,
}

pub struct Transition {
    pub code: [u8; 32],  // Hash of code to execute
    pub input: Vec<u8>,  // Input data
}

/// Vote on an action
pub struct Vote {
    pub action: [u8; 32],
    pub voter: String,
    pub value: VoteValue,
    pub signature: Vec<u8>,
}

pub enum VoteValue { Accept, Reject }

/// The engine processes actions
pub struct Engine {
    state: State,
    history: Vec<Action>,
    pending: BTreeMap<[u8; 32], (Action, Vec<Vote>)>,
    executor: Box<dyn CodeExecutor>,
}

pub trait CodeExecutor {
    fn execute(&self, code: &[u8], input: &[u8], state: &State) -> Result<Vec<Mutation>, Error>;
}

pub enum Mutation {
    Set(Path, Value),
    Delete(Path),
}
```

### 0.3 Bootstrap Genesis

```rust
fn genesis() -> State {
    let mut s = State::default();

    // Genesis entity
    s.set(&["entities", "genesis", "public_key"], GENESIS_PUBKEY);
    s.set(&["entities", "genesis", "tags", "root"], b"true");

    // Consensus mechanism (liquid democracy)
    let consensus_code = compile(LIQUID_DEMOCRACY_SOURCE);
    let consensus_hash = hash(&consensus_code);
    s.set(&["code", &hex(consensus_hash)], consensus_code);
    s.set(&["consensus", "mechanism"], consensus_hash);

    // Core actions
    for (name, source) in [
        ("create_entity", CREATE_ENTITY_SOURCE),
        ("set_value", SET_VALUE_SOURCE),
        ("delete_value", DELETE_VALUE_SOURCE),
        ("delegate", DELEGATE_SOURCE),
        ("register_code", REGISTER_CODE_SOURCE),
    ] {
        let code = compile(source);
        let hash = hash(&code);
        s.set(&["code", &hex(hash)], code);
        s.set(&["actions", name], hash);
    }

    s
}
```

---

## Phase 1: Pass Core Conformance Tests

**Goal:** Pass all SM-*, SE-*, TA-* tests.

### 1.1 Self-Modification (SM-*)

The key insight: consensus mechanism is just code at a path.

```rust
impl Engine {
    fn get_consensus_mechanism(&self) -> &[u8] {
        let hash = self.state.get(&["consensus", "mechanism"]).unwrap();
        self.state.get(&["code", &hex(hash)]).unwrap()
    }

    fn check_consensus(&self, action: &Action, votes: &[Vote]) -> ConsensusResult {
        let mechanism = self.get_consensus_mechanism();
        let input = encode(&(action, votes));
        let result = self.executor.execute(mechanism, &input, &self.state)?;
        decode(&result)
    }
}
```

**Test SM-01** passes when:
1. New consensus code can be registered
2. `/consensus/mechanism` can be changed via action
3. Subsequent actions use new mechanism

### 1.2 State Exposure (SE-*)

State is a tree with no hidden values:

```rust
impl State {
    /// Enumerate all paths (SE-01)
    pub fn enumerate(&self, prefix: &Path) -> Vec<Path> {
        fn walk(node: &Node, current: Path, acc: &mut Vec<Path>) {
            match node {
                Node::Value(_) => acc.push(current),
                Node::Tree(children) => {
                    for (k, v) in children {
                        let mut next = current.clone();
                        next.push(k.clone());
                        walk(v, next, acc);
                    }
                }
            }
        }
        let mut result = vec![];
        if let Some(node) = self.get_node(prefix) {
            walk(node, prefix.clone(), &mut result);
        }
        result
    }

    /// Hash covers ALL state (SE-04)
    pub fn hash(&self) -> [u8; 32] {
        // Merkle tree over entire state
        self.compute_merkle_root()
    }
}
```

### 1.3 Transparency (TA-*)

Every action goes through the log:

```rust
impl Engine {
    fn apply_action(&mut self, action: Action) -> Result<(), Error> {
        // 1. Verify signature (TA-05, TA-06)
        self.verify_signature(&action)?;

        // 2. Check consensus
        let votes = self.pending.get(&action.id)
            .map(|(_, v)| v.as_slice())
            .unwrap_or(&[]);

        match self.check_consensus(&action, votes)? {
            ConsensusResult::Accept => {
                // 3. Execute transition
                let code = self.state.get(&["code", &hex(action.transition.code)])
                    .ok_or(Error::CodeNotFound)?;

                let mutations = self.executor.execute(
                    code,
                    &action.transition.input,
                    &self.state
                )?;

                // 4. Apply mutations
                for m in mutations {
                    match m {
                        Mutation::Set(path, value) => self.state.set(&path, value),
                        Mutation::Delete(path) => self.state.delete(&path),
                    }
                }

                // 5. Record in history (TA-03)
                let action_data = encode(&action);
                self.state.set(&["history", &hex(action.id)], action_data);
                self.history.push(action);

                Ok(())
            }
            ConsensusResult::Reject => Err(Error::Rejected),
            ConsensusResult::Pending => {
                self.pending.insert(action.id, (action, votes.to_vec()));
                Err(Error::Pending)
            }
        }
    }
}

/// Replay produces identical state (TA-04)
fn replay(genesis: State, actions: &[Action]) -> State {
    let mut engine = Engine::new(genesis);
    for action in actions {
        engine.apply_action(action.clone()).unwrap();
    }
    engine.state
}

#[test]
fn test_replay_determinism() {
    let state1 = run_scenario();
    let log = state1.get_history();

    let state2 = replay(genesis(), &log);

    assert_eq!(state1.hash(), state2.hash());
}
```

---

## Phase 2: Dynamic Trust and Versioning

**Goal:** Pass DT-*, VS-* tests.

### 2.1 Dynamic Trust (DT-*)

No hardcoded entity checks:

```rust
// WRONG: Hardcoded check
fn can_do_admin_thing(entity: &str) -> bool {
    entity == "genesis"  // ❌ Hardcoded!
}

// RIGHT: Check state
fn can_do_admin_thing(state: &State, entity: &str) -> bool {
    state.get(&["entities", entity, "tags", "admin"])
        .map(|v| v == b"true")
        .unwrap_or(false)
}
```

### 2.2 Versioned State (VS-*)

State is content-addressed; history is a DAG:

```rust
pub struct VersionedState {
    /// All known states by hash
    states: BTreeMap<[u8; 32], State>,
    /// DAG edges: state_hash -> parent_hashes
    parents: BTreeMap<[u8; 32], Vec<[u8; 32]>>,
    /// Current tip(s)
    tips: Vec<[u8; 32]>,
}

impl VersionedState {
    /// Query historical state (VS-01)
    pub fn at(&self, hash: &[u8; 32]) -> Option<&State> {
        self.states.get(hash)
    }

    /// Create fork (VS-02, VS-03)
    pub fn fork(&mut self, from: [u8; 32], action: Action) -> Result<[u8; 32], Error> {
        let parent = self.states.get(&from).ok_or(Error::NotFound)?;
        let mut new_state = parent.clone();

        // Apply action to forked state
        apply_action_to(&mut new_state, &action)?;

        let new_hash = new_state.hash();
        self.states.insert(new_hash, new_state);
        self.parents.insert(new_hash, vec![from]);
        self.tips.push(new_hash);

        Ok(new_hash)
    }
}
```

---

## Phase 3: Consensus (Liquid Democracy)

**Goal:** Pass CG-* tests.

### 3.1 Liquid Democracy Implementation

This is stored as code in state, not hardcoded:

```rust
// This compiles to bytecode stored at /code/<hash>
// Referenced by /consensus/mechanism

fn liquid_democracy(state: &State, action: &Action, votes: &[Vote]) -> ConsensusResult {
    // Build delegation graph
    let entities = state.enumerate(&["entities"]);
    let mut delegations: BTreeMap<String, String> = BTreeMap::new();

    for entity_path in &entities {
        if let Some(delegate) = state.get(&[entity_path, "delegate"]) {
            delegations.insert(entity_path.clone(), String::from_utf8(delegate).unwrap());
        }
    }

    // Compute voting power
    let power = compute_power(&entities, &delegations);

    // Tally
    let mut accept_power = 0u64;
    let mut reject_power = 0u64;

    for vote in votes {
        // Check voter hasn't delegated (CG-04: direct vote overrides)
        if delegations.contains_key(&vote.voter) {
            continue; // Skip, their delegate votes for them unless they vote directly
        }

        let p = power.get(&vote.voter).copied().unwrap_or(1);
        match vote.value {
            VoteValue::Accept => accept_power += p,
            VoteValue::Reject => reject_power += p,
        }
    }

    // Also count delegated power for voters who voted
    for vote in votes {
        let delegated = get_transitive_delegators(&vote.voter, &delegations);
        for d in delegated {
            // Only count if delegator didn't vote directly
            if !votes.iter().any(|v| v.voter == d) {
                match vote.value {
                    VoteValue::Accept => accept_power += 1,
                    VoteValue::Reject => reject_power += 1,
                }
            }
        }
    }

    if accept_power > reject_power && accept_power > 0 {
        ConsensusResult::Accept
    } else if reject_power >= accept_power && reject_power > 0 {
        ConsensusResult::Reject
    } else {
        ConsensusResult::Pending
    }
}

fn compute_power(
    entities: &[String],
    delegations: &BTreeMap<String, String>
) -> BTreeMap<String, u64> {
    let mut power = BTreeMap::new();

    for entity in entities {
        // Base power = 1
        let mut p = 1u64;

        // Add power from those who delegate to us
        for (from, to) in delegations {
            if to == entity && !delegations.contains_key(from) {
                // Direct delegation (non-transitive delegator)
                p += 1;
            }
        }

        // Handle transitive delegation
        for (from, _) in delegations {
            if follows_chain_to(from, entity, delegations) {
                p += 1;
            }
        }

        power.insert(entity.clone(), p);
    }

    power
}

fn follows_chain_to(
    from: &str,
    to: &str,
    delegations: &BTreeMap<String, String>
) -> bool {
    let mut current = from;
    let mut visited = std::collections::HashSet::new();

    while let Some(next) = delegations.get(current) {
        if next == to {
            return true;
        }
        if visited.contains(next.as_str()) {
            return false; // Cycle (CG-06)
        }
        visited.insert(current);
        current = next;
    }

    false
}
```

---

## Phase 4: Networking and Robustness

**Goal:** Pass RB-* tests.

### 4.1 Gossip Protocol

The protocol doesn't mandate a specific network layer. We need:
- Broadcast actions and votes to peers
- Request missing state/history from peers
- Handle partitions gracefully

```rust
pub trait Network {
    /// Broadcast to all known peers
    fn broadcast(&self, message: Message);

    /// Request from specific peer
    fn request(&self, peer: PeerId, query: Query) -> Response;

    /// Subscribe to incoming messages
    fn subscribe(&self) -> Receiver<(PeerId, Message)>;
}

pub enum Message {
    Action(Action),
    Vote(Vote),
    StateQuery { hash: [u8; 32], path: Path },
    StateResponse { value: Option<Value>, proof: MerkleProof },
}
```

### 4.2 Partition Handling

```rust
impl Engine {
    /// Handle potentially stale/conflicting data
    fn sync(&mut self, peer_state_hash: [u8; 32], peer_tips: Vec<[u8; 32]>) {
        // Find common ancestor
        let common = self.find_common_ancestor(&peer_tips);

        // Request missing actions
        let missing = self.request_actions_since(common);

        // Apply, creating forks if needed
        for action in missing {
            if self.state.hash() != action.parents[0] {
                // Fork!
                self.versioned.fork(action.parents[0], action);
            } else {
                self.apply_action(action);
            }
        }
    }
}
```

---

## Phase 5: Code Execution

**Goal:** Sandboxed, deterministic execution.

The protocol requires executing arbitrary code. Options:

| Approach | Pros | Cons |
|----------|------|------|
| WASM | Portable, sandboxed, mature tooling | Complexity, startup overhead |
| Custom bytecode | Full control, minimal | Must build everything |
| Tree-walking interpreter | Simple, easy to audit | Slow, limited |

For the reference implementation, we'll use WASM but keep the abstraction:

```rust
pub trait CodeExecutor: Send + Sync {
    fn execute(
        &self,
        code: &[u8],
        input: &[u8],
        state: &State
    ) -> Result<Vec<Mutation>, ExecutionError>;
}

// WASM implementation
pub struct WasmExecutor {
    engine: wasmtime::Engine,
}

impl CodeExecutor for WasmExecutor {
    fn execute(&self, code: &[u8], input: &[u8], state: &State) -> Result<Vec<Mutation>, ExecutionError> {
        let module = wasmtime::Module::new(&self.engine, code)?;
        let mut store = wasmtime::Store::new(&self.engine, ExecutionContext {
            state: state.clone(),
            mutations: vec![],
        });

        // Set fuel limit for determinism
        store.set_fuel(MAX_FUEL)?;

        let instance = wasmtime::Instance::new(&mut store, &module, &[])?;
        let run = instance.get_typed_func::<(i32, i32), i32>(&mut store, "run")?;

        // Pass input, get output
        let (input_ptr, input_len) = write_to_memory(&mut store, input);
        run.call(&mut store, (input_ptr, input_len))?;

        Ok(store.data().mutations.clone())
    }
}

// Alternative: simple interpreter for testing
pub struct SimpleInterpreter;

impl CodeExecutor for SimpleInterpreter {
    fn execute(&self, code: &[u8], input: &[u8], state: &State) -> Result<Vec<Mutation>, ExecutionError> {
        // Parse simple instruction set
        let instructions = parse_bytecode(code);
        let mut vm = SimpleVM::new(input, state);

        for inst in instructions {
            vm.execute(inst)?;
        }

        Ok(vm.mutations)
    }
}
```

---

## Project Structure

```
ezvote/
├── Cargo.toml
├── PROTOCOL.md                 # Specification
├── IMPLEMENTATION_PLAN.md      # This file
├── src/
│   ├── lib.rs                  # Core types: State, Action, Vote
│   ├── state.rs                # State tree implementation
│   ├── action.rs               # Action processing
│   ├── consensus.rs            # Consensus abstraction
│   ├── versioned.rs            # DAG/forking support
│   ├── executor/
│   │   ├── mod.rs              # CodeExecutor trait
│   │   ├── wasm.rs             # WASM implementation
│   │   └── simple.rs           # Simple interpreter (testing)
│   └── network/
│       ├── mod.rs              # Network trait
│       └── gossip.rs           # Gossip implementation
├── tests/
│   ├── CONFORMANCE.md          # Test specifications
│   ├── conformance/
│   │   ├── sm_self_modification.rs
│   │   ├── se_state_exposure.rs
│   │   ├── ta_transparency.rs
│   │   ├── dt_dynamic_trust.rs
│   │   ├── vs_versioned_state.rs
│   │   ├── cg_consensus.rs
│   │   ├── rb_robustness.rs
│   │   └── sp_simplicity.rs
│   └── common/
│       └── mod.rs              # Test utilities
├── bootstrap/
│   ├── genesis.rs              # Genesis state generator
│   └── actions/                # Core action source code
│       ├── create_entity.rs
│       ├── set_value.rs
│       ├── delete_value.rs
│       ├── delegate.rs
│       └── liquid_democracy.rs
└── bin/
    ├── ezvote-node.rs          # Full node
    └── ezvote-cli.rs           # CLI client
```

---

## Implementation Milestones

### Milestone 1: Core Types
- [ ] `State` with get/set/delete/enumerate/hash
- [ ] `Action` and `Vote` types
- [ ] Signature verification
- [ ] Content-addressed storage
- [ ] **Tests:** SE-01, SE-02, SE-04

### Milestone 2: Action Processing
- [ ] Action validation
- [ ] Simple code executor
- [ ] Mutation application
- [ ] History recording
- [ ] **Tests:** TA-01, TA-02, TA-03, TA-04, TA-05, TA-06

### Milestone 3: Versioning
- [ ] DAG structure for states
- [ ] Fork creation
- [ ] Historical state queries
- [ ] **Tests:** VS-01, VS-02, VS-03, VS-04

### Milestone 4: Consensus
- [ ] Consensus abstraction
- [ ] Liquid democracy implementation
- [ ] Delegation handling
- [ ] **Tests:** CG-01 through CG-07

### Milestone 5: Self-Modification
- [ ] Consensus mechanism as state
- [ ] Core actions as state
- [ ] No hardcoded logic
- [ ] **Tests:** SM-01, SM-02, SM-03, SM-04, DT-01, DT-02, DT-03

### Milestone 6: Networking
- [ ] Gossip protocol
- [ ] State synchronization
- [ ] Partition handling
- [ ] **Tests:** RB-01, RB-02, RB-03, RB-04, RB-05

### Milestone 7: Simplicity Audit
- [ ] Core < 10000 LOC
- [ ] < 5 core types
- [ ] Minimal genesis
- [ ] **Tests:** SP-01, SP-02, SP-03, SP-04

---

## Success Criteria

The implementation is complete when:

1. **All 36 conformance tests pass**
2. **Core is under 2000 lines of code**
3. **Another implementation can interoperate** (protocol, not implementation, compatibility)
4. **Genesis can be created from a simple config file**
5. **A non-technical user can understand the state tree**

---

## Open Design Questions

These should be resolved by running experiments, not by fiat:

1. **What bytecode format?** WASM vs custom. Run benchmarks on typical actions.

2. **What hash function?** BLAKE3 vs SHA-256. Check determinism across platforms.

3. **What serialization?** CBOR vs bincode. Test determinism, size, speed.

4. **How to handle spam?** Stake? Proof of work? Trusted introducer? Test under adversarial conditions.

5. **How to merge forks?** Automatic (longest chain)? Manual (meta-vote)? Experiment with both.
