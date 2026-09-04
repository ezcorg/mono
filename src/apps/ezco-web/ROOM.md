# The room

joinez.co is a room you walk into. The logo is the building (two faces of a cube); the furniture is the
navigation, and the pages render on the furniture. There are no other pages: everything reachable is in the room.

| thing | page |
| --- | --- |
| laptop on the corner desk | our work — a lock screen (the logo bounces like the DVD one and lands in a corner every 104 s) until you hover, then a tiny desktop OS; each project is a program (codeblock and markdown-editor run for real, each in its own document framed in a window; witmproxy opens crates.io); "+ new project" opens the form as a dialog |
| tablet on the coffee table | blog — every post from `src/content/blog`, newest first; `#/blog/<slug>` picks one |
| kanban on the left wall | start a project — the "ideas" note is the form; "doing" and "done" come from `src/data` |
| gallery wall | about — the employee of the month, Lady (`public/employee.jpg`, greyscaled; blank while it loads, a dog silhouette only if it fails) and the framed manifesto |
| floppy + thumb drive on the desk | GitHub |
| rolodex on the shelf | LinkedIn |
| radio on the shelf | plays a Nujabes playlist through a hidden YouTube player (audio only; nothing loads until you switch it on); while it plays, ⏮ ⏸ ⏭ float just under it, and hovering shows the track |
| whiteboard on the right wall | draw on it (strokes live in localStorage) |
| clipboard in your hands | come work with us — rises when you look down or tab to it (no backend yet: it says so) |
| dial by the door | lights: ◐ auto (follows the system colour scheme) · ☀ day · ☾ night; every lamp switches on its own (its label is a bulb, filled when lit) and remembers overrides until you put it back to the default |

Keys: `↵` or scroll to come in · click · drag or arrows to look · `?` labels · `l` lights · `esc` back.

## Where things live

- `src/pages/index.astro` → `src/layouts/RoomLayout.astro` + `src/components/Room.astro`. The component holds the 2D
  chrome, the accessible page list (`.sr-nav`, object-level tab stops), the no-WebGL fallback, and the `<template>`s the
  furniture renders — filled at build time from `src/data/work.ts`, `src/data/about.ts` and `src/content/blog/*.md`.
- `src/room/room.js` is the scene: three.js WebGL for the room (geometry, edges, lights, shadows) and `CSS3DRenderer` for the
  content surfaces, sharing one camera. `boot({ mount, turnstileSiteKey, photo })` returns a `dispose()`.
- `src/room/forms.js` posts the project form to the contact-form worker (`src/apps/contact-form-worker`, schema in
  `@joinezco/shared`) with a Turnstile token. `src/room/demos.js` frames the demo programs: they run as their own documents,
  `src/pages/apps/*.astro` (not pages people visit), on the shared demo filesystem (`src/scripts/demo-fs.ts`, files in
  `src/data/demo-files.js`), so tooltips and popovers can't spill past the window. `src/room/radio.js` is the hidden player.
- `src/styles/room.css` is the room's CSS; `src/styles/global.css` only carries the demo fonts.
- `experiments/cube-room.html` is the single-file experiment the room was ported from. It is frozen at the port; changes
  go to `src/room` now. In dev mode the site accepts the same debug params before the route:
  `?lit ?dark ?look=yaw,pitch ?hover=<id> ?labels ?up ?win=<app> ?photo=<url> ?debug` (`?debug` exposes `window.room`).

## Rendering notes worth knowing

- The scene is authored in cube units (edge = 1) and rendered at ×2500 so CSS3D planes sit near scale 1 (crisp text, 1px
  borders) and far enough apart for Chrome's 3D sorter. Surfaces are laid out at the pixel width they will have on screen
  when focused (`fitPose`), and re-laid-out on resize.
- The DOM always composites above WebGL, so surfaces are shown only when facing the camera, unoccluded (raycast against the
  shell and door) and only from inside the room, and lamps are placed so they never overlap a board on screen.
- The transformed surface element must not clip: `overflow:hidden` on a 3D-transformed element breaks Chrome's pointer
  hit-testing (clicks fall through to the canvas). Content roots (`.scroller`, `.os`, `.kb`) clip instead. Native scroll
  containers inside CSS3D planes break depth sorting too, so surfaces scroll by hand.
- Editors measure themselves with `getBoundingClientRect`, which a perspective transform confuses (CodeMirror's measure
  loop). A demo window is therefore lifted out of the 3D plane into a fixed `.overlay`, sized every frame from a hidden
  placeholder that stays in the OS, and the camera holds still (`focusLock`) while one is open. Desktop icons only work
  once the laptop page is open; from afar a click on one just opens the laptop.
- Camera tweens start from what you actually see: `absorbLook()` bakes the drag/parallax offset into the camera target
  before a pose tween, so opening or closing a page never snaps back to the "ideal" angle first.
- Remembered in localStorage: `ezco-lights` (auto/day/night), `ezco-lamps` (per-lamp overrides), `ezco-board` (strokes).

## Verifying

Headless Chrome screenshots and puppeteer scripts against `astro dev` (`?debug` gives `window.room` for assertions). The
console should stay clean apart from the missing `/employee.jpg` and Turnstile's 110200 on localhost (prod site key).

## Still to do

Real join-form infrastructure; a Safari pass; code-splitting three.js behind the loading screen (≈550 KB chunk); an OG image;
browser tests in `ezco-web-build.yml`; publish `@joinezco/shared` 0.0.6 and redeploy the worker before the room's
budget-less submissions succeed.
