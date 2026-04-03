import { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";
import { LSPPlugin } from "@codemirror/lsp-client";
import { settingsField } from "../panels/settings";
import { ContextMenu } from "./menu";
import { buildMenuItems, type MenuContext, type ContextMenuItem } from "./items";

export type { ContextMenuItem, MenuContext } from "./items";

// -------------------------------------------------------------------------
// MenuContext builder
// -------------------------------------------------------------------------

function buildMenuContext(view: EditorView, pos: number): MenuContext {
    const sel = view.state.selection.main;
    const hasSelection = !sel.empty;

    // LSP
    const lspPlugin = LSPPlugin.get(view);
    const hasLSP = !!lspPlugin;
    const serverCapabilities = lspPlugin?.client.serverCapabilities ?? null;

    // Cursor on identifier heuristic: check if the character at pos is a word char
    let cursorOnIdentifier = false;
    if (pos >= 0 && pos <= view.state.doc.length) {
        const wordRange = view.state.wordAt(pos);
        cursorOnIdentifier = !!wordRange && wordRange.from < wordRange.to;
    }

    // Diagnostics at cursor
    let hasDiagnosticsAtCursor = false;
    forEachDiagnostic(view.state, (_d, from, to) => {
        if (pos >= from && pos <= to) hasDiagnosticsAtCursor = true;
    });

    // AI
    let hasAI = false;
    try { hasAI = !!view.state.field(settingsField).agentUrl; } catch { /* field not present */ }

    return {
        view,
        pos,
        hasSelection,
        hasLSP,
        serverCapabilities,
        cursorOnIdentifier,
        hasDiagnosticsAtCursor,
        hasAI,
    };
}

// -------------------------------------------------------------------------
// Extension factory
// -------------------------------------------------------------------------

export interface ContextMenuConfig {
    extraItems?: ContextMenuItem[];
}

export function contextMenu(config?: ContextMenuConfig): Extension {
    const menu = new ContextMenu();
    const items = buildMenuItems();
    if (config?.extraItems) items.push(...config.extraItems);

    const plugin = ViewPlugin.define(view => {
        function onContextMenu(e: MouseEvent) {
            e.preventDefault();
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
            const ctx = buildMenuContext(view, pos);
            menu.open(view, items, ctx, e.clientX, e.clientY);
        }

        view.dom.addEventListener('contextmenu', onContextMenu);

        return {
            destroy() {
                view.dom.removeEventListener('contextmenu', onContextMenu);
                menu.close();
            },
        };
    });

    const contextMenuKeymap = keymap.of([{
        key: 'Shift-F10',
        run(view) {
            const head = view.state.selection.main.head;
            const coords = view.coordsAtPos(head);
            if (!coords) return false;
            const ctx = buildMenuContext(view, head);
            menu.open(view, items, ctx, coords.left, coords.bottom);
            return true;
        },
    }]);

    return [plugin, contextMenuKeymap];
}
