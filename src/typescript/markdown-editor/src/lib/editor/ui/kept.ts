/**
 * What is kept in this browser and nowhere else (a choice, a draft, the
 * emoji picked lately): read and written through localStorage, which may be
 * missing or refused, in which case nothing is kept and nothing breaks.
 */
export function readKept(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

/** Keep `value` under `key`, or forget the key with null. */
export function writeKept(key: string, value: string | null): void {
    try {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
    } catch {
        // Not kept: the default next time.
    }
}
