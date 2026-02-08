# `witmproxy`

- [ ] Add note somewhere to its README that `witmproxy` requires nightly Rust for development, and plugin development requires `rustup target add wasm32-wasip2`
- [ ] Add note somewhere that `wkg` is required for updating/fetching `wit` files
- [ ] Ensure that `witm plugin add` can be used after the proxy is running (i.e, should likely make a request to the web service instead of starting a plugin registry with a connection to the embedded sqlite database)
- [ ] Configuration: plugins need to expose a way for users to configure them
- [ ] Create GitHub Action infrastructure to test `witmproxy` across a matrix of build targets (Windows/macOS/Ubuntu/etc.)
- [ ] Look at base options passed to `witm` CLI, do they make sense to always be available (i.e, apply to all commands), or should some of them be refactored to only apply to certain command invocations?
- [ ] Add a `cron()` method to CEL which determines whether or not a given cron expression (which may include one or many individual cron expressions) matches for this plugins `handle()` invocation
- [ ] A clock `capability-kind` (wasi:clocks) to allow plugins to request current system time
~~- [ ] Add an imprecise (minute resolution) event timestamp to all CEL context which can be referenced in CEL expressions (for example: "runs and blocks requests to YouTube during weekday business hours and before bed/early morning")~~

## Bigger tasks
- [ ] `[at some future point when wit/wasmtime allows it]` Consider getting rid of CEL string expressions in favor of a function callback which evaluates whether a capability applies to a given context
- [ ] Platform-specific secret handling of sensitive credentials (database password) that is compatible with the `witmproxy` daemon
- [ ] Add a layer on-top of `witmproxy` to allow it to spawn a backend which can be used as a complete network interface/device, so that we can capture and handle all network traffic (if this makes sense)
- [ ] Consider what architectural changes would be needed in order to allow something like the following: It would be convenient to deploy `witmproxy` to external hosts (which can be reached by a VPN/tunnel of some kind), and have multiple clients (like mobile phones, tablets, PCs, etc.) able to share the same instance. It should still be possible to remotely (and securely) manage the proxy. What are ways we could accomplish this? How could we change the CLI (should it operate more as a client)? In some ways, `tailscale` is a good model to follow for this kind of functionality/architecture.
- [ ] Consider whether it is possible to use WIT to express a system where plugins may register custom "capabilities" (interfaces?) that other plugins may request access to, and if it is possible, how that system would integrate into `witmproxy` (and what changes would be required)

# `ezfilter`

A cross-platform application which assumes `witmproxy` (which may be hosted locally or remotely) as a backend. `ezfilter` is primarily a front-end, built using either `dioxus` or Tauri, which provides a UI to both administer and observe the `witmproxy` backend, but also includes (and configures) several opinionated plugins:

* `@ezfilter/noshorts` - a plugin which prevents you from using reels in TikTok, Instagram, YouTube, Facebook, and ...
* `@ezfilter/noslop` - a plugin which uses hand-crafted heuristics, AI, and user-provided signals to filter addictive, manipulative, and low-quality content
* `@ezfilter/notrump` - a plugin which filters Trump related content
* `@ezfilter/moredogs` - a plugin which injects additional dogs into your browsing experience

- [ ] Think about the UI, what would you want to have?
  * Plugins, and some stats about them (execution count/duration/resource usage, i.e CPU, MEM, DISK, etc.)
  * An event log, showing a live stream of recent system events (and their outcome through an icon: green -> okay, red -> error, orange -> dropped, pale blue -> processing/pending)
  * Plugin creation tab (terminal to a WASM-based VM, optional file explorer, search bar)