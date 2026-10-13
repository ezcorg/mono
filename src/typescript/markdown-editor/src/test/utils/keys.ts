import type { MarkdownEditor } from '../../lib/editor'

/** Keys as `userEvent.keyboard` and the keymap take them. */

/** The platform's Mod: ⌘ on a Mac, Ctrl elsewhere, as ProseMirror resolves `Mod-`. */
export const MOD = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? 'Meta' : 'Control'

/** `keys` with Mod held: `mod('{Shift>}e{/Shift}')` is ⌘⇧E on a Mac, Ctrl+Shift+E elsewhere. */
export const mod = (keys: string) => `{${MOD}>}${keys}{/${MOD}}`

/**
 * Simulates key press in the editor
 */
export function pressKey(editor: MarkdownEditor, key: string, modifiers: { ctrl?: boolean, shift?: boolean, alt?: boolean } = {}): void {
    // `ctrl` here means the platform "Mod" key the editor's shortcuts bind to.
    // ProseMirror maps `Mod-*` to Cmd (metaKey) on macOS and Ctrl elsewhere, so
    // a hardcoded `ctrlKey` never matches the keymap on a Mac. Route the modifier
    // to the right key for the platform the test happens to run on.
    const isMac = MOD === 'Meta'
    const event = new KeyboardEvent('keydown', {
        key,
        ctrlKey: (modifiers.ctrl && !isMac) || false,
        metaKey: (modifiers.ctrl && isMac) || false,
        shiftKey: modifiers.shift || false,
        altKey: modifiers.alt || false,
        bubbles: true,
        cancelable: true,
    })

    editor.view.dom.dispatchEvent(event)
}
