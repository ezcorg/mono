import { TaskItem } from '@tiptap/extension-task-item';
import { wrappingInputRule } from '@tiptap/core';

/**
 * Extended TaskItem extension with configurable input regex rules.
 */
export interface ExtendedTaskItemOptions {
    nested: boolean;
    inputRegex?: RegExp;
}

export const ExtendedTaskItem = TaskItem.extend<ExtendedTaskItemOptions>({
    addOptions() {
        return {
            ...this.parent?.(),
            nested: true,
            inputRegex: /^\s*[-+*]\s\[( |x|X)\](?:\s)?$/, // Match `- [ ]` or `- [x]`, with optional space
        };
    },

    addInputRules() {
        const { inputRegex } = this.options;

        return [
            wrappingInputRule({
                find: inputRegex!,
                type: this.type,
                getAttributes: (match) => {
                    return {
                        checked: match[1] === 'x' || match[1] === 'X',
                    };
                },
            })
        ];
    },
});
