// A V2 net room on a virtual clock over the in-memory hub (no sockets, nothing leaves the process):
// index 0 is the host. Used by tests/v2.net*.test.mjs.
import { makeMemoryHub } from '../gamev2/net/transport.js';
import { createNetGame } from '../gamev2/net/game.js';

export const DT = 1 / 60;
export function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// o: { names, ships, teams (PvP: lobby team per player), mode, mission, seed, latency, jitter, tap(i, channel, data) }
export function makeRoom(o = {}) {
   const names = o.names || ['host', 'anna', 'bert'];
   const ships = o.ships || ['Sachsen', 'Burke', 'Braunschweig'];
   const mode = o.mode || 'coop', mission = o.mission || 'standard', seed = o.seed ?? 20261005;
   let nowMs = 0, n = 0;
   const q = [];
   const hub = makeMemoryHub({
      latency: o.latency ?? 40, jitter: o.jitter ?? 25, rand: rng(7), now: () => nowMs,
      schedule: (fn, ms) => { q.push({ at: nowMs + ms, n: n++, fn }); },
   });
   const onRejoin = [];
   // every message a peer receives, by channel: counted (bytes of the binary ones) and shown to o.tap
   const stat = names.map(() => ({ snap: 0, snapBytes: 0, snapPeak: 0, evt: 0, sync: 0 }));
   const join = (id, i) => {
      const t = hub.join(id);
      t.onRejoin = (fn) => { onRejoin[i] = fn; };
      const on = t.on.bind(t);
      t.on = (ch, fn) => on(ch, (d, from) => {
         const st = stat[i];
         if (ch === 'snap' && d instanceof Uint8Array) { st.snap++; st.snapBytes += d.byteLength; if (d.byteLength > st.snapPeak) st.snapPeak = d.byteLength; }
         else if (ch === 'evt') st.evt++;
         else if (ch === 'sync') st.sync++;
         if (o.tap) o.tap(i, ch, d, from);
         fn(d, from);
      });
      return t;
   };
   const tps = names.map(join);
   const players = names.map((id, i) => ({ id, name: 'Kapitän ' + id, ship: ships[i], ...(o.teams ? { team: o.teams[i] } : null) }));
   const ends = names.map(() => []), lost = names.map(() => []);
   const make = (transport, i, pl, extra) => createNetGame(
      { transport, mode, mission, difficulty: 'normal', seed, players: pl, onEnd: (r) => ends[i].push(r) },
      { now: () => nowMs / 1000, loadout: () => null, measure: true, onLost: (t) => lost[i].push(t), ...extra });
   const games = tps.map((t, i) => make(t, i, players));
   const room = {
      hub, tps, games, ends, lost, players, stat, frozen: new Set(), each: null,
      get now() { return nowMs / 1000; },
      step() {
         nowMs += 1000 * DT;
         for (;;) {
            let bi = -1;
            for (let i = 0; i < q.length; i++) if (q[i].at <= nowMs && (bi < 0 || q[i].at < q[bi].at || (q[i].at === q[bi].at && q[i].n < q[bi].n))) bi = i;
            if (bi < 0) break;
            q.splice(bi, 1)[0].fn();
         }
         for (let i = 0; i < games.length; i++) {
            const g = games[i];
            if (g.done || room.frozen.has(i)) continue;
            g.pump();
            if (g.world && !g.lost) g.world.update(DT);
         }
         if (room.each) room.each();
      },
      run(seconds, until) { const N = Math.round(seconds * 60); for (let i = 0; i < N; i++) { room.step(); if (until && until()) return true; } return !until; },
      // player i comes back under a new peer id with a fresh page; h: the peer that runs the match now
      rejoin(i, newId, h = 0) {
         const old = room.players[i].id;
         const pl = room.players.map(p => p.id === old ? { ...p, id: newId } : p);
         const transport = join(newId, i);
         transport.hostId = room.players[h].id;
         onRejoin[h](old, newId);
         const g = make(transport, i, pl, { onReady: () => { g.readyCalls = (g.readyCalls || 0) + 1; } });
         games[i] = g; tps[i] = transport; room.players[i] = pl[i];
         return g;
      },
   };
   return room;
}
export const ready = (room) => room.run(12, () => room.games.every(g => g.ready));
export const shipOf = (world, id) => world._byId.get(id);
