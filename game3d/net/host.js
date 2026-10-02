// game3d/net/host.js — the authoritative side of a net game. The host's World runs as in
// singleplayer; this module hangs onto it and
//   - applies every remote captain's latest command to that captain's ship before each sim step
//   - records what happens (events, effects, shell / torpedo spawns and removals, smoke, log lines,
//     ships entering or leaving) by wrapping the World's own entry points, and sends it in batches
//   - sends a binary ship snapshot 20 times a second (codec.js) and slow state 4 times a second
//   - sends every client its own result when the battle is over.
// Nothing here touches the DOM, so the node tests drive it directly.
import { World } from '../state.js';
import { calcRewards } from '../progress3d.js';
import { makeCommand, applyCommand, execAction } from './command.js';
import { encodeShips, encodeOwn } from './codec.js';

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
// shallow copy for the wire: numbers shortened, positions rounded to 0.1 m
function slim(x) {
   const o = {};
   for (const k in x) {
      const v = x[k];
      o[k] = typeof v === 'number' ? r3(v) : (k === 'pos' && v && typeof v === 'object') ? { x: r1(v.x), y: r1(v.y) } : v;
   }
   return o;
}

// o: { send(channel, data, to), clients: [{ id, name, ship }] }
export function makeHost(world, o) {
   const clients = new Map();
   for (const c of o.clients) {
      clients.set(c.id, { id: c.id, name: c.name || '', ship: c.ship, lastSeq: -1, nextAct: 0, queue: [], cmd: makeCommand(),
         aim: { x: 0, y: 0 }, retry: { x: 0, y: 0, n: 0 }, gone: false });
   }
   let ids = [...clients.keys()];
   let items = [], batchSeq = 0, stepTick = world.tick + 1, muteLog = false, ended = false, objSig = '', stopped = false;
   const liveShells = new Map(), liveTorps = new Map();
   const buf = new ArrayBuffer(8192), dv = new DataView(buf), u8 = new Uint8Array(buf);
   const P = World.prototype;

   // ---------------------------------------------------------------- recording
   world.addShell = (s) => {
      const n = world.shells.length;
      P.addShell.call(world, s);
      if (world.shells.length === n) return;
      s.target.nat = 1;               // lets the 'splash' of its natural end be recognised below
      liveShells.set(s.id, s);
      items.push(['s', s.id, s.ownerId, s.kind === 'main' ? 0 : 1, s.ammo === 'AP' ? 1 : 0, r1(s.start.x), r1(s.start.y), r1(s.target.x), r1(s.target.y), stepTick]);
   };
   world.addTorpedo = (t) => {
      P.addTorpedo.call(world, t);
      liveTorps.set(t.id, t);
      t._ns = t.spotted;
      items.push(['T', t.id, t.ownerId, r1(t.pos.x), r1(t.pos.y), Math.round(t.heading * 1e4) / 1e4, stepTick]);
   };
   world.addEffect = (kind, pos, life, size, extra) => {
      const e = P.addEffect.call(world, kind, pos, life, size, extra);
      // a shell falling into the sea at the end of its flight: the client makes that splash itself
      if (kind === 'splash' && pos.nat === 1) { pos.nat = 2; return e; }
      items.push(['f', kind, r1(e.pos.x), r1(e.pos.y), r3(e.life), r3(e.size), extra ? slim(extra) : 0]);
      return e;
   };
   world.addSmoke = (c) => {
      P.addSmoke.call(world, c);
      items.push(['k', r1(c.c.x), r1(c.c.y), c.r, c.maxR || 0, r3(c.life), c.side, c.ownerId]);
   };
   world.pushEvent = (type, data) => {
      const e = P.pushEvent.call(world, type, data);
      items.push(['e', type, data ? slim(data) : 0]);
      return e;
   };
   world.log = (who, text, type) => {
      P.log.call(world, who, text, type);
      if (!muteLog) items.push(['l', (who && who.name ? who.name + ': ' : '') + text, type || 'info']);
   };
   // "fire on board" is a personal log line: the host's own stays local, a remote captain gets theirs
   world.onStatus = (ship, shooter, kind, zone) => {
      muteLog = true;
      try { P.onStatus.call(world, ship, shooter, kind, zone); } finally { muteLog = false; }
      if (ship.human) for (const c of clients.values()) if (c.ship === ship && !c.gone) o.send('sync', { k: 'own', text: kind === 'fire' ? '🔥 Feuer an Bord!' : '💧 Wassereinbruch!', type: 'warn' }, c.id);
   };
   world.spawn = (cls, side, pos, heading, opts) => {
      const s = P.spawn.call(world, cls, side, pos, heading, opts);
      items.push(['n', s.id, cls, side, r1(s.pos.x), r1(s.pos.y), Math.round(s.heading * 1e4) / 1e4,
         { name: s.name, speedKn: s.maxSpeedKn, maxHP: s.maxHP, telegraph: s.telegraph, depth: s.depthTarget, color: s.color, nation: s.nation }]);
      return s;
   };
   world.removeShip = (ship, reason) => {
      const was = ship.alive;
      P.removeShip.call(world, ship, reason);
      if (was) items.push(['r', ship.id, ship.escaped]);
   };

   // ---------------------------------------------------------------- commands
   // [seq, telegraph, rudder, aimX, aimY, lock, firstActionId, actions]
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
         if (s.alive && c.lastSeq >= 0) applyCommand(s, c.cmd);
         const rt = c.retry;
         if (rt.n > 0) { rt.n--; if (!s.alive || s.fireMain(world, rt) > 0) rt.n = 0; }
         const q = c.queue;
         for (let i = 0; i < q.length; i++) {
            const a = q[i];
            const r = execAction(s, world, a);
            c.nextAct++;
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
      if (s.target.nat !== 2) items.push(['x', id]);
   };
   const scanTorp = (t, id) => {
      if (!t.alive) { liveTorps.delete(id); items.push(['X', id]); }
      else if (t.spotted !== t._ns) { t._ns = t.spotted; items.push(['v', id, t.spotted ? 1 : 0]); }
   };

   function flush(tick) {
      if (!items.length) return;
      const all = items;
      items = [];
      if (!ids.length) return;
      for (let i = 0; i < all.length; i += BATCH_ITEMS) {
         o.send('evt', [batchSeq++, tick, all.length <= BATCH_ITEMS ? all : all.slice(i, i + BATCH_ITEMS)], ids);
      }
   }

   function snapshot() {
      if (!ids.length) return;
      const end = encodeShips(dv, world);
      for (const c of clients.values()) {
         if (c.gone) continue;
         dv.setUint32(5, c.nextAct >>> 0, true);
         dv.setUint16(9, c.lastSeq & 0xffff, true);
         o.send('snap', u8.slice(0, encodeOwn(dv, end, c.ship, world)), c.id);
      }
   }

   function state(tick) {
      if (!ids.length) return;
      const env = world.env, sc = world.score, f = env.front;
      const m = {
         k: 'st', t: tick, tl: world.timeLeft, kc: world.killCount,
         sc: sc ? [sc.player, sc.enemy, sc.target, sc.kind] : null,
         cp: world.caps.map(c => [SIDE_CODE[c.owner] || 0, SIDE_CODE[c.capper] || 0, r3(c.progress || 0), c.contested ? 1 : 0]),
         env: [env.weather, env.frontK, f ? f.to : null, f ? f.from : null, r3(env.visibility), r3(env.seaState), r3(env.wind), env.spotCap === Infinity ? null : Math.round(env.spotCap)],
      };
      const mis = world.mission;
      if (mis) {
         const sig = JSON.stringify(mis.objectives) + JSON.stringify(mis.zones);
         if (sig !== objSig) { objSig = sig; m.obj = mis.objectives; m.zn = mis.zones; }
      }
      if (world.hasSubs) {
         m.sn = [];
         for (const s of world.ships) if (s.sonarSeen) m.sn.push([s.id, r1(s.sonarSeen.x), r1(s.sonarSeen.y), r1(world.time - s.sonarSeen.t)]);
      }
      const slow = tick % STATS_EVERY === 0;
      if (slow) m.ro = world.roster.map(s => [s.id, Math.round(s.dmgDealt), s.kills]);
      o.send('sync', m, ids);
      if (slow) for (const c of clients.values()) if (!c.gone) o.send('sync', { k: 'me', stats: c.ship.stats }, c.id);
   }

   function sendEnd(tick) {
      const res = world.result || { victory: world.phase === 'won', reason: '' };
      const objectives = world.mission ? world.mission.objectives : [];
      const ro = world.roster.map(s => [s.id, Math.round(s.dmgDealt), s.kills, s.alive ? 1 : 0, r3(s.hp / s.maxHP), s.escaped || 0]);
      for (const c of clients.values()) {
         if (c.gone) continue;
         const rw = calcRewards({ victory: res.victory, stats: c.ship.stats, rewardMult: world.difficulty.rewardMult || 1, alive: c.ship.alive, objectives });
         o.send('sync', { k: 'end', t: tick, victory: !!res.victory, reason: res.reason || '', time: world.time, xp: rw.xp, credits: rw.credits, rewards: rw,
            stats: c.ship.stats, ro, obj: objectives }, c.id);
      }
   }

   function post() {
      const tick = world.tick;
      liveShells.forEach(scanShell);
      liveTorps.forEach(scanTorp);
      const over = !ended && world.phase !== 'playing';
      if (over || tick % SNAP_EVERY === 0) { flush(tick); snapshot(); }
      if (tick % STATE_EVERY === 0 || over) state(tick);
      if (over) { ended = true; sendEnd(tick); }
      stepTick = world.tick + 1;
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
      ids = ids.filter(x => x !== id);
      const s = c.ship;
      s.human = false;
      if (world.phase !== 'playing') return true;
      world.message((c.name || s.name) + (s.alive ? ' hat das Gefecht verlassen – KI übernimmt' : ' hat das Gefecht verlassen'), 'warn');
      const H = world.net && world.net.humans;
      if (H && !H.some(h => h && h.alive && (h.isPlayer || h.human))) {
         world.end(false, 'Alle Spielerschiffe wurden versenkt.');
         post();                      // ended outside a sim step: tell the others now
      }
      return true;
   }

   function stop() {
      if (stopped) return;
      stopped = true;
      for (const k of ['addShell', 'addTorpedo', 'addEffect', 'addSmoke', 'pushEvent', 'log', 'onStatus', 'spawn', 'removeShip', 'update']) delete world[k];
   }

   return {
      onCmd, drop, stop,
      get clientIds() { return ids; },
      get ended() { return ended; },
      client(id) { return clients.get(id) || null; },
   };
}
