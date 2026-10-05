// gamev2/helo.js — shipboard helicopters and lightweight anti-submarine torpedoes of the modern mode.
// Plain data in world.helos[]; World.update calls updateHelos.
//
// Helo: { id, side, ownerId, isHelo, kind 'helo', type 'helo', model 'helo', nation, name, n (1 | 0), n0, hp,
//         pos {x, y}, alt, heading, want, speed, prev {x, y, alt, h}, state 'transit' | 'dip' | 'return',
//         mode 'screen' | 'point', goal {x, y}, fuel (s), fuelMax, torps, armed (= torps), dipT, dips,
//         alive, visible (to the player side), visE, eng (SAMs on it) }
// A helo carries the fields air3d.js reads from a squadron (n, visible, pos, alt, heading, speed, id,
// kind, model, armed), so the renderer can draw world.helos with the code it has for squadrons.
//    launch   sendHelo(world, ship, pos | null)   null: screen ahead of the ship (dip, move on, dip)
//             a ship has cfg.helo and the consumable 'helo' (one charge per sortie, cooldown = turn-around)
//    recall   recallHelo(world, ship)
//    sonar    while it hovers ('dip') it holds every submerged enemy boat inside HELO.dipRange (a slow
//             boat is held at 60 % of that): ship.sonarSeen as the passive sonar of the ships does
//    attack   drops one of HELO.torps lightweight torpedoes on a contact inside HELO.torpRange
//    fuel     HELO.fuel seconds; it turns home in time by itself; without a deck it ditches
//    SAMs     missile.js engages it like a squadron (tk 'squad'): one hit brings it down
// Lightweight torpedoes (cfg.weapons.asw of a surface ship: n, reload, range, speedKn, dmg):
//    fireAswTorpedo(world, ship) needs a sonar or periscope contact inside range; the weapon homes on
//    the boat (seeker HELO.seek, a creeping boat is acquired later), hits boats at any depth and
//    nothing else. Entries of world.torpedoes with asw: true, homeId, tx / ty.
// Events: heloLaunch { srcId, heloId, pos }, heloOrder { srcId, heloId, pos, mode }, heloDip { srcId, heloId, pos },
//    heloLanded { srcId, heloId }, heloLost { srcId (killer), dstId (ship), heloId, reason 'sam' | 'fuel' | 'blast', pos },
//    aswTorp { srcId, dstId, heloId | null, pos }, sonar { srcId, dstId, pos, helo: true }.
import { WORLD, DIFFICULTY } from './config.js';
import { clamp, angleDelta } from './utils.js';
import { SONAR_KEEP } from './submarine.js';

export const HELO = {
   speed: 78, alt: 110, dipAlt: 22, climb: 30, turnRate: 0.9,
   fuel: 300, reserve: 1.2, turnaround: 45,
   dipT: 12, dipRange: 4200, quiet: 0.6, screen: 5500, screenArc: 0.6,
   torps: 2, torpRange: 2800, torpGap: 8,
   seek: 1700, torpTurn: 0.7, torpArm: 60, torpFlood: 0.5, torpRun: 3800, torpKn: 44, torpDmg: 3200,
   seenAt: 9000,
};

const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function heloById(world, id) {
   for (const h of world.helos) if (h.id === id) return h;
   return null;
}
export function heloOf(world, ship) { return ship && ship.heloOut != null ? heloById(world, ship.heloOut) : null; }

// null when the ship may launch its helicopter now, else the reason (German, for the HUD).
export function heloBlock(world, ship) {
   if (!ship || !ship.alive || !ship.cfg.helo) return 'Kein Hubschrauber';
   if (ship.depth > 0) return 'Getaucht';
   if (ship.heloOut != null) return 'Hubschrauber ist in der Luft';
   if ((ship.heloT || 0) > world.time) return 'Hubschrauber wird klargemacht';
   return null;
}

// Called by Ship.useConsumable('helo') (the charge is already taken) and by sendHelo.
export function launchHelo(world, ship) {
   if (heloBlock(world, ship)) return null;
   const c = Math.cos(ship.heading), s = Math.sin(ship.heading), L = ship.cfg.hull.L;
   const h = {
      id: world._nextId++, side: ship.side, ownerId: ship.id, isHelo: true, kind: 'helo', type: 'helo', model: 'helo',
      nation: ship.cfg.hull.nation, name: ship.cfg.helo.name || 'Bordhubschrauber', n: 1, n0: 1, hp: 1,
      pos: { x: ship.pos.x - c * L * 0.4, y: ship.pos.y - s * L * 0.4 }, alt: ship.cfg.hull.deckH || 6,
      prev: { x: 0, y: 0, alt: 0, h: ship.heading },
      heading: ship.heading, want: ship.heading, speed: 0, state: 'transit', mode: 'screen', goal: { x: 0, y: 0 },
      fuel: HELO.fuel, fuelMax: HELO.fuel, torps: HELO.torps, armed: HELO.torps, dipT: 0, dips: 0, torpT: 0, sonarT: 0,
      alive: true, visible: ship.side === 'player', visE: ship.side === 'enemy', eng: 0,
   };
   h.prev.x = h.pos.x; h.prev.y = h.pos.y; h.prev.alt = h.alt;
   screenPoint(world, h, ship);
   world.helos.push(h);
   ship.heloOut = h.id;
   world.pushEvent('heloLaunch', { srcId: ship.id, heloId: h.id, pos: { x: h.pos.x, y: h.pos.y }, text: h.name + ' gestartet' });
   return h;
}

// Send the helicopter to a point (launches it when it is on deck); pos null: screen ahead.
// Returns the helo or null.
export function sendHelo(world, ship, pos = null) {
   let h = heloOf(world, ship);
   if (!h) {
      if (heloBlock(world, ship)) return null;
      // the consumable is the count of sorties; a ship without it (land sites, scripts) launches freely
      if (ship.consumable && ship.consumable('helo')) { if (!ship.useConsumable(world, 'helo')) return null; h = heloOf(world, ship); }
      else h = launchHelo(world, ship);
      if (!h) return null;
   }
   if (h.state === 'return' && h.fuel < homeTime(h, ship) + 20) return null;      // no fuel left for another task
   if (pos) {
      const A = world.arena * 1.1;
      h.mode = 'point'; h.goal.x = clamp(pos.x, -A, A); h.goal.y = clamp(pos.y, -A, A);
   } else { h.mode = 'screen'; screenPoint(world, h, ship); }
   h.state = 'transit';
   world.pushEvent('heloOrder', { srcId: ship.id, heloId: h.id, mode: h.mode, pos: { x: h.goal.x, y: h.goal.y } });
   return h;
}
export function recallHelo(world, ship) {
   const h = heloOf(world, ship);
   if (!h || h.state === 'return') return false;
   h.state = 'return';
   world.pushEvent('heloOrder', { srcId: ship.id, heloId: h.id, mode: 'return', pos: { x: ship.pos.x, y: ship.pos.y } });
   return true;
}

// HUD: { state 'deck' | 'ready' | 'transit' | 'dip' | 'return' | 'none', fuel 0..1, torps, sorties, readyIn, helo }
export function heloStatus(world, ship) {
   if (!ship || !ship.cfg.helo) return { state: 'none', fuel: 0, torps: 0, sorties: 0, readyIn: 0, helo: null };
   const h = heloOf(world, ship), c = ship.consumable ? ship.consumable('helo') : null;
   const readyIn = Math.max(0, (ship.heloT || 0) - world.time, c ? c.cd || 0 : 0);
   if (h) return { state: h.state, fuel: h.fuel / h.fuelMax, torps: h.torps, sorties: c ? c.charges : 1, readyIn: 0, helo: h };
   return { state: readyIn > 0 ? 'deck' : 'ready', fuel: 1, torps: HELO.torps, sorties: c ? c.charges : 1, readyIn, helo: null };
}

function screenPoint(world, h, ship) {
   // alternate either side of the bow
   const a = ship.heading + (h.dips % 3 - 1) * HELO.screenArc, A = world.arena * 1.05;
   h.goal.x = clamp(ship.pos.x + Math.cos(a) * HELO.screen, -A, A);
   h.goal.y = clamp(ship.pos.y + Math.sin(a) * HELO.screen, -A, A);
}
const homeTime = (h, ship) => hyp(h.pos, ship.pos) / HELO.speed * HELO.reserve + 8;

export function killHelo(world, h, by, reason = 'sam') {
   if (!h || !h.alive) return false;
   h.alive = false; h.n = 0;
   const ship = world.shipById(h.ownerId);
   if (ship && ship.heloOut === h.id) { ship.heloOut = null; ship.heloT = world.time + HELO.turnaround; }
   if (reason !== 'landed') {
      world.addEffect('planeDown', h.pos, 2.5, 14, { alt: h.alt, heading: h.heading, speed: h.speed, kind: 'helo' });
      world.pushEvent('heloLost', { srcId: by ? by.id : null, dstId: h.ownerId, heloId: h.id, reason, pos: { x: h.pos.x, y: h.pos.y }, alt: h.alt,
         text: h.name + (reason === 'fuel' ? ' notgewassert' : ' abgeschossen') });
      if (by && by.stats && reason === 'sam') by.stats.planesDown = (by.stats.planesDown || 0) + 1;
   }
   return true;
}

// ---------------------------------------------------------------- lightweight torpedoes
// Where `side` believes the boat is: its position while it is seen, the sonar contact while fresh.
function subContact(world, side, T) {
   if (!T.alive || !T.sub || T.side === side) return null;
   if (T.depth < 2 && T.detected) return T.pos;
   const c = T.sonarSeen;
   return c && world.time - c.t <= SONAR_KEEP ? c : null;
}
function nearestContact(world, side, from, range) {
   let best = null, bd = range;
   for (const T of world.ships) {
      if (!T.sub) continue;
      const c = subContact(world, side, T);
      if (!c) continue;
      const d = hyp(c, from);
      if (d < bd) { bd = d; best = T; }
   }
   return best;
}
function spawnAswTorpedo(world, from, T, side, ownerId, o) {
   const c = subContact(world, side, T) || T.pos, h = Math.atan2(c.y - from.y, c.x - from.x);
   const speed = o.speedKn * WORLD.KN_TO_MS;
   const t = {
      id: world._nextId++, pos: { x: from.x, y: from.y }, start: { x: from.x, y: from.y }, heading: h, dir: h, speed, speedKn: o.speedKn,
      side, owner: side, ownerId, dmg: o.dmg, flood: HELO.torpFlood, range: o.range, detect: 900,
      traveled: 0, age: 0, alive: true, spotted: side === 'player', arm: HELO.torpArm,
      asw: true, homeId: T.id, tx: c.x, ty: c.y,
   };
   world.addTorpedo(t);
   return t;
}
// combat.js calls this for a torpedo with homeId before it moves.
export function steerAswTorpedo(world, t, dt) {
   const T = world.shipById(t.homeId);
   if (T && T.alive && T.sub) {
      const vmax = (T.maxSpeed || 1) * (T.sub.deepSpeed || 1);
      const loud = 0.45 + 0.55 * clamp(Math.abs(T.speed) / vmax, 0, 1);
      const d = hyp(T.pos, t.pos);
      if (d < HELO.seek * loud * (T.depth === 0 ? 1.2 : 1)) { t.tx = T.pos.x; t.ty = T.pos.y; t.locked = true; }
      else t.locked = false;
   }
   const want = Math.atan2(t.ty - t.pos.y, t.tx - t.pos.x), da = angleDelta(t.heading, want), m = HELO.torpTurn * dt;
   t.heading += clamp(da, -m, m); t.dir = t.heading;
}

// null when the ship may fire a lightweight torpedo now, else the reason.
export function aswBlock(world, ship) {
   const a = ship && ship.alive && ship.cfg.weapons && ship.cfg.weapons.asw;
   if (!a || ship.sub) return 'Keine U-Jagd-Torpedos';
   const st = ship.ltt || (ship.ltt = { n: a.n, readyT: 0 });
   if (st.n <= 0) return 'U-Jagd-Torpedos verschossen';
   if (st.readyT > world.time) return 'Rohr wird geladen';
   if (!nearestContact(world, ship.side, ship.pos, a.range)) return 'Kein Sonarkontakt in Reichweite';
   return null;
}
// HUD: { n, max, reload (s left), contact (ship id | null) }
export function aswStatus(world, ship) {
   const a = ship && ship.cfg.weapons && ship.cfg.weapons.asw;
   if (!a || ship.sub) return null;
   const st = ship.ltt || (ship.ltt = { n: a.n, readyT: 0 });
   const T = nearestContact(world, ship.side, ship.pos, a.range);
   return { n: st.n, max: a.n, reload: Math.max(0, st.readyT - world.time), contact: T ? T.id : null };
}
export function fireAswTorpedo(world, ship) {
   if (aswBlock(world, ship)) return false;
   const a = ship.cfg.weapons.asw, T = nearestContact(world, ship.side, ship.pos, a.range);
   const t = spawnAswTorpedo(world, ship.pos, T, ship.side, ship.id, { speedKn: a.speedKn, dmg: a.dmg * (ship.dmgMult || 1), range: a.range * 1.3 });
   ship.ltt.n--; ship.ltt.readyT = world.time + a.reload;
   world.addEffect('torpLaunch', ship.pos, 0.6, 8, { shipId: ship.id, bearing: t.heading });
   world.pushEvent('aswTorp', { srcId: ship.id, dstId: T.id, heloId: null, pos: { x: ship.pos.x, y: ship.pos.y }, text: 'U-Jagd-Torpedo im Wasser' });
   return true;
}

// ---------------------------------------------------------------- per step
function dipSonar(world, h, ship) {
   const now = world.time;
   let near = null, nd = HELO.torpRange;
   for (const T of world.ships) {
      if (!T.alive || !T.sub || T.side === h.side || T.depth === 0) continue;
      const vmax = (T.maxSpeed || 1) * (T.sub.deepSpeed || 1);
      const loud = HELO.quiet + (1 - HELO.quiet) * clamp(Math.abs(T.speed) / vmax, 0, 1);
      const d = hyp(T.pos, h.pos);
      if (d > HELO.dipRange * loud) continue;
      const noise = T.depth === 2 ? 70 : 30;
      const c = T.sonarSeen || (T.sonarSeen = { x: 0, y: 0, t: 0, by: 0, evT: -99 });
      c.x = T.pos.x + (world.rng() * 2 - 1) * noise; c.y = T.pos.y + (world.rng() * 2 - 1) * noise;
      c.t = now; c.by = h.ownerId;
      T.pingT = now;
      if (now - c.evT > 4) {
         c.evT = now;
         world.pushEvent('sonar', { srcId: h.ownerId, dstId: T.id, heloId: h.id, helo: true, pos: { x: c.x, y: c.y }, dist: d, text: 'Sonarkontakt (Hubschrauber)' });
      }
      if (d < nd) { nd = d; near = T; }
   }
   if (near && h.torps > 0 && now >= h.torpT) {
      const mult = ship ? ship.dmgMult || 1 : 1;
      spawnAswTorpedo(world, h.pos, near, h.side, h.ownerId, { speedKn: HELO.torpKn, dmg: HELO.torpDmg * mult, range: HELO.torpRun });
      h.torps--; h.armed = h.torps; h.torpT = now + HELO.torpGap;
      world.addEffect('splash', h.pos, 1, 10);
      world.pushEvent('aswTorp', { srcId: h.ownerId, dstId: near.id, heloId: h.id, pos: { x: h.pos.x, y: h.pos.y }, text: 'Hubschrauber wirft Torpedo' });
   }
}

function fly(h, to, dt, hover) {
   const d = hyp(to, h.pos);
   h.want = d > 5 ? Math.atan2(to.y - h.pos.y, to.x - h.pos.x) : h.heading;
   const da = angleDelta(h.heading, h.want), m = HELO.turnRate * dt;
   h.heading += clamp(da, -m, m);
   const vWant = hover ? 0 : Math.min(HELO.speed, Math.max(12, d * 0.5)) * (Math.abs(da) > 1.2 ? 0.4 : 1);
   h.speed += clamp(vWant - h.speed, -28 * dt, 22 * dt);
   const step = Math.min(h.speed * dt, d);
   h.pos.x += Math.cos(h.heading) * step; h.pos.y += Math.sin(h.heading) * step;
   const altT = hover ? HELO.dipAlt : HELO.alt;
   h.alt += clamp(altT - h.alt, -HELO.climb * dt, HELO.climb * dt);
   return d;
}

export function updateHelos(world, dt) {
   world._heloAiT = (world._heloAiT || 0) - dt;
   if (world._heloAiT <= 0) { world._heloAiT = 1; botAsw(world); }
   const hs = world.helos;
   if (!hs.length) return;
   for (const h of hs) {
      if (!h.alive) continue;
      const ship = world.shipById(h.ownerId), home = ship && ship.alive && !(ship.depth > 0);
      h.prev.x = h.pos.x; h.prev.y = h.pos.y; h.prev.alt = h.alt; h.prev.h = h.heading;
      h.fuel -= dt;
      if (h.fuel <= 0) { killHelo(world, h, null, 'fuel'); continue; }
      if (home && h.state !== 'return' && h.fuel < homeTime(h, ship)) {
         h.state = 'return';
         world.pushEvent('heloOrder', { srcId: ship.id, heloId: h.id, mode: 'return', bingo: true, pos: { x: ship.pos.x, y: ship.pos.y }, text: h.name + ' kehrt zurück (Treibstoff)' });
      }
      if (h.state === 'return') {
         if (!home) { fly(h, h.pos, dt, true); }                 // no deck: it hovers until the fuel is gone
         else if (fly(h, ship.pos, dt, false) < 90) {
            h.alive = false; h.n = 0;
            ship.heloOut = null; ship.heloT = world.time + HELO.turnaround;
            world.pushEvent('heloLanded', { srcId: ship.id, heloId: h.id, text: h.name + ' gelandet' });
            continue;
         }
      } else if (h.state === 'transit') {
         if (fly(h, h.goal, dt, false) < 40) {
            h.state = 'dip'; h.dipT = HELO.dipT; h.dips++;
            world.pushEvent('heloDip', { srcId: h.ownerId, heloId: h.id, pos: { x: h.pos.x, y: h.pos.y }, text: 'Tauchsonar im Wasser' });
         }
      } else {   // dip
         fly(h, h.goal, dt, true);
         h.sonarT -= dt;
         if (h.alt < HELO.dipAlt + 15 && h.sonarT <= 0) { h.sonarT = 0.5; dipSonar(world, h, ship); }
         h.dipT -= dt;
         if (h.dipT <= 0) {
            if (h.mode === 'screen' && home) { screenPoint(world, h, ship); h.state = 'transit'; }
            else h.dipT = HELO.dipT;                                // holds its station
         }
      }
      // seen by the other side: inside visual / radar reach of one of its ships
      h.seenT = (h.seenT || 0) - dt;
      if (h.seenT <= 0) {
         h.seenT = 1;
         let seen = false;
         for (const O of world.ships) {
            if (!O.alive || O.side === h.side || O.depth > 0) continue;
            if (hyp(O.pos, h.pos) < (O.radarOn && O.cfg.radar ? O.cfg.radar.air || HELO.seenAt : HELO.seenAt * 0.6)) { seen = true; break; }
         }
         if (h.side === 'enemy') h.visible = seen; else h.visE = seen;
      }
   }
   if (hs.some(h => !h.alive)) world.helos = hs.filter(h => h.alive);
}

// Bot captains (and the autopilot): lightweight torpedoes on any contact in reach, the helicopter on
// a boat the team knows of. Easy captains only send it at a boat that is already close.
function botAsw(world) {
   if (!world.hasSubs) return;
   for (const b of world.ships) {
      if (!b.alive || b.human || b.sub || (b.isPlayer && !world.autoPlayer) || (b.ai && b.ai.passive)) continue;
      if (b.cfg.weapons.asw) fireAswTorpedo(world, b);
      if (!b.cfg.helo) continue;
      const smarts = (b.isPlayer ? DIFFICULTY.normal : world.difficulty).smarts ?? 1;
      const T = nearestContact(world, b.side, b.pos, smarts < 0.8 ? 5000 : 13000);
      if (!T) continue;
      const h = heloOf(world, b), c = subContact(world, b.side, T);
      if (h) { if (h.state !== 'return' && hyp(h.goal, c) > 900) sendHelo(world, b, c); }
      else if (!heloBlock(world, b)) sendHelo(world, b, c);
   }
}
