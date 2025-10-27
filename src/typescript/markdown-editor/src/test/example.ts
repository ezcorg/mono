export const file = `
# \`@joinezco/markdown-editor\`

This editor supports **Markdown** syntax.

## Features

### Bring-your-own-LLM

Use \`/settings\` to configure, \`ctrl + enter\` to trigger a completion

* [ ] \`TODO: actually use settings\`
* [ ] \`TODO: actually use llms\`
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