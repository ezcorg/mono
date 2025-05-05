import { useState } from 'react';
import MarkdownEditor from './components/editor'; // Adjust path

const initialMarkdown = `
# @ezcodelol/richtext

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

  const handleContentChange = (newMarkdown: string) => {
    setMarkdownContent(newMarkdown);
    // You can now save this markdown content, send it to an API, etc.
    console.log("Markdown updated in App:", newMarkdown);
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: 'auto' }}>
      <MarkdownEditor
        initialContent={markdownContent}
        onChange={handleContentChange}
      />
      <hr style={{ margin: '20px 0' }} />
      <h2>Live Markdown Output:</h2>
      <pre style={{ whiteSpace: 'pre-wrap', background: '#eee', padding: '10px', border: '1px solid #ccc' }}>
        {markdownContent}
      </pre>
    </div>
  );
}

export default App;