// gamev2/sites.js — land positions of the modern mode: static, team-owned entities with HP on the
// coast of an island. Plain data in world.sites[]; World.update calls updateSites.
//
// Site: { id, side, team, kind, name, x, y, pos {x, y}, r (m, hit radius), hp, maxHp, alive, isSite,
//         radarOn, cfg { radar, weapons { ssm, sam, ... }, stealth, air }, mag, samDoctrine, samPriority,
//         lastSsmFire, detected, targetable, esmSeen, ... }
// A site carries the same fields a ship does where the shared systems need them, so sensors.js
// (radar, ESM) and missile.js (launchSSM, SAM channels) treat it as a "platform".
//    battery   Küstenbatterie: fires anti-ship missiles at ships its side holds a fire-control track on
//    sam       Flugabwehrstellung: SAM channels like a ship (missile.js defends it and its surroundings)
//    radar     Radarstation: a strong radar (sensors.sitesSee) — its side sees far while it stands
//    airfield  Flugplatz: launches squadrons through air.js (strike on tracked ships)
//    bunker    Kommandobunker, launcher Raketenstartrampe: mission targets with HP only
// Damage: cruise missiles, rockets (missile.js), bombs (air.js), shells that land on it (combat.js).
// Events: siteHit { dstId, dmg, by }, siteDestroyed { dstId }.
import { SHIPS, MISSILES } from './config.js';
import { obstacleT, obstacleRadiusAt } from './utils.js';
import { launchSSM } from './missile.js';
import { launchSquadron, canLaunch, AIR_TYPES } from './air.js';

const RADAR = (range, horizon) => ({ range, horizon, air: Math.round(range * 1.3) });
export const SITE_KINDS = {
   battery: { name: 'Küstenbatterie', hp: 6000, r: 60, radar: RADAR(22000, 9000), ssm: { type: 'noor', n: 8 }, salvo: 2, interval: 28 },
   sam: { name: 'Flugabwehrstellung', hp: 5000, r: 60, radar: RADAR(21000, 9500), sam: { type: 'hq16', n: 16, ch: 2 } },
   radar: { name: 'Radarstation', hp: 3500, r: 50, radar: RADAR(27000, 11500) },
   airfield: { name: 'Flugplatz', hp: 14000, r: 160, radar: RADAR(18000, 8000), wing: 'Kusnezow', interval: 50 },
   bunker: { name: 'Kommandobunker', hp: 16000, r: 70 },
   launcher: { name: 'Raketenstartrampe', hp: 9000, r: 70 },
};

export function siteById(world, id) {
   if (id == null) return null;
   for (const s of world.sites) if (s.id === id) return s;
   return null;
}

// Put a position inside an island on its coast (radars and sea-skimmers need a free line to the sea).
function toCoast(world, pos) {
   for (const o of world.obstacles) {
      if (o.kind !== 'island') continue;
      const t = obstacleT(o, pos);
      if (t >= 0.94) continue;
      let a = Math.atan2(pos.y - o.c.y, pos.x - o.c.x);
      if (t < 0.01) a = 0;
      const r = obstacleRadiusAt(o, a) * 0.96;
      return { x: o.c.x + Math.cos(a) * r, y: o.c.y + Math.sin(a) * r };
   }
   return { x: pos.x, y: pos.y };
}

// opts: { name, hp, radarOn, inland (keep the position), ssm { type, n }, salvo, interval, sam { type, n, ch }
//         | [..], radar { range, horizon, air }, wing (carrier class key whose air wing the field flies), id }
export function addSite(world, kind, side, pos, opts = {}) {
   const K = SITE_KINDS[kind];
   if (!K) throw new Error('Unknown site kind: ' + kind);
   const p = opts.inland ? { x: pos.x, y: pos.y } : toCoast(world, pos);
   const ssm = opts.ssm || K.ssm, sam = opts.sam || K.sam;
   const weapons = { ssm: ssm ? [{ ...ssm }] : [], cruise: null, sam: sam ? (Array.isArray(sam) ? sam.map(s => ({ ...s })) : [{ ...sam }]) : [], ciws: null, rockets: null, asw: null, cells: 0 };
   const mag = {};
   for (const s of weapons.ssm) mag[s.type] = s.n;
   for (const s of weapons.sam) mag[s.type] = s.n;
   for (const k in mag) if (!MISSILES[k]) throw new Error('site ' + kind + ': unknown missile ' + k);
   const hp = Math.round((opts.hp ?? K.hp) * (side === 'enemy' ? world.difficulty?.botHP || 1 : 1));
   const radar = opts.radar === null ? null : opts.radar || K.radar || null;
   const wing = kind === 'airfield' ? SHIPS[opts.wing || K.wing]?.air || null : null;
   const s = {
      id: opts.id ?? world._nextId++, side, team: side, kind, name: opts.name || K.name, isSite: true,
      x: p.x, y: p.y, pos: p, r: opts.r ?? K.r, heading: opts.heading ?? 0, depth: 0,
      hp, maxHp: hp, maxHP: hp, alive: true,
      radarOn: opts.radarOn ?? !!radar, jamming: false, detected: !opts.hidden, targetable: !opts.hidden, esmSeen: null,
      cfg: { name: opts.name || K.name, radar, stealth: 1, weapons, air: wing, hull: { L: 2 * (opts.r ?? K.r), type: 'SITE' } },
      mag, samDoctrine: opts.samDoctrine || 'free', samPriority: null, ssmSel: 0, lastSsmFire: -999, dmgMult: side === 'enemy' ? world.difficulty?.botDmg || 1 : 1,
      salvo: opts.salvo ?? K.salvo ?? 0, interval: opts.interval ?? K.interval ?? 0, nextT: opts.delay ?? 8, salvoLeft: 0, salvoTgt: null,
      air: null, stats: null, kills: 0, hits: 0, dmgDealt: 0,
   };
   if (wing) {
      s.air = { deckT: 0, sel: 'tb', strikeT: 4 };
      for (const t of AIR_TYPES) s.air[t] = { hangar: wing[t].hangar, max: wing[t].hangar, service: [], restockT: wing[t].restock };
      world._byId.set(s.id, s);      // air.js finds the home base of a squadron through world.shipById
   }
   world.sites.push(s);
   return s;
}

export function damageSite(world, site, amount, shooter, by = 'shell') {
   if (!site || !site.alive || !(amount > 0)) return 0;
   const amt = Math.min(amount, site.hp);
   site.hp -= amt;
   site.lastHitT = world.time;
   if (shooter) { shooter.dmgDealt = (shooter.dmgDealt || 0) + amt; if (shooter.stats) { shooter.stats.dmg += amt; shooter.stats.siteDmg += amt; } }
   world.pushEvent('siteHit', { srcId: shooter ? shooter.id : null, dstId: site.id, dmg: Math.round(amt), by, pos: { x: site.x, y: site.y }, text: site.name + ' getroffen' });
   if (site.hp <= 0.5) {
      site.hp = 0; site.alive = false; site.radarOn = false; site.esmSeen = null;
      if (shooter && shooter.stats) shooter.stats.sitesDown++;
      world.addEffect('explosion', site.pos, 2.4, 70, { big: true, hit: 'site' });
      world.pushEvent('siteDestroyed', { srcId: shooter ? shooter.id : null, dstId: site.id, kind: site.kind, pos: { x: site.x, y: site.y }, text: site.name + ' zerstört' });
      world.log(null, (site.side === 'enemy' ? '🎯 Zerstört: ' : '💀 Verlust: ') + site.name, site.side === 'enemy' ? 'kill' : 'warn');
      if (world._script && world._script.onSiteDestroyed) world._script.onSiteDestroyed(world, site, shooter);
   }
   return amt;
}

// A shell (or bomb) came down at p: the first opposing site whose radius covers the point takes
// `dmg`. Returns the site or null.
export function impactOnSites(world, p, side, dmg, shooter, by) {
   for (const s of world.sites) {
      if (!s.alive || s.side === side) continue;
      const dx = s.x - p.x, dy = s.y - p.y;
      if (dx * dx + dy * dy > s.r * s.r) continue;
      damageSite(world, s, dmg, shooter, by);
      return s;
   }
   return null;
}

// The ship of the other side a battery / airfield goes for: fire-control track, in range, nearest.
function pickTarget(world, site, range, needLos) {
   let best = null, bd = range * range;
   for (const T of world.ships) {
      if (!T.alive || T.side === site.side || !T.targetable || T.depth > 0) continue;
      const d2 = (T.pos.x - site.x) ** 2 + (T.pos.y - site.y) ** 2;
      if (d2 >= bd || (needLos && world.losBlocked(site.pos, T.pos))) continue;
      bd = d2; best = T;
   }
   return best;
}

export function updateSites(world, dt) {
   for (const s of world.sites) {
      if (!s.alive) continue;
      if (s.kind === 'battery') {
         const w = s.cfg.weapons.ssm[0];
         if (!w || !(s.mag[w.type] > 0)) continue;
         if (s.salvoLeft > 0) {
            const T = world.shipById(s.salvoTgt);
            if (!T || !T.alive || !T.targetable) { s.salvoLeft = 0; continue; }
            if (launchSSM(world, s, { targetId: T.id }, w.type)) s.salvoLeft--;
            continue;
         }
         if ((s.nextT -= dt) > 0) continue;
         const c = MISSILES[w.type];
         const T = pickTarget(world, s, c.range * 0.95, c.skim);
         if (!T) { s.nextT = 1; continue; }
         s.salvoLeft = s.salvo || 1; s.salvoTgt = T.id; s.nextT = s.interval || 30;
      } else if (s.kind === 'airfield' && s.air) {
         const a = s.air, wing = s.cfg.air;
         a.deckT = Math.max(0, a.deckT - dt);
         for (const t of AIR_TYPES) {
            const h = a[t];
            for (let i = h.service.length - 1; i >= 0; i--) {
               const e = h.service[i];
               if ((e.t -= dt) <= 0) { h.hangar = Math.min(h.max, h.hangar + e.n); h.service.splice(i, 1); }
            }
         }
         if ((s.nextT -= dt) > 0) continue;
         s.nextT = 3;
         // fighters up while opposing aircraft are about, a strike on the nearest tracked ship
         if (world.squadrons.some(q => q.side !== s.side && q.n > 0) && canLaunch(world, s, 'ft')) {
            launchSquadron(world, s, 'ft', { kind: 'patrol', pos: { x: s.x, y: s.y } });
            continue;
         }
         const T = pickTarget(world, s, (wing.fuel || 170) * wing.tb.speed * 0.4, false);
         if (!T) continue;
         const type = canLaunch(world, s, 'tb') ? 'tb' : canLaunch(world, s, 'db') ? 'db' : null;
         if (type && launchSquadron(world, s, type, { kind: 'strike', targetId: T.id })) s.nextT = s.interval || 50;
      }
   }
}
