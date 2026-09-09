/* Every real address on the site, for crawlers (robots.txt points here). */
import type { APIRoute } from 'astro';
import { SITE, routes } from '../data/site';
import { posts } from '../data/posts';

export const GET: APIRoute = () => {
	const urls = ['/', ...routes.map((r) => r.path + '/'), ...posts.map((p) => p.path)];
	const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join('\n')}\n</urlset>\n`;
	return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
