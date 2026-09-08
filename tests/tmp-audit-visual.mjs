// TEMPORARY visual-audit capture script (deleted after the audit). Loads the 3D page,
// starts an easy game, and screenshots 8 states into tests/shots/audit/.
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

const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot:', name); };

// (1) menu
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1500);
await shot('01-menu');

// start easy game
await page.click('.chip[data-diff="easy"]');
await page.click('#btn-play');
await page.waitForTimeout(800);

// (2) battle start, default cam
await shot('02-battle-default-cam');

// (3) zoomed way out: wheel down ~15x (deltaY>0 => zoom out per main3d.js)
for (let i = 0; i < 15; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(40); }
await page.waitForTimeout(400);
console.log('zoom after out:', await page.evaluate(() => window.__cam3.zoom));
await shot('03-zoomed-out-map');

// (4) zoomed in close on own ship: wheel up ~15x
for (let i = 0; i < 15; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
await page.waitForTimeout(400);
console.log('zoom after in:', await page.evaluate(() => window.__cam3.zoom));
await shot('04-zoomed-in-ship');

// back to a mid zoom for firing shots
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(40); }
await page.waitForTimeout(300);

// (5) mid-flight main shells: hold LMB while sweeping cursor until shells exist, then wait ~40% of flight
await page.mouse.move(720, 400);
await page.mouse.down();
let shellsSeen = 0;
for (let i = 0; i < 40 && shellsSeen === 0; i++) {
   await page.mouse.move(720 - i * 18, 400 - (i % 3) * 10, { steps: 2 });
   await page.waitForTimeout(80);
   shellsSeen = await page.evaluate(() => window.__world().shells.length);
}
console.log('shells in flight at sweep end:', shellsSeen);
if (shellsSeen > 0) {
   // wait ~40% of a typical flight time (arcDur ~ range/vShell ~ 1.5-2.8s for player shots)
   const flight = await page.evaluate(() => {
      const w = window.__world();
      const mine = w.shells.filter(s => s.owner === 'player');
      return mine.length ? Math.min(...mine.map(s => s.arcDur)) : 2;
   });
   await page.waitForTimeout(Math.max(300, flight * 0.4 * 1000));
   const midShells = await page.evaluate(() => window.__world().shells.length);
   console.log('shells mid-flight at screenshot:', midShells);
}
await shot('05-shells-midflight');
await page.mouse.up();
await page.waitForTimeout(2500); // let salvo finish + cooldowns settle

// (6) smoke active
await page.evaluate(() => {
   const w = window.__world();
   w.player.smoke.active = true; w.player.smoke.t = 8;
});
await page.waitForTimeout(1200); // let clouds grow behind the ship
console.log('smoke clouds:', await page.evaluate(() => window.__world().smokeClouds.length));
await shot('06-smoke-active');
await page.evaluate(() => { const w = window.__world(); w.player.smoke.active = false; w.player.smoke.t = 0; });

// (7) torpedo in flight
await page.keyboard.down('t');
await page.waitForTimeout(60);
await page.keyboard.up('t');
await page.waitForTimeout(1000);
console.log('torpedoes in flight:', await page.evaluate(() => window.__world().torpedoes.length));
await shot('07-torpedo-flight');

// (8) restart via #btn-again and compare zoomed-out scene before/after
// first take a "before" zoomed-out shot of the current game
for (let i = 0; i < 15; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(40); }
await page.waitForTimeout(400);
await shot('08a-restart-before');
// force an end screen so #btn-again is reachable: kill all bots
await page.evaluate(() => {
   const w = window.__world();
   for (const b of w.bots) { b.hp = 1; b.alive = true; }
   // sink them directly to trigger the win path
   for (const b of w.bots) { b.alive = false; }
});
await page.waitForTimeout(2500); // endTimer 1.6s -> showEnd
const endVisible = await page.locator('#end').isVisible();
console.log('end screen visible:', endVisible);
if (endVisible) {
   await page.click('#btn-again');
   await page.waitForTimeout(900);
   // new game: zoom out again and screenshot
   for (let i = 0; i < 15; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(40); }
   await page.waitForTimeout(400);
   await shot('08b-restart-after');
} else {
   console.log('NOTE: end screen did not appear; skipping restart comparison');
}

if (errors.length) {
   console.log('\nCONSOLE ERRORS (' + errors.length + '):');
   for (const e of errors.slice(0, 20)) console.log('  -', e);
} else {
   console.log('\nno console errors');
}

await browser.close();
