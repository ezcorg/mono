/* The things we've built. Programs on the laptop in the room, cards on /work. */
export interface Project {
	id: string;
	title: string;
	icon: string;
	description: string;
	tags: string[];
	/** opens in a new tab */
	href?: string;
	/** mounts a real demo inside the room's OS window (see src/room/demos.js) */
	demo?: 'codeblock' | 'markdown-editor';
	github: string;
}

export const projects: Project[] = [
	{
		id: 'markdown-editor',
		title: 'markdown-editor',
		icon: '📝',
		description: 'An intuitive, minimal, extensible markdown editor component.',
		tags: ['TipTap', 'ProseMirror', 'TypeScript'],
		demo: 'markdown-editor',
		github: 'https://github.com/join-ezco/mono/tree/main/src/typescript/markdown-editor',
	},
	{
		id: 'codeblock',
		title: 'codeblock',
		icon: '💻',
		description: 'A codeblock component with language server and virtual filesystem support.',
		tags: ['CodeMirror', 'LSP', 'TypeScript'],
		demo: 'codeblock',
		github: 'https://github.com/join-ezco/mono/tree/main/src/typescript/codeblock',
	},
	{
		id: 'witmproxy',
		title: 'witmproxy',
		icon: '🌐',
		description: 'A WASM-in-the-middle proxy.',
		tags: ['Rust', 'Plugins', 'WASM', 'mitmproxy'],
		href: 'https://crates.io/crates/witmproxy',
		github: 'https://github.com/join-ezco/mono/tree/main/src/apps/witmproxy',
	},
];
