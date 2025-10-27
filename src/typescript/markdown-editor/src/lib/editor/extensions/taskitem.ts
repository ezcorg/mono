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

    addNodeView() {
        return ({ node, getPos, editor }) => {
            const listItem = document.createElement('li');
            listItem.setAttribute('data-type', 'taskItem');
            listItem.setAttribute('data-checked', node.attrs.checked);

            const checkboxWrapper = document.createElement('label');
            checkboxWrapper.contentEditable = 'false';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = node.attrs.checked;

            // Add click handler to the checkbox
            checkbox.addEventListener('change', () => {
                const pos = getPos();
                if (typeof pos === 'number') {
                    const { tr } = editor.state;
                    tr.setNodeMarkup(pos, undefined, {
                        ...node.attrs,
                        checked: checkbox.checked
                    });
                    editor.view.dispatch(tr);
                }
            });

            const content = document.createElement('div');
            content.style.display = 'inline';

            checkboxWrapper.appendChild(checkbox);
            listItem.appendChild(checkboxWrapper);
            listItem.appendChild(content);

            return {
                dom: listItem,
                contentDOM: content,
                update: (updatedNode) => {
                    if (updatedNode.type !== this.type) {
                        return false;
                    }

                    // Update checkbox state when node is updated
                    checkbox.checked = updatedNode.attrs.checked;
                    listItem.setAttribute('data-checked', updatedNode.attrs.checked);
                    return true;
                }
            };
        };
    },
});
