import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getRequiredLibs, getLibFieldForTarget, prefillTypescriptDefaults, resetPrefillState } from './typescript-defaults';
import { VfsInterface } from '../types';

function createMockFs(): VfsInterface {
    const files = new Map<string, string>();
    return {
        readFile: vi.fn(async (path: string) => {
            if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
            return files.get(path)!;
        }),
        writeFile: vi.fn(async (path: string, data: string) => {
            files.set(path, data);
        }),
        exists: vi.fn(async (path: string) => files.has(path)),
        mkdir: vi.fn(async () => { }),
        readDir: vi.fn(async () => []),
        stat: vi.fn(async () => null),
        watch: vi.fn(),
    } as unknown as VfsInterface;
}

describe('getRequiredLibs', () => {
    it('returns ES5 libs for es5 target', () => {
        const libs = getRequiredLibs('es5');
        expect(libs).toContain('es5');
        expect(libs).toContain('decorators');
        expect(libs).toContain('decorators.legacy');
        expect(libs).not.toContain('es2015');
    });

    it('returns ES2015 libs including ES5 for es2015 target', () => {
        const libs = getRequiredLibs('es2015');
        expect(libs).toContain('es5');
        expect(libs).toContain('es2015');
        expect(libs).toContain('es2015.promise');
        expect(libs).toContain('es2015.collection');
        expect(libs).not.toContain('es2016');
    });

    it('returns ES2020 libs for es2020 target', () => {
        const libs = getRequiredLibs('es2020');
        expect(libs).toContain('es5');
        expect(libs).toContain('es2015');
        expect(libs).toContain('es2020');
        expect(libs).toContain('es2020.bigint');
        expect(libs).toContain('es2020.promise');
    });

    it('is case-insensitive', () => {
        expect(getRequiredLibs('ES2020')).toEqual(getRequiredLibs('es2020'));
    });

    it('defaults to ES2020 for unknown targets', () => {
        expect(getRequiredLibs('unknown')).toEqual(getRequiredLibs('es2020'));
    });

    it('defaults to ES2020 when no target is provided', () => {
        expect(getRequiredLibs()).toEqual(getRequiredLibs('es2020'));
    });
});

describe('getLibFieldForTarget', () => {
    it('returns all individual lib names for a target', () => {
        const libs = getLibFieldForTarget('es2020');
        expect(libs).toContain('es5');
        expect(libs).toContain('es2015');
        expect(libs).toContain('es2015.promise');
        expect(libs).toContain('es2020');
        expect(libs).toContain('es2020.bigint');
        expect(libs).toEqual(getRequiredLibs('es2020'));
    });

    it('returns es2015 libs for es2015 target', () => {
        const libs = getLibFieldForTarget('ES2015');
        expect(libs).toContain('es5');
        expect(libs).toContain('es2015');
        expect(libs).not.toContain('es2016');
    });

    it('defaults to es2020 libs for unknown targets', () => {
        expect(getLibFieldForTarget('unknown')).toEqual(getRequiredLibs('es2020'));
    });

    it('defaults to es2020 libs when no target is provided', () => {
        expect(getLibFieldForTarget()).toEqual(getRequiredLibs('es2020'));
    });
});

describe('prefillTypescriptDefaults', () => {
    let mockFs: VfsInterface;
    const mockResolveLib = vi.fn(async (name: string) => `// lib.${name}.d.ts content`);

    beforeEach(() => {
        mockFs = createMockFs();
        mockResolveLib.mockClear();
        resetPrefillState();
    });

    it('writes tsconfig.json with default settings', async () => {
        await prefillTypescriptDefaults(mockFs, mockResolveLib);

        expect(mockFs.writeFile).toHaveBeenCalledWith(
            '/tsconfig.json',
            expect.stringContaining('"target"')
        );

        const tsconfigCall = vi.mocked(mockFs.writeFile).mock.calls.find(
            ([path]) => path === '/tsconfig.json'
        );
        const tsconfig = JSON.parse(tsconfigCall![1]);
        expect(tsconfig.compilerOptions.target).toBe('ES2020');
        expect(tsconfig.compilerOptions.lib).toEqual(getRequiredLibs('es2020'));
        expect(tsconfig.compilerOptions.module).toBe('ESNext');
        expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    it('does not overwrite existing tsconfig.json', async () => {
        // Pre-create tsconfig.json
        await mockFs.writeFile('/tsconfig.json', '{"existing": true}');
        vi.mocked(mockFs.writeFile).mockClear();

        await prefillTypescriptDefaults(mockFs, mockResolveLib);

        const tsconfigWrites = vi.mocked(mockFs.writeFile).mock.calls.filter(
            ([path]) => path === '/tsconfig.json'
        );
        expect(tsconfigWrites).toHaveLength(0);
    });

    it('merges custom compilerOptions into tsconfig', async () => {
        await prefillTypescriptDefaults(mockFs, mockResolveLib, {
            compilerOptions: { jsx: 'react-jsx', strict: false },
        });

        const tsconfigCall = vi.mocked(mockFs.writeFile).mock.calls.find(
            ([path]) => path === '/tsconfig.json'
        );
        const tsconfig = JSON.parse(tsconfigCall![1]);
        expect(tsconfig.compilerOptions.jsx).toBe('react-jsx');
        expect(tsconfig.compilerOptions.strict).toBe(false);
    });

    it('writes TypeScript lib files to /node_modules/typescript/lib/', async () => {
        await prefillTypescriptDefaults(mockFs, mockResolveLib, { target: 'es5' });

        expect(mockFs.mkdir).toHaveBeenCalledWith(
            '/node_modules/typescript/lib',
            { recursive: true }
        );

        // ES5 needs 3 target libs + 5 default env libs (dom, dom.iterable, etc.)
        const libWrites = vi.mocked(mockFs.writeFile).mock.calls.filter(
            ([path]) => path.startsWith('/node_modules/typescript/lib/')
        );
        expect(libWrites).toHaveLength(8);
        expect(libWrites.map(([path]) => path)).toEqual(expect.arrayContaining([
            '/node_modules/typescript/lib/lib.es5.d.ts',
            '/node_modules/typescript/lib/lib.decorators.d.ts',
            '/node_modules/typescript/lib/lib.decorators.legacy.d.ts',
            '/node_modules/typescript/lib/lib.dom.d.ts',
            '/node_modules/typescript/lib/lib.dom.iterable.d.ts',
            '/node_modules/typescript/lib/lib.dom.asynciterable.d.ts',
            '/node_modules/typescript/lib/lib.webworker.importscripts.d.ts',
            '/node_modules/typescript/lib/lib.scripthost.d.ts',
        ]));
    });

    it('calls resolveLib for each lib file', async () => {
        await prefillTypescriptDefaults(mockFs, mockResolveLib, { target: 'es5' });

        expect(mockResolveLib).toHaveBeenCalledWith('es5');
        expect(mockResolveLib).toHaveBeenCalledWith('decorators');
        expect(mockResolveLib).toHaveBeenCalledWith('decorators.legacy');
        expect(mockResolveLib).toHaveBeenCalledWith('dom');
        expect(mockResolveLib).toHaveBeenCalledWith('dom.iterable');
        expect(mockResolveLib).toHaveBeenCalledWith('dom.asynciterable');
        expect(mockResolveLib).toHaveBeenCalledWith('webworker.importscripts');
        expect(mockResolveLib).toHaveBeenCalledWith('scripthost');
    });

    it('does not overwrite existing lib files', async () => {
        // Pre-create one lib file
        await mockFs.writeFile('/node_modules/typescript/lib/lib.es5.d.ts', '// existing');
        vi.mocked(mockFs.writeFile).mockClear();
        mockResolveLib.mockClear();

        await prefillTypescriptDefaults(mockFs, mockResolveLib, { target: 'es5' });

        // resolveLib is called for all libs (to populate the return cache)
        expect(mockResolveLib).toHaveBeenCalledWith('es5');
        // But the existing file should NOT be overwritten in the VFS
        const es5Writes = vi.mocked(mockFs.writeFile).mock.calls.filter(
            ([path]) => path === '/node_modules/typescript/lib/lib.es5.d.ts'
        );
        expect(es5Writes).toHaveLength(0);
        // Other libs should still be written
        expect(mockResolveLib).toHaveBeenCalledWith('decorators');
        expect(mockResolveLib).toHaveBeenCalledWith('decorators.legacy');
    });

    it('only runs once per session', async () => {
        const result1 = await prefillTypescriptDefaults(mockFs, mockResolveLib, { target: 'es5' });
        const firstCallCount = mockResolveLib.mock.calls.length;

        const result2 = await prefillTypescriptDefaults(mockFs, mockResolveLib, { target: 'es5' });

        // Should not have been called again
        expect(mockResolveLib).toHaveBeenCalledTimes(firstCallCount);
        // Second call returns cached result
        expect(result2).toEqual(result1);
    });

    it('returns lib file contents keyed by path', async () => {
        const result = await prefillTypescriptDefaults(mockFs, mockResolveLib, { target: 'es5' });

        expect(result['/tsconfig.json']).toBeDefined();
        expect(result['/node_modules/typescript/lib/lib.es5.d.ts']).toBe('// lib.es5.d.ts content');
        expect(result['/node_modules/typescript/lib/lib.decorators.d.ts']).toBe('// lib.decorators.d.ts content');
        expect(result['/node_modules/typescript/lib/lib.decorators.legacy.d.ts']).toBe('// lib.decorators.legacy.d.ts content');
        expect(result['/node_modules/typescript/lib/lib.dom.d.ts']).toBe('// lib.dom.d.ts content');
        expect(result['/node_modules/typescript/lib/lib.dom.iterable.d.ts']).toBe('// lib.dom.iterable.d.ts content');
    });

    it('handles resolveLib errors gracefully', async () => {
        const errorResolve = vi.fn(async (name: string) => {
            if (name === 'decorators') throw new Error('Network error');
            return `// lib.${name}.d.ts`;
        });
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

        await prefillTypescriptDefaults(mockFs, errorResolve, { target: 'es5' });

        // Should have logged the error
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('decorators'),
            expect.any(Error)
        );

        // Other libs should still have been written
        const es5Write = vi.mocked(mockFs.writeFile).mock.calls.find(
            ([path]) => path === '/node_modules/typescript/lib/lib.es5.d.ts'
        );
        expect(es5Write).toBeTruthy();

        consoleSpy.mockRestore();
    });

    it('uses custom target when specified', async () => {
        await prefillTypescriptDefaults(mockFs, mockResolveLib, { target: 'ES2015' });

        // Should include ES2015-specific libs
        expect(mockResolveLib).toHaveBeenCalledWith('es2015.promise');
        expect(mockResolveLib).toHaveBeenCalledWith('es2015.collection');
        // Should not include ES2016+ libs
        expect(mockResolveLib).not.toHaveBeenCalledWith('es2016');
    });
});
