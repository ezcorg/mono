import { describe, it, expect } from 'vitest'
import { CodeblockFS } from '@joinezco/codeblock'
import { FileType } from '@joinezco/storage'

// The browser's own VFS (the fs SharedWorker over the dedicated OPFS worker)
// held to the parts of the contract a text-only store could fake: bytes,
// renames of files and directories, and modification times.

describe('worker VFS (OPFS)', () => {
    it('round-trips bytes, renames files and directories, and reports mtimes', async () => {
        const fs = await CodeblockFS.worker()
        const dir = `vfs-worker-${Date.now()}`
        await fs.mkdir(`${dir}/sub`, { recursive: true })

        const bytes = new Uint8Array(300).map((_, i) => i % 256)
        await fs.writeBytes(`${dir}/img.bin`, bytes)
        expect([...(await fs.readBytes(`${dir}/img.bin`))]).toEqual([...bytes])
        const stat = await fs.stat(`${dir}/img.bin`)
        expect(stat?.type).toBe(FileType.File)
        expect(stat?.size).toBe(300)
        expect(Number(stat?.mtime ?? 0)).toBeGreaterThan(0)

        // A file onto an existing one replaces it.
        await fs.writeFile(`${dir}/sub/old.md`, 'old')
        await fs.rename(`${dir}/img.bin`, `${dir}/sub/old.md`)
        expect(await fs.exists(`${dir}/img.bin`)).toBe(false)
        expect([...(await fs.readBytes(`${dir}/sub/old.md`))]).toEqual([...bytes])

        // A directory moves with its contents.
        await fs.rename(`${dir}/sub`, `${dir}/moved`)
        expect(await fs.exists(`${dir}/sub/old.md`)).toBe(false)
        expect((await fs.readBytes(`${dir}/moved/old.md`)).length).toBe(300)
    })
})
