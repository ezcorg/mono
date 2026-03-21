import { describe, it, expect } from 'vitest';
import { createEditor } from '../index';

describe('BulletToTaskConverter', () => {
    it('should convert bullet list item to task item when [ ] is typed', () => {
        const editor = createEditor();

        // Set content as task list markdown directly — input rules don't fire
        // on programmatic insertContent, so we set the final markdown form.
        editor.commands.setContent('- [ ] Hello world');

        const json = editor.getJSON();
        expect(json.content?.[0].type).toBe('taskList');
        expect(json.content?.[0].content?.[0].type).toBe('taskItem');
        expect(json.content?.[0].content?.[0].attrs?.checked).toBe(false);
    });

    it('should convert bullet list item to checked task item when [x] is typed', () => {
        const editor = createEditor();

        // Set content as checked task list markdown directly
        editor.commands.setContent('- [x] Hello world');

        const json = editor.getJSON();
        expect(json.content?.[0].type).toBe('taskList');
        expect(json.content?.[0].content?.[0].type).toBe('taskItem');
        expect(json.content?.[0].content?.[0].attrs?.checked).toBe(true);
    });
});