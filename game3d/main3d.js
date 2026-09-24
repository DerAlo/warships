// game3d/main3d.js — 3D entry point: WoWs-style controls, camera/aim state, firing gate,
// consumables, event processing and HUD orchestration.
//
// The simulation is consumed through the ARCHITECTURE.md contract. Every access has a
// fallback for the current (older) sim so the page runs against both; see the "adapters"
// section. Per frame: input -> fixed sim steps (controls applied each step) -> interpolated
// render -> HUD. The aim model: a world bearing + a range; the camera looks EXACTLY at the
// aim point, so the screen-centre crosshair is the aim by construction.
import { angleDelta, clamp, clamp01, lerp, TAU, DEG } from './utils.js';
import { WORLD } from './config.js';
import { Input3D } from './input3d.js';
import { Renderer3D } from './render3d.js';
import { BASE_FOV } from './camera3d.js';
import { HudCanvases3D, shipType, TYPE_NAME, isAlly, isVisible, shipLen, torpSide, torpHeading, displayKn } from './minimap3d.js';
import { Hud } from './hud.js';
import { Overlay3D } from './hud3d.js';
import { Audio } from './audio.js';
import { World } from './state.js';
// Namespace imports: a missing named export must not break module linking on either sim.
import * as ai from './ai.js';
import * as combat from './combat.js';

const $ = (id) => document.getElementById(id);
const SIM_DT = WORLD.SIM_DT || 1 / 60;
const KN = WORLD.KN_TO_MS || 1 / 1.94384;     // m/s per knot (old sim: real knots)
const ALIGN_TOL = 3 * DEG;                    // old sim: turret counts as aligned within this
const FIRE_TOL = WORLD.FIRE_TOL || WORLD.ALIGN_TOL || ALIGN_TOL;
const ZOOMS = [2, 4, 8, 16];
const YAW_SENS = 0.0028, RANGE_SENS = 0.0025; // rad/px and log(range)/px at base FOV
const AIM_TAU = 0.035;                        // aim smoothing time constant (s)
const TELE_NAMES = { '-1': 'Rückwärts', 0: 'Stopp', 1: '1/4', 2: '1/2', 3: '3/4', 4: 'Voll' };
const RUDDER_NAMES = { '-2': 'hart Bb', '-1': 'halb Bb', 0: 'mittschiffs', 1: 'halb Stb', 2: 'hart Stb' };
// Old-sim throttle per telegraph step. Stopp is a hair below 0: the old integrator snaps any
// non-negative throttle under 0.12 up to MIN_THROTTLE ("keep way"), which would make Stopp
// impossible.
const OLD_THROTTLE = { '-1': -0.5, 0: -0.001, 1: 0.25, 2: 0.5, 3: 0.75, 4: 1 };
const HOLD_DELAY = 0.35, HOLD_REPEAT = 0.28;
const CONS_NAMES = {
   damageControl: 'Schadensbekämpfung', repair: 'Reparaturtrupp', smoke: 'Nebelgenerator',
   boost: 'Maschinen-Boost', hydro: 'Hydroakustik', radar: 'Radar', spotter: 'Aufklärer', fighter: 'Jäger',
};
const OLD_BEAM = { DD: 13, LC: 18, HC: 22, EB: 36, Bismarck: 36 };

// ------------------------------------------------------------------ setup
const scene3d = $('scene3d');
const renderer = new Renderer3D(scene3d);
const overlay = new Overlay3D($('fx'));
const hud = new Hud();
const audio = new Audio();
const input = new Input3D(scene3d);
const minimap = new HudCanvases3D();
minimap.setCanvases($('minimap-canvas'), null);

let W = 1, H = 1;
function resize() {
   W = window.innerWidth; H = window.innerHeight;
   renderer.resize(W, H);
   const dpr = Math.min(window.devicePixelRatio || 1, 2);
   overlay.resize(W, H, dpr);
   const mm = $('minimap-canvas');
   const s = mm.clientWidth || 220;
   mm.width = Math.round(s * dpr); mm.height = Math.round(s * dpr);
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ state
let world = null, P = null;           // P = world.player (cached per game)
let phase = 'menu';                   // menu | playing | paused | ended
let difficulty = 'normal';
let endTimer = 0, acc = 0;
let simv = {};                        // which contract features the sim provides

// Camera/aim state handed to the renderer (camera3d.js reads yaw/range/dist/bino/zoom...).
const cam3 = { yaw: 0, range: 3000, dist: 500, bino: false, zoom: 4, rangeMin: 1000, rangeMax: 20000, aimH: 0, spectate: false, freeLook: false };
const view = { yaw: 0, logR: Math.log(3000) };   // raw (unsmoothed) mouse targets
const frozen = { yaw: 0, range: 3000 };           // gun aim held during free look
const ctl = {
   telegraph: 0, rudder: 0, ammo: 'HE', mode: 'guns', spread: 'narrow', zoomIdx: 1,
   lockId: null, lead: true, mapOpen: false, board: false, help: false,
   hold: { W: 0, S: 0, A: 0, D: 0 }, wheelAcc: 0,
};
const aim = { point: { x: 0, y: 0 }, snapped: null, gunRange: 15000, flight: 0, yaw: 0, range: 3000, out: false };
let consEmu = null;                   // old-sim consumable emulation
let flightCal = null;                 // { k } calibrated from the sim's own shell durations
let intel = { lastKnown: new Map() };
const fx = {
   seq: 0, oldEvIdx: 0, lastHits: 0, lastDmg: 0, lastHp: 0, spotted: false,
   ribbons: new Map(), dmg: 0, feed: [], msgs: [], shellSeen: new Set(), effSeen: new WeakSet(),
   whistled: new Set(), torpPingT: 0, torpWarn: [], ribbonSndT: 0, maxShellId: 0,
};
let turretCache = [];
let lastMarkers = [];
let fired = { shots: 0, salvos: 0, torps: 0 };

// ------------------------------------------------------------------ test hooks
window.__world = () => world;
window.__cam3 = cam3;
window.__camY = () => renderer.camera.position.y;
window.__shipHdg = () => P ? P.heading : null;
window.__scopeT = () => renderer.cam?.scopeT ?? renderer.scopeT ?? 0;
window.__weaponSel = () => ctl.mode === 'torp' ? 'torp' : 'main';
window.__badFireCount = 0;
window.__phase = () => phase;
window.__ctl = () => ({
   telegraph: ctl.telegraph, rudder: ctl.rudder, ammo: currentAmmo(), mode: ctl.mode, spread: ctl.spread,
   bino: cam3.bino, zoom: cam3.zoom, freeLook: cam3.freeLook, lockId: ctl.lockId, lead: ctl.lead,
   mapOpen: ctl.mapOpen, board: ctl.board, dist: cam3.dist,
});
window.__aim = () => ({
   yaw: cam3.yaw, range: cam3.range, targetRange: Math.exp(view.logR), targetYaw: view.yaw,
   rangeMin: cam3.rangeMin, rangeMax: cam3.rangeMax, gunRange: aim.gunRange, point: { ...aim.point },
   snapped: aim.snapped, flight: aim.flight, out: aim.out, fov: renderer.camera.fov,
});
window.__turrets = () => turretCache.map(t => ({ state: t.state, reload: t.reload, aligned: t.aligned, canBear: t.canBear }));
window.__cons = () => consumables().map(c => ({ slot: c.slot, key: c.key, charges: c.charges, cd: c.cd, active: c.active }));
window.__fired = () => ({ ...fired });
window.__start = (opts) => startGame(opts || {});
let renderOn = true;
window.__setRender = (on) => { renderOn = !!on; };
// Aim relative to the ship's heading (radians, + = starboard) and optionally at a range (m).
window.__setAim = (yawRel, range) => {
   if (!P) return;
   view.yaw = unwrapNear(P.heading + (yawRel || 0), cam3.yaw); cam3.yaw = view.yaw;
   if (range) { view.logR = Math.log(clamp(range, cam3.rangeMin, cam3.rangeMax)); cam3.range = Math.exp(view.logR); }
};

// ------------------------------------------------------------------ adapters (contract first, old sim second)
// True if `k` is a plain data property of `o` (own or inherited). The new sim keeps getter-only
// legacy read-outs (fireTimer, secTimer, torpTimer, boost) -- those must not select old-sim paths.
function hasData(o, k) {
   for (let x = o; x; x = Object.getPrototypeOf(x)) {
      const d = Object.getOwnPropertyDescriptor(x, k);
      if (d) return 'value' in d || typeof d.set === 'function';
   }
   return false;
}
function gunRangeOf(p) {
   return p?.cfg?.main?.range || p?.gunRange || p?.mainRange || 15000;
}
function hullL(p) { return p?.cfg?.hull?.L || shipLen(p); }
function hullBeam(s) { return s?.cfg?.hull?.beam || OLD_BEAM[s?.cls] || shipLen(s) * 0.12; }
function hullDeckH(s) { return s?.cfg?.hull?.deckH || Math.max(8, shipLen(s) * 0.075); }
function maxSpeedMs(s) { return s?.maxSpeed ?? (s?.maxSpeedKn ? s.maxSpeedKn * KN : 20); }
function velOf(s) {
   if (s.vel && typeof s.vel.x === 'number') return s.vel;
   return { x: Math.cos(s.heading) * (s.speed || 0), y: Math.sin(s.heading) * (s.speed || 0) };
}
function playerSpotted(p) {
   if (typeof p.detected === 'boolean') return p.detected;
   if (typeof world.isSpotted === 'function') { try { return !!world.isSpotted(p); } catch (e) { return false; } }
   return false;
}
function detectRangeOf(p) {
   return p.detectRange ?? p.cfg?.detectRange ?? (p.cfg?.detect || 3000) * (world.difficulty?.detectMult || 1);
}
function currentAmmo() { return simv.newAmmo ? (P?.ammo || ctl.ammo) : ctl.ammo; }
function mainCaliber(p) { return p?.turrets?.[0]?.caliber || p?.cfg?.main?.caliber || 380; }

// Shell flight time for range R: sim function > calibration from the sim's own shells >
// old constant-velocity shells > WoWs-like default curve.
function flightTime(R) {
   if (!P) return 0;
   try {
      if (typeof P.flightTime === 'function') return P.flightTime(R);
      if (typeof world.flightTime === 'function') return world.flightTime(P, R);
      if (typeof combat.flightTime === 'function' && P.cfg?.main) {
         const t = combat.flightTime(P.cfg.main, Math.max(1, R));
         if (Number.isFinite(t)) return t;
      }
   } catch (e) { /* fall through */ }
   if (flightCal) return flightCal.k * Math.pow(Math.max(1, R), 1.15);
   if (P.cfg?.main?.vShell && !simv.newShells) return R / P.cfg.main.vShell;
   return 15 * Math.pow(Math.max(1, R) / 20000, 1.15);
}

// Per-turret status: { state: 'ready'|'traverse'|'reload'|'blocked'|'dead', reload 0..1 (1=loaded) }.
function computeTurrets(p) {
   const out = [];
   if (!p?.turrets) return out;
   const reloadMaxOld = p.cfg?.main?.reload || 5;
   const desiredRel = angleDelta(p.heading, Math.atan2(aim.point.y - p.pos.y, aim.point.x - p.pos.x));
   for (const t of p.turrets) {
      let aligned, canBear, alive, reload, reloadMax;
      if (simv.newTurrets) {
         // "ready" must match what fireMain accepts (it tolerates FIRE_TOL > ALIGN_TOL)
         aligned = !!t.aligned || (typeof t.err === 'number' && t.err <= FIRE_TOL);
         canBear = t.canBear !== false; alive = t.alive !== false;
         reload = Math.max(0, t.reload || 0); reloadMax = t.reloadMax || reloadMaxOld;
      } else {
         // Old sim has no firing arcs: forward mounts can't shoot over the stern, aft mounts
         // can't shoot over the bow (superstructure in the way).
         const fwd = (t.off?.x || 0) >= 0;
         canBear = fwd ? Math.abs(desiredRel) < 150 * DEG : Math.abs(desiredRel) > 30 * DEG;
         aligned = Math.abs(angleDelta(t.bearing || 0, desiredRel)) < ALIGN_TOL;
         alive = true; reload = Math.max(0, t.cd || 0); reloadMax = reloadMaxOld;
      }
      const state = !alive ? 'dead' : !canBear ? 'blocked' : reload > 0 ? 'reload' : !aligned ? 'traverse' : 'ready';
      out.push({ state, aligned, canBear, alive, reload, reloadMax, frac: 1 - clamp01(reload / (reloadMax || 1)),
         rel: t.bearing || 0, offX: t.off?.x || 0, caliber: t.caliber || mainCaliber(p) });
   }
   return out;
}

function torpInfo(p) {
   if (!p) return null;
   if (p.torps && simv.newTorps) {
      const T = p.torps, L = T.launchers || [];
      if (!L.length) return null;
      const ready = L.filter(l => (l.reload || 0) <= 0);
      // the launcher the sim would use on this bearing (side/arc aware); null = no firing angle
      const pick = typeof p.torpLauncherFor === 'function' ? p.torpLauncherFor(aim.yaw) : ready[0];
      const next = pick || ready[0] || L.reduce((a, b) => ((a.reload || 0) < (b.reload || 0) ? a : b));
      const minReload = Math.min(...L.map(l => l.reload || 0));
      return { range: T.range || p.cfg?.torp?.range || 8000, speed: T.speed || p.cfg?.torp?.speed || (T.speedKn || p.cfg?.torp?.speedKn || 60) * KN,
         tubes: next.tubes || 3, readyCount: ready.length, total: L.length, canFire: !!pick, reload: minReload,
         reloadMax: next.reloadMax || 60, spread: T.spread || ctl.spread };
   }
   const c = p.cfg?.torp;
   if (!c || typeof p.fireTorpedo !== 'function') return null;
   const r = Math.max(0, p.torpTimer || 0);
   return { range: c.range, speed: c.speed, tubes: c.salvo || 3, readyCount: r <= 0 ? 1 : 0, total: 1, canFire: r <= 0,
      reload: r, reloadMax: c.cd || 30, spread: ctl.spread };
}
function torpBearings(info, yaw) {
   const gap = (info.spread === 'wide' ? 3.2 : 1.3) * DEG;   // same fan as ship.fireTorpedoes
   const n = info.tubes, out = [];
   for (let i = 0; i < n; i++) out.push(yaw + (i - (n - 1) / 2) * gap);
   return out;
}

// Unified consumable list for HUD + keys, WoWs slot order: R = damage control, then the
// repair party, then the class specials in the ship's own order (a DD without repair party
// gets smoke on T, boost on Y -- like the real game).
const CONS_SLOTS = ['R', 'T', 'Y', 'U'];
function consumables() {
   const p = P;
   if (!p) return [];
   if (simv.newCons) {
      const list = p.consumables;
      const dc = list.find(c => c.key === 'damageControl');
      const rp = list.find(c => c.key === 'repair');
      const ordered = [dc, rp, ...list.filter(c => c !== dc && c !== rp)].filter(Boolean);
      return ordered.slice(0, CONS_SLOTS.length).map((c, i) => ({ slot: CONS_SLOTS[i], key: c.key, name: c.name || CONS_NAMES[c.key] || c.key,
         charges: c.charges, maxCharges: c.maxCharges, cd: c.cd || 0, cdMax: c.cdMax || 1, active: !!c.active, t: c.t || 0, dur: c.dur || 1, src: c }));
   }
   return consEmu || [];
}
function makeConsEmu(p) {
   const list = [
      { slot: 'R', key: 'damageControl', charges: Infinity, maxCharges: Infinity, cdMax: 40, dur: 8 },
      { slot: 'T', key: 'repair', charges: 3, maxCharges: 3, cdMax: 60, dur: 20 },
   ];
   if (p.boost) list.push({ slot: 'Y', key: 'boost', charges: Infinity, maxCharges: Infinity, cdMax: p.cfg?.boost?.cd || 20, dur: p.cfg?.boost?.dur || 4 });
   if (p.smoke) list.push({ slot: list.length === 3 ? 'U' : 'Y', key: 'smoke', charges: 2, maxCharges: 2, cdMax: WORLD.SMOKE_CD || 25, dur: WORLD.SMOKE_DURATION || 8 });
   for (const c of list) { c.name = CONS_NAMES[c.key]; c.cd = 0; c.active = false; c.t = 0; }
   return list;
}
function useConsumable(slot) {
   const c = consumables().find(k => k.slot === slot);
   if (!c) { audio.denied(); return false; }
   if (simv.newCons) {
      let ok = false;
      try { ok = !!P.useConsumable(world, c.key); } catch (e) { ok = false; }
      if (ok) { audio.consumable(c.key); hud.msg(c.name + ' aktiviert', 'info'); } else audio.denied();
      return ok;
   }
   if (c.active || c.cd > 0 || c.charges <= 0) { audio.denied(); return false; }
   const p = P;
   if (c.key === 'damageControl') { p.fires = []; p.floods = []; }
   else if (c.key === 'repair') { p.repairT = Math.max(p.repairT || 0, c.dur); }
   else if (c.key === 'boost' && p.boost) { p.boost.active = true; p.boost.t = c.dur; p.boost.cd = 0; }
   else if (c.key === 'smoke' && p.smoke) { p.smoke.active = true; p.smoke.t = c.dur; }
   c.active = true; c.t = c.dur; c.cd = c.dur + c.cdMax;
   if (c.charges !== Infinity) c.charges--;
   audio.consumable(c.key);
   hud.msg(c.name + ' aktiviert', 'info');
   return true;
}
function tickConsEmu(dt) {
   if (!consEmu) return;
   for (const c of consEmu) {
      if (c.cd > 0) c.cd = Math.max(0, c.cd - dt);
      if (c.active) {
         c.t -= dt;
         if (c.key === 'damageControl' && P) { P.fires = []; P.floods = []; } // immune while active
         if (c.t <= 0) { c.active = false; c.t = 0; }
      }
   }
}

// ------------------------------------------------------------------ game lifecycle
function startGame(opts = {}) {
   if (opts.difficulty) difficulty = opts.difficulty;
   const wopts = {};
   if (opts.mission) wopts.mission = opts.mission;
   if (opts.ship) wopts.ship = opts.ship;
   world = new World(difficulty, wopts);
   world.audio = audio;
   P = world.player;
   simv = {
      newTele: typeof P.setTelegraph === 'function',
      newRudder: typeof P.setRudder === 'function',
      newTurrets: !!(P.turrets?.length && 'aligned' in P.turrets[0]),
      newAmmo: typeof P.setAmmo === 'function',
      newTorps: typeof P.fireTorpedoes === 'function',
      newCons: Array.isArray(P.consumables) && typeof P.useConsumable === 'function',
      newShells: false,
      oldSecondaries: typeof P.fireSecondary === 'function' && hasData(P, 'secTimer') && !world.autoSecondaries,
      botsInternal: !!world.aiInternal,
   };
   const build = renderer.buildWorld || renderer.buildObstacles;
   if (build) build.call(renderer, world);

   // controls
   ctl.telegraph = P.telegraph ?? 0; ctl.rudder = P.rudderCmd ?? 0;
   ctl.ammo = P.ammo || 'HE'; ctl.mode = 'guns'; ctl.spread = P.torps?.spread || 'narrow';
   ctl.zoomIdx = 1; ctl.lockId = null; ctl.mapOpen = false; ctl.board = false; ctl.wheelAcc = 0;
   ctl.lead = difficulty !== 'hard';
   for (const k in ctl.hold) ctl.hold[k] = 0;
   consEmu = simv.newCons ? null : makeConsEmu(P);
   flightCal = null;
   intel = { lastKnown: new Map() };
   Object.assign(fx, { seq: 0, oldEvIdx: world.events?.length || 0, lastHits: P.shotsHit || 0, lastDmg: P.dmgDealt || 0,
      lastHp: P.hp, spotted: false, dmg: 0, feed: [], msgs: [], torpPingT: 0, torpWarn: [], ribbonSndT: 0, maxShellId: 0 });
   fx.ribbons = new Map(); fx.shellSeen = new Set(); fx.effSeen = new WeakSet(); fx.whistled = new Set();
   if (Array.isArray(world.events)) for (const e of world.events) if (e.seq > fx.seq) fx.seq = e.seq;
   fired = { shots: 0, salvos: 0, torps: 0 };
   window.__badFireCount = 0;

   // aim: start looking over the bow at ~60% gun range
   aim.gunRange = gunRangeOf(P);
   const L = hullL(P);
   cam3.rangeMin = clamp(aim.gunRange * 0.08, 150, 1000);
   cam3.rangeMax = Math.min(aim.gunRange * 1.12, Math.max(20000, aim.gunRange * 1.02));
   const R0 = clamp(aim.gunRange * 0.6, cam3.rangeMin, cam3.rangeMax);
   view.yaw = P.heading; view.logR = Math.log(R0);
   cam3.yaw = view.yaw; cam3.range = R0; cam3.dist = Math.max(150, L * 2); cam3.bino = false; cam3.zoom = ZOOMS[ctl.zoomIdx];
   cam3.freeLook = false; cam3.spectate = false;
   frozen.yaw = cam3.yaw; frozen.range = R0;
   updateAimPoint();

   phase = 'playing'; endTimer = 0; acc = 0;
   input.gameActive = true;
   for (const id of ['menu', 'end', 'pause', 'howto']) $(id)?.classList.add('hidden');
   hud.reset(world);
   hud.show(true);
   audio.init();
   audio.uiClick();
   input.requestLock();
}

function endGame() {
   phase = 'ended';
   input.gameActive = false;
   input.releaseLock();
   const p = P;
   const won = world.result ? !!world.result.victory : world.phase === 'won';
   const st = world.stats || {};
   $('end-emoji').textContent = won ? '🏆' : '⚓';
   $('end-title').textContent = won ? 'SIEG' : 'NIEDERLAGE';
   $('end-sub').textContent = world.result?.reason || (won ? 'Alle feindlichen Schiffe versenkt.' : (p?.name || 'Dein Schiff') + ' ist gesunken.');
   const kills = st.kills ?? world.killCount ?? 0;
   const dmg = st.dmg ?? p?.dmgDealt ?? 0;
   $('stat-kills').textContent = String(kills);
   $('stat-dmg').textContent = Math.round(dmg).toLocaleString('de-DE');
   const m = Math.floor(world.time / 60), s = Math.floor(world.time % 60);
   $('stat-time').textContent = m + ':' + String(s).padStart(2, '0');
   const hits = st.hits ?? p?.shotsHit, shots = st.shotsFired ?? p?.shotsFired;
   $('stat-hits').textContent = hits != null && shots ? `${hits} / ${shots}` : '—';
   $('stat-cit').textContent = String(st.citadels ?? fx.ribbons.get('citadel') ?? 0);
   $('stat-xp').textContent = world.result?.xp != null ? Math.round(world.result.xp).toLocaleString('de-DE') : Math.round(dmg / 20 + kills * 300 + (won ? 800 : 0)).toLocaleString('de-DE');
   $('end').classList.remove('hidden');
   hud.show(false);
}

function pause() {
   if (phase !== 'playing') return;
   phase = 'paused';
   input.gameActive = false;
   input.releaseLock();
   input.mouse.down = false;
   $('pause').classList.remove('hidden');
}
function resume() {
   if (phase !== 'paused') return;
   phase = 'playing';
   input.gameActive = true;
   $('pause').classList.add('hidden');
   input.requestLock();
   audio.resume();
}
input.onLockLost = () => { if (phase === 'playing') pause(); };

function toMenu() {
   phase = 'menu';
   input.gameActive = false;
   input.releaseLock();
   world = null; P = null;
   for (const id of ['end', 'pause']) $(id).classList.add('hidden');
   $('menu').classList.remove('hidden');
   hud.show(false);
}

// ------------------------------------------------------------------ frame-level input
function frameInput(dt) {
   const p = P;
   const inp = input;

   // --- panels
   if (inp.tapped('M')) { ctl.mapOpen = !ctl.mapOpen; audio.uiClick(); }
   ctl.board = inp.down('TAB');
   if (inp.tapped('H')) { ctl.help = !ctl.help; hud.toggleHelp(ctl.help); }

   if (!p || !p.alive) { cam3.bino = false; return; }

   // --- engine telegraph / rudder: persistent steps, hold repeats
   stepHold('W', dt, () => setTelegraph(ctl.telegraph + 1));
   stepHold('S', dt, () => setTelegraph(ctl.telegraph - 1));
   stepHold('A', dt, () => setRudder(ctl.rudder - 1));
   stepHold('D', dt, () => setRudder(ctl.rudder + 1));
   if (inp.tapped('Q')) setRudder(0);

   // --- weapons
   const ti = torpInfo(p);
   if (inp.tapped('1')) selectAmmo('HE');
   if (inp.tapped('2')) selectAmmo('AP');
   if (inp.tapped('3')) {
      if (!ti) { audio.denied(); hud.msg('Keine Torpedos an Bord', 'warn'); }
      else if (ctl.mode === 'torp') {
         ctl.spread = ctl.spread === 'narrow' ? 'wide' : 'narrow';
         if (typeof p.setTorpSpread === 'function') p.setTorpSpread(ctl.spread);
         else if (p.torps) p.torps.spread = ctl.spread;
         audio.uiClick();
         hud.msg('Torpedofächer: ' + (ctl.spread === 'wide' ? 'weit' : 'eng'), 'info');
      } else { ctl.mode = 'torp'; audio.ammoSwitch(); }
   }
   if (inp.tapped('L')) { ctl.lead = !ctl.lead; hud.msg('Vorhaltemarker ' + (ctl.lead ? 'an' : 'aus'), 'info'); audio.uiClick(); }
   if (inp.tapped('X')) toggleLock();

   // --- consumables
   for (const k of CONS_SLOTS) if (inp.tapped(k)) useConsumable(k);

   // --- binoculars + wheel
   if (inp.tapped('SHIFT')) { cam3.bino = !cam3.bino; audio.uiClick(); }
   if (!ctl.mapOpen && inp.mouse.wheel) {
      if (cam3.bino) {
         ctl.wheelAcc += inp.mouse.wheel;
         while (ctl.wheelAcc <= -1) { ctl.wheelAcc += 1; ctl.zoomIdx = Math.min(ZOOMS.length - 1, ctl.zoomIdx + 1); }
         while (ctl.wheelAcc >= 1) { ctl.wheelAcc -= 1; ctl.zoomIdx = Math.max(0, ctl.zoomIdx - 1); }
      } else {
         const L = hullL(p);
         cam3.dist = clamp(cam3.dist * Math.pow(1.12, inp.mouse.wheel), Math.max(150, L * 0.9), Math.max(600, L * 5));
      }
   }
   if (Math.abs(ctl.wheelAcc) < 1 && !inp.mouse.wheel) ctl.wheelAcc *= 0.9;
   cam3.zoom = ZOOMS[ctl.zoomIdx];

   // --- free look (C or RMB): the camera roams, the guns hold the last aim
   const wantFree = inp.down('C') || inp.mouse.right;
   if (wantFree && !cam3.freeLook) { frozen.yaw = cam3.yaw; frozen.range = cam3.range; }
   if (!wantFree && cam3.freeLook) { view.yaw = unwrapNear(frozen.yaw, view.yaw); view.logR = Math.log(frozen.range); }
   cam3.freeLook = wantFree;

   // --- mouse -> bearing / range. Sensitivity follows the FOV so 16x is as controllable as 1x.
   if (!ctl.mapOpen) {
      const fov = renderer.camera.fov || BASE_FOV;
      const k = Math.tan(fov * DEG / 2) / Math.tan(BASE_FOV * DEG / 2);
      const dx = clamp(inp.mouse.dx, -4000, 4000), dy = clamp(inp.mouse.dy, -4000, 4000);
      view.yaw += dx * YAW_SENS * k;
      view.logR = clamp(view.logR - dy * RANGE_SENS * k, Math.log(cam3.rangeMin), Math.log(cam3.rangeMax));
   }
   const s = 1 - Math.exp(-dt / AIM_TAU);
   cam3.yaw += (view.yaw - cam3.yaw) * s;
   cam3.range = Math.exp(lerp(Math.log(cam3.range), view.logR, s));
   // keep angles bounded without a visible jump (both shift together)
   if (Math.abs(cam3.yaw) > 50) { const sh = Math.round(cam3.yaw / TAU) * TAU; cam3.yaw -= sh; view.yaw -= sh; frozen.yaw -= sh; }
}

function unwrapNear(a, ref) { return ref + angleDelta(ref, a); }

function stepHold(key, dt, fn) {
   const n = input.tapped(key);
   if (n) { for (let i = 0; i < n; i++) fn(); ctl.hold[key] = HOLD_DELAY; return; }
   if (input.down(key)) {
      ctl.hold[key] -= dt;
      if (ctl.hold[key] <= 0) { fn(); ctl.hold[key] = HOLD_REPEAT; }
   }
}
function setTelegraph(n) {
   n = clamp(n, -1, 4);
   if (n !== ctl.telegraph) { ctl.telegraph = n; audio.uiClick(); }
}
function setRudder(n) {
   n = clamp(n, -2, 2);
   if (n !== ctl.rudder) { ctl.rudder = n; audio.uiClick(); }
}
function selectAmmo(type) {
   const wasTorp = ctl.mode === 'torp';
   ctl.mode = 'guns';
   if (currentAmmo() === type) { if (wasTorp) audio.ammoSwitch(); return; }
   if (simv.newAmmo) { try { P.setAmmo(type); } catch (e) { /* ignore */ } }
   else {
      // emulate the switch: every mount reloads with the new shell type
      const rl = P.cfg?.main?.reload || 5;
      for (const t of P.turrets || []) t.cd = Math.max(t.cd || 0, rl);
   }
   ctl.ammo = type;
   audio.ammoSwitch();
   hud.msg('Munition: ' + (type === 'HE' ? 'Spreng (HE)' : 'Panzerbrechend (AP)'), 'info');
}

function toggleLock() {
   // nearest spotted enemy to the crosshair (screen space from the last frame)
   let best = null, bestD = Infinity;
   for (const m of lastMarkers) {
      if (m.ally || !m.onScreen) continue;
      const d = Math.hypot(m.x - W / 2, m.y - H / 2);
      if (d < bestD) { bestD = d; best = m; }
   }
   if (best && bestD < Math.max(W, H) * 0.35 && best.id !== ctl.lockId) { ctl.lockId = best.id; audio.uiClick(); }
   else if (ctl.lockId != null) { ctl.lockId = null; audio.uiClick(); }
   else audio.denied();
}
function lockedShip() {
   if (ctl.lockId == null || !world) return null;
   const s = world.ships.find(x => x.id === ctl.lockId);
   if (!s || !s.alive || !isVisible(world, s)) { ctl.lockId = null; return null; }
   return s;
}

// Aim point from the (smoothed) aim bearing/range, then snapped to a ship the crosshair ray
// actually hits (so aiming at a superstructure doesn't send shells a few hundred metres long).
function updateAimPoint() {
   const p = P;
   if (!p) return;
   const yaw = cam3.freeLook ? frozen.yaw : cam3.yaw;
   const R = cam3.freeLook ? frozen.range : cam3.range;
   aim.yaw = yaw; aim.range = R;
   const ax = p.pos.x + Math.cos(yaw) * R, ay = p.pos.y + Math.sin(yaw) * R;
   aim.point = { x: ax, y: ay };
   aim.snapped = null;
   if (!cam3.freeLook) {
      const hit = rayHitShip(ax, ay);
      if (hit) { aim.point = { x: hit.x, y: hit.y }; aim.snapped = hit.id; }
   }
   const d = Math.hypot(aim.point.x - p.pos.x, aim.point.y - p.pos.y);
   aim.out = d > aim.gunRange;
   aim.flight = flightTime(Math.min(d, aim.gunRange));
}

// Ray from the camera through the sea aim point vs. oriented boxes of spotted enemies.
function rayHitShip(ax, ay) {
   const pose = renderer.cam?.pose;
   if (!pose || !world) return null;
   const ox = pose.pos.x, oy = pose.pos.y, oz = pose.pos.z;
   let dx = ax - ox, dy = -oy, dz = ay - oz;
   const tA = Math.hypot(dx, dy, dz);
   if (tA < 1) return null;
   dx /= tA; dy /= tA; dz /= tA;
   let best = null, bestT = tA * 1.001;
   for (const s of world.ships) {
      if (!s.alive || s === P || isAlly(world, s) || !isVisible(world, s)) continue;
      const hL = shipLen(s) / 2, hB = hullBeam(s) / 2, top = hullDeckH(s) * 2.4;
      const c = Math.cos(s.heading), sn = Math.sin(s.heading);
      // into ship-local frame: u along the keel, v across, y up
      const rx = ox - s.pos.x, rz = oz - s.pos.y;
      const u0 = rx * c + rz * sn, v0 = -rx * sn + rz * c;
      const du = dx * c + dz * sn, dv = -dx * sn + dz * c;
      let t0 = 0, t1 = bestT;
      const slab = (o, d, lo, hi) => {
         if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
         let a = (lo - o) / d, b = (hi - o) / d;
         if (a > b) { const tmp = a; a = b; b = tmp; }
         t0 = Math.max(t0, a); t1 = Math.min(t1, b);
         return t0 <= t1;
      };
      if (!slab(u0, du, -hL, hL) || !slab(v0, dv, -hB, hB) || !slab(oy, dy, 0, top)) continue;
      if (t0 < bestT) {
         bestT = t0;
         // aim at the waterline under the hit point, pulled onto the keel line
         const hx = ox + dx * t0, hz = oz + dz * t0;
         const along = clamp((hx - s.pos.x) * c + (hz - s.pos.y) * sn, -hL, hL);
         best = { x: s.pos.x + c * along, y: s.pos.y + sn * along, id: s.id };
      }
   }
   return best;
}

// ------------------------------------------------------------------ per-step control application
function applyControls(dt) {
   const p = P;
   if (!p || !p.alive) return;
   // engine + rudder
   if (simv.newTele) p.setTelegraph(ctl.telegraph);
   else { p.throttleIn = OLD_THROTTLE[ctl.telegraph]; p.telegraph = ctl.telegraph; }
   if (simv.newRudder) p.setRudder(ctl.rudder);
   else { p.helm = ctl.rudder / 2; p.rudderCmd = ctl.rudder; }

   // aim
   updateAimPoint();
   const ap = aim.point;
   p.aimPoint = ap;
   const bx = ap.x - p.pos.x, by = ap.y - p.pos.y, bl = Math.hypot(bx, by) || 1;
   p.aimBearing = Math.atan2(by, bx);
   p.aim = { x: bx / bl, y: by / bl };

   turretCache = computeTurrets(p);

   if (phase !== 'playing' || ctl.mapOpen) return;
   // clicked covers a press+release inside one frame (low frame rates, quick taps)
   if (ctl.mode === 'guns' && (input.mouse.down || input.mouse.clicked)) fireGuns();
   if (ctl.mode === 'torp' && input.mouse.clicked) { input.mouse.clicked = false; fireTorps(); }
   if (simv.oldSecondaries) autoSecondaries();
}

function fireGuns() {
   const p = P;
   const st = turretCache;
   if (!st.some(t => t.state === 'ready')) return 0;
   // WoWs: a shot past max range falls at max range
   let ap = aim.point;
   const dx = ap.x - p.pos.x, dy = ap.y - p.pos.y, d = Math.hypot(dx, dy);
   if (d > aim.gunRange) ap = { x: p.pos.x + dx / d * aim.gunRange, y: p.pos.y + dy / d * aim.gunRange };
   const R = Math.min(d, aim.gunRange);
   let n = 0;
   if (simv.newTurrets && !hasData(p, 'fireTimer')) {
      const before = p.turrets.map(t => t.reload || 0);
      try { n = p.fireMain(world, ap) || 0; } catch (e) { n = 0; }
      p.turrets.forEach((t, i) => { if ((t.reload || 0) > before[i] + 1e-6 && st[i]?.state !== 'ready') window.__badFireCount++; });
   } else {
      // Old sim: fireMain fires every mount with cd <= 0 along the aim bearing and has a
      // ship-wide fireTimer. Make non-ready mounts look "reloading" for the duration of the call.
      const before = p.turrets.map(t => t.cd || 0);
      const held = [];
      p.turrets.forEach((t, i) => { if ((t.cd || 0) <= 0 && st[i]?.state !== 'ready') { held.push([t, t.cd]); t.cd = 1e-6; } });
      p.fireTimer = 0;
      const tgt = { x: ap.x, y: ap.y, pos: { x: ap.x, y: ap.y } };
      const firstNew = world.shells.length;
      try { n = p.fireMain(world, tgt, { x: dx / (d || 1), y: dy / (d || 1) }) || 0; } catch (e) { n = 0; }
      for (const [t, cd] of held) t.cd = cd;
      p.turrets.forEach((t, i) => { if ((t.cd || 0) > 0.01 && before[i] <= 0 && st[i]?.state !== 'ready') window.__badFireCount++; });
      // emulate the ammo type on the shells just spawned
      const ammo = ctl.ammo;
      for (let i = firstNew; i < world.shells.length; i++) {
         const s = world.shells[i];
         if (s.shooter !== p || s.kind !== 'main') continue;
         s.ammo = ammo;
         if (ammo === 'HE' && s.type !== 'HE') { s.type = 'HE'; s.dmg *= 0.55; }
         else if (ammo === 'AP') s.type = 'AP';
      }
   }
   if (n > 0) {
      fired.shots += n; fired.salvos++;
      audio.mainGun(mainCaliber(p), n, 0);
      calibrateFlight(R);
   }
   return n;
}

// Learn the sim's flight-time curve from its own shells (contract: shell.dur).
function calibrateFlight(R) {
   if (R < 500) return;
   for (let i = world.shells.length - 1; i >= 0; i--) {
      const s = world.shells[i];
      if ((s.ownerId === P.id || s.shooter === P) && typeof s.dur === 'number' && (s.age || 0) < 0.05) {
         simv.newShells = true;
         const k = s.dur / Math.pow(R, 1.15);
         flightCal = flightCal ? { k: flightCal.k * 0.7 + k * 0.3 } : { k };
         return;
      }
   }
}

function fireTorps() {
   const p = P;
   const ti = torpInfo(p);
   if (!ti) return 0;
   if (ti.readyCount <= 0) { audio.denied(); return 0; }
   if (ti.canFire === false) { audio.denied(); hud.msg('Kein Schusswinkel – Torpedorohre zeigen zur Seite', 'warn'); return 0; }
   let n = 0;
   if (simv.newTorps) {
      try { n = p.fireTorpedoes(world, aim.yaw) || 0; } catch (e) { n = 0; }
   } else {
      const save = p.aimBearing;
      try { n = p.fireTorpedo(world, null, { x: Math.cos(aim.yaw), y: Math.sin(aim.yaw) }) || 0; } catch (e) { n = 0; }
      p.aimBearing = save;
      // old sim fires parallel fish: fan them out like the preview
      if (n > 0) {
         const bs = torpBearings(ti, aim.yaw);
         const fresh = world.torpedoes.slice(-n);
         fresh.forEach((t, i) => {
            const b = bs[i % bs.length], sp = t.speed || Math.hypot(t.vel.x, t.vel.y);
            t.vel = { x: Math.cos(b) * sp, y: Math.sin(b) * sp }; t.dir = b;
         });
      }
   }
   if (n > 0) { fired.torps += n; audio.torpLaunch(); hud.msg('Torpedos los!', 'info'); }
   else audio.denied();
   return n;
}

// Old sim only: secondaries don't fire on their own. Engage the nearest spotted enemy in
// range, without disturbing the main battery's aim bearing (fireSecondary overwrites it).
function autoSecondaries() {
   const p = P, sec = p.cfg?.sec;
   if (!sec || p.secTimer > 0) return;
   let best = null, bestD = sec.range;
   for (const s of world.ships) {
      if (!s.alive || isAlly(world, s) || !isVisible(world, s)) continue;
      const d = Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y);
      if (d < bestD) { bestD = d; best = s; }
   }
   if (!best) return;
   const save = p.aimBearing, saveAim = p.aim;
   const t = bestD / (sec.vShell || 600), v = velOf(best);
   const lx = best.pos.x + v.x * t - p.pos.x, ly = best.pos.y + v.y * t - p.pos.y, ll = Math.hypot(lx, ly) || 1;
   try { if (p.fireSecondary(world, best, { x: lx / ll, y: ly / ll }) > 0) audio.secondary(0); } catch (e) { /* ignore */ }
   p.aimBearing = save; p.aim = saveAim;
}

// ------------------------------------------------------------------ events, ribbons, audio
const RIBBON_NAMES = {
   pen: 'Durchschlag', citadel: 'Zitadelle', overpen: 'Überdurchschlag', ricochet: 'Abpraller', shatter: 'Zerschellt',
   he: 'Treffer', sec: 'Sekundär', torp: 'Torpedotreffer', fire: 'Brand', flood: 'Flutung', kill: 'Versenkt',
   spotted: 'Aufgeklärt', cap: 'Eroberung', defend: 'Verteidigt',
};
function addRibbon(kind, n = 1) {
   if (!RIBBON_NAMES[kind] || n <= 0) return;
   fx.ribbons.set(kind, (fx.ribbons.get(kind) || 0) + n);
   hud.ribbon(kind, RIBBON_NAMES[kind], fx.ribbons.get(kind));
   if (fx.ribbonSndT <= 0) { audio.ribbon(kind); fx.ribbonSndT = 0.07; }
}
function feed(killer, victim) {
   fx.feed.push({ t: performance.now() / 1000, killer, victim });
   if (fx.feed.length > 7) fx.feed.shift();
   hud.killFeed(fx.feed, world);
}
function shipById(id) { return world.ships.find(s => s.id === id) || null; }

function processEvents(dt) {
   const p = P;
   fx.ribbonSndT -= dt;
   const evs = world.events || [];
   // contract events: monotonic seq
   let sawContract = false;
   for (const e of evs) {
      if (typeof e.seq !== 'number') continue;
      sawContract = true;
      if (e.seq <= fx.seq) continue;
      fx.seq = e.seq;
      const mine = e.srcId === p.id, onMe = e.dstId === p.id;
      switch (e.type) {
         case 'pen': case 'citadel': case 'overpen': case 'ricochet': case 'shatter': case 'he': case 'sec': case 'torp': case 'fire': case 'flood':
            if (mine) { addRibbon(e.type); fx.dmg += e.dmg || 0; }
            if (onMe && e.type !== 'fire' && e.type !== 'flood') audio.hit((e.dmg || 0) > p.maxHP * 0.05);
            if (onMe && e.type === 'fire') { audio.fireStart(); hud.msg('Feuer an Bord!', 'warn'); }
            if (onMe && e.type === 'flood') hud.msg('Wassereinbruch!', 'warn');
            break;
         case 'kill': case 'sunk': {
            const v = shipById(e.dstId), k = shipById(e.srcId);
            if (e.type === 'kill' && mine) addRibbon('kill');
            if (v && !fx.whistled.has('sunk' + v.id)) {
               fx.whistled.add('sunk' + v.id);
               feed(k, v);
               audio.sink(Math.hypot(v.pos.x - p.pos.x, v.pos.y - p.pos.y));
            }
            break;
         }
         case 'spotted': if (mine) addRibbon('spotted'); break;
         case 'cap': {
            // no capper id in the event: credit the player if they sat inside the circle
            const c = (world.caps || []).find(k => k.id === e.capId);
            if (mine || (c && Math.hypot(c.pos.x - p.pos.x, c.pos.y - p.pos.y) <= (c.r || 0) * 1.05)) addRibbon('cap');
            if (e.text) hud.msg(e.text, 'good');
            break;
         }
         case 'capLost': if (e.text) hud.msg(e.text, 'warn'); break;
         case 'module': if (onMe && e.text) hud.msg(e.text, 'warn'); break;
         case 'objective': {
            // mission radio + objective updates: longer on screen than combat notices
            if (!e.text || e.end) break;
            const bad = e.level === 'warn' || e.level === 'bad' || e.state === 'failed';
            hud.msg(e.text, bad ? 'warn' : e.state === 'done' ? 'good' : 'radio', 6);
            audio.radio?.();
            break;
         }
         default: break;
      }
   }
   // old sim: {kind:'sink', ship} records + synthesized hit ribbons
   for (; fx.oldEvIdx < evs.length; fx.oldEvIdx++) {
      const e = evs[fx.oldEvIdx];
      if (e.kind !== 'sink' || !e.ship) continue;
      const v = e.ship;
      if (fx.whistled.has('sunk' + v.id)) continue;
      fx.whistled.add('sunk' + v.id);
      const killer = v.side !== p.side ? p : null;   // old sim: only the player fights enemies
      if (killer) addRibbon('kill');
      feed(killer, v);
      audio.sink(Math.hypot(v.pos.x - p.pos.x, v.pos.y - p.pos.y));
   }
   if (!sawContract) synthRibbons();

   // own ship took a hit (both sims): a sudden HP drop, not the fire/flood trickle
   const dHp = fx.lastHp - p.hp;
   if (!sawContract && dHp > Math.max(40, p.maxHP * 0.004)) audio.hit(dHp > p.maxHP * 0.05);
   fx.lastHp = p.hp;
}
function synthRibbons() {
   const p = P;
   const dHits = (p.shotsHit || 0) - fx.lastHits, dDmg = (p.dmgDealt || 0) - fx.lastDmg;
   fx.lastHits = p.shotsHit || 0; fx.lastDmg = p.dmgDealt || 0;
   if (dDmg <= 0 && dHits <= 0) return;
   fx.dmg += Math.max(0, dDmg);
   if (dHits <= 0) { if (dDmg > 200) addRibbon('torp'); return; }
   const base = p.cfg?.main?.dmg || 300;
   const avg = dDmg / dHits;
   let kind;
   if (avg < base * 0.2) kind = 'sec';
   else if (ctl.ammo === 'HE') kind = 'he';
   else if (avg > base * 1.2) kind = 'citadel';
   else if (avg > base * 0.45) kind = 'overpen';
   else kind = 'pen';
   addRibbon(kind, dHits);
}

// Intel for the maps: last-known positions of enemies that dropped out of sight.
function updateIntel() {
   for (const s of world.ships) {
      if (isAlly(world, s)) continue;
      let k = intel.lastKnown.get(s.id);
      const vis = s.alive && isVisible(world, s);
      if (vis) {
         if (!k) { k = {}; intel.lastKnown.set(s.id, k); }
         Object.assign(k, { x: s.pos.x, y: s.pos.y, t: world.time, type: shipType(s), name: s.name || s.cls, visible: true, alive: true });
      } else if (k) { k.visible = false; k.alive = s.alive; }
   }
}

// Torpedo threat: closest approach of each enemy fish to the own hull.
function torpThreats() {
   const p = P, out = [];
   if (!p?.alive) return out;
   const vs = velOf(p), L = hullL(p);
   for (const t of world.torpedoes || []) {
      if (torpSide(t) === p.side) continue;
      const rx = t.pos.x - p.pos.x, ry = t.pos.y - p.pos.y;
      const d = Math.hypot(rx, ry);
      const seen = typeof t.spotted === 'boolean' ? t.spotted : d < 1600;
      if (!seen) continue;
      const h = torpHeading(t), sp = t.speed || (t.vel ? Math.hypot(t.vel.x, t.vel.y) : 30);
      const vx = Math.cos(h) * sp - vs.x, vy = Math.sin(h) * sp - vs.y;
      const vv = vx * vx + vy * vy;
      if (vv < 1e-6) continue;
      const tc = -(rx * vx + ry * vy) / vv;
      if (tc < 0 || tc > 25) continue;
      const mx = rx + vx * tc, my = ry + vy * tc;
      if (Math.hypot(mx, my) < L * 0.6 + 60) out.push({ bearing: Math.atan2(ry, rx), t: tc, d });
   }
   return out;
}

function pollAudio(dt) {
   const p = P;
   if (!p) return;
   const lx = p.pos.x, ly = p.pos.y;
   // other ships' guns + incoming whistles
   const salvos = new Map();
   for (const s of world.shells) {
      const id = s.id;
      if (id == null) continue;
      if (!fx.shellSeen.has(id)) {
         fx.shellSeen.add(id);
         const own = s.shooter ? s.shooter === p : s.ownerId === p.id;
         if (!own) {
            const shooter = s.shooter || shipById(s.ownerId);
            const key = (shooter?.id ?? 'x') + (s.kind || 'main');
            if (!salvos.has(key)) salvos.set(key, { n: 0, sec: s.kind === 'sec', cal: s.caliber || shooter?.cfg?.main?.caliber || 200,
               d: shooter ? Math.hypot(shooter.pos.x - lx, shooter.pos.y - ly) : Math.hypot(s.pos.x - lx, s.pos.y - ly) });
            salvos.get(key).n++;
         }
      }
      const side = s.side ?? s.owner;
      if (side !== p.side && !fx.whistled.has(id)) {
         const d = Math.hypot(s.pos.x - lx, s.pos.y - ly);
         const falling = s.dur ? (s.age || 0) > s.dur * 0.6 : true;
         if (d < 420 && falling) { fx.whistled.add(id); audio.whistle(0); }
      }
   }
   for (const v of salvos.values()) {
      if (v.sec) audio.secondary(v.d); else audio.mainGun(v.cal, v.n, Math.max(1, v.d));
   }
   if (fx.shellSeen.size > 4000) fx.shellSeen = new Set(world.shells.map(s => s.id));
   if (fx.whistled.size > 4000) fx.whistled = new Set();
   // splashes / explosions near enough to hear
   for (const e of world.effects || []) {
      if (fx.effSeen.has(e)) continue;
      fx.effSeen.add(e);
      if (!e.pos) continue;
      const d = Math.hypot(e.pos.x - lx, e.pos.y - ly);
      if (d > 9000) continue;
      if (e.kind === 'splash') audio.splash(d, !!e.big || (e.size || 0) > 1.5);
      else if (e.kind === 'explosion') audio.explosion(!!e.big, d);
   }
   // torpedo warning ping + spotted alarm
   fx.torpPingT -= dt;
   if (fx.torpWarn.length && fx.torpPingT <= 0) { audio.torpWarning(); fx.torpPingT = 1.3; }
   const sp = p.alive && playerSpotted(p);
   if (sp && !fx.spotted) { audio.spottedAlarm(); hud.msg('Du wurdest entdeckt!', 'warn'); }
   fx.spotted = sp;
   const muted = phase !== 'playing';
   audio.updateEngine(Math.abs(p.speed || 0), maxSpeedMs(p), muted || !p.alive);
   audio.updateAmbient(world.env?.seaState ?? 0.4, muted);
}

// ------------------------------------------------------------------ render interpolation
// Ships are drawn between the last two sim states so motion is smooth at any refresh rate.
const prevState = new Map();
function snapshotPrev() {
   for (const s of world.ships) {
      let r = prevState.get(s);
      if (!r) { r = {}; prevState.set(s, r); }
      r.x = s.pos.x; r.y = s.pos.y; r.h = s.heading; r.ok = true;
   }
}
const interpSaved = [];
function applyInterp(alpha) {
   interpSaved.length = 0;
   if (!world) return;
   for (const s of world.ships) {
      const r = prevState.get(s);
      if (!r?.ok) continue;
      if (Math.hypot(s.pos.x - r.x, s.pos.y - r.y) > 200) continue;   // teleport / respawn
      interpSaved.push([s, s.pos, s.heading]);
      s.pos = { x: lerp(r.x, s.pos.x, alpha), y: lerp(r.y, s.pos.y, alpha) };
      s.heading = r.h + angleDelta(r.h, s.heading) * alpha;
   }
}
function restoreInterp() {
   for (const [s, pos, h] of interpSaved) { s.pos = pos; s.heading = h; }
   interpSaved.length = 0;
}

// ------------------------------------------------------------------ HUD state per frame
function project(x, h, y) {
   if (typeof renderer.project === 'function') return renderer.project(x, h, y);
   return renderer.cam.project(x, h, y, W, H);
}

function buildUi(dt) {
   const p = P;
   const ui = { W, H, world, p, phase, alive: !!p?.alive, mapOpen: ctl.mapOpen, board: ctl.board };
   const pose = renderer.cam?.pose;
   const fov = renderer.camera.fov || BASE_FOV;
   ui.fov = fov;
   ui.pxPerRad = H / (2 * Math.tan(fov * DEG / 2));
   ui.scopeT = renderer.cam?.scopeT || 0;
   ui.bino = cam3.bino; ui.zoom = cam3.zoom; ui.freeLook = cam3.freeLook;
   if (!p) return ui;

   // aim / reticle
   const d = Math.hypot(aim.point.x - p.pos.x, aim.point.y - p.pos.y);
   ui.range = d; ui.gunRange = aim.gunRange; ui.out = aim.out; ui.flight = aim.flight;
   ui.snapped = aim.snapped != null;
   ui.mode = ctl.mode; ui.ammo = currentAmmo(); ui.lead = ctl.lead;
   ui.turrets = turretCache;
   const live = turretCache.filter(t => t.state !== 'dead');
   const anyReady = live.some(t => t.state === 'ready');
   const loaded = live.filter(t => t.reload <= 0).length;
   // soonest reload among mounts actually reloading (blocked mounts read 0 and would mask it)
   const rl = live.filter(t => t.reload > 0).map(t => t.reload);
   const minRl = rl.length ? Math.min(...rl) : 0;
   const rlMax = live[0]?.reloadMax || 1;
   const ready = live.filter(t => t.state === 'ready').length, trav = live.filter(t => t.state === 'traverse').length;
   ui.reload = { anyReady, loaded, ready, trav, total: live.length, left: minRl, frac: 1 - clamp01(minRl / rlMax) };
   // lead ticks: pixels per knot of perpendicular target speed at this range
   const tf = flightTime(Math.min(d, aim.gunRange));
   ui.pxPerKn = d > 1 ? (KN * tf / d) * ui.pxPerRad : 0;
   ui.torpInfo = torpInfo(p);

   // floating markers
   const markers = [];
   for (const s of world.ships) {
      if (s === p || !s.alive) continue;
      const ally = isAlly(world, s);
      if (!ally && !isVisible(world, s)) continue;
      const hgt = hullDeckH(s) * 2.6 + 28;
      const sp = project(s.pos.x, hgt, s.pos.y);
      const dist = Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y);
      markers.push({ id: s.id, x: sp.x, y: sp.y, onScreen: !!sp.visible, ally, name: s.name || s.cls, type: shipType(s),
         hpFrac: clamp01(s.hp / (s.maxHP || 1)), dist, locked: s.id === ctl.lockId, fires: s.fires?.length || 0 });
   }
   ui.markers = markers;
   lastMarkers = markers;

   // target (locked, else nearest to the crosshair) -> lead ghost + lock panel
   let tgt = lockedShip();
   if (!tgt) {
      let bestD = Math.max(W, H) * 0.22;
      for (const m of markers) {
         if (m.ally || !m.onScreen) continue;
         const dd = Math.hypot(m.x - W / 2, m.y - H / 2);
         if (dd < bestD) { bestD = dd; tgt = shipById(m.id); }
      }
   }
   ui.target = tgt;
   ui.lockShip = lockedShip();
   if (tgt && ctl.lead && ctl.mode === 'guns') {
      const v = velOf(tgt);
      let px = tgt.pos.x, py = tgt.pos.y;
      for (let i = 0; i < 4; i++) {
         const t = flightTime(Math.hypot(px - p.pos.x, py - p.pos.y));
         px = tgt.pos.x + v.x * t; py = tgt.pos.y + v.y * t;
      }
      const sp = project(px, 0, py);
      if (sp.visible) {
         const hl = shipLen(tgt) / 2, c = Math.cos(tgt.heading), s = Math.sin(tgt.heading);
         const bow = project(px + c * hl, 0, py + s * hl), stern = project(px - c * hl, 0, py - s * hl);
         ui.leadPt = { x: sp.x, y: sp.y, bow: bow.visible ? bow : null, stern: stern.visible ? stern : null, id: tgt.id };
      }
   }

   // torpedo fan (screen polylines) + lead
   if (ctl.mode === 'torp' && ui.torpInfo) {
      const ti = ui.torpInfo;
      const bs = torpBearings(ti, aim.yaw);
      const lines = [];
      const L = hullL(p);
      for (const b of bs) {
         const pts = [];
         for (let i = 0; i <= 24; i++) {
            const r = L * 0.3 + (ti.range - L * 0.3) * (i / 24);
            const q = project(p.pos.x + Math.cos(b) * r, 0, p.pos.y + Math.sin(b) * r);
            pts.push(q.visible ? [q.x, q.y] : null);
         }
         lines.push(pts);
      }
      ui.torpFan = { lines, ready: ti.readyCount > 0 };
      if (tgt) {
         const v = velOf(tgt), rx = tgt.pos.x - p.pos.x, ry = tgt.pos.y - p.pos.y, s = ti.speed;
         const a = v.x * v.x + v.y * v.y - s * s, b = 2 * (rx * v.x + ry * v.y), c = rx * rx + ry * ry;
         let t = null;
         if (Math.abs(a) < 1e-6) t = -c / b;
         else { const disc = b * b - 4 * a * c; if (disc >= 0) { const r1 = (-b - Math.sqrt(disc)) / (2 * a), r2 = (-b + Math.sqrt(disc)) / (2 * a); t = Math.min(...[r1, r2].filter(x => x > 0)); } }
         if (t && isFinite(t) && t > 0) {
            const lx = tgt.pos.x + v.x * t, ly = tgt.pos.y + v.y * t;
            const q = project(lx, 0, ly);
            if (q.visible) ui.torpLead = { x: q.x, y: q.y, inRange: Math.hypot(lx - p.pos.x, ly - p.pos.y) <= ti.range };
         }
      }
   }

   // torpedo warnings as screen angles around the crosshair (0 = straight ahead/up)
   ui.torpWarn = fx.torpWarn.map(w => ({ ang: angleDelta(pose?.yaw ?? cam3.yaw, w.bearing), t: w.t }));

   if (cam3.freeLook) {
      const q = project(aim.point.x, 0, aim.point.y);
      ui.frozenPt = q.visible ? q : null;
   }

   ui.cons = consumables();
   ui.telegraph = ctl.telegraph; ui.rudder = ctl.rudder;
   ui.teleName = TELE_NAMES[ctl.telegraph]; ui.rudderName = RUDDER_NAMES[ctl.rudder];
   ui.rudderActual = p.rudder ?? p.helm ?? 0;
   ui.speedKn = displayKn(p);
   ui.spotted = fx.spotted;
   ui.dmg = world.stats?.dmg ?? p.dmgDealt ?? fx.dmg;
   ui.spread = ctl.spread;
   ui.torpWarnCount = fx.torpWarn.length;
   ui.camYaw = pose?.yaw ?? cam3.yaw;
   ui.mapOpts = {
      intel, camYaw: ui.camYaw, camHfov: pose?.hfov, gunRange: aim.gunRange, detectRange: detectRangeOf(p),
      aimPoint: aim.point, torpFan: ctl.mode === 'torp' && ui.torpInfo ? { bearings: torpBearings(ui.torpInfo, aim.yaw), range: ui.torpInfo.range } : null,
   };
   return ui;
}

// ------------------------------------------------------------------ main loop
let lastT = performance.now() / 1000;
let miniT = 0;

function frame() {
   requestAnimationFrame(frame);
   const nowT = performance.now() / 1000;
   let dt = nowT - lastT;
   lastT = nowT;
   if (dt > 0.25) dt = 0.25;

   try {
      if (world && input.tapped('P')) { if (phase === 'playing') pause(); else if (phase === 'paused') resume(); }
      if (phase === 'playing' && world) {
         frameInput(dt);
         tickConsEmu(dt);
         acc += dt;
         let steps = 0;
         while (acc >= SIM_DT && steps < 15) {
            snapshotPrev();
            applyControls(SIM_DT);
            if (!simv.botsInternal && ai.updateBot) for (const b of world.bots) ai.updateBot(b, world, SIM_DT);
            world.update(SIM_DT);
            acc -= SIM_DT; steps++;
         }
         if (steps === 15) acc = 0;
         if (P) {
            processEvents(dt);
            updateIntel();
            fx.torpWarn = torpThreats();
            if (steps === 0) updateAimPoint();
         }
         if ((world.phase === 'won' || world.phase === 'lost') && phase === 'playing') {
            endTimer += dt;
            if (endTimer > 2.5) endGame();
         }
      }

      const alpha = phase === 'playing' ? clamp01(acc / SIM_DT) : 1;
      if (world) {
         applyInterp(alpha);
         try {
            cam3.spectate = !!(P && !P.alive && P.sinking);
            // test hook: headless software-GL is slow, so control tests can skip the 3D draw
            // (the camera rig still runs, keeping aim/projection exact)
            if (renderOn) renderer.render(world, dt, cam3);
            else if (renderer.cam?.update) { renderer.cam.update(world, dt, cam3); renderer.camera.updateMatrixWorld(); }
            if (phase === 'playing' || phase === 'paused') {
               const ui = buildUi(dt);
               miniT -= dt;
               if (miniT <= 0) { minimap.draw(world, ui.mapOpts); miniT = 1 / 30; }
               hud.update(ui, dt);
               overlay.draw(ui);
            }
         } finally { restoreInterp(); }
         if (phase === 'playing') pollAudio(dt);
      } else {
         renderer.render(emptyWorld(), dt, null);
         overlay.clear();
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
         time: 0, ships: [], shells: [], torpedoes: [], aaTracers: [], particles: [], effects: [], smokeClouds: [],
         damageNumbers: [], obstacles: [], logLines: [], events: [], player: null, bots: [], _shake: 0,
      };
   }
   emptyWorld._w.time += 1 / 60;
   return emptyWorld._w;
}

// ------------------------------------------------------------------ UI wiring
const click = (id, fn) => $(id)?.addEventListener('click', fn);
click('btn-play', () => startGame({}));
click('btn-how', () => { $('howto').classList.remove('hidden'); audio.init(); audio.uiClick(); });
click('btn-how-close', () => { $('howto').classList.add('hidden'); audio.uiClick(); });
click('btn-again', () => startGame({}));
click('btn-menu', toMenu);
click('btn-resume', resume);
click('btn-quit', toMenu);
document.querySelectorAll('.chip[data-diff]').forEach(ch => {
   ch.addEventListener('click', () => {
      document.querySelectorAll('.chip[data-diff]').forEach(c => c.classList.remove('sel'));
      ch.classList.add('sel');
      difficulty = ch.dataset.diff;
      audio.init(); audio.uiClick();
   });
});
// Audio may only start after a user gesture.
const gesture = () => { audio.init(); audio.resume(); };
window.addEventListener('pointerdown', gesture);
window.addEventListener('keydown', gesture);
document.addEventListener('visibilitychange', () => { if (!document.hidden) audio.resume(); });
window.addEventListener('error', (e) => {
   const el = document.createElement('div');
   el.style.cssText = 'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);z-index:99;background:#3a1414;color:#ffb4a8;padding:6px 12px;border-radius:6px;font:12px monospace';
   el.textContent = '⚠ ' + (e.message || 'Unbekannter Fehler');
   document.body.appendChild(el);
});

// A mission/ship picker (menu3d.js, sim workstream) can start a match through this.
window.startGame3D = startGame;

$('loading')?.remove();
$('menu').classList.remove('hidden');
requestAnimationFrame(frame);
