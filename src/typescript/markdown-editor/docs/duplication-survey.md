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
- **Dependencies**: `react`, `react-dom` and `multimatch` are only the
  demo's and the Vite config's, so they are devDependencies now;
  `@tiptap/react`, `vite-plugin-node-polyfills` and
  `prosemirror-inputrules` were imported by nothing and are gone, as are
  `micromatch`, `jsdom` and `@types/tippy.js` (tippy ships its types) from
  devDependencies. `happy-dom` stays only as the config's named environment,
  which browser mode ignores.

## Left for discussion

Worth doing, each a contained refactor with tests around it:

1. **DOM helpers** (`ui/dom.ts`): `el(tag, class, text)` is written in four
   files and `make(cls)` in `index.ts`, with about a hundred bare
   `createElement` plus `className` pairs elsewhere; `button`/`glyph`
   (label or SVG, title and aria-label, `mousedown` preventDefault,
   `click` stopPropagation) is written six times under four names and the
   `mousedown` preventDefault alone at some 25 sites. One `el`, one
   `pressable(el, onPress)` and one `labelled(el, title)` would cover them.
2. *Popovers: done, above.*
3. **Suggestion menus**: the slash menu, the emoji picker's typed trigger
   and the `[[` note menu each hand-roll "trigger character, range, tippy,
   arrow keys", and the slash and wikilink menus build identical rows and
   empty states. One `ui/suggestion-menu.ts` would hold them.
4. **Mount resolution**: five copies resolve a `Mount`; they disagree on
   what a function returning nothing means (`toolbar.ts` and
   `links-panel.ts`: "mounted it itself"; the others: "no mount"). A
   shared `resolveMount` must pick one meaning, so this is a behaviour
   decision, not only a merge.
5. **rAF throttling**: six "schedule a layout pass" copies with their
   cancel-on-destroy; a `rafThrottle(fn)` returning `{ schedule, cancel }`.
   Likewise the `ResizeObserver` presence guard (six sites) and the
   fixed-overlay "follow the page on scroll and resize" pair
   (`comment-sheet.ts`, `comment-margin.ts`), and the sheet and the
   overlaid panel's wake/rest/away logic with `REST_AFTER` in both.
6. *markdown-it setup: done, above.*
7. **The persistence cast**: `(editor.storage as any).persistence` at about
   25 sites in 14 files, and the open note's path derived from it in seven
   places (two functions both named `openPath`). A module augmentation of
   Tiptap's `Storage` for `persistence`, or a `persistenceOf(editor)` and
   `openNotePath(editor)` pair in `filesystem.ts`.
8. **Bylines**: `@author` or the bare name is formatted in four places;
   export `byline` from `comment-render.ts` beside `when()`.
9. *Hand positioning: done, with the popovers above.*

## Libraries doing the same job

- Two glob matchers (`multimatch` used, `micromatch` not): the unused one
  is removed.
- Two test DOMs (`happy-dom` named, `jsdom` unused): the unused one is
  removed. Browser mode uses neither.
- ProseMirror twice (direct packages and `@tiptap/pm`): now once.
- Positioning twice (tippy and by hand): now once (item 9).
