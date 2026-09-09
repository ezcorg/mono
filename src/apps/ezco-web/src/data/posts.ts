/* The blog: every post in src/content/blog, newest first (drafts left out). Read by the tablet in the room and by /blog/. */
import type { MarkdownInstance } from 'astro';

export interface Frontmatter { title: string; description?: string; date: string; author?: string; tags?: string[]; draft?: boolean }
export interface Post { slug: string; fm: Frontmatter; Content: MarkdownInstance<Frontmatter>['Content']; path: string }

const modules = import.meta.glob<MarkdownInstance<Frontmatter>>('../content/blog/*.md', { eager: true });
export const posts: Post[] = Object.entries(modules)
	.map(([file, m]) => { const slug = file.split('/').pop()!.replace(/\.md$/, ''); return { slug, fm: m.frontmatter, Content: m.Content, path: `/blog/${slug}/` }; })
	.filter((p) => !p.fm.draft)
	.sort((a, b) => new Date(b.fm.date).getTime() - new Date(a.fm.date).getTime());

/** frontmatter dates are calendar dates */
export const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
