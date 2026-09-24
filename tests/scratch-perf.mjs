// scratch: draw calls per mission and GPU memory growth across restarts; deleted before commit
import { chromium } from 'playwright';
const URL = process.env.URL3D || 'http://localhost:5188/index-3d.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const ev = (fn, a) => page.evaluate(fn, a);
const frames = (n = 2) => ev(n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1000);
const missions = (process.argv[2] || 'standard,domination,convoy,rheinuebung,laststand,night,raid,standard,standard').split(',');
for (const m of missions) {
   await ev(m => window.__start({ difficulty: 'normal', mission: m }), m);
   for (let i = 0; i < 80 && (await ev(() => window.__phase())) !== 'playing'; i++) await page.waitForTimeout(100);
   await ev(() => window.__setRender?.(true));
   await frames(12);
   const info = await ev(() => { const r = window.__renderer3d.renderer.info; return { calls: r.render.calls, tris: r.render.triangles, geo: r.memory.geometries, tex: r.memory.textures, prog: r.programs?.length }; });
   const heap = await ev(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1);
   console.log(m.padEnd(12), JSON.stringify(info), 'heapMB', heap);
}
console.log('errors', errors.length, errors.slice(0, 5));
await browser.close();
