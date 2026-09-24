/**
 * A filesystem on the other side of a message port: a worker's
 * `VfsInterface`, used here as if it were local.
 *
 * `serveVfs(fs, port)` answers for `fs` on a port; `remoteVfs(port)` is the
 * other end. A port is anything with `postMessage` and `message` events: a
 * `MessagePort` (browser or Node), a `Worker`, a worker's own global scope.
 * One request, one reply, numbered, on one port: no channel per call, which
 * is what loses messages under load in Firefox (bugs 1756975, 1594984).
 * Watches stream their events until cancelled.
 *
 * Both ends of a port can serve and call at once (`peer`), which is how the
 * browser workers in `./browser` ask each other for things.
 */
import type { FileStat, VfsInterface, WatchEvent } from './vfs.js'

/** What the protocol needs of a port. */
export interface PortLike {
    postMessage(message: unknown, transfer?: Transferable[]): void
    /** `close`, where the platform sends it (Node; newer browsers), says the
     *  other end hung up. */
    addEventListener(type: 'message' | 'close', listener: (event: MessageEvent) => void): void
    removeEventListener(type: 'message' | 'close', listener: (event: MessageEvent) => void): void
    start?(): void
    close?(): void
}

type Request = { id: number; method: string; args: unknown[] }
type Cancel = { id: number; cancel: true }
type Reply =
    | { id: number; result: unknown }
    | { id: number; error: WireError }
    | { id: number; event: unknown }
    | { id: number; end: true }

interface WireError {
    message: string
    name?: string
    code?: string
}

/** The code on every error a closed connection causes: calls in flight
 *  reject with it and watches end with it. */
export const DISCONNECTED = 'ECONNRESET'

type Handler = (...args: any[]) => unknown

const STREAM = Symbol('stream')

/** A handler that answers with a stream. It is given the signal that aborts
 *  when the caller stops reading, and should end promptly when it does. */
export function streaming<A extends unknown[]>(
    fn: (signal: AbortSignal, ...args: A) => AsyncIterable<unknown>,
): Handler {
    return Object.assign((...args: any[]) => (fn as Handler)(...args), { [STREAM]: true })
}

/** Calls and streams to the other end of a port. */
export interface Peer {
    call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
    /** Results of a method that answers with a stream, until it ends or
     *  `signal` aborts. */
    stream<T = unknown>(method: string, args: unknown[], signal: AbortSignal): AsyncGenerator<T>
    /** Stop: calls in flight reject and streams end, both with a
     *  `DISCONNECTED` error; nothing more is served; the port closes. */
    close(reason?: string): void
    readonly closed: boolean
}

/**
 * Serve `handlers` on `port` and call the other end's. A handler's result is
 * sent back (any `MessagePort` in it transferred); a `streaming` one sends
 * each value until it ends or the caller cancels.
 */
export function peer(port: PortLike, handlers: Record<string, Handler> = {}): Peer {
    let nextId = 0
    let closed = false
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
    const streams = new Map<number, { event: (value: unknown) => void; end: (error?: Error) => void }>()
    const serving = new Map<number, AbortController>()

    const send = (message: Reply | Request | Cancel, transfer: Transferable[] = []) => {
        if (!closed) port.postMessage(message, transfer)
    }

    const serve = async ({ id, method, args }: Request) => {
        const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
        if (!handler) return send({ id, error: { message: `No method '${method}' here` } })
        if (!(STREAM in handler)) {
            try {
                const result = await handler(...args)
                send({ id, result: result ?? null }, transferablesOf(result))
            } catch (error) {
                send({ id, error: toWire(error) })
            }
            return
        }
        const controller = new AbortController()
        serving.set(id, controller)
        try {
            for await (const value of handler(controller.signal, ...args) as AsyncIterable<unknown>) {
                if (controller.signal.aborted) break
                send({ id, event: value }, transferablesOf(value))
            }
            send({ id, end: true })
        } catch (error) {
            send(controller.signal.aborted ? { id, end: true } : { id, error: toWire(error) })
        } finally {
            serving.delete(id)
        }
    }

    const onMessage = (event: MessageEvent) => {
        const data = event.data
        if (!data || typeof data.id !== 'number') return
        if ('method' in data) return void serve(data)
        if ('cancel' in data) return serving.get(data.id)?.abort()
        const stream = streams.get(data.id)
        if (stream) {
            if ('event' in data) stream.event(data.event)
            else if ('error' in data) stream.end(fromWire(data.error))
            else if ('end' in data) stream.end()
            return
        }
        const call = pending.get(data.id)
        if (!call) return
        pending.delete(data.id)
        if ('error' in data) call.reject(fromWire(data.error))
        else call.resolve(data.result)
    }

    const onClose = () => endpoint.close('the other end hung up')
    port.addEventListener('message', onMessage)
    port.addEventListener('close', onClose)
    port.start?.()

    const endpoint: Peer = {
        get closed() {
            return closed
        },
        call<T>(method: string, ...args: unknown[]): Promise<T> {
            if (closed) return Promise.reject(disconnected('the connection is closed'))
            return new Promise<T>((resolve, reject) => {
                const id = nextId++
                pending.set(id, { resolve, reject })
                send({ id, method, args }, transferablesOf(args))
            })
        },
        async *stream<T>(method: string, args: unknown[], signal: AbortSignal): AsyncGenerator<T> {
            if (signal.aborted) return
            if (closed) throw disconnected('the connection is closed')
            const id = nextId++
            const queue: T[] = []
            let ended = false
            let failure: Error | undefined
            let wake: (() => void) | null = null
            streams.set(id, {
                event: (value) => {
                    queue.push(value as T)
                    wake?.()
                },
                end: (error) => {
                    ended = true
                    failure = error
                    wake?.()
                },
            })
            const onAbort = () => wake?.()
            signal.addEventListener('abort', onAbort, { once: true })
            send({ id, method, args })
            try {
                while (!signal.aborted) {
                    if (queue.length) {
                        yield queue.shift()!
                        continue
                    }
                    if (ended) break
                    await new Promise<void>((resolve) => (wake = resolve))
                    wake = null
                }
                if (failure && !signal.aborted) throw failure
            } finally {
                streams.delete(id)
                signal.removeEventListener('abort', onAbort)
                if (!ended) send({ id, cancel: true })
            }
        },
        close(reason = 'the connection is closed') {
            if (closed) return
            closed = true
            port.removeEventListener('message', onMessage)
            port.removeEventListener('close', onClose)
            for (const controller of serving.values()) controller.abort()
            for (const call of pending.values()) call.reject(disconnected(reason))
            for (const stream of streams.values()) stream.end(disconnected(reason))
            pending.clear()
            port.close?.()
        },
    }
    return endpoint
}

// ── The filesystem over a port ───────────────────────────────────────────────

/** A filesystem served elsewhere. */
export interface RemoteVfs extends VfsInterface {
    connect(): Promise<MessagePort>
    /** Hang up: calls in flight fail and watches end. */
    close(reason?: string): void
}

/** The methods a filesystem answers on a port: every call of the contract. */
const CALLS = ['readFile', 'writeFile', 'readBytes', 'writeBytes', 'rename', 'mkdir', 'readDir', 'exists', 'stat', 'unlink'] as const

/** Answer for `fs` on `port` until the returned peer is closed. A `connect`
 *  from the other end opens another port to `fs` (reaching it directly when
 *  `fs` is itself remote). */
export function serveVfs(fs: VfsInterface, port: PortLike): Peer {
    const handlers: Record<string, Handler> = {}
    for (const method of CALLS) handlers[method] = (...args: any[]) => (fs[method] as Handler)(...args)
    handlers.watch = streaming((signal, path: string) => fs.watch(path, { signal }))
    handlers.connect = () => vfsPort(fs)
    return peer(port, handlers)
}

/** The filesystem served on the other end of `port`. */
export function remoteVfs(port: PortLike): RemoteVfs {
    const remote = peer(port)
    const call = <T>(method: string, ...args: unknown[]) => remote.call<T>(method, ...args)
    return {
        readFile: (path) => call<string>('readFile', path),
        writeFile: (path, data) => call<void>('writeFile', path, data),
        readBytes: (path) => call<Uint8Array>('readBytes', path),
        writeBytes: (path, data) => call<void>('writeBytes', path, data),
        rename: (oldPath, newPath) => call<void>('rename', oldPath, newPath),
        mkdir: (path, options) => call<void>('mkdir', path, options),
        readDir: (path) => call('readDir', path),
        exists: (path) => call<boolean>('exists', path),
        stat: (path) => call<FileStat | null>('stat', path),
        unlink: (path) => call<void>('unlink', path),
        watch: (path, { signal }) => remote.stream<WatchEvent>('watch', [path], signal),
        connect: () => call<MessagePort>('connect'),
        close: (reason) => remote.close(reason),
    }
}

/**
 * A port reaching `fs`, to hand to a worker: a filesystem served from
 * another thread opens a direct one (`connect`), any other is served from
 * this thread.
 */
export async function vfsPort(fs: VfsInterface): Promise<MessagePort> {
    if (fs.connect) return fs.connect()
    const { port1, port2 } = new MessageChannel()
    serveVfs(fs, port1)
    return port2
}

// ── Wire helpers ─────────────────────────────────────────────────────────────

function toWire(error: unknown): WireError {
    if (error instanceof Error || (error && typeof error === 'object' && 'message' in error)) {
        const e = error as Error & { code?: unknown }
        return { message: String(e.message), name: e.name, ...(typeof e.code === 'string' ? { code: e.code } : {}) }
    }
    return { message: String(error) }
}

function fromWire(wire: WireError): Error {
    const error = new Error(wire.message)
    if (wire.name && wire.name !== 'Error') error.name = wire.name
    if (wire.code) Object.assign(error, { code: wire.code })
    return error
}

function disconnected(reason: string): Error {
    return Object.assign(new Error(reason), { code: DISCONNECTED })
}

/** Ports in `value` (it, or its own members), which must move rather than copy. */
function transferablesOf(value: unknown): Transferable[] {
    if (typeof MessagePort === 'undefined' || !value || typeof value !== 'object') return []
    if (value instanceof MessagePort) return [value]
    return Object.values(value).filter((member): member is MessagePort => member instanceof MessagePort)
}
