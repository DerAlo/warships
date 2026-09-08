// TEMPORARY follow-up capture: torpedo in flight, close-range shell arc, compass crop.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = 'http://localhost:5173/index-3d.html';
const OUT = 'tests/shots/audit';
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200);
await page.click('.chip[data-diff="easy"]');
await page.click('#btn-play');
await page.waitForTimeout(600);

// --- torpedo: clear the 32s initial cooldown, aim forward, fire ---
await page.evaluate(() => { const w = window.__world(); w.player.torpTimer = 0; });
await page.mouse.move(720, 300); // aim ahead of the ship
await page.keyboard.down('t');
await page.waitForTimeout(60);
await page.keyboard.up('t');
await page.waitForTimeout(700);
console.log('torpedoes in flight:', await page.evaluate(() => window.__world().torpedoes.length));
await page.screenshot({ path: `${OUT}/07b-torpedo-flight.png` });

// --- close-range shell arc: zoom in, aim short, hold LMB ---
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
await page.waitForTimeout(300);
console.log('zoom:', await page.evaluate(() => window.__cam3.zoom));
await page.mouse.move(720, 430);
await page.mouse.down();
let n = 0;
for (let i = 0; i < 30 && n === 0; i++) {
   await page.mouse.move(720 + (i % 2) * 6, 430, { steps: 1 });
   await page.waitForTimeout(70);
   n = await page.evaluate(() => window.__world().shells.filter(s => s.owner === 'player').length);
}
console.log('player shells:', n);
if (n > 0) {
   const flight = await page.evaluate(() => {
      const w = window.__world();
      const mine = w.shells.filter(s => s.owner === 'player');
      return mine.length ? Math.min(...mine.map(s => s.arcDur)) : 1;
   });
   await page.waitForTimeout(Math.max(250, flight * 0.45 * 1000));
   console.log('shells at shot:', await page.evaluate(() => window.__world().shells.length));
}
await page.screenshot({ path: `${OUT}/05b-shells-close.png` });
await page.mouse.up();

// --- compass crop from a fresh default-cam frame ---
await page.screenshot({ path: `${OUT}/09-compass-crop.png`, clip: { x: 560, y: 720, width: 320, height: 90 } });

// --- restart-leak probe: count scene children via a reachable handle if any ---
const probe = await page.evaluate(() => {
   // renderer is module-scoped; try to reach it through the canvas' three context? Not possible.
   // Instead: trigger two restarts and compare GPU memory estimate via performance.memory if present.
   return typeof performance.memory === 'undefined' ? 'no perf.memory' : JSON.stringify(performance.memory);
});
console.log('mem probe:', probe);

if (errors.length) { console.log('\nCONSOLE ERRORS:'); for (const e of errors.slice(0, 10)) console.log(' -', e); }
else console.log('\nno console errors');
await browser.close();
