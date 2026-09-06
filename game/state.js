// game/state.js — the World: central container, dispatch, and query surface for every module.
import { add, sub, dist, fromAngle, angleOf, clamp, pick, TAU } from './utils.js';
import { WORLD, SHIPS, ENCOUNTER, OBSTACLES, DIFFICULTY, COMBAT, TUNE } from './config.js';
import { Ship } from './ship.js';
import { resolveShells, resolveTorpedoes, resolveAA } from './combat.js';

let SEQ = 0;
export class World {
   constructor(difficulty = 'normal', seed = null) {
      this.difficulty = DIFFICULTY[difficulty] || DIFFICULTY.normal;
      this.difficultyKey = difficulty;
      this.time = 0;
      this.phase = 'playing';   // playing | won | lost
      this.ships = [];
      this.shells = [];
      this.torpedoes = [];
      this.aaTracers = [];
      this.particles = [];
      this.effects = [];        // {kind, ...} rendered each frame
      this.smokeClouds = [];
      this.damageNumbers = [];
      this.obstacles = OBSTACLES.map(o => ({ ...o, lobes: o.irregular ? makeIslandLobes(o) : null }));
      this.player = null;
      this.bots = [];
      this.events = [];         // sink events etc. for HUD/log
      this.logLines = [];
      this._spawn();
      this.log(null, '⚓ In See — feindliche Flotte gesichtet', 'warn');
      this.killCount = 0;
      this.seed = seed;
    }

   _spawn() {
       // Player Bismarck at origin facing east
      this.player = new Ship(this, 'Bismarck', 'player', { x: 0, y: 0 }, 0);
      this.ships.push(this.player);
       // Enemy wave
      for (const spec of ENCOUNTER.bots) {
         const r = ENCOUNTER.ring;
         const p = fromAngle(spec.bearing, r);
         p.x += this.player.pos.x; p.y += this.player.pos.y;
         const facesPlayer = angleOf(sub(this.player.pos, p));
         const bot = new Ship(this, spec.cls, 'enemy', p, facesPlayer, {
            hpMult: this.difficulty.botHP,
            dmgMult: this.difficulty.botDmg,
         });
         this.bots.push(bot);
         this.ships.push(bot);
       }
    }

    spawnPressure() {
       for (const spec of ENCOUNTER.pressure) {
         const r = ENCOUNTER.ring;
         const p = fromAngle(spec.bearing, r);
         p.x += this.player.pos.x; p.y += this.player.pos.y;
         const bot = new Ship(this, spec.cls, 'enemy', p, angleOf(sub(this.player.pos, p)),
            { hpMult: this.difficulty.botHP, dmgMult: this.difficulty.botDmg });
         this.bots.push(bot); this.ships.push(bot);
       }
       this.log(null, '⚠ Verstärkung gesichtet!', 'warn');
    }

   // ---- queries used by AI / combat ----
   enemiesOf(ship) {
      const out = [];
      for (const s of this.ships) if (s.alive && s.side !== ship.side) out.push(s);
      return out;
    }
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
   enemyLeader(ship) {
       // the enemy battleship (or heaviest) is the squad leader
      let best = null, bestHP = -1;
      for (const s of this.enemiesOf(ship)) {
         if (s.cls === 'EB' || s.maxHP > bestHP) { bestHP = s.maxHP; best = s; }
       }
      return best;
   }
   inSmoke(pos, side) {
      for (const c of this.smokeClouds) {
         if (c.side === side) continue; // your own smoke hides you, not others
         if (dist(pos, c.c) < c.r) return true;
       }
      return false;
   }
   smokeCloudAt(pos, side) {
      let best = null, bestD = 1e9;
      for (const c of this.smokeClouds) {
         if (c.side === side) continue;
         const d = dist(pos, c.c);
         if (d < c.r && d < bestD) { bestD = d; best = c.c; }
       }
      return best;
   }

   // ---- dispatch: projectiles ----
   spawnShell(shooter, muzzle, dir, gun, kind = 'main') {
      if (this.shells.length > TUNE.maxProjectiles) return;
      const dmgMult = shooter.dmgMult || 1;
      this.shells.push({
         id: ++SEQ, pos: { x: muzzle.x, y: muzzle.y },
         vel: { x: dir.x * (gun.vShell || 650), y: dir.y * (gun.vShell || 650) },
         dir: angleOf(dir),
         owner: shooter.side,
         shooter, gun, kind,
         dmg: gun.dmg * dmgMult * (kind === 'sec' ? 0.5 : 1),
         ap: gun.ap || 0,
         type: gun.type || 'AP',
         age: 0,
         arc: 0,           // for visual parabola
         arcDur: Math.hypot(dir.x, dir.y) > 0 ? (dist(muzzle, shooter.pos) / (gun.vShell || 650)) + 1.2 : 1.2,
         alive: true,
      });
   }

   spawnTorpedo(shooter, muzzle, dir, torp) {
      const dmgMult = shooter.dmgMult || 1;
      this.torpedoes.push({
         id: ++SEQ, pos: { x: muzzle.x, y: muzzle.y },
         vel: { x: dir.x * torp.speed, y: dir.y * torp.speed },
         dir: angleOf(dir), owner: shooter.side, shooter,
         dmg: torp.dmg * dmgMult, range: torp.range, age: 0, alive: true, wake: [],
      });
   }

   spawnAA(shooter, dir, target) {
       // rapid tracers at a target (visual + light dps)
      for (let i = 0; i < 4; i++) {
         this.aaTracers.push({
            pos: { x: shooter.pos.x + (Math.random() - 0.5) * 30, y: shooter.pos.y + (Math.random() - 0.5) * 30 },
            dir: dir + (Math.random() - 0.5) * 0.2,
            owner: shooter.side, age: 0, life: 1.2,
         });
       }
   }

   addMuzzleFlash(ship, bearing) {
      this.effects.push({ kind: 'muzzle', pos: { x: ship.pos.x, y: ship.pos.y }, bearing, age: 0, life: 0.08, big: ship.cls === 'Bismarck' || ship.cls === 'EB' });
   }

   emitSmokePuff(ship, dt) {
      this._smokeAccum = (this._smokeAccum || 0) + dt;
      if (this._smokeAccum > 0.15) {
         this._smokeAccum = 0;
         // find or create a cloud trailing the ship
         let cloud = this.smokeClouds.find(c => c.side === ship.side && c.ship === ship && dist(c.c, ship.pos) < WORLD.SMOKE_RADIUS * 0.7);
         if (!cloud) {
            cloud = { c: { x: ship.pos.x, y: ship.pos.y }, r: WORLD.SMOKE_RADIUS * 0.4, age: 0, life: WORLD.SMOKE_DURATION + 2, side: ship.side, ship, targetR: WORLD.SMOKE_RADIUS };
            this.smokeClouds.push(cloud);
         }
         this.particles.push({ kind: 'smoke', pos: { x: ship.pos.x + (Math.random() - 0.5) * 20, y: ship.pos.y + (Math.random() - 0.5) * 20 },
            vel: fromAngle(ship.heading + Math.PI + (Math.random() - 0.5) * 0.6, 10 + Math.random() * 15),
            age: 0, life: WORLD.SMOKE_DURATION, r: 30 + Math.random() * 30, side: ship.side });
      }
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
      this.events.push({ kind: 'sink', ship, t: this.time });
      // win is checked BEFORE loss: a simultaneous sink (mutual kill) counts as a victory
      if (ship.side === 'enemy' && this.bots.every(b => !b.alive)) this._win();
      else if (ship === this.player) this._lose();
   }

   _win() { if (this.phase === 'playing') { this.phase = 'won'; this.log(null, '🏆 Alle Feinde versenkt — Sieg!', 'kill'); } }
   _lose() { if (this.phase === 'playing') { this.phase = 'lost'; this.log(null, '💀 Die Bismarck ist gesunken — Niederlage.', 'warn'); } }

   update(dt) {
      this.time += dt;
       // fire control pressure wave
      if (!this._pressureSpawned && this.time > ENCOUNTER.pressureAt && this.bots.some(b => b.alive)) {
         this._pressureSpawned = true; this.spawnPressure();
       }
       // update ships (movement + timers + DoT)
      for (const s of this.ships) s.update(dt);
       // projectiles, torpedoes, effects, particles
      this._updateShells(dt);
      this._updateTorpedoes(dt);
      this._updateAA(dt);
      this._updateEffects(dt);
      this._updateSmoke(dt);
      this._updateDamageNumbers(dt);
       // shake decay
      if (this._shake) { this._shake *= Math.pow(0.02, dt); if (this._shake < 0.1) this._shake = 0; }
       // win/lose recheck
      if (this.phase === 'playing' && this.bots.every(b => !b.alive)) this._win();
   }

    // ---- combat resolution (delegated to combat.js to keep this file focused) ----
   _updateShells(dt) { resolveShells(this, dt); }
   _updateTorpedoes(dt) { resolveTorpedoes(this, dt); }
   _updateAA(dt) { resolveAA(this, dt); }

    // smoke & particles & effects are pure decay — keep inline
   _updateSmoke(dt) {
      for (const c of this.smokeClouds) { c.age += dt; c.life -= dt; c.r = Math.min(c.targetR, c.r + dt * 120); }
      this.smokeClouds = this.smokeClouds.filter(c => c.life > 0);
      for (const p of this.particles) {
         p.age += dt; p.life -= dt;
         p.pos = add(p.pos, scaleV(p.vel, dt));
         p.vel = scaleV(p.vel, 0.96);
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

function scaleV(v, s) { return { x: v.x * s, y: v.y * s }; }

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
