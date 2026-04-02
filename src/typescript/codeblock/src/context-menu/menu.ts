import type { EditorView } from "@codemirror/view";
import type { ContextMenuItem, MenuContext } from "./items";
import { mountContextMenuStyles } from "./styles";

type MenuGroup = 'navigation' | 'editing' | 'find' | 'clipboard' | 'ai';
const GROUP_ORDER: MenuGroup[] = ['navigation', 'editing', 'find', 'clipboard', 'ai'];

/**
 * Manages a single context menu instance. At most one menu is open at a time.
 */
export class ContextMenu {
    private dom: HTMLElement | null = null;
    private selectedIndex = -1;
    private visibleItems: ContextMenuItem[] = [];
    private view: EditorView | null = null;
    private onCloseCb: (() => void) | null = null;

    // Bound handlers for cleanup
    private handleKeydownBound = this.handleKeydown.bind(this);
    private handleClickOutsideBound = this.handleClickOutside.bind(this);
    private handleScrollBound = this.close.bind(this);

    open(
        view: EditorView,
        items: ContextMenuItem[],
        ctx: MenuContext,
        x: number,
        y: number,
        onClose?: () => void,
    ) {
        this.close(); // close any previously open menu
        mountContextMenuStyles();

        this.view = view;
        this.onCloseCb = onClose ?? null;

        // Filter items by availability
        const available = items.filter(i => i.available(ctx));
        if (available.length === 0) return;

        // Group items and interleave dividers
        this.visibleItems = [];
        let lastGroup: string | null = null;
        for (const group of GROUP_ORDER) {
            const groupItems = available.filter(i => i.group === group);
            if (groupItems.length === 0) continue;
            if (lastGroup !== null) {
                // sentinel divider — we push null and handle it during render
                this.visibleItems.push(null as any);
            }
            this.visibleItems.push(...groupItems);
            lastGroup = group;
        }

        // Build DOM
        this.dom = document.createElement('div');
        this.dom.className = 'cm-context-menu';
        this.dom.setAttribute('role', 'menu');
        this.dom.tabIndex = 0;

        for (let i = 0; i < this.visibleItems.length; i++) {
            const item = this.visibleItems[i];
            if (item === null) {
                const div = document.createElement('div');
                div.className = 'cm-context-menu-divider';
                div.setAttribute('role', 'separator');
                this.dom.appendChild(div);
                continue;
            }
            const el = this.renderItem(item, i, ctx);
            this.dom.appendChild(el);
        }

        // The context menu is appended to document.body, outside the
        // .cm-editor element where CSS custom properties and data-theme
        // are set. Copy them so the menu inherits the editor's theme.
        const theme = view.dom.getAttribute('data-theme');
        if (theme) this.dom.setAttribute('data-theme', theme);
        const editorStyle = getComputedStyle(view.dom);
        for (const prop of [
            '--cm-font-size', '--cm-font-family',
            '--cm-toolbar-background', '--cm-toolbar-color',
            '--cm-search-result-color', '--cm-search-result-color-hover',
            '--cm-search-result-bg-hover', '--cm-search-result-color-selected',
            '--cm-search-result-select-bg', '--cm-command-result-color',
            '--cm-tooltip-border',
        ]) {
            const val = editorStyle.getPropertyValue(prop);
            if (val) this.dom.style.setProperty(prop, val);
        }

        // Position off-screen first to measure
        this.dom.style.left = '-9999px';
        this.dom.style.top = '-9999px';
        document.body.appendChild(this.dom);

        const rect = this.dom.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = x;
        let top = y;

        // Flip horizontal
        if (left + rect.width > vw - 4) left = Math.max(4, x - rect.width);
        // Flip vertical
        if (top + rect.height > vh - 4) top = Math.max(4, y - rect.height);
        // Clamp
        left = Math.max(4, Math.min(left, vw - rect.width - 4));
        top = Math.max(4, Math.min(top, vh - rect.height - 4));

        this.dom.style.left = `${left}px`;
        this.dom.style.top = `${top}px`;

        // Select first non-divider item
        this.selectedIndex = this.visibleItems.findIndex(i => i !== null);
        this.updateSelection();

        // Event listeners
        this.dom.addEventListener('keydown', this.handleKeydownBound);
        // Delay click-outside to avoid the contextmenu event itself closing the menu
        requestAnimationFrame(() => {
            document.addEventListener('mousedown', this.handleClickOutsideBound, true);
        });
        window.addEventListener('scroll', this.handleScrollBound, true);
        window.addEventListener('resize', this.handleScrollBound);

        this.dom.focus();
    }

    close() {
        if (!this.dom) return;
        this.dom.removeEventListener('keydown', this.handleKeydownBound);
        document.removeEventListener('mousedown', this.handleClickOutsideBound, true);
        window.removeEventListener('scroll', this.handleScrollBound, true);
        window.removeEventListener('resize', this.handleScrollBound);
        this.dom.remove();
        this.dom = null;
        this.visibleItems = [];
        this.selectedIndex = -1;
        const cb = this.onCloseCb;
        this.onCloseCb = null;
        const v = this.view;
        this.view = null;
        cb?.();
        // Restore focus to editor
        v?.focus();
    }

    get isOpen() { return this.dom !== null; }

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    private renderItem(item: ContextMenuItem, index: number, ctx: MenuContext): HTMLElement {
        const el = document.createElement('div');
        el.className = 'cm-context-menu-item';
        el.setAttribute('role', 'menuitem');

        const isDisabled = item.disabled?.(ctx) ?? false;
        if (isDisabled) el.classList.add('disabled');

        // Icon
        const iconEl = document.createElement('span');
        iconEl.className = 'cm-context-menu-icon';
        iconEl.textContent = item.icon ?? '';
        el.appendChild(iconEl);

        // Label
        const labelEl = document.createElement('span');
        labelEl.className = 'cm-context-menu-label';
        labelEl.textContent = item.label;
        el.appendChild(labelEl);

        // Shortcut
        if (item.shortcut) {
            const shortcutEl = document.createElement('span');
            shortcutEl.className = 'cm-context-menu-shortcut';
            shortcutEl.textContent = item.shortcut;
            el.appendChild(shortcutEl);
        }

        // Click
        el.addEventListener('mousedown', (e) => e.preventDefault());
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isDisabled) return;
            this.executeItem(item);
        });

        // Hover selects
        el.addEventListener('mouseenter', () => {
            this.selectedIndex = index;
            this.updateSelection();
        });

        return el;
    }

    private updateSelection() {
        if (!this.dom) return;
        const items = this.dom.querySelectorAll('.cm-context-menu-item');
        // Map visible index (including dividers) to DOM element index (items only)
        let itemIdx = 0;
        for (let i = 0; i < this.visibleItems.length; i++) {
            if (this.visibleItems[i] === null) continue; // divider
            const el = items[itemIdx];
            if (el) {
                el.classList.toggle('selected', i === this.selectedIndex);
            }
            itemIdx++;
        }
    }

    private executeItem(item: ContextMenuItem) {
        const view = this.view;
        this.close();
        if (view) item.action(view);
    }

    // -----------------------------------------------------------------------
    // Keyboard navigation
    // -----------------------------------------------------------------------

    private handleKeydown(e: KeyboardEvent) {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.moveSelection(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.moveSelection(-1);
                break;
            case 'Home':
                e.preventDefault();
                this.selectedIndex = this.visibleItems.findIndex(i => i !== null);
                this.updateSelection();
                break;
            case 'End':
                e.preventDefault();
                for (let i = this.visibleItems.length - 1; i >= 0; i--) {
                    if (this.visibleItems[i] !== null) { this.selectedIndex = i; break; }
                }
                this.updateSelection();
                break;
            case 'Enter':
                e.preventDefault();
                if (this.selectedIndex >= 0) {
                    const item = this.visibleItems[this.selectedIndex];
                    if (item && !(item.disabled?.(null as any))) {
                        this.executeItem(item);
                    }
                }
                break;
            case 'Escape':
                e.preventDefault();
                this.close();
                break;
        }
    }

    private moveSelection(dir: 1 | -1) {
        const len = this.visibleItems.length;
        if (len === 0) return;
        let idx = this.selectedIndex;
        for (let i = 0; i < len; i++) {
            idx = ((idx + dir) % len + len) % len;
            if (this.visibleItems[idx] !== null) break;
        }
        this.selectedIndex = idx;
        this.updateSelection();
    }

    // -----------------------------------------------------------------------
    // Click outside
    // -----------------------------------------------------------------------

    private handleClickOutside(e: MouseEvent) {
        if (this.dom && !this.dom.contains(e.target as Node)) {
            this.close();
        }
    }
}
