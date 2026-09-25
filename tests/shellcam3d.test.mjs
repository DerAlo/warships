// tests/shellcam3d.test.mjs -- unit tests for the 3D shell camera (game3d/shellcam.js):
// shell choice, analytic shell state vs. the sim, chase pose framing, and the state machine
// (start / impact hold / hand-back / aborts) against a real World with a fake controller.
// Run: node --test tests/shellcam3d.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../game3d/state.js';
import { makeShell, resolveShells } from '../game3d/combat.js';
import {
   ShellCam, pickShell, maxOwnId, shellAt, chasePose, normMode, HOLD, FOV, AUTO_MIN_FLIGHT,
} from '../game3d/shellcam.js';

const DT = 1 / 60, DEG = Math.PI / 180;

// A standard world reduced to the player on an empty sea.
function sea(seed = 3) {
   const w = new World('normal', { mission: 'standard', seed });
   w.ships = [w.player]; w.bots = []; w.obstacles = []; w.shells = []; w.torpedoes = []; w._maxTerrainH = 0;
   w.player.pos = { x: 0, y: 0 }; w.player.heading = 0;
   return w;
}
// One salvo of n shells from the player toward (R, 0); returns the shells.
function salvo(w, R, n = 4, lat = 0) {
   const p = w.player, out = [];
   for (let i = 0; i < n; i++) {
      const s = makeShell(w, p, { x: 0, y: (i - n / 2) * 4 }, { x: R, y: lat }, p.cfg.main, 'main', 'AP');
      w.shells.push(s); out.push(s);
   }
   return out;
}
function fakeCtx(w, mode = 'key') {
   const hud = { shown: true, msgs: [], show(on) { this.shown = on; }, msg(t) { this.msgs.push(t); } };
   const input = {
      pressed: new Map(), mouse: { dx: 0, dy: 0, down: false, right: false, wheel: 0, clicked: false },
      tapped(k) { return this.pressed.get(k) || 0; },
   };
   const st = { phase: 'playing', torp: false, kc: false, lock: null, map: false };
   const ctx = {
      cam3: { override: null }, input, hud, overlay: { clear() {} }, settings: { shellCam: mode }, saveSettings() {},
      simDt: DT, hintEl: null, world: () => w, phase: () => st.phase, torpWarn: () => st.torp, killCamOn: () => st.kc,
      lockedShip: () => st.lock, mapOpen: () => st.map,
   };
   return { ctx, st, hud, input };
}
// one frame: sim step(s) then the camera update, like main3d's loop
function frame(w, cam, input, steps = 1, alpha = 0.5) {
   cam.input();
   for (let i = 0; i < steps; i++) { resolveShells(w, DT); w.time += DT; }
   cam.update(DT * steps, alpha);
   cam.restore();
   input.pressed.clear(); input.mouse.clicked = false;
}

test('normMode: unknown values fall back to "key"', () => {
   assert.equal(normMode('auto'), 'auto');
   assert.equal(normMode('off'), 'off');
   assert.equal(normMode(undefined), 'key');
   assert.equal(normMode(true), 'key');
});

test('pickShell: latest own main salvo, shell landing closest to the aim point', () => {
   const w = sea();
   const old = salvo(w, 9000, 3);
   for (const s of old) s.age = 2;                 // an older salvo still in the air
   const fresh = salvo(w, 12000, 6);
   const enemySec = { ...fresh[0], id: 9999, ownerId: -1, age: 0 };
   const ownSec = { ...fresh[0], id: 10000, kind: 'sec', age: 0 };
   w.shells.push(enemySec, ownSec);
   const s = pickShell(w.shells, w.player.id);
   assert.ok(fresh.includes(s), 'picked from the newest salvo');
   const d = (x) => Math.hypot(x.target.x - x.aimPoint.x, x.target.y - x.aimPoint.y);
   for (const o of fresh) assert.ok(d(s) <= d(o) + 1e-9);
   // minId: only shells newer than the old salvo
   assert.equal(pickShell(w.shells, w.player.id, maxOwnId(w.shells, w.player.id)), null);
   assert.ok(old.includes(pickShell(old, w.player.id)));
   fresh.forEach(x => { x.alive = false; });
   assert.ok(old.includes(pickShell(w.shells, w.player.id)), 'dead shells are skipped');
});

test('shellAt reproduces the simulated shell path; direction climbs, then falls', () => {
   const w = sea();
   const [s] = salvo(w, 16000, 1);
   const st = {};
   let first = null, last = null;
   while (s.alive) {
      const age = s.age;
      shellAt(s, age, st);
      assert.ok(Math.abs(st.x - s.pos.x) < 1e-6 && Math.abs(st.z - s.pos.y) < 1e-6, 'ground position');
      assert.ok(Math.abs(st.y - s.alt) < 1e-6, 'altitude');
      assert.ok(Math.abs(Math.hypot(st.dx, st.dy, st.dz) - 1) < 1e-9, 'unit direction');
      if (!first) first = { ...st };
      last = { ...st };
      resolveShells(w, DT);
   }
   assert.ok(first.pitch > 3 * DEG, 'climbs at launch ' + first.pitch / DEG);
   assert.ok(last.pitch < -5 * DEG, 'plunges at the end ' + last.pitch / DEG);
   assert.ok(last.u > 0.95);
});

test('chasePose: behind and above the shell, shell in view, horizon kept, all flight long', () => {
   const w = sea();
   const [s] = salvo(w, 20000, 1, 3000);
   const st = {}, pose = {};
   const half = FOV / 2 * DEG;
   for (let t = 0; t <= s.dur; t += 0.25) {
      shellAt(s, t, st);
      chasePose(st, st.pitch, null, pose);
      const vx = st.x - pose.px, vy = st.y - pose.py, vz = st.z - pose.pz;
      const vn = Math.hypot(vx, vy, vz);
      assert.ok((vx * st.dx + vz * st.dz) > 0, 'camera behind the shell');
      assert.ok(pose.py > st.y, 'camera above the shell');
      assert.ok(vn > 40 && vn < 90, 'chase distance ' + vn);
      const lookPitch = Math.asin(pose.ly);
      assert.ok(lookPitch >= -18.001 * DEG && lookPitch <= 10.001 * DEG, 'view pitch ' + lookPitch / DEG);
      assert.ok(lookPitch - half < -1 * DEG && lookPitch + half > 1 * DEG, 'horizon inside the view');
      const cos = (vx * pose.lx + vy * pose.ly + vz * pose.lz) / vn;
      assert.ok(Math.acos(Math.min(1, cos)) < half * 0.9, 'shell inside the view at t=' + t.toFixed(2));
   }
   // late-flight blend toward a locked target turns the view toward it
   shellAt(s, s.dur * 0.95, st);
   const a = chasePose(st, st.pitch, null, {});
   const b = chasePose(st, st.pitch, { x: st.x + 200, y: 12, z: st.z + 900, w: 0.6 }, {});
   assert.ok(Math.atan2(b.lz, b.lx) > Math.atan2(a.lz, a.lx), 'view turned toward the target');
});

test('state machine: B arms, next salvo followed, impact hold, clean hand-back', () => {
   const w = sea();
   const { ctx, input, hud } = fakeCtx(w, 'key');
   const cam = new ShellCam(ctx);
   frame(w, cam, input);                             // prime on the new world
   salvo(w, 15000, 4);
   frame(w, cam, input);
   assert.equal(cam.on, false, '"key" mode needs the key');
   w.shells.forEach(s => { s.alive = false; }); frame(w, cam, input);
   input.pressed.set('B', 1); frame(w, cam, input);
   assert.equal(cam.armed, true);
   assert.ok(hud.msgs.at(-1).includes('nächsten Salve'));
   const fired = salvo(w, 15000, 4);
   frame(w, cam, input);
   assert.equal(cam.on, true); assert.equal(cam.state, 'follow'); assert.equal(cam.armed, false);
   assert.ok(fired.includes(cam.shell));
   assert.equal(ctx.cam3.override, cam.pose); assert.equal(hud.shown, false);
   assert.equal(cam.blocksFire(), true);
   const followed = cam.shell;
   // smoothness: the per-frame camera step may change only gradually (shells fly ~1-3 km/s,
   // so the step itself is large; a jitter would show as a jump in the step)
   let prev = { ...cam.pose }, step = null, maxJerk = 0, frames = 0;
   while (cam.state === 'follow' && frames < 2000) {
      frame(w, cam, input);
      if (cam.state === 'follow') {
         const d = { x: cam.pose.px - prev.px, y: cam.pose.py - prev.py, z: cam.pose.pz - prev.pz };
         if (step) maxJerk = Math.max(maxJerk, Math.hypot(d.x - step.x, d.y - step.y, d.z - step.z));
         step = d;
      }
      prev = { ...cam.pose }; frames++;
   }
   assert.equal(followed.alive, false);
   assert.equal(cam.state, 'hold');
   assert.ok(Math.abs(frames * DT - followed.dur) < 0.1, 'followed for the whole flight');
   assert.ok(maxJerk < 3, 'no pose jitter: ' + maxJerk.toFixed(2));
   const holdFrames = Math.ceil(HOLD / DT) + 1;
   for (let i = 0; i < holdFrames && cam.on; i++) frame(w, cam, input);
   assert.equal(cam.on, false); assert.equal(cam.reason, 'done');
   assert.equal(ctx.cam3.override, null); assert.equal(hud.shown, true);
   assert.equal(cam.blocksFire(), false);
});

test('"auto" follows long salvos only and B follows a salvo already in flight', () => {
   const w = sea();
   const { ctx, input } = fakeCtx(w, 'auto');
   const cam = new ShellCam(ctx);
   frame(w, cam, input);
   const short = salvo(w, 2500, 2);
   assert.ok(short[0].dur < AUTO_MIN_FLIGHT);
   frame(w, cam, input);
   assert.equal(cam.on, false, 'short salvo skipped');
   short.forEach(s => { s.alive = false; }); frame(w, cam, input);
   salvo(w, 14000, 3);
   frame(w, cam, input);
   assert.equal(cam.on, true, 'long salvo followed');
   input.pressed.set('B', 1); frame(w, cam, input);     // B while active: back, not re-armed
   assert.equal(cam.on, false); assert.equal(cam.armed, false); assert.equal(cam.reason, 'input');
   ctx.settings.shellCam = 'key';
   input.pressed.set('B', 1); frame(w, cam, input);     // salvo still in the air: follow it now
   assert.equal(cam.on, true);
});

test('aborts: click (fire held until release), torpedo warning, hit, kill cam, phase', () => {
   const w = sea();
   const { ctx, st, input } = fakeCtx(w, 'auto');
   const cam = new ShellCam(ctx);
   frame(w, cam, input);
   const restart = () => { w.shells = []; salvo(w, 16000, 3); frame(w, cam, input); assert.equal(cam.on, true); };

   restart();
   input.mouse.clicked = true; input.mouse.down = true; frame(w, cam, input);
   assert.equal(cam.reason, 'input'); assert.equal(ctx.cam3.override, null);
   assert.equal(cam.blocksFire(), true, 'the skip click does not fire');
   input.mouse.down = false;
   assert.equal(cam.blocksFire(), false);

   restart(); st.torp = true; frame(w, cam, input); st.torp = false;
   assert.equal(cam.reason, 'danger');

   restart();
   w.pushEvent('pen', { srcId: -1, dstId: w.player.id, dmg: 1000 }); frame(w, cam, input);
   assert.equal(cam.reason, 'hit');

   restart();
   w.pushEvent('pen', { srcId: w.player.id, dstId: 12345, dmg: 1000 }); frame(w, cam, input);
   assert.equal(cam.on, true, 'own hits on others do not abort');
   const other = { px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0, fov: 40 };
   st.kc = true; ctx.cam3.override = other; frame(w, cam, input);
   assert.equal(cam.reason, 'killcam');
   assert.equal(ctx.cam3.override, other, 'kill cam keeps the camera');
   st.kc = false; ctx.cam3.override = null;

   restart(); st.phase = 'paused'; frame(w, cam, input); st.phase = 'playing';
   assert.equal(cam.reason, 'phase');

   restart(); input.mouse.wheel = 1; frame(w, cam, input); input.mouse.wheel = 0;
   assert.equal(cam.reason, 'input');
});

test('render interpolation is undone exactly and allocates no per-frame state', () => {
   const w = sea();
   const { ctx, input } = fakeCtx(w, 'auto');
   const cam = new ShellCam(ctx);
   frame(w, cam, input);
   salvo(w, 16000, 6);
   frame(w, cam, input);
   for (let i = 0; i < 30; i++) { resolveShells(w, DT); w.time += DT; }
   const before = w.shells.map(s => [s.pos.x, s.pos.y, s.alt]);
   const saved = cam._saved;
   cam.update(DT, 0.25);
   const moved = w.shells.some((s, i) => s.pos.x !== before[i][0]);
   assert.ok(moved, 'shells drawn at the interpolated time');
   cam.restore();
   assert.deepEqual(w.shells.map(s => [s.pos.x, s.pos.y, s.alt]), before);
   for (let i = 0; i < 10; i++) { cam.update(DT, 0.5); cam.restore(); }
   assert.equal(cam._saved, saved, 'scratch buffer reused');
});
