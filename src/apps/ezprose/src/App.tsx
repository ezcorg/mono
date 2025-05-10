import { createEffect, createSignal } from "solid-js";
import { createEditor, MarkdownEditor } from "@ezcodelol/markdown-editor";
import "./App.css";

function App() {
  const [editor, setEditor] = createSignal<MarkdownEditor | null>(null);

  console.debug({editor})

  createEffect(() => {
    const editor = createEditor({
      element: document.getElementById("editor")!
    });
    setEditor(editor);
  });

  return (
    <main class="container">
      <div id='editor'></div>
    </main>
  );
}

export default App;
