/**
 * Operations on a key, run one after another: each waits for every earlier
 * one on the same key to settle, whether it succeeded or failed. The version
 * log, the OPFS store and the comment index keep one per path, so a read
 * that decides a write is never interleaved with another's.
 */
export class Locks {
    private readonly tails = new Map<string, Promise<unknown>>()

    /** Run `fn` after every earlier operation on `key` has settled. */
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(key) ?? Promise.resolve()
        const result = previous.then(fn, fn)
        const tail = result.then(
            () => {},
            () => {},
        )
        this.tails.set(key, tail)
        void tail.then(() => {
            if (this.tails.get(key) === tail) this.tails.delete(key)
        })
        return result
    }
}
