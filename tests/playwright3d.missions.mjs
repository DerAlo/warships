// tests/playwright3d.missions.mjs -- smoke sweep for the 3D mode: starts every mission (cycling
// the playable ships), drives, fires guns and torpedoes, uses every consumable, opens map /
// scoreboard / binoculars / lock, renders a couple of real frames and screenshots each mission.
// Exit code 1 on any console error. The 3D draw is skipped between screenshots (window.__setRender)
// because headless software GL is slow. Missions or ships unknown to the sim fall back silently.
//
// Run:  node server.js 5173   then   node tests/playwright3d.missions.mjs
//       (URL3D=..., OUT=..., MISSIONS=a,b,..., SHIPS=a,b,... to override)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const URL = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const missions = (process.env.MISSIONS || 'training,standard,domination,convoy,rheinuebung,laststand,night,raid').split(',');
const ships = (process.env.SHIPS || 'Bismarck,Hipper,Nuernberg,Z23').split(',');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);
let i = 0;
for (const mission of missions) {
   const ship = ships[i++ % ships.length];
   const e0 = errors.length;
   await page.evaluate(([mission, ship]) => { window.__start({ difficulty: 'normal', mission, ship }); window.__setRender(false); }, [mission, ship]);
   await page.waitForTimeout(300);
   const info = await page.evaluate(() => ({ phase: window.__phase(), ship: window.__world()?.player?.name, mission: window.__world()?.mission?.key || window.__world()?.mission?.id }));
   // drive: full speed, turn, shoot, torps, consumables, map, board
   for (const k of ['w', 'w', 'w', 'd']) await page.keyboard.press(k);
   for (let t = 0; t < 12; t++) {
      await page.mouse.move(640, 360); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
      if (t === 3) { await page.keyboard.press('3'); await page.evaluate(() => window.__setAim(Math.PI / 2, 5000)); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.keyboard.press('1'); await page.evaluate(() => window.__setAim(0, 8000)); }
      if (t === 5) for (const k of ['r', 't', 'y', 'u']) await page.keyboard.press(k);
      if (t === 6) { await page.keyboard.press('m'); await page.waitForTimeout(200); await page.keyboard.press('m'); }
      if (t === 7) { await page.keyboard.down('Tab'); await page.waitForTimeout(200); await page.keyboard.up('Tab'); }
      if (t === 8) { await page.keyboard.press('x'); await page.keyboard.press('Shift'); await page.mouse.wheel(0, -200); }
      if (t === 9) { await page.keyboard.press('Shift'); await page.keyboard.press('2'); }
      await page.waitForTimeout(250);
   }
   // render a couple of frames for real too
   await page.evaluate(() => window.__setRender(true));
   await page.waitForTimeout(1500);
   await page.screenshot({ path: `${OUT}/3d-mission-${mission}.png` });
   await page.evaluate(() => window.__setRender(false));
   const st = await page.evaluate(() => ({ t: window.__world().time.toFixed(1), fired: window.__fired(), phase: window.__phase() }));
   console.log(mission, ship, JSON.stringify(info), JSON.stringify(st), 'errors:', errors.length - e0);
}
console.log('TOTAL ERRORS', errors.length);
for (const e of [...new Set(errors)].slice(0, 10)) console.log(' -', e);
await browser.close();
process.exit(errors.length ? 1 : 0);
