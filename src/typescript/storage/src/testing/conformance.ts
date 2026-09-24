/**
 * The filesystem contract, as tests: every implementation is held to it
 * (memory and Node in `vfs.test.ts`, a remote one in `remote.test.ts`,
 * the OPFS and the browser's workers in `browser/*.browser.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import { FileType, statTime, walk, type VfsInterface } from '../vfs.js'

export function describeVfs(name: string, make: () => Promise<VfsInterface>): void {
    describe(`VfsInterface: ${name}`, () => {
        it('round-trips text, including characters outside ASCII', async () => {
            const fs = await make()
            await fs.writeFile('note.md', '# Café ✓\n\nline two\n')
            expect(await fs.readFile('note.md')).toBe('# Café ✓\n\nline two\n')
            await fs.writeFile('note.md', 'shorter')
            expect(await fs.readFile('/note.md')).toBe('shorter')
        })

        it('round-trips every byte value', async () => {
            const fs = await make()
            const bytes = new Uint8Array(512).map((_, i) => i % 256)
            await fs.writeBytes('img.bin', bytes)
            const back = await fs.readBytes('img.bin')
            expect(back).toBeInstanceOf(Uint8Array)
            expect([...back]).toEqual([...bytes])
            expect((await fs.stat('img.bin'))?.size).toBe(512)
        })

        it('creates directories, recursively or one level at a time', async () => {
            const fs = await make()
            await fs.mkdir('a/b/c', { recursive: true })
            expect(await fs.exists('a/b/c')).toBe(true)
            await fs.mkdir('a/b/d', { recursive: false })
            await expect(fs.mkdir('x/y', { recursive: false })).rejects.toThrow()
            const listing = await fs.readDir('a/b')
            expect(listing.sort()).toEqual([
                ['c', FileType.Directory],
                ['d', FileType.Directory],
            ])
        })

        it('lists, stats and removes', async () => {
            const fs = await make()
            await fs.mkdir('dir', { recursive: true })
            await fs.writeFile('dir/a.md', 'a')
            expect(await fs.readDir('dir')).toEqual([['a.md', FileType.File]])
            const stat = await fs.stat('dir/a.md')
            expect(stat?.type).toBe(FileType.File)
            expect(stat?.size).toBe(1)
            expect((await fs.stat('dir'))?.type).toBe(FileType.Directory)
            expect(await fs.stat('missing.md')).toBeFalsy()
            await fs.unlink('dir/a.md')
            expect(await fs.exists('dir/a.md')).toBe(false)
            await expect(fs.readFile('dir/a.md')).rejects.toThrow()
        })

        it('reports a later modification time after a write', async () => {
            const fs = await make()
            await fs.writeFile('t.md', 'one')
            const first = statTime((await fs.stat('t.md'))?.mtime)
            expect(first).toBeGreaterThan(0)
            await new Promise((r) => setTimeout(r, 20))
            await fs.writeFile('t.md', 'two')
            expect(statTime((await fs.stat('t.md'))?.mtime)).toBeGreaterThan(first)
        })

        it('renames a file, replacing what is at the destination', async () => {
            const fs = await make()
            await fs.mkdir('notes', { recursive: true })
            await fs.writeFile('plan.md', 'plan')
            await fs.writeFile('notes/old.md', 'old')
            await fs.rename('plan.md', 'notes/old.md')
            expect(await fs.exists('plan.md')).toBe(false)
            expect(await fs.readFile('notes/old.md')).toBe('plan')
        })

        it('renames a directory with its contents', async () => {
            const fs = await make()
            await fs.mkdir('src/deep', { recursive: true })
            await fs.writeFile('src/deep/a.md', 'a')
            await fs.writeBytes('src/b.bin', new Uint8Array([1, 2, 3]))
            await fs.rename('src', 'dst')
            expect(await fs.exists('src')).toBe(false)
            expect(await fs.readFile('dst/deep/a.md')).toBe('a')
            expect([...(await fs.readBytes('dst/b.bin'))]).toEqual([1, 2, 3])
        })

        it('walks every file under a directory', async () => {
            const fs = await make()
            await fs.mkdir('x/y', { recursive: true })
            await fs.writeFile('x/1.md', '')
            await fs.writeFile('x/y/2.md', '')
            await fs.writeFile('3.md', '')
            const all: string[] = []
            for await (const p of walk(fs, '/')) all.push(p)
            expect(all.sort()).toEqual(['/3.md', '/x/1.md', '/x/y/2.md'])
        })

        it('watches a directory, naming changes relative to it', async () => {
            const fs = await make()
            await fs.mkdir('w/sub', { recursive: true })
            const controller = new AbortController()
            const seen: string[] = []
            const done = (async () => {
                for await (const event of fs.watch('w', { signal: controller.signal })) {
                    seen.push(event.filename)
                    if (event.filename === 'sub/n.md') break
                }
            })()
            // Give a native watcher a moment to arm before the write it must see.
            await new Promise((r) => setTimeout(r, 50))
            await fs.writeFile('w/sub/n.md', 'hello')
            await Promise.race([done, new Promise((r) => setTimeout(r, 2000))])
            controller.abort()
            expect(seen).toContain('sub/n.md')
        })

        it('brings nothing into being by looking', async () => {
            const fs = await make()
            expect(await fs.exists('ghost/deep/x.md')).toBe(false)
            expect(await fs.stat('ghost/deep/x.md')).toBeFalsy()
            await expect(fs.readDir('ghost')).rejects.toThrow()
            await expect(fs.readFile('ghost/x.md')).rejects.toThrow()
            expect(await fs.exists('ghost')).toBe(false)
        })

        it('writes into folders that exist, and deletes files only', async () => {
            const fs = await make()
            await expect(fs.writeFile('nowhere/x.md', 'x')).rejects.toThrow()
            await fs.mkdir('d', { recursive: true })
            await fs.writeFile('d/x.md', 'x')
            await expect(fs.unlink('d')).rejects.toThrow()
            await expect(fs.unlink('d/missing.md')).rejects.toThrow()
            expect(await fs.readFile('d/x.md')).toBe('x')
        })
    })
}
