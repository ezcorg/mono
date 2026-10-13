/**
 * What the chrome needs to know about where it stands: where a piece of it
 * is mounted, and what scrolls the note.
 */

/** Where a piece of chrome goes: an element, or a function given the
 *  editor's root that returns one (or nothing, for the default place). */
export type Mount = HTMLElement | ((editorRoot: HTMLElement) => HTMLElement | null | void)

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
