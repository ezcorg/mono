//! The flagship icanhaz demo: a **@joinezco/markdown-editor** instance styled
//! exactly like the "custom" variant of the package's `mac-window` dev preview
//! (traffic-light titlebar, the file-search toolbar mounted *into* the titlebar,
//! an auto-generated outline sidebar, a light/system/dark theme toggle, and a
//! Source Serif 4 prose body) — but instead of a local snapshot VFS it edits
//! **real host files over wRPC**, gated by consent, with the host's
//! rust-analyzer lighting up any (embedded or standalone) code block.
//!
//! `mountMacDemo` is shared by both demo pages: `editor-demo` opens a Markdown
//! file (rich-text prose); `rust-demo` opens a `.rs` file (which the editor
//! renders as a single standalone codeblock → rust-analyzer over the `process`
//! capability). The two differ only in their default file.
//!
//! Run (rust-analyzer + cargo on the daemon's PATH for the Rust page):
//!   cd /Users/theo/dev/mono && PATH="$HOME/.cargo/bin:$PATH" ICANHAZ_CONSENT=auto ./target/debug/icanhazd
//!   cd src/apps/icanhaz/web && npm run dev   # open /editor-demo.html or /rust-demo.html
//! Override the file/socket via `?file=…` and `?ws=…`.

import "./mac-window.css";

import { connect, requestFilesystemGrant, type Transport } from "./wrpc";
import { wrpcFilesystem } from "./vfs";
import { workspaceRoot } from "./workspace";
import { add as addComponent } from "./generated/components";
import { openLinks, requestLinksGrant, type LinksIndex } from "./links";
import { createWrpcLspProvider } from "./lsp-provider";
import { setRemoteLspProvider } from "@joinezco/codeblock";
import {
    createEditor,
    type MarkdownEditor,
    type FileSystemOptions,
    type ToolbarOptions,
} from "@joinezco/markdown-editor";

export interface MacDemoOptions {
    /** Where to mount the whole page (usually `#root`). */
    root: HTMLElement;
    /** Default file to open, relative to the granted jail (overridable via `?file=`). */
    defaultFile: string;
    /** Default WebSocket URL (overridable via `?ws=`). */
    defaultWs?: string;
    /** Headline shown at the top-left of the page. */
    title?: string;
    /** Consent reason surfaced in the request. */
    reason?: string;
    /** Seed content written when the file doesn't exist yet (so there's always
     *  something to edit). Omit to leave a missing file missing. */
    seed?: (filepath: string) => string;
}

type ThemeMode = "light" | "system" | "dark";
const THEME_KEY = "icanhaz.demo.theme";
const THEMES: { mode: ThemeMode; glyph: string; label: string }[] = [
    { mode: "light", glyph: "☀", label: "Light" },
    { mode: "system", glyph: "◐", label: "System" },
    { mode: "dark", glyph: "☾", label: "Dark" },
];

function isDark(mode: ThemeMode): boolean {
    if (mode === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches;
    return mode === "dark";
}

/** Tiny DOM builder — `el("div", "cls", child, …)`. */
function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const c of children) node.append(c);
    return node;
}

/** Build the simulated-macOS-window chrome and return its mount points. */
function buildChrome(root: HTMLElement, title: string) {
    const status = el("span", "dev-status", "idle");
    const header = el(
        "header",
        "dev-header",
        el("div", "dev-title", el("strong", undefined, title), el("code", undefined, "@joinezco/markdown-editor")),
        status,
    );

    const toolbarMount = el("div", "mac-titlebar-toolbar");
    const lights = el("span", "mac-lights");
    lights.setAttribute("aria-hidden", "true");
    for (const which of ["close", "min", "max"]) lights.append(el("span", `mac-light mac-light--${which}`));

    const themeToggle = el("div", "theme-toggle");
    themeToggle.setAttribute("role", "radiogroup");
    themeToggle.setAttribute("aria-label", "Color theme");

    const titlebar = el("div", "mac-titlebar", lights, toolbarMount, themeToggle);

    const sidebarMount = el("div", "mac-sidebar");
    const linksMount = el("div", "mac-links");
    sidebarMount.append(linksMount);
    const editorMount = el("div", "mac-editor");
    const body = el("div", "mac-body", el("div", "mac-body-row", sidebarMount, editorMount));

    const win = el("div", "mac-window mac-window--custom", titlebar, body);
    const page = el("div", "dev-page", header, win);
    root.replaceChildren(page);

    return { status, toolbarMount, themeToggle, sidebarMount, linksMount, editorMount };
}

/** Wire the light/system/dark segmented control; drives `data-theme` on the
 *  root (which flips the editor's CSS variables + is read by codeblocks) and
 *  re-themes already-mounted codeblocks via the editor command. */
function wireThemeToggle(container: HTMLElement, getEditor: () => MarkdownEditor | undefined): void {
    let mode = ((): ThemeMode => {
        const saved = localStorage.getItem(THEME_KEY);
        return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    })();

    const buttons = THEMES.map(({ mode: m, glyph, label }) => {
        const btn = el("button", undefined, el("span", undefined, glyph));
        btn.type = "button";
        btn.setAttribute("role", "radio");
        btn.setAttribute("aria-label", label);
        btn.title = label;
        btn.addEventListener("click", () => apply(m));
        container.append(btn);
        return { m, btn };
    });

    const apply = (next: ThemeMode) => {
        mode = next;
        localStorage.setItem(THEME_KEY, mode);
        const rootEl = document.documentElement;
        if (mode === "system") rootEl.removeAttribute("data-theme");
        else rootEl.setAttribute("data-theme", mode);
        for (const { m, btn } of buttons) {
            const on = m === mode;
            btn.classList.toggle("is-active", on);
            btn.setAttribute("aria-checked", String(on));
        }
        getEditor()?.commands.setCodeblockTheme({ dark: isDark(mode) });
    };
    apply(mode);
}

/**
 * Mount the flagship demo into `opts.root` and connect it to the daemon.
 * Returns nothing; errors surface in the header status chip and the console.
 */
export async function mountMacDemo(opts: MacDemoOptions): Promise<void> {
    const params = new URLSearchParams(location.search);
    const ws = params.get("ws") ?? opts.defaultWs ?? "ws://127.0.0.1:7777";
    const filepath = params.get("file") ?? opts.defaultFile;

    const { status, toolbarMount, themeToggle, sidebarMount, linksMount, editorMount } = buildChrome(
        opts.root,
        opts.title ?? "icanhaz",
    );
    const setStatus = (text: string, isError = false) => {
        status.textContent = text;
        status.classList.toggle("is-error", isError);
    };

    let editor: MarkdownEditor | undefined;
    // The theme toggle can be wired before the editor exists — it re-themes
    // codeblocks lazily via the getter once the editor is created.
    wireThemeToggle(themeToggle, () => editor);

    try {
        setStatus("connecting…");
        const transport: Transport = await connect({ ws });
        const grant = await requestFilesystemGrant(transport, opts.reason ?? "edit a host file in the browser");
        const fs = await wrpcFilesystem(transport, grant);

        // Light up rust-analyzer (on the host) for code files when the grant's
        // jail is a Cargo project — a `process` grant is requested on first use.
        // No workspace path / non-Rust files → the codeblock's built-in behavior.
        const root = await workspaceRoot(transport, grant).catch(() => undefined);
        if (root !== undefined) {
            setRemoteLspProvider(
                createWrpcLspProvider({
                    transport,
                    workspaceRoot: root,
                    servers: { rust: { image: "rust-analyzer" } },
                }),
            );
        }

        // Seed the file the first time so there's always something to edit.
        if (opts.seed && !(await fs.exists(filepath))) {
            await fs.writeFile(filepath, opts.seed(filepath));
        }

        editor = createEditor({
            element: editorMount,
            // `VfsLike` structurally mirrors codeblock's `VfsInterface` (only
            // `stat`'s return is deliberately wider) — assert it to the options.
            fs: { fs, filepath, autoSave: true } as FileSystemOptions,
            // The file-search toolbar mounts into the window titlebar (in place
            // of a title) and stays visible there (not the default floating pill);
            // `.mac-titlebar-search` rethemes it into a slim titlebar field.
            toolbar: {
                fs: fs as unknown as ToolbarOptions["fs"],
                filepath,
                mount: () => toolbarMount,
                autoHide: false,
                className: "mac-titlebar-search",
            },
            // Auto-generated document outline in the window's left column.
            sidebar: { mount: () => sidebarMount, title: "Document" },
        });
        // Re-apply the current theme now that codeblocks can receive it.
        editor.commands.setCodeblockTheme({
            dark: isDark((localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "system"),
        });
        // Expose for manual debugging in the console.
        (window as unknown as { editor?: MarkdownEditor }).editor = editor;

        // Backlinks: a novel capability from the store, lent this page's
        // filesystem grant. Named by hash and source (`?links-provider=sha256:…
        // &links-source=oci://…`), the daemon fetches it, checks the hash and
        // shows the consent card with its origin; without them the demo adds
        // the example's bytes itself.
        void mountLinks(transport, grant, editor, linksMount, {
            provider: params.get("links-provider") ?? undefined,
            source: params.get("links-source") ?? undefined,
        }).catch((e) => console.warn("links unavailable:", e));

        setStatus(`editing ${filepath} via ${transport.kind} — autosaving to the host`);
    } catch (e) {
        console.error(e);
        setStatus(`failed: ${e}`, true);
    }
}

/** The backlinks panel under the outline: what links to the open note, the
 *  dangling links in the vault, and a rename that rewrites every link. */
async function mountLinks(
    transport: Transport,
    fsGrant: string,
    editor: MarkdownEditor,
    mount: HTMLElement,
    named: { provider?: string; source?: string },
): Promise<void> {
    let provider = named.provider;
    if (!provider) {
        const wasm = new Uint8Array(await (await fetch("/fixtures/links.wasm")).arrayBuffer());
        const added = await addComponent(transport, wasm, undefined);
        if (added.tag !== "ok") throw new Error(added.val);
        provider = added.val.hash;
    }
    const token = await requestLinksGrant(transport, {
        provider,
        source: named.source,
        filesystemGrant: fsGrant,
        reason: "show which notes link to the one you are editing",
    });
    const index: LinksIndex = await openLinks(transport, token);
    const persistence = editor.storage.persistence as { options: { filepath?: string }; loadFile: (path: string) => Promise<void> };
    const title = el("div", "mac-links-title", "Links");
    const list = el("ul", "mac-links-list");
    const dangling = el("div", "mac-links-dangling");
    mount.replaceChildren(title, list, dangling);
    let current = "";
    const render = async () => {
        const path = persistence.options.filepath ?? "";
        const [into, unresolved] = await Promise.all([index.backlinks(path), index.unresolved()]);
        current = path;
        list.replaceChildren(
            ...(into.length === 0 ? [el("li", "mac-links-empty", "nothing links here yet")] : []),
            ...into.map((l) => {
                const li = el("li", "mac-links-item");
                const a = el("a", "mac-links-link", `${l.source}:${l.line}`);
                a.setAttribute("href", "#");
                a.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    void persistence.loadFile(l.source).then(render);
                });
                li.append(a);
                return li;
            }),
        );
        const mine = unresolved.filter((l) => l.source === path);
        dangling.textContent = mine.length === 0 ? "" : `${mine.length} link${mine.length === 1 ? "" : "s"} in this note point nowhere: ${mine.map((l) => l.target).join(", ")}`;
    };
    const rename = el("button", "mac-links-rename", "rename this note…");
    rename.addEventListener("click", async () => {
        const to = prompt("New path for this note (links to it are rewritten):", current);
        if (!to || to === current) return;
        try {
            const n = await index.rename(current, to);
            await persistence.loadFile(to);
            await render();
            console.info(`renamed ${current} → ${to}, rewrote ${n} link(s)`);
        } catch (e) {
            alert(`rename refused: ${e}`);
        }
    });
    mount.append(rename);
    await render();
    // The note may change under us (autosave, another page): re-read every few seconds.
    setInterval(() => void render().catch(() => {}), 4000);
    editor.on("update", () => void 0);
}