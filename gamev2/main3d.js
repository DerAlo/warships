// game3d/main3d.js — 3D entry point: WoWs-style controls, camera/aim state, firing gate,
// consumables, event processing and HUD orchestration.
//
// The simulation is consumed through the ARCHITECTURE.md contract. Every access has a
// fallback for the current (older) sim so the page runs against both; see the "adapters"
// section. Per frame: input -> fixed sim steps (controls applied each step) -> interpolated
// render -> HUD. The aim model: a world bearing + a range; the camera looks EXACTLY at the
// aim point, so the screen-centre crosshair is the aim by construction.
import { angleDelta, clamp, clamp01, lerp, TAU, DEG } from './utils.js';
import { WORLD, SHIPS } from './config.js';
import { Input3D } from './input3d.js';
import { Renderer3D } from './render3d.js';
import { BASE_FOV, aimGain } from './camera3d.js';
import { HudCanvases3D, shipType, TYPE_NAME, isAlly, isVisible, shipLen, torpSide, torpHeading, displayKn } from './minimap3d.js';
import { Hud } from './hud.js';
import { Overlay3D } from './hud3d.js';
import { Audio } from './audio.js';
import { World } from './state.js';
// Namespace imports: a missing named export must not break module linking on either sim.
import * as ai from './ai.js';
import * as combat from './combat.js';
import { getMission } from './missions.js';
import { Menu3D } from './menu3d.js';
import { ZoomLadder, TP_STEPS, LADDER_LEN } from './zoom3d.js';
import { ShellCam } from './shellcam.js';
import { solveLead, solveIntercept, leadState, edgeClamp, pickTarget } from './lead3d.js';
import { SubUi } from './subui.js';
import { MissileUi, CONS_KEYS } from './missileui.js';
import { OpsUi } from './opsui.js';
import { contactLevel } from './sensors.js';
import { AirUi } from './airui.js';
import { activeSquad } from './air.js';
import { TouchUi } from './touch3d.js';
import { makeCommand, applyCommand, execAction } from './net/command.js';
import { createNetGame } from './net/game.js';
import { gfxPref, setGfxPref, setGfxCustom, startTier, mountDiag, lostVeil, TIERS } from './gfxquality.js';

const $ = (id) => document.getElementById(id);
const SIM_DT = WORLD.SIM_DT || 1 / 60;
const KN = WORLD.KN_TO_MS || 1 / 1.94384;     // m/s per knot (old sim: real knots)
const ALIGN_TOL = 3 * DEG;                    // old sim: turret counts as aligned within this
const FIRE_TOL = WORLD.FIRE_TOL || WORLD.ALIGN_TOL || ALIGN_TOL;
const YAW_SENS = 0.0028;                      // rad/px at base FOV
// Vertical: the view tilts VSENS rad/px (scaled by FOV) at the aim range -- screen-steady like the
// yaw -- converted to a range step through camera3d.aimGain; RANGE_CAP bounds the log-range step
// where the sea is nearly edge-on (third person at long range), so 1x stays finely adjustable.
const VSENS = 0.0011, RANGE_CAP_TP = 0.0042, RANGE_CAP_BINO = 0.02;
const AIM_TAU = 0.035;                        // aim smoothing time constant (s)
const TELE_NAMES = { '-1': 'Rückwärts', 0: 'Stopp', 1: '1/4', 2: '1/2', 3: '3/4', 4: 'Voll' };
const RUDDER_NAMES = { '-2': 'hart Bb', '-1': 'halb Bb', 0: 'mittschiffs', 1: 'halb Stb', 2: 'hart Stb' };
// Old-sim throttle per telegraph step. Stopp is a hair below 0: the old integrator snaps any
// non-negative throttle under 0.12 up to MIN_THROTTLE ("keep way"), which would make Stopp
// impossible.
const OLD_THROTTLE = { '-1': -0.5, 0: -0.001, 1: 0.25, 2: 0.5, 3: 0.75, 4: 1 };
const HOLD_DELAY = 0.35, HOLD_REPEAT = 0.28;
const CONS_NAMES = { damageControl: 'Schadensabwehr', repair: 'Notreparatur', decoy: 'Täuschkörper', jammer: 'Störsender', hydro: 'Aktivsonar' };
const OLD_BEAM = { DD: 13, LC: 18, HC: 22, EB: 36, Bismarck: 36 };

// ------------------------------------------------------------------ setup
const scene3d = $('scene3d');
const renderer = new Renderer3D(scene3d);
const gfxVeil = lostVeil();
renderer.onContextLost = () => { gfxVeil.show(); if (document.pointerLockElement) document.exitPointerLock(); };   // the mouse must reach the reload button
renderer.onContextRestored = () => { gfxVeil.hide(); hud.msg('Grafik neu gestartet · Stufe ' + TIERS[renderer.tier].label, 'info', 4); };
const overlay = new Overlay3D($('fx'));
const hud = new Hud();
const audio = new Audio();
const subui = new SubUi({ hud, audio });   // submarine / ASW client side (subui.js)
const mui = new MissileUi({ hud, audio }); // guided weapons, air defence, threat display (missileui.js)
const opsui = new OpsUi({ hud, audio, mui }); // helicopter, swimmer team, large detonation (opsui.js)
window.__opsui = () => opsui;
// the rumble of a large detonation arrives with its shock front (blast3d.js times it by distance)
if (renderer.blast) renderer.blast.onShock = (dist, at) => audio.blast(dist, at);
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
let menu = null;                      // Menu3D (port + results screen)
let lastOpts = null;                  // resolved options of the running match (restart / next mission)
let phase = 'menu';                   // menu | playing | paused | ended
let difficulty = 'normal';
let endTimer = 0, acc = 0;
let simv = {};                        // which contract features the sim provides
let net = null;                       // running net game (net/game.js), null in singleplayer
// The own ship is steered through one command structure (net/command.js): continuous state in
// `cmd`, one-shot actions through act(). A net client hands both to the netcode (predicted
// locally, executed by the host); everybody else applies them to the own ship directly.
const cmd = makeCommand();
function act(a) { return net && !net.isHost ? net.act(a) : execAction(P, world, a); }

// Camera/aim state handed to the renderer (camera3d.js reads yaw/range/dist/bino/zoom...).
const cam3 = { yaw: 0, range: 3000, dist: 500, bino: false, zoom: 4, rangeMin: 1000, rangeMax: 20000, aimH: 0, spectate: false, freeLook: false };
const view = { yaw: 0, logR: Math.log(3000) };   // raw (unsmoothed) mouse targets
const frozen = { yaw: 0, range: 3000 };           // gun aim held during free look
const ctl = {
   telegraph: 0, rudder: 0, ammo: 'HE', mode: 'guns', spread: 'narrow',
   lockId: null, lead: true, mapOpen: false, board: false, help: false,
   hold: { W: 0, S: 0, A: 0, D: 0 },
};
const zoom = new ZoomLadder();          // wheel ladder: third-person distance <-> 2x..16x scope
const aim = { point: { x: 0, y: 0 }, snapped: null, gunRange: 15000, flight: 0, yaw: 0, range: 3000, out: false };
let consEmu = null;                   // old-sim consumable emulation
let flightCal = null;                 // { k } calibrated from the sim's own shell durations
let intel = { lastKnown: new Map() };
const fx = {
   seq: 0, oldEvIdx: 0, lastHits: 0, lastDmg: 0, lastHp: 0, spotted: false,
   ribbons: new Map(), dmg: 0, feed: [], msgs: [], shellSeen: new Set(), effSeen: new WeakSet(),
   whistled: new Set(), torpPingT: 0, torpWarn: [], ribbonSndT: 0, maxShellId: 0,
   heat: 0, music: -1, musicHold: 0, alertT: { torp: 0, fire: 0, flood: 0, citadel: 0 }, starT: -99,
};
// Player settings (per browser). sens scales both mouse axes.
const SETTINGS_KEY = 'warshipsv2.settings.v1';
const settings = { sens: 1, music: 0.5, sfx: 1, killCam: true, aimAssist: true, touchHint: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* private mode */ }
settings.sens = clamp(Number(settings.sens) || 1, 0.3, 2.5);
settings.music = clamp(Number.isFinite(Number(settings.music)) ? Number(settings.music) : 0.5, 0, 1);
settings.sfx = clamp(Number.isFinite(Number(settings.sfx)) ? Number(settings.sfx) : 1, 0, 1);
settings.killCam = settings.killCam !== false;
settings.aimAssist = settings.aimAssist !== false;
settings.touchHint = settings.touchHint !== false;
audio.setVolumes(settings.music, settings.sfx);
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } }
// shell camera (shellcam.js): settings.shellCam, B key, cam3.override like the kill cam
const shellcam = new ShellCam({ cam3, input, hud, overlay, settings, saveSettings, simDt: SIM_DT, hintEl: $('shellcam-hint'),
   world: () => world, phase: () => phase, torpWarn: () => fx.torpWarn.length > 0, killCamOn: () => kc.on,
   lockedShip: () => lockedShip(), mapOpen: () => ctl.mapOpen });
// carriers / squadrons / AA focus (airui.js): the squadron view owns cam3.override while it is open
const airui = new AirUi({ hud, audio, onView: (on) => {
   if (on) { shellcam.reset(); endKillCam(); renderer.focus = airui.focus; }
   else { renderer.focus = null; input.mouse.dx = 0; input.mouse.dy = 0; input.mouse.wheel = 0; }
} });
// touch overlay (touch3d.js): only on a coarse pointer / after the first touch; it drives `input`
// like the keys do, plus the absolute telegraph lever and rudder track
const touch = new TouchUi({ input, canvas: scene3d, api: {
   state: () => touchState(),
   setTelegraph: (n) => setTelegraph(n),
   setRudder: (n) => setRudder(n),
   hint: () => settings.touchHint && !/[?&]nohint\b/.test(location.search),
   hintDone: (forever) => { if (forever) { settings.touchHint = false; saveSettings(); } },
} });
window.__touch = () => ({ on: touch.on, shown: touch.shown });
function touchState() {
   const p = P;
   if (!p) return null;
   const sq = airui.squad(world);
   return {
      alive: !!p.alive, kn: Math.round(displayKn(p) || 0), tele: ctl.telegraph, rudder: ctl.rudder,
      map: ctl.mapOpen, help: ctl.help, bino: !!cam3.bino, free: !!cam3.freeLook, lock: ctl.lockId != null,
      cv: !!p.air, sub: !!p.sub, deep: !!p.sub && p.depth === 2, depthTarget: p.depthTarget ?? 0,
      sec: !!p.cfg?.sec, secTarget: p.secTarget != null, asw: !!p.asw || (!p.sub && !!p.cfg?.weapons?.asw), ltt: !p.sub && !!p.cfg?.weapons?.asw, aa: !!p.air && !!p.aa?.range, aaFocus: p.aaFocus || 0, net: !!net, mode: ctl.mode,
      squad: !!airui.flying, sqType: sq?.type || null, sqHome: !!sq && (sq.state === 'return' || sq.state === 'land'),
      airSel: p.air?.sel || null, sqActive: !!(p.air && world && activeSquad(world, p, p.air.sel)),
   };
}
let turretCache = [];
let lastMarkers = [];
let fired = { shots: 0, salvos: 0, torps: 0 };

// ------------------------------------------------------------------ test hooks
window.__world = () => world;
window.__cam3 = cam3;
window.__camY = () => renderer.camera.position.y;
window.__shipHdg = () => P ? P.heading : null;
window.__scopeT = () => renderer.cam?.scopeT ?? renderer.scopeT ?? 0;
window.__weaponSel = () => ctl.mode === 'guns' ? 'main' : ctl.mode;
window.__mui = () => mui;
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
window.__gfx = () => renderer.gfxState();
window.__setGfx = (t) => renderer.setTier(t);
window.__setGfxOpt = (o) => renderer.setOptions(o);
mountDiag(() => renderer.gfxState());
window.__zoom3d = () => ({
   level: zoom.level, tp: zoom.tp, bino: zoom.bino, zoom: zoom.zoom, dist: zoom.dist, distTarget: zoom.distTarget,
   acc: zoom.acc, scopeT: renderer.cam?.scopeT ?? 0, fov: renderer.camera.fov,
   cam: { x: renderer.camera.position.x, y: renderer.camera.position.y, z: renderer.camera.position.z },
});
let renderOn = true;
window.__setRender = (on) => { renderOn = !!on; };
// atmosphere hooks: kill camera on a ship, photo mode state, music level
window.__killCam = (id) => { const v = id != null ? shipById(id) : world?.ships.find(s => s.side !== P?.side); if (v) startKillCam(v); return kc.on; };
window.__killCamOn = () => kc.on;
window.__shellCam = () => shellcam.debug();
// carrier hooks: squadron view state, planes drawn last frame
window.__air = () => ({ flying: airui.flying, sqId: airui.sqId, drawn: renderer.air?.drawn ?? 0, override: !!cam3.override,
   sel: P?.air?.sel ?? null, squads: world ? world.squadrons.length : 0 });
window.__photo = () => ({ on: phase === 'photo', yaw: photo.yaw, pitch: photo.pitch, dist: photo.dist });
window.__music = () => fx.music;
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
      // WoWs binds the slots in the ship's slot order: damage control first, then R/T/Y/U.
      const list = p.consumables;
      const dc = list.find(c => c.key === 'damageControl');
      const rp = list.find(c => c.key === 'repair');
      // one fixed key per kind (missileui.js CONS_KEYS); the helicopter has no effect in the sim yet and stays off the bar.
      // Submarines dive on F / G, so their decoys sit on N.
      const ordered = [dc, rp, ...list.filter(c => c !== dc && c !== rp)].filter(c => c && CONS_KEYS[c.key]);
      return ordered.map((c) => ({ slot: c.key === 'decoy' && p.sub ? 'N' : CONS_KEYS[c.key], key: c.key, name: c.name || CONS_NAMES[c.key] || c.key,
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
      try { ok = !!act(['c', c.key]); } catch (e) { ok = false; }
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
// opts: { mission, ship | shipClass, difficulty, seed }. Missing fields fall back to the test
// hooks (window.__mission / __ship), the query string (?mission=&ship=) and then the menu selection.
function resolveOpts(opts) {
   const q = new URLSearchParams(location.search);
   const sel = menu?.selection || {};
   const o = {
      mission: opts.mission || window.__mission || q.get('mission') || sel.mission || 'standard',
      ship: opts.ship || opts.shipClass || window.__ship || q.get('ship') || null,
      difficulty: opts.difficulty || q.get('difficulty') || sel.difficulty || difficulty,
   };
   const m = getMission(o.mission) || getMission('standard');
   o.mission = m.id;
   if (!o.ship && sel.mission === o.mission) o.ship = sel.ship;
   // an unknown ship key would silently fall back inside the sim; pick the mission's own choice instead
   if (!o.ship || !SHIPS[o.ship]) o.ship = m.recommendedShip || m.playableShips?.[0] || 'Sachsen';
   if (opts.seed != null) o.seed = opts.seed;
   return o;
}

function startGame(opts = {}) {
   if (net) { const n = net; net = null; n.quit(); }
   const o = resolveOpts(opts || {});
   lastOpts = o;
   difficulty = o.difficulty;
   world = new World(difficulty, { mission: o.mission, ship: o.ship, loadout: menu?.loadout ? menu.loadout(o.ship) : null,
      ...(o.seed != null ? { seed: o.seed } : {}) });
   beginMatch();
}

// ------------------------------------------------------------------ net game (game3d/net/)
// The lobby hands over a session (net/CONTRACT.md). The host's World is the real one, a client's
// is a replica fed by the host; either way `world.player` is the local ship and everything below
// reads the world as in a singleplayer match. session.onEnd() fires when the player leaves the
// match (results screen, pause menu, host lost) through toMenu() -> net.quit().
function netNotice(text) {
   const el = document.createElement('div');
   el.className = 'net-notice';
   el.style.cssText = 'position:fixed;top:14%;left:50%;transform:translateX(-50%);z-index:120;background:rgba(20,28,38,.94);color:#ffd9a0;border:1px solid #7a5a2a;padding:12px 20px;border-radius:6px;font:15px system-ui,sans-serif;pointer-events:none';
   el.textContent = text;
   document.body.appendChild(el);
   setTimeout(() => el.remove(), 7000);
}
export function startNetGame(session) {
   if (net) { const n = net; net = null; n.quit(); }
   if (world) toMenu();
   const g = createNetGame(session, {
      now: () => performance.now() / 1000,
      measure: !!window.__netMeasure,
      loadout: (cls) => (menu?.loadout ? menu.loadout(cls) : null),
      onReady: (w) => {
         if (net !== g) return;
         world = w;
         difficulty = session.difficulty;
         lastOpts = { mission: w.mission?.id || session.mission, ship: w.player.cls, difficulty };
         beginMatch();
      },
      // host gone, connection lost or the match never started
      onLost: (text) => { if (net !== g) return; netNotice(text); toMenu(); },
      // host migration: the match goes on under another host
      onNotice: (text) => { if (net === g) netNotice(text); },
   });
   net = g;
   return g;
}
window.__startNetGame = startNetGame;
window.__net = () => (net ? net.info() : null);
// the host's page is closed or reloaded: say so while the page still can (the successor takes
// over at once instead of after 5 s of silence); best effort, the silence still counts
addEventListener('pagehide', () => { if (net && net.isHost) { try { net.quit(); } catch { /* page is going */ } } });

// A hidden tab gets no animation frames, but a net host must keep simulating for the others: a
// worker timer (not throttled like the page's own timers) steps the world meanwhile.
let bgWorker = null, bgT = 0;
function bgTick() {
   if (!document.hidden || !net || !net.isHost || !world || (phase !== 'playing' && phase !== 'paused' && phase !== 'photo')) return;
   const t = performance.now() / 1000;
   const dt = Math.min(0.5, t - bgT);
   bgT = t; lastT = t;
   net.pump();
   acc += dt;
   let steps = 0;
   while (acc >= SIM_DT && steps < 30) { world.update(SIM_DT); acc -= SIM_DT; steps++; }
   if (steps === 30) acc = 0;
}
document.addEventListener('visibilitychange', () => {
   if (document.hidden && net && net.isHost && world) {
      bgT = performance.now() / 1000;
      if (!bgWorker) {
         try {
            bgWorker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33)'], { type: 'text/javascript' })));
            bgWorker.onmessage = bgTick;
         } catch (e) { bgWorker = null; }
      }
   } else if (bgWorker) { bgWorker.terminate(); bgWorker = null; }
});

// Everything a fresh `world` needs before the first frame (singleplayer and net game alike).
function beginMatch() {
   menu?.hide(); menu?.hideResults();
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
   ctl.ammo = P.ammo || 'HE'; ctl.mode = P.turrets?.length ? 'guns' : torpInfo(P) ? 'torp' : MissileUi.defaultMode(P); ctl.spread = P.torps?.spread || 'narrow';
   ctl.lockId = null; ctl.mapOpen = false; ctl.board = false;
   ctl.lead = true; lead.id = null; lead.shown = false;
   for (const k in ctl.hold) ctl.hold[k] = 0;
   consEmu = simv.newCons ? null : makeConsEmu(P);
   flightCal = null;
   intel = { lastKnown: new Map() };
   Object.assign(fx, { seq: 0, oldEvIdx: world.events?.length || 0, lastHits: P.shotsHit || 0, lastDmg: P.dmgDealt || 0,
      lastHp: P.hp, spotted: false, dmg: 0, feed: [], msgs: [], torpPingT: 0, torpWarn: [], ribbonSndT: 0, maxShellId: 0,
      heat: 0, music: -1, musicHold: 0, starT: -99 });
   for (const k in fx.alertT) fx.alertT[k] = 0;
   shellcam.reset(); endKillCam(); cam3.override = null;
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
   cam3.yaw = view.yaw; cam3.range = R0; zoom.reset(L); cam3.dist = zoom.dist; cam3.bino = false; cam3.zoom = zoom.zoom;
   // the last match may have ended in the scope: snap the lens back instead of blending out
   if (renderer.cam) { renderer.cam.scopeT = 0; renderer.cam._zoomS = 1; renderer.cam._zoomV = 0; }
   cam3.freeLook = false; cam3.spectate = false;
   cam3.peri = null; subui.reset(world); airui.reset(world, cam3); mui.reset(world); opsui.reset(world);
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
   hud.show(false);
   for (const id of ['pause', 'howto']) $(id)?.classList.add('hidden');
   menu.showResults(world, lastOpts || resolveOpts({}), { ribbons: fx.ribbons, ribbonNames: RIBBON_NAMES, net: !!net });
}

let pausedAt = 0;
function pause() {
   if (phase !== 'playing') return;
   endKillCam();
   phase = 'paused';
   pausedAt = performance.now();
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
// The battle wheel zooms only with no map / overlay up; otherwise the page keeps the event.
input.wheelGate = () => (phase === 'photo' || (phase === 'playing' && !ctl.mapOpen)) && !document.querySelector('.overlay:not(.hidden)');

function toMenu() {
   const n = net;
   net = null;
   subui.stop(); airui.stop();
   shellcam.reset(); endKillCam(); cam3.override = null; input.noLock = false; $('photo-hint')?.classList.add('hidden');
   phase = 'menu';
   input.gameActive = false;
   input.releaseLock();
   world = null; P = null;
   for (const id of ['pause', 'howto']) $(id)?.classList.add('hidden');
   hud.show(false);
   menu.show();
   if (n) n.quit();                    // tells the others and hands back to the lobby (session.onEnd)
}

// context for missileui.js (one object, reused)
const _mctx = { ctl, aim, lockId: null, camYaw: 0, W: 1, H: 1 };
function mctx() {
   const l = ctl.lockId != null ? lockedShip() : null;
   _mctx.lockId = l ? l.id : null; _mctx.camYaw = renderer.cam?.pose?.yaw ?? cam3.yaw; _mctx.W = W; _mctx.H = H;
   return _mctx;
}

// ------------------------------------------------------------------ frame-level input
function frameInput(dt) {
   const p = P;
   const inp = input;

   // --- panels
   if (inp.tapped('M')) { ctl.mapOpen = !ctl.mapOpen; audio.uiClick(); }
   ctl.board = inp.down('TAB');
   if (inp.tapped('H')) { ctl.help = !ctl.help; hud.toggleHelp(ctl.help); }

   subui.frame(p, world, cam3, dt);
   mui.frame(p, world, dt);
   // carrier keys (1-3 plane type, E launch / take over, 4 AA focus); true = squadron view
   if (airui.input(inp, p, world, dt, { mapOpen: ctl.mapOpen, sens: settings.sens, client: !!net && !net.isHost, act })) { cam3.bino = false; return; }
   if (!p || !p.alive) { cam3.bino = false; return; }

   // --- engine telegraph / rudder: persistent steps, hold repeats
   stepHold('W', dt, () => setTelegraph(ctl.telegraph + 1));
   stepHold('S', dt, () => setTelegraph(ctl.telegraph - 1));
   stepHold('A', dt, () => setRudder(ctl.rudder - 1));
   stepHold('D', dt, () => setRudder(ctl.rudder + 1));
   if (inp.tapped('Q')) setRudder(0);

   // --- weapons
   const ti = torpInfo(p);
   // 1 gun · 2 anti-ship missile · 3 cruise missile (map) · 4 rockets · 5 torpedoes; carriers: 1-4 belong to the air group (airui)
   const cruiseChart = ctl.mode === 'cruise' && ctl.mapOpen;
   if (!p.air && inp.tapped('1')) {
      if (p.turrets?.length) selectAmmo('HE');
      else { audio.denied(); hud.msg('Kein Geschütz an Bord', 'warn'); }
   }
   if (!p.air && inp.tapped('5')) {
      if (!ti) { audio.denied(); hud.msg('Keine Torpedos an Bord', 'warn'); }
      else if (ctl.mode === 'torp') {
         ctl.spread = ctl.spread === 'narrow' ? 'wide' : 'narrow';
         if (typeof p.setTorpSpread === 'function') act(['s', ctl.spread]);
         else if (p.torps) p.torps.spread = ctl.spread;
         audio.uiClick();
         hud.msg('Torpedofächer: ' + (ctl.spread === 'wide' ? 'weit' : 'eng'), 'info');
      } else { ctl.mode = 'torp'; audio.ammoSwitch(); }
   }
   // I helicopter (map open: send it to a point), K swimmer team (opsui.js); it takes the map click first
   opsui.input(inp, p, world, act, mctx());
   // 2 / 3 / 4, R radar, V doctrine, T priority target, map targeting (missileui.js)
   mui.input(inp, p, world, act, mctx());
   // touch: another weapon chosen on the cruise-missile chart puts the chart away (no second tap on the minimap)
   if (cruiseChart && touch.shown && !opsui.mapMode && (ctl.mode === 'guns' || ctl.mode === 'ssm' || ctl.mode === 'torp')) ctl.mapOpen = false;
   if (inp.tapped('SPACE')) inp.mouse.clicked = true;
   if (inp.tapped('L')) { ctl.lead = !ctl.lead; hud.msg('Vorhaltemarker ' + (ctl.lead ? 'an' : 'aus'), 'info'); audio.uiClick(); }
   if (inp.tapped('X')) toggleLock();
   if (inp.mouse.ctrlClicks && !ctl.mapOpen) pickSecTarget();
   watchSecTarget();

   // --- consumables (Y damage control, U repair, F decoys, J jammer)
   for (const c of consumables()) if (inp.tapped(c.slot)) useConsumable(c.slot);

   // --- zoom ladder (zoom3d.js): the wheel runs third-person distance -> 2x..16x scope, Shift
   // jumps in/out on the same state. Only the camera moves: bearing and range stay put.
   if (inp.tapped('SHIFT')) { zoom.toggle(); audio.uiClick(); }
   if (!ctl.mapOpen && inp.mouse.wheel && zoom.wheel(inp.mouse.wheel)) audio.uiClick();
   zoom.update(dt);
   cam3.bino = zoom.bino; cam3.zoom = zoom.zoom; cam3.dist = zoom.dist;
   subui.input(inp, p, world, act);                     // F / G: depth keys, depth charges
   if (p.sub && p.depth === 2) cam3.bino = false;       // deep: no optics

   // --- free look (C or RMB): the camera roams, the guns hold the last aim
   const wantFree = inp.down('C') || inp.mouse.right;
   if (wantFree && !cam3.freeLook) { frozen.yaw = cam3.yaw; frozen.range = cam3.range; }
   if (!wantFree && cam3.freeLook) { view.yaw = unwrapNear(frozen.yaw, view.yaw); view.logR = Math.log(frozen.range); }
   cam3.freeLook = wantFree;

   // --- touch aim assist (Zielhilfe): the aim rides on the lead point of the locked target, a swipe
   // shifts it (the shift is kept), a long swipe away pauses the assist until the next lock
   const ab = assistBase(p);
   if (ab) {
      view.yaw = unwrapNear(ab.yaw + assist.yaw, view.yaw);
      view.logR = clamp(ab.logR + assist.logR, Math.log(cam3.rangeMin), Math.log(cam3.rangeMax));
   }

   // --- mouse -> bearing / range. Sensitivity follows the FOV so 16x is as controllable as 1x.
   if (!ctl.mapOpen) {
      const fov = renderer.camera.fov || BASE_FOV;
      const k = Math.tan(fov * DEG / 2) / Math.tan(BASE_FOV * DEG / 2);
      const dx = clamp(inp.mouse.dx, -4000, 4000) * settings.sens, dy = clamp(inp.mouse.dy, -4000, 4000) * settings.sens;
      view.yaw += dx * YAW_SENS * k;
      if (dy) {
         const st = renderer.cam?.scopeT ?? 0;
         const cap = lerp(RANGE_CAP_TP, RANGE_CAP_BINO, clamp01(st));
         // integrate in a few sub-steps: the gain changes along a long mouse sweep
         const n = Math.min(12, Math.ceil(Math.abs(dy) / 40));
         for (let i = 0; i < n; i++) {
            const g = Math.max(1e-4, aimGain(p, cam3, Math.exp(view.logR), st));
            const step = Math.min(cap, VSENS * k / g) * (dy / n);
            view.logR = clamp(view.logR - step, Math.log(cam3.rangeMin), Math.log(cam3.rangeMax));
         }
      }
   }
   if (ab) {
      assist.yaw = angleDelta(ab.yaw, view.yaw); assist.logR = clamp(view.logR - ab.logR, -0.4, 0.4);
      if (Math.abs(assist.yaw) > ASSIST_BREAK) { assist.paused = true; hud.msg('Zielhilfe pausiert · Ziel neu erfassen', 'info'); }
   }
   const s = 1 - Math.exp(-dt / AIM_TAU);
   cam3.yaw += (view.yaw - cam3.yaw) * s;
   cam3.range = Math.exp(lerp(Math.log(cam3.range), view.logR, s));
   // keep angles bounded without a visible jump (both shift together)
   if (Math.abs(cam3.yaw) > 50) { const sh = Math.round(cam3.yaw / TAU) * TAU; cam3.yaw -= sh; view.yaw -= sh; frozen.yaw -= sh; }
}

function unwrapNear(a, ref) { return ref + angleDelta(ref, a); }

// Touch aim assist: only on a touch screen, only for the X lock, never in PvP and never for the
// squadron view, free look or the map. Firing, ammunition and dispersion stay with the player.
// Returns the bearing / log range of the lead point (from the last buildLead) or null.
const ASSIST_BREAK = 0.35;                                  // rad swiped off the lead: assist pauses
const assist = { id: null, paused: false, yaw: 0, logR: 0 };
const assistOut = { yaw: 0, logR: 0 };
function assistWanted() { return touch.on && settings.aimAssist && !net?.pvp && ctl.lockId != null; }
function assistBase(p) {
   if (assist.id !== ctl.lockId) { assist.id = ctl.lockId; assist.paused = false; assist.yaw = 0; assist.logR = 0; }
   if (!assistWanted() || assist.paused || cam3.freeLook || ctl.mapOpen || airui.flying || !p.alive) return null;
   if (!lead.fix || lead.id !== ctl.lockId) return null;
   const dx = lead.wx - p.pos.x, dy = lead.wy - p.pos.y, d = Math.hypot(dx, dy);
   if (!(d > 1)) return null;
   assistOut.yaw = Math.atan2(dy, dx); assistOut.logR = clamp(Math.log(d), Math.log(cam3.rangeMin), Math.log(cam3.rangeMax));
   return assistOut;
}
window.__assist = () => ({ wanted: assistWanted(), paused: assist.paused, yaw: assist.yaw, logR: assist.logR, fix: lead.fix });

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
   if (simv.newAmmo) { try { act(['a', type]); } catch (e) { /* ignore */ } }
   else {
      // emulate the switch: every mount reloads with the new shell type
      const rl = P.cfg?.main?.reload || 5;
      for (const t of P.turrets || []) t.cd = Math.max(t.cd || 0, rl);
   }
   ctl.ammo = type;
   audio.ammoSwitch();
   if (type !== 'HE') hud.msg('Munition: Panzerbrechend (AP)', 'info');
}

function toggleLock() {
   // nearest spotted enemy to the crosshair (screen space from the last frame)
   let best = null, bestD = Infinity;
   for (const m of lastMarkers) {
      if (m.ally || !m.onScreen) continue;
      const d = Math.hypot(m.x - W / 2, m.y - H / 2);
      if (d < bestD) { bestD = d; best = m; }
   }
   if (best && bestD < Math.max(W, H) * 0.35 && best.id !== ctl.lockId) {
      ctl.lockId = best.id; audio.lock();
      if (assistWanted() && !assist.told) { assist.told = true; hud.msg('Zielhilfe: das Fadenkreuz folgt dem Vorhalt · Wischen korrigiert', 'info'); }
   }
   else if (ctl.lockId != null) { ctl.lockId = null; audio.uiClick(); }
   else { audio.denied(); hud.msg('Kein Ziel im Blickfeld', 'warn'); }   // a silent button reads as a missed tap
}
// Ctrl+left click (WoWs): the enemy under the crosshair becomes the secondary battery's priority
// target (sim: ship.secTarget); the same ship again or open sea clears it. Picking: the crosshair
// ray against the hulls (the aim snap), else the nearest marker / waterline close to the centre.
function pickSecTarget() {
   const p = P;
   if (typeof p?.setSecTarget !== 'function') return;
   if (!p.cfg?.sec) { audio.denied(); hud.msg('Keine Sekundärbewaffnung an Bord', 'warn'); return; }
   let id = aim.snapped;
   if (id == null) {
      let bestD = Math.max(40, Math.min(W, H) * 0.06);
      for (const m of lastMarkers) {
         if (m.ally || !m.onScreen) continue;
         const s = shipById(m.id);
         if (!s) continue;
         const wl = project(s.pos.x, 0, s.pos.y);
         const d = Math.min(Math.hypot(m.x - W / 2, m.y - H / 2), wl.visible ? Math.hypot(wl.x - W / 2, wl.y - H / 2) : Infinity);
         if (d < bestD) { bestD = d; id = m.id; }
      }
   }
   if (id != null && id !== p.secTarget) act(['x', id]);
   else if (p.secTarget != null) act(['x', null]);
   else { audio.denied(); return; }
   audio.uiClick();
}
// German notice whenever the priority target changes (set, cleared, or dropped by the sim when
// the target sinks / stays unseen); with the manual skill a hint at the start of a battle.
const secSeen = { world: null, id: null };
function watchSecTarget() {
   const p = P, id = p?.secTarget ?? null;
   if (secSeen.world !== world) {
      secSeen.world = world; secSeen.id = id;
      if (p?.manualSec && p.cfg?.sec) hud.msg('Einzelzielfeuer: Ziel der Mittelartillerie mit ' + (input.touchMode ? '„Sek. Ziel“' : 'Strg+Linksklick') + ' wählen', 'info', 5);
      return;
   }
   if (id === secSeen.id) return;
   secSeen.id = id;
   const s = id != null ? shipById(id) : null;
   hud.msg(s ? 'Sekundärziel: ' + (s.name || s.cls) : 'Sekundärziel aufgehoben', 'info');
}
function lockedShip() {
   if (ctl.lockId == null || !world) return null;
   const s = world.ships.find(x => x.id === ctl.lockId);
   if (!s || !s.alive) { ctl.lockId = null; return null; }
   if (isVisible(world, s)) return s;
   // out of sight: the lock (and the dead-reckoned lead marker) survives a short loss of contact
   if (!seenWithin(s, LOCK_GRACE)) { ctl.lockId = null; hud.msg('Ziel außer Sicht – Erfassung aufgehoben', 'info'); }
   return null;
}
function seenWithin(s, sec) {
   const k = intel.lastKnown.get(s.id);
   return !!k && world.time - k.t <= sec;
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
   // engine + rudder, aim point, X lock (the secondaries' fallback choice)
   updateAimPoint();
   const ap = aim.point;
   cmd.telegraph = ctl.telegraph; cmd.rudder = ctl.rudder; cmd.aim = ap; cmd.lock = ctl.lockId;
   if (simv.newTele && simv.newRudder) applyCommand(p, cmd);
   else {
      // old sim
      p.throttleIn = OLD_THROTTLE[ctl.telegraph]; p.telegraph = ctl.telegraph;
      p.helm = ctl.rudder / 2; p.rudderCmd = ctl.rudder;
      p.aimPoint = ap;
      const bx = ap.x - p.pos.x, by = ap.y - p.pos.y, bl = Math.hypot(bx, by) || 1;
      p.aimBearing = Math.atan2(by, bx);
      p.aim = { x: bx / bl, y: by / bl };
      if ('lockTarget' in p) p.lockTarget = ctl.lockId;
   }
   if (net) { cmd.air = airui.netCtl; net.control(cmd); }   // air: the flight a net client flies (airui.js)
   turretCache = computeTurrets(p);

   // a press in a frame without a sim step would be gone by the next one (endFrame clears it)
   const click = input.mouse.clicked || firePending; firePending = false;
   if (airui.flying) return;            // squadron view: the ship holds fire
   if (phase !== 'playing' || ctl.mapOpen || kc.on || shellcam.blocksFire()) return;
   // clicked covers a press+release inside one frame (low frame rates, quick taps);
   // Ctrl held = secondary target picking, never a salvo
   // Space fires like the left mouse button
   if (ctl.mode === 'guns' && (input.mouse.down || click || input.down('SPACE')) && !input.down('CTRL')) fireGuns();
   else if (ctl.mode === 'torp' && click) { input.mouse.clicked = false; fireTorps(); }
   else if (ctl.mode !== 'guns' && ctl.mode !== 'torp' && click && !input.down('CTRL')) {
      // guided weapons (missileui.js): one launch per press
      input.mouse.clicked = false;
      mui.fire(p, world, act, mctx());
   }
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
      try { n = act(['f', ap.x, ap.y]) || 0; } catch (e) { n = 0; }
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
      fx.heat += 0.4;
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
   if (ti.canFire === false) {
      audio.denied();
      hud.msg(!p.sub ? 'Kein Schusswinkel – Torpedorohre zeigen zur Seite'
         : p.depth === 2 ? 'Zu tief – Torpedos nur bis Sehrohrtiefe' : 'Kein Schusswinkel – Bug- oder Heckrohre auf das Ziel drehen', 'warn');
      return 0;
   }
   let n = 0;
   if (simv.newTorps) {
      try { n = act(['t', aim.yaw]) || 0; } catch (e) { n = 0; }
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
   if (n > 0) { fired.torps += n; audio.torpLaunch(n); hud.msg('Torpedos los!', 'info'); }
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
   pen: 'Panzertreffer', citadel: 'Zitadelltreffer', overpen: 'Durchschuss', ricochet: 'Abgeprallt', shatter: 'Wirkungslos',
   he: 'Sprengtreffer', sec: 'Mittelartillerie', torp: 'Torpedotreffer', fire: 'Brand gelegt', flood: 'Wassereinbruch', kill: 'Versenkt',
   spotted: 'Gesichtet', cap: 'Punkt genommen', defend: 'Punkt gehalten',
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
            if (onMe && e.type !== 'fire' && e.type !== 'flood') { audio.hit((e.dmg || 0) > p.maxHP * 0.05, e.type); fx.heat += 1; }
            if (onMe && e.type === 'fire') { audio.fireStart(); alertCue('fire', 'Feuer an Bord!'); }
            if (onMe && e.type === 'flood') alertCue('flood', 'Wassereinbruch!');
            if (onMe && (e.type === 'citadel' || (e.dmg || 0) > p.maxHP * 0.12)) alertCue('citadel', e.type === 'citadel' ? 'Zitadelle getroffen!' : 'Schwerer Treffer!');
            break;
         case 'kill': case 'sunk': {
            const v = shipById(e.dstId), k = shipById(e.srcId);
            if (e.type === 'kill' && mine) {
               addRibbon('kill');
               hud.msg('Gegner versenkt', 'good');
               audio.alert('kill');
               if (v) startKillCam(v);
            }
            if (v && !fx.whistled.has('sunk' + v.id)) {
               fx.whistled.add('sunk' + v.id);
               feed(k, v);
               audio.sink(Math.hypot(v.pos.x - p.pos.x, v.pos.y - p.pos.y), v.pos);
            }
            break;
         }
         case 'spotted': {
            if (mine) addRibbon('spotted');
            // night: an illumination round bursts over a freshly spotted enemy (visual only)
            const v = world.env?.time === 'night' && world.time - fx.starT > 10 ? shipById(e.dstId) : null;
            if (v && renderer.fx?.starShell && Math.hypot(v.pos.x - p.pos.x, v.pos.y - p.pos.y) < 12000) {
               fx.starT = world.time;
               renderer.fx.starShell(v.pos.x + Math.cos(v.heading) * 250, v.pos.y + Math.sin(v.heading) * 250);
            }
            break;
         }
         case 'weather': audio.alert('storm'); break;
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
            if (e.end) { audio.endCue(e.level !== 'lose' && e.state !== 'failed'); break; }
            if (!e.text) break;
            const bad = e.level === 'warn' || e.level === 'bad' || e.state === 'failed';
            hud.msg(e.text, bad ? 'warn' : e.state === 'done' ? 'good' : 'radio', 6);
            if (e.state === 'done' || e.state === 'failed') audio.objective(e.state); else audio.radio();
            break;
         }
         default: subui.event(e, p, world, mine, onMe); airui.event(e, p, world); mui.event(e, p, world); opsui.event(e, p, world); break;
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
         const v = velOf(s);
         k.x = s.pos.x; k.y = s.pos.y; k.vx = v.x; k.vy = v.y; k.hdg = s.heading; k.t = world.time;
         k.type = shipType(s); k.name = s.name || s.cls; k.visible = true; k.alive = true;
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

const AUDIO_FX = new Set(['ricochet', 'shatter', 'terrain', 'torpHit', 'detonation']);
let gunsWereBusy = false;
function pollAudio(dt) {
   const p = P;
   if (!p) return;
   const lx = p.pos.x, ly = p.pos.y;
   audio.setListener(lx, ly, renderer.cam?.pose?.yaw ?? cam3.yaw);
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
            if (!salvos.has(key)) salvos.set(key, { n: 0, sec: s.kind === 'sec', cal: s.caliber || shooter?.cfg?.main?.caliber || 200, pos: shooter?.pos || s.pos,
               d: shooter ? Math.hypot(shooter.pos.x - lx, shooter.pos.y - ly) : Math.hypot(s.pos.x - lx, s.pos.y - ly) });
            salvos.get(key).n++;
         }
      }
      const side = s.side ?? s.owner;
      if (side !== p.side && !fx.whistled.has(id)) {
         const d = Math.hypot(s.pos.x - lx, s.pos.y - ly);
         const falling = s.dur ? (s.age || 0) > s.dur * 0.6 : true;
         if (d < 420 && falling) { fx.whistled.add(id); audio.whistle(0); fx.heat += 0.5; }
      }
   }
   for (const v of salvos.values()) {
      if (v.sec) audio.secondary(v.d, v.pos); else audio.mainGun(v.cal, v.n, Math.max(1, v.d), v.pos);
   }
   if (fx.shellSeen.size > 4000) fx.shellSeen = new Set(world.shells.map(s => s.id));
   if (fx.whistled.size > 4000) fx.whistled = new Set();
   // splashes / explosions near enough to hear
   for (const e of world.effects || []) {
      if (fx.effSeen.has(e)) continue;
      fx.effSeen.add(e);
      if (!e.pos) continue;
      if (e.blast) continue;                 // scripted large detonation: its rumble comes with the shock front (blast3d.js)
      const d = Math.hypot(e.pos.x - lx, e.pos.y - ly);
      if (d > 9000) continue;
      if (e.kind === 'splash') audio.splash(d, !!e.big || (e.size || 0) > 1.5, e.pos);
      else if (e.kind === 'explosion') {
         // hits on the own ship are heard from inside the hull (processEvents -> audio.hit)
         if (e.sink || e.shipId !== p.id) audio.impact(e.sink ? 'explosion' : e.hit || 'explosion', d, e.pos, !!e.big || !!e.sink);
      } else if (e.kind === 'torpLaunch') { if (e.shipId !== p.id) audio.impact(e.kind, d, e.pos); }
      else if (AUDIO_FX.has(e.kind)) audio.impact(e.kind, d, e.pos, !!e.big);
   }
   // main battery loaded again: a muffled clank from the turrets
   let live = 0, ready = 0;
   for (const t of turretCache) { if (t.state !== 'dead') live++; if (t.state === 'ready') ready++; }
   const allReady = live > 0 && ready === live;
   if (allReady && gunsWereBusy && p.alive && phase === 'playing') audio.reloaded();
   gunsWereBusy = !allReady;
   // torpedo warning ping + spotted alarm
   fx.torpPingT -= dt;
   if (fx.torpWarn.length && !fx.hadTorpWarn) alertCue('torp', 'Torpedos voraus!');
   fx.hadTorpWarn = fx.torpWarn.length > 0;
   if (fx.torpWarn.length && fx.torpPingT <= 0) { audio.torpWarning(); fx.torpPingT = 1.3; }
   const sp = p.alive && playerSpotted(p);
   if (sp && !fx.spotted) { audio.spottedAlarm(); hud.msg('Du wurdest entdeckt!', 'warn'); }
   fx.spotted = sp;
   const muted = phase !== 'playing';
   audio.updateEngine(Math.abs(p.speed || 0), maxSpeedMs(p), muted || !p.alive, Math.abs(ctl.telegraph || 0) / 4);
   audio.updateAmbient(world.env?.seaState ?? 0.4, muted, world.env?.weather, p.alive ? p.fires?.length || 0 : 0);
}

// ------------------------------------------------------------------ render interpolation
// Ships are drawn between the last two sim states so motion is smooth at any refresh rate.
const prevState = new WeakMap();   // keyed by Ship: finished matches' ships can be collected
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
function project(x, h, y, out) {
   if (typeof renderer.project === 'function') return renderer.project(x, h, y, out);
   const q = renderer.cam.project(x, h, y, W, H);
   return out ? Object.assign(out, q) : q;
}

// ------------------------------------------------------------------ lead marker (Vorhaltemarker)
// Where the target will be when a salvo (or a torpedo) fired now arrives. Whenever there is an
// enemy to shoot at, the marker is on screen: clamped to the frame edge with an arrow when the lead
// point is outside the view, dead-reckoned for a few seconds when the target drops out of sight
// ('lost'), flagged when the lead point is beyond weapon range ('range'). The target is the X lock,
// else the enemy whose icon or lead point is nearest to the crosshair. All scratch objects are
// module-level: nothing is allocated per frame. Drawn by hud3d.js (_lead), pure logic in lead3d.js.
const LOCK_GRACE = 10, AUTO_GRACE = 6;                     // s a locked / auto target may stay unseen
const LEAD_FRAME = { l: 36, t: 100, r: 36, b: 250 };       // px kept clear: score box, bottom panels + minimap
const lead = { shown: false, x: 0, y: 0, off: false, ang: 0, state: 'ok', torp: false, id: null,
   hull: false, bx: 0, by: 0, sx: 0, sy: 0, dist: 0, fix: false, wx: 0, wy: 0 };   // fix / wx, wy: world lead point (aim assist)
const leadPt = { x: 0, y: 0, t: 0 }, leadPr = { x: 0, y: 0, visible: false }, leadPr2 = { x: 0, y: 0, visible: false };
const leadCands = [];
let leadSpeed = 0;   // torpedo speed (m/s) in torpedo mode, 0 = guns
function leadSolve(p, tx, ty, vx, vy, out) {
   if (leadSpeed > 0) return solveIntercept(p.pos.x, p.pos.y, tx, ty, vx, vy, leadSpeed, out);
   solveLead(p.pos.x, p.pos.y, tx, ty, vx, vy, flightTime, out);
   return true;
}
function buildLead(ui, markers) {
   const p = P, L = lead, cx = W / 2, cy = H / 2;
   L.shown = false; L.fix = false;
   const torp = ctl.mode === 'torp';
   if (!(ctl.lead || assistWanted()) || !p?.alive || (torp && !ui.torpInfo)) { L.id = null; return; }
   leadSpeed = torp ? ui.torpInfo.speed : 0;
   // --- target: the lock (also while it is briefly unseen), else the best candidate
   let tgt = ui.lockShip, lost = false;
   if (!tgt && ctl.lockId != null) { tgt = shipById(ctl.lockId); lost = !!tgt; }
   if (!tgt) {
      let n = 0;
      for (let i = 0; i < markers.length; i++) {
         const m = markers[i];
         if (m.ally) continue;
         const s = m.ship, v = velOf(s);
         let d = m.onScreen ? Math.hypot(m.x - cx, m.y - cy) : Infinity;
         if (leadSolve(p, s.pos.x, s.pos.y, v.x, v.y, leadPt)) {
            project(leadPt.x, 0, leadPt.y, leadPr);
            if (leadPr.visible) d = Math.min(d, Math.hypot(leadPr.x - cx, leadPr.y - cy));
         }
         // off-screen: rank by how far the camera would have to turn
         if (d === Infinity) d = W + H + Math.abs(angleDelta(renderer.cam?.pose?.yaw ?? cam3.yaw,Math.atan2(s.pos.y - p.pos.y, s.pos.x - p.pos.x))) * ui.pxPerRad;
         const c = leadCands[n] || (leadCands[n] = { id: null, score: 0, ship: null });
         c.id = s.id; c.score = d; c.ship = s; n++;
      }
      const bi = pickTarget(leadCands, n, L.id);
      const best = bi >= 0 ? leadCands[bi] : null;
      // the previous target dropped out of sight: keep its marker for a moment unless the crosshair
      // is clearly on another ship
      const prev = L.id != null && (!best || best.id !== L.id) ? shipById(L.id) : null;
      if (prev && prev.alive && !isAlly(world, prev) && !isVisible(world, prev) && seenWithin(prev, AUTO_GRACE)
         && (!best || best.score > Math.max(W, H) * 0.22)) { tgt = prev; lost = true; }
      else if (best) tgt = best.ship;
      for (let i = 0; i < n; i++) leadCands[i].ship = null;   // no stale ship references
   }
   if (!tgt) { L.id = null; return; }
   L.id = tgt.id;
   // --- lead point: live track, or dead reckoning from the last sighting
   let tx, ty, vx, vy, hdg;
   if (lost) {
      const k = intel.lastKnown.get(tgt.id);
      if (!k) { L.id = null; return; }
      const dtk = world.time - k.t;
      vx = k.vx || 0; vy = k.vy || 0; tx = k.x + vx * dtk; ty = k.y + vy * dtk; hdg = k.hdg ?? 0;
   } else { const v = velOf(tgt); tx = tgt.pos.x; ty = tgt.pos.y; vx = v.x; vy = v.y; hdg = tgt.heading; }
   if (!leadSolve(p, tx, ty, vx, vy, leadPt)) return;   // a torpedo cannot catch this target
   L.fix = true; L.wx = leadPt.x; L.wy = leadPt.y;
   if (!ctl.lead) return;                                // marker off: the aim assist alone needs the point
   const dist = Math.hypot(leadPt.x - p.pos.x, leadPt.y - p.pos.y);
   L.dist = dist; L.torp = torp;
   L.state = leadState(!lost, dist, torp ? ui.torpInfo.range : aim.gunRange);
   // --- screen placement (view-space z / x tell "behind the camera" and which side)
   const e = renderer.camera.matrixWorldInverse.elements;
   const vz = e[2] * leadPt.x + e[10] * leadPt.y + e[14], vxs = e[0] * leadPt.x + e[8] * leadPt.y + e[12];
   project(leadPt.x, 0, leadPt.y, leadPr);
   edgeClamp(leadPr.x, leadPr.y, vz > -1, vxs, W, H, LEAD_FRAME, L);
   L.hull = false;
   if (!L.off && !torp) {
      const hl = shipLen(tgt) / 2, c = Math.cos(hdg), sn = Math.sin(hdg);
      project(leadPt.x + c * hl, 0, leadPt.y + sn * hl, leadPr);
      project(leadPt.x - c * hl, 0, leadPt.y - sn * hl, leadPr2);
      if (leadPr.visible && leadPr2.visible) { L.hull = true; L.bx = leadPr.x; L.by = leadPr.y; L.sx = leadPr2.x; L.sy = leadPr2.y; }
   }
   L.shown = true;
}
window.__lead = () => ({ shown: lead.shown, x: lead.x, y: lead.y, off: lead.off, ang: lead.ang, state: lead.state, torp: lead.torp, id: lead.id, hull: lead.hull, dist: lead.dist });

function buildUi(dt) {
   const p = P;
   const ui = { W, H, world, p, phase, alive: !!p?.alive, mapOpen: ctl.mapOpen, board: ctl.board };
   const pose = renderer.cam?.pose;
   const fov = renderer.camera.fov || BASE_FOV;
   ui.fov = fov;
   ui.pxPerRad = H / (2 * Math.tan(fov * DEG / 2));
   ui.scopeT = renderer.cam?.scopeT || 0;
   ui.bino = cam3.bino; ui.zoom = cam3.zoom; ui.freeLook = cam3.freeLook;
   // brief ladder cue after a zoom change (hud3d fades it out)
   ui.zoomLevel = zoom.level; ui.zoomLadder = LADDER_LEN; ui.zoomTP = TP_STEPS;
   ui.zoomCueA = clamp01(1.6 - zoom.sinceChange * 1.25);
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
      markers.push({ id: s.id, ship: s, x: sp.x, y: sp.y, onScreen: !!sp.visible, ally, name: s.name || s.cls, type: shipType(s), level: ally ? 0 : contactLevel(world, p.side, s),
         hpFrac: clamp01(s.hp / (s.maxHP || 1)), dist, locked: s.id === ctl.lockId, sec: s.id === p.secTarget, fires: s.fires?.length || 0 });
   }
   ui.markers = markers;
   lastMarkers = markers;

   // lock panel + lead marker (guns and torpedoes; see buildLead)
   ui.lockShip = lockedShip();
   if (airui.flying) lead.shown = false; else buildLead(ui, markers);
   ui.leadMark = lead;

   // torpedo fan (screen polylines)
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
   subui.fill(ui, p, world, cam3, project, subui.peri.y, dt);
   airui.fill(ui, p, world, project, dt);
   mui.fill(ui, p, world, project, mctx());
   opsui.fill(ui, p, world, project, mctx(), renderer.blast ? renderer.blast.white : 0);
   ui.mapOpts = {
      mx: ui.mx, ops: ui.ops, sub: ui.sub.map, airCtl: airui.sqId, intel, camYaw: ui.camYaw, camHfov: pose?.hfov, gunRange: aim.gunRange, detectRange: detectRangeOf(p),
      aimPoint: aim.point, torpFan: ctl.mode === 'torp' && ui.torpInfo ? { bearings: torpBearings(ui.torpInfo, aim.yaw), range: ui.torpInfo.range } : null,
   };
   return ui;
}

// ------------------------------------------------------------------ alerts + dynamic music
// Distinct synthesized cue + HUD text; each kind at most every 3 s (fires/floods re-trigger).
function alertCue(kind, text) {
   if (world.time - (fx.alertT[kind] ?? -99) < 3) return;
   fx.alertT[kind] = world.time;
   hud.msg(text, 'warn');
   audio.alert(kind);
}
// -1 off (menu/pause/photo), 0 calm, 1 enemies spotted, 2 heavy fire, 3 low HP. Rising is
// immediate, falling waits 6 s so the music does not flap.
function updateMusic(dt) {
   let lvl = -1;
   const p = P;
   if (phase === 'playing' && p && p.alive && world.phase === 'playing') {
      fx.heat = Math.max(0, fx.heat - dt * 0.3);
      lvl = 0;
      const r2 = (aim.gunRange * 1.3) ** 2;
      for (const s of world.ships) {
         if (s.alive && s.side !== p.side && s.spotted && (s.pos.x - p.pos.x) ** 2 + (s.pos.y - p.pos.y) ** 2 < r2) { lvl = 1; break; }
      }
      if (fx.heat > 2.5) lvl = 2;
      if (p.hp < p.maxHP * 0.3) lvl = 3;
   }
   if (lvl >= fx.music || lvl < 0) { fx.music = lvl; fx.musicHold = 6; }
   else if ((fx.musicHold -= dt) <= 0) { fx.music = lvl; fx.musicHold = 6; }
   audio.updateMusic(fx.music);
}

// ------------------------------------------------------------------ kill camera
// ~2 s cut to an enemy the player just sank. Any key/click/wheel skips it (key taps still act),
// a torpedo warning or a fresh hit aborts it, the guns hold fire meanwhile. The chase rig is
// frozen while cam3.override is set, so camera, zoom and aim resume exactly as they were.
const kc = { on: false, t: 0, dur: 2.2, ship: null, a0: 0, hp0: 0, d: 400, pose: { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0, fov: 40 } };
function startKillCam(v) {
   const p = P;
   if (!settings.killCam || kc.on || phase !== 'playing' || !p?.alive || ctl.mapOpen || airui.flying) return;
   if (fx.torpWarn.length || p.hp < p.maxHP * 0.25) return;   // never in obvious danger
   kc.on = true; kc.t = 0; kc.w0 = performance.now(); kc.ship = v; kc.hp0 = p.hp;
   kc.d = clamp(shipLen(v) * 2.4, 260, 700);
   kc.a0 = Math.atan2(p.pos.y - v.pos.y, p.pos.x - v.pos.x) + 0.6;
   cam3.override = kc.pose;
   tickKillCam(0);
   hud.show(false);
   overlay.clear();
}
function endKillCam() {
   if (!kc.on) return;
   kc.on = false; kc.ship = null;
   cam3.override = null;
   input.mouse.dx = 0; input.mouse.dy = 0; input.mouse.wheel = 0;
   if (phase === 'playing' || phase === 'paused') hud.show(true);
}
// before frameInput: mouse aim is frozen, clicks only skip
function killCamInput() {
   const m = input.mouse;
   const skip = input.pressed.size > 0 || m.clicked || m.wheel || m.right;
   m.dx = 0; m.dy = 0; m.wheel = 0; m.clicked = false;
   if (skip) endKillCam();
}
function tickKillCam(dt) {
   const p = P, v = kc.ship;
   kc.t += dt;
   const wall = (performance.now() - kc.w0) / 1000;   // hard real-time cap: never hold the camera longer than dur
   if (!v || !p?.alive || kc.t >= kc.dur || wall >= kc.dur || fx.torpWarn.length || p.hp < kc.hp0 - p.maxHP * 0.03) { endKillCam(); return; }
   const a = kc.a0 + kc.t * 0.22, d = kc.d * (1 - kc.t * 0.06), o = kc.pose;
   o.px = v.pos.x + Math.cos(a) * d; o.pz = v.pos.y + Math.sin(a) * d; o.py = d * 0.28;
   o.tx = v.pos.x; o.ty = 4; o.tz = v.pos.y;
}

// ------------------------------------------------------------------ photo mode
// O: sim paused, HUD hidden, free orbit around the own ship (drag = rotate, wheel = distance).
// O / Esc returns to the exact previous view (cam3 is never touched, only overridden).
const photo = { yaw: 0, pitch: 0.3, dist: 600, cx: 0, cz: 0, pose: { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0, fov: 45 } };
function enterPhoto() {
   if (phase !== 'playing' || !P) return;
   endKillCam();
   phase = 'photo';
   photo.cx = P.pos.x; photo.cz = P.pos.y;
   photo.yaw = (renderer.cam?.pose?.yaw ?? cam3.yaw) + Math.PI;
   photo.pitch = 0.28;
   photo.dist = clamp(hullL(P) * 2.2, 220, 1500);
   cam3.override = photo.pose;
   input.noLock = true;
   input.releaseLock();
   input.mouse.down = false;
   hud.show(false);
   overlay.clear();
   $('photo-hint')?.classList.remove('hidden');
   audio.updateEngine(0, 1, true);
   tickPhoto();
}
function exitPhoto() {
   if (phase !== 'photo') return;
   phase = 'playing';
   cam3.override = null;
   input.noLock = false;
   input.mouse.dx = 0; input.mouse.dy = 0; input.mouse.wheel = 0; input.mouse.down = false; input.mouse.clicked = false;
   $('photo-hint')?.classList.add('hidden');
   hud.show(true);
   input.requestLock();
   audio.resume();
}
function tickPhoto() {
   const m = input.mouse;
   if (m.down || m.right) {
      photo.yaw += clamp(m.dx, -2000, 2000) * 0.005;
      photo.pitch = clamp(photo.pitch + clamp(m.dy, -2000, 2000) * 0.004, 0.02, 1.45);
   }
   if (m.wheel) photo.dist = clamp(photo.dist * Math.pow(1.15, m.wheel), 60, 6000);
   m.clicked = false;
   if (net && P) { photo.cx = P.pos.x; photo.cz = P.pos.y; }   // net game: the battle goes on, stay with the ship
   const o = photo.pose, cp = Math.cos(photo.pitch);
   o.tx = photo.cx; o.ty = 12; o.tz = photo.cz;
   o.px = photo.cx - Math.cos(photo.yaw) * cp * photo.dist;
   o.pz = photo.cz - Math.sin(photo.yaw) * cp * photo.dist;
   o.py = 12 + Math.sin(photo.pitch) * photo.dist;
}

// ------------------------------------------------------------------ main loop
let lastT = performance.now() / 1000;
let miniT = 0;
let firePending = false;   // fire press waiting for the next sim step

function frame() {
   requestAnimationFrame(frame);
   const nowT = performance.now() / 1000;
   let dt = nowT - lastT;
   lastT = nowT;
   if (dt > 0.25) dt = 0.25;

   try {
      if (net) net.pump();
      // Esc both drops the pointer lock (-> pause) and may arrive as a key tap in the same frame:
      // that tap must not resume the pause it just caused.
      if (world && phase === 'photo') {
         if (input.tapped('P') || input.tapped('O')) exitPhoto();
         else tickPhoto();
      } else if (world && input.tapped('P')) {
         if (phase === 'playing') pause();
         else if (phase === 'paused' && performance.now() - pausedAt > 400) resume();
      } else if (world && phase === 'playing' && input.tapped('O') && !kc.on) enterPhoto();
      // a net game never stops: pause menu and photo mode are local overlays over a running battle
      const live = !!net && !!world && (phase === 'paused' || phase === 'photo');
      if ((phase === 'playing' || live) && world) {
         if (!live) {
            if (kc.on) killCamInput();
            shellcam.input();
            frameInput(dt);
            tickConsEmu(dt);
         }
         acc += dt;
         let steps = 0;
         while (acc >= SIM_DT && steps < 15) {
            snapshotPrev();
            if (!live) applyControls(SIM_DT);
            if (!simv.botsInternal && ai.updateBot) for (const b of world.bots) ai.updateBot(b, world, SIM_DT);
            world.update(SIM_DT);
            acc -= SIM_DT; steps++;
         }
         if (steps === 15) acc = 0;
         if (!live) firePending = steps === 0 && (firePending || input.mouse.clicked);
         if (P) {
            processEvents(dt);
            updateIntel();
            fx.torpWarn = torpThreats();
            if (steps === 0 && !live) updateAimPoint();
         }
         if (world.phase === 'won' || world.phase === 'lost') {
            endTimer += dt;
            if (endTimer > 2.5) { if (phase === 'photo') exitPhoto(); endGame(); }
         }
      }

      if (kc.on) tickKillCam(dt);
      updateMusic(dt);
      const alpha = phase === 'playing' || (net && (phase === 'paused' || phase === 'photo')) ? clamp01(acc / SIM_DT) : 1;
      if (world) {
         applyInterp(alpha);
         renderer.simAlpha = alpha;       // missiles3d.js interpolates the missiles itself
         airui.frame(world, alpha, dt);   // squadron render positions + squadron camera
         try {
            shellcam.update(dt, alpha);
            cam3.spectate = !!(P && !P.alive && P.sinking);
            // test hook: headless software-GL is slow, so control tests can skip the 3D draw
            // (the camera rig still runs, keeping aim/projection exact)
            // photo mode freezes the whole scene (particles, waves) for the picture (not in a net game)
            if (renderOn) renderer.render(world, phase === 'photo' && !net ? 0 : dt, cam3);
            else if (renderer.cam?.update) { renderer.cam.update(world, dt, cam3); renderer.camera.updateMatrixWorld(); }
            if ((phase === 'playing' && !kc.on && !shellcam.on) || phase === 'paused') {
               const ui = buildUi(dt);
               miniT -= dt;
               if (miniT <= 0) { minimap.draw(world, ui.mapOpts); miniT = 1 / 30; }
               hud.update(ui, dt);
               overlay.draw(ui);
            }
         } finally { shellcam.restore(); restoreInterp(); }
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
   touch.frame(dt, phase === 'playing' && !!world);
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
const showHowTo = () => { $('howto').classList.remove('hidden'); audio.init(); audio.uiClick(); };
menu = new Menu3D($('menu'), $('end'), {
   onStart: (o) => startGame(o),
   onPort: toMenu,
   onHowTo: showHowTo,
   onClick: () => { audio.init(); audio.uiClick(); },
});
click('btn-how-close', () => { $('howto').classList.add('hidden'); audio.uiClick(); });
click('btn-resume', resume);
click('btn-quit', toMenu);
{
   const sl = $('sens'), lab = $('sens-val');
   const show = () => { if (lab) lab.textContent = Math.round(settings.sens * 100) + ' %'; };
   if (sl) {
      sl.value = String(Math.round(settings.sens * 100));
      sl.addEventListener('input', () => { settings.sens = clamp(Number(sl.value) / 100, 0.3, 2.5); show(); saveSettings(); });
   }
   show();
}
{
   const bind = (id, key, fn) => {
      const sl = $(id), lab = $(id + '-val');
      const show = () => { if (lab) lab.textContent = Math.round(settings[key] * 100) + ' %'; };
      if (sl) {
         sl.value = String(Math.round(settings[key] * 100));
         sl.addEventListener('input', () => { settings[key] = clamp(Number(sl.value) / 100, 0, 1); show(); fn(); saveSettings(); });
      }
      show();
   };
   const vol = () => audio.setVolumes(settings.music, settings.sfx);
   bind('vol-music', 'music', vol);
   bind('vol-sfx', 'sfx', vol);
   const kcBox = $('opt-killcam');
   if (kcBox) {
      kcBox.checked = settings.killCam;
      kcBox.addEventListener('change', () => { settings.killCam = kcBox.checked; saveSettings(); });
   }
   const asBox = $('opt-assist');
   if (asBox) {
      asBox.checked = settings.aimAssist;
      asBox.addEventListener('change', () => { settings.aimAssist = asBox.checked; saveSettings(); });
   }
   shellcam.bindSelect($('opt-shellcam'));
   const gfxSel = $('opt-gfx');
   if (gfxSel) {
      // the tier select plus the single options behind "Erweitert": a tier fills them all in, changing
      // one makes the choice "Benutzerdefiniert" (stored; a watchdog step-down discards it again)
      const el = { pr: $('gfx-pr'), aa: $('gfx-aa'), bloom: $('gfx-bloom'), shadow: $('gfx-shadow'), effects: $('gfx-effects'), detail: $('gfx-detail'), ocean: $('gfx-ocean') };
      const customOpt = gfxSel.querySelector('option[value="custom"]');
      const SHADOW = { low: [1024, 1], medium: [2048, 1], high: [4096, 1], ultra: [4096, TIERS.ultra.shadowFit] };
      const sync = () => {
         const o = renderer.opts, g = renderer.gfxState();
         if (customOpt) customOpt.hidden = customOpt.disabled = !renderer.custom;
         gfxSel.value = renderer.custom ? 'custom' : gfxPref() === 'auto' ? 'auto' : renderer.tier;
         if (el.pr) {   // only what the screen can show: steps up to the device's own pixel ratio
            const dpr = window.devicePixelRatio || 1, cur = Math.min(o.pr, dpr);
            const steps = [...new Set([0.5, 0.75, 1, 1.5, 2, 2.5, 3].filter(v => v < dpr).concat(dpr, cur))].sort((a, b) => a - b);
            el.pr.textContent = '';
            for (const v of steps) el.pr.add(new Option(String(Math.round(v * 100) / 100).replace('.', ',') + '×' + (v === dpr ? ' (nativ)' : ''), String(v)));
            el.pr.value = String(cur);
         }
         if (el.aa) {
            for (const op of el.aa.options) op.disabled = Number(op.value) > (g.maxSamples || 4);
            el.aa.value = String(g.samples);
         }
         if (el.bloom) el.bloom.checked = o.bloom;
         if (el.shadow) el.shadow.value = o.shadow >= 4096 ? (o.shadowFit < 1 ? 'ultra' : 'high') : o.shadow >= 2048 ? 'medium' : 'low';
         if (el.effects) el.effects.value = String(o.effects);
         if (el.detail) el.detail.value = String(o.detail);
         if (el.ocean) el.ocean.value = String(o.oceanSegs);
      };
      const set = (patch) => { renderer.setOptions(patch); if (renderer.custom) setGfxCustom(renderer.tier, renderer.opts); sync(); };
      gfxSel.addEventListener('change', () => { if (gfxSel.value === 'custom') return; setGfxPref(gfxSel.value); renderer.setTier(startTier(gfxSel.value)); });
      el.pr?.addEventListener('change', () => set({ pr: Number(el.pr.value) }));
      el.aa?.addEventListener('change', () => set({ samples: Number(el.aa.value) }));
      el.bloom?.addEventListener('change', () => set({ bloom: el.bloom.checked }));
      el.shadow?.addEventListener('change', () => { const s = SHADOW[el.shadow.value]; if (s) set({ shadow: s[0], shadowFit: s[1] }); });
      el.effects?.addEventListener('change', () => set({ effects: Number(el.effects.value) }));
      el.detail?.addEventListener('change', () => set({ detail: Number(el.detail.value) }));
      el.ocean?.addEventListener('change', () => set({ oceanSegs: Number(el.ocean.value) }));
      // opened on a small screen the options start below the fold of the card
      $('gfx-adv')?.addEventListener('toggle', (e) => { if (e.target.open) e.target.scrollIntoView({ block: 'nearest' }); });
      renderer.onGfxChange = sync;
      sync();
   }
}
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

// Test/automation entry point: startGame3D({ mission, ship, difficulty }).
window.startGame3D = startGame;

$('loading')?.remove();
menu.show();
requestAnimationFrame(frame);
