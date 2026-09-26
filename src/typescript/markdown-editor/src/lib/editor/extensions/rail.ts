/**
 * The rail: the column beside the note that the outline and the file tree
 * share, whether the host gives it (`mount`) or the editor makes one.
 *
 * The rail, not each panel, is what stays in view as the note scrolls:
 * panels pinned on their own pin to the same place and cover each other.
 * It is kept no taller than the scroll area it is in, so all of it can be
 * reached, and scrolls inside itself when its panels are taller.
 */
import type { SidebarMount } from './sidebar'

interface Joined {
    panels: number
    stop: () => void
}

const rails = new WeakMap<HTMLElement, Joined>()

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
        entry = { panels: 0, stop: fit(rail) }
        rails.set(rail, entry)
    }
    entry.panels++
    const joined = entry
    return () => {
        if (--joined.panels > 0) return
        joined.stop()
        rails.delete(rail)
        rail.classList.remove('ezco-mde-rail')
        rail.style.removeProperty('--ezco-mde-rail-height')
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
