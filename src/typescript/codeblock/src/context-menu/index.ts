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
        // When a hover/diagnostic tooltip is right-clicked to use the NATIVE
        // menu, the menu opening fires a spurious `mouseleave` on the editor,
        // which CM's hover plugin reads as "pointer left" and uses to close the
        // tooltip — so the tooltip vanishes just as the native menu appears.
        // Set a one-shot flag on such a right-click and swallow that next
        // `mouseleave` so the tooltip stays open beneath the menu.
        let keepTooltipOpen = false;
        let keepTimer: ReturnType<typeof setTimeout> | undefined;
        const clearKeep = () => { keepTooltipOpen = false; if (keepTimer) clearTimeout(keepTimer); };

        function onContextMenu(e: MouseEvent) {
            // The editor context menu is for the *code*. Don't hijack
            // right-clicks on the search toolbar / its dropdown (`.cm-panels`,
            // `.cm-search-results`) or on hover/diagnostic tooltips
            // (`.cm-tooltip`) — those aren't code, and the menu's actions don't
            // apply. Leaving the event alone lets the native menu appear (e.g.
            // cut/copy/paste in the search input, or copy from a tooltip, which
            // is now selectable).
            const target = e.target as Element | null;
            if (target?.closest?.('.cm-panels, .cm-search-results, .cm-tooltip')) {
                if (target.closest('.cm-tooltip')) {
                    keepTooltipOpen = true;
                    if (keepTimer) clearTimeout(keepTimer);
                    keepTimer = setTimeout(clearKeep, 800);
                }
                return;
            }
            e.preventDefault();
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
            const ctx = buildMenuContext(view, pos);
            menu.open(view, items, ctx, e.clientX, e.clientY);
        }

        // Capture phase on `document` so this runs before CM's hover plugin
        // mouseleave handler (registered on the editor's own DOM); stopping
        // propagation there keeps it from hiding the tooltip.
        function onMouseLeaveCapture(e: Event) {
            if (keepTooltipOpen && e.target === view.dom) {
                clearKeep();
                e.stopPropagation();
            }
        }

        view.dom.addEventListener('contextmenu', onContextMenu);
        document.addEventListener('mouseleave', onMouseLeaveCapture, true);

        return {
            destroy() {
                view.dom.removeEventListener('contextmenu', onContextMenu);
                document.removeEventListener('mouseleave', onMouseLeaveCapture, true);
                if (keepTimer) clearTimeout(keepTimer);
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
