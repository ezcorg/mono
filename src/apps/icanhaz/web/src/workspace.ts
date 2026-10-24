//! The `workspace` capability from a page: the host absolute path a
//! filesystem grant is jailed to, so the page can form the `file://` URIs a
//! native language server speaks. Resource-shaped: `open` presents the grant
//! once and yields the `workspace` object; the answer is read on it and the
//! object released.

import type { Transport } from "./wrpc";
import { open, workspaceRootPath } from "./generated/workspace";
import { drop } from "./generated/resources";

/** The host absolute path `grant` is jailed to. Throws when the grant is not
 *  a live filesystem grant of this connection's. */
export async function workspaceRoot(t: Transport, grant: string): Promise<string> {
    const workspace = await open(t, grant);
    if (workspace.tag !== "ok") throw new Error(`no workspace path: ${workspace.val}`);
    try {
        const root = await workspaceRootPath(t, workspace.val);
        if (root.tag !== "ok") throw new Error(`no workspace path: ${root.val}`);
        return root.val;
    } finally {
        // Best effort: an unreleased object is reclaimed when the connection closes.
        await drop(t, workspace.val).catch(() => {});
    }
}
