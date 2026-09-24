// game3d/combat.js — ballistics, dispersion, shell/torpedo flight and the WoWs-style damage
// model (AP pen vs angled armour, ricochet, overmatch, overpen, citadels, HE shatter/fires,
// torpedo floods). Pure functions over the World; no rendering.
import { WORLD, TUNE } from './config.js';
import {
   DEG, clamp, clamp01, dist2, toLocal, insideHull, halfBeamAt, islandHeightAt, obstacleT, truncGauss,
} from './utils.js';

// ---------------- ballistics ----------------
// Horizontal motion uses quadratic drag: x(t) = ln(1 + k v t) / k, so flight time grows faster
// than linearly with range (t(R) = (e^(kR) - 1) / (k v)); k = DRAG_K / max range.
export function flightTime(gun, R) {
   const k = WORLD.DRAG_K / gun.range;
   return (Math.exp(k * Math.max(0, R)) - 1) / (k * gun.vShell);
}
export function horizDist(gun, t) {
   const k = WORLD.DRAG_K / gun.range;
   return Math.log(1 + k * gun.vShell * Math.max(0, t)) / k;
}
// Angle of fall grows with range (plunging fire at long range, flat at short range).
export function fallAngle(gun, R) {
   return Math.atan(Math.tan(gun.fallMaxRad || 0.4) * Math.pow(clamp(R / gun.range, 0.02, 1.25), 1.4));
}
// Trajectory altitude over normalised ground progress u: alt(u) = h0(1-u) + H*A*u(1-u^2).
// The apex sits at u = 0.577 and the descent is twice as steep as the climb, like a real
// drag-affected shell; tan(fall) = 2A*H/R with A = 3*sqrt(3)/2.
export const ARC_A = 3 * Math.sqrt(3) / 2;
export function apexHeight(gun, R) {
   return Math.max(R * 0.004, Math.tan(fallAngle(gun, R)) * R / (2 * ARC_A));
}
export function launchAngle(gun, R) {
   return Math.atan(ARC_A * apexHeight(gun, R) / Math.max(1, R));
}
export function arcAlt(H, h0, u) { return h0 * (1 - u) + H * ARC_A * u * (1 - u * u); }

// AP penetration (mm) at range: loses ~45% between muzzle and max range.
export function apPenAt(gun, R) { return gun.ap ? gun.ap.pen * (1 - 0.45 * clamp01(R / gun.range)) : 0; }

// ---------------- shells ----------------
export function makeShell(world, shooter, muzzle, aim, gun, kind, ammo) {
   const rng = world.rng;
   let dx = aim.x - muzzle.x, dy = aim.y - muzzle.y;
   let R0 = Math.hypot(dx, dy);
   if (R0 < 1) { dx = Math.cos(shooter.heading); dy = Math.sin(shooter.heading); R0 = 1; }
   const ux = dx / R0, uy = dy / R0;
   R0 = Math.min(R0, gun.range);       // beyond max range the shells simply fall at max range
   // dispersion ellipse: horizontal (across the line of fire) > vertical (along it)
   const frac = clamp01(R0 / gun.range);
   const weather = world.env && (world.env.weather === 'storm' ? 1.12 : world.env.weather === 'rain' ? 1.05 : 1);
   const dH = gun.dispH * (0.2 + 0.8 * frac) * (weather || 1);
   const eh = truncGauss(rng, gun.sigma || 1.8) * dH;
   const ev = truncGauss(rng, gun.sigma || 1.8) * dH * (gun.vRatio || 0.55);
   const ix = muzzle.x + ux * (R0 + ev) - uy * eh;
   const iy = muzzle.y + uy * (R0 + ev) + ux * eh;
   const R = Math.max(30, Math.hypot(ix - muzzle.x, iy - muzzle.y));
   const dirX = (ix - muzzle.x) / R, dirY = (iy - muzzle.y) / R;
   const dur = flightTime(gun, R);
   const shot = ammo === 'AP' ? (gun.ap || gun.he) : (gun.he || gun.ap);
   const isAP = shot === gun.ap;
   const h0 = (shooter.cfg.hull.deckH || 10) + 3;
   const dmgMult = shooter.dmgMult || 1;
   return {
      id: world._nextId++,
      pos: { x: muzzle.x, y: muzzle.y }, alt: h0,
      start: { x: muzzle.x, y: muzzle.y }, target: { x: ix, y: iy }, aimPoint: { x: aim.x, y: aim.y },
      dirX, dirY, range: R, dur, H: apexHeight(gun, R), h0, fall: fallAngle(gun, R), u: 0,
      side: shooter.side, ownerId: shooter.id, shooter,
      caliber: gun.caliber, ammo: isAP ? 'AP' : 'HE', kind,
      dmg: shot.dmg * dmgMult, hePen: isAP ? 0 : shot.pen, fire: isAP ? 0 : (shot.fire || 0),
      age: 0, alive: true,
      // legacy fields (old render3d / tests): owner side string, flat velocity, arc progress
      owner: shooter.side, gun, arc: 0, arcDur: dur,
      vel: { x: dirX * gun.vShell, y: dirY * gun.vShell }, dir: Math.atan2(dirY, dirX),
   };
}

function nearbyShips(world, p, side, pad) {
   const out = [];
   for (const s of world.ships) {
      if (!s.alive || s.side === side) continue;
      const r = s.cfg.hull.L / 2 + pad;
      if (dist2(s.pos, p) < r * r) out.push(s);
   }
   return out;
}

// Which part of `ship` (if any) is hit at world point p / altitude a. prevP/prevA = previous
// sample: a shell that was already over the hull outline above deck height came in through
// the deck, otherwise through the side.
function hitZone(ship, lp, a, prevLp, prevA) {
   const h = ship.cfg.hull;
   const deckH = h.deckH;
   const sup = h.sup;
   if (a > deckH) {
      if (sup && a <= deckH + sup.h && Math.abs(lp.x - sup.x) <= sup.len / 2 && Math.abs(lp.y) <= sup.w / 2) return 'sup';
      return null;
   }
   if (a < -h.draft * 0.6) return null;
   if (!insideHull(h, lp)) return null;
   if (prevLp && prevA > deckH && insideHull(h, prevLp)) return 'deck';
   const cit = ship.cfg.armor.citLen * h.L / 2;
   return Math.abs(lp.x) <= cit ? 'belt' : 'ends';
}

export function resolveShells(world, dt) {
   const shells = world.shells;
   for (let i = 0; i < shells.length; i++) {
      const s = shells[i];
      if (!s.alive) continue;
      const g = s.gun;
      const px = s.pos.x, py = s.pos.y, pa = s.alt, pu = s.u;
      s.age += dt;
      const x = Math.min(s.range, horizDist(g, s.age));
      const u = x / s.range;
      s.u = u;
      s.arc = Math.min(1, s.age / s.dur);
      s.pos.x = s.start.x + s.dirX * x;
      s.pos.y = s.start.y + s.dirY * x;
      s.alt = arcAlt(s.H, s.h0, u);
      // only the low part of the flight can hit anything (ships ~<45 m, islands by height)
      if (Math.min(pa, s.alt) < world._maxTerrainH + 5) {
         const segLen = Math.hypot(s.pos.x - px, s.pos.y - py);
         const n = Math.max(1, Math.min(16, Math.ceil(segLen / 8)));
         const cand = Math.min(pa, s.alt) < 60 ? nearbyShips(world, s.pos, s.side, segLen + 60) : null;
         let prevP = { x: px, y: py }, prevA = pa;
         for (let k = 1; k <= n && s.alive; k++) {
            const f = k / n;
            const p = { x: px + (s.pos.x - px) * f, y: py + (s.pos.y - py) * f };
            const a = arcAlt(s.H, s.h0, pu + (u - pu) * f);
            if (cand) {
               for (const ship of cand) {
                  const lp = toLocal(ship, p);
                  const zone = hitZone(ship, lp, a, toLocal(ship, prevP), prevA);
                  if (zone) { resolveHit(world, s, ship, zone, lp, p, a); s.alive = false; break; }
               }
               if (!s.alive) break;
            }
            for (const o of world.obstacles) {
               if (o.kind !== 'island' || a > o.height) continue;
               if (a <= islandHeightAt(o, p)) {
                  world.addEffect('terrain', p, 1.2, 14 + s.caliber * 0.08);
                  s.alive = false; break;
               }
            }
            if (s.alive && a <= 0) break;
            prevP = p; prevA = a;
         }
      }
      if (s.alive && u >= 1) {
         s.alive = false;
         world.addEffect('splash', s.target, 1.6, 8 + s.caliber * 0.09, { big: s.caliber >= 280 });
         noteNearMiss(world, s);
      }
   }
   world.shells = shells.filter(s => s.alive);
}

// "Potential damage" (WoWs stat): enemy shells that landed close to the player.
function noteNearMiss(world, s) {
   const p = world.player;
   if (!p || !p.alive || s.side === p.side) return;
   if (dist2(p.pos, s.target) < 250 * 250) world.stats.potential += s.dmg;
}

// ---------------- damage model ----------------
const HIT_TEXT = {
   citadel: 'Zitadellentreffer!', pen: 'Durchschlag', overpen: 'Überdurchschlag', ricochet: 'Abpraller',
   shatter: 'Nicht durchschlagen', he: 'Sprenggranate', sec: 'Sekundärtreffer', torp: 'Torpedotreffer',
};

export function resolveHit(world, s, ship, zone, lp, p, alt) {
   const cfg = ship.cfg, ar = cfg.armor, hull = cfg.hull;
   const shooter = s.shooter && s.shooter.alive !== undefined ? s.shooter : world.shipById(s.ownerId);
   const rng = world.rng;
   const plate = zone === 'belt' ? ar.belt : zone === 'deck' ? ar.deck : zone === 'sup' ? ar.sup : ar.ends;
   // impact geometry in ship-local space: alpha = angle between the shell's ground track and
   // the side-plate normal; combined with the angle of fall for the true obliquity
   const c = Math.cos(ship.heading), sn = Math.sin(ship.heading);
   const dly = -s.dirX * sn + s.dirY * c;              // lateral component of the shell track
   const cosAlpha = Math.abs(dly);
   const cosT = zone === 'deck' ? Math.sin(s.fall) : cosAlpha * Math.cos(s.fall);
   let type, mult = 0;
   if (s.kind === 'sec') {
      if (s.hePen >= plate) { type = 'sec'; mult = 1 / 3; } else type = 'shatter';
   } else if (s.ammo === 'AP') {
      const g = s.gun;
      const pen = apPenAt(g, s.range);
      const overmatch = s.caliber > WORLD.OVERMATCH * plate;
      const thetaDeg = Math.acos(clamp(cosT, 0, 1)) / DEG;
      const [r0, r1] = g.ap.ricochet;
      let ric = false;
      if (!overmatch) {
         if (thetaDeg >= r1) ric = true;
         else if (thetaDeg > r0) ric = rng() < (thetaDeg - r0) / (r1 - r0);
      }
      if (ric) type = 'ricochet';
      else {
         const eff = plate / Math.max(0.05, cosT);
         if (!overmatch && pen < eff) type = 'shatter';
         else {
            const residual = pen - (overmatch ? plate : eff);
            const armThr = s.caliber / WORLD.FUSE_DIV;
            // side hits above the citadel roof (alt = impact height over the waterline) only pen the upper hull
            const overCit = zone === 'belt' && alt !== undefined && alt > hull.deckH * (ar.citH ?? 0.45);
            const inCit = ar.citLen > 0 && Math.abs(lp.x) <= ar.citLen * hull.L / 2 && (zone === 'belt' || zone === 'deck') && !overCit;
            if (inCit) {
               // turtleback (German designs): flat shells meet the sloped citadel deck at a steep angle
               const slope = zone === 'belt' && ar.turtle ? ar.turtle : 1;
               const citEff = ar.cit / Math.max(0.2, cosT * slope);
               const armed = plate >= armThr || ar.cit >= armThr;
               if (residual >= citEff) type = armed ? 'citadel' : 'overpen';
               else type = plate >= armThr || ar.cit >= armThr ? 'pen' : 'overpen';
            } else {
               const armed = plate >= armThr;
               // an armed shell still exits if the hull is thinner than its fuse travel
               const path = zone === 'deck' ? (hull.deckH + hull.draft) / Math.max(0.15, Math.sin(s.fall))
                  : zone === 'sup' ? hull.sup.w / Math.max(0.25, cosAlpha)
                  : (2 * halfBeamAt(hull, lp.x)) / Math.max(0.25, cosAlpha);
               type = armed && path > g.ap.fuse ? 'pen' : 'overpen';
            }
         }
      }
      mult = type === 'citadel' ? 1 : type === 'pen' ? 1 / 3 : type === 'overpen' ? 0.1 : 0;
   } else {
      // HE: angle-independent, penetrates if its pen >= the plate it strikes
      if (s.hePen >= plate) { type = 'he'; mult = 1 / 3; } else type = 'shatter';
   }
   const dmg = s.dmg * mult;
   world.onHit(shooter, ship, type, s);
   world.pushEvent(type, { srcId: s.ownerId, dstId: ship.id, dmg: Math.round(dmg), pos: { x: p.x, y: p.y }, text: HIT_TEXT[type] });
   const big = type === 'citadel' || s.caliber >= 280;
   world.addEffect(type === 'ricochet' ? 'ricochet' : type === 'shatter' ? 'shatter' : 'explosion', p, big ? 1.1 : 0.6,
      type === 'citadel' ? 40 : 10 + s.caliber * 0.06, { big, hit: type, shipId: ship.id });
   if (dmg > 0) {
      ship.takeDamage(dmg, shooter, type, WORLD.HIT_POOL[type] ?? 0.5);
      if (ship.alive && s.fire > 0 && (type === 'he' || type === 'sec')) {
         const wet = world.env && (world.env.weather === 'rain' || world.env.weather === 'storm') ? 0.8 : 1;
         if (rng() < s.fire * wet) ship.ignite(fireZone(hull, lp.x), shooter);
      }
      if (ship.alive && s.kind === 'main' && rng() < (type === 'citadel' ? 0.08 : 0.03)) ship.damageModule(lp, shooter);
   }
   if (ship === world.player && shooter) world.shakeAdd(type === 'citadel' ? 1.4 : 0.5);
}

export function fireZone(hull, lx) {
   return clamp(Math.floor((lx / hull.L + 0.5) * WORLD.FIRE_MAX), 0, WORLD.FIRE_MAX - 1);
}

// ---------------- torpedoes ----------------
export function resolveTorpedoes(world, dt) {
   for (const t of world.torpedoes) {
      if (!t.alive) continue;
      const px = t.pos.x, py = t.pos.y;
      const step = t.speed * dt;
      t.pos.x += Math.cos(t.heading) * step;
      t.pos.y += Math.sin(t.heading) * step;
      t.traveled += step; t.age += dt;
      if (t.traveled >= t.range) { t.alive = false; continue; }
      for (const o of world.obstacles) {
         if (o.kind === 'island' && obstacleT(o, t.pos) < 1) { t.alive = false; world.addEffect('splash', t.pos, 1.2, 12); break; }
      }
      if (!t.alive || t.traveled < 120) continue;       // arming distance
      for (const ship of world.ships) {
         if (!ship.alive || ship.side === t.side) continue;
         const r = ship.cfg.hull.L / 2 + step + 10;
         if (dist2(ship.pos, t.pos) > r * r) continue;
         let hit = null;
         for (let k = 0; k <= 3; k++) {
            const f = k / 3;
            const p = { x: px + (t.pos.x - px) * f, y: py + (t.pos.y - py) * f };
            const lp = toLocal(ship, p);
            if (insideHull(ship.cfg.hull, lp, 1.5)) { hit = { p, lp }; break; }
         }
         if (hit) { torpedoHit(world, t, ship, hit.p, hit.lp); t.alive = false; break; }
      }
   }
   world.torpedoes = world.torpedoes.filter(t => t.alive);
}

function torpedoHit(world, t, ship, p, lp) {
   const ar = ship.cfg.armor, hull = ship.cfg.hull;
   const shooter = world.shipById(t.ownerId);
   // torpedo protection only covers the citadel section
   const inBelt = ar.citLen > 0 && Math.abs(lp.x) <= ar.citLen * hull.L / 2;
   const dmg = t.dmg * (1 - (inBelt ? ar.tds : ar.tds * 0.3));
   world.onHit(shooter, ship, 'torp', t);
   world.pushEvent('torp', { srcId: t.ownerId, dstId: ship.id, dmg: Math.round(dmg), pos: { x: p.x, y: p.y }, text: HIT_TEXT.torp });
   world.addEffect('torpHit', p, 1.8, 40, { big: true, shipId: ship.id });
   if (ship === world.player) world.shakeAdd(1.6);
   ship.takeDamage(dmg, shooter, 'torp', WORLD.HIT_POOL.torp);
   if (ship.alive && world.rng() < t.flood * (1 - (inBelt ? ar.tds * 0.5 : 0))) ship.flood(lp.x >= 0 ? 1 : 0, shooter);
}

export { TUNE };
