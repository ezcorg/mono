import { useEffect, useRef, useState } from 'react';
import { createEditor, MarkdownEditor } from './lib/editor';
import { CodeblockFS, SearchIndex } from '@joinezco/codeblock';
import './App.css'
import { file } from './test/example';

function App() {
  const [markdownContent, setMarkdownContent] = useState('');
  const [editor, setEditor] = useState<MarkdownEditor | null>(null);
  const ref = useRef(null);

  async function loadFs() {
    const fs = await CodeblockFS.worker('/snapshot.bin');

    // Generate or load search index
    try {
      const index = await SearchIndex.get(fs, '.codeblock/index.json');
      console.log('Search index ready with', index, 'documents');
    } catch (error) {
      console.warn('Failed to create search index:', error);
    }

    return fs;
  }

  useEffect(() => {

    let newEditor: MarkdownEditor | null = null;

    if (ref.current && !editor) {
      loadFs().then(async fs => {
        console.debug('Loaded filesystem', fs);

        await fs.writeFile('test.md', file);

        newEditor = createEditor({
          element: ref.current!,
          fs: {
            fs: fs,
            filepath: 'test.md',
            autoSave: false,
          },
          onUpdate: ({ editor }) => {
            const markdown = (editor as MarkdownEditor).storage.markdown.getMarkdown();
            setMarkdownContent(markdown);
          },
        });
        setEditor(newEditor);
      });
    }

    return () => {
      if (ref.current) {
        newEditor?.destroy();
      }
    };

  }, [ref.current])


  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: 'auto' }}>
      <div id='md-editor' ref={ref}></div>
      <hr style={{ margin: '20px 0' }} />
      <h2>Live Markdown Output:</h2>
      <pre style={{ whiteSpace: 'pre-wrap', background: '#eee', padding: '10px', border: '1px solid #ccc' }}>
        {markdownContent}
      </pre>
    </div>
  );
}

export default App;