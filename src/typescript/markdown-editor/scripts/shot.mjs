#!/usr/bin/env node
// A screenshot of the demo (`pnpm dev`, http://127.0.0.1:5173) after a snippet
// has run against the editor: the way to look at what a change does, in
// light or dark, at any width, before and after.
//
//   pnpm shot out.png [--width 1400] [--height 900] [--dark] [--full]
//        [--clip .mac-window] [--eval "editor.commands.setContent('# Hi')"]
//
// The snippet runs in the page as the body of an async function with
// `editor` bound to `window.editor`; what it returns is printed as JSON. The
// page is loaded fresh (the demo's kept window width and comments-panel
// choice cleared) and shot once the note and its comments are in.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const { chromium } = createRequire(path.join(here, '..', 'package.json'))('playwright')

const args = process.argv.slice(2)
const out = args.find((a) => !a.startsWith('--')) ?? 'shot.png'
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const flag = (name) => args.includes(name)
const url = opt('--url', 'http://127.0.0.1:5173/')

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: Number(opt('--width', 1400)), height: Number(opt('--height', 900)) }, colorScheme: flag('--dark') ? 'dark' : 'light' })
  page.on('pageerror', (e) => console.error('page error:', e.message))
  page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()) })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('ezco-demo-window') || key.startsWith('ezco-mde-comments')) localStorage.removeItem(key) })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.editor && document.querySelector('.ezco-mde-body'))
  await page.waitForFunction(() => window.editor.getText().length > 0 && (window.editor.storage.comments?.comments().length ?? 1) > 0, null, { timeout: 15000 }).catch(() => console.error('the note or its comments did not load in time'))
  await page.waitForTimeout(500)
  if (flag('--dark')) await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); window.editor.commands.setCodeblockTheme({ dark: true }) })
  const snippet = opt('--eval', null)
  if (snippet) {
    const result = await page.evaluate(`(async () => { const editor = window.editor; ${snippet} })()`)
    if (result !== undefined) console.log(JSON.stringify(result, null, 2))
  }
  await page.waitForTimeout(400)
  const clip = opt('--clip', null)
  if (clip) await page.locator(clip).first().screenshot({ path: out })
  else await page.screenshot({ path: out, fullPage: flag('--full') })
  console.log('wrote', out)
} finally {
  await browser.close()
}
