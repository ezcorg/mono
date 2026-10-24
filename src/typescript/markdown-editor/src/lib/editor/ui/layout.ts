/**
 * What the chrome needs to know about where it stands: where a piece of it
 * is mounted, and what scrolls the note; and how it keeps up when that
 * changes: a layout pass a frame at a time, a watch on an element's size,
 * the page moving under a fixed overlay, and an overlay resting at the
 * edge when left alone.
 */

/** Where a piece of chrome goes: an element to put it in, or a function
 *  given the editor's root that returns one. A function that returns
 *  nothing, like no mount at all, leaves the piece in its default place
 *  (the one its options describe): the function is never given the piece,
 *  so it cannot have mounted it itself. `resolveMount` reads it. */
export type Mount = HTMLElement | ((editorRoot: HTMLElement) => HTMLElement | null | void)

/** The element `mount` names for a piece of chrome, or null for its
 *  default place: no mount, a function that returned nothing, or no `root`
 *  to call it with. */
export function resolveMount(mount: Mount | undefined, root: HTMLElement | null): HTMLElement | null {
    if (mount instanceof HTMLElement) return mount
    if (typeof mount === 'function' && root) {
        const el = mount(root)
        return el instanceof HTMLElement ? el : null
    }
    return null
}

/** The nearest ancestor of `el` that scrolls, or null for the page itself.
 *  Judged by `overflow-y` alone (not by whether there is anything to
 *  scroll yet), since this is asked before the note is in. */
export function scrollerOf(el: HTMLElement): HTMLElement | null {
    for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) return node
    }
    return null
}

/** The element whose scroll position is the note's: the nearest scroller,
 *  or the document's own scrolling element. */
export function scrollContainerOf(el: HTMLElement | null): HTMLElement {
    return (el && scrollerOf(el)) ?? (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

/** Whether `scroller` is the page itself, whose scroll events come from `window`. */
export function isPageScroller(scroller: HTMLElement): boolean {
    return scroller === document.documentElement || scroller === document.scrollingElement
}

/** `fn` in the next frame, once, however often `schedule` is called before
 *  it runs; `cancel` on destroy, so no frame outlives its owner. */
export function rafThrottle(fn: () => void): { schedule: () => void; cancel: () => void } {
    let frame = 0
    return {
        schedule: () => {
            if (frame) return
            frame = requestAnimationFrame(() => {
                frame = 0
                fn()
            })
        },
        cancel: () => {
            if (frame) cancelAnimationFrame(frame)
            frame = 0
        },
    }
}

/** A `ResizeObserver` calling `fn`, or null where the platform has none:
 *  for what observes and unobserves as it goes (`?.observe`). */
export function sizeObserver(fn: () => void): ResizeObserver | null {
    return typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fn())
}

/** `fn` whenever `target` changes size; returns what stops watching. */
export function observeResize(target: Element, fn: () => void): () => void {
    const observer = sizeObserver(fn)
    observer?.observe(target)
    return () => observer?.disconnect()
}

/** `fn` whenever the page moves under something fixed on it: any scroll
 *  (heard in capture, so a scroller's too) and the window's resize.
 *  Returns what stops following. */
export function followPage(fn: () => void): () => void {
    window.addEventListener('scroll', fn, true)
    window.addEventListener('resize', fn)
    return () => {
        window.removeEventListener('scroll', fn, true)
        window.removeEventListener('resize', fn)
    }
}

/** How long the pointer is gone before what stands over the note's edge
 *  rests at the edge. */
const REST_AFTER = 350

export interface Restable {
    /** Back from the edge (the handle, a comment looked at, a quote). */
    wake(): void
    /** The listeners and the timer taken away, and the class. */
    stop(): void
}

/** What stands over the note's edge (the overlaid comments panel) rests
 *  there when left alone: `is-away` once the pointer has been gone
 *  `REST_AFTER` and nothing in it has focus; back on the pointer's return,
 *  on focus, or on `wake()`. */
export function restable(dom: HTMLElement): Restable {
    let timer = 0
    const wake = () => {
        clearTimeout(timer)
        dom.classList.remove('is-away')
    }
    const rest = () => {
        clearTimeout(timer)
        timer = window.setTimeout(() => {
            if (!dom.matches(':hover') && !dom.contains(document.activeElement)) dom.classList.add('is-away')
        }, REST_AFTER)
    }
    // Focus moving elsewhere within it has not left.
    const left = (e: FocusEvent) => {
        if (!dom.contains(e.relatedTarget as Node | null) && !dom.matches(':hover')) rest()
    }
    dom.addEventListener('pointerenter', wake)
    dom.addEventListener('pointerleave', rest)
    dom.addEventListener('focusin', wake)
    dom.addEventListener('focusout', left)
    return {
        wake,
        stop: () => {
            clearTimeout(timer)
            dom.removeEventListener('pointerenter', wake)
            dom.removeEventListener('pointerleave', rest)
            dom.removeEventListener('focusin', wake)
            dom.removeEventListener('focusout', left)
            dom.classList.remove('is-away')
        },
    }
}

/**
 * `clip` as a fixed frame over the note's root, within the window and the
 * root's scroller: what slides over the note's edge (the comments panel
 * with no room beside the note) lives in such a frame, which clips it as
 * it slides. Returns the frame's size.
 */
export function frameOver(clip: HTMLElement, root: HTMLElement): { width: number; height: number } {
    const r = root.getBoundingClientRect()
    const scroller = scrollerOf(root)
    let top = r.top
    let bottom = r.bottom
    let left = r.left
    let right = r.right
    if (scroller) {
        const s = scroller.getBoundingClientRect()
        top = Math.max(top, s.top)
        bottom = Math.min(bottom, s.bottom)
        left = Math.max(left, s.left)
        right = Math.min(right, s.right)
    }
    top = Math.max(top, 0)
    bottom = Math.min(bottom, window.innerHeight)
    left = Math.max(left, 0)
    right = Math.min(right, window.innerWidth)
    const width = Math.max(0, right - left)
    const height = Math.max(0, bottom - top)
    clip.style.top = `${Math.round(top)}px`
    clip.style.left = `${Math.round(left)}px`
    clip.style.width = `${Math.round(width)}px`
    clip.style.height = `${Math.round(height)}px`
    return { width, height }
}
