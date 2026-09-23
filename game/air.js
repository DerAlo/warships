// game/air.js — carrier air groups. A squadron flies out to its target, torpedo bombers release a
// spread at AIR.torpDrop, dive bombers commit to a telegraphed dive and drop at AIR.diveDrop; then
// they egress and fly home to land (survivors return to the hangar). Individual planes live in
// world.aircraft so every ship's AA (ship._autoAA) can shoot them down.
import { add, sub, dist, fromAngle, angleOf, angleDelta, clamp, randn } from './utils.js';
import { AIR } from './config.js';

let SQ = 0;
// V formation offsets (behind/abreast of the leader), in squadron-local coords (+x = forward)
const FORM = [{ x: 0, y: 0 }, { x: -26, y: -24 }, { x: -26, y: 24 }, { x: -52, y: -48 }, { x: -52, y: 48 }, { x: -78, y: 0 }];

// Launch `n` planes of `type` ('torp' | 'dive') from `carrier` against `target`. Returns the squadron.
export function launchSquadron(world, carrier, target, type, n) {
   const sq = {
      id: ++SQ, carrier, side: carrier.side, type, target, state: 'outbound', t: 0,
      pos: { x: carrier.pos.x, y: carrier.pos.y }, heading: angleOf(sub(target.pos, carrier.pos)),
      planes: [],
   };
   const hp = type === 'dive' ? AIR.hp * 1.6 : AIR.hp;
   for (let i = 0; i < n; i++) {
      const a = { id: sq.id * 10 + i, pos: { x: sq.pos.x, y: sq.pos.y }, side: sq.side, hp, maxHP: hp, alive: true,
         heading: sq.heading, sq, slot: i, kind: type };
      sq.planes.push(a);
      world.aircraft.push(a);
   }
   world.squadrons.push(sq);
   world.emit({ kind: 'airLaunch', ship: carrier, type });
   return sq;
}

// where a ship will be after t seconds on its current course
function lead(ship, t) { return { x: ship.pos.x + ship.vel.x * t, y: ship.pos.y + ship.vel.y * t }; }

function steer(sq, goal, dt) {
   const want = angleOf(sub(goal, sq.pos));
   const d = angleDelta(sq.heading, want);
   sq.heading += clamp(d, -AIR.turn * dt, AIR.turn * dt);
   sq.pos.x += Math.cos(sq.heading) * AIR.speed * dt;
   sq.pos.y += Math.sin(sq.heading) * AIR.speed * dt;
   return Math.abs(d);
}

function retarget(world, sq) {
   let best = null, bd = Infinity;
   for (const s of world.ships) {
      if (!s.alive || s.side === sq.side || s.depth >= 0.5) continue;
      const d = dist(s.pos, sq.pos);
      if (d < bd) { bd = d; best = s; }
   }
   return best;
}

export function updateAir(world, dt) {
   for (const sq of world.squadrons) {
      sq.planes = sq.planes.filter(a => a.alive);
      if (!sq.planes.length) { sq.dead = true; continue; }
      sq.t += dt;
      if ((sq.state === 'outbound' || sq.state === 'attack') && (!sq.target || !sq.target.alive || sq.target.depth >= 0.5)) {
         sq.target = retarget(world, sq);
         if (!sq.target) { sq.state = 'return'; sq.t = 0; }
      }
      const tg = sq.target;
      switch (sq.state) {
         case 'outbound': {
            const d = dist(sq.pos, tg.pos);
            if (sq.type === 'torp') {
               // aim the run at where the target will be when the fish arrive
               const aim = lead(tg, (d / AIR.speed) * 0.5 + AIR.torpDrop / AIR.torp.speed);
               const off = steer(sq, aim, dt);
               if (d < AIR.torpDrop && off < 0.3) dropTorpedoes(world, sq, aim);
               else if (d < AIR.torpDrop * 0.45) { sq.state = 'egress'; sq.t = 0; } // overshot: go round
            } else {
               steer(sq, lead(tg, d / AIR.speed), dt);
               if (d < AIR.diveStart) { sq.state = 'attack'; sq.t = 0; world.emit({ kind: 'airAttack', target: tg, type: 'dive' }); }
            }
            break;
         }
         case 'attack': {
            const d = dist(sq.pos, tg.pos);
            steer(sq, lead(tg, d / AIR.speed + AIR.bomb.fall), dt);
            if (d < AIR.diveDrop) dropBombs(world, sq, tg);
            else if (sq.t > 12) { sq.state = 'egress'; sq.t = 0; }
            break;
         }
         case 'egress':
            steer(sq, add(sq.pos, fromAngle(sq.heading, 500)), dt);
            if (sq.t > AIR.egress) { sq.state = 'return'; sq.t = 0; }
            break;
         case 'return': {
            const c = sq.carrier;
            if (!c.alive) {
               // no deck to land on: fly off and ditch
               steer(sq, add(sq.pos, fromAngle(sq.heading, 500)), dt);
               if (sq.t > 20) { for (const a of sq.planes) a.alive = false; sq.dead = true; }
               break;
            }
            steer(sq, c.pos, dt);
            if (dist(sq.pos, c.pos) < 90) {
               c.hangar = (c.hangar || 0) + sq.planes.length;
               for (const a of sq.planes) { a.alive = false; a.landed = true; }
               sq.dead = true;
            }
            break;
         }
      }
      // planes hold their slot in the V behind the leader
      const ch = Math.cos(sq.heading), sh = Math.sin(sq.heading);
      for (const a of sq.planes) {
         const o = FORM[a.slot % FORM.length];
         a.pos.x = sq.pos.x + o.x * ch - o.y * sh;
         a.pos.y = sq.pos.y + o.x * sh + o.y * ch;
         a.heading = sq.heading;
         a.diving = sq.state === 'attack';
      }
   }
   if (world.squadrons.some(s => s.dead)) world.squadrons = world.squadrons.filter(s => !s.dead);
   if (world.aircraft.some(a => !a.alive)) world.aircraft = world.aircraft.filter(a => a.alive);
}

function dropTorpedoes(world, sq, aim) {
   for (const a of sq.planes) {
      const dir = fromAngle(angleOf(sub(aim, a.pos)));
      world.spawnTorpedo(sq.carrier, a.pos, dir, AIR.torp);
   }
   sq.state = 'egress'; sq.t = 0;
   world.emit({ kind: 'airAttack', target: sq.target, type: 'torp' });
}

function dropBombs(world, sq, tg) {
   const at = lead(tg, AIR.bomb.fall);
   const dmgMult = sq.carrier.dmgMult || 1;
   for (const a of sq.planes) {
      world.bombs.push({ pos: { x: at.x + randn() * AIR.bomb.sigma, y: at.y + randn() * AIR.bomb.sigma },
         t: AIR.bomb.fall, T: AIR.bomb.fall, dmg: AIR.bomb.dmg * dmgMult, fire: AIR.bomb.fire, side: sq.side, shooter: sq.carrier });
   }
   sq.state = 'egress'; sq.t = 0;
}
