import { Browser, Page } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

export const CHROME_PATH = '/usr/bin/google-chrome';

/** Get the dev server URL started by globalSetup. */
export function getDevServerUrl(): string {
    const url = process.env.CODEBLOCK_DEV_SERVER;
    if (!url) throw new Error('CODEBLOCK_DEV_SERVER not set — is globalSetup configured?');
    return url;
}

export async function launchBrowser(): Promise<Browser> {
    return puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: process.env.HEADFUL ? false : true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-site-isolation-trials',
            '--allow-file-access-from-files',
        ],
    });
}

/**
 * Create a new page inside an incognito browser context so each test
 * gets a clean OPFS / storage state, uncontaminated by the dev
 * server's lazy filesystem.
 */
export async function newIsolatedPage(browser: Browser, url: string): Promise<Page> {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.goto(url);
    await waitForEditor(page);
    return page;
}

/** Wait for the CodeMirror editor to be ready. */
export async function waitForEditor(page: Page) {
    await page.waitForSelector('.cm-editor', { visible: true });
    await page.waitForSelector('.cm-content', { visible: true });
}

/** Type into the editor content area. */
export async function typeInEditor(page: Page, text: string) {
    await page.click('.cm-content');
    await page.keyboard.type(text);
}

/** Get the current editor text. */
export async function getEditorText(page: Page) {
    return page.$eval('.cm-content', el => el.textContent);
}

/** Get toolbar input value. */
export async function getToolbarValue(page: Page) {
    return page.$eval('.cm-toolbar-input', (el) => (el as HTMLInputElement).value);
}

/** Create a new file via toolbar. */
export async function createFile(page: Page, filename: string) {
    await page.click('.cm-toolbar-input', { count: 3 }); // triple-click to select all
    await page.type('.cm-toolbar-input', filename);
    // Wait for the dropdown to show results
    await page.waitForSelector('.cm-search-result', { timeout: 2000 });
    // Select the create command (first result)
    const createCommand = await page.$('.cm-command-result');
    if (createCommand) {
        await createCommand.click();
    } else {
        await page.keyboard.press('Enter');
    }
    // Wait for file to load and editor to become editable
    await waitForFileReady(page, filename);
}

/** Open an existing file via toolbar. */
export async function openFile(page: Page, filename: string) {
    await page.click('.cm-toolbar-input', { count: 3 });
    await page.type('.cm-toolbar-input', filename);
    await page.waitForSelector('.cm-file-result', { timeout: 3000 });
    await page.click('.cm-file-result');
    // Wait for file to load and editor to become editable
    await waitForFileReady(page, filename);
}

/** Wait for file loading to complete and editor to be ready for typing.
 *  With LazyVfs, the async chain is: openFileEffect microtask → handleOpen
 *  (async OPFS read) → safeDispatch content + fileLoadedEffect → panel
 *  update syncs toolbar input → readOnly reconfiguration microtask. */
async function waitForFileReady(page: Page, filename: string) {
    // Wait for the toolbar to show the expected filename AND no loading
    // spinner present.  The toolbar input is set twice during file creation:
    // once immediately by the toolbar command handler (before loading starts),
    // and once by the panel update after fileLoadedEffect lands.  The spinner
    // only disappears after the second update, so checking both conditions
    // ensures the full loading pipeline has completed.
    await page.waitForFunction(
        (fn: string) => {
            const input = document.querySelector('.cm-toolbar-input') as HTMLInputElement;
            const loading = document.querySelector('.cm-loading');
            return input?.value === fn && !loading;
        },
        { timeout: 15000 },
        filename,
    );

    // Let remaining microtasks (readOnly reconfiguration, spinner fade) settle
    await new Promise(r => setTimeout(r, 300));
}
