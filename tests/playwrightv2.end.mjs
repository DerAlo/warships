// tests/playwrightv2.end.mjs -- the end of a V2 operation in the browser (index-v2.html).
// For one western and one eastern operation a win and a loss are forced (world.end) and the battle
// report is checked at 1440x810 (mouse) and 844x390 (phone, touch): stamp, mission name, reason,
// objectives with their marks, the clasp (stars), the reward table, the three buttons inside the
// screen and large enough, tables and tiles not clipped, no WW2 wording. After a win the clasps show
// on the operation's card in the menu and "next operation" selects the following one, ready to start.
// Screenshots: tests/shots/v2-end-*.png. Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8839   then   URLV2=http://localhost:8839/index-v2.html node tests/playwrightv2.end.mjs
//       (ONLY=desktop,phone and OPS=hormus,reefs to limit; NO_GPU=1 for software GL)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8839/index-v2.html';
const OUT = process.env.OUT || 'tests/shots';
const ONLY = (process.env.ONLY || 'desktop,phone').split(',');
const OPS = (process.env.OPS || 'hormus,reefs').split(',');
const VIEWS = { desktop: { w: 1440, h: 810, touch: false }, phone: { w: 844, h: 390, touch: true } };
const NEXT = { hormus: 'redsea', redsea: 'pipeline', pipeline: 'blacksea', blacksea: 'giuk', giuk: 'barents', barents: 'reefs', reefs: 'strait', strait: 'philsea', philsea: 'countdown' };
// words of the WW2 game that must not show in a modern battle report
const WW2 = /Schlachtschiff|Panzerbrechend|Sprenggranat|Torpedobomber|Sturzkampf|Sturzbomber|Reichsmark|Kriegsmarine|Zitadell|Nebelwand|Flak\b|19[34]\d/;
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const GPU = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: GPU });

// what the battle report shows, and what of it is clipped or outside the screen
const report = page => page.evaluate(() => {
   const R = document.getElementById('end'), q = s => R.querySelector(s), txt = s => q(s)?.textContent.trim() || '';
   const vis = e => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
   const inScreen = e => { const r = e.getBoundingClientRect(); return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; };
   const sheet = q('.m3r-sheet'), body = q('.m3r-body');
   // a table or a tile row wider than the box it sits in is clipped (the boxes scroll only vertically)
   const wide = [...R.querySelectorAll('.m3r-teams table, .m3r-rw table, .m3r-grid, .m3r-obj, .m3r-hist')].filter(e => {
      const r = e.getBoundingClientRect(), b = e.closest('.m3r-box').getBoundingClientRect();
      return r.right > b.right + 1 || r.left < b.left - 1;
   }).map(e => e.className || e.tagName);
   const cutCells = [...R.querySelectorAll('.m3r-teams td.d, .m3r-rw td, .m3r-st b')].filter(e => e.scrollWidth > e.clientWidth + 1).length;
   // everything in the scrolling part can be reached: its last element scrolls into view
   const sc = getComputedStyle(body).overflowY === 'auto' ? body : null;
   return {
      shown: vis(R) && !R.classList.contains('hidden'), cls: R.className, title: txt('.m3r-title'), mis: txt('.m3r-mis'), reason: txt('.m3r-reason'), meta: txt('.m3r-meta'),
      objs: [...R.querySelectorAll('.m3r-obj > div')].map(e => e.className + ':' + e.textContent.trim().slice(0, 1)),
      medal: txt('.m3r-medal'), debrief: txt('.m3r-hist').length,
      rw: [...R.querySelectorAll('.m3r-rw tr')].map(e => e.textContent.replace(/\s+/g, ' ').trim()), earn: txt('.m3r-earn'),
      btns: [...R.querySelectorAll('.m3r-btn')].map(e => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim(), act: e.dataset.act, w: Math.round(r.width), h: Math.round(r.height), in: inScreen(e) }; }),
      sheetIn: inScreen(sheet), headIn: inScreen(q('.m3r-head')), footIn: inScreen(q('.m3r-foot')), bodyH: Math.round(body.getBoundingClientRect().height),
      scrolls: sc ? sc.scrollHeight - sc.clientHeight : [...R.querySelectorAll('.m3r-box')].map(b => b.scrollHeight - b.clientHeight),
      wide, cutCells, rows: R.querySelectorAll('.m3r-teams tr').length, tiles: R.querySelectorAll('.m3r-st').length,
      bad: /undefined|NaN|\[object/.test(R.innerText), text: R.innerText,
   };
});

for (const view of ONLY) {
   const V = VIEWS[view];
   for (const op of OPS) {
      for (const win of [true, false]) {
         const tag = `${view} ${op} ${win ? 'win' : 'loss'}`, T = tag + ': ', e0 = errors.length;
         const ctx = await browser.newContext({ viewport: { width: V.w, height: V.h }, hasTouch: V.touch, isMobile: V.touch });
         const page = await ctx.newPage();
         page.on('console', m => { if (m.type() === 'error') errors.push(tag + ': ' + m.text().slice(0, 300)); });
         page.on('pageerror', e => errors.push(tag + ' PAGEERROR: ' + e.message + ' ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
         page.on('requestfailed', r => errors.push(tag + ' REQUESTFAILED: ' + r.url()));
         await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
         const ev = (fn, arg) => page.evaluate(fn, arg), wait = ms => page.waitForTimeout(ms);
         const press = async sel => { if (V.touch) await page.tap(sel); else await page.click(sel); await wait(500); };
         await page.goto(URL + '?nohint', { waitUntil: 'load' });
         await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 30000 });
         await ev(op => window.__start({ mission: op, difficulty: 'normal' }), op);
         await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 30000 });
         await wait(2500);
         // a little battle first so the tiles carry numbers, then the end: every optional objective met on a win
         const forced = await ev(win => {
            const w = window.__world(), st = w.stats;
            Object.assign(st, { dmg: 48250, kills: 3, ssmFired: 6, ssmHits: 4, missilesDown: 7, sitesDown: 2, shotsFired: 120, hits: 41, tanked: 3900, potential: 21500 });
            if (win) for (const o of w.mission.objectives) if (o.optional && o.state === 'active') o.state = 'done';
            w.end(win, win ? 'Auftrag erfüllt' : 'Zu viele Schiffe des Geleits verloren');
            return { phase: w.phase, objs: w.mission.objectives.length, optional: w.mission.objectives.filter(o => o.optional).length };
         }, win);
         const ended = await page.waitForFunction(() => window.__phase() === 'ended' && !document.getElementById('end').classList.contains('hidden'), null, { timeout: 12000 }).then(() => true, () => false);
         await wait(1800);   // the count-up of the earnings
         const r = await report(page);
         check(T + 'the battle report comes up by itself', ended && r.shown, forced);
         check(T + 'stamp and sheet colour', r.title === (win ? 'SIEG' : 'NIEDERLAGE') && r.cls.includes(win ? 'win' : 'lose'), r.title);
         check(T + 'mission name, reason, ship and duration', r.mis.length > 4 && r.reason.length > 4 && /Dauer \d+:\d\d/.test(r.meta) && /Gegner \S+/.test(r.meta), { mis: r.mis, reason: r.reason, meta: r.meta });
         check(T + 'objectives listed with their marks', r.objs.length === forced.objs && r.objs.every(o => /^(done:✔|failed:✘)$/.test(o)) && (win ? r.objs.every(o => o === 'done:✔') : r.objs.some(o => o === 'failed:✘')), r.objs);
         check(T + (win ? 'clasp awarded (silver: all optional objectives met)' : 'no clasp on a loss'), win ? /^◆◆ Silberne Spange verliehen$/.test(r.medal) : r.medal === '', r.medal);
         check(T + 'reward table with a total, earnings counted up', r.rw.length >= 2 && /Gesamt.*EP.*Mark/.test(r.rw[r.rw.length - 1]) && /\d/.test(r.earn) && (!win || !/^0\s*ERFAHRUNG/.test(r.earn)), { rw: r.rw.slice(-2), earn: r.earn });
         const want = ['again', 'next', 'port'];
         check(T + 'buttons: again, next operation, port — inside the screen' + (V.touch ? ', at least 40 px' : ''), want.every(a => r.btns.some(b => b.act === a && b.in && (!V.touch || (b.h >= 40 && b.w >= 40)))), r.btns);
         check(T + 'sheet, head and foot inside the screen, the body keeps room', r.sheetIn && r.headIn && r.footIn && r.bodyH >= 90, { bodyH: r.bodyH, scrolls: r.scrolls });
         check(T + 'tables, tiles and objectives not clipped sideways', !r.wide.length && !r.cutCells && r.rows >= 4 && r.tiles === 12, { wide: r.wide, cut: r.cutCells, rows: r.rows });
         check(T + 'no WW2 wording, no undefined / NaN', !WW2.test(r.text) && !r.bad, (r.text.match(WW2) || [''])[0]);
         await page.screenshot({ path: `${OUT}/v2-end-${view}-${op}-${win ? 'win' : 'loss'}.png` });
         // the scrolling part reaches its end: the debrief / last objective can be read
         const last = await ev(() => {
            const R = document.getElementById('end'), body = R.querySelector('.m3r-body');
            const sc = getComputedStyle(body).overflowY === 'auto' ? [body] : [...R.querySelectorAll('.m3r-box')];
            for (const s of sc) s.scrollTop = s.scrollHeight;
            const e = R.querySelector('.m3r-box:last-child').lastElementChild, a = e.getBoundingClientRect(), b = R.querySelector('.m3r-foot').getBoundingClientRect();
            return { bottom: Math.round(a.bottom), foot: Math.round(b.top), what: e.className };
         });
         check(T + 'scrolled down, the last block ends above the buttons', last.bottom <= last.foot + 1, last);
         if (view === 'phone') await page.screenshot({ path: `${OUT}/v2-end-${view}-${op}-${win ? 'win' : 'loss'}-scrolled.png` });

         if (win) {
            // "next operation": back in the menu with the following operation selected and ready to start
            await press('#end [data-act="next"]');
            await page.waitForFunction(() => window.__phase() === 'menu', null, { timeout: 8000 }).catch(() => {});
            await wait(600);
            const m = await ev(op => {
               const card = document.querySelector(`[data-mis="${op}"]`), sel = document.querySelector('.m3-mis.sel'), go = document.querySelector('[data-act="battle"]');
               return { phase: window.__phase(), endHidden: document.getElementById('end').classList.contains('hidden'), stars: card ? card.querySelectorAll('.m3-medal i.on').length : -1,
                  sel: sel?.dataset.mis, go: !!go && !go.disabled, others: [...document.querySelectorAll('.m3-mis.op')].filter(c => c.dataset.mis !== op && c.querySelector('.m3-medal i.on')).length };
            }, op);
            check(T + 'menu: the won operation carries its two clasps on the card, no other card does', m.phase === 'menu' && m.endHidden && m.stars === 2 && m.others === 0, m);
            check(T + 'menu: the next operation (' + NEXT[op] + ') is selected and can be started', m.sel === NEXT[op] && m.go, { sel: m.sel, go: m.go });
            await page.locator(`[data-mis="${op}"]`).scrollIntoViewIfNeeded().catch(() => {});
            await page.screenshot({ path: `${OUT}/v2-end-${view}-${op}-menu.png` });
            // ... and it does start
            await press('[data-act="battle"]');
            // an operation opens its briefing first
            const brief = await ev(() => !!document.querySelector('[data-op="go"]'));
            if (brief) await press('[data-op="go"]');
            const started = await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 30000 }).then(() => true, () => false);
            check(T + 'the next operation starts from there', started && await ev(() => window.__world().mission.id) === NEXT[op], await ev(() => ({ phase: window.__phase(), id: window.__world()?.mission?.id, ov: [...document.querySelectorAll('.overlay:not(.hidden), .m3-brief, [data-op="go"]')].map(e => e.className || e.dataset.op).slice(0, 5) })));
         } else {
            // a loss: "again" restarts the same operation, no clasp is booked
            await press('#end [data-act="again"]');
            const again = await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 30000 }).then(() => true, () => false);
            check(T + '"again" restarts the same operation', again && await ev(() => window.__world().mission.id) === op);
            const rec = await ev(op => { try { for (const k of Object.keys(localStorage)) { const v = JSON.parse(localStorage.getItem(k)); if (v?.missions?.[op]) return v.missions[op]; } } catch (e) { /* ignore */ } return null; }, op);
            check(T + 'progress: played once, not won, no clasp', rec && rec.plays === 1 && !rec.won && !rec.stars, rec);
         }
         check(T + 'no console errors', errors.length === e0, errors.slice(e0, e0 + 3));
         await ctx.close();
      }
   }
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of errors.slice(0, 12)) console.log('  ERR ' + e);
process.exit(failed.length || errors.length ? 1 : 0);
