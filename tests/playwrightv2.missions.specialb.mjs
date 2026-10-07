// tests/playwrightv2.missions.specialb.mjs -- browser check of the special operations (gamev2/missions_special_b.js).
// Every mission is started from the menu (mission card -> AUSLAUFEN -> briefing -> AUSLAUFEN) on a
// desktop (1440x810) and on a phone held sideways (844x390), runs 30 s and must show its objectives
// without a single console error; then the mission's special rule is triggered (hijack: alongside the
// tanker the boarding clock runs). The operations list of the menu is checked for reach with all entries.
// Screenshots: tests/shots/v2-specialb-<mission>-<view>.png (+ briefing, menu, rule).
//
// Run:  node server.js 8831   then   node tests/playwrightv2.missions.specialb.mjs
//       (URLV2, OUT, RUN_S, ONLY=hijack,... and VIEWS=desktop,phone to limit; NO_GPU=1 for software GL)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8831/index-v2.html';
const OUT = process.env.OUT || 'tests/shots';
const RUN_S = +(process.env.RUN_S || 30);
const IDS = (process.env.ONLY || 'hijack').split(',');
const VIEWS = { desktop: { w: 1440, h: 810, touch: false }, phone: { w: 844, h: 390, touch: true } };
const ONLY_VIEWS = (process.env.VIEWS || 'desktop,phone').split(',');
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const GPU = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: GPU });

for (const view of ONLY_VIEWS) {
   const V = VIEWS[view];
   for (const id of IDS) {
      const tag = id + '/' + view, e0 = errors.length;
      const ctx = await browser.newContext({ viewport: { width: V.w, height: V.h }, hasTouch: V.touch, isMobile: V.touch });
      const page = await ctx.newPage();
      page.on('console', m => { if (m.type() === 'error') errors.push(tag + ': ' + m.text().slice(0, 400)); });
      page.on('pageerror', e => errors.push(tag + ' PAGEERROR: ' + e.message + ' ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
      page.on('requestfailed', r => errors.push(tag + ' REQUESTFAILED: ' + r.url()));
      await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
      const ev = (fn, arg) => page.evaluate(fn, arg);
      const wait = ms => page.waitForTimeout(ms);
      const press = (sel) => (V.touch ? page.tap(sel, { timeout: 5000 }) : page.click(sel, { timeout: 5000 })).then(() => true, () => false);
      await page.goto(URL + '?nohint', { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 30000 });
      await wait(700);

      // ---- the operations list with the new entries: every card can be brought into view and tapped
      const menu = await ev(() => {
         const cards = [...document.querySelectorAll('[data-mis]')], out = { n: cards.length, bad: [] };
         for (const c of cards) {
            c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            const b = c.getBoundingClientRect(), hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            if (!(b.width > 20 && b.height > 12 && b.top >= 0 && b.bottom <= innerHeight + 1 && b.left >= 0 && b.right <= innerWidth + 1 && hit && c.contains(hit))) out.bad.push(c.dataset.mis);
         }
         return out;
      });
      check(`${tag}: every operation card of the menu can be reached (${menu.n})`, menu.n >= 11 && !menu.bad.length, menu.bad);
      await ev((id) => document.querySelector(`[data-mis="${id}"]`)?.scrollIntoView({ block: 'center' }), id);
      await wait(200);
      await page.screenshot({ path: `${OUT}/v2-specialb-${id}-${view}-menu.png` });

      // ---- the menu way: mission card, a ship in service, AUSLAUFEN, briefing, AUSLAUFEN
      const listed = await ev((id) => !!document.querySelector(`[data-mis="${id}"]`), id);
      check(`${tag}: listed in the menu`, listed);
      let how = 'menu';
      await press(`[data-mis="${id}"]`);
      await wait(300);
      if (await ev(() => document.querySelector('[data-act="battle"]')?.disabled)) {
         // the remembered ship is not in service in a fresh profile: take the first allowed one that is
         await press('[data-nat="all"]'); await wait(200);
         await press('.m3-card[data-ship]:not(.off):not(.lock)'); await wait(300);
      }
      await press('[data-act="battle"]');
      await wait(500);
      const intro = await ev(() => { const b = document.querySelector('[data-op="go"]'); const p = b && b.closest('div[class]')?.parentElement; return b ? (p || b).innerText.slice(0, 600) : null; });
      check(`${tag}: briefing screen`, !!intro && !/undefined|NaN/.test(intro), intro ? intro.replace(/\s+/g, ' ').slice(0, 90) : 'none');
      if (intro) { await page.screenshot({ path: `${OUT}/v2-specialb-${id}-${view}-briefing.png` }); await press('[data-op="go"]'); }
      let ok = await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 15000 }).then(() => true, () => false);
      if (!ok) {                                    // no ship of this mission in service: start directly
         how = 'direct';
         await ev((id) => { window.__start({ mission: id, difficulty: 'normal' }); }, id);
         ok = await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 20000 }).then(() => true, () => false);
      }
      const st = ok ? await ev(() => { const w = window.__world(); return { id: w.mission.id, ship: w.player.cls, ships: w.ships.length, sites: w.sites.length }; }) : {};
      check(`${tag}: battle started (${how})`, ok && st.id === id, st);
      check(`${tag}: started from the menu`, how === 'menu');
      if (!ok) { await ctx.close(); continue; }

      // (on a phone the objectives fade a few seconds after every change: they are measured while fresh)
      const measure = () => ev(() => {
         const w = window.__world(), o = document.getElementById('objectives');
         const r = o ? o.getBoundingClientRect() : null, cs = o ? getComputedStyle(o) : null;
         return { t: +w.time.toFixed(1), phase: window.__phase(), objs: o ? [...o.querySelectorAll('.obj')].map(e => e.textContent.trim()) : [],
            world: w.mission.objectives.map(x => x.text),
            box: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
            shown: !!(r && r.width > 20 && r.height > 8 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.2 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1),
            radio: w.events.filter(e => e.type === 'objective').length };
      });
      await wait(2500);
      const early = await measure();
      await wait(3500);
      await page.screenshot({ path: `${OUT}/v2-specialb-${id}-${view}.png` });
      await wait(Math.max(0, RUN_S * 1000 - 6000));
      const late = await measure();
      const hud = { ...late, shown: early.shown || late.shown, box: early.box, objs: early.objs.length ? early.objs : late.objs };
      check(`${tag}: sim ran ${RUN_S} s`, hud.t > RUN_S * 0.5 && hud.phase === 'playing', { t: hud.t, phase: hud.phase });
      check(`${tag}: objectives text visible`, hud.shown && hud.objs.length >= 2 && hud.objs.every(t => t && !/undefined|NaN/.test(t)), { box: hud.box, objs: hud.objs });
      check(`${tag}: radio message arrived`, hud.radio >= 1, hud.radio);
      await page.screenshot({ path: `${OUT}/v2-specialb-${id}-${view}-30s.png` });
      // ---- the special rule
      if (id === 'hijack') {
         // alongside the tanker at its speed, no boat near: the boarding clock runs and the objective counts
         const rule = await ev(async () => {
            const w = window.__world(), S = w._script, t = w.shipById(S.tankId), p = w.player;
            for (const s of w.ships.slice()) if (s.alive && s.side === 'enemy' && s !== t) w.removeShip(s, 'test');
            const put = () => { p.pos.x = t.pos.x - Math.sin(t.heading) * 350; p.pos.y = t.pos.y + Math.cos(t.heading) * 350; p.heading = t.heading; p.speed = t.speed; };
            const t0 = performance.now();
            while (performance.now() - t0 < 5000 && S.board < 3) { put(); await new Promise(r => setTimeout(r, 50)); }
            return { board: +S.board.toFixed(1), text: w.mission.objectives.find(o => o.id === 'board').text, hud: [...document.querySelectorAll('#objectives .obj')].map(e => e.textContent.trim())[0] || '' };
         });
         check(`${tag}: alongside the tanker the boarding clock runs`, rule.board >= 3 && /Entern/.test(rule.text), rule);
         await wait(400);
         await page.screenshot({ path: `${OUT}/v2-specialb-${id}-${view}-rule.png` });
      }
      check(`${tag}: no console errors`, errors.length === e0, errors.slice(e0, e0 + 4));
      await ctx.close();
   }
}

await browser.close();
const bad = results.filter(r => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 12)) console.log(' -', e);
process.exit(bad.length || errors.length ? 1 : 0);
