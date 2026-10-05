// gamev2/missile.js — everything that flies under its own power in the modern mode, and the
// layered defence against it. Pure game rules on plain data (world.missiles, world.decoys); no
// rendering. World.update calls updateMissiles after the torpedo step.
//
// Missile (world.missiles[]):
//    { id, side, team, kind 'ssm'|'cruise'|'sam'|'aam'|'rocket', type (key of MISSILES; rockets: 'rocket'),
//      x, y, alt, heading, speed, ownerId (ship or site), sqId (air launched), dmg,
//      target (id of the designated ship / site / missile / squadron or null), tk 'ship'|'site'|'missile'|'squad'|'point'|'bearing',
//      tx, ty (aim point), seekerOn, lock (ship id | null), lockDecoy (decoy id | null), seduced,
//      detected, detT (sensors.js), eng (interceptors in flight against it), dist, range, t, alive }
// Decoy cloud (world.decoys[]): { id, side, shipId, x, y, t0, n (seekers it has seduced, max DEFENCE.decoyCap) }
// A "platform" is whatever launches and defends: a Ship or a land site (sites.js). Both carry
//    id, side, pos, alive, radarOn, cfg.weapons, mag, samDoctrine, samPriority, lastSsmFire.
// Defence state on a platform: samCh[] = { type, tgt (threat id | null), mid (interceptor id), readyT },
//    ciwsTgt[] (missile ids the gun mounts fire at this step).
//
// Events (world.pushEvent): ssmLaunch, cruiseLaunch, samLaunch, aamLaunch, rockets, vampire, intercept
// { by: 'sam'|'ciws'|'aam' }, samMiss, missileHit, missileLost { reason }, decoy, seduced, doctrine;
// siteHit / siteDestroyed come from sites.js. All carry pos and, where it applies, missileId / mtype.
import { MISSILES, CIWS, CIWS_SUPER, DEFENCE, SENSOR, WORLD, TUNE } from './config.js';
import { angleDelta, clamp, obstacleT, islandHeightAt, pointSegDist, toLocal, insideHull, truncGauss } from './utils.js';
import { jammed } from './sensors.js';
import { damageSite, siteById } from './sites.js';
import { hurtSquad, squadById } from './air.js';
import { heloById, killHelo } from './helo.js';

const DEF_DT = 0.2;                  // s between two fire-control passes
const SCAN_DT = 0.2;                 // s between two seeker sweeps
const SKIM_ALT = 8;
const opp = (side) => side === 'player' ? 'enemy' : 'player';
const isThreat = (m) => m.kind === 'ssm' || m.kind === 'cruise';

export function platformById(world, id) { return world.shipById(id) || siteById(world, id); }

function spawn(world, o) {
   const ms = world.missiles;
   if (ms.length >= TUNE.maxMissiles) return null;
   const m = {
      id: world._nextId++, side: o.side, team: o.side, kind: o.kind, type: o.type,
      x: o.x, y: o.y, px: o.x, py: o.y, sx: o.x, sy: o.y, alt: o.alt ?? SKIM_ALT, heading: o.heading, speed: o.speed,
      ownerId: o.ownerId ?? null, sqId: o.sqId ?? null, chI: -1, dmg: o.dmg || 0,
      target: o.target ?? null, tk: o.tk || 'point', tx: o.tx ?? o.x, ty: o.ty ?? o.y,
      seekerOn: false, lock: null, lockDecoy: null, seduced: false, rolled: null, scanT: 0,
      detected: false, detT: 0, ann: false, eng: 0, dist: 0, range: o.range || 0, t: o.t || 0, alive: true,
   };
   ms.push(m);
   return m;
}
function lose(world, m, reason, quiet) {
   if (!m.alive) return;
   m.alive = false;
   if (!quiet) world.pushEvent('missileLost', { srcId: m.ownerId, missileId: m.id, mtype: m.type, kind: m.kind, reason, pos: { x: m.x, y: m.y } });
}

// ================================================================ launching
// Why can platform P not launch an anti-ship missile right now? null = it can.
//    'none' no such weapon | 'empty' | 'reload' (launch interval) | 'notrack' (target not fire-control
//    quality) | 'range'
export function ssmBlock(world, P, aim, type) {
   const w = P.cfg.weapons;
   type = type || ssmType(P);
   const c = MISSILES[type];
   if (!P.alive || !c || c.kind !== 'ssm' || !w.ssm.some(s => s.type === type)) return 'none';
   if (!(P.mag[type] > 0)) return 'empty';
   if (world.time - P.lastSsmFire < DEFENCE.launchGap) return 'reload';
   if (aim && aim.targetId != null) {
      const T = world.shipById(aim.targetId);
      if (!T || !T.alive || T.side === P.side || !T.targetable || T.depth > 0) return 'notrack';
      if (Math.hypot(T.pos.x - P.pos.x, T.pos.y - P.pos.y) > c.range) return 'range';
   }
   return null;
}
// The anti-ship missile type the platform has selected (ship.ssmSel), or the first with rounds left.
export function ssmType(P) {
   const list = P.cfg.weapons.ssm;
   const sel = list[P.ssmSel || 0];
   if (sel && P.mag[sel.type] > 0) return sel.type;
   const any = list.find(s => P.mag[s.type] > 0);
   return any ? any.type : sel ? sel.type : null;
}
export function selectSsm(ship, idx) {
   const n = ship.cfg.weapons.ssm.length;
   if (!n) return false;
   ship.ssmSel = clamp(idx | 0, 0, n - 1);
   return true;
}

function launched(world, P, type) {
   P.mag[type]--;
   P.lastSsmFire = world.time;
   if ('lastMainFire' in P) P.lastMainFire = world.time;      // the launch flash blooms like gunfire
}

// Launch an anti-ship missile. aim: { targetId } (needs a fire-control track; the data link keeps
// updating the aim point while the target stays detected) | { bearing } (bearing-only: seeker on
// after the arming run, takes whatever it finds) | { x, y } (flies there, then searches).
// Returns the missile or null (see ssmBlock).
export function launchSSM(world, P, aim, type) {
   type = type || ssmType(P);
   if (!aim || ssmBlock(world, P, aim, type)) return null;
   const c = MISSILES[type];
   let tx, ty, target = null, tk;
   if (aim.targetId != null) {
      const T = world.shipById(aim.targetId);
      tx = T.pos.x; ty = T.pos.y; target = T.id; tk = 'ship';
   } else if (typeof aim.bearing === 'number') {
      tx = P.pos.x + Math.cos(aim.bearing) * c.range; ty = P.pos.y + Math.sin(aim.bearing) * c.range; tk = 'bearing';
   } else if (typeof aim.x === 'number' && typeof aim.y === 'number') {
      const dx = aim.x - P.pos.x, dy = aim.y - P.pos.y, d = Math.hypot(dx, dy) || 1, k = Math.min(1, c.range / d);
      tx = P.pos.x + dx * k; ty = P.pos.y + dy * k; tk = 'point';
   } else return null;
   const m = spawn(world, {
      side: P.side, kind: 'ssm', type, x: P.pos.x, y: P.pos.y, alt: c.skim ? SKIM_ALT : c.alt || 300,
      heading: Math.atan2(ty - P.pos.y, tx - P.pos.x), speed: c.speed, ownerId: P.id, dmg: c.dmg * (P.dmgMult || 1),
      target, tk, tx, ty, range: c.range * 1.08,
   });
   if (!m) return null;
   launched(world, P, type);
   if (P.stats) P.stats.ssmFired++;
   world.pushEvent('ssmLaunch', { srcId: P.id, dstId: target, missileId: m.id, mtype: type, pos: { x: m.x, y: m.y }, text: c.name + ' gestartet' });
   return m;
}

// Stand-off missile released by an attack squadron (air.js). aim as launchSSM.
export function launchAirSSM(world, sq, aim, type, dmgMult = 1) {
   const c = MISSILES[type];
   if (!c || c.kind !== 'ssm' || !aim) return null;
   let tx, ty, target = null, tk = 'bearing';
   const T = aim.targetId != null ? world.shipById(aim.targetId) : null;
   if (T && T.alive) { tx = T.pos.x; ty = T.pos.y; target = T.id; tk = 'ship'; }
   else if (typeof aim.x === 'number') { tx = aim.x; ty = aim.y; tk = 'point'; }
   else { const b = aim.bearing ?? sq.heading; tx = sq.pos.x + Math.cos(b) * c.range; ty = sq.pos.y + Math.sin(b) * c.range; }
   const m = spawn(world, {
      side: sq.side, kind: 'ssm', type, x: sq.pos.x, y: sq.pos.y, alt: Math.max(SKIM_ALT, sq.alt || 0),
      heading: Math.atan2(ty - sq.pos.y, tx - sq.pos.x), speed: c.speed, ownerId: sq.ownerId, sqId: sq.id, dmg: c.dmg * dmgMult,
      target, tk, tx, ty, range: c.range * 1.08,
   });
   if (!m) return null;
   const carrier = world.shipById(sq.ownerId);
   if (carrier?.stats) carrier.stats.ssmFired++;
   world.pushEvent('ssmLaunch', { srcId: sq.ownerId, sqId: sq.id, dstId: target, missileId: m.id, mtype: type, air: true, pos: { x: m.x, y: m.y }, text: c.name + ' gestartet' });
   return m;
}

export function cruiseBlock(world, P, aim) {
   const cw = P.cfg.weapons.cruise, c = cw && MISSILES[cw.type];
   if (!P.alive || !c) return 'none';
   if (!(P.mag[cw.type] > 0)) return 'empty';
   if (world.time - P.lastSsmFire < DEFENCE.launchGap) return 'reload';
   if (aim) {
      const S = aim.siteId != null ? siteById(world, aim.siteId) : null;
      if (aim.siteId != null && (!S || !S.alive)) return 'notrack';
      const x = S ? S.pos.x : aim.x, y = S ? S.pos.y : aim.y;
      if (typeof x !== 'number' || typeof y !== 'number') return 'notrack';
      if (Math.hypot(x - P.pos.x, y - P.pos.y) > c.range) return 'range';
   }
   return null;
}
// Launch a cruise missile at a map point or a land site. Flies over islands; hits what stands there.
export function launchCruise(world, P, aim) {
   if (!aim || cruiseBlock(world, P, aim)) return null;
   const type = P.cfg.weapons.cruise.type, c = MISSILES[type];
   const S = aim.siteId != null ? siteById(world, aim.siteId) : null;
   const tx = S ? S.pos.x : aim.x, ty = S ? S.pos.y : aim.y;
   const m = spawn(world, {
      side: P.side, kind: 'cruise', type, x: P.pos.x, y: P.pos.y, alt: c.alt || 60,
      heading: Math.atan2(ty - P.pos.y, tx - P.pos.x), speed: c.speed, ownerId: P.id, dmg: c.dmg * (P.dmgMult || 1),
      target: S ? S.id : null, tk: S ? 'site' : 'point', tx, ty, range: c.range * 1.05,
   });
   if (!m) return null;
   launched(world, P, type);
   if (P.stats) P.stats.ssmFired++;
   world.pushEvent('cruiseLaunch', { srcId: P.id, dstId: m.target, missileId: m.id, mtype: type, pos: { x: m.x, y: m.y }, to: { x: tx, y: ty }, text: c.name + ' gestartet' });
   return m;
}

// Unguided rocket salvo (swarm boats) at a point: falls in a scatter around it. Returns rockets fired.
export function rocketState(ship) {
   const rk = ship.cfg.weapons.rockets;
   if (!rk) return null;
   return ship.rk || (ship.rk = { readyT: 0, salvo: rk.salvo || rk.n, reload: rk.reload, range: rk.range });
}
export function fireRockets(world, ship, aim) {
   const rk = ship.cfg.weapons.rockets, st = rocketState(ship);
   if (!st || !ship.alive || ship.depth > 0 || !aim || world.time < st.readyT) return 0;
   let dx = aim.x - ship.pos.x, dy = aim.y - ship.pos.y, d = Math.hypot(dx, dy);
   if (!(d > 1)) return 0;
   const R = clamp(d, 300, rk.range), ux = dx / d, uy = dy / d, n = st.salvo;
   let fired = 0;
   for (let i = 0; i < n; i++) {
      const eh = truncGauss(world.rng, 1.8) * rk.disp * 0.5, ev = truncGauss(world.rng, 1.8) * rk.disp;
      const tx = ship.pos.x + ux * (R + ev) - uy * eh, ty = ship.pos.y + uy * (R + ev) + ux * eh;
      const m = spawn(world, {
         side: ship.side, kind: 'rocket', type: 'rocket', x: ship.pos.x, y: ship.pos.y, alt: 6,
         heading: Math.atan2(ty - ship.pos.y, tx - ship.pos.x), speed: rk.speed, ownerId: ship.id, dmg: rk.dmg * (ship.dmgMult || 1),
         tx, ty, range: Math.hypot(tx - ship.pos.x, ty - ship.pos.y), t: -i * 0.09,
      });
      if (m) fired++;
   }
   if (!fired) return 0;
   st.readyT = world.time + rk.reload;
   ship.lastMainFire = world.time;
   world.pushEvent('rockets', { srcId: ship.id, n: fired, pos: { x: ship.pos.x, y: ship.pos.y }, to: { x: ship.pos.x + ux * R, y: ship.pos.y + uy * R }, text: 'Raketensalve' });
   return fired;
}

// ================================================================ doctrine, decoys
export const DOCTRINES = ['free', 'self', 'hold'];
export const DOCTRINE_NAMES = { free: 'Feuer frei', self: 'Selbstschutz', hold: 'Feuer halten' };
export function setDoctrine(world, P, d) {
   if (!DOCTRINES.includes(d)) return false;
   if (P.samDoctrine === d) return true;
   P.samDoctrine = d;
   if (world && (P.isPlayer || P.human)) world.pushEvent('doctrine', { srcId: P.id, doctrine: d, text: 'Flugabwehr: ' + DOCTRINE_NAMES[d] });
   return true;
}
// The SAMs take this missile / squadron first (id) — null clears it.
export function setPriorityTarget(world, P, id) {
   P.samPriority = typeof id === 'number' ? id : null;
   return true;
}

// A chaff / flare cloud beside the ship (consumable 'decoy', Ship.useConsumable). Every seeker that
// sees the cloud rolls once whether it falls for it.
export function deployDecoys(world, ship) {
   if (!ship.alive || ship.depth > 0) return null;
   const sgn = (ship._decoyN = (ship._decoyN || 0) + 1) & 1 ? 1 : -1;
   const a = ship.heading + sgn * Math.PI / 2, r = 160 + ship.cfg.hull.L * 0.4;
   const d = { id: world._nextId++, side: ship.side, shipId: ship.id, x: ship.pos.x + Math.cos(a) * r, y: ship.pos.y + Math.sin(a) * r, t0: world.time, n: 0 };
   world.decoys.push(d);
   world.pushEvent('decoy', { srcId: ship.id, decoyId: d.id, pos: { x: d.x, y: d.y }, text: 'Täuschkörper ausgestoßen' });
   return d;
}

// ================================================================ flight
function crashed(world, m) {
   for (const o of world.obstacles) {
      if (o.kind !== 'island') continue;
      const dx = m.x - o.c.x, dy = m.y - o.c.y, R = o.rMax || o.r * 1.6;
      if (dx * dx + dy * dy > R * R) continue;
      if (obstacleT(o, m) < 0.97 && islandHeightAt(o, m) > m.alt) return true;
   }
   return false;
}

function seduceChance(c) {
   return c.passive ? DEFENCE.decoyPkPassive : c.supersonic ? DEFENCE.decoyPkSuper : DEFENCE.decoyPk;
}
// One sweep of the terminal seeker: ships and decoy clouds inside range and cone; the designated
// target is preferred, a friendly ship in the cone is taken only if nothing else is there.
function seek(world, m, c) {
   let best = null, bestS = Infinity, viaDecoy = null;
   const cone = c.cone || 0.4;
   for (const S of world.ships) {
      if (!S.alive || S.id === m.ownerId || S.depth > 0) continue;
      const friendly = S.side === m.side;
      if (friendly && (!DEFENCE.friendlySeek || m.dist < DEFENCE.armDist)) continue;
      const dx = S.pos.x - m.x, dy = S.pos.y - m.y, d2 = dx * dx + dy * dy;
      let r = c.seeker;
      if (d2 > r * r) continue;
      if (!friendly && jammed(world, S.side, S.pos)) { r *= SENSOR.JAM_SEEKER; if (d2 > r * r) continue; }
      const off = Math.abs(angleDelta(m.heading, Math.atan2(dy, dx)));
      if (off > cone) continue;
      if (c.skim && world.losBlocked(m, S.pos)) continue;
      const s = off / cone + Math.sqrt(d2) / c.seeker * 0.6 - S.cfg.hull.L / 600 - (S.id === m.target ? 2 : 0) - (S.id === m.lock ? 0.5 : 0) + (friendly ? 3 : 0);
      if (s < bestS) { bestS = s; best = S; }
   }
   // decoys only matter while a real ship is (or would be) the target
   for (const D of world.decoys) {
      if (D.side === m.side || world.time - D.t0 > SENSOR.DECOY_LIFE) continue;
      if (m.rolled && m.rolled.includes(D.id)) continue;
      if ((D.n || 0) >= DEFENCE.decoyCap) continue;               // a cloud holds only so many seekers
      const dx = D.x - m.x, dy = D.y - m.y, d2 = dx * dx + dy * dy;
      if (d2 > c.seeker * c.seeker || Math.abs(angleDelta(m.heading, Math.atan2(dy, dx))) > cone) continue;
      (m.rolled || (m.rolled = [])).push(D.id);
      const fresh = 1 - 0.5 * (world.time - D.t0) / SENSOR.DECOY_LIFE;
      if (world.rng() < seduceChance(c) * fresh) { viaDecoy = D; break; }
   }
   if (viaDecoy) {
      viaDecoy.n = (viaDecoy.n || 0) + 1;
      m.lock = null; m.lockDecoy = viaDecoy.id; m.seduced = true;
      world.pushEvent('seduced', { srcId: viaDecoy.shipId, missileId: m.id, mtype: m.type, decoyId: viaDecoy.id, pos: { x: viaDecoy.x, y: viaDecoy.y }, text: 'Flugkörper abgelenkt' });
      return;
   }
   m.lock = best ? best.id : null;
}

function stepSSM(world, m, dt) {
   const c = MISSILES[m.type];
   m.t += dt;
   let aimX = m.tx, aimY = m.ty, L = null, decoy = null;
   if (m.lockDecoy != null) {
      decoy = world.decoys.find(d => d.id === m.lockDecoy) || null;
      if (decoy) { aimX = decoy.x; aimY = decoy.y; }
      else { lose(world, m, 'seduced'); return; }
   } else if (!m.seekerOn && m.tk === 'ship') {
      // mid-course guidance over the data link while the launching side still holds the target
      const T = world.shipById(m.target);
      if (T && T.alive && T.detected && !(T.depth > 0)) {
         const tgo = Math.hypot(T.pos.x - m.x, T.pos.y - m.y) / m.speed;
         m.tx = aimX = T.pos.x + T.vel.x * tgo; m.ty = aimY = T.pos.y + T.vel.y * tgo;
      }
   }
   const dAim = Math.hypot(aimX - m.x, aimY - m.y);
   if (!m.seekerOn && (m.tk === 'bearing' ? m.dist >= DEFENCE.armDist : dAim <= c.seeker)) { m.seekerOn = true; m.scanT = 0; }
   if (m.seekerOn && !decoy) {
      m.scanT -= dt;
      if (m.scanT <= 0) { m.scanT = SCAN_DT; seek(world, m, c); if (m.lockDecoy != null) return; }
      L = m.lock != null ? world.shipById(m.lock) : null;
      if (L && !L.alive) { L = null; m.lock = null; }
      if (L) { aimX = L.pos.x; aimY = L.pos.y; }
   }
   // terminal sprint (YJ-18, Kalibr)
   if (c.sprint && m.speed < c.sprint.speed && (L ? Math.hypot(aimX - m.x, aimY - m.y) : dAim) < c.sprint.at) m.speed = c.sprint.speed;
   // high flyers dive on the target at the end
   if (!c.skim) { const d = Math.hypot(aimX - m.x, aimY - m.y); m.alt = d < 3000 ? Math.max(SKIM_ALT, (c.alt || 300) * d / 3000) : c.alt || 300; }
   else if (m.alt > SKIM_ALT) m.alt = Math.max(SKIM_ALT, m.alt - 120 * dt);
   const want = Math.atan2(aimY - m.y, aimX - m.x);
   const turn = (m.seekerOn ? DEFENCE.turnTerminal : DEFENCE.turnCruise) * dt;
   m.heading += clamp(angleDelta(m.heading, want), -turn, turn);
   const step = m.speed * dt;
   m.px = m.x; m.py = m.y;
   m.x += Math.cos(m.heading) * step; m.y += Math.sin(m.heading) * step;
   m.dist += step;
   if (L) {
      const prev = { x: m.px, y: m.py };
      if (pointSegDist(L.pos, prev, m) < L.cfg.hull.L * 0.3 + 12) { ssmHit(world, m, L); return; }
   } else if (decoy) {
      if (pointSegDist(decoy, { x: m.px, y: m.py }, m) < 80) { lose(world, m, 'seduced'); world.addEffect('splash', m, 1.4, 16); return; }
   } else if (m.tk !== 'bearing' && dAim < step * 1.5 + 30) {
      // nothing found at the aim point: search on along the heading for one seeker range
      m.tk = 'bearing'; m.seekerOn = true;
      m.tx = m.x + Math.cos(m.heading) * c.seeker; m.ty = m.y + Math.sin(m.heading) * c.seeker;
      m.range = Math.min(m.range, m.dist + c.seeker);
   }
   if (m.dist >= m.range) { lose(world, m, L || m.seekerOn ? 'nolock' : 'fuel'); world.addEffect('splash', m, 1.4, 16); return; }
   // (not during the first metres: a coastal battery or a ship close inshore launches upward first)
   if (m.alt < 200 && m.dist > 600 && crashed(world, m)) { lose(world, m, 'terrain'); world.addEffect('terrain', m, 1.4, 30); }
}

function ssmHit(world, m, S) {
   const c = MISSILES[m.type], shooter = world.shipById(m.ownerId);
   const p = { x: S.pos.x + (m.px - S.pos.x) * 0.15, y: S.pos.y + (m.py - S.pos.y) * 0.15 };
   const dmg = m.dmg * (S.side === m.side ? DEFENCE.friendlyDmg : 1);
   m.alive = false; m.x = p.x; m.y = p.y;
   world.onHit(shooter, S, 'ssm', m);
   world.pushEvent('missileHit', { srcId: m.ownerId, dstId: S.id, dmg: Math.round(dmg), missileId: m.id, mtype: m.type, kind: m.kind, pos: p, text: c.name + ': Treffer' });
   world.addEffect('explosion', p, 1.5, 48, { big: true, hit: 'ssm', shipId: S.id });
   if (S === world.player) world.shakeAdd(1.5);
   S.takeDamage(dmg, shooter, 'ssm', WORLD.HIT_POOL.ssm ?? 0.3);
   if (!S.alive) return;
   const lp = toLocal(S, p), rng = world.rng;
   if (rng() < DEFENCE.hitFire) S.ignite(clamp(Math.floor((lp.x / S.cfg.hull.L + 0.5) * WORLD.FIRE_MAX), 0, WORLD.FIRE_MAX - 1), shooter);
   if (S.alive && rng() < DEFENCE.hitModule) S.damageModule(lp, shooter);
}

// Blast at a ground point: sites inside the radius, ships whose hull covers the point.
function groundBlast(world, m, radius, type) {
   const shooter = world.shipById(m.ownerId);
   let hit = 0;
   for (const S of world.sites) {
      if (!S.alive || S.side === m.side) continue;
      const d = Math.hypot(S.pos.x - m.x, S.pos.y - m.y), R = radius + (S.r || 0);
      if (d > R) continue;
      damageSite(world, S, m.dmg * (d < R * 0.5 ? 1 : 0.5), shooter, type);
      hit++;
   }
   for (const S of world.ships) {
      if (!S.alive || S.side === m.side || S.depth > 0) continue;
      const r = S.cfg.hull.L * 0.5 + 30;
      if (Math.abs(S.pos.x - m.x) > r || Math.abs(S.pos.y - m.y) > r) continue;
      if (!insideHull(S.cfg.hull, toLocal(S, m), type === 'cruise' ? 12 : 2)) continue;
      world.onHit(shooter, S, type, m);
      world.pushEvent('missileHit', { srcId: m.ownerId, dstId: S.id, dmg: Math.round(m.dmg), missileId: m.id, mtype: m.type, kind: m.kind, pos: { x: m.x, y: m.y },
         text: type === 'cruise' ? MISSILES[m.type].name + ': Treffer' : 'Raketentreffer' });
      S.takeDamage(m.dmg, shooter, type, WORLD.HIT_POOL[type] ?? 0.4);
      hit++;
   }
   return hit;
}

function stepCruise(world, m, dt) {
   const c = MISSILES[m.type];
   m.t += dt;
   const dx = m.tx - m.x, dy = m.ty - m.y, d = Math.hypot(dx, dy), step = m.speed * dt;
   m.px = m.x; m.py = m.y;
   if (d <= step + 5) {
      m.x = m.tx; m.y = m.ty; m.alt = 0; m.alive = false;
      const n = groundBlast(world, m, DEFENCE.cruiseBlast, 'cruise');
      world.addEffect('explosion', m, 1.8, 60, { big: true, hit: 'cruise' });
      if (!n) world.pushEvent('missileLost', { srcId: m.ownerId, missileId: m.id, mtype: m.type, kind: m.kind, reason: 'ground', pos: { x: m.x, y: m.y } });
      return;
   }
   const turn = DEFENCE.turnCruise * dt;
   m.heading += clamp(angleDelta(m.heading, Math.atan2(dy, dx)), -turn, turn);
   m.x += Math.cos(m.heading) * step; m.y += Math.sin(m.heading) * step;
   m.dist += step;
   m.alt = d < 1500 ? Math.max(5, (c.alt || 60) * d / 1500) : c.alt || 60;
   if (m.dist >= m.range) lose(world, m, 'fuel');
}

function stepRocket(world, m, dt) {
   m.t += dt;
   if (m.t < 0) return;
   const u = Math.min(1, m.t * m.speed / m.range);
   m.px = m.x; m.py = m.y;
   m.x = m.sx + (m.tx - m.sx) * u; m.y = m.sy + (m.ty - m.sy) * u;
   m.alt = 6 + m.range * 0.12 * 4 * u * (1 - u);
   m.dist = m.range * u;
   if (u < 1) return;
   m.alive = false; m.alt = 0;
   if (groundBlast(world, m, DEFENCE.rocketBlast, 'rocket')) world.addEffect('explosion', m, 0.7, 14, { hit: 'rocket' });
   else world.addEffect(world.obstacles.some(o => o.kind === 'island' && obstacleT(o, m) < 1) ? 'terrain' : 'splash', m, 1.2, 10);
}

// ---------------------------------------------------------------- interceptors
function threatRef(world, m, idx) {
   if (m.tk === 'squad') {
      const q = squadById(world, m.target);
      if (q) return q.n > 0 && q.state !== 'land' ? q : null;
      const h = heloById(world, m.target);      // helicopters are engaged like a flight of one
      return h && h.alive ? h : null;
   }
   const t = idx.get(m.target);
   return t && t.alive ? t : null;
}
function freeChannel(world, m) {
   if (m.chI < 0) return;
   const P = platformById(world, m.ownerId), ch = P && P.samCh ? P.samCh[m.chI] : null;
   if (ch && ch.mid === m.id) { ch.tgt = null; ch.mid = null; ch.readyT = world.time + DEFENCE.relook; }
}
function stepInterceptor(world, m, dt, idx) {
   const c = MISSILES[m.type];
   m.t += dt;
   const T = threatRef(world, m, idx);
   if (!T) { m.alive = false; freeChannel(world, m); return; }
   const sq = m.tk === 'squad';
   const Tx = sq ? T.pos.x : T.x, Ty = sq ? T.pos.y : T.y;
   const d = Math.hypot(Tx - m.x, Ty - m.y), step = m.speed * dt;
   const done = () => { T.eng = Math.max(0, (T.eng || 0) - 1); m.alive = false; freeChannel(world, m); };
   m.px = m.x; m.py = m.y;
   if (d <= step + T.speed * dt + 25) {
      m.x = Tx; m.y = Ty; m.alt = T.alt;
      const f = Math.hypot(Tx - m.sx, Ty - m.sy) / (sq ? c.air || c.range : c.range);
      let pk = c.pk * (f <= 0.5 ? 1 : 1 - (1 - DEFENCE.farPk) * Math.min(1, (f - 0.5) * 2));
      pk *= sq ? DEFENCE.aircraftPk : (MISSILES[T.type]?.evade ?? 1) * DEFENCE.missilePk;
      const by = m.kind === 'aam' ? 'aam' : 'sam', owner = platformById(world, m.ownerId);
      done();
      if (world.rng() < Math.min(0.95, pk)) {
         if (sq && T.isHelo) { world.addEffect('flak', T.pos, 0.8, 16, { alt: T.alt }); killHelo(world, T, owner, 'sam'); }
         else if (sq) { world.addEffect('flak', T.pos, 0.8, 16, { alt: T.alt }); hurtSquad(world, T, T.hp + 1, owner && owner.aa ? owner : null); }
         else killMissile(world, T, by, owner, m);
      } else world.pushEvent('samMiss', { srcId: m.ownerId, missileId: sq ? null : T.id, sqId: sq ? T.id : null, mtype: m.type, pos: { x: Tx, y: Ty }, alt: T.alt });
      return;
   }
   // lead pursuit: aim where the target will be when the interceptor gets there
   const tgo = d / (m.speed + 1);
   const ax = Tx + Math.cos(T.heading) * T.speed * tgo * 0.8, ay = Ty + Math.sin(T.heading) * T.speed * tgo * 0.8;
   m.heading = Math.atan2(ay - m.y, ax - m.x);
   m.x += Math.cos(m.heading) * step; m.y += Math.sin(m.heading) * step;
   m.dist += step;
   m.alt += clamp(T.alt - m.alt, -400 * dt, 400 * dt);
   if (m.dist > m.range) done();
}
function killMissile(world, T, by, owner, via) {
   if (!T.alive) return;
   T.alive = false;
   if (owner && owner.stats) owner.stats.missilesDown++;
   world.addEffect('flak', T, 0.9, 20, { alt: T.alt, hit: 'intercept' });
   world.pushEvent('intercept', { srcId: owner ? owner.id : null, by, missileId: T.id, mtype: T.type, kind: T.kind, samId: via ? via.id : null,
      pos: { x: T.x, y: T.y }, alt: T.alt, text: (MISSILES[T.type]?.name || 'Flugkörper') + ' abgefangen' });
}

// ================================================================ defence
// Is missile m coming for platform P (as far as its track tells)?
export function threatens(P, m) {
   if (m.lock != null) return m.lock === P.id;
   if (m.lockDecoy != null) return false;
   const dx = P.pos.x - m.x, dy = P.pos.y - m.y, d = Math.hypot(dx, dy);
   if (m.kind === 'cruise') return Math.hypot(m.tx - P.pos.x, m.ty - P.pos.y) < 400;
   if (Math.hypot(m.tx - P.pos.x, m.ty - P.pos.y) < 2500) return true;
   return d < 14000 && Math.abs(angleDelta(m.heading, Math.atan2(dy, dx))) < 0.2;
}
function channels(P) {
   if (P.samCh) return P.samCh;
   const out = [];
   for (const s of P.cfg.weapons.sam) for (let i = 0; i < s.ch; i++) out.push({ type: s.type, tgt: null, mid: null, readyT: 0 });
   return P.samCh = out;
}

// Seconds between two SAMs leaving platform P: the launcher / fire-control rate is what a salvo
// saturates. More channels fire faster; a supersonic threat is answered in rapid fire.
export function samInterval(P, urgent) {
   return DEFENCE.samGap * 4 / (2 + channels(P).length) * (urgent ? DEFENCE.samGapUrgent : 1);
}
function isUrgent(P, m) {
   return !!MISSILES[m.type].supersonic;
}

function launchSAM(world, P, chI, T, sq) {
   const ch = P.samCh[chI], c = MISSILES[ch.type];
   const Tx = sq ? T.pos.x : T.x, Ty = sq ? T.pos.y : T.y;
   const m = spawn(world, {
      side: P.side, kind: 'sam', type: ch.type, x: P.pos.x, y: P.pos.y, alt: 20, heading: Math.atan2(Ty - P.pos.y, Tx - P.pos.x),
      speed: c.speed, ownerId: P.id, target: T.id, tk: sq ? 'squad' : 'missile', tx: Tx, ty: Ty, range: (sq ? c.air || c.range : c.range) * 1.6,
   });
   if (!m) return null;
   m.chI = chI; m.detected = true;
   P.mag[ch.type]--;
   ch.tgt = T.id; ch.mid = m.id;
   P.samGapT = world.time + samInterval(P, !sq && isUrgent(P, T));
   T.eng = (T.eng || 0) + 1;
   if (P.stats) P.stats.samFired++;
   world.pushEvent('samLaunch', { srcId: P.id, missileId: m.id, mtype: ch.type, dstId: T.id, tk: m.tk, pos: { x: m.x, y: m.y }, text: c.name });
   return m;
}

function defendPlatform(world, P, threats, squads) {
   const chs = channels(P);
   if (!chs.length || P.samDoctrine === 'hold') return;
   const now = world.time, self = P.samDoctrine === 'self';
   for (let i = 0; i < chs.length; i++) {
      const ch = chs[i];
      if (ch.tgt != null || now < ch.readyT || (P.samGapT || 0) > now) continue;
      if (!(P.mag[ch.type] > 0)) continue;
      const c = MISSILES[ch.type];
      const blind = !P.radarOn;
      if (blind && !c.passive) continue;
      let best = null, bestS = Infinity, bestSq = false;
      for (const m of threats) {
         if (!m.alive || now - m.detT < DEFENCE.react) continue;
         const d = Math.hypot(m.x - P.pos.x, m.y - P.pos.y);
         if (d > c.range || d < DEFENCE.minRange || (blind && d > SENSOR.VISUAL_MISSILE)) continue;
         const tti = d / m.speed;
         if ((m.eng || 0) >= (tti < DEFENCE.panicT || MISSILES[m.type].supersonic ? DEFENCE.salvoClose : DEFENCE.salvo)) continue;
         const mine = threatens(P, m);
         if (self && !mine) continue;
         if (m.alt < 300 && world.losBlocked(P.pos, m)) continue;
         const s = tti - (mine ? 4 : 0) - (m.id === P.samPriority ? 1000 : 0);
         if (s < bestS) { bestS = s; best = m; bestSq = false; }
      }
      if (!best || bestS > 20) for (const q of squads) {
         const d = Math.hypot(q.pos.x - P.pos.x, q.pos.y - P.pos.y);
         if (d > (c.air || c.range) || (blind && d > 4000) || (self && d > (c.air || c.range) * 0.6)) continue;
         if ((q.eng || 0) >= DEFENCE.salvoClose) continue;
         const s = 20 + d / 400 - (q.id === P.samPriority ? 1000 : 0);
         if (s < bestS) { bestS = s; best = q; bestSq = true; }
      }
      if (best) launchSAM(world, P, i, best, bestSq);
   }
}

function ciwsPass(world, dt, bySide) {
   for (const S of world.ships) {
      const cw = S.cfg.weapons.ciws;
      if (!cw) continue;
      const tg = S.ciwsTgt || (S.ciwsTgt = []);
      tg.length = 0;
      if (!S.alive || S.depth > 0) continue;
      const list = bySide[opp(S.side)], k = CIWS[cw.type], r2 = k.range * k.range;
      // nearest first; one mount per target, spare mounts double up on the nearest
      let near = null;
      for (const m of list) {
         if (!m.alive) continue;
         const dx = m.x - S.pos.x, dy = m.y - S.pos.y, d2 = dx * dx + dy * dy;
         if (d2 > r2) continue;
         (near || (near = [])).push(m); m._d2 = d2;
      }
      if (!near) continue;
      near.sort((a, b) => a._d2 - b._d2);
      for (let i = 0; i < cw.n; i++) {
         const m = near[i < near.length ? i : 0];
         if (!m.alive) continue;
         if (!tg.includes(m.id)) tg.push(m.id);
         const kps = k.kps * DEFENCE.ciwsK * (MISSILES[m.type].supersonic ? CIWS_SUPER : 1);
         if (world.rng() < 1 - Math.pow(1 - kps, dt)) killMissile(world, m, 'ciws', S, null);
      }
   }
}

// ---------------------------------------------------------------- fighters (air-to-air missiles)
// One AAM from fighter squadron sq at an opposing squadron or missile. Returns the missile or null.
export function launchInterceptor(world, sq, T) {
   const a = sq.cfg && sq.cfg.aam, c = a && MISSILES[a.type];
   if (!c || !T || sq.n <= 0) return null;
   if (sq.aam == null) sq.aam = sq.n0 * (a.per || 2);
   if (sq.aam <= 0) return null;
   const isSq = !!T.pos;
   const Tx = isSq ? T.pos.x : T.x, Ty = isSq ? T.pos.y : T.y;
   const m = spawn(world, {
      side: sq.side, kind: 'aam', type: a.type, x: sq.pos.x, y: sq.pos.y, alt: sq.alt, heading: Math.atan2(Ty - sq.pos.y, Tx - sq.pos.x),
      speed: c.speed, ownerId: sq.ownerId, sqId: sq.id, target: T.id, tk: isSq ? 'squad' : 'missile', tx: Tx, ty: Ty, range: c.range * 1.6,
   });
   if (!m) return null;
   m.detected = true;
   sq.aam--;
   T.eng = (T.eng || 0) + 1;
   world.pushEvent('aamLaunch', { srcId: sq.ownerId, sqId: sq.id, missileId: m.id, mtype: a.type, dstId: T.id, tk: m.tk, pos: { x: m.x, y: m.y }, alt: m.alt, text: c.name });
   return m;
}
function fightersPass(world, bySide) {
   for (const sq of world.squadrons) {
      if (sq.type !== 'ft' || sq.n <= 0 || sq.state === 'launch' || sq.state === 'land' || sq.state === 'return') continue;
      const a = sq.cfg.aam, c = a && MISSILES[a.type];
      if (!c || (sq.aamT || 0) > world.time || sq.aam === 0) continue;
      let best = null, bd = c.range;
      for (const q of world.squadrons) {
         if (q.side === sq.side || q.n <= 0 || q.state === 'land' || (q.eng || 0) >= 2) continue;
         const d = Math.hypot(q.pos.x - sq.pos.x, q.pos.y - sq.pos.y);
         if (d < bd) { bd = d; best = q; }
      }
      if (!best) for (const h of world.helos) {      // a helicopter in reach is an easy kill
         if (h.side === sq.side || !h.alive || (h.eng || 0) >= 1) continue;
         const d = Math.hypot(h.pos.x - sq.pos.x, h.pos.y - sq.pos.y);
         if (d < bd) { bd = d; best = h; }
      }
      if (!best) for (const m of bySide[opp(sq.side)]) {
         if (!m.alive || !m.detected || (m.eng || 0) >= 1) continue;
         const d = Math.hypot(m.x - sq.pos.x, m.y - sq.pos.y);
         if (d < bd * 0.8) { bd = d / 0.8; best = m; }
      }
      if (best && launchInterceptor(world, sq, best)) sq.aamT = world.time + DEFENCE.aamGap;
   }
}

// ================================================================ per step
const _by = { player: [], enemy: [] }, _sq = { player: [], enemy: [] }, _idx = new Map();
export function updateMissiles(world, dt) {
   const ms = world.missiles;
   if (world.decoys.length && world.time - world.decoys[0].t0 > SENSOR.DECOY_LIFE) world.decoys = world.decoys.filter(d => world.time - d.t0 <= SENSOR.DECOY_LIFE);
   if (!ms.length && !world.squadrons.length && !world.helos.length) return;
   _idx.clear();
   let guided = false;
   for (const m of ms) { if (m.kind === 'sam' || m.kind === 'aam') guided = true; else if (m.kind !== 'rocket') _idx.set(m.id, m); }
   if (!guided) _idx.clear();
   // threats first, then the interceptors that chase them
   for (let i = 0, n = ms.length; i < n; i++) {
      const m = ms[i];
      if (!m.alive) continue;
      if (m.kind === 'ssm') stepSSM(world, m, dt);
      else if (m.kind === 'cruise') stepCruise(world, m, dt);
      else if (m.kind === 'rocket') stepRocket(world, m, dt);
   }
   if (guided) for (let i = 0, n = ms.length; i < n; i++) { const m = ms[i]; if (m.alive && (m.kind === 'sam' || m.kind === 'aam')) stepInterceptor(world, m, dt, _idx); }

   _by.player.length = _by.enemy.length = 0;
   for (const m of ms) {
      if (!m.alive || !isThreat(m)) continue;
      _by[m.side].push(m);
      if (m.detected && !m.ann) {
         m.ann = true;
         world.pushEvent('vampire', { missileId: m.id, mtype: m.type, kind: m.kind, side: opp(m.side), dstId: m.lock ?? (m.tk === 'ship' ? m.target : null),
            pos: { x: m.x, y: m.y }, text: 'Flugkörper im Anflug!' });
      }
   }
   if (_by.player.length || _by.enemy.length) ciwsPass(world, dt, _by);
   world._defT = (world._defT || 0) - dt;
   if (world._defT <= 0) {
      world._defT = DEF_DT;
      _sq.player.length = _sq.enemy.length = 0;
      for (const q of world.squadrons) if (q.n > 0 && q.state !== 'land' && q.alt > 15) _sq[q.side].push(q);
      for (const h of world.helos) if (h.alive && h.alt > 15 && (h.side === 'enemy' ? h.visible : h.visE)) _sq[h.side].push(h);
      for (const side of ['player', 'enemy']) {
         const o = opp(side);
         let threats = null;
         for (const m of _by[o]) if (m.detected) (threats || (threats = [])).push(m);
         if (!threats && !_sq[o].length) continue;
         for (const S of world.ships) if (S.alive && S.side === side && !(S.depth > 0) && S.cfg.weapons.sam.length) defendPlatform(world, S, threats || NONE, _sq[o]);
         for (const S of world.sites) if (S.alive && S.side === side && S.cfg.weapons.sam.length) defendPlatform(world, S, threats || NONE, _sq[o]);
      }
      if (world.squadrons.length) fightersPass(world, _by);
   }
   // compact in place
   let j = 0;
   for (let i = 0; i < ms.length; i++) if (ms[i].alive) ms[j++] = ms[i];
   ms.length = j;
}
const NONE = [];

// ================================================================ queries (HUD / AI)
// Missiles `side` tracks coming in: [{ id, kind, type, name, x, y, alt, heading, speed, supersonic,
// targetId (ship of `side` it goes for, or null), tti (s to that ship / its aim point), eng, seduced }]
export function inbound(world, side) {
   const out = [];
   for (const m of world.missiles) {
      if (!m.alive || m.side === side || !isThreat(m) || !m.detected) continue;
      let T = m.lock != null ? world.shipById(m.lock) : null, tti;
      if (!T && m.lockDecoy == null && m.kind === 'ssm') {
         let bd = 3000 * 3000;
         for (const S of world.ships) {
            if (!S.alive || S.side !== side) continue;
            const d2 = (S.pos.x - m.tx) ** 2 + (S.pos.y - m.ty) ** 2;
            if (d2 < bd) { bd = d2; T = S; }
         }
      }
      if (T && T.side !== side) T = null;
      if (T) tti = Math.hypot(T.pos.x - m.x, T.pos.y - m.y) / m.speed;
      else tti = Math.hypot(m.tx - m.x, m.ty - m.y) / m.speed;
      out.push({ id: m.id, kind: m.kind, type: m.type, name: MISSILES[m.type].name, x: m.x, y: m.y, alt: m.alt, heading: m.heading, speed: m.speed,
         supersonic: !!MISSILES[m.type].supersonic, targetId: T ? T.id : null, tti, eng: m.eng || 0, seduced: m.seduced });
   }
   return out.sort((a, b) => a.tti - b.tti);
}
// The tracked missiles that go for `ship`, nearest in time first (same shape as inbound).
export function threatsTo(world, ship) {
   return inbound(world, ship.side).filter(t => t.targetId === ship.id);
}
// What the air defence of a platform is doing:
// { doctrine, priority, layers: [{ type, name, cls, mag, max, ch, busy, targets: [ids] }], ciws: { type, name, n, targets } | null }
export function samStatus(P) {
   const chs = channels(P), layers = [];
   for (const s of P.cfg.weapons.sam) {
      const mine = chs.filter(c => c.type === s.type), c = MISSILES[s.type];
      layers.push({ type: s.type, name: c.name, cls: c.cls, mag: P.mag[s.type] || 0, max: s.n, ch: s.ch,
         busy: mine.filter(c => c.tgt != null).length, targets: mine.filter(c => c.tgt != null).map(c => c.tgt) });
   }
   const cw = P.cfg.weapons.ciws;
   return { doctrine: P.samDoctrine, priority: P.samPriority, layers,
      ciws: cw ? { type: cw.type, name: CIWS[cw.type].name, n: cw.n, targets: P.ciwsTgt ? P.ciwsTgt.slice() : [] } : null };
}
