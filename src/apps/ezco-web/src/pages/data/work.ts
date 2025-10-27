export const files = [
	['example.ts', `export const greet = (name: string) => {
	return \`Hello, \${name}!\`
};`],
	['hello.md', `# \`@joinezco/markdown-editor\`

## Usage

### Install
\`\`\`sh
pnpm i @joinezco/markdown-editor
\`\`\`

### Import

\`\`\`ts
import { createEditor } from '@joinezco/markdown-editor';
\`\`\`

## Features

### Lists

#### Bullets

* Paragraphs
* Headings
* *Italic* and **Bold** text
* \`Inline code\`
* Links (auto-detected [example.com](http://example.com) and [manual](https://google.com)

#### Ordered

1. \`todo:\` Emojis
2. 

#### Tasks

* [x] Task 1 (Done)

* [ ] Task 2 (Pending)

  * [ ] Subtask 2.1

* [ ] Task 3

### Tables

| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |

### Codeblocks

\`\`\`javascript
function greet(name) {
	console.log(\`Hello, \${name}!\`);
}

greet('World');
\`\`\`

#### Virtual filesystem

Reference and change files in a document-local filesystem.

\`\`\`example.ts
\`\`\`
`]
]