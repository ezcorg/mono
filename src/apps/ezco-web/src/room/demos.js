/* The demo programs run in their own documents (src/pages/apps/*), framed inside the OS window, so their tooltips,
   popovers and layout can't spill past the window and the room's CSS can't leak in. Each document draws its own title bar
   (src/scripts/ezos-frame.ts) and follows the room's theme: passed as ?lit at first, then by message. */
const live = new Map();

export function mountDemo(name, el, { lit = false } = {}) {
	if (!el || live.has(name)) return;
	const f = document.createElement('iframe');
	f.src = `/apps/${name}/${lit ? '?lit' : ''}`; f.title = name; f.setAttribute('allow', 'clipboard-read; clipboard-write');
	el.replaceChildren(f); live.set(name, f);
}

export function destroyDemo(name) { const f = live.get(name); if (f) { f.remove(); live.delete(name); } }

export function destroyDemos() { for (const name of [...live.keys()]) destroyDemo(name); }

export function themeDemos(lit) { for (const f of live.values()) f.contentWindow?.postMessage({ ezos: 'theme', lit }, location.origin); }
