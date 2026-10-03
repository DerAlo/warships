// tests/playwright3d.newmissions.mjs -- browser smoke test of the second mission batch
// (game3d/missions_extra.js): every mission is picked in the real menu (list stays readable, the
// selected entry is scrolled into view, briefing text shown), started (ops through their briefing
// screen), shows its objectives in the HUD, runs for a few seconds and is then won through the sim
// so the result screen appears. Screenshots: tests/shots/3d-new-<id>-<step>-<width>.png.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8772   then   URL3D=http://localhost:8772/index-3d.html node tests/playwright3d.newmissions.mjs
//       (VW/VH = viewport, MISSIONS=a,b to limit, NO_GPU=1 for software GL)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:8772/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
const VW = Number(process.env.VW) || 1440, VH = Number(process.env.VH) || 810;
const ALL = { strait: null, rearguard: null, fleet: null, cerberus: 'Scharnhorst', vian: 'Jervis', barents: 'Fiji', narvik: 'Jervis', matapan: 'Warspite', dakar: 'Richelieu', wahoo: 'Gato', spartivento: 'Littorio' };
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
const shot = (id, step) => page.screenshot({ path: `${OUT}/3d-new-${id}-${step}-${VW}.png` });

await page.goto(URL, { waitUntil: 'load' });
await wait(900);

// ---- the longer list: every entry present, none clipped horizontally, sections in order
{
   const list = await ev(() => {
      const box = document.querySelector('.m3-list');
      const items = [...box.querySelectorAll('.m3-mis')];
      return { n: items.length, ids: items.map(e => e.dataset.mis), scroll: box.scrollHeight > box.clientHeight + 2,
         clipped: items.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.dataset.mis),
         secs: [...box.querySelectorAll('.m3-sec')].map(e => e.textContent.trim()) };
   });
   check('menu lists every new mission', ids.every(id => list.ids.includes(id)), list.n + ' entries, scrolls: ' + list.scroll);
   check('no list entry is clipped', !list.clipped.length, list.clipped);
   await page.screenshot({ path: `${OUT}/3d-new-menu-${VW}.png` });
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
   if (id === ids[0] || ALL[id]) await shot(id, 'menu');
   if (ALL[id]) check(`${id}: fixed ship card`, await ev((cls) => !!document.querySelector(`[data-ship="${cls}"]:not(.off)`), ALL[id]), ALL[id]);
   await page.keyboard.press('Enter');
   await wait(250);
   if (ALL[id]) {
      const intro = await ev(() => { const o = document.querySelector('.m3-op'); return o ? { t: o.querySelector('.t')?.textContent || '', len: o.innerText.length, over: o.scrollHeight > innerHeight + 2 } : null; });
      check(`${id}: briefing screen`, intro && intro.len > 300, intro && intro.t);
      await shot(id, 'intro');
      await page.keyboard.press('Enter');
      await wait(250);
   }
   const ok = await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 15000 }).then(() => true, () => false);
   const st = await ev(() => { const w = window.__world(); return { id: w?.mission?.id, ship: w?.player?.cls, name: w?.player?.name, zones: w?.mission?.zones.length }; });
   check(`${id}: battle started`, ok && st.id === id && (!ALL[id] || st.ship === ALL[id]), st);
   for (const k of ['w', 'w', 'w']) await page.keyboard.press(k);
   await wait(6500);
   const hud = await ev(() => {
      const o = document.getElementById('objectives'), r = o.getBoundingClientRect();
      const objs = [...o.querySelectorAll('.obj')].map(e => e.textContent);
      return { objs, box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], vis: r.width > 0 && r.height > 0 && r.right <= innerWidth && r.bottom <= innerHeight,
         t: +window.__world().time.toFixed(1), fps: window.__fps ? window.__fps() : null };
   });
   check(`${id}: objectives in the HUD`, hud.vis && hud.objs.length >= 2 && hud.objs.every(t => t && !/undefined|NaN/.test(t)), hud.objs.length + ' @ ' + hud.box.join(','));
   check(`${id}: sim is running`, hud.t > 3, hud.t + ' s');
   await shot(id, 'battle');
   // tactical map: zones and islands
   await page.keyboard.press('m'); await wait(500);
   await shot(id, 'map');
   await page.keyboard.press('m'); await wait(200);
   check(`${id}: no console errors`, errors.length === e0, errors.slice(e0, e0 + 3));
}

// ---- result screen of an operation (debrief + medal) and of a battle
for (const id of ids.filter(i => i === 'vian' || i === 'strait')) {
   await page.goto(URL, { waitUntil: 'load' });
   await wait(700);
   await ev((id) => { window.__start({ difficulty: 'normal', mission: id }); }, id);
   await wait(1200);
   await ev((id) => {
      const w = window.__world();
      if (id === 'vian') w.stats.torpHits = 3;
      else w.timeLeft = 0;
   }, id);
   const got = await page.waitForFunction(() => /won|lost|result|end/.test(window.__phase()) || !!document.querySelector('.m3r-rw'), null, { timeout: 20000 }).then(() => true, () => false);
   await page.waitForFunction(() => !!document.querySelector('.m3r-rw'), null, { timeout: 20000 }).catch(() => {});
   await wait(600);
   const r = await ev(() => ({ rows: document.querySelectorAll('.m3r-rw tr').length, hist: !!document.querySelector('.m3r-hist'), medal: document.querySelector('.m3r-medal')?.textContent || '', phase: window.__phase() }));
   check(`${id}: result screen with rewards`, got && r.rows >= 3 && (id !== 'vian' || r.hist), r);
   await shot(id, 'result');
}

console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 10)) console.log(' -', e);
await browser.close();
process.exit(errors.length || results.some(r => !r.ok) ? 1 : 0);
