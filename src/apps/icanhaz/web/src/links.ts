//! Backlinks in the editor: the `example:links/links` capability, a store
//! component nobody native provides. The page holds a filesystem grant for
//! the vault and asks the daemon for a `links` grant that lends it; the
//! index that `open` yields runs on the daemon, reads the vault through the
//! delegated grant, and answers here. The token once, at `open`; the object
//! released when the page is done.

import type { Transport } from "./wrpc";
import { request, requestScoped } from "./generated/broker";
import { open, indexBacklinks, indexUnresolved, indexRename, type Link } from "./generated/links";
import { drop } from "./generated/resources";

export const LINKS_INTERFACE = "example:links/links@0.1.0";
export type { Link };

export interface LinksIndex {
    /** The links into `note`, a vault-relative path. */
    backlinks(note: string): Promise<Link[]>;
    /** Every link whose target does not exist. */
    unresolved(): Promise<Link[]>;
    /** Move a note and rewrite every link to it; how many were rewritten. */
    rename(oldPath: string, newPath: string): Promise<number>;
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
