# The room

joinez.co's landing page is a room you walk into. The logo is the building (two faces of a cube); the
furniture is the navigation, and the pages render on the furniture.

| thing | page |
| --- | --- |
| laptop on the corner desk | our work — a tiny desktop OS; each project is a program (codeblock and markdown-editor mount the real components in windows, witmproxy opens crates.io); "+ new project" opens the form as a dialog |
| tablet on the coffee table | blog — every post from `src/content/blog`, newest first; `#/blog/<slug>` picks one |
| kanban on the left wall | start a project — the "ideas" note is the form; "doing" and "done" come from `src/data` |
| gallery wall | about — the employee of the month (`public/employee.jpg`, greyscaled; a dog silhouette until it exists) and the framed manifesto |
| drive and rolodex on the shelf | GitHub, LinkedIn |
| whiteboard on the right wall | draw on it (strokes live in localStorage) |
| clipboard in your hands | come work with us — rises when you look down or tab to it |
| light switch by the door | day / night; each lamp switches on its own and remembers overrides until you put it back to the default |

## Where things live

- `src/pages/index.astro` → `src/layouts/RoomLayout.astro` + `src/components/Room.astro`. The component holds the 2D
  chrome, the accessible page list (`.sr-nav`, object-level tab stops), the no-WebGL fallback, and the `<template>`s the
  furniture renders — filled at build time from `src/data/work.ts`, `src/data/about.ts` and `src/content/blog/*.md`.
- `src/room/room.js` is the scene: three.js WebGL for the room (geometry, edges, lights, shadows) and `CSS3DRenderer` for the
  content surfaces, sharing one camera. It exports `boot({ mount, turnstileSiteKey, photo })` and returns a `dispose()`;
  `Room.astro` boots on load and on `astro:page-load`, and disposes on `astro:before-swap`, so view transitions to the flat
  pages and back work.
- `src/room/forms.js` posts the project form to the contact-form worker (`src/apps/contact-form-worker`) with a Turnstile
  token. `src/room/demos.js` mounts the demo programs with the same demo filesystem the `/work/*` pages use.
- `src/styles/room.css` is the room's CSS. `experiments/cube-room.html` is the single-file experiment the room was ported
  from and stays as a reference (debug params `?lit ?look=yaw,pitch ?hover=<id> ?labels ?up ?win=<app> ?photo=<url> ?debug`
  work there, and in the site in dev mode).

## Rendering notes worth knowing

- The scene is authored in cube units (edge = 1) and rendered at ×2500 so CSS3D planes sit near scale 1 (crisp text, 1px
  borders) and far enough apart for Chrome's 3D sorter. Surfaces are laid out at the pixel width they will have on screen
  when focused (`fitPose`), and re-laid-out on resize.
- The DOM always composites above WebGL, so surfaces are shown only when facing the camera, unoccluded (raycast against the
  shell and door) and only from inside the room, and lamps are placed so they never overlap a board on screen.
- The transformed surface element must not clip: `overflow:hidden` on a 3D-transformed element breaks Chrome's pointer
  hit-testing (clicks fall through to the canvas). Content roots (`.scroller`, `.os`, `.kb`) clip instead. Native scroll
  containers inside CSS3D planes break depth sorting too, so surfaces scroll by hand.
- Day/night, lamp overrides, and whiteboard strokes are remembered in localStorage (`ezco-lit`, `ezco-lamps`, `ezco-board`).

## Still to do before it replaces the whole site

See the plan in the session notes: real URLs for the room's routes, the join form's backend, Safari/Firefox/mobile passes,
code-splitting three.js behind the loading screen, flat pages reading from `src/data`, an OG image, and browser tests in CI.
