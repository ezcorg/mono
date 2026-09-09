/* The room's sounds: small mechanical noises for the things you touch, synthesised (no files, nothing to load) and
   placed where they happen — each one plays through a PannerNode at the thing's position while the listener rides the
   camera, so a lamp on your left clicks on your left and the radio hisses from the shelf across the room.
   The context is created on the first pointer or key gesture (browsers keep audio silent until one), so a hover
   before any click is mute. `ezco-sound` in localStorage remembers "off". */
const M = 3;   // metres per cube unit: the room is a 3 m box, for the panner's distance falloff

export function createSfx({ context = null } = {}) {
	let ctx = context, master = null, noise = null, on = true;
	try { on = localStorage.getItem('ezco-sound') !== 'off'; } catch {}
	const ready = () => !!ctx && on;
	function ensure() {
		if (ctx) return ctx;
		const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
		ctx = new AC({ latencyHint: 'interactive' }); setup(); return ctx;
	}
	function setup() {
		master = ctx.createGain(); master.gain.value = on ? .7 : 0; master.connect(ctx.destination);
		const n = ctx.sampleRate * 2, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
		for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
		noise = b;
		const l = ctx.listener; if (l.forwardX) { l.forwardZ.value = -1; l.upY.value = 1; }
	}
	if (ctx) setup();

	/* a sound source at a point in the room */
	function at(pos, o = {}) {
		const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 1; p.rolloffFactor = o.rolloff ?? .6; p.maxDistance = 30;
		if (p.positionX) { p.positionX.value = pos.x * M; p.positionY.value = pos.y * M; p.positionZ.value = pos.z * M; } else p.setPosition(pos.x * M, pos.y * M, pos.z * M);
		p.connect(master); return p;
	}
	const env = (g, t, dur, peak) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + .0015); g.gain.exponentialRampToValueAtTime(.0005, t + dur); };
	/* a burst of filtered noise: the body of any click */
	function tick(dest, t, { f = 3000, q = 1, dur = .01, g = .2, type = 'bandpass' }) {
		const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const ga = ctx.createGain();
		env(ga, t, dur, g); s.connect(fl).connect(ga).connect(dest); s.start(t); s.stop(t + dur + .03);
	}
	/* a pitch-dropping sine: the knock underneath a click */
	function thump(dest, t, { f0 = 200, f1 = 90, dur = .05, g = .2 }) {
		const o = ctx.createOscillator(); o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur); const ga = ctx.createGain();
		env(ga, t, dur, g); o.connect(ga).connect(dest); o.start(t); o.stop(t + dur + .03);
	}
	/* a few decaying partials: metal */
	function ring(dest, t, { freqs = [2600], durs = [.08], g = .1 }) {
		freqs.forEach((f, i) => { const o = ctx.createOscillator(); o.frequency.value = f; o.detune.value = (i % 2 ? -1 : 1) * 6; const ga = ctx.createGain(); env(ga, t, durs[i] ?? durs[0], g / (1 + i * .6)); o.connect(ga).connect(dest); o.start(t); o.stop(t + (durs[i] ?? durs[0]) + .03); });
	}

	const SOUNDS = {
		/* a mouse click: press, then release a moment later */
		mouse(d, t, v) { tick(d, t, { f: 3800, q: .9, dur: .011, g: .32 * v }); thump(d, t, { f0: 600, f1: 350, dur: .022, g: .1 * v }); tick(d, t + .07, { f: 3000, q: .9, dur: .009, g: .22 * v }); thump(d, t + .07, { f0: 500, f1: 300, dur: .02, g: .07 * v }); },
		/* the tablet's power button: a small plastic click, a touch softer when it goes off */
		tablet(d, t, v, o) { const on = o.on !== false; tick(d, t, { f: 2600, q: 1.4, dur: .012, g: (on ? .2 : .14) * v }); thump(d, t, { f0: on ? 340 : 260, f1: on ? 210 : 170, dur: .03, g: .1 * v }); },
		/* the paper lantern's switch: muffled, a soft knock through paper */
		lantern(d, t, v, o) { thump(d, t, { f0: o.on ? 160 : 140, f1: 70, dur: .1, g: .35 * v }); tick(d, t, { f: 500, q: .6, dur: .035, g: .1 * v }); },
		/* the pendant's switch: a bright tick that rings in the metal cone */
		pendant(d, t, v, o) { tick(d, t, { f: 5200, q: 2, dur: .008, g: .25 * v }); ring(d, t, { freqs: o.on ? [2650, 4150, 6300] : [2450, 3900, 5900], durs: [.09, .06, .045], g: .1 * v }); thump(d, t, { f0: 230, f1: 120, dur: .03, g: .08 * v }); },
		/* the table lamp's rotary switch: two woody clicks */
		tripod(d, t, v, o) { const f = o.on ? 1500 : 1300; tick(d, t, { f, q: 1.2, dur: .018, g: .3 * v }); thump(d, t, { f0: 400, f1: 170, dur: .045, g: .18 * v }); tick(d, t + .055, { f: f * .9, q: 1.2, dur: .014, g: .18 * v }); thump(d, t + .055, { f0: 360, f1: 160, dur: .04, g: .1 * v }); },
		/* the wall dial: a soft detent per position it passes */
		dial(d, t, v, o) { for (let i = 0; i < (o.steps || 1); i++) { const ti = t + i * .09; tick(d, ti, { f: 2300, q: 1.5, dur: .007, g: .2 * v }); thump(d, ti, { f0: 280, f1: 150, dur: .022, g: .1 * v }); } },
		/* the radio's switch */
		radio(d, t, v) { tick(d, t, { f: 1300, q: 1, dur: .014, g: .3 * v }); thump(d, t, { f0: 320, f1: 160, dur: .04, g: .18 * v }); },
		/* one rolodex card flicking past */
		card(d, t, v) { tick(d, t, { f: 1900, q: .6, dur: .005, g: .05 * v }); },
	};

	return {
		get enabled() { return on; },
		set enabled(v) { on = v; try { localStorage.setItem('ezco-sound', v ? 'on' : 'off'); } catch {} if (master) master.gain.setTargetAtTime(v ? .7 : 0, ctx.currentTime, .02); },
		get ctx() { return ctx; },
		/** call from a user gesture: creates the context (browsers allow audio only after one) */
		unlock() { if (!on && !ctx) return; ensure(); if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); },
		/** the listener follows the camera (position in cube units, orientation as a quaternion) */
		update(pos, fwd, up) {
			if (!ctx) return; const l = ctx.listener;
			if (l.positionX) { l.positionX.value = pos.x * M; l.positionY.value = pos.y * M; l.positionZ.value = pos.z * M; l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z; l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z; }
			else { l.setPosition(pos.x * M, pos.y * M, pos.z * M); l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
		},
		/** a one-shot at a point; o.vol scales it, o.at schedules it (context time) */
		play(name, pos, o = {}) { if (!ready() || !SOUNDS[name]) return false; const t = (o.at ?? ctx.currentTime) + .005; SOUNDS[name](at(pos), t, o.vol ?? 1, o); return true; },
		/** the radio between stations: band-limited noise wandering about, until stop() */
		static(pos, o = {}) {
			if (!ready()) return { stop() {} };
			const t = o.at ?? ctx.currentTime, d = at(pos), s = ctx.createBufferSource(); s.buffer = noise; s.loop = true;
			const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 400;
			const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = .5;
			const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 2.7; lg.gain.value = 700; lfo.connect(lg).connect(bp.frequency);   // the tuning wanders
			const crackle = ctx.createOscillator(), cg = ctx.createGain(); crackle.type = 'square'; crackle.frequency.value = 9; cg.gain.value = .35; crackle.connect(cg).connect(bp.Q);   // and crackles
			const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.16, t + .12);
			s.connect(hp).connect(bp).connect(g).connect(d); s.start(t); lfo.start(t); crackle.start(t);
			let done = false;
			return { stop(fade = .35, when) { if (done) return; done = true; const t1 = when ?? ctx.currentTime; g.gain.cancelScheduledValues(t1); g.gain.setValueAtTime(g.gain.value, t1); g.gain.linearRampToValueAtTime(0, t1 + fade); s.stop(t1 + fade + .05); lfo.stop(t1 + fade + .05); crackle.stop(t1 + fade + .05); } };
		},
		/** the air the rolodex moves: a faint low hiss whose level follows set(speed 0…1), until stop() */
		wind(pos, o = {}) {
			if (!ready()) return { set() {}, stop() {} };
			const d = at(pos), s = ctx.createBufferSource(); s.buffer = noise; s.loop = true;
			const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; const g = ctx.createGain(); g.gain.value = 0;
			s.connect(lp).connect(g).connect(d); s.start(o.at ?? ctx.currentTime);
			let done = false;
			return { set(v, when) { if (!done) g.gain.setTargetAtTime(Math.min(1, Math.max(0, v)) * .05, when ?? ctx.currentTime, .06); }, stop(when) { if (done) return; done = true; const t = when ?? ctx.currentTime; g.gain.setTargetAtTime(0, t, .06); s.stop(t + .4); } };
		},
		names: Object.keys(SOUNDS),
		dispose() { try { ctx?.close(); } catch {} ctx = null; },
	};
}
