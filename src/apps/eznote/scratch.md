Examine `src/apps/eznote` (a work-in-progress Tauri-based notes app), and the related libraries it consumes (`src/typescript/markdown-editor`), to work on the following:

* Fix the sizing of the markdown editor within the application so that the editor takes up all available space
* (if possible) have the app create a built-in system keyboard shortcut (or provide instructions to do so) for opening the `eznote` application to an initially untitled Markdown file (the idea being to have the ability to very quickly open a Markdown scratch pad).
* (if not already the case) ensure that `markdown-editor` is passed a reference to the host filesystem through an object which implements the necessary `fs` API it requires.
* Examine the demo in `~/dev/mono/src/typescript/markdown-editor` and copy the styling of the demo component (as much as possible, including the search toolbar + theme toggle being located in the application titlebar), using the same font as the "custom" variant