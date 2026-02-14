# ezvote Conformance Test Specification

These tests verify that an implementation satisfies the protocol properties.

---

## Test Categories

| Category | Property Verified |
|----------|-------------------|
| SM-* | Self-Modification |
| SE-* | State Exposure |
| TA-* | Transparency/Auditability |
| DT-* | Dynamic Trust |
| VS-* | Versioned State |
| CG-* | Consensus-Gated Actions |
| RB-* | Robustness |
| SP-* | Simplicity |

---

## SM: Self-Modification Tests

### SM-01: Replace Consensus Mechanism

**Property:** The system can replace its own consensus mechanism.

```
SETUP:
  - Genesis state with liquid_democracy consensus
  - Entities: [genesis] with full voting power

STEPS:
  1. Compile new consensus mechanism:
     always_accept(state, action, votes) { return Accept }

  2. Register the code:
     code_hash = register_code(always_accept_bytecode)

  3. Propose action to set /consensus/mechanism = code_hash

  4. Vote Accept as genesis entity

  5. Wait for finality

VERIFY:
  - /consensus/mechanism == code_hash
  - Subsequent action proposed with NO votes gets accepted
  - Old liquid_democracy has no effect
```

### SM-02: Replace Core Action Code

**Property:** Even "primitive" actions like create_entity can be replaced.

```
SETUP:
  - Genesis state with standard create_entity action

STEPS:
  1. Compile modified create_entity that adds tag "modified": "true" to all entities

  2. Register the code

  3. Propose action to set /actions/create_entity = new_code_hash

  4. Achieve consensus

  5. Create a new entity "test_entity"

VERIFY:
  - /entities/test_entity/tags/modified == "true"
```

### SM-03: Self-Destruction

**Property:** The system can break itself.

```
SETUP:
  - Running system with entities [A, B]

STEPS:
  1. Propose action to delete /consensus/mechanism

  2. Achieve consensus

VERIFY:
  - /consensus/mechanism is undefined
  - Subsequent actions cannot reach consensus (no mechanism)
  - System is effectively frozen
  - This is an acceptable outcome (system chose to break itself)
```

### SM-04: Modify Entity Model

**Property:** The entity structure itself can be changed.

```
SETUP:
  - Standard genesis

STEPS:
  1. Register code that adds new required field to entities: "reputation"

  2. Modify create_entity to require reputation field

  3. Create entity without reputation field

VERIFY:
  - Creation fails (new validation in effect)
  - Create entity with reputation field succeeds
```

---

## SE: State Exposure Tests

### SE-01: Enumerate All Paths

**Property:** All state is enumerable.

```
SETUP:
  - Genesis state
  - Create 3 additional entities
  - Set 5 arbitrary values at various paths

STEPS:
  1. Call enumerate_paths("/")

VERIFY:
  - Returns all entity paths
  - Returns all code paths
  - Returns all action paths
  - Returns /consensus/mechanism
  - Returns all custom set paths
  - No paths are missing
```

### SE-02: Read Any Value

**Property:** Any value in state is readable.

```
SETUP:
  - State with various values

FOR EACH path in enumerate_paths("/"):
  VERIFY:
    - get(path) returns a value or explicit undefined
    - No "access denied" or hidden values
```

### SE-03: Action Discovery

**Property:** Valid actions are discoverable.

```
SETUP:
  - Genesis state with standard actions

STEPS:
  1. List all keys under /actions/

  2. For each action name, retrieve /actions/{name}

  3. For each code hash, retrieve /code/{hash}

VERIFY:
  - All action names are returned
  - All code hashes resolve to bytecode
  - Bytecode can be disassembled (implementation-specific)
```

### SE-04: No Hidden State

**Property:** State hash covers ALL state.

```
SETUP:
  - State S1 with known values

STEPS:
  1. Compute state_hash(S1)

  2. Modify a "hidden" value (if implementation allows)

  3. Compute state_hash(S1')

VERIFY:
  - If any state changed, hash changed
  - There is no way to store data not reflected in hash
```

---

## TA: Transparency/Auditability Tests

### TA-01: Action Attribution

**Property:** Every action has a known author.

```
SETUP:
  - System with action log

FOR EACH action in get_action_log():
  VERIFY:
    - action.author is set
    - action.author exists (or existed) as entity
    - action.signature is valid for action.author
```

### TA-02: Action Timestamps

**Property:** Every action has a timestamp.

```
FOR EACH action in get_action_log():
  VERIFY:
    - action.timestamp is set
    - action.timestamp is reasonable (not in future, not ancient)
    - Actions are partially ordered by timestamp consistent with causality
```

### TA-03: Complete Log

**Property:** Action log is complete.

```
SETUP:
  - Fresh system
  - Perform exactly N actions

STEPS:
  1. Retrieve action log

VERIFY:
  - Log contains exactly N entries
  - Each action we performed is in the log
```

### TA-04: Replay Produces Identical State

**Property:** Replaying log from genesis produces current state.

```
SETUP:
  - System that has processed many actions
  - Record current state hash H1
  - Extract action log L

STEPS:
  1. Create fresh node from same genesis
  2. Replay each action in L
  3. Record resulting state hash H2

VERIFY:
  - H1 == H2
```

### TA-05: Signature Verification

**Property:** Invalid signatures are rejected.

```
SETUP:
  - Entity A with known keypair

STEPS:
  1. Create valid action from A
  2. Corrupt the signature (flip a bit)
  3. Submit action

VERIFY:
  - Action is rejected
  - Rejection reason mentions signature
```

### TA-06: Cannot Spoof Author

**Property:** Cannot submit action as another entity.

```
SETUP:
  - Entities A and B with different keypairs

STEPS:
  1. Create action with author=B
  2. Sign with A's private key
  3. Submit action

VERIFY:
  - Action is rejected
  - B's reputation/state unaffected
```

---

## DT: Dynamic Trust Tests

### DT-01: No Hardcoded Root

**Property:** "Root" entity can be demoted.

```
SETUP:
  - Genesis entity with tag root=true
  - Create entity B

STEPS:
  1. Propose action to remove genesis's root tag
  2. Have B vote (B needs voting power somehow first)
  3. Achieve consensus

VERIFY:
  - Genesis no longer has root tag
  - Genesis is treated as regular entity
```

### DT-02: Trust From State Only

**Property:** Entity privileges come only from state.

```
SETUP:
  - Entity A with tag admin=true
  - Entity B with no special tags

STEPS:
  1. Action requiring admin fails for B
  2. Remove A's admin tag
  3. Add admin tag to B
  4. Same action now succeeds for B, fails for A

VERIFY:
  - Privileges follow tags, not identity
```

### DT-03: Bootstrap Entities Removable

**Property:** Initial entities can be deleted.

```
SETUP:
  - Genesis with single entity

STEPS:
  1. Create new entity B
  2. Give B voting power (delegate or direct)
  3. Propose deletion of genesis entity
  4. B votes to accept
  5. Achieve consensus

VERIFY:
  - Genesis entity no longer exists
  - System continues to function with only B
```

---

## VS: Versioned State Tests

### VS-01: Historical State Access

**Property:** Can query past states.

```
SETUP:
  - Perform actions producing states [S0, S1, S2, S3]
  - Set /test/value = "v0" in S0
  - Set /test/value = "v1" in S1
  - Set /test/value = "v2" in S2
  - Delete /test/value in S3

STEPS:
  1. query(hash(S0), "/test/value")
  2. query(hash(S1), "/test/value")
  3. query(hash(S2), "/test/value")
  4. query(hash(S3), "/test/value")

VERIFY:
  - Returns "v0", "v1", "v2", undefined respectively
  - Historical states are not modified
```

### VS-02: Fork Creation

**Property:** Can create divergent forks.

```
SETUP:
  - State S with hash H

STEPS:
  1. Create action A1 with parent H, sets /x = 1
  2. Create action A2 with parent H, sets /x = 2
  3. Apply A1 producing S1
  4. Apply A2 producing S2

VERIFY:
  - Both S1 and S2 exist
  - S1[/x] == 1
  - S2[/x] == 2
  - Both reference H as parent
```

### VS-03: Rollback via Fork

**Property:** Can "rollback" by forking from past.

```
SETUP:
  - States [S0, S1, S2] where S2 has "bad" changes

STEPS:
  1. Create action with parent = hash(S1) (not S2)
  2. Apply action producing S3

VERIFY:
  - S3 branches from S1, not S2
  - S3 does not contain S2's changes
  - S2 still exists (not deleted)
```

### VS-04: State Hash Stability

**Property:** Same state always produces same hash.

```
SETUP:
  - Create state with specific values

STEPS:
  1. Compute hash H1
  2. Serialize state, deserialize
  3. Compute hash H2

VERIFY:
  - H1 == H2
```

---

## CG: Consensus-Gated Actions Tests

### CG-01: No Action Without Consensus

**Property:** State doesn't change without consensus.

```
SETUP:
  - Running system

STEPS:
  1. Propose action
  2. Do NOT vote
  3. Wait

VERIFY:
  - Action remains pending
  - State unchanged
  - No timeout auto-accept
```

### CG-02: Liquid Democracy Basic

**Property:** Direct votes work.

```
SETUP:
  - Entities [A, B, C] with equal weight, no delegation

STEPS:
  1. Propose action X
  2. A votes Accept
  3. B votes Accept
  4. C votes Reject

VERIFY:
  - Action accepted (2 > 1)
```

### CG-03: Liquid Democracy Delegation

**Property:** Delegation transfers voting power.

```
SETUP:
  - Entities [A, B, C, D]
  - B delegates to A
  - C delegates to B (transitive to A)
  - D has no delegation

STEPS:
  1. Propose action X
  2. A votes Accept (power = 3: A + B + C)
  3. D votes Reject (power = 1)

VERIFY:
  - Action accepted (3 > 1)
```

### CG-04: Delegation Override

**Property:** Direct vote overrides delegation.

```
SETUP:
  - B delegates to A

STEPS:
  1. Propose action X
  2. A votes Accept
  3. B votes Reject (overrides delegation)

VERIFY:
  - A's power = 1 (just A)
  - B's power = 1 (just B)
  - Tie or depends on other voters
```

### CG-05: Delegation Revocation

**Property:** Delegation can be revoked.

```
SETUP:
  - B delegates to A

STEPS:
  1. B revokes delegation
  2. Propose action X
  3. A votes Accept

VERIFY:
  - A's power = 1 (only A)
  - B can vote independently
```

### CG-06: Circular Delegation

**Property:** Circular delegation is handled.

```
SETUP:
  - A delegates to B
  - B delegates to C
  - C delegates to A (cycle)

STEPS:
  1. Propose action X
  2. None of A, B, C vote directly

VERIFY:
  - No infinite loop
  - Power is computed reasonably (e.g., each has power 1, or combined power 3 goes to... someone)
  - System doesn't crash
```

### CG-07: Consensus Mechanism Change

**Property:** Changed mechanism takes effect.

```
SETUP:
  - Liquid democracy with entities [A, B, C]

STEPS:
  1. Change consensus to "supermajority" (requires 2/3)
  2. Propose action Y
  3. A votes Accept (1/3)
  4. B votes Accept (2/3)

VERIFY:
  - After step 3: pending (only 1/3)
  - After step 4: accepted (2/3 reached)
```

---

## RB: Robustness Tests

### RB-01: Partition Tolerance

**Property:** Partitions make independent progress.

```
SETUP:
  - Nodes [N1, N2, N3] in partition P1
  - Nodes [N4, N5] in partition P2
  - Entities distributed across both

STEPS:
  1. Sever network between P1 and P2
  2. Propose and vote on action A in P1
  3. Propose and vote on action B in P2
  4. Wait for each partition to finalize locally

VERIFY:
  - P1 nodes agree on state including A
  - P2 nodes agree on state including B
  - Neither partition crashed
```

### RB-02: Partition Healing

**Property:** Partitions converge when healed.

```
SETUP:
  - Same as RB-01, partitions have diverged

STEPS:
  1. Restore network connectivity
  2. Wait for synchronization

VERIFY:
  - All nodes eventually agree on state
  - State includes both A and B (or explicit fork)
  - No actions lost
```

### RB-03: Message Delay

**Property:** Delayed messages don't break consensus.

```
SETUP:
  - Network with artificial delays (up to 30s)

STEPS:
  1. Propose action
  2. Votes trickle in slowly

VERIFY:
  - Action eventually reaches consensus
  - No timeouts cause incorrect state
```

### RB-04: Message Duplication

**Property:** Duplicate messages are idempotent.

```
STEPS:
  1. Propose action
  2. Send vote message 5 times (duplicates)

VERIFY:
  - Vote counted once
  - No double-counting
  - State consistent
```

### RB-05: Out-of-Order Messages

**Property:** Messages arriving out of order work.

```
STEPS:
  1. Propose action A (depends on nothing)
  2. Propose action B (depends on A)
  3. Deliver B before A to some nodes

VERIFY:
  - Nodes buffer B until A arrives
  - Or nodes request missing A
  - Final state consistent
```

---

## SP: Simplicity Tests

### SP-01: Core Concept Count

**Property:** The model has few primitives.

```
VERIFY:
  - Core types <= 5 (State, Action, Entity, Vote, Transition)
  - Core operations <= 10
  - No concept requires more than 1 paragraph to explain
```

### SP-02: Implementation Size

**Property:** Core logic is small.

```
VERIFY:
  - Core consensus logic < 500 lines
  - State management < 500 lines
  - Action processing < 500 lines
  - Total core < 2000 lines (excluding networking, storage, crypto primitives)
```

### SP-03: Genesis Simplicity

**Property:** Genesis state is minimal.

```
VERIFY:
  - Genesis has < 20 paths
  - Genesis can be written by hand
  - Genesis contains no redundant data
```

### SP-04: Composition Works

**Property:** Complex behavior emerges from simple primitives.

```
VERIFY:
  - Delegation is NOT a primitive (built from set_value)
  - Voting is NOT a primitive (built from actions + consensus)
  - Permissions are NOT a primitive (built from tags + code)
```

---

## Running the Tests

```bash
# Run all conformance tests
ezvote-test --conformance

# Run specific category
ezvote-test --conformance --filter "SM-*"

# Run single test
ezvote-test --conformance --filter "TA-04"

# Verbose output
ezvote-test --conformance -v

# Generate report
ezvote-test --conformance --report conformance-report.html
```

## Implementation Checklist

| Test | Status | Notes |
|------|--------|-------|
| SM-01 | | |
| SM-02 | | |
| SM-03 | | |
| SM-04 | | |
| SE-01 | | |
| SE-02 | | |
| SE-03 | | |
| SE-04 | | |
| TA-01 | | |
| TA-02 | | |
| TA-03 | | |
| TA-04 | | |
| TA-05 | | |
| TA-06 | | |
| DT-01 | | |
| DT-02 | | |
| DT-03 | | |
| VS-01 | | |
| VS-02 | | |
| VS-03 | | |
| VS-04 | | |
| CG-01 | | |
| CG-02 | | |
| CG-03 | | |
| CG-04 | | |
| CG-05 | | |
| CG-06 | | |
| CG-07 | | |
| RB-01 | | |
| RB-02 | | |
| RB-03 | | |
| RB-04 | | |
| RB-05 | | |
| SP-01 | | |
| SP-02 | | |
| SP-03 | | |
| SP-04 | | |
