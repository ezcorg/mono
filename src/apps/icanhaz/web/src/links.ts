//! Backlinks in the editor: the `example:links/links` capability, a store
//! component nobody native provides. The page holds a filesystem grant for
//! the vault and asks the daemon for a `links` grant that lends it; the
//! index that `open` yields runs on the daemon, reads the vault through the
//! delegated grant, and answers here. The token once, at `open`; the object
//! released when the page is done.
//!
//! The editor never sees any of this: it takes a `LinkIndex` and a
//! `LinkResolver` (`@joinezco/storage`'s contracts), and `editorLinks` makes
//! the capability into both.

import {
    decodeDestination,
    dirname,
    joinPath,
    newNotePath,
    type LinkIndex,
    type LinkResolver,
    type VfsInterface,
} from "@joinezco/storage";
import type { Transport } from "./wrpc";
import { request, requestScoped } from "./generated/broker";
import { open, indexBacklinks, indexUnresolved, indexRename, type Link } from "./generated/links";
import { drop } from "./generated/resources";

export const LINKS_INTERFACE = "example:links/links@0.1.0";
export type { Link };

/** The capability's index: the editor's `LinkIndex`, plus a release. */
export interface LinksIndex extends LinkIndex {
    /** Release the index on the daemon. */
    close(): Promise<void>;
}

/**
 * Ask for a `links` grant provided by the component `provider` (a store hash,
 * with an optional `source` the daemon fetches it from when it lacks it),
 * lending it `filesystemGrant`. `allow` narrows what the grant may do, a CEL
 * clause over the interface (`call.method != "rename"` for a read-only index).
 */
export async function requestLinksGrant(
    t: Transport,
    opts: { provider: string; source?: string; filesystemGrant: string; reason?: string; allow?: string },
): Promise<string> {
    const want = {
        tag: "component" as const,
        val: { provides: LINKS_INTERFACE, provider: opts.provider, delegated: [opts.filesystemGrant], source: opts.source },
    };
    const reason = opts.reason ?? "index the links between your notes";
    const res = opts.allow
        ? await requestScoped(t, want, { when: "true", allow: opts.allow }, reason, undefined)
        : await request(t, want, reason, undefined);
    if (res.tag !== "ok") throw new Error(`links grant refused: ${JSON.stringify(res.val)}`);
    return res.val.token;
}

/** Open the index for a `links` grant. */
export async function openLinks(t: Transport, grant: string): Promise<LinksIndex> {
    const opened = await open(t, grant);
    if (opened.tag !== "ok") throw new Error(`links refused: ${opened.val}`);
    const index = opened.val;
    const unwrap = <T,>(r: { tag: "ok"; val: T } | { tag: "err"; val: string }): T => {
        if (r.tag !== "ok") throw new Error(r.val);
        return r.val;
    };
    return {
        backlinks: async (note) => unwrap(await indexBacklinks(t, index, note)),
        unresolved: async () => unwrap(await indexUnresolved(t, index)),
        rename: async (oldPath, newPath) => unwrap(await indexRename(t, index, oldPath, newPath)),
        close: async () => {
            await drop(t, index).catch(() => {});
        },
    };
}

/**
 * The capability as the editor's links, available before the grant is: the
 * index answers with nothing until `pending` resolves and then tells the
 * editor to ask again, so the page need not wait on consent to show the
 * note. The capability re-reads the vault on every query; what makes the
 * editor ask again when another client changes a note is the filesystem's
 * own watch, passed on as the index's `subscribe`.
 *
 * The resolver follows the capability's rule, so the editor and the index
 * agree on what a link points at: a wikilink names a note beside the linking
 * one (`.md` implied), a Markdown link is a path from it.
 */
export function editorLinks(pending: Promise<LinksIndex>, fs: VfsInterface): {
    index: LinksIndex;
    resolver: LinkResolver;
} {
    let ready: LinksIndex | null = null;
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach((listener) => listener());
    void pending.then(
        (index) => {
            ready = index;
            notify();
        },
        (e) => console.warn("links unavailable:", e),
    );

    let watching: AbortController | null = null;
    const watch = () => {
        watching = new AbortController();
        const signal = watching.signal;
        void (async () => {
            try {
                for await (const event of fs.watch(".", { signal })) {
                    if (/\.(md|markdown)$/i.test(event.filename)) notify();
                }
            } catch {
                /* a grant without watch: the editor still asks on every load and save */
            }
        })();
    };

    const index: LinksIndex = {
        backlinks: async (note) => (ready ? ready.backlinks(note) : []),
        unresolved: async () => (ready ? ready.unresolved() : []),
        rename: async (oldPath, newPath) => {
            if (!ready) throw new Error("the links capability is not granted yet");
            return ready.rename(oldPath, newPath);
        },
        subscribe(listener) {
            listeners.add(listener);
            if (!watching) watch();
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) {
                    watching?.abort();
                    watching = null;
                }
            };
        },
        close: async () => {
            watching?.abort();
            await ready?.close();
        },
    };

    const resolver: LinkResolver = {
        async resolve(target, from, syntax = "wikilink") {
            if (!target.trim()) return from ? { path: from, exists: true } : null;
            const path =
                syntax === "markdown"
                    ? joinPath(decodeDestination(target).startsWith("/") || !from ? "" : dirname(from), decodeDestination(target))
                    : newNotePath(target, from);
            if (!path) return null;
            return { path, exists: await fs.exists(path) };
        },
        subscribe: index.subscribe,
    };

    return { index, resolver };
}
