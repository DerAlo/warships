// tests/playwright3d.fleet.mjs -- browser smoke test of the enlarged fleet: the port shows the
// whole roster in nation tabs without overflow (1440x810 and 1920x1080), every new ship can be
// researched, selected and taken into a battle, and gets a beam + quarter screenshot in tests/shots/.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8771   then   URL3D=http://localhost:8771/index-3d.html node tests/playwright3d.fleet.mjs
// SHIPS=Yamato,Iowa limits the battle part to those ships.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { PLAYABLE, SHIPS, NATIONS } from '../game3d/config.js';
import { UNLOCK_REQ, UNLOCK_XP } from '../game3d/progress3d.js';

const URL = process.env.URL3D || 'http://localhost:8771/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const NEW_SHIPS = ['Gneisenau', 'Warspite', 'Iowa', 'Cleveland', 'Fletcher', 'Yamato', 'Shimakaze', 'Richelieu', 'Algerie', 'LeFantasque', 'Littorio', 'Zara', 'Kirov', 'Gnevny'];
const todo = process.env.SHIPS ? process.env.SHIPS.split(',') : NEW_SHIPS;
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   if (!ok || process.env.VERBOSE) console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};

const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const hook = (page) => {
   page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
   page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
};

// ---- port: fresh profile, both resolutions
for (const [vw, vh] of [[1440, 810], [1920, 1080]]) {
   const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
   const page = await ctx.newPage(); hook(page);
   await page.goto(URL);
   await page.waitForSelector('.m3-card');
   const tag = `${vw}x${vh}`;
   const tabs = await page.evaluate(() => [...document.querySelectorAll('.m3-tabs [data-nat]')].map(e => e.dataset.nat));
   check(`${tag} nation tabs`, tabs.join() === [...NATIONS, 'all'].join(), tabs);
   const seen = new Set();
   for (const n of NATIONS) {
      await page.click(`.m3-tabs [data-nat="${n}"]`);
      const r = await page.evaluate(() => {
         const car = document.querySelector('.m3-car'), cr = car.getBoundingClientRect();
         const cards = [...car.querySelectorAll('.m3-card')];
         return {
            // the fleet register is a vertical list: one navy fits without scrolling either way
            keys: cards.map(c => c.dataset.ship), fits: car.scrollWidth <= car.clientWidth + 1 && car.scrollHeight <= car.clientHeight + 1,
            inside: cards.every(c => { const b = c.getBoundingClientRect(); return b.left >= cr.left - 1 && b.right <= cr.right + 1 && b.bottom <= innerHeight; }),
            clipped: cards.filter(c => { const h = c.querySelector('.hd'); return h.scrollWidth > h.clientWidth + 1; }).map(c => c.dataset.ship),
            page: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
            tabsH: document.querySelector('.m3-tabs').getBoundingClientRect().height,
         };
      });
      r.keys.forEach(k => seen.add(k));
      check(`${tag} ${n} cards fit without scrolling`, r.fits && r.inside, r);
      check(`${tag} ${n} no page overflow, tabs on one line`, r.page && r.tabsH < 40, r);
      check(`${tag} ${n} cards are this navy`, r.keys.length >= 2 && r.keys.every(k => SHIPS[k].hull.nation === n), r.keys);
      if (n === 'uk' || n === 'jp') await page.screenshot({ path: `${OUT}/fleet-port-${tag}-${n}.png` });
   }
   check(`${tag} all playable ships have a card`, PLAYABLE.every(k => seen.has(k)), PLAYABLE.filter(k => !seen.has(k)));
   await page.click('.m3-tabs [data-nat="all"]');
   const all = await page.evaluate(() => {
      const car = document.querySelector('.m3-car');
      return { n: car.querySelectorAll('.m3-card').length, groups: car.querySelectorAll('.m3-nat').length, scroll: car.scrollHeight > car.clientHeight,
         page: document.documentElement.scrollWidth <= innerWidth, locked: car.querySelectorAll('.m3-card.lock').length };
   });
   check(`${tag} "Alle" lists the whole roster in a scrolling strip`, all.n === PLAYABLE.length && all.groups === NATIONS.length && all.scroll && all.page, all);
   check(`${tag} fresh profile: everything but the two starters is locked`, all.locked === PLAYABLE.filter(k => UNLOCK_XP[k]).length, all);
   // a locked ship can be inspected: panel with tier, description and price, battle button disabled
   await page.click('.m3-tabs [data-nat="jp"]');
   await page.click('.m3-card[data-ship="Yamato"]');
   const pan = await page.evaluate(() => ({
      cl: document.querySelector('.m3-ship .cl')?.textContent || '', ds: document.querySelector('.m3-ship .ds')?.textContent || '',
      btn: document.querySelector('[data-act="unlock"]')?.textContent || '', hint: document.querySelector('.m3-prog .hint')?.textContent || '',
      dis: document.querySelector('.m3-battle').disabled,
      over: (() => { const e = document.querySelector('.m3-ship'); return e.scrollWidth > e.clientWidth + 1; })(),
   }));
   check(`${tag} locked ship panel`, /Stufe 10/.test(pan.cl) && pan.ds.length > 30 && /EP/.test(pan.btn) && /Mark/.test(pan.btn) && /Erfordert Kirishima/.test(pan.hint) && pan.dis && !pan.over, pan);
   await page.screenshot({ path: `${OUT}/fleet-port-${tag}-locked.png` });
   await page.click('.m3-tabs [data-nat="all"]');
   await page.screenshot({ path: `${OUT}/fleet-port-${tag}-all.png` });
   await ctx.close();
}

// ---- research + battle with every new ship (rich profile)
{
   const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 } });
   await ctx.addInitScript(() => {
      HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); };
      if (!localStorage.getItem('warships3d.profile.v1')) localStorage.setItem('warships3d.profile.v1', JSON.stringify({ v: 1, xp: 2000000, totalXp: 2000000, credits: 20000000, unlocked: { Nuernberg: true } }));
   });
   const page = await ctx.newPage(); hook(page);
   const research = async (k) => {
      if (UNLOCK_REQ[k]) await research(UNLOCK_REQ[k]);
      await page.click(`.m3-tabs [data-nat="${SHIPS[k].hull.nation}"]`);
      await page.click(`.m3-card[data-ship="${k}"]`);
      if (await page.$('[data-act="unlock"]')) await page.click('[data-act="unlock"]:not([disabled])', { timeout: 3000 });
   };
   for (const k of todo) {
      const before = errors.length;
      await page.goto(URL);
      await page.waitForSelector('.m3-card');
      await page.click('[data-mis="standard"]');
      await research(k);
      const sel = await page.evaluate((k) => ({
         sel: document.querySelector('.m3-card.sel')?.dataset.ship, lock: !!document.querySelector(`.m3-card.lock[data-ship="${k}"]`),
         name: document.querySelector('.m3-ship .nm')?.textContent, dis: document.querySelector('.m3-battle').disabled,
      }), k);
      check(`${k} researched and selected in port`, sel.sel === k && !sel.lock && !sel.dis && sel.name === SHIPS[k].name, sel);
      await page.click('.m3-battle');
      let ok = false;
      for (let i = 0; i < 100 && !ok; i++) { ok = await page.evaluate(() => window.__phase() === 'playing' && !!window.__world()?.player); if (!ok) await page.waitForTimeout(200); }
      const st = ok ? await page.evaluate(() => { const w = window.__world(), p = w.player; return { key: p.cfg.key, turrets: p.turrets.length, ships: w.ships.length, hp: p.hp }; }) : null;
      check(`${k} battle starts`, ok && st.key === k && st.turrets === SHIPS[k].main.turrets.length && st.ships >= 6, st);
      if (!ok) continue;
      await page.addStyleTag({ content: '#hud, .hud, #hud3d, .overlay { visibility:hidden !important; }' });
      await page.waitForTimeout(2500);
      const L = SHIPS[k].hull.L;
      for (const [view, ang, dist, hgt] of [['side', Math.PI / 2, 1.9, 0.09], ['quarter', 0.62, 1.25, 0.42]]) {
         await page.evaluate(({ ang, d, h, L }) => {
            const p = window.__world().player, a = p.heading + ang;
            window.__cam3.override = { px: p.pos.x + Math.cos(a) * d, py: h, pz: p.pos.y + Math.sin(a) * d, tx: p.pos.x, ty: L * 0.035, tz: p.pos.y, fov: 30 };
         }, { ang, d: L * dist, h: Math.max(14, L * dist * hgt), L });
         await page.waitForTimeout(350);
         // re-aim once more so the moving ship is centred in the frame that gets captured
         await page.evaluate(({ ang, d, h, L }) => {
            const p = window.__world().player, a = p.heading + ang, o = window.__cam3.override;
            Object.assign(o, { px: p.pos.x + Math.cos(a) * d, py: h, pz: p.pos.y + Math.sin(a) * d, tx: p.pos.x, tz: p.pos.y });
         }, { ang, d: L * dist, h: Math.max(14, L * dist * hgt), L });
         await page.waitForTimeout(120);
         await page.screenshot({ path: `${OUT}/fleet-${k}-${view}.png` });
      }
      const alive = await page.evaluate(() => { const w = window.__world(); return w.ships.every(s => Number.isFinite(s.pos.x) && Number.isFinite(s.hp)) && window.__phase(); });
      check(`${k} sim state finite after 3 s`, alive === 'playing', alive);
      check(`${k} no console errors`, errors.length === before, errors.slice(before));
      console.log(`${k}: ok`);
   }
   await ctx.close();
}
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, ${errors.length} console errors`);
for (const e of errors.slice(0, 20)) console.log('  ERR ' + e);
process.exit(failed.length || errors.length ? 1 : 0);
