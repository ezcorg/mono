For some decisions and follow-ups:
* No opinion about the certificate format. Up to you, do a bit of research into existing formats and their drawbacks. Maybe look at OCapN's thoughts as well.
* Live mode opt-in with `@automerge/prosemirror` sounds fine for now.
* What do you mean here by WASM plugins defaulting to the browser or host executor? I suppose my instinct would that it should be agnostic, or that the question matters more for where the desired capability is.
* Can you find some alternatives to CriticMarkup syntax for comments and threads? Anchoring by document URLs is sort of what I imagined myself aswell (the anchor used in "copy link to highlight" also allowing comments/etc. on ranges of text within the document).
* Also, heads up that there is `/Users/theo/dev/djt/crates/wrpc-transport-iroh` which I believe may cover the wrpc transport for iroh (though note entirely certain).

This document is full of great ideas, thanks!

Thoughts:
* Do we need CRDT's/is a CRDT the right abstraction? If we're assuming collaborative editing, what happens when agents edit other files at the same time? Typically, you're not really that interested on collaborating on a Markdown editor. Or, is the idea here that the collaboration _would_ occur entirely in the Markdown editor? An agent references a file (with any number of specific line ranges) in the editor itself, and any changes to the file within the editor is propagated to the filesystem?
* Originally, I think one version of my idea was that the Markdown editor would be the user-friendly way of safely duplicating files into a sandbox (CoW would have been the dream). Import the files that you need for your task from your host into the documents filesystem, which is attached to the agents sandbox. Are you imagining then that the agent would just operate on handles which give direct access to resources on the hosts machine? Would `icanhaz` be the layer that determines what the isolation mechanism looks like (it satisfies handles, which could be resolved to host resources directly, or to resources in a container, or a VM)? What would this look like to a user of the app?
* What would you say to the criticism that some of these ideas wouldn't belong within `@joinezco/markdown-editor` (even though it currently violates some of this itself), as they have more to do with a system that orchestrates features built around folders of Markdown documents? Would it make sense to offer them as optional plugins, which most people would use, but not necessarily assume that everyone using the library will want that functionality out of the box?
* Would it make sense for plugins which register their own page to have full access to the DOM within that page, but running as an iframe?
* In a collaborative document, how are capabilities granted and retained? What do peers see when they work on the same document if I've already granted specific permissions? Does the document only ever reference the capabilities the original author grants (which are used by peers as well)?


In the current Tauri project (within a greater monorepo):

* Fix whatever caused the following issue:
```
Search index build failed, starting empty:
"forbidden path: /Users/theo/Documents/eznote/.codeblock/index.json, maybe it is not allowed on the scope for `allow-exists` permission in your capability file"
```
Additionally, ensure that a missing or improperly configured index doesn't impact other filesystem navigation.
* Ensure that the necessary font that's used for icons is present in `eznote` (it seems to be missing).

Elsewhere:
* Analyze `@joinezco/markdown-editor` (`/Users/theo/dev/mono/src/typescript/markdown-editor`) and form a list of all the expected features we're currently missing from an open-source, transparent (just Markdown files and SQLite/similar), feature-complete Markdown editor (think Obsidian) that can reasonably be implemented using a local-first / p2p synchronization (iroh, webrtc, reticulum, whatever transport) mechanisms. To me, this includes things like:
    * AI/LLM integration (configurable inference backend of the users choosing)
    * Document comments (probably some format which specifies them inline in the Markdown, where comments may refer to multiple ranges within the document itself)
    * Math/Latex/every other visualization we're probably missing
    * A plugin framework: something capability-based which allows extending the UI (modifying existing pages, adding new ones, changing styles/themes/etc.), operating on editor events (and emitting new ones), access to editor APIs... whatever else.
Then, consider how the editor could interact with other projects we have (like `/Users/theo/dev/mono/src/apps/icanhaz`), and how we might use something like `WASIX` (or similar, if at all) to provide a WASM-based virtual machine for the computational backend, in a way which provides an inherently isolated sandbox requiring little effort or technical knowledge to implement. Think about how all of these components could interact, and what would be interesting use cases that they would unlock (particularly in terms of safe agentic development and collaboration).