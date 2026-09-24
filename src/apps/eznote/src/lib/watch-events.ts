/**
 * Tauri's file watcher events (plugin-fs, `notify` underneath) as the
 * storage contract's `WatchEvent`s: one per path the event names, relative
 * to the watched directory, so both sides of a rename (`[from, to]`) are
 * reported. Kept apart from the plugin so it can be tested without Tauri.
 */
import type { WatchEvent } from '@joinezco/storage'

/** `path` relative to the directory `dir` (both absolute host paths), with
 *  `/` separators: the watch contract names changes relative to what is
 *  watched. */
export function relativeTo(dir: string, path: string): string {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
    const base = norm(dir)
    const full = norm(path)
    return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : (full.split('/').pop() ?? full)
}

/** An entry created, removed or moved (`rename`), or new contents (`change`). */
function kindOf(type: unknown): WatchEvent['eventType'] {
    if (!type || typeof type !== 'object') return 'change'
    const t = type as Record<string, any>
    if ('create' in t || 'remove' in t || 'rename' in t) return 'rename'
    if (t.modify?.kind === 'rename') return 'rename'
    return 'change'
}

export function watchEventsOf(watched: string, event: { type?: unknown; paths?: string[] }): WatchEvent[] {
    const eventType = kindOf(event?.type)
    return (event?.paths ?? []).map((path) => ({ eventType, filename: relativeTo(watched, path) }))
}
