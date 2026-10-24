# Duplication in the editor: what was shared, what remains

Surveyed 2026-10-12 over `src/lib/editor`. The free wins were taken in the
same pass (each covered by the suites named); the items listed for
discussion were then done on 2026-10-13, in the order below, each with the
suites around it and the demo looked at.

## Done

- **Icons**: `ui/icons.ts` holds `svg()`, `stroke` and the glyphs drawn in
  more than one place (× close, the document, the down chevron, the face).
  `comment-margin.ts`, `comment-sheet.ts` and `emoji-picker.ts` take them
  from there; the face was a byte-for-byte copy in two files.
- **Kept settings**: `ui/kept.ts` (`readKept`, `writeKept`) replaces eleven
  try/catch localStorage wrappers in `emoji-picker.ts`, `comment-render.ts`,
  `front-matter.ts` and `comment-margin.ts`.
- **Scrolling**: `ui/layout.ts` has the one `scrollerOf` (was `rail.ts`'s,
  still re-exported there), `scrollContainerOf` (with the page as the
  fallback, replacing two copies of `findScrollContainer` in `toolbar.ts`
  and `sidebar.ts` and an inline loop in `filesystem.ts`), and
  `isPageScroller` (five inline checks). One `Mount` type stands behind
  `BlockActionsMount`, `ToolbarMount`, `SidebarMount` and the margin's.
- **Reactions**: one `reactionGrid` (`emoji-picker.ts`) draws the grid at
  the top of a bubble's menu and in the popover under the React button;
  the two were different components with different widths.
- **Links**: `embed.ts` imports `attrsOf` and `optionalData` from
  `wikilink.ts` instead of its own copies; `filesystem.ts` uses
  `codeblock.ts`'s `isDarkMode` instead of its own `isDarkContext`;
  `comment-composer.ts` uses `comment-render.ts`'s `fallbackExtensions`
  instead of an inline copy.
- **A leak**: `slash-commands.ts` bound `selectionUpdate` freshly for each
  `on` and took the unbound method `off` in `destroy`, so its listeners
  outlived the menu. Bound once now.
- **ProseMirror**: `codeblock.ts` imported `prosemirror-history` and
  `prosemirror-commands` directly while everything else goes through
  `@tiptap/pm/*`; with two installs the code block's undo would look for a
  history plugin that is not there. It now imports through `@tiptap/pm`.
- **Popovers** (2026-10-13): `ui/popover.ts` holds the one `popover()`
  over tippy (body, manual, interactive, no duration, `preventOverflow`
  and `flip` with 8px of padding, the array return normalised, `rangeRect`
  and `caretRect` for a reference that is a stretch of text) and
  `menuPopover()` for the ContextMenu lifecycle (enable before show, focus
  on shown, disable on hide, destroy a tick later). The selection menu,
  the block menu, the comment menus, the reaction grid and emoji picker,
  the `:` and `/` triggers and the link popover use them, and the
  prose-action panel (item 9) is a popover too, so it flips above its text
  at the viewport's edge (measured in `prose-ai.test.ts`). One
  close-on-press-outside: `mousedown` on the document in the capture
  phase, armed a tick after opening, ignoring the popover, its reference
  and what the caller keeps. One change to notice: tippy's `onShown` never
  fired before (its CSS is not shipped, so no transition ended), and
  menus opened with focus left in the editor; now the first item takes
  focus, as `ContextMenu` always meant. The `[[` menu in `wikilink.ts` is
  the one copy left (its file was being edited for the markdown-it item
  at the time).
- **markdown-it setup** (2026-10-13): `extensions/markdown-it.ts` has
  `setupOnce(md, key, fn)` (one `Set` of keys on the parser in place of
  eleven `__ezcoX` flags; tiptap-markdown calls every `parse.setup` on
  every parse, so a setup that added its rules each time would stack them)
  and `eachToken(md, name, type, visit)` for the three core rules that
  walked the tokens. The seven `const esc = md.utils.escapeHtml` lines
  stay: `markdown-it` is tiptap-markdown's dependency, not importable
  here, and a one-line indirection would be no shorter.
- **DOM helpers** (2026-10-13): `ui/dom.ts` has `el(tag, class, text)`
  (typed by tag), `button(class, text)` (`type="button"`), `pressable(el,
  onPress)` (the press keeps the note's selection, the click stops where
  it is), `labelled(el, title)` (title and aria-label) and `glyph(icon,
  title, class, onPress)` over them. The four `el`s, `make`, the six
  press-builders and the margin's, sheet's, picker's, tree's, gutter's,
  rail's, indicator's and selection button's own builders are gone; the
  sites whose click must bubble on (the tree's tools, the rail's chevron,
  the links panel's rows, the prose panel's buttons, the overlay handle)
  keep their own listeners and say so. 80 `createElement` calls remain
  (was 125), 60 of them bare pairs in fifteen files not touched.
- **Bylines** (2026-10-13): `byline(by)` beside `when()` in
  `comment-render.ts`, at the card, the bubble head, the sheet's handle
  and title and the gutter mark.
- **Layout passes** (2026-10-13): `ui/layout.ts` has `rafThrottle(fn)`
  (one pending frame, `schedule` and `cancel` as closures), `sizeObserver`
  and `observeResize` (null-safe where `ResizeObserver` is missing),
  `followPage(fn)` (scroll in capture and resize, for a fixed overlay) and
  `restable(dom)` (the wake/rest/away of the sheet and the overlaid panel,
  one `REST_AFTER`). Six throttles, six guards, both follow pairs and both
  rest copies are on them.
- **Suggestion menus** (2026-10-13): `ui/suggestion-menu.ts` draws the
  rows and the empty line, keeps the selection in view, takes the keys
  (arrows that wrap, Enter, Tab where it chose, Escape) and opens under
  the typed text through the popover; the slash and `[[` menus delegate
  all of it and keep their triggers, filters and choices, the `:` trigger
  only the popover (its grid and two-way arrows serve the searching
  picker too). The `[[` menu closes on a press outside now, and stands
  under its brackets: referenced on `document.body`, it had opened off
  the page in the demo. Three identical tippy theme rules are one.
  `slash-commands.test.ts` (new) and a `[[` case in `wikilink.test.ts`
  drive both with real keys.
- **The persistence cast** (2026-10-13): `persistenceOf(editor)` and
  `openNotePath(editor)` in `extensions/filesystem.ts` (the two
  `openPath`s gone, the three sites that never normalised still read the
  path as it is). Fifteen files; no `(storage as any).persistence` left
  outside tests. The other storage casts (`comments`, `markdown`,
  `blockActions`, …) stay: each would want a helper of its own.
- **Mount resolution** (2026-10-13): `resolveMount(mount, root)` in
  `ui/layout.ts`, used by the toolbar, the links panel, the rail (so the
  outline and the file tree), the block actions and the margin. A mount
  function returning nothing means the default place, as the `Mount` type
  always said: the "mounted it itself" reading was never attainable (a
  mount function is given the editor's root, never the piece), and left
  the toolbar and links panel detached, and a rail panel in `body`.
- **Dependencies**: `react`, `react-dom` and `multimatch` are only the
  demo's and the Vite config's, so they are devDependencies now;
  `@tiptap/react`, `vite-plugin-node-polyfills` and
  `prosemirror-inputrules` were imported by nothing and are gone, as are
  `micromatch`, `jsdom` and `@types/tippy.js` (tippy ships its types) from
  devDependencies. `happy-dom` stays only as the config's named environment,
  which browser mode ignores.

## Left for discussion

Every item below was done on 2026-10-13 (see above); the list is kept as
the record of what was found. What remains is smaller and listed at the
end.

1. *DOM helpers: done, above.*
2. *Popovers: done, above.*
3. *Suggestion menus: done, above.*
4. *Mount resolution: done, above.*
5. *Layout passes: done, above.*
6. *markdown-it setup: done, above.*
7. *The persistence cast: done, above.*
8. *Bylines: done, above.*
9. *Hand positioning: done, with the popovers above.*

## Still duplicated, for a later pass

- 60 bare `createElement` + `className` pairs in fifteen files not
  touched by the DOM pass (`slash-commands`, `wikilink`, `embed`,
  `sidebar`, `ui/context-menu`, `ui/link-popover`, `callout`,
  `comment-composer`, `conflict-notice`, `footnote`, `front-matter`,
  `folding`, `image`, `filesystem`, `source-view`).
- The storage casts other than `persistence` (`comments`, `markdown`,
  `blockActions`, `settings`, `commentMargin`, …): each wants a helper of
  its own, as `settingsOf` and `persistenceOf` are.
- Seven `const esc = md.utils.escapeHtml` lines, and the
  `(tokens, idx) => tokens[idx]` renderer preamble, which a
  `renderers(md, …)` helper could take if the renderer signature may
  change.
- Test files still cast `(editor.storage as any).persistence` (30 sites).

## Libraries doing the same job

- Two glob matchers (`multimatch` used, `micromatch` not): the unused one
  is removed.
- Two test DOMs (`happy-dom` named, `jsdom` unused): the unused one is
  removed. Browser mode uses neither.
- ProseMirror twice (direct packages and `@tiptap/pm`): now once.
- Positioning twice (tippy and by hand): now once (item 9).
