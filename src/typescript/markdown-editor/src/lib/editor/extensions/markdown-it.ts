/**
 * What every extension's markdown-it setup shares. tiptap-markdown calls
 * each extension's `parse.setup` with the editor's one parser on every
 * `parse()` (each load, each paste), so a setup that added its rules each
 * time would stack them: it runs once per parser instead. `markdown-it` is
 * tiptap-markdown's dependency, not reachable from here, so the parser is
 * untyped.
 */

/** Runs `fn` once per parser: a later call with the same `key` (the
 *  feature's name) on the same `md` does nothing. */
export function setupOnce(md: any, key: string, fn: () => void): void {
    const done: Set<string> = (md.__ezcoSetup ??= new Set())
    if (done.has(key)) return
    done.add(key)
    fn()
}

/** A core rule `name` that hands `visit` every top-level token of `type`
 *  once the document is tokenized (a list's open token, a paragraph's
 *  `inline`), to mark on it what it was written as. */
export function eachToken(md: any, name: string, type: string, visit: (token: any) => void): void {
    md.core.ruler.push(name, (state: any) => {
        for (const token of state.tokens) if (token.type === type) visit(token)
    })
}
