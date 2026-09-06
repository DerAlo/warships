// game/ship.js — the shared ship integrator (player + bots) plus the Bismarck weapon model.
// Movement has weight/inertia so it feels like a 45,000-ton warship, not an arcade car.
import { add, sub, scale, fromAngle, angleOf, angleDelta, clamp, approach, fromAngle as pol,
   clamp01, smoothstep, TAU, DEG } from './utils.js';
import { WORLD, SHIPS, COMBAT } from './config.js';

// Build the turret layout for a ship. Bismarck: 4 turrets x 2 guns (A,B forward; X,Y aft).
function buildTurrets(cls) {
   const c = SHIPS[cls];
   const guns = c.main.guns;
   if (cls === 'Bismarck') {
      return [
         { off: { x: 42, y: 0 }, guns: 2, cd: 0, bearing: 0 }, // A forward
         { off: { x: 24, y: 0 }, guns: 2, cd: 0, bearing: 0 }, // B forward
         { off: { x: -30, y: 0 }, guns: 2, cd: 0, bearing: 0 }, // X aft
         { off: { x: -44, y: 0 }, guns: 2, cd: 0, bearing: 0 }, // Y aft
      ];
   }
   if (cls === 'EB') {
      return [
         { off: { x: 30, y: 0 }, guns: 3, cd: 0, bearing: 0 },
         { off: { x: -30, y: 0 }, guns: 3, cd: 0, bearing: 0 },
      ];
   }
   if (cls === 'HC' || cls === 'LC') {
      const n = Math.ceil(guns / 2);
      const arr = [];
      for (let i = 0; i < n; i++) arr.push({ off: { x: 20 - i * 18, y: (i % 2 ? -1 : 1) * 8 }, guns: 2, cd: 0, bearing: 0 });
      return arr;
   }
   // DD: single or twin forward
   return [ { off: { x: 18, y: 0 }, guns: Math.min(2, guns), cd: 0, bearing: 0 } ];
}

let ID = 0;
export class Ship {
   constructor(world, cls, side, pos, heading = 0, opts = {}) {
      this.world = world;
      this.cls = cls;
      this.cfg = SHIPS[cls];
      this.side = side;               // 'player' | 'enemy'
      this.name = this.cfg.name;
      this.color = this.cfg.color;
      this.id = ++ID;
      this.pos = { x: pos.x, y: pos.y };
      this.heading = heading;
      this.speed = 0;
      this.throttle = WORLD.MIN_THROTTLE;
      this.throttleTarget = WORLD.MIN_THROTTLE;
      this.angularVel = 0;
      this.vel = fromAngle(heading, 0);
      this.maxHP = this.cfg.hp * (opts.hpMult || 1);
      this.hp = this.maxHP;
      this.dmgMult = opts.dmgMult || 1;   // rider on outgoing damage (difficulty)
      this.turrets = buildTurrets(cls);
      // timers
      this.fireTimer = 0;
      this.secTimer = 0;
      this.torpTimer = this.cfg.torp ? this.cfg.torp.cd : 0;
      this.aaTimer = 0;
      // boost
      this.boost = { active: false, t: 0, cd: 0 };
      // smoke
      this.smoke = { active: false, t: 0, cd: 0 };
      // damage modules
      this.fires = [];   // { mod, heat, spreadT, t }
      this.floods = [];  // { mod, t }
      this.repairT = 0;  // seconds of active repair-crew healing left
      // control (for bots; overwritten by AI controller each tick)
      this.helm = 0;
      this.throttleIn = WORLD.MIN_THROTTLE;
      // AI
      this.state = 'STANDBY';
      this.stateTime = 0;
      this.target = null;
      this.flankSign = Math.random() < 0.5 ? 1 : -1;
      this.reactionTimer = 0;
      this.patrolPoint = { x: pos.x, y: pos.y };
      // stats
      this.dmgDealt = 0;
      this.dmgTaken = 0;
      this.shotsFired = 0;
      this.shotsHit = 0;
      // visual
      this.wakePhase = Math.random() * 10;
      this.aim = { x: 1, y: 0 }; // current aim direction (unit)
      this.lastFireDir = 0;
      this.hitFlash = 0;
      this.aimBearing = 0; // desired turret absolute bearing
      this.alive = true;
      // repair rate
      this.repairTimer = 0;
   }

   get maxSpeed() {
      let s = this.cfg.maxSpeed;
      if (this.boost.active) s *= this.cfg.boost ? this.cfg.boost.mult : 1;
      s *= (1 - Math.min(0.5, this.floods.length * COMBAT.flood.slow));
      return s;
   }

   get speedKnots() { return Math.abs(this.speed) * 1.94384; }

   update(dt) {
      if (!this.alive) return;
      // ---- movement integration (weighty) ----
      const helm = clamp(this.helm, -1, 1);
      // turn effectiveness: needs flow
      const flow = clamp(this.speed / 6, 0, 1);
      const targetOmega = helm * this.cfg.turnRate * (0.4 + 0.6 * flow);
      const turnAccel = 0.9; // rad/s^2-ish slew
      this.angularVel = approach(this.angularVel, targetOmega, turnAccel * dt * (0.5 + 0.5 * flow));
      this.heading += this.angularVel * dt;
      this.heading = ((this.heading % TAU) + TAU) % TAU;

      // throttle: ramp toward target with inertia
      const tTarget = clamp(this.throttleIn, -1, 1);
      const throttleAccel = tTarget >= 0 ? 0.28 : 0.45; // astern bites harder
      this.throttle = approach(this.throttle, tTarget, throttleAccel * dt);
      if (this.throttle < 0.12 && tTarget >= 0) this.throttle = WORLD.MIN_THROTTLE; // keep way
      // crash stop (space) handled by controller setting throttleIn=-1
      // Acceleration scales with each ship's OWN top speed so every class reaches flank
      // speed in roughly the same real time (~8s ahead / ~5s braking) instead of a fixed
      // 0.55 m/s^2 that made the 18 m/s Bismarck take ~33s to get moving — it was there,
      // but the helm didn't feel connected to the throttle at all.
      const spdAccel = this.maxSpeed / (this.throttle >= 0 ? 8 : 5);
      this.speed = approach(this.speed, this.throttle * this.maxSpeed, dt * spdAccel);

      this.vel = fromAngle(this.heading, this.speed);
      this.pos = add(this.pos, scale(this.vel, dt));

      // clamp to arena
      const half = WORLD.ARENA;
      if (this.pos.x < -half) { this.pos.x = -half; this.speed *= 0.5; }
      if (this.pos.x > half) { this.pos.x = half; this.speed *= 0.5; }
      if (this.pos.y < -half) { this.pos.y = -half; this.speed *= 0.5; }
      if (this.pos.y > half) { this.pos.y = half; this.speed *= 0.5; }

      // ---- terrain: islands are solid rock, reefs are shallow water ----
      for (const o of this.world.obstacles) {
         const ddx = this.pos.x - o.c.x, ddy = this.pos.y - o.c.y;
         const dd = Math.hypot(ddx, ddy);
         if (o.kind === 'island') {
            const R = o.r + 24; // hull margin so the bow doesn't clip into the beach
            if (dd < R && dd > 0.001) {
               // shove back onto the shoreline...
               const nx = ddx / dd, ny = ddy / dd; // outward normal
               this.pos.x = o.c.x + nx * R;
               this.pos.y = o.c.y + ny * R;
               // ...and redirect (not just shrink) velocity: drop the component driving
               // INTO the rock, keep the tangential component so the hull scrapes along
               // the coastline instead of parking nose-first on the beach. A naive
               // uniform speed*=k here left the ship pinned exactly on the boundary
               // forever whenever steering kept pointing at the island -- each frame
               // re-collided and re-decayed speed toward 0 before throttle could rebuild
               // it, a stable near-standstill that could stall an entire match.
               const vn = this.vel.x * nx + this.vel.y * ny; // < 0 = moving into the rock
               if (vn < 0) {
                  const tx = this.vel.x - vn * nx, ty = this.vel.y - vn * ny;
                  const tSpeed = Math.hypot(tx, ty) * 0.7; // scraping friction
                  if (tSpeed > 0.5) { this.heading = angleOf({ x: tx, y: ty }); this.speed = tSpeed; }
                  else this.speed = 0;
                  this.vel = fromAngle(this.heading, this.speed);
               }
            }
         } else if (o.kind === 'reef') {
            // shallow water: no hard wall, but the hull drags and tops out well below flank
            if (dd < o.r) this.speed = Math.min(this.speed, this.maxSpeed * WORLD.REEF_SPEED_CAP);
         }
      }

      // ---- turrets slew toward aim ----
      const slew = 0.14; // rad/s
      for (const t of this.turrets) {
         if (t.cd > 0) t.cd -= dt;
         // aim: slew relative bearing toward the desired relative bearing
         const desiredRel = angleDelta(this.heading, this.aimBearing);
         t.bearing = approach(t.bearing, desiredRel, slew * dt);
      }

      // ---- weapon cooldowns ----
      if (this.fireTimer > 0) this.fireTimer -= dt;
      if (this.secTimer > 0) this.secTimer -= dt;
      if (this.torpTimer > 0) this.torpTimer -= dt;
      if (this.aaTimer > 0) this.aaTimer -= dt;

      // ---- boost / smoke timers ----
      if (this.boost.cd > 0) this.boost.cd -= dt;
      if (this.boost.active) { this.boost.t -= dt; if (this.boost.t <= 0) { this.boost.active = false; this.boost.cd = this.cfg.boost ? this.cfg.boost.cd : 12; } }
      if (this.smoke.cd > 0) this.smoke.cd -= dt;
      if (this.smoke.active) {
         this.smoke.t -= dt;
         this.world.emitSmokePuff(this, dt);
         if (this.smoke.t <= 0) this.smoke.active = false;
      }
      this.hitFlash = Math.max(0, this.hitFlash - dt * 3);

      // ---- damage over time: fire + flood ----
      this._applyDoT(dt);

      // ---- repair timers ----
      if (this.repairT > 0) this.repairT -= dt;
      if (this.side === 'enemy' && this.state === 'REPAIR') this.repairTimer += dt;

      // ---- death ----
      if (this.hp <= 0 && this.alive) this._sink();
   }

   _applyDoT(dt) {
      let fireDmg = 0;
      for (const f of this.fires) {
         fireDmg += COMBAT.fire.perModule * dt * (1 + 0.15 * f.heat);
         f.heat = (f.heat || 0) + dt * 0.1;
         f.t += dt;
      }
      if (fireDmg > 0) this._damage(fireDmg, { source: 'fire', silent: true });
      // fires burn out after ~45-75s so a battle can't be decided by ancient damage
      this.fires = this.fires.filter(f => f.t < 60);
      // fire spreads to adjacent modules over time
      for (const f of this.fires) {
         f.spreadT = (f.spreadT || 0) + dt;
         if (f.spreadT > COMBAT.fire.spread && this.fires.length < COMBAT.fire.max && Math.random() < COMBAT.fire.spreadP * dt * 3) {
            this.ignite(Math.floor((Math.random() - 0.5) * 6));
         }
      }
      let floodDmg = 0;
      for (const fo of this.floods) {
         floodDmg += COMBAT.flood.perModule * dt;
         fo.t += dt;
      }
      if (floodDmg > 0) this._damage(floodDmg, { source: 'flood', silent: true });
      this.floods = this.floods.filter(fo => fo.t < 90);

      // repair-crew healing: only while actively repairing (R / REPAIR state), out of danger
      const inDanger = this.world && this.world.nearestThreat(this) < 600;
      if (!inDanger && this.repairT > 0) {
         this.hp = Math.min(this.maxHP, this.hp + WORLD.REPAIR_RATE * dt * this.maxHP);
      }
   }

   ignite(mod) {
      if (this.fires.length >= COMBAT.fire.max) return;
      const m = mod ?? Math.floor(Math.random() * 6);
      if (this.fires.some(f => f.mod === m)) return; // one fire per module
      this.fires.push({ mod: m, heat: 0, spreadT: 0, t: 0 });
   }
   flood(mod) {
      if (this.floods.length >= COMBAT.flood.max) return;
      const m = mod ?? Math.floor(Math.random() * 6);
      if (this.floods.some(f => f.mod === m)) return;
      this.floods.push({ mod: m, t: 0 });
   }
   repairAll() {
      this.fires = [];
      this.floods = [];
      this.repairT = 20; // 20s of healing at full rate
   }

   _damage(amount, opts = {}) {
      if (!this.alive) return;
      this.hp -= amount;
      this.dmgTaken += amount;
      this.hitFlash = 1;
      if (!opts.silent) this.world.log(this, `−${Math.round(amount)}`, 'dmg');
      if (this.hp <= 0) this._sink();
   }

   _sink() {
      if (!this.alive) return;
      this.alive = false;
      this.world.onSink(this);
   }

   // Fire the main battery. Returns number of shells spawned.
   fireMain(world, target, aimOverride) {
      if (this.fireTimer > 0 || !this.alive) return 0;
      // all turrets that can face the aim fire a salvo
      const aimDir = aimOverride || this.aim;
      this.aimBearing = angleOf(aimDir);
      this.fireTimer = this.cfg.main.reload;
      // Difficulty scales how many guns of each turret actually join the salvo
      // (easy bots limp along with a partial battery, hard ones bring everything).
      const mult = (this.side === 'enemy' && world.difficulty) ? world.difficulty.salvoMult : 1;
      let n = 0;
      for (const t of this.turrets) {
         if (t.cd > 0) continue;
         t.cd = this.cfg.main.reload;
         const rel = t.bearing;
         const muzzle = this._muzzle(t, rel);
         const gCount = Math.max(1, Math.round(t.guns * mult));
         for (let g = 0; g < gCount; g++) {
            const spread = this._fireSpread(world, target);
            const dir = fromAngle(this.aimBearing + spread + (Math.random() - 0.5) * 0.02);
            world.spawnShell(this, muzzle, dir, this.cfg.main, 'main');
            n++;
         }
         this.shotsFired += gCount;
      }
      if (this.cfg.boost && this.side === 'player') this.world.shakeAdd(6);
      this.world.addMuzzleFlash(this, this.aimBearing);
      return n;
   }

   fireSecondary(world, target, aimOverride) {
      if (!this.cfg.sec || this.secTimer > 0 || !this.alive) return 0;
      this.secTimer = this.cfg.sec.reload;
      this.aimBearing = angleOf(aimOverride || this.aim);
      let n = 0;
      const count = this.side === 'player' ? 4 : 6; // fire a burst
      for (let i = 0; i < count; i++) {
         const side = i % 2 ? 1 : -1;
         const off = { x: (Math.random() - 0.5) * 60, y: side * 10 };
         const muzzle = add(this.pos, rotate(off, this.heading));
         const spread = this._fireSpread(world, target, 1.6);
         const dir = fromAngle(this.aimBearing + spread + (Math.random() - 0.5) * 0.05);
         world.spawnShell(this, muzzle, dir, this.cfg.sec, 'sec');
         n++;
      }
      this.world.addMuzzleFlash(this, this.aimBearing);
      return n;
   }

   fireTorpedo(world, target, aimOverride) {
      if (!this.cfg.torp || this.torpTimer > 0 || !this.alive) return 0;
      this.torpTimer = this.cfg.torp.cd;
      this.aimBearing = angleOf(aimOverride || this.aim);
      const salvo = this.cfg.torp.salvo;
      let n = 0;
      for (let i = 0; i < salvo; i++) {
         const off = { x: (i - (salvo - 1) / 2) * 6, y: -20 };
         const muzzle = add(this.pos, rotate(off, this.heading));
         const dir = fromAngle(this.aimBearing + (Math.random() - 0.5) * 0.03);
         world.spawnTorpedo(this, muzzle, dir, this.cfg.torp);
         n++;
      }
      return n;
   }

   fireAA(world, target) {
      if (!this.cfg.aa || this.aaTimer > 0 || !this.alive) return 0;
      this.aaTimer = this.cfg.aa.reload;
      const dir = angleOf(sub(target.pos, this.pos));
      world.spawnAA(this, dir, target);
      return 1;
   }

   _fireSpread(world, target, mult = 1) {
      // dispersion tightens with proximity; bots scale by difficulty.
      // Roughly halved vs the original tuning: at 2000m the old curve scattered shells
      // +/-4.6 deg (~160m) -- wider than most targets are long, so a well-aimed shot
      // still whiffed constantly. A good lead at sane range should now actually land.
      let base = 0.015; // rad, point-blank baseline (no target/range known)
      if (target) {
         const d = Math.hypot(target.pos.x - this.pos.x, target.pos.y - this.pos.y);
         base = 0.01 + 0.028 * clamp(d / 2000, 0, 1);
      }
      if (this.side === 'enemy' && world.difficulty) {
         base *= (world.difficulty.sigmaDeg || 0.7) / 0.7;
      }
      return (Math.random() - 0.5) * 2 * base * mult;
   }

   _muzzle(t, rel) {
      // world position of a turret muzzle, offset along the barrel
      const off = rotate({ x: 58, y: 0 }, this.heading);
      const base = add(this.pos, off);
      const barrelDir = this.heading + rel;
      return add(base, fromAngle(barrelDir, 40));
   }

   // A shell/torpedo hit lands here.
   applyImpact(impact) {
      if (!this.alive) return;
      const { dmg, type, source, isTorpedo, central } = impact;
      this._damage(dmg, { source: source || 'gun' });
      if (impact.firing) this.ignite(impact.mod);
      if (impact.flooding) this.flood(impact.mod);
   }

   get fireModulesCount() { return this.fires.length; }
   get floodModulesCount() { return this.floods.length; }
}

// rotate a local offset by world heading
function rotate(v, a) {
   const c = Math.cos(a), s = Math.sin(a);
   return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}
