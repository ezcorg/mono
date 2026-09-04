/* The radio on the shelf: a YouTube player kept out of sight (audio only), created the first time it's switched on —
   which is a click, so the browser lets it play. Nothing from YouTube loads until then. */
const PLAYLIST = 'PLX0T2DHBqfElagdQglRLZTW_AodBl8Qwa';   // "Nujabes all albums", 74 tracks

let player = null, state = 'off', onChange = () => {};

export const radio = {
	on(fn) { onChange = fn; },
	get playing() { return state === 'playing'; },
	get state() { return state; },
	next() { try { player?.nextVideo(); } catch {} },
	prev() { try { player?.previousVideo(); } catch {} },
	async toggle() {
		if (state === 'loading') return;
		if (!player) {
			state = 'loading'; onChange(state);
			try { await load(); } catch (e) { console.warn('[radio]', e); state = 'off'; onChange(state); }
			return;
		}
		if (state === 'playing') player.pauseVideo(); else player.playVideo();
	},
	title() { try { return player?.getVideoData?.().title || ''; } catch { return ''; } },
	dispose() { try { player?.destroy(); } catch {} player = null; state = 'off'; },
};

function load() {
	return new Promise((res, rej) => {
		const el = document.createElement('div'); el.className = 'radio-player'; document.body.appendChild(el);
		const start = () => {
			player = new window.YT.Player(el, {
				host: 'https://www.youtube-nocookie.com', width: 200, height: 200,
				playerVars: { listType: 'playlist', list: PLAYLIST, autoplay: 1, controls: 0, playsinline: 1 },
				events: {
					onReady: e => { try { e.target.setShuffle(true); } catch {} e.target.playVideo(); res(); },
					onStateChange: e => { const s = e.data; state = s === 1 ? 'playing' : s === 3 || s === -1 || s === 5 ? 'loading' : 'paused'; onChange(state); },
					onError: e => { rej(new Error('player error ' + e.data)); },
				},
			});
		};
		if (window.YT?.Player) return start();
		const prev = window.onYouTubeIframeAPIReady; window.onYouTubeIframeAPIReady = () => { prev?.(); start(); };
		const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.async = true; s.onerror = () => rej(new Error('iframe_api failed to load')); document.head.appendChild(s);
	});
}
