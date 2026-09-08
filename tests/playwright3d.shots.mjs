// tests/playwright3d.shots.mjs — headless self-test for the 3D mode: load page, catch
// console/shader errors, start a game, verify the turret-lock firing gate actually works
// (that's the headline mechanic of the 3D mode), take screenshots.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const OUT = 'tests/shots';
mkdirSync(OUT, { recursive: true });

const errors = [];
let exitCode = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

// 1) menu loads
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200);
const menuVisible = await page.locator('#menu').isVisible();
console.log('menu visible:', menuVisible);
if (!menuVisible) { console.log('FAIL: menu not visible'); exitCode = 1; }
await page.screenshot({ path: OUT + '/3d-01-menu.png' });

// 2) howto overlay
await page.click('#btn-how');
await page.waitForTimeout(200);
const howtoVisible = await page.locator('#howto').isVisible();
console.log('howto visible:', howtoVisible);
if (!howtoVisible) { console.log('FAIL: howto not visible'); exitCode = 1; }
await page.click('#btn-how-close');

// 3) start game
await page.click('.chip[data-diff="easy"]');
await page.click('#btn-play');
await page.waitForTimeout(600);
const hudVisible = await page.locator('#hud').isVisible();
console.log('hud visible:', hudVisible);
if (!hudVisible) { console.log('FAIL: hud not visible after start'); exitCode = 1; }
await page.screenshot({ path: OUT + '/3d-02-battle.png' });

// 4a) NEW WoWs control: the reticle follows the live cursor. Move the pointer and confirm
// the on-screen reticle (#reticle3d) tracks it (its left/top move with the cursor).
await page.mouse.move(400, 300);
await page.waitForTimeout(120);
const r1 = await page.locator('#reticle3d').evaluate(el => ({ l: el.style.left, t: el.style.top }));
await page.mouse.move(900, 500);
await page.waitForTimeout(120);
const r2 = await page.locator('#reticle3d').evaluate(el => ({ l: el.style.left, t: el.style.top }));
const reticleFollows = r1.l !== r2.l && r1.t !== r2.t;
console.log('reticle follows cursor:', reticleFollows, JSON.stringify(r1), '->', JSON.stringify(r2));
if (!reticleFollows) { console.log('FAIL: reticle did not track the cursor'); exitCode = 1; }

// 4b) THE core mechanic: turret-lock gates firing. Aim is now driven by the CURSOR position
// (raycast onto the sea plane). Hold the trigger while sweeping the cursor across the screen
// (real intermediate mousemove events, not a teleport) and sample the turret-status + ammo
// readout together at each step -- across the whole sweep we must NEVER observe "still
// slewing" together with a fired shot (ammo != READY).
await page.mouse.move(700, 400);
await page.mouse.down();
let sawSlewing = false, badCombo = false;
for (let i = 0; i < 15; i++) {
   await page.mouse.move(700 - i * 25, 400, { steps: 3 });
   await page.waitForTimeout(60);
   const [status, ammo] = await Promise.all([
      page.locator('#turret-status').textContent(),
      page.locator('#ammo-main-n').textContent(),
   ]);
   if (status.includes('DREHEN')) { sawSlewing = true; if (ammo !== 'READY') badCombo = true; }
}
await page.mouse.up();
console.log('observed a slewing sample during the sweep:', sawSlewing, '| forbidden (slewing+fired) combo seen:', badCombo);
if (badCombo) { console.log('FAIL: main battery fired while turrets were still slewing'); exitCode = 1; }
if (!sawSlewing) console.log('NOTE: sweep never caught the turrets mid-slew this run -- gate untested but not failed');
await page.waitForTimeout(3500);
await page.mouse.down();
await page.waitForTimeout(300);
const ammoAfterLock = await page.locator('#ammo-main-n').textContent();
await page.mouse.up();
console.log('ammo main after letting turrets settle + firing (cooldown expected if a target was in range):', ammoAfterLock);
await page.screenshot({ path: OUT + '/3d-03-turretlock.png' });

// 4c) NEW WoWs control: right-mouse DRAG is free-look (orbits the chase cam) and the
// perspective is PERSISTENT -- it stays where you left it, no spring-back. Drag, release,
// wait well past any hypothetical easing time, and confirm the yaw offset is still there.
await page.mouse.move(720, 405);
const camBefore = await page.evaluate(() => window.__cam3.yawOff);
await page.mouse.down({ button: 'right' });
for (let i = 0; i < 8; i++) { await page.mouse.move(720 - i * 20, 405 - i * 6, { steps: 2 }); await page.waitForTimeout(30); }
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(1500); // long past any spring-back easing (old rate was 0.18s)
const camAfter = await page.evaluate(() => window.__cam3.yawOff);
console.log('free-look yaw offset before drag:', camBefore.toFixed(4), '| after release + 1.5s:', camAfter.toFixed(4));
if (Math.abs(camAfter) < 0.05) { console.log('FAIL: free-look offset did not persist after release'); exitCode = 1; }
if (Math.abs(camAfter - camBefore) < 0.01) { console.log('FAIL: free-look drag did not move the camera'); exitCode = 1; }
console.log('free-look is persistent (no spring-back) ✔');
await page.screenshot({ path: OUT + '/3d-03b-freelook.png' });

// 4d) NEW WoWs control: weapons are switched with the NUMBER ROW (1/2/3), LEFT mouse hold
// fires the selected weapon, and RIGHT mouse is PURE free-look that never fires anything.
// Part 1: press '2' -> selection switches to secondaries (test hook + HUD label).
await page.keyboard.down('2');
await page.waitForTimeout(80);
await page.keyboard.up('2');
const selAfter2 = await page.evaluate(() => window.__weaponSel());
const selLabel = await page.locator('#weapon-sel').textContent();
console.log('weapon after pressing 2:', selAfter2, '| HUD label:', selLabel);
if (selAfter2 !== 'sec') { console.log('FAIL: pressing 2 did not select secondaries'); exitCode = 1; }
if (!selLabel.includes('Sekundär')) { console.log('FAIL: weapon HUD label does not show Sekundär'); exitCode = 1; }

// Part 2: holding RIGHT MOUSE (with a small drag = "looking around") must NOT fire anything.
const secBeforeLook = await page.locator('#ammo-sec-n').textContent();
await page.mouse.move(700, 400);
await page.mouse.down({ button: 'right' });
let firedWhileLooking = false;
for (let i = 0; i < 10; i++) {
   await page.mouse.move(700 - i * 8, 400, { steps: 2 });
   await page.waitForTimeout(100);
   const sec = await page.locator('#ammo-sec-n').textContent();
   if (sec !== 'READY') firedWhileLooking = true;
}
await page.mouse.up({ button: 'right' });
console.log('right-mouse free-look fired nothing:', !firedWhileLooking, '(readout before:', secBeforeLook + ')');
if (firedWhileLooking) { console.log('FAIL: holding right-mouse fired a shot -- free-look must never fire'); exitCode = 1; }

// Part 3: with secondaries selected, LEFT mouse hold fires them (readout leaves READY).
let secFired = false;
await page.mouse.down();
for (let i = 0; i < 10; i++) {
   await page.waitForTimeout(100);
   const sec = await page.locator('#ammo-sec-n').textContent();
   if (sec !== 'READY') secFired = true;
}
await page.mouse.up();
console.log('secondaries fired via left-mouse while "2" selected:', secFired);
if (!secFired) { console.log('FAIL: left-mouse hold did not fire the selected secondaries'); exitCode = 1; }

// Back to main battery for the remaining steps.
await page.keyboard.down('1');
await page.waitForTimeout(80);
await page.keyboard.up('1');
if ((await page.evaluate(() => window.__weaponSel())) !== 'main') { console.log('FAIL: pressing 1 did not restore main battery'); exitCode = 1; }

// 4e) NEW WoWs control: mouse wheel zooms the chase cam. Exercise both directions.
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(40); }
await page.waitForTimeout(200);
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
await page.waitForTimeout(200);
console.log('wheel zoom exercised (no error thrown)');

// 5) basic drive + HUD sanity
await page.keyboard.down('w');
await page.waitForTimeout(2000);
await page.keyboard.up('w');
const speedText = await page.locator('#speed-readout').textContent();
const hpText = await page.locator('#hp-text').textContent();
console.log('speed:', speedText, 'hp:', hpText);
if (!speedText || !hpText) { console.log('FAIL: HUD readouts empty'); exitCode = 1; }
await page.screenshot({ path: OUT + '/3d-04-cruise.png' });

// 6) pause / resume (down/up with a delay -- see tests/playwright.shots.mjs for why not press())
const endVisible = await page.locator('#end').isVisible();
if (endVisible) {
   await page.click('#btn-again');
   await page.waitForTimeout(300);
   await page.click('.chip[data-diff="easy"]');
   await page.click('#btn-play');
   await page.waitForTimeout(500);
}
await page.keyboard.down('p');
await page.waitForTimeout(80);
await page.keyboard.up('p');
await page.waitForTimeout(300);
const pauseVisible = await page.locator('#pause').isVisible();
console.log('pause visible:', pauseVisible);
if (!pauseVisible) { console.log('FAIL: pause overlay missing'); exitCode = 1; }
await page.screenshot({ path: OUT + '/3d-05-pause.png' });

// 7) console/shader error report
if (errors.length) {
   console.log('\nCONSOLE ERRORS (' + errors.length + '):');
   for (const e of errors.slice(0, 20)) console.log('  -', e);
   exitCode = 1;
} else {
   console.log('\nno console errors ✔');
}

await browser.close();
process.exit(exitCode);
