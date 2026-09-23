// game/combat.js — projectile motion + the WoWs-style damage model (ricochet / citadel / overpen /
// HE / fire / flood). Smoke is deliberately absent here: it blocks sight (state.js), not shells.
// Convention: ship local coords  +X = bow (forward), +Y = starboard.
import { add, dist2, fromAngle, norm, clamp, clamp01 } from './utils.js';
import { WORLD, COMBAT, TUNE, HANDLING } from './config.js';

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

      if (hitsIsland(world, s.pos)) {
         world.addExplosion(s.pos, false);
         world.shells.splice(i, 1);
         continue;
      }
      // test the previous position too: ~11 m/frame could tunnel through a 13 m destroyer beam
      let hit = false;
      for (const ship of ships) {
         if (!ship.alive || ship.side === s.owner) continue;
         const imp = localImpact(ship, s.pos) || localImpact(ship, prev);
         if (imp) { resolveHit(world, ship, s, imp); hit = true; break; }
      }
      if (hit) { world.shells.splice(i, 1); continue; }
      if (s.age >= s.arcDur * (1 + HANDLING.overshoot)) {
         world.addSplash(s.pos, s.kind === 'main' && s.caliber >= 250);
         world.shells.splice(i, 1);
      }
   }
}

// Solid-rock test — reefs are shallow water and don't stop anything, only islands do.
function hitsIsland(world, pos) {
   for (const o of world.obstacles) {
      if (o.kind !== 'island') continue;
      if (dist2(pos, o.c) < o.r * o.r) return true;
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
   if (by) by.shotsHit++;

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
         if (!ship.alive || ship.side === t.owner) continue;
         const imp = localImpact(ship, t.pos) || localImpact(ship, prev);
         if (!imp) continue;
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
