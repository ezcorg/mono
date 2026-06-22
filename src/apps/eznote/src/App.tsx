import { For, createSignal, onCleanup, onMount } from "solid-js";
import { createEditor, type MarkdownEditor } from "@joinezco/markdown-editor";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import {
  createTauriVfs,
  ensureNotesDir,
  latestNotePath,
  newScratchPath,
  type HostVfs,
} from "./lib/tauri-vfs";
import "./App.css";

/** System-wide hotkey that summons the window and opens a fresh scratch note. */
const SCRATCH_SHORTCUT = "CommandOrControl+Alt+N";

type ThemeMode = "light" | "system" | "dark";

const THEME_OPTIONS: { mode: ThemeMode; glyph: string; label: string }[] = [
  { mode: "light", glyph: "☀", label: "Light" },
  { mode: "system", glyph: "◐", label: "System" },
  { mode: "dark", glyph: "☾", label: "Dark" },
];

/** Whether `mode` should render dark right now. */
function isDark(mode: ThemeMode): boolean {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return mode === "dark";
}

/** Light / system / dark segmented control for the titlebar. */
function ThemeToggle(props: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  return (
    <div class="theme-toggle" role="radiogroup" aria-label="Color theme">
      <For each={THEME_OPTIONS}>
        {(opt) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.mode === opt.mode}
            aria-label={opt.label}
            title={opt.label}
            classList={{ "is-active": props.mode === opt.mode }}
            onClick={() => props.onChange(opt.mode)}
          >
            <span aria-hidden="true">{opt.glyph}</span>
          </button>
        )}
      </For>
    </div>
  );
}

function App() {
  let editorHost!: HTMLDivElement;
  let titlebarToolbar!: HTMLDivElement;
  let editor: MarkdownEditor | null = null;
  let fs: HostVfs | null = null;

  const stored = (localStorage.getItem("eznote-theme") as ThemeMode | null) ?? "system";
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(stored);

  /** Drive the editor's light/dark theme from a `data-theme` on the root
   *  element (the markdown-editor's CSS variables key off it; `system` removes
   *  it so the OS preference wins) and re-theme already-mounted codeblocks. */
  function applyTheme(mode: ThemeMode) {
    const root = document.documentElement;
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    localStorage.setItem("eznote-theme", mode);
    try {
      editor?.commands.setCodeblockTheme({ dark: isDark(mode) });
    } catch {
      /* command only exists once codeblocks are present */
    }
  }

  function changeTheme(mode: ThemeMode) {
    setThemeMode(mode);
    applyTheme(mode);
  }

  /** Open a brand-new untitled note (used by the global hotkey). */
  async function newScratch() {
    if (!editor || !fs) return;
    const persistence = (editor.storage as any).persistence;
    persistence?.flushPendingSave?.();
    const path = newScratchPath();
    await fs.writeFile(path, "");
    if (persistence?.loadFile) await persistence.loadFile(path);
    editor.commands.focus("end");
  }

  onMount(async () => {
    // Apply the persisted theme immediately so first paint is correct.
    applyTheme(themeMode());

    const base = await ensureNotesDir();
    fs = createTauriVfs(base);

    // Reopen the most recent note on launch, else start a fresh scratch.
    const filepath = (await latestNotePath(fs)) ?? newScratchPath();
    if (!(await fs.exists(filepath))) await fs.writeFile(filepath, "");

    editor = createEditor({
      element: editorHost,
      fs: { fs, filepath, autoSave: true },
      // Mount the file-search toolbar into the titlebar (in place of a window
      // title) and keep it always visible there. `.mac-titlebar-search`
      // retheme lives in App.css.
      toolbar: {
        fs,
        filepath,
        mount: () => titlebarToolbar,
        autoHide: false,
        className: "mac-titlebar-search",
      },
      onUpdate: () => {},
    });
    applyTheme(themeMode());
    // Expose for manual debugging / inspection.
    (window as unknown as { editor?: MarkdownEditor }).editor = editor;

    // Register the system-wide "new scratch pad" hotkey. Works whenever the
    // app is resident (the window hides instead of quitting on close), so the
    // hotkey can always summon it.
    try {
      await register(SCRATCH_SHORTCUT, async (event) => {
        // plugin-global-shortcut v2 fires for both press and release.
        if (event?.state && event.state !== "Pressed") return;
        const win = getCurrentWindow();
        await win.show();
        await win.unminimize();
        await win.setFocus();
        await newScratch();
      });
    } catch (e) {
      console.warn("[eznote] Failed to register global shortcut:", e);
    }
  });

  onCleanup(() => {
    unregister(SCRATCH_SHORTCUT).catch(() => {});
    editor?.destroy();
    editor = null;
  });

  return (
    <div class="app">
      <div class="titlebar" data-tauri-drag-region>
        {/* Reserve room for the native macOS traffic lights (drawn by the OS
            over the webview via titleBarStyle: Overlay). */}
        <span class="titlebar-lights-spacer" data-tauri-drag-region aria-hidden="true" />
        {/* The file-search toolbar mounts here (replacing the window title). */}
        <div class="titlebar-toolbar" ref={titlebarToolbar} />
        <ThemeToggle mode={themeMode()} onChange={changeTheme} />
      </div>

      {/* The scroll container — takes all remaining vertical space. The editor
          mounts into the inset host so the block-action indicator (which sits
          to the left of the editor element) has room. */}
      <div class="body">
        <div class="editor-host" ref={editorHost} />
      </div>
    </div>
  );
}

export default App;
