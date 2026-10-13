import { describe, it, expect, afterEach, vi } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { ContextMenu, type ContextMenuEntry } from './context-menu'
import { menuItem, menuLabels } from '../../../test/utils'

/**
 * The menu component on its own, driven by real keys and presses: what it
 * renders (items, a separator, a switch, a disabled item), where the focus
 * goes (first enabled item, arrows wrapping and skipping the disabled,
 * Home/End, a hover), what runs (Enter, Space, a click) and how it closes
 * (Escape, Tab). A letter typed moves nothing: the menu has no type-ahead.
 */
describe('ContextMenu', () => {
    const made: ContextMenu[] = []
    afterEach(() => {
        made.forEach((m) => m.destroy())
        made.length = 0
    })

    /** A menu of `entries` in the document, keys live, the first item focused. */
    function open(entries: ContextMenuEntry[], onClose?: (reason: 'escape' | 'tab') => void): ContextMenu {
        const menu = new ContextMenu({ items: entries, className: 'test-menu', onClose })
        document.body.append(menu.dom)
        menu.enable()
        menu.focus()
        made.push(menu)
        return menu
    }

    const focused = () => (document.activeElement as HTMLElement | null)?.querySelector('.ezco-mde-context-menu-item-label')?.textContent ?? null

    function items() {
        const ran: string[] = []
        const entries: ContextMenuEntry[] = [
            { label: 'Cut', icon: '✂', onSelect: () => ran.push('Cut') },
            { label: 'Copy', icon: '⎘', onSelect: () => ran.push('Copy') },
            { label: 'Paste', icon: '📋', disabled: true, onSelect: () => ran.push('Paste') },
            { type: 'separator' },
            { label: 'Wrap lines', checked: true, onSelect: () => ran.push('Wrap lines') },
            { label: 'Delete', icon: '✕', onSelect: () => ran.push('Delete') },
        ]
        return { ran, entries }
    }

    it('renders items as menuitems (glyph then label), a separator, a disabled item and a checked switch', () => {
        const { entries } = items()
        const menu = open(entries)
        expect(menu.dom.getAttribute('role')).toBe('menu')
        expect(menu.dom.classList.contains('ezco-mde-context-menu')).toBe(true)
        expect(menu.dom.classList.contains('test-menu')).toBe(true)
        expect(menuLabels(menu.dom)).toEqual(['Cut', 'Copy', 'Paste', 'Wrap lines', 'Delete'])
        const cut = menuItem('Cut', menu.dom)!
        expect(cut.tagName).toBe('BUTTON')
        expect((cut as HTMLButtonElement).type).toBe('button')
        expect(cut.getAttribute('role')).toBe('menuitem')
        expect(cut.firstElementChild?.className).toBe('ezco-mde-context-menu-item-icon')
        expect(cut.firstElementChild?.textContent).toBe('✂')
        expect(cut.lastElementChild?.className).toBe('ezco-mde-context-menu-item-label')
        // The separator stands between the groups, as a separator.
        const separator = menu.dom.querySelector('.ezco-mde-context-menu-separator')!
        expect(separator.getAttribute('role')).toBe('separator')
        expect(separator.previousElementSibling).toBe(menuItem('Paste', menu.dom))
        expect(separator.nextElementSibling).toBe(menuItem('Wrap lines', menu.dom))
        // A disabled item is disabled for the pointer and the screen reader.
        const paste = menuItem('Paste', menu.dom) as HTMLButtonElement
        expect(paste.disabled).toBe(true)
        expect(paste.getAttribute('aria-disabled')).toBe('true')
        // A setting is a checkbox item with a switch drawn at its end.
        const wrap = menuItem('Wrap lines', menu.dom)!
        expect(wrap.getAttribute('role')).toBe('menuitemcheckbox')
        expect(wrap.getAttribute('aria-checked')).toBe('true')
        expect(wrap.lastElementChild?.className).toBe('ezco-mde-context-menu-switch')
        expect(wrap.lastElementChild?.getAttribute('aria-hidden')).toBe('true')
        expect(wrap.querySelector('.ezco-mde-context-menu-item-icon')).toBeNull()
        const off = open([{ label: 'Off', checked: false, onSelect: () => {} }])
        expect(menuItem('Off', off.dom)?.getAttribute('aria-checked')).toBe('false')
    })

    it('focuses the first enabled item, and only that one is in the tab order', () => {
        const { entries } = items()
        const menu = open(entries)
        expect(focused()).toBe('Cut')
        expect(menuItem('Cut', menu.dom)?.tabIndex).toBe(0)
        expect(menuItem('Copy', menu.dom)?.tabIndex).toBe(-1)
        // A first item that is disabled is skipped.
        const skipping = open([{ label: 'Gone', disabled: true, onSelect: () => {} }, { label: 'Here', onSelect: () => {} }])
        expect(focused()).toBe('Here')
        expect(menuItem('Here', skipping.dom)?.tabIndex).toBe(0)
        expect(menuItem('Gone', skipping.dom)?.tabIndex).toBe(-1)
    })

    it('moves with the arrows, skipping the disabled item and wrapping at the ends; Home and End jump', async () => {
        const { entries } = items()
        open(entries)
        await userEvent.keyboard('{ArrowDown}')
        expect(focused()).toBe('Copy')
        // Paste is disabled: the arrow goes past it.
        await userEvent.keyboard('{ArrowDown}')
        expect(focused()).toBe('Wrap lines')
        await userEvent.keyboard('{ArrowDown}')
        expect(focused()).toBe('Delete')
        await userEvent.keyboard('{ArrowDown}')
        expect(focused()).toBe('Cut')
        await userEvent.keyboard('{ArrowUp}')
        expect(focused()).toBe('Delete')
        await userEvent.keyboard('{ArrowUp}{ArrowUp}')
        expect(focused()).toBe('Copy')
        await userEvent.keyboard('{Home}')
        expect(focused()).toBe('Cut')
        await userEvent.keyboard('{End}')
        expect(focused()).toBe('Delete')
        // Only the focused item is in the tab order.
        expect([...document.querySelectorAll<HTMLElement>('.ezco-mde-context-menu-item')].map((i) => i.tabIndex)).toEqual([-1, -1, -1, -1, 0])
    })

    it('runs the focused item on Enter and on Space, and an item on a press; a disabled item never runs', async () => {
        const { ran, entries } = items()
        const menu = open(entries)
        await userEvent.keyboard('{ArrowDown}{Enter}')
        expect(ran).toEqual(['Copy'])
        await userEvent.keyboard('{Home} ')
        expect(ran).toEqual(['Copy', 'Cut'])
        await userEvent.click(menuItem('Delete', menu.dom)!)
        expect(ran).toEqual(['Copy', 'Cut', 'Delete'])
        // A switch runs its `onSelect` too (the host turns it).
        await userEvent.click(menuItem('Wrap lines', menu.dom)!)
        expect(ran).toEqual(['Copy', 'Cut', 'Delete', 'Wrap lines'])
        menuItem('Paste', menu.dom)!.click()
        expect(ran).toEqual(['Copy', 'Cut', 'Delete', 'Wrap lines'])
    })

    it('pointing at an item focuses it, so the keys go on from there', async () => {
        const { entries } = items()
        const menu = open(entries)
        await userEvent.hover(menuItem('Wrap lines', menu.dom)!)
        expect(focused()).toBe('Wrap lines')
        await userEvent.keyboard('{ArrowDown}')
        expect(focused()).toBe('Delete')
        // Pointing at the disabled item moves nothing.
        await userEvent.hover(menuItem('Paste', menu.dom)!)
        expect(focused()).toBe('Delete')
    })

    it('closes on Escape and on Tab, each with its reason, and runs nothing', async () => {
        const { ran, entries } = items()
        const onClose = vi.fn()
        open(entries, onClose)
        await userEvent.keyboard('{Escape}')
        expect(onClose).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenLastCalledWith('escape')
        await userEvent.keyboard('{Tab}')
        expect(onClose).toHaveBeenCalledTimes(2)
        expect(onClose).toHaveBeenLastCalledWith('tab')
        // Tab was prevented: the focus did not wander off through the items.
        expect(focused()).toBe('Cut')
        expect(ran).toEqual([])
    })

    it('has no type-ahead: a letter typed moves the focus nowhere', async () => {
        const { ran, entries } = items()
        open(entries)
        await userEvent.keyboard('d')
        expect(focused()).toBe('Cut')
        expect(ran).toEqual([])
    })

    it('hears no key once disabled, and is gone once destroyed', async () => {
        const { entries } = items()
        const menu = open(entries)
        menu.disable()
        await userEvent.keyboard('{ArrowDown}')
        expect(focused()).toBe('Cut')
        // Enabling twice attaches one listener: one arrow moves one step.
        menu.enable()
        menu.enable()
        await userEvent.keyboard('{ArrowDown}')
        expect(focused()).toBe('Copy')
        menu.destroy()
        expect(menu.dom.isConnected).toBe(false)
        await userEvent.keyboard('{ArrowDown}')
        expect(document.activeElement).toBe(document.body)
    })
})
