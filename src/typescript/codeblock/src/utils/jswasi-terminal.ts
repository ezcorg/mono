import { Jswasi } from '@joinezco/jswasi';
import type { JswasiConfig } from '../types';

// jswasi const enum major.MAJ_HTERM = 1
const MAJ_HTERM = 1;

// ---------------------------------------------------------------------------
// Ghostty-web ↔ hterm shim
// ---------------------------------------------------------------------------

type GhosttyTerminal = {
    write(data: string): void;
    onData(callback: (data: string) => void): void;
};

/**
 * Wraps a ghostty-web terminal instance to look like an hterm terminal,
 * so jswasi's HtermDeviceDriver can use it without modification.
 */
function createHtermShim(ghostty: GhosttyTerminal) {
    let onInput: ((data: string) => void) | null = null;

    // Wire ghostty input to the shim's input handler
    ghostty.onData((data: string) => {
        if (onInput) onInput(data);
    });

    return {
        screenSize: { width: 80, height: 24 },

        io: {
            print(data: string) { ghostty.write(data); },
            println(data: string) { ghostty.write(data + '\r\n'); },
            push() {
                return {
                    set onVTKeystroke(cb: (data: string) => void) { onInput = cb; },
                    set sendString(_cb: (data: string) => void) { /* same handler */ },
                    set onTerminalResize(_cb: (cols: number, rows: number) => void) { /* TODO */ },
                    print(data: string) { ghostty.write(data); },
                    println(data: string) { ghostty.write(data + '\r\n'); },
                };
            },
        },

        installKeyboard() {},
        keyboard: { bindings: { addBindings() {} } },
        setInsertMode(_mode: boolean) {},
        cursorLeft(n: number) { ghostty.write(`\x1b[${n}D`); },

        scrollPort_: {
            getScreenSize() { return { width: 800, height: 600 }; },
        },
    };
}

// ---------------------------------------------------------------------------
// Lazy jswasi singleton
// ---------------------------------------------------------------------------

let jswasiReady: Promise<Jswasi> | null = null;

export async function getJswasi(
    config: JswasiConfig,
    ghostty: GhosttyTerminal,
): Promise<Jswasi> {
    if (jswasiReady) return jswasiReady;
    jswasiReady = (async () => {
        const jswasi = new Jswasi();

        // Attach the ghostty terminal as an hterm-compatible device
        const shim = createHtermShim(ghostty);
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
    // getJswasi boots the kernel and attaches ghostty as the terminal device.
    // Once init() completes, the wash shell is running and connected to the
    // terminal — no additional wiring needed.
    await getJswasi(config, ghostty);

    return {
        dispose() {
            // Terminal cleanup — the jswasi kernel persists as a singleton,
            // so we don't tear it down when the panel closes.
        },
    };
}
