/**
 * CBOR (RFC 8949), as much as snapshots need: the encoder writes null,
 * booleans, numbers, strings, bytes, arrays and string-keyed maps; the
 * decoder reads any well-formed item (tags are read through, big integers
 * become numbers), so snapshots written by other encoders load too.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeCbor(value: unknown): Uint8Array {
    let buf = new Uint8Array(1024)
    let view = new DataView(buf.buffer)
    let at = 0

    const room = (n: number) => {
        if (at + n <= buf.length) return
        let size = buf.length * 2
        while (size < at + n) size *= 2
        const next = new Uint8Array(size)
        next.set(buf.subarray(0, at))
        buf = next
        view = new DataView(buf.buffer)
    }
    const head = (major: number, n: number) => {
        room(9)
        const m = major << 5
        if (n < 24) buf[at++] = m | n
        else if (n < 0x100) (buf[at++] = m | 24), (buf[at++] = n)
        else if (n < 0x10000) (buf[at++] = m | 25), view.setUint16(at, n), (at += 2)
        else if (n < 0x100000000) (buf[at++] = m | 26), view.setUint32(at, n), (at += 4)
        else (buf[at++] = m | 27), view.setBigUint64(at, BigInt(n)), (at += 8)
    }
    const bytes = (data: Uint8Array) => {
        room(data.length)
        buf.set(data, at)
        at += data.length
    }
    const write = (v: unknown): void => {
        if (v === null || v === undefined) {
            room(1)
            buf[at++] = v === null ? 0xf6 : 0xf7
        } else if (typeof v === 'boolean') {
            room(1)
            buf[at++] = v ? 0xf5 : 0xf4
        } else if (typeof v === 'number') {
            if (Number.isSafeInteger(v)) head(v < 0 ? 1 : 0, v < 0 ? -1 - v : v)
            else {
                room(9)
                buf[at++] = 0xfb
                view.setFloat64(at, v)
                at += 8
            }
        } else if (typeof v === 'string') {
            const utf8 = encoder.encode(v)
            head(3, utf8.length)
            bytes(utf8)
        } else if (v instanceof Uint8Array) {
            head(2, v.length)
            bytes(v)
        } else if (Array.isArray(v)) {
            head(4, v.length)
            for (const item of v) write(item)
        } else if (typeof v === 'object') {
            const entries = Object.entries(v)
            head(5, entries.length)
            for (const [key, item] of entries) {
                write(key)
                write(item)
            }
        } else {
            throw new TypeError(`CBOR: cannot encode a ${typeof v}`)
        }
    }

    write(value)
    return buf.slice(0, at)
}

export function decodeCbor(data: Uint8Array): unknown {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    let at = 0
    const BREAK = Symbol('break')

    const need = (n: number) => {
        if (at + n > data.length) throw new RangeError('CBOR: truncated')
    }
    const length = (info: number): number => {
        if (info < 24) return info
        const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
        if (!size) throw new RangeError(`CBOR: bad length ${info}`)
        need(size)
        const n =
            size === 1 ? view.getUint8(at) : size === 2 ? view.getUint16(at) : size === 4 ? view.getUint32(at) : Number(view.getBigUint64(at))
        at += size
        return n
    }
    const chunked = (major: number): Uint8Array => {
        const parts: Uint8Array[] = []
        for (;;) {
            const part = read()
            if (part === BREAK) break
            parts.push(major === 3 ? encoder.encode(part as string) : (part as Uint8Array))
        }
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
        let o = 0
        for (const p of parts) (out.set(p, o), (o += p.length))
        return out
    }
    const half = (bits: number) => {
        const exp = (bits >> 10) & 0x1f
        const frac = bits & 0x3ff
        const sign = bits & 0x8000 ? -1 : 1
        if (exp === 0) return sign * 2 ** -14 * (frac / 1024)
        if (exp === 31) return frac ? NaN : sign * Infinity
        return sign * 2 ** (exp - 15) * (1 + frac / 1024)
    }

    const read = (): unknown => {
        need(1)
        const initial = data[at++]
        const major = initial >> 5
        const info = initial & 0x1f
        if (major === 7) {
            switch (info) {
                case 20:
                    return false
                case 21:
                    return true
                case 22:
                    return null
                case 23:
                    return undefined
                case 25: {
                    need(2)
                    const v = half(view.getUint16(at))
                    at += 2
                    return v
                }
                case 26: {
                    need(4)
                    const v = view.getFloat32(at)
                    at += 4
                    return v
                }
                case 27: {
                    need(8)
                    const v = view.getFloat64(at)
                    at += 8
                    return v
                }
                case 31:
                    return BREAK
                default:
                    if (info < 24) return undefined // an unassigned simple value
                    need(1)
                    at++
                    return undefined
            }
        }
        const indefinite = info === 31
        if (indefinite && (major === 2 || major === 3)) {
            const joined = chunked(major)
            return major === 3 ? decoder.decode(joined) : joined
        }
        if (indefinite && major !== 4 && major !== 5) throw new RangeError('CBOR: bad indefinite item')
        const n = indefinite ? Infinity : length(info)
        switch (major) {
            case 0:
                return n
            case 1:
                return -1 - n
            case 2:
            case 3: {
                need(n)
                const slice = data.slice(at, at + n)
                at += n
                return major === 3 ? decoder.decode(slice) : slice
            }
            case 4: {
                const out: unknown[] = []
                for (let i = 0; i < n; i++) {
                    const item = read()
                    if (item === BREAK) break
                    out.push(item)
                }
                return out
            }
            case 5: {
                const out: Record<string, unknown> = {}
                for (let i = 0; i < n; i++) {
                    const key = read()
                    if (key === BREAK) break
                    out[String(key)] = read()
                }
                return out
            }
            default:
                // A tag: the tagged item stands for itself.
                return read()
        }
    }

    return read()
}
