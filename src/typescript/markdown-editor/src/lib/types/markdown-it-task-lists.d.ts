declare module 'markdown-it-task-lists' {
    /** markdown-it-task-lists: `- [ ]` and `- [x]` items as checkboxes. */
    const taskLists: (md: unknown, options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean }) => void
    export default taskLists
}
