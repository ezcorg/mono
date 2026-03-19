import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Browser, Page } from 'puppeteer-core';
import { DEV_SERVER, launchBrowser } from './helpers';

const BASE_URL = `${DEV_SERVER}/src/e2e/fixtures/create-file.html`;

describe('Create file flow (e2e)', () => {
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
        browser = await launchBrowser();
    });

    afterAll(async () => {
        await browser.close();
    });

    beforeEach(async () => {
        page = await browser.newPage();
        page.on('pageerror', err => console.log(`[pageerror] ${err}`));
        page.on('console', msg => {
            if (msg.type() === 'error') console.log(`[browser error] ${msg.text()}`);
        });
        await page.goto(BASE_URL);
        await page.waitForFunction(() => (window as any).__ready === true, { timeout: 10000 });
        await page.waitForSelector('.cm-content', { visible: true, timeout: 5000 });
    }, 30000);

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

    it('should preserve content when creating a new file via toolbar', async () => {
        // 1. Click toolbar input
        await page.click('.cm-toolbar-input', { count: 3 });

        // 2. Type a filename
        await page.type('.cm-toolbar-input', 'myfile.txt');

        // 3. Wait for the dropdown to show the "Create new file" command
        await page.waitForSelector('.cm-command-result', { timeout: 3000 });

        // 4. Click the create command
        const createCmd = await page.$('.cm-command-result');
        expect(createCmd).not.toBeNull();
        await createCmd!.click();

        // 5. Wait for the file to be "opened" (toolbar updates to the new path)
        await page.waitForFunction(
            () => (document.querySelector('.cm-toolbar-input') as HTMLInputElement)?.value === 'myfile.txt',
            { timeout: 3000 }
        );

        // 6. Verify the editor content is PRESERVED (not cleared)
        const content = await page.$eval('.cm-content', el => el.textContent);
        expect(content).toBe('initial content here');

        // 7. Verify the file exists in VFS with the correct content
        const vfsContent = await page.evaluate(async () => {
            const fs = (window as any).__fs;
            const exists = await fs.exists('myfile.txt');
            if (!exists) return null;
            return await fs.readFile('myfile.txt');
        });
        expect(vfsContent).toBe('initial content here');
    }, 15000);

    it('should preserve content when creating a file via naming mode (language query)', async () => {
        // 1. Click toolbar, type a language name to trigger naming mode
        await page.click('.cm-toolbar-input', { count: 3 });
        await page.type('.cm-toolbar-input', 'typescript');

        // 2. Wait for dropdown and click create command (which enters naming mode)
        await page.waitForSelector('.cm-command-result', { timeout: 3000 });
        const createCmd = await page.$('.cm-command-result');
        await createCmd!.click();

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

    it('should allow editing after creating a file and editor reflects changes', async () => {
        // Create a file first
        await page.click('.cm-toolbar-input', { count: 3 });
        await page.type('.cm-toolbar-input', 'persist.txt');
        await page.waitForSelector('.cm-command-result', { timeout: 3000 });
        await page.$eval('.cm-command-result', el => (el as HTMLElement).click());

        await page.waitForFunction(
            () => (document.querySelector('.cm-toolbar-input') as HTMLInputElement)?.value === 'persist.txt',
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

        // Verify toolbar still shows the filename
        const toolbarValue = await page.$eval('.cm-toolbar-input', (el) => (el as HTMLInputElement).value);
        expect(toolbarValue).toBe('persist.txt');
    }, 15000);
});
