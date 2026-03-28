`cicd` (src/rust/cicd):

- [ ] symlink produced CLI to some user binary directory
- [ ] replace 


`codeblock` (src/typescript/codeblock):
- [ ] Fix ctrl+c resulting in terminal newline output

- [ ] Include `git` functionality in the wanix VM (to be reworked into `witvm`?)
- [ ] Support for configurable keybindings for opening available commands
- [ ] Sharable links to codeblock line ranges as # anchors (should work even with multiple codeblocks on the same page) 
- [ ] Add an "Download file" option (for downloading the currently open file)
- [ ] And an "Export archive" option
- [ ] "Share p2p room" feature (use some webrtc p2p protocol)
- [ ] Show a clipboard icon in the first row in the editor
- [ ] Graph visualization for CSV files
- [ ] Maybe change how search text is used for querying files (partial internal matches seem to be ignored, for some reason, for ex. "exa" doesn't return example), with some dynamically adjusting (as some function of search index size) threshold for when query length is sufficiently long for partial match querying.
- [ ] Benchmark codeblock e2e performance using tests for 1 instance, 10 instances, all open to the same file, different files, some +1MB files open, and any other tests which seem like they'd be useful. Measure CPU+RAM+network utilization/etc. and save the data in OpenTelemetry format

- [ ] Make light mode code editor text coloring less ugly

`ezco-web` (src/apps/ezco-web):
- [ ] In the `markdown-editor` example, loading multiple files at once doesn't always seem to properly result in LSP based diagnostics highlighting working immediately (requires a file change to properly flush state? unsure).
- [ ] Include a lazy-loading Pokemon terminal example

`markdown-editor` (src/typescript/markdown-editor)
- [ ] The editor cursor flash rate is too slow (on Zen?)

`witmproxy` (src/apps/witmproxy)
- [ ] Modify WIT to include a `subprocess` capability. Develop the corresponding host implementation.
- [ ] When code is merged to main, we should be automatically producing versioned `witmproxy` binaries, which are then stored. When publishing, we should just have to reference these already built binaries. We shouldn't have to to build and test beforehand everytime.

- [ ] We should have test infrastructure for producing `plugin` components in tests more easily (rather than re-using statically declared and separately built `witmproxy-<xyz>` plugins)

`witmproxy-web`

- [ ] Fix awful AI generated copy
- [ ] Consider what to keep from the generated skeleton

`ezfilter`

- [ ] Automatically update installed plugin dependencies
- [ ] Managed infrastructure (confidential compute) offering
- [ ] 

`other`
- [ ] Look over app tests, some seem to be complete nonsense
- [ ] a witmproxy soundcloud plugin which allows playing specific sections of songs only

===

# `witmproxy`

## Simple

- [ ] Investigate whether it's currently possible to emit structured logs/traces with our existing logging infrastructure

## Medium

- [ ] Consider merging witmproxy/e2e with underlying library (under a flag) 

## Bigger tasks

- [ ] True e2e tests which dynamically bring up a remote `witmproxy` server, with various clients (emulated Android/iOS, desktop Chrome+Firefox+Safari+etc.) configured to use it as a remote proxy. Use `Appium` here. It should exercise the behavior to test that tenant-specific functionality works, and that the server updates in response to dynamic changes, with clients observing the expected changes. It should verify that plugins work as expected (and we should have sufficient test plugins to exercise the full surface of the available plugins API). We should expose test utilities as a separate crate (or module? whichever seems most idiomatic and is most efficient) such that plugin authors can orchestrate the same client tests if they desire. https://github.com/multicatch/appium-client provides an unofficial Rust appium client. When applicable, detect whether necessary host system binaries are present for called test functions, emitting warning!s if not.
- [ ] Consider different CLI APIs, like `witm start --server --client localhost` to bring up the proxy as a server and a local-user client, `witm stop --client` to stop the client (but leave the server), or something like `witm start --proxy --client localhost` to not assume that we always want the API server (would it make sense to have  a locally available API server but no proxy? if there's a client, I guess it would just forward requests, but without one it makes no sense)  
- [ ] Platform-specific secret handling of sensitive credentials (database password) that is compatible with the `witmproxy` service
- [ ] Add a layer on-top of `witmproxy` to allow it to spawn a backend which can be used as a complete network interface/device, so that we can capture and handle all network traffic (if this makes sense)
- [ ] Remove dependency on system binaries where possible (`certutil`, `cp`, `sh`, `sudo`, etc.), preferring native Rust interfaces or bundled binaries (with corresponding `bundled` features)
- [ ] Some sort of LLM-assisted interface/functionality for building request/response plugins.

- [ ] Consider whether it is possible to use WIT to express a system where plugins may register custom "capabilities" (interfaces?) that other plugins may request access to, and if it is possible, how that system would integrate into `witmproxy` (and what changes would be required)
- [ ] A code editor extension for syntax highlighting CEL expressions

# `ezfilter`

A cross-platform application which assumes `witmproxy` (which may be hosted locally or remotely) as a backend. `ezfilter` is primarily a front-end, built using either `dioxus` or `tauri`, which provides a UI to manage and observe the `witmproxy` backend, but also provides additional functionality and includes (and configures) several opinionated plugins:

* `noshorts` - a plugin which prevents you from viewing reels in TikTok, Instagram, YouTube, Facebook, ...
* `noslop` - a plugin which uses hand-crafted heuristics, AI, and user-provided signals to filter addictive, manipulative, and low-quality content
* `nofeeds` - a plugin which hides popular app feeds
* `nocomments` - a plugin to hide comment sections from webpages
* `notrump` - a plugin which filters Trump related content
* `moredogs` - a plugin which injects additional dogs into your browsing experience
* `focus` - a plugin which restricts your internet use to accomplishing set goals and avoiding distractions
* `schedule` - a plugin which allows you to schedule when other plugins run (and how) 

All `ezfilter` plugins must be open-source (as in you may view the unobfuscated client-side code which produced each binary in its whole) but they do not necessarily have to be free.

In some cases, plugins may require external compute and infrastructure to provide a feature. If you self-host all the resources required by a given plugin, you should be able to avoid paying for any resource usage they would incur.

In others, the plugin author may ask the user to make a one-time payment or subscription to help fund plugin development and on-going maintenance.

## What's your business model?

We charge for what it costs us to provide you our services (which includes a fair salary and some room for business development/R&D).

This let's us work on `ezfilter` (and `witmproxy`) sustainably, so that we can hopefully improve your internet experience for the better, long into the future.

Our company, [`ez co`](https://joinez.co), is a worker-owned _democratic collective_: every company decision comes to a vote, and every employee has an equal ballot (which they can delegate to someone else if they so choose). We hope that this structure keeps us honest and transparent, and helps us avoid the typical issues caused by static hierarachy and any misaligned incentives.

## Planning

- [ ] Think about the UI, what would you want to have?
  * Plugins, and some stats about them (execution count/duration/resource usage, i.e CPU, MEM, DISK, etc.)
  * An event log, showing a live stream of recent system events (and their outcome through an icon: green -> okay, red -> error, orange -> dropped, pale blue -> processing/pending)
  * Plugin creation tab (terminal to a WASM-based VM, optional file explorer, search bar, LLM-powered code editor)
- [ ] Plugin marketplace:
  * How do we support third-party plugin building? Should the primary interface be the `ezfilter` UI itself (interacting with our remote servers)? How do we make source code available? How do plugin security review? How much (if anything) do we charge third-party plugins?
    * Minimal plugin developer account fee: gives greater confidence of author authenticity (part of our security review), and helps us pay for the platform (which includes compute time and storage for building and hosting plugins+marketplace)
    * x% cut of earnings made through the marketplace (which are returned to plugin authors to balance our net profit goals)
    * Manual plugin review process (with automations to help)
- [ ] Payment infrastructure:
  * How do we allow payments in our system? Do we use Stripe? Do we accept stable coins?
  * How do we charge our users? What information do we retain (if any)?
