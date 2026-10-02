// tests/relay3d.test.mjs — the relayed game room transport (game3d/net/relay.js) over a fake
// broker network that loses, delays, reorders and throttles like the public brokers do.
// Run: node --test tests/relay3d.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBusLobby, makeRoomTransport } from '../game3d/net/relay.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
   const t0 = Date.now();
   while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(20); }
}

// brokers: [{ loss, delay, jitter, gap, limit }] — limit: messages per second a connection may
// publish, the rest is dropped silently (what broker.emqx.io does)
function makeNet(brokers) {
   const buses = [];
   const net = {
      brokers, published: brokers.map(() => 0),
      bus() {
         const subs = new Map(), sentAt = brokers.map(() => []);
         const bus = {
            size: brokers.length, watch: new Set(), down: new Set(),
            gap: (i) => brokers[i].gap || 0,
            isOpen: (i) => !bus.down.has(i),
            backlog: () => 0,
            status: () => ({ open: brokers.length - bus.down.size, total: brokers.length }),
            stats: () => brokers.map((b, i) => ({ url: 'fake' + i, open: bus.isOpen(i) })),
            subscribe(topic, fn) { if (!subs.has(topic)) subs.set(topic, new Set()); subs.get(topic).add(fn); },
            unsubscribe(topic, fn) { subs.get(topic)?.delete(fn); },
            publish(i, topic, payload) {
               if (!bus.isOpen(i)) return false;
               const b = brokers[i], t = Date.now();
               net.published[i]++;
               if (b.limit) {
                  const q = sentAt[i];
                  while (q.length && t - q[0] > 1000) q.shift();
                  if (q.length >= b.limit) return true;            // accepted, never forwarded
                  q.push(t);
               }
               for (const other of buses) {
                  if (Math.random() < (b.loss || 0)) continue;
                  const copy = payload.slice();
                  setTimeout(() => { if (other.isOpen(i)) for (const fn of [...(other._subs.get(topic) || [])]) fn(copy, i); }, (b.delay || 0) + Math.random() * (b.jitter || 0));
               }
               return true;
            },
            publishAll(topic, payload) { let n = 0; for (let i = 0; i < brokers.length; i++) if (bus.publish(i, topic, payload)) n++; return n; },
            setOpen(i, open) { if (open) bus.down.delete(i); else bus.down.add(i); for (const fn of [...bus.watch]) fn(i, open); },
            _subs: subs,
         };
         buses.push(bus);
         return bus;
      },
   };
   return net;
}
// fake WebRTC: carriers of one hub see each other once connect() was called
function makeDirectHub() {
   const ends = new Map();
   let up = false;
   return {
      factory: (id) => async (hooks) => {
         ends.set(id, hooks);
         return { send(bytes, to) { if (up && ends.has(to)) { const copy = bytes.slice(); setTimeout(() => { if (up) ends.get(to)?.onData(copy, id); }, 1); } }, leave() { ends.delete(id); } };
      },
      connect() { up = true; for (const [a, h] of ends) for (const b of ends.keys()) if (a !== b) h.onUp(b); },
      disconnect() { up = false; for (const [a, h] of ends) for (const b of ends.keys()) if (a !== b) h.onDown(b); },
   };
}
async function pair(net, o = {}) {
   const joins = { a: [], b: [] }, leaves = { a: [], b: [] };
   const a = await makeRoomTransport({ bus: net.bus(), selfId: 'hostA', room: o.room || 'r1', hostId: 'hostA', key: o.keyA ?? 'k', admit: o.admit, direct: o.hub?.factory('hostA') });
   a.onPeerJoin(id => joins.a.push(id)); a.onPeerLeave(id => leaves.a.push(id));
   const b = await makeRoomTransport({ bus: net.bus(), selfId: 'clientB', room: o.room || 'r1', hostId: 'hostA', key: o.keyB ?? 'k', direct: o.hub?.factory('clientB') });
   b.onPeerJoin(id => joins.b.push(id)); b.onPeerLeave(id => leaves.b.push(id));
   return { a, b, joins, leaves };
}

test('peers meet over the relay and exchange JSON and binary messages', async () => {
   const net = makeNet([{ delay: 5 }, { delay: 20 }]);
   const { a, b, joins } = await pair(net);
   const got = [];
   b.on('evt', (d, from) => got.push([d, from]));
   await until(() => a.peers().length === 1 && b.peers().length === 1, 4000, 'peers');
   assert.deepEqual(joins, { a: ['clientB'], b: ['hostA'] });
   assert.equal(a.link('clientB').via, 'relay');
   a.send('evt', { x: 1 });
   a.send('evt', new Uint8Array([1, 2, 3]), 'clientB');
   await until(() => got.length === 2, 3000, 'messages');
   assert.deepEqual(got[0], [{ x: 1 }, 'hostA']);
   assert.ok(got[1][0] instanceof Uint8Array);
   assert.deepEqual([...got[1][0]], [1, 2, 3]);
   await until(() => a.link('clientB').rtt != null, 4000, 'rtt');
   assert.ok(a.link('clientB').rtt < 200);
   a.leave(); b.leave();
});

test('reliable channels survive loss, reordering and duplicates: everything once, in order', async () => {
   const net = makeNet([{ loss: 0.3, delay: 5, jitter: 80 }, { loss: 0.3, delay: 30, jitter: 60 }]);
   const { a, b } = await pair(net);
   const gotB = [], gotA = [];
   b.on('evt', (d) => gotB.push(d.n)); a.on('evt', (d) => gotA.push(d.n));
   await until(() => a.peers().length === 1 && b.peers().length === 1, 6000, 'peers');
   const N = 300;
   for (let i = 0; i < N; i++) { a.send('evt', { n: i }); b.send('evt', { n: i }); if (i % 10 === 9) await sleep(15); }
   await until(() => gotB.length >= N && gotA.length >= N, 20000, `all messages (${gotA.length}/${gotB.length})`);
   await sleep(300);
   const want = Array.from({ length: N }, (_, i) => i);
   assert.deepEqual(gotB, want);
   assert.deepEqual(gotA, want);
   assert.ok(b.stats().dups > 0, 'duplicates from the second broker were dropped');
   a.leave(); b.leave();
});

test('latest-wins channels are never repeated, never duplicated and never go backwards', async () => {
   const net = makeNet([{ loss: 0.1, delay: 5, jitter: 60 }, { loss: 0.1, delay: 40, jitter: 20 }]);
   const { a, b } = await pair(net);
   const got = [];
   b.on('snap', (d) => got.push(new DataView(d.buffer).getUint32(0)));
   await until(() => a.peers().length === 1 && b.peers().length === 1, 6000, 'peers');
   for (let i = 1; i <= 100; i++) { const s = new Uint8Array(600); new DataView(s.buffer).setUint32(0, i); a.send('snap', s); await sleep(10); }
   await sleep(400);
   // how many get through is chance (10% loss, and the jitter overtakes the 10 ms send interval)
   assert.ok(got.length >= 35 && got.length <= 100, `received ${got.length} of 100`);
   for (let i = 1; i < got.length; i++) assert.ok(got[i] > got[i - 1], 'strictly newer');
   assert.equal(a.stats().resent, 0);
   a.leave(); b.leave();
});

test('a rate-limited broker alone still carries the room (bundling, pacing)', async () => {
   const net = makeNet([{ delay: 20, gap: 130, limit: 10 }]);
   const { a, b } = await pair(net);
   const evt = [], snap = [];
   b.on('evt', (d) => evt.push(d.n)); b.on('snap', (d) => snap.push(d.n));
   await until(() => a.peers().length === 1 && b.peers().length === 1, 6000, 'peers');
   const before = net.published[0], t0 = Date.now();
   for (let i = 0; i < 60; i++) { a.send('snap', { n: i }); if (i % 3 === 0) a.send('evt', { n: i / 3 }); await sleep(50); }
   const secs = (Date.now() - t0) / 1000;
   await until(() => evt.length === 20, 6000, 'reliable messages');
   assert.deepEqual(evt, Array.from({ length: 20 }, (_, i) => i));
   assert.ok(snap.length >= 15, `snapshots thinned to the broker's rate, got ${snap.length}`);
   for (let i = 1; i < snap.length; i++) assert.ok(snap[i] > snap[i - 1]);
   // both peers publish (pings, presence): the host alone must stay under the limit
   assert.ok((net.published[0] - before) / secs < 20, `publish rate ${(net.published[0] - before) / secs}/s`);
   a.leave(); b.leave();
});

test('the route switches to direct and back without losing or reordering reliable messages', async () => {
   const net = makeNet([{ delay: 30, jitter: 30, loss: 0.1 }]);
   const hub = makeDirectHub();
   const { a, b } = await pair(net, { hub });
   const got = [], routes = [];
   b.on('evt', (d) => got.push(d.n));
   a.onRoute((id, via) => routes.push(via));
   await until(() => a.peers().length === 1 && b.peers().length === 1, 6000, 'peers');
   let n = 0;
   const pump = setInterval(() => a.send('evt', { n: n++ }), 10);
   await sleep(400);
   hub.connect();
   await until(() => a.link('clientB').via === 'direct' && b.link('hostA').via === 'direct', 3000, 'direct route');
   await sleep(400);
   hub.disconnect();
   assert.equal(a.link('clientB').via, 'relay');
   await sleep(400);
   clearInterval(pump);
   await until(() => got.length === n, 8000, `all messages (${got.length}/${n})`);
   assert.deepEqual(got, Array.from({ length: n }, (_, i) => i));
   assert.deepEqual(routes, ['direct', 'relay']);
   assert.ok(a.stats().directOut > 10);
   a.leave(); b.leave();
});

test('a broker going away mid-game is covered by the other one', async () => {
   const net = makeNet([{ delay: 5 }, { delay: 40 }]);
   const busA = net.bus();
   const a = await makeRoomTransport({ bus: busA, selfId: 'hostA', room: 'r2', hostId: 'hostA', key: 'k' });
   const b = await makeRoomTransport({ bus: net.bus(), selfId: 'clientB', room: 'r2', hostId: 'hostA', key: 'k' });
   const evt = [], snap = [];
   b.on('evt', (d) => evt.push(d.n)); b.on('snap', (d) => snap.push(d.n));
   await until(() => a.peers().length === 1 && b.peers().length === 1, 6000, 'peers');
   for (let i = 0; i < 40; i++) { if (i === 15) busA.setOpen(0, false); a.send('snap', { n: i }); a.send('evt', { n: i }); await sleep(25); }
   await until(() => evt.length === 40, 6000, 'reliable messages');
   assert.deepEqual(evt, Array.from({ length: 40 }, (_, i) => i));
   assert.ok(snap.filter(x => x > 20).length >= 15, 'snapshots keep flowing over the remaining broker');
   assert.deepEqual(b.peers(), ['hostA']);
   a.leave(); b.leave();
});

test('wrong room key: the peers never see each other; the host gate hides unadmitted peers', async () => {
   const net = makeNet([{ delay: 5 }]);
   const x = await pair(net, { keyA: 'right', keyB: 'wrong', room: 'r3' });
   const y = await pair(net, { room: 'r4', admit: () => false });
   await sleep(1200);
   assert.deepEqual(x.a.peers(), []); assert.deepEqual(x.b.peers(), []);
   assert.ok(x.a.stats().badCrypto > 0);
   assert.deepEqual(y.a.peers(), []);
   for (const t of [x.a, x.b, y.a, y.b]) t.leave();
});

test('leaving is noticed at once, a re-join is a new peer, a vanished peer times out', async () => {
   const net = makeNet([{ delay: 5 }, { delay: 15 }]);
   const { a, b, joins, leaves } = await pair(net, { room: 'r5' });
   await until(() => a.peers().length === 1 && b.peers().length === 1, 4000, 'peers');
   b.leave();
   await until(() => leaves.a.length === 1, 2000, 'leave');
   assert.deepEqual(a.peers(), []);
   await sleep(500);
   assert.deepEqual(a.peers(), [], 'late duplicates of the goodbye do not bring the peer back');
   const got = [];
   const b2 = await makeRoomTransport({ bus: net.bus(), selfId: 'clientB', room: 'r5', hostId: 'hostA', key: 'k' });
   b2.on('evt', (d) => got.push(d.n));
   await until(() => a.peers().length === 1 && b2.peers().length === 1, 5000, 're-join');
   assert.deepEqual(joins.a, ['clientB', 'clientB']);
   a.send('evt', { n: 7 });
   await until(() => got.length === 1, 3000, 'message after re-join');
   assert.deepEqual(got, [7]);
   a.leave(); b2.leave();
});

test('lobby channel: broadcast and addressed messages arrive once per message, not once per broker', async () => {
   const net = makeNet([{ delay: 5 }, { delay: 10 }, { delay: 30 }]);
   const a = makeBusLobby(net.bus(), 'peerA'), b = makeBusLobby(net.bus(), 'peerB'), c = makeBusLobby(net.bus(), 'peerC');
   const gotB = [], gotC = [];
   b.on('list', (d, from) => gotB.push([d, from])); c.on('list', (d, from) => gotC.push([d, from]));
   b.on('knock', (d, from) => gotB.push([d, from])); c.on('knock', (d, from) => gotC.push([d, from]));
   a.send('list', { id: 'g1' });
   a.send('knock', { room: 'g1' }, 'peerB');
   await sleep(200);
   assert.deepEqual(gotB, [[{ id: 'g1' }, 'peerA'], [{ room: 'g1' }, 'peerA']]);
   assert.deepEqual(gotC, [[{ id: 'g1' }, 'peerA']]);
   b.leave(); a.send('list', { id: 'g2' });
   await sleep(100);
   assert.equal(gotB.length, 2);
   a.leave(); c.leave();
});

// ---------------------------------------------------------------- the lobby on top of it
function lobbyBackend(net, selfId) {
   const bus = net.bus();
   return {
      local: false, selfId, bus,
      openLobby: async () => makeBusLobby(bus, selfId),
      openRoom: (id, hostId, key, admit) => makeRoomTransport({ bus, selfId, room: id, hostId, key, admit }),
      status: () => bus.status(),
   };
}
async function lobbyPair(net) {
   const { Lobby, coopMissions } = await import('../game3d/net/lobby.js');
   const profile = () => ({ unlocked: {} });
   const host = new Lobby(lobbyBackend(net, 'hostA'), profile, {}), client = new Lobby(lobbyBackend(net, 'clientB'), profile, {});
   host.name = 'Anna'; client.name = 'Bert';
   await host.open();
   await host.host({ name: 'T', mission: coopMissions()[0].id, max: 2, password: 'pw' });
   await client.open();
   await until(() => client.list().length === 1, 4000, 'listing');
   const entry = client.list()[0];
   await client.join(entry, 'pw');
   await until(() => host.room.players.length === 2, 3000, 'two players');
   return { host, client, entry };
}

test('lobby: leaving and joining again at once works although the goodbye is still on its way', async () => {
   // slow brokers: the knock of the second visit overtakes the goodbye of the first
   const net = makeNet([{ delay: 300 }, { delay: 320 }]);
   const { host, client, entry } = await lobbyPair(net);
   client.leaveRoom();
   await until(() => !!client.lt, 2000, 'lobby open again');
   await client.join(entry, 'pw');
   assert.equal(client.room.players.length, 2);
   await until(() => host.room.players.length === 2, 3000, 'two players again');
   await sleep(800);                                    // every late goodbye has arrived by now
   assert.deepEqual(host.room.players.map(p => p.id), ['hostA', 'clientB']);
   assert.deepEqual(host.rt.peers(), ['clientB']);
   client.close(); host.close();
   await sleep(400);
});

test('lobby: joining again works when the goodbye never arrived (full room, same player)', async () => {
   const net = makeNet([{ delay: 10 }, { delay: 20 }]);
   const { host, client, entry } = await lobbyPair(net);
   client.net.bus.setOpen(0, false); client.net.bus.setOpen(1, false);      // the line drops, nothing gets out
   client.leaveRoom();
   await sleep(700);
   client.net.bus.setOpen(0, true); client.net.bus.setOpen(1, true);
   assert.equal(host.room.players.length, 2, 'the host has not noticed');
   await until(() => !!client.lt, 2000, 'lobby open again');
   await client.join(entry, 'pw');
   await until(() => host.room.players.length === 2 && host.rt.peers().length === 1, 3000, 'two players again');
   assert.equal(client.room.players.length, 2);
   client.close(); host.close();
   await sleep(400);
});
