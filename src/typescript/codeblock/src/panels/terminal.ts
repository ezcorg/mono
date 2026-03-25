import { EditorView } from "@codemirror/view";
import { CodeblockFacet } from "../editor";
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
    const mod: GhosttyModule = await import('ghostty-web');
    await mod.init();
    ghosttyModule = mod;
    return mod;
}

function terminalTheme(dark: boolean): GhosttyTheme {
    return dark
        ? { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4' }
        : { background: '#ffffff', foreground: '#1e1e1e', cursor: '#1e1e1e' };
}

const MAX_ROWS = 16;

// ---------------------------------------------------------------------------
// Persistent terminal state
// ---------------------------------------------------------------------------
let persistentTerminal: GhosttyTerminal | null = null;
let persistentContainer: HTMLElement | null = null;
const persistentState: { session: JswasiTerminalSession | null } = { session: null };

/**
 * Returns the persistent terminal container, creating and initializing
 * ghostty on first call.
 */
export async function ensureTerminalElement(view: EditorView): Promise<HTMLElement> {
    if (persistentContainer) return persistentContainer;

    const container = document.createElement("div");
    container.className = "cm-terminal-container";
    persistentContainer = container;

    initTerminal(view, container).catch((err) => {
        container.textContent = `Failed to load terminal: ${err.message}`;
        container.style.padding = '8px';
        container.style.color = '#f44';
    });

    return container;
}

/** Focus the ghostty terminal. */
export function focusTerminalEl() {
    if (!persistentTerminal || !persistentContainer) return;
    if (persistentTerminal.focus) {
        persistentTerminal.focus();
        return;
    }
    requestAnimationFrame(() => {
        const focusable = persistentContainer?.querySelector('canvas, [tabindex]') as HTMLElement;
        if (focusable) focusable.focus();
    });
}

/** Update terminal column count from container width. */
export function handleTerminalResize(fontSize: number) {
    if (!persistentTerminal?.resize || !persistentContainer) return;
    const w = persistentContainer.clientWidth;
    if (w === 0) return;
    const charWidth = fontSize * 0.6;
    const cols = Math.max(2, Math.floor(w / charWidth));
    if (cols !== persistentTerminal.cols) {
        const rows = persistentTerminal.rows || MAX_ROWS;
        persistentTerminal.resize(cols, rows);
        import('../utils/jswasi-terminal').then(m => m.updateTerminalSize(cols, rows));
    }
}

// ---------------------------------------------------------------------------
// First-time initialization
// ---------------------------------------------------------------------------
async function initTerminal(view: EditorView, container: HTMLElement) {
    const ghostty = await ensureGhostty();

    // Wait for the container to have width (height will be determined by content)
    await new Promise<void>((resolve) => {
        if (container.clientWidth > 0) {
            resolve();
            return;
        }
        const observer = new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect;
            if (rect && rect.width > 0) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(container);
    });

    if (!container.isConnected) return;

    const settings = view.state.field(settingsField);
    const dark = resolveThemeDark(settings.theme);
    const charWidth = settings.fontSize * 0.6;
    const cols = Math.max(2, Math.floor(container.clientWidth / charWidth));

    const terminal = new ghostty.Terminal({
        cols,
        rows: MAX_ROWS,
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily || undefined,
        cursorBlink: true,
        cursorStyle: 'block',
        theme: terminalTheme(dark),
    });
    terminal.open(container);
    persistentTerminal = terminal;

    // Connect to jswasi if configured
    const cfg = view.state.facet(CodeblockFacet);
    if (!cfg.jswasi) {
        terminal.write('\x1b[1;32m$\x1b[0m Terminal ready (no backend connected)\r\n');
        return;
    }

    try {
        const { createTerminalSession, updateTerminalSize } = await import('../utils/jswasi-terminal');
        updateTerminalSize(cols, MAX_ROWS);
        persistentState.session = await createTerminalSession(cfg.jswasi, terminal);
    } catch (err: any) {
        terminal.write(`\x1b[1;31mFailed to start terminal:\x1b[0m ${err.message}\r\n`);
    }
}
