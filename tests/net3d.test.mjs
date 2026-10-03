// Net game (game3d/net): a host World and client replicas over the in-memory transport with
// latency and jitter, on a virtual clock. Run: node --test tests/net3d.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemoryHub } from '../game3d/net/transport.js';
import { createNetGame, TEXT } from '../game3d/net/game.js';
import { coopSlots, coopRoles, coopExcluded } from '../game3d/net/coop.js';
import { SNAP_EVERY } from '../game3d/net/host.js';
import { makeSnap, decodeSnap, encodeShips, encodeOwn, decodeOwn, SQ_STATES, SQ_BYTES } from '../game3d/net/codec.js';
import { execAction, applyAirControl } from '../game3d/net/command.js';
import { packWorld } from '../game3d/net/migrate.js';
import { World } from '../game3d/state.js';
import { AIR, AIR_TYPES, launchSquadron, orderPatrol, squadById, squadVisibleTo } from '../game3d/air.js';
import { angleDelta } from '../game3d/utils.js';

const DT = 1 / 60;

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// A room on a virtual clock: index 0 is the host.
function makeRoom(o = {}) {
   const names = o.names || ['host', 'anna', 'bert'];
   const ships = o.ships || ['Bismarck', 'Hipper', 'Z23'];
   let nowMs = 0, n = 0;
   const q = [];
   const hub = makeMemoryHub({
      latency: o.latency ?? 40, jitter: o.jitter ?? 25, rand: rng(7), now: () => nowMs,
      schedule: (fn, ms) => { q.push({ at: nowMs + ms, n: n++, fn }); },
   });
   const tps = names.map(id => hub.join(id));
   const onRejoin = [];
   tps.forEach((t, i) => { t.onRejoin = (fn) => { onRejoin[i] = fn; }; });     // the lobby's part in a rejoin (lobby.js)
   const players = names.map((id, i) => ({ id, name: 'Kapitän ' + id, ship: ships[i] }));
   const ends = names.map(() => []), lost = names.map(() => []);
   const games = tps.map((transport, i) => createNetGame(
      { transport, mode: o.mode || 'coop', mission: o.mission || 'standard', difficulty: 'normal', seed: o.seed ?? 20260924, players: o.players || players, onEnd: (r) => ends[i].push(r) },
      { now: () => nowMs / 1000, loadout: () => null, measure: true, onLost: (t) => lost[i].push(t) }));
   const room = {
      hub, tps, games, ends, lost, players, frozen: new Set(), hist: new Map(),
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
            if (g.world && !g.lost) g.world.update(DT);      // like main3d: stepping goes on after the end
         }
         const hw = games[0].world;
         if (hw && o.history) {
            // host positions per tick, to compare a replica with the moment it is showing
            const m = new Map();
            for (const s of hw.ships) m.set(s.id, { x: s.pos.x, y: s.pos.y, hd: s.heading, hp: s.hp });
            room.hist.set(hw.tick, m);
            room.hist.delete(hw.tick - 240);
         }
      },
      run(seconds, until) { const N = Math.round(seconds * 60); for (let i = 0; i < N; i++) { room.step(); if (until && until()) return true; } return !until; },
      // player i comes back under a new peer id with a fresh page (new game object); h: the
      // index of the peer that runs the match now
      rejoin(i, newId, h = 0) {
         const old = room.players[i].id;
         const pl = (o.players || players).map(p => p.id === old ? { ...p, id: newId } : p);
         const transport = hub.join(newId);
         transport.hostId = room.players[h].id;
         onRejoin[h](old, newId);
         const g = createNetGame({ transport, mode: o.mode || 'coop', mission: o.mission || 'standard', difficulty: 'normal', seed: o.seed ?? 20260924, players: pl, onEnd: (r) => ends[i].push(r) },
            { now: () => nowMs / 1000, loadout: () => null, measure: true, onLost: (t) => lost[i].push(t), onReady: () => { g.readyCalls = (g.readyCalls || 0) + 1; } });
         games[i] = g; tps[i] = transport; room.players[i] = pl[i];
         return g;
      },
   };
   return room;
}

function ready(room) { return room.run(12, () => room.games.every(g => g.ready)); }
const shipOf = (world, id) => world._byId.get(id);

test('coopSlots: the standard battle takes several captains, historical operations their allied ships', () => {
   assert.ok(coopSlots('standard') >= 3, 'standard: ' + coopSlots('standard'));
   assert.equal(coopSlots('no-such-mission'), 0);
   assert.equal(coopSlots('rheinuebung'), 2);
   assert.equal(coopSlots('cerberus'), 4);
   assert.equal(coopSlots('laststand'), 0, 'the Bismarck fights alone');
   assert.equal(coopSlots('training'), 0);
   for (const id of Object.keys(coopExcluded())) assert.equal(coopSlots(id), 0, id);
   assert.deepEqual(coopRoles('rheinuebung').map(r => r.name), ['Bismarck', 'Prinz Eugen']);
   assert.deepEqual(coopRoles('cerberus').map(r => r.cls), ['Scharnhorst', 'Scharnhorst', 'Hipper', 'Z23']);
   assert.deepEqual(coopRoles('standard'), [], 'free ship choice');
   // round-7 operations
   assert.equal(coopSlots('wahoo'), 0, 'the Wahoo hunts alone');
   for (const id of ['matapan', 'dakar', 'spartivento']) assert.equal(coopSlots(id), 4, id);
   assert.deepEqual(coopRoles('matapan').map(r => r.name), ['HMS Warspite', 'HMS Valiant', 'HMS Barham', 'HMS Jervis']);
   assert.deepEqual(coopRoles('dakar').map(r => r.cls), ['Richelieu', 'LeFantasque', 'LeFantasque', 'LeFantasque']);
   assert.deepEqual(coopRoles('spartivento').map(r => r.cls), ['Littorio', 'Zara', 'Zara', 'Zara']);
});

test('historical operation: the host keeps the flagship, the others take the mission\'s own allied ships', () => {
   const room = makeRoom({ mission: 'cerberus', names: ['host', 'anna', 'bert', 'carl'], ships: ['Scharnhorst', 'Bismarck', 'Hipper', 'Z23'] });
   assert.ok(ready(room), 'all peers ready');
   const [gh, ga, gb, gc] = room.games;
   const hw = gh.world, H = hw.net.humans, S = hw._script;
   assert.equal(H.length, 4);
   assert.equal(hw.net.flag, H[0]);
   assert.equal(H[0].cls, 'Scharnhorst');
   // the very ships the mission script watches ("Gneisenau und Prinz Eugen dürfen nicht sinken")
   assert.equal(H[1], S.gn); assert.equal(H[2], S.eugen);
   assert.match(H[1].name, /^Gneisenau \(Kapitän anna\)$/);
   assert.equal(H[3].cls, 'Z23');
   for (const h of H.slice(1)) { assert.ok(h.human); assert.equal(h.dmgMult, 1); assert.ok(h.stats); }
   for (const [g, i] of [[ga, 1], [gb, 2], [gc, 3]]) {
      assert.equal(g.world.player.id, H[i].id);
      assert.equal(g.world.player.cls, H[i].cls);
      assert.equal(g.world.player.name, H[i].name);
   }
   // Gneisenau answers her captain, not the escort AI
   const cmd = { telegraph: 1, rudder: -2, aim: { x: 0, y: 0 }, lock: null };
   room.run(8, () => { ga.control(cmd); });
   assert.equal(H[1].telegraph, 1); assert.equal(H[1].rudderCmd, -2);
   // losing an escort costs the optional objective, the battle goes on
   H[2].takeDamage(1e9, null, 'pen');
   room.run(3);
   assert.equal(hw.phase, 'playing');
   assert.equal(hw.mission.objectives.find(o => o.id === 'ships').state, 'failed');
   assert.equal(gb.world.mission.objectives.find(o => o.id === 'ships').state, 'failed', 'objectives reach the clients');
   // the flagship lost: the operation has failed for everybody
   H[0].takeDamage(1e9, null, 'pen');
   assert.ok(room.run(10, () => room.games.every(g => g.world.phase !== 'playing')), 'every world ended');
   for (const g of room.games) { assert.equal(g.world.phase, 'lost'); assert.match(g.world.result.reason, /Flaggschiff/); }
});

test('historical operation: torpedo hits of every human destroyer count for Vian\'s attack', () => {
   const room = makeRoom({ mission: 'vian', names: ['host', 'anna'], ships: ['Jervis', 'Jervis'] });
   assert.ok(ready(room));
   const hw = room.games[0].world, H = hw.net.humans;
   assert.equal(H[1].name, 'HMS Maori (Kapitän anna)');
   H[1].stats.torpHits = 2;
   room.run(1);
   assert.equal(hw.score.player, 2, 'a client\'s hits count');
   H[0].stats.torpHits = 1;
   room.run(1);
   assert.equal(hw.score.player, 3);
});

test('start: every peer builds the same world, each with its own ship', () => {
   const room = makeRoom();
   assert.ok(ready(room), 'all peers ready');
   const [h, a, b] = room.games.map(g => g.world);
   assert.equal(h.ships.length, a.ships.length);
   for (let i = 0; i < h.ships.length; i++) {
      assert.equal(a.ships[i].id, h.ships[i].id);
      assert.equal(a.ships[i].cls, h.ships[i].cls);
      assert.equal(b.ships[i].side, h.ships[i].side);
   }
   assert.equal(h.obstacles.length, a.obstacles.length);
   const H = h.net.humans;
   assert.equal(H.length, 3);
   assert.equal(h.player, H[0]);
   assert.equal(a.player.id, H[1].id); assert.equal(a.player.cls, 'Hipper');
   assert.equal(b.player.id, H[2].id); assert.equal(b.player.cls, 'Z23');
   assert.ok(H[1].human && H[2].human && !H[0].human);
   assert.ok(a.player.isPlayer && !shipOf(a, H[0].id).isPlayer);
   assert.match(H[1].name, /Kapitän anna/);
});

test('a ship the mission does not allow falls back to a valid class', () => {
   const room = makeRoom({ ships: ['Bismarck', 'NoSuchShip', 'Z23'] });
   assert.ok(ready(room));
   const H = room.games[0].world.net.humans;
   assert.ok(H[1].cfg && H[1].cls !== 'NoSuchShip');
   assert.equal(room.games[1].world.player.cls, H[1].cls);
});

test('client commands steer and fire the ship on the host; the replica follows the host', () => {
   const room = makeRoom({ history: true });
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games;
   const hw = gh.world, aw = ga.world;
   const hs = hw.net.humans[1], me = aw.player;
   const hd0 = hs.heading;
   const cmd = { telegraph: 4, rudder: 2, aim: { x: 0, y: 0 }, lock: null };
   const aimAhead = () => { cmd.aim.x = me.pos.x + Math.cos(me.heading + 1.2) * 9000; cmd.aim.y = me.pos.y + Math.sin(me.heading + 1.2) * 9000; };
   // the AI must not take the ship back: note every telegraph / rudder value the host ship shows
   let foreign = 0;
   room.run(20, () => { aimAhead(); ga.control(cmd); if (room.now > 3 && (hs.telegraph !== 4 || hs.rudderCmd !== 2)) foreign++; });
   assert.equal(foreign, 0, 'host ship kept the client command');
   assert.equal(hs.telegraph, 4); assert.equal(hs.rudderCmd, 2);
   assert.ok(hs.speedKn > 10, 'ship under way: ' + hs.speedKn);
   assert.ok(Math.abs(hs.heading - hd0) > 0.3, 'ship turned');
   assert.ok(Math.hypot(hs.aimPoint.x - cmd.aim.x, hs.aimPoint.y - cmd.aim.y) < 400, 'aim point arrived');

   // fire: predicted on the client, executed by the host
   const shots0 = hs.stats.shotsFired;
   aimAhead(); ga.control(cmd);
   const ax = cmd.aim.x, ay = cmd.aim.y;
   let n = 0;
   room.run(20, () => { ga.control(cmd); n = ga.act(['f', ax, ay]); return n > 0; });
   assert.ok(n > 0, 'client guns fired');
   assert.ok(aw.shells.some(s => s.ownerId === me.id), 'predicted shells fly at once');
   assert.ok(me.turrets.some(t => t.reload > 0), 'reload starts at once');
   room.run(1);
   assert.ok(hs.stats.shotsFired > shots0, 'host fired the guns: ' + hs.stats.shotsFired);
   assert.ok(hw.shells.some(s => s.ownerId === hs.id), 'host has the shells');
   assert.ok(aw.shells.some(s => s.ownerId === me.id && !s.pred && s.hid), 'predicted shells were confirmed');
   // the same shell count for that ship on both sides (prediction did not double them)
   const cnt = (w) => w.shells.filter(s => s.ownerId === hs.id && s.kind === 'main').length;
   assert.equal(cnt(aw), cnt(hw));
   // ammo, consumable
   assert.ok(ga.act(['a', 'AP']));
   room.run(0.5);
   assert.equal(hs.ammo, 'AP'); assert.equal(me.ammo, 'AP');
   const key = hs.consumables[0].key;
   const act0 = hs.consumables[0].active, ch0 = hs.consumables[0].charges;
   ga.act(['c', key]);
   room.run(0.5);
   assert.ok(hs.consumables[0].active !== act0 || hs.consumables[0].charges !== ch0 || hs.consumables[0].cd > 0, 'consumable used on the host');

   // torpedoes from the destroyer (client b)
   const hb = hw.net.humans[2], bw = gb.world;
   let tn = 0;
   room.run(10, () => { tn = gb.act(['t', bw.player.heading + Math.PI / 2]); return tn > 0; });
   assert.ok(tn > 0, 'client torpedoes launched');
   room.run(1);
   assert.ok(hw.torpedoes.some(t => t.ownerId === hb.id), 'host launched them');
   assert.ok(bw.torpedoes.some(t => t.ownerId === hb.id), 'the client sees them');
   assert.ok(aw.torpedoes.some(t => t.ownerId === hb.id), 'the other client sees them');
   const ht = hw.torpedoes.find(t => t.ownerId === hb.id), ct = bw.torpedoes.find(t => t.id === ht.id);
   assert.ok(ct, 'same torpedo id');

   // convergence: a replica shows the host's state of the tick it renders
   room.run(10);
   for (const g of [ga, gb]) {
      const w = g.world, at = room.hist.get(w.tick);
      assert.ok(at, 'history for tick ' + w.tick + ' (host ' + hw.tick + ')');
      const lag = (hw.tick - w.tick) * DT;
      assert.ok(lag > 0.05 && lag < 0.4, 'render delay ' + lag.toFixed(3));
      let worst = 0;
      for (const s of w.ships) {
         const r = at.get(s.id);
         if (!r) continue;
         worst = Math.max(worst, Math.hypot(s.pos.x - r.x, s.pos.y - r.y));
         assert.ok(Math.abs(s.hp - r.hp) <= s.maxHP * 0.02 + 1, s.name + ' hp ' + s.hp + ' vs ' + r.hp);
      }
      assert.ok(worst < 3, 'worst position error ' + worst.toFixed(2) + ' m');
      assert.equal(w.ships.filter(s => s.alive).length, hw.ships.filter(s => s.alive).length);
      assert.ok(Math.abs(w.timeLeft - hw.timeLeft) < 1, 'timer');
   }
   // a torpedo is where the host has it (compare at the replica's moment)
   const t2 = hw.torpedoes.find(t => t.ownerId === hb.id && t.alive);
   if (t2) {
      const c2 = bw.torpedoes.find(t => t.id === t2.id);
      assert.ok(c2, 'torpedo still known');
      const back = (hw.tick - bw.tick) * DT * t2.speed;
      assert.ok(Math.abs(Math.hypot(t2.pos.x - c2.pos.x, t2.pos.y - c2.pos.y) - back) < 3, 'torpedo position');
   }
});

test('battle: events, hits and personal statistics reach the right client', () => {
   const room = makeRoom({ history: true });
   assert.ok(ready(room));
   const [gh, ga] = room.games;
   const hw = gh.world, aw = ga.world, hs = hw.net.humans[1], me = aw.player;
   // put an enemy right in front of client a's guns and shoot it
   const foe = hw.ships.find(s => s.side === 'enemy' && s.alive);
   foe.pos.x = hs.pos.x + Math.cos(hs.heading + 1.3) * 5000; foe.pos.y = hs.pos.y + Math.sin(hs.heading + 1.3) * 5000;
   const cmd = { telegraph: 0, rudder: 0, aim: { x: 0, y: 0 }, lock: null };
   const seen = new Set();
   let seq = 0;
   room.run(60, () => {
      const f = shipOf(aw, foe.id);
      cmd.aim.x = f.pos.x; cmd.aim.y = f.pos.y;
      ga.control(cmd);
      ga.act(['f', f.pos.x, f.pos.y]);
      for (const e of aw.events) if (e.seq > seq) { seq = e.seq; if (e.srcId === me.id) seen.add(e.type); }
      return hs.stats.hits >= 3;
   });
   assert.ok(hs.stats.hits >= 3, 'hits on the host: ' + hs.stats.hits);
   room.run(2, () => { for (const e of aw.events) if (e.seq > seq) { seq = e.seq; if (e.srcId === me.id) seen.add(e.type); } });
   assert.ok([...seen].some(t => ['pen', 'citadel', 'overpen', 'he', 'ricochet', 'shatter'].includes(t)), 'hit events on the client: ' + [...seen]);
   assert.equal(aw.stats.hits, hs.stats.hits, 'own statistics on the client');
   // statistics arrive once a second; burning damage keeps trickling in between
   assert.ok(aw.stats.dmg > 0 && Math.abs(aw.stats.dmg - hs.stats.dmg) <= hs.stats.dmg * 0.1 + 50, aw.stats.dmg + ' vs ' + hs.stats.dmg);
   assert.notEqual(hw.stats, hs.stats, 'the host keeps its own statistics');
   assert.equal(hw.stats.hits, 0);
   const cf = shipOf(aw, foe.id);
   assert.ok(cf.hp < cf.maxHP, 'damage visible on the client');
   assert.ok(aw.effects.length > 0, 'effects on the client');
   assert.ok(aw.logLines.length >= 0);
});

test('a client that leaves hands its ship back to the AI; the match goes on', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games;
   const hw = gh.world, hb = hw.net.humans[2];
   gb.control({ telegraph: 0, rudder: 0, aim: null, lock: null });
   room.run(3);
   assert.ok(hb.human);
   gb.quit();
   room.run(1);
   assert.equal(room.ends[2].length, 1);
   assert.equal(room.ends[2][0].aborted, true);
   assert.equal(hb.human, false, 'AI has the ship');
   assert.equal(gh.host.clientIds.length, 1);
   assert.ok(hw.logLines.some(l => /KI übernimmt/.test(l.text || l)), 'German notice on the host');
   let moved = false;
   room.run(30, () => { if (hb.telegraph !== 0) moved = true; return moved; });
   assert.ok(moved, 'the AI gives orders again');
   assert.equal(hw.phase, 'playing');
   assert.equal(ga.lost, null);
   gb.quit();
   assert.equal(room.ends[2].length, 1, 'onEnd only once');
   // a dropped connection does the same
   room.tps[1].leave();
   room.run(0.5);
   assert.equal(hw.net.humans[1].human, false);
   assert.equal(gh.host.clientIds.length, 0);
});

test('rejoin: a dropped captain comes back under a new id, catches up and takes the ship back', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const [gh] = room.games;
   const hw = gh.world, hb = hw.net.humans[2];
   room.games[2].control({ telegraph: 2, rudder: 0, aim: null, lock: null });
   room.run(3);
   // the page is gone (reload): the transport drops, the AI takes over
   room.games[2].quit();
   room.tps[2].leave();
   room.run(1);
   assert.equal(hb.human, false);
   // meanwhile: a reinforcement enters, a torpedo runs, objectives and own statistics change
   const extra = hw.spawn('Z23', 'enemy', { x: hw.arena * 0.5, y: hw.arena * 0.5 }, 1.2, { name: 'Nachzügler' });
   hb.stats.shotsFired = (hb.stats.shotsFired || 0) + 7;
   const victim = hw.ships.find(s => s.side === 'enemy' && s !== extra);
   hw.removeShip(victim, 'escaped');
   room.run(2);
   room.games[2].quit();
   // back with a new id: the transport's room got the lobby's ok
   const g = room.rejoin(2, 'bert-2');
   assert.ok(room.run(10, () => g.ready), 'the returning client is ready');
   assert.equal(g.readyCalls, 1, 'onReady once, after the resync');
   room.run(2);
   const rw = g.world;
   assert.equal(rw.player.id, hb.id, 'same ship as before');
   assert.equal(hb.human, true, 'the AI let go');
   assert.deepEqual(gh.host.clientIds.slice().sort(), ['anna', 'bert-2']);
   assert.ok(shipOf(rw, extra.id), 'reinforcement spawned on the replica');
   const rv = shipOf(rw, victim.id);
   assert.ok(!rv || !rv.alive, 'the ship sunk meanwhile is not alive on the replica');
   assert.equal(rw.stats.shotsFired, hb.stats.shotsFired, 'own statistics');
   assert.deepEqual(rw.mission ? rw.mission.objectives : null, hw.mission ? hw.mission.objectives : null);
   assert.ok(hw.logLines.some(l => /ist zurück/.test(l.text || l)), 'German notice');
   // and the ship obeys the new peer
   g.control({ telegraph: -1, rudder: 1, aim: null, lock: null });
   assert.ok(room.run(3, () => hb.telegraph === -1 && hb.rudderCmd === 1), 'commands of the new id steer the ship');
   assert.equal(room.lost[2].length, 0);
   // an id that never played is refused, and an unknown rejoin is ignored
   const tx = room.hub.join('mallory');
   let refused = false;
   tx.on('sync', (m) => { if (m.k === 'refuse') refused = true; });
   tx.send('sync', { k: 'hello', v: 99 }, 'host');
   room.run(1);
   assert.equal(refused, false, 'not in the session: no answer at all');
});

test('the match runs to its end: every client gets its own result', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games;
   const hw = gh.world;
   room.run(5);
   // client a's ship sinks first: that captain keeps watching
   const ha = hw.net.humans[1];
   ha.takeDamage(1e9, null, 'pen');
   room.run(3);
   assert.equal(ha.alive, false);
   assert.equal(ga.world.player.alive, false, 'the client sees its ship sink');
   assert.equal(hw.phase, 'playing', 'the battle goes on');
   assert.equal(ga.world.phase, 'playing');
   const hb = hw.net.humans[2];
   hb.stats.dmg = 4321; hb.stats.kills = 1;
   for (const s of hw.ships.slice()) if (s.side === 'enemy' && s.alive) s.takeDamage(1e9, hw.player, 'pen');
   assert.ok(room.run(30, () => room.games.every(g => g.world.phase !== 'playing')), 'every world ended');
   assert.equal(hw.phase, 'won');
   for (const g of [ga, gb]) {
      const w = g.world;
      assert.equal(w.phase, 'won');
      assert.equal(w.result.victory, true);
      assert.equal(w.result.reason, hw.result.reason);
      assert.ok(w.result.rewards && Array.isArray(w.result.rewards.lines), 'reward lines');
      assert.equal(w.roster.filter(s => s.alive).length, hw.roster.filter(s => s.alive).length);
   }
   assert.equal(gb.world.result.stats.dmg, 4321);
   assert.equal(ga.world.result.stats.dmg, ha.stats.dmg);
   assert.ok(gb.world.result.xp > ga.world.result.xp, 'own rewards: ' + gb.world.result.xp + ' vs ' + ga.world.result.xp);
   assert.notEqual(gb.world.result.xp, hw.result.xp);
   // the host goes back to the lobby first; nobody is told the host was lost
   gh.quit();
   room.run(8);
   assert.deepEqual(room.lost[1], []); assert.deepEqual(room.lost[2], []);
   ga.quit(); gb.quit(); gb.quit();
   for (let i = 0; i < 3; i++) {
      assert.equal(room.ends[i].length, 1, 'onEnd once for ' + i);
      assert.equal(room.ends[i][0].aborted, false);
      assert.equal(room.ends[i][0].victory, true);
   }
});

test('host migration: the host leaves, the successor carries on, the others switch over', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games;
   room.run(5);
   assert.equal(gh.host.successor, 'anna', 'the first captain is the successor');
   assert.equal(gb.info().successor, 'anna', 'everybody knows it');
   const ms = gh.host.migStats();
   assert.ok(ms.count >= 4 && ms.count <= 7, 'full state about once a second: ' + ms.count);
   const hw = gh.world;
   // some state the replica alone could not know: AI, statistics, consumables, a running torpedo
   const hb = hw.net.humans[2];
   hb.stats.shotsFired = 17; hw.net.humans[1].stats.hits = 5;
   const bot = hw.ships.find(s => s.side === 'player' && !s.human && !s.isPlayer && s.alive);
   const foe = hw.ships.find(s => s.side === 'enemy' && s.alive);
   foe.hp = Math.round(foe.maxHP * 0.6);
   room.run(0.5);
   const before = new Map(hw.ships.map(s => [s.id, { hp: s.hp, x: s.pos.x, y: s.pos.y, alive: s.alive }]));
   const t0 = room.now;
   gh.quit();
   assert.equal(room.ends[0][0].handover, true, 'the old host hands over');
   assert.ok(room.run(3, () => ga.isHost && gb.info().hostId === 'anna'), 'anna took over, bert follows it');
   const took = room.now - t0;
   assert.ok(took < 1, 'migration within a second: ' + took.toFixed(2));
   assert.deepEqual(room.lost, [[], [], []]);
   const aw = ga.world;
   for (const [id, b] of before) {
      const s = aw._byId.get(id);
      assert.ok(s, 'ship ' + id + ' known');
      assert.equal(s.alive, b.alive, 'ship ' + id + ' alive');
      if (!b.alive) continue;
      assert.ok(Math.abs(s.hp - b.hp) <= Math.max(1, b.hp * 0.02), 'hp of ' + s.name + ': ' + s.hp + ' vs ' + b.hp);
      assert.ok(Math.hypot(s.pos.x - b.x, s.pos.y - b.y) < 200, 'position of ' + s.name);
   }
   assert.ok(Math.abs(aw._byId.get(foe.id).hp - foe.hp) < 1, 'damage done before the migration stays');
   assert.equal(aw.net.humans[2].stats.shotsFired, 17, 'statistics of the others came along');
   assert.equal(aw.stats.hits, 5, 'own statistics');
   assert.equal(aw.player.isPlayer, true);
   assert.ok(aw._byId.get(bot.id).ai, 'the AI runs on the new host');
   const info = ga.info();
   assert.ok(info.migrated && info.migrated.tick > 0);
   // the match goes on: bert steers its ship on anna's World, the old host's ship is a bot now
   const bs = aw.net.humans[2];
   assert.equal(bs.human, true);
   assert.equal(aw.net.humans[0].human, false, 'the old host\'s ship sails under the AI');
   gb.control({ telegraph: -1, rudder: 1, aim: null, lock: null });
   assert.ok(room.run(4, () => bs.telegraph === -1 && bs.rudderCmd === 1), 'bert commands its ship on the new host');
   room.run(2);
   assert.ok(gb.replica.info().synced, 'bert gets the new host\'s snapshots');
   assert.ok(Math.abs(gb.world.tick - aw.tick) < 30, 'replica close to the new host: ' + gb.world.tick + ' / ' + aw.tick);
   const bp = gb.world.player;
   assert.ok(Math.hypot(bp.pos.x - bs.pos.x, bp.pos.y - bs.pos.y) < 60, 'bert sees its ship where the new host has it');
   // ... and ends correctly
   for (const s of aw.ships.slice()) if (s.side === 'enemy' && s.alive) s.takeDamage(1e9, aw.player, 'pen');
   assert.ok(room.run(30, () => [ga, gb].every(g => g.world.phase !== 'playing')), 'both worlds ended');
   assert.equal(aw.phase, 'won');
   assert.equal(gb.world.phase, 'won');
   assert.equal(gb.world.result.reason, aw.result.reason);
   assert.equal(gb.world.result.stats.shotsFired >= 17, true, 'bert\'s result carries its statistics');
   ga.quit(); gb.quit();
   assert.equal(room.ends[1][0].aborted, false);
   assert.equal(room.ends[2][0].aborted, false);
   assert.equal(room.ends[2][0].victory, true);
});

test('host migration: the page of the host is gone; the old host may come back as a captain', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games;
   room.run(3);
   const hostShip = gh.world.player.id;
   room.frozen.add(0);                 // page closed: no quit(), the transport says goodbye
   room.tps[0].leave();
   assert.ok(room.run(3, () => ga.isHost && gb.info().hostId === 'anna'), 'anna took over');
   assert.deepEqual(room.lost, [[], [], []]);
   room.run(1);
   // the old host is back under a new id (the lobby checked its seat token on anna's side)
   const g = room.rejoin(0, 'host-2', 1);
   room.frozen.delete(0);
   assert.ok(room.run(10, () => g.ready), 'the old host is ready again');
   room.run(2);
   assert.equal(g.isHost, false);
   assert.equal(g.world.player.id, hostShip, 'its old ship');
   const hs = ga.world._byId.get(hostShip);
   assert.equal(hs.human, true, 'the AI let go of it');
   g.control({ telegraph: 3, rudder: -1, aim: null, lock: null });
   assert.ok(room.run(3, () => hs.telegraph === 3 && hs.rudderCmd === -1), 'it steers its ship on the new host');
   assert.deepEqual(ga.host.clientIds.slice().sort(), ['bert', 'host-2']);
   assert.equal(room.lost[0].length, 0);
});

test('host migration: a host cut off for a while gives way; without a successor the match ends', () => {
   const room = makeRoom({ names: ['host', 'anna', 'bert', 'cara'], ships: ['Bismarck', 'Hipper', 'Z23', 'Z23'] });
   assert.ok(ready(room));
   const [, ga, gb, gc] = room.games;
   room.run(3);
   room.frozen.add(0);
   assert.ok(room.run(8, () => ga.isHost && gc.info().hostId === 'anna'), 'anna took over');
   room.frozen.delete(0);              // the old host wakes up and hears of anna
   room.run(1);
   assert.deepEqual(room.lost[0], [TEXT.replaced]);
   assert.deepEqual(room.lost.slice(1), [[], [], []]);
   room.run(2);
   assert.equal(ga.host.successor, 'bert');
   // host and successor gone at once: cara waits a few seconds, then gives up
   room.frozen.add(1); room.frozen.add(2);
   room.run(10);
   assert.deepEqual(room.lost[3], []);
   room.run(6);
   assert.deepEqual(room.lost[3], [TEXT.hostLost]);
   gc.quit(); gb.quit();
   assert.equal(room.ends[3][0].reason, TEXT.hostLost);
   assert.match(TEXT.hostLeft, /Host hat das Spiel verlassen/);
});

test('host migration: a successor cut off from everybody does not take over', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games;
   room.run(3);
   assert.equal(gh.host.successor, 'anna');
   // anna's network is gone: nothing in, nothing out, and its transport hears none of the others
   const ta = room.tps[1];
   let cut = true;
   const deliver = ta._deliver.bind(ta), send = ta.send.bind(ta);
   ta._deliver = (...a) => { if (!cut) deliver(...a); };
   ta.send = (...a) => { if (!cut) send(...a); };
   ta.heardAny = () => (cut ? 9e9 : 0);
   room.run(15);
   assert.equal(ga.isHost, false, 'anna did not start a match of its own');
   assert.deepEqual(room.lost[1], [TEXT.hostLost]);
   assert.deepEqual(room.lost[0], []);
   assert.deepEqual(room.lost[2], []);
   assert.equal(gb.info().hostId, 'host');
   assert.ok(gb.replica.info().synced);
   cut = false;
   room.run(1);
   assert.deepEqual(room.lost[0], [], 'the host carries on');
});

test('only the host is believed; only session players may command', () => {
   const room = makeRoom({ names: ['host', 'anna', 'bert', 'eve'], players: [{ id: 'host', name: 'H', ship: 'Bismarck' }, { id: 'anna', name: 'A', ship: 'Hipper' }, { id: 'bert', name: 'B', ship: 'Z23' }] });
   assert.ok(room.run(12, () => room.games.slice(0, 3).every(g => g.ready)));
   const [gh, ga, gb, ge] = room.games;
   assert.equal(ge.ready, false);
   assert.deepEqual(room.lost[3], [TEXT.notListed]);
   const hw = gh.world, ha = hw.net.humans[1];
   room.run(2);
   ga.control({ telegraph: 3, rudder: 0, aim: null, lock: null });
   room.run(1);
   assert.equal(ha.telegraph, 3);
   // a stranger and another client try to command anna's ship and to feed her fake state
   const tick0 = ga.world.tick;
   room.tps[3].send('cmd', [9999, -1, 2, 0, 0, null, 0, []], 'host');
   room.tps[2].send('snap', new Uint8Array([1, 255, 255, 255, 127, 0, 0, 0, 0, 0, 0, 0]), 'anna');
   room.tps[3].send('sync', { k: 'abort' }, 'anna');
   room.tps[3].send('sync', { k: 'end', t: 1, victory: false, reason: 'fake' }, 'anna');
   room.tps[3].send('evt', [0, 1, [['l', 'fake', 'info']]], 'anna');
   room.run(2);
   assert.equal(ha.telegraph, 3, 'foreign command ignored');
   assert.deepEqual(room.lost[1], []);
   assert.equal(ga.world.phase, 'playing');
   assert.ok(ga.world.tick > tick0 && ga.world.tick < tick0 + 200, 'clock not thrown off');
   assert.ok(!ga.world.logLines.some(l => /fake/.test(l.text || l)));
   // garbage from the real host side of the wire must not throw either
   room.tps[1].send('cmd', 'x', 'host'); room.tps[1].send('cmd', [1e9, 'a', {}, null, null, {}, 0, [['f', 'x', 1], ['zz'], 5, ['c', 5]]], 'host');
   room.run(1);
   assert.equal(hw.phase, 'playing');
});

test('late and out-of-order snapshots are dropped', () => {
   const room = makeRoom({ latency: 20, jitter: 0 });
   assert.ok(ready(room));
   room.run(2);
   const ga = room.games[1];
   const r = ga.replica, before = r.info().newestTick;
   // replay an old snapshot by hand
   const old = new Uint8Array(12); old[0] = 1; new DataView(old.buffer).setUint32(1, before - 30, true);
   r.onSnap(old);
   assert.equal(r.info().newestTick, before);
});

test('bandwidth: a 7v7 battle stays inside the budget', () => {
   const room = makeRoom({ history: false });
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games;
   const hw = gh.world;
   const sides = { player: hw.ships.filter(s => s.side === 'player').length, enemy: hw.ships.filter(s => s.side === 'enemy').length };
   const cmd = { telegraph: 4, rudder: 0, aim: { x: 0, y: 0 }, lock: null };
   let k = 0;
   const drive = (g) => {
      // a busy captain: the aim point moves every frame, a salvo whenever the guns are ready
      const p = g.world.player, foe = g.world.ships.find(s => s.side === 'enemy' && s.alive) || p;
      cmd.aim.x = foe.pos.x + Math.sin(k * 0.05) * 200; cmd.aim.y = foe.pos.y + Math.cos(k * 0.031) * 200;
      g.control(cmd);
      if (k % 30 === 0) g.act(['f', cmd.aim.x, cmd.aim.y]);
   };
   room.run(60, () => { k++; drive(ga); drive(gb); });       // approach
   for (const g of room.games) g.resetStats();
   const mig0 = gh.host.migStats();
   let shells = 0, n = 0;
   room.run(120, () => { k++; drive(ga); drive(gb); shells += hw.shells.length; n++; });
   const hi = gh.info(), ai = ga.info();
   const mig = { bytes: hi.mig.bytes - mig0.bytes, count: hi.mig.count - mig0.count };
   console.log(`[net] host migration full state (to the successor only): ${mig.count} in 120 s, ${(mig.bytes / mig.count / 1000).toFixed(1)} kB each, ${(mig.bytes / 120 / 1000).toFixed(1)} kB/s`);
   assert.ok(mig.count >= 110 && mig.count <= 140, 'about one full state a second: ' + mig.count);
   const down = ai.kBpsIn, up = ai.kBpsOut;
   console.log(`[net] ${sides.player}v${sides.enemy}, 2 clients, 120 s: down ${down.toFixed(1)} kB/s per client, up ${up.toFixed(2)} kB/s, ` +
      `host out ${hi.kBpsOut.toFixed(1)} kB/s total, snapshots ${ai.snapHz.toFixed(1)}/s (every ${SNAP_EVERY} steps), mean shells in the air ${(shells / n).toFixed(0)}, ` +
      `render delay ${(ai.delay * 1000).toFixed(0)} ms, rtt ${(ai.rtt * 1000).toFixed(0)} ms`);
   assert.ok(sides.player >= 7 && sides.enemy >= 7, 'fleet sizes ' + JSON.stringify(sides));
   assert.ok(down < 30, 'downstream ' + down.toFixed(1) + ' kB/s');
   assert.ok(up < 5, 'upstream ' + up.toFixed(2) + ' kB/s');
   assert.ok(Math.abs(ai.snapHz - 60 / SNAP_EVERY) < 1.5, 'snapshot rate ' + ai.snapHz);
});

// ---------------------------------------------------------------- PvP
// 2v2: host + bert (team 1) against anna + cara (team 2)
function pvpRoom(o = {}) {
   const names = ['host', 'anna', 'bert', 'cara'], ships = ['Bismarck', 'Hipper', 'Z23', 'Hipper'], teams = [1, 2, 1, 2];
   const players = names.map((id, i) => ({ id, name: 'Kapitän ' + id, ship: ships[i], team: teams[i] }));
   return makeRoom({ names, players, mode: 'pvp', ...o });
}
// the ship ids in every snapshot the host sends to `to`
function snapIds(room, to) {
   const seen = [], tp = room.tps[0], send = tp.send.bind(tp), S = makeSnap();
   tp.send = (ch, data, dst) => {
      if (ch === 'snap' && dst === to && decodeSnap(new DataView(data.buffer, data.byteOffset, data.byteLength), S)) seen.push(Array.from(S.id.subarray(0, S.n)));
      return send(ch, data, dst);
   };
   return seen;
}

test('pvp: two teams, bots fill both fleets, the other team sees the battle from its side', () => {
   const room = pvpRoom();
   assert.ok(ready(room));
   const [gh, ga, gb, gc] = room.games;
   const hw = gh.world, H = hw.net.humans;
   assert.equal(hw.net.pvp, true);
   assert.deepEqual(H.map(h => h.side), ['player', 'enemy', 'player', 'enemy']);
   const n = (w, side) => w.ships.filter(s => s.side === side && s.type !== 'TR').length;
   assert.equal(n(hw, 'player'), n(hw, 'enemy'), 'even fleets');
   assert.equal(hw.difficulty.vsPlayer, 1);
   // team 2 sails as 'player' in its own world; the host's team is its enemy
   for (const [g, i] of [[ga, 1], [gc, 3]]) {
      const w = g.world;
      assert.equal(w.player.id, H[i].id);
      assert.equal(w.player.side, 'player');
      assert.equal(w._byId.get(H[0].id).side, 'enemy');
      assert.equal(w._byId.get(H[i === 1 ? 3 : 1].id).side, 'player', 'team mate on the own side');
   }
   assert.equal(gb.world._byId.get(H[0].id).side, 'player');
   assert.equal(gb.world._byId.get(H[1].id).side, 'enemy');
});

test('pvp: a snapshot holds no enemy its team has not spotted', () => {
   const room = pvpRoom();
   const toA = snapIds(room, 'anna'), toB = snapIds(room, 'bert');
   assert.ok(ready(room));
   const hw = room.games[0].world;
   let checked = 0, hiddenA = 0, hiddenB = 0;
   room.run(40, () => {
      if (hw.tick % 30) return;
      // the snapshots just sent were encoded at this tick
      const lastA = toA[toA.length - 1], lastB = toB[toB.length - 1];
      if (!lastA || !lastB) return;
      for (const s of hw.ships) {
         const inA = lastA.includes(s.id), inB = lastB.includes(s.id);
         if (s.side === 'player') { assert.ok(inB); if (s.alive && !s.detected) { assert.ok(!inA, 'unspotted host-team ship sent to team 2'); hiddenA++; } }
         else { assert.ok(inA); if (s.alive && !s.detected) { assert.ok(!inB, 'unspotted team-2 ship sent to team 1'); hiddenB++; } }
      }
      checked++;
   });
   assert.ok(checked > 50, 'checked ' + checked);
   assert.ok(hiddenA > 0 && hiddenB > 0, 'hidden ships seen: ' + hiddenA + '/' + hiddenB);
   // the client of team 2 shows an enemy out of sight (one the last second of snapshots left out)
   // as unspotted, not as sunk
   const wa = room.games[1].world, recent = toA.slice(-20).flat();
   let out = 0;
   for (const s of hw.ships) {
      if (s.side !== 'player' || !s.alive || recent.includes(s.id)) continue;
      out++;
      const r = wa._byId.get(s.id);
      assert.equal(r.spotted, false);
      assert.equal(r.alive, true, 'out of sight is not sunk');
   }
   assert.ok(out > 0, 'some host-team ship out of sight at the end');
});

test('pvp: domination score and caps are turned round for team 2', () => {
   const room = pvpRoom({ mission: 'domination' });
   assert.ok(ready(room));
   const hw = room.games[0].world, wa = room.games[1].world;
   hw.caps[0].owner = 'player'; hw.caps[1].owner = 'enemy';
   hw.score.player = 450; hw.score.enemy = 380;
   room.run(1);
   assert.ok(Math.abs(wa.score.player - hw.score.enemy) < 20 && Math.abs(wa.score.enemy - hw.score.player) < 20, JSON.stringify([wa.score, hw.score]));
   assert.equal(wa.caps[0].owner, 'enemy');
   assert.equal(wa.caps[1].owner, 'player');
   assert.equal(room.games[2].world.caps[0].owner, 'player');
});

test('pvp: the team that loses its captains loses; results per team with every captain', () => {
   const room = pvpRoom();
   assert.ok(ready(room));
   const [gh, ga, gb, gc] = room.games;
   const hw = gh.world, H = hw.net.humans;
   room.run(3);
   H[1].stats.dmg = 1234; H[1].stats.kills = 1;
   H[1].takeDamage(1e9, H[0], 'pen');
   room.run(2);
   assert.equal(hw.phase, 'playing', 'one captain of team 2 is still afloat');
   H[3].takeDamage(1e9, H[2], 'pen');
   assert.ok(room.run(30, () => room.games.every(g => g.world.phase !== 'playing')), 'every world ended');
   assert.equal(hw.phase, 'won');
   assert.equal(gb.world.result.victory, true);
   for (const g of [ga, gc]) {
      assert.equal(g.world.phase, 'lost');
      assert.equal(g.world.result.victory, false);
      assert.match(g.world.result.reason, /Ihres Teams/);
      assert.ok(g.world.result.rewards && g.world.result.xp > 0, 'rewards for the losers too');
   }
   const pv = ga.world.result.pvp;
   assert.equal(pv.win, 1);
   assert.equal(pv.pl.length, 4);
   assert.deepEqual(pv.pl.map(p => p[1]), [1, 2, 1, 2]);
   assert.equal(pv.pl[1][2], 1234);
   assert.equal(pv.pl[1][4], 0);
   assert.equal(pv.my, 2, 'anna sails in team 2');
   assert.equal(gb.world.result.pvp.my, 1);
   assert.deepEqual(hw.result.pvp, { ...pv, my: 1 });
   // the sinking reads as a loss for team 2, as a kill for team 1
   assert.ok(ga.world.logLines.some(l => /💀 Verlust: .*Hipper/.test(l.text || l)), 'team 2 log');
   assert.ok(gb.world.logLines.some(l => /🎯 Versenkt: .*Hipper/.test(l.text || l)), 'team 1 log');
});

test('pvp: host migration to the other team; both teams carry on and the match ends', () => {
   const room = pvpRoom();
   assert.ok(ready(room));
   const [gh, ga, gb, gc] = room.games;
   room.run(4);
   assert.equal(gh.host.successor, 'anna', 'the successor sails in the other team');
   const ids = gh.world.net.humans.map(s => s.id);
   gh.quit();
   assert.ok(room.run(3, () => ga.isHost && gb.info().hostId === 'anna' && gc.info().hostId === 'anna'), 'everybody follows anna');
   assert.deepEqual(room.lost, [[], [], [], []]);
   const aw = ga.world, H = aw.net.humans;
   assert.equal(aw.player.id, ids[1]);
   assert.deepEqual(H.map(s => s.side), ['enemy', 'player', 'enemy', 'player'], 'team 2 is the side player on the new host');
   room.run(2);
   // bert (team 1) still sees the battle from its own side
   const bw = gb.world, bs = H[2];
   assert.equal(bw.player.id, ids[2]);
   assert.equal(bw.player.side, 'player');
   assert.equal(bw._byId.get(ids[1]).side, 'enemy');
   gb.control({ telegraph: 2, rudder: 1, aim: null, lock: null });
   assert.ok(room.run(3, () => bs.telegraph === 2 && bs.rudderCmd === 1), 'bert steers on the new host');
   room.run(1);
   assert.ok(Math.hypot(bw.player.pos.x - bs.pos.x, bw.player.pos.y - bs.pos.y) < 60, 'bert sees its ship where anna has it');
   assert.ok(Math.hypot(gc.world.player.pos.x - H[3].pos.x, gc.world.player.pos.y - H[3].pos.y) < 60, 'cara too');
   // team 1 loses its captains: team 2 wins
   H[0].takeDamage(1e9, H[1], 'pen'); H[2].takeDamage(1e9, H[1], 'pen');
   assert.ok(room.run(30, () => [ga, gb, gc].every(g => g.world.phase !== 'playing')), 'every world ended');
   assert.equal(aw.phase, 'won');
   assert.equal(gc.world.phase, 'won');
   assert.equal(bw.phase, 'lost');
   assert.equal(bw.result.pvp.my, 1);
   assert.equal(bw.result.pvp.win, 2);
   assert.equal(aw.result.pvp.win, 2);
});

test('pvp: a captain who leaves does not end the match; bandwidth and encode cost per team', () => {
   const room = pvpRoom({ history: false });
   assert.ok(ready(room));
   const [gh, ga, gb, gc] = room.games;
   const hw = gh.world;
   const cmd = { telegraph: 4, rudder: 0, aim: { x: 0, y: 0 }, lock: null };
   let k = 0;
   const drive = (g) => {
      const p = g.world.player, foe = g.world.ships.find(s => s.side === 'enemy' && s.alive && s.spotted !== false) || p;
      cmd.aim.x = foe.pos.x + Math.sin(k * 0.05) * 200; cmd.aim.y = foe.pos.y + Math.cos(k * 0.031) * 200;
      g.control(cmd);
      if (k % 30 === 0) g.act(['f', cmd.aim.x, cmd.aim.y]);
   };
   room.run(60, () => { k++; for (const g of [ga, gb, gc]) drive(g); });
   for (const g of room.games) g.resetStats();
   room.run(90, () => { k++; for (const g of [ga, gb, gc]) drive(g); });
   const hi = gh.info(), down = [ga, gb, gc].map(g => g.info().kBpsIn);
   // encode cost: one snapshot for everybody (co-op) against one per team
   const dv = new DataView(new ArrayBuffer(8192));
   const N = 2000;
   let t = performance.now();
   for (let i = 0; i < N; i++) encodeShips(dv, hw);
   const one = (performance.now() - t) / N;
   t = performance.now();
   for (let i = 0; i < N; i++) { encodeShips(dv, hw, 'player'); encodeShips(dv, hw, 'enemy'); }
   const two = (performance.now() - t) / N;
   console.log(`[net] pvp 2v2, 3 clients, 90 s: down ${down.map(x => x.toFixed(1)).join(' / ')} kB/s (anna, bert, cara), host out ${hi.kBpsOut.toFixed(1)} kB/s total; ` +
      `snapshot encode ${(one * 1000).toFixed(1)} µs shared vs ${(two * 1000).toFixed(1)} µs for both teams`);
   assert.ok(down.every(x => x < 30), 'downstream ' + down);
   // anna leaves: the AI sails her ship, the match goes on
   ga.quit();
   room.run(2);
   assert.equal(hw.phase, 'playing');
   assert.equal(hw.net.humans[1].human, false);
   assert.equal(gc.world.phase, 'playing');
});

// ---------------------------------------------------------------- carriers
const AIRDT = 1 / 60;
// a carrier battle in singleplayer form: the player sails an Essex (carriers on both sides)
function cvWorld(seed = 3) {
   const w = new World('normal', { mission: 'standard', ship: 'Essex', seed });
   w.phase = 'playing';
   return w;
}
const ownCv = (w) => w.player;
const foeCv = (w) => w.ships.find(s => s.side === 'enemy' && s.air);
function launched(w, cv, type) {
   cv.air.deckT = 0;
   const q = launchSquadron(w, cv, type, null, true);
   assert.ok(q, 'launched ' + type);
   return q;
}

test('carrier codec: one entry per squadron, quantized, round trip; own detail carries hangars and fuel', () => {
   const w = cvWorld();
   const me = ownCv(w), foe = foeCv(w);
   assert.ok(me.air && foe, 'carriers on both sides');
   const tb = launched(w, me, 'tb'), ft = launched(w, me, 'ft'), db = launched(w, foe, 'db');
   for (let i = 0; i < 6 * 60; i++) w.update(AIRDT);
   orderPatrol(w, ft, { x: 1234.4, y: -987.6 });
   tb.aiming = true; tb.aimT = 1.25; tb.human = true; tb.want = tb.heading + 0.4;
   db.visible = true;                               // seen by the player team
   const dv = new DataView(new ArrayBuffer(8192));
   const end = encodeShips(dv, w, 'player');
   const S = makeSnap();
   assert.ok(decodeSnap(new DataView(dv.buffer, 0, end), S));
   const live = w.squadrons.filter(q => q.n > 0 && q.state !== 'land' && squadVisibleTo(q, 'player'));
   assert.equal(S.nq, live.length);
   assert.ok(S.nq >= 3, 'squadrons in the snapshot: ' + S.nq);
   const ang = (a, b) => Math.abs(((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
   for (const q of live) {
      const i = Array.from(S.qid.subarray(0, S.nq)).indexOf(q.id);
      assert.ok(i >= 0, 'squadron ' + q.id + ' listed');
      const b = S.qb[i];
      assert.equal(S.qown[i], q.ownerId);
      assert.equal(AIR_TYPES[b & 3], q.type);
      assert.equal(SQ_STATES[(b >> 2) & 7], q.state);
      assert.equal(!!(b & 32), q.side === 'enemy');
      assert.equal(!!(b & 64), !!q.aiming);
      assert.equal(!!(b & 128), !!q.human);
      assert.equal(S.qn[i] & 15, q.n);
      assert.equal(S.qn[i] >> 4, q.armed);
      assert.ok(Math.abs(S.qx[i] - q.pos.x) <= 0.5 && Math.abs(S.qy[i] - q.pos.y) <= 0.5, 'position to 1 m');
      assert.ok(ang(S.qh[i], q.heading) < 2e-4 && ang(S.qw[i], q.want) < 2e-4, 'headings');
      assert.ok(Math.abs(S.qalt[i] - q.alt) <= 2.5, 'altitude to 5 m');
      assert.ok(Math.abs(S.qsp[i] - q.speed) <= 1, 'speed to 2 m/s');
      assert.ok(Math.abs(S.qaim[i] - q.aimT) <= 0.025, 'attack run to 0.05 s');
      if (q === ft) assert.ok(S.qc[i] === 1 && Math.abs(S.qcx[i] - 1234) <= 0.5 && Math.abs(S.qcy[i] + 988) <= 0.5, 'patrol point');
      else assert.equal(S.qc[i], 0);
   }
   // size: 21 bytes a flight (+4 with a patrol point)
   const bytes = live.length * SQ_BYTES + 4 * live.filter(q => q.type === 'ft' && q.center).length;
   const all = w.squadrons.slice();
   w.squadrons.length = 0;
   const end0 = encodeShips(dv, w, 'player');
   assert.equal(end - end0, bytes, 'bytes of the squadron section');
   w.squadrons.push(...all);
   // own detail: hangars, deck, service, own flights' fuel / boost / throttle
   tb.fuel = 77.4; tb.boost = 1.5; tb.throttle = -1;
   const o = encodeOwn(dv, 0, me, w);
   const keep = { h: me.air.tb.hangar, d: me.air.deckT };
   me.air.tb.hangar = 99; me.air.deckT = 42;
   assert.ok(decodeOwn(dv, 0, me, w, 0));
   assert.equal(me.air.tb.hangar, keep.h);
   assert.ok(Math.abs(me.air.deckT - keep.d) < 0.01);
   const d = w._sqOwn.get(tb.id);
   assert.ok(d && d[0] === 77 && d[1] === 1.5 && d[2] === -1 && d[3] === tb.n0, 'own squadron detail ' + d);
   assert.ok(!w._sqOwn.has(db.id), 'the enemy\'s flights are not in the own detail');
   assert.ok(o < 400, 'own detail bytes ' + o);
});

test('carrier codec: a team gets only the flights it sees (PvP fog of war)', () => {
   const w = cvWorld();
   const me = ownCv(w), foe = foeCv(w);
   const a = launched(w, me, 'tb'), b = launched(w, foe, 'tb');
   a.visible = true; a.visE = false;               // the player team's flight, unseen by the enemy
   b.visible = false; b.visE = true;               // the enemy's flight, unseen by the player team
   const dv = new DataView(new ArrayBuffer(8192)), S = makeSnap();
   const ids = (side) => { const e = encodeShips(dv, w, side); assert.ok(decodeSnap(new DataView(dv.buffer, 0, e), S)); return Array.from(S.qid.subarray(0, S.nq)); };
   assert.deepEqual(ids('player'), [a.id]);
   assert.deepEqual(ids('enemy'), [b.id]);
   b.visible = true;
   assert.deepEqual(ids('player').sort(), [a.id, b.id].sort());
   // the enemy bit is the host's side: the team-2 client turns it round (codec.localSide)
   ids('enemy');
   assert.equal(!!(S.qb[0] & 32), true);
});

test('carrier commands: only own squadrons, valid types, clamped steering, drops only with a run', () => {
   const w = cvWorld();
   const me = ownCv(w), foe = foeCv(w);
   const bb = w.ships.find(s => s.side === 'player' && !s.air && s.alive);
   assert.equal(execAction(bb, w, ['L', 'tb']), 0, 'no carrier: no launch');
   assert.equal(execAction(me, w, ['L', 'xx']), 0, 'unknown type');
   assert.equal(execAction(me, w, ['L', 'constructor']), 0, 'no prototype keys');
   const q = execAction(me, w, ['L', 'tb']);
   assert.ok(q && q.ownerId === me.id && q.human, 'launched into the captain\'s hands');
   assert.equal(execAction(me, w, ['L', 'tb']), 0, 'one squadron per type');
   assert.equal(execAction(me, w, ['L', 'db']), 0, 'deck busy');
   const other = launched(w, foe, 'tb');
   for (const a of [['P', other.id], ['H', other.id], ['R', other.id], ['W', other.id, 0, 0], ['B', other.id], ['P', 'x'], ['R', null], ['W', q.id, NaN, 0]])
      assert.ok(!execAction(me, w, a), 'refused: ' + JSON.stringify(a));
   assert.ok(!execAction(bb, w, ['R', q.id]), 'another ship cannot recall it');
   // continuous control: wanted heading at most STEER_MAX off, throttle -1 / 0 / 1
   for (let i = 0; i < 15 * 60 && q.state === 'launch'; i++) w.update(AIRDT);
   assert.equal(q.state, 'fly');
   assert.ok(applyAirControl(me, w, [q.id, q.heading + 3, 7, 1]));
   assert.ok(Math.abs(angleDelta(q.heading, q.want)) <= 1.3 + 1e-9, 'steering clamped');
   assert.equal(q.throttle, 1);
   assert.equal(q.aiming, true);
   assert.equal(applyAirControl(me, w, [other.id, 0, 0, 1]), false, 'foreign flight');
   assert.equal(applyAirControl(bb, w, [q.id, 0, 0, 1]), false, 'not a carrier');
   // a snap drop is refused, a held run drops
   assert.equal(execAction(me, w, ['B', q.id]), 0, 'run too short');
   for (let i = 0; i < 2 * 60; i++) { applyAirControl(me, w, [q.id, q.heading, 0, 1]); w.update(AIRDT); }
   assert.ok(execAction(me, w, ['B', q.id]) > 0, 'drop after a held run');
   // hand back: the flight flies on under its pilots; recall turns it home
   assert.ok(execAction(me, w, ['H', q.id]));
   assert.equal(q.human, false);
   assert.ok(q.order, 'bombers keep an order');
   assert.ok(execAction(me, w, ['R', q.id]));
   assert.equal(q.state, 'return');
   assert.ok(!execAction(me, w, ['P', q.id]), 'a returning flight cannot be taken');
   // AA focus for any ship
   assert.ok(execAction(bb, w, ['F', 1]));
   assert.equal(bb.aaFocus, 1);
   assert.ok(!execAction(bb, w, ['F', 'x']));
});

// host: Essex, anna: Essex (a client carrier), bert: Hipper
function cvRoom(o = {}) {
   return makeRoom({ ships: ['Essex', 'Essex', 'Hipper'], ...o });
}
const findSq = (w, id) => w.squadrons.find(q => q.id === id);
// an order as main3d gives it: the host runs it, a client sends it
const order = (g, a) => g.isHost ? execAction(g.world.player, g.world, a) : g.act(a);

test('carriers: a client launches and flies a squadron, everybody sees it, the strike hits, recall', () => {
   const room = cvRoom();
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games;
   const hw = gh.world, A = hw.net.humans[1];
   assert.ok(A.air && ga.world.player.air, 'anna captains a carrier');
   assert.ok(hw.ships.some(s => s.side === 'enemy' && s.air), 'bot carrier on the other side');
   // launch: the replica does not predict it, the host launches into anna's hands
   assert.equal(ga.act(['L', 'tb']), 1);
   assert.ok(room.run(2, () => hw.squadrons.some(q => q.ownerId === A.id && q.type === 'tb')), 'host launched it');
   const hq = hw.squadrons.find(q => q.ownerId === A.id && q.type === 'tb');
   assert.equal(hq.human, true);
   assert.ok(room.run(2, () => findSq(ga.world, hq.id) && findSq(gb.world, hq.id)), 'both clients see it');
   assert.ok(room.run(15, () => hq.state === 'fly'), 'climbed out');
   // the strike: an enemy held still, broadside on, no flak; the flight put in front of it
   const E = hw.ships.find(s => s.side === 'enemy' && s.alive && !s.air && !s.sub && s.type !== 'TR');
   E.ai = { _init: true, passive: true, desired: E.heading, tel: 0, dodged: new Set(), dodgeT: 0, reverseT: 99999, stuckT: 0 };
   E.telegraph = 0; E.speed = 0; E.aa = { range: 0, dps: 0, bands: [] };
   const h = E.heading + Math.PI / 2, gap = 1750 + hq.cfg.speed * 1.4;
   hq.pos.x = E.pos.x - Math.cos(h) * gap; hq.pos.y = E.pos.y - Math.sin(h) * gap; hq.heading = hq.want = h;
   hq.speed = hq.cfg.speed; hq.alt = AIR.cruiseAlt;
   let hits = 0;
   const pe = hw.pushEvent;
   hw.pushEvent = (t, d) => { if (t === 'torp' && d && d.srcId === A.id && d.dstId === E.id) hits++; return pe.call(hw, t, d); };
   const cmd = { telegraph: 0, rudder: 0, aim: null, lock: null, air: null };
   // hold the attack run, then release: the drop rides in the same command as aiming = 0
   cmd.air = [hq.id, h, 0, 1]; ga.control(cmd);
   assert.ok(room.run(3, () => hq.aimT >= AIR.tbAimMin + 0.05), 'the host flies the run: aimT ' + hq.aimT);
   const armed0 = hq.armed;
   cmd.air = [hq.id, h, 0, 0]; ga.control(cmd);
   assert.equal(ga.act(['B', hq.id]), 1);
   assert.ok(room.run(1, () => hq.armed < armed0), 'dropped');
   assert.ok(room.run(1, () => ga.world.torpedoes.some(t => t.air && t.ownerId === A.id)), 'the client runs the aerial torpedoes');
   const ct = ga.world.torpedoes.find(t => t.air), ht = hw.torpedoes.find(t => t.id === ct.id);
   assert.ok(ht && Math.abs(ct.speed - ht.speed) < 1e-6 && ct.range === ht.range, 'with the aerial torpedo\'s speed and range');
   assert.ok(room.run(30, () => hits > 0), 'torpedo hit on the target');
   // recall
   cmd.air = null; ga.control(cmd);
   assert.equal(ga.act(['R', hq.id]), 1);
   assert.ok(room.run(1, () => hq.state === 'return'), 'host: returning');
   assert.ok(room.run(1, () => findSq(ga.world, hq.id)?.state === 'return'), 'client: returning');
   // bert cannot order anna's planes (his replica sends nothing, the host would refuse)
   assert.equal(gb.act(['R', hq.id]), 0);
});

test('carriers: a captain who leaves hands his flight to its pilots; migration carries the air war on', () => {
   const room = cvRoom();
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games;
   const hw = gh.world, A = hw.net.humans[1];
   assert.equal(ga.act(['L', 'db']), 1);
   assert.ok(room.run(2, () => hw.squadrons.some(q => q.ownerId === A.id)));
   // the host launches too
   assert.ok(order(gh, ['L', 'tb']), 'the host launches');
   room.run(10);
   const mine = hw.squadrons.filter(q => q.ownerId === hw.player.id);
   const anna = hw.squadrons.find(q => q.ownerId === A.id);
   assert.ok(mine.length && anna && anna.human, 'flights of host and anna in the air');
   const ids = hw.squadrons.filter(q => q.n > 0 && q.state !== 'land').map(q => q.id).sort((a, b) => a - b);
   // the host leaves: who carries on knows every squadron (the successor is a client)
   gh.quit();
   assert.ok(room.run(5, () => [ga, gb].some(g => g.isHost)), 'a successor took over');
   const nh = [ga, gb].find(g => g.isHost), w = nh.world;
   const now = w.squadrons.map(q => q.id);
   const kept = ids.filter(id => now.includes(id));
   assert.ok(kept.length >= ids.length - 1, 'squadrons carried over: ' + JSON.stringify({ ids, now }));
   for (const q of w.squadrons) assert.ok(q.cfg && q.prev && q.ai, 'full squadron objects');
   const old = w.squadrons.filter(q => q.ownerId === hw.player.id);
   assert.ok(old.every(q => !q.human), 'the old host\'s flights fly on under their pilots');
   room.run(5);
   assert.equal(w.phase, 'playing');
});

test('bandwidth: 7v7 with carriers and squadrons in the air, and the full state for migration', () => {
   const room = cvRoom({ history: false });
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games;
   const hw = gh.world;
   const cvs = hw.ships.filter(s => s.air);
   assert.ok(cvs.some(s => s.side === 'enemy') && cvs.filter(s => s.side === 'player').length >= 2, 'carriers: ' + cvs.map(s => s.cls + '/' + s.side));
   const cmd = { telegraph: 4, rudder: 0, aim: { x: 0, y: 0 }, lock: null, air: null };
   let k = 0, flyId = null;
   const drive = (g) => {
      const p = g.world.player, foe = g.world.ships.find(s => s.side === 'enemy' && s.alive) || p;
      cmd.aim.x = foe.pos.x + Math.sin(k * 0.05) * 200; cmd.aim.y = foe.pos.y + Math.cos(k * 0.031) * 200;
      cmd.air = null;
      if (g === ga) {
         // anna flies her torpedo bombers: the stick moves every frame
         const q = g.world.squadrons.find(q => q.ownerId === p.id && q.type === 'tb' && q.state !== 'return');
         flyId = q ? q.id : null;
         if (q) cmd.air = [q.id, q.heading + Math.sin(k * 0.02) * 0.6, k % 400 < 100 ? 1 : 0, 0];
      }
      g.control(cmd);
      if (k % 30 === 0 && !p.air) order(g, ['f', cmd.aim.x, cmd.aim.y]);
      // carriers keep every type in the air; the flights not flown by hand go to their pilots
      if (p.air && k % 120 === 0) {
         for (const t of ['tb', 'db', 'ft']) order(g, ['L', t]);
         for (const q of g.world.squadrons) if (q.ownerId === p.id && q.human && q.id !== flyId && q.state !== 'launch') order(g, ['H', q.id]);
      }
   };
   room.run(60, () => { k++; drive(ga); drive(gb); drive(gh); });
   for (const g of room.games) g.resetStats();
   const mig0 = gh.host.migStats();
   let sq = 0, n = 0, maxSq = 0;
   const S = makeSnap(), tp = room.tps[0], send = tp.send.bind(tp);
   let snapBytes = 0, snaps = 0;
   tp.send = (ch, data, dst) => {
      if (ch === 'snap' && dst === 'anna') { snapBytes += data.byteLength; snaps++; }
      return send(ch, data, dst);
   };
   room.run(120, () => { k++; drive(ga); drive(gb); drive(gh); const m = hw.squadrons.length; sq += m; n++; if (m > maxSq) maxSq = m; });
   tp.send = send;
   const hi = gh.info(), ai = ga.info();
   const mig = { bytes: hi.mig.bytes - mig0.bytes, count: hi.mig.count - mig0.count };
   const full = JSON.stringify(packWorld(hw, { pl: [] })).length;
   console.log(`[net] carriers 7v7, 2 clients, 120 s: mean squadrons in the air ${(sq / n).toFixed(1)} (max ${maxSq}), down ${ai.kBpsIn.toFixed(1)} kB/s per client ` +
      `(snapshots ${(snapBytes / snaps).toFixed(0)} B each, ${(snapBytes / 120 / 1000).toFixed(1)} kB/s), up ${ai.kBpsOut.toFixed(2)} kB/s, host out ${hi.kBpsOut.toFixed(1)} kB/s total; ` +
      `migration full state ${(mig.bytes / mig.count / 1000).toFixed(1)} kB each (now ${(full / 1000).toFixed(1)} kB)`);
   assert.ok(sq / n >= 3, 'squadrons in the air: ' + (sq / n));
   assert.ok(ai.kBpsIn < 40, 'downstream within 1.5x of the 26.7 kB/s budget: ' + ai.kBpsIn.toFixed(1));
   assert.ok(ai.kBpsOut < 5, 'upstream ' + ai.kBpsOut.toFixed(2));
   assert.ok(mig.bytes / mig.count < 16000 && full < 16000, 'full state under 16 kB');
   assert.ok(Math.abs(ai.snapHz - 60 / SNAP_EVERY) < 1.5, 'snapshot rate ' + ai.snapHz);
   void flyId;
});

// PvP: host + bert (team 1) against anna + cara (team 2), carriers on both teams
test('pvp carriers: a team never gets a hostile flight it has not spotted; its own flights always', () => {
   const names = ['host', 'anna', 'bert', 'cara'], ships = ['Essex', 'Akagi', 'Z23', 'Hipper'], teams = [1, 2, 1, 2];
   const players = names.map((id, i) => ({ id, name: 'Kapitän ' + id, ship: ships[i], team: teams[i] }));
   const room = makeRoom({ names, players, mode: 'pvp' });
   assert.ok(ready(room));
   const [gh, ga] = room.games;
   const hw = gh.world, H = hw.net.humans;
   assert.ok(H[0].air && H[1].air && H[1].side === 'enemy');
   const bad = [], seenFoe = { anna: 0, host: 0 }, own = { anna: 0 };
   const tp = room.tps[0], send = tp.send.bind(tp), S = makeSnap();
   tp.send = (ch, data, dst) => {
      if (ch === 'snap' && dst === 'anna' && decodeSnap(new DataView(data.buffer, data.byteOffset, data.byteLength), S)) {
         for (let i = 0; i < S.nq; i++) {
            const q = squadById(hw, S.qid[i]);
            if (!q) continue;
            if (q.side === 'player') { seenFoe.anna++; if (!q.visE) bad.push(q.id); }
            else if (q.ownerId === H[1].id) own.anna++;
         }
      }
      return send(ch, data, dst);
   };
   assert.ok(order(gh, ['L', 'ft'])); ga.act(['L', 'tb']);
   room.run(10);
   assert.ok(order(gh, ['L', 'tb'])); ga.act(['L', 'ft']);
   room.run(2);
   // the host's fighters wait where no ship or plane of team 2 is near (seen: air.seeByShip / seeByPlane)
   const far = hw.squadrons.find(q => q.ownerId === H[0].id && q.type === 'ft');
   assert.ok(far, 'host fighters up');
   const A = hw.arena;
   let spot = null;
   for (let x = -A; x <= A && !spot; x += 1000) for (let y = -A; y <= A && !spot; y += 1000) {
      const p = { x, y };
      if (hw.ships.every(s => s.side !== 'enemy' || !s.alive || Math.hypot(s.pos.x - x, s.pos.y - y) > AIR.seeByShip + 3000)
         && hw.squadrons.every(q => q.side !== 'enemy' || Math.hypot(q.pos.x - x, q.pos.y - y) > AIR.seeByPlane + 3000)) spot = p;
   }
   assert.ok(spot, 'a quiet corner');
   let hidden = 0, farSent = 0, held = 0;
   const keep = () => { far.pos.x = spot.x; far.pos.y = spot.y; far.prev.x = spot.x; far.prev.y = spot.y; };
   const spy = tp.send;
   tp.send = (ch, data, dst) => {
      if (ch === 'snap' && dst === 'anna' && held > 2 && decodeSnap(new DataView(data.buffer, data.byteOffset, data.byteLength), S))
         for (let i = 0; i < S.nq; i++) if (S.qid[i] === far.id) farSent++;
      return spy(ch, data, dst);
   };
   room.run(20, () => { if (far.n > 0) { keep(); held++; } for (const q of hw.squadrons) if (q.side === 'player' && !q.visE) hidden++; });
   assert.equal(farSent, 0, 'the hidden flight never went to team 2');
   // flown over anna's carrier, it is seen and sent
   const B = H[1];
   spot = { x: B.pos.x + 2000, y: B.pos.y };
   assert.ok(room.run(3, () => { if (far.n > 0) keep(); return farSent > 0; }), 'seen over team 2, sent to team 2');
   tp.send = send;
   assert.deepEqual(bad, [], 'hostile flights sent unseen');
   assert.ok(own.anna > 0, 'anna gets her own flights');
   assert.ok(hidden > 0, 'team 1 flew unseen by team 2 at some point');
   // anna's replica: her flights are hers ('player'), the host's are the enemy's
   const aw = ga.world;
   assert.ok(aw.squadrons.some(q => q.ownerId === H[1].id && q.side === 'player'), 'anna\'s flights are hers on her replica');
   for (const q of aw.squadrons) { const s = aw.shipById(q.ownerId); if (s) assert.equal(q.side, s.side); }
   console.log(`[net] pvp carriers: hostile flight entries anna saw ${seenFoe.anna}, own ${own.anna}, team-1 flight-ticks hidden from team 2 ${hidden}`);
});
