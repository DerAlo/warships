// tests/playwright3d.missions.west.mjs -- browser smoke test of the Atlantic/Mediterranean
// operations (game3d/missions_west.js): each one is picked in the real menu (entry visible,
// briefing text, fixed ship card), started through its briefing screen, shows its objectives in
// the HUD and its zones on the tactical map, runs for a few seconds, and is then won and lost
// through the sim so the result screen with the historical debrief appears.
// Screenshots: tests/shots/3d-west-<id>-<step>-<width>.png.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8822   then   URL3D=http://localhost:8822/index-3d.html node tests/playwright3d.missions.west.mjs
//       (VW/VH = viewport, MISSIONS=a,b to limit, NO_GPU=1 for software GL)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:8822/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
const VW = Number(process.env.VW) || 1440, VH = Number(process.env.VH) || 810;
const ALL = { laplata: 'Fiji', pedestal: 'Fiji', juno: 'Scharnhorst' };
const NAMES = { laplata: 'HMS Ajax', pedestal: 'HMS Kenya', juno: null };
const ids = (process.env.MISSIONS || Object.keys(ALL).join(',')).split(',');
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = ms => page.waitForTimeout(ms);
const shot = (id, step) => page.screenshot({ path: `${OUT}/3d-west-${id}-${step}-${VW}.png` });

await page.goto(URL, { waitUntil: 'load' });
await wait(900);

// ---- the list: every entry present under the operations, none clipped horizontally
{
   const list = await ev(() => {
      const box = document.querySelector('.m3-list');
      const items = [...box.querySelectorAll('.m3-mis')];
      return { n: items.length, ids: items.map(e => e.dataset.mis), scroll: box.scrollHeight > box.clientHeight + 2,
         clipped: items.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.dataset.mis) };
   });
   check('menu lists every west operation', ids.every(id => list.ids.includes(id)), list.n + ' entries, scrolls: ' + list.scroll);
   check('no list entry is clipped', !list.clipped.length, list.clipped);
   check('no duplicate list entries', new Set(list.ids).size === list.ids.length);
   await page.screenshot({ path: `${OUT}/3d-west-menu-${VW}.png` });
}

for (const id of ids) {
   const e0 = errors.length;
   if (await ev(() => window.__phase() !== 'menu')) {
      await page.goto(URL, { waitUntil: 'load' });
      await wait(700);
   }
   await page.click(`[data-mis="${id}"]`);
   await wait(150);
   const m = await ev((id) => {
      const el = document.querySelector(`[data-mis="${id}"]`), box = document.querySelector('.m3-list');
      const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
      return { sel: el.classList.contains('sel'), inView: r.top >= b.top - 1 && r.bottom <= b.bottom + 1, tag: el.querySelector('.tag')?.textContent || '',
         text: document.body.innerText };
   }, id);
   check(`${id}: selected entry visible in the list`, m.sel && m.inView, m.tag);
   check(`${id}: type label is German`, m.tag && m.tag !== m.tag.toLowerCase(), m.tag);
   check(`${id}: briefing shown in the menu`, /Sie |Ihr/.test(m.text) && m.text.length > 400);
   await shot(id, 'menu');
   check(`${id}: fixed ship card`, await ev((cls) => !!document.querySelector(`[data-ship="${cls}"]:not(.off)`), ALL[id]), ALL[id]);
   await page.keyboard.press('Enter');
   await wait(250);
   const intro = await ev(() => { const o = document.querySelector('.m3-op'); return o ? { t: o.querySelector('.t')?.textContent || '', len: o.innerText.length, over: o.scrollHeight > innerHeight + 2 } : null; });
   check(`${id}: briefing screen`, intro && intro.len > 300, intro && intro.t);
   check(`${id}: briefing screen fits the viewport`, intro && !intro.over);
   await shot(id, 'intro');
   await page.keyboard.press('Enter');
   await wait(250);
   const ok = await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 15000 }).then(() => true, () => false);
   const st = await ev(() => { const w = window.__world(); return { id: w?.mission?.id, ship: w?.player?.cls, name: w?.player?.name, zones: w?.mission?.zones.length, foes: w?.ships.filter(s => s.side === 'enemy').length }; });
   check(`${id}: battle started`, ok && st.id === id && st.ship === ALL[id] && st.zones >= 1 && st.foes >= 1 && (!NAMES[id] || st.name === NAMES[id]), st);
   for (const k of ['w', 'w', 'w']) await page.keyboard.press(k);
   await wait(6500);
   const hud = await ev(() => {
      const o = document.getElementById('objectives'), r = o.getBoundingClientRect();
      const objs = [...o.querySelectorAll('.obj')].map(e => e.textContent);
      return { objs, box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], vis: r.width > 0 && r.height > 0 && r.right <= innerWidth && r.bottom <= innerHeight,
         t: +window.__world().time.toFixed(1), radio: window.__world().logLines.filter(l => /📻/.test(l.text)).length };
   });
   check(`${id}: objectives in the HUD`, hud.vis && hud.objs.length >= 3 && hud.objs.every(t => t && !/undefined|NaN/.test(t)), hud.objs.length + ' @ ' + hud.box.join(','));
   check(`${id}: sim is running, first radio message came in`, hud.t > 3 && hud.radio >= 1, hud.t + ' s, radio ' + hud.radio);
   await shot(id, 'battle');
   // tactical map: zones and islands
   await page.keyboard.press('m'); await wait(500);
   await shot(id, 'map');
   await page.keyboard.press('m'); await wait(200);
   check(`${id}: no console errors`, errors.length === e0, errors.slice(e0, e0 + 3));
}

// ---- result screens: every operation won through the sim (debrief + medal), one lost
const WIN = {
   laplata: (w) => { const s = w._script.spee; s.takeDamage(s.hp + 1, w.player, 'citadel'); },
   pedestal: (w) => { const S = w._script; S.ohio.pos.x = S.exit.x; S.ohio.pos.y = S.exit.y; },
   juno: (w) => { const s = w._script.glo; s.takeDamage(s.hp + 1, w.player, 'citadel'); },
};
for (const id of ids) for (const mode of id === ids[0] ? ['win', 'loss'] : ['win']) {
   const e0 = errors.length;
   await page.goto(URL, { waitUntil: 'load' });
   await wait(700);
   await ev((id) => { window.__start({ difficulty: 'normal', mission: id }); }, id);
   await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 15000 }).catch(() => {});
   await wait(1200);
   if (mode === 'win') await page.evaluate(`(${WIN[id].toString()})(window.__world())`);
   else await ev(() => { window.__world().timeLeft = 0; });
   const got = await page.waitForFunction(() => /won|lost|result|end/.test(window.__phase()) || !!document.querySelector('.m3r-rw'), null, { timeout: 20000 }).then(() => true, () => false);
   await page.waitForFunction(() => !!document.querySelector('.m3r-rw'), null, { timeout: 20000 }).catch(() => {});
   await wait(600);
   const r = await ev(() => ({ rows: document.querySelectorAll('.m3r-rw tr').length, hist: !!document.querySelector('.m3r-hist'), medal: document.querySelector('.m3r-medal')?.textContent || '',
      phase: window.__world().phase, reason: window.__world().result?.reason || '' }));
   check(`${id}: result screen after a ${mode}`, got && r.rows >= 3 && r.hist && r.phase === (mode === 'win' ? 'won' : 'lost') && r.reason.length > 20, r);
   check(`${id}: no console errors on the result screen (${mode})`, errors.length === e0, errors.slice(e0, e0 + 3));
   await shot(id, mode === 'win' ? 'result' : 'lost');
}

console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 10)) console.log(' -', e);
await browser.close();
process.exit(errors.length || results.some(r => !r.ok) ? 1 : 0);
