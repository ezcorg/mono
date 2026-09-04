/* the room — ported from experiments/cube-room.html (the experiment stays as the reference copy) */
let THREE, CSS3DRenderer, CSS3DObject;   // loaded behind the loading label, see boot()
import { submitProject, turnstile } from './forms.js';
import { mountDemo, destroyDemos } from './demos.js';
import { radio } from './radio.js';

/* Boots the room into `opts.mount` (the element holding the chrome + templates). Returns a dispose(). */
export async function boot(opts = {}) {
const root = opts.mount || document.body;
{ const probe = document.createElement('canvas'); if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) { root.classList.add('no-webgl'); return () => {}; } }
[THREE, { CSS3DRenderer, CSS3DObject }] = await Promise.all([import('three'), import('three/addons/renderers/CSS3DRenderer.js')]);
const ac = new AbortController(), { signal } = ac; let disposed = false;
const addEventListener = (type, fn, o) => window.addEventListener(type, fn, { ...(typeof o === 'object' ? o : {}), signal });
document.body.dataset.state = 'logo'; document.body.classList.add('preload');
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const tpl = id => $('#t-' + id).innerHTML;
const D2R = Math.PI / 180, body = document.body;
const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;
const dbg = new URLSearchParams(import.meta.env.DEV ? location.search : '');
const isPortrait = () => innerWidth < innerHeight;
const EMPLOYEE_PHOTO = dbg.get('photo') || opts.photo || '/employee.jpg', FACE = .4;   // FACE: where along the photo's height the crop centres (0 top … 1 bottom)   // grayscale'd onto the frame when it loads; a dog silhouette until then
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = k => k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
const delay = ms => new Promise(r => setTimeout(r, ms));

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const Y = V3(0, 1, 0);

/* ------------------------------------------------------------------ renderers + camera
   Authored in cube units (edge = 1), rendered at ×K: CSS3DRenderer maps world units to CSS px, so K puts
   the focused DOM planes near scale 1 (crisp, 1px borders stay 1px) and far apart for Chrome's 3D sorter. */
const K = 2500;
const gl = new THREE.WebGLRenderer({ antialias: true });
gl.setPixelRatio(Math.min(devicePixelRatio, 2)); gl.shadowMap.enabled = true; gl.shadowMap.type = THREE.PCFSoftShadowMap;
gl.domElement.id = 'gl'; root.prepend(gl.domElement);
const css = new CSS3DRenderer(); css.domElement.id = 'css'; gl.domElement.after(css.domElement);
{ const q = new URLSearchParams(location.search); if (q.has('nodom')) css.domElement.style.display = 'none'; if (q.has('nogl')) gl.domElement.style.visibility = 'hidden'; }   // bisecting renderer artifacts in any build: ?nodom hides the DOM layer, ?nogl the WebGL one
const scene = new THREE.Scene(); scene.scale.setScalar(K);
const camera = new THREE.PerspectiveCamera(55, 1, .02 * K, 60 * K);

/* ------------------------------------------------------------------ theme: colourless light, night / day */
const THEMES = {
  night: { bg: '#000000', wall: '#0c0c0c', floor: '#080808', rug: '#161616', obj: '#000000', bezel: '#2b2b2b', edge: '#f5f5f5', edgeA: .5, hemi: .18, ground: '#050505', sun: 0, moon: .3, glass: '#9fb4cc', plant: '#1e1e1e', grid: .16, glow: .8 },
  day:   { bg: '#f5f5f5', wall: '#f0f0f0', floor: '#e6e6e6', rug: '#d9d9d9', obj: '#f5f5f5', bezel: '#cfcfcf', edge: '#000000', edgeA: .65, hemi: 1.1, ground: '#b8b8b8', sun: 2.4, moon: 0, glass: '#ffffff', plant: '#d6d6d6', grid: .22, glow: 0 },
};
let themeT = 0, themeTarget = 0;
const C = hex => new THREE.Color(hex), lerpC = (a, b, t) => a.clone().lerp(b, t);
const reg = { wall: [], floor: [], rug: [], edge: [], things: [] };
const wallMat = () => { const m = new THREE.MeshStandardMaterial({ color: THEMES.night.wall, roughness: .96 }); reg.wall.push(m); return m; };
const edgeMat = () => { const m = new THREE.LineBasicMaterial({ color: THEMES.night.edge, transparent: true, opacity: THEMES.night.edgeA }); reg.edge.push(m); return m; };
const stdMat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: .9, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, ...extra });

/* ------------------------------------------------------------------ geometry helpers */
function edges(geo, mat, threshold = 25) { return new THREE.LineSegments(new THREE.EdgesGeometry(geo, threshold), mat); }
function mesh(geo, o = {}) {
  const m = new THREE.Mesh(geo, o.mat); m.position.set(o.x || 0, o.y || 0, o.z || 0); m.rotation.set(o.rx || 0, o.ry || 0, o.rz || 0);
  m.castShadow = o.shadow !== false; m.receiveShadow = true; if (o.edge) m.add(edges(geo, o.edge, o.threshold)); return m;
}
const box = (w, h, d, o = {}) => mesh(new THREE.BoxGeometry(w, h, d), o);
const cyl = (r, h, o = {}) => mesh(new THREE.CylinderGeometry(o.r2 ?? r, r, h, 40, 1, !!o.open), { threshold: 40, ...o });
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  t.redraw = () => { draw(c.getContext('2d'), w, h); t.needsUpdate = true; }; t.redraw(); return t;
}
const themeColors = () => themeT < .5 ? { bg: '#000', fg: '#f5f5f5' } : { bg: '#f5f5f5', fg: '#000' };
/* a stand-in employee: a dog in profile */
function drawDog(ctx, cx, cy, s, fg) {
  ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.ellipse(cx, cy, s, s * .48, 0, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = s * .17; for (const lx of [-.66, -.34, .3, .62]) { ctx.beginPath(); ctx.moveTo(cx + lx * s, cy + s * .2); ctx.lineTo(cx + lx * s * .96, cy + s * .98); ctx.stroke(); }
  ctx.lineWidth = s * .4; ctx.beginPath(); ctx.moveTo(cx + s * .72, cy - s * .12); ctx.lineTo(cx + s * .95, cy - s * .52); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(cx + s * 1.0, cy - s * .6, s * .33, s * .29, -.25, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx + s * 1.3, cy - s * .5, s * .2, s * .12, .1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx + s * .82, cy - s * .5, s * .11, s * .25, .4, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = s * .12; ctx.beginPath(); ctx.moveTo(cx - s * .96, cy - s * .08); ctx.quadraticCurveTo(cx - s * 1.35, cy - s * .45, cx - s * 1.1, cy - s * .9); ctx.stroke();
}
/* a monstera leaf: heart outline with notches, as a Shape */
function monsteraShape(s = 1) {
  const sh = new THREE.Shape();
  sh.moveTo(0, -.55 * s); sh.bezierCurveTo(.5 * s, -.5 * s, .62 * s, .1 * s, .32 * s, .45 * s); sh.bezierCurveTo(.16 * s, .62 * s, .04 * s, .5 * s, 0, .4 * s);
  sh.bezierCurveTo(-.04 * s, .5 * s, -.16 * s, .62 * s, -.32 * s, .45 * s); sh.bezierCurveTo(-.62 * s, .1 * s, -.5 * s, -.5 * s, 0, -.55 * s);
  for (const [x, y, r] of [[.28, .05, .06], [-.3, -.1, .05], [.22, -.28, .045], [-.2, .22, .04]]) { const h = new THREE.Path(); h.absarc(x * s, y * s, r * s, 0, Math.PI * 2, true); sh.holes.push(h); }
  return sh;
}

/* ------------------------------------------------------------------ lights (all white) */
const hemi = new THREE.HemisphereLight(0xffffff, 0x0a0a0a, THEMES.night.hemi); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 0); sun.position.set(1.2, 3, .8); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -1.2 * K, right: 1.2 * K, top: 1.2 * K, bottom: -1.2 * K, near: .5 * K, far: 9 * K }); sun.shadow.bias = -.002; sun.shadow.normalBias = .01 * K;
scene.add(sun, sun.target);
const moon = new THREE.DirectionalLight(0xffffff, THEMES.night.moon); moon.position.set(3, 1.4, .6); moon.castShadow = true; moon.shadow.mapSize.set(1024, 1024);
Object.assign(moon.shadow.camera, { left: -1.2 * K, right: 1.2 * K, top: 1.2 * K, bottom: -1.2 * K, near: .5 * K, far: 9 * K }); moon.shadow.bias = -.002; moon.shadow.normalBias = .01 * K;
scene.add(moon, moon.target);
const pointLight = (x, y, z, shadows) => { const l = new THREE.PointLight(0xffffff, 1, 2.6 * K, 2); l.position.set(x, y, z); if (shadows) { l.castShadow = true; l.shadow.mapSize.set(1024, 1024); l.shadow.bias = -.004; l.shadow.normalBias = .01 * K; l.shadow.camera.near = .03 * K; l.shadow.camera.far = 8 * K; } scene.add(l); return l; };
/* every lamp is a thing you can switch: on by night, off by day, unless you've overridden it (remembered per lamp) */
const lamps = [];
let lampState = {}; try { lampState = JSON.parse(localStorage.getItem('ezco-lamps') || '{}') || {}; } catch {}
scene.background = C(THEMES.night.bg); scene.fog = new THREE.Fog(THEMES.night.bg, 2.6 * K, 7 * K);

/* ------------------------------------------------------------------ the building (exterior = the logo) */
const logoTex = {};
function drawLogo(ctx, W, txt, slide) {
  const { bg, fg } = themeColors();
  ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = bg; ctx.fillRect(0, 0, W, W); ctx.fillStyle = fg; ctx.fillRect(slide * W, 0, W, W);
  ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = '#fff'; ctx.font = `500 ${W * .38}px Helvetica, Arial, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, W / 2, W / 2 + W * .02);
  ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = fg; ctx.lineWidth = W * .012; ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, W - ctx.lineWidth);
}
let logoT = 0, logoHot = false, logoDrawn = -1;
logoTex.ez = canvasTex(1024, 1024, (ctx, W) => drawLogo(ctx, W, 'ez', 1 - logoT));
logoTex.co = canvasTex(1024, 1024, (ctx, W) => drawLogo(ctx, W, 'co', -logoT));
const extMat = new THREE.MeshStandardMaterial({ color: '#000', roughness: .95 }), none = new THREE.MeshBasicMaterial({ visible: false });
const shellMats = [new THREE.MeshBasicMaterial({ map: logoTex.co }), extMat, extMat, extMat, none, extMat];
const shell = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shellMats); scene.add(shell);
const doorGroup = new THREE.Group(); doorGroup.position.set(-.5, 0, .512); scene.add(doorGroup);
const doorMats = [extMat, extMat, extMat, extMat, new THREE.MeshBasicMaterial({ map: logoTex.ez }), extMat];
const door = new THREE.Mesh(new THREE.BoxGeometry(1, 1, .02), doorMats); door.position.set(.5, 0, 0); doorGroup.add(door);
const ghost = m => { const c = m.clone(); c.transparent = true; c.opacity = m === none ? 0 : .14; c.depthWrite = false; return c; };
const mirror = new THREE.Group(); mirror.scale.y = -1; mirror.position.y = -1.004; scene.add(mirror);   // a hair below the floor, or the ghost's underside z-fights it during the walk in
mirror.add(new THREE.Mesh(shell.geometry, shellMats.map(ghost)));
const doorGroupM = new THREE.Group(); doorGroupM.position.copy(doorGroup.position); mirror.add(doorGroupM);
const doorM = new THREE.Mesh(door.geometry, doorMats.map(ghost)); doorM.position.copy(door.position); doorGroupM.add(doorM);
const ground = new THREE.GridHelper(12, 96, THEMES.night.edge, THEMES.night.edge); ground.position.y = -.502; ground.material.transparent = true; ground.material.opacity = .09; scene.add(ground);

/* ------------------------------------------------------------------ the room: a glass box on a solid frame */
const floorMat = (() => { const m = new THREE.MeshStandardMaterial({ color: THEMES.night.floor, roughness: .95 }); reg.floor.push(m); return m; })();
const glassMat = new THREE.MeshStandardMaterial({ color: THEMES.night.glass, transparent: true, opacity: .1, roughness: .08, metalness: 0, depthWrite: false });
const frameMat = stdMat(THEMES.night.bezel, { roughness: .55, metalness: .2 });
const plantMat = stdMat(THEMES.night.plant, { side: THREE.DoubleSide });
const lanternMat = new THREE.MeshStandardMaterial({ color: '#2a2a2a', emissive: '#ffffff', emissiveIntensity: .7, roughness: .9 });
function pane(w, h, x, y, z, rx, ry, mat) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); m.receiveShadow = mat === floorMat; return m; }
scene.add(pane(1, 1, 0, 0, -.5, 0, 0, glassMat), pane(1, 1, -.5, 0, 0, 0, Math.PI / 2, glassMat), pane(1, 1, .5, 0, 0, 0, -Math.PI / 2, glassMat), pane(1, 1, 0, .5, 0, Math.PI / 2, 0, glassMat), pane(1, 1, 0, -.5, 0, -Math.PI / 2, 0, floorMat));
const frameEdge = edgeMat();
const bar = (w, h, d, x, y, z) => { const m = box(w, h, d, { x, y, z, mat: frameMat, edge: frameEdge, shadow: false }); return m; };
{ const E = .024, M = .009;
  for (const sx of [-.5, .5]) for (const sz of [-.5, .5]) scene.add(bar(E, 1 + E, E, sx, 0, sz));
  for (const sy of [-.5, .5]) for (const sz of [-.5, .5]) scene.add(bar(1 + E, E, E, 0, sy, sz));
  for (const sy of [-.5, .5]) for (const sx of [-.5, .5]) scene.add(bar(E, E, 1 + E, sx, sy, 0));
  scene.add(bar(M, 1, M, -.494, 0, 0), bar(M, 1, M, .494, 0, 0), bar(M, 1, M, 0, 0, -.494), bar(1, M, M, 0, .06, -.494), bar(M, M, 1, -.494, .06, 0), bar(M, M, 1, .494, .06, 0), bar(1, M, M, 0, .494, 0), bar(M, M, 1, 0, .494, 0)); }
const grid = new THREE.GridHelper(1, 10, THEMES.night.edge, THEMES.night.edge); grid.position.y = -.499; grid.material.transparent = true; grid.material.opacity = THEMES.night.grid; scene.add(grid);
const rugMat = new THREE.MeshStandardMaterial({ color: THEMES.night.rug, roughness: 1 }); reg.rug.push(rugMat);
const rug = new THREE.Mesh(new THREE.PlaneGeometry(.56, .42), rugMat); rug.rotation.x = -Math.PI / 2; rug.position.set(.06, -.497, .12); rug.receiveShadow = true; rug.add(edges(rug.geometry, edgeMat())); scene.add(rug);

/* ------------------------------------------------------------------ things (furniture that is also navigation) + decor */
const things = [], byId = {}, pickables = [], surfaces = [];
function thing(def) {
  const t = { ...def, group: new THREE.Group(), hover: 0, active: false, mat: stdMat(THEMES.night.obj), bezel: stdMat(THEMES.night.bezel, { roughness: .6, metalness: .1 }), edge: edgeMat() };
  reg.things.push(t); scene.add(t.group); things.push(t); if (t.id) byId[t.id] = t;
  t.pick = m => { m.userData.thing = t; pickables.push(m); return m; };
  t.box = (w, h, d, o = {}) => t.pick(box(w, h, d, { mat: t.mat, edge: t.edge, ...o }));
  t.bez = (w, h, d, o = {}) => t.pick(box(w, h, d, { mat: t.bezel, edge: t.edge, ...o }));
  t.cyl = (r, h, o = {}) => t.pick(cyl(r, h, { mat: t.mat, edge: t.edge, ...o }));
  return t;
}
function surface(t, o) {
  const el = document.createElement('div'); el.className = 'surface ' + o.cls; el.innerHTML = o.html;
  const obj = new CSS3DObject(el); el.style.userSelect = 'text'; el.style.webkitUserSelect = 'text';
  obj.position.set(o.x, o.y, o.z); if (o.ry) obj.rotation.y = o.ry; if (o.rx) obj.rotation.x = o.rx;
  const s = { el, obj, w: o.w, h: o.h, thing: t, fixedW: o.fixedW, setW(px) { px = Math.round(px); el.style.width = px + 'px'; el.style.height = Math.round(o.h / o.w * px) + 'px'; obj.scale.setScalar(o.w / px); } };
  s.setW(o.fixedW || 600); (o.parent || t.group).add(obj); surfaces.push(s);
  if (t.id) {
    el.addEventListener('pointerenter', () => setHover(t)); el.addEventListener('pointerleave', () => setHover(null));
    el.addEventListener('click', e => { if (dragMoved || t.active || e.target.closest('a,button,input,select,textarea,label')) return; activate(t); });
  }
  return s;
}
/* page controls get an explicit tabindex="0" when enabled, not just the attribute removed: Safari's plain Tab skips links and buttons without one */
function setInteractive(t, on) { for (const s of surfaces.filter(s => s.thing === t)) for (const el of $$('a,button,input,select,textarea,[tabindex]', s.el)) { if (on) { if (el.dataset.ti !== undefined) { el.setAttribute('tabindex', el.dataset.ti === '' ? '0' : el.dataset.ti); delete el.dataset.ti; } } else if (el.dataset.ti === undefined) { el.dataset.ti = el.getAttribute('tabindex') ?? ''; el.setAttribute('tabindex', '-1'); } } }
const decor = thing({ id: '', label: '' });
const dm = { mat: decor.mat, edge: decor.edge }, dz = { mat: decor.bezel, edge: decor.edge };
const leafGeo = (w, h) => { const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.quadraticCurveTo(w, h * .45, 0, h); sh.quadraticCurveTo(-w, h * .45, 0, 0); return new THREE.ShapeGeometry(sh, 10); };
const along = (m, from, to, axis = V3(0, 0, 1)) => { const d = to.clone().sub(from); m.position.copy(from).addScaledVector(d, .5); m.quaternion.setFromUnitVectors(axis, d.normalize()); return m; };
const alongZ = (m, from, to) => along(m, from, to, V3(0, 0, 1));
const mkBulb = () => new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0, roughness: .15, transparent: true, opacity: .35, depthWrite: false });
const mkShade = () => new THREE.MeshStandardMaterial({ color: '#1a1a1a', emissive: '#ffffff', emissiveIntensity: .3, roughness: .95, side: THREE.DoubleSide, transparent: true, opacity: .6, depthWrite: false });
const glowTex = canvasTex(128, 128, (ctx, W) => { const gr = ctx.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.35, 'rgba(255,255,255,.3)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, W); });
const glow = (x, y, z, s) => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 })); sp.position.set(x, y, z); sp.scale.setScalar(s); return sp; };

/* light switch on the left wall, by the door → day / night */
{
  const t = thing({ id: 'lights', label: 'lights: auto', action: 'lights', anchor: V3(-.487, .078, .36) });
  t.group.add(t.bez(.008, .06, .06, { x: -.492, y: .02, z: .36 }));
  for (const a of [.95, 0, -.95]) t.group.add(t.box(.002, .007, .002, { x: -.4875, y: .02 + Math.cos(a) * .025, z: .36 + Math.sin(a) * .025, rx: -a }));   // night · auto · day
  t.knob = new THREE.Group(); t.knob.position.set(-.487, .02, .36); t.group.add(t.knob);
  t.knob.add(t.cyl(.016, .01, { rz: Math.PI / 2 }), t.box(.004, .012, .003, { x: .006, y: .009 }));
  const hit = new THREE.Mesh(new THREE.BoxGeometry(.03, .1, .1), none); hit.position.set(-.485, .02, .36); t.group.add(t.pick(hit));   // a bigger target than the dial itself
}

/* corner desk + stool + laptop + a desk plant → our work */
{
  const t = thing({ id: 'work', label: 'our work', anchor: V3(-.27, -.02, -.4) });
  const g = t.group;
  decor.group.add(box(.42, .02, .2, { x: -.29, y: -.22, z: -.4, ...dm }), box(.2, .02, .34, { x: -.4, y: -.22, z: -.13, ...dm }));
  for (const [x, z] of [[-.11, -.31], [-.11, -.49], [-.31, .03], [-.48, .03], [-.48, -.49]]) decor.group.add(box(.018, .27, .018, { x, y: -.365, z, ...dm }));
  const lap = new THREE.Group(); lap.position.set(-.27, -.21, -.39); g.add(lap);
  lap.add(t.bez(.2, .012, .14, { y: .006 }));
  const scr = new THREE.Group(); scr.position.set(0, .012, -.07); scr.rotation.x = -.2; lap.add(scr);
  scr.add(t.bez(.2, .13, .008, { y: .065 }));
  t.surface = surface(t, { cls: 'scr', html: tpl('screen'), w: .18, h: .115, x: 0, y: .065, z: .0045, parent: scr });
  const n = V3(0, Math.sin(.2), Math.cos(.2)), c = V3(-.27, -.21 + .012 + .065 * Math.cos(.2), -.39 - .07 - .065 * Math.sin(.2)).addScaledVector(n, .0045);
  t.fit = () => ({ c, n, w: .18, h: .115, max: 900 });
  const st = new THREE.Group(); st.position.set(-.27, -.5, -.12); decor.group.add(st);
  st.add(cyl(.07, .025, { y: .19, ...dm }));
  for (let i = 0; i < 4; i++) { const a = (i * 90 + 45) * D2R; st.add(cyl(.006, .18, { x: Math.cos(a) * .045, y: .09, z: Math.sin(a) * .045, r2: .004, ...dm })); }
  const pl = new THREE.Group(); pl.position.set(-.45, -.21, -.45); decor.group.add(pl);
  pl.add(cyl(.03, .05, { y: .025, r2: .024, ...dm }));
  const lg = leafGeo(.026, .11);
  for (let i = 0; i < 8; i++) { const leaf = new THREE.Mesh(lg, plantMat); leaf.castShadow = true; leaf.add(edges(lg, decor.edge, 80)); leaf.position.set(0, .048, 0); leaf.rotation.order = 'YXZ'; leaf.rotation.set(-(.5 + (i % 3) * .28), i * 45 * D2R + .2, 0); pl.add(leaf); }
}

/* a floppy and a thumb drive on the near end of the desk → GitHub */
{
  const t = thing({ id: 'github', label: 'GitHub', href: $('#srnav [data-thing=github]').href, ext: true, anchor: V3(-.39, -.13, -.05) });
  const f = new THREE.Group(); f.position.set(-.41, -.21, -.07); f.rotation.y = .25; t.group.add(f);
  const diskGeo = (() => { const q = .045, c = .015, sh = new THREE.Shape(); sh.moveTo(-q, -q); sh.lineTo(q, -q); sh.lineTo(q, q - c); sh.lineTo(q - c, q); sh.lineTo(-q, q); sh.closePath(); return new THREE.ExtrudeGeometry(sh, { depth: .003, bevelEnabled: false }); })();
  f.add(t.pick(mesh(diskGeo, { mat: t.mat, edge: t.edge, rx: -Math.PI / 2 })));                                                   // the disk, one corner cut like the save icon
  f.add(t.bez(.048, .0012, .024, { y: .0036, z: -.03 }), t.box(.006, .0015, .014, { x: .013, y: .0037, z: -.032 }));            // metal shutter with its slot
  f.add(t.bez(.064, .0008, .03, { y: .0034, z: .024 }), t.box(.026, .001, .0022, { x: .009, y: .004, z: .019 }), t.box(.032, .001, .0022, { x: .012, y: .004, z: .027 }));   // label with two lines of "writing"
  const GH = 'M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z';
  const mark = canvasTex(128, 128, (ctx, W) => { ctx.clearRect(0, 0, W, W); ctx.fillStyle = themeColors().fg; ctx.save(); ctx.scale(W / 24, W / 24); ctx.fill(new Path2D(GH)); ctx.restore(); }); t.textures = [mark];
  const badge = new THREE.Mesh(new THREE.PlaneGeometry(.02, .02), new THREE.MeshBasicMaterial({ map: mark, transparent: true })); badge.rotation.x = -Math.PI / 2; badge.position.set(-.02, .0042, .024); f.add(badge);
  const u = new THREE.Group(); u.position.set(-.34, -.21, -.02); u.rotation.y = -.7; t.group.add(u);
  u.add(t.bez(.014, .006, .03, { y: .003 }), t.box(.011, .004, .012, { y: .003, z: .02 }));   // stick + connector
}

/* bookshelf above the desk: a radio, a rolodex → LinkedIn, and a pothos */
{
  const g = decor.group, top = .066;
  g.add(box(.3, .012, .06, { x: -.27, y: .06, z: -.47, ...dz }), box(.012, .04, .05, { x: -.4, y: .034, z: -.475, ...dm }), box(.012, .04, .05, { x: -.14, y: .034, z: -.475, ...dm }));
  { const t = thing({ id: 'radio', label: '♫ play some Nujabes', action: 'radio', anchor: V3(-.36, .135, -.46) });
    const r = new THREE.Group(); r.position.set(-.36, top, -.46); t.group.add(r);
    r.add(t.bez(.07, .04, .036, { y: .02 }));
    for (let i = 0; i < 7; i++) r.add(t.box(.0018, .026, .002, { x: -.027 + i * .005, y: .02, z: .0185 }));   // speaker grille
    r.add(t.pick(cyl(.007, .004, { x: .022, y: .025, z: .019, rx: Math.PI / 2, mat: t.mat, edge: t.edge })), t.box(.002, .006, .001, { x: .022, y: .028, z: .0215 }));   // tuning knob + pointer
    r.add(along(t.cyl(.0012, .066), V3(.03, .04, -.01), V3(.052, .1, -.022), V3(0, 1, 0)));   // antenna
    t.led = new THREE.Mesh(new THREE.BoxGeometry(.003, .003, .002), new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0, roughness: .4 })); t.led.position.set(.022, .01, .0185); r.add(t.led); }
  { const t = thing({ id: 'linkedin', label: 'LinkedIn', href: 'https://linkedin.com/company/eeezco/', ext: true, anchor: V3(-.21, .2, -.455) });
    const r = new THREE.Group(); r.position.set(-.21, top, -.455); t.group.add(r);
    for (const x of [-.032, .032]) r.add(t.bez(.005, .052, .034, { x, y: .026 }));
    r.add(t.bez(.004, .076, .004, { y: .04, rz: Math.PI / 2 }));
    for (const x of [-.043, .043]) r.add(t.pick(cyl(.009, .008, { x, y: .04, rz: Math.PI / 2, mat: t.bezel, edge: t.edge })));
    t.wheel = new THREE.Group(); t.wheel.position.y = .04; r.add(t.wheel);
    t.wheel.add(t.pick(cyl(.012, .05, { rz: Math.PI / 2, mat: t.bezel, edge: t.edge })));
    const N = 22; for (let i = 0; i < N; i++) { const pv = new THREE.Group(); pv.rotation.x = i / N * Math.PI * 2; pv.add(t.box(.044, .026, .0012, { y: .025 })); t.wheel.add(pv); } }
  g.add(cyl(.02, .04, { x: -.135, y: .086, z: -.45, r2: .016, ...dm }), box(.004, .22, .004, { x: -.12, y: -.05, z: -.44, ...dm }));
  for (let i = 0; i < 5; i++) { const leaf = mesh(new THREE.CircleGeometry(.015, 16), { mat: plantMat, edge: decor.edge, threshold: 80 }); leaf.scale.set(.8, 1, 1); leaf.position.set(-.12 + (i % 2 ? .017 : -.017), .045 - i * .04, -.438); leaf.rotation.set(.2, i % 2 ? .35 : -.35, .25); g.add(leaf); }
}

/* kanban on the left wall → start a project */
{
  const t = thing({ id: 'newproject', label: 'start a project', anchor: V3(-.46, .34, -.04) });
  t.group.add(t.bez(.014, .4, .52, { x: -.492, y: .12, z: -.04 }));
  t.surface = surface(t, { cls: 'board', html: tpl('kanban'), w: .5, h: .38, x: -.484, y: .12, z: -.04, ry: Math.PI / 2 });
  t.fit = p => p ? { c: V3(-.484, .12, .1), n: V3(1, 0, 0), w: .19, h: .33, max: 440 } : { c: V3(-.484, .12, -.04), n: V3(1, 0, 0), w: .5, h: .38, max: 1100 };
}

/* whiteboard on the right wall → draw on it (strokes live in localStorage; it's a chalkboard by night) */
const wb = { strokes: [], W: 1040, H: 800 };
try { wb.strokes = JSON.parse(localStorage.getItem('ezco-board') || '[]') || []; } catch {}
wb.save = () => { while (wb.strokes.length > 400) wb.strokes.shift(); try { localStorage.setItem('ezco-board', JSON.stringify(wb.strokes)); } catch {} };
function drawBoard(ctx, W, H) {
  const { bg, fg } = themeColors(); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = fg; ctx.lineWidth = 5; ctx.lineCap = ctx.lineJoin = 'round';
  for (const st of wb.strokes) { ctx.beginPath(); st.forEach(([u, v], i) => i ? ctx.lineTo(u * W, (1 - v) * H) : ctx.moveTo(u * W, (1 - v) * H)); if (st.length === 1) ctx.lineTo(st[0][0] * W + .1, (1 - st[0][1]) * H); ctx.stroke(); }
  if (!wb.strokes.length) { ctx.fillStyle = fg; ctx.globalAlpha = .3; ctx.font = '300 26px Times, serif'; ctx.textAlign = 'right'; ctx.fillText('draw something', W - 34, H - 30); ctx.globalAlpha = 1; }
}
{
  const t = thing({ id: 'whiteboard', label: 'whiteboard', anchor: V3(.46, .37, .1) });
  t.group.add(t.bez(.014, .44, .56, { x: .492, y: .12, z: .1 }), t.bez(.03, .012, .22, { x: .478, y: -.105, z: .1 }));
  t.group.add(cyl(.006, .1, { x: .478, y: -.092, z: .13, rx: Math.PI / 2, ...dz }), box(.04, .022, .06, { x: .478, y: -.088, z: .02, ...dm }));
  t.tex = canvasTex(wb.W, wb.H, drawBoard); t.textures = [t.tex];
  t.plane = new THREE.Mesh(new THREE.PlaneGeometry(.52, .4), new THREE.MeshBasicMaterial({ map: t.tex })); t.plane.position.set(.484, .12, .1); t.plane.rotation.y = -Math.PI / 2; t.group.add(t.pick(t.plane));
  t.fit = () => ({ c: V3(.484, .12, .1), n: V3(-1, 0, 0), w: .52, h: .4, max: 1000 });
  t.clear = () => { wb.strokes = []; t.tex.redraw(); wb.save(); };
}

/* gallery wall (back, right half) → about */
{
  const t = thing({ id: 'about', label: 'about us', anchor: V3(.2, .42, -.48) });
  const g = t.group;
  const photo = { img: null, failed: false };
  const eotm = canvasTex(520, 640, (ctx, W, H) => {
    const { bg, fg } = themeColors(); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const px = 48, py = 44, pw = W - 2 * px, ph = H - 224;
    ctx.strokeStyle = fg; ctx.lineWidth = 3; ctx.strokeRect(px - 7, py - 7, pw + 14, ph + 14);
    if (photo.img) { const r = Math.max(pw / photo.img.width, ph / photo.img.height), sw = pw / r, sh = ph / r; ctx.drawImage(photo.img, (photo.img.width - sw) / 2, (photo.img.height - sh) * FACE, sw, sh, px, py, pw, ph); }
    else { ctx.fillStyle = fg; ctx.globalAlpha = .07; ctx.fillRect(px, py, pw, ph); ctx.globalAlpha = 1; if (photo.failed) drawDog(ctx, px + pw / 2, py + ph * .58, pw * .3, fg); }   // blank while the photo loads: no flash
    const plY = py + ph + 30; ctx.fillStyle = fg; ctx.fillRect(px + 16, plY, pw - 32, 100); ctx.fillStyle = bg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 36px Helvetica, Arial, sans-serif'; ctx.letterSpacing = '8px'; ctx.fillText('LADY', W / 2 + 4, plY + 38);
    ctx.font = '500 15px Helvetica, Arial, sans-serif'; ctx.letterSpacing = '3px'; ctx.fillText('EMPLOYEE OF THE MONTH', W / 2 + 1, plY + 76);
  });
  { const im = new Image(); im.onerror = () => { photo.failed = true; eotm.redraw(); }; im.onload = () => { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, c.width, c.height), q = d.data; for (let i = 0; i < q.length; i += 4) q[i] = q[i + 1] = q[i + 2] = q[i] * .299 + q[i + 1] * .587 + q[i + 2] * .114; x.putImageData(d, 0, 0); photo.img = c; eotm.redraw(); }; im.src = EMPLOYEE_PHOTO; }
  g.add(t.bez(.2, .246, .015, { x: .11, y: .25, z: -.49 }));
  const ph = new THREE.Mesh(new THREE.PlaneGeometry(.18, .222), new THREE.MeshBasicMaterial({ map: eotm })); ph.position.set(.11, .25, -.481); g.add(t.pick(ph));
  t.textures = [eotm];
  const plaque = canvasTex(680, 120, (ctx, W, H) => { const { bg, fg } = themeColors(); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); ctx.strokeStyle = fg; ctx.lineWidth = 4; ctx.strokeRect(2, 2, W - 4, H - 4); ctx.fillStyle = fg; ctx.font = '500 40px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.letterSpacing = '8px'; ctx.fillText('EZ CO · EST. 2025', W / 2, H / 2 + 2); });
  const pl = new THREE.Mesh(new THREE.PlaneGeometry(.15, .027), new THREE.MeshBasicMaterial({ map: plaque })); pl.position.set(.11, .09, -.481); g.add(t.pick(pl)); t.textures.push(plaque);
  g.add(t.bez(.24, .32, .015, { x: .35, y: .18, z: -.49 }));
  t.surface = surface(t, { cls: 'manifesto', html: tpl('manifesto'), w: .22, h: .3, x: .35, y: .18, z: -.481 });
  t.fit = p => p ? { c: V3(.35, .18, -.481), n: V3(0, 0, 1), w: .22, h: .3, max: 440 } : { c: V3(.23, .2, -.481), n: V3(0, 0, 1), w: .5, h: .38, max: 1000 };
}

/* L-couch in the back-right corner, coffee table, tablet → blog */
{
  const g = decor.group;
  g.add(box(.2, .07, .8, { x: .39, y: -.415, z: -.05, ...dm }), box(.06, .2, .8, { x: .455, y: -.28, z: -.05, ...dm }), box(.2, .14, .05, { x: .39, y: -.38, z: .375, ...dm }), box(.2, .14, .05, { x: .39, y: -.38, z: -.475, ...dm }));
  for (const z of [-.3, -.05, .2]) g.add(box(.18, .05, .23, { x: .38, y: -.355, z, ...dm }));
  g.add(box(.26, .07, .2, { x: .16, y: -.415, z: -.35, ...dm }), box(.24, .05, .18, { x: .16, y: -.355, z: -.35, ...dm }));
  for (const [x, z] of [[.31, -.43], [.31, .33], [.05, -.43], [.05, -.27]]) g.add(cyl(.008, .04, { x, y: -.47, z, r2: .005, ...dm }));
  const table = new THREE.Group(); table.position.set(.02, -.5, .1); g.add(table);
  table.add(cyl(.13, .015, { y: .135, ...dm }));
  for (let i = 0; i < 3; i++) { const a = i * 120 * D2R, from = V3(Math.cos(a) * .11, 0, Math.sin(a) * .11), to = V3(Math.cos(a) * .07, .13, Math.sin(a) * .07); table.add(along(cyl(.007, from.distanceTo(to), { r2: .005, ...dm }), from, to, V3(0, 1, 0))); }
  const t = thing({ id: 'blog', label: 'blog', anchor: V3(.02, -.28, .1) });
  const tab = new THREE.Group(); tab.position.set(.02, -.352, .1); tab.rotation.order = 'YXZ'; tab.rotation.set(-Math.PI / 2, .35, 0); t.group.add(tab);
  tab.add(t.bez(.15, .2, .008));
  t.surface = surface(t, { cls: 'reader', html: tpl('reader'), w: .15, h: .2, x: 0, y: 0, z: .0045, parent: tab });
  const rest = { p: V3(.02, -.352, .1), rx: -Math.PI / 2, ry: .35 }, held = { p: V3(.02, -.2, .19), rx: -.9, ry: 0 };
  const place = k => { tab.position.lerpVectors(rest.p, held.p, k); tab.rotation.x = rest.rx + (held.rx - rest.rx) * k; tab.rotation.y = rest.ry + (held.ry - rest.ry) * k; };
  t.present = (on, instant) => instant ? place(on ? 1 : 0) : tween({ from: on ? 0 : 1, to: on ? 1 : 0, dur: 900, update: place });
  const arts = $$('article[data-slug]', t.surface.el), links = $$('.posts a[data-slug]', t.surface.el);
  t.show = slug => { const s = arts.some(a => a.dataset.slug === slug) ? slug : arts[0]?.dataset.slug; for (const a of arts) a.hidden = a.dataset.slug !== s; for (const l of links) l.classList.toggle('on', l.dataset.slug === s); $('.scroller', t.surface.el).scrollTop = 0; };
  t.show();
  const n = V3(0, Math.sin(.9), Math.cos(.9));
  t.fit = () => ({ c: held.p.clone().addScaledVector(n, .0045), n, w: .15, h: .2, max: 640 });
}

/* lamps: a tripod lamp on the side table, a paper lantern by the desk, a cone pendant over the desk */
function lamp(id, name, base, x, y, z, shadows) {
  const t = thing({ id, label: name, action: 'lamp', anchor: V3(x, y + .1, z) });
  t.name = name; t.base = base; t.lit = 0; t.override = typeof lampState[id] === 'boolean' ? lampState[id] : null;
  t.light = pointLight(x, y, z, shadows); lamps.push(t); return t;
}
{
  const t = lamp('tripod', 'table lamp', 1.0, .4, -.22, .445, false);
  decor.group.add(box(.16, .015, .08, { x: .4, y: -.3675, z: .445, ...dm }));
  for (const [x, z] of [[.335, .415], [.465, .415], [.335, .475], [.465, .475]]) decor.group.add(cyl(.006, .125, { x, y: -.4375, z, r2: .004, ...dm }));
  const tri = new THREE.Group(); tri.position.set(.4, -.36, .445); t.group.add(tri);
  tri.add(t.cyl(.042, .008, { y: .004 }));
  for (let i = 0; i < 3; i++) { const a = i * 120 * D2R + .5; tri.add(along(t.box(.006, .006, .115), V3(Math.cos(a) * .036, .008, Math.sin(a) * .036), V3(0, .11, 0))); }
  tri.add(t.cyl(.005, .022, { y: .118 }));
  const shade = mkShade(), bulbM = mkBulb();
  const drum = cyl(.04, .05, { y: .145, r2: .04, open: true, mat: shade, edge: t.edge }); drum.renderOrder = 1; tri.add(t.pick(drum));
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(.012, 20, 12), bulbM); bulb.position.set(0, .141, 0); bulb.renderOrder = 2; tri.add(t.pick(bulb)); const gl2 = glow(0, .141, 0, .16); gl2.renderOrder = 3; tri.add(gl2);
  t.update = (on, day) => { bulbM.emissiveIntensity = 1.6 * on; bulbM.opacity = .35 + .45 * on; shade.emissiveIntensity = .3 * on; shade.color.copy(lerpC(C('#1a1a1a'), C('#e4e4e4'), day)); gl2.material.opacity = on * (.8 - .55 * day); };
}
{
  const t = lamp('lantern', 'paper lantern', .7, -.42, -.43, .14, false);
  const lantern = mesh(new THREE.SphereGeometry(.075, 20, 9), { mat: lanternMat, edge: t.edge, threshold: 12, x: -.42, y: -.43, z: .14 }); lantern.scale.set(1, .85, 1); t.group.add(t.pick(lantern));
  decor.group.add(cyl(.03, .008, { x: -.42, y: -.496, z: .14, ...dm }));
  t.update = (on, day) => { lanternMat.emissiveIntensity = .7 * on; lanternMat.color.copy(lerpC(C('#2a2a2a'), C('#f0f0f0'), day)); };
}
{
  const x = -.3, z = -.38, y = .285, t = lamp('pendant', 'pendant', 1.1, x, y - .04, z, true);
  t.bezel.side = THREE.DoubleSide;
  t.group.add(cyl(.004, .494 - y - .045, { x, y: (.494 + y + .045) / 2, z, ...dm }), cyl(.02, .01, { x, y: .489, z, ...dz }));
  const cone = cyl(.09, .09, { x, y, z, r2: .018, open: true, mat: t.bezel, edge: t.edge }); t.group.add(t.pick(cone));
  const bulbM = mkBulb(), bulb = new THREE.Mesh(new THREE.SphereGeometry(.014, 20, 12), bulbM); bulb.position.set(x, y - .03, z); bulb.renderOrder = 2; t.group.add(t.pick(bulb)); const gl3 = glow(x, y - .035, z, .2); gl3.renderOrder = 3; t.group.add(gl3);
  t.update = (on, day) => { bulbM.emissiveIntensity = 1.6 * on; bulbM.opacity = .35 + .45 * on; gl3.material.opacity = on * (.8 - .55 * day); };
}

/* monstera by the door: stems from the pot to each leaf */
{
  const g = new THREE.Group(); g.position.set(-.43, -.5, .41); decor.group.add(g);
  g.add(cyl(.045, .09, { y: .045, r2: .034, ...dm }));
  const s = .07, lg = new THREE.ShapeGeometry(monsteraShape(s), 12); lg.translate(0, .55 * s, 0);
  const base = V3(0, .09, 0);
  for (let i = 0; i < 5; i++) {
    const a = i * 72 * D2R + .4, end = V3(Math.cos(a) * (.06 + i * .012), .19 + i * .035, Math.sin(a) * (.06 + i * .012)), dir = end.clone().sub(base);
    g.add(alongZ(box(.006, .006, dir.length(), { ...dm }), base, end));
    const leaf = new THREE.Mesh(lg, plantMat); leaf.castShadow = true; leaf.add(edges(lg, decor.edge, 80)); leaf.position.copy(end);
    leaf.quaternion.setFromUnitVectors(Y, dir.clone().normalize()); leaf.rotateY(-a + Math.PI / 2); leaf.rotateX(-.45); g.add(leaf);
  }
}

/* the sign-up clipboard: held in your hands, rises when you look down → come work with us */
const heldTilt = new THREE.Quaternion().setFromAxisAngle(V3(1, 0, 0), -.62);
{
  const t = thing({ id: 'join', label: 'come work with us', anchor: V3() }); t.held = true; t.up = 0; t.forceUp = false; t.frozen = false;
  t.group.add(t.bez(.21, .3, .012), t.box(.06, .025, .02, { y: .14, z: .006 }));
  t.surface = surface(t, { cls: 'sheet', html: tpl('sheet'), w: .17, h: .24, x: 0, y: -.012, z: .0065 });
  t.fit = () => ({ c: V3(0, -.012, .0065).applyQuaternion(t.group.quaternion).add(t.group.position), n: V3(0, 0, 1).applyQuaternion(t.group.quaternion), w: .17, h: .24, max: 560 });
  t.present = on => { t.forceUp = on; t.frozen = on; };
}
function updateHeld() {
  const t = byId.join; if (t.frozen) return;
  const target = t.forceUp ? 1 : (state === 'room' ? clamp((-look.pitch - 11) / 8, 0, 1) : 0);
  t.up += (target - t.up) * .12;
  t.group.position.set(0, -.6 + .35 * t.up, -.46).applyQuaternion(camera.quaternion).add(cam.pos);
  t.group.quaternion.copy(camera.quaternion).multiply(heldTilt);
  t.anchor.copy(t.group.position).addScaledVector(V3(0, 1, 0).applyQuaternion(t.group.quaternion), .17);
}

/* ------------------------------------------------------------------ tweens */
const tweens = [];
function tween(o) { return new Promise(res => { tweens.push({ ...o, t0: performance.now() + (o.delay || 0), dur: reduced ? 1 : o.dur, ease: o.ease || easeInOut, res }); }); }
function runTweens(now) { for (let i = tweens.length - 1; i >= 0; i--) { const t = tweens[i]; if (now < t.t0) continue; const k = clamp((now - t.t0) / t.dur, 0, 1); t.update(t.from + (t.to - t.from) * t.ease(k)); if (k >= 1) { tweens.splice(i, 1); t.res(); } } }

/* ------------------------------------------------------------------ camera */
const cam = { pos: V3(), target: V3() };
let camTween = null;
function poseTo(p, dur) { return new Promise(res => { camTween = { p0: cam.pos.clone(), t0: cam.target.clone(), p1: p.pos.clone(), t1: p.target.clone(), start: performance.now(), dur: reduced ? 1 : dur, res }; }); }
function setPose(p) { camTween = null; cam.pos.copy(p.pos); cam.target.copy(p.target); }
const spherical = (r, az, el, target) => ({ pos: V3(r * Math.cos(el * D2R) * Math.sin(az * D2R), r * Math.sin(el * D2R), r * Math.cos(el * D2R) * Math.cos(az * D2R)).add(target), target: target.clone() });
const POSE = {
  logo: (az = 40, el = 12) => spherical(isPortrait() ? 3.6 : 2.7, az, el, V3(0, -.22, 0)),
  front: () => ({ pos: V3(0, .12, isPortrait() ? 3.4 : 2.7), target: V3(0, -.05, 0) }),
  room: () => ({ pos: V3(0, .05, isPortrait() ? 1.45 : 1.22), target: V3(0, -.1, 0) }),
};
function fitPose(spec) {
  const W = innerWidth, H = innerHeight, aspect = W / H, tanV = Math.tan(camera.fov * D2R / 2), fit = .86;
  const wantPx = Math.min(W * fit, spec.max || 1e9);
  const d = Math.max(spec.w * W / (2 * tanV * aspect * wantPx), spec.h / (2 * tanV * fit));
  const px = spec.w * W / (2 * d * tanV * aspect);
  return { pos: spec.c.clone().addScaledVector(spec.n, d), target: spec.c.clone(), d, px };
}
function layoutSurfaces() { for (const t of things) if (t.fit && t.surface) { const spec = t.fit(isPortrait()), f = fitPose(spec); t.surface.setW(f.px * t.surface.w / spec.w); } }
const look = { yaw: 0, pitch: 0 }, drag = { yaw: 0, pitch: 0 }, glance = { yaw: 0, pitch: 0 }, par = { x: 0, y: 0 };
let parT = { x: 0, y: 0 };
const limits = () => state === 'page' ? { yaw: 6, lo: -4, hi: 4 } : { yaw: 50, lo: -22, hi: 14 };
/* bake the current look offset into the camera pose, so the look can reset to 0 without a jump and tweens start from what you actually see */
function absorbLook() { const d = cam.target.distanceTo(cam.pos); camera.getWorldDirection(fwd); cam.target.copy(cam.pos).addScaledVector(fwd, d); look.yaw = look.pitch = 0; drag.yaw = drag.pitch = glance.yaw = glance.pitch = 0; }

/* ------------------------------------------------------------------ state machine */
let state = 'logo', active = null, busy = false, showLabels = false;
const setState = s => { state = s; body.dataset.state = s; prompts(); document.title = state === 'page' && active ? `${active.label} · ez co` : 'ez co'; };
const doorTo = (a, dur) => tween({ from: doorGroup.rotation.y, to: a, dur, update: v => { doorGroup.rotation.y = v; doorGroupM.rotation.y = v; } });
async function enterRoom() {
  if (state !== 'logo' || busy) return; busy = true; setState('entering'); drag.yaw = drag.pitch = 0;
  await poseTo(POSE.front(), 1000);
  doorTo(-125 * D2R, 900); await delay(reduced ? 0 : 450);
  await poseTo(POSE.room(), 1700);
  mirror.visible = false;
  busy = false; setState('room');
}
async function leaveRoom() {
  if (state === 'logo' || busy) return; busy = true;
  absorbLook();
  if (active) await closePage(true);
  setState('leaving'); mirror.visible = true;
  const p = poseTo(POSE.front(), 1200); await delay(reduced ? 0 : 500); doorTo(0, 900); await p;
  await poseTo(POSE.logo(), 1000);
  busy = false; setState('logo');
}
function present(t, on, instant) { t.active = on; t.surface?.el.classList.toggle('active', on); setInteractive(t, on); t.present?.(on, instant); if (!on) t.onClose?.(); if (on && t.id === 'newproject') armForms(); }
async function openPage(t, sub) {
  if (!t || t.action || t.href) return;
  if (state === 'logo' || state === 'entering') { await enterRoom(); if (state !== 'room') return; }
  if (t.id === 'newproject' && sub) { const sel = q('#np-service'); if ([...sel.options].some(o => o.value === sub)) sel.value = sub; }
  if (t.id === 'blog') t.show(sub);
  if (active === t) return;
  if (active) present(active, false);
  active = t; present(t, true);
  absorbLook();
  setState('page');
  await poseTo(fitPose(t.fit(isPortrait())), 1100);
}
async function closePage(silent) {
  if (!active) return;
  present(active, false); active = null;
  absorbLook();
  if (!silent) { setState('room'); await poseTo(POSE.room(), 1000); }
}
function route() {
  const raw = location.hash.replace(/^#\/?/, ''), [path, q_] = raw.split('?'), [id, sub] = path.split('/').filter(Boolean);
  const params = new URLSearchParams(q_ || '');
  if (!id) { leaveRoom(); return; }
  if (id === 'room') { active ? closePage() : enterRoom(); return; }
  if (byId[id]) openPage(byId[id], sub || params.get('service') || undefined);
}
addEventListener('hashchange', route);
const go = h => { if (location.hash !== h) location.hash = h; else route(); };
const isLit = () => document.documentElement.classList.contains('lit');
const activate = t => { if (!t) return; if (t.action === 'lights') cycleLights(); else if (t.action === 'lamp') toggleLamp(t); else if (t.action === 'radio') radio.toggle(); else if (t.href) open(t.href, '_blank', 'noopener'); else go('#/' + t.id); };
const q = sel => document.querySelector(sel) || surfaces.map(s => s.el.querySelector(sel)).find(Boolean) || null;

/* ------------------------------------------------------------------ prompts (the option bar) */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const chip = (k, txt, act, on) => `<span${act ? ` class="btn${on ? ' on' : ''}" data-act="${act}"` : ''}>${[].concat(k).map(x => `<kbd>${x}</kbd>`).join('<i>/</i>')} ${txt}</span>`;
function prompts() {
  const el = $('#prompts');
  if (state === 'logo') el.innerHTML = chip(['↵', 'scroll'], 'come in', '#/room');
  else if (state === 'room') el.innerHTML = chip('click', 'open') + chip('drag', 'look around') + chip('?', 'labels', 'labels', showLabels) + chip('l', LIGHT_ICON[lights.mode], 'lights') + chip('esc', 'step outside', '#/');
  else if (state === 'page') el.innerHTML = (active?.id === 'whiteboard' ? chip('drag', 'draw') + chip('c', 'clear', 'clear') : '') + (active?.id === 'blog' ? chip('scroll', 'read') : '') + (active && ['newproject', 'join'].includes(active.id) ? chip('tab', 'fields') : '') + chip('esc', 'close', '#/room');
  else el.innerHTML = '';
}
$('#prompts').addEventListener('click', e => { const b = e.target.closest('.btn'); if (!b) return; const a = b.dataset.act; if (a === 'lights') cycleLights(); else if (a === 'labels') toggleLabels(); else if (a === 'clear') byId.whiteboard.clear(); else go(a); });
function toggleLabels() { showLabels = !showLabels; prompts(); }

/* ------------------------------------------------------------------ day / night */
/* auto follows the system colour scheme; day and night are explicit, and remembered */
const prefersDark = matchMedia('(prefers-color-scheme: dark)');
const lights = { mode: 'auto' };
try { localStorage.removeItem('ezco-lit'); const m = localStorage.getItem('ezco-lights'); if (['auto', 'day', 'night'].includes(m)) lights.mode = m; } catch {}
const DIAL = { night: .95, auto: 0, day: -.95 };
/* the three settings as inline SVG (a text sun renders as a star in Safari's fallback font) */
const svg = inner => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const LIGHT_ICON = {
  day: svg('<circle cx="12" cy="12" r="4" fill="currentColor"/>' + [0, 45, 90, 135, 180, 225, 270, 315].map(a => { const r = a * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r); return `<line x1="${(12 + 6.8 * c).toFixed(2)}" y1="${(12 + 6.8 * sn).toFixed(2)}" x2="${(12 + 9.6 * c).toFixed(2)}" y2="${(12 + 9.6 * sn).toFixed(2)}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`; }).join('')),
  night: svg('<path d="M14.8 3.2a8.8 8.8 0 1 0 6 15.6 7.4 7.4 0 0 1-6-15.6z" fill="currentColor"/>'),
  auto: svg('<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 3.6a8.4 8.4 0 0 0 0 16.8z" fill="currentColor"/>'),
};   // knob angle: night at eleven, auto at noon, day at one
function setLights(mode, instant) {
  lights.mode = mode; try { localStorage.setItem('ezco-lights', mode); } catch {}
  const on = mode === 'auto' ? !prefersDark.matches : mode === 'day';
  document.documentElement.classList.toggle('lit', on); themeTarget = on ? 1 : 0;
  const t = byId.lights; t.label = `lights: ${mode}`; if (t.lbl) { t.lbl.innerHTML = LIGHT_ICON[mode]; t.lbl.title = t.label; } $('#srlights').textContent = `lights: ${mode}` + (mode === 'auto' ? ` (${on ? 'day' : 'night'})` : '');
  if (instant) t.knob.rotation.x = DIAL[mode]; else tween({ from: t.knob.rotation.x, to: DIAL[mode], dur: 220, update: v => { t.knob.rotation.x = v; } });
  refreshLamps(); prompts();
}
const cycleLights = () => setLights({ auto: 'day', day: 'night', night: 'auto' }[lights.mode]);
prefersDark.addEventListener('change', () => { if (lights.mode === 'auto') setLights('auto'); }, { signal });
const lampOn = l => l.override ?? !isLit();   // default: on at night, off by day
function toggleLamp(l) {
  const next = !lampOn(l); l.override = next === !isLit() ? null : next;   // back at the default → follows day / night again
  lampState[l.id] = l.override; try { localStorage.setItem('ezco-lamps', JSON.stringify(lampState)); } catch {}
  refreshLamps();
}
const BULB = on => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 21h5M10 18h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1.1 1.9V16h4.8v-.2c.1-.8.5-1.5 1.1-1.9A6 6 0 0 0 12 3z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
function refreshLamps() { for (const l of lamps) { const on = lampOn(l); l.label = (on ? 'turn off the ' : 'turn on the ') + l.name; if (l.lbl) { l.lbl.innerHTML = BULB(on); l.lbl.title = l.label; } const b = $(`#srnav [data-thing="${l.id}"]`); if (b) b.textContent = l.label; } }
let themeDrawn = -1;
function applyTheme(t) {
  const N = THEMES.night, D = THEMES.day, col = k => lerpC(C(N[k]), C(D[k]), t), num = k => N[k] + (D[k] - N[k]) * t;
  reg.wall.forEach(m => m.color.copy(col('wall'))); reg.floor.forEach(m => m.color.copy(col('floor'))); reg.rug.forEach(m => m.color.copy(col('rug')));
  const edgeC = col('edge'), objC = col('obj'), bezC = col('bezel');
  reg.edge.forEach(m => { m.color.copy(edgeC); m.opacity = num('edgeA'); });
  for (const th of reg.things) { th.mat.color.copy(th.isBezel ? bezC : objC).lerp(edgeC, th.hover); th.bezel.color.copy(bezC).lerp(edgeC, th.hover); th.edge.color.copy(edgeC).lerp(objC, th.hover); }
  hemi.intensity = num('hemi'); hemi.groundColor.copy(col('ground')); sun.intensity = num('sun'); moon.intensity = num('moon');
  for (const l of lamps) { l.light.intensity = l.base * l.lit * (1 - .6 * t) * K * K; l.update(l.lit, t); }   // lamps do little by day
  scene.background.copy(col('bg')); scene.fog.color.copy(col('bg')); glassMat.color.copy(col('glass')); glassMat.opacity = .1 - .04 * t; frameMat.color.copy(bezC); frameEdge.color.copy(edgeC); plantMat.color.copy(col('plant')); 
  grid.material.opacity = num('grid'); grid.material.color.copy(edgeC); ground.material.color.copy(edgeC);
  extMat.color.copy(col('bg'));
  const bucket = t < .5 ? 0 : 1;
  if (bucket !== themeDrawn) { themeDrawn = bucket; for (const th of things) th.textures?.forEach(x => x.redraw()); logoTex.ez.redraw(); logoTex.co.redraw(); }
}

/* ------------------------------------------------------------------ hover, labels, picking */
const labelsEl = $('#labels');
for (const t of things) if (t.id) {
  const l = document.createElement('span'); l.className = 'lbl' + (t.action ? ' action' : '') + (t.ext ? ' ext' : ''); l.textContent = t.label; labelsEl.appendChild(l); t.lbl = l;
  l.addEventListener('click', () => { if (state === 'room') activate(t); }); l.addEventListener('pointerenter', () => setHover(t)); l.addEventListener('pointerleave', () => setHover(null));
}
let hovered = null;
function setHover(t) { if (hovered === t) return; hovered = t; body.classList.toggle('hover', !!t && state === 'room'); if (t?.id === 'radio') radio.warm(); }   // warming the player on hover keeps the eventual click synchronous, which Safari's autoplay rules want
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
  if (state === 'logo') { logoHot = ray.intersectObjects([shell, door], false).length > 0; body.classList.toggle('hover', logoHot); return null; }
  if (state !== 'room') return null;
  const h = ray.intersectObjects(pickables, false); return h.length ? h[0].object.userData.thing : null;
}
let dragging = null, dragMoved = false;
addEventListener('pointermove', e => {
  if (e.pointerType !== 'touch') parT = { x: (e.clientX / innerWidth) * 2 - 1, y: (e.clientY / innerHeight) * 2 - 1 };
  if (dragging && e.pointerId === dragging.id) {
    const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
    if (!dragMoved && Math.hypot(dx, dy) > 6) { dragMoved = true; body.classList.add('dragging'); }
    if (dragMoved) { const lim = limits(); drag.yaw = clamp(dragging.yaw + dx * .22, -lim.yaw, lim.yaw); drag.pitch = clamp(dragging.pitch + dy * .16, lim.lo, lim.hi); }
    return;
  }
  if (wbDraw && e.pointerId === wbDraw.id) { const uv = wbHit(e); if (uv) wbAdd(uv); return; }
  if (e.target === gl.domElement) setHover(pick(e));
}, { passive: true });
/* drag to look from anywhere that isn't an open page's controls */
addEventListener('pointerdown', e => {
  if (state === 'logo' || focusLock || e.button > 0 || e.target.closest('.surface.active, a, button, input, select, textarea, label, .prompts, .sr-nav, .lbl, .ctl')) return;
  if (state === 'page' && active?.id === 'whiteboard' && e.target === gl.domElement) { const uv = wbHit(e); if (uv) { wbDraw = { id: e.pointerId, stroke: [] }; wb.strokes.push(wbDraw.stroke); if (wb.strokes.length === 1) byId.whiteboard.tex.redraw(); wbAdd(uv); } return; }
  dragging = { x: e.clientX, y: e.clientY, yaw: drag.yaw, pitch: drag.pitch, id: e.pointerId }; dragMoved = false;
});
const endDrag = () => { dragging = null; body.classList.remove('dragging'); if (wbDraw) { wbDraw = null; wb.save(); } setTimeout(() => { dragMoved = false; }, 0); };
/* whiteboard: strokes in board uv space, drawn straight onto the texture canvas as you go */
let wbDraw = null;
function wbHit(e) { ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera); const h = ray.intersectObject(byId.whiteboard.plane, false); return h.length ? [+h[0].uv.x.toFixed(4), +h[0].uv.y.toFixed(4)] : null; }
function wbAdd(uv) {
  const st = wbDraw.stroke, last = st[st.length - 1]; if (last && Math.hypot((uv[0] - last[0]) * wb.W, (uv[1] - last[1]) * wb.H) < 1.5) return; st.push(uv);
  const tex = byId.whiteboard.tex, ctx = tex.image.getContext('2d'), a = last || uv; ctx.strokeStyle = themeColors().fg; ctx.lineWidth = 5; ctx.lineCap = ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(a[0] * wb.W, (1 - a[1]) * wb.H); ctx.lineTo(uv[0] * wb.W + (last ? 0 : .1), (1 - uv[1]) * wb.H); ctx.stroke(); tex.needsUpdate = true;
}
addEventListener('pointerup', endDrag); addEventListener('pointercancel', endDrag);
gl.domElement.addEventListener('click', e => {
  if (dragMoved) return;
  if (state === 'logo') { pick(e); if (logoHot) go('#/room'); return; }
  if (state === 'room') { const t = pick(e); if (t) activate(t); }
});
gl.domElement.addEventListener('pointerleave', () => { setHover(null); logoHot = false; });
addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select')) return;
  if (e.key === 'Escape') { if (state === 'page') go('#/room'); else if (state === 'room') go('#/'); return; }
  if (state === 'logo' && (e.key === 'Enter' || e.key === 'ArrowDown')) { go('#/room'); return; }
  if ((e.key === 'l' || e.key === 'L') && state !== 'logo') { cycleLights(); return; }
  if (['?', '/', 'i', 'I'].includes(e.key) && state === 'room') { toggleLabels(); return; }
  if ((e.key === 'c' || e.key === 'C') && state === 'page' && active?.id === 'whiteboard') { byId.whiteboard.clear(); return; }
  if (state === 'room') { if (e.key === 'ArrowLeft') drag.yaw += 12; if (e.key === 'ArrowRight') drag.yaw -= 12; if (e.key === 'ArrowUp') drag.pitch += 8; if (e.key === 'ArrowDown') drag.pitch -= 8; }
});
addEventListener('wheel', e => { if (state === 'logo' && e.deltaY > 20) go('#/room'); }, { passive: true });
$$('#srnav [data-thing]').forEach(a => {
  const t = byId[a.dataset.thing];
  a.addEventListener('focus', () => { if (state !== 'room' || !t) return; if (t.held) { t.forceUp = true; glance.yaw = 0; glance.pitch = -22; } else glanceAt(t); setHover(t); });
  a.addEventListener('blur', () => { glance.yaw = glance.pitch = 0; setHover(null); if (t?.held && !t.active) t.forceUp = false; });
  if (a.tagName === 'BUTTON') a.addEventListener('click', () => activate(t));
});
function glanceAt(t) { const d = t.anchor.clone().sub(cam.pos); glance.yaw = clamp(-Math.atan2(d.x, -d.z) / D2R * .7, -32, 32); glance.pitch = clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)) / D2R * .6, -14, 14); }
/* hand-rolled scrolling for the clipped page surfaces */
for (const el of surfaces.flatMap(s => $$('.scroller', s.el))) {
  el.tabIndex = 0;
  const by = d => { el.scrollTop = clamp(el.scrollTop + d, 0, el.scrollHeight - el.clientHeight); };
  el.addEventListener('wheel', e => { e.preventDefault(); e.stopPropagation(); by(e.deltaY); }, { passive: false });
  let ty = null; el.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') ty = e.clientY; });
  el.addEventListener('pointermove', e => { if (ty !== null && e.pointerType === 'touch') { by(ty - e.clientY); ty = e.clientY; e.stopPropagation(); } });
  el.addEventListener('pointerup', () => { ty = null; }); el.addEventListener('pointercancel', () => { ty = null; });
  el.addEventListener('keydown', e => { if (e.target.matches('input,textarea,select')) return; const h = el.clientHeight, d = { ArrowDown: 40, ArrowUp: -40, PageDown: h * .9, PageUp: -h * .9, ' ': h * .9, End: 1e6, Home: -1e6 }[e.key]; if (d !== undefined) { e.preventDefault(); e.stopPropagation(); by(d); } });
}
for (const t of things) if (t.id) setInteractive(t, false);
/* the radio: audio only, from a hidden player behind the wall */
/* once the radio has been touched, a ⏮ ⏸ ⏭ bar stands where its label was and stays as long as the radio is on;
   the track name lives in the buttons' tooltips and the screen-reader text */
const ctl = document.createElement('span'); ctl.className = 'ctl'; ctl.innerHTML = '<button data-act="prev" aria-label="previous track" tabindex="-1">⏮\uFE0E</button><button data-act="toggle" aria-label="pause" tabindex="-1">⏸\uFE0E</button><button data-act="next" aria-label="next track" tabindex="-1">⏭\uFE0E</button>';
root.appendChild(ctl);   // after the accessible page list (every control in the room carries an explicit tabindex: Safari's plain Tab only visits form fields and elements that have one), so once the radio is on, Tab reaches ⏮ ⏸ ⏭ right after "play the radio"; until then they're out of the tab order
ctl.addEventListener('click', e => { const b = e.target.closest('button'); if (b) radio[b.dataset.act](); });
let ctlHover = false, ctlFocus = false, ctlSeen = -1e9;
ctl.addEventListener('pointerenter', () => { ctlHover = true; }); ctl.addEventListener('pointerleave', () => { ctlHover = false; });
ctl.addEventListener('focusin', () => { ctlFocus = true; });   // keeps the bar up while a button has focus; the camera stays put
ctl.addEventListener('focusout', e => { if (!ctl.contains(e.relatedTarget)) ctlFocus = false; });
radio.on(st => {
  const title = radio.title() || 'Nujabes', b = $('#srnav [data-thing=radio]'), tip = st === 'loading' ? 'tuning…' : '♪ ' + title;
  for (const x of $$('button', ctl)) { x.title = tip; x.tabIndex = st === 'off' ? -1 : 0; }
  const tg = $('[data-act=toggle]', ctl); tg.textContent = radio.playing ? '⏸\uFE0E' : '▶\uFE0E'; tg.setAttribute('aria-label', radio.playing ? 'pause' : 'play');
  if (b) b.textContent = st === 'off' ? 'play the radio' : (radio.playing ? 'pause the radio · ' : 'play the radio · ') + title;
});
/* the laptop's little OS: programs on a desktop, windows for the demos and the new-project dialog */
let openWin, clockTimer, focusLock = false, placeFloating = () => {}, bounce = () => {};
{
  const scr = byId.work.surface.el, wins = $$('.win', scr);
  /* editors measure themselves with getBoundingClientRect, which a perspective transform confuses; so a demo window is lifted out of the
     3D plane into a fixed overlay sized from a hidden placeholder that stays in the OS, and the camera holds still while it is open */
  const os = $('.os', scr), overlay = document.createElement('div'); overlay.className = 'overlay'; root.appendChild(overlay);
  const ph = document.createElement('div'); ph.className = 'win wide ph'; ph.hidden = true; os.appendChild(ph);
  let floating = null;
  const closeWins = () => { if (floating) { os.appendChild(floating); floating.style.cssText = ''; floating = null; } ph.hidden = true; focusLock = false; wins.forEach(w => { w.hidden = true; }); destroyDemos(); };
  openWin = id => { closeWins(); const w = wins.find(w => w.dataset.win === id); if (!w || !byId.work.active) return; w.hidden = false;
    if (w.dataset.demo) { floating = w; overlay.appendChild(w); ph.hidden = false; focusLock = true; placeFloating(); mountDemo(w.dataset.demo, $('.demo', w)); }
    else { armForms(); $('input, button', w)?.focus(); } };
  placeFloating = () => { if (!floating) return; const r = ph.getBoundingClientRect(); floating.style.cssText = `left:${r.left.toFixed(1)}px;top:${r.top.toFixed(1)}px;width:${r.width.toFixed(1)}px;height:${r.height.toFixed(1)}px`; };
  for (const b of $$('.app', scr)) b.addEventListener('click', () => { if (!byId.work.active) { activate(byId.work); return; } if (b.dataset.href) open(b.dataset.href, '_blank', 'noopener'); else openWin(b.dataset.app); });
  for (const b of $$('[data-close]', scr)) b.addEventListener('click', closeWins);
  /* the lock screen logo bounces like the DVD one: linear, exact reflections, and — with 13 s per width and 8 s per height —
     it lands exactly in a corner every 104 s (first time ~74 s in) */
  const saver = $('.saver', scr), mlogo = $('.mlogo', scr), tri = u => { const f = u % 2; return f < 1 ? f : 2 - f; };
  bounce = now => { if (scr.classList.contains('awake') || byId.work.active) return; const W = saver.clientWidth - mlogo.offsetWidth, H = saver.clientHeight - mlogo.offsetHeight; if (W <= 0 || H <= 0) return; const t = now / 1000 + 30; mlogo.style.transform = `translate(${(tri(t / 13) * W).toFixed(1)}px,${(tri(t / 8) * H).toFixed(1)}px)`; };
  const clocks = $$('[data-clock]', scr), tick = () => { const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); for (const c of clocks) c.textContent = t; }; tick(); clockTimer = setInterval(tick, 15000);
  byId.work.onClose = closeWins;
}
/* a new project from either form lands on the kanban's ideas column */
const stick = (name, service, msg) => { const f = q('#np-form'); $('.stuckText', f).innerHTML = `${msg.length > 90 ? msg.slice(0, 90) + '…' : msg}<small>${name} · ${service.replace('-', ' ')}</small>`; f.classList.add('stuck'); };
for (const f of surfaces.flatMap(s => $$('form.np', s.el))) f.addEventListener('submit', async e => {
  e.preventDefault(); if (f.classList.contains('busy')) return;
  const el = f.elements, data = { name: el.name.value.trim(), email: el.email.value.trim(), service: el.service.value, message: el.message.value.trim() };
  if (el.budget.value) data.budget = Number(el.budget.value);
  f.classList.add('busy'); f.classList.remove('failed');
  const r = await submitProject(data, turnstile.token(f), opts.api);
  f.classList.remove('busy');
  if (!r.ok) { $('.err', f).textContent = r.error; f.classList.add('failed'); turnstile.reset(f); return; }
  stick(data.name || 'someone', data.service, data.message); if (f.id !== 'np-form') f.classList.add('sent');
});
/* the captcha loads the first time a project form is on screen */
function armForms() { for (const f of surfaces.flatMap(s => $$('form.np', s.el))) if (f.closest('.surface.active') && !f.closest('[hidden]')) turnstile.mount(f, opts.turnstileSiteKey, isLit()); }
q('#join-form').addEventListener('submit', e => { e.preventDefault(); e.target.classList.add('sent'); });

/* ------------------------------------------------------------------ frame loop */
const fwd = V3(), tmp = V3(), nrm = V3(), toCam = V3(), wp = V3(), qt = new THREE.Quaternion(), occluders = [shell, door];
let firstFrame = true;
function frame(now) {
  if (disposed) return;
  requestAnimationFrame(frame);
  if (firstFrame) { firstFrame = false; $('#loading').classList.add('off'); setTimeout(() => body.classList.remove('preload'), 400); }
  runTweens(now);
  if (camTween) { const k = clamp((now - camTween.start) / camTween.dur, 0, 1), e = easeInOut(k); cam.pos.lerpVectors(camTween.p0, camTween.p1, e); cam.target.lerpVectors(camTween.t0, camTween.t1, e); if (k >= 1) { const r = camTween.res; camTween = null; r(); } }
  par.x += (parT.x - par.x) * .06; par.y += (parT.y - par.y) * .06;
  if (state === 'logo' && !camTween) cam.pos.lerp(POSE.logo(40 + par.x * 8, 12 - par.y * 5).pos, .08);
  logoT += ((logoHot ? 1 : 0) - logoT) * .12;
  if (Math.abs(logoT - logoDrawn) > .01) { logoDrawn = logoT; logoTex.ez.redraw(); logoTex.co.redraw(); }
  const lim = limits(), k = state === 'room' ? [4, 2.5] : state === 'page' && !focusLock ? [1.2, .8] : [0, 0];
  const inside = state === 'room' || state === 'page';
  const tYaw = inside ? clamp(drag.yaw, -lim.yaw, lim.yaw) + glance.yaw - par.x * k[0] : 0, tPitch = inside ? clamp(drag.pitch, lim.lo, lim.hi) + glance.pitch - par.y * k[1] : 0;
  look.yaw += (tYaw - look.yaw) * .1; look.pitch += (tPitch - look.pitch) * .1;
  camera.position.copy(cam.pos).multiplyScalar(K); camera.lookAt(tmp.copy(cam.target).multiplyScalar(K));
  camera.rotateOnWorldAxis(Y, look.yaw * D2R); camera.rotateX(look.pitch * D2R); camera.updateMatrixWorld();
  updateHeld(); byId.join.group.updateMatrixWorld();
  themeT += (themeTarget - themeT) * .08;
  for (const t of things) if (t.id) { const goal = (hovered === t && !t.active) ? 1 : 0; t.hover += (goal - t.hover) * .18; }
  for (const l of lamps) l.lit += ((lampOn(l) ? 1 : 0) - l.lit) * .1;
  byId.linkedin.wheel.rotation.x -= .07 * byId.linkedin.hover;
  byId.work.surface.el.classList.toggle('awake', hovered === byId.work);
  byId.radio.led.material.emissiveIntensity += ((radio.playing ? 1.2 : 0) - byId.radio.led.material.emissiveIntensity) * .1;
  applyTheme(themeT);
  camera.getWorldDirection(fwd);
  for (const s of surfaces) {
    s.obj.getWorldPosition(wp); nrm.set(0, 0, 1).applyQuaternion(s.obj.getWorldQuaternion(qt)); toCam.copy(camera.position).sub(wp);
    let vis = nrm.dot(toCam) > 0 && fwd.dot(tmp.copy(wp).sub(camera.position)) > 0 && (state === 'room' || state === 'page' || doorGroup.rotation.y < -.4);
    if (vis) { const dist = toCam.length(); ray.set(camera.position, tmp.copy(wp).sub(camera.position).normalize()); ray.far = dist; vis = !ray.intersectObjects(occluders, false).some(h => !(h.object === shell && h.face.materialIndex === 4)); ray.far = Infinity; }
    s.obj.visible = vis;
  }
  if (state === 'room' && radio.state !== 'off' && (hovered === byId.radio || ctlHover || ctlFocus || showLabels)) ctlSeen = now;
  const ctlOn = state === 'room' && radio.state !== 'off' && now - ctlSeen < 350;   // a short grace so the pointer can travel from the radio to the bar
  for (const t of things) if (t.id) { const on = state === 'room' && (hovered === t || showLabels) && !(t.held && t.up < .5) && !(t.id === 'radio' && ctlOn); if (on) { tmp.copy(t.anchor).multiplyScalar(K).project(camera); t.lbl.style.transform = `translate(${((tmp.x + 1) / 2 * innerWidth).toFixed(1)}px,${((1 - tmp.y) / 2 * innerHeight).toFixed(1)}px)`; t.lbl.classList.toggle('on', tmp.z < 1); } else t.lbl.classList.remove('on'); }
  if (ctlOn) { tmp.copy(byId.radio.anchor).multiplyScalar(K).project(camera); ctl.style.transform = `translate(${((tmp.x + 1) / 2 * innerWidth).toFixed(1)}px,${((1 - tmp.y) / 2 * innerHeight).toFixed(1)}px)`; ctl.classList.toggle('on', tmp.z < 1); } else ctl.classList.remove('on');
  gl.render(scene, camera); css.render(scene, camera); placeFloating(); bounce(now);
}

/* ------------------------------------------------------------------ sizing, boot */
function resize() {
  const W = innerWidth, H = innerHeight; camera.aspect = W / H; camera.updateProjectionMatrix(); gl.setSize(W, H); css.setSize(W, H); layoutSurfaces();
  if (active) setPose(fitPose(active.fit(isPortrait()))); else if (state === 'room') setPose(POSE.room()); else if (state === 'logo') setPose(POSE.logo());
}
addEventListener('resize', resize);
if (dbg.has('lit')) lights.mode = 'day'; if (dbg.has('dark')) lights.mode = 'night';
setLights(lights.mode, true); themeT = themeTarget; for (const l of lamps) l.lit = lampOn(l) ? 1 : 0;
resize(); setPose(POSE.logo()); applyTheme(themeT);
if (dbg.has('look')) { const [y, p = 0] = dbg.get('look').split(',').map(Number); drag.yaw = y; drag.pitch = p; look.yaw = y; look.pitch = p; }
if (dbg.has('labels')) showLabels = true;
if (dbg.has('up')) byId.join.up = 1;
{
  const raw = location.hash.replace(/^#\/?/, ''), [path] = raw.split('?'), [id] = path.split('/').filter(Boolean);
  if (id) { doorGroup.rotation.y = doorGroupM.rotation.y = -125 * D2R; mirror.visible = false; state = 'room'; body.dataset.state = 'room'; setPose(POSE.room()); }
  if (byId[id] && !byId[id].action && !byId[id].href) { const t = byId[id]; active = t; present(t, true, true); state = 'page'; body.dataset.state = 'page'; setPose(fitPose(t.fit(isPortrait()))); }
  if (dbg.has('hover') && byId[dbg.get('hover')]) setHover(byId[dbg.get('hover')]);
  if (dbg.has('win')) openWin(dbg.get('win'));
  if (dbg.has('debug')) window.room = { look, drag, glance, cam, lamps, wb, byId, camera, radio, dir: () => camera.getWorldDirection(V3()).toArray(), openWin: id => openWin(id), get state() { return state; }, get active() { return active; }, get focusLock() { return focusLock; } };
  prompts();
}
requestAnimationFrame(frame);
return function dispose() { disposed = true; ac.abort(); clearInterval(clockTimer); destroyDemos(); radio.dispose(); gl.dispose(); gl.domElement.remove(); css.domElement.remove(); root.querySelector('.overlay')?.remove(); delete document.body.dataset.state; document.body.classList.remove('preload', 'hover', 'dragging'); document.documentElement.classList.remove('lit'); };
}
