
## Feature ideas

### Runtime user theming/overrides

A mechanism for users to change behavior/rendering/settings at runtime.

* `.codeblock/index.mjs`, a Javascript module which exports a single function which when called can be used to configure any `codeblock` instances which mount that filesystem
* `.markdown-editor/index.mjs`, the same as the above, but for `markdown-editor` instances
    * Supports declaring and registering JSX components which can be referenced in the editor