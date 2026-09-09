// tests/playwright3d.shots.mjs — headless self-test for the 3D mode: load page, catch
// console/shader errors, start a game, verify the turret-lock firing gate actually works
// (that's the headline mechanic of the 3D mode), take screenshots.
//
// IMPORTANT mouse-model note: the camera/aim scheme is now pure WoWs-style mouse-look (see
// input3d.js/main3d.js) -- the reticle is FIXED at screen centre and ONLY movementX/Y deltas
// matter, never absolute cursor position. Two Playwright/Chromium quirks make the obvious
// `page.mouse.move(x, y)` approach unreliable here:
//   1) `page.mouse.move` teleports the synthetic OS cursor to an ABSOLUTE point. Doing that
//      repeatedly from wherever it last was works for small steps, but any jump back to a
//      fixed coordinate (e.g. to "recentre") produces one huge uncontrolled movementX/Y delta.
//   2) Chromium clamps the synthetic cursor position to the viewport bounds -- once accumulated
//      moves would push it outside the viewport, further moves in that direction silently stop
//      producing new movementY/X entirely (verified: sweeping a cursor down past the 810px
//      viewport bottom froze movementY dead at whatever it last was, well before test assertions
//      were satisfied).
// `look()` below sidesteps both: it dispatches a SYNTHETIC mousemove event with an explicit
// movementX/Y directly, never touching the OS-level cursor position at all. This is exactly
// what input3d.js reads (`e.movementX || 0`), so it drives the real look code path faithfully
// without any of the position-tracking pitfalls above. `resetLook()` snaps cam3 back to
// neutral via direct state assignment (exact, instant, position-independent).
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

// Dispatch a synthetic mousemove carrying an explicit movementX/Y delta -- see the file-level
// comment above for why this replaces page.mouse.move() for look/aim steering. `steps` splits
// the delta into that many smaller events (closer to how a real mouse reports many small
// moves rather than one big jump; matters for code that reacts per-event rather than per-sum).
async function look(dx, dy, steps = 1) {
   await page.evaluate(([dx, dy, steps]) => {
      for (let i = 0; i < steps; i++) {
         window.dispatchEvent(new MouseEvent('mousemove', { movementX: dx / steps, movementY: dy / steps, bubbles: true }));
      }
   }, [dx, dy, steps]);
}
async function settle(ms = 150) { await page.waitForTimeout(ms); }
async function resetLook() { await page.evaluate(() => { window.__cam3.yawOff = 0; window.__cam3.pitchOff = 0; }); }

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
// Position the real OS cursor once, roughly centre-screen, for the mousedown/up fire-trigger
// clicks used throughout this file (those need a real click target; look() never touches
// cursor position so it doesn't interact with this at all).
await page.mouse.move(720, 405);
await resetLook();

// 3b) THE flat-angle fix: the user could not get the camera flat enough to aim long shots.
// The old _syncCamera added a pitch-independent base height (`60 + dist*0.4`), so even at
// minimum pitch the view looked down ~31 deg and the sea plane at the screen bottom only
// reached a few hundred metres -- 1800 m shots were physically unaimable. Now the camera is
// a PURE orbit AND the mouse always drives it (no button held -- WoWs-style, see input3d.js):
// dragging the mouse straight down drives the pitch to its floor and drops the camera to the
// waterline. Prove reachability: record the resting camera height, drive the pitch down via
// plain mouse moves, and confirm the camera actually reaches the flat/waterline regime.
const camYBefore = await page.evaluate(() => window.__camY());
for (let i = 0; i < 20; i++) { await look(0, 30); await settle(20); }
await settle(300);
const { camYFlat, pitchFlat } = await page.evaluate(() => ({ camYFlat: window.__camY(), pitchFlat: window.__cam3.pitchOff }));
console.log(`flat-pitch: camY ${camYBefore.toFixed(0)}m -> ${camYFlat.toFixed(0)}m | pitchOff ${pitchFlat.toFixed(3)} (floor -0.55)`);
if (pitchFlat > -0.5) { console.log('FAIL: could not drive pitch to the flat floor'); exitCode = 1; }
if (camYFlat > 60) { console.log('FAIL: camera did not drop to the waterline at flat pitch'); exitCode = 1; }
if (camYFlat >= camYBefore - 50) { console.log('FAIL: flat pitch barely moved the camera'); exitCode = 1; }
await page.screenshot({ path: OUT + '/3d-06-flatpitch.png' });
await resetLook();
await settle(100);

// 3c) THE flight-path fix: a shell's ballistic arc must span THIS shot's real flight, not a
// fixed full-range parabola. Root cause was estRange=null -> state.js fell back to gun.range,
// so EVERY player shot drew the same ~1800 m crest even point-blank. Now fireMain/fireSecondary
// receive a pseudo-target at the aim point, so arcDur == muzzle-to-aim distance / vShell.
// Fire SECONDARIES (no turret-lock gate -> reliable) at a mid-range aim point and confirm the
// spawned shell's arcDur matches the actual aim distance. Also runs early, before the ship
// can plausibly have sunk from bot fire. The aim point is ALWAYS screen centre (the fixed
// reticle) -- steer the aim distance by turning the camera (pitch) with small incremental
// mouse moves, sweeping continuously with look() (synthetic movementY deltas, never a real cursor move).
await page.keyboard.down('2'); await page.waitForTimeout(80); await page.keyboard.up('2');
let aimOK = false;
for (let i = 0; i < 60 && !aimOK; i++) {
   await look(0, 10, 1);
   await settle(20);
   const ad = await page.evaluate(() => {
      const w = window.__world(); const p = w.player;
      return w._aimPoint ? Math.hypot(w._aimPoint.x - p.pos.x, w._aimPoint.y - p.pos.y) : 0;
   });
   // >200 m so we're clear of the 150 m floor, <900 m so the expected arcDur stays well under
   // the old bug's fixed 1.83 s and the two are unambiguously distinguishable.
   if (ad > 200 && ad < 900) aimOK = true;
}
console.log('mid-range aim point found:', aimOK);
if (!aimOK) { console.log('FAIL: could not find a mid-range aim point'); exitCode = 1; }
// Hold the trigger long enough to guarantee at least one volley (sec reload is 1.3 s), then
// snapshot the newest player shell + the aim point ATOMICALLY (one evaluate).
const beforeCount = await page.evaluate(() => window.__world().shells.filter(s => s.owner === 'player').length);
await page.mouse.down();
await page.waitForTimeout(1500);
await page.mouse.up();
const arc = await page.evaluate((bc) => {
   const w = window.__world(); const p = w.player;
   const mine = w.shells.filter(s => s.owner === 'player');
   const s = mine[bc] || mine[mine.length - 1];
   return {
      arcDur: s ? s.arcDur : null,
      vShell: s ? (s.gun.vShell || 650) : null,
      aimDist: w._aimPoint ? Math.hypot(w._aimPoint.x - p.pos.x, w._aimPoint.y - p.pos.y) : null,
   };
}, beforeCount);
console.log(`flight path: shell arcDur ${arc.arcDur?.toFixed(2)}s vs aim ${arc.aimDist?.toFixed(0)}m / ${arc.vShell} m/s = ${(arc.aimDist / arc.vShell).toFixed(2)}s`);
if (arc.arcDur == null) { console.log('FAIL: no player shell spawned'); exitCode = 1; }
else {
   const expected = arc.aimDist / arc.vShell;
   // Generous band: the muzzle sits ~60 m off the ship centre and the ship drifts during the
   // hold, so aimDist (centre-to-aim) and arcDur (muzzle-to-aim) differ by well under 0.5 s.
   if (Math.abs(arc.arcDur - expected) > 0.5) {
      console.log('FAIL: shell arcDur does not match the actual aim distance (arc not sized to this shot)'); exitCode = 1;
   }
   // Hard cap that pins the regression: pre-fix, estRange was null so state.js fell back to
   // gun.range and EVERY secondary shot had arcDur = 1100/600 = 1.83 s no matter where you
   // aimed. We aimed mid-range (<900 m -> <1.5 s), so a fixed full-range arc can never pass.
   if (arc.arcDur > 1.6) {
      console.log('FAIL: shell used a fixed full-range arc instead of this shot\'s real distance'); exitCode = 1;
   }
}
// Restore main battery + neutral look for the remaining steps.
await page.keyboard.down('1'); await page.waitForTimeout(80); await page.keyboard.up('1');
await resetLook();
await settle(100);

// 4a) NEW WoWs control: the reticle is FIXED at screen centre (CSS, index-3d.html) -- there is
// no cursor to follow any more, since the mouse now always turns the camera. Confirm the
// element is actually centred rather than left over at some stale position.
const reticleBox = await page.locator('#reticle3d').boundingBox();
const viewport = page.viewportSize();
const centeredX = Math.abs((reticleBox.x + reticleBox.width / 2) - viewport.width / 2) < 2;
const centeredY = Math.abs((reticleBox.y + reticleBox.height / 2) - viewport.height / 2) < 2;
console.log('reticle fixed at screen centre:', centeredX && centeredY, JSON.stringify(reticleBox));
if (!centeredX || !centeredY) { console.log('FAIL: reticle is not centred on screen'); exitCode = 1; }

// 4b) THE core mechanic: turret-lock gates firing. Aim is driven by turning the camera (mouse
// ALWAYS looks now, no button needed). Hold the trigger while sweeping the look direction
// (synthetic movementX deltas via look(), never an absolute cursor teleport) and sample the turret
// status each step. Reconstructing "fired while slewing" from HUD polling is inherently racy
// -- the sim runs on a fixed timestep independent of the poll interval, so a shot can
// legitimately land while locked and the turret can already be slewing toward the next aim
// direction before the following poll samples the DOM, which reads as a false "slewing +
// fired" combo even though the in-game code is correctly gated. So the real assertion lives in
// main3d.js: window.__badFireCount increments ONLY if a main shot's fire conditions were met
// with anyLocked=false -- read that instead of the DOM.
await page.mouse.down();
let sawSlewing = false;
for (let i = 0; i < 15; i++) {
   await look(-25, 0, 3);
   await settle(60);
   const status = await page.evaluate(() => document.getElementById('turret-status').textContent);
   if (status.includes('DREHEN')) sawSlewing = true;
}
const badCombo = (await page.evaluate(() => window.__badFireCount)) > 0;
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
await resetLook();
await settle(100);

// 4c) NEW WoWs control: the mouse ALWAYS turns the camera now (no button needed, WoWs-style)
// and the offset is PERSISTENT -- it stays where you left it, no spring-back. Move, stop, wait
// well past any hypothetical easing time, and confirm the yaw offset is still there.
const camBefore = await page.evaluate(() => window.__cam3.yawOff);
for (let i = 0; i < 8; i++) { await look(-20, -6, 2); await settle(30); }
await page.waitForTimeout(1500); // long past any spring-back easing (old rate was 0.18s)
const camAfter = await page.evaluate(() => window.__cam3.yawOff);
console.log('mouse-look yaw offset before move:', camBefore.toFixed(4), '| after stopping + 1.5s:', camAfter.toFixed(4));
if (Math.abs(camAfter) < 0.05) { console.log('FAIL: mouse-look offset did not persist after stopping'); exitCode = 1; }
if (Math.abs(camAfter - camBefore) < 0.01) { console.log('FAIL: mouse move did not turn the camera'); exitCode = 1; }
console.log('mouse-look is persistent (no spring-back) ✔');
await page.screenshot({ path: OUT + '/3d-03b-mouselook.png' });
await resetLook();
await settle(100);

// 4d) NEW WoWs control: weapons are switched with the NUMBER ROW (1/2/3), LEFT mouse hold
// fires the selected weapon. Part 1: press '2' -> selection switches to secondaries (test
// hook + HUD label).
await page.keyboard.down('2');
await page.waitForTimeout(80);
await page.keyboard.up('2');
const selAfter2 = await page.evaluate(() => window.__weaponSel());
const selLabel = await page.locator('#weapon-sel').textContent();
console.log('weapon after pressing 2:', selAfter2, '| HUD label:', selLabel);
if (selAfter2 !== 'sec') { console.log('FAIL: pressing 2 did not select secondaries'); exitCode = 1; }
if (!selLabel.includes('Sekundär')) { console.log('FAIL: weapon HUD label does not show Sekundär'); exitCode = 1; }

// Part 2: moving the mouse WITHOUT holding the trigger (just looking around, no button held)
// must NOT fire anything -- the mouse always turns the camera now, so this is the only guard
// left against an accidental shot while aiming.
const secBeforeLook = await page.locator('#ammo-sec-n').textContent();
let firedWhileLooking = false;
for (let i = 0; i < 10; i++) {
   await look(-8, 0, 2);
   await settle(100);
   const sec = await page.locator('#ammo-sec-n').textContent();
   if (sec !== 'READY') firedWhileLooking = true;
}
console.log('looking around without the trigger held fired nothing:', !firedWhileLooking, '(readout before:', secBeforeLook + ')');
if (firedWhileLooking) { console.log('FAIL: moving the mouse without the trigger held fired a shot'); exitCode = 1; }
await resetLook();
await settle(100);

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

// 4f) NEW: sniper scope. Scrolling the wheel all the way IN should blend the camera into the
// scope view (render3d.js scopeT -> 1) and toggle the #scope-overlay vignette on; scrolling
// back out should disengage it again.
for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -120); // deltaY<0 == zoom in, see input3d.js
await page.waitForTimeout(200);
const scopeInT = await page.evaluate(() => window.__scopeT());
const scopeInOn = await page.locator('#scope-overlay').evaluate(el => el.classList.contains('on'));
console.log(`scope engaged when zoomed in: scopeT=${scopeInT.toFixed(2)} overlay-on=${scopeInOn}`);
if (scopeInT < 0.9) { console.log('FAIL: scope did not fully engage at max zoom-in'); exitCode = 1; }
if (!scopeInOn) { console.log('FAIL: scope overlay did not toggle on'); exitCode = 1; }
await page.screenshot({ path: OUT + '/3d-07-scope.png' });
for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 120); // zoom back out
await page.waitForTimeout(200);
const scopeOutT = await page.evaluate(() => window.__scopeT());
const scopeOutOn = await page.locator('#scope-overlay').evaluate(el => el.classList.contains('on'));
console.log(`scope disengaged when zoomed out: scopeT=${scopeOutT.toFixed(2)} overlay-on=${scopeOutOn}`);
if (scopeOutT > 0.1) { console.log('FAIL: scope did not disengage when zoomed back out'); exitCode = 1; }
if (scopeOutOn) { console.log('FAIL: scope overlay stayed on after zooming out'); exitCode = 1; }

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
   // btn-again calls startGame() directly (it does not reopen #menu), reusing whatever
   // `difficulty` was already selected -- that's still 'easy' from the very first chip
   // click. Clicking the chip again here would hang: it's inside the still-hidden #menu.
   console.log('match already ended before pause check (fast combat) -- starting a fresh match');
   await page.click('#btn-again');
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

// 6b) THE core fix: P must RESUME, not just pause. The old bug handled the P tap only inside
// the sim-step block, which is skipped while paused -- so a second P could never unpause.
// Now frame() consumes the tap every frame regardless of phase. Press P again -> overlay gone.
if (pauseVisible) {
   await page.keyboard.down('p');
   await page.waitForTimeout(80);
   await page.keyboard.up('p');
   await page.waitForTimeout(300);
   const resumed = !(await page.locator('#pause').isVisible());
   console.log('resume via second P press works:', resumed);
   if (!resumed) { console.log('FAIL: second P press did not resume from pause'); exitCode = 1; }
}

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
