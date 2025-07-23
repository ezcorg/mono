import { useEffect, useRef, useState } from 'react';
import { createEditor, MarkdownEditor } from './components/editor';
import { CodeblockFS, SearchIndex } from '@ezdevlol/codeblock';

const initialMarkdown = `
# \`@ezdevlol/markdown-editor\`

This editor supports **Markdown** syntax.

## Features

### Bring-your-own-LLM

Use \`/settings\` to configure, \`ctrl + enter\` to trigger a completion

* [ ] \`TODO: actually use settings\`
* [ ] \`TODO: actually use llms\`

### The basics
- Paragraphs
- Headings
- *Italic* and **Bold** text
- \`Inline code\`
- Links (auto-detected google.com and [manual](https://google.com)

### Task Lists

- [x] Task 1 (Done)
- [ ] Task 2 (Pending)
  - [ ] Subtask 2.1
- [ ] Task 3

### Tables

| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |

 - [ ] \`TODO: fix pasting typical md syntax not producing tables\`

### Codeblocks

\`\`\`javascript
function greet(name) {
  console.log(\`Hello, \${name}!\`);
}

greet('World');
\`\`\`

- [ ] \`TODO: support registering/calling execution handlers for each file extension/mime\` (e.g. allowing to run files)

#### Language server support

Lazily-loaded language server support for Typescript/Javascript, Python, Rust, and Go.

\`\`\`python
def add(a, b):
  """Adds two numbers."""
  return a + b

print(add(5, 3))
\`\`\`


* [ ] \`TODO: support LSPs\`

  * [x] \`js/ts\`

  * [ ] \`python\`

  * [ ] \`rust\`

  * [ ] \`go\`


#### Virtual filesystem

Reference and change files in a document-local filesystem.

\`\`\`src/App.tsx
\`\`\`

Try editing the content!
`;

function App() {
  const [markdownContent, setMarkdownContent] = useState(initialMarkdown);
  const [editor, setEditor] = useState<MarkdownEditor | null>(null);
  const ref = useRef(null);

  async function loadFs() {
    const fs = await CodeblockFS.worker('/snapshot.bin');

    // Generate or load search index
    try {
      const index = await SearchIndex.get(fs, '.codeblock/index.json');
      console.log('Search index ready with', index, 'documents');
      // Attach the search index to the filesystem object so it can be accessed by the codeblock extension
      (fs as any).searchIndex = index;
    } catch (error) {
      console.warn('Failed to create search index:', error);
      // Set a null search index if creation fails
      (fs as any).searchIndex = null;
    }

    return fs;
  }

  useEffect(() => {

    let newEditor: MarkdownEditor | null = null;

    if (ref.current && !editor) {
      loadFs().then(fs => {
        console.debug('Loaded filesystem', fs);
        newEditor = createEditor({
          element: ref.current!,
          content: initialMarkdown,
          fs: {
            fs: fs,
            filepath: undefined,
            autoSave: false,
          },
          onUpdate: ({ editor }) => {
            const json = editor.getJSON();
            const markdown = (editor as MarkdownEditor).storage.markdown.getMarkdown();
            setMarkdownContent(markdown);
            console.log("Editor JSON:", json);
            console.log("Editor Markdown:", markdown);
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
      {/* <MarkdownEditor

        initialContent={markdownContent}
        onChange={handleContentChange}
      /> */}
      <hr style={{ margin: '20px 0' }} />
      <h2>Live Markdown Output:</h2>
      <pre style={{ whiteSpace: 'pre-wrap', background: '#eee', padding: '10px', border: '1px solid #ccc' }}>
        {markdownContent}
      </pre>
    </div>
  );
}

export default App;