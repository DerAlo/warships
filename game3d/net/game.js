// game3d/net/game.js — one net match from the lobby's hand-over (session, see CONTRACT.md) to
// session.onEnd(). Ties transport, World (setup.js), host recorder (host.js) and client replica
// (replica.js) together. No DOM in here: main3d.js drives it in the browser, the node tests
// drive it directly.
//
// Start handshake (channel `sync`):
//   client -> host   { k:'hello', v, loadout }          repeated until the start arrives
//   host -> client   { k:'start', v, mission, difficulty, seed, classes, loadouts, names, self, teams? }
// teams (PvP only): the lobby team (1 / 2) of every slot. Slot 0's team sails as the World's side
// 'player'; a client of the other team turns its World round (setup.flipSides).
// The host waits a few seconds for every player of the session; whoever does not answer is left
// out (an allied bot keeps that place). Then both sides build the same World and the host starts
// sending snapshots.
//
// Rejoin: the lobby re-admits a former captain of the running match (CONTRACT.md) and calls the
// transport's onRejoin(oldId, newId). The returning client says hello like at the start and gets
//   host -> client   { ...start, self, rejoin: 1 }, then { k:'more' }* and { k:'resync' }
// and its ship back from the AI.
import { NET_VERSION } from './transport.js';
import { buildNetWorld, flipSides, validClass, cleanLoadout, MAX_HUMANS } from './setup.js';
import { makeHost } from './host.js';
import { makeReplica } from './replica.js';

const HELLO_EVERY = 0.3;            // s between a client's hellos
const HELLO_WAIT = 8;               // s the host waits for the players
const START_WAIT = 15;              // s a client waits for the start

export const TEXT = {
   hostLeft: 'Der Host hat das Spiel verlassen – das Gefecht wurde beendet.',
   hostLost: 'Verbindung zum Host verloren – das Gefecht wurde beendet.',
   noStart: 'Der Host hat das Gefecht nicht gestartet.',
   version: 'Der Host verwendet eine andere Spielversion.',
   refused: 'Der Host hat die Teilnahme abgelehnt.',
   notListed: 'Dieser Spieler gehört nicht zum Gefecht.',
   build: 'Das Gefecht konnte nicht aufgebaut werden.',
   quit: 'Gefecht verlassen',
   abort: 'Gefecht abgebrochen',
};

const size = (d) => d instanceof Uint8Array ? d.byteLength : JSON.stringify(d).length;

// hooks: { now() -> seconds, loadout(cls) -> career loadout of the local player or null,
//          onReady(world), onLost(text), measure: bool }
// Returns { isHost, world, ready, act(a), control(cmd), pump(), quit(), info() }.
// onLost(text): the match cannot go on (host gone, no start); the caller shows `text` and calls
// quit(). session.onEnd() is called exactly once, from quit().
export function createNetGame(session, hooks) {
   const tp = session.transport;
   const isHost = !!tp.isHost;
   const hostId = tp.hostId, selfId = tp.selfId;
   const players = (session.players || []).slice(0, MAX_HUMANS);
   const pvp = session.mode === 'pvp';
   const now = hooks.now;
   const t0 = now();
   const stat = { out: 0, in: 0, snapIn: 0, snapOut: 0, since: t0 };
   let world = null, host = null, replica = null, done = false, lostText = null, lastHello = -1;
   let startMsg = null, waitResync = 0;
   const slots = new Map();          // host: peer id -> slot index in the start message
   const hello = new Map();          // host: peer id -> loadout
   const gone = new Set();           // host: players that left before the start
   const early = [];                 // client: event batches that overtook the start message

   const send = (channel, data, to) => {
      if (done) return;
      if (hooks.measure) stat.out += size(data) * (Array.isArray(to) ? to.length : 1);
      if (channel === 'snap') stat.snapOut++;
      tp.send(channel, data, to);
   };

   function lose(text) {
      if (done || lostText) return;
      lostText = text;
      hooks.onLost?.(text);
   }

   // ---------------------------------------------------------------- host
   function hostStart() {
      const mission = session.mission, list = [players[0]], lo = [cleanLoadout(hooks.loadout?.(validClass(mission, players[0].ship)))];
      for (let i = 1; i < players.length; i++) {
         const p = players[i];
         if (!hello.has(p.id)) continue;
         list.push(p); lo.push(hello.get(p.id));
      }
      const start = {
         k: 'start', v: NET_VERSION, mission, difficulty: pvp ? 'normal' : session.difficulty, seed: session.seed >>> 0,
         classes: list.map(p => validClass(mission, p.ship)), loadouts: lo, names: list.map(p => String(p.name || '').slice(0, 32)), self: 0,
      };
      // PvP: both fleets at the same strength, whatever the lobby's difficulty said
      if (pvp) start.teams = list.map(p => (p.team | 0) || 1);
      try { world = buildNetWorld(start); } catch (e) { console.error('[net] world build failed', e); send('sync', { k: 'abort' }); lose(TEXT.build); return; }
      const humans = world.net.humans;
      const labels = pvp ? { player: start.teams[0], enemy: 3 - start.teams[0] } : null;
      host = makeHost(world, { send, pvp, labels, clients: list.slice(1).map((p, i) => ({ id: p.id, name: p.name, ship: humans[i + 1] })) });
      startMsg = start;
      for (let i = 1; i < list.length; i++) { slots.set(list[i].id, i); send('sync', { ...start, self: i }, list[i].id); }
      for (const p of players) if (p.id !== selfId && !list.includes(p)) send('sync', { k: 'refuse' }, p.id);
      hooks.onReady?.(world);
   }

   function hostSync(m, from) {
      if (!m || typeof m !== 'object' || !players.some(p => p.id === from) || from === selfId) return;
      if (m.k === 'hello') {
         if (world) {
            const c = host && host.client(from);
            if (!c) send('sync', { k: 'refuse' }, from);
            else if (c.back) {
               if (m.v !== NET_VERSION) { send('sync', { k: 'refuse', why: 'version' }, from); return; }
               send('sync', { ...startMsg, self: slots.get(from), rejoin: 1 }, from);
               host.resume(from);
            }
            return;
         }
         if (m.v !== NET_VERSION) { send('sync', { k: 'refuse', why: 'version' }, from); return; }
         if (!hello.has(from)) hello.set(from, cleanLoadout(m.loadout));
      } else if (m.k === 'bye') { hello.delete(from); gone.add(from); if (host) host.drop(from); }
   }

   // ---------------------------------------------------------------- client
   function clientStart(m) {
      if (m.v !== NET_VERSION) { lose(TEXT.version); return; }
      const teams = Array.isArray(m.teams) && m.teams.length === (m.classes || []).length ? m.teams : null;
      const flip = !!teams && teams[m.self | 0] !== teams[0];
      try {
         world = buildNetWorld({ mission: String(m.mission), difficulty: String(m.difficulty), seed: m.seed >>> 0, classes: m.classes, loadouts: m.loadouts, names: m.names, self: m.self | 0, teams });
         if (flip) flipSides(world);
      } catch (e) { console.error('[net] world build failed', e); lose(TEXT.build); return; }
      replica = makeReplica(world, {
         send: (channel, data) => send(channel, data, hostId), now, pvp: !!teams, flip,
         onLost: (why) => lose(why === 'timeout' ? TEXT.hostLost : TEXT.hostLeft),
         // back in a running match: show it once the world has caught up (own telegraph included)
         onResync: () => { if (waitResync) { waitResync = 0; hooks.onReady?.(world); } },
      });
      for (const b of early) replica.onEvt(b);
      early.length = 0;
      if (m.rejoin) waitResync = now();
      else hooks.onReady?.(world);
   }

   function clientSync(m, from) {
      if (from !== hostId || !m || typeof m !== 'object') return;
      if (hooks.measure) stat.in += size(m);
      if (replica) { replica.onSync(m); return; }
      if (m.k === 'start') { if (!world && !lostText) clientStart(m); }
      else if (m.k === 'refuse') lose(m.why === 'version' ? TEXT.version : TEXT.refused);
      else if (m.k === 'abort') lose(TEXT.hostLeft);
   }

   // ---------------------------------------------------------------- wiring
   if (isHost) {
      tp.on('sync', hostSync);
      tp.on('cmd', (d, from) => { if (host) { if (hooks.measure) stat.in += size(d); host.onCmd(d, from); } });
      tp.on('snap', () => {}); tp.on('evt', () => {});
      tp.onPeerLeave((id) => { hello.delete(id); gone.add(id); if (host) host.drop(id); });
      // a former captain is back under a new peer id (lobby check passed): the slot moves along
      tp.onRejoin?.((oldId, newId) => {
         const p = players.find(x => x.id === oldId);
         if (!p || !host) return;
         if (oldId !== newId && players.some(x => x.id === newId)) return;
         if (!host.rejoin(oldId, newId)) return;
         players[players.indexOf(p)] = { ...p, id: newId };
         gone.delete(newId);
         if (slots.has(oldId)) { const i = slots.get(oldId); slots.delete(oldId); slots.set(newId, i); }
      });
   } else {
      tp.on('sync', clientSync);
      tp.on('snap', (d, from) => {
         if (from !== hostId || !replica) return;
         if (hooks.measure) stat.in += size(d);
         stat.snapIn++;
         replica.onSnap(d);
      });
      tp.on('evt', (d, from) => {
         if (from !== hostId) return;
         if (hooks.measure) stat.in += size(d);
         if (replica) replica.onEvt(d); else if (early.length < 400) early.push(d);
      });
      tp.on('cmd', () => {});
      tp.onPeerLeave((id) => { if (id !== hostId) return; if (replica) replica.hostLost('left'); else lose(TEXT.hostLeft); });
      if (!players.some(p => p.id === selfId)) lostText = TEXT.notListed;   // reported by the first pump()
   }
   tp.onPeerJoin(() => {});

   // every frame, whether or not the simulation runs
   function pump() {
      if (done) return;
      const t = now();
      if (isHost) {
         if (!world && !lostText && (players.slice(1).every(p => hello.has(p.id) || gone.has(p.id)) || t - t0 > HELLO_WAIT)) hostStart();
      } else if (!world) {
         if (lostText === TEXT.notListed && lastHello < 0) { lastHello = t; hooks.onLost?.(lostText); }
         else if (!lostText) {
            if (t - lastHello >= HELLO_EVERY) { lastHello = t; send('sync', { k: 'hello', v: NET_VERSION, loadout: cleanLoadout(hooks.loadout?.(players.find(p => p.id === selfId).ship)) }, hostId); }
            if (t - t0 > START_WAIT) lose(TEXT.noStart);
         }
      } else if (replica) {
         if (waitResync && t - waitResync > START_WAIT) lose(TEXT.noStart);
         replica.pump();
      }
   }

   // The local player leaves the match (results screen closed, pause menu, host lost): tell the
   // others, let go of the transport channels and hand back to the lobby. Never tp.leave().
   function quit() {
      if (done) return;
      const over = world && world.phase !== 'playing';
      let res;
      if (lostText) res = { aborted: true, reason: lostText, victory: null };
      else if (over) res = { aborted: false, reason: (world.result && world.result.reason) || '', victory: world.phase === 'won' };
      else if (isHost) { send('sync', { k: 'abort' }); res = { aborted: true, reason: TEXT.abort, victory: null }; }
      else { send('sync', { k: 'bye' }, hostId); res = { aborted: true, reason: TEXT.quit, victory: null }; }
      done = true;
      if (host) host.stop();
      for (const ch of ['cmd', 'snap', 'evt', 'sync']) tp.on(ch, () => {});
      tp.onPeerLeave(() => {}); tp.onPeerJoin(() => {});
      session.onEnd?.(res);
   }

   return {
      isHost, pump, quit,
      get world() { return world; },
      get ready() { return !!world && !waitResync; },
      get done() { return done; },
      get lost() { return lostText; },
      get host() { return host; },
      get replica() { return replica; },
      act(a) { return replica ? replica.act(a) : 0; },
      control(c) { if (replica) replica.control(c); },
      resetStats() { stat.out = 0; stat.in = 0; stat.snapIn = 0; stat.snapOut = 0; stat.since = now(); },
      info() {
         const dt = Math.max(1e-3, now() - stat.since);
         return { isHost, ready: !!world, done, lost: lostText, clients: host ? host.clientIds.length : 0, seconds: dt,
            bytesOut: stat.out, bytesIn: stat.in, snapsIn: stat.snapIn, snapsOut: stat.snapOut,
            kBpsIn: stat.in / dt / 1000, kBpsOut: stat.out / dt / 1000, snapHz: (isHost ? stat.snapOut / Math.max(1, host ? host.clientIds.length : 1) : stat.snapIn) / dt,
            ...(replica ? replica.info() : null) };
      },
   };
}
