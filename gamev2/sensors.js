// gamev2/sensors.js — radar, emission control (EMCON), ESM and missile tracking of the modern mode.
// Pure functions on the world; World._updateSpotting calls them every WORLD.SPOT_DT.
//
// The picture a side has of an opposing ship or site T (all team-shared = the data link):
//    T.detected     on the plot with its true position (eyes, radar, sonar, aircraft)
//    T.targetable   fire-control quality: eyes, or a radar that holds it inside SENSOR.FC of its
//                   detection range. Only such a track takes a missile "with lock" or guns.
//    T.esmSeen      { x, y, t, brg, by, err } | null: T radiates (radar or jammer on) and an opposing
//                   ESM hears it. x/y is the rough fix (err = 1-sigma in m), brg the bearing from
//                   listener `by`. Reaches SENSOR.ESM x the emitter's own radar range.
// Radar:  ship.radarOn (setRadar). A radar reaches cfg.radar.range * target.cfg.stealth against
// ships, cfg.radar.horizon against sea-skimming missiles, cfg.radar.air against high flyers and
// aircraft; islands block all of it. A silent ship sees only what its eyes see (cfg.detect).
// Missiles: m.detected = the opposing side tracks the missile (missile.js engages only those);
//    m.seekerOn && its radar seeker is heard by ESM -> ship.seekerWarn = { t, brg, id } on its target area.
// Observers and emitters are ships and land sites (sites.js) alike: both have pos, side, alive,
// radarOn and cfg.radar.
import { SENSOR, MISSILES } from './config.js';
import { dist2 } from './utils.js';

// every alive platform with a working radar
function radars(world, side) {
   const out = [];
   for (const s of world.ships) if (s.alive && s.side === side && s.radarOn && s.cfg.radar && !(s.depth > 0)) out.push(s);
   for (const s of world.sites) if (s.alive && s.side === side && s.radarOn && s.cfg.radar) out.push(s);
   return out;
}
// Is `pos` covered by an active jammer of `side`?
export function jammed(world, side, pos) {
   for (const s of world.ships) {
      if (!s.alive || s.side !== side || !s.jamming) continue;
      if (dist2(s.pos, pos) < SENSOR.JAM_R * SENSOR.JAM_R) return true;
   }
   return false;
}

// Radar of observer O (ship or site) against surface target T at squared distance d2:
// 0 = nothing, 1 = detected, 2 = fire-control quality. Line of sight is checked last.
export function radarHolds(world, O, T, d2) {
   const rd = O.cfg.radar;
   if (!rd || !O.radarOn || O.depth > 0 || T.depth > 0) return 0;
   let r = rd.range * (T.cfg.stealth ?? 1);
   if (r * r < d2) return 0;
   if (jammed(world, T.side, T.pos)) { r *= SENSOR.JAM_RADAR; if (r * r < d2) return 0; }
   if (world.losBlocked(O.pos, T.pos)) return 0;
   return d2 < (r * SENSOR.FC) ** 2 ? 2 : 1;
}
// Land sites as observers of ship T (World._updateSpotting): 0 | 1 | 2 as radarHolds; a manned
// position also sees with its eyes (T.detectRange).
export function sitesSee(world, T) {
   let best = 0;
   if (T.depth > 0) return 0;
   for (const O of world.sites) {
      if (!O.alive || O.side === T.side) continue;
      const d2 = dist2(O.pos, T.pos);
      if (T.detectRange > 0 && d2 < T.detectRange * T.detectRange && !world.losBlocked(O.pos, T.pos)) return 2;
      const q = radarHolds(world, O, T, d2);
      if (q > best) best = q;
   }
   return best;
}

// Switch the radar of a ship or site. Returns the new state.
export function setRadar(world, s, on) {
   if (!s || !s.cfg.radar) return false;
   on = !!on;
   if (s.radarOn === on) return on;
   s.radarOn = on;
   if (world && (s.isPlayer || s.human)) world.pushEvent('radar', { srcId: s.id, on, text: on ? 'Radar eingeschaltet – Sie strahlen' : 'Radar aus – Funkstille (EMCON)' });
   return on;
}
export const emitting = (s) => !!(s.alive && (s.radarOn && s.cfg.radar || s.jamming) && !(s.depth > 0));

// ---------------------------------------------------------------- ESM
function esmPass(world, E, listeners) {
   let near = null, nd = Infinity, n = 0, b0 = 0, spread = 0;
   if (emitting(E)) {
      const R = (E.cfg.radar ? E.cfg.radar.range : 12000) * SENSOR.ESM, R2 = R * R;
      for (const Lr of listeners) {
         if (Lr.side === E.side) continue;
         const d2 = dist2(Lr.pos, E.pos);
         if (d2 > R2 || world.losBlocked(Lr.pos, E.pos)) continue;
         const b = Math.atan2(E.pos.y - Lr.pos.y, E.pos.x - Lr.pos.x);
         if (n++ === 0) b0 = b; else spread = Math.max(spread, Math.abs(Math.atan2(Math.sin(b - b0), Math.cos(b - b0))));
         if (d2 < nd) { nd = d2; near = Lr; }
      }
   }
   if (!near) {
      if (E.esmSeen && world.time - E.esmSeen.t > SENSOR.ESM_KEEP) E.esmSeen = null;
      return;
   }
   const d = Math.sqrt(nd);
   // one bearing: the range is a guess. Two listeners with a wide baseline: a cross fix.
   const err = d * (spread > 0.3 ? SENSOR.ESM_ERR * 0.3 : SENSOR.ESM_ERR);
   let N = E._esmN;
   if (!N || world.time - N.t > 5) N = E._esmN = { t: world.time, k: world.rng() * 2 - 1, c: world.rng() * 2 - 1 };
   const brg = Math.atan2(E.pos.y - near.pos.y, E.pos.x - near.pos.x);
   const ux = Math.cos(brg), uy = Math.sin(brg);
   E.esmSeen = {
      x: E.pos.x + ux * err * N.k - uy * err * 0.2 * N.c, y: E.pos.y + uy * err * N.k + ux * err * 0.2 * N.c,
      t: world.time, brg, by: near.id, err,
   };
}
export function updateEsm(world) {
   const listeners = [];
   for (const s of world.ships) if (s.alive && s.type !== 'TR' && s.depth !== 2) listeners.push(s);
   for (const s of world.sites) if (s.alive) listeners.push(s);
   for (const E of world.ships) { if (E.alive) esmPass(world, E, listeners); else E.esmSeen = null; }
   for (const E of world.sites) { if (E.alive) esmPass(world, E, listeners); else E.esmSeen = null; }
}

// ---------------------------------------------------------------- missiles
// Which missiles does the opposing side track? Sea-skimmers hide below the radar horizon and
// behind islands; high flyers are seen from far. Eyes see a missile at SENSOR.VISUAL_MISSILE.
// A SAM / AAM is always "detected" (nobody shoots at it).
export function updateMissileTracks(world) {
   const ms = world.missiles;
   if (!ms.length) return;
   const R = { player: radars(world, 'player'), enemy: radars(world, 'enemy') };
   const eyes = SENSOR.VISUAL_MISSILE * SENSOR.VISUAL_MISSILE;
   for (const m of ms) {
      if (!m.alive || m.kind === 'sam' || m.kind === 'aam') continue;
      const opp = m.side === 'player' ? 'enemy' : 'player';
      const cfg = MISSILES[m.type] || {}, high = m.alt >= 300, sig = Math.min(1, cfg.evade ?? 1) < 0.85 && !cfg.supersonic ? 0.8 : 1;
      let seen = false;
      for (const O of R[opp]) {
         const r = (high ? O.cfg.radar.air : O.cfg.radar.horizon) * sig;
         if (dist2(O.pos, m) > r * r) continue;
         if (!high && m.alt < 300 && world.losBlocked(O.pos, m)) continue;
         seen = true; break;
      }
      if (!seen) {
         for (const O of world.ships) if (O.alive && O.side === opp && O.depth !== 2 && dist2(O.pos, m) < eyes) { seen = true; break; }
         if (!seen) for (const O of world.sites) if (O.alive && O.side === opp && dist2(O.pos, m) < eyes) { seen = true; break; }
      }
      if (seen && !m.detected) m.detT = world.time;         // first detection (reaction time of the defence)
      m.detected = seen;
      // an active radar seeker gives itself away to every ESM in its beam
      if (m.seekerOn && !cfg.passive) {
         const hear = SENSOR.SEEKER_ESM * SENSOR.SEEKER_ESM;
         for (const O of world.ships) {
            if (!O.alive || O.side !== opp || O.depth === 2) continue;
            const dx = O.pos.x - m.x, dy = O.pos.y - m.y, d2 = dx * dx + dy * dy;
            if (d2 > hear) continue;
            const off = Math.atan2(dy, dx) - m.heading;
            if (Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) > 0.9) continue;
            if (!O.seekerWarn || world.time - O.seekerWarn.t > 1 || d2 < O.seekerWarn.d2) O.seekerWarn = { t: world.time, brg: Math.atan2(-dy, -dx), id: m.id, d2 };
         }
      }
   }
}

// Convenience for HUD / AI: what `side` knows about opposing ship or site T.
//    3 targetable, 2 detected, 1 ESM bearing, 0 nothing
export function contactLevel(world, side, T) {
   if (T.side === side) return 3;
   return T.targetable ? 3 : T.detected ? 2 : T.esmSeen ? 1 : 0;
}
