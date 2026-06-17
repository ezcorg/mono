import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Browser, Page } from 'puppeteer-core';
import { getDevServerUrl, launchBrowser } from './helpers';

/**
 * Layout regression guard for the toolbar search row.
 *
 * Three things must share the same left x:
 *   1. the toolbar's text input,
 *   2. the code in the editor, and
 *   3. the labels of dropdown search results.
 *
 * They line up because each reserves an equally-wide leading column: the
 * input sits after a status slot spanning the FULL gutter width, the code
 * begins after that same gutter, and every dropdown result reserves a
 * gutter-width icon column before its label. This regressed once when the
 * status slot was sized to the line-number column (`--cm-gutter-lineno-width`)
 * instead of the whole gutter (`--cm-gutter-width`) — which differ whenever a
 * second gutter (e.g. the fold gutter) is present — pulling the input left of
 * the code and dropdown labels.
 *
 * We compare where text actually begins (border-box left + left padding +
 * left border), not raw element rects, because the input, code lines, and
 * labels each carry their own left padding. Uses the in-browser-OPFS fixture
 * (no lazy manifest) so the editor mounts without any network dependency.
 */
describe('Toolbar search row x-alignment (e2e)', () => {
    let browser: Browser;
    let page: Page;
    let BASE_URL: string;

    beforeAll(async () => {
        BASE_URL = `${getDevServerUrl()}/src/e2e/fixtures/create-file.html`;
        browser = await launchBrowser();
    });

    afterAll(async () => {
        await browser.close();
    });

    beforeEach(async () => {
        page = await browser.newPage();
        page.on('pageerror', err => console.log(`[pageerror] ${err}`));
        await page.goto(BASE_URL);
        await page.waitForFunction(() => (window as any).__ready === true, { timeout: 5000 });
        await page.waitForSelector('.cm-content', { visible: true, timeout: 3000 });
    }, 15000);

    afterEach(async () => {
        await page.close();
    });

    it('aligns toolbar input, code, and dropdown result labels on the same left x', async () => {
        // The fixture starts with a line of content, so the line-number
        // gutter renders and the code has a measurable text origin.
        await page.waitForSelector('.cm-lineNumbers .cm-gutterElement', { timeout: 5000 });

        // Open the dropdown with a query that always yields at least a
        // "create" command result, so a label is present to measure.
        await page.click('.cm-toolbar-input', { count: 3 });
        await page.type('.cm-toolbar-input', 'align-probe.ts');
        await page.waitForSelector('.cm-search-result .cm-search-result-label', { timeout: 3000 });
        // Let the gutter-width ResizeObserver settle the layout vars.
        await new Promise(r => setTimeout(r, 100));

        const m = await page.evaluate(() => {
            const textLeft = (el: Element | null): number | null => {
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.left + parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth);
            };
            return {
                input: textLeft(document.querySelector('.cm-toolbar-input')),
                code: textLeft(document.querySelector('.cm-content .cm-line')),
                label: textLeft(document.querySelector('.cm-search-result .cm-search-result-label')),
            };
        });

        expect(m.input).not.toBeNull();
        expect(m.code).not.toBeNull();
        expect(m.label).not.toBeNull();

        // Sub-pixel rounding across a flex-sized input box, a CM line, and a
        // dropdown row — within a single CSS pixel reads as aligned.
        expect(Math.abs(m.input! - m.code!)).toBeLessThanOrEqual(1);
        expect(Math.abs(m.input! - m.label!)).toBeLessThanOrEqual(1);
        expect(Math.abs(m.code! - m.label!)).toBeLessThanOrEqual(1);
    }, 15000);
});
