/**
 * Navigation history — VS Code-like Go Back / Go Forward.
 *
 * Tracks cursor positions and file changes. When the user navigates
 * (e.g. Go to Definition, opening a different file, or moving the
 * cursor far enough), a history entry is recorded. The user can then
 * jump back and forward through their navigation trail.
 */
import { EditorView, ViewPlugin, ViewUpdate, keymap, Command } from "@codemirror/view";
import { openFileEffect, currentFileField } from "./editor";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

interface NavEntry {
    path: string | null;
    pos: number;
    /** The line number — used to detect "significant" cursor moves. */
    line: number;
}

// Minimum line distance to count as a navigation event
const MIN_LINE_DISTANCE = 10;
const MAX_HISTORY = 50;

// -------------------------------------------------------------------------
// View plugin — tracks cursor movement and file changes
// -------------------------------------------------------------------------

const navPlugin = ViewPlugin.define(view => {
    let lastLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    let lastPath: string | null = null;
    try { lastPath = view.state.field(currentFileField).path; } catch {}
    // Suppress recording when we're performing a nav back/forward
    let navigating = false;

    // Mutable back/forward stacks (mirrors the state field but needed
    // for imperative navigation that dispatches effects)
    let backStack: NavEntry[] = [];
    let forwardStack: NavEntry[] = [];

    function currentEntry(): NavEntry {
        let path: string | null = null;
        try { path = view.state.field(currentFileField).path; } catch {}
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head).number;
        return { path, pos: head, line };
    }

    function push(entry: NavEntry) {
        backStack.push(entry);
        if (backStack.length > MAX_HISTORY) backStack.shift();
        forwardStack = [];
    }

    return {
        update(u: ViewUpdate) {
            if (navigating) return;

            // Detect file change
            let curPath: string | null = null;
            try { curPath = u.state.field(currentFileField).path; } catch {}
            if (curPath !== lastPath && lastPath !== null) {
                push({ path: lastPath, pos: u.startState.selection.main.head, line: lastLine });
                lastPath = curPath;
                lastLine = u.state.doc.lineAt(u.state.selection.main.head).number;
                return;
            }
            lastPath = curPath;

            // Detect significant cursor jump (≥ MIN_LINE_DISTANCE lines)
            if (u.selectionSet) {
                const newLine = u.state.doc.lineAt(u.state.selection.main.head).number;
                if (Math.abs(newLine - lastLine) >= MIN_LINE_DISTANCE) {
                    // Check if this was a user-driven jump (definition, click, etc.)
                    const isUserNav = u.transactions.some(tr =>
                        tr.isUserEvent("select.definition") ||
                        tr.isUserEvent("select.pointer") ||
                        tr.isUserEvent("select.search")
                    );
                    if (isUserNav) {
                        push({ path: curPath, pos: u.startState.selection.main.head, line: lastLine });
                    }
                }
                lastLine = u.state.doc.lineAt(u.state.selection.main.head).number;
            }
        },

        goBack() {
            if (backStack.length === 0) return false;
            const entry = backStack.pop()!;
            forwardStack.push(currentEntry());
            navigating = true;
            try {
                if (entry.path && entry.path !== lastPath) {
                    view.dispatch({ effects: openFileEffect.of({ path: entry.path }) });
                    // After file loads, set cursor position
                    const waitAndJump = () => {
                        const state = view.state.field(currentFileField);
                        if (!state.loading && state.path === entry.path) {
                            const pos = Math.min(entry.pos, view.state.doc.length);
                            view.dispatch({
                                selection: { anchor: pos },
                                effects: EditorView.scrollIntoView(pos, { y: "center" }),
                            });
                            lastPath = entry.path;
                            lastLine = view.state.doc.lineAt(pos).number;
                            navigating = false;
                        } else {
                            setTimeout(waitAndJump, 30);
                        }
                    };
                    setTimeout(waitAndJump, 30);
                } else {
                    const pos = Math.min(entry.pos, view.state.doc.length);
                    view.dispatch({
                        selection: { anchor: pos },
                        effects: EditorView.scrollIntoView(pos, { y: "center" }),
                    });
                    lastLine = view.state.doc.lineAt(pos).number;
                    navigating = false;
                }
            } catch {
                navigating = false;
            }
            return true;
        },

        goForward() {
            if (forwardStack.length === 0) return false;
            const entry = forwardStack.pop()!;
            backStack.push(currentEntry());
            navigating = true;
            try {
                if (entry.path && entry.path !== lastPath) {
                    view.dispatch({ effects: openFileEffect.of({ path: entry.path }) });
                    const waitAndJump = () => {
                        const state = view.state.field(currentFileField);
                        if (!state.loading && state.path === entry.path) {
                            const pos = Math.min(entry.pos, view.state.doc.length);
                            view.dispatch({
                                selection: { anchor: pos },
                                effects: EditorView.scrollIntoView(pos, { y: "center" }),
                            });
                            lastPath = entry.path;
                            lastLine = view.state.doc.lineAt(pos).number;
                            navigating = false;
                        } else {
                            setTimeout(waitAndJump, 30);
                        }
                    };
                    setTimeout(waitAndJump, 30);
                } else {
                    const pos = Math.min(entry.pos, view.state.doc.length);
                    view.dispatch({
                        selection: { anchor: pos },
                        effects: EditorView.scrollIntoView(pos, { y: "center" }),
                    });
                    lastLine = view.state.doc.lineAt(pos).number;
                    navigating = false;
                }
            } catch {
                navigating = false;
            }
            return true;
        },

        get canGoBack() { return backStack.length > 0; },
        get canGoForward() { return forwardStack.length > 0; },
    };
});

// -------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------

export const goBack: Command = view => {
    const plugin = view.plugin(navPlugin);
    return plugin ? plugin.goBack() : false;
};

export const goForward: Command = view => {
    const plugin = view.plugin(navPlugin);
    return plugin ? plugin.goForward() : false;
};

export const canGoBack = (view: EditorView) => view.plugin(navPlugin)?.canGoBack ?? false;
export const canGoForward = (view: EditorView) => view.plugin(navPlugin)?.canGoForward ?? false;

// -------------------------------------------------------------------------
// Extension
// -------------------------------------------------------------------------

export const navigationKeymap = keymap.of([
    { key: "Alt-ArrowLeft", mac: "Ctrl-Minus", run: goBack, preventDefault: true },
    { key: "Alt-ArrowRight", mac: "Ctrl-Shift-Minus", run: goForward, preventDefault: true },
]);

export function navigationHistory() {
    return [navPlugin, navigationKeymap];
}
