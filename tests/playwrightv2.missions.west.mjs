// tests/playwrightv2.missions.west.mjs -- browser check of the five western operations (gamev2/missions_west.js):
// every operation is listed in the menu with its data, starts from the menu on desktop (1440x810) and on a
// phone in landscape (844x390), runs RUN_S seconds (default 30) without a console error and shows its
// objectives on screen. Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8830   then   URLV2=http://localhost:8830/index-v2.html node tests/playwrightv2.missions.west.mjs
//       (MISSIONS=a,b to limit, VIEWS=desktop,phone, RUN_S=seconds, NO_GPU=1 for software GL, SHOTS=0 for no screenshots)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8830/index-v2.html';
const OUT = process.env.OUT || 'tests/shots';
const RUN_S = Number(process.env.RUN_S) || 30;
const ids = (process.env.MISSIONS || 'hormus,redsea,pipeline,blacksea,giuk').split(',');
const VIEWS = { desktop: { width: 1440, height: 810, touch: false }, phone: { width: 844, height: 390, touch: true } };
const views = (process.env.VIEWS || 'desktop,phone').split(',');
const SHOTS = process.env.SHOTS !== '0';
if (SHOTS) mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });

for (const view of views) {
   const V = VIEWS[view];
   const ctx = await browser.newContext({ viewport: { width: V.width, height: V.height }, hasTouch: V.touch });
   const page = await ctx.newPage();
   page.on('console', m => { if (m.type() === 'error') errors.push(`[${view}] ` + m.text().slice(0, 400)); });
   page.on('pageerror', e => errors.push(`[${view}] PAGEERROR: ` + e.message + ' ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
   page.on('requestfailed', r => errors.push(`[${view}] REQUESTFAILED: ` + r.url()));
   await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
   const ev = (fn, arg) => page.evaluate(fn, arg);
   const wait = ms => page.waitForTimeout(ms);
   const shot = (name) => SHOTS ? page.screenshot({ path: `${OUT}/v2-west-${name}-${V.width}.png` }) : null;
   // the touch note ("Gebaut für Maus und Tastatur") covers the page on a touch device until it is acknowledged
   const dismiss = async () => {
      if (!(await page.locator('#tu-hint-ok').isVisible().catch(() => false))) return;
      await page.click('#tu-hint-never').catch(() => {});
      await page.click('#tu-hint-ok').catch(() => {});
      await wait(200);
   };
   const toMenu = async () => {
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 20000 }).catch(() => {});
      await wait(800);
      await dismiss();
   };
   await toMenu();
   {
      const menu = await ev(() => ({
         mis: [...document.querySelectorAll('[data-mis]')].map(e => ({ id: e.dataset.mis, text: e.innerText })),
         bad: /undefined|NaN/.test(document.body.innerText || ''),
      }));
      const listed = menu.mis.map(m => m.id);
      check(`${view}: menu lists the five operations`, ids.every(id => listed.includes(id)), listed);
      check(`${view}: menu entries carry a name`, ids.every(id => (menu.mis.find(m => m.id === id)?.text || '').trim().length > 5));
      check(`${view}: menu has no undefined/NaN`, !menu.bad);
      await page.locator(`[data-mis="${ids[0]}"]`).scrollIntoViewIfNeeded().catch(() => {});
      await shot('menu');
   }

   for (const id of ids) {
      const e0 = errors.length;
      if (await ev(() => window.__phase() !== 'menu')) await toMenu();
      const card = page.locator(`[data-mis="${id}"]`);
      await dismiss();
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await card.click();
      await wait(300);
      if (SHOTS && view === 'desktop') await shot(id + '-menu');
      await page.keyboard.press('Enter');
      await wait(400); await dismiss();
      let how = 'menu';
      // operations open a briefing first: it must show the text, its "go" button (or Enter) casts off
      const go = page.locator('[data-op="go"]');
      if (await go.isVisible().catch(() => false)) {
         const txt = await ev(() => document.querySelector('[data-op="go"]').closest('.m3-intro, .m3-op, div[class*="intro"]')?.innerText || document.body.innerText);
         check(`${view} ${id}: briefing shown`, txt.length > 80 && !/undefined|NaN/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 90));
         await shot(id + '-briefing');
         await go.click();
      }
      let ok = await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 8000 }).then(() => true, () => false);
      if (!ok) {                                   // still not under way: start directly (reported as a failed check below)
         how = 'direct';
         await ev((id) => { window.__start({ mission: id, difficulty: 'normal' }); }, id);
         ok = await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 15000 }).then(() => true, () => false);
      }
      const st = await ev(() => { const w = window.__world(); return { id: w?.mission?.id, ship: w?.player?.cls, ships: w?.ships.length, sites: w?.sites?.length, zones: w?.mission?.zones?.length }; });
      check(`${view} ${id}: started from the menu`, ok && st.id === id && how === 'menu', { ...st, how });
      for (const k of ['w', 'w', 'w']) await page.keyboard.press(k);
      await wait(3000);
      // (a touch HUD fades the objectives out a few seconds after each change: they are judged while fresh)
      const seen = await ev(() => { const o = document.getElementById('objectives'); return !!o && +getComputedStyle(o).opacity > 0.5 && o.getBoundingClientRect().height > 10; });
      await shot(id + '-start');
      await wait(3000);
      await shot(id + '-battle');
      await page.keyboard.press('m'); await wait(700);
      await shot(id + '-map');
      await page.keyboard.press('m');
      await wait(Math.max(0, RUN_S * 1000 - 7700));
      const hud = await ev(() => {
         const w = window.__world(), o = document.getElementById('objectives');
         const r = o ? o.getBoundingClientRect() : null, cs = o ? getComputedStyle(o) : null;
         return {
            t: +w.time.toFixed(1), phase: window.__phase(),
            objs: o ? [...o.querySelectorAll('.obj')].map(e => e.textContent) : [],
            visible: !!r && r.width > 40 && r.height > 10 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && cs.display !== 'none' && cs.visibility !== 'hidden',
            opacity: cs ? +cs.opacity : 0,
            box: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
            want: w.mission.objectives.length, fps: window.__fps ? window.__fps() : null,
         };
      });
      await shot(id + '-30s');
      check(`${view} ${id}: sim ran ${RUN_S} s`, hud.t > RUN_S * 0.5 && hud.phase === 'playing', { t: hud.t, phase: hud.phase, fps: hud.fps });
      check(`${view} ${id}: objectives text visible`, hud.visible && (seen || hud.opacity > 0.5) && hud.objs.length === hud.want && hud.objs.every(t => t && t.trim().length > 8 && !/undefined|NaN/.test(t)), { box: hud.box, n: hud.objs.length, atStart: seen, opacityAt30s: hud.opacity, first: hud.objs[0] });
      check(`${view} ${id}: no console errors`, errors.length === e0, errors.slice(e0, e0 + 4));
   }
   await ctx.close();
}

console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 12)) console.log(' -', e);
await browser.close();
process.exit(errors.length || results.some(r => !r.ok) ? 1 : 0);
