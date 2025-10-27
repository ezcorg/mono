# Markdown Editor Testing Guide

This document explains how to use the testing setup for the `@joinezco/markdown-editor` library.

## Overview

The testing setup uses **Vitest** with **browser testing capabilities** to test the markdown editor in a real browser environment. This allows us to test DOM interactions, keyboard events, and the actual rendering behavior of the editor.

## Setup

### Dependencies

The following testing dependencies are included:

- `vitest` - Fast unit test framework
- `@vitest/browser` - Browser testing support
- `@vitest/ui` - Web UI for test results
- `playwright` - Browser automation for testing
- `jsdom` - DOM implementation for Node.js
- `webdriverio` - WebDriver implementation

### Configuration

The testing is configured in [`vitest.config.ts`](./vitest.config.ts) with:

- **Browser testing enabled** using Playwright with Chromium
- **Test environment** set up with proper DOM mocking
- **Coverage reporting** with v8 provider
- **Custom setup file** for browser environment preparation

## Running Tests

### Available Scripts

```bash
# Run tests in watch mode
npm run test

# Run tests with UI
npm run test:ui

# Run tests in browser mode
npm run test:browser

# Run tests once and exit
npm run test:run

# Run tests with coverage
npm run test:coverage
```

### Test Files

Tests are located in the `src/test/` directory:

- [`setup.ts`](./src/test/setup.ts) - Global test setup and browser mocks
- [`utils.ts`](./src/test/utils.ts) - Testing utilities for markdown editor
- [`editor.test.ts`](./src/test/editor.test.ts) - Core editor functionality tests
- [`extensions.test.ts`](./src/test/extensions.test.ts) - Extension-specific tests

## Testing Utilities

The [`utils.ts`](./src/test/utils.ts) file provides comprehensive utilities for testing the markdown editor:

### DOM Management

```typescript
// Create a test container
const container = createTestContainer()

// Create and initialize editor
const editor = await createTestEditor(container)
await waitForEditor(editor)

// Cleanup after test
cleanupEditor(editor, container)
```

### Content Management

```typescript
// Get current markdown content
const content = getMarkdownContent(editor)

// Set new markdown content
setMarkdownContent(editor, '# New Content')

// Get HTML output
const html = getHTMLContent(editor)
```

### User Interactions

```typescript
// Focus the editor
focusEditor(editor)

// Type text
typeText(editor, 'Hello, World!')

// Simulate key presses
pressKey(editor, 'b', { ctrl: true }) // Ctrl+B for bold

// Set cursor position
setSelection(editor, 0, 10) // Select characters 0-10
```

### Async Operations

```typescript
// Wait for conditions
await waitFor(() => editor.isFocused, 5000)

// Wait for editor to be ready
await waitForEditor(editor)
```

## Test Categories

### Basic Editor Functionality

Tests core editor features:
- Editor initialization and DOM rendering
- Content getting/setting
- Focus management
- Selection handling

### Markdown Content Management

Tests markdown processing:
- Content conversion between markdown and HTML
- Handling of various markdown syntax
- Content validation and error handling

### Text Input and Editing

Tests user input:
- Text insertion at cursor position
- Line breaks and formatting
- Keyboard shortcuts (Ctrl+B, Ctrl+I, etc.)

### Extension Testing

Tests specific editor extensions:
- **Task Lists** - Checkbox rendering and interaction
- **Tables** - Table rendering and navigation
- **Links** - Link detection and rendering
- **Code Blocks** - Syntax highlighting and language support
- **Slash Commands** - Command menu functionality

### Browser-specific Features

Tests browser interactions:
- Copy/paste operations
- Undo/redo functionality
- Keyboard event handling
- DOM event simulation

## Writing New Tests

### Basic Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MarkdownEditor } from '../lib/editor'
import {
  createTestContainer,
  createTestEditor,
  waitForEditor,
  cleanupEditor,
} from './utils'

describe('My Feature', () => {
  let container: HTMLElement
  let editor: MarkdownEditor

  beforeEach(async () => {
    container = createTestContainer()
    editor = await createTestEditor(container)
    await waitForEditor(editor)
  })

  afterEach(() => {
    cleanupEditor(editor, container)
  })

  it('should do something', () => {
    // Your test code here
    expect(editor).toBeDefined()
  })
})
```

### Testing Editor State

```typescript
it('should update content correctly', () => {
  setMarkdownContent(editor, '# Test Heading')
  const content = getMarkdownContent(editor)
  expect(content).toContain('# Test Heading')
  
  const html = getHTMLContent(editor)
  expect(html).toContain('<h1>Test Heading</h1>')
})
```

### Testing User Interactions

```typescript
it('should handle keyboard shortcuts', () => {
  focusEditor(editor)
  typeText(editor, 'bold text')
  setSelection(editor, 0, 9) // Select "bold text"
  
  pressKey(editor, 'b', { ctrl: true })
  
  const content = getMarkdownContent(editor)
  expect(content).toContain('**bold text**')
})
```

### Testing Async Operations

```typescript
it('should handle async updates', async () => {
  let updateTriggered = false
  
  const testEditor = await createTestEditor(container, {
    onUpdate: () => { updateTriggered = true }
  })
  
  typeText(testEditor, 'New content')
  
  await waitFor(() => updateTriggered, 2000)
  expect(updateTriggered).toBe(true)
})
```

## Browser Testing Features

### Real DOM Environment

Tests run in a real browser environment (Chromium via Playwright), providing:
- Accurate DOM rendering
- Real event handling
- Proper CSS layout
- Browser-specific behaviors

### Visual Testing

While not implemented in the current setup, the browser environment supports:
- Screenshot comparison testing
- Visual regression testing
- Layout testing

### Performance Testing

The browser environment allows for:
- Measuring render times
- Testing with large documents
- Memory usage monitoring

## Debugging Tests

### Using the UI

Run tests with the UI for better debugging:

```bash
npm run test:ui
```

This opens a web interface showing:
- Test results and failures
- Test execution timeline
- Code coverage reports
- Interactive test running

### Browser DevTools

When running browser tests, you can:
- Set `headless: false` in `vitest.config.ts`
- Use browser DevTools for debugging
- Inspect the actual DOM during tests

### Console Logging

Add debug logging in tests:

```typescript
it('should debug editor state', () => {
  console.log('Editor state:', editor.state)
  console.log('Current content:', getMarkdownContent(editor))
  // ... test code
})
```

## Best Practices

### Test Isolation

- Always use `beforeEach`/`afterEach` for setup/cleanup
- Create fresh editor instances for each test
- Clean up DOM elements after tests

### Async Handling

- Use `await waitForEditor()` after creating editors
- Use `waitFor()` for conditional waiting
- Handle async operations properly

### Realistic Testing

- Test actual user interactions (typing, clicking)
- Use real markdown content in tests
- Test edge cases and error conditions

### Performance

- Keep tests focused and fast
- Use appropriate timeouts
- Clean up resources properly

## Troubleshooting

### Common Issues

1. **Editor not ready**: Always use `await waitForEditor(editor)` after creation
2. **DOM not found**: Ensure container is created and editor is initialized
3. **Async timing**: Use `waitFor()` for conditions that may take time
4. **Memory leaks**: Always call `cleanupEditor()` in `afterEach`

### Browser Issues

1. **Headless failures**: Set `headless: false` for debugging
2. **Timeout errors**: Increase timeout values in config
3. **Worker issues**: Check that worker files are accessible

## Contributing

When adding new tests:

1. Follow the existing test structure
2. Add utilities to `utils.ts` for reusable functionality
3. Group related tests in describe blocks
4. Use descriptive test names
5. Include both positive and negative test cases
6. Test browser-specific behaviors when relevant

## Future Enhancements

Potential improvements to the testing setup:

- Visual regression testing with screenshot comparison
- Performance benchmarking tests
- Accessibility testing integration
- Cross-browser testing support
- Integration with CI/CD pipelines
- Test data generation utilities