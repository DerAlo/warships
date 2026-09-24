// game/combat.js — projectile motion + the WoWs-style damage model (ricochet / citadel / overpen /
// HE / fire / flood). Smoke is deliberately absent here: it blocks sight (state.js), not shells.
// Convention: ship local coords  +X = bow (forward), +Y = starboard.
import { add, dist, dist2, fromAngle, norm, clamp, clamp01 } from './utils.js';
import { WORLD, COMBAT, TUNE, HANDLING, MINES, DCHARGE } from './config.js';

// Small margin so a shell skimming the deck edge still counts as a hit.
const HIT_MARGIN = 6;

// Point-in-hull test in the ship's local frame. Returns {along, across} or null if outside.
// along = distance along the keel (bow +), across = distance across the beam (starboard +).
export function localImpact(ship, pos, margin = HIT_MARGIN) {
   const dx = pos.x - ship.pos.x, dy = pos.y - ship.pos.y;
   const ca = Math.cos(-ship.heading), sa = Math.sin(-ship.heading);
   const along = dx * ca - dy * sa;
   const across = dx * sa + dy * ca;
   const halfB = ship.cfg.beam / 2 + margin, halfL = ship.cfg.L / 2 + margin;
   if (Math.abs(along) > halfL || Math.abs(across) > halfB) return null;
   return { along, across };
}

// ---------- SHELLS ----------
// Plunging fire: a shell flies to the range it was aimed at and can only strike a hull or an island
// in the descending tail of its arc (HANDLING.hitWindow), then splashes a little past the aim point.
// So it arcs over ships and rocks in between, and passes straight through smoke.
export function resolveShells(world, dt) {
   const ships = world.ships;
   for (let i = world.shells.length - 1; i >= 0; i--) {
      const s = world.shells[i];
      const prev = { x: s.pos.x, y: s.pos.y };
      s.age += dt;
      s.arc = clamp01(s.age / s.arcDur);
      s.pos.x += s.vel.x * dt; s.pos.y += s.vel.y * dt;

      if (s.age > TUNE.shellLife || Math.abs(s.pos.x) > WORLD.ARENA + 500 || Math.abs(s.pos.y) > WORLD.ARENA + 500) {
         world.shells.splice(i, 1);
         continue;
      }
      if (s.age < s.arcDur * (1 - HANDLING.hitWindow)) continue; // still high overhead

      // hulls first: a ship moored against a shore (coastal battery) must still be hittable
      // test the previous position too: ~11 m/frame could tunnel through a 13 m destroyer beam
      let hit = false;
      for (const ship of ships) {
         if (!ship.alive || ship.side === s.owner) continue;
         // a submarine at periscope depth only takes quick-firing secondaries; deep it takes nothing
         if (ship.depth >= 1.5 || (ship.depth >= 0.5 && s.kind !== 'sec')) continue;
         const imp = localImpact(ship, s.pos) || localImpact(ship, prev);
         if (imp) { resolveHit(world, ship, s, imp); hit = true; break; }
      }
      if (hit) { world.shells.splice(i, 1); continue; }
      if (hitsIsland(world, s.pos)) {
         world.addExplosion(s.pos, false);
         world.shells.splice(i, 1);
         continue;
      }
      if (s.age >= s.arcDur * (1 + HANDLING.overshoot)) {
         world.addSplash(s.pos, s.kind === 'main' && s.caliber >= 250);
         if (world.mines.length) detonateMinesNear(world, s.pos, 40, s.shooter);
         world.shells.splice(i, 1);
      }
   }
}

// Solid-rock test — reefs are shallow water and don't stop anything, only islands do.
// Ground right around a coastal battery is its apron, not cover: a shell there flies on and can
// still strike the fort (otherwise the shoreline in front would soak up every shell aimed at it).
function hitsIsland(world, pos) {
   for (const o of world.obstacles) {
      if (o.kind !== 'island') continue;
      if (dist2(pos, o.c) < o.r * o.r) {
         for (const s of world.bots) if (s.alive && s.cfg.static && dist2(pos, s.pos) < 120 * 120) return false;
         return true;
      }
   }
   return false;
}

// Incidence of a shell against the side belt: 0 = square to the keel (broadside), PI/2 = along it
// (bow-on). Angling the hull is therefore the defensive skill, exactly as in WoWs.
export function beltIncidence(ship, shellVel) {
   const d = norm(shellVel);
   const n = fromAngle(ship.heading + Math.PI / 2);
   return Math.acos(clamp(Math.abs(d.x * n.x + d.y * n.y), 0, 1));
}

// Pure outcome roll for a shell striking `ship` (no side effects): exported for tests.
// Returns { outcome: 'CITADEL'|'PEN'|'OVERPEN'|'RICOCHET'|'HE'|'SEC', dmg, fire }.
export function rollHit(ship, shell, imp, rnd = Math.random) {
   const armor = ship.cfg.armor || 100;
   const halfL = ship.cfg.L / 2;
   const inCitadel = Math.abs(imp.along) < COMBAT.citadelLen * halfL;
   if (shell.type === 'HE') {
      // HE never bounces; heavy belts soak part of the blast
      const k = clamp(COMBAT.heBase - armor / COMBAT.heArmorDiv, COMBAT.heMin, 1);
      return { outcome: shell.kind === 'sec' ? 'SEC' : 'HE', dmg: shell.dmg * k, fire: rnd() < (shell.fire || COMBAT.heFireDefault) };
   }
   const inc = beltIncidence(ship, shell.vel);
   const overmatch = armor < shell.ap * COMBAT.overmatch;
   if (!overmatch) {
      const pRic = clamp01((inc - COMBAT.ricStart) / (COMBAT.ricAuto - COMBAT.ricStart));
      if (rnd() < pRic) return { outcome: 'RICOCHET', dmg: 0, fire: false };
   }
   const glance = 1 - Math.cos(inc);
   const margin = shell.ap * (1 - 0.5 * glance) / armor - 1;
   const pPen = 1 / (1 + Math.exp(-margin / COMBAT.penK));
   if (rnd() > pPen) return { outcome: 'RICOCHET', dmg: 0, fire: false }; // shattered on the belt
   if (margin > COMBAT.overPen) return { outcome: 'OVERPEN', dmg: shell.dmg * COMBAT.overPenMult, fire: false };
   if (inCitadel) return { outcome: 'CITADEL', dmg: shell.dmg * COMBAT.citadelMult, fire: rnd() < COMBAT.igniteFire };
   return { outcome: 'PEN', dmg: shell.dmg * COMBAT.grazeMult, fire: rnd() < COMBAT.igniteFire * 0.5 };
}

// Apply a shell hit: damage, fire, FX, ribbon event.
function resolveHit(world, ship, shell, imp) {
   const r = rollHit(ship, shell, imp);
   const by = shell.shooter || null;
   if (r.outcome === 'RICOCHET') {
      world.addSplash(shell.pos, false);
      world.effects.push({ kind: 'ricochet', pos: { ...shell.pos }, bearing: shell.dir, age: 0, life: 0.35 });
      world.emit({ kind: 'hit', shooter: by, target: ship, outcome: 'RICOCHET', dmg: 0, pos: { ...shell.pos }, shell: shell.kind });
      return;
   }
   let dmg = r.dmg;
   if (r.outcome === 'CITADEL') {
      // a salvo piling into the citadel within 1.5 s hits harder
      const hits = ship._citHits || (ship._citHits = []);
      for (let k = hits.length - 1; k >= 0; k--) if (world.time - hits[k] > 1.5) hits.splice(k, 1);
      hits.push(world.time);
      if (hits.length >= COMBAT.concentration.minShells) dmg *= COMBAT.concentration.mult;
   }
   const res = ship.applyImpact({ dmg, source: shell.kind === 'sec' ? 'secondary' : r.outcome === 'CITADEL' ? 'citadel' : 'main',
      firing: r.fire, flooding: false, mod: Math.floor(Math.random() * 6),
      dmgMult: (by && by.dmgMult) || 1, by });
   // accuracy is main-battery hits per main shell fired (secondaries are not counted as shots)
   if (by && shell.kind === 'main') by.shotsHit++;

   const big = r.outcome === 'CITADEL';
   world.addExplosion(shell.pos, big);
   world.addDamageNumber(shell.pos, dmg, res.fire ? 'fire' : big ? 'cit' : 'dmg');
   if (res.fire) world.effects.push({ kind: 'fire', pos: { x: ship.pos.x + imp.along * 0.3, y: ship.pos.y + imp.across * 0.3 }, age: 0, life: 3 + Math.random() * 3, big });
   if (by && by.side === 'player') world.shakeAdd(big ? 5 : 1.5);
   if (ship.side === 'player') world.shakeAdd(big ? 7 : 2.5);
   world.emit({ kind: 'hit', shooter: by, target: ship, outcome: r.outcome, dmg, pos: { ...shell.pos }, shell: shell.kind, fire: res.fire });
}

// ---------- TORPEDOES ----------
// Torpedoes run under smoke and through it; only islands, the arena edge and hulls stop them.
export function resolveTorpedoes(world, dt) {
   for (let i = world.torpedoes.length - 1; i >= 0; i--) {
      const t = world.torpedoes[i];
      const prev = { x: t.pos.x, y: t.pos.y };
      t.age += dt;
      t.pos = add(t.pos, { x: t.vel.x * dt, y: t.vel.y * dt });
      t.wake.push({ x: t.pos.x, y: t.pos.y });
      if (t.wake.length > 40) t.wake.shift();

      if (t.age * t.speed > t.range) { world.addSplash(t.pos, false); world.torpedoes.splice(i, 1); continue; }
      if (Math.abs(t.pos.x) > WORLD.ARENA || Math.abs(t.pos.y) > WORLD.ARENA) { world.torpedoes.splice(i, 1); continue; }
      if (hitsIsland(world, t.pos)) { world.addExplosion(t.pos, false); world.torpedoes.splice(i, 1); continue; }

      for (const ship of world.ships) {
         if (!ship.alive || ship.side === t.owner || ship.depth >= 0.5) continue; // runs above a dived sub
         const imp = localImpact(ship, t.pos) || localImpact(ship, prev);
         if (!imp) continue;
         if (ship.human) world.stats.torpHitsTaken++;
         const central = Math.abs(imp.along) < ship.cfg.L / 6;
         const dmg = t.dmg * (central ? COMBAT.torpCentralMult : 1);
         const res = ship.applyImpact({ dmg, source: 'torpedo', flooding: Math.random() < COMBAT.torpFlood, firing: false,
            mod: 3, dmgMult: (t.shooter && t.shooter.dmgMult) || 1, by: t.shooter });
         world.addExplosion(t.pos, true);
         world.addDamageNumber(t.pos, dmg, 'torp');
         if (ship.side === 'player') world.shakeAdd(9);
         else if (t.owner === 'player') world.shakeAdd(4);
         world.emit({ kind: 'hit', shooter: t.shooter, target: ship, outcome: 'TORP', dmg, pos: { ...t.pos }, shell: 'torp', flood: res.flood });
         world.torpedoes.splice(i, 1);
         break;
      }
   }
}

// ---------- AA ----------
export function resolveAA(world, dt) {
   for (let i = world.aaTracers.length - 1; i >= 0; i--) {
      const a = world.aaTracers[i];
      a.age += dt;
      if (a.age > a.life) world.aaTracers.splice(i, 1);
   }
   // AA damage is applied at fire time (ship._autoAA) — tracers here are visual.
}

// ---------- MINES ----------
// Moored contact mines: armed after MINES.arm s, seen by the other side only up close, triggered by
// any surface hull of the other side (subs pass under them).
export function resolveMines(world, dt) {
   for (const m of world.mines) {
      if (!m.alive) continue;
      if (m.armT > 0) { m.armT -= dt; continue; }
      m.seen = false;
      for (const s of world.ships) {
         if (!s.alive || s.side === m.side) continue;
         const d = dist(s.pos, m.pos);
         if (d < MINES.reveal) m.seen = true;
         if (s.depth >= 0.5 || d > s.cfg.L) continue;
         if (!localImpact(s, m.pos, MINES.trigger)) continue;
         m.alive = false;
         const dmg = MINES.dmg * (m.dmgMult || 1);
         const res = s.applyImpact({ dmg, source: 'torpedo', flooding: Math.random() < MINES.flood, firing: false, mod: 3,
            dmgMult: m.dmgMult || 1, by: m.owner });
         world.addExplosion(m.pos, true);
         world.addSplash(m.pos, true);
         world.addDamageNumber(m.pos, dmg, 'torp');
         if (s.human) { world.stats.mineHits++; world.shakeAdd(9); }
         world.emit({ kind: 'hit', shooter: m.owner, target: s, outcome: 'MINE', dmg, pos: { ...m.pos }, shell: 'mine', flood: res.flood });
         break;
      }
   }
   if (world.mines.some(m => !m.alive)) world.mines = world.mines.filter(m => m.alive);
}

// a shell splash close enough sets a mine off harmlessly (secondaries can sweep a lane)
function detonateMinesNear(world, pos, r, by) {
   for (const m of world.mines) {
      if (!m.alive || m.armT > 0 || (by && by.side === m.side)) continue;
      if (dist2(pos, m.pos) < r * r) {
         m.alive = false;
         world.addExplosion(m.pos, true);
         world.addSplash(m.pos, true);
         world.emit({ kind: 'mineCleared', pos: { ...m.pos }, by });
      }
   }
}

// ---------- DEPTH CHARGES ----------
// Only submarines care: full damage at the centre, linear falloff to DCHARGE.radius.
export function resolveDepthCharges(world, dt) {
   for (const c of world.depthCharges) {
      c.t -= dt;
      if (c.t > 0) continue;
      world.addSplash(c.pos, true);
      world.effects.push({ kind: 'dcharge', pos: { ...c.pos }, age: 0, life: 1.2 });
      for (const s of world.ships) {
         if (!s.alive || s.side === c.side || !s.cfg.sub) continue;
         const d = dist(s.pos, c.pos);
         if (d > DCHARGE.radius) continue;
         const dmg = DCHARGE.dmg * (1 - 0.6 * d / DCHARGE.radius) * ((c.owner && c.owner.dmgMult) || 1);
         s.applyImpact({ dmg, source: 'torpedo', flooding: Math.random() < 0.3, firing: false, mod: 3, dmgMult: 1, by: c.owner });
         world.addDamageNumber(s.pos, dmg, 'torp');
         // a close shake-up forces the boat up
         if (s.alive && s.depthTarget != null && d < DCHARGE.radius * 0.5) s.depthTarget = Math.min(s.depthTarget, 0.8);
         world.emit({ kind: 'hit', shooter: c.owner, target: s, outcome: 'DC', dmg, pos: { ...c.pos }, shell: 'dc' });
      }
   }
   world.depthCharges = world.depthCharges.filter(c => c.t > 0);
}

// ---------- BOMBS ----------
export function resolveBombs(world, dt) {
   for (const b of world.bombs) {
      b.t -= dt;
      if (b.t > 0) continue;
      let hitShip = null;
      for (const s of world.ships) {
         if (!s.alive || s.side === b.side || s.depth >= 0.5) continue;
         const imp = localImpact(s, b.pos, 10);
         if (!imp) continue;
         hitShip = s;
         const res = s.applyImpact({ dmg: b.dmg, source: 'main', firing: Math.random() < b.fire, flooding: false,
            mod: Math.floor(Math.random() * 6), dmgMult: 1, by: b.shooter });
         world.addExplosion(b.pos, true);
         world.addDamageNumber(b.pos, b.dmg, res.fire ? 'fire' : 'dmg');
         if (res.fire) world.effects.push({ kind: 'fire', pos: { x: s.pos.x + imp.along * 0.3, y: s.pos.y + imp.across * 0.3 }, age: 0, life: 4, big: false });
         if (s.human) world.shakeAdd(5);
         world.emit({ kind: 'hit', shooter: b.shooter, target: s, outcome: 'BOMB', dmg: b.dmg, pos: { ...b.pos }, shell: 'bomb', fire: res.fire });
         break;
      }
      if (!hitShip) world.addSplash(b.pos, true);
   }
   world.bombs = world.bombs.filter(b => b.t > 0);
}

// ---------- BARRAGES (boss special salvo) ----------
export function resolveBarrages(world, dt) {
   for (const z of world.barrages) {
      z.t -= dt;
      if (z.t > 0) continue;
      world.addExplosion(z.pos, true);
      world.addSplash(z.pos, true);
      for (const s of world.ships) {
         if (!s.alive || s.side === z.side || s.depth >= 0.5) continue;
         const d = dist(s.pos, z.pos) - s.cfg.beam * 0.5;
         if (d > z.r) continue;
         const dmg = z.dmg * (1 - 0.55 * clamp01(d / z.r));
         const res = s.applyImpact({ dmg, source: 'citadel', firing: Math.random() < 0.4, flooding: false,
            mod: Math.floor(Math.random() * 6), dmgMult: 1, by: z.shooter });
         world.addDamageNumber(s.pos, dmg, 'cit');
         if (s.human) world.shakeAdd(10);
         world.emit({ kind: 'hit', shooter: z.shooter, target: s, outcome: 'BARRAGE', dmg, pos: { ...z.pos }, shell: 'main', fire: res.fire });
      }
   }
   world.barrages = world.barrages.filter(z => z.t > 0);
}
