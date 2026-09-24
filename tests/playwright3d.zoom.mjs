// tests/playwright3d.zoom.mjs -- measures the 3D mouse-wheel zoom ladder in a real browser:
// per-notch ladder state, per-frame FOV / camera path of every transition (monotonic, settle
// time), aim continuity, vertical aim screen rate per zoom state, Shift/wheel mixes, bursts,
// touchpad deltas, event capture (HUD, no pointer lock) and non-capture (menu, pause, map,
// results), reset on restart. Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 5196   then   URL3D=http://localhost:5196/index-3d.html node tests/playwright3d.zoom.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const f1 = (x) => Math.round(x * 10) / 10, f3 = (x) => Math.round(x * 1000) / 1000;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
// Worst case for capture: pointer lock never engages (no lock -> events target HUD elements).
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const frames = (n = 2) => ev(n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const Z = () => ev(() => window.__zoom3d());
const shot = async name => {
   await ev(() => window.__setRender?.(true));
   await frames(4);
   await page.screenshot({ path: `${OUT}/3d-zoom-${name}.png` });
   await ev(() => window.__setRender?.(false));
};
async function waitFor(fn, timeout = 8000, step = 50) {
   const t0 = Date.now();
   while (Date.now() - t0 < timeout) { if (await ev(fn)) return true; await wait(step); }
   return false;
}
// synthetic wheel on window (or an element); returns whether the page prevented the default
const wheelEv = (deltaY, deltaMode = 0, sel = null) => ev(([dy, dm, sel]) => {
   const t = sel ? document.querySelector(sel) || document.querySelector(sel.split(' ')[0]) : window;
   const e = new WheelEvent('wheel', { deltaY: dy, deltaMode: dm, bubbles: true, cancelable: true });
   t.dispatchEvent(e);
   return e.defaultPrevented;
}, [deltaY, deltaMode, sel]);
const notch = async (dir, n = 1) => { for (let i = 0; i < n; i++) { await page.mouse.wheel(0, dir * 100); await frames(1); } };
const settled = () => waitFor(() => { const z = window.__zoom3d(); return Math.abs(z.dist - z.distTarget) < 1e-9 && (z.bino ? z.scopeT >= 1 : z.scopeT <= 0) && Math.abs(Math.tan(z.fov * Math.PI / 360) - Math.tan(55 * Math.PI / 360) / (z.bino ? z.zoom : 1)) < 1e-4; }, 8000, 30);

// ------------------------------------------------------------------ start
await page.goto(URL, { waitUntil: 'load' });
await wait(1000);
// menu: the wheel is not taken
{
   const prevented = await wheelEv(-100, 0, '#menu .card');
   check('menu: wheel not hijacked (default kept)', prevented === false);
   // the port screen's scrolling element (if its content overflows at this size)
   const sc = await ev(() => {
      for (const el of [document.getElementById('menu'), ...document.querySelectorAll('#menu *')]) {
         const o = getComputedStyle(el).overflowY;
         if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 4) { el.setAttribute('data-zscroll', '1'); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
      }
      return null;
   });
   if (sc) {
      await page.mouse.move(sc.x, sc.y);
      for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 200); await wait(300); }
      const top = await ev(() => Math.max(0, ...[...document.querySelectorAll('#menu, #menu *')].map(e => e.scrollTop)));
      check('menu: port screen still scrolls natively', top > 0, { top });
      await ev(() => { for (const e of document.querySelectorAll('#menu, #menu *')) e.scrollTop = 0; });
   } else console.log('info port screen does not overflow at this size; native scroll not exercised');
}
await ev(() => window.__start({ difficulty: 'normal', ship: 'Hipper' }));
check('game starts', await waitFor(() => window.__phase() === 'playing'));
await ev(() => { setInterval(() => { for (const s of window.__world()?.ships || []) if (s.alive && s.maxHP) s.hp = s.maxHP; }, 50); });
await ev(() => window.__setRender?.(false));
// aim over open water to port-forward at 9 km, so no ship snap changes the solution
await ev(() => window.__setAim(-0.6, 9000));
await frames(10);
await page.mouse.move(720, 405);
const z0 = await Z();
console.log('default', { level: z0.level, tp: z0.tp, dist: f1(z0.dist), bino: z0.bino, zoom: z0.zoom, fov: f1(z0.fov) });
check('pointer lock is off in this run', await ev(() => document.pointerLockElement === null));

// per-frame recorder (runs after the game's frame each rAF)
await ev(() => {
   window.__rec = { on: false, rows: [] };
   const loop = () => {
      requestAnimationFrame(loop);
      const r = window.__rec; if (!r.on) return;
      const z = window.__zoom3d(), a = window.__aim(), p = window.__world()?.player;
      const cy = Math.cos(a.yaw), sy = Math.sin(a.yaw);
      r.rows.push({ t: performance.now(), fov: z.fov, dist: z.dist, bino: z.bino, zoom: z.zoom, level: z.level, s: z.scopeT,
         along: (z.cam.x - p.pos.x) * cy + (z.cam.z - p.pos.y) * sy, h: z.cam.y, yaw: a.yaw, range: a.range, ty: a.targetYaw, tr: a.targetRange });
   };
   requestAnimationFrame(loop);
});
const recStart = () => ev(() => { window.__rec.rows = []; window.__rec.on = true; });
const recStop = () => ev(() => { window.__rec.on = false; return window.__rec.rows; });

function monotonic(xs, tol) {
   let dir = 0;
   for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (Math.abs(d) <= tol) continue;
      const s = Math.sign(d);
      if (dir && s !== dir) return false;
      dir = s;
   }
   return true;
}
function settleTime(rows, key, tol, t0) {
   const fin = rows[rows.length - 1][key];
   let last = t0;
   for (const r of rows) if (Math.abs(r[key] - fin) > tol) last = r.t;
   return (last - t0) / 1000;
}
function maxStep(rows, key) { let m = 0; for (let i = 1; i < rows.length; i++) m = Math.max(m, Math.abs(rows[i][key] - rows[i - 1][key])); return m; }

// ------------------------------------------------------------------ ladder sweep with per-frame traces
const sweep = [];
let allMono = true, maxSettle = 0, aimOk = true;
async function traceNotch(dir, label) {
   const before = await ev(() => { const a = window.__aim(); return { yaw: a.yaw, range: a.range, ty: a.targetYaw, tr: a.targetRange, flight: a.flight, snapped: a.snapped }; });
   await recStart();
   const t0 = await ev(() => performance.now());
   await page.mouse.wheel(0, dir * 100);
   await wait(600); await frames(3);
   const rows = (await recStop()).filter(r => r.t >= t0);
   const z = await Z();
   const after = await ev(() => { const a = window.__aim(); return { yaw: a.yaw, range: a.range, ty: a.targetYaw, tr: a.targetRange, flight: a.flight, snapped: a.snapped }; });
   // camera coordinates are relative to the SIM ship position while the rig uses the interpolated
   // one: up to ~0.4 m of frame noise at speed, hence the 0.6 m tolerance there
   const mono = monotonic(rows.map(r => r.fov), 1e-6) && monotonic(rows.map(r => r.along), 0.6) && monotonic(rows.map(r => r.h), 0.6) && monotonic(rows.map(r => r.dist), 1e-6);
   const arm = Math.hypot(rows[rows.length - 1].along, rows[rows.length - 1].h);
   const st = Math.max(settleTime(rows, 'fov', 0.005 * rows[rows.length - 1].fov, t0), settleTime(rows, 'along', Math.max(0.6, 0.005 * arm), t0), settleTime(rows, 'h', Math.max(0.6, 0.005 * arm), t0));
   const dAim = { dyaw: Math.abs(after.yaw - before.yaw), drange: Math.abs(after.range - before.range), dty: Math.abs(after.ty - before.ty), dtr: Math.abs(after.tr - before.tr), dflight: Math.abs(after.flight - before.flight) };
   const aimSame = dAim.dyaw < 1e-9 && dAim.drange < 1e-6 && dAim.dty < 1e-9 && dAim.dtr < 1e-6 && dAim.dflight < 1e-6 && after.snapped === before.snapped;
   allMono &&= mono; aimOk &&= aimSame; maxSettle = Math.max(maxSettle, st);
   const row = { step: label, level: z.level, bino: z.bino, zoom: z.bino ? z.zoom + 'x' : '-', dist: f1(z.dist), fov: f3(z.fov), frames: rows.length,
      fovPath: f1(rows[0]?.fov) + '->' + f1(rows[rows.length - 1]?.fov), camAlong: f1(rows[0]?.along) + '->' + f1(rows[rows.length - 1]?.along),
      camH: f1(rows[0]?.h) + '->' + f1(rows[rows.length - 1]?.h), maxFovStepPerFrame: f3(maxStep(rows, 'fov')), maxCamStepPerFrame_m: f1(Math.max(maxStep(rows, 'along'), maxStep(rows, 'h'))),
      monotonic: mono, settle_s: f3(st), aimUnchanged: aimSame };
   sweep.push(row);
   return row;
}
await notch(1, 8); await settled();              // widest third-person view
check('wheel out clamps at the widest view', (await Z()).level === 0);
await shot('tp-widest');
for (let i = 0; i < 9; i++) await traceNotch(-1, 'in ' + (i + 1));
await shot('16x');
for (let i = 0; i < 9; i++) await traceNotch(1, 'out ' + (i + 1));
console.table(sweep);
check('sweep in: tp 1..5, then 2x/4x/8x/16x', JSON.stringify(sweep.slice(0, 9).map(r => r.bino ? r.zoom : r.level)) === JSON.stringify([1, 2, 3, 4, 5, '2x', '4x', '8x', '16x']), sweep.slice(0, 9).map(r => r.bino ? r.zoom : r.level));
check('sweep out: 8x/4x/2x, closest view, then out to the widest', JSON.stringify(sweep.slice(9).map(r => r.bino ? r.zoom : r.level)) === JSON.stringify(['8x', '4x', '2x', 5, 4, 3, 2, 1, 0]), sweep.slice(9).map(r => r.bino ? r.zoom : r.level));
check('every transition monotonic (FOV, camera along/height, distance)', allMono);
check('every transition settles (0.5 %) within 0.33 s', maxSettle <= 0.33, { maxSettle: f3(maxSettle) });
check('aim bearing / range / flight time unchanged by every zoom step', aimOk);

// closest third-person + 2x screenshots, with the ladder cue
await notch(-1, 5); await settled();
await shot('tp-closest');
await notch(-1, 1); await settled();
await shot('2x');

// ------------------------------------------------------------------ vertical aim screen rate per zoom state
// 10 px of vertical mouse -> log-range step and the on-screen shift of the old aim point (sea,
// on the bearing plane) per mouse pixel. Uncapped states must all sit at the design rate
// VSENS * H / (2 tan(27.5 deg)) = 0.856 px/px; capped ones (sea nearly edge-on) below it.
{
   const H = 810, DY = 10, rates = [];
   const RATE0 = 0.0011 * H / (2 * Math.tan(55 * Math.PI / 360));
   const rate = async (label, R) => {
      await ev((R) => window.__setAim(-0.6, R), R);
      await settled(); await frames(15);
      const b = await ev(() => window.__aim());
      await ev((dy) => window.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: dy, bubbles: true })), DY);
      await frames(20);
      const a = await ev(() => ({ a: window.__aim(), z: window.__zoom3d(), p: { ...window.__world().player.pos } }));
      const cy = Math.cos(a.a.yaw), sy = Math.sin(a.a.yaw);
      const along = (a.z.cam.x - a.p.x) * cy + (a.z.cam.z - a.p.y) * sy, h = a.z.cam.y;
      const dep = (r) => Math.atan2(h, r - along);
      const px = Math.tan(dep(b.targetRange) - dep(a.a.targetRange)) * H / (2 * Math.tan(a.z.fov * Math.PI / 360));
      const lr = Math.log(b.targetRange / a.a.targetRange) / DY, cap = a.z.bino ? 0.02 : 0.0042;
      rates.push({ state: label, R: R, fov: f3(a.z.fov), logRangePerPx: +lr.toFixed(5), capped: lr > cap * 0.97, screenPxPerMousePx: f3(Math.abs(px) / DY) });
   };
   for (const R of [3000, 12000]) {
      await notch(1, 12); await rate('tp widest', R);
      await notch(-1, 3); await rate('tp 3', R);
      await notch(-1, 2); await rate('tp closest', R);
      for (const m of ['2x', '4x', '8x', '16x']) { await notch(-1, 1); await rate(m, R); }
   }
   console.table(rates);
   const unc = rates.filter(r => !r.capped).map(r => r.screenPxPerMousePx);
   check('uncapped zoom states: vertical screen rate = design rate +-10 %', unc.length >= 2 && unc.every(v => Math.abs(v / RATE0 - 1) < 0.1), { design: f3(RATE0), unc });
   check('capped states never exceed the design rate', rates.every(r => r.screenPxPerMousePx <= RATE0 * 1.1));
   await ev(() => window.__setAim(-0.6, 9000)); await frames(10);
}

// ------------------------------------------------------------------ Shift + wheel mixes
{
   // deterministic memory: wheel to 16x, back to 8x, Shift out (remembers 8x), wheel out to tp 3
   await notch(-1, 12); await notch(1, 1); await page.keyboard.press('Shift'); await frames(2);
   await notch(1, 2); await frames(2);
   const seq = [];
   const st = async () => { await frames(2); const z = await Z(); seq.push(z.bino ? z.zoom + 'x' : 'tp' + z.tp); };
   const shift = async () => { await page.keyboard.press('Shift'); await frames(2); };
   await st();                                          // tp3
   await shift(); await st();                           // Shift: last power 8x
   await notch(-1); await st();                         // 16x
   await shift(); await st();                           // back to tp3
   await notch(-1); await st();                         // tp4
   await shift(); await st();                           // 16x (memory)
   await notch(1, 4); await st();                       // 8x, 4x, 2x, out -> closest (tp5)
   await notch(-1); await st();                         // wheel entry is always 2x
   await shift(); await st();                           // tp5
   await shift(); await st();                           // 2x
   await notch(-1); await shift(); await notch(1); await st();   // 4x, Shift out (tp5), wheel out -> tp4
   check('Shift + wheel share one state', JSON.stringify(seq) === JSON.stringify(['tp3', '8x', '16x', 'tp3', 'tp4', '16x', 'tp5', '2x', 'tp5', '2x', 'tp4']), seq);
}

// ------------------------------------------------------------------ fast bursts, delta modes
{
   await notch(1, 12); await settled();
   const burst = (dy) => ev((dy) => new Promise(r => { let k = 0; const id = setInterval(() => { window.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true })); if (++k >= 10) { clearInterval(id); r(); } }, 10); }), dy);
   await recStart();
   await burst(-100);
   await frames(3);
   let z = await Z();
   check('10 notches in 100 ms: widest -> 16x, clamped', z.bino && z.zoom === 16 && z.acc === 0, { level: z.level, acc: z.acc });
   await settled();
   let rows = await recStop();
   check('burst in: FOV and distance monotonic', monotonic(rows.map(r => r.fov), 1e-6) && monotonic(rows.map(r => r.dist), 1e-6), { frames: rows.length });
   await recStart();
   await burst(100);
   await frames(3);
   z = await Z();
   check('10 notches out in 100 ms: 16x -> widest, clamped', !z.bino && z.level === 0, { level: z.level });
   await settled();
   rows = await recStop();
   check('burst out: FOV and distance monotonic', monotonic(rows.map(r => r.fov), 1e-6) && monotonic(rows.map(r => r.dist), 1e-6), { frames: rows.length, fovMono: monotonic(rows.map(r => r.fov), 1e-6), fov: rows.map(r => f3(r.fov)).join(' '), dist: rows.map(r => f1(r.dist)).join(' '), lv: rows.map(r => r.level).join(' ') });
   // one coalesced 300 px event = 3 clicks; 125 px (OS scaling) = 1 click
   await wheelEv(-300); await frames(2);
   z = await Z(); check('coalesced 300 px = 3 rungs', z.level === 3, z.level);
   await wheelEv(-125); await frames(2);
   z = await Z(); check('125 px click = 1 rung', z.level === 4, z.level);
   await wheelEv(-3, 1); await frames(2);
   z = await Z(); check('deltaMode 1 (3 lines) = 1 rung', z.level === 5, z.level);
   await wheelEv(-1, 2); await frames(2);
   z = await Z(); check('deltaMode 2 (1 page) = 1 rung -> 2x', z.bino && z.zoom === 2, z.level);
   await wheelEv(1, 2); await frames(2);
}

// ------------------------------------------------------------------ touchpad deltas across the boundary
{
   await notch(1, 2); await settled();                  // tp 3
   const tp0 = (await Z()).tp;
   // 4 px deltas (0.04 notch), one per frame, until the scope opens
   const glide = await ev(async () => {
      const out = [];
      const fr = () => new Promise(r => requestAnimationFrame(() => r()));
      for (let i = 0; i < 200 && !window.__zoom3d().bino; i++) {
         window.dispatchEvent(new WheelEvent('wheel', { deltaY: -4, bubbles: true, cancelable: true }));
         await fr();
         const z = window.__zoom3d(); out.push({ tp: z.tp, bino: z.bino, acc: z.acc });
      }
      return out;
   });
   const atClosest = glide.findIndex(g => g.tp === 5), firstBino = glide.findIndex(g => g.bino);
   const path = glide.slice(0, atClosest + 1);
   const smooth = path.every((g, i, a) => i === 0 || (g.tp >= a[i - 1].tp && g.tp - a[i - 1].tp <= 0.04 + 1e-6)) && new Set(path.map(g => g.tp)).size >= 40;
   console.log(`touchpad glide: tp ${tp0} -> closest in ${atClosest + 1} events (0.04 rung each), scope after ${firstBino - atClosest} more events`);
   check('touchpad: continuous third-person glide, then a detent before the scope', smooth && firstBino - atClosest >= 14 && firstBino - atClosest <= 16);
   const jit = await ev(async () => {
      let flips = 0, was = window.__zoom3d().bino;
      const fr = () => new Promise(r => requestAnimationFrame(() => r()));
      for (let i = 0; i < 120; i++) {
         window.dispatchEvent(new WheelEvent('wheel', { deltaY: i % 2 ? 12 : -12, bubbles: true, cancelable: true }));
         if (i % 4 === 3) await fr();
         const b = window.__zoom3d().bino; if (b !== was) { flips++; was = b; }
      }
      return flips;
   });
   check('touchpad jitter (+-12 px) at the scope boundary: no flicker', jit === 0, { flips: jit });
   const outN = await ev(async () => {
      let n = 0;
      const fr = () => new Promise(r => requestAnimationFrame(() => r()));
      while (window.__zoom3d().bino && n < 100) { window.dispatchEvent(new WheelEvent('wheel', { deltaY: 4, bubbles: true, cancelable: true })); n++; await fr(); }
      return n;
   });
   const z = await Z();
   check('touchpad out of the scope needs the detent and lands at the closest view', !z.bino && z.tp === 5 && outN >= 14 && outN <= 16, { outN, tp: z.tp });
}

// ------------------------------------------------------------------ capture: HUD element, pointer lock off
{
   await settled();
   const l0 = (await Z()).level;
   const target = await ev(() => { const r = document.getElementById('minimap-wrap').getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { x: r.x + r.width / 2, y: r.y + r.height / 2, el: e ? (e.id || e.tagName) : null }; });
   await page.mouse.move(target.x, target.y);
   await page.mouse.wheel(0, 100); await frames(2);
   const l1 = (await Z()).level;
   const prevented = await wheelEv(100, 0, '#minimap-canvas'); await frames(2);
   const l2 = (await Z()).level;
   check('wheel over the minimap / HUD zooms (pointer lock off)', l1 === l0 - 1 && l2 === l0 - 2 && prevented, { l0, l1, l2, under: target.el, prevented });
   const hudEl = await ev(() => { const e = document.querySelector('#hud .panel, #hud > div'); return e ? '#' + (e.id || '') : null; });
   if (hudEl && hudEl !== '#') { const p2 = await wheelEv(-100, 0, hudEl); await frames(2); check('wheel on ' + hudEl + ' is consumed', p2 === true); }
   await page.mouse.move(720, 405);
}

// ------------------------------------------------------------------ not hijacked: map, pause, results
{
   await page.keyboard.press('m'); await frames(2);
   let l0 = (await Z()).level;
   let p = await wheelEv(-100); await frames(2);
   check('tactical map (M): wheel not hijacked', p === false && (await Z()).level === l0);
   await page.keyboard.press('m'); await frames(2);
   await page.keyboard.press('p'); await frames(3);
   check('paused', (await ev(() => window.__phase())) === 'paused');
   p = await wheelEv(-100, 0, '#pause'); await frames(2);
   check('pause: wheel not hijacked', p === false && (await Z()).level === l0);
   await ev(() => document.getElementById('btn-resume').click()); await frames(3);
   check('resumed', (await ev(() => window.__phase())) === 'playing');
   p = await wheelEv(-100); await frames(2);
   check('after resume the wheel zooms again', p === true && (await Z()).level === l0 + 1);
}

// ------------------------------------------------------------------ results + restart reset
{
   await notch(-1, 6); await frames(3);
   const zb = await Z();
   await ev(() => { window.__world().phase = 'won'; });
   check('results screen shows', await waitFor(() => window.__phase() === 'ended', 12000));
   const p = await wheelEv(-100, 0, '#end');
   check('results: wheel not hijacked', p === false);
   await ev(() => window.__start({ difficulty: 'normal', ship: 'Hipper' }));
   await waitFor(() => window.__phase() === 'playing');
   await frames(2);
   const z = await Z();
   check('restart resets the zoom (default distance, no scope, 55 deg)', !z.bino && z.level === z0.level && Math.abs(z.dist - z0.dist) < 1e-6 && z.scopeT === 0 && Math.abs(z.fov - 55) < 0.01, { before: { level: zb.level, bino: zb.bino }, after: { level: z.level, dist: f1(z.dist), scopeT: z.scopeT, fov: f3(z.fov) } });
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length) { console.log('CONSOLE ERRORS:'); for (const e of errors) console.log('  ' + e); }
process.exit(failed.length || errors.length ? 1 : 0);
