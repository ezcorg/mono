/**
 * Files a note shows rather than links: images and other attachments,
 * reached through the vault's `VfsInterface` as bytes (a vault path is not
 * a URL a browser can fetch) and shown through object URLs.
 */
import type { Editor } from '@tiptap/core'
import { dirname, extname, joinPath, normalizePath, type VfsInterface } from '@joinezco/storage'
import { decodeDestination, type LinkResolution, type LinkSyntax } from '@joinezco/vault'
import type { WikilinkStorage } from './wikilink'

const MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
}

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'])

export function mimeOf(path: string): string {
    return MIME[extname(path)] ?? 'application/octet-stream'
}

/** A URL the browser can load as it is (not a vault path). */
export function isUrl(src: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')
}

/** The open note's vault path, and the vault. */
export function vaultOf(editor: Editor): { fs?: VfsInterface; path: string | null } {
    const options = (editor.storage as any).persistence?.options
    return { fs: options?.fs, path: options?.filepath ? normalizePath(options.filepath) : null }
}

/**
 * Where a target written in the open note leads: through the host's
 * resolver when there is one (so the editor and the index agree), else as a
 * path from the note.
 */
export async function resolveAsset(editor: Editor, target: string, syntax: LinkSyntax): Promise<LinkResolution | null> {
    const wikilink = (editor.storage as any).wikilink as WikilinkStorage | undefined
    const resolved = await wikilink?.resolveTarget(target, syntax)
    if (resolved !== undefined) return resolved
    const { fs, path: from } = vaultOf(editor)
    const decoded = syntax === 'markdown' ? decodeDestination(target) : target
    const path = joinPath(decoded.startsWith('/') || !from ? '' : dirname(from), decoded)
    if (!path) return null
    return { path, exists: fs ? await fs.exists(path) : false }
}

/** An object URL for a vault file's bytes; revoke it when done. */
export async function objectUrlFor(fs: VfsInterface, path: string): Promise<string> {
    const bytes = await fs.readBytes(path)
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(path) }))
}

/** Obsidian's size suffix on alt text (`![pic|200](a.png)`, `|200x100`);
 *  for an embed, pass its alias with a leading `|`. */
export function sizeOf(text: string | null | undefined): { width?: number; height?: number } {
    const m = /\|\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(text ?? '')
    if (!m) return {}
    return { width: Number(m[1]), height: m[2] ? Number(m[2]) : undefined }
}

/** The alt text without a size suffix. */
export function altOf(text: string | null | undefined): string {
    return (text ?? '').replace(/\|\s*\d+(?:\s*x\s*\d+)?\s*$/, '')
}
