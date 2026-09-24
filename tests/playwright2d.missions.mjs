// tests/playwright2d.missions.mjs — browser play-test of EVERY 2D campaign mission + survival:
// start it, drive, fire salvos (AP and HE), torpedoes, all consumables, pause/resume, restart,
// check the zoom stays fixed under wheel input, screenshot each mission after ~12 s of play.
// Run: node server.js 5183 & URL=http://localhost:5183/ node tests/playwright2d.missions.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL || 'http://localhost:5173/';
const OUT = 'tests/shots/missions';
const KEY = 'warships2d.progress.v1';
mkdirSync(OUT, { recursive: true });

const errors = [];
let exitCode = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) exitCode = 1; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

async function tap(key, hold = 80) {
   await page.keyboard.down(key);
   await page.waitForTimeout(hold);
   await page.keyboard.up(key);
   await page.waitForTimeout(60);
}
const P = (fn, arg) => page.evaluate(fn, arg);

await page.goto(URL, { waitUntil: 'load' });
// everything unlocked so every card can be started
await P((k) => localStorage.setItem(k, JSON.stringify({ stars: { m1: 1, m2: 1, m3: 1, m4: 1, m5: 1, m6: 1, m7: 1, m8: 1 }, survivalBest: {}, difficulty: 'normal' })), KEY);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(900);
await page.screenshot({ path: OUT + '/00-menu.png' });

const IDS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'survival', 'skirmish'];
for (const id of IDS) {
   await page.click(`.mcard[data-id="${id}"]`);
   await page.waitForTimeout(100);
   await page.click('#btn-play');
   await page.waitForTimeout(600);
   const ok = await P(() => window.__game && window.__game.phase === 'playing' && !!window.__game.world);
   check(ok, `${id}: mission running`);
   const z0 = await P(() => window.__game.cam.zoom);
   await page.mouse.move(1100, 330);
   await page.mouse.wheel(0, -1200);
   await page.keyboard.down('w');
   await page.keyboard.down('d');
   await page.waitForTimeout(1500);
   await page.keyboard.up('d');
   // AP salvo, switch to HE, ripple fire by holding the button
   await page.mouse.click(1100, 330);
   await tap('2');
   await page.mouse.down(); await page.waitForTimeout(900); await page.mouse.up();
   await tap('1');
   // torpedo fan: aim abeam, toggle spread, release
   await page.mouse.move(720, 120);
   await page.keyboard.down('t'); await page.waitForTimeout(400);
   await tap('q');
   await page.keyboard.up('t');
   // consumables (flare only counts at night; C only drops when carried)
   for (const k of ['f', 'Shift', 'c', 'g', 'e']) await tap(k);
   // secondary focus with RMB
   await page.mouse.click(1100, 330, { button: 'right' });
   await page.waitForTimeout(700);
   check(await P(() => window.__game.cam.zoom) === z0, `${id}: wheel does not change zoom`);
   // pause/resume must freeze the world clock
   await tap('Escape');
   const tA = await P(() => window.__game.world.time);
   await page.waitForTimeout(400);
   const tB = await P(() => window.__game.world.time);
   check(tA === tB && await page.locator('#pause').isVisible(), `${id}: pause freezes the game`);
   await tap('Escape');
   await page.waitForTimeout(6500);
   await page.keyboard.up('w');
   const st = await P(() => {
      const w = window.__game.world, p = w.player;
      return { t: Math.round(w.time), hp: Math.round(100 * p.hp / p.maxHP), shots: p.shotsFired, phase: w.phase,
         nan: [p, ...w.bots, ...w.allies].some(s => !Number.isFinite(s.pos.x) || !Number.isFinite(s.pos.y) || !Number.isFinite(s.hp)),
         bots: w.bots.filter(b => b.alive).length };
   });
   check(!st.nan, `${id}: no NaN positions/hp`);
   check(st.shots > 0, `${id}: main battery fired (${st.shots} shells)`);
   console.log('     ', id, JSON.stringify(st));
   await page.screenshot({ path: `${OUT}/${id}.png` });
   // restart from the pause menu resets the clock
   await tap('Escape');
   await page.click('#btn-restart');
   await page.waitForTimeout(500);
   check(await P(() => window.__game.world.time < 2 && window.__game.phase === 'playing'), `${id}: restart resets the mission`);
   await tap('Escape');
   await page.click('#btn-quit');
   await page.waitForTimeout(300);
}

if (errors.length) {
   exitCode = 1;
   console.log('\nCONSOLE ERRORS (' + errors.length + '):');
   for (const e of errors.slice(0, 20)) console.log('  -', e);
} else console.log('\nno console errors ✔');
await browser.close();
process.exit(exitCode);
