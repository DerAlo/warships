// tests/playwright3d.shots.mjs -- headless self-test for the 3D mode's controls, camera, aim and
// HUD. Deterministic assertions on the control model (telegraph/rudder steps, range-based aim,
// binocular zoom, turret-alignment firing rule, ammo/torpedo modes, consumables, pause) plus
// screenshots of the main views. Exit code 1 on any failed check or console error.
//
// Run:  node server.js 5173   then   node tests/playwright3d.shots.mjs   (URL3D=... to override)
//
// Mouse note: the aim is pure mouse-look (pointer lock, movementX/Y only). page.mouse.move()
// teleports an absolute cursor and gets clamped at the viewport edge, so look() dispatches
// synthetic mousemove events with explicit movementX/Y instead -- exactly what input3d.js reads.
// main3d clamps the per-frame delta to +-400 px (guards against pointer-lock jumps), so long
// sweeps are split into chunks spread over several frames.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const OUT = 'tests/shots';
mkdirSync(OUT, { recursive: true });

const errors = [];
const results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const ctl = () => ev(() => window.__ctl());
const aim = () => ev(() => window.__aim());
const turrets = () => ev(() => window.__turrets());
const cons = () => ev(() => window.__cons());
const fired = () => ev(() => window.__fired());
const shot = name => page.screenshot({ path: `${OUT}/3d-${name}.png` });
async function press(key, n = 1) { for (let i = 0; i < n; i++) { await page.keyboard.press(key); await wait(40); } }
async function waitFor(fn, timeout = 8000, step = 100) {
   const t0 = Date.now();
   while (Date.now() - t0 < timeout) { if (await ev(fn)) return true; await wait(step); }
   return false;
}
// Mouse-look delta split over frames (see header).
async function look(dx, dy, chunk = 150) {
   const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / chunk));
   for (let i = 0; i < n; i++) {
      await ev(([x, y]) => window.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y, bubbles: true })), [dx / n, dy / n]);
      await wait(22);
   }
}
async function click(ms = 70) {
   await page.mouse.move(720, 405);
   await page.mouse.down(); await wait(ms); await page.mouse.up(); await wait(40);
}

// ------------------------------------------------------------------ load + start
await page.goto(URL, { waitUntil: 'load' });
await wait(1200);
const menuVisible = await page.locator('#menu').isVisible().catch(() => false);
console.log('menu visible:', menuVisible);
if (menuVisible) await shot('01-menu');
// start through the hook (menu3d may own the menu flow); deterministic default options
await ev(() => window.__start({ difficulty: 'normal' }));
check('game starts', await waitFor(() => window.__phase() === 'playing', 8000));
await wait(1500);
await shot('02-normal');

// ------------------------------------------------------------------ telegraph
{
   const t0 = (await ctl()).telegraph;
   await press('s', 8);
   check('telegraph clamps at Rückwärts (-1)', (await ctl()).telegraph === -1);
   await press('w');
   check('W = one telegraph step', (await ctl()).telegraph === 0, { t0 });
   await press('w', 9);
   check('telegraph clamps at Voll (4)', (await ctl()).telegraph === 4);
   await press('s', 2);
   await wait(700);
   check('telegraph persists after release', (await ctl()).telegraph === 2);
   // holding repeats: tap step + repeats after the hold delay
   await press('s', 3);                       // -> -1
   await page.keyboard.down('w'); await wait(1150); await page.keyboard.up('w');
   const th = (await ctl()).telegraph;
   check('holding W repeats steps', th >= 1, { telegraph: th });
   await press('s', 8); await press('w', 3);  // settle at 1/2
   const sim = await ev(() => { const p = window.__world().player; return { telegraph: p.telegraph, throttleIn: p.throttleIn }; });
   check('telegraph reaches the sim', sim.telegraph === 2 || sim.throttleIn === 0.5, sim);
}

// ------------------------------------------------------------------ rudder
{
   await press('d');
   check('D = one rudder step (halb Stb)', (await ctl()).rudder === 1);
   await press('d', 3);
   check('rudder clamps at hart Stb (2)', (await ctl()).rudder === 2);
   await wait(900);
   check('rudder persists after release', (await ctl()).rudder === 2);
   await press('a', 5);
   check('rudder clamps at hart Bb (-2)', (await ctl()).rudder === -2);
   await press('q');
   check('Q centres the rudder', (await ctl()).rudder === 0);
   await press('a');
   await wait(400);
   const sim = await ev(() => { const p = window.__world().player; return { rudderCmd: p.rudderCmd, helm: p.helm }; });
   check('rudder reaches the sim', sim.rudderCmd === -1 || Math.abs((sim.helm ?? 99) + 0.5) < 1e-6, sim);
   await press('q');
}

// ------------------------------------------------------------------ aim range mapping
{
   await look(0, 3000);                       // mouse down = shorter range
   await wait(250);
   let a = await aim();
   const lo = a.targetRange;
   check('aim range reaches the minimum', Math.abs(lo - a.rangeMin) / a.rangeMin < 0.005, { lo, min: a.rangeMin });
   check('minimum range is <= 1 km', a.rangeMin <= 1000 + 1e-6, a.rangeMin);
   const seq = [lo];
   for (let i = 0; i < 26; i++) { await look(0, -60); await wait(30); seq.push((await aim()).targetRange); }
   a = await aim();
   let mono = true;
   for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1] - 1e-6) mono = false;
   check('aim range is monotonic in mouse Y', mono && seq[seq.length - 1] > seq[0]);
   check('aim range reaches the maximum', Math.abs(seq[seq.length - 1] - a.rangeMax) / a.rangeMax < 0.005, { hi: seq[seq.length - 1], max: a.rangeMax });
   check('max range covers the gun range, capped ~20 km', a.rangeMax >= a.gunRange && a.rangeMax <= Math.max(20000, a.gunRange) * 1.13, { max: a.rangeMax, gun: a.gunRange });
   await wait(400);
   a = await aim();
   const p = await ev(() => { const s = window.__world().player; return { x: s.pos.x, y: s.pos.y }; });
   const d = Math.hypot(a.point.x - p.x, a.point.y - p.y);
   check('aim point sits at the aim range', a.snapped != null || Math.abs(d - a.range) / a.range < 0.02, { d, range: a.range });
   // back to a mid range for the rest of the run
   await look(0, 180);
   await wait(300);
}

// ------------------------------------------------------------------ binoculars
{
   await press('Shift');
   await wait(600);
   let c = await ctl(), a = await aim();
   check('Shift enters binoculars', c.bino === true);
   const tanBase = Math.tan(55 * Math.PI / 360);
   const fovOk = (fov, z) => Math.abs(Math.tan(fov * Math.PI / 360) - tanBase / z) / (tanBase / z) < 0.12;
   check(`binocular FOV matches ${c.zoom}x`, fovOk(a.fov, c.zoom), { fov: a.fov, zoom: c.zoom });
   await shot('03-binoculars');
   await page.mouse.move(720, 405);
   const zooms = [];
   for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 100); await wait(80); }   // out to the widest
   zooms.push((await ctl()).zoom);
   for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -100); await wait(450); c = await ctl(); a = await aim(); zooms.push(c.zoom); if (!fovOk(a.fov, c.zoom)) zooms.push('fov!' + a.fov.toFixed(1)); }
   check('wheel steps 2x/4x/8x/16x (and clamps)', JSON.stringify(zooms) === JSON.stringify([2, 4, 8, 16, 16]), zooms);
   await shot('04-binoculars-16x');
   // sensitivity scales with FOV: the same mouse delta turns much less at 16x
   const y0 = (await aim()).targetYaw;
   await look(100, 0);
   const dyaw16 = (await aim()).targetYaw - y0;
   for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 100); await wait(60); }
   await press('Shift');
   await wait(600);
   const y1 = (await aim()).targetYaw;
   await look(100, 0);
   const dyaw1 = (await aim()).targetYaw - y1;
   check('look sensitivity scales with zoom', dyaw16 > 0 && dyaw16 < dyaw1 * 0.12, { dyaw16, dyaw1 });
   check('Shift leaves binoculars', (await ctl()).bino === false && Math.abs((await aim()).fov - 55) < 1, (await aim()).fov);
   await look(-200, 0);
}

// ------------------------------------------------------------------ firing rule
{
   check('some turret becomes ready', await waitFor(() => window.__turrets().some(t => t.state === 'ready'), 12000));
   // knock every mount off the aim bearing: none is aligned, so LMB must not fire
   await ev(() => { for (const t of window.__world().player.turrets) t.bearing = (t.bearing || 0) + 1.6; });
   await wait(40);
   const st = (await turrets()).map(t => t.state);
   const f0 = await fired();
   await click();
   const f1 = await fired();
   check('misaligned turrets hold fire', f1.shots === f0.shots && !st.includes('ready'), { states: st, shots: f1.shots - f0.shots });
   check('turrets re-align and become ready', await waitFor(() => window.__turrets().some(t => t.state === 'ready'), 12000));
   const st2 = (await turrets()).map(t => t.state);
   await click();
   const f2 = await fired();
   check('LMB fires ready turrets', f2.shots > f1.shots, { states: st2, shots: f2.shots - f1.shots });
   const st3 = (await turrets()).map(t => t.state);
   await click();
   const f3 = await fired();
   const readyAfter = st3.filter(s => s === 'ready').length;
   check('reloading turrets do not fire again', readyAfter > 0 || f3.shots === f2.shots, { states: st3, shots: f3.shots - f2.shots });
   check('no shot from a non-ready turret', (await ev(() => window.__badFireCount)) === 0);
   await wait(900);
   await shot('05-after-salvo');
}

// ------------------------------------------------------------------ ammo
{
   await press('2');
   let c = await ctl();
   const st = (await turrets()).map(t => t.state);
   check('2 selects AP', c.ammo === 'AP' && c.mode === 'guns');
   check('ammo switch reloads the mounts', st.every(s => s !== 'ready'), st);
   await press('1');
   c = await ctl();
   check('1 selects HE', c.ammo === 'HE');
}

// ------------------------------------------------------------------ torpedoes
{
   await press('3');
   let c = await ctl();
   check('3 enters torpedo mode', c.mode === 'torp' && (await ev(() => window.__weaponSel())) === 'torp');
   await wait(300);
   await shot('06-torpedo');
   // force the launchers ready (old sim: torpTimer, contract: launchers[].reload)
   await ev(() => {
      const p = window.__world().player;
      if ('torpTimer' in p) p.torpTimer = 0;
      for (const l of p.torps?.launchers || []) l.reload = 0;
   });
   await wait(80);
   const t0 = await fired();
   const n0 = await ev(() => window.__world().torpedoes.length);
   await click();
   await wait(150);
   const t1 = await fired();
   const n1 = await ev(() => window.__world().torpedoes.length);
   check('LMB launches torpedoes', t1.torps > t0.torps && n1 > n0, { fired: t1.torps - t0.torps, inWater: n1 - n0 });
   check('torpedo click fires no shells', t1.shots === t0.shots);
   await press('1');
   c = await ctl();
   check('1 returns to guns', c.mode === 'guns');
}

// ------------------------------------------------------------------ consumables
{
   const b = await cons();
   const rep0 = b.find(x => x.slot === 'T');
   await press('t');
   await wait(120);
   let a = await cons();
   const rep1 = a.find(x => x.slot === 'T');
   check('T uses the repair party', rep1 && (rep1.active || rep1.cd > 0) && (rep0.charges == null || rep1.charges === rep0.charges - 1), { rep0, rep1 });
   await press('t');
   await wait(120);
   a = await cons();
   const rep2 = a.find(x => x.slot === 'T');
   check('cooldown blocks a second use', rep2.charges === rep1.charges, rep2);
   await press('r');
   await wait(120);
   const dc = (await cons()).find(x => x.slot === 'R');
   check('R uses damage control', dc && (dc.active || dc.cd > 0), dc);
}

// ------------------------------------------------------------------ pause / resume
{
   await press('p');
   check('P pauses', (await ev(() => window.__phase())) === 'paused');
   const tA = await ev(() => window.__world().time);
   await wait(400);
   const tB = await ev(() => window.__world().time);
   check('sim is frozen while paused', tA === tB, { tA, tB });
   await press('p');
   await wait(400);
   const tC = await ev(() => window.__world().time);
   check('P resumes', (await ev(() => window.__phase())) === 'playing' && tC > tB, { tB, tC });
}

// ------------------------------------------------------------------ lock + panels
{
   await press('x');
   const lockId = (await ctl()).lockId;
   console.log('lock target:', lockId);
   await press('m');
   check('M opens the tactical map', (await ctl()).mapOpen === true);
   await wait(250);
   await shot('07-map');
   await press('m');
   check('M closes the tactical map', (await ctl()).mapOpen === false);
   await page.keyboard.down('Tab');
   await wait(300);
   check('Tab shows the scoreboard', (await ctl()).board === true);
   await shot('08-scoreboard');
   await page.keyboard.up('Tab');
   await wait(100);
   check('releasing Tab hides the scoreboard', (await ctl()).board === false);
   if (lockId != null) await press('x');
}

check('zero console errors', errors.length === 0, errors.slice(0, 5));
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
