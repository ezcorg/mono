# `witmproxy`

- [ ] Add note somewhere to its README that `witmproxy` requires nightly Rust for development, and plugins require `rustup target add wasm32-wasip2`
- [ ] Add note somewhere that `wkg` is required for updating/fetching `wit` files
- [ ] Ensure that `witm plugin add` can be used after the proxy is running (i.e, should likely make a request to the web service instead of starting a plugin registry with a connection to the embedded sqlite database)
- [ ] Create GitHub Action infrastructure to test `witmproxy` across a matrix of build targets (Windows/macOS/Ubuntu/etc.)
- [ ] Look at base options passed to `witm` CLI, do they make sense to always be available (i.e, apply to all commands), or should some of them be refactored to only apply to certain command invocations?

## Bigger tasks
- [ ] Add a layer on-top of `witmproxy` to allow it to spawn a backend which can be used as a complete network interface/device, so that we can capture and handle all network traffic (if this makes sense)
- [ ] Consider what architectural changes would be needed in order to allow something like the following: It would be convenient to deploy `witmproxy` to external hosts (which can be reached by a VPN of some kind), and have multiple clients (like mobile phones, tablets, PCs, etc.) able to share the same instance. It should still be possible to remotely (and securely) manage the proxy. What are ways we could accomplish this? How could we change the CLI (should it operate more as a client)? In some ways, `tailscale` is a good model to follow for this kind of functionality/architecture.
- [ ] Consider whether it is possible to use WIT to express a system where plugins may register custom "capabilities" (interfaces?) that other plugins may request to access, and if it is possible, how that system would integrate into `witmproxy` (and what changes would be required)