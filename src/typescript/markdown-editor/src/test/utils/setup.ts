import { beforeAll, afterEach } from 'vitest'
import { enableComments } from '../../lib/editor/extensions/comments-feature'

// The comments work is off for every editor until it ships
// (comments-feature.ts). The suites were written with it on and keep it so,
// so the work keeps passing; `comments-feature.test.ts` is the one place it
// is turned off.
enableComments()

// Global test setup
beforeAll(() => {
    // Setup any global test configuration here
    console.log('Setting up test environment for markdown editor...')
})

// Cleanup after each test
afterEach(() => {
    // Clean up any DOM elements created during tests
    document.body.innerHTML = ''
})

// The suites run in a real browser (Chromium, through Playwright): layout,
// computed styles, observers and media queries are the browser's own, so
// what a test measures is what a user sees. Nothing here stands in for them.
