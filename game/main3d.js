// game/main3d.js — 3D game entry point. Reuses the EXACT same simulation core as the 2D
// game (World, Ship, updateBot, combat resolution) -- only rendering, input, and the
// firing gate are different. The headline feature: turret traverse time is a real gate on
// firing, not a loose 40deg cone (that's still used by the bot AI's _maybeFire, unchanged).
import { sub, norm, angleOf, angleDelta, clamp, TAU, DEG } from './utils.js';
import { WORLD } from './config.js';
import { Input3D } from './input3d.js';
import { Renderer3D } from './render3d.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { World } from './state.js';
import { updateBot } from './ai.js';

const $ = (id) => document.getElementById(id);
const scene3d = $('scene3d');
const fxCanvas = $('fx');
const reticleEl = $('reticle3d');

// How tightly a turret must be aimed before the player can actually fire, in degrees.
// This is the whole point of the 3D mode: WoWs-style, you wait for the rumble to stop.
const TURRET_LOCK_DEG = 6 * DEG;

// Chase-camera zoom range (meters). WoWs uses a scroll wheel to dolly in/out; we map the
// wheel to a continuous distance between these bounds instead of two discrete levels.
const ZOOM_MIN = 260, ZOOM_MAX = 1500;
// Neutral over-the-shoulder pose (the starting camera position before any free-look).
const CAM_BASE_YAW = 0.5, CAM_BASE_PITCH = 0.5;

const renderer = new Renderer3D(scene3d);
renderer.setHudCanvases($('minimap-canvas'), $('compass-canvas'));
const hud = new Hud();
const audio = new Audio();
const input = new Input3D(scene3d);

function resize() {
   const w = window.innerWidth, h = window.innerHeight;
   renderer.resize(w, h);
   const fxCtx = fxCanvas.getContext('2d');
   const dpr = Math.min(window.devicePixelRatio || 1, 2);
   fxCanvas.width = Math.round(w * dpr); fxCanvas.height = Math.round(h * dpr);
   fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
   const mm = $('minimap-canvas'), cp = $('compass-canvas');
   mm.width = Math.round(180 * dpr); mm.height = Math.round(180 * dpr);
   mm.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
   // The compass canvas is a 220x42 CSS box (see index-3d.html) and _compass() draws into a
   // 220x42 logical space -- the backing store must match that or the content gets squashed
   // into the top half with a blank bottom half. (It was 84*dpr before: double height.)
   cp.width = Math.round(220 * dpr); cp.height = Math.round(42 * dpr);
   cp.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

let world = null;
let phase = 'menu';
let endTimer = 0;
let difficulty = 'normal';
// Chase-camera state. `zoom` is the continuous camera distance (wheel-driven). `yawOff`/
// `pitchOff` are PERSISTENT free-look offsets applied on top of the neutral over-the-shoulder
// pose -- they stay where the player left them (no spring-back), so the chosen perspective
// survives until the next game. The base pose is offset slightly off dead-astern: looking
// straight down the keel from directly behind reduces the ~250m hull to a sliver.
const cam3 = { zoom: 420, yawOff: 0, pitchOff: 0 };
window.__cam3 = cam3; // test hook (tests/playwright3d.shots.mjs reads this)
window.__shipHdg = () => (world && world.player) ? world.player.heading : null; // test hook
window.__world = () => world; // test hook (gate/shell-count assertions)

const snd = { kills: 0, shotsP: 0, shotsE: 0, torps: 0, hitCd: 0 };

// Selected weapon: 'main' | 'sec' | 'aa'. Switched with the number row (1/2/3); LEFT mouse
// hold fires whatever is selected. Right mouse is pure free-look and never fires -- aiming
// around must not accidentally shoot.
let weaponSel = 'main';
window.__weaponSel = () => weaponSel; // test hook

function startGame() {
   weaponSel = 'main';
   world = new World(difficulty);
   world.audio = audio;
   renderer.buildObstacles(world);
   // Camera is now a world-space orbit pose (not heading-locked). Seed its yaw from the
   // spawn heading so the opening frame still sits behind the ship -- then it STAYS there
   // as you steer, instead of spinning with every rudder input.
   cam3.zoom = 420; cam3.yawOff = -world.player.heading; cam3.pitchOff = 0;
   snd.kills = 0; snd.shotsP = 0; snd.shotsE = 0; snd.torps = 0;
   phase = 'playing';
   endTimer = 0;
   input.gameActive = true;
   $('menu').classList.add('hidden');
   $('end').classList.add('hidden');
   $('pause').classList.add('hidden');
   hud.show(true);
   audio.init();
   audio.uiClick();
}

function showEnd() {
   phase = 'ended';
   input.gameActive = false;
   const p = world.player;
   const won = world.phase === 'won';
   $('end-emoji').textContent = won ? '🏆' : '💀';
   $('end-title').textContent = won ? 'SIEG' : 'NIEDERLAGE';
   $('end-sub').textContent = won ? 'Alle feindlichen Schiffe versenkt.' : 'Die Bismarck ist gesunken.';
   $('stat-kills').textContent = String(world.killCount);
   $('stat-dmg').textContent = Math.round(p.dmgDealt).toLocaleString('de-DE');
   const m = Math.floor(world.time / 60), s = Math.floor(world.time % 60);
   $('stat-time').textContent = m + ':' + String(s).padStart(2, '0');
   $('end').classList.remove('hidden');
}

// ---------- player controller ----------
function controlPlayer(dt) {
   const p = world.player;
   if (!p || !p.alive) return;
   const inp = input;

   // ---- chase camera (WoWs-style) ----
   // Wheel dollies the camera in/out. Right-mouse DRAG orbits the camera around the ship
   // (free-look): the yaw/pitch offsets are PERSISTENT -- they stay where you left them,
   // they do not spring back. That's the player's chosen perspective. Pitch is clamped so
   // you can't dip under the sea. WASD never touches the camera -- it only steers the ship.
   cam3.zoom = clamp(cam3.zoom * Math.pow(1.08, inp.mouse.wheel), ZOOM_MIN, ZOOM_MAX);
   if (inp.mouse.right) {
      cam3.yawOff -= inp.mouse.dx * 0.0032;
      cam3.pitchOff = clamp(cam3.pitchOff - inp.mouse.dy * 0.0022, -0.4, 0.75);
   }
   renderer.setCameraPose(CAM_BASE_YAW + cam3.yawOff, CAM_BASE_PITCH + cam3.pitchOff, cam3.zoom);

   // ---- aim: raycast from the CURSOR through the scene onto the sea plane ----
   // This is what the turrets track toward -- same aimBearing field the 2D game uses, so
   // ship.js's existing turret-slew integration needs no changes at all. The reticle under
   // the cursor marks exactly this point.
   const worldPt = renderer.screenToWorld(inp.mouse.x, inp.mouse.y);
   if (worldPt) {
      const toAim = sub(worldPt, p.pos);
      p.aim = norm(toAim);
      p.aimBearing = angleOf(toAim);
      world._aimPoint = worldPt;
   }
   // park the on-screen reticle under the live cursor
   reticleEl.style.left = inp.mouse.mx + 'px';
   reticleEl.style.top = inp.mouse.my + 'px';

   // helm & throttle
   const helm = inp.helmAxis();
   p.helm = clamp(helm, -1, 1);
   const thr = inp.throttleAxis();
   const anchorWasOut = p.anchorOut;
   p.anchorOut = inp.down('SPACE');
   if (thr !== 0 && !p.anchorOut) p.throttleIn = thr;
   else if (!p.anchorOut && anchorWasOut) p.throttleIn = WORLD.MIN_THROTTLE;
   if (inp.tapped('SPACE')) { world.log(p, '⚓ Anker fällt!', 'info'); audio.uiClick(); }

   // ---- weapon selection: number row. 1 = main battery, 2 = secondaries, 3 = AA.
   // LEFT mouse hold fires whatever is selected; RIGHT mouse is pure free-look and never
   // fires, so looking around can't accidentally shoot.
   if (inp.tapped('1')) weaponSel = 'main';
   else if (inp.tapped('2')) weaponSel = 'sec';
   else if (inp.tapped('3')) weaponSel = 'aa';

   // main-battery traverse gate: computed every frame regardless of selection so the HUD
   // always shows the true turret state. ship.js slews t.bearing toward aimBearing each tick
   // at cfg.turretSlew rad/s (unchanged) -- we just gate the main trigger on it.
   let anyReady = false, anyLocked = false;
   for (const t of p.turrets) {
      if (t.cd > 0) continue;
      anyReady = true;
      const desiredRel = angleDelta(p.heading, p.aimBearing);
      if (Math.abs(angleDelta(t.bearing, desiredRel)) < TURRET_LOCK_DEG) anyLocked = true;
   }
   world._turretLocked = anyReady ? anyLocked : null; // null = no turret off cooldown yet (HUD hides indicator)

   if (inp.mouse.down && worldPt) {
      if (weaponSel === 'main') {
         const toAimVec = sub(worldPt, p.pos);
         const d = Math.hypot(toAimVec.x, toAimVec.y);
         if (d < p.cfg.main.range * 1.15 && p.fireTimer <= 0 && anyLocked) {
            const n = p.fireMain(world, null, p.aim);
            if (n > 0) audio.cannon(true);
         }
      } else if (weaponSel === 'sec') {
         // secondaries are fast-traversing casemate guns: no turret-lock gate.
         if (p.secTimer <= 0) {
            const n = p.fireSecondary(world, null, p.aim);
            if (n > 0) audio.cannon(false);
         }
      } else if (weaponSel === 'aa' && p.cfg.aa) {
         if (p.aaTimer <= 0) {
            let best = null, bestD = p.cfg.aa.range;
            for (const e of world.enemiesOf(p)) {
               const dd = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y);
               if (dd < bestD) { bestD = dd; best = e; }
            }
            if (best) p.fireAA(world, best);
         }
      }
   }

   if (inp.tapped('F') && p.smoke.cd <= 0 && !p.smoke.active) {
      p.smoke.active = true; p.smoke.t = WORLD.SMOKE_DURATION; p.smoke.cd = WORLD.SMOKE_CD + WORLD.SMOKE_DURATION;
      world.log(p, 'Rauchvorhang gelegt', 'info');
   }
   if (inp.tapped('SHIFT') && p.cfg.boost && !p.boost.active && p.boost.cd <= 0) {
      p.boost.active = true; p.boost.t = p.cfg.boost.dur; p.boost.cd = p.cfg.boost.cd;
      world.log(p, '⚡ Turbo!', 'info');
   }
   if (inp.tapped('R')) {
      if (p.fires.length || p.floods.length) { p.repairAll(); world.log(p, '🔧 Schäden behoben', 'info'); audio.uiClick(); }
   }
   if (inp.tapped('T') && p.cfg.torp && p.torpTimer <= 0) {
      const n = p.fireTorpedo(world, null, p.aim);
      if (n > 0) { world.log(p, '🐟 Torpedosalve!', 'warn'); audio.torpLaunch(); }
   }
   // NOTE: P (pause/resume) is handled in frame(), NOT here -- while paused the sim-step
   // block is skipped entirely, so a tap handled only inside step() could never RESUME.
}

function togglePause() {
   if (phase === 'playing') { phase = 'paused'; input.gameActive = false; $('pause').classList.remove('hidden'); }
   else if (phase === 'paused') { phase = 'playing'; input.gameActive = true; $('pause').classList.add('hidden'); }
}

function pollSounds(dt) {
   const p = world.player;
   snd.hitCd = Math.max(0, snd.hitCd - dt);
   if (p.shotsFired > snd.shotsP) snd.shotsP = p.shotsFired;
   let eShots = 0;
   for (const b of world.bots) eShots += b.shotsFired;
   if (eShots > snd.shotsE) { snd.shotsE = eShots; audio.cannon(false); }
   if (world.torpedoes.length > snd.torps) audio.torpLaunch();
   snd.torps = world.torpedoes.length;
   if (world.killCount > snd.kills) { snd.kills = world.killCount; audio.sink(); }
   for (const e of world.effects) {
      if (e.age < dt * 1.5) {
         if (e.kind === 'explosion') audio.explosion(e.big);
         else if (e.kind === 'splash') audio.splash();
         else if (e.kind === 'fire') audio.fireStart();
      }
   }
   // camera shake is driven by world._shake (set in combat.js on hits) -- render3d.js
   // reads it directly each frame, same convention as the 2D camera.
   if (p.alive && p.hitFlash > 0.9 && snd.hitCd <= 0) { audio.hit(); snd.hitCd = 0.4; }
   audio.updateEngine(p.speed, p.maxSpeed, phase !== 'playing');
}

// ---------- weapon-selection HUD ----------
const weaponSelEl = $('weapon-sel');
function updateWeaponHud() {
   const label = weaponSel === 'main' ? '1 · Hauptbatterie' : weaponSel === 'sec' ? '2 · Sekundär' : '3 · Flak';
   weaponSelEl.innerHTML = 'Waffe: <b>' + label + '</b>';
}

// ---------- turret-lock HUD ----------
const turretStatusEl = $('turret-status');
function updateTurretHud() {
   if (!world || !world.player || !world.player.alive) { turretStatusEl.classList.add('hidden'); return; }
   const locked = world._turretLocked;
   if (locked === null || locked === undefined) { turretStatusEl.classList.add('hidden'); return; }
   turretStatusEl.classList.remove('hidden');
   turretStatusEl.classList.toggle('locked', locked);
   turretStatusEl.classList.toggle('slewing', !locked);
   turretStatusEl.textContent = locked ? '🎯 EINGERASTET' : '🎯 TÜRME DREHEN…';
}

// ---------- main loop ----------
let lastT = performance.now() / 1000;
let acc = 0;

function frame() {
   requestAnimationFrame(frame);
   const nowT = performance.now() / 1000;
   let dt = nowT - lastT;
   lastT = nowT;
   if (dt > 0.25) dt = 0.25;

   try {
      // P toggles pause/resume every frame regardless of phase -- while paused the sim-step
      // block below is skipped entirely, so a tap handled only inside step() could never
      // RESUME the game. Consuming it here makes both directions work identically.
      if (world && input.tapped('P')) togglePause();
      if (phase === 'playing' && world) {
         acc += dt;
         let steps = 0;
         while (acc >= WORLD.SIM_DT && steps < 5) {
            step(WORLD.SIM_DT);
            acc -= WORLD.SIM_DT; steps++;
            // Consume edge-triggered taps once per sim step: a key pressed this frame fires
            // exactly once, not once per step of a multi-step frame (the old bug where P
            // double-toggled and SPACE logged "Anker fällt!" twice on a 2-step frame).
            input.consumeTaps();
         }
         if (steps === 5) acc = 0;
         pollSounds(WORLD.SIM_DT);
         if ((world.phase === 'won' || world.phase === 'lost') && phase === 'playing') {
            endTimer += dt;
            if (endTimer > 1.6) showEnd();
         }
      }
      if (world) {
         renderer.render(world, dt, cam3);
         hud.update(world);
         updateTurretHud();
         updateWeaponHud();
      } else {
         renderer.render(emptyWorld(), dt, cam3);
      }
   } catch (err) {
      console.error('[warships-3d] frame error:', err);
      if (!frame._errShown) {
         frame._errShown = true;
         const el = document.createElement('div');
         el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99;background:#3a1414;color:#ffb4a8;padding:8px 14px;border-radius:6px;font:13px monospace';
         el.textContent = '⚠ Fehler im Spiel-Loop: ' + err.message;
         document.body.appendChild(el);
      }
   }
   input.endFrame();
}

function emptyWorld() {
   if (!emptyWorld._w) {
      emptyWorld._w = {
         time: 0, ships: [], shells: [], torpedoes: [], aaTracers: [], particles: [],
         effects: [], smokeClouds: [], damageNumbers: [], obstacles: [], logLines: [],
         player: null, bots: [], _shake: 0, _aimPoint: null,
      };
   }
   emptyWorld._w.time += 1 / 60;
   return emptyWorld._w;
}

function step(dt) {
   controlPlayer(dt);
   for (const b of world.bots) updateBot(b, world, dt);
   world.update(dt);
}

// ---------- UI wiring ----------
$('btn-play').addEventListener('click', startGame);
$('btn-how').addEventListener('click', () => { $('howto').classList.remove('hidden'); audio.uiClick(); });
$('btn-how-close').addEventListener('click', () => { $('howto').classList.add('hidden'); audio.uiClick(); });
$('btn-again').addEventListener('click', startGame);
$('btn-menu').addEventListener('click', () => {
   $('end').classList.add('hidden'); $('menu').classList.remove('hidden'); hud.show(false); phase = 'menu';
});
$('btn-resume').addEventListener('click', togglePause);

document.querySelectorAll('.chip[data-diff]').forEach(ch => {
   ch.addEventListener('click', () => {
      document.querySelectorAll('.chip[data-diff]').forEach(c => c.classList.remove('sel'));
      ch.classList.add('sel');
      difficulty = ch.dataset.diff;
      audio.uiClick();
   });
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) audio.resume(); });

window.addEventListener('error', (e) => {
   console.error('[warships-3d] uncaught:', e.error || e.message);
   const el = document.createElement('div');
   el.style.cssText = 'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);z-index:99;background:#3a1414;color:#ffb4a8;padding:6px 12px;border-radius:6px;font:12px monospace';
   el.textContent = '⚠ ' + (e.message || 'Unbekannter Fehler');
   document.body.appendChild(el);
});

$('loading').remove();
$('menu').classList.remove('hidden');
requestAnimationFrame(frame);
