// game/main.js — entry point: canvas setup, fixed-timestep loop, player controller, UI phases.
import { sub, norm, angleOf, clamp, TAU } from './utils.js';
import { WORLD } from './config.js';
import { Input } from './input.js';
import { Camera } from './camera.js';
import { Ocean } from './ocean.js';
import { Renderer } from './render.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { World } from './state.js';
import { updateBot } from './ai.js';

const $ = (id) => document.getElementById(id);
const sceneCanvas = $('scene');
const fxCanvas = $('fx');

// ---------- global singletons ----------
const cam = new Camera();
const ocean = new Ocean();
const renderer = new Renderer(sceneCanvas, fxCanvas, cam, ocean);
renderer.setHudCanvases($('minimap-canvas'), $('compass-canvas'));
const hud = new Hud();
const audio = new Audio();
let input = null;   // created after DOM ready (canvas exists already)
input = new Input(sceneCanvas);

// ---------- resize ----------
// Full-screen canvases: backing store = CSS size × dpr, ctx pre-scaled so all drawing is in CSS px.
// HUD canvases (minimap 180×180, compass 220×42): same trick with their fixed CSS sizes —
// render.js draws them in CSS pixels and reads those constants.
const MINIMAP_CSS = { w: 180, h: 180 };
const COMPASS_CSS = { w: 220, h: 42 };
function resize() {
   const dpr = Math.min(window.devicePixelRatio || 1, 2);
   const w = window.innerWidth, h = window.innerHeight;
   for (const c of [sceneCanvas, fxCanvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
   }
   const mm = $('minimap-canvas'), cp = $('compass-canvas');
   mm.width = Math.round(MINIMAP_CSS.w * dpr); mm.height = Math.round(MINIMAP_CSS.h * dpr);
   mm.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
   cp.width = Math.round(COMPASS_CSS.w * dpr); cp.height = Math.round(COMPASS_CSS.h * dpr);
   cp.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
   cam.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

// ---------- game state ----------
let world = null;
let phase = 'menu';        // menu | playing | paused | ended
let endTimer = 0;
let difficulty = 'normal';

// sound event diffing (poll-based, no coupling into sim modules)
const snd = { kills: 0, shotsP: 0, shotsE: 0, torps: 0, hitCd: 0 };

function startGame() {
   world = new World(difficulty);
   world.audio = audio;
   cam.setFollow(world.player, { lookAhead: 260, zoom: 0.55 });
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

   // aim: mouse -> world point
   const aimW = cam.s2w(inp.mouse.x, inp.mouse.y);
   world._aimPoint = aimW;
   const toAim = sub(aimW, p.pos);
   p.aim = norm(toAim);
   p.aimBearing = angleOf(toAim);

   // helm & throttle
   const helm = inp.helmAxis();
   p.helm = clamp(helm, -1, 1);
   const thr = inp.throttleAxis();
   if (inp.down('SPACE')) { p.throttleIn = -1; p._crash = true; }        // crash stop
   else if (thr !== 0) { p.throttleIn = thr; p._crash = false; }
   else if (p._crash) { p.throttleIn = WORLD.MIN_THROTTLE; p._crash = false; } // back to min way, not stuck astern

   // main battery: hold left mouse
   if (inp.mouse.down) {
      const d = Math.hypot(toAim.x, toAim.y);
      if (d < p.cfg.main.range * 1.15 && p.fireTimer <= 0) {
         const n = p.fireMain(world, null, p.aim);
         if (n > 0) audio.cannon(true);
      }
   }

   // secondary + AA: hold right mouse
   if (inp.mouse.right) {
      if (p.secTimer <= 0) {
         const n = p.fireSecondary(world, null, p.aim);
         if (n > 0) audio.cannon(false);
      }
      // flak at nearest threat in AA range
      if (p.cfg.aa && p.aaTimer <= 0) {
         let best = null, bestD = p.cfg.aa.range;
         for (const e of world.enemiesOf(p)) {
            const d = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y);
            if (d < bestD) { bestD = d; best = e; }
         }
         if (best) { p.fireAA(world, best); }
      }
   }

   // edge actions
   if (inp.tapped('F') && p.smoke.cd <= 0 && !p.smoke.active) {
      p.smoke.active = true;
      p.smoke.t = WORLD.SMOKE_DURATION;
      p.smoke.cd = WORLD.SMOKE_CD + WORLD.SMOKE_DURATION;
      world.log(p, 'Rauchvorhang gelegt', 'info');
   }
   if (inp.tapped('SHIFT') && p.cfg.boost && !p.boost.active && p.boost.cd <= 0) {
      p.boost.active = true;
      p.boost.t = p.cfg.boost.dur;
      p.boost.cd = p.cfg.boost.cd;
      world.log(p, '⚡ Turbo!', 'info');
   }
   if (inp.tapped('R')) {
      if (p.fires.length || p.floods.length) {
         p.repairAll();
         world.log(p, '🔧 Schäden behoben', 'info');
         audio.uiClick();
      }
   }
   if (inp.tapped('T') && p.cfg.torp && p.torpTimer <= 0) {
      const n = p.fireTorpedo(world, null, p.aim);
      if (n > 0) { world.log(p, '🐟 Torpedosalve!', 'warn'); audio.torpLaunch(); }
   }
   if (inp.tapped('M')) {
      // zoom toggle: overview <-> combat
      cam.targetZoom = cam.targetZoom < 0.35 ? 0.55 : 0.22;
   }
   if (inp.tapped('P')) togglePause();
}

function togglePause() {
   if (phase === 'playing') {
      phase = 'paused';
      input.gameActive = false;   // let the pause-menu buttons be keyboard-reachable
      $('pause').classList.remove('hidden');
   } else if (phase === 'paused') {
      phase = 'playing';
      input.gameActive = true;
      $('pause').classList.add('hidden');
   }
}

// ---------- sound diffing ----------
function pollSounds(dt) {
   const p = world.player;
   snd.hitCd = Math.max(0, snd.hitCd - dt);
   if (p.shotsFired > snd.shotsP) { snd.shotsP = p.shotsFired; }
   let eShots = 0;
   for (const b of world.bots) eShots += b.shotsFired;
   if (eShots > snd.shotsE) { snd.shotsE = eShots; audio.cannon(false); }
   if (world.torpedoes.length > snd.torps) { snd.torps = world.torpedoes.length; audio.torpLaunch(); }
   else snd.torps = world.torpedoes.length;
   if (world.killCount > snd.kills) { snd.kills = world.killCount; audio.sink(); }
   // fresh explosions / splashes this frame
   for (const e of world.effects) {
      if (e.age < dt * 1.5) {
         if (e.kind === 'explosion') audio.explosion(e.big);
         else if (e.kind === 'splash') audio.splash();
         else if (e.kind === 'fire') audio.fireStart();
      }
   }
   if (p.alive && p.hitFlash > 0.9 && snd.hitCd <= 0) { audio.hit(); snd.hitCd = 0.4; }
   // engine hum fades out while paused or on the end screen
   audio.updateEngine(p.speed, p.maxSpeed, phase !== 'playing');
}

// ---------- main loop ----------
let lastT = performance.now() / 1000;
let acc = 0;

function frame() {
   requestAnimationFrame(frame);
   const nowT = performance.now() / 1000;
   let dt = nowT - lastT;
   lastT = nowT;
   if (dt > 0.25) dt = 0.25;   // tab was hidden — don't spiral

   try {
      if (phase === 'playing' && world) {
         acc += dt;
         let steps = 0;
         while (acc >= WORLD.SIM_DT && steps < 5) {
            step(WORLD.SIM_DT);
            acc -= WORLD.SIM_DT;
            steps++;
         }
         if (steps === 5) acc = 0;
         pollSounds(WORLD.SIM_DT);
         if ((world.phase === 'won' || world.phase === 'lost') && phase === 'playing') {
            endTimer += dt;
            if (endTimer > 1.6) showEnd();
         }
      }

      if (world) {
         cam.update(dt, world.player);
         renderer.render(world, dt);
         hud.update(world);
      } else {
         // menu backdrop: slow drifting sea
         ocean.update(dt);
         renderer.render(emptyWorld(), dt);
      }
   } catch (err) {
      // a sim/render exception must not kill the rAF loop — report once and keep the frame going
      console.error('[warships] frame error:', err);
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
   // lightweight stand-in so the menu shows a living ocean behind the card
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
   // player first, then bots decide, then physics
   controlPlayer(dt);
   for (const b of world.bots) updateBot(b, world, dt);
   world.update(dt);
   ocean.update(dt);
}

// ---------- UI wiring ----------
$('btn-play').addEventListener('click', startGame);
$('btn-how').addEventListener('click', () => { $('howto').classList.remove('hidden'); audio.uiClick(); });
$('btn-how-close').addEventListener('click', () => { $('howto').classList.add('hidden'); audio.uiClick(); });
$('btn-again').addEventListener('click', startGame);
$('btn-menu').addEventListener('click', () => {
   $('end').classList.add('hidden');
   $('menu').classList.remove('hidden');
   hud.show(false);
   phase = 'menu';
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

// mute with M? No — M is map. Use Ctrl+M? Keep simple: no mute key, volume fixed.

// browsers suspend the AudioContext when the tab was hidden — bring it back on focus
document.addEventListener('visibilitychange', () => { if (!document.hidden) audio.resume(); });

// last-resort: surface uncaught module errors instead of a silent dead game
window.addEventListener('error', (e) => {
   console.error('[warships] uncaught:', e.error || e.message);
   const el = document.createElement('div');
   el.style.cssText = 'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);z-index:99;background:#3a1414;color:#ffb4a8;padding:6px 12px;border-radius:6px;font:12px monospace';
   el.textContent = '⚠ ' + (e.message || 'Unbekannter Fehler');
   document.body.appendChild(el);
});

// ---------- boot ----------
$('loading').remove();
$('menu').classList.remove('hidden');
requestAnimationFrame(frame);
