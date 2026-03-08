
Unconfirmed if fixed:
- [ ] Changing the exports of a file, say writing `const foo = 1, export { foo }` in `test.ts`, and then `import { foo } from './test'` in `test2.ts`, results in a LSP error being emitted that `test.ts` does not export foo. Re-opening `test.ts`, and then `test2.ts`, fixes the issue. Investigate and fix this bug.

Needs to change:
- [ ] Tooltip box-shadow should not be blurry/fuzzy.
- [ ] Loading spinner isn't aligned with the search magnifying glass icon as line number digits increase (works for 1 digit with margin-left: 4px, but is misaligned with 2+ digit line numbers)

Need to plan and implement:
- [ ] It should be possible to execute certain files by clicking on a play button of some kind. `.ts`/`.js` files, for example, should run `npx tsx <currently-open-filepath>`. I'm unsure of how the API should look, but you can imagine it should function very similarly to VSCode's "run and debug"

Might be hard:
- [ ] Consider whether it should be possible to synchronize a Dropbox folder in the filesystem (bi-directionally)
- [ ] It should probably be possible to export the entire VFS as a (compressed?) archive
- [ ] Autocompletion functionality could likely help autofill valid local variables into method calls
- [ ] Autocompletion in Typescript seems to recommend syntactically valid items, but not semantically correct (recommended `case`, `continue`, `const`, `class` after typing `c` in a method call). Figure out if there's something we can do to improve this. In any given language, we should only make suggestions which are syntactically and semantically correct at a given position.
- [ ] Autocompletion in LSP does not provide `console`/`document`/`window` autocompletes (something missing from LSP VFS? an issue with the LSP itself?)

Maybe unnecessary:
- [ ] Don't support creation of anonymous/unnamed Markdown files (i.e ```ts ... ```, ```py ... ```) anymore, require that they reference a real file on disc. We should still be able to parse them, but when entered force the user to name the file.