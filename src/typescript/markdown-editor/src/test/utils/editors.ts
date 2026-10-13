import { afterEach } from 'vitest'
import { memoryVfs, type VfsInterface } from '@joinezco/storage'
import { Vault } from '@joinezco/vault'
import { createEditor, settingsOf, type CommentsStorage, type MarkdownEditor, type MarkdownEditorOptions } from '../../lib/editor'
import type { SettingsStorage } from '../../lib/editor/settings'
import type { FileEvent, FileSystemStorage } from '../../lib/editor/extensions/filesystem'
import { cleanupEditor, createTestContainer, waitFor } from './base'

/**
 * Editors as a test file makes them: tracked, so each test's are destroyed
 * after it with their containers and vaults; over a vault of a few files,
 * wired the way a host wires one; and the small waits every file needs.
 */

/** `n` animation frames: Tiptap mounts after a tick, and layout settles a frame later. */
export async function frames(n = 2): Promise<void> {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r))
}

/** `ms` of the clock: a debounce, a transition, a save. */
export const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The path the editor's persistence has open. */
export const filepath = (editor: MarkdownEditor) => (editor.storage as any).persistence.options.filepath as string

/** What the chrome kept in this browser (a panel's choice, a draft, a setting): forgotten. */
export function wipeStorage(): void {
    for (const key of Object.keys(localStorage)) if (key.startsWith('ezco-mde-') || key.startsWith('ezco-settings:')) localStorage.removeItem(key)
}

/** A container's size; `scroll` makes it the note's scroller. */
export interface Size {
    width?: number
    height?: number
    scroll?: boolean
}

function sized(container: HTMLElement, size?: Size): HTMLElement {
    if (size?.width !== undefined) container.style.width = `${size.width}px`
    if (size?.height !== undefined) container.style.height = `${size.height}px`
    if (size?.scroll) container.style.overflowY = 'auto'
    return container
}

export type MakeOptions = Partial<MarkdownEditorOptions> & { size?: Size }

export interface Made {
    editor: MarkdownEditor
    container: HTMLElement
    vault?: Vault
}

/**
 * What a vault gives the editor besides its files: the link resolver, the
 * link index (the links panel with it), search, file operations, comments
 * (with their reactions, the identity as author), versions.
 */
export type Service = 'resolver' | 'index' | 'search' | 'files' | 'comments' | 'versions'

export interface VaultOptions extends MakeOptions {
    /** The file to open: the first `.md` of the files unless given. */
    path?: string
    /** Who is looking: the vault's identity, and the author of comments. */
    identity?: string
    /** Saves as the note changes (not unless asked, as the editor itself). */
    autoSave?: boolean
    /** The vault watches its files (a memory filesystem has nothing to watch). */
    watch?: boolean
    /** A filesystem to open instead of a fresh one over the files. */
    on?: VfsInterface
    /** A vault already open, used as it is (closed after the test all the same). */
    vault?: Vault
    /** The resolver, index, search and file operations unless said otherwise. */
    services?: Service[]
    /** When the editor is ready: the note's text in, unless given (and, with
     *  comments wired, every comment on the note at its text). */
    until?: (editor: MarkdownEditor, opened: Opened) => boolean
    /** How long `until` may take. */
    timeout?: number
}

/** An editor over a vault, and the services a test reads. */
export interface Opened extends Made {
    vault: Vault
    fs: VfsInterface
    /** The comments extension's storage (the extension is on unless the editor was made with `comments: false`). */
    comments: CommentsStorage
    settings: SettingsStorage | null
    persistence: FileSystemStorage
    /** Every load and save since the editor was made. */
    events: FileEvent[]
}

const noteOf = (files: Record<string, unknown>) => Object.keys(files).find((p) => p.endsWith('.md')) ?? Object.keys(files)[0]

/**
 * The editors a file makes, each test's destroyed after it (containers
 * removed, vaults closed), the chrome's localStorage wiped and anything
 * left floating under the body removed. `also` runs first, for a file's
 * own leftovers (a theme attribute, a button of its own).
 *
 * `created` is the list itself, for an editor made by hand in a test.
 */
export function trackEditors(hooks: { also?: () => void } = {}) {
    const created: Made[] = []

    function cleanup(): void {
        hooks.also?.()
        created.forEach(({ editor, container, vault }) => {
            cleanupEditor(editor, container)
            vault?.close()
        })
        created.length = 0
        wipeStorage()
        for (const left of document.querySelectorAll('.ezco-mde-comment-overlay-frame')) left.remove()
    }
    afterEach(cleanup)

    /** An editor made elsewhere, destroyed with the others. */
    function track(editor: MarkdownEditor, container: HTMLElement, vault?: Vault): Made {
        const made: Made = vault ? { editor, container, vault } : { editor, container }
        created.push(made)
        return made
    }

    /** An editor in a fresh container: `make('# A note')`, or the options as a host gives them. */
    function make(content: string | MakeOptions = {}, options: MakeOptions = {}): Made {
        const { size, ...rest } = typeof content === 'string' ? { content, ...options } : { ...content, ...options }
        const container = sized(createTestContainer(`editor-${created.length}`), size)
        const editor = createEditor({ element: container, ...rest })
        return track(editor, container)
    }

    /** An editor to type in: made, mounted (Tiptap mounts after a tick), focused. */
    async function typing(content = '', options: MakeOptions = {}): Promise<Made> {
        const made = make(content, options)
        await frames()
        made.editor.commands.focus()
        await frames()
        return made
    }

    /** An editor on `path` of a vault over `files`, the vault's services wired as asked. */
    async function openVault(files: Record<string, string | Uint8Array>, options: VaultOptions = {}): Promise<Opened> {
        const {
            path = noteOf(files),
            identity,
            autoSave = false,
            watch = false,
            on,
            vault: given,
            services = ['resolver', 'index', 'search', 'files'],
            until,
            timeout = 3000,
            links,
            comments: extraComments,
            ...rest
        } = options
        const vault = given ?? (await Vault.open(on ?? memoryVfs(files), { watch, identity }))
        const has = (service: Service) => services.includes(service)
        const withComments = has('comments') || (extraComments !== undefined && extraComments !== false)
        const made = make({
            ...rest,
            fs: { fs: vault.fs, filepath: path, autoSave },
            ...(has('resolver') || has('index') || links
                ? { links: { ...(has('resolver') || has('index') ? { resolver: vault.links } : {}), ...(has('index') ? { index: vault.links } : {}), ...links } }
                : {}),
            ...(has('search') ? { search: vault.search } : {}),
            ...(has('files') ? { files: vault.files } : {}),
            ...(has('versions') ? { versions: vault.versions } : {}),
            ...(withComments ? { comments: { author: identity, index: vault.comments, reactions: vault.reactions, ...(extraComments || {}) } } : {}),
        })
        made.vault = vault
        const { editor } = made
        const persistence = (editor.storage as any).persistence as FileSystemStorage
        const events: FileEvent[] = []
        persistence.subscribe((event) => events.push(event))
        const comments = (editor.storage as any).comments as CommentsStorage
        const opened: Opened = { ...made, vault, fs: vault.fs, comments, settings: settingsOf(editor), persistence, events }
        if (until) {
            await waitFor(() => until(editor, opened), timeout)
        } else {
            await waitFor(() => editor.getText().length > 0, timeout)
            if (withComments) {
                // Every comment on the note (the documents referencing it), at its text.
                const name = path.replace(/\.md$/, '')
                const base = name.slice(name.lastIndexOf('/') + 1)
                const expected = Object.values(files).filter((text) => typeof text === 'string' && (text.startsWith(`![[${base}#`) || text.startsWith(`![[${name}#`))).length
                await waitFor(() => comments.comments().length === expected && comments.comments().every((c) => c.target.range !== null), 5000)
            }
        }
        return opened
    }

    return { created, make, typing, track, openVault, cleanup }
}
