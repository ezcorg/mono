import { useEffect, useRef, useState } from 'react';
import { createEditor, MarkdownEditor } from './lib/editor';
import { browserVfs } from '@joinezco/storage/browser';
import { Vault } from '@joinezco/vault';
import '../fonts/source-serif-4.css'
import './App.css'
import { file } from './example';

/** Where the window's width is kept between reloads. */
const WIDTH_KEY = 'ezco-demo-window-width';
const MIN_WIDTH = 480;

/** The window's width in the reader's hands: dragged by either edge
 *  (centred, so the other edge mirrors it), kept across reloads, and given
 *  back to the page's full width by a double-click on an edge. */
function useResizableWidth() {
  const [width, setWidth] = useState<number | null>(() => {
    const kept = Number(localStorage.getItem(WIDTH_KEY));
    return kept >= MIN_WIDTH ? kept : null;
  });
  const [held, setHeld] = useState<'left' | 'right' | null>(null);

  useEffect(() => {
    if (width === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  }, [width]);

  const grab = (side: 'left' | 'right') => (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const window_ = target.parentElement!;
    const page = window_.parentElement!;
    const start = window_.getBoundingClientRect().width;
    const most = page.getBoundingClientRect().width;
    const x0 = e.clientX;
    target.setPointerCapture(e.pointerId);
    setHeld(side);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) * (side === 'right' ? 2 : -2);
      setWidth(Math.round(Math.max(MIN_WIDTH, Math.min(most, start + dx))));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      setHeld(null);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
    e.preventDefault();
  };

  return { width, held, grab, reset: () => setWidth(null) };
}

/** A simulated macOS window — the editor renders inside it as the
 *  fullscreen input component. The library's file-search toolbar is
 *  mounted into the titlebar (in place of a window title) via
 *  `toolbarMountRef`. */
function MacWindow({
  toolbarMountRef,
  titlebarExtra,
  size,
  children,
}: {
  toolbarMountRef: React.Ref<HTMLDivElement>;
  titlebarExtra?: React.ReactNode;
  size: ReturnType<typeof useResizableWidth>;
  children: React.ReactNode;
}) {
  const edge = (side: 'left' | 'right') => (
    <div
      className={`mac-resize mac-resize--${side}${size.held === side ? ' is-held' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the window"
      title="Drag to resize; double-click for the full width"
      onPointerDown={size.grab(side)}
      onDoubleClick={size.reset}
    />
  );
  return (
    <div
      className="mac-window"
      style={size.width === null ? undefined : ({ '--mac-window-width': `${size.width}px` } as React.CSSProperties)}
    >
      {edge('left')}
      {edge('right')}
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

/** Where the demo notes which seeds it wrote last. */
const SEEDS_KEY = 'ezco-demo-seeds';

/** A short hash of `text` (FNV-1a), to tell the seeds apart. */
function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${h.toString(16)}:${text.length}`;
}

function App() {
  const [markdownContent, setMarkdownContent] = useState('');
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const size = useResizableWidth();
  const editorBodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MarkdownEditor | null>(null);
  const toolbarMountRef = useRef<HTMLDivElement>(null);

  // The demo's files (the package's own source, as a snapshot) as a vault:
  // one index behind the palette's search, wikilinks, backlinks and renames.
  async function loadVault() {
    return new Vault(await browserVfs('codeblock', { snapshot: '/snapshot.bin' }), { identity: 'theo' });
  }

  // Create the editor once.
  useEffect(() => {
    let cancelled = false;
    let ed: MarkdownEditor | null = null;

    loadVault().then(async (vault) => {
      if (cancelled || !editorBodyRef.current) return;
      const { fs } = vault;
      // The demo's own files: the note, a comment on it (a document
      // referencing a passage of it) with a reply, and a non-Markdown file
      // the titlebar search can open (code files render as one codeblock,
      // and round-trip back to raw .ts on edit). Written once, and again
      // only when they change here (or are gone), so that edits made in the
      // demo stay across reloads, as the snapshot's do.
      const seeds: [string, string][] = [
        ['test.md', file],
        ['comments/test/alice 2026-09-23 10.05.md', '![[test#:~:text=travels%20with%20the%20file]]\n\nEven to tools that know nothing of comments: they show a quoted passage and a link.\n'],
        ['comments/test/theo 2026-09-23 10.06.md', '![[comments/test/alice 2026-09-23 10.05#:~:text=they%20show%20a%20quoted%20passage]]\n\nAnd the version log keeps its history.\n'],
        ['example.ts', exampleTs],
      ];
      const stamp = hashOf(seeds.map(([path, content]) => `${path}\0${content}`).join('\n'));
      if (localStorage.getItem(SEEDS_KEY) !== stamp || !(await fs.exists('test.md'))) {
        await fs.mkdir('comments/test', { recursive: true });
        for (const [path, content] of seeds) await fs.writeFile(path, content);
        localStorage.setItem(SEEDS_KEY, stamp);
      }
      if (cancelled) return;

      ed = createEditor({
        element: editorBodyRef.current,
        fs: { fs, filepath: 'test.md', autoSave: true },
        links: { resolver: vault.links, index: vault.links },
        search: vault.search,
        files: vault.files,
        // Mount the file-search toolbar into the window titlebar (in place of
        // a title) and keep it always visible there, instead of the default
        // floating auto-hiding pill. `.mac-titlebar-search` retheme lives in
        // App.css.
        toolbar: {
          filepath: 'test.md',
          mount: () => toolbarMountRef.current,
          autoHide: false,
          className: 'mac-titlebar-search',
        },
        // The vault's files and the document's outline, in the editor's own
        // column beside the note (the rail), so they sit against the text.
        fileTree: {},
        sidebar: { title: 'Document' },
        // Unnamed fences get a stand-in file in the demo's own vault.
        codeblock: { standIns: true },
        // Threads in the note, and in other notes of the vault, in the margin.
        comments: { author: 'theo', index: vault.comments, reactions: vault.reactions },
        // The reader's settings, as files in the demo's vault (`.settings/theo/`),
        // with a scope for this editor instance.
        settings: { instance: 'demo' },
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
    <div className={`dev-page${size.held ? ' is-resizing' : ''}`}>
      <header className="dev-header">
        <div className="dev-title">
          <code>@joinezco/markdown-editor</code>
          <span className="dev-subtitle">live preview</span>
        </div>
      </header>

      <MacWindow
        toolbarMountRef={toolbarMountRef}
        titlebarExtra={<ThemeToggle mode={themeMode} onChange={setThemeMode} />}
        size={size}
      >
        {/* .mac-body is the scroll container with a left gutter; the editor
            mounts into the inset .mac-editor so the block-action indicator
            (which sits to the left of the editor element) has room. The
            search toolbar lives up in the titlebar (see MacWindow). */}
        <div className="mac-body">
          {/* The editor owns the row inside: its rail (the outline, the file
              tree), the block-action gutter, the note and the comments. */}
          <div className="mac-editor" ref={editorBodyRef} />
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
