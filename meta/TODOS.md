# `witmproxy`

## Simple

- [ ] Add note somewhere to its README that `witmproxy` requires nightly Rust for development, and plugin development requires `rustup target add wasm32-wasip2`
- [ ] Add note somewhere that `wkg` is required for updating/fetching `wit` files
- [ ] Configuration: plugins need to expose a way for users to configure them (`.configure()` method in )
- [ ] Look at base options passed to `witm` CLI, do they make sense to always be available (i.e, apply to all commands), or should some of them be refactored to only apply to certain command invocations?
- [ ] Add a `time` object to CEL context which provides minimal convenience methods to control the time when a plugin should run (without leaking too much host information to the plugin):
  - [ ] `time.matches_cron(cron_string)` which accepts a string CRON expression, returning a boolean indicating whether it applies to the current system time
  - [ ] `time.is_day_of_week(weekday_int)` which accepts an integer 0-6 (sunday-monday) and returns a boolean indicating whether the current day matches
  - [ ] `time.is_between_hours(hour_start, hour_end)` which accepts two integers `hour_start` and `hour_end` where `hour_start` > `hour_end` and both are in the range [0,23], and returns whether the current time resides within the specified window

## Medium

- [x] Ensure that `witm plugin add` can be used after the proxy is running (i.e, should likely make a request to the web service instead of starting a plugin registry with a connection to the embedded sqlite database)
- [x] Create GitHub Action infrastructure to test `witmproxy` across a matrix of build targets (Windows/macOS/Ubuntu/etc.)
- [ ] A clock `capability-kind` (wasi:clocks) to allow plugins to request current system time

## Bigger tasks

- [ ] Platform-specific secret handling of sensitive credentials (database password) that is compatible with the `witmproxy` daemon
- [ ] Add a layer on-top of `witmproxy` to allow it to spawn a backend which can be used as a complete network interface/device, so that we can capture and handle all network traffic (if this makes sense)
- [ ] Consider what architectural changes would be needed in order to allow something like the following: It would be convenient to deploy `witmproxy` to external hosts (which can be reached by a VPN/tunnel of some kind), and have multiple clients (like mobile phones, tablets, PCs, etc.) able to share the same instance. It should still be possible to remotely (and securely) manage the proxy. What are ways we could accomplish this? How could we change the CLI (should it operate more as a client)? In some ways, `tailscale` is a good model to follow for this kind of functionality/architecture.
- [ ] Consider whether it is possible to use WIT to express a system where plugins may register custom "capabilities" (interfaces?) that other plugins may request access to, and if it is possible, how that system would integrate into `witmproxy` (and what changes would be required)
- [ ] A code editor extension for syntax highlighting capability CEL expressions

# `ezfilter`

A cross-platform application which assumes `witmproxy` (which may be hosted locally or remotely) as a backend. `ezfilter` is primarily a front-end, built using either `dioxus` or `tauri`, which provides a UI to manage and observe the `witmproxy` backend, but also provides additional functionality and includes (and configures) several opinionated plugins:

* `noshorts` - a plugin which prevents you from using reels in TikTok, Instagram, YouTube, Facebook, ...
* `noslop` - a plugin which uses hand-crafted heuristics, AI, and user-provided signals to filter addictive, manipulative, and low-quality content
* `nocomments` - a plugin to hide comment sections from webpages
* `notrump` - a plugin which filters Trump related content
* `moredogs` - a plugin which injects additional dogs into your browsing experience
* `focus` - a plugin which restricts your internet use to accomplishing set goals and avoiding distractions

All `ezfilter` plugins must be open-source (as in you may view the unobfuscated client-side code which produced each binary in its whole) but they do not necessarily have to be free.

In some cases, plugins may require external compute and infrastructure to provide a feature. If you self-host all the resources required by a given plugin, you should be able to avoid paying for any resource usage they would incur.

In others, the plugin author may ask the user to make a one-time payment or subscription to help fund plugin development and on-going maintenance.

## What's your business model?

We charge for what it costs us to provide you our services (which includes a fair salary and some room for business development/R&D).

This let's us work on `ezfilter` (and `witmproxy`) sustainably, so that we can hopefully improve your internet experience for the better long into the future.

Our company, [`ez co`](https://joinez.co), is a worker-owned _democratic collective_: every company decision comes to a vote, and every employee has an equal ballot (which they can delegate to someone else if they so choose). We hope that this structure keeps us honest and transparent, and helps us avoid the typical issues caused by static hierarachy and any misaligned incentives.

## Planning

- [ ] Think about the UI, what would you want to have?
  * Plugins, and some stats about them (execution count/duration/resource usage, i.e CPU, MEM, DISK, etc.)
  * An event log, showing a live stream of recent system events (and their outcome through an icon: green -> okay, red -> error, orange -> dropped, pale blue -> processing/pending)
  * Plugin creation tab (terminal to a WASM-based VM, optional file explorer, search bar, LLM-powered code editor)
- [ ] Plugin marketplace:
  * How do we support third-party plugin building? Should the primary interface be the `ezfilter` UI itself (interacting with our remote servers)? How do we make source code available? How do plugin security review? How much (if anything) do we charge third-party plugins?
    * Minimal plugin developer account fee: gives greater confidence of author authenticity (part of our security review), and helps us pay for the platform (which includes compute time and storage for building and hosting plugins+marketplace)
    * x% cut of earnings made through the marketplace (which we may return to plugin authors to balance our net profit goals)
    * Manual plugin review process (with automations to help)
- [ ] Payment infrastructure:
  * How do we allow payments in our system? Do we use Stripe? Do we accept stable coins?
  * How do we charge our users? What information do we retain (if any)?


In `src/apps/witmproxy/wit/world.wit`, can you finish refactoring the WIT interface to expose a `plugin` resource, which will have a constructor(`list<user-input>`) (accepting user-input for plugin configuration) and the existing `handle()` method? This is desired so that guest plugins may reference supplied configuration for execution. We will then need to update the current Rust host (`witmproxy`) WASM component usage, and add tests to ensure things function as expected (which involve updating current example guests with the new interface and APIs).