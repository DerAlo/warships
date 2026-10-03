// tests/playwright3d.carrier.mjs -- browser smoke test of the aircraft carrier: port card (air group,
// flak rating), battle in Enterprise, air panel, launch + squadron view (E), a dive-bomber attack run
// (LMB hold / release) with damage on an enemy ship, a torpedo-bomber launch and recall (F), the AA
// focus key (4), instanced aircraft drawn, and the mission "Midway".
// Screenshots go to tests/shots/. Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8782   then   URL3D=http://localhost:8782/index-3d.html node tests/playwright3d.carrier.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:8782/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};

const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
async function waitFor(fn, timeout = 8000, step = 50) {
   const t0 = Date.now();
   while (Date.now() - t0 < timeout) { if (await ev(fn)) return true; await wait(step); }
   return false;
}
const shot = (name) => page.screenshot({ path: `${OUT}/3d-cv-${name}.png` });
const air = () => ev(() => window.__air());

await page.goto(URL, { waitUntil: 'load' });
await wait(1200);

// ---- 1. port card
await ev(() => document.querySelector('[data-nat="us"]')?.click());
await wait(300);
const card = await ev(() => {
   const c = document.querySelector('[data-ship="Enterprise"]');
   if (!c) return null;
   c.click();
   return true;
});
await wait(300);
const port = await ev(() => document.getElementById('menu')?.innerText || '');
check('port: Enterprise card with air group and flak rating', card && /Flugabwehr/.test(port) && /SBD|TBD|F4F|Hangar/.test(port), port.match(/[^\n]*Hangar[^\n]*/)?.[0] || '');
await shot('port');

// ---- 2. battle in Enterprise
await ev(() => window.__start({ difficulty: 'easy', mission: 'standard', ship: 'Enterprise' }));
await waitFor(() => window.__phase() === 'playing', 5000);
await page.mouse.move(720, 405);
check('battle started in a carrier', await ev(() => window.__phase() === 'playing' && !!window.__world().player.air));
check('air panel shown', await ev(() => !document.getElementById('air-panel').classList.contains('hidden')));
await wait(1500);
await shot('ship');

// ---- 3. AA focus key
const f0 = await ev(() => window.__world().player.aaFocus);
await page.keyboard.press('4');
await wait(200);
check('4 cycles the AA focus', (await ev(() => window.__world().player.aaFocus)) !== f0, { f0, f1: await ev(() => window.__world().player.aaFocus) });

// ---- 4. dive bombers: launch and take over
await page.keyboard.press('2');
await wait(150);
check('2 selects dive bombers', (await air()).sel === 'db');
await page.keyboard.press('e');
check('E launches and takes over the squadron', await waitFor(() => window.__air().flying && window.__air().override, 3000), await air());
check('squadron leaves the deck', await waitFor(() => { const w = window.__world(), q = w.squadrons.find(s => s.id === window.__air().sqId); return q && q.state !== 'launch'; }, 15000));
await wait(1500);
await shot('squad-view');

// put the squadron on a run at the nearest enemy (release, move, take over again so the aim
// heading resets), with the target's motion led for the hold time plus the bomb fall
const setup = async () => {
   await page.keyboard.press('e');
   await wait(120);
   const r = await ev(async () => {
      const { AIR } = await import('/game3d/air.js');
      const w = window.__world(), p = w.player;
      const q = w.squadrons.find(s => s.ownerId === p.id && s.type === 'db' && s.state !== 'return' && s.state !== 'land');
      if (!q) return null;
      let e = null, best = 1e9;
      for (const s of w.ships) if (s.alive && s.side !== p.side && /BB|CA|CV/.test(s.cfg.hull.type)) { const d = Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y); if (d < best) { best = d; e = s; } }
      if (!e) return null;
      const hold = 3.2, T = hold + AIR.bombFall + 0.1;
      const tx = e.pos.x + (e.vel?.x || 0) * T, ty = e.pos.y + (e.vel?.y || 0) * T;
      const h = e.heading;          // along the target's length: the best chance for a short bomb pattern
      const back = AIR.dbAim + q.cfg.speed * hold;
      q.pos.x = tx - Math.cos(h) * back; q.pos.y = ty - Math.sin(h) * back;
      q.prev.x = q.pos.x; q.prev.y = q.pos.y; q.heading = q.want = q.prev.h = h;
      q.speed = q.cfg.speed; q.alt = q.prev.alt = AIR.dbAlt;
      q.state = 'fly'; q.fuel = Math.max(q.fuel, 120);
      window.__cvTarget = e.id;
      return { id: e.id, hp: e.hp, name: e.cfg.name };
   });
   await page.keyboard.press('e');
   await wait(100);
   return r;
};
const tgt = await setup();
check('squadron on an attack run', !!tgt && (await air()).flying, tgt || '');
const hp0 = await ev(() => window.__world().shipById(window.__cvTarget).hp);
await page.mouse.down();
await wait(1500);
await shot('aim');
await wait(1300);
// release when the bombing ellipse's centre reaches where the target will be at impact
await waitFor(async () => {
   const { AIR } = await import('/game3d/air.js');
   const w = window.__world(), e = w.shipById(window.__cvTarget), q = w.squadrons.find(s => s.id === window.__air().sqId);
   if (!e || !q) return true;
   const T = AIR.bombFall, c = Math.cos(q.heading), s = Math.sin(q.heading);
   const ax = q.pos.x + c * AIR.dbAim, ay = q.pos.y + s * AIR.dbAim;
   const tx = e.pos.x + (e.vel?.x || 0) * T, ty = e.pos.y + (e.vel?.y || 0) * T;
   return (tx - ax) * c + (ty - ay) * s < 15;
}, 2500, 16);
await page.mouse.up();
check('bombs released', await waitFor(() => window.__world().bombs.some(b => b.alive) || window.__world().squadrons.some(s => s.id === window.__air().sqId && s.armed < s.n0), 1500));
const miss = await ev(() => {
   const w = window.__world(), e = w.shipById(window.__cvTarget), bs = w.bombs.filter(b => b.alive);
   if (!e || !bs.length) return null;
   const mx = bs.reduce((a, b) => a + b.x, 0) / bs.length, my = bs.reduce((a, b) => a + b.y, 0) / bs.length;
   return { n: bs.length, centreToShip: Math.round(Math.hypot(mx - e.pos.x, my - e.pos.y)), fallLeft: +(bs[0].fall - bs[0].t).toFixed(2) };
});
console.log('bomb pattern:', JSON.stringify(miss));
await wait(1600);
await shot('bombs');
const hp1 = await ev(() => window.__world().shipById(window.__cvTarget)?.hp ?? 0);
check('enemy ship damaged by the bombs', hp1 < hp0, { hp0, hp1 });
check('instanced aircraft drawn', (await air()).drawn > 0, await air());
const calls = await ev(() => window.__renderer3d?.renderer?.info?.render?.calls ?? -1);
console.log('draw calls with squadrons in the air:', calls);

// ---- 5. back to the ship, torpedo bombers, recall
if ((await air()).flying) { await page.keyboard.press('e'); await wait(200); }
check('E returns to the ship', await waitFor(() => !window.__air().flying && !window.__air().override, 5000));
await page.keyboard.press('1');
await wait(150);
check('1 selects torpedo bombers', (await air()).sel === 'tb');
check('deck free again', await waitFor(() => window.__world().player.air.deckT <= 0, 15000));
await page.keyboard.press('e');
check('torpedo bombers launched', await waitFor(() => window.__air().flying && window.__world().squadrons.some(s => s.id === window.__air().sqId && s.type === 'tb'), 3000));
await wait(2500);
await page.keyboard.press('f');
await wait(300);
check('F recalls and returns to the ship', !(await air()).flying && (await ev(() => window.__world().squadrons.filter(s => s.type === 'tb' && s.ownerId === window.__world().player.id).every(s => s.state === 'return' || s.state === 'land'))));

// ---- 6. Midway
await ev(() => window.__start({ difficulty: 'normal', mission: 'midway', ship: 'Enterprise' }));
await waitFor(() => window.__phase() === 'playing', 5000);
const mw = await ev(() => { const w = window.__world(), ps = w.player.side; return { own: w.ships.filter(s => s.air && s.side === ps).map(s => s.cfg.name), foe: w.ships.filter(s => s.air && s.side !== ps).map(s => s.cfg.name) }; });
check('Midway: carriers on both sides', mw.own.length > 0 && mw.foe.length > 0, mw);
await wait(2500);

const fails = results.filter(r => !r.ok).length;
check('no console errors', errors.length === 0, errors.slice(0, 5));
console.log(`\n${results.length - fails - (errors.length ? 1 : 0)}/${results.length} checks passed`);
await browser.close();
process.exit(fails || errors.length ? 1 : 0);
