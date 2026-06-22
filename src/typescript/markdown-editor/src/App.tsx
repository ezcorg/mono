import { useEffect, useRef, useState } from 'react';
import { createEditor, MarkdownEditor } from './lib/editor';
import { CodeblockFS, SearchIndex } from '@joinezco/codeblock';
import './App.css'
import { file } from './example';

type Variant = 'custom' | 'default';

/** A simulated macOS window — the editor renders inside it as the
 *  fullscreen input component. The variant drives the chrome's styling.
 *  The library's file-search toolbar is mounted into the titlebar (in place
 *  of a window title) via `toolbarMountRef`. */
function MacWindow({
  variant,
  toolbarMountRef,
  titlebarExtra,
  children,
}: {
  variant: Variant;
  toolbarMountRef: React.Ref<HTMLDivElement>;
  titlebarExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`mac-window mac-window--${variant}`}>
      <div className="mac-titlebar">
        <span className="mac-lights" aria-hidden="true">
          <span className="mac-light mac-light--close" />
          <span className="mac-light mac-light--min" />
          <span className="mac-light mac-light--max" />
        </span>
        {/* The search toolbar mounts here (replacing the window title) —
            see the createEditor `toolbar.mount` below. */}
        <div className="mac-titlebar-toolbar" ref={toolbarMountRef} />
        {titlebarExtra}
      </div>
      {children}
    </div>
  );
}

type ThemeMode = 'light' | 'dark' | 'system';

/** Resolve whether `mode` should render dark right now. */
function isDark(mode: ThemeMode): boolean {
  if (mode === 'system') {
    return typeof window !== 'undefined'
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return mode === 'dark';
}

const THEME_OPTIONS: { mode: ThemeMode; glyph: string; label: string }[] = [
  { mode: 'light', glyph: '☀', label: 'Light' },
  { mode: 'system', glyph: '◐', label: 'System' },
  { mode: 'dark', glyph: '☾', label: 'Dark' },
];

/** A light / system / dark segmented control for the titlebar. */
function ThemeToggle({
  mode,
  onChange,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Color theme">
      {THEME_OPTIONS.map(({ mode: m, glyph, label }) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          aria-label={label}
          title={label}
          className={mode === m ? 'is-active' : ''}
          onClick={() => onChange(m)}
        >
          <span aria-hidden="true">{glyph}</span>
        </button>
      ))}
    </div>
  );
}

// A small non-Markdown file the demo seeds into the VFS, to show that opening
// it renders as a single syntax-highlighted codeblock rather than parsed prose.
const exampleTs = `// example.ts — opened as a single syntax-highlighted codeblock,
// not parsed as Markdown. Edits autosave back to disk as raw .ts.
export interface Note {
  id: string;
  title: string;
  body: string;
}

export function wordCount(text: string): number {
  return text.split(/\\s+/).filter(Boolean).length;
}

const notes: Note[] = [];
`;

function App() {
  const [markdownContent, setMarkdownContent] = useState('');
  const [variant, setVariant] = useState<Variant>('default');
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const editorBodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MarkdownEditor | null>(null);
  const toolbarMountRef = useRef<HTMLDivElement>(null);
  const sidebarMountRef = useRef<HTMLDivElement>(null);
  const blockActionMountRef = useRef<HTMLDivElement>(null);

  async function loadFs() {
    const fs = await CodeblockFS.worker('/snapshot.bin');
    let index: SearchIndex | undefined;
    try {
      index = await SearchIndex.get(fs, '.codeblock/index.json');
    } catch (error) {
      console.warn('Failed to create search index:', error);
    }
    return { fs, index };
  }

  // Create the editor once. The custom/default distinction is purely
  // presentational (CSS scoped to the window's variant class), so toggling
  // variants doesn't recreate the editor.
  useEffect(() => {
    let cancelled = false;
    let ed: MarkdownEditor | null = null;

    loadFs().then(async ({ fs, index }) => {
      if (cancelled || !editorBodyRef.current) return;
      await fs.writeFile('test.md', file);
      // Seed a non-Markdown file so the titlebar search can open it and show
      // the "code files render as a single codeblock" behavior (and round-trip
      // back to raw .ts on edit).
      await fs.writeFile('example.ts', exampleTs);
      if (cancelled) return;

      ed = createEditor({
        element: editorBodyRef.current,
        fs: { fs, filepath: 'test.md', autoSave: true },
        // Mount the file-search toolbar into the window titlebar (in place of
        // a title) and keep it always visible there, instead of the default
        // floating auto-hiding pill. `.mac-titlebar-search` retheme lives in
        // App.css.
        toolbar: {
          fs,
          index,
          filepath: 'test.md',
          mount: () => toolbarMountRef.current,
          autoHide: false,
          className: 'mac-titlebar-search',
        },
        // Auto-generated document outline, mounted into the window's left column.
        sidebar: {
          mount: () => sidebarMountRef.current,
          title: 'Outline',
        },
        // The block-action indicator gets its own dedicated column (between the
        // outline and the editor) so it never overlaps the sidebar.
        blockActions: {
          mount: () => blockActionMountRef.current,
        },
        onUpdate: ({ editor }) => {
          setMarkdownContent((editor as MarkdownEditor).storage.markdown.getMarkdown());
        },
      });
      editorRef.current = ed;
      // Expose for manual debugging / inspection in the dev preview.
      (window as unknown as { editor?: MarkdownEditor }).editor = ed;
    });

    return () => {
      cancelled = true;
      ed?.destroy();
      editorRef.current = null;
    };
  }, []);

  // Drive the editor's light/dark theme from the titlebar toggle. A
  // `data-theme` on the root element flips the markdown-editor's CSS
  // variables and is read by embedded codeblocks; `system` removes it so the
  // OS `prefers-color-scheme` wins (and the codeblocks' own OS listener keeps
  // them in step). `setCodeblockTheme` re-themes already-mounted codeblocks.
  useEffect(() => {
    const root = document.documentElement;
    if (themeMode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', themeMode);
    editorRef.current?.commands.setCodeblockTheme({ dark: isDark(themeMode) });
  }, [themeMode]);

  return (
    <div className="dev-page">
      <header className="dev-header">
        <div className="dev-title">
          <code>@joinezco/markdown-editor</code>
          <span className="dev-subtitle">live preview</span>
        </div>
        <div className="variant-toggle" role="tablist" aria-label="Editor styling">
          <button
            role="tab"
            aria-selected={variant === 'custom'}
            className={variant === 'custom' ? 'is-active' : ''}
            onClick={() => setVariant('custom')}
          >
            Custom
          </button>
          <button
            role="tab"
            aria-selected={variant === 'default'}
            className={variant === 'default' ? 'is-active' : ''}
            onClick={() => setVariant('default')}
          >
            Default
          </button>
        </div>
      </header>

      <p className="dev-note">
        {variant === 'custom'
          ? 'A heavily-themed instance — how far the editor can be styled inside a native window.'
          : 'The unstyled, out-of-the-box editor.'}
      </p>

      <MacWindow
        variant={variant}
        toolbarMountRef={toolbarMountRef}
        titlebarExtra={<ThemeToggle mode={themeMode} onChange={setThemeMode} />}
      >
        {/* .mac-body is the scroll container with a left gutter; the editor
            mounts into the inset .mac-editor so the block-action indicator
            (which sits to the left of the editor element) has room. The
            search toolbar lives up in the titlebar (see MacWindow). */}
        <div className="mac-body">
          {/* A flex row INSIDE the scroller, so the sticky sidebar column spans
              the editor's full scroll height (a flex item placed directly in
              the scroller is clipped to one viewport and scrolls away). */}
          <div className="mac-body-row">
            <div className="mac-sidebar" ref={sidebarMountRef} />
            {/* Three columns: Sidebar | Block-action | Editor. The middle
                column reserves room for the indicator so nothing overlaps. */}
            <div className="mac-blockaction-col" ref={blockActionMountRef} />
            <div className="mac-editor" ref={editorBodyRef} />
          </div>
        </div>
      </MacWindow>

      <details className="dev-output">
        <summary>Live Markdown output</summary>
        <pre>{markdownContent}</pre>
      </details>
    </div>
  );
}

export default App;
