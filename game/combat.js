// game/combat.js — projectile motion + the WoWs-style damage model (ricochet / citadel / fire / flood).
// Convention: ship local coords  +X = bow (forward), +Y = starboard.
import { add, sub, dist, dist2, fromAngle, angleOf, norm, clamp, clamp01, pick, TAU } from './utils.js';
import { WORLD, COMBAT, TUNE } from './config.js';

// Ship footprints (m) — used for deck hit tests and citadel bands.
const DIMS = {
  DD: { L: 120, beam: 13 },
  LC: { L: 170, beam: 18 },
  HC: { L: 205, beam: 22 },
  EB: { L: 251, beam: 36 },
  Bismarck: { L: 251, beam: 36 },
};

function shipDims(ship) { return DIMS[ship.cls] || { L: 180, beam: 20 }; }
// Small margin so a shell skimming the deck edge still counts as a hit.
const HIT_MARGIN = 6;
function scaleV(v, s) { return { x: v.x * s, y: v.y * s }; }

// Point-in-hull test in the ship's local frame. Returns {along, across} or null if outside.
// along = distance along the keel (bow +), across = distance across the beam (starboard +).
function localImpact(ship, pos) {
  const dim = shipDims(ship);
  const dx = pos.x - ship.pos.x, dy = pos.y - ship.pos.y;
  const ca = Math.cos(-ship.heading), sa = Math.sin(-ship.heading);
  const along = dx * ca - dy * sa;
  const across = dx * sa + dy * ca;
  const halfB = dim.beam / 2 + HIT_MARGIN, halfL = dim.L / 2 + HIT_MARGIN;
  if (Math.abs(along) > halfL || Math.abs(across) > halfB) return null;
  return { along, across };
}

// ---------- SHELLS ----------
export function resolveShells(world, dt) {
  const ships = world.ships;
  for (let i = world.shells.length - 1; i >= 0; i--) {
    const s = world.shells[i];
    const prev = { x: s.pos.x, y: s.pos.y };
    s.age += dt;
    s.arc = clamp01(s.age / s.arcDur);
    s.pos = add(s.pos, scaleV(s.vel, dt));

    // out of bounds / lifetime
    if (s.age > TUNE.shellLife || Math.abs(s.pos.x) > WORLD.ARENA + 500 || Math.abs(s.pos.y) > WORLD.ARENA + 500) {
      world.shells.splice(i, 1);
      continue;
    }

    // smoke intercepts a shell — splash, miss
    if (world.inSmoke(s.pos, s.owner)) { world.addSplash(s.pos, false); world.shells.splice(i, 1); continue; }

    // islands are solid rock: a shell that reaches one detonates there instead of
    // passing through. This is what makes terrain useful cover, not just scenery --
    // duck the Bismarck behind an island and incoming fire slams into the rock.
    if (hitsIsland(world, s.pos) || hitsIsland(world, prev)) {
      world.addExplosion(s.pos, false);
      world.shells.splice(i, 1);
      continue;
    }

    // collide with enemy ships against the real hull rectangle.
    // A shell moves ~11 m/frame, so also test the previous position to avoid
    // tunnelling straight through a thin beam (DDs are only ~19 m wide).
    let hit = false;
    for (const ship of ships) {
      if (!ship.alive || ship.side === s.owner) continue;
      const imp = localImpact(ship, s.pos) || localImpact(ship, prev);
      if (imp) { resolveHit(world, ship, s, imp); hit = true; break; }
    }
    if (hit) world.shells.splice(i, 1);
  }
}

// Solid-rock test — reefs are shallow water and don't stop shells, only islands do.
function hitsIsland(world, pos) {
  for (const o of world.obstacles) {
    if (o.kind !== 'island') continue;
    if (dist2(pos, o.c) < o.r * o.r) return true;
  }
  return false;
}

// The heart: decide bounce vs penetrate vs citadel, apply damage, fire, flood.
// imp = {along, across} in the ship's local frame (from localImpact).
function resolveHit(world, ship, shell, imp) {
  const dim = shipDims(ship);
  const { along, across } = imp;
  const halfB = dim.beam / 2, halfL = dim.L / 2;

  // Surface normal of the hull face that was struck: the nearest rectangle edge,
  // expressed in world space. A shell hitting the broadside at a shallow angle
  // glances off; one hitting the bow head-on penetrates.
  const tAlong = clamp(along / halfL, -1, 1), tAcross = clamp(across / halfB, -1, 1);
  const ex = halfL - Math.abs(along), ey = halfB - Math.abs(across);
  let nLocal;
  if (ex < ey) nLocal = { x: Math.sign(along || 1), y: 0 };   // bow/stern face
  else nLocal = { x: 0, y: Math.sign(across || 1) };          // port/starboard face
  const ca = Math.cos(ship.heading), sa = Math.sin(ship.heading);
  const normalWorld = { x: nLocal.x * ca - nLocal.y * sa, y: nLocal.x * sa + nLocal.y * ca };
  const shellDir = norm(shell.vel);
  const dot = Math.abs(shellDir.x * normalWorld.x + shellDir.y * normalWorld.y);
  const glance = clamp01(1 - dot); // 1 = grazing (bounces), 0 = perpendicular (penetrates)

  // citadel band (central length, full beam) — now a real sub-region of the hull,
  // so bow/stern and deck-edge hits graze instead of always landing in the citadel
  const inCitadel = Math.abs(along) < COMBAT.citadelLen * halfL && Math.abs(across) < halfB;
  // central third for torpedoes
  const central = Math.abs(along) < halfL / 3;

  const isHE = shell.type === 'HE';
  let outcome, dmg = 0, fires = false, floods = false;

  if (isHE) {
    // HE splashes — always lands, strong fire chance, little penetration worry
    outcome = 'HE';
    dmg = shell.dmg;
    fires = Math.random() < 0.35;
    floods = Math.random() < 0.08;
  } else {
    // AP penetration vs armor; glancing reduces effective penetration
    const effAP = shell.ap * (1 - 0.5 * glance);
    const ratio = effAP / (ship.cfg.armor || 100);
    const margin = ratio - 1;
    const pPen = 1 / (1 + Math.exp(-margin / COMBAT.penK));
    if (Math.random() > pPen) {
      // RICOCHET — bounces, no damage, dramatic splash
      outcome = 'BOUNCE';
      world.addSplash(shell.pos, true);
      if (shell.shooter && shell.shooter.side === 'player') world.shakeAdd(2);
      return;
    }
    if (margin > COMBAT.overPen) {
      // OVER-PENETRATION — through-and-through, half damage, no citadel
      outcome = 'OVERPEN';
      dmg = shell.dmg * 0.5;
    } else {
      // PENETRATION
      outcome = 'PEN';
      if (inCitadel) {
        // concentration bonus if a salvo piles into the citadel
        const hits = ship._citHits || (ship._citHits = []);
        const now = world.time;
        for (let k = hits.length - 1; k >= 0; k--) if (now - hits[k] > 1.5) hits.splice(k, 1);
        hits.push(now);
        dmg = shell.dmg * COMBAT.citadelMult;
        if (hits.length >= COMBAT.concentration.minShells) dmg *= COMBAT.concentration.mult;
        fires = Math.random() < COMBAT.igniteFire * (hits.length > 3 ? 1.8 : 1);
        floods = Math.random() < COMBAT.igniteFlood;
      } else {
        // graze hit outside citadel
        dmg = shell.dmg * COMBAT.grazeMult;
        fires = Math.random() < 0.05;
      }
    }
  }

  // apply
  ship.applyImpact({ dmg, type: outcome, source: shell.kind === 'sec' ? 'secondary' : 'main',
    firing: fires, flooding: floods, mod: Math.floor((Math.random() - 0.5) * 6 + 3) });
  if (shell.shooter) { shell.shooter.shotsHit++; shell.shooter.dmgDealt += dmg; }

  // FX
  if (outcome !== 'BOUNCE') {
    world.addExplosion(shell.pos, outcome === 'OVERPEN' || inCitadel);
    world.addDamageNumber(shell.pos, dmg, fires ? 'fire' : 'dmg');
    if (shell.shooter && shell.shooter.side === 'player') world.shakeAdd(outcome === 'BOUNCE' ? 1 : (inCitadel ? 5 : 2.5));
    if (fires) world.effects.push({ kind: 'fire', pos: { x: ship.pos.x + along * 0.3, y: ship.pos.y + across * 0.3 }, age: 0, life: 3 + Math.random() * 3, big: inCitadel });
  }
}

// ---------- TORPEDOES ----------
export function resolveTorpedoes(world, dt) {
  for (let i = world.torpedoes.length - 1; i >= 0; i--) {
    const t = world.torpedoes[i];
    t.age += dt;
    t.pos = add(t.pos, scaleV(t.vel, dt));
    t.wake.push({ x: t.pos.x, y: t.pos.y });
    if (t.wake.length > 40) t.wake.shift();

    // per-torpedo speed, not a global constant -- classes now carry different torp speeds
    if (t.age * t.speed > t.range) { world.addSplash(t.pos, false); world.torpedoes.splice(i, 1); continue; }
    if (Math.abs(t.pos.x) > WORLD.ARENA || Math.abs(t.pos.y) > WORLD.ARENA) { world.torpedoes.splice(i, 1); continue; }
    if (hitsIsland(world, t.pos)) { world.addExplosion(t.pos, false); world.torpedoes.splice(i, 1); continue; }

    for (const ship of world.ships) {
      if (!ship.alive || ship.side === t.owner) continue;
      const imp = localImpact(ship, t.pos);
      if (imp) {
        const dim = shipDims(ship);
        const { along } = imp;
        const central = Math.abs(along) < dim.L / 6;
        const dmg = t.dmg * (central ? COMBAT.torpCentralMult : 1);
        ship.applyImpact({ dmg, type: 'TORP', source: 'torpedo', flooding: Math.random() < 0.6, firing: false, mod: 3 });
        if (t.shooter) t.shooter.dmgDealt += dmg;
        world.addExplosion(t.pos, true);
        world.addDamageNumber(t.pos, dmg, 'torp');
        if (ship.side === 'player') world.shakeAdd(8);
        world.torpedoes.splice(i, 1);
        break;
      }
    }
  }
}

// ---------- AA ----------
export function resolveAA(world, dt) {
  for (let i = world.aaTracers.length - 1; i >= 0; i--) {
    const a = world.aaTracers[i];
    a.age += dt;
    if (a.age > a.life) { world.aaTracers.splice(i, 1); continue; }
  }
  // AA damage is applied at fire time (see ship.fireAA caller) — tracers here are visual.
}
