/* The chrome of a demo document framed by the laptop's OS window (src/room/demos.js): a title bar carrying the program's
   icon, its file-search toolbar (centred, like a window's search field), a link to its source and the window buttons,
   which ask the room (postMessage) to minimise or close. The room passes its theme as ?lit at first, then by message;
   the bar mirrors it on the root as `.lit` + `data-theme`, and tells the program through an `ezos-theme` event. */
const GH = 'M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z';

/** Builds the bar; returns the slot the program mounts its search toolbar into and a getter for the current theme.
 *  (Explicit tabindexes: Safari's plain Tab skips links and buttons without one.) */
export function frame({ github, icon = '' }: { github: string; icon?: string }): { tool: HTMLElement; dark: () => boolean } {
	const root = document.documentElement;
	const set = (lit: boolean) => { root.classList.toggle('lit', lit); root.setAttribute('data-theme', lit ? 'light' : 'dark'); dispatchEvent(new CustomEvent('ezos-theme', { detail: { dark: !lit } })); };
	set(new URLSearchParams(location.search).has('lit'));
	addEventListener('message', (e) => { if (e.origin === location.origin && e.data?.ezos === 'theme') set(!!e.data.lit); });
	const tb = document.createElement('div'); tb.className = 'tb';
	tb.innerHTML = `<span class="ai" aria-hidden="true">${icon}</span><div class="tool"></div><span class="wc"><a tabindex="0" href="${github}" target="_blank" rel="noopener" title="source on GitHub" aria-label="source on GitHub"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${GH}"/></svg></a><button type="button" tabindex="0" data-act="minimize" title="minimise" aria-label="minimise">–</button><button type="button" tabindex="0" data-act="close" title="close" aria-label="close">×</button></span>`;
	tb.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button, a'); if (!b) return; parent.postMessage({ ezos: 'click' }, location.origin); if (b instanceof HTMLButtonElement) parent.postMessage({ ezos: b.dataset.act }, location.origin); });   // the room hears the click at the desk, then acts
	document.body.prepend(tb);
	return { tool: tb.querySelector('.tool') as HTMLElement, dark: () => !root.classList.contains('lit') };
}
