/**
 * A name for this device, kept where the device keeps things (the
 * browser's localStorage; a host may keep it elsewhere and pass it in):
 * what the device scope's file is named by. Made once, short and random.
 */
export interface Keep {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
}

const KEY = 'ezco-device'
let made: string | null = null

export function deviceId(keep: Keep | null = defaultKeep(), key = KEY): string {
    try {
        const kept = keep?.getItem(key)
        if (kept) return kept
    } catch {
        // Not kept: a name for this run.
    }
    made ??= randomName()
    try {
        keep?.setItem(key, made)
    } catch {
        // Not kept.
    }
    return made
}

function defaultKeep(): Keep | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
        return null
    }
}

function randomName(): string {
    const bytes = new Uint8Array(4)
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
