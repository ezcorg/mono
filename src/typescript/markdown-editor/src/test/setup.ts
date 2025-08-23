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

// Mock window.matchMedia for tests
Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => { },
        removeListener: () => { },
        addEventListener: () => { },
        removeEventListener: () => { },
        dispatchEvent: () => { },
    }),
})

// Mock ResizeObserver
globalThis.ResizeObserver = class ResizeObserver {
    observe() { }
    unobserve() { }
    disconnect() { }
}

// Mock IntersectionObserver
globalThis.IntersectionObserver = class IntersectionObserver {
    root = null
    rootMargin = ''
    thresholds = []

    constructor() { }
    observe() { }
    unobserve() { }
    disconnect() { }
    takeRecords() { return [] }
}

// Mock getComputedStyle
Object.defineProperty(window, 'getComputedStyle', {
    value: () => ({
        getPropertyValue: () => '',
    }),
})