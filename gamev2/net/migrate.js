// gamev2/net/migrate.js — host migration: the full state a successor needs to carry on a running
// match when the host is gone (CONTRACT.md "Host migration"). The host sends it to the one client
// it names as successor about once a second (channel `mig`, latest wins). When the host leaves,
// that client turns its replica World into the authoritative one (game.js promote()).
// The replica already knows ships, smoke, score, caps, objectives, timer and weather from the
// normal stream; this message adds what a client never sees: ship internals (reloads, fires,
// floods, modules, consumables, damage statistics), bot AI state, the mission script's state,
// torpedoes, the full weather front and every ship out of the team's sight (PvP), the carriers'
// hangars and every squadron in the air (orders, fuel, AI; PvP also the ones out of sight).
// Lost on the way: shells and bombs in the air, flak bursts.
// No DOM in here.
import { makeStats } from '../state.js';
import { WORLD } from '../config.js';
import { AIR, AIR_TYPES, releaseSquadron, sqIdFloor } from '../air.js';
import { localSide, SQ_STATES } from './codec.js';
import { packV2, restoreV2 } from './v2.js';

export const MIG_EVERY = 60;         // sim steps between two full states (1 s)
const MAX_DEPTH = 4, MAX_LIST = 64;
const SIDES = [null, 'player', 'enemy'];
const SIDE_CODE = { player: 1, enemy: 2 };
// ship fields taken over as they are (positions, health, timers, statistics, AI, ...)
const SHIP_KEYS = ['pos', 'heading', 'speed', 'omega', 'telegraph', 'rudderCmd', 'rudder', 'heel', 'grounded', 'maxHP', 'hp', 'sinkT',
   'dmgMult', 'healPool', 'ammo', 'lockTarget', 'secTarget', 'secLostT', 'lastMainFire', 'lastTorpFire', 'lastHitT', 'lastAttackerId',
   '_smokeT', 'ramT', 'pingT', 'dmgDealt', 'dmgTaken', 'kills', 'shotsFired', 'hits', 'human', 'maxSpeedKn', 'fires', 'floods',
   'modules', 'depth', 'depthF', 'depthTarget', 'depthM', 'battery', 'batteryLock', 'asw', 'sonarSeen', 'sec', 'ai', 'air', 'aaFocus',
   // V2: sensors, magazines, air-defence state, launch timers, helicopter and team
   'radarOn', 'mag', 'samDoctrine', 'samPriority', 'ssmSel', 'lastSsmFire', 'samCh', 'ciwsTgt', 'rk', 'ltt', 'heloOut', 'heloT', 'teamOut', 'teamsLeft', '_decoyN'];
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
   const sh = [], ak = { keys: [], at: new Map() };
   for (const s of world.roster) {
      if (!s.alive && !s.sinking) { sh.push([s.id, 0, s.escaped || 0, Math.round(s.dmgDealt), s.kills, Math.round(s.dmgTaken)]); continue; }
      const row = [s.id, s.alive ? 1 : 2];
      for (const k of SHIP_KEYS) row.push(k === 'air' ? packAir(s.air) : k === 'ai' ? packAi(s.ai, pk, ak) : pk(s[k], MAX_DEPTH) ?? null);
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
      v: 1, t: world.tick, tm: r3(world.time), nid: world._nextId, sh, st, ak: ak.keys,
      scr: o.scr !== undefined ? o.scr : packScript(world),
      tn: S ? S.timers.map(x => r3(x.t)) : [],
      fr: env.front ? pk(env.front, 3) : null,
      tp: world.torpedoes.filter(t => t.alive).map(t => [t.id, t.ownerId, Math.round(t.pos.x * 10) / 10, Math.round(t.pos.y * 10) / 10, r3(t.heading),
         Math.round(t.traveled), Math.round(t.range), Math.round(t.dmg), r3(t.flood || 0), SIDE_CODE[t.side] || 0, r3(t.detect || 0), t.air ? 1 : 0]),
      sq: world.squadrons.filter(q => q.n > 0 && q.state !== 'land').map(packSquad),
      pl: o.pl || [],
      v2: packV2(world),
   };
}

// A ship's AI state: the values in the order of the key table `ak` (shared by all ships, sent
// once), AI_NONE where a ship has no such key. Most of an AI object's bytes were its key names.
const AI_NONE = '~';
function packAi(ai, pk, ak) {
   if (!ai || typeof ai !== 'object') return null;
   const row = [];
   for (const k of Object.keys(ai)) {
      const y = pk(ai[k], MAX_DEPTH - 1);
      if (y === undefined) continue;
      let i = ak.at.get(k);
      if (i === undefined) { i = ak.keys.length; ak.keys.push(k); ak.at.set(k, i); }
      while (row.length < i) row.push(AI_NONE);
      row[i] = y;
   }
   for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = AI_NONE;
   return row;
}
function unpackAi(v, keys) {
   if (!Array.isArray(v)) return v && typeof v === 'object' ? v : {};
   const o = {};
   for (let i = 0; i < v.length && i < keys.length; i++) if (v[i] !== AI_NONE && typeof keys[i] === 'string') o[keys[i]] = v[i];
   return o;
}

// a squadron: [id, ownerId, type, state, n, n0, armed, hp, x, y, alt, altT, heading, want, speed,
// t, fuel, ammo, boost, patrolT, ditchT, human, order, center, foeId, ai]; distances in whole
// metres. order: 0 | [kind (0 strike, 1 patrol), targetId, x, y, scout]; center: 0 | [x, y];
// foeId: 0 | id; ai: 0 (as launched) | [t, phase, errL, errP.x, errP.y, outT, dropR] (ai_air.js)
const ri = Math.round, r2 = (v) => Math.round(v * 100) / 100;
function packSquad(q) {
   const a = q.ai, d = q.order;
   const ai = !a.t && !a.phase && !a.errL && !a.errP.x && !a.errP.y && !a.outT && a.dropR == null ? 0
      : [r2(a.t), a.phase, r3(a.errL), ri(a.errP.x), ri(a.errP.y), r2(a.outT || 0), a.dropR != null ? ri(a.dropR) : null];
   return [q.id, q.ownerId, AIR_TYPES.indexOf(q.type), SQ_STATES.indexOf(q.state), q.n, q.n0, q.armed, ri(q.hp),
      ri(q.pos.x), ri(q.pos.y), ri(q.alt), ri(q.altT), r3(q.heading), r3(q.want), ri(q.speed),
      r2(q.t), r2(q.fuel), r2(q.ammo), r2(q.boost), r2(q.patrolT), r2(q.ditchT), q.human ? 1 : 0,
      d ? [d.kind === 'patrol' ? 1 : 0, d.targetId ?? null, d.pos ? ri(d.pos.x) : null, d.pos ? ri(d.pos.y) : null, d.scout ? 1 : 0] : 0,
      q.center ? [ri(q.center.x), ri(q.center.y)] : 0, q.foeId || 0, ai];
}
// a carrier's hangars: [deckT, strikeT, sel, per type tb, db, ft: hangar, max, restockT, [n, t, ...] in service]
function packAir(a) {
   if (!a) return null;
   const r = [rn(a.deckT), rn(a.strikeT || 0), AIR_TYPES.indexOf(a.sel)];
   for (const t of AIR_TYPES) { const h = a[t]; r.push(h.hangar, h.max, rn(h.restockT), h.service.flatMap(e => [e.n, rn(e.t)])); }
   return r;
}

// The squadrons as the successor runs them: from the full state, moved to where the replica saw
// them last (younger); flights launched after the full state from the replica alone (orders
// restarted). Flights of a captain who is gone go back to their pilots.
function restoreSquads(world, m, o, dtm) {
   const byId = world._byId, seen = new Map();
   for (const q of world.squadrons) seen.set(q.id, q);
   const out = [];
   let maxId = 0, lost = 0;
   for (const r of Array.isArray(m.sq) ? m.sq : []) {
      if (!Array.isArray(r) || r.length < 26) { lost++; continue; }
      const owner = byId.get(r[1]), type = AIR_TYPES[r[2]];
      const cfg = owner && owner.cfg.air && owner.cfg.air[type];
      if (!cfg) { lost++; continue; }
      const v = seen.get(r[0]);
      seen.delete(r[0]);
      const h = r[12];
      const q = {
         id: r[0], side: owner.side, ownerId: owner.id, type, cfg, n: r[4], n0: r[5], armed: r[6], hp: r[7],
         pos: { x: r[8] + Math.cos(h) * r[14] * dtm, y: r[9] + Math.sin(h) * r[14] * dtm }, alt: r[10], altT: r[11],
         prev: { x: 0, y: 0, alt: 0, h: 0 }, heading: h, want: r[13], speed: r[14], throttle: 0, boost: r[18],
         state: SQ_STATES[r[3]] || 'fly', t: r[15], fuel: r[16] - dtm, order: null, human: !!r[21],
         aiming: false, aimT: 0, aimPt: { x: 0, y: 0 }, spread: AIR.tbSpread[0], ellipse: AIR.dbEllipse[0],
         ammo: r[17], foeId: r[24] || null, patrolT: r[19], center: Array.isArray(r[23]) ? { x: r[23][0], y: r[23][1] } : null,
         visible: owner.side === 'player', visE: owner.side === 'enemy', seenT: 0, flakT: 0, underFire: 0, ditchT: r[20],
         ai: unpackSqAi(r[25]),
      };
      const d = r[22];
      if (Array.isArray(d)) {
         q.order = { kind: d[0] === 1 ? 'patrol' : 'strike', targetId: typeof d[1] === 'number' ? d[1] : null,
            pos: typeof d[2] === 'number' && typeof d[3] === 'number' ? { x: d[2], y: d[3] } : null };
         if (d[4]) q.order.scout = true;
         if (q.order.kind === 'patrol') { delete q.order.targetId; if (q.center) q.order.pos = q.center; }
      }
      // the replica saw it later: its position, heading, planes and state count
      if (v) {
         q.pos.x = v.pos.x; q.pos.y = v.pos.y; q.alt = v.alt; q.heading = v.heading; q.speed = v.speed;
         q.n = Math.min(q.n, v.n); q.armed = Math.min(q.armed, v.armed);
         if (v.state === 'return' && q.state !== 'return') q.state = 'return';
      }
      out.push(q);
   }
   // launched after the full state: the replica's copy, handed back to its pilots below
   for (const v of seen.values()) {
      if (v.n <= 0 || !byId.get(v.ownerId)) continue;
      v.human = v.state !== 'return'; v.order = null; v.visible = v.side === 'player'; v.visE = v.side === 'enemy';
      v.net = undefined;
      out.push(v);
   }
   for (const q of out) {
      q.prev.x = q.pos.x; q.prev.y = q.pos.y; q.prev.alt = q.alt; q.prev.h = q.heading;
      if (q.id > maxId) maxId = q.id;
   }
   world.squadrons = out;
   world.hasAir = world.hasAir || out.length > 0;
   for (const b of world.bombs) b.alive = false;
   sqIdFloor(maxId);
   // a flight whose captain is not at the controls any more (the old host, a launch the full state
   // missed) flies on under its pilots: bombers look for a target, fighters patrol
   const at = (s) => !!s && (s === o.me || s.human);
   for (const q of out) if (q.human && !at(byId.get(q.ownerId))) releaseSquadron(world, q);
   return lost;
}

// The successor takes over. Its World is a replica brought up to date with every event and the
// newest snapshot (replica.handover); m is the newest full state from the host, a moment older.
// o: { flip, tick (the newest snapshot's), seen: Set of ships that snapshot carried (a PvP
//      replica keeps the enemies it lost sight of afloat), torps: the replica's torpedoes (run
//      distance as the host counts it), me: the local ship }
// Returns what was lost on the way, for the log: { shells, timers, squads }.
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
            if (v && typeof v === 'object') s.ai = Object.assign(s.ai || {}, uk(unpackAi(v, Array.isArray(m.ak) ? m.ak : [])));
            if (s.ai._init && !(s.ai.dodged instanceof Set)) s.ai.dodged = new Set();
         }
         else if (k === 'sec') { if (s.sec && v) Object.assign(s.sec, ukPlain(v)); }
         else if (k === 'asw') { if (s.asw && v) Object.assign(s.asw, v); }
         else if (k === 'air') { if (s.air && v && typeof v === 'object') restoreAir(s.air, v); }
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
      const tc = torpCfg(owner, !!r[11]);
      t.speed = tc ? tc.speed : 0; t.speedKn = tc ? tc.speedKn : 0;
      if (r[11]) { t.air = true; t.arm = AIR.tbArm; }
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
      const owner = byId.get(q.ownerId), tc = torpCfg(owner, !!q.air);
      if (!tc || q.asw) continue;
      const t = { id: q.id, pos: { x: q.pos.x, y: q.pos.y }, start: { x: q.pos.x, y: q.pos.y }, heading: q.heading, dir: q.heading, speed: tc.speed, speedKn: tc.speedKn,
         side: owner.side, owner: owner.side, ownerId: owner.id, dmg: tc.dmg * owner.dmgMult, flood: tc.flood, range: q.range, detect: tc.detect,
         traveled: q.traveled, age: 0, alive: true, spotted: owner.side === 'player' };
      if (q.air) { t.air = true; t.arm = AIR.tbArm; }
      torps.push(t);
   }
   world.torpedoes = torps;
   const squads = restoreSquads(world, m, o, dtm);
   // missiles, helicopters, teams, task points, blasts, decoys, the land sites' state (v2.js)
   restoreV2(world, m.v2, flip, dtm, o.mids, o.late ? { tick: o.tick, list: o.late } : null);
   const shells = world.shells.length;
   world.shells = [];
   if (world.depthCharges) for (const d of world.depthCharges) d.alive = false;
   world._nextId = Math.max(m.nid || 1, 1 + Math.max(0, ...world.roster.map(s => s.id)), 1 + Math.max(0, ...world.missiles.map(x => x.id))) + 1000;
   const me = o.me;
   if (me) { me.human = false; me.isPlayer = true; }
   return { shells, timers: timersLost, squads };
}

function unpackSqAi(a) {
   const ai = { t: 0, phase: 0, errL: 0, errP: { x: 0, y: 0 } };
   if (!Array.isArray(a)) return ai;
   const n = (i) => typeof a[i] === 'number' ? a[i] : 0;
   ai.t = n(0); ai.phase = n(1); ai.errL = n(2); ai.errP.x = n(3); ai.errP.y = n(4); ai.outT = n(5);
   if (typeof a[6] === 'number') ai.dropR = a[6];
   return ai;
}

// a ship's torpedoes, or (air) its torpedo bombers' (air.dropWeapons)
function torpCfg(owner, air) {
   if (!owner) return null;
   if (!air) return owner.cfg.torp || null;
   const w = owner.cfg.air?.tb?.weapon;
   return w ? { speed: w.speedKn * 2.6, speedKn: w.speedKn, range: w.range, dmg: w.dmg, flood: w.flood, detect: AIR.tbDetect } : null;
}

// a carrier's hangars, deck and restock timers (packAir)
function restoreAir(a, v) {
   if (!Array.isArray(v) || v.length < 15) return;
   const num = (x, d) => typeof x === 'number' && Number.isFinite(x) ? x : d;
   a.deckT = num(v[0], a.deckT); a.strikeT = num(v[1], a.strikeT);
   if (AIR_TYPES[v[2]]) a.sel = AIR_TYPES[v[2]];
   AIR_TYPES.forEach((t, i) => {
      const h = a[t], o = 3 + i * 4, sv = v[o + 3];
      h.hangar = num(v[o], h.hangar); h.max = num(v[o + 1], h.max); h.restockT = num(v[o + 2], h.restockT);
      if (Array.isArray(sv)) { h.service = []; for (let k = 0; k + 1 < sv.length; k += 2) if (typeof sv[k] === 'number') h.service.push({ n: sv[k], t: num(sv[k + 1], 0) }); }
   });
}
