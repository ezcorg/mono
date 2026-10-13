/**
 * The glyphs the chrome draws itself, as inline SVG: one 16-unit box, 14px
 * on screen, in the current colour; `stroke` is the line the menus' icons
 * share. Everything that shows a glyph takes it from here, so a face or a
 * close mark is the same wherever it stands.
 */
export const svg = (body: string) => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${body}</svg>`
export const stroke = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'

/** × */
export const CLOSE_ICON = svg(`<path ${stroke} stroke-width="1.6" d="M4 4l8 8M12 4l-8 8"/>`)
/** A document. */
export const FILE_ICON = svg(`<path ${stroke} d="M4 2.5h5l3 3v8H4zM9 2.5v3h3"/><path ${stroke} d="M6 8.5h4M6 11h4"/>`)
/** A chevron pointing down: a menu behind the control. */
export const CHEVRON_DOWN_ICON = svg(`<path ${stroke} stroke-width="1.6" d="M4 6.5 8 10.5l4-4"/>`)
/** A face: reactions, and the way to more of them. */
export const FACE_ICON = svg(
    '<path fill="currentColor" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm0 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM5.5 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM5.3 9.6a.75.75 0 0 1 1.05.15c.4.53 1 .85 1.65.85s1.25-.32 1.65-.85a.75.75 0 1 1 1.2.9A3.55 3.55 0 0 1 8 12.1a3.55 3.55 0 0 1-2.85-1.45.75.75 0 0 1 .15-1.05Z"/>',
)
