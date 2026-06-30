import { Node, mergeAttributes } from "@tiptap/core";
import type { TerminalHandle } from "./wrpc";

/** Renders a live terminal into `container`, driven by `handle`. Returns cleanup.
 *  Injected so this node stays free of any specific terminal UI (the default is
 *  the xterm.js renderer in `./xterm-view`). */
export type MountTerminal = (container: HTMLElement, handle: TerminalHandle) => () => void;

export interface TerminalBlockOptions {
  /** Open a terminal for a request. You supply the connection (URL + PIN) —
   *  e.g. `(req) => openTerminal({ url, pin, request: req })`. */
  open: (request: { shell?: string; cols: number; rows: number }) => Promise<TerminalHandle>;
  /** Render the live terminal. */
  mount: MountTerminal;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    terminalBlock: {
      /** Insert a live terminal block at the selection. */
      insertTerminal: (attrs?: { shell?: string }) => ReturnType;
    };
  }
}

/**
 * A TipTap node that renders a **live terminal** inline — the markdown-editor
 * codeblock integration. It's an atom (ProseMirror doesn't manage its insides);
 * the NodeView opens a NoCap terminal via `options.open` and hands it to
 * `options.mount`. Round-trips to a ```terminal fence on save.
 *
 * Wire it into the editor with the connection you choose:
 *
 *   createEditor({ extensions: [ createXtermTerminalBlock({
 *     open: (req) => openTerminal({ url, pin, request: req }),
 *   }) ] })
 */
export const createTerminalBlock = (options: TerminalBlockOptions) =>
  Node.create<TerminalBlockOptions>({
    name: "terminalBlock",
    group: "block",
    atom: true,
    selectable: true,

    addOptions() {
      return options;
    },

    addAttributes() {
      return {
        shell: { default: null as string | null },
      };
    },

    parseHTML() {
      return [{ tag: "div[data-terminal]" }];
    },

    renderHTML({ HTMLAttributes }) {
      return ["div", mergeAttributes(HTMLAttributes, { "data-terminal": "" })];
    },

    addCommands() {
      return {
        insertTerminal:
          (attrs) =>
          ({ commands }) =>
            commands.insertContent({ type: this.name, attrs: attrs ?? {} }),
      };
    },

    addStorage() {
      return {
        // Round-trip as a fenced ```terminal block. (Parsing that fence back
        // into this node — vs the plain codeblock — is a markdown-it rule the
        // host adds; see README. Inserted-in-session terminals work regardless.)
        markdown: {
          serialize(state: any, node: any) {
            const info = node.attrs.shell ? `terminal ${node.attrs.shell}` : "terminal";
            state.write("```" + info + "\n```");
            state.closeBlock(node);
          },
        },
      };
    },

    addNodeView() {
      const { open, mount } = this.options;
      return ({ node }) => {
        const dom = document.createElement("div");
        dom.className = "ezco-terminal-block";
        dom.contentEditable = "false";
        dom.style.cssText = "border-radius:8px;overflow:hidden;background:#1e1e1e;";

        const status = document.createElement("div");
        status.className = "ezco-terminal-status";
        status.style.cssText = "padding:8px 10px;font:12px/1.4 ui-monospace,Menlo,monospace;color:#9aa;";
        status.textContent = "starting terminal…";
        dom.appendChild(status);

        const surface = document.createElement("div");
        surface.className = "ezco-terminal-surface";
        surface.style.cssText = "min-height:240px;padding:4px 6px;";
        dom.appendChild(surface);

        let cleanup: (() => void) | null = null;
        const shell = (node.attrs.shell as string | null) ?? undefined;
        open({ shell, cols: 80, rows: 24 })
          .then((handle) => {
            status.remove();
            cleanup = mount(surface, handle);
          })
          .catch((e: unknown) => {
            status.textContent = String(e);
            status.style.color = "#e57";
          });

        return {
          dom,
          // Atom: ProseMirror must not touch the terminal's DOM.
          ignoreMutation: () => true,
          destroy() {
            cleanup?.();
          },
        };
      };
    },
  });
