/** A snapshot as the workers are given one: its bytes, or a URL to fetch. */
export type SnapshotSource = Uint8Array | string

export async function snapshotBytes(source: SnapshotSource): Promise<Uint8Array> {
    if (typeof source !== 'string') return source
    const response = await fetch(source)
    if (!response.ok) throw new Error(`Could not fetch the snapshot ${source}: ${response.status} ${response.statusText}`)
    return new Uint8Array(await response.arrayBuffer())
}
