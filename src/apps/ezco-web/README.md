# joinez.co - Astro Website

A modern, minimalist website built with Astro and deployed on GitHub Pages.

## 🚀 Project Structure

```
/
├── public/
│   └── favicon.svg
├── src/
│   ├── components/
│   │   ├── Breadcrumb.astro
│   │   ├── Footer.astro
│   │   ├── Logo.astro
│   │   └── Navbar.astro
│   ├── layouts/
│   │   └── Layout.astro
│   └── pages/
│       ├── index.astro
│       ├── about.astro
│       ├── services.astro
│       ├── work.astro
│       └── project.astro
├── astro.config.mjs
└── package.json
```

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## 🌐 Deployment

This site is configured to deploy automatically to GitHub Pages when changes are pushed to the main branch.

### Setup GitHub Pages

1. Go to your repository settings
2. Navigate to "Pages" in the sidebar
3. Under "Source", select "GitHub Actions"
4. Push to the main branch to trigger the first deployment

The site will be available at: `https://[username].github.io/ezco-web`

## 🎨 Features

- **Astro**: Modern static site generator
- **Tailwind CSS**: Utility-first CSS framework
- **TypeScript**: Type-safe development
- **Responsive Design**: Mobile-first approach
- **GitHub Pages**: Automatic deployment
- **SEO Optimized**: Meta tags and semantic HTML

## 📝 Pages

- **Home** (`/`) - Hero section with animated text
- **About** (`/about`) - Team information
- **Services** (`/services`) - Service offerings
- **Work** (`/work`) - Portfolio showcase
- **Project** (`/newproject`) - Contact form

## 🔧 Customization

### Updating Site Configuration

Edit `astro.config.mjs` to update:
- Site URL
- Base path
- Build settings

### Styling

The project uses Tailwind CSS with a custom dark theme. Global styles are defined in `src/layouts/Layout.astro`.

### Content

Update page content by editing the respective `.astro` files in `src/pages/`.

## 📱 Browser Support

- Modern browsers (Chrome, Firefox, Safari, Edge)
- Mobile responsive design
- Progressive enhancement approach