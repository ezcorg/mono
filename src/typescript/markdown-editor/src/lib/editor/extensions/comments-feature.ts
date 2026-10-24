/**
 * The switch the comments work is behind. Comments (`comments.ts`, the
 * marks in `comment-gutter.ts`, the margin in `comment-margin.ts` with
 * `comment-inline.ts`, `comment-composer.ts` and `comment-render.ts`, the
 * `comments` group of the settings) are in the tree but not finished: how
 * they are shown is not settled, and how they are stored is likely to
 * change. Off, an editor is made without them whatever its `comments`
 * option says: no comment extensions, no annotation column or comments
 * column beside the note, no `Comments` settings in the toolbar or in
 * `schema.json`. A note's reference blocks and spans are still the
 * documents they are, and round-trip as written; the identity given as
 * `comments.author` still names the vault's identity and whose settings
 * are read. The tests turn the work on (`enableComments`, in
 * `src/test/utils/setup.ts`) so it keeps passing until it ships; the demo
 * does with `?comments` in its URL.
 */
let enabled = false

/** Whether an editor made now gets the comments work. */
export function commentsEnabled(): boolean {
    return enabled
}

/** Turn the comments work on (the tests, the demo) or off, for editors made after. */
export function enableComments(on = true): void {
    enabled = on
}
