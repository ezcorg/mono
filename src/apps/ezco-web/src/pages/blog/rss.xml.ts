/* The blog as a feed. */
import type { APIRoute } from 'astro';
import { SITE as PROD } from '../../data/site';
import { posts } from '../../data/posts';

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
export const GET: APIRoute = ({ url }) => {
	const SITE = import.meta.env.DEV ? url.origin : PROD;   // in dev the links point at the dev server
	const items = posts.map((p) => `    <item>\n      <title>${esc(p.fm.title)}</title>\n      <link>${SITE}${p.path}</link>\n      <guid>${SITE}${p.path}</guid>\n      <pubDate>${new Date(p.fm.date).toUTCString()}</pubDate>\n${p.fm.description ? `      <description>${esc(p.fm.description)}</description>\n` : ''}    </item>`).join('\n');
	const body = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>ez co · blog</title>\n    <link>${SITE}/blog/</link>\n    <description>Notes from ez co, a democratic tech collective.</description>\n    <language>en</language>\n    <atom:link href="${SITE}/blog/rss.xml" rel="self" type="application/rss+xml"/>\n${items}\n  </channel>\n</rss>\n`;
	return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
};
