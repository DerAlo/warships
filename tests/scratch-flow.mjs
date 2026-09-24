// scratch: pause/resume, results screen and its buttons, resource counts across the flow; deleted before commit
import { chromium } from 'playwright';
const URL = process.env.URL3D || 'http://localhost:5205/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const ev = (fn, a) => page.evaluate(fn, a);
const frames = (n = 2) => ev(n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const res = () => ev(() => { const r = window.__renderer3d.renderer.info; return `geo=${r.memory.geometries} tex=${r.memory.textures} calls=${r.render.calls} heapMB=${Math.round(performance.memory.usedJSHeapSize / 1e6)}`; });
const vis = sel => ev(sel => { const e = document.querySelector(sel); return !!e && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none' && e.offsetParent !== null; }, sel);
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) fails++; };

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/flow-menu.png` });
await ev(() => window.__start({ difficulty: 'normal', mission: 'standard' }));
await frames(6);
check('playing after start', (await ev(() => window.__phase())) === 'playing');
console.log('  start   ', await res());
// pause via Escape, resume via Escape after the debounce
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check('Escape pauses', (await ev(() => window.__phase())) === 'paused');
const t0 = await ev(() => window.__world().time);
await page.waitForTimeout(1200);
check('sim frozen while paused', (await ev(() => window.__world().time)) === t0);
await page.screenshot({ path: `${OUT}/flow-pause.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape resumes', (await ev(() => window.__phase())) === 'playing');
// win -> results
await ev(() => window.__world().end(true, 'Test: Sieg'));
for (let i = 0; i < 40 && !(await vis('.m3r-btn')); i++) await page.waitForTimeout(150);
check('results screen visible', await vis('.m3r-btn'));
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/flow-results.png` });
// NOCHMAL restarts the same mission
await page.click('[data-act="again"]');
for (let i = 0; i < 40 && (await ev(() => window.__phase())) !== 'playing'; i++) await page.waitForTimeout(100);
await frames(6);
check('NOCHMAL -> playing', (await ev(() => window.__phase())) === 'playing');
check('NOCHMAL same mission', (await ev(() => window.__world().mission?.id)) === 'standard');
console.log('  again   ', await res());
// loss -> NÄCHSTE MISSION
await ev(() => window.__world().end(false, 'Test: Niederlage'));
for (let i = 0; i < 40 && !(await vis('.m3r-btn')); i++) await page.waitForTimeout(150);
await page.click('[data-act="next"]');
await page.waitForTimeout(800);
const ph = await ev(() => window.__phase());
console.log('  next -> phase', ph, 'mission', await ev(() => window.__world()?.mission?.id));
await page.screenshot({ path: `${OUT}/flow-next.png` });
// back to port from a fresh result
if (ph !== 'playing') await ev(() => window.__start({ difficulty: 'normal', mission: 'convoy' }));
await frames(4);
await ev(() => window.__world().end(true, 'Test'));
for (let i = 0; i < 40 && !(await vis('.m3r-btn')); i++) await page.waitForTimeout(150);
await page.click('[data-act="port"]');
await page.waitForTimeout(800);
check('HAFEN -> menu', (await ev(() => window.__phase())) === 'menu');
check('menu visible (GEFECHT button)', await vis('[data-act="battle"]'));
// 6 restarts: resources must not grow
for (let k = 0; k < 6; k++) { await ev(k => window.__start({ difficulty: 'normal', mission: ['standard', 'night', 'raid'][k % 3] }), k); await frames(4); }
await ev(() => window.__start({ difficulty: 'normal', mission: 'standard' }));
await frames(8);
console.log('  after 6 restarts', await res());
check('no console errors', errors.length === 0);
if (errors.length) console.log(errors.slice(0, 5));
console.log(fails ? `${fails} FAILED` : 'all ok');
await browser.close();
