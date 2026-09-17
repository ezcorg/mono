# Test fixtures

The `.wasm` files here are what the host tests load; each is built from the
crate of the same name beside it, and committed so the tests need no wasm
toolchain. Rebuild one after changing its source (or the daemon's WIT it
vendors) with, from the crate's directory:

    cargo build --release --target wasm32-wasip2 --target-dir target
    cp target/wasm32-wasip2/release/<crate>.wasm ../<crate>.wasm

`--target-dir target` matters: a global cargo target directory would take
the artifact elsewhere. The crates are excluded from the mono workspace
(they are wasm32-wasip2 guests) and each is a scaffold's output, so a
vendored `wit/deps` is a snapshot of the daemon's WIT at build time.

| Fixture | What it proves |
|---|---|
| `counter_demo` | a guest resource served over wRPC (a 3-method counter) |
| `fs_wrap` | a filesystem wrapper composed in front of the shipped capability; refuses paths naming `forbidden` |
| `greeter` | a novel capability with no imports, served from the store |
| `oracle` | a component building on inference through a delegated grant |
| `pipe` | a resource-shaped, streaming, async capability through the generic serving path |
