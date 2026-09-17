# Test fixtures

The `.wasm` files here are what the host tests load; each is built from the
crate of the same name beside it, and committed so the tests need no wasm
toolchain. `scripts/build-wasm.sh` (from `src/apps/icanhaz/`) rebuilds them
all, refreshing the daemon's WIT each crate vendors first, so a WIT change
cannot leave a fixture behind; CI runs it before the host tests. To rebuild
one by hand, from the crate's directory:

    cargo build --release --target wasm32-wasip2 --target-dir target
    cp target/wasm32-wasip2/release/<crate>.wasm ../<crate>.wasm

`--target-dir target` matters: a global cargo target directory would take
the artifact elsewhere. The crates are standalone workspaces (they are
wasm32-wasip2 guests) and each is a scaffold's output.

| Fixture | What it proves |
|---|---|
| `counter_demo` | a guest resource served over wRPC (a 3-method counter) |
| `fs_wrap` | a filesystem wrapper composed in front of the shipped capability; refuses paths naming `forbidden` |
| `greeter` | a novel capability with no imports, served from the store |
| `oracle` | a component building on inference through a delegated grant |
| `pipe` | a resource-shaped, streaming, async capability through the generic serving path |
| `reader` | a component reading files through a delegated filesystem grant (its store has no preopens) |
