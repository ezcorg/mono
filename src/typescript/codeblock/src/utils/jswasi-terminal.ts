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

// The underlying ghostty terminal is mutable — it gets swapped each time
// the terminal panel is opened. The shim's references always go through
// these module-level variables so the jswasi kernel doesn't need to be
// re-attached.
let activeGhostty: GhosttyTerminal | null = null;
let onInput: ((data: string) => void) | null = null;

// Terminal dimensions reported to jswasi programs
let screenCols = 80;
let screenRows = 24;

/**
 * Creates a persistent hterm-compatible shim that delegates all I/O
 * through `activeGhostty`. The same shim instance stays attached to
 * jswasi for the kernel's lifetime — only the underlying ghostty
 * terminal is swapped on reopen.
 */
function createPersistentShim() {
    return {
        get screenSize() { return { width: screenCols, height: screenRows }; },

        io: {
            print(data: string) { activeGhostty?.write(data); },
            println(data: string) { activeGhostty?.write(data + '\r\n'); },
            push() {
                return {
                    set onVTKeystroke(cb: (data: string) => void) { onInput = cb; },
                    set sendString(_cb: (data: string) => void) { /* same handler */ },
                    set onTerminalResize(_cb: (cols: number, rows: number) => void) { /* TODO */ },
                    print(data: string) { activeGhostty?.write(data); },
                    println(data: string) { activeGhostty?.write(data + '\r\n'); },
                };
            },
        },

        installKeyboard() {},
        keyboard: { bindings: { addBindings() {} } },
        setInsertMode(_mode: boolean) {},
        cursorLeft(n: number) { activeGhostty?.write(`\x1b[${n}D`); },

        scrollPort_: {
            getScreenSize() { return { width: 800, height: 600 }; },
        },
    };
}

/** Connect a new ghostty terminal to the persistent shim. */
function attachGhostty(ghostty: GhosttyTerminal) {
    activeGhostty = ghostty;
    // Route this terminal's input to the jswasi kernel's input handler
    ghostty.onData((data: string) => {
        if (onInput) onInput(data);
    });
}

/** Disconnect the current ghostty terminal so stale writes are dropped. */
function detachGhostty() {
    activeGhostty = null;
}

/** Update the terminal dimensions reported to jswasi programs. */
export function updateTerminalSize(cols: number, rows: number) {
    screenCols = cols;
    screenRows = rows;
}

// ---------------------------------------------------------------------------
// Lazy jswasi singleton
// ---------------------------------------------------------------------------

let jswasiReady: Promise<Jswasi> | null = null;

async function getJswasi(config: JswasiConfig): Promise<Jswasi> {
    if (jswasiReady) return jswasiReady;
    jswasiReady = (async () => {
        const jswasi = new Jswasi();

        // Attach the persistent shim as the hterm-compatible device
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
        }, false); // false = don't use jswasi's own service worker (host app handles COEP/COOP)

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
    // Swap in the new ghostty terminal before booting (first call) or
    // reconnecting (subsequent calls). The persistent shim routes all
    // kernel I/O through the active ghostty instance.
    attachGhostty(ghostty);
    await getJswasi(config);

    return {
        dispose() {
            // Disconnect so the disposed terminal doesn't receive stale writes.
            // The jswasi kernel persists as a singleton — it keeps running.
            detachGhostty();
        },
    };
}
