// game/ai.js — enemy bot behaviour: steering primitives + a finite-state machine driven by the
// per-class profile in SHIPS[cls].ai (role, leash, smoke use, hidden-target tactics).
// Bots only know what their side has spotted (ship.visible / ship.lastKnown, see state.js):
// a hidden target can't be locked, only area-fired at its dead-reckoned position or hunted.
import { sub, add, fromAngle, angleOf, angleDelta, dist, clamp, approachAngle, randn, TAU, DEG } from './utils.js';
import { WORLD, VISION, COMBAT } from './config.js';
import { beltIncidence } from './combat.js';

const NO_AI = {};

// ---------- steering primitives (pure) ----------
// Each returns {heading, throttle}.
function seek(target, from) { return { heading: angleOf(sub(target, from)), throttle: 1 }; }
// sub(from, target) already points AWAY from the threat — no extra PI.
function flee(target, from) { return { heading: angleOf(sub(from, target)), throttle: 1 }; }
function flank(target, from, angleDeg, side, prefRange) {
   const bearing = angleOf(sub(target, from));
   const aim = add(target, fromAngle(bearing + Math.PI + side * angleDeg * DEG, prefRange));
   return seek(aim, from);
}
function kite(target, from, side, prefRange) {
   const bearing = angleOf(sub(target, from));
   const d = dist(target, from);
   const perp = bearing + side * (Math.PI / 2);
   // too far -> bend the orbit inward (toward the bearing), too close -> outward
   const radial = clamp((d - prefRange) / prefRange, -1, 1);
   return { heading: perp - side * clamp(radial * 1.1, -0.9, 0.9), throttle: 1 };
}

// Obstacle + arena-edge avoidance (highest priority). Steers TANGENTIALLY around an obstacle
// (radial "point away" flips sides as the ship passes the centre and oscillates at these turn
// radii). Buffer uses maxSpeed so a collision-stalled ship keeps an honest margin, and is capped
// so avoidance stays a local correction instead of overriding combat steering map-wide.
function avoidObstacles(bot, world, steer) {
   const turnRadius = bot.maxSpeed / Math.max(0.05, bot.cfg.turnRate || 0.2);
   const speedBuf = clamp(turnRadius * 1.1, 300, 550);
   let best = null;
   for (const o of world.obstacles) {
      const d = dist(bot.pos, o.c);
      // reefs only slow a ship down: skirt them, don't give them an island's berth
      const buf = o.r + (o.kind === 'reef' ? 150 : speedBuf);
      if (d < buf) {
         const toObs = angleOf(sub(o.c, bot.pos));
         const perpCW = toObs + Math.PI / 2, perpCCW = toObs - Math.PI / 2;
         const dir = Math.abs(angleDelta(bot.heading, perpCW)) < Math.abs(angleDelta(bot.heading, perpCCW)) ? perpCW : perpCCW;
         const w = 1 - d / buf;
         if (!best || w > best.w) best = { heading: dir, throttle: 0.7, w };
      }
   }
   const edgeBuf = clamp(turnRadius * 1.3, 400, 700);
   const edgeD = WORLD.ARENA - Math.max(Math.abs(bot.pos.x), Math.abs(bot.pos.y));
   if (edgeD < edgeBuf) {
      const w = 1 - Math.max(0, edgeD) / edgeBuf;
      if (!best || w > best.w) best = { heading: angleOf(sub({ x: 0, y: 0 }, bot.pos)), throttle: 0.7, w };
   }
   return best || steer;
}

// Nearest enemy shell/torpedo threatening the bot (shells are visible in flight).
function nearestThreatShell(bot, world) {
   let best = null, bestD = WORLD.THREAT_RANGE;
   for (const s of world.shells) {
      if (s.owner === bot.side) continue;
      const d = dist(s.pos, bot.pos);
      if (d < bestD) { bestD = d; best = s; }
   }
   return best;
}

// What the bot's side knows about `t`: exact when spotted, dead-reckoned from the last sighting
// otherwise. null = no contact at all.
export function perceive(world, t) {
   if (!t || !t.alive) return null;
   if (t.visible) return { ship: t, pos: t.pos, vel: t.vel, seen: true, age: 0 };
   const lk = t.lastKnown;
   if (!lk) return null;
   const age = world.time - lk.t;
   return { ship: t, pos: world.estimatePos(t), vel: lk.vel, seen: false, age, lastPos: lk.pos };
}

function pickTarget(bot, world) {
   let best = null, bestD = Infinity;
   for (const e of world.enemiesOf(bot)) {
      const k = perceive(world, e);
      if (!k) continue;
      // a spotted ship is always a better target than a ghost
      const d = dist(bot.pos, k.pos) + (k.seen ? 0 : 1500);
      if (d < bestD) { bestD = d; best = k; }
   }
   return best;
}

// Lead point for a projectile of speed v (two fixed-point iterations are plenty here).
function leadPoint(from, pos, vel, v, quality = 1) {
   let t = dist(from, pos) / v;
   let p = pos;
   for (let i = 0; i < 2; i++) {
      p = add(pos, { x: vel.x * t * quality, y: vel.y * t * quality });
      t = dist(from, p) / v;
   }
   return p;
}

// AP vs a broadside target it can actually penetrate, HE otherwise (angled / overmatched / DD).
function chooseAmmo(bot, world, k) {
   const A = bot.cfg.main.ammo;
   if (!A || !A.AP || !A.HE || !k.seen) return;
   const armor = k.ship.cfg.armor || 100;
   const margin = A.AP.ap / armor - 1;
   const inc = beltIncidence(k.ship, sub(k.ship.pos, bot.pos));
   const want = margin > -0.1 && margin < COMBAT.overPen && inc < COMBAT.ricStart ? 'AP' : 'HE';
   // hysteresis: the switch costs reload, don't flip-flop every salvo
   if (want !== bot.ammo && world.time - (bot._ammoT ?? -99) > 10) { bot.setAmmo(want); bot._ammoT = world.time; }
}

// ---------- main entry ----------
export function updateBot(bot, world, dt) {
   if (!bot.alive) return;
   bot.stateTime += dt;
   const diff = world.difficulty;
   const ai = bot.cfg.ai || NO_AI;

   const k = pickTarget(bot, world);
   const kd = k ? dist(bot.pos, k.pos) : Infinity;
   // "contact" = spotted, or recently lost; "detect" = something to react to at all
   const contact = k && (k.seen || k.age < VISION.searchAfter + VISION.blindWindow);
   const threat = nearestThreatShell(bot, world);
   const underFire = !!threat;
   const lowHP = bot.hp < bot.maxHP * WORLD.LOW_HP;
   const critHP = bot.hp < bot.maxHP * WORLD.CRIT_HP;
   bot.reactionTimer = Math.max(0, bot.reactionTimer - dt);
   if (bot.state !== 'RETREAT') bot.retreatTime = 0;
   if (k) bot.target = k.ship;

   // Leash: a ship that has survived too long stops denying the fight and commits to a last
   // stand (fast DDs could otherwise kite forever). The last ship of a side commits at once.
   bot.aliveT = (bot.aliveT || 0) + dt;
   const alliesLeft = world.alliesOf(bot).length;
   const commitT = alliesLeft === 0 ? 6 : (ai.commitTime || 160);
   if (!bot.lastStand && bot.aliveT > commitT) {
      bot.lastStand = true;
      if (bot.state !== 'ENGAGE') { bot.state = 'ENGAGE'; bot.stateTime = 0; }
   }

   consumableLogic(bot, world, ai, k, underFire, dt);

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
         if (contact) {
            bot.reactionTimer = (diff ? diff.reactionTime : 0.9) * (bot.cfg.reactionMult || 1);
            bot.state = 'DETECT'; bot.stateTime = 0;
         }
         break;
      }
      case 'DETECT': {
         if (!k) { bot.state = 'STANDBY'; bot.stateTime = 0; break; }
         steer = { heading: angleOf(sub(k.pos, bot.pos)), throttle: 0.7 };
         if (underFire) { bot.state = 'DODGE'; bot.stateTime = 0; break; }
         if (lowHP) { bot.state = 'RETREAT'; bot.stateTime = 0; break; }
         if (bot.reactionTimer <= 0) {
            if (ai.role === 'torpedo') { bot.flankSign = sideTowardOpenSpace(bot, world, k); bot.state = 'FLANK'; }
            else bot.state = 'ENGAGE';
            bot.stateTime = 0;
         }
         break;
      }
      case 'ENGAGE': {
         if (!k) { bot.state = 'STANDBY'; bot.stateTime = 0; break; }
         if (!k.seen && !bot.lastStand && k.age > VISION.searchAfter) { bot.state = 'SEARCH'; bot.stateTime = 0; break; }
         if (bot.lastStand) steer = seek(k.pos, bot.pos); // fight to the death: close in, duel converges
         else if (!k.seen && ai.reposition && k.age > 2) {
            // target vanished into smoke: swing round the cloud for a new sight line
            steer = flank(k.pos, bot.pos, 75, bot.flankSign, bot.cfg.prefRange || 1000);
         } else if (ai.role === 'torpedo') steer = flank(k.pos, bot.pos, bot.cfg.flankDeg, bot.flankSign, bot.cfg.prefRange || 550);
         else steer = kite(k.pos, bot.pos, bot.flankSign, bot.cfg.prefRange || 1200);
         if (ai.holdThrottle && !bot.lastStand) steer.throttle = ai.holdThrottle;
         if (critHP && !bot.lastStand) { bot.state = 'RETREAT'; bot.stateTime = 0; break; }
         if (!bot.lastStand && underFire && Math.random() < 0.25 * dt * 4) {
            bot.state = ai.smokeChance && bot.canUse('smoke') && Math.random() < ai.smokeChance ? 'SMOKE' : 'DODGE';
            bot.stateTime = 0; break;
         }
         break;
      }
      case 'FLANK': {
         if (!k) { bot.state = 'STANDBY'; bot.stateTime = 0; break; }
         steer = flank(k.pos, bot.pos, bot.cfg.flankDeg, bot.flankSign, bot.cfg.prefRange || 550);
         if (underFire) { bot.state = 'DODGE'; bot.stateTime = 0; break; }
         if (lowHP && !bot.lastStand) { bot.state = 'RETREAT'; bot.stateTime = 0; break; }
         if (kd < (bot.cfg.prefRange || 600) * 1.2) { bot.state = 'ENGAGE'; bot.stateTime = 0; }
         break;
      }
      case 'SEARCH': {
         // lost contact: hunters sweep in on the last known position (proximity spotting finds a
         // ship inside smoke), everyone else circles to open a sight line
         if (!k) { bot.state = 'STANDBY'; bot.stateTime = 0; break; }
         if (k.seen) { bot.state = 'ENGAGE'; bot.stateTime = 0; break; }
         const goal = k.lastPos || k.pos;
         steer = ai.huntHidden ? seek(goal, bot.pos) : flank(goal, bot.pos, 80, bot.flankSign, (bot.cfg.prefRange || 1000) * 0.8);
         if (dist(bot.pos, goal) < 250 || bot.stateTime > 30) {
            // nothing there: give up the trail and go back to patrolling
            bot.target = null; bot.state = 'STANDBY'; bot.stateTime = 0;
            if (k.ship.lastKnown) k.ship.lastKnown.t = -1e9;
         }
         if (underFire) { bot.state = 'DODGE'; bot.stateTime = 0; }
         break;
      }
      case 'DODGE': {
         const t = nearestThreatShell(bot, world);
         if (t) steer = { heading: angleOf(t.vel) + Math.PI / 2, throttle: 1 };
         else steer = flee(k ? k.pos : bot.pos, bot.pos);
         if (bot.stateTime > 2.0 && !underFire) { bot.state = lowHP ? 'RETREAT' : 'ENGAGE'; bot.stateTime = 0; }
         break;
      }
      case 'SMOKE': {
         // lay smoke, then loiter slowly inside it: unspotted unless the enemy closes to proximity
         if (!bot.smoke.active && bot.stateTime < 0.2) bot.useConsumable('smoke');
         const cloud = world.smokeCloudAt(bot.pos, bot, 900);
         if (cloud) {
            const d = dist(bot.pos, cloud.c);
            steer = { heading: angleOf(sub(cloud.c, bot.pos)), throttle: d > cloud.r * 0.4 ? 0.6 : WORLD.MIN_THROTTLE };
         } else steer = flee(k ? k.pos : bot.pos, bot.pos);
         const spotted = bot.visible && bot.visReason === 'prox';
         if (spotted || bot.stateTime > (bot.smoke.cfg ? bot.smoke.cfg.dur : 8) + 8 || (!cloud && bot.stateTime > 2)) {
            bot.state = lowHP ? 'RETREAT' : 'ENGAGE'; bot.stateTime = 0;
         }
         break;
      }
      case 'RETREAT': {
         const threatPos = world.nearestThreatPos(bot);
         // a ship that has been running too long (or is pinned at the edge) turns and fights
         bot.retreatTime = (bot.retreatTime || 0) + dt;
         const nearEdge = Math.abs(bot.pos.x) > WORLD.ARENA - 700 || Math.abs(bot.pos.y) > WORLD.ARENA - 700;
         const chased = world.nearestThreat(bot) < 1600;
         if (bot.retreatTime > 40 || (nearEdge && chased)) {
            bot.lastStand = true;
            bot.state = 'ENGAGE'; bot.stateTime = 0; break;
         }
         steer = flee(threatPos || bot.pos, bot.pos);
         bot.repairTimer += dt;
         // bots enter RETREAT below LOW_HP, so repair once running a moment and still hurt
         if (bot.repairTimer > 3 && bot.hp < bot.maxHP * 0.85) { bot.state = 'REPAIR'; bot.stateTime = 0; }
         break;
      }
      case 'REPAIR': {
         if (underFire || world.nearestThreat(bot) < 900) {
            bot.repairTimer = 0; // don't instantly re-enter REPAIR next frame
            bot.state = lowHP ? 'RETREAT' : 'ENGAGE'; bot.stateTime = 0; break;
         }
         steer = seek(world.safeZone(bot), bot.pos);
         steer.throttle = 0.5;
         bot.repairAll();
         if (bot.hp > bot.maxHP * 0.85) { bot.state = 'STANDBY'; bot.stateTime = 0; }
         break;
      }
   }

   steer = avoidObstacles(bot, world, steer);

   // loose formation on the squad's battleship
   if (ai.role !== 'battleship') {
      const lead = world.enemyLeader(bot);
      if (lead && bot.state !== 'DODGE' && bot.state !== 'RETREAT' && bot.state !== 'SMOKE') {
         const d = dist(lead.pos, bot.pos);
         if (d > 600 && d < 1800) steer.heading = approachAngle(steer.heading, angleOf(sub(lead.pos, bot.pos)), 0.05);
      }
   }
   steer = applySeparation(bot, world, steer);

   bot.helm = clamp(angleDelta(bot.heading, steer.heading) * 2.2, -1, 1);
   bot.throttleIn = clamp(steer.throttle, -1, 1);

   // ---- weapons ----
   const combat = bot.state === 'ENGAGE' || bot.state === 'FLANK' || bot.state === 'SMOKE'
      || (bot.state === 'DODGE' && bot.stateTime > 0.5) || bot.state === 'SEARCH';
   if (k && combat) {
      weapons(bot, world, k, ai, dt);
   } else {
      bot.aimBearing = k ? angleOf(sub(k.pos, bot.pos)) : bot.heading;
   }
}

// Guns + torpedoes. A spotted target gets an aimed, led salvo. A hidden one only gets blind area
// fire at its dead-reckoned position (much wider spread, slower cadence) while the trail is fresh.
function weapons(bot, world, k, ai, dt) {
   const diff = world.difficulty;
   const m = bot.cfg.main;
   const d = dist(bot.pos, k.pos);
   const q = diff ? diff.leadQuality : 0.7;
   const aim = k.seen ? leadPoint(bot.pos, k.pos, k.vel, m.vShell || 650, q) : k.pos;
   bot.aimBearing = angleOf(sub(aim, bot.pos));

   // torpedoes: led at the (estimated) target, into smoke too if the class does that
   if (bot.cfg.torp && (k.seen || (ai.torpSmoke && k.age < VISION.blindWindow))) {
      const T = bot.cfg.torp;
      if (d < T.range * 0.9 && bot.stateTime > 0.4) {
         const tAim = leadPoint(bot.pos, k.pos, k.vel, T.speed, q);
         const dir = fromAngle(angleOf(sub(tAim, bot.pos)));
         const l = bot.launcherFor(angleOf(dir));
         if (l && l.cd <= 0 && bot.fireTorpedo(world, k.ship, dir)) bot.flankSign *= -1;
      }
   }

   if (bot.fireTimer > 0 || bot.stateTime < 0.25 || d > m.range) return;
   // a stealthy torpedo boat doesn't give itself away with gunfire from long range
   if (!bot.visible && ai.role === 'torpedo' && d > (bot.cfg.prefRange || 550) * 1.3) return;
   // no gunfire out of our own smoke unless the class is built for it (cruisers "smoke-firing")
   if (bot.state === 'SMOKE' && !ai.smokeFire && !(bot.visible && bot.visReason === 'prox')) return;
   if (k.seen) {
      chooseAmmo(bot, world, k);
      bot.fireMain(world, k.ship, fromAngle(bot.aimBearing), { aimPoint: aim });
   } else if (k.age < VISION.blindWindow) {
      // area fire into the smoke: a couple of turrets, wide spread, long pauses
      const jitter = { x: k.pos.x + randn() * 60, y: k.pos.y + randn() * 60 };
      bot.fireMain(world, k.ship, fromAngle(bot.aimBearing), {
         aimPoint: jitter, spreadMult: VISION.blindSpread, reloadMult: VISION.blindReloadMult, maxTurrets: 2, blind: true });
   }
}

// Damage control on fires/floods, smoke when hurt under fire (profile), with a human-ish delay.
function consumableLogic(bot, world, ai, k, underFire, dt) {
   bot._consDelay = (bot._consDelay ?? 1 + Math.random()) - dt;
   if (bot._consDelay > 0) return;
   const burning = bot.fires.length + bot.floods.length * 2;
   if (burning >= 2 && bot.canUse('dc')) { bot.useConsumable('dc'); bot._consDelay = 1.5; return; }
   if (ai.smokeChance && bot.visible && bot.canUse('smoke') && bot.state !== 'SMOKE'
      && (underFire || bot.state === 'RETREAT') && bot.hp < bot.maxHP * (ai.smokeHP || 0.5)) {
      if (Math.random() < ai.smokeChance) { bot.state = 'SMOKE'; bot.stateTime = 0; }
      bot._consDelay = 3;
   }
}

function sideTowardOpenSpace(bot, world, k) {
   // flank on the side farthest from our own leader: spreads the DDs across both flanks
   const leader = world.enemyLeader(bot);
   if (!leader || !k) return bot.flankSign;
   const bearing = angleOf(sub(k.pos, bot.pos));
   const r = bot.cfg.prefRange || 550;
   const d1 = dist(add(k.pos, fromAngle(bearing + 90 * DEG, r)), leader.pos);
   const d2 = dist(add(k.pos, fromAngle(bearing - 90 * DEG, r)), leader.pos);
   return d1 >= d2 ? 1 : -1;
}

function applySeparation(bot, world, steer) {
   let sx = 0, sy = 0;
   const R = 250;
   for (const o of world.alliesOf(bot)) {
      const d = dist(bot.pos, o.pos);
      if (d < R && d > 0) {
         const w = 1 - d / R;
         sx += (bot.pos.x - o.pos.x) / d * w;
         sy += (bot.pos.y - o.pos.y) / d * w;
      }
   }
   if (sx || sy) steer.heading = approachAngle(steer.heading, angleOf({ x: sx, y: sy }), 0.3);
   return steer;
}
