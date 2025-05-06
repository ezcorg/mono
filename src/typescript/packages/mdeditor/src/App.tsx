import { useEffect, useRef, useState } from 'react';
import { createEditor, MarkdownEditor } from './components/editor';

const initialMarkdown = `
# @ezcodelol/mdeditor

This editor supports **Markdown** syntax.

## Features

- Paragraphs
- Headings
- *Italic* and **Bold** text
- \`Inline code\`
- Links (auto-detected): google.com

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

### Custom Code Block

\`\`\`javascript
function greet(name) {
  console.log(\`Hello, \${name}!\`);
}

greet('World');
\`\`\`

\`\`\`python
def add(a, b):
  """Adds two numbers."""
  return a + b

print(add(5, 3))
\`\`\`

Try editing the content!
`;

function App() {
  const [markdownContent, setMarkdownContent] = useState(initialMarkdown);
  const [editor, setEditor] = useState<MarkdownEditor | null>(null);
  const ref = useRef(null);

  useEffect(() => {

    let newEditor: MarkdownEditor | null = null;

    if (ref.current && !editor) {
      newEditor = createEditor({
        element: ref.current,
        content: initialMarkdown,
        onUpdate: ({ editor }) => {
          const json = editor.getJSON();
          const markdown = (editor as MarkdownEditor).storage.markdown.getMarkdown();
          setMarkdownContent(markdown);
          console.log("Editor JSON:", json);
          console.log("Editor Markdown:", markdown);
        },
      });
      setEditor(newEditor);
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