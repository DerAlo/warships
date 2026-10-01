// tests/playwright3d.lead.mjs -- browser check of the red lead marker (Vorhaltemarker): it has to be
// on screen in every case where the player has a main-battery target. Each case below made the old
// marker vanish: target far from the crosshair (aiming at the lead point in the scope), lead point
// off-screen or behind the camera, target out of sight for a moment, target beyond gun range, hard
// difficulty, night; plus the views that hide the HUD (kill cam, photo mode, tactical map) must
// hand it back. Screenshots go to tests/shots/3d-lead-*.png.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8772   then   URL3D=http://localhost:8772/index-3d.html node tests/playwright3d.lead.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:8772/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
const TAG = process.env.TAG || '';
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};

const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const VW = Number(process.env.VW) || 1440, VH = Number(process.env.VH) || 810;
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const frames = (n = 3) => ev(n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
async function waitFor(fn, timeout = 8000, step = 30) {
   const t0 = Date.now();
   while (Date.now() - t0 < timeout) { if (await ev(fn)) return true; await wait(step); }
   return false;
}
const shot = (name) => page.screenshot({ path: `${OUT}/3d-lead-${name}${TAG}.png` });
const L = () => ev(() => (window.__lead ? window.__lead() : window.__leadOld) || { shown: false });
// shown and inside the HUD-free frame (clear of the score box, the bottom panels and the minimap)
const onScreen = (l) => l.shown && l.x >= 30 && l.x <= VW - 30 && l.y >= 90 && l.y <= VH - 240;

// Scene control: one enemy E is put at (dist, bearing relative to the bow) with a crossing course;
// every other enemy is parked far astern, out of sight. Re-applied before each sample because the
// sim keeps running.
async function scene(o) {
   await ev((o) => {
      const w = window.__world(), P = w.player;
      const foes = w.ships.filter(s => s.side !== P.side && s.alive);
      let E = foes.find(s => s.id === window.__E) || foes.find(s => s.type === 'DD') || foes[0];
      if (window.__E !== E.id) {   // spotting is forced so a case tests the marker, not the spotting rules
         window.__E = E.id; window.__hide = false;
         Object.defineProperty(E, 'spotted', { get: () => !window.__hide, set: () => { }, configurable: true });
         Object.defineProperty(E, 'detected', { get: () => !window.__hide, set: () => { }, configurable: true });
      }
      P.speed = 0; P.telegraph = 0;
      const b = P.heading + (o.brg || 0);
      E.pos.x = P.pos.x + Math.cos(b) * o.dist; E.pos.y = P.pos.y + Math.sin(b) * o.dist;
      E.heading = b + (o.course ?? Math.PI / 2);
      if (o.speed != null) { E.speed = o.speed; if (E.vel) { E.vel.x = Math.cos(E.heading) * o.speed; E.vel.y = Math.sin(E.heading) * o.speed; } }
      let k = 0;
      for (const s of foes) if (s !== E) { k++; s.pos.x = P.pos.x - Math.cos(P.heading) * (40000 + k * 500); s.pos.y = P.pos.y - Math.sin(P.heading) * (40000 + k * 500); }
   }, o);
}
// aim: 'target' | 'lead' | relative yaw offset (rad) from the target bearing
async function aimAt(what, range) {
   await ev(([what, range]) => {
      const w = window.__world(), P = w.player, E = w.ships.find(s => s.id === window.__E);
      let x = E.pos.x, y = E.pos.y;
      if (what === 'lead') {
         const v = E.vel || { x: Math.cos(E.heading) * E.speed, y: Math.sin(E.heading) * E.speed };
         for (let i = 0; i < 4; i++) { const t = P.flightTime(Math.hypot(x - P.pos.x, y - P.pos.y)); x = E.pos.x + v.x * t; y = E.pos.y + v.y * t; }
      }
      let rel = Math.atan2(y - P.pos.y, x - P.pos.x) - P.heading + (typeof what === 'number' ? what : 0);
      while (rel > Math.PI) rel -= 2 * Math.PI; while (rel < -Math.PI) rel += 2 * Math.PI;
      window.__setAim(rel, range || Math.hypot(x - P.pos.x, y - P.pos.y));
   }, [what, range]);
}
const zoomTo = async (mag) => {   // mag 0 = third person, else scope magnification
   for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, 100); await frames(1); }
   if (mag) for (let i = 0; i < 14 && !(await ev((m) => { const z = window.__zoom3d(); return z.bino && z.zoom >= m; }, mag)); i++) { await page.mouse.wheel(0, -100); await frames(2); }
   await wait(700);
};
const start = async (opts) => {
   await ev((o) => { window.__E = null; window.__start(o); }, opts);
   await waitFor(() => window.__phase() === 'playing', 5000);
   await page.mouse.move(VW / 2, VH / 2);
   await wait(500);
};
// hold a scene for a few frames and sample the marker
async function sample(sc, aim, n = 6) {
   let l;
   for (let i = 0; i < n; i++) { await scene(sc); await aimAt(aim.what, aim.range); await frames(2); l = await L(); }
   return l;
}

await page.goto(URL, { waitUntil: 'load' });
await wait(800);
await start({ difficulty: 'normal', mission: 'standard', ship: 'Bismarck' });
const SPD = 80;   // m/s, a fast crossing target (sim is time-compressed)

// ---- 1. baseline: crosshair on the target
{
   const l = await sample({ dist: 9000, speed: SPD }, { what: 'target' });
   check('1 baseline: marker shown when aiming at the target', onScreen(l), l);
   await shot('1-baseline');
}
// ---- 2. scope 16x, aiming AT the lead point (the target itself slides out of view)
{
   await zoomTo(16);
   const l = await sample({ dist: 14000, speed: SPD }, { what: 'lead' }, 10);
   check('2 scope 16x, aiming at the lead point: marker shown at the crosshair', onScreen(l) && Math.hypot(l.x - VW / 2, l.y - VH / 2) < 60, l);
   await shot('2-scope16-on-lead');
   const l2 = await sample({ dist: 14000, speed: SPD }, { what: 'target' }, 10);
   check('2b scope 16x, crosshair on the target: marker shown (edge-clamped if the lead point is outside)', onScreen(l2), l2);
   await shot('2b-scope16-on-target');
   await zoomTo(0);
}
// ---- 3. lead point off-screen / behind the camera (locked target)
{
   await sample({ dist: 9000, speed: SPD }, { what: 'target' });
   await page.keyboard.press('x');
   await frames(3);
   check('3 lock taken', (await ev(() => window.__ctl().lockId)) != null);
   const l = await sample({ dist: 9000, speed: SPD }, { what: 1.2 });
   check('3a locked, looking 70° away: marker clamped to the screen edge', onScreen(l), l);
   await shot('3a-offscreen-side');
   const lb = await sample({ dist: 9000, speed: SPD }, { what: Math.PI });
   check('3b locked, target behind the camera: marker clamped to the screen edge', onScreen(lb), lb);
   await shot('3b-behind');
}
// ---- 4. beyond gun range (still spotted)
{
   const gr = await ev(() => window.__aim().gunRange);
   // the arena clamps ships to its border: put the player at one edge, the target at the other
   const far = await ev(() => { const w = window.__world(), P = w.player; P.pos.x = -w.arena + 300; P.pos.y = 0; P.heading = 0; return 2 * w.arena - 700; });
   if (far < gr + 800) console.log(`  (arena too small for case 4: ${far} m vs range ${gr} m)`);
   const l = await sample({ dist: far, speed: SPD }, { what: 'target', range: gr }, 10);
   check('4 target beyond gun range: marker kept', onScreen(l), { ...l, gunRange: gr });
   if (l.state !== undefined) check('4b ... and flagged as out of range', l.state === 'range', `${l.state}, lead point at ${Math.round(l.dist)} m, gun range ${Math.round(gr)} m`);
   await shot('4-out-of-range');
}
// ---- 5. target briefly out of sight
{
   await sample({ dist: 9000, speed: SPD }, { what: 'target' });
   await ev(() => { window.__hide = true; });
   await frames(20);
   let l = await L();
   check('5 target just lost from sight: marker kept', onScreen(l), l);
   if (l.state !== undefined) check('5b ... and flagged as not visible', l.state === 'lost', l.state);
   await aimAt('target'); await frames(3);
   await shot('5-unseen');
   await ev(() => { window.__hide = false; });
   await frames(10);
   l = await L();
   check('5c target seen again: marker back to normal', onScreen(l) && (l.state === undefined || l.state !== 'lost'), l);
}
// ---- 6. views that hide the HUD hand the marker back
{
   await sample({ dist: 9000, speed: SPD }, { what: 'target' });
   await page.keyboard.press('m'); await frames(4);
   await page.keyboard.press('m'); await frames(4);
   let l = await sample({ dist: 9000, speed: SPD }, { what: 'target' }, 2);
   check('6a after the tactical map: marker shown', onScreen(l), l);
   await page.keyboard.press('o'); await wait(300);
   check('6b photo mode entered', await ev(() => window.__photo().on));
   await page.keyboard.press('o'); await wait(300);
   l = await sample({ dist: 9000, speed: SPD }, { what: 'target' }, 2);
   check('6c after photo mode: marker shown', onScreen(l), l);
   await ev(() => window.__killCam(window.__world().ships.find(s => s.side !== window.__world().player.side && s.id !== window.__E).id));
   await waitFor(() => !window.__killCamOn(), 5000);
   l = await sample({ dist: 9000, speed: SPD }, { what: 'target' }, 3);
   check('6d after the kill cam: marker shown', onScreen(l), l);
   // shell cam: arm with B, fire, wait until it is over
   await waitFor(() => window.__turrets().some(t => t.state === 'ready'), 40000, 100);
   await page.keyboard.press('b'); await frames(3);
   await page.mouse.down(); await wait(80); await page.mouse.up();
   const on = await waitFor(() => window.__shellCam().on, 3000, 10);
   await waitFor(() => !window.__shellCam().on, 25000, 50);
   l = await sample({ dist: 9000, speed: SPD }, { what: 'target' }, 3);
   check('6e after the shell cam' + (on ? '' : ' (did not start)') + ': marker shown', onScreen(l), l);
}
// ---- 7. torpedo mode (destroyer): same marker, green
{
   await start({ difficulty: 'normal', mission: 'standard', ship: 'Z23' });
   await page.keyboard.press('3'); await frames(3);
   const l = await sample({ dist: 5000, speed: 30 }, { what: 'target' });
   check('7 torpedo mode: lead marker shown', onScreen(l) && l.torp === true, l);
   await shot('7-torpedo');
   const lo = await sample({ dist: 5000, speed: 30 }, { what: 1.3 });
   check('7b torpedo mode, looking away: marker clamped to the edge', onScreen(lo) && lo.off === true, lo);
}
// ---- 8. hard difficulty
{
   await start({ difficulty: 'hard', mission: 'standard', ship: 'Bismarck' });
   const l = await sample({ dist: 9000, speed: SPD }, { what: 'target' });
   check('8 hard difficulty: marker shown by default', onScreen(l), l);
}
// ---- 9. night + storm: contrast screenshots
for (const [mission, ship] of [['night', 'Hipper'], ['laststand', 'Bismarck']]) {
   await start({ difficulty: 'normal', mission, ship });
   const l = await sample({ dist: 7000, speed: SPD }, { what: -0.06 }, 10);
   check(`9 ${mission}: marker shown`, onScreen(l), l);
   await shot('9-' + mission);
   await zoomTo(8);
   const l2 = await sample({ dist: 7000, speed: SPD }, { what: 'lead' }, 10);
   check(`9 ${mission}, scope 8x on the lead point: marker shown`, onScreen(l2), l2);
   await shot('9-' + mission + '-scope8');
}

await browser.close();
const fails = results.filter(r => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log('  ERR ' + e);
process.exit(fails.length || errors.length ? 1 : 0);
