import { useEffect, useRef, useState } from 'react';
import { createEditor, MarkdownEditor } from './lib/editor';
import { CodeblockFS, SearchIndex } from '@joinezco/codeblock';
import './App.css'
import { file } from './test/example';

type Variant = 'custom' | 'default';

/** A simulated macOS window — the editor renders inside it as the
 *  fullscreen input component. The variant drives the chrome's styling. */
function MacWindow({
  variant,
  title,
  children,
}: {
  variant: Variant;
  title: string;
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
        <span className="mac-title">{title}</span>
      </div>
      {children}
    </div>
  );
}

function App() {
  const [markdownContent, setMarkdownContent] = useState('');
  const [variant, setVariant] = useState<Variant>('default');
  const editorBodyRef = useRef<HTMLDivElement>(null);
  const toolbarSlotRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MarkdownEditor | null>(null);

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
      if (cancelled || !editorBodyRef.current || !toolbarSlotRef.current) return;
      await fs.writeFile('test.md', file);
      if (cancelled) return;

      ed = createEditor({
        element: editorBodyRef.current,
        fs: { fs, filepath: 'test.md', autoSave: false },
        // Render the toolbar into a dedicated slot above the editor body,
        // outside the editor element itself.
        toolbar: { fs, index, filepath: 'test.md', mount: toolbarSlotRef.current },
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

      <MacWindow variant={variant} title="Hello World">
        <div className="mac-toolbar-slot" ref={toolbarSlotRef} />
        {/* .mac-body is the scroll container with a left gutter; the editor
            mounts into the inset .mac-editor so the block-action indicator
            (which sits to the left of the editor element) has room. */}
        <div className="mac-body">
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
