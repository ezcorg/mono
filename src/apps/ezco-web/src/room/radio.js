/* The radio on the shelf: a YouTube player kept out of sight (audio only). Hovering the radio warms the player up so the
   click that switches it on can call play synchronously, which Safari's autoplay rules require. Nothing from YouTube loads
   before you hover or touch the radio. */
const PLAYLIST = 'PLX0T2DHBqfElagdQglRLZTW_AodBl8Qwa';   // "Nujabes all albums", 74 tracks

let player = null, ready = false, st = 'off', touched = false, loading = null, onChange = () => {};
const tell = () => onChange(radio.state);

export const radio = {
	on(fn) { onChange = fn; },
	get playing() { return touched && st === 'playing'; },
	/** what the room sees: 'off' until the radio has been switched on, then playing / paused / loading */
	get state() { return touched ? st : 'off'; },
	warm() { ensure().catch(() => {}); },
	toggle() {
		if (touched && st === 'loading') return;
		touched = true;
		if (ready) { if (st === 'playing') player.pauseVideo(); else player.playVideo(); return; }
		st = 'loading'; tell();
		ensure().then(() => player.playVideo(), e => { console.warn('[radio]', e); touched = false; st = 'off'; tell(); });
	},
	next() { try { player?.nextVideo(); } catch {} },
	prev() { try { player?.previousVideo(); } catch {} },
	title() { try { return player?.getVideoData?.().title || ''; } catch { return ''; } },
	dispose() { try { player?.destroy(); } catch {} player = null; ready = false; loading = null; touched = false; st = 'off'; },
};

function ensure() { if (!loading) loading = load().catch(e => { loading = null; throw e; }); return loading; }

function load() {
	return new Promise((res, rej) => {
		const box = document.createElement('div'); box.className = 'radio-player'; document.body.appendChild(box);   // the API swaps its host for an iframe, so it gets a child to swap
		const el = box.appendChild(document.createElement('div'));
		const start = () => {
			player = new window.YT.Player(el, {
				host: 'https://www.youtube-nocookie.com', width: 200, height: 200,
				playerVars: { listType: 'playlist', list: PLAYLIST, autoplay: 0, controls: 0, playsinline: 1 },
				events: {
					onReady: e => { try { e.target.setShuffle(true); } catch {} ready = true; res(); },
					onStateChange: e => { const s = e.data; st = s === 1 ? 'playing' : s === 3 ? 'loading' : 'paused'; tell(); },
					onError: e => { rej(new Error('player error ' + e.data)); },
				},
			});
		};
		if (window.YT?.Player) return start();
		const prev = window.onYouTubeIframeAPIReady; window.onYouTubeIframeAPIReady = () => { prev?.(); start(); };
		const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.async = true; s.onerror = () => rej(new Error('iframe_api failed to load')); document.head.appendChild(s);
	});
}
