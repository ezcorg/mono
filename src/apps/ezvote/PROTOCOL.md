# ezvote Protocol Specification

A minimal protocol for programmable, self-modifying democratic systems.

---

## 1. Desiderata

The protocol must satisfy these properties. Each property has associated tests that any conforming implementation must pass.

### 1.1 Complete Self-Modification

The system must be capable of modifying any aspect of itself, including:
- The consensus mechanism
- The state transition rules
- The entity/identity model
- This specification itself

Even if such modification breaks the system entirely.

**Implication:** There is no "kernel" or "privileged" code. Everything is subject to change via the same mechanism.

### 1.2 Total State Exposure

All system state must be:
- Enumerable (you can list everything that exists)
- Readable (you can inspect any value)
- Addressable (every piece of state has a unique path)

All valid actions must be:
- Discoverable (you can ask "what can I do?")
- Inspectable (you can see the action's definition)

**Implication:** No hidden state. No undocumented capabilities.

### 1.3 Transparency and Auditability

Every action must be:
- Attributed to a known entity (who did it)
- Timestamped (when it was proposed/executed)
- Signed (cryptographically bound to the actor)
- Logged (permanently recorded)
- Replayable (given the log, reconstruct any past state)

**Implication:** The system is a deterministic state machine. Given genesis + log, you get current state.

### 1.4 Dynamic Trust

The system must not assume:
- Any particular entity exists or is trusted
- Any particular structure is permanent
- Any hardcoded parameters

Trust is computed from state, not assumed.

**Implication:** Even the initial "bootstrap" entities can be removed if consensus allows.

### 1.5 Versioned State (Forkability)

The system must support:
- Referring to any historical state by version/hash
- "Rolling back" by forking from a historical state
- Multiple concurrent forks (divergent timelines)

**Implication:** State is content-addressed. History is a DAG, not a line.

### 1.6 Consensus-Gated Actions

No state mutation occurs without consensus. The consensus mechanism itself is state that can be changed.

Initial priority: **Liquid Democracy** — entities can vote directly or delegate to others, delegation is transitive and revocable.

**Implication:** Even "administrative" actions go through consensus.

### 1.7 Robustness

The system should:
- Function with intermittent connectivity
- Tolerate arbitrary message delays
- Converge when partitions heal
- Not require global coordination for local reads

**Implication:** Eventual consistency with strong consistency for finalized state.

### 1.8 Simplicity

The core abstraction should be minimal:
- Few primitive concepts
- Composition over complexity
- Easy to implement, verify, and audit

**Implication:** If the spec is too long, it's wrong.

### 1.9 Protocol, Not Implementation

This document specifies behavior, not code. Any implementation that passes the conformance tests is valid.

---

## 2. Core Model

The system consists of exactly three primitives:

### 2.1 State

State is a tree of values, addressable by path.

```
State : Path -> Value | Undefined
Path  : List<String>
Value : Bytes
```

Examples:
- `/entities/abc123/public_key` → `<32 bytes>`
- `/consensus/mechanism` → `<hash of consensus code>`
- `/actions/vote/code` → `<bytecode>`

The entire state is content-addressed:
```
StateHash : Hash(serialize(State))
```

### 2.2 Action

An action is a proposal to transition state.

```
Action {
  id         : Hash          // Content hash of this action
  author     : EntityId      // Who is proposing
  parents    : List<Hash>    // Previous state(s) this builds on
  transition : Transition    // What change to make
  signature  : Signature     // Proof of authorship
  timestamp  : Timestamp     // When proposed
}

Transition {
  code   : Hash              // Hash of code to execute
  input  : Bytes             // Input to the code
}
```

An action is valid iff:
1. `author` exists in parent state
2. `signature` is valid for `author`'s public key
3. `code` exists in parent state
4. Execution of `code(input, parent_state)` succeeds

### 2.3 Consensus

Consensus determines which actions are accepted.

```
Consensus : (State, Action, Set<Vote>) -> Accept | Reject | Pending

Vote {
  action  : Hash        // Which action
  voter   : EntityId    // Who is voting
  value   : Accept | Reject
  weight  : Natural     // Computed from delegation
  sig     : Signature
}
```

The consensus mechanism itself is code stored in state at `/consensus/mechanism`.

---

## 3. Minimal Bootstrap State

The genesis state contains only what's needed to bootstrap:

```
/
├── entities/
│   └── genesis/
│       ├── public_key    : <genesis entity's public key>
│       └── tags/
│           └── root      : "true"
├── consensus/
│   └── mechanism         : <hash of initial consensus code>
├── actions/
│   ├── create_entity     : <hash of create_entity code>
│   ├── set_value         : <hash of set_value code>
│   ├── delete_value      : <hash of delete_value code>
│   └── delegate          : <hash of delegate code>
└── code/
    ├── <hash1>           : <bytecode for consensus>
    ├── <hash2>           : <bytecode for create_entity>
    ├── <hash3>           : <bytecode for set_value>
    ├── <hash4>           : <bytecode for delete_value>
    └── <hash5>           : <bytecode for delegate>
```

This is the absolute minimum. Everything else is built by actions.

---

## 4. Initial Consensus: Liquid Democracy

The bootstrap consensus mechanism implements liquid democracy:

```
liquid_democracy(state, action, votes) {
  // Get all entities
  entities = keys(state["/entities"])

  // Build delegation graph
  delegations = {}
  for entity in entities {
    delegate = state["/entities/{entity}/delegate"]
    if delegate != null {
      delegations[entity] = delegate
    }
  }

  // Compute voting power (follow delegation chains)
  power = {}
  for entity in entities {
    power[entity] = compute_power(entity, delegations, entities)
  }

  // Tally votes
  total_power = sum(power.values())
  accept_power = 0
  reject_power = 0

  for vote in votes {
    if vote.value == Accept {
      accept_power += power[vote.voter]
    } else {
      reject_power += power[vote.voter]
    }
  }

  // Simple majority of participating power
  if accept_power > reject_power && accept_power > 0 {
    return Accept
  } else if reject_power > accept_power {
    return Reject
  } else {
    return Pending
  }
}

compute_power(entity, delegations, all_entities) {
  // Count entities that delegate to this one (transitively)
  power = 1  // Own vote
  for other in all_entities {
    if follows_delegation_to(other, entity, delegations) {
      power += 1
    }
  }
  return power
}
```

This can be replaced by any other mechanism via consensus.

---

## 5. State Transition Semantics

When an action is accepted:

```
apply(state, action) {
  // 1. Verify preconditions
  assert exists(state, "/entities/{action.author}")
  assert verify_sig(action.signature, action.author, action)
  assert exists(state, "/code/{action.transition.code}")

  // 2. Load and execute transition code
  code = state["/code/{action.transition.code}"]

  // 3. Execute in sandbox with capabilities
  result = execute(code, {
    input: action.transition.input,
    state: readonly(state),  // Can read all state
    emit: []                 // Accumulates state changes
  })

  // 4. Apply emitted changes
  new_state = state
  for change in result.emit {
    match change {
      Set(path, value) => new_state[path] = value
      Delete(path)     => delete new_state[path]
    }
  }

  // 5. Record the action in history
  new_state["/history/{action.id}"] = serialize(action)

  // 6. Update state hash
  return (new_state, hash(new_state))
}
```

---

## 6. History and Forking

State forms a DAG:

```
     [Genesis]
         |
      [Action1]
         |
      [Action2]
        / \
  [Action3] [Action3']   <- Fork: two actions with same parent
       |        |
  [Action4] [Action4']
```

Each node is identified by its state hash. Forks are natural; they represent disagreement or experimentation.

To "rollback":
1. Identify the historical state hash you want
2. Create a new action with that state as parent
3. The fork continues from there

Merging forks requires a merge action that has multiple parents and reconciles conflicts.

---

## 7. Network Protocol

Nodes communicate via message passing. Messages are:

```
Message {
  type    : Announce | Request | Response
  payload : Action | Vote | StateQuery | StateResponse
  sender  : NodeId
  sig     : Signature
}
```

### 7.1 Announce

Broadcast new actions and votes to peers.

### 7.2 Request/Response

Query state or history from peers.

```
StateQuery {
  state_hash : Hash           // Which state version
  path       : Path           // What to read (or null for root)
  proof      : Boolean        // Include Merkle proof?
}

StateResponse {
  value : Value | Undefined
  proof : MerkleProof?
}
```

### 7.3 Consistency

- Actions are propagated via gossip
- Votes are propagated via gossip
- State is synchronized on-demand
- Nodes may have different views temporarily
- Finality is reached when consensus mechanism returns `Accept`

---

## 8. Conformance Tests

Any implementation must pass these tests to be conformant.

### Test 1: Self-Modification

```
GIVEN a running system with initial consensus mechanism
WHEN an action is proposed to replace /consensus/mechanism
AND the action achieves consensus
THEN the new consensus mechanism is used for subsequent actions
AND the old mechanism has no effect
```

### Test 2: State Enumeration

```
GIVEN any system state
WHEN enumerate_paths(state, "/") is called
THEN all paths in the state are returned
AND no paths are omitted
```

### Test 3: Action Discovery

```
GIVEN any system state
WHEN list_actions(state) is called
THEN all action types in /actions/* are returned
AND each action's code can be inspected
```

### Test 4: Auditability

```
GIVEN a system that has processed N actions
WHEN the action log is retrieved
THEN exactly N actions are in the log
AND each action has (author, timestamp, signature, transition)
AND replaying the log from genesis produces current state
```

### Test 5: Replay Determinism

```
GIVEN action log L1 producing state S1
AND action log L2 = L1 (identical)
WHEN L2 is replayed from genesis
THEN the resulting state S2 = S1 (identical hash)
```

### Test 6: No Hardcoded Trust

```
GIVEN a system with entities {A, B, C}
AND A has tag "root"
WHEN action to remove A's "root" tag achieves consensus
THEN A no longer has special privileges
AND subsequent actions treat A as any other entity
```

### Test 7: Historical State Access

```
GIVEN a system with state history [S0, S1, S2, S3]
WHEN query(S1, "/some/path") is called
THEN the value at that path in S1 is returned
AND S1 is not modified
```

### Test 8: Forking

```
GIVEN state S with hash H
WHEN action A1 is applied producing S1
AND action A2 (different from A1) is applied to S (same parent H)
THEN two valid states S1 and S2 exist
AND both are accessible
AND both reference H as parent
```

### Test 9: Liquid Democracy Delegation

```
GIVEN entities {A, B, C, D}
AND B delegates to A
AND C delegates to B
AND D delegates to C
WHEN A votes Accept on action X
THEN the effective voting power for Accept is 4 (A + B + C + D)
```

### Test 10: Delegation Revocation

```
GIVEN entity B delegates to A
WHEN B submits action to remove delegation
AND action achieves consensus
THEN B's votes are no longer counted toward A
AND B can vote independently
```

### Test 11: Partition Tolerance

```
GIVEN nodes {N1, N2, N3} in partition P1
AND nodes {N4, N5} in partition P2
WHEN actions are proposed in both partitions
THEN each partition makes local progress
AND when partition heals
THEN nodes converge to consistent state (possibly via fork resolution)
```

### Test 12: Code Inspection

```
GIVEN any code hash H referenced in state
WHEN get_code(H) is called
THEN the full bytecode is returned
AND the bytecode can be disassembled/inspected
```

### Test 13: Genesis Reproducibility

```
GIVEN genesis parameters P
WHEN two nodes independently initialize with P
THEN both produce identical genesis state hash
```

### Test 14: Signature Verification

```
GIVEN action A with signature S from entity E
WHEN verify_action(A) is called
THEN the signature is checked against E's public key in state
AND invalid signatures cause rejection
AND the entity cannot be spoofed
```

### Test 15: Consensus Replacement

```
GIVEN system using liquid_democracy consensus
WHEN action to change /consensus/mechanism to quadratic_voting achieves consensus
THEN subsequent actions use quadratic_voting
AND the transition is recorded in history
AND old liquid_democracy votes have no effect
```

---

## 9. Implementation Notes

These are suggestions, not requirements.

### 9.1 Code Execution

The protocol requires executing arbitrary code. Options:
- WASM (portable, sandboxed)
- Embedded interpreter (Lua, JavaScript)
- Native with sandboxing (Linux seccomp, etc.)

The code must be deterministic. Non-deterministic operations (random, time, I/O) are forbidden in transition code.

### 9.2 Content Addressing

State and code should be content-addressed (hash-linked). Suggested: BLAKE3 or SHA-256.

### 9.3 Serialization

State must be serializable deterministically. Suggested: canonical CBOR or similar.

### 9.4 Merkle Proofs

For efficient state verification, state should be stored as a Merkle tree (or similar authenticated data structure).

### 9.5 Networking

Any gossip protocol works. Suggested: libp2p, or simple TCP with peer discovery.

---

## 10. Non-Goals

The protocol explicitly does not specify:

- User interfaces
- Specific cryptographic algorithms (just "signatures" and "hashes")
- Performance requirements
- Storage format
- Wire protocol encoding

These are implementation and network choices.

---

## 11. Versioning

This is version `0.1.0` of the protocol.

Changes to the protocol itself can be proposed as actions within a running system (since the system is self-modifying). This document serves as the initial specification only.

---

## Appendix A: Pseudocode for Core Operations

### A.1 Create Entity

```
create_entity(input, state) {
  params = decode(input)  // { id, public_key, tags }

  // Check entity doesn't exist
  if exists(state, "/entities/{params.id}") {
    fail("entity already exists")
  }

  emit Set("/entities/{params.id}/public_key", params.public_key)
  for (key, value) in params.tags {
    emit Set("/entities/{params.id}/tags/{key}", value)
  }
}
```

### A.2 Set Value

```
set_value(input, state) {
  params = decode(input)  // { path, value }

  // Could add permission checks here based on state
  emit Set(params.path, params.value)
}
```

### A.3 Delegate

```
delegate(input, state) {
  params = decode(input)  // { from, to }

  // Verify 'from' is the action author (enforced by signature)
  // Verify 'to' exists
  if !exists(state, "/entities/{params.to}") {
    fail("delegate target does not exist")
  }

  emit Set("/entities/{params.from}/delegate", params.to)
}
```

### A.4 Undelegate

```
undelegate(input, state) {
  params = decode(input)  // { entity }

  emit Delete("/entities/{params.entity}/delegate")
}
```

### A.5 Register Code

```
register_code(input, state) {
  params = decode(input)  // { bytecode }

  hash = hash(params.bytecode)
  emit Set("/code/{hash}", params.bytecode)

  return hash
}
```

### A.6 Register Action Type

```
register_action(input, state) {
  params = decode(input)  // { name, code_hash }

  // Verify code exists
  if !exists(state, "/code/{params.code_hash}") {
    fail("code not found")
  }

  emit Set("/actions/{params.name}", params.code_hash)
}
```

---

## Appendix B: Example Action Flow

**Scenario:** Entity "alice" proposes to add entity "bob"

1. Alice constructs action:
   ```
   Action {
     id: hash(...)
     author: "alice"
     parents: [current_state_hash]
     transition: {
       code: hash_of_create_entity_code
       input: encode({ id: "bob", public_key: <bob's key>, tags: {} })
     }
     signature: sign(alice_private_key, ...)
     timestamp: now()
   }
   ```

2. Alice broadcasts action to network

3. Other entities see the action and vote:
   ```
   Vote { action: action.id, voter: "carol", value: Accept, ... }
   Vote { action: action.id, voter: "dave", value: Accept, ... }
   ```

4. When consensus is reached (e.g., majority accepts):
   - The action is applied
   - State now includes `/entities/bob/*`
   - Action is recorded in `/history/{action.id}`

5. New state hash is computed and becomes the new tip

---

## Appendix C: Test Implementation Skeleton

```python
# Conformance test framework (language-agnostic pseudocode)

class ConformanceTest:
    def setup(self):
        self.node = create_node(genesis_params())

    def test_self_modification(self):
        # Get current consensus mechanism
        old_mechanism = self.node.get("/consensus/mechanism")

        # Create new consensus code (e.g., always accept)
        new_code = compile("fn consensus(s,a,v) { Accept }")
        new_hash = self.node.register_code(new_code)

        # Propose changing consensus
        action = self.node.propose_action(
            code=hash_of_set_value,
            input=encode({ path: "/consensus/mechanism", value: new_hash })
        )

        # Achieve consensus under OLD mechanism
        self.node.vote(action.id, Accept, as_entity="genesis")
        self.node.wait_for_finality(action.id)

        # Verify new mechanism is active
        assert self.node.get("/consensus/mechanism") == new_hash

        # Verify new mechanism works (all actions auto-accepted)
        action2 = self.node.propose_action(...)
        # No votes needed
        self.node.wait_for_finality(action2.id)
        assert action2.status == Accepted

    def test_replay_determinism(self):
        # Perform some actions
        self.node.do_actions([...])
        state1 = self.node.state_hash()
        log = self.node.get_action_log()

        # Create fresh node and replay
        node2 = create_node(genesis_params())
        for action in log:
            node2.apply_action(action)

        state2 = node2.state_hash()
        assert state1 == state2

    # ... etc for all 15 tests
```
