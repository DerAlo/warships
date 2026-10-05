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
//
// Host migration (CONTRACT.md): the host names a successor (`st.hs`) and sends it the full state
// once a second (`mig`). When the host is gone (left, connection lost) the successor turns its
// replica World into the authoritative one (promote) and announces itself to everybody:
//   successor -> all   { k:'host', id, t, team }
// The others point their replica at it (adopt). A host leaving a running match on purpose says
//   host -> all        { k:'left' }
// instead of `abort` when it has a successor.
import { NET_VERSION } from './transport.js';
import { buildNetWorld, flipSides, validClass, cleanLoadout, MAX_HUMANS } from './setup.js';
import { makeHost } from './host.js';
import { makeReplica } from './replica.js';
import { restoreWorld } from './migrate.js';
import { releaseSquadron } from '../air.js';

const HELLO_EVERY = 0.3;            // s between a client's hellos
const HELLO_WAIT = 8;               // s the host waits for the players
const START_WAIT = 15;              // s a client waits for the start
const MIGRATE_WAIT = 8;             // s a client waits for the successor once the host is gone
const PROMOTE_GRACE = 0.25;         // s the successor waits for a last full state of a leaving host
const ANNOUNCE_QUIET = 2;           // s without a snapshot after which a client believes a new host
const CUT_OFF_MS = 4000;            // ms the successor heard none of the others: it is the one cut off

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
   waitHost: 'Verbindung zum Gastgeber verloren – ein anderer Spieler übernimmt …',
   newHost: (name) => 'Gastgeber gewechselt – ' + (name || 'ein anderer Spieler') + ' führt das Gefecht weiter.',
   selfHost: 'Gastgeber gewechselt – du führst das Gefecht jetzt weiter.',
   replaced: 'Ein anderer Spieler hat das Gefecht übernommen.',
};

const size = (d) => d instanceof Uint8Array ? d.byteLength : JSON.stringify(d).length;

// hooks: { now() -> seconds, loadout(cls) -> career loadout of the local player or null,
//          onReady(world), onLost(text), onNotice(text), measure: bool }
// Returns { isHost, world, ready, act(a), control(cmd), pump(), quit(), info() }.
// onLost(text): the match cannot go on (host gone, no start); the caller shows `text` and calls
// quit(). session.onEnd() is called exactly once, from quit(). onNotice(text): a short notice
// (the host changed). isHost turns true when this client takes over as the host.
// The lobby hears of a migration through session.onSuccessor(id) (host: the successor changed)
// and session.onHost(id) (everybody: id is the host now).
export function createNetGame(session, hooks) {
   const tp = session.transport;
   let isHost = !!tp.isHost;
   let hostId = tp.hostId;
   const selfId = tp.selfId;
   const players = (session.players || []).slice(0, MAX_HUMANS);
   const pvp = session.mode === 'pvp';
   const now = hooks.now;
   const t0 = now();
   const stat = { out: 0, in: 0, snapIn: 0, snapOut: 0, since: t0 };
   let world = null, host = null, replica = null, done = false, lostText = null, lastHello = -1;
   let startMsg = null, waitResync = 0, migrated = null;
   const slots = new Map();          // host: peer id -> slot index in the start message
   const hello = new Map();          // host: peer id -> loadout
   const gone = new Set();           // host: players that left before the start
   const early = [];                 // client: event batches that overtook the start message
   // host migration (client side)
   let succ = null;                  // the successor the host named
   let mig = null;                   // successor: the newest full state from the host
   let orphan = 0;                   // when the host was lost (waiting for the successor)
   let startIn = null, myTeam = 0, mySlot = 0, flipNow = false;
   const pend = [];                  // messages of the successor that overtook its announcement
   let heir = null;                  // an announcement that came while the host still sent: { id, m, at }
   let orphanWhy = '';               // how the host was lost ('left' | 'timeout')
   const nameOf = (id) => players.find(p => p.id === id)?.name || '';

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
      host = makeHost(world, { send, pvp, labels, clients: list.slice(1).map((p, i) => ({ id: p.id, name: p.name, ship: humans[i + 1] })),
         self: { id: selfId, slot: 0 }, measure: hooks.measure, onSuccessor: (id) => session.onSuccessor?.(id) });
      startMsg = start;
      for (let i = 1; i < list.length; i++) { slots.set(list[i].id, i); send('sync', { ...start, self: i }, list[i].id); }
      for (const p of players) if (p.id !== selfId && !list.includes(p)) send('sync', { k: 'refuse' }, p.id);
      hooks.onReady?.(world);
   }

   function hostSync(m, from) {
      if (!m || typeof m !== 'object' || !players.some(p => p.id === from) || from === selfId) return;
      // somebody else took over (this host was cut off from the others for a while)
      if (m.k === 'host') { if (world && !lostText) lose(TEXT.replaced); return; }
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
      // the World is built the way slot 0 saw it; the wire speaks the current host's sides (m.ht:
      // its lobby team, set after a migration)
      const flip = !!teams && teams[m.self | 0] !== teams[0];
      startIn = m; mySlot = m.self | 0; myTeam = teams ? teams[mySlot] : 0;
      flipNow = !!teams && myTeam !== (m.ht ?? teams[0]);
      try {
         world = buildNetWorld({ mission: String(m.mission), difficulty: String(m.difficulty), seed: m.seed >>> 0, classes: m.classes, loadouts: m.loadouts, names: m.names, self: m.self | 0, teams });
         if (flip) flipSides(world);
      } catch (e) { console.error('[net] world build failed', e); lose(TEXT.build); return; }
      replica = makeReplica(world, {
         send: (channel, data) => send(channel, data, hostId), now, pvp: !!teams, flip: flipNow,
         onLost: (why) => hostGone(why),
         // back in a running match: show it once the world has caught up (own telegraph included)
         onResync: () => { if (waitResync) { waitResync = 0; hooks.onReady?.(world); } },
      });
      for (const b of early) replica.onEvt(b);
      early.length = 0;
      if (m.rejoin) waitResync = now();
      else hooks.onReady?.(world);
   }

   function clientSync(m, from) {
      if (!m || typeof m !== 'object') return;
      if (from !== hostId) {
         if (!replica || !players.some(p => p.id === from)) return;
         // a new host: believed once the old one is gone or silent, kept for that moment otherwise
         if (m.k === 'host') { if (orphan || replica.silent() >= ANNOUNCE_QUIET) adopt(from, m); else heir = { id: from, m, at: now() }; }
         else if (pend.length < 400) pend.push(['sync', m, from]);
         return;
      }
      if (hooks.measure) stat.in += size(m);
      if (replica) {
         if (m.k === 'st' && 'hs' in m && m.hs !== succ) { succ = typeof m.hs === 'string' ? m.hs : null; if (succ) tp._add?.([succ]); }
         else if (m.k === 'left') { hostGone('left'); return; }
         replica.onSync(m);
         return;
      }
      if (m.k === 'start') { if (!world && !lostText) clientStart(m); }
      else if (m.k === 'refuse') lose(m.why === 'version' ? TEXT.version : TEXT.refused);
      else if (m.k === 'abort') lose(TEXT.hostLeft);
   }

   // ---------------------------------------------------------------- host migration
   // The host is gone (why: 'left' | 'timeout' | 'abort'). The successor takes over, the others
   // wait for its announcement; after an abort, or when the successor has no full state, the
   // match is over.
   function hostGone(why) {
      if (done || lostText || !replica || orphan) return;
      const text = why === 'timeout' ? TEXT.hostLost : TEXT.hostLeft;
      if (why === 'abort' || replica.ended || (succ === selfId && !mig)) { lose(text); return; }
      orphan = now(); orphanWhy = why;
      if (heir && orphan - heir.at < MIGRATE_WAIT) { const h = heir; heir = null; adopt(h.id, h.m); return; }
      if (succ !== selfId) hooks.onNotice?.(TEXT.waitHost);
   }

   // The host fell silent and the successor heard nobody else of the room for a while either: it is
   // the one cut off, not the host. It does not take over (it would run a match of its own) and
   // gives up like the others. A host that said goodbye proves the connection. Only the real
   // transport tells (heardAny); with nobody else in the room it cannot tell.
   function cutOff() {
      if (orphanWhy === 'left' || !tp.heardAny) return false;
      const ms = tp.heardAny(hostId);
      return ms !== null && !(ms < CUT_OFF_MS);
   }

   // This client carries on as the host: the replica World becomes the authoritative one.
   function promote() {
      const m = mig, oldHost = hostId, since = orphan;
      try {
         const h = replica.handover();
         const lossInfo = restoreWorld(world, m, { flip: flipNow, tick: h.tick, seen: h.seen, torps: h.torps, me: world.player });
         h.own();
         world.player.human = false; world.player.isPlayer = true;
         const humans = world.net.humans, pl = Array.isArray(m.pl) ? m.pl : [];
         tp._add?.(pl.map(x => x[0]));
         const here = new Set(tp.peers());
         const clients = [];
         for (const [id, slot, g] of pl) {
            if (id === selfId || typeof id !== 'string') continue;
            const ship = humans[slot];
            if (!ship || ship === world.player) continue;
            slots.set(id, slot);
            const name = String(startIn.names?.[slot] || '');
            if (!players.some(p => p.id === id)) players.push({ id, name, ship: ship.cls });
            const off = !!g || id === oldHost || !here.has(id);
            ship.human = !off;
            if (off) gone.add(id);
            clients.push({ id, name: nameOf(id) || name, ship, gone: off });
         }
         // flights of captains who are gone fly on under their pilots
         for (const q of world.squadrons) { const s = q.human && world.shipById(q.ownerId); if (s && s !== world.player && !s.human) releaseSquadron(world, q); }
         startMsg = { ...startIn, self: 0, rejoin: undefined, ht: myTeam || undefined };
         const labels = pvp ? { player: myTeam, enemy: 3 - myTeam } : null;
         host = makeHost(world, { send, pvp, labels, clients, self: { id: selfId, slot: mySlot }, spawned: h.arrived, adopt: true,
            measure: hooks.measure, onSuccessor: (id) => session.onSuccessor?.(id) });
         replica = null;
         isHost = true; hostId = selfId; mig = null; orphan = 0; succ = null;
         tp._setHost?.(selfId);
         send('sync', { k: 'host', id: selfId, t: world.tick, team: myTeam });
         migrated = { tick: h.tick, stateTick: m.t, waited: now() - since, lost: lossInfo };
         console.info('[net] host migration: host from tick', h.tick, '(full state of tick ' + m.t + '), dropped', lossInfo);
      } catch (e) {
         console.error('[net] host migration failed', e);
         lose(TEXT.hostLost);
         return;
      }
      session.onHost?.(selfId);
      hooks.onNotice?.(TEXT.selfHost);
   }

   // Another client took over: the replica listens to it from now on.
   function adopt(id, m) {
      if (done || lostText || !replica || replica.ended) return;
      hostId = id; orphan = 0; succ = null; heir = null;
      tp._setHost?.(id);
      flipNow = pvp && !!m.team && myTeam !== m.team;
      replica.rehost(flipNow);
      session.onHost?.(id);
      hooks.onNotice?.(TEXT.newHost(nameOf(id)));
      for (const [ch, d, from] of pend.splice(0)) if (from === id) { if (ch === 'sync') clientSync(d, from); else replica.onEvt(d); }
   }

   // ---------------------------------------------------------------- wiring
   // One handler per channel for the whole match: a client may become the host on the way.
   tp.on('sync', (m, from) => { if (isHost) hostSync(m, from); else clientSync(m, from); });
   tp.on('cmd', (d, from) => { if (isHost && host) { if (hooks.measure) stat.in += size(d); host.onCmd(d, from); } });
   tp.on('snap', (d, from) => {
      if (isHost || from !== hostId || !replica) return;
      if (hooks.measure) stat.in += size(d);
      stat.snapIn++;
      replica.onSnap(d);
   });
   tp.on('evt', (d, from) => {
      if (isHost) return;
      if (from !== hostId) { if (replica && pend.length < 400 && players.some(p => p.id === from)) pend.push(['evt', d, from]); return; }
      if (hooks.measure) stat.in += size(d);
      if (replica) replica.onEvt(d); else if (early.length < 400) early.push(d);
   });
   tp.on('mig', (d, from) => {
      if (isHost || from !== hostId || !d || d.k !== 'mig' || !Array.isArray(d.sh)) return;
      if (hooks.measure) stat.in += size(d);
      if (!mig || !(d.t < mig.t)) mig = d;
   });
   tp.onPeerLeave((id) => {
      if (isHost) { hello.delete(id); gone.add(id); if (host) host.drop(id); return; }
      if (id !== hostId) return;
      if (replica) replica.hostLost('left'); else lose(TEXT.hostLeft);
   });
   // a former captain is back under a new peer id (lobby check passed): the slot moves along
   tp.onRejoin?.((oldId, newId) => {
      if (!isHost) return;
      const p = players.find(x => x.id === oldId);
      if (!p || !host) return;
      if (oldId !== newId && players.some(x => x.id === newId)) return;
      if (!host.rejoin(oldId, newId)) return;
      players[players.indexOf(p)] = { ...p, id: newId };
      gone.delete(newId);
      if (slots.has(oldId)) { const i = slots.get(oldId); slots.delete(oldId); slots.set(newId, i); }
   });
   if (!isHost && !players.some(p => p.id === selfId)) lostText = TEXT.notListed;   // reported by the first pump()
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
         if (!orphan) replica.pump();
         else if (lostText) { /* over */ }
         else if (succ === selfId) {
            if (t - orphan < PROMOTE_GRACE) { /* a last full state may be on the way */ }
            else if (cutOff()) { succ = null; hooks.onNotice?.(TEXT.waitHost); }
            else promote();
         }
         else if (t - orphan > MIGRATE_WAIT) lose(TEXT.hostLost);
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
      else if (isHost && host && host.successor) {
         // the match goes on without this peer: the successor takes over (last full state first)
         host.handoff();
         send('sync', { k: 'left' });
         res = { aborted: true, reason: TEXT.quit, victory: null, handover: true };
      }
      else if (isHost) { send('sync', { k: 'abort' }); res = { aborted: true, reason: TEXT.abort, victory: null }; }
      else { send('sync', { k: 'bye' }, hostId); res = { aborted: true, reason: TEXT.quit, victory: null }; }
      done = true;
      if (host) host.stop();
      for (const ch of ['cmd', 'snap', 'evt', 'sync', 'mig']) tp.on(ch, () => {});
      tp.onPeerLeave(() => {}); tp.onPeerJoin(() => {});
      session.onEnd?.(res);
   }

   return {
      get isHost() { return isHost; },
      get pvp() { return pvp || !!startIn?.teams; },
      pump, quit,
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
         return { isHost, hostId, successor: host ? host.successor : succ, ready: !!world, done, lost: lostText, clients: host ? host.clientIds.length : 0, seconds: dt,
            mig: host ? host.migStats() : null, migrated,
            bytesOut: stat.out, bytesIn: stat.in, snapsIn: stat.snapIn, snapsOut: stat.snapOut,
            kBpsIn: stat.in / dt / 1000, kBpsOut: stat.out / dt / 1000, snapHz: (isHost ? stat.snapOut / Math.max(1, host ? host.clientIds.length : 1) : stat.snapIn) / dt,
            ...(replica ? replica.info() : null) };
      },
   };
}
