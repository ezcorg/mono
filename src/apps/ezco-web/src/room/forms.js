/* The new-project form: posts JSON to the contact-form worker (src/apps/contact-form-worker), guarded by Turnstile. */
const PROD_API = 'https://newproject.joinez.co';

/** @returns {Promise<{ok: true} | {ok: false, error: string}>} */
export async function submitProject(data, token, api) {
	if (api === false) return { ok: true }; // offline / demo mode
	if (data.message.length < 50) return { ok: false, error: 'Tell us a little more — at least 50 characters.' };
	if (!token) return { ok: false, error: 'Please complete the captcha first.' };
	const url = api ?? (import.meta.env.DEV ? 'http://localhost:8787' : PROD_API);
	try {
		const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, turnstileToken: token }) });
		const j = await r.json().catch(() => ({}));
		return r.ok && j.success ? { ok: true } : { ok: false, error: j.error || `Something went wrong (${r.status}).` };
	} catch {
		return { ok: false, error: "Couldn't reach the server — are you online?" };
	}
}

/* Cloudflare Turnstile, loaded the first time a form is on screen and rendered explicitly into each form's `.cf-turnstile`. */
export const turnstile = {
	script: null,
	load() {
		if (!this.script) this.script = new Promise((res, rej) => {
			if (window.turnstile) return res(window.turnstile);
			const s = document.createElement('script');
			s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true;
			s.onload = () => res(window.turnstile); s.onerror = () => rej(new Error('turnstile failed to load'));
			document.head.appendChild(s);
		});
		return this.script;
	},
	async mount(form, sitekey, light) {
		const el = form.querySelector('.cf-turnstile');
		if (!el || el.dataset.widget || !sitekey) return;
		el.dataset.widget = 'pending';
		try {
			const ts = await this.load();
			if (!el.isConnected || el.dataset.widget !== 'pending') return;
			el.dataset.widget = ts.render(el, { sitekey, theme: light ? 'light' : 'dark', size: 'flexible' });
		} catch { delete el.dataset.widget; }
	},
	token(form) { return form.querySelector('[name="cf-turnstile-response"]')?.value || ''; },
	reset(form) { const el = form.querySelector('.cf-turnstile'); if (el?.dataset.widget && el.dataset.widget !== 'pending' && window.turnstile) { try { window.turnstile.reset(el.dataset.widget); } catch {} } },
};
