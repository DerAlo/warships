// tests/playwrightv2.missions.speciala.mjs -- browser check of the special operations, set A (gamev2/missions_special_a.js):
// every operation is listed in the menu (and its card can be scrolled into view with the longer list), starts
// from the menu on desktop (1440x810) and on a phone in landscape (844x390), runs RUN_S seconds (default 30)
// without a console error, shows its objectives and radio traffic, and its special rule can be triggered.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8871   then   URLV2=http://localhost:8871/index-v2.html node tests/playwrightv2.missions.speciala.mjs
//       (MISSIONS=a,b to limit, VIEWS=desktop,phone, RUN_S=seconds, NO_GPU=1 for software GL, SHOTS=0 for no screenshots)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8871/index-v2.html';
const OUT = process.env.OUT || 'tests/shots';
const RUN_S = Number(process.env.RUN_S) || 30;
const ids = (process.env.MISSIONS || 'cable,rig').split(',');
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
   const shot = (name) => SHOTS ? page.screenshot({ path: `${OUT}/v2-speciala-${name}-${V.width}.png` }) : null;
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
      check(`${view}: menu lists the operations`, ids.every(id => listed.includes(id)), listed);
      check(`${view}: menu entries carry a name`, ids.every(id => (menu.mis.find(m => m.id === id)?.text || '').trim().length > 5));
      check(`${view}: menu has no undefined/NaN`, !menu.bad);
      // the list has grown: every operation card (the last one too) can be brought fully into view
      const cards = await ev(() => [...document.querySelectorAll('[data-mis]')].map(e => e.dataset.mis));
      let reach = 0;
      for (const id of cards) {
         await page.locator(`[data-mis="${id}"]`).scrollIntoViewIfNeeded().catch(() => {});
         if (await ev((id) => { const r = document.querySelector(`[data-mis="${id}"]`).getBoundingClientRect(); return r.height > 10 && r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1; }, id)) reach++;
      }
      check(`${view}: all ${cards.length} mission cards can be scrolled into view`, reach === cards.length, { reach, n: cards.length });
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
            threat: !!document.querySelector('body.touch #mx-threat:not(.hidden)'),      // a phone gives the band to an incoming salvo (touch3d.js)
            want: w.mission.objectives.length, fps: window.__fps ? window.__fps() : null,
         };
      });
      await shot(id + '-30s');
      check(`${view} ${id}: sim ran ${RUN_S} s`, hud.t > RUN_S * 0.5 && hud.phase === 'playing', { t: hud.t, phase: hud.phase, fps: hud.fps });
      check(`${view} ${id}: objectives text visible`, (hud.visible || (hud.threat && seen)) && (seen || hud.opacity > 0.5) && hud.objs.length === hud.want && hud.objs.every(t => t && t.trim().length > 8 && !/undefined|NaN/.test(t)), { box: hud.box, n: hud.objs.length, atStart: seen, opacityAt30s: hud.opacity, first: hud.objs[0] });
      if (id === 'cable') {
         // radio traffic of the first half minute, then the special rule: alongside the dragging ship the lookout
         // identifies it and the boarding team goes over (the test holds the ship there for a few seconds)
         const res = await ev(() => new Promise(done => {
            const w = window.__world(), S = w._script, p = w.player, m = w.shipById(S.susId);
            for (const id of S.boats) { const b = w.shipById(id); if (b) { b.pos.x = 9000; b.pos.y = -9000; } }
            const t0 = performance.now();
            const hold = () => {
               p.pos.x = m.pos.x - Math.sin(m.heading) * 300; p.pos.y = m.pos.y + Math.cos(m.heading) * 300; p.heading = m.heading; p.speed = m.speed;
               if (performance.now() - t0 < 6000 && w.phase === 'playing') requestAnimationFrame(hold);
               else done({ found: S.found, board: S.board, need: S.need, find: w.mission.objectives.find(o => o.id === 'find').state, stop: w.mission.objectives.find(o => o.id === 'stop').text, phase: w.phase });
            };
            hold();
         }));
         const banner2 = await ev(() => document.body.innerText);
         check(`${view} cable: radio traffic says what to do at that moment`, /Ausguck: .*Ankerschlepper/.test(banner2) && /Boardingteam: Wir setzen/.test(banner2), (banner2.match(/Boardingteam.{0,70}/) || [''])[0]);
         await shot(id + '-boarding');
         check(`${view} cable: alongside, the dragging ship is identified and boarding counts up`, res.found && res.find === 'done' && res.board > 1 && /Boarding/.test(res.stop), res);
         const objs = await ev(() => [...document.querySelectorAll('#objectives .obj')].map(e => e.textContent).join(' | '));
         check(`${view} cable: the objective shows the boarding progress`, /längsseits/.test(objs) && /Kabel hält noch/.test(objs), objs.slice(0, 200));
      }
      if (id === 'rig') {
         // the special moment: the boats are gone from the platform, the ship lies stopped inside the circle with the
         // platform ahead, and the boarding team goes over by itself (the test holds the ship there for a few seconds)
         const res = await ev(() => new Promise(done => {
            const w = window.__world(), S = w._script, p = w.player;
            const plat = w.sites.find(s => s.id === S.platId);
            const t0 = performance.now();
            const hold = () => {
               S.boats.forEach((id, k) => { const b = w.shipById(id); if (b && b.alive) { b.pos.x = 10500; b.pos.y = -10500 + k * 300; b.ai.anchored = true; } });
               p.pos.x = plat.pos.x - 520; p.pos.y = plat.pos.y - 60; p.heading = 0.1; p.speed = 0; p.setTelegraph(0);
               if (window.__setAim) window.__setAim(0, 520);      // the view on the platform
               if (performance.now() - t0 < 6000 && w.phase === 'playing') requestAnimationFrame(hold);
               else done({ model: plat.model, hidden: !plat.detected && !plat.targetable, hp: plat.hp === plat.maxHp, teams: w.teams.map(t => t.state), left: S.teamsLeft, board: w.mission.objectives.find(o => o.id === 'board').text, phase: w.phase });
            };
            hold();
         }));
         const text = await ev(() => document.body.innerText);
         check(`${view} rig: radio traffic says what happens at that moment`, /Boardingteam: Wir setzen von/.test(text), (text.match(/Boardingteam: .{0,90}/) || [''])[0]);
         await shot(id + '-boarding');
         check(`${view} rig: stopped in the circle with no boat at the platform, the team goes over`, res.phase === 'playing' && res.model === 'platform' && res.hidden && res.hp && res.teams[0] === 'out' && /setzt über/.test(res.board), res);
         const objs = await ev(() => [...document.querySelectorAll('#objectives .obj')].map(e => e.textContent).join(' | '));
         check(`${view} rig: the objective shows the crossing and the valve clock`, /setzt über/.test(objs) && /Ventile in/.test(objs), objs.slice(0, 200));
      }
      check(`${view} ${id}: no console errors`, errors.length === e0, errors.slice(e0, e0 + 4));
   }
   await ctx.close();
}

console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 12)) console.log(' -', e);
await browser.close();
process.exit(errors.length || results.some(r => !r.ok) ? 1 : 0);
