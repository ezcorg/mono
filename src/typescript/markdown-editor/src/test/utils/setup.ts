import { beforeAll, afterEach } from 'vitest'

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
