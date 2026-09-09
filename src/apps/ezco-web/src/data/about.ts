/* Who we are. The framed manifesto in the room, the sections on /about. */
export interface Statement {
	text: string;
	/** substrings of `text` to turn into links */
	links?: { text: string; href: string }[];
}
export interface Section {
	heading: string;
	statements: Statement[];
}

export const sections: Section[] = [
	{
		heading: 'who we are',
		statements: [
			{ text: 'We are passionate technologists determined to build without compromising our values.' },
			{ text: 'We do not believe in chasing short-term profits at the expense of long-term prosperity.' },
			{ text: 'We will never be evil (<i>actually</i>).' },
		],
	},
	{
		heading: 'who you are',
		statements: [
			{ text: 'Someone who feels the same.' },
			{
				text: 'Someone who wants to join or work with our collective.',
				links: [
					{ text: 'join', href: '/join' },
					{ text: 'work with', href: '/newproject' },
				],
			},
		],
	},
];

/** What's on the board right now (the kanban's "doing" column). */
export const lately: string[] = [
	'A man-in-the-middle proxy to filter addictive and low-effort content',
	'A browser-based Markdown (and code) editor',
	'An aesthetically pleasing wireless charging device',
	'A platform to power democratic organizations',
];

export const links = {
	github: 'https://github.com/join-ezco',
	linkedin: 'https://linkedin.com/company/eeezco/',
};

/** Statement text with its links applied, as HTML. */
export function statementHtml(s: Statement, hrefFor: (href: string) => string = (h) => h): string {
	let html = s.text;
	for (const l of s.links ?? []) html = html.replace(l.text, `<a class="link" href="${hrefFor(l.href)}">${l.text}</a>`);
	return html;
}
