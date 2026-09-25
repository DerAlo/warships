// tests/playwright3d.secondary.mjs -- browser smoke test for the WoWs-style secondary battery
// priority target: Ctrl+left click on an enemy sets ship.secTarget (orange HUD brackets + notice)
// without firing the main battery, Ctrl+click again clears it, a plain click still fires.
// Also exercises the career skill "Manuelle Steuerung der Sekundärbewaffnung" in the port.
// Exit code 1 on a failed check or any console error. Screenshots go to tests/shots/.
//
// Run:  node server.js 8762   then   URL3D=http://localhost:8762/index-3d.html node tests/playwright3d.secondary.mjs
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const frames = (n = 2) => ev(n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
async function waitFor(fn, timeout = 8000, step = 50) {
   const t0 = Date.now();
   while (Date.now() - t0 < timeout) { if (await ev(fn)) return true; await wait(step); }
   return false;
}
const msgs = () => ev(() => [...document.querySelectorAll('#msgs .msg')].map(d => d.textContent));
// orange (secondary marker) pixels on the HUD overlay canvas
const orangePx = () => ev(() => {
   const c = document.getElementById('fx'), g = c.getContext('2d');
   const d = g.getImageData(0, 0, c.width, c.height).data;
   let n = 0;
   for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 120 && d[i] > 200 && d[i + 1] > 105 && d[i + 1] < 185 && d[i + 2] < 90) n++;
   return n;
});
const ctrlClick = async () => {
   await page.keyboard.down('Control');
   await page.mouse.click(720, 405);
   await page.keyboard.up('Control');
   await frames(3);
};

// ------------------------------------------------------------------ port: the skill is listed and learnable
await page.addInitScript(() => {
   // captain level 5 (enough points for the 4-point skill), nothing learned yet
   if (!sessionStorage.getItem('secTestSeeded')) {
      sessionStorage.setItem('secTestSeeded', '1');
      localStorage.setItem('warships3d.profile.v1', JSON.stringify({ v: 1, xp: 0, totalXp: 17500, credits: 0, battles: 3, unlocked: {}, modules: {}, skills: [] }));
   }
});
await page.goto(URL, { waitUntil: 'load' });
await wait(1200);
{
   const capBtn = await page.$('[data-act="captain"]');
   if (capBtn) { await capBtn.click(); await wait(300); }
   const btn = await page.$('[data-skill="manualSec"]');
   check('port: skill "Manuelle Steuerung der Sekundärbewaffnung" listed', !!btn && (await btn.textContent()).includes('Manuelle Steuerung der Sekundärbewaffnung'));
   if (btn) {
      await page.screenshot({ path: `${OUT}/3d-secondary-skills.png` });
      await btn.click(); await wait(200);
      const learned = await ev(() => JSON.parse(localStorage.getItem('warships3d.profile.v1')).skills);
      check('port: skill learned and saved', learned.includes('manualSec'), learned);
      // unlearn again for the plain Ctrl+click part below
      await ev(() => { const p = JSON.parse(localStorage.getItem('warships3d.profile.v1')); p.skills = []; localStorage.setItem('warships3d.profile.v1', JSON.stringify(p)); });
   }
}
await page.goto(URL, { waitUntil: 'load' });
await wait(1000);

// ------------------------------------------------------------------ battle: Ctrl+click on an enemy
await ev(() => window.__start({ difficulty: 'normal', mission: 'standard', ship: 'Bismarck' }));
check('game starts', await waitFor(() => window.__phase() === 'playing'));
await ev(() => window.__setRender?.(false));
// pin one enemy broadside 5 km off the starboard bow; everybody stays at full HP
const tgtId = await ev(() => {
   const w = window.__world(), p = w.player;
   const e = w.ships.find(s => s.side !== p.side && s.alive);
   const b = p.heading + 0.5;
   const pin = () => {
      for (const s of w.ships) if (s.alive && s.maxHP) s.hp = s.maxHP;
      e.pos.x = p.pos.x + Math.cos(b) * 5000; e.pos.y = p.pos.y + Math.sin(b) * 5000;
      e.heading = b + Math.PI / 2; e.speed = 0; e.vel.x = 0; e.vel.y = 0; e.ai.passive = true;
   };
   pin(); setInterval(pin, 30);
   window.__secTgt = e;
   return e.id;
});
await ev(() => window.__setAim(0.5, 5000));
await frames(20);
const snapped = await ev(() => window.__aim().snapped);
check('crosshair snaps onto the pinned enemy', snapped === tgtId, { snapped, tgtId });

const shots0 = await ev(() => window.__fired().shots);
await ctrlClick();
let st = await ev(() => ({ sec: window.__world().player.secTarget, shots: window.__fired().shots, lock: window.__ctl().lockId }));
check('Ctrl+click sets the secondary target', st.sec === tgtId, st);
check('Ctrl+click fires no main-battery salvo', st.shots === shots0, { before: shots0, after: st.shots });
check('notice "Sekundärziel: <Name>"', (await msgs()).some(t => t.startsWith('Sekundärziel: ')), await msgs());
// marker: render one frame with the HUD and look for the orange brackets
await ev(() => window.__setRender?.(true));
await frames(4);
const orange = await orangePx();
check('orange secondary-target marker drawn', orange > 40, { orange });
await page.screenshot({ path: `${OUT}/3d-secondary-target.png` });
await ev(() => window.__setRender?.(false));
// the secondaries engage it (7.6 km range, target at 5 km)
check('secondaries fire at the priority target', await waitFor(() => {
   const w = window.__world();
   return w.shells.some(s => s.kind === 'sec' && s.ownerId === w.player.id && Math.hypot(s.aimPoint.x - window.__secTgt.pos.x, s.aimPoint.y - window.__secTgt.pos.y) < 300);
}, 10000));

// Ctrl+click the same ship again -> cleared
await ctrlClick();
st = await ev(() => ({ sec: window.__world().player.secTarget, shots: window.__fired().shots }));
check('Ctrl+click on the same ship clears it', st.sec === null, st);
check('still no main-battery salvo', st.shots === shots0);
check('notice "Sekundärziel aufgehoben"', (await msgs()).includes('Sekundärziel aufgehoben'), await msgs());
await frames(2);
await ev(() => window.__setRender?.(true));
await frames(3);
// (the traversing reticle ring and turret pips carry some orange-ish pixels of their own)
const orangeAfter = await orangePx();
await page.screenshot({ path: `${OUT}/3d-secondary-cleared.png` });
check('marker gone after clearing', orangeAfter < orange * 0.4, { orange, orangeAfter });
await ev(() => window.__setRender?.(false));

// set again, then Ctrl+click on open sea clears it
await ctrlClick();
check('set again', await ev(id => window.__world().player.secTarget === id, tgtId));
await ev(() => window.__setAim(-1.2, 6000));
await frames(20);
await ctrlClick();
check('Ctrl+click on open sea clears it', await ev(() => window.__world().player.secTarget === null));

// a plain left click still fires the main battery (turrets swing back first)
await ev(() => window.__setAim(0.5, 5000));
await waitFor(() => window.__turrets().some(t => t.state === 'ready'), 30000);
await page.mouse.click(720, 405);
await frames(3);
check('plain left click fires the main battery', (await ev(() => window.__fired().shots)) > shots0);

check('zero console errors', errors.length === 0, errors.slice(0, 5));
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
