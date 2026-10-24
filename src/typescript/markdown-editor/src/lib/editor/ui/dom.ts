/**
 * The DOM the chrome is built from: an element with its class and text in
 * one line, a `<button>` that is one, a control that acts on a press
 * without taking the selection or the focus from the note, and a control
 * named for the pointer and the screen reader alike. Every panel, card and
 * menu once wrote its own of each.
 */

/** An element of `tag`, with its class and text when given. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
}

/** A `<button type="button">` (a bare `<button>` submits the form it stands in). */
export function button(className?: string, text?: string): HTMLButtonElement {
    const b = el('button', className, text)
    b.type = 'button'
    return b
}

/**
 * Make `element` act on a press. The `mousedown`'s default is prevented,
 * so the editor keeps its selection and focus (and whatever is being typed
 * in keeps its caret); the `click` stops where it is, so pressing a control
 * is not pressing the card, row or line it stands on; then `onPress` runs,
 * given the element and the click.
 */
export function pressable<E extends HTMLElement>(element: E, onPress: (element: E, event: MouseEvent) => void): E {
    element.addEventListener('mousedown', (e) => e.preventDefault())
    element.addEventListener('click', (e) => {
        e.stopPropagation()
        onPress(element, e)
    })
    return element
}

/** Name `element` for the pointer (`title`) and the screen reader (`aria-label`) alike. */
export function labelled<E extends HTMLElement>(element: E, title: string): E {
    element.title = title
    element.setAttribute('aria-label', title)
    return element
}

/** A control drawn as a glyph: `icon` (SVG from `icons.ts`) in a button named `title`, acting on a press. */
export function glyph(icon: string, title: string, className: string, onPress: (b: HTMLButtonElement, event: MouseEvent) => void): HTMLButtonElement {
    const b = pressable(labelled(button(className), title), onPress)
    b.innerHTML = icon
    return b
}
