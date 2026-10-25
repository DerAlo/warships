// tests/playwrightv2.missions.specialc.mjs -- browser check of the special operations set D (gamev2/missions_special_d.js:
// mayday, gunline, airbase). Every mission is started from the menu (mission card -> AUSLAUFEN -> briefing ->
// AUSLAUFEN) on a desktop (1440x810) and on a phone held sideways (844x390), runs RUN_S s and must show its
// objectives without a single console error; then the mission's special rule is triggered (mayday: lying stopped
// at the raft with no boat near the pickup counter runs; gunline: the first fire mission opens and its target is on
// the chart; airbase: a SAM site that fires is located and put on the chart).
// Screenshots: OUT/v2-specialc-<mission>-<view>.png (+ briefing, rule).
//
// Run:  node server.js 8931   then   URLV2=http://localhost:8931/index-v2.html node tests/playwrightv2.missions.specialc.mjs
//       (OUT, RUN_S, ONLY=mayday,... and VIEWS=desktop,phone to limit; NO_GPU=1 for software GL)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8931/index-v2.html';
const OUT = process.env.OUT || 'tests/shots';
const RUN_S = +(process.env.RUN_S || 8);
const IDS = (process.env.ONLY || 'mayday,gunline,airbase').split(',');
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

      // ---- the menu way: mission card, a ship in service, AUSLAUFEN, briefing, AUSLAUFEN
      const listed = await ev((id) => !!document.querySelector(`[data-mis="${id}"]`), id);
      check(`${tag}: listed in the menu`, listed);
      await ev((id) => document.querySelector(`[data-mis="${id}"]`)?.scrollIntoView({ block: 'center' }), id);
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
      if (intro) { await page.screenshot({ path: `${OUT}/v2-specialc-${id}-${view}-briefing.png` }); await press('[data-op="go"]'); }
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
            box: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
            shown: !!(r && r.width > 20 && r.height > 8 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.2 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1),
            threat: !!document.querySelector('body.touch #mx-threat:not(.hidden)'),
            radio: w.events.filter(e => e.type === 'objective').length };
      });
      await wait(2500);
      const early = await measure();
      await wait(Math.max(0, RUN_S * 1000 - 2500));
      await page.screenshot({ path: `${OUT}/v2-specialc-${id}-${view}.png` });
      const late = await measure();
      const hud = { ...late, shown: early.shown || late.shown || ((early.threat || late.threat) && !!early.box), box: early.box, objs: early.objs.length ? early.objs : late.objs };
      check(`${tag}: sim ran ${RUN_S} s`, hud.t > RUN_S * 0.5 && hud.phase === 'playing', { t: hud.t, phase: hud.phase });
      check(`${tag}: objectives text visible`, hud.shown && hud.objs.length >= 2 && hud.objs.every(t => t && !/undefined|NaN/.test(t)), { box: hud.box, objs: hud.objs });
      check(`${tag}: radio message arrived`, hud.radio >= 1, hud.radio);
      // ---- the special rule
      let rule = null;
      if (id === 'mayday') {
         // stopped at the raft, no boat near: the pickup counter runs and the objective counts
         rule = await ev(async () => {
            const w = window.__world(), S = w._script, p = w.player;
            for (const s of w.ships.slice()) if (s.alive && s.side === 'enemy') w.removeShip(s, 'test');
            const t0 = performance.now();
            while (performance.now() - t0 < 6000 && S.pick < 3) { p.pos.x = S.raft.x + 150; p.pos.y = S.raft.y; p.speed = 0; p.setTelegraph(0); await new Promise(r => setTimeout(r, 50)); }
            return { pick: S.pick, text: w.mission.objectives.find(o => o.id === 'rescue').text };
         });
         check(`${tag}: at the raft the pickup counter runs`, rule.pick >= 3 && /Netz ausgebracht/.test(rule.text), rule);
      }
      if (id === 'gunline') {
         // the first fire mission opens: its target is marked on the chart
         rule = await ev(async () => {
            const w = window.__world(), S = w._script;
            S.nextT = Math.min(S.nextT, w.time);
            const t0 = performance.now();
            while (performance.now() - t0 < 4000 && !S.open) await new Promise(r => setTimeout(r, 50));
            const s = w.sites.find(x => x.id === S.targets[S.k]);
            return { open: S.open, k: S.k, target: s && s.name, detected: !!(s && s.detected), text: w.mission.objectives.find(o => o.id === 'fire').text };
         });
         check(`${tag}: the first fire mission opens with its target on the chart`, rule.open && rule.k === 0 && rule.detected && /Auftrag 1:/.test(rule.text), rule);
      }
      if (id === 'airbase') {
         // a hidden SAM site that has fired is located
         rule = await ev(async () => {
            const w = window.__world(), S = w._script, s = w.sites.find(x => x.id === S.sams[0]);
            const before = s.detected;
            s.mag.hq16 -= 1;
            const t0 = performance.now();
            while (performance.now() - t0 < 4000 && !s.detected) await new Promise(r => setTimeout(r, 50));
            return { before, after: s.detected, tlam: w.player.mag.tomahawk };
         });
         check(`${tag}: a SAM site that fires is located`, !rule.before && rule.after, rule);
      }
      await wait(400);
      await page.screenshot({ path: `${OUT}/v2-specialc-${id}-${view}-rule.png` });
      check(`${tag}: no console errors`, errors.length === e0, errors.slice(e0, e0 + 4));
      await ctx.close();
   }
}

await browser.close();
const bad = results.filter(r => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 12)) console.log(' -', e);
process.exit(bad.length || errors.length ? 1 : 0);
