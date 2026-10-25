// game3d/sites.js — land targets of the WW2 mode (coastal operations): static, team-owned positions
// with HP on an island. Plain data in world.sites[]; World.update calls updateSites while any exist.
// Adapted from the modern mode's sites (gamev2/sites.js) down to what guns and shells need.
//
// Site: { id, side, kind, name, x, y, pos {x, y}, r (m, hit radius), h (ground height), hp, maxHp,
//         alive, isSite, heading, ... }
//    ramp     V-2 launch site: counts down, then a rocket lifts off (event 'rocket', _script.onRocket);
//             with `rearm` it is fuelled again for the next launch
//    battery  coastal battery: fires shells (combat.makeShell) at the nearest ship of the other side it
//             can see (spotted by its side, or within `detect` m of its own observers)
//    gate     dock caisson / harbour boom: a target with HP only (rammed or shelled)
//    bunker   command bunker, flak    flak tower: targets with HP only
// Damage: shells that come down on or next to a site (combat.js calls shellOnSite). HE wrecks the
// light positions, AP is wasted on them; concrete takes both badly.
// Events: siteHit { dstId, dmg }, siteDestroyed { dstId, kind }, siteFire { srcId, caliber, guns },
// rocket { srcId, pos }.
// Sites are not ships: they are in no ship list, never in world._byId, and are not replicated in a
// co-op game (missions that use them are single-player, see net/setup.js NO_COOP).
import { SHIPS } from './config.js';
import { islandHeightAt, obstacleT, gaussR } from './utils.js';
import { makeShell, flightTime } from './combat.js';

// he / ap: share of a shell's damage that tells against the position (on top of the 1/3 of a hit)
export const SITE_KINDS = {
   ramp: { name: 'V-2-Abschussrampe', hp: 5000, r: 70, he: 1, ap: 0.3 },
   battery: { name: 'Küstenbatterie', hp: 9000, r: 50, he: 0.75, ap: 0.6 },
   gate: { name: 'Docktor', hp: 30000, r: 70, he: 0.5, ap: 0.7 },
   bunker: { name: 'Leitbunker', hp: 14000, r: 45, he: 0.55, ap: 0.8 },
   flak: { name: 'Flakstellung', hp: 5000, r: 40, he: 1, ap: 0.35 },
};

// Coastal guns: a cruiser's guns on a fixed mount (light: 15 cm, heavy: 28 cm), slower to lay.
const GUNS = {
   light: { from: 'Nuernberg', range: 13000, reload: 9, guns: 3 },
   heavy: { from: 'Scharnhorst', range: 17000, reload: 22, guns: 2 },
};
function batteryGun(key) {
   const G = GUNS[key] || GUNS.light, m = SHIPS[G.from].main;
   return { ...m, range: G.range, reload: G.reload, guns: G.guns, he: { ...m.he, fire: (m.he.fire || 0) * 0.6 } };
}

export function siteById(world, id) {
   if (id == null || !world.sites) return null;
   for (const s of world.sites) if (s.id === id) return s;
   return null;
}

// ground height under a point (the highest island there)
export function groundAt(world, p) {
   let h = 0;
   for (const o of world.obstacles) if (o.kind === 'island' && obstacleT(o, p) < 1.02) h = Math.max(h, islandHeightAt(o, p));
   return h;
}

// opts: { name, hp, r, heading, gun ('light'|'heavy'), guns, reload, detect (m), delay (s before first salvo),
//         countdown (s, ramp), rearm (s, ramp: 0 = one rocket only), hidden (ramp not yet known) }
export function addSite(world, kind, side, pos, opts = {}) {
   const K = SITE_KINDS[kind];
   if (!K) throw new Error('Unknown site kind: ' + kind);
   const hp = Math.round((opts.hp ?? K.hp) * (side === 'enemy' ? world.difficulty?.botHP || 1 : 1));
   const p = { x: pos.x, y: pos.y };
   const h = groundAt(world, p);
   const s = {
      id: world._nextId++, side, kind, name: opts.name || K.name, isSite: true,
      x: p.x, y: p.y, pos: p, r: opts.r ?? K.r, h, heading: opts.heading ?? 0,
      hp, maxHp: hp, maxHP: hp, alive: true, heK: K.he, apK: K.ap, lastHitT: -99,
      hidden: !!opts.hidden,
      // what combat.js / Ship.takeDamage read from a shooter
      hits: 0, dmgDealt: 0, kills: 0, stats: null, dmgMult: side === 'enemy' ? world.difficulty?.botDmg || 1 : 1,
      cfg: { name: opts.name || K.name, hull: { deckH: h + 8, L: 2 * (opts.r ?? K.r), type: 'SITE' } },
   };
   if (kind === 'battery') {
      s.gun = batteryGun(opts.gun);
      if (opts.guns) s.gun.guns = opts.guns;
      if (opts.reload) s.gun.reload = opts.reload;
      s.detect = opts.detect ?? 7000;
      s.reload = opts.delay ?? 6 + world.rng() * 6;
      s.tgtId = null; s.salvoN = 0; s.err = { r: 0, l: 0 };
   } else if (kind === 'ramp') {
      s.countdown = opts.countdown ?? 240;
      s.rearm = opts.rearm ?? 0;
      s.launches = 0;
      s.armed = true;
   }
   world.sites.push(s);
   return s;
}

// Damage a site; returns the damage done. Fires the events and the mission hook when it falls.
export function damageSite(world, site, amount, shooter) {
   if (!site || !site.alive || !(amount > 0)) return 0;
   const amt = Math.min(amount, site.hp);
   site.hp -= amt;
   site.lastHitT = world.time;
   if (shooter) {
      shooter.dmgDealt = (shooter.dmgDealt || 0) + amt;
      if (shooter.stats) shooter.stats.dmg += amt;
   }
   world.pushEvent('siteHit', { srcId: shooter ? shooter.id : null, dstId: site.id, dmg: Math.round(amt), pos: { x: site.x, y: site.y }, text: site.name + ' getroffen' });
   if (site.hp <= 0.5) {
      site.hp = 0; site.alive = false; site.armed = false;
      world.addEffect('explosion', site.pos, 2.4, 70, { big: true, hit: 'site' });
      world.pushEvent('siteDestroyed', { srcId: shooter ? shooter.id : null, dstId: site.id, kind: site.kind, pos: { x: site.x, y: site.y }, text: site.name + ' zerstört' });
      world.log(null, (site.side === 'enemy' ? '🎯 Zerstört: ' : '💀 Verlust: ') + site.name, site.side === 'enemy' ? 'kill' : 'warn');
      if (world._script && world._script.onSiteDestroyed) world._script.onSiteDestroyed(world, site, shooter);
   }
   return amt;
}

// A shell came down at p (on land or in the water next to the coast): the nearest opposing site
// within twice its radius takes a share of it (full inside the radius, 40 % in the outer ring).
export function shellOnSite(world, s, p) {
   const sites = world.sites;
   if (!sites || !sites.length) return null;
   let best = null, bd = Infinity;
   for (const S of sites) {
      if (!S.alive || S.side === s.side) continue;
      const d2 = (S.x - p.x) ** 2 + (S.y - p.y) ** 2, R = 2 * S.r;
      if (d2 < R * R && d2 < bd) { bd = d2; best = S; }
   }
   if (!best) return null;
   const near = bd <= best.r * best.r ? 1 : 0.4;
   const k = s.ammo === 'AP' ? best.apK : best.heK;
   const shooter = s.shooter && s.shooter.alive !== undefined ? s.shooter : world.shipById(s.ownerId);
   const amt = damageSite(world, best, s.dmg / 3 * k * near, shooter);
   if (amt > 0 && shooter && shooter.stats && s.kind !== 'sec') shooter.stats.hits++;
   return best;
}

// the ship a battery engages: of the other side, afloat, in range and seen (spotted, or close)
function pickTarget(world, site) {
   let best = null, bd = site.gun.range * site.gun.range;
   const det2 = site.detect * site.detect;
   for (const T of world.ships) {
      if (!T.alive || T.side === site.side || T.depth > 0) continue;
      const d2 = (T.pos.x - site.x) ** 2 + (T.pos.y - site.y) ** 2;
      if (d2 >= bd) continue;
      if (!T.detected && d2 > det2) continue;
      bd = d2; best = T;
   }
   return best;
}

const _aim = { x: 0, y: 0 }, _muz = { x: 0, y: 0 };
function batteryFire(world, S, dt) {
   if ((S.reload -= dt) > 0) return;
   const T = pickTarget(world, S);
   if (!T) { S.reload = 1; S.tgtId = null; return; }
   if (T.id !== S.tgtId) { S.tgtId = T.id; S.salvoN = 0; }
   const g = S.gun, dx = T.pos.x - S.x, dy = T.pos.y - S.y, dd = Math.hypot(dx, dy) || 1;
   // ranging: the first salvos are wide, later ones walk onto the target (difficulty aim error)
   const e = (world.difficulty?.aimErr || 0.013) * (S.salvoN < 2 ? 2.2 : 1.1);
   S.err.r = gaussR(world.rng) * e; S.err.l = gaussR(world.rng) * e * 0.5;
   const lead = flightTime(g, Math.min(dd, g.range)) * (world.difficulty?.lead ?? 0.8);
   const bx = dx / dd, by = dy / dd;
   _aim.x = T.pos.x + T.vel.x * lead + bx * S.err.r * dd - by * S.err.l * dd;
   _aim.y = T.pos.y + T.vel.y * lead + by * S.err.r * dd + bx * S.err.l * dd;
   S.heading = Math.atan2(dy, dx);
   for (let i = 0; i < g.guns; i++) {
      _muz.x = S.x + bx * 12 + (i - (g.guns - 1) / 2) * -by * 14;
      _muz.y = S.y + by * 12 + (i - (g.guns - 1) / 2) * bx * 14;
      world.addShell(makeShell(world, S, _muz, _aim, g, 'main', 'HE'));
   }
   world.pushEvent('siteFire', { srcId: S.id, dstId: T.id, caliber: g.caliber, guns: g.guns, pos: { x: S.x, y: S.y }, bearing: S.heading });
   S.salvoN++;
   S.reload = g.reload * (0.9 + world.rng() * 0.2);
}

export function updateSites(world, dt) {
   for (const S of world.sites) {
      if (!S.alive) continue;
      if (S.kind === 'battery') batteryFire(world, S, dt);
      else if (S.kind === 'ramp' && S.armed) {
         if ((S.countdown -= dt) > 0) continue;
         S.launches++;
         world.pushEvent('rocket', { srcId: S.id, pos: { x: S.x, y: S.y }, alt: S.h, text: S.name + ': Rakete gestartet' });
         if (world._script && world._script.onRocket) world._script.onRocket(world, S);
         if (S.rearm > 0) S.countdown = S.rearm;
         else { S.armed = false; S.countdown = 0; }
      }
   }
}
