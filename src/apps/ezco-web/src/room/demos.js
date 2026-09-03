/* The real demo programs, mounted inside the laptop's OS windows (same components and demo filesystem as /work/*). */
import { getDemoFs } from '../scripts/demo-fs';

const live = new Map();

export async function mountDemo(name, el) {
	if (!el || live.has(name)) return;
	const entry = { destroy: () => {} }; live.set(name, entry);
	el.innerHTML = '<div class="loading-indicator">loading…</div>';
	try {
		const fs = await getDemoFs();
		if (!live.has(name) || !el.isConnected) return;
		if (name === 'codeblock') {
			const { createCodeblock, SearchIndex } = await import('@joinezco/codeblock');
			const index = await SearchIndex.get(fs, '.codeblock/index.json');
			el.innerHTML = '';
			const view = createCodeblock({ parent: el, fs, filepath: 'example.ts', index, cwd: '/', dark: true });
			entry.destroy = () => { try { view.destroy(); } catch {} };
		} else if (name === 'markdown-editor') {
			const { createEditor } = await import('@joinezco/markdown-editor');
			el.innerHTML = '';
			const editor = createEditor({ element: el, autofocus: false, fs: { fs, filepath: 'hello.md', autoSave: true } });
			(editor.view.dom.closest('.ezco-mde') ?? editor.view.dom).setAttribute('data-theme', 'dark');
			entry.destroy = () => { try { editor.destroy(); } catch {} };
		} else {
			el.innerHTML = `<div class="loading-indicator">no such program: ${name}</div>`;
		}
	} catch (e) {
		console.error('[room] demo failed', name, e);
		el.innerHTML = `<div class="loading-indicator">couldn't start ${name}</div>`;
	}
}

export function destroyDemos() {
	for (const [name, e] of live) { e.destroy(); live.delete(name); }
}
