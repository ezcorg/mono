use wasmtime::component::bindgen;

bindgen!({
    world: "plugin",
    path: "plugins/examples/minimal-wasi-plugin/wit",
});
