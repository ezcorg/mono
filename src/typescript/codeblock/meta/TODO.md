- [x] While selecting the file input toolbar, pressing Esc should close the dropdown.
- [x] Include configuration for pre-filling the filesystem (and editor) with default tsconfig Typescript definitions for built-in types (String, Numper, Map<>, etc.) and resolves any specified overrides on the filesystem, should not pre-fill if files already exist, runs lazily when a Typescript file is first opened -- include this in the `pnpm dev` editor with some tests.
- [x] Ensure that the editor search index is updated when files are created dynamically at runtime
- [ ] Fix this error related to loading dynamic CSS language support:
```console
Failed to open file TypeError: error loading dynamically imported module: http://localhost:5175/node_modules/.vite/deps/@codemirror_lang-css.js?v=fbe08590
    css http://localhost:5175/@fs/home/theo/dev/mono/src/typescript/codeblock/dist/lsps/index.js:21
    getLanguageSupport http://localhost:5175/@fs/home/theo/dev/mono/src/typescript/codeblock/dist/lsps/index.js:139
    handleOpen http://localhost:5175/@fs/home/theo/dev/mono/src/typescript/codeblock/dist/editor.js:151
    update http://localhost:5175/@fs/home/theo/dev/mono/src/typescript/codeblock/dist/editor.js:204
    update http://localhost:5175/@fs/home/theo/dev/mono/src/typescript/codeblock/dist/editor.js:204
    update http://localhost:5175/node_modules/.vite/deps/chunk-ANG44IO3.js?v=fbe08590:2334
    updatePlugins http://localhost:5175/node_modules/.vite/deps/chunk-ANG44IO3.js?v=fbe08590:7077
    update http://localhost:5175/node_modules/.vite/deps/chunk-ANG44IO3.js?v=fbe08590:6980
    dispatchTransactions http://localhost:5175/node_modules/.vite/deps/chunk-ANG44IO3.js?v=fbe08590:6894
    dispatch http://localhost:5175/node_modules/.vite/deps/chunk-ANG44IO3.js?v=fbe08590:6916
    safeDispatch http://localhost:5175/@fs/home/theo/dev/mono/src/typescript/codeblock/dist/panels/toolbar.js:30
    safeDispatch http://localhost:5175/@fs/home/theo/dev/mono/src/typescript/codeblock/dist/panels/toolbar.js:28
    handleSearchResult http://localhost:5175/@fs/home/theo/dev/mono/src/typescript/codeblock/dist/panels/toolbar.js:320
    selectResult http://localhost:5175/@fs/home/theo/dev/mono/src/typescript/codeblock/dist/panels/toolbar.js:262
    toolbarPanel http://localhost:5175/@fs/home/theo/dev/mono/src/typescript/codeblock/dist/panels/toolbar.js:425
editor.js:185:21
```

- [ ] Update Playwright tests and configuration to validate expected editor functionality and behavior
  - [ ] For each supported language (focus on JS/TS for now, leave others unimplemented):
    - [ ] Verify code editor file operations work (creating new files, opening existing, renaming existing, making persistent changes, toolbar search index updates in response to new files being created)
    - [ ] Verify completions work: built-in types should autocomplete, methods on built-in types should autocomplete, etc.
    - [ ] Verify syntax highlighting works (test case with syntax errors) -- hovering the error should result in a tooltip
    - [ ] Verify semantic highlighting works (test case with semantic errors) -- hovering the error should result in a tooltip

In particular, find out why our LSP is giving us errors for built-in functions:
```
{
  "jsonrpc": "2.0",
  "method": "textDocument/publishDiagnostics",
  "params": {
    "uri": "file:///example.ts",
    "diagnostics": [
      {
        "range": {
          "start": {
            "line": 0,
            "character": 7
          },
          "end": {
            "line": 0,
            "character": 13
          }
        },
        "severity": 1,
        "source": "ts",
        "code": 2304,
        "message": "Cannot find name 'Number'.",
        "data": {
          "uri": "file:///example.ts",
          "version": 20,
          "pluginIndex": 0,
          "isFormat": false,
          "original": {},
          "documentUri": "file:///example.ts"
        }
      }
    ],
    "version": 35
  }
}
```

Given this file:
```example.ts
let a: Number = 0
```