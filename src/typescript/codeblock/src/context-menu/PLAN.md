# Right-Click Context Menu — Implementation Plan

## Overview

A CodeMirror 6 extension that intercepts `contextmenu` events on the editor
and displays a custom context menu with VS Code-like functionality.  All LSP
commands already exist in `@codemirror/lsp-client`; the menu is primarily a
UI layer that dispatches to them.

---

## Architecture

```
src/context-menu/
  index.ts          — public extension factory + re-exports
  menu.ts           — ContextMenu class (DOM, positioning, keyboard nav)
  items.ts          — menu item definitions, availability predicates
  styles.ts         — StyleModule for the menu (theme-aware CSS vars)
```

### Extension interface

```ts
import { contextMenu } from "./context-menu";

// Add to editor extensions:
contextMenu({
  // Optional: additional custom items injected by the host
  extraItems?: ContextMenuItem[],
  // Optional: override clipboard integration (for environments without
  // navigator.clipboard, e.g. iframes without permission)
  clipboard?: { copy(text: string): void; paste(): Promise<string> },
})
```

Returns a single `Extension` containing:
1. A `ViewPlugin` that installs the `contextmenu` event handler.
2. The `StyleModule` for menu styles.
3. A keymap for the context-menu trigger (`Shift-F10` / `Menu` key).

---

## Menu Items

Modeled after VS Code's right-click context menu. Items are divided into
groups separated by dividers. Each item declares an `available` predicate
that receives the current editor state + cursor context and returns whether
the item should appear.

### Group 1 — Navigation (requires LSP)

| Label                  | Shortcut         | Command                    | Available when              |
|------------------------|------------------|----------------------------|-----------------------------|
| Go to Definition       | F12              | `jumpToDefinition`         | LSP + cursor on identifier  |
| Go to Declaration      |                  | `jumpToDeclaration`        | LSP + `declarationProvider` |
| Go to Type Definition  |                  | `jumpToTypeDefinition`     | LSP + `typeDefinitionProvider` |
| Go to Implementations  |                  | `jumpToImplementation`     | LSP + `implementationProvider` |
| Go to References       | Shift+F12        | `findReferences`           | LSP + `referencesProvider`  |

### Group 2 — Editing (requires LSP)

| Label                  | Shortcut         | Command                    | Available when              |
|------------------------|------------------|----------------------------|-----------------------------|
| Rename Symbol          | F2               | `renameSymbol`             | LSP + `renameProvider`      |
| Format Document        | Shift+Alt+F      | `formatDocument`           | LSP + `formatting`          |
| Quick Fix...           | Ctrl+.           | Show code actions panel    | LSP + diagnostics at cursor |

### Group 3 — Selection & Find

| Label                  | Shortcut         | Command                    | Available when              |
|------------------------|------------------|----------------------------|-----------------------------|
| Find                   | Ctrl+F           | `openSearchPanel`          | Always                      |
| Find and Replace       | Ctrl+H           | `openSearchPanel` (replace)| Always                      |
| Select All             | Ctrl+A           | `selectAll`                | Always                      |
| Toggle Comment         | Ctrl+/           | `toggleComment`            | Always                      |

### Group 4 — Clipboard

| Label                  | Shortcut         | Command                    | Available when              |
|------------------------|------------------|----------------------------|-----------------------------|
| Cut                    | Ctrl+X           | Cut selection               | Has selection               |
| Copy                   | Ctrl+C           | Copy selection              | Has selection               |
| Paste                  | Ctrl+V           | Paste from clipboard        | Always                      |

### Group 5 — AI (optional)

| Label                  | Shortcut         | Command                    | Available when              |
|------------------------|------------------|----------------------------|-----------------------------|
| Edit with AI           | Ctrl+L           | Trigger AI inline edit      | `agentUrl` configured       |

### Group 6 — Peek (stretch goal)

| Label                  | Shortcut         | Command                    | Available when              |
|------------------------|------------------|----------------------------|-----------------------------|
| Peek Definition        | Alt+F12          | Inline definition preview   | LSP + definitionProvider    |
| Peek References        |                  | Inline references preview   | LSP + referencesProvider    |

> Peek requires an inline widget that embeds a read-only editor view at
> the cursor position. This can be implemented as a
> `Decoration.widget()` that creates a mini `EditorView` with the
> target file content. Lower priority — implement navigation first.

---

## Menu Item Type

```ts
interface ContextMenuItem {
  label: string;
  /** Keyboard shortcut hint shown right-aligned */
  shortcut?: string;
  /** Nerd font or emoji icon (optional, shown left of label) */
  icon?: string;
  /** Return false to hide this item from the menu */
  available: (ctx: MenuContext) => boolean;
  /** Return true to grey-out but still show the item */
  disabled?: (ctx: MenuContext) => boolean;
  /** Execute the action. Receives the view for dispatching. */
  action: (view: EditorView) => void;
  /** Group identifier — items in the same group are visually grouped */
  group: 'navigation' | 'editing' | 'find' | 'clipboard' | 'ai' | 'peek';
}

interface MenuContext {
  view: EditorView;
  /** The position in the document where the menu was triggered */
  pos: number;
  /** Whether text is selected */
  hasSelection: boolean;
  /** Whether an LSP plugin is active for this view */
  hasLSP: boolean;
  /** LSP server capabilities (to check which features are available) */
  serverCapabilities: lsp.ServerCapabilities | null;
  /** Whether the word under cursor is an identifier (heuristic) */
  cursorOnIdentifier: boolean;
  /** Whether diagnostics exist at the cursor position */
  hasDiagnosticsAtCursor: boolean;
  /** Whether an AI agent URL is configured */
  hasAI: boolean;
}
```

---

## DOM Structure & Positioning

```html
<div class="cm-context-menu">
  <div class="cm-context-menu-item">
    <span class="cm-context-menu-icon">{icon}</span>
    <span class="cm-context-menu-label">Go to Definition</span>
    <span class="cm-context-menu-shortcut">F12</span>
  </div>
  <div class="cm-context-menu-divider"></div>
  <!-- ... -->
</div>
```

**Positioning algorithm:**
1. Use the `contextmenu` event's `clientX`/`clientY`.
2. Measure menu dimensions after rendering (off-screen first).
3. Flip to the left if it would overflow the viewport right edge.
4. Flip upward if it would overflow the viewport bottom edge.
5. Clamp to stay within the editor's bounding rect.

---

## Keyboard Navigation

- **ArrowDown / ArrowUp** — move selection (skip dividers)
- **Enter** — execute selected item
- **Escape** — close menu
- **Home / End** — jump to first / last item
- **Type-ahead** — filter items by label prefix (optional, low priority)

Focus is trapped in the menu while open. Clicking outside or pressing
Escape closes it.

---

## Styling (theme-aware)

Use the same CSS custom properties as the toolbar/tooltip:

```css
.cm-context-menu {
  position: fixed;
  z-index: 300;
  background: var(--cm-tooltip-background);
  color: var(--cm-tooltip-color);
  border: 1px solid var(--cm-tooltip-border);
  border-radius: 4px;
  padding: 4px 0;
  font-family: var(--cm-font-family);
  font-size: var(--cm-font-size, 14px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  min-width: 200px;
  max-width: 320px;
}
.cm-context-menu-item {
  display: flex;
  align-items: center;
  padding: 2px 24px 2px 8px;
  cursor: pointer;
  gap: 8px;
}
.cm-context-menu-item:hover,
.cm-context-menu-item.selected {
  background: var(--cm-search-result-select-bg);
  color: var(--cm-search-result-color-selected);
}
.cm-context-menu-item.disabled {
  opacity: 0.5;
  cursor: default;
}
.cm-context-menu-shortcut {
  margin-left: auto;
  opacity: 0.6;
  font-size: 0.9em;
}
.cm-context-menu-divider {
  height: 1px;
  background: var(--cm-tooltip-border);
  margin: 4px 0;
  opacity: 0.3;
}
```

---

## Implementation Steps

### Phase 1 — Core menu infrastructure
1. Create `styles.ts` with `StyleModule` definitions (CSS above).
2. Create `menu.ts` — `ContextMenu` class:
   - Constructor takes `items: ContextMenuItem[]`
   - `open(view, x, y)` — build DOM, position, attach
   - `close()` — remove DOM, restore focus
   - Keyboard navigation handler
   - Click-outside handler
3. Create `items.ts` — all menu item definitions with `available` predicates.
4. Create `index.ts` — `contextMenu()` extension factory:
   - `ViewPlugin` that listens for `contextmenu`, builds `MenuContext`, filters
     items via `available`, instantiates `ContextMenu`.
   - Prevent default browser context menu.
   - Add `Shift-F10` keymap binding to trigger menu at cursor position.

### Phase 2 — Clipboard actions
5. Implement Cut/Copy/Paste using `navigator.clipboard` with fallback to
   `document.execCommand` for sandboxed iframes.

### Phase 3 — LSP integration
6. Import LSP commands from `@codemirror/lsp-client`:
   ```ts
   import {
     jumpToDefinition, jumpToDeclaration,
     jumpToTypeDefinition, jumpToImplementation,
     findReferences, renameSymbol, formatDocument,
   } from "@codemirror/lsp-client";
   ```
7. Build `MenuContext.serverCapabilities` by reading from `LSPPlugin.get(view)`.
8. Wire each navigation/editing item to its corresponding command.

### Phase 4 — AI integration
9. Add "Edit with AI" item gated on `settingsField.agentUrl`.
10. Trigger same flow as `Ctrl+L` (marimo-team/codemirror-ai).

### Phase 5 — Peek views (stretch)
11. Implement `PeekWidget` as a `Decoration.widget` that embeds a read-only
    `EditorView` showing the target location.
12. Wire to `Alt+F12` for peek definition.

---

## Integration with codeblock

In `editor.ts`, add to the `codeblock()` extensions array:

```ts
import { contextMenu } from "./context-menu";

// Inside codeblock():
contextMenu(),
```

No additional configuration needed — the extension auto-detects LSP
availability and AI settings from the editor state.

---

## Testing

- E2E: right-click triggers menu, items match expected availability
- E2E: clicking "Go to Definition" on a known symbol navigates correctly
- E2E: clipboard operations work (cut, copy, paste)
- E2E: keyboard navigation (arrows, enter, escape)
- Unit: `MenuContext` builder correctly identifies cursor-on-identifier
- Unit: positioning algorithm handles edge cases (viewport overflow)
