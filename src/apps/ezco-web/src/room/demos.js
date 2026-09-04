/* The demo programs run in their own documents (src/pages/apps/*), framed inside the OS window, so their tooltips,
   popovers and layout can't spill past the window and the room's CSS can't leak in. */
const live = new Map();

export function mountDemo(name, el) {
	if (!el || live.has(name)) return;
	const f = document.createElement('iframe');
	f.src = `/apps/${name}/`; f.title = name; f.setAttribute('allow', 'clipboard-read; clipboard-write');
	el.replaceChildren(f); live.set(name, f);
}

export function destroyDemos() {
	for (const [name, f] of live) { f.remove(); live.delete(name); }
}
