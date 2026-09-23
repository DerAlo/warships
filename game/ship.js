// game/ship.js — the shared ship integrator (player + bots) plus the weapon model:
// per-turret reload + traverse arcs, AP/HE ammo, side torpedo launchers, automatic secondaries/AA
// and consumables. Movement has weight/inertia so it feels like a 45,000-ton warship.
import { add, sub, scale, fromAngle, angleOf, angleDelta, clamp, approach, dist, randn, TAU, DEG } from './utils.js';
import { WORLD, SHIPS, COMBAT, VISION, HANDLING } from './config.js';

const TURRET_NAMES = 'ABCDEFGH';

// Turrets come from config: x > 0 = forward mount (home bearing 0), x < 0 = aft mount (home PI).
function buildTurrets(cfg) {
   const list = cfg.turrets || [{ x: 0, guns: cfg.main.guns }];
   return list.map((t, i) => {
      const home = t.x >= 0 ? 0 : Math.PI;
      return { idx: i, name: TURRET_NAMES[i] || String(i + 1), off: { x: t.x, y: 0 }, guns: t.guns,
         home, bearing: home, cd: 0, cdMax: 1, aligned: false, blocked: false };
   });
}

// Side launchers from config; a class without them gets one centreline mount that fires anywhere.
function buildLaunchers(cfg) {
   const T = cfg.torp;
   if (!T) return [];
   const list = T.launchers || [{ id: 'c', label: '', side: 0, arcMin: -180, arcMax: 180 }];
   // bots start with launchers reloading so a destroyer can't open the match with a point-blank salvo
   return list.map(l => ({ ...l, cd: cfg.isPlayer ? 0 : T.cd }));
}

function buildCons(cfg) {
   const out = {};
   for (const [key, c] of Object.entries(cfg.cons || {})) out[key] = { key, cfg: c, charges: c.charges, active: false, t: 0, cd: 0 };
   return out;
}

// dormant stand-in so render/AI can read ship.boost/ship.smoke on classes without them
const NO_CONS = Object.freeze({ key: null, cfg: null, charges: 0, active: false, t: 0, cd: 0 });

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
      this.angularVel = 0;
      this.vel = fromAngle(heading, 0);
      this.maxHP = this.cfg.hp * (opts.hpMult || 1);
      this.hp = this.maxHP;
      this.dmgMult = opts.dmgMult || 1;   // rider on outgoing damage (difficulty)
      // weapons
      this.turrets = buildTurrets(this.cfg);
      this.launchers = buildLaunchers(this.cfg);
      this.torpSpread = 'narrow';
      const A = this.cfg.main.ammo;
      this.ammo = A ? (A[this.cfg.main.type] ? this.cfg.main.type : Object.keys(A)[0]) : null;
      this._shellSpecs = {};
      this.secTimer = 0;
      this.aaTimer = 0;
      this._aaVis = 0;
      this.secFocus = null;   // manual secondary target (player RMB)
      this.secTarget = null;  // what the secondaries are engaging right now (HUD)
      // consumables; boost/smoke alias their entries so movement/render/AI read one object
      this.cons = buildCons(this.cfg);
      this.boost = this.cons.boost || NO_CONS;
      this.smoke = this.cons.smoke || NO_CONS;
      this._smokeAccum = 0;
      // damage state
      this.fires = [];   // { mod, t, spreadT, dmgMult, by }
      this.floods = [];  // { mod, t, dmgMult, by }
      this.healable = 0; // HP the repair party can still restore (COMBAT.restorable)
      this.repairT = 0;  // bot repair-crew healing time left (REPAIR state)
      this.repairTimer = 0;
      this.lastHitBy = null;
      // vision (maintained by World._updateVision)
      this.visible = true;
      this.visReason = 'sight';
      this.lastKnown = null;
      this.inSmokeNow = false;
      this.bloomT = 0;
      this.bloomRange = clamp((this.cfg.main.caliber || 150) * VISION.bloomPerCaliber, VISION.bloomMin, VISION.bloomMax);
      // control (for bots; overwritten by AI controller each tick)
      this.helm = 0;
      this.throttleIn = WORLD.MIN_THROTTLE;
      // anchor turn: drop anchor (Space) to bite into the seabed -- hard braking AND a big
      // turn-rate boost. It takes a moment to bite and to weigh again: a deliberate maneuver.
      this.anchorOut = false;
      this.anchorBite = 0;
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
      this.blindShots = 0;
      // visual
      this.wakePhase = Math.random() * 10;
      this.aim = { x: 1, y: 0 };
      this.hitFlash = 0;
      this.aimBearing = heading; // desired absolute turret bearing
      this.alive = true;
   }

   get maxSpeed() {
      let s = this.cfg.maxSpeed;
      if (this.boost.active) s *= this.boost.cfg.mult || 1.3;
      s *= (1 - Math.min(0.5, this.floods.length * COMBAT.flood.slow));
      return s;
   }

   // world units are not metres/s (Bismarck maxSpeed 90 ~ 30 kn), so scale for a plausible readout
   get speedKnots() { return Math.abs(this.speed) * 0.33; }

   // soonest-ready turret (0 = at least one turret loaded); per-turret state lives on this.turrets
   get fireTimer() {
      let m = Infinity;
      for (const t of this.turrets) m = Math.min(m, Math.max(0, t.cd));
      return m === Infinity ? 0 : m;
   }
   get torpTimer() {
      let m = Infinity;
      for (const l of this.launchers) m = Math.min(m, Math.max(0, l.cd));
      return m === Infinity ? 0 : m;
   }

   update(dt) {
      if (!this.alive) return;
      this.anchorBite = approach(this.anchorBite, this.anchorOut ? 1 : 0, dt / (this.anchorOut ? 0.6 : 1.0));
      const anchorTurnMult = 1 + 2.5 * this.anchorBite;
      const anchorDragRate = 2.2 * this.anchorBite;

      // ---- movement integration (weighty) ----
      const helm = clamp(this.helm, -1, 1);
      const flow = clamp(this.speed / 6, 0, 1); // rudder needs water flowing past it
      const targetOmega = helm * this.cfg.turnRate * anchorTurnMult * (0.4 + 0.6 * flow);
      const turnAccel = 0.9 * anchorTurnMult;
      this.angularVel = approach(this.angularVel, targetOmega, turnAccel * dt * (0.5 + 0.5 * flow));
      this.heading += this.angularVel * dt;
      this.heading = ((this.heading % TAU) + TAU) % TAU;

      const tTarget = this.anchorOut ? 0 : clamp(this.throttleIn, -1, 1);
      const throttleAccel = tTarget >= 0 ? 0.28 : 0.45; // astern bites harder
      this.throttle = approach(this.throttle, tTarget, throttleAccel * dt);
      if (this.throttle < 0.12 && tTarget >= 0 && !this.anchorOut) this.throttle = WORLD.MIN_THROTTLE; // keep way
      // acceleration scales with each class's own top speed so every ship reaches flank speed in
      // roughly the same real time (~8s ahead / ~5s braking)
      const spdAccel = this.maxSpeed / (this.throttle >= 0 ? 8 : 5);
      this.speed = approach(this.speed, this.throttle * this.maxSpeed, dt * spdAccel);
      if (anchorDragRate > 0) this.speed *= Math.exp(-anchorDragRate * dt);

      this.vel = fromAngle(this.heading, this.speed);
      this.pos = add(this.pos, scale(this.vel, dt));

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
            const R = o.r + 24;
            if (dd < R && dd > 0.001) {
               const nx = ddx / dd, ny = ddy / dd;
               this.pos.x = o.c.x + nx * R;
               this.pos.y = o.c.y + ny * R;
               // drop only the velocity component driving INTO the rock and keep the tangential
               // part: a uniform speed cut pinned ships nose-first on the beach forever
               const vn = this.vel.x * nx + this.vel.y * ny;
               if (vn < 0) {
                  const tx = this.vel.x - vn * nx, ty = this.vel.y - vn * ny;
                  const tSpeed = Math.hypot(tx, ty) * 0.7;
                  if (tSpeed > 0.5) { this.heading = angleOf({ x: tx, y: ty }); this.speed = tSpeed; }
                  else this.speed = 0;
                  this.vel = fromAngle(this.heading, this.speed);
               }
            }
         } else if (o.kind === 'reef') {
            if (dd < o.r) this.speed = Math.min(this.speed, this.maxSpeed * WORLD.REEF_SPEED_CAP);
         }
      }

      // ---- turrets: reload + traverse inside each mount's arc ----
      const slew = this.cfg.turretSlew || 0.5;
      const desiredRel = angleDelta(this.heading, this.aimBearing);
      const tol = this.side === 'player' ? HANDLING.alignTolPlayer : HANDLING.alignTolBot;
      const ARC = HANDLING.turretArc;
      let reloaded = false;
      for (const t of this.turrets) {
         if (t.cd > 0) { t.cd -= dt; if (t.cd <= 0) reloaded = true; }
         // work in offset-from-home space so a turret swings round through its own arc and never
         // through the superstructure behind it
         const want = angleDelta(t.home, desiredRel);
         const wantC = clamp(want, -ARC, ARC);
         const next = approach(angleDelta(t.home, t.bearing), wantC, slew * dt);
         t.bearing = t.home + next;
         t.blocked = Math.abs(want) > ARC;
         t.aligned = !t.blocked && Math.abs(want - next) < tol;
      }
      if (reloaded && this.side === 'player') this.world.emit({ kind: 'reloaded', ship: this });
      for (const l of this.launchers) if (l.cd > 0) {
         l.cd -= dt;
         if (l.cd <= 0 && this.side === 'player') this.world.emit({ kind: 'torpReady', ship: this, launcher: l });
      }
      if (this.bloomT > 0) this.bloomT -= dt;

      // ---- consumables ----
      for (const key in this.cons) {
         const c = this.cons[key];
         if (c.active) {
            c.t -= dt;
            if (key === 'smoke') this.world.emitSmokePuff(this, dt);
            else if (key === 'repair') this._repairTick(dt, c.cfg.rate || 0.01);
            if (c.t <= 0) { c.active = false; c.t = 0; c.cd = c.cfg.cd; }
         } else if (c.cd > 0) c.cd = Math.max(0, c.cd - dt);
      }
      this.hitFlash = Math.max(0, this.hitFlash - dt * 3);

      // ---- automatic batteries ----
      if (this.cfg.sec) this._autoSecondary(dt);
      if (this.cfg.aa) this._autoAA(dt);

      // ---- damage over time: fire + flood ----
      this._applyDoT(dt);

      if (this.repairT > 0) this.repairT -= dt;
      if (this.side === 'enemy' && this.state === 'REPAIR') this.repairTimer += dt;

      // Enemy ships patch themselves up passively while out of danger, so a bot that retreated
      // comes back combat-ready instead of limping forever. The player uses consumables instead.
      if (this.side === 'enemy' && this.hp < this.maxHP && this.world.nearestThreat(this) >= 600) {
         this.hp = Math.min(this.maxHP, this.hp + WORLD.REPAIR_RATE * 0.35 * dt * this.maxHP);
         if (this.fires.length && Math.random() < 0.12 * dt) this.fires.shift();
         if (this.floods.length && Math.random() < 0.12 * dt) this.floods.shift();
      }

      if (this.hp <= 0 && this.alive) this._sink();
   }

   _applyDoT(dt) {
      // Fire/flood burn a fraction of the VICTIM's max HP per second, scaled by the igniter's
      // difficulty dmgMult, and burn out after a fixed time -- so a fire matters equally on a
      // destroyer and on the Bismarck, and damage control (E) is the counter.
      const F = COMBAT.fire, FL = COMBAT.flood;
      for (let i = 0; i < this.fires.length && this.alive; i++) {
         const f = this.fires[i];
         f.t += dt;
         f.spreadT += dt;
         this._damage(F.rate * this.maxHP * (f.dmgMult || 1) * dt, { source: 'fire', by: f.by, dot: true });
         if (f.spreadT > F.spread && this.fires.length < F.max && Math.random() < F.spreadP * dt * 0.5) {
            f.spreadT = 0;
            this.ignite(Math.floor(Math.random() * 6), f.dmgMult, f.by);
         }
      }
      this.fires = this.fires.filter(f => f.t < F.dur);
      for (let i = 0; i < this.floods.length && this.alive; i++) {
         const fo = this.floods[i];
         fo.t += dt;
         this._damage(FL.rate * this.maxHP * (fo.dmgMult || 1) * dt, { source: 'flood', by: fo.by, dot: true });
      }
      this.floods = this.floods.filter(fo => fo.t < FL.dur);

      // bot repair crew (REPAIR state): only while nobody is shooting at it
      if (this.repairT > 0 && this.world.nearestThreat(this) >= 600) {
         this.hp = Math.min(this.maxHP, this.hp + WORLD.REPAIR_RATE * dt * this.maxHP);
      }
   }

   _repairTick(dt, rate) {
      if (this.healable <= 0 || this.hp >= this.maxHP) return;
      const h = Math.min(rate * this.maxHP * dt, this.healable, this.maxHP - this.hp);
      this.hp += h;
      this.healable -= h;
   }

   // Returns true when a NEW fire was started (damage control active = immune).
   ignite(mod, dmgMult = 1, by = null) {
      if (this.cons.dc && this.cons.dc.active) return false;
      if (this.fires.length >= COMBAT.fire.max) return false;
      const m = mod ?? Math.floor(Math.random() * 6);
      if (this.fires.some(f => f.mod === m)) return false; // one fire per section
      this.fires.push({ mod: m, t: 0, spreadT: 0, dmgMult, by });
      return true;
   }
   flood(mod, dmgMult = 1, by = null) {
      if (this.cons.dc && this.cons.dc.active) return false;
      if (this.floods.length >= COMBAT.flood.max) return false;
      const m = mod ?? Math.floor(Math.random() * 6);
      if (this.floods.some(f => f.mod === m)) return false;
      this.floods.push({ mod: m, t: 0, dmgMult, by });
      return true;
   }
   // bots' repair crew (REPAIR state) and tests: instant fix + a stretch of hull healing
   repairAll() {
      this.fires = [];
      this.floods = [];
      this.repairT = 20;
   }

   // ---- consumables ----
   consState(key) {
      const c = this.cons[key];
      if (!c) return 'none';
      if (c.active) return 'active';
      if (c.charges <= 0) return 'empty';
      if (c.cd > 0) return 'cd';
      return 'ready';
   }
   canUse(key) { return this.alive && this.consState(key) === 'ready'; }
   useConsumable(key) {
      if (!this.canUse(key)) return false;
      if (key === 'repair' && (this.healable < 1 || this.hp >= this.maxHP)) return false;
      const c = this.cons[key];
      c.active = true;
      c.t = c.cfg.dur;
      c.charges -= 1; // Infinity stays Infinity
      if (key === 'dc') { this.fires = []; this.floods = []; }
      if (key === 'smoke') this._smokeAccum = 1; // first puff immediately
      this.world.emit({ kind: 'cons', ship: this, key });
      return true;
   }

   _damage(amount, opts = {}) {
      if (!this.alive || !(amount > 0)) return;
      this.hp -= amount;
      this.dmgTaken += amount;
      const r = COMBAT.restorable[opts.source];
      this.healable = Math.min(this.maxHP, this.healable + amount * (r === undefined ? 0.5 : r));
      if (opts.by && opts.by !== this) { opts.by.dmgDealt += amount; this.lastHitBy = opts.by; }
      if (!opts.dot) this.hitFlash = 1;
      if (this.hp <= 0) this._sink();
   }

   _sink() {
      if (!this.alive) return;
      this.alive = false;
      this.world.onSink(this);
   }

   // ---- main battery ----
   // Merged shell spec for the loaded ammo (the class `main` block when it has no ammo table).
   mainShell() {
      const m = this.cfg.main;
      if (!this.ammo) return m;
      return this._shellSpecs[this.ammo] || (this._shellSpecs[this.ammo] = { ...m, ...m.ammo[this.ammo] });
   }

   // Switching shells costs reload time: turrets closer than `switchTime` to loaded are pushed
   // back to it, a turret that is still mid-reload just loads the new type. Returns true on change.
   setAmmo(type) {
      const A = this.cfg.main.ammo;
      if (!A || !A[type] || this.ammo === type) return false;
      this.ammo = type;
      const pen = this.cfg.main.switchTime || 0;
      for (const t of this.turrets) if (t.cd < pen) { t.cd = pen; t.cdMax = pen; }
      this.world.emit({ kind: 'ammo', ship: this, ammo: type });
      return true;
   }

   // Can turret t fire along relative bearing `rel` right now (loaded, inside its arc, on target)?
   turretCanFire(t, rel, tol) {
      if (t.cd > 0) return false;
      const want = angleDelta(t.home, rel);
      if (Math.abs(want) > HANDLING.turretArc) return false;
      return Math.abs(angleDelta(t.bearing, t.home + want)) <= tol;
   }

   // Fire every loaded turret that bears on the aim (up to opts.maxTurrets). Each turret aims at
   // opts.aimPoint so the salvo converges there; shells come down around that range (plunging
   // fire, see combat.js). opts.spreadMult / reloadMult are for blind area fire. Returns shells.
   fireMain(world, target, aimOverride, opts = {}) {
      if (!this.alive) return 0;
      const aimDir = aimOverride || this.aim;
      this.aimBearing = angleOf(aimDir);
      const gun = this.mainShell();
      const rel = angleDelta(this.heading, this.aimBearing);
      const tol = this.side === 'player' ? HANDLING.alignTolPlayer : HANDLING.alignTolBot;
      const aimPoint = opts.aimPoint || (target ? target.pos : null);
      const max = opts.maxTurrets || Infinity;
      const spreadMult = opts.spreadMult || 1;
      const salvoMult = (this.side === 'enemy' && world.difficulty) ? world.difficulty.salvoMult : 1;
      const reload = gun.reload * (opts.reloadMult || 1);
      const rangeSigma = HANDLING.rangeSigma * this._aimScale(world) * spreadMult;
      let fired = 0, n = 0;
      for (const t of this.turrets) {
         if (fired >= max) break;
         if (!this.turretCanFire(t, rel, tol)) continue;
         t.cd = reload; t.cdMax = reload;
         const muzzle = this._muzzle(t);
         const baseRange = aimPoint ? dist(muzzle, aimPoint) : gun.range;
         const baseDir = aimPoint ? angleOf(sub(aimPoint, muzzle)) : this.aimBearing;
         const gCount = Math.max(1, Math.round(t.guns * salvoMult));
         for (let g = 0; g < gCount; g++) {
            const spread = this._fireSpread(world, baseRange, spreadMult);
            const landRange = clamp(baseRange * (1 + randn() * rangeSigma), 60, gun.range * 1.1);
            world.spawnShell(this, muzzle, fromAngle(baseDir + spread), gun, 'main', landRange);
            n++;
         }
         world.addMuzzleFlash(this, baseDir, muzzle);
         this.shotsFired += gCount;
         fired++;
      }
      if (fired > 0) {
         // muzzle flash gives the shooter away for a while (VISION.bloom*)
         this.bloomT = VISION.bloomTime;
         if (opts.blind) this.blindShots += n;
         world.emit({ kind: 'salvo', ship: this, turrets: fired, guns: n, ammo: gun.type });
         if (this.side === 'player') world.shakeAdd(2 + fired * 1.5);
      }
      return n;
   }

   // ---- secondaries: automatic, nearest visible enemy or the manual focus target ----
   _autoSecondary(dt) {
      if (this.secTimer > 0) { this.secTimer -= dt; return; }
      const S = this.cfg.sec;
      const f = this.secFocus;
      if (f && !f.alive) this.secFocus = null;
      let tgt = null;
      if (this.secFocus && this.secFocus.visible && dist(this.secFocus.pos, this.pos) < S.range) tgt = this.secFocus;
      else {
         let bd = S.range;
         for (const e of this.world.enemiesOf(this)) {
            if (!e.visible) continue;
            const d = dist(e.pos, this.pos);
            if (d < bd) { bd = d; tgt = e; }
         }
      }
      this.secTarget = tgt;
      if (!tgt) return;
      // fire discipline: automatic batteries don't give away a ship hiding in smoke; a manual
      // focus order (RMB) overrides that and blooms like the main guns
      if (this.inSmokeNow && !this.visible && tgt !== this.secFocus) return;
      this.secTimer = S.reload;
      this.fireSecondary(this.world, tgt);
      if (tgt === this.secFocus) this.bloomT = Math.max(this.bloomT, VISION.bloomTime * 0.5);
   }

   fireSecondary(world, target) {
      const S = this.cfg.sec;
      if (!S || !target || !this.alive) return 0;
      const focused = target === this.secFocus;
      const count = S.burst || 4;
      const tof = dist(this.pos, target.pos) / (S.vShell || 600);
      const pred = add(target.pos, scale(target.vel, tof));
      const side = angleDelta(this.heading, angleOf(sub(pred, this.pos))) >= 0 ? 1 : -1;
      for (let i = 0; i < count; i++) {
         const off = { x: (Math.random() - 0.5) * this.cfg.L * 0.5, y: side * this.cfg.beam * 0.45 };
         const muzzle = add(this.pos, rotate(off, this.heading));
         const r = dist(muzzle, pred);
         const spread = this._fireSpread(world, r, 1.4 * (focused ? 0.6 : 1));
         const landRange = Math.max(60, r * (1 + randn() * 0.03 * (focused ? 0.6 : 1)));
         world.spawnShell(this, muzzle, fromAngle(angleOf(sub(pred, muzzle)) + spread), S, 'sec', landRange);
      }
      world.addMuzzleFlash(this, angleOf(sub(pred, this.pos)), add(this.pos, rotate({ x: 0, y: side * this.cfg.beam * 0.45 }, this.heading)));
      world.emit({ kind: 'sec', ship: this });
      return count;
   }

   // ---- AA: aircraft first (carrier hook, world.aircraft), else light fire on close ships ----
   _autoAA(dt) {
      if (this.aaTimer > 0) { this.aaTimer -= dt; return; }
      const A = this.cfg.aa;
      this.aaTimer = A.reload;
      let tgt = null, bd = A.range;
      for (const a of this.world.aircraft) {
         if (!a.alive || a.side === this.side) continue;
         const d = dist(a.pos, this.pos);
         if (d < bd) { bd = d; tgt = a; }
      }
      if (tgt) {
         tgt.hp -= A.dps * A.reload;
         if (tgt.hp <= 0) { tgt.alive = false; this.world.emit({ kind: 'aircraftDown', ship: this, aircraft: tgt }); }
      } else {
         if (this.inSmokeNow && !this.visible) return;
         for (const e of this.world.enemiesOf(this)) {
            if (!e.visible) continue;
            const d = dist(e.pos, this.pos);
            if (d < bd) { bd = d; tgt = e; }
         }
         if (!tgt) return;
         tgt._damage((A.vsShip || 0) * A.reload * (this.dmgMult || 1), { source: 'aa', by: this, dot: true });
      }
      this._aaVis = (this._aaVis + 1) % 2; // tracers every other burst: plenty on screen
      if (!this._aaVis) this.world.spawnAA(this, angleOf(sub(tgt.pos, this.pos)), tgt);
   }

   // ---- torpedoes ----
   // Launcher whose arc covers absolute bearing `bearing` (prefers a loaded one), or null.
   launcherFor(bearing) {
      const rel = angleDelta(this.heading, bearing) / DEG;
      let best = null;
      for (const l of this.launchers) {
         if (rel < l.arcMin || rel > l.arcMax) continue;
         if (!best || (l.cd <= 0 && best.cd > 0)) best = l;
      }
      return best;
   }
   // Absolute headings of a salvo fired along `bearing` (player: Q toggles narrow/wide).
   torpFan(bearing) {
      const T = this.cfg.torp;
      if (!T) return [];
      const gap = this.side === 'player' ? HANDLING.torpSpread[this.torpSpread] : (T.spread || 3 * DEG);
      const out = [];
      for (let i = 0; i < T.salvo; i++) out.push(bearing + (i - (T.salvo - 1) / 2) * gap);
      return out;
   }
   toggleTorpSpread() {
      this.torpSpread = this.torpSpread === 'narrow' ? 'wide' : 'narrow';
      return this.torpSpread;
   }
   launcherPos(l) {
      return add(this.pos, rotate({ x: -this.cfg.L * 0.08, y: l.side * this.cfg.beam * 0.5 }, this.heading));
   }
   fireTorpedo(world, target, aimOverride) {
      const T = this.cfg.torp;
      if (!T || !this.alive) return 0;
      const bearing = angleOf(aimOverride || this.aim);
      const l = this.launcherFor(bearing);
      if (!l || l.cd > 0) return 0;
      l.cd = T.cd;
      const muzzle = this.launcherPos(l);
      const fan = this.torpFan(bearing);
      for (const a of fan) world.spawnTorpedo(this, muzzle, fromAngle(a), T);
      world.emit({ kind: 'torp', ship: this, launcher: l.id });
      return fan.length;
   }

   _aimScale(world) {
      return (this.side === 'enemy' && world.difficulty) ? (world.difficulty.sigmaDeg || 0.7) / 0.7 : 1;
   }

   // Lateral dispersion (rad, uniform +-base) grows with range; bots scale by difficulty.
   _fireSpread(world, range, mult = 1) {
      const base = (0.01 + 0.028 * clamp(range / 2000, 0, 1)) * this._aimScale(world);
      return (Math.random() - 0.5) * 2 * base * mult;
   }

   _muzzle(t) {
      const mount = add(this.pos, rotate(t.off, this.heading));
      return add(mount, fromAngle(this.heading + t.bearing, 6 + (this.cfg.main.caliber || 150) / 25));
   }

   // A shell/torpedo hit lands here. Returns which damage-over-time effects actually started.
   applyImpact(impact) {
      if (!this.alive) return { fire: false, flood: false };
      const { dmg, source, dmgMult, by } = impact;
      this._damage(dmg, { source: source || 'gun', by });
      const fire = !!impact.firing && this.alive && this.ignite(impact.mod, dmgMult, by);
      const flood = !!impact.flooding && this.alive && this.flood(impact.mod, dmgMult, by);
      return { fire, flood };
   }
}

// rotate a local offset by world heading
function rotate(v, a) {
   const c = Math.cos(a), s = Math.sin(a);
   return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}
