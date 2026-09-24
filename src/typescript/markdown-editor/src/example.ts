export const file = `
# \`@joinezco/markdown-editor\`

This editor supports **Markdown** syntax.

## Features

### Bring-your-own-LLM

Use \`/settings\` to configure, \`ctrl + enter\` to trigger a completion

&nbsp;

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

&nbsp;

- [ ] \`TODO: fix pasting typical md syntax not producing tables\`

### Codeblocks

\`\`\`javascript
function greet(name) {
  console.log(\`Hello, \${name}!\`);
}

greet('World');
\`\`\`

&nbsp;

- [ ] \`TODO: support registering/calling execution handlers for each file extension/mime\` (e.g. allowing to run files)

#### Language server support

Lazily-loaded language server support for Typescript/Javascript, Python, Rust, and Go.

&nbsp;

\`\`\`python
def add(a, b):
  """Adds two numbers."""
  return a + b

print(add(5, 3))
\`\`\`

&nbsp;

* [ ] \`TODO: support LSPs\`

  * [x] \`js/ts\`

  * [ ] \`python\`

  * [ ] \`rust\`

  * [ ] \`go\`


#### Virtual filesystem

Reference and change files in a document-local filesystem.

&nbsp;

\`\`\`src/App.tsx
\`\`\`

&nbsp;

Or only some of a file's lines, numbered as the file numbers them. Edits go back into the file where those lines are, even if they have moved since.

\`\`\`example.ts#L9-L11
\`\`\`

&nbsp;

### Comments

Select some text and choose **Comment** (or press ⌘⌥M) to start a thread beside it. A thread is a footnote in the note, so it travels with the file and reads as one anywhere else.

[^c-01K5DEMO00000001]: @theo 2026-09-23T10:00Z · open · [[#:~:text=travels%20with%20the%20file]]
    Even to tools that know nothing of comments: they show a footnote.
    - @alice 2026-09-23T10:05Z: And the version log keeps its history.
      - @theo 2026-09-23T10:06Z: 👍

&nbsp;

Try editing the content!
`;