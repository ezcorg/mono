// Drives a real Chrome through witmproxy against the stand-in YouTube page
// and reports what the plugin's injected agent did, as one JSON line on
// stdout. Invoked by tests/integration_tests.rs; runnable by hand:
//
//   node tests/puppeteer/noshorts.mjs --proxy 127.0.0.1:PORT --origin https://127.0.0.1:PORT --repo ../../..
//
// Prints {"skipped": "<why>"} when puppeteer-core or Chrome cannot be found.

import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] ?? '']);
    return acc;
  }, []),
);
const out = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findPuppeteer(repo) {
  if (process.env.PUPPETEER_CORE) return process.env.PUPPETEER_CORE;
  const dir = path.join(repo, 'node_modules', '.pnpm');
  if (!existsSync(dir)) return null;
  const c = readdirSync(dir).filter((d) => d.startsWith('puppeteer-core@')).sort();
  if (!c.length) return null;
  const p = path.join(dir, c.at(-1), 'node_modules', 'puppeteer-core', 'lib', 'esm', 'puppeteer', 'puppeteer-core.js');
  return existsSync(p) ? p : null;
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (existsSync(base)) {
    for (const v of readdirSync(base).sort().reverse()) {
      const d = path.join(base, v);
      for (const sub of readdirSync(d)) {
        for (const rel of [
          'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome',
          'chrome.exe',
        ]) {
          const p = path.join(d, sub, rel);
          if (existsSync(p)) return p;
        }
      }
    }
  }
  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const repo = path.resolve(args.repo ?? '../../..');
const pp = findPuppeteer(repo);
const chrome = findChrome();
if (!pp) { out({ skipped: 'puppeteer-core not found (pnpm install at the repo root, or set PUPPETEER_CORE)' }); process.exit(0); }
if (!chrome) { out({ skipped: 'no Chrome found (set CHROME_PATH)' }); process.exit(0); }
if (!args.proxy || !args.origin) { out({ error: '--proxy and --origin are required' }); process.exit(2); }

const puppeteer = (await import(pathToFileURL(pp).href)).default;
const r = { chrome, puppeteer: pp };
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: [
      `--proxy-server=http://${args.proxy}`,
      // Chrome never proxies loopback unless told so explicitly.
      '--proxy-bypass-list=<-loopback>',
      '--ignore-certificate-errors',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 700 });
  const origin = args.origin.replace(/\/$/, '');

  // 1. A managed page is rewritten: CSS + agent frame, Shorts UI hidden.
  const first = await page.goto(origin + '/', { waitUntil: 'load' });
  r.firstStatus = first.status();
  r.css = (await page.$('#witm-noshorts-css')) !== null;
  r.frame = (await page.$('#witm-noshorts-agent')) !== null;
  r.shortsLinkHidden = await page.$eval('#shorts-link', (el) => getComputedStyle(el).display === 'none');
  r.shortItemHidden = await page.$eval('#short', (el) => getComputedStyle(el).display === 'none');
  r.shortsShelfHidden = await page.$eval('#shorts-shelf', (el) => getComputedStyle(el).display === 'none');
  r.plainShelfVisible = await page.$eval('#plain-shelf', (el) => getComputedStyle(el).display !== 'none');

  // 2. The agent scores feed titles and hides the bait.
  try {
    await page.waitForFunction(() => document.querySelector('[data-witm-hidden]') !== null, { timeout: 15000 });
  } catch (_) {}
  r.baitHidden = await page.$eval('#bait', (el) => getComputedStyle(el).display === 'none');
  r.rageHidden = await page.$eval('#rage', (el) => getComputedStyle(el).display === 'none');
  r.plainVisible = await page.$eval('#plain', (el) => getComputedStyle(el).display !== 'none');
  r.baitReason = await page.$eval('#bait', (el) => el.dataset.witmHidden ?? null);

  // 3. Activity is metered; the overlay engages once the budget is spent.
  const started = Date.now();
  let engaged = false;
  while (Date.now() - started < 25000) {
    await page.mouse.move(100 + Math.random() * 400, 100 + Math.random() * 300);
    await sleep(250);
    engaged = await page.$eval('#witm-noshorts-agent', (el) => {
      const b = el.getBoundingClientRect();
      return b.width >= innerWidth - 1 && b.height >= innerHeight - 1 && getComputedStyle(el).opacity === '1';
    });
    if (engaged) break;
  }
  r.overlayEngaged = engaged;
  r.overlayAfterMs = Date.now() - started;
  if (engaged) {
    // The frame navigates itself to the block page; give it a moment.
    for (let i = 0; i < 40 && !r.overlayText; i++) {
      const f = page.frames().find((f) => f.url().includes('/__witm/noshorts/blocked'));
      if (f) {
        try { r.overlayText = await f.evaluate(() => document.body.innerText); } catch (_) {}
      }
      if (!r.overlayText) await sleep(250);
    }
  }

  // 4. Every further navigation on the host gets the block page.
  const watch = await page.goto(origin + '/watch?v=plain', { waitUntil: 'load' });
  r.watchStatus = watch.status();
  r.watchReason = watch.headers()['x-witm-noshorts'] ?? null;
  r.watchText = await page.evaluate(() => document.body.innerText.slice(0, 200));
  const shorts = await page.goto(origin + '/shorts/abc123', { waitUntil: 'load' });
  r.shortsStatus = shorts.status();
  r.shortsReason = shorts.headers()['x-witm-noshorts'] ?? null;

  r.ok = r.firstStatus === 200 && r.css && r.frame && r.shortsLinkHidden && r.shortItemHidden
    && r.shortsShelfHidden && r.plainShelfVisible
    && r.baitHidden && r.rageHidden && r.plainVisible
    && r.overlayEngaged && /enough YouTube for today/.test(r.overlayText ?? '')
    && r.watchStatus === 403 && r.watchReason === 'budget'
    && r.shortsStatus === 403 && r.shortsReason === 'shorts';
} catch (e) {
  r.error = String(e && e.stack || e);
  r.ok = false;
} finally {
  if (browser) await browser.close();
}
out(r);
