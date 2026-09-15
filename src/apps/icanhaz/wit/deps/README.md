
## ezco:ezcap

`ezco:ezcap@0.1.0` (the shared capability scope types) is not a registry
package: `wkg.toml` overrides it to the workspace path `src/rust/ezcap/wit`, and
`wkg wit fetch` copies it here like the WASI packages. Do not edit the copy;
edit `src/rust/ezcap/wit/ezcap.wit`.
