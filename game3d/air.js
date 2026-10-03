// game3d/air.js — carriers, squadrons and anti-aircraft fire. Pure sim (no rendering); World.update
// calls updateAir once per step, right after the submarines.
//
// Carrier (ship.air, any ship with cfg.air): three hangars (tb torpedo bombers, db dive bombers,
// ft fighters). launchSquadron() takes up to cfg.air[type].squad planes off the deck as one
// squadron; the deck is busy while they take off. Landed planes are serviced (cfg.air.service s)
// before they are ready again; lost planes are replaced one by one (cfg.air[type].restock s each)
// up to the hangar size.
//
// Squadron (world.squadrons) life cycle:
//    launch  taking off (deck busy), climbs to cruise altitude
//    fly     heading for its order (strike: target ship; patrol: a point) or steered by the player
//    attack  bombers: attack run (aiming); fighters: dogfight
//    patrol  fighters circling a point for AIR.patrolT s
//    return  flying home; within AIR.landR of the carrier the planes land and go into service
// One attack run drops `flight` planes' weapons; that flight splits off and returns at once, the
// rest of the squadron (still armed) stays for another run. A squadron also turns home when its
// fuel runs out. If the carrier is lost the planes ditch.
//
// Anti-aircraft (config.aaProfile): every surface ship fires at enemy planes inside its bands;
// the damage goes to the squadron's lead plane, so planes fall one at a time. AA focus (ship.aaFocus
// -1 port / +1 starboard) strengthens one side and weakens the other.
//
// Spotting: squadrons spot surface ships for their team (airSpots, called by World._updateSpotting).
// Squadrons themselves are visible to the other team near its ships and planes (sq.visible is
// the player team's view).
//
// Not networked yet: the snapshot codec carries no squadrons, so updateAir is a no-op in a net game.
import { aaProfile } from './config.js';
import { DEG, clamp, clamp01, angleDelta, dist2, toLocal, insideHull, gaussR } from './utils.js';
import { resolveHit } from './combat.js';
import { squadThink } from './ai_air.js';

export const AIR_TYPES = ['tb', 'db', 'ft'];
export const AIR_NAMES = { tb: 'Torpedobomber', db: 'Sturzkampfbomber', ft: 'Jäger' };
export const AIR_SHORT = { tb: 'TB', db: 'SB', ft: 'J' };
export const AIR = {
   cruiseAlt: 420,          // m
   tbAlt: 45,               // torpedo run height
   dbAlt: 1100,             // dive bombers approach high and dive on release
   climb: 70,               // m/s altitude change
   launchBase: 2.5,         // s deck time per squadron + per plane
   launchPer: 0.45,
   landR: 380,              // m from the carrier: planes land
   turn: { tb: 0.62, db: 0.68, ft: 0.95 },  // rad/s
   aimTurn: 0.38,           // turn-rate factor while aiming
   boost: 1.3, slow: 0.72,  // speed factors (W / S)
   boostMax: 8,             // s of boost; recharges at half that rate
   tbAimMin: 0.6,           // s the run must be held before torpedoes can be dropped
   tbAimFull: 3,            // s to the tightest spread
   tbSpread: [26 * DEG, 7 * DEG],   // full fan width loose .. tight
   tbDrop: 150,             // m ahead of the planes the torpedoes enter the water
   tbArm: 300,              // m an aerial torpedo runs before it is armed
   tbDetect: 1000,          // m: aerial torpedoes are smaller and slower than ship torpedoes
   dbAim: 520,              // m ahead: centre of the bombing ellipse
   dbAimMin: 0.5,
   dbAimFull: 3,
   dbEllipse: [190, 48],    // m: semi-major axis of the bombing ellipse loose .. tight (minor = half)
   bombFall: 1.15,          // s from release to impact
   bombCal: 250,            // mm-equivalent of a bomb (fuse arming, hit effect size)
   maxBombs: 48,            // pooled
   patrolR: 900,            // m
   patrolT: 60,             // s
   ftEngage: 2600,          // m: fighters engage enemy planes this close to their post
   gunR: 450,               // m: dogfight range
   gunnerDps: 14,           // per bomber plane: rear gunners
   aaStack: 0.5,            // each further ship's flak on one squadron counts this much
   spotK: 0.6,              // planes see a ship at this fraction of its surface detectability ...
   spotMax: 8000,           // ... at most this far
   periSpot: 1000,          // m: a periscope is seen from the air only this close
   seeByShip: 8000,         // m: enemy planes are visible this close to a ship of the team ...
   seeByPlane: 4000,        // ... or to a squadron of the team
   flakGap: 0.1,            // s: one flak burst per squadron at most this often (scaled with fire)
   ditchT: 12,              // s a squadron without a carrier flies on before it ditches
};
const SPOT_DT = 0.25;
const AA_DT = 0.1;          // AA is integrated at 10 Hz (cheap, and the bursts read better)

let _sqId = 1;
const _lp = { x: 0, y: 0 };

// Fields every ship carries (cheap, so nothing else has to test for undefined).
export function initAirState(ship) {
   const a = ship.cfg.air;
   ship.air = a ? {
      tb: { hangar: a.tb.hangar, service: [], restockT: a.tb.restock },
      db: { hangar: a.db.hangar, service: [], restockT: a.db.restock },
      ft: { hangar: a.ft.hangar, service: [], restockT: a.ft.restock },
      deckT: 0,                // s until the deck is free for the next launch
      sel: 'tb',               // selected type (player HUD)
      strikeT: 4,              // bot: s until the next strike decision
   } : null;
   ship.aa = aaProfile(ship.cfg);
   ship.aaFocus = 0;           // -1 port, +1 starboard, 0 even
   ship.aaFire = 0;            // dps actually fired last AA tick (HUD / renderer)
}
export function isCarrierShip(s) { return !!(s && s.air); }

// Planes of one type: ready in the hangar, in service, airborne (this carrier's squadrons).
export function planeCount(world, ship, type) {
   const h = ship.air[type];
   let svc = 0, air = 0;
   for (const s of h.service) svc += s.n;
   for (const q of world.squadrons) if (q.ownerId === ship.id && q.type === type) air += q.n;
   return { ready: h.hangar, service: svc, air, total: h.hangar + svc + air, max: ship.cfg.air[type].hangar };
}
function totalPlanes(world, ship, type) {
   const h = ship.air[type];
   let n = h.hangar;
   for (let i = 0; i < h.service.length; i++) n += h.service[i].n;
   for (const q of world.squadrons) if (q.ownerId === ship.id && q.type === type) n += q.n;
   return n;
}
// The squadron of this type still on a mission (not returning / landing), if any.
export function activeSquad(world, ship, type) {
   for (const q of world.squadrons) if (q.ownerId === ship.id && q.type === type && q.state !== 'return' && q.state !== 'land') return q;
   return null;
}
export function canLaunch(world, ship, type) {
   const a = ship.air;
   if (!a || !ship.alive || world.phase !== 'playing') return false;
   if (a.deckT > 0 || a[type].hangar < 1 || activeSquad(world, ship, type)) return false;
   return true;
}

// Launch a squadron. order: { kind: 'strike', targetId?, pos? } | { kind: 'patrol', pos } | null
// (null: the player flies it). Returns the squadron or null.
export function launchSquadron(world, ship, type, order = null, human = false) {
   if (!canLaunch(world, ship, type)) return null;
   const pc = ship.cfg.air[type], h = ship.air[type];
   const n = Math.min(pc.squad, h.hangar);
   h.hangar -= n;
   const L = ship.cfg.hull.L, c = Math.cos(ship.heading), s = Math.sin(ship.heading);
   const lt = AIR.launchBase + AIR.launchPer * n;
   ship.air.deckT = lt;
   const sq = {
      id: _sqId++, side: ship.side, ownerId: ship.id, type, cfg: pc, n, n0: n,
      armed: type === 'ft' ? 0 : n, hp: pc.hp,
      pos: { x: ship.pos.x + c * L * 0.35, y: ship.pos.y + s * L * 0.35 }, alt: 20, altT: type === 'db' ? AIR.dbAlt : AIR.cruiseAlt,
      prev: { x: 0, y: 0, alt: 0, h: 0 },
      heading: ship.heading, want: ship.heading, speed: pc.speed * 0.6, throttle: 0, boost: AIR.boostMax,
      state: 'launch', t: lt, fuel: ship.cfg.air.fuel, order, human,
      aiming: false, aimT: 0, aimPt: { x: 0, y: 0 }, spread: AIR.tbSpread[0], ellipse: AIR.dbEllipse[0],
      ammo: pc.ammo || 0, foeId: null, patrolT: AIR.patrolT, center: null,
      visible: ship.side === 'player', seenT: 0, flakT: 0, underFire: 0, ditchT: 0,
      ai: { t: 0, phase: 0, errL: 0, errP: { x: 0, y: 0 } },
   };
   sq.prev.x = sq.pos.x; sq.prev.y = sq.pos.y; sq.prev.alt = sq.alt; sq.prev.h = sq.heading;
   if (type === 'ft' && order && order.kind === 'patrol') sq.center = { x: order.pos.x, y: order.pos.y };
   world.squadrons.push(sq);
   world.hasAir = true;
   world.pushEvent('airLaunch', { srcId: ship.id, sqId: sq.id, kind: type, n, pos: { x: sq.pos.x, y: sq.pos.y },
      text: AIR_NAMES[type] + ' gestartet (' + n + ')' });
   return sq;
}

// Recall: the squadron turns home (the player's view returns to the ship, airui.js).
export function recallSquadron(world, sq) {
   if (!sq || sq.state === 'return' || sq.state === 'land') return false;
   sq.state = 'return'; sq.aiming = false; sq.aimT = 0; sq.human = false; sq.altT = AIR.cruiseAlt;
   world.pushEvent('airInfo', { srcId: sq.ownerId, sqId: sq.id, text: AIR_NAMES[sq.type] + ': Rückkehr zum Träger' });
   return true;
}

// Fighters: patrol a point (player: LMB in fighter view; AI: cover the fleet).
export function orderPatrol(world, sq, pos) {
   if (!sq || sq.type !== 'ft' || sq.state === 'return' || sq.state === 'land') return false;
   sq.center = { x: pos.x, y: pos.y };
   sq.order = { kind: 'patrol', pos: sq.center };
   sq.state = sq.state === 'launch' ? 'launch' : 'patrol';
   sq.patrolT = AIR.patrolT;
   sq.human = false;
   world.pushEvent('airInfo', { srcId: sq.ownerId, sqId: sq.id, text: 'Jäger: Patrouille eingerichtet' });
   return true;
}

// Release the weapons of one flight (bombers). Returns the number of weapons dropped.
export function dropWeapons(world, sq) {
   if (sq.type === 'ft' || sq.armed <= 0 || sq.state === 'launch' || sq.state === 'return' || sq.state === 'land') return 0;
   const need = sq.type === 'tb' ? AIR.tbAimMin : AIR.dbAimMin;
   if (sq.aimT < need) return 0;
   const carrier = world.shipById(sq.ownerId);
   const k = Math.min(sq.cfg.flight, sq.armed);
   const w = sq.cfg.weapon, mult = carrier ? carrier.dmgMult || 1 : 1;
   const c = Math.cos(sq.heading), s = Math.sin(sq.heading);
   if (sq.type === 'tb') {
      const dx = sq.pos.x + c * AIR.tbDrop, dy = sq.pos.y + s * AIR.tbDrop;
      const spd = w.speedKn * 2.6;
      for (let i = 0; i < k; i++) {
         const h = sq.heading + (k > 1 ? (i / (k - 1) - 0.5) * sq.spread : 0);
         const px = dx + Math.cos(h + Math.PI / 2) * (i - (k - 1) / 2) * 25, py = dy + Math.sin(h + Math.PI / 2) * (i - (k - 1) / 2) * 25;
         world.addTorpedo({
            id: world._nextId++, pos: { x: px, y: py }, start: { x: px, y: py },
            heading: h, dir: h, speed: spd, speedKn: w.speedKn, side: sq.side, owner: sq.side, ownerId: sq.ownerId,
            dmg: w.dmg * mult, flood: w.flood, range: w.range, detect: AIR.tbDetect,
            traveled: 0, age: 0, alive: true, spotted: sq.side === 'player', air: true, arm: AIR.tbArm,
         });
         world.addEffect('splash', { x: px, y: py }, 1, 4);
      }
      if (carrier?.stats) carrier.stats.torpsFired += k;
   } else {
      // bombs land inside the ellipse around the aim point (major axis along the run)
      const ax = sq.pos.x + c * AIR.dbAim, ay = sq.pos.y + s * AIR.dbAim;
      const R = sq.ellipse;
      for (let i = 0; i < k; i++) {
         const u = clamp(gaussR(world.rng) * 0.5, -1, 1) * R, v = clamp(gaussR(world.rng) * 0.5, -1, 1) * R * 0.5;
         addBomb(world, sq, ax + c * u - s * v, ay + s * u + c * v, w, mult, i * 0.08);
      }
   }
   world.pushEvent('airDrop', { srcId: sq.ownerId, sqId: sq.id, kind: sq.type, n: k, pos: { x: sq.pos.x, y: sq.pos.y },
      text: sq.type === 'tb' ? 'Torpedos abgeworfen' : 'Bomben ausgeklinkt' });
   // the flight that dropped turns home; the rest of the squadron stays for another run
   sq.armed -= k;
   const back = sq.n - sq.armed;   // unarmed planes
   if (sq.armed > 0 && back > 0) {
      const f = splitSquad(world, sq, back);
      f.state = 'return'; f.altT = AIR.cruiseAlt;
   } else if (sq.armed <= 0) {
      sq.state = 'return'; sq.human = false; sq.altT = AIR.cruiseAlt;
   }
   sq.aiming = false; sq.aimT = 0;
   if (sq.state !== 'return') { sq.state = 'fly'; sq.altT = sq.type === 'db' ? AIR.dbAlt : AIR.cruiseAlt; }
   return k;
}

function splitSquad(world, sq, n) {
   const f = {
      ...sq, id: _sqId++, n, armed: 0, hp: sq.cfg.hp, human: false, order: null, aiming: false, aimT: 0,
      pos: { x: sq.pos.x, y: sq.pos.y }, prev: { ...sq.prev }, aimPt: { x: 0, y: 0 }, center: null,
      ai: { t: 0, phase: 0, errL: 0, errP: { x: 0, y: 0 } },
      heading: sq.heading + 0.4, want: sq.heading + 0.4,
   };
   sq.n -= n;
   world.squadrons.push(f);
   return f;
}

function addBomb(world, sq, x, y, w, mult, delay) {
   let b = null;
   for (const o of world.bombs) if (!o.alive) { b = o; break; }
   if (!b) {
      if (world.bombs.length >= AIR.maxBombs) return;
      b = { alive: false, x: 0, y: 0, sx: 0, sy: 0, salt: 0, t: 0, fall: 0, side: '', ownerId: 0, dmg: 0, pen: 0, fire: 0, ap: false, heading: 0 };
      world.bombs.push(b);
   }
   b.alive = true; b.x = x; b.y = y; b.sx = sq.pos.x; b.sy = sq.pos.y; b.salt = Math.max(sq.alt, 250);
   b.t = -delay; b.fall = AIR.bombFall; b.side = sq.side; b.ownerId = sq.ownerId;
   b.dmg = w.dmg * mult; b.pen = w.pen; b.fire = w.fire; b.ap = !!w.ap; b.heading = sq.heading;
}

// pseudo shell for combat.resolveHit (one reused object; resolveHit keeps no reference)
const BOMB_SHELL = {
   kind: 'bomb', ammo: 'HE', hePen: 0, dmg: 0, fire: 0, dirX: 1, dirY: 0, fall: 78 * DEG, caliber: AIR.bombCal,
   gun: { ap: { pen: 0, ricochet: [80, 90], fuse: 10 }, range: 1 }, range: 0, ownerId: 0, shooter: null,
};
function bombImpact(world, b) {
   b.alive = false;
   const p = { x: b.x, y: b.y };
   for (const ship of world.ships) {
      if (!ship.alive || ship.side === b.side || ship.depth === 2) continue;
      const r = ship.cfg.hull.L * 0.5 + 10;
      if (dist2(ship.pos, p) > r * r) continue;
      const lp = toLocal(ship, p);
      if (!insideHull(ship.cfg.hull, lp, 0.5)) continue;
      const sup = ship.cfg.hull.sup;
      const zone = sup && Math.abs(lp.x - sup.x) < sup.len / 2 && Math.abs(lp.y) < sup.w / 2 ? 'sup' : 'deck';
      const s = BOMB_SHELL, shooter = world.shipById(b.ownerId);
      s.ammo = b.ap ? 'AP' : 'HE'; s.hePen = b.pen; s.dmg = b.dmg; s.fire = b.fire;
      s.dirX = Math.cos(b.heading); s.dirY = Math.sin(b.heading);
      s.gun.ap.pen = b.pen; s.ownerId = b.ownerId; s.shooter = shooter;
      resolveHit(world, s, ship, zone, lp, p, ship.cfg.hull.deckH);
      s.shooter = null;
      return;
   }
   world.addEffect('splash', p, 1.6, 18);
}

// ---------------------------------------------------------------- per step
export function updateAir(world, dt) {
   if (world.net) return;        // not networked yet (see header)
   const ships = world.ships;
   // carriers: deck, service, restock
   for (const s of ships) {
      const a = s.air;
      if (!a || !s.alive) continue;
      a.deckT = Math.max(0, a.deckT - dt);
      for (const type of AIR_TYPES) {
         const h = a[type];
         for (let i = h.service.length - 1; i >= 0; i--) {
            const e = h.service[i];
            if ((e.t -= dt) <= 0) { h.hangar += e.n; h.service.splice(i, 1); }
         }
         if (totalPlanes(world, s, type) < s.cfg.air[type].hangar) {
            if ((h.restockT -= dt) <= 0) { h.hangar++; h.restockT = s.cfg.air[type].restock; }
         } else h.restockT = s.cfg.air[type].restock;
      }
   }
   const sqs = world.squadrons;
   if (!sqs.length && !world.bombs.length) return;
   world._aaT = (world._aaT || 0) - dt;
   const aaTick = world._aaT <= 0;
   if (aaTick) world._aaT += AA_DT;
   for (const sq of sqs) {
      sq.prev.x = sq.pos.x; sq.prev.y = sq.pos.y; sq.prev.alt = sq.alt; sq.prev.h = sq.heading;
      if (sq.n <= 0) continue;
      stepSquad(world, sq, dt);
   }
   if (aaTick) {
      // a ship's guns are shared between the enemy squadrons in its range (splitting a strike
      // does not double the flak)
      for (const s of ships) {
         s.aaFire = 0; s._aaN = 0;
         if (!s.alive || s.depth > 0 || !s.aa.range) continue;
         const r2 = s.aa.range * s.aa.range;
         for (const q of sqs) if (q.n > 0 && q.side !== s.side && q.state !== 'land' && dist2(q.pos, s.pos) <= r2) s._aaN++;
      }
      for (const sq of sqs) if (sq.n > 0) antiAir(world, sq, AA_DT);
      dogfights(world, AA_DT);
   }
   // bombs
   for (const b of world.bombs) {
      if (!b.alive) continue;
      if ((b.t += dt) >= b.fall) bombImpact(world, b);
   }
   // visibility of squadrons to the player team
   world._airSpotT = (world._airSpotT || 0) - dt;
   if (world._airSpotT <= 0) { world._airSpotT = SPOT_DT; squadVisibility(world); }
   let dead = false;
   for (const q of sqs) if (q.n <= 0) { dead = true; break; }
   if (dead) world.squadrons = sqs.filter(q => q.n > 0);
}

function stepSquad(world, sq, dt) {
   const carrier = world.shipById(sq.ownerId);
   const home = carrier && carrier.alive ? carrier : null;
   if (sq.state !== 'launch' && sq.state !== 'land') sq.fuel -= dt;
   if (sq.state === 'launch') {
      sq.t -= dt;
      if (home) sq.want = home.heading;
      if (sq.t <= 0) sq.state = sq.type === 'ft' && sq.center ? 'patrol' : 'fly';
   }
   if (sq.state !== 'return' && sq.state !== 'land' && sq.state !== 'launch' && (sq.fuel <= 0 || !home && sq.armed <= 0)) {
      if (sq.human) world.pushEvent('airInfo', { srcId: sq.ownerId, sqId: sq.id, text: 'Treibstoff knapp – Staffel kehrt zurück', level: 'warn' });
      recallSquadron(world, sq);
   }
   if (sq.state === 'return') {
      if (!home) {
         // nowhere to land: fly on, then ditch
         if ((sq.ditchT += dt) > AIR.ditchT) { ditch(world, sq); return; }
      } else {
         const dx = home.pos.x - sq.pos.x, dy = home.pos.y - sq.pos.y;
         sq.want = Math.atan2(dy, dx);
         if (dx * dx + dy * dy < AIR.landR * AIR.landR) { land(world, sq, home); return; }
      }
   } else if (!sq.human) squadThink(world, sq, dt);

   // flight model
   let turn = AIR.turn[sq.type] * (sq.aiming ? AIR.aimTurn : 1);
   const dh = angleDelta(sq.heading, sq.want);
   sq.heading += clamp(dh, -turn * dt, turn * dt);
   let spd = sq.cfg.speed;
   if (sq.state === 'launch') spd *= 0.7;
   else if (sq.throttle > 0 && sq.boost > 0 && !sq.aiming) { spd *= AIR.boost; sq.boost = Math.max(0, sq.boost - dt); }
   else {
      if (sq.throttle < 0) spd *= AIR.slow;
      sq.boost = Math.min(AIR.boostMax, sq.boost + dt * 0.5);
   }
   sq.speed += clamp(spd - sq.speed, -40 * dt, 40 * dt);
   sq.pos.x += Math.cos(sq.heading) * sq.speed * dt;
   sq.pos.y += Math.sin(sq.heading) * sq.speed * dt;
   // keep inside the arena (planes simply turn back at the edge)
   const lim = world.arena * 1.15;
   if (Math.abs(sq.pos.x) > lim || Math.abs(sq.pos.y) > lim) {
      sq.pos.x = clamp(sq.pos.x, -lim, lim); sq.pos.y = clamp(sq.pos.y, -lim, lim);
      if (!sq.human) sq.want = Math.atan2(-sq.pos.y, -sq.pos.x);
   }
   // attack-run altitude: torpedo bombers come down while aiming, dive bombers dive
   const altT = sq.state === 'launch' ? AIR.cruiseAlt * 0.5
      : sq.aiming ? (sq.type === 'tb' ? AIR.tbAlt : AIR.dbAlt * 0.45) : sq.altT;
   sq.alt += clamp(altT - sq.alt, -AIR.climb * dt * (sq.aiming && sq.type === 'db' ? 4 : 1), AIR.climb * dt);
   // aiming
   if (sq.aiming && sq.armed > 0) {
      sq.aimT += dt;
      if (sq.type === 'tb') sq.spread = AIR.tbSpread[0] + (AIR.tbSpread[1] - AIR.tbSpread[0]) * clamp01((sq.aimT - AIR.tbAimMin) / (AIR.tbAimFull - AIR.tbAimMin));
      else sq.ellipse = AIR.dbEllipse[0] + (AIR.dbEllipse[1] - AIR.dbEllipse[0]) * clamp01(sq.aimT / AIR.dbAimFull);
      const ahead = sq.type === 'tb' ? AIR.tbDrop : AIR.dbAim;
      sq.aimPt.x = sq.pos.x + Math.cos(sq.heading) * ahead; sq.aimPt.y = sq.pos.y + Math.sin(sq.heading) * ahead;
      if (sq.state === 'fly') sq.state = 'attack';
   } else {
      sq.aimT = 0;
      sq.spread = AIR.tbSpread[0]; sq.ellipse = AIR.dbEllipse[0];
      if (sq.state === 'attack' && sq.type !== 'ft') sq.state = 'fly';
   }
}

function land(world, sq, home) {
   const h = home.air[sq.type];
   h.service.push({ n: sq.n, t: home.cfg.air.service });
   world.pushEvent('airLand', { srcId: home.id, sqId: sq.id, kind: sq.type, n: sq.n, text: AIR_NAMES[sq.type] + ' gelandet (' + sq.n + ')' });
   sq.n = 0; sq.state = 'land';
}
function ditch(world, sq) {
   world.addEffect('splash', sq.pos, 1.5, 10);
   const carrier = world.shipById(sq.ownerId);
   if (carrier?.stats) carrier.stats.planesLost += sq.n;
   sq.n = 0; sq.state = 'land';
}

// One plane of the squadron down (AA or fighters).
function planeDown(world, sq, by) {
   sq.n--;
   if (sq.armed > sq.n) sq.armed = sq.n;
   sq.hp += sq.cfg.hp;
   world.addEffect('planeDown', sq.pos, 4.5, 8, { alt: sq.alt, heading: sq.heading, speed: sq.speed * 0.8, side: sq.side });
   const carrier = world.shipById(sq.ownerId);
   if (carrier?.stats) carrier.stats.planesLost++;
   if (by?.stats) by.stats.planesDown++;
   world.pushEvent('planeDown', { srcId: by ? by.id : null, dstId: sq.ownerId, sqId: sq.id, kind: sq.type, n: sq.n,
      pos: { x: sq.pos.x, y: sq.pos.y }, text: sq.n > 0 ? 'Flugzeug abgeschossen' : 'Staffel aufgerieben' });
   if (sq.n <= 0) { sq.state = 'land'; if (sq.human) sq.human = false; }
}

function hurtSquad(world, sq, dmg, by) {
   sq.hp -= dmg;
   while (sq.hp <= 0 && sq.n > 0) planeDown(world, sq, by);
}

// AA: every enemy surface ship within range fires at the squadron.
function antiAir(world, sq, dt) {
   if (sq.state === 'land') return;
   let total = 0, nShips = 0, topDps = 0, top = null;
   for (const s of world.ships) {
      if (!s.alive || s.side === sq.side || s.depth > 0 || !s.aa.range) continue;
      const dx = sq.pos.x - s.pos.x, dy = sq.pos.y - s.pos.y, d2 = dx * dx + dy * dy;
      const bands = s.aa.bands;
      if (d2 > bands[0].r * bands[0].r) continue;
      let dps = 0;
      for (const b of bands) if (d2 <= b.r * b.r) dps += b.dps;
      if (s.aaFocus) {
         const rel = angleDelta(s.heading, Math.atan2(dy, dx));
         dps *= Math.sign(rel) === s.aaFocus ? 1.5 : 0.7;
      }
      // fires and flooding take crews off the guns; a burning hull is still dangerous
      dps *= (0.6 + 0.4 * (s.hp / s.maxHP)) / Math.max(1, s._aaN);
      s.aaFire += dps;
      total += dps;
      nShips++;
      if (dps > topDps) { topDps = dps; top = s; }
   }
   // overlapping umbrellas add up with diminishing returns (a formation is dangerous, but a
   // strike on an escorted target must still be survivable)
   if (nShips > 1) total *= (1 + AIR.aaStack * (nShips - 1)) / nShips;
   if (total > 0) hurtSquad(world, sq, total * dt, top);
   sq.underFire = total;
   if (total > 0 && sq.n > 0) {
      sq.flakT -= dt;
      // bursts: more and denser the more guns fire
      let k = 0;
      while (sq.flakT <= 0 && k < 3) {
         sq.flakT += AIR.flakGap * clamp(120 / total, 0.5, 3);
         const r = world.rng, ox = (r() - 0.5) * 420, oy = (r() - 0.5) * 420;
         world.addEffect('flak', { x: sq.pos.x + Math.cos(sq.heading) * 120 + ox, y: sq.pos.y + Math.sin(sq.heading) * 120 + oy }, 1.6, 9,
            { alt: Math.max(25, sq.alt + (r() - 0.4) * 140) });
         k++;
      }
   } else sq.flakT = 0;
}

// Fighters against enemy planes in gun range.
function dogfights(world, dt) {
   for (const f of world.squadrons) {
      if (f.type !== 'ft' || f.n <= 0 || f.foeId == null || f.state === 'launch' || f.state === 'land' || f.ammo <= 0) continue;
      const e = squadById(world, f.foeId);
      if (!e || e.n <= 0) { f.foeId = null; continue; }
      if (dist2(f.pos, e.pos) > AIR.gunR * AIR.gunR) continue;
      f.ammo -= dt;
      const carrier = world.shipById(f.ownerId);
      hurtSquad(world, e, f.cfg.dps * f.n * dt, carrier);
      // return fire: escorting fighters fire back fully, bombers with their rear gunners
      if (e.n > 0) hurtSquad(world, f, (e.type === 'ft' ? e.cfg.dps : AIR.gunnerDps) * e.n * dt, world.shipById(e.ownerId));
      if (f.ammo <= 0 && f.state !== 'return') recallSquadron(world, f);
   }
}

export function squadById(world, id) {
   for (const q of world.squadrons) if (q.id === id) return q;
   return null;
}

// The player team's view of enemy squadrons.
function squadVisibility(world) {
   const sb = AIR.seeByShip * AIR.seeByShip, sp = AIR.seeByPlane * AIR.seeByPlane;
   for (const q of world.squadrons) {
      if (q.side === 'player') { q.visible = true; continue; }
      let vis = false;
      for (const s of world.ships) if (s.alive && s.side === 'player' && s.depth === 0 && dist2(s.pos, q.pos) < sb) { vis = true; break; }
      if (!vis) for (const o of world.squadrons) if (o.side === 'player' && o.n > 0 && dist2(o.pos, q.pos) < sp) { vis = true; break; }
      q.visible = vis;
      if (vis) q.seenT = world.time;
   }
}

// Spotting from the air (World._updateSpotting): 0 not seen, 1 seen by an enemy squadron,
// 2 seen by a squadron of the player's own carrier.
export function airSpots(world, T) {
   if (T.depth === 2 || T.inSmoke) return 0;
   const r = T.depth === 1 ? AIR.periSpot : Math.min(T.detectRange * AIR.spotK, AIR.spotMax);
   const r2 = r * r, pid = world.player ? world.player.id : -1;
   let seen = 0;
   for (const q of world.squadrons) {
      if (q.side === T.side || q.n <= 0 || q.state === 'land' || q.state === 'launch') continue;
      if (dist2(q.pos, T.pos) < r2) {
         if (q.ownerId === pid) return 2;
         seen = 1;
      }
   }
   return seen;
}

// AA focus (player key): cycles off -> port -> starboard -> off. Returns the new focus.
export function cycleAaFocus(world, ship) {
   if (!ship.aa.range) return 0;
   ship.aaFocus = ship.aaFocus === 0 ? -1 : ship.aaFocus === -1 ? 1 : 0;
   world.pushEvent('aaFocus', { srcId: ship.id, focus: ship.aaFocus,
      text: 'Flak-Schwerpunkt: ' + (ship.aaFocus < 0 ? 'Backbord' : ship.aaFocus > 0 ? 'Steuerbord' : 'aus') });
   return ship.aaFocus;
}
