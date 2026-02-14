Imagine a simple WASM WIT interface for a WASM component whose purpose is to manage a democratic collective.

Initially, you want to support a method for starting "votes".

All votes have the same underlying structure:

```rs
// Any entity in the system has the following structure 
struct Entity {
    id: string, // guid of the entity
    publickey: string, // publickey of the entity (for signature verification)
    tags: map<string, string>, // system or user-defined tags associated with the entity
    owners: set<Entity>, // who manages this entity
}

// A Tally is a generic serializable and signed data structure that represents the current state of a vote.
// A Ballot is a filled Form response, signed by the voting entity.
struct Vote<Tally> {
    entity: Entity, // the entity representing the vote
    description: string, // human-readable description of the vote
    created_by: Entity, // identifier of the vote creator (which can be any entity)
    start_utime_ms: u64, // unix timestamp for when the vote starts
    finish_utime_ms: u64, // unix timestamp for when the vote ended
    form: Form, // the form associated with the vote
    requested_capabilities: set<Capability>, // capabilities requested for use during the vote
    on_start: func(capabilities: set<Capability>) -> (), // callback when the vote first starts
    on_finish: func(tally: Tally, capability: set<Capability>) -> (), // callback when the vote finishes
    on_response: func(ballot: Ballot<Self>, current: Tally, capabilities: set<Capability>) -> Tally,
}

struct Form {
    entries: list<FormEntry>,
}

struct FormEntry {
    prompt: string, // prompt associated with the inputs, typically a question, but can be any Markdown text
    inputs: list<FormInput>, // the inputs relating to the prompt
}

// each input should also have its own expected response type
enum FormInput {
    SingleChoice { options: list<string> },
    MultipleChoice { options: list<string> },
    Text { max_length: u32 },
    Number { min: i64, max: i64 },
    Date {},
}

// granted capabilities that can be used within callbacks
struct Capabilities {
    granted: set<Capability>,
    // ...
}

// Capabilities are an Entity + WASM component
// Requesting a capability requires majority approval from either the entity which created the capability, or from the collective
struct Capability {
    entity: Entity, // the entity that created the capability
    component: Component, // a reference to the WASM component implementing the capability
    // ...
}

struct Component {
    wasm: bytes, // the WASM bytecode, which includes any signatures
}
```

System capabilities:
* Entity management: create entities, manage ownership, sign data
* Capability management: CRUD capabilities