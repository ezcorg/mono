- [ ] Autocompletion functionality could likely help autofill valid local variables into method calls
- [ ] Autocompletion in Typescript seems to recommend syntactically valid items, but not semantically correct (recommended `case`, `continue`, `const`, `class` after typing `c` in a method call). Figure out if there's something we can do to improve this. In any given language, we should only make suggestions which are syntactically and semantically correct at a given position.
- [ ] Autocompletion in LSP does not provide `console`/`document`/`window` autocompletes (something missing from LSP VFS? an issue with the LSP itself?)

- [ ] Migrate the theme toggle from the footer to the far right (end) of the search toolbar
- [ ] In the search bar the "Import files/folder" option should always be visible (currently isn't visible when first clicking the search toolbar with a file already open)
- [ ] Pressing the down key in the search bar (when there's no dropdown open) should transition the cursor from the search bar to the code editor body
- [ ] Change the resting search toolbar icon to be an appropriate search icon (i.e magnifying glass)
- [ ] Change the LSP server log icon to be the same icon as the icon for the mimetype of the currently open file
- [ ] For the import files/folder option, on Ubuntu Firefox it didn't seem possible for me to open a specific file, it imported an entire folder (even when I double-clicked one .txt specifically). If necessary, split into two separate options of "Import local file(s)" and "Import local folder(s)" (or whatever the browser actually allows)
- [ ] I'm not sure what the loading state icon is supposed to be, but it currently just renders like an unmoving semi-circle. It would be better if it were an animated spinner of some type. Ensure that it has a sensible minimum animation duration so that files which are already loaded don't cause it to flicker by loading too quickly
- [ ] Changing the base font size in the settings should impact the font size of all text in the codeblock (including the size of settings itself). If necessary, make style changes such that all font sizes are calculated relative to the base font size, so this can happen automatically.
- [ ] Add a boolean setting to the editor for toggling editor line-wrap
- [ ] When modifying text in the search toolbar, but then closing it without confirming any action, the search toolbar text contents should reset to the filepath of the currently open file

- [ ] Importing local file(s) changes the editor content, but does not sync the search toolbar text as the filepath (though it does properly reset after toggling the search bar)
- [ ] The search toolbar loading spinner point of rotation (origin) is incorrect (it seems to be offset from the center of the semi-circle)
- [ ] Changing the exports of a file, say writing `const foo = 1, export { foo }` in `test.ts`, and then `import { foo } from './test'` in `test2.ts`, results in a LSP error being emitted that `test.ts` does not export foo. Re-opening `test.ts`, and then `test2.ts`, fixes the issue. Investigate and fix this bug.

Might be hard:
- [ ] Consider whether it should be possible to synchronize a Dropbox folder in the filesystem (bi-directionally)
- [ ] It should probably be possible to export the entire VFS as a (compressed?) archive

Maybe unnecessary:
- [ ] Don't support creation of anonymous/unnamed Markdown files (i.e ```ts ... ```, ```py ... ```) anymore, require that they reference a real file on disc. We should still be able to parse them, but when entered force the user to name the file.