// tests/playwright3d.touch.mjs -- browser test of the touch controls (game3d/touch3d.js) on a phone held
// sideways (915x412) and a tablet (1180x820): the overlay appears only in a touch context, the telegraph
// lever and the rudder steer the ship, FIRE fires, the scope button and a pinch zoom, a drag aims, the
// weapon/consumable plates, map and pause, the carrier buttons (plane type, launch, back to the ship,
// recall) and the submarine buttons (dive, surface). Exit code 1 on a failed check or a console error.
//
// Run:  node server.js 8806   then   URL3D=http://localhost:8806/index-3d.html node tests/playwright3d.touch.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:8806/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};

const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });

async function open(viewport, touch) {
   const ctx = await browser.newContext(touch ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 1 } : { viewport });
   const page = await ctx.newPage();
   const tag = `[${viewport.width}x${viewport.height}${touch ? '' : ' desktop'}] `;
   page.on('console', m => { if (m.type() === 'error') errors.push(tag + m.text()); });
   page.on('pageerror', e => errors.push(tag + 'PAGEERROR: ' + e.message));
   await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
   await page.goto(URL, { waitUntil: 'load' });
   await page.waitForTimeout(1000);
   const cdp = touch ? await ctx.newCDPSession(page) : null;
   const ev = (fn, arg) => page.evaluate(fn, arg);
   const wait = ms => page.waitForTimeout(ms);
   const waitFor = async (fn, timeout = 6000, step = 50) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { if (await ev(fn)) return true; await wait(step); }
      return false;
   };
   const box = async (sel) => page.locator(sel).first().boundingBox();
   const centre = async (sel) => { const b = await box(sel); return b ? [b.x + b.width / 2, b.y + b.height / 2] : null; };
   const tap = async (sel) => { const c = await centre(sel); if (!c) return false; await page.touchscreen.tap(c[0], c[1]); await wait(120); return true; };
   const tapAt = async (x, y) => { await page.touchscreen.tap(x, y); await wait(120); };
   // raw multi-finger touches through CDP (drag, hold, pinch)
   const touchEv = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
   const start = async (ship) => {
      await ev((s) => window.__start({ difficulty: 'easy', mission: 'standard', ship: s }), ship);
      await waitFor(() => window.__phase() === 'playing', 6000);
      await wait(1200);
   };
   const visible = (sel) => page.locator(sel).first().isVisible();
   return { ctx, page, tag, ev, wait, waitFor, box, centre, tap, tapAt, touchEv, start, visible };
}

// ---------------- desktop: no overlay, mouse firing untouched ----------------
{
   const t = await open({ width: 1440, height: 810 }, false);
   await t.start('Bismarck');
   const st = await t.ev(() => window.__touch());
   check(t.tag + 'no touch overlay on a desktop', !st.on && !st.shown && !(await t.visible('#touch-ui')), st);
   check(t.tag + 'no touch class on the body', !(await t.ev(() => document.body.classList.contains('touch'))));
   await t.ctx.close();
}

// ---------------- phone and tablet: battleship ----------------
for (const [vp, ship] of [[{ width: 915, height: 412 }, 'Bismarck'], [{ width: 1180, height: 820 }, 'Fletcher']]) {
   const t = await open(vp, true);
   const { ev, wait, waitFor, tap, tapAt, touchEv, start, visible, page } = t;
   const tag = t.tag + ship + ': ';
   check(tag + 'port menu has no touch overlay', !(await visible('#touch-ui')));
   await start(ship);
   const st = await ev(() => window.__touch());
   check(tag + 'touch overlay shown in battle', st.on && st.shown && await visible('#tu-fire') && await visible('#tu-tele') && await visible('#tu-rud'), st);
   check(tag + 'keyboard hint line hidden', !(await visible('#hint-line')));
   check(tag + 'canvas has touch-action none', (await ev(() => getComputedStyle(document.getElementById('scene3d')).touchAction)) === 'none');
   const small = await ev(() => [...document.querySelectorAll('#touch-ui .tu-btn, #tu-tele .tu-st')]
      .filter(b => b.offsetParent).map(b => [b.id || b.className, b.getBoundingClientRect()])
      // buttons at least 48 px square; the telegraph lever is one slider, its notches at least 40 px apart
      .filter(([n, r]) => /tu-st/.test(n) ? r.height < 39.5 : r.width < 47.5 || r.height < 47.5).map(([n, r]) => `${n} ${Math.round(r.width)}x${Math.round(r.height)}`));
   check(tag + 'touch targets are large enough', small.length === 0, small);

   // telegraph lever: absolute steps
   await tap('#tu-tele .tu-st[data-n="2"]');
   check(tag + 'telegraph lever: 1/2 ahead', (await ev(() => window.__ctl().telegraph)) === 2, await ev(() => window.__ctl().telegraph));
   await tap('#tu-tele .tu-st[data-n="4"]');
   check(tag + 'telegraph lever: full ahead', (await ev(() => window.__ctl().telegraph)) === 4);
   await tap('#tu-tele .tu-st[data-n="-1"]');
   check(tag + 'telegraph lever: astern', (await ev(() => window.__ctl().telegraph)) === -1);
   await tap('#tu-tele .tu-st[data-n="3"]');

   // rudder track: ends and centre
   const rb = await t.box('#tu-rud');
   await tapAt(rb.x + rb.width - 8, rb.y + rb.height / 2);
   check(tag + 'rudder: full starboard', (await ev(() => window.__ctl().rudder)) === 2, await ev(() => window.__ctl().rudder));
   await tapAt(rb.x + 8, rb.y + rb.height / 2);
   check(tag + 'rudder: full port', (await ev(() => window.__ctl().rudder)) === -2);
   await tapAt(rb.x + rb.width / 2, rb.y + rb.height / 2);
   check(tag + 'rudder: amidships', (await ev(() => window.__ctl().rudder)) === 0);
   check(tag + 'ship under way', await waitFor(() => window.__world().player.speed > 1, 6000));

   // drag on the sea turns the camera
   const y0 = await ev(() => window.__aim().targetYaw);
   const sx = vp.width * 0.55, sy = vp.height * 0.3;
   await touchEv('touchStart', [[sx, sy]]);
   for (let i = 1; i <= 8; i++) { await touchEv('touchMove', [[sx + i * 15, sy]]); await wait(16); }
   await touchEv('touchEnd', []);
   await wait(150);
   const y1 = await ev(() => window.__aim().targetYaw);
   check(tag + 'drag turns the camera', Math.abs(y1 - y0) > 0.05, { y0, y1 });
   check(tag + 'a drag does not fire', (await ev(() => window.__fired().shots)) === 0);
   // swing back so the bow guns bear again
   await touchEv('touchStart', [[sx, sy]]);
   for (let i = 1; i <= 8; i++) { await touchEv('touchMove', [[sx - i * 15, sy]]); await wait(16); }
   await touchEv('touchEnd', []);

   // FIRE (hold until a salvo leaves)
   await wait(600);
   const fb = await t.centre('#tu-fire');
   await touchEv('touchStart', [fb]);
   const shot = await waitFor(() => window.__fired().shots > 0, 12000);
   await touchEv('touchEnd', []);
   check(tag + 'FIRE fires the main battery', shot, await ev(() => window.__fired()));
   if (vp.width === 915) await page.screenshot({ path: `${OUT}/3d-touch-phone.png` });

   // weapon plates (after firing: a shell change restarts the reload)
   await tap('#weapons .wslot[data-w="HE"]');
   check(tag + 'weapon plate: HE shells', (await ev(() => window.__ctl().ammo)) === 'HE', await ev(() => window.__ctl().ammo));
   await tap('#weapons .wslot[data-w="AP"]');
   check(tag + 'weapon plate: AP shells', (await ev(() => window.__ctl().ammo)) === 'AP');
   if (await visible('#weapons .wslot[data-w="TORP"]:not(.none)')) {
      await tap('#weapons .wslot[data-w="TORP"]');
      const torpSel = await ev(() => window.__weaponSel());
      await tap('#weapons .wslot[data-w="AP"]');
      check(tag + 'weapon plate: torpedoes and back', torpSel === 'torp' && (await ev(() => window.__weaponSel())) === 'main', torpSel);
   }

   // scope toggle and pinch zoom
   await tap('#tu-scope');
   check(tag + 'scope button: binoculars on', await waitFor(() => window.__ctl().bino, 1500));
   await tap('#tu-scope');
   check(tag + 'scope button: binoculars off', await waitFor(() => !window.__ctl().bino, 1500));
   await wait(400);
   const z0 = await ev(() => window.__zoom3d());
   const cx = vp.width * 0.6, cy = vp.height * 0.35;
   await touchEv('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
   for (let i = 1; i <= 8; i++) { await touchEv('touchMove', [[cx - 30 - i * 14, cy], [cx + 30 + i * 14, cy]]); await wait(20); }
   await touchEv('touchEnd', []);
   await wait(500);
   const z1 = await ev(() => window.__zoom3d());
   check(tag + 'pinch out zooms in', z1.bino || z1.level !== z0.level || z1.distTarget < z0.distTarget - 1, { z0: [z0.level, z0.distTarget], z1: [z1.level, z1.distTarget, z1.bino] });
   if (z1.bino) { await tap('#tu-scope'); await wait(300); }

   // consumable plate: one of them takes
   const c0 = await ev(() => window.__cons());
   let used = false;
   for (const c of c0) {
      await tap(`#cons .cslot[data-slot="${c.slot}"]`);
      const c1 = (await ev(() => window.__cons())).find(x => x.slot === c.slot);
      if (c1 && (c1.active || c1.charges < c.charges || c1.cd > c.cd)) { used = true; break; }
   }
   check(tag + 'consumable plate starts a consumable', used, c0.map(c => c.slot));

   // map and pause
   await tap('#tu-map');
   check(tag + 'map button opens the map', await waitFor(() => window.__ctl().mapOpen, 1000));
   await tap('#tu-map');
   check(tag + 'map button closes the map', await waitFor(() => !window.__ctl().mapOpen, 1000));
   await tap('#tu-pause');
   check(tag + 'pause button pauses', await waitFor(() => window.__phase() === 'paused', 1000));
   check(tag + 'overlay hidden while paused', await waitFor(() => !window.__touch().shown, 1000));
   await tap('#btn-resume');
   check(tag + 'resume by touch', await waitFor(() => window.__phase() === 'playing' && window.__touch().shown, 1500));
   await t.ctx.close();
}

// ---------------- carrier (tablet) ----------------
{
   const t = await open({ width: 1180, height: 820 }, true);
   const { ev, waitFor, tap, start, visible, page, tag } = t;
   await start('Enterprise');
   check(tag + 'carrier: plane-type bar and launch button', await visible('#tu-bar .tu-btn[data-t="db"]') && await visible('#tu-launch'));
   check(tag + 'carrier: no gun weapon plates', !(await visible('#weapons')));
   const f0 = await ev(() => window.__world().player.aaFocus);
   await tap('#tu-aa');
   check(tag + 'carrier: AA focus button', (await ev(() => window.__world().player.aaFocus)) !== f0);
   await tap('#tu-bar .tu-btn[data-t="db"]');
   check(tag + 'carrier: select dive bombers', (await ev(() => window.__air().sel)) === 'db');
   await tap('#tu-launch');
   check(tag + 'carrier: launch and take over', await waitFor(() => window.__air().flying && window.__air().override, 3000), await ev(() => window.__air()));
   await t.wait(1500);
   check(tag + 'carrier: squadron controls shown', await waitFor(() => document.body.classList.contains('tu-squad'), 1000) && await visible('#tu-ship') && await visible('#tu-recall'));
   await page.screenshot({ path: `${OUT}/3d-touch-squadron.png` });
   await tap('#tu-ship');
   check(tag + 'carrier: back to the ship', await waitFor(() => !window.__air().flying && !window.__air().override, 3000));
   await tap('#tu-launch');
   check(tag + 'carrier: take over the flying squadron again', await waitFor(() => window.__air().flying, 3000));
   await t.wait(400);          // the overlay refreshes its buttons five times a second
   await tap('#tu-recall');
   check(tag + 'carrier: recall', await waitFor(() => !window.__air().flying, 2000)
      && await ev(() => window.__world().squadrons.filter(s => s.ownerId === window.__world().player.id && s.type === 'db').every(s => s.state === 'return' || s.state === 'land')));
   await t.ctx.close();
}

// ---------------- submarine (phone) ----------------
{
   const t = await open({ width: 915, height: 412 }, true);
   const { ev, waitFor, tap, start, visible, tag } = t;
   await start('U96');
   check(tag + 'submarine: dive and surface buttons', await visible('#tu-dive') && await visible('#tu-up'));
   const d0 = await ev(() => window.__world().player.depthTarget);
   await tap('#tu-dive');
   const d1 = await ev(() => window.__world().player.depthTarget);
   check(tag + 'submarine: dive', d1 > d0, { d0, d1 });
   await tap('#tu-up');
   check(tag + 'submarine: surface', (await ev(() => window.__world().player.depthTarget)) < d1);
   await tap('#weapons .wslot[data-w="TORP"]');
   check(tag + 'submarine: torpedo plate', (await ev(() => window.__weaponSel())) === 'torp');
   await t.ctx.close();
}

const fails = results.filter(r => !r.ok).length;
check('no console errors', errors.length === 0, errors.slice(0, 5));
console.log(`\n${results.length - fails - (errors.length ? 1 : 0)}/${results.length} checks passed`);
await browser.close();
process.exit(fails || errors.length ? 1 : 0);
