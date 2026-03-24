import { EditorView, Panel, showPanel } from "@codemirror/view";
import { terminalCompartment, CodeblockFacet, terminalActiveEffect, terminalActiveField } from "../editor";
import { settingsField, resolveThemeDark } from "./settings";
import type { JswasiTerminalSession } from "../utils/jswasi-terminal";

type GhosttyTheme = {
    background?: string;
    foreground?: string;
    cursor?: string;
};

type GhosttyTerminal = {
    open(container: HTMLElement): void;
    write(data: string): void;
    onData(callback: (data: string) => void): void;
    dispose?(): void;
    focus?(): void;
    resize?(cols: number, rows: number): void;
    cols?: number;
    rows?: number;
};

type GhosttyModule = {
    init(): Promise<void>;
    Terminal: new (opts?: Record<string, unknown>) => GhosttyTerminal;
};

let ghosttyModule: GhosttyModule | null = null;

async function ensureGhostty(): Promise<GhosttyModule> {
    if (ghosttyModule) return ghosttyModule;
    // Dynamic import — ghostty-web is loaded only when the terminal is opened.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    const mod: GhosttyModule = await import('ghostty-web');
    await mod.init();
    ghosttyModule = mod;
    return mod;
}

function hideScroller(view: EditorView) {
    const scroller = view.dom.querySelector('.cm-scroller') as HTMLElement;
    if (scroller) {
        scroller.style.visibility = 'hidden';
        scroller.style.height = '0';
        scroller.style.overflow = 'hidden';
        scroller.style.position = 'absolute';
    }
}

function showScroller(view: EditorView) {
    const scroller = view.dom.querySelector('.cm-scroller') as HTMLElement;
    if (scroller) {
        scroller.style.visibility = '';
        scroller.style.height = '';
        scroller.style.overflow = '';
        scroller.style.position = '';
    }
}

function focusTerminal(container: HTMLElement, terminal: GhosttyTerminal) {
    if (terminal.focus) {
        terminal.focus();
        return;
    }
    // Fallback: focus the first interactive element ghostty creates
    requestAnimationFrame(() => {
        const focusable = container.querySelector('canvas, [tabindex]') as HTMLElement;
        if (focusable) focusable.focus();
    });
}

function terminalTheme(dark: boolean): GhosttyTheme {
    return dark
        ? { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4' }
        : { background: '#ffffff', foreground: '#1e1e1e', cursor: '#1e1e1e' };
}

/** Estimate terminal cols/rows from container pixel dimensions and font size. */
function calcTerminalSize(container: HTMLElement, fontSize: number): { cols: number; rows: number } {
    const charWidth = fontSize * 0.6;
    const lineHeight = fontSize * 1.2;
    return {
        cols: Math.max(2, Math.floor(container.clientWidth / charWidth)),
        rows: Math.max(1, Math.floor(container.clientHeight / lineHeight)),
    };
}

// ---------------------------------------------------------------------------
// Persistent terminal state — the ghostty instance and jswasi session
// survive panel close/reopen so content and cursor position are preserved.
// ---------------------------------------------------------------------------
let persistentTerminal: GhosttyTerminal | null = null;
let persistentContainer: HTMLElement | null = null;

// Prevents GC of the session object while the terminal persists.
// Accessed via persistentState.session so TS doesn't flag it as unused.
const persistentState: { session: JswasiTerminalSession | null } = { session: null };

/** Resize handler shared by first-open and reopen paths. */
function handleResize(container: HTMLElement, fontSize: number) {
    if (!persistentTerminal?.resize) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return; // container not visible
    const { cols, rows } = calcTerminalSize(container, fontSize);
    if (cols !== persistentTerminal.cols || rows !== persistentTerminal.rows) {
        persistentTerminal.resize(cols, rows);
        // Update the size reported to jswasi programs (fire-and-forget)
        import('../utils/jswasi-terminal').then(m => m.updateTerminalSize(cols, rows));
    }
}

function createTerminalPanel(view: EditorView): Panel {
    const dom = document.createElement("div");
    dom.className = "cm-terminal-panel";

    // Hide the editor and mark terminal active — deferred to avoid
    // interfering with CM's current update cycle
    queueMicrotask(() => {
        hideScroller(view);
        view.dom.classList.add('cm-terminal-active');
    });

    let resizeObserver: ResizeObserver | null = null;

    if (persistentContainer && persistentTerminal) {
        // Reopen: re-attach the existing terminal (all state preserved)
        dom.appendChild(persistentContainer);

        resizeObserver = new ResizeObserver(() => {
            handleResize(persistentContainer!, view.state.field(settingsField).fontSize);
        });
        resizeObserver.observe(persistentContainer);

        // Focus after layout settles
        requestAnimationFrame(() => {
            if (persistentTerminal) focusTerminal(persistentContainer!, persistentTerminal);
        });
    } else {
        // First open: create container and initialize ghostty
        const container = document.createElement("div");
        container.className = "cm-terminal-container";
        dom.appendChild(container);
        persistentContainer = container;

        resizeObserver = new ResizeObserver(() => {
            handleResize(container, view.state.field(settingsField).fontSize);
        });
        resizeObserver.observe(container);

        initTerminal(view, container).catch((err) => {
            container.textContent = `Failed to load terminal: ${err.message}`;
            container.style.padding = '8px';
            container.style.color = '#f44';
        });
    }

    return {
        dom,
        top: false,
        destroy() {
            // Restore editor visibility
            showScroller(view);
            view.dom.classList.remove('cm-terminal-active');
            resizeObserver?.disconnect();
            resizeObserver = null;

            // Terminal and session intentionally NOT disposed — they persist
            // so content and cursor state are preserved across toggles.

            // Sync state field if it wasn't already updated
            queueMicrotask(() => {
                try {
                    if (view.state.field(terminalActiveField)) {
                        view.dispatch({ effects: terminalActiveEffect.of(false) });
                    }
                } catch { /* view may be destroyed */ }
            });
        },
    };
}

/** First-time terminal initialization. */
async function initTerminal(view: EditorView, container: HTMLElement) {
    const ghostty = await ensureGhostty();
    if (!container.isConnected) return;

    // Wait for the container to have non-zero dimensions
    await new Promise<void>((resolve) => {
        if (container.clientWidth > 0 && container.clientHeight > 0) {
            resolve();
            return;
        }
        const observer = new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect;
            if (rect && rect.width > 0 && rect.height > 0) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(container);
    });

    if (!container.isConnected) return;

    const settings = view.state.field(settingsField);
    const dark = resolveThemeDark(settings.theme);
    const { cols, rows } = calcTerminalSize(container, settings.fontSize);

    const terminal = new ghostty.Terminal({
        cols,
        rows,
        fontSize: settings.fontSize,
        cursorBlink: true,
        cursorStyle: 'block',
        theme: terminalTheme(dark),
    });
    terminal.open(container);
    persistentTerminal = terminal;
    focusTerminal(container, terminal);

    // Connect to jswasi if configured
    const cfg = view.state.facet(CodeblockFacet);
    if (!cfg.jswasi) {
        terminal.write('\x1b[1;32m$\x1b[0m Terminal ready (no backend connected)\r\n');
        return;
    }

    terminal.write('\x1b[1;33m$\x1b[0m Initializing terminal...\r\n');

    try {
        const { createTerminalSession, updateTerminalSize } = await import('../utils/jswasi-terminal');
        updateTerminalSize(cols, rows);
        persistentState.session = await createTerminalSession(cfg.jswasi, terminal);
    } catch (err: any) {
        terminal.write(`\x1b[1;31mFailed to start terminal:\x1b[0m ${err.message}\r\n`);
    }
}

/** Open (or toggle) the terminal panel on the given editor view. */
export async function openTerminal(view: EditorView) {
    view.dispatch({
        effects: [
            terminalCompartment.reconfigure(
                showPanel.of(createTerminalPanel)
            ),
            terminalActiveEffect.of(true),
        ],
    });
}
