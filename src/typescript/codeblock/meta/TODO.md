- [ ] Autocompletion functionality could likely help autofill valid local variables into method calls
- [ ] Autocompletion in Typescript seems to recommend syntactically valid items, but not semantically correct (recommended `case`, `continue`, `const`, `class` after typing `c` in a method call). Figure out if there's something we can do to improve this. In any given language, we should only make suggestions which are syntactically and semantically correct at a given position.
- [ ] Provide a mechanism for importing a file/folder from the host within the code editor (should likely result in a corresponding picker dialog, and should be persisted to the filesystem) and include it in the search options
- [ ] Prioritize opening existing files (if any returned) over creating/renaming them in the search toolbar autocomplete
- [ ] Create a footer toolbar for the component (its height should be roughly equal to one code editor row), then inside (arranged start to end):
  - [ ] Add a simple light/dark/system toggle
  - [ ] Add a settings cog which allows changing code editor configuration
    - [ ] Theme
      - [ ] Font size
      - [ ] Colors
      - [ ] ...etc.
    - [ ] Autosave (enabled by default)
    - [ ] OpenAPI API-compatible agent URL (research what existing codemirror plugins exist for this)
    - [ ] Terminal (WASM `ghostty` build connected to a lazily loaded `wanix` host? -- leave as a stub for now)
    - [ ] Any others that seem relevant?
- [ ] Change the color of cm-search-results to black from their current light grey.
- [ ] Have an intermediate state/indicator for when file opening/saving/etc.
- [ ] Develop a plan for integrating nerdfonts (Ubuntu Mono? see: https://www.nerdfonts.com/#features) into the code editor
  - [ ] Replace existing file icons with the appropriate nerdfont icon.

- [ ] The theme toggle icon should be aligned horizontally with cm-toolbar-state-icon (currently, the toggle icon is more aligned to the right)
- [ ] The settings page overlay is not currently visible (it attaches to the top of the container, and extends off screen), it might be better to have settings act as a complete overlay to the editor
- [ ] Add footer toolbar icon for viewing log of language server output (limit the retained log size to a sensible configuration -- disable server output by default in settings)
- [ ] This error now occurs when clicking the toolbar:
```console
Module "node:path" has been externalized for browser compatibility. Cannot access "node:path.parse" in client code. See https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details. @m234_nerd-fonts_fs.js:13:19
Uncaught TypeError: import_node_path.parse is not a function
    fromPath http://localhost:5175/node_modules/.vite/deps/@m234_nerd-fonts_fs.js?v=804599b4:11265
    fromPath2 http://localhost:5175/node_modules/.vite/deps/@m234_nerd-fonts_fs.js?v=804599b4:11295
    getFileIcon http://localhost:5175/src/panels/toolbar.ts:37
    getLanguageIcon http://localhost:5175/src/panels/toolbar.ts:41
    createCommandResults http://localhost:5175/src/panels/toolbar.ts:51
    toolbarPanel http://localhost:5175/src/panels/toolbar.ts:286
    toolbarPanel http://localhost:5175/src/panels/toolbar.ts:280
    panels http://localhost:5175/node_modules/.vite/deps/chunk-LZZTHNIC.js?v=519efa79:9970
    <anonymous> http://localhost:5175/node_modules/.vite/deps/chunk-LZZTHNIC.js?v=519efa79:9970
    fromClass http://localhost:5175/node_modules/.vite/deps/chunk-LZZTHNIC.js?v=519efa79:1358
    update http://localhost:5175/node_modules/.vite/deps/chunk-LZZTHNIC.js?v=519efa79:1374
    _EditorView http://localhost:5175/node_modules/.vite/deps/chunk-LZZTHNIC.js?v=519efa79:7341
    createCodeblock http://localhost:5175/src/editor.ts:263
    <anonymous> http://localhost:5175/example.ts:41
@m234_nerd-fonts_fs.js:11265:79
```
- [ ] Don't support creation of anonymous/unnamed Markdown files (i.e ```ts ... ```, ```py ... ```) anymore, require that they reference a real file on disc. We should still be able to parse them, but when entered force the user to name the file.
- [ ] Consider whether it should be possible to synchronize a Dropbox folder in the filesystem (bi-directionally)
- [ ] 
