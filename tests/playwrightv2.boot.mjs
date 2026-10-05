// tests/playwrightv2.boot.mjs -- browser boot check of V2 (index-v2.html): the page loads, the menu
// shows the modern roster, both base missions (training, standard) start from the menu and run for
// RUN_S seconds (default 30) without a console error; missiles, land positions and decoys are put
// through the renderer once. Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8824   then   URLV2=http://localhost:8824/index-v2.html node tests/playwrightv2.boot.mjs
//       (VW/VH = viewport, MISSIONS=a,b to limit, RUN_S=seconds, NO_GPU=1 for software GL, SHOTS=1 for screenshots)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8824/index-v2.html';
const OUT = process.env.OUT || 'tests/shots';
const VW = Number(process.env.VW) || 1440, VH = Number(process.env.VH) || 810;
const RUN_S = Number(process.env.RUN_S) || 30;
const ids = (process.env.MISSIONS || 'training,standard').split(',');
const ROSTER = ['Braunschweig', 'Sachsen', 'Burke', 'Ticonderoga', 'Daring', 'Ford', 'U212', 'Virginia'];   // config.js PLAYABLE
const OLD = ['Bismarck', 'Yamato', 'Fletcher', 'Iowa', 'Scharnhorst'];
if (process.env.SHOTS) mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message + ' ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
page.on('requestfailed', r => errors.push('REQUESTFAILED: ' + r.url()));
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const shot = (name) => process.env.SHOTS ? page.screenshot({ path: `${OUT}/v2-boot-${name}-${VW}.png` }) : null;

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 20000 }).catch(() => {});
await wait(900);

// ---- menu: both base missions listed, the new roster on the ship cards, nothing of the old one
{
   await page.click('[data-nat="all"]').catch(() => {});      // one tab per navy; "Alle" shows the whole line-up
   await wait(200);
   const menu = await ev(() => ({
      phase: typeof window.__phase === 'function' ? window.__phase() : null,
      mis: [...document.querySelectorAll('[data-mis]')].map(e => e.dataset.mis),
      ships: [...document.querySelectorAll('[data-ship]')].map(e => e.dataset.ship),
      bad: /undefined|NaN/.test(document.querySelector('.m3-list')?.innerText || ''),
   }));
   check('page boots into the menu', menu.phase === 'menu', menu.phase);
   check('menu lists the base missions', ids.every(id => menu.mis.includes(id)), menu.mis);
   check('menu shows the new roster', ROSTER.every(k => menu.ships.includes(k)) && !OLD.some(k => menu.ships.includes(k)), menu.ships.length + ' ships: ' + menu.ships.join(','));
   check('mission list has no undefined/NaN', !menu.bad);
   check('menu: no console errors', errors.length === 0, errors.slice(0, 3));
   await shot('menu');
}

for (const id of ids) {
   const e0 = errors.length;
   if (await ev(() => window.__phase() !== 'menu')) {
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 20000 }).catch(() => {});
      await wait(700);
   }
   await page.click(`[data-mis="${id}"]`);
   await wait(200);
   await page.keyboard.press('Enter');
   let ok = await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 6000 }).then(() => true, () => false);
   if (!ok) {                                   // a briefing screen or a locked card in the way: start directly
      await ev((id) => { window.__start({ mission: id, difficulty: 'normal' }); }, id);
      ok = await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 15000 }).then(() => true, () => false);
   }
   const st = await ev(() => { const w = window.__world(); return { id: w?.mission?.id, ship: w?.player?.cls, ships: w?.ships.length, sites: w?.sites?.length }; });
   check(`${id}: battle started`, ok && st.id === id, st);
   for (const k of ['w', 'w', 'w']) await page.keyboard.press(k);
   await wait(3000);
   // put the new things in front of the renderer: a missile each way, a decoy cloud, a rocket-free
   // cruise missile at a land position if the mission has one (all through the public sim API)
   const fired = await ev(async () => {
      const w = window.__world(), p = w.player;
      const M = await import('./gamev2/missile.js');
      const out = { ssm: null, cruise: null, decoy: false, sites: w.sites.length };
      const foe = w.ships.filter(s => s.alive && s.side !== p.side).sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))[0];
      if (foe) {
         const m = M.launchSSM(w, p, { bearing: Math.atan2(foe.pos.y - p.pos.y, foe.pos.x - p.pos.x) });
         out.ssm = m ? m.type : M.ssmBlock(w, p, { bearing: 0 });
      }
      const site = w.sites.find(s => s.alive && s.side !== p.side);
      if (site) { const m = M.launchCruise(w, p, { siteId: site.id }); out.cruise = m ? m.type : 'blocked'; }
      out.decoy = !!M.deployDecoys(w, p);
      out.missiles = w.missiles.length;
      return out;
   });
   check(`${id}: missiles and decoys through the sim in the browser`, fired.missiles >= 0, fired);
   await wait(2500);
   await shot(id + '-battle');
   await page.keyboard.press('m'); await wait(600);
   await shot(id + '-map');
   await page.keyboard.press('m');
   await wait(Math.max(0, RUN_S * 1000 - 6500));
   const hud = await ev(() => {
      const w = window.__world(), o = document.getElementById('objectives');
      return { t: +w.time.toFixed(1), phase: window.__phase(), objs: o ? [...o.querySelectorAll('.obj')].map(e => e.textContent) : [], missiles: w.missiles.length,
         ev: [...new Set(w.events.map(e => e.type))].join(','), fps: window.__fps ? window.__fps() : null };
   });
   check(`${id}: sim ran ${RUN_S} s`, hud.t > RUN_S * 0.5, hud);
   check(`${id}: objectives readable`, hud.objs.every(t => t && !/undefined|NaN/.test(t)), hud.objs.length);
   check(`${id}: no console errors`, errors.length === e0, errors.slice(e0, e0 + 4));
}

console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 12)) console.log(' -', e);
await browser.close();
process.exit(errors.length || results.some(r => !r.ok) ? 1 : 0);
