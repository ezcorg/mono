import { Browser, Page } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

export const CHROME_PATH = '/usr/bin/google-chrome';
export const DEV_SERVER = 'http://localhost:5173';

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
    // Wait for file to load
    await new Promise(r => setTimeout(r, 500));
}

/** Open an existing file via toolbar. */
export async function openFile(page: Page, filename: string) {
    await page.click('.cm-toolbar-input', { count: 3 });
    await page.type('.cm-toolbar-input', filename);
    await page.waitForSelector('.cm-file-result', { timeout: 3000 });
    await page.click('.cm-file-result');
    await new Promise(r => setTimeout(r, 500));
}
