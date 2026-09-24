// game/main.js — entry point: canvas setup, fixed-timestep loop, player controller, UI phases.
import { sub, add, norm, angleOf, clamp, dist, fromAngle } from './utils.js';
import { WORLD, HANDLING } from './config.js';
import { Input } from './input.js';
import { Camera } from './camera.js';
import { Ocean } from './ocean.js';
import { Renderer } from './render.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { World } from './state.js';
import { updateBot } from './ai.js';
import { missionById, nextMission } from './missions.js';
import { loadProgress, saveProgress, recordStars, recordSurvival } from './progress.js';
import { Menu, SKIRMISH } from './menu.js';

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
let progress = loadProgress();
let difficulty = ['easy', 'normal', 'hard'].includes(progress.difficulty) ? progress.difficulty : 'normal';
let missionId = 'm1';
// per-run counters for the end screen that the World does not keep itself
const run = { cit: 0, torpHits: 0 };

// sound throttling (effects are polled; weapon/hit cues come from world.events)
const snd = { hitCd: 0, eCannonCd: 0, cueCd: 0, citCd: 0, reloadCd: 0, airCd: 0, sonarCd: 0 };
// main-battery trigger state: click = full salvo, hold = ripple (one turret per HANDLING.rippleGap)
const trig = { holdT: 0, rippleCd: 0 };
// read-only handle for the headless self-test (tests/playwright.shots.mjs)
window.__game = { get world() { return world; }, get phase() { return phase; }, cam };

function startGame(id = missionId) {
   missionId = id;
   const m = id === SKIRMISH.id ? null : missionById(id);
   // survival waves are seeded per run so every attempt plays differently; missions stay fixed
   world = new World(difficulty, m && m.survival ? (Math.random() * 1e9) | 0 : null, m);
   run.cit = 0; run.torpHits = 0;
   world.audio = audio;
   cam.setFollow(world.player);
   trig.holdT = 0; trig.rippleCd = 0;
   hud.reset();
   phase = 'playing';
   endTimer = 0;
   input.gameActive = true;
   $('menu').classList.add('hidden');
   $('end').classList.add('hidden');
   $('pause').classList.add('hidden');
   $('howto').classList.add('hidden');
   hud.show(true);
   audio.init();
   audio.uiClick();
}

function missionLabel(m) {
   if (!m) return 'Freies Gefecht';
   return m.survival ? 'Überleben · Endlos' : `Einsatz ${m.num} · ${m.title}`;
}

function critList(ul, items) {
   ul.innerHTML = '';
   for (const c of items) {
      const li = document.createElement('li');
      li.className = c.ok ? 'ok' : '';
      li.textContent = (c.ok ? '✓ ' : '✗ ') + c.text;
      ul.appendChild(li);
   }
}

function showEnd() {
   phase = 'ended';
   input.gameActive = false;
   const p = world.player;
   const won = world.phase === 'won';
   const d = world.director;
   const m = world.campaign ? world.mission : null;
   const surv = !!(m && m.survival);
   $('end-mission').textContent = missionLabel(m);
   $('end-emoji').textContent = surv ? '🌊' : won ? '🏆' : '💀';
   $('end-title').textContent = surv ? `WELLE ${d.wave}` : won ? 'SIEG' : 'NIEDERLAGE';
   $('end-sub').textContent = surv ? `${d.score.toLocaleString('de-DE')} Punkte — die Bismarck ist gesunken.` : (world.endReason || (won ? 'Alle feindlichen Schiffe versenkt.' : 'Die Bismarck ist gesunken.'));
   // stars + criteria (missions only)
   const starsEl = $('end-stars');
   let rec = '';
   if (m && !surv) {
      const stars = d.stars();
      starsEl.style.display = '';
      starsEl.innerHTML = [0, 1, 2].map(k => `<span class="${k < stars ? 'on' : ''}">★</span>`).join('');
      critList($('end-crit'), [{ text: 'Mission gewonnen', ok: won }, ...d.criteria().map(c => ({ text: c.text, ok: c.ok && won }))]);
      if (won && recordStars(progress, m.id, stars)) rec = stars === 3 ? '🏅 Perfekt — drei Sterne!' : '⭐ Neuer Bestwert!';
      if (won && !nextMission(m.id)) rec = (rec ? rec + ' · ' : '') + '⚓ Feldzug abgeschlossen!';
   } else {
      starsEl.style.display = 'none';
      $('end-crit').innerHTML = '';
      if (surv) {
         if (recordSurvival(progress, difficulty, d.wave, d.score)) rec = '🏅 Neuer Rekord!';
         else { const b = progress.survivalBest[difficulty]; if (b) rec = `Rekord: Welle ${b.wave} · ${b.score.toLocaleString('de-DE')} Punkte`; }
      }
   }
   saveProgress(progress);
   $('end-record').textContent = rec;
   $('stat-kills').textContent = String(world.killCount);
   $('stat-dmg').textContent = Math.round(p.dmgDealt).toLocaleString('de-DE');
   $('stat-acc').textContent = p.shotsFired ? Math.round(100 * p.shotsHit / p.shotsFired) + '%' : '—';
   const mm = Math.floor(world.time / 60), ss = Math.floor(world.time % 60);
   $('stat-time').textContent = mm + ':' + String(ss).padStart(2, '0');
   $('stat-cit').textContent = String(run.cit);
   $('stat-torp').textContent = String(run.torpHits);
   $('stat-planes').textContent = String(world.stats.planesDown || 0);
   $('stat-hull').textContent = Math.max(0, Math.round(100 * p.hp / p.maxHP)) + '%';
   const next = won && m && !surv ? nextMission(m.id) : null;
   $('btn-next').style.display = next ? '' : 'none';
   $('btn-next').dataset.id = next ? next.id : '';
   $('end').classList.remove('hidden');
   if (won) audio.victory(); else audio.defeat();
}

// ---------- player controller ----------
// Aim point clamped to main-battery range: firing past it just drops the salvo at max range.
function aimPointFor(p) {
   const aimW = world._aimPoint;
   const d = dist(p.pos, aimW);
   const max = p.cfg.main.range * HANDLING.maxAimMult;
   return d <= max ? aimW : add(p.pos, fromAngle(angleOf(sub(aimW, p.pos)), max));
}

function fireSalvo(p, maxTurrets) {
   return p.fireMain(world, null, p.aim, { aimPoint: aimPointFor(p), maxTurrets });
}

// Continuous controls, every sim step: aim, helm, throttle, anchor, hold-to-ripple.
function controlPlayer(dt) {
   const p = world.player;
   if (!p || !p.alive) return;
   const inp = input;

   const aimW = cam.s2w(inp.mouse.x, inp.mouse.y);
   world._aimPoint = aimW;
   const toAim = sub(aimW, p.pos);
   p.aim = norm(toAim);
   p.aimBearing = angleOf(toAim);

   p.helm = clamp(inp.helmAxis(), -1, 1);
   const thr = inp.throttleAxis();
   // Anchor turn: hold Space to drop anchor -- hard braking plus a big turn-rate boost
   // (see ship.js update()), so hauling the rudder over while anchored snaps the bow around.
   const anchorWasOut = p.anchorOut;
   p.anchorOut = inp.down('SPACE');
   if (thr !== 0 && !p.anchorOut) p.throttleIn = thr;
   else if (!p.anchorOut && anchorWasOut) p.throttleIn = WORLD.MIN_THROTTLE;

   // hold LMB: after the click-salvo, keep firing turret by turret as each one bears
   if (inp.mouse.down) {
      trig.holdT += dt;
      trig.rippleCd -= dt;
      if (trig.holdT > HANDLING.clickHold && trig.rippleCd <= 0 && fireSalvo(p, 1) > 0) trig.rippleCd = HANDLING.rippleGap;
   } else trig.holdT = 0;

   world._torpPreview = inp.down('T') && !!p.cfg.torp;
}

const CONS_NAMES = { repair: 'Reparatur', dc: 'Schadensbegrenzung', smoke: 'Nebelwand', boost: 'Maschinen-Boost', dcharge: 'Wasserbomben', flare: 'Leuchtgranate' };
const CONS_LOG = { repair: '🔧 Reparaturtrupp an Deck', dc: '🧯 Schadensbegrenzung: Brände & Wassereinbruch gestoppt',
   smoke: '🌫 Nebelwand wird gelegt', boost: '⚡ Maschinen-Boost!', dcharge: '💣 Wasserbomben rollen vom Heck', flare: '✨ Leuchtgranate abgefeuert' };

function useCons(p, key) {
   const st = p.consState(key);
   if (st === 'none') return;
   if (p.useConsumable(key)) { world.log(p, CONS_LOG[key], 'info'); return; }
   const c = p.cons[key];
   let why = st === 'active' ? 'bereits aktiv' : st === 'empty' ? 'keine Ladungen mehr' : st === 'cd' ? `bereit in ${Math.ceil(c.cd)} s` : '';
   if (key === 'repair' && st === 'ready') why = 'nichts zu reparieren';
   world.log(p, `${CONS_NAMES[key]}: ${why}`, 'warn');
}

// Edge-triggered controls, once per rendered frame (a frame can run several sim steps, and a
// tap must act exactly once).
function playerEdges() {
   const p = world.player;
   const inp = input;
   if (inp.tapped('P')) { togglePause(); return; }
   if (!p || !p.alive) return;
   if (!world._aimPoint) world._aimPoint = cam.s2w(inp.mouse.x, inp.mouse.y);
   p.aim = norm(sub(world._aimPoint, p.pos));

   if (inp.mouse.leftPressed) { fireSalvo(p, Infinity); trig.holdT = 0; trig.rippleCd = HANDLING.clickHold; }
   if (inp.tapped('1') && p.setAmmo('AP')) world.log(p, '🎯 Panzergranaten (AP) laden', 'info');
   if (inp.tapped('2') && p.setAmmo('HE')) world.log(p, '💥 Sprenggranaten (HE) laden', 'info');
   if (inp.tapped('Q') && p.cfg.torp) world.log(p, p.toggleTorpSpread() === 'wide' ? 'Torpedofächer: weit' : 'Torpedofächer: eng', 'info');
   if (inp.tapped('R')) useCons(p, 'repair');
   if (inp.tapped('E')) useCons(p, 'dc');
   if (inp.tapped('F')) useCons(p, 'smoke');
   if (inp.tapped('SHIFT')) useCons(p, 'boost');
   if (inp.tapped('C')) useCons(p, 'dcharge');
   // star shells only make sense at night; by day they would just be a free wallhack
   if (inp.tapped('G')) { if (world.env.night) useCons(p, 'flare'); else world.log(p, 'Leuchtgranaten nur bei Nacht', 'warn'); }
   if (inp.tapped('SPACE')) { world.log(p, '⚓ Anker fällt!', 'info'); audio.uiClick(); }

   // T: hold to aim the fan (drawn by render.js), release to launch
   if (inp.releasedKey('T') && p.cfg.torp) {
      const bearing = angleOf(p.aim);
      const l = p.launcherFor(bearing);
      if (!l) world.log(p, 'Torpedos: Ziel liegt nicht querab — Breitseite zeigen', 'warn');
      else if (l.cd > 0) world.log(p, `Torpedos ${l.label}: bereit in ${Math.ceil(l.cd)} s`, 'warn');
      else if (p.fireTorpedo(world, null, p.aim) > 0) world.log(p, `🐟 Torpedofächer ${l.label} abgefeuert`, 'warn');
   }

   // RMB: focus the secondaries on the enemy nearest the cursor (empty water clears the focus)
   if (inp.mouse.rightPressed && p.cfg.sec) {
      let best = null, bestD = 320;
      for (const e of world.enemiesOf(p)) {
         if (!e.visible) continue;
         const d = dist(e.pos, world._aimPoint);
         if (d < bestD) { bestD = d; best = e; }
      }
      p.secFocus = best;
      world.log(p, best ? `Sekundärbatterie: Feuer auf ${best.name}` : 'Sekundärbatterie: freie Zielwahl', 'info');
   }
}

function togglePause() {
   if (phase === 'playing') {
      phase = 'paused';
      input.gameActive = false;   // let the pause-menu buttons be keyboard-reachable
      fillPause();
      $('pause').classList.remove('hidden');
   } else if (phase === 'paused') {
      phase = 'playing';
      input.gameActive = true;
      $('pause').classList.add('hidden');
   }
}

function fillPause() {
   const m = world.campaign ? world.mission : null;
   $('pause-mission').textContent = missionLabel(m);
   const ul = $('pause-obj');
   ul.innerHTML = '';
   const objs = world.director ? world.director.view().objectives : [{ text: 'Alle Feindschiffe versenken', progress: `${world.killCount}/${world.bots.length}`, state: 'active' }];
   for (const o of objs) {
      const li = document.createElement('li');
      li.className = o.state === 'done' ? 'ok' : '';
      li.textContent = (o.state === 'done' ? '✓ ' : '▸ ') + o.text + (o.progress ? '  —  ' + o.progress : '');
      ul.appendChild(li);
   }
}

// ---------- events -> audio + HUD ribbons ----------
function drainEvents() {
   const p = world.player;
   const evs = world.events;
   for (const ev of evs) {
      if (ev.kind === 'hit' && ev.shooter === p) {
         if (ev.outcome === 'CITADEL') run.cit++;
         else if (ev.outcome === 'TORP') run.torpHits++;
      }
      switch (ev.kind) {
         case 'salvo':
            if (ev.ship === p) audio.cannon(true, ev.guns);
            else if (ev.ship.visible && snd.eCannonCd <= 0) { audio.cannon(ev.ship.cfg.main.caliber >= 250, 1); snd.eCannonCd = 0.25; }
            break;
         case 'torp': if (ev.ship === p) audio.torpLaunch(); break;
         case 'hit':
            if (ev.outcome === 'RICOCHET' && ev.shooter === p) audio.bounce();
            if (ev.shooter === p) {
               // at most one chime per salvo; a citadel always gets its own, louder cue
               if (ev.outcome === 'CITADEL') { if (snd.citCd <= 0) { audio.citadel(); snd.citCd = 0.6; snd.cueCd = 0.6; } }
               else if (ev.outcome !== 'SEC' && ev.outcome !== 'RICOCHET' && snd.cueCd <= 0) { audio.ribbon(); snd.cueCd = 0.25; }
            }
            if (ev.target === p && snd.hitCd <= 0) { audio.hit(); snd.hitCd = 0.3; }
            break;
         case 'sink': audio.sink(); if (ev.by === p) setTimeout(() => audio.kill(), 400); break;
         case 'cons': case 'ammo': if (ev.ship === p) audio.uiClick(); break;
         // ripple fire reloads turrets one by one -- throttle so it reads as a rhythm, not noise
         case 'reloaded': if (snd.reloadCd <= 0) { audio.reloaded(); snd.reloadCd = 1.2; } break;
         case 'torpReady': audio.torpReady(); break;
         case 'spotted': if (ev.ship === p) audio.spotted(); break;
         case 'airLaunch': if (ev.ship.side === 'enemy' && snd.airCd <= 0) { audio.airRaid(); snd.airCd = 6; } break;
         case 'airAttack': if (ev.type === 'dive' && ev.target === p) audio.diveWarn(); break;
         case 'barrage': if (ev.ship.side === 'enemy') audio.alarm(); break;
         case 'sonar': if (snd.sonarCd <= 0) { audio.sonar(); snd.sonarCd = 2; } break;
         case 'escaped': audio.escaped(); break;
         case 'arrived': audio.ribbon(); break;
         case 'waveClear': audio.waveClear(); break;
         case 'reinforce': if (world.time > 2) audio.reinforce(); break;
      }
   }
   hud.onEvents(world, evs);
   evs.length = 0;
}

function pollSounds(dt) {
   const p = world.player;
   snd.hitCd = Math.max(0, snd.hitCd - dt);
   snd.eCannonCd = Math.max(0, snd.eCannonCd - dt);
   snd.cueCd = Math.max(0, snd.cueCd - dt);
   snd.citCd = Math.max(0, snd.citCd - dt);
   snd.reloadCd = Math.max(0, snd.reloadCd - dt);
   snd.airCd = Math.max(0, snd.airCd - dt);
   snd.sonarCd = Math.max(0, snd.sonarCd - dt);
   for (const e of world.effects) {
      if (e.age < dt * 1.5) {
         if (e.kind === 'explosion') audio.explosion(e.big);
         else if (e.kind === 'splash') audio.splash();
         else if (e.kind === 'fire') audio.fireStart();
      }
   }
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
      if (phase === 'paused' && input.tapped('P')) togglePause();
      else if (phase === 'playing' && world) playerEdges();
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
         drainEvents();
         if ((world.phase === 'won' || world.phase === 'lost') && phase === 'playing') {
            endTimer += dt;
            if (endTimer > 1.6) showEnd();
         }
      }

      if (world) {
         if (phase !== 'paused') cam.update(dt, world.player, phase === 'playing' ? input.mouse : null);
         renderer.render(world, dt);
         hud.update(world, phase === "paused" ? 0 : dt);
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
         effects: [], smokeClouds: [], damageNumbers: [], obstacles: [], logLines: [], aircraft: [], events: [],
         player: null, bots: [], allies: [], _shake: 0, _aimPoint: null,
         mines: [], flares: [], barrages: [], bombs: [], depthCharges: [], squadrons: [], squalls: [], sonarPings: [],
         zones: [], env: { visionMult: 1 }, stats: {}, flareR: () => 0,
      };
   }
   emptyWorld._w.time += 1 / 60;
   return emptyWorld._w;
}

function step(dt) {
   // player first, then bots decide, then physics
   controlPlayer(dt);
   for (const b of world.bots) updateBot(b, world, dt);
   for (const a of world.allies) updateBot(a, world, dt);
   world.update(dt);
   ocean.update(dt);
}

// ---------- UI wiring ----------
const menu = new Menu(progress, {
   onPlay: (id) => startGame(id),
   onDifficulty: (key) => { difficulty = key; progress.difficulty = key; saveProgress(progress); menu.refresh(); },
   onClick: () => audio.uiClick(),
});
menu.refresh();

function toMenu(prefer = null) {
   $('end').classList.add('hidden');
   $('pause').classList.add('hidden');
   hud.show(false);
   input.gameActive = false;
   phase = 'menu';
   world = null;   // back to the drifting-sea backdrop
   menu.refresh(prefer);
   $('menu').classList.remove('hidden');
}

$('btn-play').addEventListener('click', () => startGame(menu.sel || 'm1'));
$('btn-how').addEventListener('click', () => { $('howto').classList.remove('hidden'); audio.uiClick(); });
$('btn-how-close').addEventListener('click', () => { $('howto').classList.add('hidden'); audio.uiClick(); });
$('btn-again').addEventListener('click', () => startGame(missionId));
$('btn-next').addEventListener('click', () => { const id = $('btn-next').dataset.id; if (id) startGame(id); });
$('btn-menu').addEventListener('click', () => { toMenu(missionId); audio.uiClick(); });
$('btn-resume').addEventListener('click', togglePause);
$('btn-restart').addEventListener('click', () => startGame(missionId));
$('btn-quit').addEventListener('click', () => { toMenu(missionId); audio.uiClick(); });

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
