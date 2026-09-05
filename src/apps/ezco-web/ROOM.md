# The room

joinez.co is a room you walk into. The logo is the building (two faces of a cube); the furniture is the
navigation, and the pages render on the furniture. There are no other pages: everything reachable is in the room.

| thing | page |
| --- | --- |
| laptop on the corner desk | our work — a lock screen (the logo bounces like the DVD one and lands in a corner every 104 s) until you hover, then a tiny desktop OS; each project is a program (codeblock and markdown-editor run for real, each in its own document framed in a window; witmproxy opens crates.io); "+ new project" opens the form as a dialog. Windows minimise to the bar at the top and come back from it (one in front at a time; a minimised demo keeps running); a demo's title bar is drawn by its own document: the program's file search, a GitHub mark for the source, – and × |
| tablet on the coffee table | blog — every post from `src/content/blog`, newest first; `#/blog/<slug>` picks one |
| kanban on the left wall | start a project — the "ideas" note is the form (the same one as the laptop's dialog; the worker's rules are checked in the browser first, `checkProject` in `src/room/forms.js`, which also holds the $500 minimum budget); "doing" and "done" come from `src/data` |
| gallery wall | about — the employee of the month, Lady (`public/employee.jpg`, greyscaled; blank while it loads, a dog silhouette only if it fails; her plate is in the room's mid tone, the bezels') and the framed manifesto |
| floppy + thumb drive on the desk | GitHub |
| rolodex on the shelf | LinkedIn |
| radio on the shelf | plays a Nujabes playlist through a hidden YouTube player (audio only; hovering warms the player so the click can play synchronously, which Safari requires); once touched, a ⏮ ⏸ ⏭ bar appears above it while the radio or the bar is hovered or focused, and fades exactly like a label (an invisible hit box reaches from the radio up to the bar, so the pointer can climb to it) — the track name is in the buttons' tooltips |
| whiteboard on the right wall | draw on it (strokes live in localStorage) |
| clipboard in your hands | come work with us — rises when you look down or tab to it (no backend yet: it says so) |
| dial by the door | lights: ◐ auto (follows the system colour scheme) · ☀ day · ☾ night; every lamp switches on its own (its label is a bulb, filled when lit) and remembers overrides until you put it back to the default |

Keys: `↵` or scroll to come in · click · drag or arrows to look (in a page too) · `?` labels · `l` lights · `esc` back. In the
OS, a bar chip brings a window up or minimises it; every control carries an explicit `tabindex` (Safari's Tab needs one).
In a page you can look as far as the thing's whole area (`limitsFor`): a phone's portrait crop of the kanban or the gallery
wall can be panned to the other columns or the other frame. Scroll areas (`.scroller`, in-flow `.scroll`) fade their bottom
edge while there's more below; a finger drag scrolls them (`touch-action: none`, or the browser cancels the pointer events).

## Where things live

- `src/pages/index.astro` → `src/layouts/RoomLayout.astro` + `src/components/Room.astro`. The component holds the 2D
  chrome, the accessible page list (`.sr-nav`, object-level tab stops), the no-WebGL fallback, and the `<template>`s the
  furniture renders — filled at build time from `src/data/work.ts`, `src/data/about.ts` and `src/content/blog/*.md`.
- `src/room/room.js` is the scene: three.js WebGL for the room (geometry, edges, lights, shadows) and `CSS3DRenderer` for the
  content surfaces, sharing one camera. `boot({ mount, turnstileSiteKey, photo })` returns a `dispose()`.
- `src/room/forms.js` posts the project form to the contact-form worker (`src/apps/contact-form-worker`, schema in
  `@joinezco/shared`) with a Turnstile token. `src/room/demos.js` frames the demo programs: they run as their own documents,
  `src/pages/apps/*.astro` (not pages people visit), on the shared demo filesystem (`src/scripts/demo-fs.ts`, files in
  `src/data/demo-files.js`), so tooltips and popovers can't spill past the window. Each of those documents draws its own
  title bar (`src/scripts/ezos-frame.ts`, `src/styles/ezos-frame.css`): the program's icon, its file-search toolbar as a
  centred search field (the markdown-editor mounts it there; the codeblock's is a CodeMirror panel that gets moved up, laid
  out with the library's `toolbarLayout: 'compact'`), a GitHub mark, – and ×, which ask the room by `postMessage`; the room
  passes its theme as `?lit` and then by message, and the editors follow it — paper, ink, rules and highlights in the room's
  palette (`ezos-frame.css`), syntax colours their own. The markdown-editor runs with `blockActions: false` (the library
  builds no gutter then). `src/room/radio.js` is the hidden player.
- `src/styles/room.css` is the room's CSS; `src/styles/global.css` only carries the demo fonts.
- `experiments/cube-room.html` is the single-file experiment the room was ported from. It is frozen at the port; changes
  go to `src/room` now. In dev mode the site accepts the same debug params before the route:
  `?lit ?dark ?look=yaw,pitch ?hover=<id> ?labels ?up ?win=<app> ?photo=<url> ?debug` (`?debug` exposes `window.room`).
  In any build: `?perf` shows a readout (rAF interval, the frame function's JS time, gl.render, css.render, draw calls);
  `?nogl` / `?nodom` skip a renderer, `?noaa` drops antialiasing, `?noshadow` the shadow maps, `?dpr=1` the pixel ratio —
  one at a time, to find which layer a browser is slow in. `?bench` runs all of them for you (one reload each, panning,
  three seconds apiece, outside and then inside) and ends with a box of results and a copy button.

## Rendering notes worth knowing

- The scene is authored in cube units (edge = 1) and rendered at ×2500 so CSS3D planes sit near scale 1 (crisp text, 1px
  borders) and far enough apart for Chrome's 3D sorter. The door is .976 wide and flush with the frame bars, so the logo
  face's painted border sits inside the frame rather than over it. Surfaces are laid out at the pixel width they will have on screen
  when focused (`fitPose`), and re-laid-out on resize.
- The DOM always composites above WebGL, so surfaces are shown only when facing the camera, unoccluded (raycast against the
  shell and door) and only from inside the room, and lamps are placed so they never overlap a board on screen.
- The transformed surface element must not clip: `overflow:hidden` on a 3D-transformed element breaks Chrome's pointer
  hit-testing (clicks fall through to the canvas). Content roots (`.scroller`, `.os`, `.kb`) clip instead. Native scroll
  containers inside CSS3D planes break depth sorting too, so surfaces scroll by hand.
- A plane's content is laid out at its reading width and rastered at the scale it is seen at: a `.zw` wrapper inside the
  surface carries a 2D `scale(res)` (`surface.setRes`), and `refreshRes()` picks `res` for every plane from wherever the
  camera is headed (the open page reads at 1). Chrome re-rasters 3D layers at their on-screen scale by itself; Safari
  and Firefox raster them at layout size and minify, which turns 1px rules into dashes from across the room.
- Editors measure themselves with `getBoundingClientRect`, which a perspective transform confuses (CodeMirror's measure
  loop). A demo window is therefore lifted out of the 3D plane into a fixed `.overlay`, sized every frame from a hidden
  placeholder that stays in the OS, and the camera holds still (`focusLock`) while one is open. Desktop icons only work
  once the laptop page is open; from afar a click on one just opens the laptop.
- Camera tweens start from what you actually see: `absorbLook()` bakes the drag/parallax offset into the camera target
  before a pose tween, so opening or closing a page never snaps back to the "ideal" angle first. A fit never puts the
  camera behind the far wall (`maxD` on the whiteboard and kanban fits — a portrait viewport would otherwise stand outside
  the room to fit a wide board). The clipboard, opened, comes to you: it settles squarely in front of the camera at
  reading distance (gliding from your hands if it was up), so the camera only tilts down to it; a page opened from
  another page (the manifesto's links) remembers it (`t.back`) and `esc` goes back there.
- Motion is in wall-clock terms: every follow-lerp goes through `lerpK(rate)`, which scales the per-frame rate to the
  time that actually passed (reference 120 Hz, where the feel was tuned). Safari caps pages at 60 fps by default
  ("Prefer Page Rendering Updates near 60fps" in Develop → Feature Flags) — before this, the room followed the pointer
  half as fast there.
- The laptop's lock-screen logo and the desktop's programs are sized to the screen (container units), so a phone gets
  the same picture as a desk.
- Remembered in localStorage: `ezco-lights` (auto/day/night), `ezco-lamps` (per-lamp overrides), `ezco-board` (strokes).
- three.js loads behind the loading label (its own chunk); the label and the lock-screen logo animate with a clipped
  inverted copy rather than `mix-blend-mode`, which Safari rasterises badly inside 3D transforms. No web fonts are loaded
  for the room itself (Helvetica/Arial/system); the demo fonts live in `global.css`.
- Lossless rendering savings (three.js culls by frustum only, never by occlusion): everything inside the box is one
  `interior` group, hidden while you're outside with the door shut (63 draw calls instead of ~350); the shadow maps are
  re-rendered only while a caster moves (`gl.shadowMap.autoUpdate = false`, `needsUpdate` while a tween runs or the
  rolodex spins — 138 casters × 8 passes otherwise, every frame; the clipboard casts nothing, it rides with the camera);
  the renderer asks for the high-performance GPU. Chrome at 2× with vsync off: the room went from 3.1 to 2.3 ms/frame,
  the logo view from 2.2 to 1.3. Safari's WebGL runs in a separate GPU process, so its per-draw-call cost is higher and
  these matter more there; `?perf` with `?nogl` / `?nodom` / `?noaa` / `?noshadow` / `?dpr=1` tells which layer is the slow
  one on a given machine. The logo's hover slide is an inverted copy of each face behind a moving clipping plane (a uniform),
  not a per-frame canvas redraw (that was two 1024² texture uploads a frame for half a second); the material pass
  (`applyTheme`) runs only while a transition is in flight — the lerps snap once they're within .003.
- Astro scopes a component's `<style>` to elements it rendered, so rules for elements a script creates later (editor DOM,
  the toolbar) need `<style is:global>` — the app documents use it.
- The OS's idiom: a window has one soft border (`--line`) and a hard offset shadow; inside it nothing else is boxed —
  icons, task chips and window buttons sit bare and take the selection tint (`--sel`) when pointed at; the search field,
  dropdowns and the editors' tooltips get a soft rounded edge (`--line-soft`, 4px) and the same hard shadow.

## Verifying

Headless Chrome screenshots and puppeteer scripts against `astro dev` (`?debug` gives `window.room` for assertions). The
console should stay clean apart from the missing `/employee.jpg` and Turnstile's 110200 on localhost (prod site key).

## Still to do

Real join-form infrastructure; browser tests in CI; redeploy the worker before (or with) the site so the room's budget-less
submissions validate.
