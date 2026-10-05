// tests/playwright3d.missions.pacific.mjs -- browser smoke test of the Pacific operations
// (game3d/missions_pacific.js): Samar, Surigao Strait and Savo Island are picked in the real menu
// (entry visible, German type label, briefing text, ship cards), started through their briefing
// screen, show their objectives in the HUD, run for a few seconds, and one of them is won through
// the sim so the result screen with the debrief appears. Surigao is started with both of its ships.
// Screenshots: tests/shots/3d-pac-<id>-<step>-<width>.png.
// Exit code 1 on a failed check or any console error.
//
// Run:  node server.js 8821   then   URL3D=http://localhost:8821/index-3d.html node tests/playwright3d.missions.pacific.mjs
//       (VW/VH = viewport, MISSIONS=a,b to limit, NO_GPU=1 for software GL)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:8821/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
const VW = Number(process.env.VW) || 1440, VH = Number(process.env.VH) || 810;
// mission -> [ships to start it with, name of the player's ship]
const ALL = { samar: [['Fletcher', 'USS Johnston']], surigao: [['Fletcher', 'USS McDermut'], ['Washington', 'USS West Virginia']], savo: [['Takao', 'Chōkai']] };
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
const shot = (id, step) => page.screenshot({ path: `${OUT}/3d-pac-${id}-${step}-${VW}.png` });

await page.goto(URL, { waitUntil: 'load' });
await wait(900);

// ---- the list: the three operations are present, in the operations section, none clipped
{
   const list = await ev(() => {
      const box = document.querySelector('.m3-list');
      const items = [...box.querySelectorAll('.m3-mis')];
      return { n: items.length, ids: items.map(e => e.dataset.mis),
         clipped: items.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.dataset.mis),
         secs: [...box.querySelectorAll('.m3-sec')].map(e => e.textContent.trim()) };
   });
   check('menu lists the Pacific operations', ids.every(id => list.ids.includes(id)), list.n + ' entries');
   check('no list entry is clipped', !list.clipped.length, list.clipped);
   await page.screenshot({ path: `${OUT}/3d-pac-menu-${VW}.png` });
}

for (const id of ids) for (const [cls, shipName] of ALL[id]) {
   const tag = ALL[id].length > 1 ? `${id}/${cls}` : id;
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
   check(`${tag}: selected entry visible in the list`, m.sel && m.inView, m.tag);
   check(`${tag}: type label is German`, m.tag && m.tag !== m.tag.toLowerCase() && !/undefined/.test(m.tag), m.tag);
   check(`${tag}: briefing shown in the menu`, /Sie |Ihr/.test(m.text) && m.text.length > 400);
   const cards = await ev((all) => all.map(([c]) => !!document.querySelector(`[data-ship="${c}"]:not(.off)`)), ALL[id]);
   check(`${tag}: ship cards of the operation are selectable`, cards.every(Boolean), ALL[id].map(a => a[0]).join(', '));
   await page.click(`[data-ship="${cls}"]`);
   await wait(150);
   await shot(tag.replace('/', '-'), 'menu');
   await page.keyboard.press('Enter');
   await wait(250);
   const intro = await ev(() => { const o = document.querySelector('.m3-op'); return o ? { t: o.querySelector('.t')?.textContent || '', len: o.innerText.length } : null; });
   check(`${tag}: briefing screen`, intro && intro.len > 300, intro && intro.t);
   await shot(tag.replace('/', '-'), 'intro');
   await page.keyboard.press('Enter');
   await wait(250);
   const ok = await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 15000 }).then(() => true, () => false);
   const st = await ev(() => { const w = window.__world(); return { id: w?.mission?.id, ship: w?.player?.cls, name: w?.player?.name, zones: w?.mission?.zones.length, foes: w?.ships.filter(s => s.side === 'enemy').length }; });
   check(`${tag}: battle started with the right ship`, ok && st.id === id && st.ship === cls && st.name === shipName && st.foes > 0, st);
   for (const k of ['w', 'w', 'w']) await page.keyboard.press(k);
   await wait(6500);
   const hud = await ev(() => {
      const o = document.getElementById('objectives'), r = o.getBoundingClientRect();
      const objs = [...o.querySelectorAll('.obj')].map(e => e.textContent);
      return { objs, box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], vis: r.width > 0 && r.height > 0 && r.right <= innerWidth && r.bottom <= innerHeight,
         t: +window.__world().time.toFixed(1), phase: window.__phase() };
   });
   check(`${tag}: objectives in the HUD`, hud.vis && hud.objs.length >= 3 && hud.objs.every(t => t && !/undefined|NaN/.test(t)), hud.objs.length + ' @ ' + hud.box.join(','));
   check(`${tag}: sim is running`, hud.t > 3 && hud.phase === 'playing', hud.t + ' s');
   await shot(tag.replace('/', '-'), 'battle');
   await page.keyboard.press('m'); await wait(500);
   await shot(tag.replace('/', '-'), 'map');
   await page.keyboard.press('m'); await wait(200);
   check(`${tag}: no console errors`, errors.length === e0, errors.slice(e0, e0 + 3));
}

// ---- result screens: Samar won by holding out (debrief + medal), Savo lost at daybreak
for (const id of ids.filter(i => i === 'samar' || i === 'savo')) {
   const e0 = errors.length;
   await page.goto(URL, { waitUntil: 'load' });
   await wait(700);
   await ev((id) => { window.__start({ difficulty: 'normal', mission: id }); }, id);
   await wait(1200);
   await ev(() => { window.__world().timeLeft = 0; });
   const got = await page.waitForFunction(() => /won|lost|result|end/.test(window.__phase()) || !!document.querySelector('.m3r-rw'), null, { timeout: 20000 }).then(() => true, () => false);
   await page.waitForFunction(() => !!document.querySelector('.m3r-rw'), null, { timeout: 20000 }).catch(() => {});
   await wait(600);
   const r = await ev(() => ({ rows: document.querySelectorAll('.m3r-rw tr').length, hist: !!document.querySelector('.m3r-hist'), medal: document.querySelector('.m3r-medal')?.textContent || '', phase: window.__world()?.phase }));
   check(`${id}: result screen (${id === 'samar' ? 'won' : 'lost'})`, got && r.rows >= 3 && r.phase === (id === 'samar' ? 'won' : 'lost') && (id !== 'samar' || r.hist), r);
   await shot(id, 'result');
   check(`${id}: no console errors on the result screen`, errors.length === e0, errors.slice(e0, e0 + 3));
}

console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 10)) console.log(' -', e);
await browser.close();
process.exit(errors.length || results.some(r => !r.ok) ? 1 : 0);
