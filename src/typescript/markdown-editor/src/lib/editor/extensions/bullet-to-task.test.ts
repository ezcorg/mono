import { describe, it, expect } from 'vitest';
import { createEditor } from '../index';

describe('BulletToTaskConverter', () => {
    it('should convert bullet list item to task item when [ ] is typed', () => {
        const editor = createEditor();

        // Set initial content with a bullet list
        editor.commands.setContent('* Hello world');

        // Simulate editing the content to add [ ]
        editor.commands.setTextSelection(2); // Position after "* "
        editor.commands.insertContent('[ ] ');

        // Check if it converted to a task item
        const json = editor.getJSON();
        expect(json.content?.[0].type).toBe('taskList');
        expect(json.content?.[0].content?.[0].type).toBe('taskItem');
        expect(json.content?.[0].content?.[0].attrs?.checked).toBe(false);
    });

    it('should convert bullet list item to checked task item when [x] is typed', () => {
        const editor = createEditor();

        // Set initial content with a bullet list
        editor.commands.setContent('* Hello world');

        // Simulate editing the content to add [x]
        editor.commands.setTextSelection(2); // Position after "* "
        editor.commands.insertContent('[x] ');

        // Check if it converted to a checked task item
        const json = editor.getJSON();
        expect(json.content?.[0].type).toBe('taskList');
        expect(json.content?.[0].content?.[0].type).toBe('taskItem');
        expect(json.content?.[0].content?.[0].attrs?.checked).toBe(true);
    });
});