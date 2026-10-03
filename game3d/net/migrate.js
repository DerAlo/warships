// game3d/net/migrate.js — host migration: the full state a successor needs to carry on a running
// match when the host is gone (CONTRACT.md "Host migration"). The host sends it to the one client
// it names as successor about once a second (channel `mig`, latest wins). When the host leaves,
// that client turns its replica World into the authoritative one (game.js promote()).
// The replica already knows ships, smoke, score, caps, objectives, timer and weather from the
// normal stream; this message adds what a client never sees: ship internals (reloads, fires,
// floods, modules, consumables, damage statistics), bot AI state, the mission script's state,
// torpedoes, the full weather front and every ship out of the team's sight (PvP).
// No DOM in here.
import { makeStats } from '../state.js';
import { WORLD } from '../config.js';
import { localSide } from './codec.js';

export const MIG_EVERY = 60;         // sim steps between two full states (1 s)
const MAX_DEPTH = 4, MAX_LIST = 64;
const SIDES = [null, 'player', 'enemy'];
const SIDE_CODE = { player: 1, enemy: 2 };
// ship fields taken over as they are (positions, health, timers, statistics, AI, ...)
const SHIP_KEYS = ['pos', 'heading', 'speed', 'omega', 'telegraph', 'rudderCmd', 'rudder', 'heel', 'grounded', 'maxHP', 'hp', 'sinkT',
   'dmgMult', 'healPool', 'ammo', 'lockTarget', 'secTarget', 'secLostT', 'lastMainFire', 'lastTorpFire', 'lastHitT', 'lastAttackerId',
   '_smokeT', 'ramT', 'pingT', 'dmgDealt', 'dmgTaken', 'kills', 'shotsFired', 'hits', 'human', 'maxSpeedKn', 'fires', 'floods',
   'modules', 'depth', 'depthF', 'depthTarget', 'depthM', 'battery', 'batteryLock', 'asw', 'sonarSeen', 'sec', 'ai'];
const SCRIPT_SKIP = new Set(['def', 'timers', 'onSink']);
// what the newest snapshot knows better than the full state (a ship it carried)
const FRESH = new Set(['pos', 'heading', 'speed', 'omega', 'rudder', 'heel', 'hp', 'sinkT', 'depthF', 'depth', 'telegraph', 'rudderCmd', 'grounded']);

const r3 = (v) => Math.round(v * 1000) / 1000;
// about five significant digits: metres to 0.1, small values (angles, factors) to 0.001
const rn = (v) => { const a = Math.abs(v); return a >= 1000 ? Math.round(v * 10) / 10 : a >= 10 ? Math.round(v * 100) / 100 : r3(v); };

// Plain data for the wire: numbers rounded, ships as { $s: id }, Sets as { $set }, infinities as
// { $i }; class instances other than ships, functions and deep or long structures are left out.
function packer(byId) {
   const pk = (v, d) => {
      if (typeof v === 'number') return Number.isFinite(v) ? rn(v) :Number.isNaN(v) ? null : { $i: v > 0 ? 1 : -1 };
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
      if (typeof v !== 'object') return undefined;
      if (typeof v.id === 'number' && byId.get(v.id) === v) return { $s: v.id };
      if (d <= 0) return undefined;
      if (v instanceof Set) return v.size <= MAX_LIST ? { $set: [...v].map(x => pk(x, 0) ?? null) } : undefined;
      if (Array.isArray(v)) return v.length <= MAX_LIST ? v.map(x => pk(x, d - 1) ?? null) : undefined;
      const p = Object.getPrototypeOf(v);
      if (p !== Object.prototype && p !== null) return undefined;
      const o = {};
      for (const k of Object.keys(v)) { const y = pk(v[k], d - 1); if (y !== undefined) o[k] = y; }
      return o;
   };
   return pk;
}
// The way back. flip: the successor's World has the sides turned round (PvP, other team).
function unpacker(byId, flip) {
   const uk = (v) => {
      if (typeof v === 'string') return flip ? localSide(v, true) : v;
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(uk);
      if ('$s' in v) return byId.get(v.$s) || null;
      if ('$i' in v) return v.$i > 0 ? Infinity : -Infinity;
      if ('$set' in v) return new Set(Array.isArray(v.$set) ? v.$set.map(uk) : []);
      const o = {};
      for (const k of Object.keys(v)) o[k] = uk(v[k]);
      return o;
   };
   return uk;
}

export function packScript(world) {
   const S = world._script;
   if (!S) return null;
   const pk = packer(world._byId), o = {};
   for (const k of Object.keys(S)) {
      if (SCRIPT_SKIP.has(k)) continue;
      const y = pk(S[k], MAX_DEPTH);
      if (y !== undefined) o[k] = y;
   }
   return o;
}
// what counts as a change of the script's state (a phase, a flag, a ship list), not every
// running counter (domination's capTick)
export const scriptSig = (scr) => JSON.stringify(scr, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? 0 : v);

// The host's full state. o: { pl: [[peerId, slot, gone]], scr: packScript() result }
export function packWorld(world, o = {}) {
   const pk = packer(world._byId);
   const sh = [];
   for (const s of world.roster) {
      if (!s.alive && !s.sinking) { sh.push([s.id, 0, s.escaped || 0, Math.round(s.dmgDealt), s.kills, Math.round(s.dmgTaken)]); continue; }
      const row = [s.id, s.alive ? 1 : 2];
      for (const k of SHIP_KEYS) row.push(pk(s[k], MAX_DEPTH) ?? null);
      const tu = [];
      for (const t of s.turrets) tu.push(r3(t.bearing), r3(t.reload), t.alive ? 1 : 0, r3(t.disabledT || 0));
      const tl = [];
      if (s.torps) for (const l of s.torps.launchers) tl.push(r3(l.bearing), r3(l.reload));
      const co = [];
      for (const c of s.consumables) co.push(c.charges, r3(c.cd), c.active ? 1 : 0, r3(c.t));
      row.push(tu, tl, co, s.torps ? s.torps.spread : 0);
      sh.push(row);
   }
   const H = (world.net && world.net.humans) || [];
   const st = H.map((h, i) => [i, h === world.player ? world.stats : h.stats]).filter(x => x[1]);
   const S = world._script, env = world.env;
   return {
      v: 1, t: world.tick, tm: r3(world.time), nid: world._nextId, sh, st,
      scr: o.scr !== undefined ? o.scr : packScript(world),
      tn: S ? S.timers.map(x => r3(x.t)) : [],
      fr: env.front ? pk(env.front, 3) : null,
      tp: world.torpedoes.filter(t => t.alive).map(t => [t.id, t.ownerId, Math.round(t.pos.x * 10) / 10, Math.round(t.pos.y * 10) / 10, r3(t.heading),
         Math.round(t.traveled), Math.round(t.range), Math.round(t.dmg), r3(t.flood || 0), SIDE_CODE[t.side] || 0, r3(t.detect || 0)]),
      pl: o.pl || [],
   };
}

// The successor takes over. Its World is a replica brought up to date with every event and the
// newest snapshot (replica.handover); m is the newest full state from the host, a moment older.
// o: { flip, tick (the newest snapshot's), seen: Set of ships that snapshot carried (a PvP
//      replica keeps the enemies it lost sight of afloat), torps: the replica's torpedoes (run
//      distance as the host counts it), me: the local ship }
// Returns what was lost on the way, for the log: { shells, timers }.
export function restoreWorld(world, m, o) {
   const byId = world._byId, flip = !!o.flip, uk = unpacker(byId, flip), ukPlain = unpacker(byId, false);
   const dtm = Math.max(0, o.tick * (1 / 60) - (m.tm || 0));      // the full state's age
   for (const row of m.sh || []) {
      const s = byId.get(row[0]);
      if (!s) continue;
      if (row[1] === 0) {
         if (s.alive || s.sinking) { s.alive = false; s.sinking = false; s.hp = 0; if (row[2]) s.escaped = row[2]; }
         s.dmgDealt = row[3] || 0; s.kills = row[4] || 0; s.dmgTaken = row[5] || 0;
         continue;
      }
      // the replica learned of its end after the full state was made
      if (!s.alive && !s.sinking) continue;
      // the newest snapshot is younger than the full state: its positions, health and orders count
      const fresh = !!(o.seen && o.seen.has(s.id));
      if (!fresh) { s.alive = row[1] === 1; s.sinking = row[1] === 2; }
      for (let i = 0; i < SHIP_KEYS.length; i++) {
         const k = SHIP_KEYS[i], v = row[2 + i];
         if (v === null && s[k] === undefined) continue;
         if (fresh && FRESH.has(k)) continue;
         if (k === 'pos') { if (v) { s.pos.x = v.x; s.pos.y = v.y; } }
         else if (k === 'modules') { if (v) Object.assign(s.modules, v); }
         else if (k === 'fires' || k === 'floods') { s[k].length = 0; if (Array.isArray(v)) for (const x of v) s[k].push(ukPlain(x)); }
         else if (k === 'ai') {
            // what did not fit on the wire (long routes) stays as the replica had it from the start
            if (v && typeof v === 'object') s.ai = Object.assign(s.ai || {}, uk(v));
            if (s.ai._init && !(s.ai.dodged instanceof Set)) s.ai.dodged = new Set();
         }
         else if (k === 'sec') { if (s.sec && v) Object.assign(s.sec, ukPlain(v)); }
         else if (k === 'asw') { if (s.asw && v) Object.assign(s.asw, v); }
         else s[k] = ukPlain(v);
      }
      // a ship out of the team's sight ran on since the full state: dead reckoning
      if (!fresh && s.alive && dtm > 0) { s.pos.x += Math.cos(s.heading) * s.speed * dtm; s.pos.y += Math.sin(s.heading) * s.speed * dtm; }
      s.speedKn = s.speed / WORLD.KN_TO_MS;
      s.vel.x = Math.cos(s.heading) * s.speed; s.vel.y = Math.sin(s.heading) * s.speed;
      const n = SHIP_KEYS.length + 2, tu = row[n], tl = row[n + 1], co = row[n + 2];
      if (Array.isArray(tu)) for (let j = 0; j < s.turrets.length && j * 4 + 3 < tu.length; j++) {
         const t = s.turrets[j];
         t.bearing = tu[j * 4]; t.reload = tu[j * 4 + 1]; t.alive = !!tu[j * 4 + 2]; t.disabledT = tu[j * 4 + 3];
      }
      if (s.torps && Array.isArray(tl)) {
         for (let j = 0; j < s.torps.launchers.length && j * 2 + 1 < tl.length; j++) { const l = s.torps.launchers[j]; l.bearing = tl[j * 2]; l.reload = tl[j * 2 + 1]; }
         if (row[n + 3]) s.torps.spread = row[n + 3];
      }
      if (Array.isArray(co)) for (let j = 0; j < s.consumables.length && j * 4 + 3 < co.length; j++) {
         const c = s.consumables[j];
         c.charges = co[j * 4]; c.cd = co[j * 4 + 1]; c.active = !!co[j * 4 + 2]; c.t = co[j * 4 + 3];
      }
   }
   world.ships = world.roster.filter(s => s.alive || s.sinking);
   // statistics of every captain (slot order); the old host's ship gets its own record now
   const H = (world.net && world.net.humans) || [];
   for (const [i, st] of m.st || []) {
      const h = H[i];
      if (!h || !st || typeof st !== 'object') continue;
      if (h === world.player) Object.assign(world.stats, st);
      else { if (!h.stats) h.stats = makeStats(); Object.assign(h.stats, st); }
   }
   // the mission script: its state as the host had it, timers that already fired there dropped
   const S = world._script;
   let timersLost = 0;
   if (S && m.scr && typeof m.scr === 'object') {
      for (const k of Object.keys(m.scr)) if (!SCRIPT_SKIP.has(k)) S[k] = uk(m.scr[k]);
      const due = Array.isArray(m.tn) ? m.tn : [];
      S.timers = S.timers.filter(x => due.some(t => Math.abs(t - r3(x.t)) < 0.002));
      timersLost = Math.max(0, due.length - S.timers.length);
   }
   if (m.fr && typeof m.fr === 'object') world.env.front = ukPlain(m.fr);
   // torpedoes: the replica's where it has them (younger), the rest from the full state run on
   const mine = new Map((o.torps || []).filter(t => t.alive).map(t => [t.id, t]));
   const torps = [];
   for (const r of m.tp || []) {
      const owner = byId.get(r[1]);
      const side = owner ? owner.side : localSide(SIDES[r[9]] || 'enemy', flip);
      const t = { id: r[0], pos: { x: r[2], y: r[3] }, start: { x: r[2], y: r[3] }, heading: r[4], dir: r[4], speed: 0, speedKn: 0, side, owner: side, ownerId: r[1],
         dmg: r[7], flood: r[8], range: r[6], detect: r[10], traveled: r[5], age: 0, alive: true, spotted: side === 'player' };
      const tc = owner && owner.cfg.torp;
      t.speed = tc ? tc.speed : 0; t.speedKn = tc ? tc.speedKn : 0;
      const q = mine.get(t.id);
      mine.delete(t.id);
      const run = q ? q.traveled : t.traveled + t.speed * dtm;
      if (q) { t.pos.x = q.pos.x; t.pos.y = q.pos.y; }
      else { t.pos.x += Math.cos(t.heading) * t.speed * dtm; t.pos.y += Math.sin(t.heading) * t.speed * dtm; }
      t.traveled = run;
      if (t.traveled < t.range) torps.push(t);
   }
   // launched after the full state: built from what the replica knows and the launcher's data
   for (const q of mine.values()) {
      const owner = byId.get(q.ownerId), tc = owner && owner.cfg.torp;
      if (!tc) continue;
      torps.push({ id: q.id, pos: { x: q.pos.x, y: q.pos.y }, start: { x: q.pos.x, y: q.pos.y }, heading: q.heading, dir: q.heading, speed: tc.speed, speedKn: tc.speedKn,
         side: owner.side, owner: owner.side, ownerId: owner.id, dmg: tc.dmg * owner.dmgMult, flood: tc.flood, range: q.range, detect: tc.detect,
         traveled: q.traveled, age: 0, alive: true, spotted: owner.side === 'player' });
   }
   world.torpedoes = torps;
   const shells = world.shells.length;
   world.shells = [];
   if (world.depthCharges) for (const d of world.depthCharges) d.alive = false;
   world._nextId = Math.max(m.nid || 1, 1 + Math.max(0, ...world.roster.map(s => s.id))) + 1000;
   const me = o.me;
   if (me) { me.human = false; me.isPlayer = true; }
   return { shells, timers: timersLost };
}
