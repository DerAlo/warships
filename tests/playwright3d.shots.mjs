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
//
// Frame-rate note: headless Chromium renders WebGL in software, so with the full graphics the
// page may run at only a few fps. Everything here therefore waits for rendered FRAMES (or polls
// a condition) instead of fixed milliseconds; the input layer counts taps per frame, so several
// key presses inside one slow frame still register.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
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
// resolve after n rendered frames
const frames = (n = 2) => ev(n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
// Screenshots switch the WebGL scene on for a few frames; between shots the checks run with the
// 3D render skipped (window.__setRender), because software GL at a few fps would stretch the run
// to many minutes. The sim, the camera, the HUD and the overlay keep running either way.
const shot = async name => {
   await ev(() => window.__setRender?.(true));
   await frames(3);
   await page.screenshot({ path: `${OUT}/3d-${name}.png` });
   await ev(() => window.__setRender?.(false));
};
async function press(key, n = 1) { for (let i = 0; i < n; i++) { await page.keyboard.press(key); await wait(10); } await frames(2); }
async function waitFor(fn, timeout = 8000, step = 100) {
   const t0 = Date.now();
   while (Date.now() - t0 < timeout) { if (await ev(fn)) return true; await wait(step); }
   return false;
}
// Mouse-look delta as a burst of small synthetic moves (like a real mouse), then 2 frames.
async function look(dx, dy, chunk = 150) {
   const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / chunk));
   await ev(([x, y, n]) => { for (let i = 0; i < n; i++) window.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y, bubbles: true })); }, [dx / n, dy / n, n]);
   await frames(2);
}
async function click() {
   await page.mouse.move(720, 405);
   await page.mouse.down(); await frames(2); await page.mouse.up(); await frames(2);
}

// ------------------------------------------------------------------ load + start
await page.goto(URL, { waitUntil: 'load' });
await wait(1200);
const menuVisible = await page.locator('#menu').isVisible().catch(() => false);
console.log('menu visible:', menuVisible);
if (menuVisible) await shot('01-menu');
// start through the hook (menu3d may own the menu flow); deterministic default options.
// Hipper: a cruiser with guns AND torpedoes on the new sim (the old sim ignores `ship`).
await ev(() => window.__start({ difficulty: 'normal', ship: 'Hipper' }));
check('game starts', await waitFor(() => window.__phase() === 'playing', 8000));
// Keep every ship afloat: at software-rendering frame rates the run spans minutes of sim time,
// and a sunk player (or a won match) would end the phase mid-test. Test-only, from the page.
await ev(() => { setInterval(() => { for (const s of window.__world()?.ships || []) if (s.alive && s.maxHP) s.hp = s.maxHP; }, 50); });
await wait(1500);
await shot('02-normal');   // (leaves the 3D render off until the next screenshot)

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
   await page.keyboard.down('w'); await wait(1200); await frames(6); await page.keyboard.up('w'); await frames(2);
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
   let a = await aim();
   const lo = a.targetRange;
   check('aim range reaches the minimum', Math.abs(lo - a.rangeMin) / a.rangeMin < 0.005, { lo, min: a.rangeMin });
   check('minimum range is <= 1 km', a.rangeMin <= 1000 + 1e-6, a.rangeMin);
   const seq = [lo];
   for (let i = 0; i < 26; i++) { await look(0, -60); seq.push((await aim()).targetRange); }
   a = await aim();
   let mono = true;
   for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1] - 1e-6) mono = false;
   check('aim range is monotonic in mouse Y', mono && seq[seq.length - 1] > seq[0]);
   check('aim range reaches the maximum', Math.abs(seq[seq.length - 1] - a.rangeMax) / a.rangeMax < 0.005, { hi: seq[seq.length - 1], max: a.rangeMax });
   check('max range covers the gun range, capped ~20 km', a.rangeMax >= a.gunRange && a.rangeMax <= Math.max(20000, a.gunRange) * 1.13, { max: a.rangeMax, gun: a.gunRange });
   await waitFor(() => { const a = window.__aim(); return Math.abs(a.range - a.targetRange) / a.targetRange < 0.001; }, 10000);
   a = await aim();
   const p = await ev(() => { const s = window.__world().player; return { x: s.pos.x, y: s.pos.y }; });
   const d = Math.hypot(a.point.x - p.x, a.point.y - p.y);
   check('aim point sits at the aim range', a.snapped != null || Math.abs(d - a.range) / a.range < 0.02, { d, range: a.range });
   // back to a mid range for the rest of the run
   await look(0, 180);
   await frames(10);
}

// ------------------------------------------------------------------ binoculars
{
   const tanBase = Math.tan(55 * Math.PI / 360);
   const fovOk = (fov, z) => Math.abs(Math.tan(fov * Math.PI / 360) - tanBase / z) / (tanBase / z) < 0.12;
   const settleFov = () => waitFor(() => { const a = window.__aim(), z = window.__ctl().zoom, tb = Math.tan(55 * Math.PI / 360);
      return Math.abs(Math.tan(a.fov * Math.PI / 360) - tb / z) / (tb / z) < 0.05; }, 15000);
   await press('Shift');
   await settleFov();
   let c = await ctl(), a = await aim();
   check('Shift enters binoculars', c.bino === true);
   check(`binocular FOV matches ${c.zoom}x`, fovOk(a.fov, c.zoom), { fov: a.fov, zoom: c.zoom });
   await shot('03-binoculars');
   await page.mouse.move(720, 405);
   const zooms = [];
   for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 100); await frames(2); }   // out to the widest
   zooms.push((await ctl()).zoom);
   for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -100); await frames(2); await settleFov(); c = await ctl(); a = await aim(); zooms.push(c.zoom); if (!fovOk(a.fov, c.zoom)) zooms.push('fov!' + a.fov.toFixed(1)); }
   check('wheel steps 2x/4x/8x/16x (and clamps)', JSON.stringify(zooms) === JSON.stringify([2, 4, 8, 16, 16]), zooms);
   await shot('04-binoculars-16x');
   // sensitivity scales with FOV: the same mouse delta turns much less at 16x
   const y0 = (await aim()).targetYaw;
   await look(100, 0);
   const dyaw16 = (await aim()).targetYaw - y0;
   for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 100); await frames(2); }
   await press('Shift');
   await waitFor(() => Math.abs(window.__aim().fov - 55) < 0.5, 15000);
   const y1 = (await aim()).targetYaw;
   await look(100, 0);
   const dyaw1 = (await aim()).targetYaw - y1;
   check('look sensitivity scales with zoom', dyaw16 > 0 && dyaw16 < dyaw1 * 0.12, { dyaw16, dyaw1 });
   check('Shift leaves binoculars', (await ctl()).bino === false && Math.abs((await aim()).fov - 55) < 1, (await aim()).fov);
   await look(-200, 0);
}

// ------------------------------------------------------------------ free look
{
   await frames(4);
   const a0 = await aim();
   await page.keyboard.down('c');
   await frames(2);
   await look(600, 0);
   await frames(4);
   const c = await ctl(), a1 = await aim();
   const ship = await ev(() => ({ x: window.__world().player.pos.x, y: window.__world().player.pos.y }));
   const b0 = Math.atan2(a0.point.y - ship.y, a0.point.x - ship.x), b1 = Math.atan2(a1.point.y - ship.y, a1.point.x - ship.x);
   const db = Math.abs(Math.atan2(Math.sin(b1 - b0), Math.cos(b1 - b0)));
   check('C = free look, guns keep their aim', c.freeLook && Math.abs(a1.yaw - a0.yaw) > 1 && db < 0.1, { camTurn: a1.yaw - a0.yaw, aimTurn: db });
   await page.keyboard.up('c');
   await frames(8);
   const a2 = await aim();
   check('releasing C returns the camera to the aim', !(await ctl()).freeLook && Math.abs(a2.yaw - a0.yaw) < 0.05, { back: a2.yaw - a0.yaw });
}

// ------------------------------------------------------------------ firing rule
{
   check('some turret becomes ready', await waitFor(() => window.__turrets().some(t => t.state === 'ready'), 45000));
   // knock every mount off the aim bearing: none is aligned, so LMB must not fire
   await ev(() => { const w = window.__world(); for (const t of w.player.turrets) t.bearing = (t.bearing || 0) + 1.6; window.__knockT = w.time; });
   // let a few sim steps run (fast frames can carry zero steps) so the HUD sees the new bearings
   await waitFor(() => window.__world().time > window.__knockT + 0.1, 5000, 20);
   await frames(2);
   const st = (await turrets()).map(t => t.state);
   const f0 = await fired();
   await click();
   const f1 = await fired();
   check('misaligned turrets hold fire', f1.shots === f0.shots && !st.includes('ready'), { states: st, shots: f1.shots - f0.shots });
   check('turrets re-align and become ready', await waitFor(() => window.__turrets().some(t => t.state === 'ready'), 45000));
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
   await frames(10);
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
   // force the launchers ready (old sim: torpTimer, contract: launchers[].reload) and aim abeam:
   // cruiser/destroyer tubes bear to the side, not over the bow
   await ev(() => {
      const p = window.__world().player;
      if (p.torps?.launchers) for (const l of p.torps.launchers) l.reload = 0;
      else if ('torpTimer' in p) try { p.torpTimer = 0; } catch (e) { /* getter-only read-out */ }
      window.__setAim?.(Math.PI / 2, 5000);
   });
   await frames(4);
   await shot('06-torpedo');
   await ev(() => { for (const l of window.__world().player.torps?.launchers || []) l.reload = 0; });
   await frames(2);
   const t0 = await fired();
   // collect ids of the player's torpedoes seen in the water (fast arcade torps may already be
   // gone again by the time a slow frame returns)
   await ev(() => {
      const w = window.__world(), p = w.player, old = new Set(w.torpedoes.map(t => t.id));
      const seen = window.__torpSeen = new Set();
      const mine = t => (t.shooter === p || t.ownerId === p.id) && !old.has(t.id);
      // at a few fps one frame runs many sim steps, so a fish that hits an island right away can
      // be spawned and removed between two polls: also watch the push itself
      const arr = w.torpedoes, push = arr.push;
      arr.push = function (...a) { for (const t of a) if (t && mine(t)) seen.add(t.id); return push.apply(this, a); };
      window.__torpUnhook = () => { arr.push = push; };
      window.__torpPoll = setInterval(() => {
         for (const t of window.__world().torpedoes) if ((t.shooter === p || t.ownerId === p.id) && !old.has(t.id)) seen.add(t.id);
      }, 15);
   });
   await click();
   await frames(2);
   const t1 = await fired();
   const newTorps = await ev(() => { clearInterval(window.__torpPoll); window.__torpUnhook(); return window.__torpSeen.size; });
   check('LMB launches torpedoes', t1.torps > t0.torps && newTorps > 0, { fired: t1.torps - t0.torps, inWater: newTorps });
   check('torpedo click fires no shells', t1.shots === t0.shots);
   await press('1');
   c = await ctl();
   check('1 returns to guns', c.mode === 'guns');
   await ev(() => window.__setAim?.(0, 6000));
   await frames(4);
}

// ------------------------------------------------------------------ consumables
{
   const b = await cons();
   const rep0 = b.find(x => x.slot === 'T');
   await press('t');
   let a = await cons();
   const rep1 = a.find(x => x.slot === 'T');
   check('T uses the repair party', rep1 && (rep1.active || rep1.cd > 0) && (rep0.charges == null || rep1.charges === rep0.charges - 1), { rep0, rep1 });
   await press('t');
   a = await cons();
   const rep2 = a.find(x => x.slot === 'T');
   check('cooldown blocks a second use', rep2.charges === rep1.charges, rep2);
   await press('r');
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
   await frames(6);
   const tC = await ev(() => window.__world().time);
   check('P resumes', (await ev(() => window.__phase())) === 'playing' && tC > tB, { tB, tC });
}

// ------------------------------------------------------------------ target lock
{
   // bring an enemy into clear view down the aim bearing (islands may hide the real ones):
   // ~5 km, or 60% of the gun range on the small arcade map of the old sim
   const eid = await ev(() => {
      const w = window.__world(), p = w.player, a = window.__aim(), R0 = Math.min(5000, a.gunRange * 0.6);
      const e = w.ships.find(s => s.alive && s.side !== p.side && s.side !== 'neutral');
      if (!e) return null;
      const obs = w.obstacles || [];
      const segClear = (A, B, pad) => obs.every(o => {
         const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1;
         const t = Math.max(0, Math.min(1, ((o.c.x - A.x) * dx + (o.c.y - A.y) * dy) / L2));
         return Math.hypot(A.x + dx * t - o.c.x, A.y + dy * t - o.c.y) > o.r * 1.1 + pad;
      });
      // nearest bearing to the current aim first, then outward; shorter ranges as a fallback
      for (const R of [R0, R0 * 0.7, R0 * 0.45]) {
         for (let k = 0; k <= 30; k++) {
            const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.2;
            const b = a.yaw + off, pos = { x: p.pos.x + Math.cos(b) * R, y: p.pos.y + Math.sin(b) * R };
            if (!segClear(p.pos, pos, R * 0.04) || (w.losBlocked && w.losBlocked(p.pos, pos))) continue;
            e.pos.x = pos.x; e.pos.y = pos.y;
            e.heading = b + Math.PI / 2; if (e.vel) { e.vel.x = 0; e.vel.y = 0; }
            window.__setAim(b - p.heading, R);
            w._updateSpotting?.();
            return e.id;
         }
      }
      return null;
   });
   await frames(6);
   await press('x');
   const lockId = (await ctl()).lockId;
   check('X locks the enemy under the crosshair', eid != null && lockId === eid, { eid, lockId });
   await frames(4);
   await shot('10-lock');
   await press('x');
   check('X again releases the lock', (await ctl()).lockId == null);
}

// ------------------------------------------------------------------ panels
{
   await press('m');
   check('M opens the tactical map', (await ctl()).mapOpen === true);
   await frames(3);
   await shot('07-map');
   await press('m');
   check('M closes the tactical map', (await ctl()).mapOpen === false);
   await page.keyboard.down('Tab');
   await frames(3);
   check('Tab shows the scoreboard', (await ctl()).board === true);
   await shot('08-scoreboard');
   await page.keyboard.up('Tab');
   await frames(2);
   check('releasing Tab hides the scoreboard', (await ctl()).board === false);
   await press('h');
   await frames(2);
   check('H shows the controls help', await page.locator('#help-panel').isVisible());
   await shot('09-help');
   await press('h');
}

check('zero console errors', errors.length === 0, errors.slice(0, 5));
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
