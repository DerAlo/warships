// game3d/net/command.js — the one command structure that steers a human-controlled ship.
//
// main3d.js fills a command from the local input and applies it to world.player; in a net game
// the client sends the very same data on the `cmd` channel and the host applies it to that
// player's ship. Two parts:
//   - continuous state (applied every sim step): telegraph, rudder, aim point, locked target
//   - one-shot actions (executed once): short arrays, first element = kind
//       ['f', x, y]     fire the main battery at the aim point
//       ['t', bearing]  launch torpedoes along the absolute bearing (rad), spread as selected
//       ['c', key]      use a consumable
//       ['a', type]     ammo type 'HE' | 'AP'
//       ['s', mode]     torpedo spread 'narrow' | 'wide'
//       ['x', id|null]  secondary battery priority target
//       ['d', +1|-1]    submarine: one depth step deeper / up
//       ['g']           drop a depth-charge pattern
//       ['F', focus]    AA focus -1 port | 0 even | +1 starboard (every ship with AA)
//     carriers (air.js; sqId = a squadron of this carrier, anything else is ignored):
//       ['L', type]     launch a squadron 'tb' | 'db' | 'ft', flown by the captain
//       ['P', sqId]     take the controls of a squadron
//       ['H', sqId]     hand it back to its pilots (bombers strike ahead, fighters patrol there)
//       ['R', sqId]     recall it
//       ['W', sqId, x, y]  fighters: patrol that point
//       ['B', sqId]     attack run: release the weapons of one flight
//   - air control (continuous, while the captain flies a squadron): c.air = [sqId, want, throttle,
//     aiming] (want: wanted heading in rad, throttle -1 | 0 | +1, aiming 0 | 1)
import { diveDeeper, diveUp, dropDepthCharges } from '../submarine.js';
import { AIR_TYPES, launchSquadron, takeSquadron, releaseSquadron, recallSquadron, orderPatrol, dropWeapons,
   squadById, setAaFocus } from '../air.js';
import { clamp, angleDelta } from '../utils.js';

export function makeCommand() { return { telegraph: 0, rudder: 0, aim: null, lock: null, air: null }; }

// the one-shot kinds that order squadrons (the client does not predict them, replica.js)
export const AIR_ACTS = { L: 1, P: 1, H: 1, R: 1, W: 1, B: 1 };
const STEER_MAX = 1.3;               // rad: a wanted heading never further off the current one

// Continuous part. c.aim is kept by reference (the sim only reads it).
export function applyCommand(ship, c) {
   ship.setTelegraph(c.telegraph);
   ship.setRudder(c.rudder);
   const ap = c.aim;
   if (ap) {
      ship.aimPoint = ap;
      const bx = ap.x - ship.pos.x, by = ap.y - ship.pos.y, bl = Math.hypot(bx, by) || 1;
      ship.aimBearing = Math.atan2(by, bx);
      const a = ship.aim || (ship.aim = { x: 1, y: 0 });
      a.x = bx / bl; a.y = by / bl;
   }
   ship.lockTarget = c.lock;
}

// A squadron of `ship` the command may address: one of its own, still in the air.
function ownSquad(ship, world, id) {
   const sq = typeof id === 'number' ? squadById(world, id) : null;
   return sq && sq.ownerId === ship.id && sq.n > 0 ? sq : null;
}

// Continuous air control (c.air) for the squadron the captain flies. Values from the network are
// clamped; a squadron that is not the captain's, or not in his hands, is left alone.
export function applyAirControl(ship, world, a) {
   if (!Array.isArray(a) || !ship.air) return false;
   const sq = ownSquad(ship, world, a[0]);
   if (!sq || !sq.human || sq.state === 'return' || sq.state === 'land') return false;
   if (fin(a[1])) sq.want = sq.heading + clamp(angleDelta(sq.heading, a[1]), -STEER_MAX, STEER_MAX);
   sq.throttle = a[2] > 0 ? 1 : a[2] < 0 ? -1 : 0;
   sq.aiming = !!a[3] && sq.type !== 'ft' && sq.armed > 0 && sq.state !== 'launch';
   return true;
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

// One-shot part. Returns what the sim call returned (guns / torpedoes fired, or a boolean), 0 for
// anything malformed: the host runs this on data from the network.
export function execAction(ship, world, a) {
   if (!ship || !ship.alive || !Array.isArray(a)) return 0;
   switch (a[0]) {
      case 'f': return fin(a[1]) && fin(a[2]) ? ship.fireMain(world, { x: a[1], y: a[2] }) || 0 : 0;
      case 't': return fin(a[1]) ? ship.fireTorpedoes(world, a[1]) || 0 : 0;
      case 'c': return typeof a[1] === 'string' ? !!ship.useConsumable(world, a[1]) : false;
      case 'a': return !!ship.setAmmo(a[1] === 'AP' ? 'AP' : 'HE');
      case 's': ship.setTorpSpread(a[1] === 'wide' ? 'wide' : 'narrow'); return true;
      case 'x': ship.setSecTarget(fin(a[1]) ? a[1] : null); return true;
      case 'd': return a[1] > 0 ? diveDeeper(ship, world) : diveUp(ship, world);
      case 'g': return dropDepthCharges(ship, world);
      case 'F': return fin(a[1]) ? setAaFocus(world, ship, a[1]) !== null : false;
      case 'L': return ship.air && AIR_TYPES.includes(a[1]) ? launchSquadron(world, ship, a[1], null, true) || 0 : 0;
      case 'P': return takeSquadron(world, ownSquad(ship, world, a[1]));
      case 'H': return releaseSquadron(world, ownSquad(ship, world, a[1]));
      case 'R': return recallSquadron(world, ownSquad(ship, world, a[1]));
      case 'W': {
         const sq = ownSquad(ship, world, a[1]), A = world.arena * 1.15;
         return sq && fin(a[2]) && fin(a[3]) ? orderPatrol(world, sq, { x: clamp(a[2], -A, A), y: clamp(a[3], -A, A) }) : false;
      }
      case 'B': { const sq = ownSquad(ship, world, a[1]); return sq && sq.human ? dropWeapons(world, sq) : 0; }
   }
   return 0;
}
