import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Browser, Page } from 'puppeteer-core';
import { getDevServerUrl, launchBrowser } from './helpers';

describe('Create file flow (e2e)', () => {
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

    it('should start with initial content and no file path', async () => {

        const content = await page.$eval('.cm-content', el => el.textContent);
        expect(content).toBe('initial content here');

        const toolbarValue = await page.$eval('.cm-toolbar-input', (el) => (el as HTMLInputElement).value);
        // Unnamed file — toolbar should show the language or be empty
        expect(toolbarValue).toBe('txt');
    }, 15000);

    it('should preserve content when saving as a new file via toolbar', async () => {

        // 1. Click toolbar input
        await page.click('.cm-toolbar-input', { count: 3 });

        // 2. Type a filename
        await page.type('.cm-toolbar-input', 'myfile.txt');

        // 3. Wait for the dropdown to show commands (Save as is first when content exists)
        await page.waitForSelector('.cm-command-result', { timeout: 3000 });

        // 4. Click "Save as" (first command when editor has content)
        const results = await page.$$('.cm-command-result');
        let saveAsCmd: any = null;
        for (const r of results) {
            const text = await r.evaluate(el => el.textContent);
            if (text?.includes('Save as')) { saveAsCmd = r; break; }
        }
        expect(saveAsCmd).not.toBeNull();
        await saveAsCmd!.click();

        // 5. Wait for the file to be "opened" (toolbar updates to the new path)
        await page.waitForFunction(
            () => (document.querySelector('.cm-toolbar-input') as HTMLInputElement)?.value === 'myfile.txt',
            { timeout: 3000 }
        );

        // 6. Verify the editor content is PRESERVED (not cleared)
        const content = await page.$eval('.cm-content', el => el.textContent);
        expect(content).toBe('initial content here');

        // 7. Verify the file exists in VFS with the correct content
        // Wait for the async VFS write to complete
        await page.waitForFunction(async () => {
            const fs = (window as any).__fs;
            return await fs.exists('myfile.txt');
        }, { timeout: 3000 });
        const vfsContent = await page.evaluate(async () => {
            const fs = (window as any).__fs;
            return await fs.readFile('myfile.txt');
        });
        expect(vfsContent).toBe('initial content here');
    }, 15000);

    it('should preserve content when saving via naming mode (language query)', async () => {

        // 1. Click toolbar, type a language name to trigger naming mode
        await page.click('.cm-toolbar-input', { count: 3 });
        await page.type('.cm-toolbar-input', 'typescript');

        // 2. Wait for dropdown and click "Save as" command (enters naming mode for language queries)
        await page.waitForSelector('.cm-command-result', { timeout: 3000 });
        const results = await page.$$('.cm-command-result');
        let saveAsCmd: any = null;
        for (const r of results) {
            const text = await r.evaluate(el => el.textContent);
            if (text?.includes('Save as')) { saveAsCmd = r; break; }
        }
        expect(saveAsCmd).not.toBeNull();
        await saveAsCmd!.click();

        // 3. In naming mode, type a filename
        await page.type('.cm-toolbar-input', 'example');

        // 4. Press Enter to confirm
        await page.keyboard.press('Enter');

        // 5. Wait for file to open
        await page.waitForFunction(
            () => {
                const val = (document.querySelector('.cm-toolbar-input') as HTMLInputElement)?.value;
                return val && val.includes('example');
            },
            { timeout: 3000 }
        );

        // 6. Verify content is preserved
        const content = await page.$eval('.cm-content', el => el.textContent);
        expect(content).toBe('initial content here');
    }, 15000);

    it('should allow editing after saving as a file and editor reflects changes', async () => {

        // Save as a file first
        await page.click('.cm-toolbar-input', { count: 3 });
        await page.type('.cm-toolbar-input', 'persist.txt');
        await page.waitForSelector('.cm-command-result', { timeout: 3000 });
        // Click "Save as" (first command when editor has content)
        const results = await page.$$('.cm-command-result');
        let saveAsCmd: any = null;
        for (const r of results) {
            const text = await r.evaluate(el => el.textContent);
            if (text?.includes('Save as')) { saveAsCmd = r; break; }
        }
        expect(saveAsCmd).not.toBeNull();
        await saveAsCmd!.click();

        // Wait for file to fully load (toolbar shows name AND loading is done)
        await page.waitForFunction(
            () => {
                const input = document.querySelector('.cm-toolbar-input') as HTMLInputElement;
                const loading = document.querySelector('.cm-loading');
                return input?.value === 'persist.txt' && !loading;
            },
            { timeout: 3000 }
        );

        // Now edit the content
        await page.click('.cm-content');
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.type('new content after save');

        // Verify the editor has the new content
        const editorContent = await page.$eval('.cm-content', el => el.textContent);
        expect(editorContent).toBe('new content after save');

        // Verify toolbar still shows the filename (re-check after editing)
        await page.waitForFunction(
            () => (document.querySelector('.cm-toolbar-input') as HTMLInputElement)?.value === 'persist.txt',
            { timeout: 3000 }
        );
    }, 15000);
});
