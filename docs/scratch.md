# Scratch

# Projects
- `@eznode`: the cloud computing platform
- `@eznote`: the rich-text editor
- `@ezcode`: the code editor

## High-level implementation plan

1. Create a rich-text editor which allows both writing notes using Markdown (rendered live), as well as writing code (with LSP-based features like semantic highlighting, smart autocomplete, etc.)
2. Add bring-your-own-LLM functionality to the above (with various interfaces)
3. Generate language-specific SDKs for code running in our environment, ex:

```ts
import { Database } from '@eznode/sdk'

// a database which only runs so long as it has connections
// and automatically scales (CPU, RAM, disk) based on utilization
const db = await Database.auto()

// a database which is created and runs until stopped
const db = await Database.static()

// which are all shorthands for something like
const db = await Database.new('mydb', {
  autoscale: true,
  type: 'postgres', // or 'mysql', 'sqlite', etc.
  memory: '2GB',
  cpu: '4',
  disk: '10GB',
  // other options...
})
```

or ...

```ts
import { Queue } from '@eznode/sdk'

// an automatically scaling queue consumer
const { recv } = await Queue.consumer('events', { autoscale: true })

for await (const event of recv()) {
  // process the event
}

// a queue producer
const { send } = await Queue.producer('events')

await send({ event: 'foo' })
```

... you can imagine the rest. These libraries abstract over the details of interacting with our APIs, and provide a really simple interface for developers to use.

4. Create a WASM-based server environment for running the above (code is compiled to WASM, a user-declared manifest determines what the code can access in their account)
5. Make sure LLM code-generation is aware of the above, and can generate code which uses the above SDKs

## TODO:
- [ ] Investigate potential existing WASM (and WASM-cloud/FaaS runtimes) and their trade-offs (https://wasmcloud.com/, https://scale.sh/)
- [ ] Investigate utilization of minimal WASM OS as compute environment for the VM https://wanix.run/
- [ ] Consider application/cloud infrastructure (and providers).
- [ ] Consider plans for funding (see what grants are available -- in Canada and abroad).
- [ ] Form a company/non-profit/co-op to manage the project

## Editor architecture high-level ideas:
- [ ] Each new post is associated with an empty WASM VM initially (but should be able to easily reference/fork state from an existing project)
- [ ] Throughout the notebook, code execution and block execution updates VM state
- [ ] alt+/ offers contextual dropdown based on where the cursor is and whats been selected (try out: pressing slash within existing text without prior escaping opens slash command dropdown)
- [ ] /slash commands function as expected (shortcuts for predefined and user-defined commands?)
- [ ] ```sh blocks which execute entire blocks or selected lines (these include a functional xtermjs terminal)

### Pages

1. Main page - an empty default template. It should be clean and practically empty, with subtle controls to allow exposing further information and settings.
2. `TODO`

## Helpful links

### `mdeditor`: React full-text editor component

(ideally this would be framework-agnostic)

* [`TipTap`](https://tiptap.dev/docs), wrapper around ProseMirror (gives some functionality for free, but not entirely sure if it wouldn't be better to just use ProseMirror on its own)
* [`ProseMirror`](https://prosemirror.net/), lightweight JS library for building rich-text editors.

### `codeblock`: Framework-agnostic code editor component
* [`CodeMirror`](https://codemirror.net/), lightweight JS library for building code editors.
* [`codemirror-languageserver`](https://github.com/marimo-team/codemirror-languageserver), extension to provide CM editor features through a LSP-client (forked by https://marimo.io/, needs help developing, open to contributions, have contributed in the past)
* [`memfs`](https://github.com/streamich/memfs) JS filesystem

### `<to be named>`: Cross-platform application combining the above
* [`tauri`](https://tauri.app/), Rust-based cross-platform app framework (uses WebView for rendering, may eventually target other platforms)

### Inspiration: projects in a similar space
* [`acreom`](https://github.com/acreom/app) open-source Obsidian alternative
* [`outline`](https://github.com/outline/outline) similar to the above, but closer to Notion
* [`onyx`](https://www.onyx.app/) open-source LLM driven knowledge base


### WASM

* [Building a WebAssembly-first OS – An Adventure Into the Unorthodox - Dan Phillips, Loophole Labs](https://www.youtube.com/watch?v=mQ58pLT8YQ4)
* [A tool to convert Docker images to WebAssembly](https://github.com/container2wasm/container2wasm)
* [The WebAssembly component model](https://component-model.bytecodealliance.org/introduction.html)