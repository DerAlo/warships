// tests/playwright.shots.mjs — headless self-test: load page, catch console errors, start a game,
// drive the Bismarck through every control (salvo/ripple, AP/HE, torpedo fan, consumables, smoke,
// secondaries focus, pause), verify the sim reacts via window.__game, take screenshots.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL || 'http://localhost:5173/';
const OUT = 'tests/shots';
mkdirSync(OUT, { recursive: true });

const errors = [];
let exitCode = 0;
const fail = (msg) => { console.log('FAIL: ' + msg); exitCode = 1; };
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) exitCode = 1; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

// a real keystroke spans at least one frame (press() can land down+up inside one rAF)
async function tap(key, hold = 80) {
   await page.keyboard.down(key);
   await page.waitForTimeout(hold);
   await page.keyboard.up(key);
   await page.waitForTimeout(60);
}
const P = (fn) => page.evaluate(fn);

// 1) menu loads, no zoom control listed
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200);
check(await page.locator('#menu').isVisible(), 'menu visible');
const menuText = await page.locator('#menu').textContent();
check(!/Karte|Minimap-Fokus/.test(menuText), 'menu has no map-zoom control');
check(/Ripple|halten/.test(menuText) && /AP/.test(menuText), 'menu lists click/hold salvo + AP/HE');
await page.screenshot({ path: OUT + '/01-menu.png' });

// 2) howto overlay
await page.click('#btn-how');
await page.waitForTimeout(200);
check(await page.locator('#howto').isVisible(), 'howto visible');
await page.screenshot({ path: OUT + '/02-howto.png' });
await page.click('#btn-how-close');

// 3) start a normal game
await page.click('.chip[data-diff="normal"]');
await page.click('#btn-play');
await page.waitForTimeout(600);
check(await page.locator('#hud').isVisible(), 'hud visible after start');
const pips = await page.locator('#turret-pips .pip').count();
check(pips === 4, `4 turret pips (got ${pips})`);

// 4) zoom is fixed: wheel and M must not change it
const z0 = await P(() => window.__game.cam.zoom);
await page.mouse.move(900, 300);
await page.mouse.wheel(0, 600);
await tap('m');
await page.waitForTimeout(200);
const z1 = await P(() => window.__game.cam.zoom);
check(z0 === z1, `camera zoom fixed (${z0} -> ${z1})`);

// 5) ammo switch 2 -> HE, 1 -> AP
await tap('2');
check(await P(() => window.__game.world.player.ammo) === 'HE', 'key 2 loads HE');
check(await page.locator('#ammo-he.sel').count() === 1, 'HUD shows HE selected');
await tap('1');
check(await P(() => window.__game.world.player.ammo) === 'AP', 'key 1 loads AP');

// 6) drive + click salvo + hold ripple
await page.keyboard.down('w');
await page.keyboard.down('d');
await page.waitForTimeout(3000);   // let the turrets train and the ammo-switch reload finish
const shots0 = await P(() => window.__game.world.player.shotsFired);
await page.mouse.down({ button: 'left' });
await page.waitForTimeout(3500);   // hold: ripple fire
await page.mouse.up({ button: 'left' });
const shots1 = await P(() => window.__game.world.player.shotsFired);
check(shots1 > shots0, `main battery fired (${shots1 - shots0} shells)`);
await page.screenshot({ path: OUT + '/03-combat.png' });
await page.keyboard.up('d');

// 7) torpedo fan: Q toggles spread, hold T previews, release fires (aim abeam)
await tap('q');
check(await P(() => window.__game.world.player.torpSpread) === 'wide', 'Q toggles torpedo spread');
const abeam = await P(() => {
   const g = window.__game, p = g.world.player;
   const a = p.heading + Math.PI / 2;
   return g.cam.w2s({ x: p.pos.x + Math.cos(a) * 900, y: p.pos.y + Math.sin(a) * 900 });
});
await page.mouse.move(abeam.x, abeam.y);
await page.waitForTimeout(150);
await page.keyboard.down('t');
await page.waitForTimeout(400);
check(await P(() => window.__game.world._torpPreview) === true, 'holding T shows the fan');
await page.screenshot({ path: OUT + '/04-torp-fan.png' });
await page.keyboard.up('t');
await page.waitForTimeout(150);
const torps = await P(() => window.__game.world.player.launchers.filter(l => l.cd > 0).length);
check(torps >= 1, 'releasing T launched a torpedo salvo');

// 8) consumables: smoke, boost, damage control; smoke hides the player
await tap('f');
await tap('Shift');
await page.waitForTimeout(300);
const cons = await P(() => { const c = window.__game.world.player.cons; return { smoke: c.smoke.active || c.smoke.charges < 3, boost: c.boost.active }; });
check(cons.smoke, 'F lays smoke');
check(cons.boost, 'SHIFT engages boost');
await page.keyboard.up('w');
await page.keyboard.down('s');     // back into our own smoke
await page.waitForTimeout(2600);
await page.keyboard.up('s');
const vis = await page.locator('#vis-status').textContent();
console.log('     visibility indicator:', JSON.stringify(vis));
await page.screenshot({ path: OUT + '/05-smoke.png' });
await tap('e');
await tap('r');
await page.screenshot({ path: OUT + '/06-consumables.png' });

// 9) RMB on empty water clears the secondary focus without errors
await page.mouse.click(200, 700, { button: 'right' });

// 10) let the battle run — bots engage, ribbons appear
await page.keyboard.down('w');
await page.mouse.move(1000, 250);
await page.mouse.down({ button: 'left' });
await page.waitForTimeout(12000);
await page.mouse.up({ button: 'left' });
await page.keyboard.up('w');
await page.screenshot({ path: OUT + '/07-battle.png' });
const st = await P(() => { const w = window.__game.world; return { t: w.time, hit: w.player.shotsHit, dmg: Math.round(w.player.dmgDealt), hp: Math.round(w.player.hp), alive: w.player.alive }; });
console.log('     battle state:', JSON.stringify(st));
check(st.t > 20, 'sim advanced');
const hpText = await page.locator('#hp-text').textContent();
if (!hpText) fail('HUD readouts empty');

// 11) pause / resume (the match may already be over — then start a fresh one first)
if (await page.locator('#end').isVisible()) {
   console.log('     match ended before the pause check — starting a fresh easy match');
   await page.screenshot({ path: OUT + '/08-end.png' });
   await page.click('#btn-again');
   await page.waitForTimeout(500);
}
await tap('p');
await page.waitForTimeout(250);
check(await page.locator('#pause').isVisible(), 'pause overlay');
await page.screenshot({ path: OUT + '/09-pause.png' });
await tap('p');
await page.waitForTimeout(250);
check(!(await page.locator('#pause').isVisible()), 'resumed');

// 12) console error report
if (errors.length) {
   console.log('\nCONSOLE ERRORS (' + errors.length + '):');
   for (const e of errors.slice(0, 20)) console.log('  -', e);
   exitCode = 1;
} else {
   console.log('\nno console errors ✔');
}

await browser.close();
process.exit(exitCode);
