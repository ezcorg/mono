import { EditorView, Decoration } from "@codemirror/view";
import { EditorState, StateEffect, StateField, RangeSet, Range } from "@codemirror/state";
import { CodeblockFacet } from "../editor";
import { settingsField, resolveThemeDark } from "./settings";
import type { JswasiTerminalSession } from "../utils/jswasi-terminal";
import type {
    Ghostty,
    GhosttyTerminal as WasmTerminal,
    GhosttyCell,
    InputHandler as InputHandlerType,
} from "ghostty-web";

// Re-declare getGhostty — it's exported at runtime but excluded from types
declare module 'ghostty-web' {
    export function getGhostty(): Ghostty;
}

// These interfaces are declared but not exported from ghostty-web
interface RGB { r: number; g: number; b: number }
interface TermColors { foreground: RGB; background: RGB; cursor: RGB | null }
// TermCursor: { x, y, visible, blinking, style } — used via wasmTerm.getCursor()

// Cell style flags (matching ghostty-web's CellFlags enum)
const BOLD = 1, ITALIC = 2, UNDERLINE = 4, STRIKETHROUGH = 8,
      INVERSE = 16, INVISIBLE = 32, FAINT = 128;

const MAX_ROWS = 24;

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------
let ghosttyInstance: Ghostty | null = null;
let wasmTerm: WasmTerminal | null = null;
let terminalCmView: EditorView | null = null;
let persistentContainer: HTMLElement | null = null;
const persistentState: { session: JswasiTerminalSession | null; inputHandler: InputHandlerType | null } = { session: null, inputHandler: null };

// Render scheduling
let renderScheduled = false;
let heightCallback: (() => void) | null = null;

/** Register a callback invoked after each render so the host can sync wrapper height. */
export function setHeightCallback(cb: (() => void) | null) {
    heightCallback = cb;
}

// Per-row cache for incremental updates
interface RowCache {
    text: string;
    decos: { from: number; to: number; style: string }[];
}
let rowCache: (RowCache | null)[] = [];

// ---------------------------------------------------------------------------
// CM decoration state
// ---------------------------------------------------------------------------
const termDecoEffect = StateEffect.define<RangeSet<Decoration>>();
const termDecoField = StateField.define<RangeSet<Decoration>>({
    create() { return Decoration.none; },
    update(value, tr) {
        for (const e of tr.effects) if (e.is(termDecoEffect)) return e.value;
        return value;
    },
    provide: f => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// WASM init
// ---------------------------------------------------------------------------
async function ensureGhosttyWasm(): Promise<Ghostty> {
    if (ghosttyInstance) return ghosttyInstance;
    const mod = await import('ghostty-web');
    await mod.init();
    ghosttyInstance = mod.getGhostty();
    return ghosttyInstance;
}

// ---------------------------------------------------------------------------
// Cell → decoration helpers
// ---------------------------------------------------------------------------
function cellStyleKey(cell: GhosttyCell, defaults: TermColors): string {
    const parts: string[] = [];
    let fg_r = cell.fg_r, fg_g = cell.fg_g, fg_b = cell.fg_b;
    let bg_r = cell.bg_r, bg_g = cell.bg_g, bg_b = cell.bg_b;

    if (cell.flags & INVERSE) {
        [fg_r, bg_r] = [bg_r, fg_r];
        [fg_g, bg_g] = [bg_g, fg_g];
        [fg_b, bg_b] = [bg_b, fg_b];
    }

    const dfg = defaults.foreground, dbg = defaults.background;
    if (fg_r !== dfg.r || fg_g !== dfg.g || fg_b !== dfg.b) {
        if (cell.flags & FAINT) parts.push(`color:rgba(${fg_r},${fg_g},${fg_b},0.5)`);
        else parts.push(`color:rgb(${fg_r},${fg_g},${fg_b})`);
    } else if (cell.flags & FAINT) {
        parts.push('opacity:0.5');
    }
    if (bg_r !== dbg.r || bg_g !== dbg.g || bg_b !== dbg.b) {
        parts.push(`background:rgb(${bg_r},${bg_g},${bg_b})`);
    }
    if (cell.flags & BOLD) parts.push('font-weight:bold');
    if (cell.flags & ITALIC) parts.push('font-style:italic');
    if (cell.flags & UNDERLINE) parts.push('text-decoration:underline');
    if (cell.flags & STRIKETHROUGH) parts.push('text-decoration:line-through');
    if (cell.flags & INVISIBLE) parts.push('visibility:hidden');
    return parts.join(';');
}

function buildRow(
    cells: GhosttyCell[] | null,
    y: number,
    cols: number,
    colors: TermColors,
    wasm: WasmTerminal,
): RowCache {
    if (!cells) return { text: ' '.repeat(cols), decos: [] };

    let text = '';
    const decos: RowCache['decos'] = [];
    let runStart = 0;
    let runStyle = '';

    for (let x = 0; x < cells.length; x++) {
        const cell = cells[x];
        if (cell.width === 0) continue; // trailing half of wide char

        // Character
        let ch: string;
        if (cell.grapheme_len > 0) {
            ch = wasm.getGraphemeString(y, x);
        } else if (cell.codepoint === 0 || cell.codepoint === 32) {
            ch = ' ';
        } else {
            ch = String.fromCodePoint(cell.codepoint);
        }
        const pos = text.length;
        text += ch;

        // Style
        const style = cellStyleKey(cell, colors);
        if (style !== runStyle) {
            if (runStyle && runStart < pos) {
                decos.push({ from: runStart, to: pos, style: runStyle });
            }
            runStart = pos;
            runStyle = style;
        }
    }

    // Flush last run
    if (runStyle && runStart < text.length) {
        decos.push({ from: runStart, to: text.length, style: runStyle });
    }

    return { text, decos };
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(renderTerminal);
}

function renderTerminal() {
    renderScheduled = false;
    if (!wasmTerm || !terminalCmView) return;

    const dirty = wasmTerm.update();
    if (dirty === 0 /* NONE */) return;

    const fullRedraw = dirty === 2 /* FULL */ || wasmTerm.needsFullRedraw();
    const colors = wasmTerm.getColors();
    const cursor = wasmTerm.getCursor();
    const cols = wasmTerm.cols;
    const rows = wasmTerm.rows;

    // Ensure cache is sized
    if (rowCache.length !== rows) {
        rowCache = new Array(rows).fill(null);
    }

    // Build text + decorations for dirty rows
    for (let y = 0; y < rows; y++) {
        if (fullRedraw || wasmTerm.isRowDirty(y)) {
            const cells = wasmTerm.getLine(y);
            rowCache[y] = buildRow(cells, y, cols, colors, wasmTerm);
        }
    }

    // Collect all rows, then trim trailing empty ones
    const allLines: string[] = [];
    for (let y = 0; y < rows; y++) {
        allLines.push((rowCache[y] || { text: ' '.repeat(cols) }).text);
    }

    // Trim trailing empty rows (but keep at least one row past the cursor)
    const minLines = Math.max(1, (cursor.visible ? cursor.y + 1 : 0));
    while (allLines.length > minLines && allLines[allLines.length - 1].trim() === '') {
        allLines.pop();
    }

    // Build decorations only for the visible rows
    const decorations: Range<Decoration>[] = [];
    let offset = 0;
    for (let y = 0; y < allLines.length; y++) {
        const cached = rowCache[y];
        if (cached) {
            for (const d of cached.decos) {
                if (d.style) {
                    decorations.push(
                        Decoration.mark({ attributes: { style: d.style } })
                            .range(offset + d.from, offset + d.to)
                    );
                }
            }
        }
        offset += allLines[y].length + 1; // +1 for \n
    }

    // Cursor decoration
    if (cursor.visible && cursor.y >= 0 && cursor.y < allLines.length) {
        const cursorLineStart = allLines.slice(0, cursor.y).reduce((s, l) => s + l.length + 1, 0);
        const cursorFrom = cursorLineStart + Math.min(cursor.x, allLines[cursor.y].length);
        const cursorTo = cursorFrom + 1;
        const newDocLen = allLines.join('\n').length;
        if (cursorFrom < newDocLen) {
            decorations.push(
                Decoration.mark({ class: 'cm-terminal-cursor' })
                    .range(cursorFrom, Math.min(cursorTo, newDocLen))
            );
        }
    }

    const sortedDecos = decorations.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
    const newDoc = allLines.join('\n');

    terminalCmView.dispatch({
        changes: { from: 0, to: terminalCmView.state.doc.length, insert: newDoc },
        effects: termDecoEffect.of(RangeSet.of(sortedDecos)),
    });

    wasmTerm.markClean();

    // Notify height callback so the wrapper can resize
    if (heightCallback) heightCallback();
}

// ---------------------------------------------------------------------------
// Terminal shim adapter — bridges jswasi's hterm interface
// ---------------------------------------------------------------------------
const onDataCallbacks: ((data: string) => void)[] = [];

function handleInputData(data: string) {
    for (const cb of onDataCallbacks) cb(data);
}

function createTermShim() {
    return {
        write(data: string) {
            wasmTerm?.write(data);
            // Check for terminal responses (DSR cursor position queries, etc.)
            while (wasmTerm?.hasResponse()) {
                const resp = wasmTerm.readResponse();
                if (resp) handleInputData(resp);
            }
            scheduleRender();
        },
        onData(cb: (data: string) => void) {
            onDataCallbacks.push(cb);
        },
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns the persistent terminal container, creating and initializing on first call. */
export async function ensureTerminalElement(view: EditorView): Promise<HTMLElement> {
    if (persistentContainer) return persistentContainer;

    const container = document.createElement("div");
    container.className = "cm-terminal-container";
    container.tabIndex = 0; // focusable for InputHandler
    persistentContainer = container;

    initTerminal(view, container).catch((err) => {
        container.textContent = `Failed to load terminal: ${err.message}`;
        container.style.padding = '8px';
        container.style.color = '#f44';
    });

    return container;
}

/** Focus the terminal container (receives keyboard events via InputHandler). */
export function focusTerminalEl() {
    persistentContainer?.focus();
}

/** Update terminal column count from container width. */
export function handleTerminalResize(fontSize: number) {
    if (!wasmTerm || !persistentContainer) return;
    const w = persistentContainer.clientWidth;
    if (w === 0) return;
    const charWidth = fontSize * 0.6;
    const cols = Math.max(2, Math.floor(w / charWidth));
    if (cols !== wasmTerm.cols) {
        wasmTerm.resize(cols, wasmTerm.rows);
        rowCache = [];
        scheduleRender();
        import('../utils/jswasi-terminal').then(m => m.updateTerminalSize(cols, wasmTerm!.rows));
    }
}

// ---------------------------------------------------------------------------
// First-time initialization
// ---------------------------------------------------------------------------
async function initTerminal(view: EditorView, container: HTMLElement) {
    const ghostty = await ensureGhosttyWasm();

    // Wait for the container to have width
    await new Promise<void>((resolve) => {
        if (container.clientWidth > 0) { resolve(); return; }
        const observer = new ResizeObserver((entries) => {
            if (entries[0]?.contentRect?.width > 0) { observer.disconnect(); resolve(); }
        });
        observer.observe(container);
    });

    if (!container.isConnected) return;

    const settings = view.state.field(settingsField);
    const dark = resolveThemeDark(settings.theme);
    const charWidth = settings.fontSize * 0.6;
    const cols = Math.max(2, Math.floor(container.clientWidth / charWidth));

    // Parse theme colors to 0xRRGGBB
    const fg = dark ? 0xd4d4d4 : 0x1e1e1e;
    const bg = dark ? 0x1e1e1e : 0xffffff;

    // Create WASM terminal (parser only — no canvas renderer)
    wasmTerm = ghostty.createTerminal(cols, MAX_ROWS, {
        fgColor: fg,
        bgColor: bg,
        cursorColor: fg,
    });

    // Create CM EditorView as the renderer
    terminalCmView = new EditorView({
        state: EditorState.create({
            doc: '',
            extensions: [
                EditorState.readOnly.of(true),
                EditorView.editable.of(false),
                termDecoField,
                EditorView.theme({
                    '&': {
                        background: dark ? '#1e1e1e' : '#ffffff',
                        color: dark ? '#d4d4d4' : '#1e1e1e',
                    },
                    '.cm-scroller': { overflow: 'hidden' },
                    '.cm-content': {
                        padding: '0',
                        caretColor: 'transparent',
                        fontFamily: 'var(--cm-font-family)',
                        fontSize: 'var(--cm-font-size, 16px)',
                    },
                    '.cm-gutters': { display: 'none' },
                    '.cm-activeLine': { backgroundColor: 'transparent' },
                    '.cm-line': { padding: '0' },
                    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
                        backgroundColor: 'transparent',
                    },
                }),
            ],
        }),
        parent: container,
    });

    // Create InputHandler for keyboard encoding
    persistentState.inputHandler = new (await import('ghostty-web')).InputHandler(
        ghostty,
        container,
        handleInputData,             // onData → feeds to jswasi
        () => { /* bell */ },
        undefined,
        undefined,
        (mode: number) => wasmTerm!.getMode(mode),
    );

    // Connect to jswasi
    const cfg = view.state.facet(CodeblockFacet);
    const termShim = createTermShim();

    if (!cfg.jswasi) {
        wasmTerm.write('Terminal ready (no backend connected)\r\n');
        scheduleRender();
        return;
    }

    try {
        const { createTerminalSession, updateTerminalSize } = await import('../utils/jswasi-terminal');
        updateTerminalSize(cols, MAX_ROWS);
        persistentState.session = await createTerminalSession(cfg.jswasi, termShim as any);
    } catch (err: any) {
        wasmTerm.write(`\x1b[1;31mFailed to start terminal:\x1b[0m ${err.message}\r\n`);
        scheduleRender();
    }
}
