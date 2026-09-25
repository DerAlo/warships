// tests/playwright3d.shellcam.mjs -- browser smoke test of the 3D shell camera (Geschoss-Kamera):
// arm with B, fire a salvo at a target, the camera follows the shell (override set, pose moves
// smoothly, HUD hidden, hint shown), holds on the impact and hands back to the chase rig; then
// B on a salvo in flight + abort by key press. Mid-flight screenshot to tests/shots/.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8761   then   URL3D=http://localhost:8761/index-3d.html node tests/playwright3d.shellcam.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:8761/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};

// GPU flags: the software renderer runs at ~2 fps, which slows the sim below real time and trips the 12 s cap.
const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
async function waitFor(fn, timeout = 8000, step = 30) {
   const t0 = Date.now();
   while (Date.now() - t0 < timeout) { if (await ev(fn)) return true; await wait(step); }
   return false;
}
const SC = () => ev(() => ({ ...window.__shellCam(), override: !!window.__cam3.override }));
const aimAtTarget = () => ev(() => {
   const w = window.__world(), P = w?.player;
   if (!P?.alive) return 0;
   let best = null, bd = 1e9;
   for (const s of w.ships) {
      if (s.side === P.side || !s.alive) continue;
      const d = Math.hypot(s.pos.x - P.pos.x, s.pos.y - P.pos.y);
      if (d < bd) { bd = d; best = s; }
   }
   if (!best) return 0;
   const brg = Math.atan2(best.pos.y - P.pos.y, best.pos.x - P.pos.x);
   let rel = brg - P.heading; while (rel > Math.PI) rel -= 2 * Math.PI; while (rel < -Math.PI) rel += 2 * Math.PI;
   window.__setAim(rel, bd);
   return Math.round(bd);
});
const ready = () => waitFor(() => { const t = window.__turrets(); return t.length > 0 && t.filter(x => x.state === 'ready').length >= Math.ceil(t.length / 2); }, 30000, 100);
const fire = async () => { await page.mouse.down(); await wait(60); await page.mouse.up(); };

await page.goto(URL, { waitUntil: 'load' });
await wait(800);
await ev(() => window.__start({ difficulty: 'normal', mission: 'training', ship: 'Hipper' }));
await waitFor(() => window.__phase() === 'playing', 5000);
await page.mouse.move(720, 405);
check('battle started', await ev(() => window.__phase() === 'playing'));
check('default mode "key"', (await SC()).mode === 'key');
// turn the bow toward the targets so the turrets bear, then aim at the nearest one
const R = await aimAtTarget();
check('target found', R > 0, { range: R });
await ready();
await aimAtTarget();
await wait(400);
await ready();

// ---- 1. arm with B, fire -> follow -> hold -> return
await page.keyboard.press('b');
await wait(100);
check('B arms the cam', (await SC()).armed === true);
await aimAtTarget();
await fire();
const started = await waitFor(() => window.__shellCam().on, 3000, 10);
check('cam starts on the next own salvo', started);
if (started) {
   const a = await SC();
   check('override set + follow state', a.override && a.state === 'follow' && a.shellId != null, { state: a.state, id: a.shellId });
   const hud = await ev(() => ({
      hint: !document.getElementById('shellcam-hint').classList.contains('hidden'),
      hintText: document.getElementById('shellcam-hint').textContent,
      fov: window.__cam3.override?.fov,
   }));
   check('hint shown', hud.hint && hud.hintText.includes('Geschoss-Kamera'), hud.hintText);
   check('FOV 45-55', hud.fov >= 45 && hud.fov <= 55, hud.fov);
   // sample the pose over a few hundred ms: it must move along the flight path
   const p0 = (await SC()).pose;
   await wait(350);
   await page.screenshot({ path: `${OUT}/3d-shellcam-midflight.png` });
   const b = await SC();
   const moved = Math.hypot(b.pose.px - p0.px, b.pose.pz - p0.pz);
   check('camera follows the shell (pose moves)', b.on && moved > 50, { moved: Math.round(moved), state: b.state });
   check('camera above the water, looking forward', b.pose.py > 5, { py: Math.round(b.pose.py) });
   const held = await waitFor(() => window.__shellCam().state === 'hold', 14000, 10);
   check('reaches the impact hold', held);
   const t0 = Date.now();
   const done = await waitFor(() => !window.__shellCam().on, 4000, 10);
   const holdMs = Date.now() - t0;
   const c = await SC();
   check('returns after ~0.8 s hold', done && c.reason === 'done' && holdMs > 500 && holdMs < 1600, { reason: c.reason, holdMs });
   check('chase rig restored (override cleared)', !c.override);
   const hud2 = await ev(() => document.getElementById('shellcam-hint').classList.contains('hidden'));
   check('hint hidden again', hud2);
}

// ---- 2. B while a salvo is in flight follows it; any key returns
await ready();
await aimAtTarget();
await fire();
await waitFor(() => (window.__world().shells || []).some(s => s.kind === 'main' && s.ownerId === window.__world().player.id), 1000, 10);
await wait(100);
await page.keyboard.press('b');
const s2 = await waitFor(() => window.__shellCam().on, 1500, 10);
check('B follows the salvo in flight', s2);
if (s2) {
   await wait(300);
   await page.keyboard.press('w');
   const off = await waitFor(() => !window.__shellCam().on, 1000, 10);
   const c = await SC();
   check('any key returns immediately', off && c.reason === 'input' && !c.override, { reason: c.reason });
}

// ---- 3. mode "Aus": B only shows a message, nothing starts
await ev(() => { const el = document.getElementById('opt-shellcam'); el.value = 'off'; el.dispatchEvent(new Event('change')); });
await page.keyboard.press('b');
await wait(100);
check('mode off: B does not arm', (await SC()).armed === false && (await SC()).mode === 'off');
await ev(() => { const el = document.getElementById('opt-shellcam'); el.value = 'key'; el.dispatchEvent(new Event('change')); });

check('zero console errors', errors.length === 0, errors.slice(0, 5));
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
