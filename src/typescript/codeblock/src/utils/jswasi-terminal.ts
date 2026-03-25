import { Jswasi } from '@joinezco/jswasi';
import type { JswasiConfig } from '../types';

// jswasi const enum major.MAJ_HTERM = 1
const MAJ_HTERM = 1;

// ---------------------------------------------------------------------------
// Ghostty-web ↔ hterm shim (persistent proxy)
// ---------------------------------------------------------------------------

type GhosttyTerminal = {
    write(data: string): void;
    onData(callback: (data: string) => void): void;
};

let activeGhostty: GhosttyTerminal | null = null;
let onInput: ((data: string) => void) | null = null;

let screenCols = 80;
let screenRows = 24;

// Content row tracking for dynamic overlay height
let contentRows = 0;
let resizeCallback: ((contentRows: number) => void) | null = null;

/** Write output to ghostty and track content rows for dynamic sizing. */
function writeTerminalOutput(data: string) {
    activeGhostty?.write(data);

    const newlines = (data.match(/\n/g) || []).length;
    if (newlines > 0) {
        contentRows += newlines;
        if (data.includes('\x1b[2J')) contentRows = 0; // screen clear
        if (resizeCallback) resizeCallback(contentRows);
    }
}

function createPersistentShim() {
    return {
        get screenSize() { return { width: screenCols, height: screenRows }; },

        io: {
            print(data: string) { writeTerminalOutput(data); },
            println(data: string) { writeTerminalOutput(data + '\r\n'); },
            push() {
                return {
                    set onVTKeystroke(cb: (data: string) => void) { onInput = cb; },
                    set sendString(_cb: (data: string) => void) { /* same handler */ },
                    set onTerminalResize(_cb: (cols: number, rows: number) => void) { /* TODO */ },
                    print(data: string) { writeTerminalOutput(data); },
                    println(data: string) { writeTerminalOutput(data + '\r\n'); },
                };
            },
        },

        installKeyboard() {},
        keyboard: { bindings: { addBindings() {} } },
        setInsertMode(_mode: boolean) {},
        cursorLeft(n: number) { writeTerminalOutput(`\x1b[${n}D`); },

        scrollPort_: {
            getScreenSize() { return { width: 800, height: 600 }; },
        },
    };
}

function attachGhostty(ghostty: GhosttyTerminal) {
    activeGhostty = ghostty;
    ghostty.onData((data: string) => {
        if (onInput) onInput(data);
    });
}

function detachGhostty() {
    activeGhostty = null;
}

export function updateTerminalSize(cols: number, rows: number) {
    screenCols = cols;
    screenRows = rows;
}

/** Register callback for content row count changes (drives overlay height). */
export function setResizeCallback(cb: ((contentRows: number) => void) | null) {
    resizeCallback = cb;
    if (cb) cb(contentRows);
}

// ---------------------------------------------------------------------------
// Lazy jswasi singleton
// ---------------------------------------------------------------------------

let jswasiReady: Promise<Jswasi> | null = null;

async function getJswasi(config: JswasiConfig): Promise<Jswasi> {
    if (jswasiReady) return jswasiReady;
    jswasiReady = (async () => {
        const jswasi = new Jswasi();
        const shim = createPersistentShim();
        await jswasi.attachDevice({ terminal: shim }, MAJ_HTERM as any);

        const bucket = config.opfsBucket || 'fsa1';

        await jswasi.init({
            init: '/usr/bin/wasibox',
            initArgs: ['init'],
            rootfs: config.rootfsUrl,
            mountConfig: {
                fsType: 'fsa',
                opts: { name: bucket, keepMetadata: 'true', create: 'true' },
            },
        }, false);

        return jswasi;
    })();
    return jswasiReady;
}

// ---------------------------------------------------------------------------
// Terminal session interface
// ---------------------------------------------------------------------------

export interface JswasiTerminalSession {
    dispose(): void;
}

export async function createTerminalSession(
    config: JswasiConfig,
    ghostty: GhosttyTerminal,
): Promise<JswasiTerminalSession> {
    attachGhostty(ghostty);
    await getJswasi(config);

    return {
        dispose() {
            detachGhostty();
        },
    };
}
