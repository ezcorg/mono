import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import puppeteer, { Browser, Page } from 'puppeteer-core';

const BASE_URL = 'http://localhost:5173/multiview-test.html';
const CHROME_PATH = '/usr/bin/google-chrome';

describe('Multi-view file sync (e2e)', () => {
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
            ],
        });
    });

    afterAll(async () => {
        await browser.close();
    });

    beforeEach(async () => {
        page = await browser.newPage();
        page.on('pageerror', err => console.log(`[pageerror] ${err}`));
        await page.goto(BASE_URL);

        // Wait for both editors to be ready with content
        await page.waitForFunction(() => (window as any).__editorsReady === true, { timeout: 10000 });
        await page.waitForSelector('#editor-a .cm-content', { visible: true, timeout: 5000 });
        await page.waitForSelector('#editor-b .cm-content', { visible: true, timeout: 5000 });
    }, 30000);

    afterEach(async () => {
        await page.close();
    });

    it('should load the same initial content in both editors', async () => {
        const textA = await page.$eval('#editor-a .cm-content', el => el.textContent);
        const textB = await page.$eval('#editor-b .cm-content', el => el.textContent);
        expect(textA).toBe('hello world');
        expect(textB).toBe('hello world');
    }, 15000);

    it('should sync edits from editor A to editor B via fileChangeBus.notify', async () => {
        // Edit view A and then notify via the bus (simulating what the save callback does)
        await page.evaluate(() => {
            const { viewA } = (window as any).__views;
            const bus = (window as any).__fileChangeBus;
            viewA.dispatch({ changes: { from: 0, to: viewA.state.doc.length, insert: 'changed from A' } });
            bus.notify('shared.txt', 'changed from A', viewA);
        });

        // B should receive the update synchronously via the bus
        const textB = await page.$eval('#editor-b .cm-content', el => el.textContent);
        expect(textB).toBe('changed from A');

        // A should still have its own content
        const textA = await page.$eval('#editor-a .cm-content', el => el.textContent);
        expect(textA).toBe('changed from A');
    }, 15000);

    it('should sync edits from editor B to editor A via fileChangeBus.notify', async () => {
        await page.evaluate(() => {
            const { viewB } = (window as any).__views;
            const bus = (window as any).__fileChangeBus;
            viewB.dispatch({ changes: { from: 0, to: viewB.state.doc.length, insert: 'changed from B' } });
            bus.notify('shared.txt', 'changed from B', viewB);
        });

        const textA = await page.$eval('#editor-a .cm-content', el => el.textContent);
        expect(textA).toBe('changed from B');
    }, 15000);

    it('should not notify the source view', async () => {
        // Edit A and notify — A should NOT receive the notification back
        const result = await page.evaluate(() => {
            const { viewA, viewB } = (window as any).__views;
            const bus = (window as any).__fileChangeBus;

            // Set up tracking
            let aReceived = false;
            let bReceived = false;
            const unsubA = bus.subscribe('track.txt', viewA, () => { aReceived = true; });
            const unsubB = bus.subscribe('track.txt', viewB, () => { bReceived = true; });

            bus.notify('track.txt', 'test', viewA);

            unsubA();
            unsubB();

            return { aReceived, bReceived };
        });

        expect(result.aReceived).toBe(false);
        expect(result.bReceived).toBe(true);
    }, 15000);

    it('should not create infinite sync loops', async () => {
        // This tests that when B receives an update and dispatches it,
        // the dispatch does NOT trigger B to re-notify (which would create a loop)
        const result = await page.evaluate(() => {
            const { viewA, viewB } = (window as any).__views;
            const bus = (window as any).__fileChangeBus;

            let notifyCount = 0;
            const originalNotify = bus.notify.bind(bus);
            bus.notify = function(path: string, content: string, source: any) {
                notifyCount++;
                originalNotify(path, content, source);
            };

            // Simulate: A edits, then "saves" (notify)
            viewA.dispatch({ changes: { from: 0, to: viewA.state.doc.length, insert: 'final content' } });
            bus.notify('shared.txt', 'final content', viewA);

            // Restore
            bus.notify = originalNotify;

            return {
                notifyCount,
                textA: viewA.state.doc.toString(),
                textB: viewB.state.doc.toString(),
            };
        });

        // Only one notify should have happened (our explicit call)
        expect(result.notifyCount).toBe(1);
        expect(result.textA).toBe('final content');
        expect(result.textB).toBe('final content');
    }, 15000);
});
