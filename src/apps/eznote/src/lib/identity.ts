/**
 * Who this device's user is, as far as eznote knows before devices have
 * identities of their own (RFC §9): a handle to write comments as.
 */
import { homeDir } from '@tauri-apps/api/path'

/** A comment handle (`[A-Za-z0-9_.-]+`) from a home folder's path: its
 *  name, which is the login name on every desktop. */
export function handleFromHome(home: string): string {
    const name = home.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    return name.normalize('NFKD').replace(/[^A-Za-z0-9_.-]/g, '') || 'me'
}

/** The handle comments are written as on this device. */
export async function localHandle(): Promise<string> {
    return handleFromHome(await homeDir())
}
