// Main library entry point
export * from './editor/index';
export type { MarkdownEditor, MarkdownEditorOptions } from './editor/index';
export { ContextMenu } from './editor/ui/context-menu';
export type {
    ContextMenuItem,
    ContextMenuOptions,
    ContextMenuCloseReason,
} from './editor/ui/context-menu';
export { PROSE_ACTIONS, completeText, type ChatMessage, type CompletionEvent, type CompletionRequest, type Inference, type ProseAction, type ProseContext } from './editor/inference';
