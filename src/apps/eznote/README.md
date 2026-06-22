# eznote

A fast Markdown scratch pad built on [`@joinezco/markdown-editor`](../../typescript/markdown-editor),
Tauri, and Solid.

The editor fills the window; the file-search toolbar and a light/system/dark
theme toggle live in the titlebar. Notes are real files on disk in
`~/Documents/eznote/`, autosaved as you type.

## Develop

```sh
pnpm install
pnpm --filter eznote tauri dev    # native app (first run cold-compiles Rust)
# or, frontend only (fs/hotkey are no-ops without the Tauri runtime):
pnpm --filter eznote dev          # http://localhost:1420
```

If the editor's chrome looks out of date, rebuild the library it consumes:

```sh
pnpm --filter @joinezco/markdown-editor build
```

## Scratch-pad shortcut

While eznote is running (it stays resident — closing the window hides it rather
than quitting), press **⌥⌘N** (`Option`+`Cmd`+`N`) anywhere to summon the window
and open a fresh untitled note. Change the binding in `src/App.tsx`
(`SCRATCH_SHORTCUT`).

### Launching eznote from cold with a system key

A Tauri global shortcut only fires while the app's process is running. To bind a
system-wide key that *launches* eznote when it isn't running, use macOS
**Shortcuts** (or Automator):

1. Open **Shortcuts.app** → **+** for a new shortcut.
2. Add the **Run Shell Script** action with:
   ```sh
   open -a eznote
   ```
   (or `open -a /Applications/eznote.app`).
3. **Shortcut Details → Add Keyboard Shortcut**, and assign your key (e.g.
   `⌃⌥⌘N`).

Now that key launches eznote if it's closed; once it's open, **⌥⌘N** spins up new
scratch notes. (Because the app is resident, after the first launch the in-app
hotkey alone is usually enough.)

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
