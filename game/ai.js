// game/ai.js — enemy bot behavior: steering primitives + per-class finite-state machines.
// The AI only *decides when/where* to move and fire; the physics/combat module owns projectiles.
import { sub, add, fromAngle, angleOf, angleDelta, dist, clamp, clamp01, approach,
   approachAngle, norm, TAU, DEG } from './utils.js';
import { WORLD, COMBAT } from './config.js';

// How long a bot may deny the fight before it is forced into a last stand.
// Fast classes get a shorter leash (they can kite the longest); the value only
// matters in a stalemate — normal matches end well before these clocks run out.
const COMMIT_TIME = { DD: 130, LC: 150, HC: 170, EB: 200 };

// ---------- steering primitives (pure, testable) ----------
// Each returns {heading, throttle}.
function seek(target, from) { return { heading: angleOf(sub(target, from)), throttle: 1 }; }
function arrive(target, from, slowR) {
   const d = dist(target, from);
   const t = d > slowR ? 1 : WORLD.MIN_THROTTLE + (d / slowR) * (1 - WORLD.MIN_THROTTLE);
   return { heading: angleOf(sub(target, from)), throttle: t };
}
// sub(from, target) already points AWAY from the threat — no extra π.
function flee(target, from) { return { heading: angleOf(sub(from, target)), throttle: 1 }; }
function flank(target, from, angleDeg, side, prefRange) {
   const bearing = angleOf(sub(target, from));
   const rel = bearing + side * angleDeg * DEG;
   const aim = add(target, fromAngle(rel, prefRange));
   return seek(aim, from);
}
function kite(target, from, side, prefRange) {
   const bearing = angleOf(sub(target, from));
   const d = dist(target, from);
   const perp = bearing + side * (Math.PI / 2);
   const radial = clamp((d - prefRange) / prefRange, -1, 1);
   return { heading: perp + side * 0.4 * radial, throttle: 1 };
}

// Obstacle avoidance (highest-priority blend). Returns a blended {heading, throttle} or null.
// Includes the arena border itself: without this a bot driving nearly bow-on into the
// edge gets its position clamped and speed halved every single frame (ship.js's arena
// clamp), which is a stable near-standstill -- the bot never turns away on its own and
// the match times out with everyone camped on the wall.
function avoidObstacles(bot, world, steer) {
   // Steering straight AWAY from an obstacle's center works for slow, tight-turning ships,
   // but once turn radius (v/omega) grows large relative to the obstacle, pointing directly
   // away means momentum keeps carrying the ship toward the obstacle while it slowly comes
   // about -- it overshoots the repel zone, and once past the center the "away" direction
   // flips, yanking the heading back the other way: a stable oscillation/orbit around the
   // obstacle instead of a clean pass. The fix is TANGENTIAL steering: aim perpendicular to
   // the obstacle (whichever side is the smaller turn from current heading), so the ship
   // curves around it in one direction instead of fighting a flip-flopping radial target.
   // Use maxSpeed, not current speed, for the turn-radius estimate: a ship that has just
   // collided and stalled to ~0 would otherwise compute turnRadius~0 -> a tiny buffer ->
   // "not near enough to avoid" -> steers straight at the obstacle again next frame -> hits
   // it again -> stays at 0 forever. maxSpeed keeps the safety margin honest regardless of
   // the ship's current (possibly collision-stalled) speed.
   // Buffer scales with turn radius but is capped: with turn rates unchanged while speed
   // tripled, turn radius alone reached 900-1400m for the big classes -- on a 3800m-radius
   // arena with 7 obstacles that meant almost every point on the map had some obstacle
   // "in range", so avoidance permanently overrode combat steering (bots wandering, losing
   // their target, never actually engaging). The cap keeps avoidance a local correction near
   // an obstacle, not a global steering override.
   const turnRadius = bot.maxSpeed / Math.max(0.05, bot.cfg.turnRate || 0.2);
   const speedBuf = clamp(turnRadius * 1.1, 300, 550);
   let best = null;
   for (const o of world.obstacles) {
      const d = dist(bot.pos, o.c);
      const buf = o.r + speedBuf;
      if (d < buf) {
         const toObs = angleOf(sub(o.c, bot.pos));
         const perpCW = toObs + Math.PI / 2, perpCCW = toObs - Math.PI / 2;
         const dir = Math.abs(angleDelta(bot.heading, perpCW)) < Math.abs(angleDelta(bot.heading, perpCCW))
            ? perpCW : perpCCW;
         const w = 1 - d / buf;
         const cand = { heading: dir, throttle: 0.7, w };
         if (!best || cand.w > best.w) best = cand;
      }
   }
   const half = WORLD.ARENA, edgeBuf = clamp(turnRadius * 1.3, 400, 700);
   const edgeD = half - Math.max(Math.abs(bot.pos.x), Math.abs(bot.pos.y));
   if (edgeD < edgeBuf) {
      // steer back toward the center, weighted by how close to the wall we are
      const dir = angleOf(sub({ x: 0, y: 0 }, bot.pos));
      const w = 1 - Math.max(0, edgeD) / edgeBuf;
      const cand = { heading: dir, throttle: 0.7, w };
      if (!best || cand.w > best.w) best = cand;
   }
   if (best) return best;
   return steer;
}

// Nearest enemy shell threatening the bot.
function nearestThreatShell(bot, world) {
   let best = null, bestD = WORLD.THREAT_RANGE;
   for (const s of world.shells) {
      if (s.owner === bot.side) continue;
      const d = dist(s.pos, bot.pos);
      if (d < bestD) { bestD = d; best = s; }
   }
   return best;
}

// ---------- main entry ----------
export function updateBot(bot, world, dt) {
   if (!bot.alive) return;
   bot.stateTime += dt;
   const diff = world.difficulty;

   // recompute conditions
   let nearest = null, nearestD = Infinity;
   for (const e of world.enemiesOf(bot)) {
      const d = dist(bot.pos, e.pos);
      if (d < nearestD) { nearestD = d; nearest = e; }
   }
   const detect = nearest && nearestD < bot.cfg.detect * (diff ? diff.detectMult : 1);
   const threat = nearestThreatShell(bot, world);
   const underFire = !!threat;
   const lowHP = bot.hp < bot.maxHP * WORLD.LOW_HP;
   const critHP = bot.hp < bot.maxHP * WORLD.CRIT_HP;
   const inSmoke = world.inSmoke(bot.pos, bot.side);
   bot.reactionTimer = Math.max(0, bot.reactionTimer - dt);
   // reset the "how long has it been running" clock whenever it isn't fleeing
   if (bot.state !== 'RETREAT') bot.retreatTime = 0;

   // State-independent leash: a ship that has simply survived too long stops
   // denying the fight (fast DDs can otherwise kite the Bismarck forever) and
   // commits to a last stand. This guarantees every match reaches a conclusion.
   // A ship that is the LAST of its side commits immediately — no more stalling.
   bot.aliveT = (bot.aliveT || 0) + dt;
   const alliesLeft = world.bots.filter(b => b !== bot && b.alive).length;
   const commitT = alliesLeft === 0 ? 6 : (COMMIT_TIME[bot.cls] || 160);
   if (!bot.lastStand && bot.aliveT > commitT) {
      bot.lastStand = true;
      if (bot.state !== 'ENGAGE') { bot.state = 'ENGAGE'; bot.stateTime = 0; }
   }

   let steer = { heading: bot.heading, throttle: 0.6 };

   switch (bot.state) {
      case 'STANDBY': {
         bot.patrolTimer = (bot.patrolTimer || 0) + dt;
         if (bot.patrolTimer > 8) {
            bot.patrolTimer = 0;
            const a = Math.random() * TAU, r = 900 + Math.random() * 500;
            bot.patrolPoint = { x: clamp(bot.pos.x + Math.cos(a) * r, -WORLD.ARENA + 200, WORLD.ARENA - 200),
               y: clamp(bot.pos.y + Math.sin(a) * r, -WORLD.ARENA + 200, WORLD.ARENA - 200) };
         }
         steer = seek(bot.patrolPoint, bot.pos);
         if (detect) { bot.target = nearest; bot.reactionTimer = diff ? diff.reactionTime * (bot.cfg.reactionMult || 1) : 0.9; bot.state = 'DETECT'; bot.stateTime = 0; }
         break;
      }
      case 'DETECT': {
         bot.target = nearest || bot.target;
         steer = { heading: bot.aimBearing || angleOf(sub(bot.target.pos, bot.pos)), throttle: 0.7 };
         if (underFire) { bot.state = 'DODGE'; bot.stateTime = 0; break; }
         if (lowHP) { bot.state = 'RETREAT'; bot.stateTime = 0; break; }
         if (bot.reactionTimer <= 0) {
            if (bot.cls === 'DD') { bot.flankSign = sideTowardOpenSpace(bot, world); bot.state = 'FLANK'; }
            else bot.state = 'ENGAGE';
            bot.stateTime = 0;
         }
         break;
      }
      case 'ENGAGE': {
         const target = bot.target && bot.target.alive ? bot.target : nearest;
         bot.target = target;
         if (!target) { bot.state = 'STANDBY'; bot.stateTime = 0; break; }
         const d = dist(bot.pos, target.pos);
         if (bot.lastStand) {
            // Fight to the death. Most enemy classes are FASTER than the Bismarck, so
            // kiting would let them run forever. Instead come straight forward and fight:
            // both sides close in, so the duel converges no matter where it started.
            steer = seek(target.pos, bot.pos);
         } else if (bot.cls === 'DD') steer = flank(target, bot.pos, bot.cfg.flankDeg, bot.flankSign, bot.cfg.prefRange || 550);
         else steer = kite(target, bot.pos, bot.flankSign, bot.cfg.prefRange || 1200); // all gun ships hold their preferred range
         if (bot.cls === 'EB' && !bot.lastStand) steer.throttle = 0.55;
         if (critHP && !bot.lastStand) { bot.state = 'RETREAT'; bot.stateTime = 0; break; }
         if (!bot.lastStand && underFire && Math.random() < (bot.cfg.fire || 0.25) * dt * 4) {
            bot.state = (bot.cls === 'DD') ? 'SMOKE' : 'DODGE'; bot.stateTime = 0; break;
         }
         // fire when ready & in range & roughly facing
         if (target.alive) bot.aimBearing = angleOf(sub(target.pos, bot.pos));
         break;
      }
      case 'FLANK': {
         const target = bot.target && bot.target.alive ? bot.target : nearest;
         bot.target = target;
         if (!target) { bot.state = 'STANDBY'; bot.stateTime = 0; break; }
         steer = flank(target, bot.pos, bot.cfg.flankDeg, bot.flankSign, bot.cfg.prefRange || 550);
         if (bot.cls === 'DD') {
            const d = dist(bot.pos, target.pos);
            const crossAngle = Math.abs(angleDelta(bot.heading, angleOf(sub(target.pos, bot.pos))));
            if (d < bot.cfg.torp.range && crossAngle < 35 * DEG) {
               bot.fireTorpedo(world, target, sub(target.pos, bot.pos));
               bot.flankSign *= -1;
            }
         }
         if (underFire) { bot.state = 'DODGE'; bot.stateTime = 0; break; }
         if (lowHP && !bot.lastStand) { bot.state = 'RETREAT'; bot.stateTime = 0; break; }
         if (dist(bot.pos, bot.target.pos) < (bot.cfg.prefRange || 600) * 1.2) { bot.state = 'ENGAGE'; bot.stateTime = 0; }
         break;
      }
      case 'DODGE': {
         const t = nearestThreatShell(bot, world);
         if (t) {
            const perp = angleOf(t.vel) + Math.PI / 2;
            steer = { heading: perp, throttle: 1 };
         } else steer = flee(nearest || bot.pos, bot.pos);
         if (bot.stateTime > 2.0 && !underFire) { bot.state = lowHP ? 'RETREAT' : 'ENGAGE'; bot.stateTime = 0; }
         break;
      }
      case 'SMOKE': {
         if (bot.smoke.cd <= 0 && !bot.smoke.active) {
            bot.smoke.active = true; bot.smoke.t = WORLD.SMOKE_DURATION; bot.smoke.cd = WORLD.SMOKE_CD + WORLD.SMOKE_DURATION;
         }
         // run into the smoke to break detection
         const cloud = world.smokeCloudAt(bot.pos, bot.side);
         steer = cloud ? seek(cloud, bot.pos) : flee(bot.target || bot.pos, bot.pos);
         if (bot.stateTime > WORLD.SMOKE_DURATION + 1) {
            bot.state = lowHP ? 'RETREAT' : 'ENGAGE'; bot.stateTime = 0;
         }
         break;
      }
      case 'RETREAT': {
         const threat = world.nearestThreatPos(bot);
         // Last stand: a ship that has been running too long (or is pinned at the
         // arena edge) stops kiting and fights to the death. Guarantees every match
         // ends — a fast DD can no longer outrun the Bismarck forever.
         bot.retreatTime = (bot.retreatTime || 0) + dt;
         const nearEdge = Math.abs(bot.pos.x) > WORLD.ARENA - 700 || Math.abs(bot.pos.y) > WORLD.ARENA - 700;
         const chased = world.nearestThreat(bot) < 1600;
         if (bot.retreatTime > 40 || (nearEdge && chased)) {
            bot.lastStand = true;
            bot.state = 'ENGAGE'; bot.stateTime = 0; break;
         }
         steer = flee(threat || bot.pos, bot.pos);
         bot.repairTimer += dt;
         // A bot only ever ENTERS RETREAT while lowHP (<40%), so the old "hp > 50%" gate
         // here was unreachable — the REPAIR state never fired and bots limped back into
         // fights permanently damaged. Repair once you've been running a moment AND are
         // still hurt; the REPAIR state itself re-checks danger before sitting down.
         if (bot.repairTimer > 3 && bot.hp < bot.maxHP * 0.85) {
            bot.state = 'REPAIR'; bot.stateTime = 0;
         }
         break;
      }
      case 'REPAIR': {
         // don't sit still while being hunted — re-engage or keep running
         if (underFire || world.nearestThreat(bot) < 900) {
            bot.repairTimer = 0; // don't instantly re-enter REPAIR next frame
            bot.state = lowHP ? 'RETREAT' : 'ENGAGE'; bot.stateTime = 0; break;
         }
         const safe = world.safeZone(bot);
         steer = seek(safe, bot.pos);
         steer.throttle = 0.5;
         bot.repairAll();
         if (bot.hp > bot.maxHP * 0.85) { bot.state = 'STANDBY'; bot.stateTime = 0; }
         break;
      }
   }

   // Obstacle avoidance overrides
   steer = avoidObstacles(bot, world, steer);

   // group cohesion: cruisers/DDs loosely follow the EB
   if (bot.cls === 'LC' || bot.cls === 'HC' || bot.cls === 'DD') {
      const eb = world.enemyLeader(bot);
      if (eb && eb.alive && bot.state !== 'DODGE' && bot.state !== 'RETREAT') {
         const d = dist(eb.pos, bot.pos);
         if (d > 600 && d < 1800) {
            const toEb = angleOf(sub(eb.pos, bot.pos));
            steer.heading = approachAngle(steer.heading, toEb, 0.05); // gentle pull toward formation
         }
      }
   }
   // separation
   steer = applySeparation(bot, world, steer);

   // apply steering to the ship
   bot.helm = clamp((angleDelta(bot.heading, steer.heading) * 2.2), -1, 1);
   bot.throttleIn = clamp(steer.throttle, -1, 1);
   bot.aimBearing = bot.state === 'ENGAGE' || bot.state === 'FLANK'
      ? angleOf(sub((bot.target || nearest || bot.pos).pos, bot.pos))
      : steer.heading;

   // firing (shared lead/shell model, difficulty-scaled)
   if (bot.state === 'ENGAGE' || bot.state === 'FLANK') {
      const target = bot.target && bot.target.alive ? bot.target : nearest;
      if (target && bot.alive) bot._maybeFire(world, target, dt);
   }
}

// A bot fires when its timer is up, in range, in cone, and gun is "warmed up".
Ship.prototype._maybeFire = function (world, target, dt) {
   // fireTimer is already decremented in ship.js update() — don't double it here.
   if (this.fireTimer > 0) return;
   // Smoke used to only intercept shells already in flight (combat.js) -- it never stopped
   // a shooter from acquiring/tracking a smoked target in the first place, so bots kept
   // firing dead-accurate lead shots at a ship that was supposed to be invisible. Real
   // smoke breaks targeting outright: a target sitting in a cloud that isn't its own side's
   // cannot be fired on at all -- this is what makes ducking into smoke actually work as an
   // escape, instead of merely giving incoming shells a random chance to be intercepted.
   if (world.inSmoke(target.pos, target.side)) return;
   const d = dist(this.pos, target.pos);
   const bearing = angleOf(sub(target.pos, this.pos));
   // the TURRET must face the target (hull may kite at 90°); any ready turret in cone suffices
   let inCone = false;
   for (const t of this.turrets) {
      if (Math.abs(angleDelta(this.heading + t.bearing, bearing)) < WORLD.DETECT_CONE) { inCone = true; break; }
   }
   const inRange = d < this.cfg.main.range;
   const warm = this.stateTime > 0.25;
   if (inCone && inRange && warm) {
      // fireMain expects a direction VECTOR, not an angle — wrap the lead angle
      this.fireMain(world, target, fromAngle(bearingToDir(bearing, target, this, world)));
   }
};

// lead the target with shell time-of-flight + reaction
function bearingToDir(bearing, target, bot, world) {
   const diff = world.difficulty;
   const d = dist(bot.pos, target.pos);
   const vShell = bot.cfg.main.vShell || 650;
   let leadT = d / vShell + (diff ? diff.reactionTime : 0.9);
   leadT *= (diff ? diff.leadQuality : 0.7);
   const pred = add(target.pos, scale(target.vel, leadT));
   return angleOf(sub(pred, bot.pos));
}

function scale(v, s) { return { x: v.x * s, y: v.y * s }; }

function sideTowardOpenSpace(bot, world) {
   // pick the flank side whose approach point is farthest from our own leader —
   // spreads the DDs across both flanks instead of stacking them on one side
   const leader = world.enemyLeader(bot);
   if (!leader || !bot.target) return bot.flankSign;
   const bearing = angleOf(sub(bot.target.pos, bot.pos));
   const r = bot.cfg.prefRange || 550;
   const d1 = dist(add(bot.target.pos, fromAngle(bearing + 90 * DEG, r)), leader.pos);
   const d2 = dist(add(bot.target.pos, fromAngle(bearing - 90 * DEG, r)), leader.pos);
   return d1 >= d2 ? 1 : -1;
}

function applySeparation(bot, world, steer) {
   let sx = 0, sy = 0;
   const R = 250;
   for (const o of world.enemiesOf(bot)) {
      if (o === bot || !o.alive) continue;
      const d = dist(bot.pos, o.pos);
      if (d < R && d > 0) {
         const w = (1 - d / R);
         sx += (bot.pos.x - o.pos.x) / d * w;
         sy += (bot.pos.y - o.pos.y) / d * w;
      }
   }
   if (sx || sy) {
      const away = angleOf({ x: sx, y: sy });
      steer.heading = approachAngle(steer.heading, away, 0.3);
   }
   return steer;
}

// ---- minimal Ship ref so _maybeFire can attach (avoid import cycle at load) ----
import { Ship } from './ship.js';
