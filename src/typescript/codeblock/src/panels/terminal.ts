import { EditorView, Panel, showPanel } from "@codemirror/view";
import { terminalCompartment } from "../editor";
import { settingsField, resolveThemeDark } from "./settings";

type GhosttyTerminal = {
    open(container: HTMLElement): void;
    write(data: string): void;
    onData(callback: (data: string) => void): void;
    dispose?(): void;
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

const CLOSE_ICON = '\uf00d'; // nf-fa-close

function createTerminalPanel(view: EditorView): Panel {
    const dom = document.createElement("div");
    dom.className = "cm-terminal-panel";

    // Header bar with close button
    const header = document.createElement("div");
    header.className = "cm-terminal-header";

    const title = document.createElement("span");
    title.className = "cm-terminal-title";
    title.textContent = "Terminal";
    header.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.className = "cm-terminal-close";
    closeBtn.style.fontFamily = 'var(--cm-icon-font-family)';
    closeBtn.textContent = CLOSE_ICON;
    closeBtn.title = "Close terminal";
    closeBtn.addEventListener("click", () => {
        view.dispatch({
            effects: terminalCompartment.reconfigure([]),
        });
    });
    header.appendChild(closeBtn);
    dom.appendChild(header);

    // Terminal container
    const container = document.createElement("div");
    container.className = "cm-terminal-container";
    dom.appendChild(container);

    let terminal: GhosttyTerminal | null = null;

    // Lazy-load ghostty-web and mount
    ensureGhostty().then(({ Terminal }) => {
        if (!dom.isConnected) return;

        const settings = view.state.field(settingsField);
        const dark = resolveThemeDark(settings.theme);

        terminal = new Terminal({
            fontSize: settings.fontSize,
            theme: dark
                ? { background: '#1e1e1e', foreground: '#d4d4d4' }
                : { background: '#ffffff', foreground: '#1e1e1e' },
        });
        terminal.open(container);
        terminal.write('\x1b[1;32m$\x1b[0m Terminal ready (no backend connected)\r\n');
    }).catch((err) => {
        container.textContent = `Failed to load terminal: ${err.message}`;
        container.style.padding = '8px';
        container.style.color = '#f44';
    });

    return {
        dom,
        top: false,
        destroy() {
            terminal?.dispose?.();
            terminal = null;
        },
    };
}

/** Open (or toggle) the terminal panel on the given editor view. */
export async function openTerminal(view: EditorView) {
    view.dispatch({
        effects: terminalCompartment.reconfigure(
            showPanel.of(createTerminalPanel)
        ),
    });
}
