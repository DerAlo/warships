// game3d/submarine.js — everything that makes a hull of type SS a submarine, plus the
// anti-submarine side: depth states, battery, passive sonar, hydrophone bearings, depth charges
// and ramming. Pure sim (no rendering); World.update calls updateSubs once per step.
//
// Depth states (ship.depth, derived from the continuous ship.depthF 0..2):
//   0 SURFACE    fastest, deck gun usable, seen like a small destroyer, battery recharges
//   1 PERISCOPE  slower; only the periscope and its wake show (cfg.sub.periDetect, scaled by
//                speed; PERI_PROX instead of the 2 km proximity rule); torpedoes usable; a salvo
//                gives the boat away for SUB_BLOOM_T s (cfg.sub.torpBloom). Shells hit for
//                PERI_SHELL_MULT (only the tower is near the surface), torpedoes hit, ramming hurts.
//   2 DEEP       slowest; never visually spotted, blind itself (hydrophone bearings only);
//                immune to shells, torpedoes and hull contact; cannot fire; drains the battery fast.
// Depth charges hurt a boat at any depth. Radar never finds a submerged boat; the hydrophone
// consumable finds one at periscope depth and gives a sonar contact on a deep one.
import { WORLD } from './config.js';
import { DEG, clamp, clamp01, approach, dist2 } from './utils.js';

export const DEPTH = { SURFACE: 0, PERISCOPE: 1, DEEP: 2 };
export const DEPTH_NAMES = ['Aufgetaucht', 'Sehrohrtiefe', 'Getaucht'];
export const SUB_TUBE_ARC = 28 * DEG;     // bow / stern tubes: gyro angle either side of the keel line
export const SUB_BLOOM_T = 14;            // s a torpedo salvo from periscope depth gives the boat away
export const PERI_PROX = 900;             // m: a periscope is always seen this close
export const PERI_SHELL_MULT = 0.5;       // shell damage against a boat at periscope depth
export const DEEP_M = 24;                 // m the hull goes further down between periscope depth and deep
export const BATTERY_LOCK = 0.15;         // charge needed before an emptied boat may dive again
// passive sonar of surface ships against a submerged boat (m); a creeping boat is harder to hear
export const SONAR_RANGE = { DD: 3000, CL: 2400, CA: 1500, BB: 1200, CV: 1200, SS: 2000, TR: 0 };
export const SONAR_DT = 0.5;
export const SONAR_KEEP = 8;              // s a sonar contact stays on the plot
// depth-charge racks by hull type: charges per pattern, s between patterns
export const ASW = { DD: { charges: 6, reload: 24 }, CL: { charges: 4, reload: 32 } };
export const DC = { sink: 2.6, gap: 0.28, full: 45, reach: 135, dmg: 1500, max: 64, throwY: 34 };

// hull sinkage (m) at periscope depth: the tower top ends ~1.5 m under the surface
export function periDepthM(cfg) { const h = cfg.hull; return h.deckH + (h.sup ? h.sup.h : 5) + 1.5; }
export function isSub(s) { return !!(s && s.sub); }
export function submerged(s) { return !!(s && s.depth > 0); }

// Fields every ship carries (cheap, so nothing else has to test for undefined).
export function initSubState(ship) {
   const cfg = ship.cfg;
   ship.sub = cfg.sub || null;
   ship.depth = 0;               // 0 surface / 1 periscope depth / 2 deep
   ship.depthTarget = 0;
   ship.depthF = 0;              // continuous 0..2
   ship.depthM = 0;              // metres the hull sits below its surfaced trim (renderer)
   ship.battery = 1;
   ship.batteryLock = false;
   ship.sonarSeen = null;        // enemy sonar contact on this boat { x, y, t, by }
   ship.pingT = -999;            // last time an enemy sonar held this boat
   ship.lastTorpFire = -999;
   ship.ramT = -999;
   const a = ASW[cfg.hull.type];
   ship.asw = a ? { reload: 0, reloadMax: a.reload, charges: a.charges, left: 0, t: 0, n: 0 } : null;
}

// Order a new depth (0..2). Returns true when the order was accepted.
export function orderDepth(ship, target, world = ship.world) {
   if (!ship.sub || !ship.alive) return false;
   target = clamp(Math.round(target), 0, 2);
   if (target === ship.depthTarget) return false;
   if (target > ship.depthTarget && (ship.batteryLock || ship.battery <= 0)) {
      if (ship.isPlayer && world) world.pushEvent('subInfo', { srcId: ship.id, text: 'Batterie zu schwach zum Tauchen', level: 'warn' });
      return false;
   }
   const from = ship.depthTarget;
   ship.depthTarget = target;
   if (world) world.pushEvent('depth', { srcId: ship.id, depth: target, from, text: DEPTH_NAMES[target] });
   return true;
}
export function diveDeeper(ship, world) { return orderDepth(ship, ship.depthTarget + 1, world); }
export function diveUp(ship, world) { return orderDepth(ship, ship.depthTarget - 1, world); }

// Speed factor of a boat at its current depth (1 for every other ship).
export function subSpeedFactor(ship) {
   const sb = ship.sub, f = ship.depthF;
   if (!sb || f <= 0) return 1;
   return f <= 1 ? 1 + (sb.periSpeed - 1) * f : sb.periSpeed + (sb.deepSpeed - sb.periSpeed) * (f - 1);
}

// Visual detectability of a submerged boat (ship.js calls this only when depthF >= 0.5).
export function subDetectRange(ship, world, vis) {
   if (ship.depth === 2) return 0;
   const sb = ship.sub;
   if (world.time - ship.lastTorpFire < SUB_BLOOM_T) return sb.torpBloom;
   const vmax = ship.maxSpeedKn * WORLD.KN_TO_MS * sb.periSpeed;
   return sb.periDetect * (0.6 + 0.4 * clamp01(Math.abs(ship.speed) / (vmax || 1))) * vis;
}

// ---------------------------------------------------------------- per-step update
export function updateSubs(world, dt) {
   const ships = world.ships;
   let any = false;
   for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      if (!s.alive) continue;
      if (s.sub) { stepSub(s, world, dt); any = true; }
      const a = s.asw;
      if (a) {
         if (a.reload > 0) a.reload = Math.max(0, a.reload - dt);
         if (a.left > 0) {
            a.t -= dt;
            if (a.t <= 0) { a.t += DC.gap; a.left--; spawnCharge(world, s, a.n++); }
         }
      }
   }
   stepCharges(world, dt);
   world.hasSubs = any;
   if (!any) return;
   world._sonarT = (world._sonarT || 0) - dt;
   if (world._sonarT <= 0) { world._sonarT = SONAR_DT; updateSonar(world); }
}

function stepSub(s, world, dt) {
   const sb = s.sub, bat = sb.battery;
   if (s.depthF > 0.5) {
      const k = clamp01(s.depthF - 1);                     // 0 at periscope depth .. 1 deep
      s.battery = Math.max(0, s.battery - dt * ((1 - k) / bat.peri + k / bat.deep));
      if (s.battery <= 0 && !s.batteryLock) {
         s.batteryLock = true;
         if (s.depthTarget > 0) {
            const from = s.depthTarget;
            s.depthTarget = 0;
            world.pushEvent('depth', { srcId: s.id, depth: 0, from, forced: true, text: 'Batterie leer – Boot taucht auf' });
         }
      }
   } else if (s.depthF < 0.05) {
      s.battery = Math.min(1, s.battery + dt / bat.charge);
      if (s.batteryLock && s.battery >= BATTERY_LOCK) s.batteryLock = false;
   }
   if (s.depth > 0 && s.fires.length) s.fires.length = 0;      // the sea puts deck fires out
   if (s.depthF !== s.depthTarget) s.depthF = approach(s.depthF, s.depthTarget, dt / sb.diveT);
   const f = s.depthF;
   s.depth = f < 0.5 ? 0 : f < 1.5 ? 1 : 2;
   const pm = periDepthM(s.cfg);
   s.depthM = f <= 1 ? f * pm : pm + (f - 1) * DEEP_M;
}

// Passive sonar: enemy surface ships (and boats) hold a submerged boat at short range. The contact
// is a noisy position for the hunters; the boat itself knows it is being held (pingT).
function updateSonar(world) {
   const ships = world.ships, now = world.time;
   for (let i = 0; i < ships.length; i++) {
      const T = ships[i];
      if (!T.alive || !T.sub) continue;
      if (T.depth === 0) { if (T.sonarSeen && now - T.sonarSeen.t > SONAR_KEEP) T.sonarSeen = null; continue; }
      const vmax = T.maxSpeedKn * WORLD.KN_TO_MS * T.sub.deepSpeed;
      // a creeping boat is quiet, a deep one harder to hold: silent running breaks a contact
      const loud = (0.5 + 0.5 * clamp01(Math.abs(T.speed) / (vmax || 1))) * (T.depth === 2 ? 0.85 : 1);
      let by = null, bd = Infinity;
      for (let j = 0; j < ships.length; j++) {
         const O = ships[j];
         if (!O.alive || O.side === T.side) continue;
         let r = (SONAR_RANGE[O.type] ?? 1200) * loud;
         if (O.consumableActive('hydro')) r = Math.max(r, O.consumable('hydro').range || 0);
         const d2 = dist2(O.pos, T.pos);
         if (d2 < r * r && d2 < bd) { bd = d2; by = O; }
      }
      if (!by) { if (T.sonarSeen && now - T.sonarSeen.t > SONAR_KEEP) T.sonarSeen = null; continue; }
      const noise = T.depth === 2 ? 70 : 30;
      const c = T.sonarSeen || (T.sonarSeen = { x: 0, y: 0, t: 0, by: 0, evT: -99 });
      c.x = T.pos.x + (world.rng() * 2 - 1) * noise; c.y = T.pos.y + (world.rng() * 2 - 1) * noise;
      c.t = now; c.by = by.id;
      T.pingT = now;
      if (now - c.evT > 4) {
         c.evT = now;
         world.pushEvent('sonar', { srcId: by.id, dstId: T.id, pos: { x: c.x, y: c.y }, dist: Math.sqrt(bd), text: 'Sonarkontakt' });
      }
   }
}

// Bearings a deep boat hears on its hydrophone: fills `out` with { id, brg, type } of every
// enemy ship under way inside cfg.sub.hydrophone. Returns the count (out is reused by callers).
export function hydrophoneContacts(world, sub, out) {
   let n = 0;
   const r = sub.sub ? sub.sub.hydrophone : 0;
   if (r > 0) for (const e of world.ships) {
      if (!e.alive || e.side === sub.side || Math.abs(e.speed) < 2) continue;
      const d2 = dist2(e.pos, sub.pos);
      if (d2 > r * r) continue;
      const o = out[n] || (out[n] = { id: 0, brg: 0, type: '', near: 0 });
      o.id = e.id; o.type = e.type; o.brg = Math.atan2(e.pos.y - sub.pos.y, e.pos.x - sub.pos.x);
      o.near = 1 - Math.sqrt(d2) / r;
      n++;
   }
   out.length = n;
   return n;
}

// ---------------------------------------------------------------- depth charges
// Start a pattern from the stern racks and throwers. Returns true when the pattern was started.
export function dropDepthCharges(ship, world = ship.world) {
   const a = ship.asw;
   if (!a || !ship.alive || a.reload > 0 || a.left > 0) return false;
   a.left = a.charges; a.t = 0; a.n = 0; a.reload = a.reloadMax;
   world.pushEvent('dcDrop', { srcId: ship.id, pos: { x: ship.pos.x, y: ship.pos.y }, text: 'Wasserbomben' });
   return true;
}

function spawnCharge(world, ship, n) {
   const list = world.depthCharges;
   let c = null;
   for (let i = 0; i < list.length; i++) if (!list[i].alive) { c = list[i]; break; }
   if (!c) {
      if (list.length >= DC.max) return;
      c = { alive: false, pos: { x: 0, y: 0 }, t: 0, life: DC.sink, side: '', ownerId: 0, dmgMult: 1 };
      list.push(c);
   }
   // racks roll charges over the stern, the throwers lob every second and third one to the sides
   const lat = n % 3 === 0 ? 0 : (n % 3 === 1 ? 1 : -1) * DC.throwY;
   const lx = -ship.cfg.hull.L * 0.48;
   const ch = Math.cos(ship.heading), sh = Math.sin(ship.heading);
   c.pos.x = ship.pos.x + ch * lx - sh * lat; c.pos.y = ship.pos.y + sh * lx + ch * lat;
   c.alive = true; c.t = 0; c.life = DC.sink + world.rng() * 0.5;
   c.side = ship.side; c.ownerId = ship.id; c.dmgMult = ship.dmgMult || 1;
   world.addEffect('splash', c.pos, 0.9, 5, { dc: true });
}

function stepCharges(world, dt) {
   const list = world.depthCharges;
   for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.alive) continue;
      c.t += dt;
      if (c.t < c.life) continue;
      c.alive = false;
      explodeCharge(world, c);
   }
}

function explodeCharge(world, c) {
   const shooter = world.shipById(c.ownerId);
   world.addEffect('depthCharge', c.pos, 2.2, 34, { big: true });
   world.pushEvent('depthCharge', { srcId: c.ownerId, pos: { x: c.pos.x, y: c.pos.y } });
   for (const s of world.ships) {
      if (!s.alive || !s.sub || s.side === c.side) continue;
      // distance to the hull (keel segment), not to its centre
      const dx = c.pos.x - s.pos.x, dy = c.pos.y - s.pos.y;
      const ch = Math.cos(s.heading), sh = Math.sin(s.heading);
      const lx = Math.max(0, Math.abs(dx * ch + dy * sh) - s.cfg.hull.L / 2), ly = -dx * sh + dy * ch;
      const d = Math.hypot(lx, ly);
      if (d >= DC.reach) continue;
      // a surfaced boat is only shaken: the charge goes off well below its keel
      const dmg = DC.dmg * c.dmgMult * clamp01((DC.reach - d) / (DC.reach - DC.full)) * (s.depth === 0 ? 0.5 : 1);
      world.pushEvent('dc', { srcId: c.ownerId, dstId: s.id, dmg: Math.round(dmg), pos: { x: s.pos.x, y: s.pos.y }, text: 'Wasserbombentreffer' });
      if (s === world.player) world.shakeAdd(0.6 + 1.2 * clamp01(1 - d / DC.reach));
      if (shooter && shooter.isPlayer) world.stats.dcHits = (world.stats.dcHits || 0) + 1;
      s.takeDamage(dmg, shooter, 'dc', 0.5);
      if (s.alive && d < DC.full && world.rng() < 0.2) s.flood(world.rng() < 0.5 ? 0 : 1, shooter);
   }
}

// ---------------------------------------------------------------- ramming
// Called by World._collideShips for two hulls in reach of each other when one is under water
// (such pairs are never pushed apart: the surface ship passes over the boat). A surface ship
// running over an enemy boat at periscope depth crushes its tower; the rammer only scrapes its
// bottom. A deep boat is passed over unharmed.
const RAM_PTS = [0.46, 0.23, 0, -0.23, -0.46];
export function hullContact(world, a, b) {
   if (a.depth === 2 || b.depth === 2 || a.side === b.side) return;
   const sub = a.depth === 1 ? a : b;
   const other = sub === a ? b : a;
   if (other.depth !== 0 || world.time - sub.ramT < 2.5) return;
   // any point of the rammer's keel over the boat?
   const L = other.cfg.hull.L, ch = Math.cos(other.heading), sh = Math.sin(other.heading);
   const sc = Math.cos(sub.heading), ss = Math.sin(sub.heading);
   const hl = sub.cfg.hull.L / 2, hw = (sub.cfg.hull.beam + other.cfg.hull.beam) / 2;
   let over = false;
   for (let i = 0; i < RAM_PTS.length && !over; i++) {
      const dx = other.pos.x + ch * L * RAM_PTS[i] - sub.pos.x, dy = other.pos.y + sh * L * RAM_PTS[i] - sub.pos.y;
      over = Math.abs(dx * sc + dy * ss) < hl && Math.abs(-dx * ss + dy * sc) < hw;
   }
   if (!over) return;
   sub.ramT = world.time;
   const k = clamp01(Math.abs(other.speed) / (other.maxSpeed || 1));
   const dmg = sub.maxHP * (0.2 + 0.25 * k);
   world.pushEvent('ram', { srcId: other.id, dstId: sub.id, dmg: Math.round(dmg), pos: { x: sub.pos.x, y: sub.pos.y }, text: 'Gerammt!' });
   world.addEffect('splash', sub.pos, 1.4, 16, { big: true });
   if (sub === world.player || other === world.player) world.shakeAdd(1.2);
   sub.takeDamage(dmg, other, 'ram', 0.3);
   other.takeDamage(Math.min(800, other.maxHP * 0.02), sub, 'ram', 0.5);
}
