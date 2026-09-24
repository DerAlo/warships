// game3d/ship.js — a WoWs-style warship: engine telegraph + rudder with shift time and yaw
// inertia, turrets that slew at their traverse speed inside their firing arcs, torpedo
// launchers, auto secondaries, consumables, fires/floods/module damage and sinking.
// Player and bots share this class; bots are steered by ai.js through the same API.
import { WORLD, SHIPS, CONSUMABLES } from './config.js';
import { TAU, DEG, clamp, clamp01, angleDelta, approach, toWorld, toLocal, obstacleT, obstacleRadiusAt, dist2 } from './utils.js';
import { makeShell, launchAngle, flightTime } from './combat.js';

const FIRE_DUR = { BB: 45, CA: 35, CL: 30, DD: 20, TR: 60, CV: 45 };   // s (a bit shorter than WoWs: fights are faster)
const FLOOD_DUR = 40;
const YAW_TAU = { BB: 3.2, CA: 2.2, CL: 1.9, DD: 1.2, TR: 3.5, CV: 3.5 }; // s, yaw inertia
const TURN_LOSS = { BB: 0.25, CA: 0.2, CL: 0.2, DD: 0.15, TR: 0.2, CV: 0.25 }; // speed lost at full rudder
const TORP_ARC = 65 * DEG;          // launchers train +-65 deg around the beam
const MODULE_T = 25;                // s a knocked-out module stays down (damage control fixes it)
const AMMO_NAMES = { AP: 'Panzersprenggranaten (AP)', HE: 'Sprenggranaten (HE)' };

export class Ship {
   constructor(world, cls, side, pos, heading = 0, opts = {}) {
      const cfg = SHIPS[cls];
      if (!cfg) throw new Error('Unknown ship class: ' + cls);
      this.world = world;
      this.id = world ? world._nextId++ : Math.floor(Math.random() * 1e9);
      this.cls = cls;
      this.cfg = cfg;
      this.type = cfg.hull.type;
      this.side = side;
      this.name = opts.name || cfg.name;
      this.isPlayer = !!opts.isPlayer;
      this.color = opts.color || cfg.hull.color || cfg.color;
      this.nation = opts.nation || cfg.hull.nation;
      // ---- motion ----
      this.pos = { x: pos.x, y: pos.y };
      this.heading = ((heading % TAU) + TAU) % TAU;
      this.maxSpeedKn = opts.speedKn || cfg.speedKn;   // missions may cap it (convoys)
      this.telegraph = opts.telegraph ?? 0;
      this.speed = (opts.speedFrac ?? WORLD.TELEGRAPH[this.telegraph] ?? 0) * this.maxSpeedKn * WORLD.KN_TO_MS;
      this.speedKn = this.speed / WORLD.KN_TO_MS;
      this.vel = { x: Math.cos(this.heading) * this.speed, y: Math.sin(this.heading) * this.speed };
      this.omega = 0;                 // yaw rate (rad/s)
      this.rudderCmd = 0;             // -2..2 commanded
      this.rudder = 0;                // -1..1 actual
      this.heel = 0;                  // rad, visual lean in turns (+ = to starboard)
      this.grounded = false;
      // ---- health ----
      this.maxHP = Math.round(cfg.hp * (opts.hpMult || 1));
      this.hp = this.maxHP;
      this.alive = true;
      this.sinking = false;
      this.sinkT = 0;
      this.dmgMult = opts.dmgMult || 1;
      this.healPool = 0;              // damage the repair party can still restore
      this.fires = [];                // [{ zone, t (s left), dur, srcId }]
      this.floods = [];
      this.modules = { engine: 0, rudder: 0 };   // seconds a module stays knocked out
      this.hitFlash = 0;
      this.lastHitT = -999;
      // ---- spotting ----
      this.spotted = side === 'player';
      this.detected = false;
      this.detectRange = cfg.detect.surface;
      this.lastSeen = null;           // enemy: last position seen by the player team {x, y, heading, t}
      this.spottedByPlayer = false;
      this.lastMainFire = -999;
      // ---- weapons ----
      const m = cfg.main;
      this.ammo = m.he && !(cfg.hull.type === 'BB' && m.ap) ? 'HE' : (m.ap ? 'AP' : 'HE');
      this.aimPoint = null;
      this.aimRange = 0;
      this.inRange = false;
      this.lockTarget = null;         // ship id the player/bot has locked (secondaries prefer it)
      this.turrets = m.turrets.map((t, i) => ({
         idx: i, off: { x: t.off.x, y: t.off.y }, guns: t.guns, caliber: m.caliber,
         arcC: t.arcC, arcW: t.arcW, bearing: t.arcC, elev: 0, err: 0,
         aligned: false, canBear: false, alive: true, disabledT: 0,
         reload: opts.unloaded ? m.reload : 0, reloadMax: m.reload,
         get cd() { return this.reload; },
      }));
      const tc = cfg.torp;
      this.torps = tc ? {
         launchers: tc.launchers.map(l => ({
            off: { x: l.off.x, y: l.off.y }, side: l.side, tubes: l.tubes,
            bearing: l.side === 'port' ? -Math.PI / 2 : Math.PI / 2,
            reload: 0, reloadMax: tc.reload, canBear: false,
         })),
         spread: 'narrow', range: tc.range, speedKn: tc.speedKn, speed: tc.speed, dmg: tc.dmg,
      } : null;
      this.sec = cfg.sec ? { t: [0.5, 0.8], target: null, retarget: 0 } : null;
      this.consumables = cfg.consumables.map(c => ({
         ...c, name: CONSUMABLES[c.key].name, short: CONSUMABLES[c.key].short, icon: CONSUMABLES[c.key].icon,
         charges: c.charges, maxCharges: c.charges, cd: 0, cdMax: c.cd, active: false, t: 0, dur: c.dur,
      }));
      this._smokeT = 0;
      // ---- stats / AI scratch ----
      this.dmgDealt = 0; this.dmgTaken = 0; this.kills = 0; this.shotsFired = 0; this.hits = 0;
      this.ai = opts.ai || {};
   }

   // ================= controls API =================
   setTelegraph(n) { this.telegraph = clamp(Math.round(n), -1, 4); }
   setRudder(n) { this.rudderCmd = clamp(Math.round(n), -2, 2); }
   setAmmo(type) {
      const m = this.cfg.main;
      if (type === this.ammo || !(type === 'AP' ? m.ap : m.he)) return false;
      this.ammo = type;
      for (const t of this.turrets) t.reload = Math.max(t.reload, t.reloadMax * WORLD.AMMO_SWITCH);
      if (this.isPlayer && this.world) this.world.pushEvent('ammo', { srcId: this.id, text: 'Munition: ' + AMMO_NAMES[type] });
      return true;
   }
   setTorpSpread(mode) { if (this.torps) this.torps.spread = mode === 'wide' ? 'wide' : 'narrow'; }
   toggleTorpSpread() { if (this.torps) this.setTorpSpread(this.torps.spread === 'wide' ? 'narrow' : 'wide'); }

   get maxSpeed() {                 // m/s incl. boost
      const b = this.consumable('boost');
      return this.maxSpeedKn * WORLD.KN_TO_MS * (b && b.active ? (b.mult || 1.08) : 1);
   }
   consumable(key) { return this.consumables.find(c => c.key === key) || null; }
   consumableActive(key) { const c = this.consumable(key); return !!(c && c.active); }

   // Fire every loaded turret that bears on the aim point within FIRE_TOL. aim: {x,y} (or a
   // legacy {pos}). Returns the number of guns fired.
   fireMain(world = this.world, aim = this.aimPoint) {
      if (!this.alive || !aim) return 0;
      const a = aim.pos || aim;
      this.aimPoint = { x: a.x, y: a.y };
      const m = this.cfg.main;
      let n = 0;
      for (const t of this.turrets) {
         if (!t.alive || t.reload > 0 || !t.canBear || t.err > WORLD.FIRE_TOL) continue;
         const wp = toWorld(this, t.off);
         const b = this.heading + t.bearing;
         const cb = Math.cos(b), sb = Math.sin(b);
         const barrel = 8 + m.caliber * 0.03;
         for (let g = 0; g < t.guns; g++) {
            const lat = (g - (t.guns - 1) / 2) * m.caliber * 0.009;
            const muzzle = { x: wp.x + cb * barrel - sb * lat, y: wp.y + sb * barrel + cb * lat };
            world.addShell(makeShell(world, this, muzzle, this.aimPoint, m, 'main', this.ammo));
            n++;
         }
         t.reload = t.reloadMax;
         world.addEffect('muzzle', { x: wp.x + cb * barrel, y: wp.y + sb * barrel }, 0.35, 10 + m.caliber * 0.07,
            { bearing: b, shipId: this.id, turret: t.idx, caliber: m.caliber, guns: t.guns, big: m.caliber >= 280, elev: t.elev });
      }
      if (n > 0) {
         this.lastMainFire = world.time;
         this.shotsFired += n;
         if (this.isPlayer) { world.stats.shotsFired += n; world.shakeAdd(0.25 + Math.min(1, n / 10) * (m.caliber / 400)); }
      }
      return n;
   }

   // Which launcher would fire at absolute bearing `bearing` (rad)? null if none can.
   torpLauncherFor(bearing) {
      if (!this.torps) return null;
      const rel = angleDelta(this.heading, bearing);
      let best = null, bestOff = Infinity;
      for (const l of this.torps.launchers) {
         const c = l.side === 'port' ? -Math.PI / 2 : l.side === 'stbd' ? Math.PI / 2 : (rel < 0 ? -Math.PI / 2 : Math.PI / 2);
         const off = Math.abs(angleDelta(c, rel));
         l.canBear = off <= TORP_ARC;
         if (l.reload > 0 || !l.canBear) continue;
         if (off < bestOff) { bestOff = off; best = l; }
      }
      return best;
   }

   // Launch one loaded launcher's spread along absolute `bearing` (rad). Returns torps launched.
   fireTorpedoes(world = this.world, bearing = this.heading) {
      if (!this.alive || !this.torps) return 0;
      const l = this.torpLauncherFor(bearing);
      if (!l) return 0;
      const tc = this.cfg.torp;
      const step = (this.torps.spread === 'wide' ? 3.2 : 1.3) * DEG;
      const rel = angleDelta(this.heading, bearing);
      const origin = toWorld(this, { x: l.off.x, y: (rel < 0 ? -1 : 1) * this.cfg.hull.beam * 0.35 });
      for (let i = 0; i < l.tubes; i++) {
         const h = bearing + (i - (l.tubes - 1) / 2) * step;
         world.addTorpedo({
            id: world._nextId++, pos: { x: origin.x, y: origin.y }, start: { x: origin.x, y: origin.y },
            heading: h, dir: h, speed: tc.speed, speedKn: tc.speedKn, side: this.side, owner: this.side, ownerId: this.id,
            dmg: tc.dmg * this.dmgMult, flood: tc.flood, range: tc.range, detect: tc.detect,
            traveled: 0, age: 0, alive: true, spotted: this.side === 'player',
         });
      }
      l.reload = l.reloadMax;
      world.addEffect('torpLaunch', origin, 0.6, 8, { shipId: this.id, bearing });
      if (this.isPlayer) world.stats.torpsFired = (world.stats.torpsFired || 0) + l.tubes;
      return l.tubes;
   }

   useConsumable(world = this.world, key) {
      if (!this.alive) return false;
      const c = this.consumable(key);
      if (!c || c.active || c.cd > 0 || c.charges <= 0) return false;
      if (c.charges !== Infinity) c.charges--;
      c.active = true;
      c.t = c.dur;
      if (key === 'damageControl') {
         this.fires.length = 0; this.floods.length = 0;
         this.modules.engine = 0; this.modules.rudder = 0;
         for (const t of this.turrets) if (!t.alive) { t.alive = true; t.disabledT = 0; }
      } else if (key === 'smoke') {
         this._smokeT = 0;
      }
      world.pushEvent('consumable', { srcId: this.id, text: c.name, key });
      return true;
   }

   // ================= damage =================
   takeDamage(amount, shooter, type, poolShare = 0.5) {
      if (!this.alive || !(amount > 0)) return 0;
      const amt = Math.min(amount, this.hp);
      this.hp -= amt;
      this.dmgTaken += amt;
      this.healPool = Math.min(this.maxHP, this.healPool + amt * poolShare);
      this.hitFlash = 1;
      this.lastHitT = this.world ? this.world.time : 0;
      if (shooter) { shooter.dmgDealt += amt; this.lastAttackerId = shooter.id; }
      if (this.world) this.world.onDamage(this, shooter, amt, type);
      if (this.hp <= 0.5) this._sink(shooter, type);
      return amt;
   }
   ignite(zone, shooter) {
      if (!this.alive || this.consumableActive('damageControl')) return false;
      if (this.fires.length >= WORLD.FIRE_MAX || this.fires.some(f => f.zone === zone)) return false;
      const dur = FIRE_DUR[this.type] || 40;
      this.fires.push({ zone, t: dur, dur, srcId: shooter ? shooter.id : null, mult: shooter ? shooter.dmgMult || 1 : 1 });
      if (this.world) this.world.onStatus(this, shooter, 'fire', zone);
      return true;
   }
   flood(zone, shooter) {
      if (!this.alive || this.consumableActive('damageControl')) return false;
      if (this.floods.length >= WORLD.FLOOD_MAX || this.floods.some(f => f.zone === zone)) return false;
      this.floods.push({ zone, t: FLOOD_DUR, dur: FLOOD_DUR, srcId: shooter ? shooter.id : null, mult: shooter ? shooter.dmgMult || 1 : 1 });
      if (this.world) this.world.onStatus(this, shooter, 'flood', zone);
      return true;
   }
   // A penetrating hit knocked out whatever sits near the impact point.
   damageModule(lp, shooter) {
      if (!this.alive || this.consumableActive('damageControl')) return null;
      const L = this.cfg.hull.L;
      let what = null;
      const t = this.turrets.find(q => q.alive && Math.abs(q.off.x - lp.x) < 9);
      if (t) { t.alive = false; t.disabledT = MODULE_T + 5; what = 'Geschützturm ausgefallen'; }
      else if (lp.x < -L * 0.36) { this.modules.rudder = MODULE_T; what = 'Ruderanlage beschädigt'; }
      else if (Math.abs(lp.x) < L * 0.18) { this.modules.engine = MODULE_T; what = 'Maschine ausgefallen'; }
      if (what && this.world) this.world.pushEvent('module', { srcId: shooter ? shooter.id : null, dstId: this.id, text: what });
      return what;
   }
   _sink(killer, type) {
      if (!this.alive) return;
      this.alive = false;
      this.sinking = true;
      this.sinkT = 0;
      this.hp = 0;
      this.floods.length = 0;
      if (this.world) this.world.onSink(this, killer, type);
   }

   // ================= simulation =================
   update(dt, world = this.world) {
      if (!this.alive) {
         if (this.sinking) {
            this.sinkT = Math.min(1, this.sinkT + dt / WORLD.SINK_TIME);
            this.speed *= Math.pow(0.6, dt);
            this.omega *= Math.pow(0.5, dt);
            this.heading += this.omega * dt;
            this.pos.x += Math.cos(this.heading) * this.speed * dt;
            this.pos.y += Math.sin(this.heading) * this.speed * dt;
            for (const f of this.fires) f.t = Math.max(f.t, 5);
            if (this.sinkT >= 1) this.sinking = false;
         }
         return;
      }
      this.hitFlash = Math.max(0, this.hitFlash - dt * 2.5);
      this._updateTimers(dt, world);
      this._move(dt, world);
      this._updateTurrets(dt);
      if (this.sec) this._secondaries(dt, world);
   }

   _updateTimers(dt, world) {
      const mods = this.modules;
      if (mods.engine > 0) mods.engine = Math.max(0, mods.engine - dt);
      if (mods.rudder > 0) mods.rudder = Math.max(0, mods.rudder - dt);
      for (const c of this.consumables) {
         if (c.active) {
            c.t -= dt;
            if (c.key === 'repair' && this.healPool > 0) {
               const h = Math.min(this.healPool, (c.heal || 0.005) * this.maxHP * dt, this.maxHP - this.hp);
               this.hp += h; this.healPool -= h;
               if (this.isPlayer) world.stats.healed = (world.stats.healed || 0) + h;
            }
            if (c.key === 'smoke') {
               this._smokeT -= dt;
               if (this._smokeT <= 0) {
                  this._smokeT = 1.1;
                  const st = toWorld(this, { x: -this.cfg.hull.L * 0.3, y: 0 });
                  world.addSmoke({ c: st, r: 40, maxR: c.radius || WORLD.SMOKE_RADIUS, life: (c.life || WORLD.SMOKE_LIFE) + c.t, side: this.side, ownerId: this.id });
               }
            }
            if (c.t <= 0) { c.active = false; c.t = 0; c.cd = c.cdMax; }
         } else if (c.cd > 0) c.cd = Math.max(0, c.cd - dt);
      }
      // damage over time
      if (this.fires.length || this.floods.length) {
         for (const f of this.fires) {
            f.t -= dt;
            this.takeDamage(WORLD.FIRE_DPS * this.maxHP * f.mult * dt, world.shipById(f.srcId), 'fireDot', 1);
            if (!this.alive) return;
         }
         for (const f of this.floods) {
            f.t -= dt;
            this.takeDamage(WORLD.FLOOD_DPS * this.maxHP * f.mult * dt, world.shipById(f.srcId), 'floodDot', 1);
            if (!this.alive) return;
         }
         if (this.fires.some(f => f.t <= 0)) this.fires = this.fires.filter(f => f.t > 0);
         if (this.floods.some(f => f.t <= 0)) this.floods = this.floods.filter(f => f.t > 0);
      }
      if (this.torps) for (const l of this.torps.launchers) if (l.reload > 0) l.reload = Math.max(0, l.reload - dt);
      // detectability: gun bloom after main-battery fire, smoke hides when not firing
      const d = this.cfg.detect, env = world.env || {};
      const vis = env.visibility ?? 1;
      const blooming = world.time - this.lastMainFire < WORLD.BLOOM_TIME;
      const smoked = world.inSmoke(this.pos);
      this.inSmoke = smoked;
      this.blooming = blooming;
      // muzzle flash is not dimmed by weather or night and reaches at least the gun range, so a
      // ship can never shoot from beyond its own bloom outside smoke (as in WoWs)
      const bloom = Math.max(d.fire, this.cfg.main ? this.cfg.main.range : 0);
      this.detectRange = Math.min(env.spotCap ?? Infinity, smoked ? (blooming ? d.smokeFire : 0) : blooming ? bloom : d.surface * vis);
   }

   _move(dt, world) {
      const cfg = this.cfg, h = cfg.hull;
      // rudder follows the command at the rudder-shift rate (centre -> full = rudderShift s)
      if (this.modules.rudder <= 0) this.rudder = approach(this.rudder, this.rudderCmd / 2, dt / cfg.rudderShift);
      const vmax = this.maxSpeed;
      const thr = this.modules.engine > 0 ? 0 : (WORLD.TELEGRAPH[this.telegraph] ?? 0);
      const target = thr * vmax * (1 - (TURN_LOSS[this.type] || 0.2) * Math.abs(this.rudder) * clamp01(Math.abs(this.speed) / vmax));
      const acc = vmax / cfg.accel;
      const accelerating = target * this.speed >= 0 && Math.abs(target) > Math.abs(this.speed);
      const rate = accelerating ? acc : acc * 1.4;
      this.speed = approach(this.speed, target, rate * dt);
      // yaw: turning circle radius at full rudder, needs way on the ship
      const omegaT = (this.speed / cfg.turnR) * this.rudder;
      this.omega += (omegaT - this.omega) * (1 - Math.exp(-dt / (YAW_TAU[this.type] || 2)));
      this.heading = (((this.heading + this.omega * dt) % TAU) + TAU) % TAU;
      this.heel += ((-this.omega * Math.abs(this.speed) * 0.006) - this.heel) * (1 - Math.exp(-dt / 1.5));
      const c = Math.cos(this.heading), s = Math.sin(this.heading);
      this.vel.x = c * this.speed; this.vel.y = s * this.speed;
      this.pos.x += this.vel.x * dt; this.pos.y += this.vel.y * dt;
      this.speedKn = this.speed / WORLD.KN_TO_MS;
      // map border: hard stop like WoWs
      const A = world.arena - 60;
      if (Math.abs(this.pos.x) > A || Math.abs(this.pos.y) > A) {
         this.pos.x = clamp(this.pos.x, -A, A); this.pos.y = clamp(this.pos.y, -A, A);
         this.speed *= Math.pow(0.1, dt);
      }
      // islands: probe bow, midships and stern; push the hull back out along the coast normal
      this.grounded = false;
      const half = h.L / 2;
      for (const o of world.obstacles) {
         if (o.kind !== 'island') continue;
         const R = (o.rMax || o.r * 1.6) + half + 20;
         if (dist2(o.c, this.pos) > R * R) continue;
         for (const f of [0.92, 0.45, 0, -0.45, -0.92]) {
            const p = { x: this.pos.x + c * half * f, y: this.pos.y + s * half * f };
            const t = obstacleT(o, p);
            if (t >= 1) continue;
            const ang = Math.atan2(p.y - o.c.y, p.x - o.c.x);
            const push = (1 - t) * obstacleRadiusAt(o, ang) + 1.5;
            this.pos.x += Math.cos(ang) * push; this.pos.y += Math.sin(ang) * push;
            this.grounded = true;
         }
      }
      if (this.grounded) { this.speed *= Math.pow(0.03, dt); this.omega *= Math.pow(0.3, dt); }
   }

   _updateTurrets(dt) {
      const m = this.cfg.main;
      const aim = this.aimPoint;
      const step = m.traverseRad * dt;
      let inRange = false, R = 0;
      if (aim) { R = Math.hypot(aim.x - this.pos.x, aim.y - this.pos.y); inRange = R <= m.range; }
      this.aimRange = R; this.inRange = inRange;
      const elevT = aim ? launchAngle(m, Math.min(R, m.range)) : 0;
      for (const t of this.turrets) {
         if (t.reload > 0) t.reload = Math.max(0, t.reload - dt);
         if (!t.alive) {
            t.disabledT -= dt;
            if (t.disabledT <= 0) { t.alive = true; t.disabledT = 0; }
            t.aligned = false;
            continue;
         }
         let ta = 0; t.canBear = false;
         if (aim) {
            const wp = toWorld(this, t.off);
            const rel = angleDelta(this.heading, Math.atan2(aim.y - wp.y, aim.x - wp.x));
            const aRel = angleDelta(t.arcC, rel);
            t.canBear = Math.abs(aRel) <= t.arcW;
            ta = clamp(aRel, -t.arcW, t.arcW);
         }
         // slew inside the arc only (never through the dead zone behind the superstructure)
         const a = approach(angleDelta(t.arcC, t.bearing), ta, step);
         t.bearing = angleDelta(0, t.arcC + a);
         t.err = Math.abs(ta - a);
         t.aligned = t.canBear && t.err <= WORLD.ALIGN_TOL;
         t.elev = approach(t.elev, elevT, dt * 0.08);
      }
   }

   // Secondary battery: auto-fires at the locked or nearest visible enemy inside its range,
   // one broadside per side, individual mounts staggered across the reload.
   _secondaries(dt, world) {
      const sc = this.cfg.sec, st = this.sec;
      st.retarget -= dt;
      if (st.retarget <= 0) {
         st.retarget = 1;
         st.target = null;
         let best = sc.range * sc.range;
         const lock = this.lockTarget != null ? world.shipById(this.lockTarget) : null;
         if (lock && lock.alive && world.canSee(this.side, lock) && dist2(lock.pos, this.pos) < best) st.target = lock;
         else for (const e of world.ships) {
            if (!e.alive || e.side === this.side || !world.canSee(this.side, e)) continue;
            const d2 = dist2(e.pos, this.pos);
            if (d2 < best) { best = d2; st.target = e; }
         }
      }
      const tg = st.target;
      if (!tg || !tg.alive) return;
      const sideIdx = toLocal(this, tg.pos).y >= 0 ? 1 : 0;
      st.t[sideIdx] -= dt;
      if (st.t[sideIdx] > 0) return;
      const perSide = Math.max(1, Math.round(sc.guns / 2));
      st.t[sideIdx] = sc.reload / perSide * (0.8 + world.rng() * 0.4);
      const k = Math.floor(world.rng() * perSide);
      const mount = toWorld(this, { x: (k / Math.max(1, perSide - 1) - 0.5) * this.cfg.hull.L * 0.45, y: (sideIdx ? 1 : -1) * this.cfg.hull.beam * 0.42 });
      const R = Math.hypot(tg.pos.x - mount.x, tg.pos.y - mount.y);
      const tf = flightTime(sc, R);
      const aim = { x: tg.pos.x + tg.vel.x * tf * 0.9, y: tg.pos.y + tg.vel.y * tf * 0.9 };
      world.addShell(makeShell(world, this, mount, aim, sc, 'sec', 'HE'));
      world.addEffect('muzzle', mount, 0.2, 5, { shipId: this.id, sec: true, caliber: sc.caliber, bearing: Math.atan2(aim.y - mount.y, aim.x - mount.x) });
   }

   // ================= legacy read-outs (old hud.js / main3d.js) =================
   get speedKnots() { return Math.abs(this.speedKn); }
   get shotsHit() { return this.hits; }
   // Main-battery shell flight time to range R (clamped to max range), for the lead indicator.
   flightTime(R) { return flightTime(this.cfg.main, Math.min(Math.max(R, 0), this.cfg.main.range)); }
   get fireTimer() {
      let best = Infinity;
      for (const t of this.turrets) if (t.alive) best = Math.min(best, t.reload);
      return best === Infinity ? 0 : best;
   }
   get secTimer() { return 0; }
   get torpTimer() {
      if (!this.torps) return 0;
      return Math.min(...this.torps.launchers.map(l => l.reload));
   }
   get boost() {
      const b = this.consumable('boost');
      return b ? { active: b.active, t: b.t, cd: b.cd } : { active: false, t: 0, cd: 0 };
   }
   get repairT() { const r = this.consumable('repair'); return r && r.active ? r.t : 0; }
   get anchorOut() { return false; }
   set anchorOut(v) { /* no anchor in the WoWs model */ }
   fireSecondary() { return 0; }
   fireAA() { return 0; }
   fireTorpedo(world, target, aimVec) { return this.fireTorpedoes(world, aimVec ? Math.atan2(aimVec.y, aimVec.x) : this.heading); }
   repairAll() { return this.useConsumable(this.world, 'damageControl'); }
}
