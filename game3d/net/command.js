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
import { diveDeeper, diveUp, dropDepthCharges } from '../submarine.js';

export function makeCommand() { return { telegraph: 0, rudder: 0, aim: null, lock: null }; }

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
   }
   return 0;
}
