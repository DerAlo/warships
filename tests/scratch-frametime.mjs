// scratch: main-thread JS time per rAF callback during a battle (GPU work excluded); deleted before commit
import { chromium } from 'playwright';
const URL = process.env.URL3D || 'http://localhost:5205/index-3d.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +(process.env.VW || 1280), height: +(process.env.VH || 720) } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.addInitScript(() => {
   const raf = window.requestAnimationFrame.bind(window);
   window.__ft = [];
   window.requestAnimationFrame = cb => raf(t => {
      const a = performance.now();
      cb(t);
      window.__ft.push(performance.now() - a);
   });
});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);
for (const m of (process.argv[2] || 'standard').split(',')) {
   await page.evaluate(m => window.__start({ difficulty: 'normal', mission: m }), m);
   for (let i = 0; i < 80 && (await page.evaluate(() => window.__phase())) !== 'playing'; i++) await page.waitForTimeout(100);
   await page.evaluate(() => { window.__world().autoPlayer = true; });
   await page.waitForTimeout(+(process.env.WARM || 8000));
   await page.evaluate(() => { window.__ft.length = 0; });
   await page.waitForTimeout(+(process.env.MEAS || 15000));
   const ft = await page.evaluate(() => window.__ft.slice());
   ft.sort((a, b) => a - b);
   const q = f => ft[Math.min(ft.length - 1, Math.floor(ft.length * f))].toFixed(1);
   console.log(m.padEnd(12), 'frames', ft.length, 'JS ms/frame p50', q(0.5), 'p90', q(0.9), 'max', q(1));
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close();
