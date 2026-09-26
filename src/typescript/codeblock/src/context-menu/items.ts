import type { EditorView } from "@codemirror/view";
import type { ServerCapabilities } from "vscode-languageserver-protocol";
import {
    jumpToDefinition, jumpToDeclaration,
    jumpToTypeDefinition, jumpToImplementation,
    findReferences, renameSymbol, formatDocument,
} from "@codemirror/lsp-client";
import { openSearchPanel } from "@codemirror/search";
import { openFileEffect, setRegionEffect, currentFileField, regionField } from "../editor";
const currentFileFieldRef = () => currentFileField;
const regionFieldRef = () => regionField;
import { formatLineRange, type LineRange } from "../utils/region";
import { selectAll, toggleComment } from "@codemirror/commands";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface MenuContext {
    view: EditorView;
    pos: number;
    hasSelection: boolean;
    hasLSP: boolean;
    serverCapabilities: ServerCapabilities | null;
    cursorOnIdentifier: boolean;
    hasDiagnosticsAtCursor: boolean;
    hasAI: boolean;
    /** The file the block shows, and which of its lines (null: all). */
    filePath: string | null;
    region: LineRange | null;
}

/** The selected lines, numbered as the file numbers them. */
function selectedLines(ctx: MenuContext): LineRange {
    const { from, to } = ctx.view.state.selection.main;
    const first = ctx.view.state.doc.lineAt(from).number;
    const last = ctx.view.state.doc.lineAt(to).number;
    const offset = ctx.region ? ctx.region.from - 1 : 0;
    return { from: first + offset, to: last + offset };
}

/** `src/a.ts#L3-L9`: the link a note's fence or embed takes. */
function lineLink(path: string, range: LineRange): string {
    return `${path}#${formatLineRange(range)}`;
}

export interface ContextMenuItem {
    label: string;
    shortcut?: string;
    icon?: string;
    available: (ctx: MenuContext) => boolean;
    disabled?: (ctx: MenuContext) => boolean;
    action: (view: EditorView) => void;
    group: 'navigation' | 'editing' | 'find' | 'clipboard' | 'ai';
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const mod = isMac ? '\u2318' : 'Ctrl';

function cap(ctx: MenuContext, key: keyof ServerCapabilities): boolean {
    return ctx.hasLSP && !!ctx.serverCapabilities?.[key];
}

// -------------------------------------------------------------------------
// Clipboard helpers — async API with execCommand fallback
// -------------------------------------------------------------------------

async function clipboardCut(view: EditorView) {
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const text = view.state.sliceDoc(sel.from, sel.to);
    try { await navigator.clipboard.writeText(text); } catch { document.execCommand('copy'); }
    view.dispatch({ changes: { from: sel.from, to: sel.to } });
}

async function clipboardCopy(view: EditorView) {
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const text = view.state.sliceDoc(sel.from, sel.to);
    try { await navigator.clipboard.writeText(text); } catch { document.execCommand('copy'); }
}

async function clipboardPaste(view: EditorView) {
    try {
        const text = await navigator.clipboard.readText();
        const sel = view.state.selection.main;
        view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: text },
            selection: { anchor: sel.from + text.length },
        });
    } catch {
        document.execCommand('paste');
    }
}

// -------------------------------------------------------------------------
// Menu item definitions
// -------------------------------------------------------------------------

export function buildMenuItems(): ContextMenuItem[] {
    return [
        // ---- Navigation ----
        {
            label: 'Go to Definition',
            shortcut: 'F12',
            group: 'navigation',
            available: ctx => cap(ctx, 'definitionProvider') && ctx.cursorOnIdentifier,
            action: v => jumpToDefinition(v),
        },
        {
            label: 'Go to Declaration',
            group: 'navigation',
            available: ctx => cap(ctx, 'declarationProvider') && ctx.cursorOnIdentifier,
            action: v => jumpToDeclaration(v),
        },
        {
            label: 'Go to Type Definition',
            group: 'navigation',
            available: ctx => cap(ctx, 'typeDefinitionProvider') && ctx.cursorOnIdentifier,
            action: v => jumpToTypeDefinition(v),
        },
        {
            label: 'Go to Implementations',
            group: 'navigation',
            available: ctx => cap(ctx, 'implementationProvider') && ctx.cursorOnIdentifier,
            action: v => jumpToImplementation(v),
        },
        {
            label: 'Go to References',
            shortcut: 'Shift+F12',
            group: 'navigation',
            available: ctx => cap(ctx, 'referencesProvider') && ctx.cursorOnIdentifier,
            action: v => findReferences(v),
        },

        // ---- Editing ----
        {
            label: 'Rename Symbol',
            shortcut: 'F2',
            group: 'editing',
            available: ctx => cap(ctx, 'renameProvider') && ctx.cursorOnIdentifier,
            action: v => renameSymbol(v),
        },
        {
            label: 'Format Document',
            shortcut: 'Shift+Alt+F',
            group: 'editing',
            available: ctx => cap(ctx, 'documentFormattingProvider'),
            action: v => formatDocument(v),
        },

        // ---- Find ----
        {
            label: 'Find',
            shortcut: `${mod}+F`,
            group: 'find',
            available: () => true,
            action: v => openSearchPanel(v),
        },
        {
            label: 'Select All',
            shortcut: `${mod}+A`,
            group: 'find',
            available: () => true,
            action: v => selectAll({ state: v.state, dispatch: tr => v.dispatch(tr) }),
        },
        {
            label: 'Toggle Comment',
            shortcut: `${mod}+/`,
            group: 'find',
            available: () => true,
            action: v => toggleComment({ state: v.state, dispatch: tr => v.dispatch(tr) }),
        },

        // ---- Clipboard ----
        {
            label: 'Cut',
            shortcut: `${mod}+X`,
            group: 'clipboard',
            available: () => true,
            disabled: ctx => !ctx.hasSelection,
            action: v => clipboardCut(v),
        },
        {
            label: 'Copy',
            shortcut: `${mod}+C`,
            group: 'clipboard',
            available: () => true,
            disabled: ctx => !ctx.hasSelection,
            action: v => clipboardCopy(v),
        },
        {
            label: 'Paste',
            shortcut: `${mod}+V`,
            group: 'clipboard',
            available: () => true,
            action: v => clipboardPaste(v),
        },

        // ---- Lines of a file ----
        {
            label: 'Copy link to lines',
            group: 'clipboard',
            available: ctx => !!ctx.filePath,
            action: async v => {
                const ctx = { view: v, region: null } as MenuContext;
                const fileState = v.state.field(currentFileFieldRef(), false);
                const path = fileState?.path;
                if (!path) return;
                ctx.region = v.state.field(regionFieldRef(), false) ?? null;
                const text = lineLink(path, selectedLines(ctx));
                try { await navigator.clipboard.writeText(text); } catch { /* the clipboard is not ours here */ }
            },
        },
        {
            label: 'Show only these lines',
            group: 'navigation',
            available: ctx => !!ctx.filePath,
            action: v => {
                const fileState = v.state.field(currentFileFieldRef(), false);
                const path = fileState?.path;
                if (!path) return;
                const region = v.state.field(regionFieldRef(), false) ?? null;
                const range = selectedLines({ view: v, region } as MenuContext);
                v.dispatch({ effects: [openFileEffect.of({ path }), setRegionEffect.of(range)] });
            },
        },
        {
            label: 'Show the whole file',
            group: 'navigation',
            available: ctx => !!ctx.filePath && !!ctx.region,
            action: v => {
                const fileState = v.state.field(currentFileFieldRef(), false);
                const path = fileState?.path;
                if (!path) return;
                v.dispatch({ effects: [openFileEffect.of({ path }), setRegionEffect.of(null)] });
            },
        },

        // ---- AI ----
        {
            label: 'Edit with AI',
            shortcut: `${mod}+L`,
            group: 'ai',
            available: ctx => ctx.hasAI,
            disabled: ctx => !ctx.hasSelection,
            action: _v => {
                // Trigger the same Ctrl+L keybinding that codemirror-ai listens for
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'l', code: 'KeyL',
                    ctrlKey: !isMac, metaKey: isMac,
                    bubbles: true,
                }));
            },
        },
    ];
}
