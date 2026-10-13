/**
 * The editor's popovers: one tippy, one "closed by a press elsewhere", one
 * rect from a range of text. Every floating surface of the chrome (the
 * block, selection and comment menus, the link popover, the emoji grids,
 * the slash and `:` menus, the prose-action panel) is placed by this, so
 * they open, stay on screen and close the same way.
 *
 * What is the same for all of them: appended to the body, interactive,
 * shown and hidden by hand (tippy's own triggers and touch handling are
 * off), kept 8px inside the viewport by popper's `preventOverflow` and
 * flipped to the other side when theirs has no room, and nothing written
 * on the reference (no `aria-*`: the owner of a button says what it
 * expands, and the editable can be a reference without being mutated).
 *
 * No transition: tippy's own stylesheet is not shipped (the themes draw a
 * transparent box, the content its own surface), so a popover that waited
 * on `transitionend` never heard `onShown` and never unmounted on hide.
 * With no duration, `onShown` follows `onMount` at once and `hide()` takes
 * the popover out of the document at once.
 */
import tippy, { type Instance, type Placement } from 'tippy.js'
import type { EditorView } from '@tiptap/pm/view'
import type { ContextMenu } from './context-menu'

export type { Placement }

/** The menus' theme: a transparent box, the `ContextMenu` its own surface. */
export const MENU_THEME = 'ezco-mde-block-actions'

/** How far inside the viewport a popover is kept. */
const PADDING = 8

export interface PopoverOptions {
    /** Which side of the reference, and how it aligns (`bottom-start` by default). */
    placement?: Placement
    /** Where to go when that side has no room; the opposite side by default. */
    flip?: Placement[]
    /** Always shifted along its side to stay on screen; `both` also shifts
     *  it across (a grid that would hang off the bottom stands over its
     *  anchor rather than out of reach), which `along` never does. */
    shift?: 'along' | 'both'
    /** A `.tippy-box[data-theme~=…]` rule of styles.ts; the menus' by default. */
    theme?: string
    /** tippy's own 350px cap on the box unless given. */
    maxWidth?: number | 'none'
    /** [along, away] from the reference, in px; tippy's [0, 10] by default. */
    offset?: [number, number]
    /** The rect to place by, when the reference element is not it (a range
     *  of text, the caret, a point). The reference is then what the popover
     *  belongs to: where popper listens for scrolling, and (for
     *  `onPressOutside`) what counts as inside. */
    rect?: () => DOMRect
    /**
     * Closed by a press elsewhere: called on a `mousedown` outside the
     * popover, its reference and `keep()`. The listener is on the document
     * in the capture phase, so it sees the press before anything stops its
     * propagation (the editor, a code block) and closes this popover before
     * the pressed thing opens its own; `mousedown`, not `click`, because a
     * menu goes on the press (a drag that starts outside is outside, and a
     * click would be the one that opened it). It is registered after the
     * current event turn (a timeout of 0), so the press, keystroke or
     * synthesized click that opened the popover can never be the one that
     * closes it, whatever phase it is in. Not with `document.body` as the
     * reference: everything is inside it.
     */
    onPressOutside?: () => void
    /** Also inside, for `onPressOutside`: things whose presses are their own
     *  (the editor, whose selection then decides). */
    keep?: () => Iterable<Element | null | undefined>
    /** The content is in the document and placed (popper's first update). */
    onMount?: () => void
    /** Shown; right after `onMount`, there being no transition. */
    onShown?: () => void
    /** Hiding, by `hide()` or a press outside (not by `destroy()`). */
    onHide?: () => void
}

export interface Popover {
    /** The tippy, for what the options do not cover (`setContent`). */
    readonly instance: Instance
    /** The popover's own element (what `contains` the content). */
    readonly dom: HTMLElement
    show(): void
    hide(): void
    /** Placed again: the reference moved or the content changed size. */
    update(): void
    /** Gone, listener and all; safe to call twice. */
    destroy(): void
}

/** A popover of `content` by `reference`, not shown until `show()`. */
export function popover(reference: Element, content: HTMLElement, opts: PopoverOptions = {}): Popover {
    // The press-outside listener, armed on show (after the turn) and
    // disarmed on hide and on destroy (tippy's destroy does not hide).
    let timer = 0
    let armed = false
    const press = (e: MouseEvent) => {
        const target = e.target as Node | null
        if (!target) return
        if (instance.popper.contains(target) || reference.contains(target)) return
        for (const el of opts.keep?.() ?? []) if (el?.contains(target)) return
        opts.onPressOutside?.()
    }
    const arm = () => {
        if (!opts.onPressOutside || armed || timer) return
        timer = window.setTimeout(() => {
            timer = 0
            armed = true
            document.addEventListener('mousedown', press, true)
        }, 0)
    }
    const disarm = () => {
        if (timer) {
            clearTimeout(timer)
            timer = 0
        }
        if (armed) {
            armed = false
            document.removeEventListener('mousedown', press, true)
        }
    }

    const made = tippy(reference, {
        content,
        appendTo: () => document.body,
        interactive: true,
        trigger: 'manual',
        touch: false,
        hideOnClick: false,
        aria: { content: null, expanded: false },
        duration: 0,
        placement: opts.placement ?? 'bottom-start',
        theme: opts.theme ?? MENU_THEME,
        ...(opts.maxWidth !== undefined ? { maxWidth: opts.maxWidth } : {}),
        ...(opts.offset ? { offset: opts.offset } : {}),
        ...(opts.rect ? { getReferenceClientRect: opts.rect } : {}),
        popperOptions: {
            modifiers: [
                { name: 'preventOverflow', options: { padding: PADDING, ...(opts.shift === 'both' ? { altAxis: true, tether: false } : {}) } },
                { name: 'flip', options: { padding: PADDING, ...(opts.flip ? { fallbackPlacements: opts.flip } : {}) } },
            ],
        },
        onShow: () => arm(),
        onMount: () => opts.onMount?.(),
        onShown: () => opts.onShown?.(),
        onHide: () => {
            disarm()
            opts.onHide?.()
        },
    })
    // One element in, one instance out; tippy's types say so, its older
    // selves did not.
    const instance: Instance = Array.isArray(made) ? made[0] : made

    return {
        instance,
        dom: instance.popper,
        show: () => {
            if (!instance.state.isDestroyed) instance.show()
        },
        hide: () => {
            if (!instance.state.isDestroyed) instance.hide()
        },
        update: () => void instance.popperInstance?.update(),
        destroy: () => {
            disarm()
            instance.destroy()
        },
    }
}

export type MenuPopoverOptions = Omit<PopoverOptions, 'onPressOutside' | 'onShown' | 'keep'>

/**
 * A `ContextMenu` in a popover, shown at once: its keys are live before it
 * shows (Escape and the arrows work from the first frame, not only once
 * shown), focus moves to its first item once shown, a press outside hides
 * it, and once hidden (by `hide()`, the press, or the menu's own `onClose`
 * through the caller) the menu and the popover are destroyed a tick later,
 * never from within tippy's own hook. One opening, one of these; the
 * caller's own "already open" state decides whether to make the next.
 */
export function menuPopover(reference: Element, menu: ContextMenu, opts: MenuPopoverOptions = {}): Popover {
    const inner = popover(reference, menu.dom, {
        ...opts,
        onPressOutside: () => inner.hide(),
        onShown: () => menu.focus(),
        onHide: () => {
            menu.disable()
            opts.onHide?.()
            setTimeout(() => p.destroy(), 0)
        },
    })
    const p: Popover = {
        ...inner,
        destroy: () => {
            inner.destroy()
            menu.destroy()
        },
    }
    menu.enable()
    p.show()
    return p
}

/** The rect of the text from `from` to `to` in `view`: what a popover
 *  under a typed word or a selection is placed by. */
export function rangeRect(view: EditorView, { from, to }: { from: number; to: number }): DOMRect {
    const start = view.coordsAtPos(from)
    const end = view.coordsAtPos(to)
    return new DOMRect(start.left, start.top, Math.max(1, end.right - start.left), Math.max(1, end.bottom - start.top))
}

/** The caret's rect at `pos` in `view`, a pixel wide. */
export function caretRect(view: EditorView, pos: number): DOMRect {
    const c = view.coordsAtPos(pos)
    return new DOMRect(c.left, c.top, 1, Math.max(1, c.bottom - c.top))
}
