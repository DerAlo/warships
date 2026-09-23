// game/state.js — the World: central container, dispatch, vision and query surface for every module.
import { add, sub, dist, fromAngle, angleOf, clamp, clamp01, pick, pointSegDist, TAU } from './utils.js';
import { WORLD, ENCOUNTER, OBSTACLES, DIFFICULTY, TUNE, VISION } from './config.js';
import { Ship } from './ship.js';
import { resolveShells, resolveTorpedoes, resolveAA } from './combat.js';

let SEQ = 0;
export class World {
   // mission (optional, the campaign hook): any ENCOUNTER field can be overridden --
   //   { player: {cls, pos, heading}, ring, bots: [{cls, bearing} | {cls, pos, heading}],
   //     pressureAt, pressure, obstacles, intro }
   constructor(difficulty = 'normal', seed = null, mission = null) {
      this.difficulty = DIFFICULTY[difficulty] || DIFFICULTY.normal;
      this.difficultyKey = difficulty;
      this.mission = { ...ENCOUNTER, ...(mission || {}) };
      this.seed = seed;
      this.time = 0;
      this.phase = 'playing';   // playing | won | lost
      this.ships = [];
      this.shells = [];
      this.torpedoes = [];
      this.aaTracers = [];
      this.aircraft = [];       // carrier hook: {pos, side, hp, alive}; ship AA engages these first
      this.particles = [];
      this.effects = [];        // {kind, ...} rendered each frame
      this.smokeClouds = [];
      this.damageNumbers = [];
      this.obstacles = (this.mission.obstacles || OBSTACLES).map(o => ({ ...o, lobes: o.irregular ? makeIslandLobes(o) : null }));
      this.player = null;
      this.bots = [];
      // gameplay event feed (sink, hit, salvo, cons, ammo, torp, ...). main.js drains it every
      // frame for audio/ribbons; headless runs just let it roll over.
      this.events = [];
      this.logLines = [];
      this.killCount = 0;
      this._shake = 0;
      this._spawn();
      this._updateVision(0);
      this.log(null, this.mission.intro || '⚓ In See — feindliche Flotte gesichtet', 'warn');
   }

   _spawn() {
      const P = this.mission.player || { cls: 'Bismarck', pos: { x: 0, y: 0 }, heading: 0 };
      this.player = new Ship(this, P.cls || 'Bismarck', 'player', P.pos || { x: 0, y: 0 }, P.heading || 0);
      this.ships.push(this.player);
      for (const spec of this.mission.bots) this.spawnBot(spec);
   }

   // spec: {cls, bearing} on the spawn ring around the player, or {cls, pos, heading}
   spawnBot(spec) {
      let p = spec.pos;
      if (!p) {
         p = fromAngle(spec.bearing || 0, spec.ring || this.mission.ring);
         p.x += this.player.pos.x; p.y += this.player.pos.y;
      }
      const heading = spec.heading ?? angleOf(sub(this.player.pos, p));
      const bot = new Ship(this, spec.cls, 'enemy', p, heading, {
         hpMult: this.difficulty.botHP,
         dmgMult: this.difficulty.botDmg,
      });
      this.bots.push(bot);
      this.ships.push(bot);
      return bot;
   }

   spawnPressure() {
      for (const spec of this.mission.pressure || []) this.spawnBot(spec);
      this.log(null, '⚠ Verstärkung gesichtet!', 'warn');
      this.emit({ kind: 'reinforce' });
   }

   emit(ev) {
      ev.t = this.time;
      this.events.push(ev);
      if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
   }

   // ---- queries used by AI / combat ----
   enemiesOf(ship) {
      const out = [];
      for (const s of this.ships) if (s.alive && s.side !== ship.side) out.push(s);
      return out;
   }
   // Truthful "you're spotted" for the HUD: the same vision pass the AI uses (_updateVision).
   isSpotted(ship) { return ship.alive && ship.visible; }
   nearestThreat(ship) {
      let best = Infinity;
      for (const s of this.enemiesOf(ship)) {
         // threat = guns that can hit, plus torpedoes
         const d = dist(ship.pos, s.pos);
         const range = Math.max(s.cfg.main.range, s.cfg.torp ? s.cfg.torp.range : 0);
         if (d < range) best = Math.min(best, d);
      }
      for (const t of this.torpedoes) if (t.owner !== ship.side) best = Math.min(best, dist(t.pos, ship.pos));
      for (const s of this.shells) if (s.owner !== ship.side) best = Math.min(best, dist(s.pos, ship.pos));
      return best;
   }
   nearestThreatPos(ship) {
      let best = null, bestD = Infinity;
      for (const s of this.enemiesOf(ship)) {
         const d = dist(ship.pos, s.pos);
         if (d < bestD) { bestD = d; best = s.pos; }
      }
      for (const t of this.torpedoes) if (t.owner !== ship.side) {
         const d = dist(t.pos, ship.pos); if (d < bestD) { bestD = d; best = t.pos; }
      }
      if (!best) best = { x: 0, y: 0 }; // arena center — never a dead ship's corpse
      return best;
   }
   safeZone(ship) {
      // farthest arena corner from all enemies
      const corners = [
         { x: -WORLD.ARENA + 300, y: -WORLD.ARENA + 300 },
         { x: WORLD.ARENA - 300, y: -WORLD.ARENA + 300 },
         { x: -WORLD.ARENA + 300, y: WORLD.ARENA - 300 },
         { x: WORLD.ARENA - 300, y: WORLD.ARENA - 300 },
      ];
      let best = corners[0], bestD = -1;
      for (const c of corners) {
         let md = Infinity;
         for (const e of this.enemiesOf(ship)) md = Math.min(md, dist(c, e.pos));
         for (const o of this.obstacles) md = Math.min(md, dist(c, o.c) - o.r);
         if (md > bestD) { bestD = md; best = c; }
      }
      return best;
   }
   alliesOf(ship) {
      const out = [];
      for (const s of this.ships) if (s.alive && s !== ship && s.side === ship.side) out.push(s);
      return out;
   }
   // squad leader of ship's own side: its battleship, else the heaviest ally
   enemyLeader(ship) {
      let best = null, bestHP = -1;
      for (const s of this.alliesOf(ship)) {
         if (s.cfg.ai && s.cfg.ai.role === 'battleship') return s;
         if (s.maxHP > bestHP) { bestHP = s.maxHP; best = s; }
      }
      return best;
   }

   // ---- smoke & vision ----
   // Smoke is neutral: every cloud blocks sight for both sides, and nothing else.
   smokeR(c) { return c.r * VISION.smokeEdge; }
   inSmoke(pos) {
      for (const c of this.smokeClouds) if (dist(pos, c.c) < this.smokeR(c)) return c;
      return null;
   }
   // cloud nearest to pos (optionally only clouds laid by `ship`), for AI "duck into smoke"
   smokeCloudAt(pos, ship = null, maxD = Infinity) {
      let best = null, bestD = maxD;
      for (const c of this.smokeClouds) {
         if (ship && c.ship !== ship) continue;
         if (c.life < 4) continue; // about to thin out
         const d = dist(pos, c.c);
         if (d < bestD) { bestD = d; best = c; }
      }
      return best;
   }
   // Does smoke block the sight line a->b? A target inside or behind a cloud is hidden; an
   // observer inside a cloud still sees out (no allied spotters in a 1-vs-fleet fight, so
   // blinding the smoker would make smoke useless for the player).
   smokeBlocks(a, b) {
      for (const c of this.smokeClouds) {
         const R = this.smokeR(c);
         if (dist(a, c.c) < R) continue;
         if (pointSegDist(c.c, a, b) < R) return true;
      }
      return false;
   }
   proxRange(ship) {
      return clamp(ship.cfg.L * VISION.proxLengths, VISION.proxMin, VISION.proxMax);
   }
   // Concealment model (WoWs): a ship is spotted by an enemy within ITS detect radius.
   detectRange(target) {
      const mult = target.side === 'player' && this.difficulty ? this.difficulty.detectMult : 1;
      return target.cfg.detect * (target.cfg.stealth || 1) * mult * (target.detectMult || 1);
   }
   // Why `obs` sees `tgt` ('prox' | 'sight' | 'bloom') or null.
   canSee(obs, tgt) {
      const d = dist(obs.pos, tgt.pos);
      if (d < this.proxRange(tgt)) return 'prox';
      const range = Math.min(this.detectRange(tgt), obs.cfg.sight || Infinity);
      const clear = !this.smokeBlocks(obs.pos, tgt.pos);
      if (clear && d < range) return 'sight';
      // a salvo from inside smoke flashes the shooter up out to its bloom range
      if (tgt.bloomT > 0 && d < tgt.bloomRange) return 'bloom';
      return null;
   }
   _updateVision() {
      for (const t of this.ships) {
         if (!t.alive) continue;
         const was = t.visible;
         let reason = null;
         for (const o of this.ships) {
            if (!o.alive || o.side === t.side) continue;
            const r = this.canSee(o, t);
            if (r) { reason = r; if (r !== 'bloom') break; }
         }
         t.visible = !!reason;
         t.visReason = reason;
         t.inSmokeNow = !!this.inSmoke(t.pos);
         if (t.visible) {
            const lk = t.lastKnown || (t.lastKnown = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, heading: 0, t: 0 });
            lk.pos.x = t.pos.x; lk.pos.y = t.pos.y;
            lk.vel.x = t.vel.x; lk.vel.y = t.vel.y;
            lk.heading = t.heading; lk.t = this.time;
         }
         if (was !== t.visible) this.emit({ kind: t.visible ? 'spotted' : 'lost', ship: t, reason });
      }
   }
   // dead-reckoned position of a hidden ship from its last sighting (AI blind fire / hunting)
   estimatePos(ship, maxExtrap = VISION.blindMaxExtrap) {
      const lk = ship.lastKnown;
      if (!lk) return null;
      const age = Math.min(this.time - lk.t, maxExtrap);
      return add(lk.pos, { x: lk.vel.x * age, y: lk.vel.y * age });
   }

   // ---- dispatch: projectiles ----
   // landRange: where the shell comes down (muzzle distance). The arc crests mid-flight and the
   // shell can only strike something in the last HANDLING.hitWindow of it (see combat.js).
   spawnShell(shooter, muzzle, dir, gun, kind = 'main', landRange = null) {
      if (this.shells.length > TUNE.maxProjectiles) return null;
      const dmgMult = shooter.dmgMult || 1;
      const vShell = gun.vShell || 650;
      const range = Math.max(landRange || gun.range || 800, 60);
      const s = {
         id: ++SEQ, pos: { x: muzzle.x, y: muzzle.y },
         vel: { x: dir.x * vShell, y: dir.y * vShell },
         dir: angleOf(dir),
         owner: shooter.side,
         shooter, gun, kind,
         dmg: gun.dmg * dmgMult * (kind === 'sec' ? 0.5 : 1),
         ap: gun.ap || 0,
         caliber: gun.caliber || 150,
         type: gun.type || 'AP',
         fire: gun.fire ?? 0,
         age: 0,
         arc: 0,           // 0..1 flight-phase fraction; drives visual height (render.js)
         arcDur: range / vShell,
         alive: true,
      };
      this.shells.push(s);
      return s;
   }

   spawnTorpedo(shooter, muzzle, dir, torp) {
      const dmgMult = shooter.dmgMult || 1;
      this.torpedoes.push({
         id: ++SEQ, pos: { x: muzzle.x, y: muzzle.y },
         vel: { x: dir.x * torp.speed, y: dir.y * torp.speed }, speed: torp.speed,
         dir: angleOf(dir), owner: shooter.side, shooter,
         dmg: torp.dmg * dmgMult, range: torp.range, age: 0, alive: true, wake: [],
      });
   }

   spawnAA(shooter, dir, target) {
      // rapid tracers at a target (visual only -- damage is applied by ship._autoAA)
      for (let i = 0; i < 4; i++) {
         this.aaTracers.push({
            pos: { x: shooter.pos.x + (Math.random() - 0.5) * 30, y: shooter.pos.y + (Math.random() - 0.5) * 30 },
            dir: dir + (Math.random() - 0.5) * 0.2,
            owner: shooter.side, age: 0, life: 1.2,
         });
      }
   }

   // pos: optional world point to flash at (a turret's muzzle) instead of the ship's centre
   addMuzzleFlash(ship, bearing, pos = null) {
      this.effects.push({ kind: 'muzzle', pos: pos ? { x: pos.x, y: pos.y } : { x: ship.pos.x, y: ship.pos.y }, bearing, age: 0, life: 0.08, big: ship.cfg.main.caliber >= 250, ship });
   }

   // Smoke generator tick: trails a chain of clouds behind the ship while active.
   emitSmokePuff(ship, dt) {
      ship._smokeAccum = (ship._smokeAccum || 0) + dt;
      if (ship._smokeAccum < 0.15) return;
      ship._smokeAccum = 0;
      const R = WORLD.SMOKE_RADIUS;
      let cloud = this.smokeClouds.find(c => c.ship === ship && c.fresh && dist(c.c, ship.pos) < R * 0.7);
      if (!cloud) {
         for (const c of this.smokeClouds) if (c.ship === ship) c.fresh = false;
         cloud = { c: { x: ship.pos.x, y: ship.pos.y }, r: R * 0.4, age: 0, life: WORLD.SMOKE_LIFE, side: ship.side, ship, targetR: R, fresh: true };
         this.smokeClouds.push(cloud);
      }
      this.particles.push({ kind: 'smoke', pos: { x: ship.pos.x + (Math.random() - 0.5) * 20, y: ship.pos.y + (Math.random() - 0.5) * 20 },
         vel: fromAngle(ship.heading + Math.PI + (Math.random() - 0.5) * 0.6, 10 + Math.random() * 15),
         age: 0, life: 9, r: 30 + Math.random() * 30, side: ship.side });
   }

   addExplosion(pos, big = false) {
      this.effects.push({ kind: 'explosion', pos: { ...pos }, age: 0, life: big ? 1.1 : 0.5, big });
      const n = big ? 40 : 16;
      for (let i = 0; i < n; i++) {
         const a = Math.random() * TAU, sp = (big ? 120 : 60) * Math.random();
         this.particles.push({ kind: 'spark', pos: { x: pos.x, y: pos.y }, vel: { x: Math.cos(a) * sp, y: Math.sin(a) * sp },
            age: 0, life: 0.5 + Math.random() * 0.6, r: 2 + Math.random() * 3, color: pick(['#ffd24a', '#ff7a2d', '#ffb03a']) });
      }
   }

   addSplash(pos, big = false) {
      // water column for a bounced/missed shell
      this.effects.push({ kind: 'splash', pos: { ...pos }, age: 0, life: 0.6, big });
      for (let i = 0; i < (big ? 14 : 6); i++) {
         const a = Math.random() * TAU, sp = (big ? 80 : 40) * Math.random();
         this.particles.push({ kind: 'water', pos: { x: pos.x, y: pos.y }, vel: { x: Math.cos(a) * sp, y: Math.sin(a) * sp },
            age: 0, life: 0.5 + Math.random() * 0.4, r: 3 + Math.random() * 4, color: '#bfe3ff' });
      }
   }

   addDamageNumber(pos, amount, type = 'dmg') {
      this.damageNumbers.push({ pos: { x: pos.x + (Math.random() - 0.5) * 20, y: pos.y }, text: Math.round(amount).toString(), age: 0, life: 1.2, type });
   }

   log(who, text, type = 'info') {
      const line = { text: (who && who.name ? who.name + ': ' : '') + text, type, t: this.time };
      this.logLines.push(line);
      if (this.logLines.length > 60) this.logLines.shift();
   }

   shakeAdd(m) { this._shake = Math.max(this._shake || 0, m); }

   onSink(ship) {
      if (ship.side === 'enemy') this.killCount++;
      this.log(null, (ship.side === 'enemy' ? '🎯 Versenkt: ' : '💀 Verlust: ') + ship.name, ship.side === 'enemy' ? 'kill' : 'warn');
      // big explosion + fire
      for (let i = 0; i < 3; i++) this.addExplosion({ x: ship.pos.x + (Math.random() - 0.5) * 40, y: ship.pos.y + (Math.random() - 0.5) * 40 }, true);
      for (let i = 0; i < 6; i++) this.particles.push({ kind: 'smoke', pos: { x: ship.pos.x + (Math.random() - 0.5) * 60, y: ship.pos.y },
         vel: { x: (Math.random() - 0.5) * 30, y: -20 - Math.random() * 30 }, age: 0, life: 6, r: 40 + Math.random() * 60, side: ship.side });
      this.emit({ kind: 'sink', ship, by: ship.lastHitBy });
      // win is checked BEFORE loss: a simultaneous sink (mutual kill) counts as a victory
      if (ship.side === 'enemy' && this.bots.every(b => !b.alive)) this._win();
      else if (ship === this.player) this._lose();
   }

   _win() { if (this.phase === 'playing') { this.phase = 'won'; this.log(null, '🏆 Alle Feinde versenkt — Sieg!', 'kill'); } }
   _lose() { if (this.phase === 'playing') { this.phase = 'lost'; this.log(null, '💀 Die Bismarck ist gesunken — Niederlage.', 'warn'); } }

   update(dt) {
      this.time += dt;
      // reinforcement wave
      const M = this.mission;
      if (!this._pressureSpawned && M.pressure && M.pressure.length && this.time > M.pressureAt && this.bots.some(b => b.alive)) {
         this._pressureSpawned = true; this.spawnPressure();
      }
      for (const s of this.ships) s.update(dt);
      this._updateShells(dt);
      this._updateTorpedoes(dt);
      this._updateAA(dt);
      this._updateEffects(dt);
      this._updateSmoke(dt);
      this._updateVision();
      this._updateDamageNumbers(dt);
      // shake decay
      if (this._shake) { this._shake *= Math.pow(0.02, dt); if (this._shake < 0.1) this._shake = 0; }
      if (this.phase === 'playing' && this.bots.every(b => !b.alive)) this._win();
   }

   // ---- combat resolution (delegated to combat.js to keep this file focused) ----
   _updateShells(dt) { resolveShells(this, dt); }
   _updateTorpedoes(dt) { resolveTorpedoes(this, dt); }
   _updateAA(dt) { resolveAA(this, dt); }

   // smoke & particles & effects are pure decay — keep inline
   _updateSmoke(dt) {
      for (const c of this.smokeClouds) {
         c.age += dt; c.life -= dt;
         // billows out to full size, then thins away over the last 3 s
         const grown = Math.min(c.targetR, c.r + dt * 120);
         c.r = c.life < 3 ? Math.min(grown, c.targetR * clamp01(c.life / 3)) : grown;
      }
      this.smokeClouds = this.smokeClouds.filter(c => c.life > 0);
      for (const p of this.particles) {
         p.age += dt; p.life -= dt;
         p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt;
         p.vel.x *= 0.96; p.vel.y *= 0.96;
      }
      this.particles = this.particles.filter(p => p.life > 0);
      if (this.particles.length > TUNE.maxParticles) this.particles.splice(0, this.particles.length - TUNE.maxParticles);
   }
   _updateDamageNumbers(dt) {
      for (const d of this.damageNumbers) { d.age += dt; d.life -= dt; d.pos.y -= dt * 30; }
      this.damageNumbers = this.damageNumbers.filter(d => d.life > 0);
   }
   _updateEffects(dt) {
      for (const e of this.effects) { e.age += dt; e.life -= dt; }
      this.effects = this.effects.filter(e => e.life > 0);
   }
}

function makeIslandLobes(o) {
   // irregular silhouette for the island obstacle (render-only)
   const lobes = [];
   for (let i = 0; i < 48; i++) {
      const a = (i / 48) * TAU;
      const r = o.r * (1 + 0.18 * Math.sin(a * 3 + 1) + 0.1 * Math.cos(a * 5) + 0.06 * Math.sin(a * 7));
      lobes.push({ a, r });
   }
   return lobes;
}
