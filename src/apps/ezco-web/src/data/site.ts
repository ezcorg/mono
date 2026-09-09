/* The site: its address, its one line, and the pages that exist as real URLs (see src/pages/*). */
export const SITE = 'https://joinez.co';
export const TAGLINE = 'your friendly neighborhood tech collective';

/** A page that is both a room route (`#/path`) and a static page (`/path/`) crawlers can read. */
export interface StaticRoute { path: string; title: string; description: string }
export const routes: StaticRoute[] = [
	{ path: '/work', title: 'our work', description: 'The things we have built: a Markdown editor, a code editor component, a WASM-in-the-middle proxy.' },
	{ path: '/blog', title: 'blog', description: 'Notes from ez co, a democratic tech collective.' },
	{ path: '/newproject', title: 'start a project', description: 'Want us to make something? Open source, software development, consulting.' },
	{ path: '/about', title: 'about us', description: 'Who we are, who you are: passionate technologists building without compromising our values.' },
	{ path: '/join', title: 'come work with us', description: 'A democratic collective, not an employer: every member has a voice, and a share.' },
];

/** the room's route for a static path: `/blog/x/` → `#/blog/x` */
export const roomRoute = (path: string) => '#' + (path.replace(/\/+$/, '') || '/');
