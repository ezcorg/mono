import { userEvent } from '@vitest/browser/context'
import { waitFor } from './base'

/**
 * The chrome as a person reaches it: a button by its label, a menu's
 * items, a choice from a menu, focus in the note.
 */

/** The button labelled `label` (its `aria-label`, else its text) within `el`. */
export const tool = (el: ParentNode, label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent === label) as HTMLButtonElement

/**
 * The item of a `ContextMenu` (the block, selection and comment menus)
 * labelled `label` within `root`: its label span when it has one, else its
 * text's end (an item's text starts with its glyph). `undefined` when the
 * menu has no such item.
 */
export function menuItem(label: string, root: ParentNode = document): HTMLElement | undefined {
    return [...root.querySelectorAll<HTMLElement>('.ezco-mde-context-menu-item')].find((item) => {
        const own = item.querySelector('.ezco-mde-context-menu-item-label')?.textContent?.trim()
        return own !== undefined ? own === label : (item.textContent?.trim().endsWith(label) ?? false)
    })
}

/** The labels of a `ContextMenu`'s items within `root`, in order. */
export function menuLabels(root: ParentNode = document): string[] {
    return [...root.querySelectorAll<HTMLElement>('.ezco-mde-context-menu-item')].map(
        (item) => (item.querySelector('.ezco-mde-context-menu-item-label') ?? item).textContent?.trim() ?? '',
    )
}

/**
 * `label` chosen from the menu `trigger` opens (a `ContextMenu` matching
 * `menu`): the trigger pressed, the item pressed, the menu gone. A switch's
 * state (`aria-checked`) as it was before the choice, else null.
 */
export async function viaMenu(trigger: HTMLElement, label: string, menu = '.ezco-mde-context-menu'): Promise<string | null> {
    trigger.click()
    await waitFor(() => !!document.querySelector(menu), 2000)
    const root = document.querySelector(menu) as HTMLElement
    const item = menuItem(label, root)
    if (!item) throw new Error(`No "${label}" in the menu: ${menuLabels(root).join(', ')}`)
    const was = item.getAttribute('aria-checked')
    item.click()
    await waitFor(() => !document.querySelector(menu), 2000)
    return was
}

/** Real focus in the note, on its heading (nothing there follows a click). */
export async function focusNote(container: HTMLElement): Promise<void> {
    await userEvent.click(container.querySelector('.ezco-mde-body h1') as HTMLElement)
    await waitFor(() => document.activeElement === container.querySelector('.ProseMirror'), 2000)
}
