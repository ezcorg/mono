/**
 * Hover-revealed copy-to-clipboard affordance for codeblocks.
 *
 * Two modes:
 *
 * 1. Toolbar present — on hover or focus of the editor, the toolbar's
 *    state icon (file-type / magnifier) is swapped for a clipboard
 *    icon. Clicking copies the document; the icon flips to a
 *    checkmark for 1.5s then restores. No extra layout chrome —
 *    re-uses the existing slot.
 *
 * 2. No toolbar — a small absolutely-positioned button appears
 *    inline at the end of the first text line on hover/focus. This
 *    keeps the affordance visible for short single-line snippets
 *    (`pnpm add …`, `curl … | sh`) where there's no toolbar to host
 *    it and the button shouldn't crowd the left margin or float
 *    over content.
 *
 * Icons are inline SVG rather than nerd-font glyphs because nerd-font
 * advance widths don't always match visible bounds — clicks/hovers
 * leak past the button's hit area to the CodeMirror content beneath
 * (which then shows the text cursor instead of `cursor: pointer`).
 */
import { EditorView, ViewPlugin } from "@codemirror/view";
import { CodeblockFacet } from "../editor";

// The icons are drawn so their visible content fills the viewBox's
// right edge (front rect → x=15, stroke half-extends to x=15.75, leaving
// only ~0.25 units of fade-out). When the SVG is positioned in the
// toolbar's gutter slot with `right: calc(1ch + 3px)` matching the
// state-icon's padding-right, this puts the visible right edge of the
// icon at the same column the right-aligned nerd-font glyph painted
// to — no leftward offset between modes.
const COPY_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="5" y="5" width="10" height="10" rx="1.5"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H12"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2.5 8.5L7 13L14 4.5"/></svg>`;
const COPY_TITLE = 'Copy file to clipboard';
const COPIED_TITLE = 'Copied!';

async function copyDocText(view: EditorView): Promise<boolean> {
    const text = view.state.doc.toString();
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Fallback for insecure contexts / older browsers.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { /* noop */ }
        ta.remove();
        return ok;
    }
}

export const copyButtonExtension = ViewPlugin.define((view: EditorView) => {
    const hasToolbar = view.state.facet(CodeblockFacet).toolbar !== false;
    return hasToolbar ? setupToolbarMode(view) : setupInlineMode(view);
});

// ---------------------------------------------------------------------------
// Mode 1: swap the toolbar's state-icon on hover.
// ---------------------------------------------------------------------------
function setupToolbarMode(view: EditorView) {
    // The toolbar mounts as a Panel — its DOM lives inside view.dom but is
    // created asynchronously. Resolve the state-icon lazily on the first
    // hover so we don't race the toolbar's own construction.
    let stateIcon: HTMLElement | null = null;
    let overlay: HTMLElement | null = null;
    let originalTitle: string | null = null;
    let inCopyMode = false;
    let successUntil = 0;
    let resetTimer: number | null = null;

    function resolveStateIcon(): HTMLElement | null {
        if (stateIcon && stateIcon.isConnected) return stateIcon;
        stateIcon = view.dom.querySelector<HTMLElement>('.cm-toolbar-state-icon');
        return stateIcon;
    }

    // We deliberately do NOT replace the state-icon's textContent.
    // Why: `@joinezco/markdown-editor`'s block-action indicator
    // (extensions/block-actions.ts) computes its icon's vertical
    // offset by walking the block's DOM for the first text node and
    // measuring its `getClientRects()`. The nerd-font glyph in
    // `.cm-toolbar-state-icon` is that first text node — its rect
    // sits at the toolbar's vertical position, and the indicator
    // icon aligns with the toolbar.
    //
    // If we replaced the glyph with an SVG, the TreeWalker would
    // skip past the (text-free) toolbar and land on the first line
    // of code below it, shifting the indicator down by one
    // line-height. So instead: hide the glyph with `color: transparent`
    // (preserves layout *and* the text node) and overlay the SVG via
    // an absolutely-positioned span.
    function isSearchActive(): boolean {
        // The state-icon's role is contextual: when the user is
        // actively interacting with the toolbar's search (input
        // focused, or the dropdown is populated with results /
        // commands), we should keep the original search/file glyph
        // visible — not the copy clipboard. Suppress copy mode in
        // both cases.
        const input = view.dom.querySelector<HTMLInputElement>('.cm-toolbar-input');
        if (input && document.activeElement === input) return true;
        const results = view.dom.querySelector('.cm-search-results');
        if (results && results.childNodes.length > 0) return true;
        return false;
    }
    function enterCopyMode() {
        const el = resolveStateIcon();
        if (!el || inCopyMode) return;
        if (isSearchActive()) return;
        inCopyMode = true;
        originalTitle = el.getAttribute('title');
        el.setAttribute('title', COPY_TITLE);
        el.classList.add('cm-copy-icon-active');
        overlay = document.createElement('span');
        overlay.className = 'cm-copy-icon-overlay';
        overlay.innerHTML = COPY_SVG;
        el.appendChild(overlay);
        el.addEventListener('mousedown', onMouseDown);
        el.addEventListener('click', onClick);
    }
    function exitCopyMode() {
        if (!inCopyMode) return;
        // Keep the success tick visible for the full 1.5s window even if
        // the user moves their cursor away mid-confirmation.
        if (Date.now() < successUntil) return;
        const el = resolveStateIcon();
        if (!el) return;
        if (originalTitle !== null) el.setAttribute('title', originalTitle);
        else el.removeAttribute('title');
        el.classList.remove('cm-copy-icon-active', 'cm-copy-icon-success');
        if (overlay) { overlay.remove(); overlay = null; }
        el.removeEventListener('mousedown', onMouseDown);
        el.removeEventListener('click', onClick);
        inCopyMode = false;
    }

    function onMouseDown(e: Event) {
        // Don't let CM steal focus / move the caret on the click.
        e.preventDefault();
        e.stopPropagation();
    }
    async function onClick(e: Event) {
        e.preventDefault();
        e.stopPropagation();
        const el = resolveStateIcon();
        if (!el || !overlay) return;
        const copied = await copyDocText(view);
        if (!copied) return;
        overlay.innerHTML = CHECK_SVG;
        el.setAttribute('title', COPIED_TITLE);
        el.classList.add('cm-copy-icon-success');
        successUntil = Date.now() + 1500;
        if (resetTimer !== null) window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => {
            resetTimer = null;
            // If the user is still hovering, swap back to the copy glyph;
            // otherwise restore the original toolbar icon entirely.
            if (view.dom.matches(':hover, :focus-within')) {
                if (overlay) overlay.innerHTML = COPY_SVG;
                el.setAttribute('title', COPY_TITLE);
                el.classList.remove('cm-copy-icon-success');
            } else {
                successUntil = 0;
                exitCopyMode();
            }
        }, 1500);
    }

    function onPointerEnter() { enterCopyMode(); }
    function onPointerLeave() { exitCopyMode(); }
    function onFocusIn(e: FocusEvent) {
        const target = e.target as Element | null;
        // If focus landed on the toolbar input, the user is starting
        // a search — bail out of copy mode (and don't re-enter it
        // until focus leaves the input).
        if (target && target.classList && target.classList.contains('cm-toolbar-input')) {
            exitCopyMode();
            return;
        }
        enterCopyMode();
    }
    function onFocusOut(e: FocusEvent) {
        // Only exit if focus actually left the editor — relatedTarget
        // is null when focus leaves the window entirely.
        const next = e.relatedTarget as Node | null;
        if (next && view.dom.contains(next)) return;
        exitCopyMode();
    }

    view.dom.addEventListener('pointerenter', onPointerEnter);
    view.dom.addEventListener('pointerleave', onPointerLeave);
    view.dom.addEventListener('focusin', onFocusIn);
    view.dom.addEventListener('focusout', onFocusOut);

    // Watch the search-results list for content changes: when the
    // toolbar populates results (the user is searching), exit copy
    // mode; when results clear and the user is still hovering, re-
    // enter. Resolved lazily because the dropdown is created by the
    // panel constructor after our plugin runs.
    let resultsObserver: MutationObserver | null = null;
    function ensureResultsObserver() {
        if (resultsObserver) return;
        const results = view.dom.querySelector('.cm-search-results');
        if (!results) return;
        resultsObserver = new MutationObserver(() => {
            if (isSearchActive()) {
                exitCopyMode();
            } else if (view.dom.matches(':hover, :focus-within')) {
                enterCopyMode();
            }
        });
        resultsObserver.observe(results, { childList: true });
    }
    // Run after the panel is mounted; one rAF is usually enough.
    requestAnimationFrame(() => ensureResultsObserver());

    return {
        destroy() {
            resultsObserver?.disconnect();
            if (resetTimer !== null) window.clearTimeout(resetTimer);
            exitCopyMode();
            view.dom.removeEventListener('pointerenter', onPointerEnter);
            view.dom.removeEventListener('pointerleave', onPointerLeave);
            view.dom.removeEventListener('focusin', onFocusIn);
            view.dom.removeEventListener('focusout', onFocusOut);
        },
    };
}

// ---------------------------------------------------------------------------
// Mode 2: floating inline button at end of first line, on hover/focus.
// ---------------------------------------------------------------------------
function setupInlineMode(view: EditorView) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-copy-button cm-copy-button-inline';
    btn.setAttribute('aria-label', COPY_TITLE);
    btn.title = COPY_TITLE;
    btn.innerHTML = COPY_SVG;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    let resetTimer: number | null = null;
    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const copied = await copyDocText(view);
        if (!copied) return;
        btn.innerHTML = CHECK_SVG;
        btn.title = COPIED_TITLE;
        btn.classList.add('cm-copy-button-success');
        if (resetTimer !== null) window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => {
            btn.innerHTML = COPY_SVG;
            btn.title = COPY_TITLE;
            btn.classList.remove('cm-copy-button-success');
            resetTimer = null;
        }, 1500);
    });
    view.dom.appendChild(btn);

    // Place the button at the end of the first visible text line.
    // We measure the line-end position via `coordsAtPos` (viewport
    // coords), translate to `view.dom`-relative coords for absolute
    // positioning, and clamp to the editor's right edge so a very
    // long single line doesn't push the button outside the viewport.
    function positionInline() {
        const docLine = view.state.doc.line(1);
        const endCoords = view.coordsAtPos(docLine.to);
        if (!endCoords) return;
        const editorRect = view.dom.getBoundingClientRect();
        const lineCenterY = (endCoords.top + endCoords.bottom) / 2;
        const top = lineCenterY - editorRect.top;
        // Sit 6px after the line end; clamp 6px from the right edge.
        const idealLeft = endCoords.right - editorRect.left + 6;
        const maxLeft = editorRect.width - 6 - btn.offsetWidth;
        btn.style.left = `${Math.min(idealLeft, Math.max(0, maxLeft))}px`;
        btn.style.top = `${top - btn.offsetHeight / 2}px`;
    }
    function schedulePosition() { requestAnimationFrame(() => positionInline()); }
    schedulePosition();

    let resizeObs: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
        resizeObs = new ResizeObserver(() => schedulePosition());
        resizeObs.observe(view.dom);
    }

    return {
        update(update) {
            if (update.docChanged || update.geometryChanged || update.viewportChanged) {
                schedulePosition();
            }
        },
        destroy() {
            if (resetTimer !== null) window.clearTimeout(resetTimer);
            resizeObs?.disconnect();
            btn.remove();
        },
    };
}
