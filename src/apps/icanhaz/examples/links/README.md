# links

Backlinks for a vault of markdown notes, as an icanhaz capability: which
notes link to a note, which links point nowhere, and renaming a note with
every link to it rewritten. Authored the way any user would author a
capability, with `icanhaz capability new`; the daemon ships nothing for it.

It imports `icanhaz:nocap/filesystem` and reaches the vault only through the
filesystem grant a page lends it, so the index sees what the human approved
(the vault, or a subtree, read-only or not) and nothing else. A read-only
grant indexes but cannot rename. A clause on the `links` grant such as
`call.method != "rename"`, typed into the consent card's "add a limit" field,
is admitted against an environment generated from this component's own WIT,
so the daemon refuses the method before the component runs.

Build it and add it to a daemon:

```sh
cargo build --release --target wasm32-wasip2 --target-dir target
icanhaz capability add target/wasm32-wasip2/release/links.wasm
```

The editor demo (`web/src/mac-demo.ts`) shows the panel it drives: the notes
linking to the open one, the dangling links, and a rename. The host test
`the_links_example_indexes_a_vault_through_a_delegated_grant` and the
browser test `links.browser.test.ts` prove the three grants: read-only,
scoped, and read-write.
