// gamev2/net/host.js — the authoritative side of a net game. The host's World runs as in
// singleplayer; this module hangs onto it and
//   - applies every remote captain's latest command to that captain's ship before each sim step
//   - records what happens (events, effects, shell / torpedo spawns and removals, smoke, log lines,
//     ships entering or leaving) by wrapping the World's own entry points, and sends it in batches
//   - sends a binary ship snapshot 20 times a second (codec.js) and slow state 4 times a second
//   - sends every client its own result when the battle is over.
// PvP (o.pvp): the clients of each team get their own stream. Snapshots, events and slow state
// carry only what that team can see (codec.visibleTo); the other team (World side 'enemy') gets
// the mission's texts turned round (pvp.js). Co-op: one stream for everybody, nothing filtered.
// Host migration: one client, the successor, also gets the full state once a second (`mig`,
// migrate.js) so it can carry on when this host is gone; everybody learns its id from `st.hs`.
// Nothing here touches the DOM, so the node tests drive it directly.
import { World } from '../state.js';
import { calcRewards } from '../progress3d.js';
import { makeCommand, applyCommand, applyAirControl, execAction, cleanAction } from './command.js';
import { squadById, squadVisibleTo, releaseSquadron } from '../air.js';
import { encodeShips, encodeOwn, visibleTo } from './codec.js';
import { mirrorEvent, mirrorLog, mirrorReason } from './pvp.js';
import { MIG_EVERY, packWorld, packScript, scriptSig } from './migrate.js';
import { encodeV2, encodeOwnV2, slowV2, v2EventFor } from './v2.js';

export const SNAP_EVERY = 3;        // sim steps between snapshots (20 Hz)
const STATE_EVERY = 15;             // slow state (score, caps, timer, weather): 4 Hz
const STATS_EVERY = 60;             // scoreboard + personal statistics: 1 Hz
const RETRY_TICKS = 15;             // a fire order that found no gun ready is retried this long
const BATCH_ITEMS = 60;             // items per `evt` message (keeps a message far below 16 kB)
const MAX_QUEUE = 32;
const SIDE_CODE = { player: 1, enemy: 2 };

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;
// a torpedo as the clients get it: ['T', id, ownerId, x, y, heading, tick, run?, kind?, speed?, range?, side?, dmg?]
// (run: the distance it has already run, when it is announced late; kind 1: dropped by a plane,
// 2: a homing ASW torpedo, which brings its speed, range and side: its owner may have no tubes)
function torpItem(t, tick, run) {
   const it = ['T', t.id, t.ownerId, r1(t.pos.x), r1(t.pos.y), Math.round(t.heading * 1e4) / 1e4, tick];
   const k = t.asw ? 2 : t.air ? 1 : 0;
   if (run !== undefined || k) it.push(run ? r1(run) : 0);
   if (k) it.push(k);
   if (k === 2) it.push(r3(t.speed), Math.round(t.range), SIDE_CODE[t.side] || 0, Math.round(t.dmg || 0));
   return it;
}
// a squadron a recorded item is about (PvP: shown to a team only while it sees that squadron)
const sqRef = (world, id) => (id == null ? null : squadById(world, id));
// shallow copy for the wire: numbers shortened, positions rounded to 0.1 m
function slim(x) {
   const o = {};
   for (const k in x) {
      const v = x[k];
      o[k] = typeof v === 'number' ? r3(v) : (k === 'pos' && v && typeof v === 'object') ? { x: r1(v.x), y: r1(v.y) } : v;
   }
   return o;
}

// o: { send(channel, data, to), clients: [{ id, name, ship, gone? }], pvp, labels: { player, enemy },
//      self: { id, slot }, migrate: bool, onSuccessor(id),
//      spawned: 'n' items of ships that came in earlier, adopt: bool (after a migration) }
// labels (PvP): the lobby's number of the team sailing as that World side (results screen).
// gone: a captain who is not (yet) back after a migration; the AI sails the ship.
// adopt: the torpedoes already in the World are announced again (the clients dropped them).
export function makeHost(world, o) {
   const pvp = !!o.pvp;
   const byId = world._byId;
   // a stream per team: the host's team sails as World side 'player'; co-op has only that one
   const teams = (pvp ? ['player', 'enemy'] : ['player']).map((side, i) => ({ side, bit: 1 << i, ids: [], seq: 0, objSig: '', known: { sig: {}, sites: new Set() } }));
   const teamOf = (side) => pvp && side === 'enemy' ? teams[1] : teams[0];
   const clients = new Map();
   for (const c of o.clients) {
      clients.set(c.id, { id: c.id, name: c.name || '', ship: c.ship, team: teamOf(c.ship.side), lastSeq: -1, nextAct: 0, queue: [], cmd: makeCommand(),
         aim: { x: 0, y: 0 }, retry: { x: 0, y: 0, n: 0 }, gone: !!c.gone });
   }
   let ids = [];
   const refresh = () => {
      ids = [...clients.values()].filter(c => !c.gone).map(c => c.id);
      for (const t of teams) t.ids = ids.filter(id => clients.get(id).team === t);
   };
   refresh();
   // items: what happened since the last flush; refs[i]: what PvP filtering needs to know of items[i]
   let items = [], refs = [], stepTick = world.tick + 1, muteLog = false, ended = false, stopped = false, capPrev = null;
   const liveShells = new Map(), liveTorps = new Map();
   const spawned = (o.spawned || []).slice();   // 'n' items of every ship that entered after the start (for a rejoin)
   // host migration
   const self = o.self || { id: '', slot: 0 };
   let rejected = 0;
   let succId = null, migAt = -1e9, migSig = '', migBytes = 0, migCount = 0;
   let snapBytes = 0, snapCount = 0, snapPeak = 0, slowBytes = 0;
   const buf = new ArrayBuffer(32768), dv = new DataView(buf), u8 = new Uint8Array(buf);
   const P = World.prototype;

   // ---------------------------------------------------------------- recording
   world.addShell = (s) => {
      const n = world.shells.length;
      P.addShell.call(world, s);
      if (world.shells.length === n) return;
      s.target.nat = 1;               // lets the 'splash' of its natural end be recognised below
      liveShells.set(s.id, s);
      items.push(['s', s.id, s.ownerId, s.kind === 'main' ? 0 : 1, s.ammo === 'AP' ? 1 : 0, r1(s.start.x), r1(s.start.y), r1(s.target.x), r1(s.target.y), stepTick]); refs.push(null);
   };
   world.addTorpedo = (t) => {
      P.addTorpedo.call(world, t);
      liveTorps.set(t.id, t);
      t._nv = t.visibleToOpp; t._to = 0;       // _to: a bit per team that knows of it
      t._it = torpItem(t, stepTick);
      items.push(t._it); refs.push(t);
   };
   world.addEffect = (kind, pos, life, size, extra) => {
      const e = P.addEffect.call(world, kind, pos, life, size, extra);
      // a shell falling into the sea at the end of its flight: the client makes that splash itself
      if (kind === 'splash' && pos.nat === 1) { pos.nat = 2; return e; }
      // flak bursts: many a second; the clients burst them around a squadron under fire themselves
      if (kind === 'flak') return e;
      items.push(['f', kind, r1(e.pos.x), r1(e.pos.y), r3(e.life), r3(e.size), extra ? slim(extra) : 0]); refs.push(extra ? sqRef(world, extra.sqId) : null);
      return e;
   };
   // falling bombs: ['b', x, y, sx, sy, salt, delay, heading, tick] (impact effects come as their own items)
   world.onBomb = (b, sq, delay) => {
      items.push(['b', r1(b.x), r1(b.y), r1(b.sx), r1(b.sy), Math.round(b.salt), r3(delay), Math.round(b.heading * 1e4) / 1e4, stepTick]); refs.push(sq);
   };
   world.addSmoke = (c) => {
      P.addSmoke.call(world, c);
      items.push(['k', r1(c.c.x), r1(c.c.y), c.r, c.maxR || 0, r3(c.life), c.side, c.ownerId]); refs.push(null);
   };
   world.pushEvent = (type, data) => {
      const e = P.pushEvent.call(world, type, data);
      items.push(['e', type, data ? slim(data) : 0]); refs.push(data ? sqRef(world, data.sqId) : null);
      if (type === 'cap' && data) capPrev = data.prev;      // for the log line that follows
      return e;
   };
   world.log = (who, text, type) => {
      P.log.call(world, who, text, type);
      if (!muteLog) { items.push(['l', (who && who.name ? who.name + ': ' : '') + text, type || 'info']); refs.push(capPrev); capPrev = null; }
   };
   // "fire on board" is a personal log line: the host's own stays local, a remote captain gets theirs
   world.onStatus = (ship, shooter, kind, zone) => {
      muteLog = true;
      try { P.onStatus.call(world, ship, shooter, kind, zone); } finally { muteLog = false; }
      if (ship.human) for (const c of clients.values()) if (c.ship === ship && !c.gone) o.send('sync', { k: 'own', text: kind === 'fire' ? '🔥 Feuer an Bord!' : '💧 Wassereinbruch!', type: 'warn' }, c.id);
   };
   world.spawn = (cls, side, pos, heading, opts) => {
      const s = P.spawn.call(world, cls, side, pos, heading, opts);
      const it = ['n', s.id, cls, side, r1(s.pos.x), r1(s.pos.y), Math.round(s.heading * 1e4) / 1e4,
         { name: s.name, speedKn: s.maxSpeedKn, maxHP: s.maxHP, telegraph: s.telegraph, depth: s.depthTarget, color: s.color, nation: s.nation }];
      items.push(it); refs.push(null); spawned.push(it);
      return s;
   };
   world.removeShip = (ship, reason) => {
      const was = ship.alive;
      P.removeShip.call(world, ship, reason);
      if (was) { items.push(['r', ship.id, ship.escaped]); refs.push(null); }
   };

   // ---------------------------------------------------------------- commands
   // [seq, telegraph, rudder, aimX, aimY, lock, firstActionId, actions, air?]
   // air: [sqId, wanted heading, throttle, aiming] while the captain flies a squadron (command.js)
   function onCmd(d, from) {
      const c = clients.get(from);
      if (!c || c.gone || !Array.isArray(d) || !fin(d[0])) return;
      if (d[0] > c.lastSeq) {
         c.lastSeq = d[0];
         const m = c.cmd, A = world.arena * 2;
         m.telegraph = fin(d[1]) ? d[1] : 0;
         m.rudder = fin(d[2]) ? d[2] : 0;
         if (fin(d[3]) && fin(d[4])) { c.aim.x = Math.max(-A, Math.min(A, d[3])); c.aim.y = Math.max(-A, Math.min(A, d[4])); m.aim = c.aim; }
         m.lock = fin(d[5]) ? d[5] : null;
         const a = d[8];
         m.air = Array.isArray(a) && fin(a[0]) && fin(a[1]) ? [a[0], a[1], fin(a[2]) ? a[2] : 0, a[3] ? 1 : 0] : null;
      }
      // every message repeats the actions the client has not seen acknowledged: take the new ones
      const acts = d[7];
      if (fin(d[6]) && Array.isArray(acts)) {
         for (let i = 0; i < acts.length && i < MAX_QUEUE; i++) {
            if (d[6] + i === c.nextAct + c.queue.length && c.queue.length < MAX_QUEUE && Array.isArray(acts[i])) c.queue.push(acts[i]);
         }
      }
   }

   function pre() {
      for (const c of clients.values()) {
         if (c.gone) continue;
         const s = c.ship;
         if (s.alive && c.lastSeq >= 0) { applyCommand(s, c.cmd); if (c.cmd.air) applyAirControl(s, world, c.cmd.air); }
         const rt = c.retry;
         if (rt.n > 0) { rt.n--; if (!s.alive || s.fireMain(world, rt) > 0) rt.n = 0; }
         const q = c.queue;
         for (let i = 0; i < q.length; i++) {
            // checked before it reaches the sim: a malformed or foreign order counts as taken, and does nothing
            const a = cleanAction(s, world, q[i]);
            const r = a ? execAction(s, world, a) : 0;
            c.nextAct++;
            if (!a) { rejected++; continue; }
            // the client's turrets were ready a moment before the host's are (traverse / reload lag)
            if (a[0] === 'f' && !r && s.alive && fin(a[1]) && fin(a[2])) { rt.x = a[1]; rt.y = a[2]; rt.n = RETRY_TICKS; }
         }
         q.length = 0;
      }
   }

   // ---------------------------------------------------------------- sending
   const scanShell = (s, id) => {
      if (s.alive) return;
      liveShells.delete(id);
      if (s.target.nat !== 2) { items.push(['x', id]); refs.push(null); }
   };
   const scanTorp = (t, id) => {
      if (!t.alive) { liveTorps.delete(id); items.push(['X', id]); refs.push(t); return; }
      // PvP: the other team hears of a torpedo only once it sees it, then where it is now
      // (it[7]: the distance it has run, so the client knows where it runs out)
      if (pvp && t.visibleToOpp && !(t._to & teams[t.side === 'player' ? 1 : 0].bit)) {
         items.push(torpItem(t, stepTick, t.traveled)); refs.push(t);
      }
      // seen by the other side or not (co-op: only the enemy's torpedoes matter to the clients)
      if ((pvp || t.side !== 'player') && t.visibleToOpp !== t._nv) { t._nv = t.visibleToOpp; items.push(['v', id, t.visibleToOpp ? 1 : 0]); refs.push(t); }
   };

   // ---- PvP: what a team gets to see of a recorded item (null: nothing)
   const hidden = (id, side) => { const s = id == null ? null : byId.get(id); return !!s && !visibleTo(s, side); };
   // an item about a squadron (bombs, plane losses, launches ...): only while the team sees it
   const isSq = (ref) => !!ref && ref.cfg !== undefined && ref.armed !== undefined;
   const sqSeen = (q, side) => q.side === side || squadVisibleTo(q, side);
   // the mission's objectives as a team reads them (the host's World writes them for side 'player')
   function teamObjectives(side) {
      const mis = world.mission;
      if (!mis) return null;
      if (side === 'player') return mis.objectives;
      const sc = world.score, won = world.phase === 'lost';
      return mis.objectives.map(x => {
         let text = x.text;
         if (x.id === 'kill') text = text.replace(/\(\d+\/(\d+)\)$/, (m, n) => '(' + (sc ? sc.enemy : killsOf('enemy')) + '/' + n + ')');
         else if (x.id === 'caps') text = text.replace(/\(\d+\/3\)$/, '(' + world.caps.filter(c => c.owner === 'enemy').length + '/3)');
         return { ...x, text, state: x.state === 'active' ? 'active' : won ? 'done' : 'failed' };
      });
   }
   function forTeam(it, ref, team) {
      const S = team.side;
      switch (it[0]) {
         case 's': return hidden(it[2], S) ? null : it;
         case 'T': {
            const t = ref;
            if ((t._to & team.bit) || (t.side !== S && !t.visibleToOpp)) return null;
            t._to |= team.bit;
            return it;
         }
         case 'v': return ref && (ref._to & team.bit) && ref.side !== S ? it : null;
         case 'X': return ref && (ref._to & team.bit) ? it : null;
         case 'f': return isSq(ref) ? (sqSeen(ref, S) ? it : null) : it[6] && hidden(it[6].shipId, S) ? null : it;
         case 'b': return ref && !sqSeen(ref, S) ? null : it;
         case 'l': {
            if (S === 'player') return it;
            const [text, type] = mirrorLog(it[1], it[2], ref);
            return text === it[1] ? it : ['l', text, type];
         }
         case 'e': {
            const d = it[2] || {};
            if (!isSq(ref)) { const v = v2EventFor(world, it, S); if (v !== undefined) return v; }
            if (it[1] === 'spotted' || it[1] === 'unspotted') {
               // 'Sie wurden entdeckt!' is the captain's own; 'X entdeckt' goes to the team that saw X
               const s = byId.get(d.dstId), own = /^(Sie wurden|Nicht mehr)/.test(d.text || '');
               return s && (own ? s.side === S : s.side !== S) ? it : null;
            }
            if (isSq(ref)) { if (!sqSeen(ref, S)) return null; }
            else if (hidden(d.dstId, S) || (d.dstId == null && hidden(d.srcId, S))) return null;
            if (S === 'player') return it;
            if (it[1] === 'objective' && d.objId) {
               const x = (teamObjectives(S) || []).find(q => q.id === d.objId);
               if (!x) return it;
               return ['e', 'objective', { ...d, state: x.state, text: (x.state === 'done' ? '✔ ' : x.state === 'failed' ? '✘ ' : '') + x.text }];
            }
            const [type, dd] = mirrorEvent(it[1], d);
            return dd === d ? it : ['e', type, dd];
         }
         default: return it;
      }
   }

   function flush(tick) {
      if (!items.length) return;
      const all = items, rs = refs;
      items = []; refs = [];
      for (const team of teams) {
         if (!team.ids.length) continue;
         let list = all;
         if (pvp) {
            list = [];
            for (let i = 0; i < all.length; i++) { const it = forTeam(all[i], rs[i], team); if (it) list.push(it); }
            if (!list.length) continue;
         }
         for (let i = 0; i < list.length; i += BATCH_ITEMS) {
            o.send('evt', [team.seq++, tick, list.length <= BATCH_ITEMS ? list : list.slice(i, i + BATCH_ITEMS)], team.ids);
         }
      }
   }

   function snapshot() {
      for (const team of teams) {
         if (!team.ids.length) continue;
         // ships and squadrons as before; missiles, helicopters and ASW torpedoes always as that side sees them
         const end = encodeV2(dv, encodeShips(dv, world, pvp ? team.side : null), world, team.side);
         for (const id of team.ids) {
            const c = clients.get(id);
            dv.setUint32(5, c.nextAct >>> 0, true);
            dv.setUint16(9, c.lastSeq & 0xffff, true);
            const len = encodeOwn(dv, encodeOwnV2(dv, end, c.ship, world), c.ship, world);
            if (o.measure) { snapBytes += len; snapCount++; if (len > snapPeak) snapPeak = len; }
            o.send('snap', u8.slice(0, len), c.id);
         }
      }
   }

   // kills of a side = ships of the other side sunk (the host's side: world.killCount)
   const killsOf = (side) => side === 'player' ? world.killCount : world.roster.filter(s => s.side === 'player' && !s.alive && !s.escaped).length;

   function state(tick) {
      if (!ids.length) return;
      const env = world.env, sc = world.score, f = env.front;
      const m = {
         k: 'st', t: tick, tl: world.timeLeft, kc: world.killCount,
         sc: sc ? [sc.player, sc.enemy, sc.target, sc.kind] : null,
         cp: world.caps.map(c => [SIDE_CODE[c.owner] || 0, SIDE_CODE[c.capper] || 0, r3(c.progress || 0), c.contested ? 1 : 0]),
         env: [env.weather, env.frontK, f ? f.to : null, f ? f.from : null, r3(env.visibility), r3(env.seaState), r3(env.wind), env.spotCap === Infinity ? null : Math.round(env.spotCap)],
         hs: succId,
      };
      // sonar contacts are the host team's hydrophone picture (PvP: not for the other team)
      if (world.hasSubs) {
         m.sn = [];
         for (const s of world.ships) if (s.sonarSeen) m.sn.push([s.id, r1(s.sonarSeen.x), r1(s.sonarSeen.y), r1(world.time - s.sonarSeen.t)]);
      }
      const slow = tick % STATS_EVERY === 0;
      if (slow) m.ro = world.roster.map(s => [s.id, Math.round(s.dmgDealt), s.kills]);
      const mis = world.mission;
      for (const team of teams) {
         if (!team.ids.length) continue;
         const tm = team.side === 'player' ? m : { ...m, kc: killsOf(team.side), sn: undefined };
         if (mis) {
            const obj = teamObjectives(team.side), sig = JSON.stringify(obj) + JSON.stringify(mis.zones);
            if (sig !== team.objSig) { team.objSig = sig; tm.obj = obj; tm.zn = mis.zones; }
         }
         o.send('sync', tm, team.ids);
         // the modern mode's slow state: only the parts that changed since this team got them
         const v2 = slowV2(world, team.side, team.known);
         if (v2) { if (o.measure) slowBytes += JSON.stringify(v2).length; o.send('sync', v2, team.ids); }
      }
      if (slow) for (const c of clients.values()) if (!c.gone) o.send('sync', { k: 'me', stats: c.ship.stats }, c.id);
   }

   const roster = () => world.roster.map(s => [s.id, Math.round(s.dmgDealt), s.kills, s.alive ? 1 : 0, r3(s.hp / s.maxHP), s.escaped || 0]);
   // PvP results: the winning team and a line per captain [name, team, damage, kills, afloat]
   function pvpResult() {
      if (!pvp) return null;
      const L = o.labels || { player: 1, enemy: 2 }, H = (world.net && world.net.humans) || [];
      return {
         win: world.phase === 'won' ? L.player : L.enemy,
         pl: H.map(h => { const st = h.stats || (h === world.player ? world.stats : {}); return [h.captain || h.name, L[h.side], Math.round(st.dmg || 0), st.kills || 0, h.alive ? 1 : 0]; }),
      };
   }
   function sendEnd(tick, only = null) {
      const res = world.result || { victory: world.phase === 'won', reason: '' };
      const ro = roster(), pv = pvpResult();
      if (pv && world.result) world.result.pvp = { ...pv, my: (o.labels || { player: 1 }).player };
      for (const c of clients.values()) {
         if (c.gone || (only && c !== only)) continue;
         const own = c.team.side === 'player', victory = own ? !!res.victory : !res.victory;
         const objectives = teamObjectives(c.team.side) || [];
         const rw = calcRewards({ victory, stats: c.ship.stats, rewardMult: world.difficulty.rewardMult || 1, alive: c.ship.alive, objectives });
         o.send('sync', { k: 'end', t: tick, victory, reason: own ? res.reason || '' : mirrorReason(res.reason || ''), time: world.time, xp: rw.xp, credits: rw.credits, rewards: rw,
            stats: c.ship.stats, ro, obj: objectives, ...(pv ? { pvp: { ...pv, my: (o.labels || { player: 1, enemy: 2 })[c.team.side] } } : null) }, c.id);
      }
   }

   // ---------------------------------------------------------------- rejoin
   // A captain is back, usually under a new peer id (reload, new network). The slot moves to that
   // id and waits, still steered by the AI, until the client has built its world from `start`
   // and says hello: resume().
   function rejoin(oldId, newId) {
      const c = clients.get(oldId);
      if (!c || (newId !== oldId && clients.has(newId))) return false;
      clients.delete(oldId);
      c.id = newId; c.gone = true; c.back = true;
      clients.set(newId, c);
      refresh();
      return true;
   }
   // The returning client gets what it missed as state (k:'more' with ships that entered after the
   // start, then k:'resync'), from then on everything else like the others, and its ship back.
   function resume(id) {
      const c = clients.get(id);
      if (!c || !c.back || stopped) return false;
      flush(world.tick);              // what happened so far: to the others as events, to this one as state
      c.back = false; c.gone = false;
      c.lastSeq = -1; c.nextAct = 0; c.queue.length = 0; c.cmd = makeCommand(); c.retry.n = 0;
      refresh();
      const s = c.ship, mis = world.mission, team = c.team;
      const live = spawned.filter(it => { const x = byId.get(it[1]); return x && (x.alive || x.sinking); });
      for (let i = 0; i < live.length; i += BATCH_ITEMS) o.send('sync', { k: 'more', n: live.slice(i, i + BATCH_ITEMS) }, id);
      const torps = [];
      for (const t of liveTorps.values()) {
         if (!t.alive || !t._it) continue;
         if (pvp) { if (t.side !== team.side && !t.visibleToOpp) continue; t._to |= team.bit; }
         torps.push([t._it, t.visibleToOpp ? 1 : 0]);
      }
      o.send('sync', {
         k: 'resync', b: team.seq, t: world.tick, kc: killsOf(team.side), ro: roster(),
         obj: teamObjectives(team.side), zn: mis ? mis.zones : null, tp: torps,
         sm: world.smokeClouds.map(m => [r1(m.c.x), r1(m.c.y), r1(m.r), m.maxR || 0, r3(m.life), m.side, m.ownerId]),
         me: s.stats, tg: [s.telegraph, s.rudderCmd], v2: slowV2(world, team.side, null, true),
      }, id);
      s.human = true;
      if (ended) sendEnd(world.tick, c);
      else if (world.phase === 'playing') world.message((c.name || s.name) + (s.alive ? ' ist zurück und übernimmt wieder' : ' ist zurück'), 'info');
      return true;
   }

   function post() {
      const tick = world.tick;
      liveShells.forEach(scanShell);
      liveTorps.forEach(scanTorp);
      const over = !ended && world.phase !== 'playing';
      if (over || tick % SNAP_EVERY === 0) { flush(tick); snapshot(); }
      if (tick % STATE_EVERY === 0 || over) state(tick);
      if (over) { ended = true; sendEnd(tick); }
      else if (world.phase === 'playing') migrate(tick);
      stepTick = world.tick + 1;
   }

   // after a migration: the clients dropped the old host's torpedoes, they come again with the
   // distance run (it[7]); not yet known to the other team (PvP) until it sees them
   if (o.adopt) for (const t of world.torpedoes) {
      if (!t.alive) continue;
      liveTorps.set(t.id, t);
      t._nv = false; t._to = 0;
      t._it = torpItem(t, stepTick, t.traveled);
      items.push(t._it); refs.push(t);
   }

   // ---------------------------------------------------------------- host migration
   // The successor: the first captain still in the match (slot order of the start; one on its
   // way back counts once it has its ship again). Gets the full state when it is named, once a second, and at once
   // when the mission script changes its state (a phase, a flag).
   function successor() {
      for (const c of clients.values()) if (!c.gone && !c.back) return c.id;
      return null;
   }
   function migrate(tick) {
      if (o.migrate === false) return;
      const sid = successor();
      if (sid !== succId) { succId = sid; migAt = -1e9; o.onSuccessor?.(sid); }
      if (!sid) return;
      let scr;
      if (tick - migAt < MIG_EVERY) {
         if (tick % STATE_EVERY !== 0 || !world._script) return;
         scr = packScript(world);
         if (scriptSig(scr) === migSig) return;
      }
      if (scr === undefined) scr = packScript(world);
      migSig = scriptSig(scr); migAt = tick;
      const pl = [[self.id, self.slot, 0]];
      for (const c of clients.values()) pl.push([c.id, c.ship.slot, c.gone || c.back ? 1 : 0]);
      const m = { k: 'mig', ...packWorld(world, { pl, scr }) };
      if (o.measure) { migBytes += JSON.stringify(m).length; migCount++; }
      o.send('mig', m, sid);
   }

   world.update = (dt) => {
      stepTick = world.tick + 1;
      pre();
      P.update.call(world, dt);
      post();
   };

   // A captain left (or lost the connection): the AI takes the ship back.
   function drop(id) {
      const c = clients.get(id);
      if (!c || c.gone) return false;
      c.gone = true;
      refresh();
      const s = c.ship;
      s.human = false;
      // the squadrons the captain flew go back to their pilots
      for (const q of world.squadrons) if (q.ownerId === s.id && q.human) releaseSquadron(world, q);
      if (world.phase !== 'playing') return true;
      world.message((c.name || s.name) + (s.alive ? ' hat das Gefecht verlassen – KI übernimmt' : ' hat das Gefecht verlassen'), 'warn');
      const H = world.net && world.net.humans;
      // co-op: nobody left to fight for. PvP goes on: the AI sails the ship, its captain may come back.
      if (H && !pvp && !H.some(h => h && h.alive && (h.isPlayer || h.human))) {
         world.end(false, 'Alle Spielerschiffe wurden versenkt.');
         post();                      // ended outside a sim step: tell the others now
      }
      return true;
   }

   function stop() {
      if (stopped) return;
      stopped = true;
      for (const k of ['addShell', 'addTorpedo', 'addEffect', 'addSmoke', 'pushEvent', 'log', 'onStatus', 'spawn', 'removeShip', 'update', 'onBomb']) delete world[k];
   }

   return {
      onCmd, drop, stop, rejoin, resume,
      get clientIds() { return ids; },
      get successor() { return succId; },
      migStats() { return { bytes: migBytes, count: migCount }; },
      // o.measure: snapshot bytes per client message (avg = bytes / count), the largest one, slow V2 state bytes
      snapStats() { return { bytes: snapBytes, count: snapCount, peak: snapPeak, slow: slowBytes, rejected }; },
      // this host leaves a running match: the successor gets the newest full state at once
      handoff() { if (!ended && !stopped && world.phase === 'playing') { migAt = -1e9; migrate(world.tick); } },
      get ended() { return ended; },
      client(id) { return clients.get(id) || null; },
   };
}
