/**
 * The rail: the column beside the note that the outline and the file tree
 * share, whether the host gives it (`mount`) or the editor makes one.
 *
 * The rail, not each panel, is what stays in view as the note scrolls:
 * panels pinned on their own pin to the same place and cover each other.
 * It is kept no taller than the scroll area it is in, so all of it can be
 * reached, and scrolls inside itself when its panels are taller.
 *
 * It can be put away. A chevron in its top corner, shown while the pointer
 * is over the rail (or ⌘⌥B, `toggleRail`), folds the rail to nothing but
 * the chevron at the note's edge, which brings it back; so does a panel
 * asked for while it is folded (⌘⇧E for the file tree).
 */
import { Extension, type Editor } from '@tiptap/core'
import type { SidebarMount } from './sidebar'

interface Joined {
    panels: number
    stop: () => void
}

const rails = new WeakMap<HTMLElement, Joined>()
/** The rail an editor's panels went into, by the editor's root. */
const railOf = new WeakMap<HTMLElement, HTMLElement>()

const CHEVRON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M10.25 3.5 5.75 8l4.5 4.5"/></svg>'

/**
 * Put `panel` in its rail: the container `mount` names, or else a rail made
 * just before `editorRoot` (shared with the other panel). Returns the way to
 * take it out.
 */
export function mountInRail(panel: HTMLElement, mount: SidebarMount | undefined, editorRoot: HTMLElement | null): () => void {
    let rail: HTMLElement | null = null
    if (mount instanceof HTMLElement) rail = mount
    else if (typeof mount === 'function' && editorRoot) rail = mount(editorRoot) ?? null
    else if (editorRoot?.parentElement) {
        const parent = editorRoot.parentElement
        rail = [...parent.children].find((el): el is HTMLElement => el.classList.contains('ezco-mde-rail') && el.nextElementSibling === editorRoot) ?? null
        if (!rail) {
            rail = document.createElement('div')
            parent.insertBefore(rail, editorRoot)
        }
    }
    if (!rail) {
        document.body.appendChild(panel)
        return () => panel.remove()
    }
    rail.appendChild(panel)
    if (editorRoot) railOf.set(editorRoot, rail)
    const joined = join(rail)
    return () => {
        panel.remove()
        joined()
    }
}

function join(rail: HTMLElement): () => void {
    let entry = rails.get(rail)
    if (!entry) {
        rail.classList.add('ezco-mde-rail')
        const stopFit = fit(rail)
        const stopToggle = toggle(rail)
        entry = {
            panels: 0,
            stop: () => {
                stopFit()
                stopToggle()
            },
        }
        rails.set(rail, entry)
    }
    entry.panels++
    const joined = entry
    return () => {
        if (--joined.panels > 0) return
        joined.stop()
        rails.delete(rail)
        rail.classList.remove('ezco-mde-rail', 'is-collapsed')
        rail.style.removeProperty('--ezco-mde-rail-height')
    }
}

/** Whether `rail` is folded away. */
export const isCollapsed = (rail: HTMLElement) => rail.classList.contains('is-collapsed')

/** Fold `rail` away, or bring it back. */
export function setCollapsed(rail: HTMLElement, folded: boolean): void {
    rail.classList.toggle('is-collapsed', folded)
    const button = rail.querySelector<HTMLButtonElement>(':scope > .ezco-mde-rail-toggle')
    if (!button) return
    const title = folded ? 'Show the side panel (⌘⌥B)' : 'Hide the side panel (⌘⌥B)'
    button.title = title
    button.setAttribute('aria-label', title)
    button.setAttribute('aria-expanded', String(!folded))
}

/** The rail the panels of `editor` are in, if any. */
export function railFor(editor: Editor): HTMLElement | null {
    const root = editor.view.dom.parentElement
    const rail = root ? railOf.get(root) : undefined
    return rail && rails.has(rail) ? rail : null
}

/** The chevron that folds the rail and brings it back. */
function toggle(rail: HTMLElement): () => void {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ezco-mde-rail-toggle'
    button.innerHTML = CHEVRON
    button.addEventListener('mousedown', (e) => e.preventDefault())
    button.addEventListener('click', () => setCollapsed(rail, !isCollapsed(rail)))
    rail.appendChild(button)
    setCollapsed(rail, false)
    // A panel shown while the rail is folded (⌘⇧E) brings the rail back.
    let observer: MutationObserver | null = null
    if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver((records) => {
            if (!isCollapsed(rail)) return
            for (const record of records) {
                const target = record.target as HTMLElement
                if (target.parentElement === rail && target !== button && !target.hidden) setCollapsed(rail, false)
            }
        })
        observer.observe(rail, { attributes: true, attributeFilter: ['hidden'], subtree: true })
    }
    return () => {
        observer?.disconnect()
        button.remove()
    }
}

/** Keep the rail's height to the scroll area it is in. */
function fit(rail: HTMLElement): () => void {
    const scroller = scrollerOf(rail)
    const update = () => {
        const height = scroller ? scroller.clientHeight : window.innerHeight
        if (height > 0) rail.style.setProperty('--ezco-mde-rail-height', `${height}px`)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return () => {}
    const observer = new ResizeObserver(update)
    observer.observe(scroller ?? document.documentElement)
    if (!scroller) window.addEventListener('resize', update)
    return () => {
        observer.disconnect()
        window.removeEventListener('resize', update)
    }
}

/** The nearest ancestor that scrolls, or null for the page itself. */
export function scrollerOf(el: HTMLElement): HTMLElement | null {
    for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) return node
    }
    return null
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        rail: {
            /** Fold the rail (the outline, the file tree) away, or bring it back. */
            toggleRail: () => ReturnType
        }
    }
}

/** The way to the rail from the keyboard and the palette: ⌘⌥B. */
export const RailToggle = Extension.create({
    name: 'rail',

    addCommands() {
        return {
            toggleRail:
                () =>
                () => {
                    const rail = railFor(this.editor)
                    if (!rail) return false
                    setCollapsed(rail, !isCollapsed(rail))
                    return true
                },
        }
    },

    addKeyboardShortcuts() {
        return { 'Mod-Alt-b': () => this.editor.commands.toggleRail() }
    },
})
