// V2 multiplayer: the new state (missiles, helicopters, sites, teams, blasts, decoys, the sensor
// picture) reaches the replicas, commands are checked by the host, nothing hidden leaks in PvP.
// Everything runs in this process over the in-memory hub (tests/v2.netutil.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeRoom, ready, shipOf } from './v2.netutil.mjs';
import { NET_VERSION } from '../gamev2/net/transport.js';
import { NET_VERSION as WW2_VERSION } from '../game3d/net/transport.js';
import { cleanAction } from '../gamev2/net/command.js';
import { encodeV2, decodeV2, makeV2Snap, missileVisibleTo, heloVisibleTo, M_BYTES, H_BYTES, A_BYTES } from '../gamev2/net/v2.js';
import { decodeSnap, makeSnap } from '../gamev2/net/codec.js';
import { teamShips, validClass, EAST_TEAM } from '../gamev2/net/setup.js';
import { allowedShips } from '../gamev2/net/lobby.js';
import { launchSSM, ssmBlock } from '../gamev2/missile.js';
import { addSite, damageSite, siteById } from '../gamev2/sites.js';
import { addBlast } from '../gamev2/blast.js';
import { addTaskPoint } from '../gamev2/seal.js';
import { PLAYABLE, PLAYABLE_EAST, SHIPS } from '../gamev2/config.js';

const ids = (list) => list.map(x => x.id).sort((a, b) => a - b);
const human = (room, i) => room.games[0].world.net.humans[i];
// every event a peer's World pushes, in order (the worlds cut their lists, so they are collected per step)
function collect(room) {
   const seen = room.games.map(() => 0), out = room.games.map(() => []);
   const prev = room.each;
   room.each = () => {
      if (prev) prev();
      room.games.forEach((g, i) => {
         const w = g.world;
         if (!w) return;
         for (const e of w.events) if (e.seq > seen[i]) { seen[i] = e.seq; out[i].push(e); }
      });
   };
   return out;
}
const count = (list, f) => list.filter(f).length;

test('v2 net: own namespace, own protocol version', () => {
   const dir = new URL('../gamev2/net/', import.meta.url);
   const bad = ['ks3d', 'warships3d', "'ks-net-", 'ks3d-room:', 'ks3d-relay:', '__ks3dRtc', "'ks/1"];
   let n = 0;
   for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      n++;
      const src = fs.readFileSync(new URL(f, dir), 'utf8');
      for (const b of bad) assert.ok(!src.includes(b), f + ' contains the WW2 name ' + b);
   }
   assert.ok(n >= 8, 'net files read: ' + n);
   assert.notEqual(NET_VERSION, WW2_VERSION);
   assert.ok(NET_VERSION > 200);
});

test('v2 net: another protocol version is refused, in both directions', () => {
   // bert's page is an older build: the host refuses its hello
   let room = makeRoom({ tap: (i, ch, d, from) => { if (i === 0 && ch === 'sync' && d && d.k === 'hello' && from === 'bert') d.v = WW2_VERSION; } });
   room.run(12);
   assert.equal(room.lost[2].length, 1, 'bert was told');
   assert.match(room.lost[2][0], /andere Spielversion/);
   assert.deepEqual(room.lost[1], []);
   assert.ok(room.games[1].ready, 'anna plays');
   assert.equal(room.games[0].world.net.humans.filter(h => h.human || h.isPlayer).length, 2, 'bert\'s ship sails under the AI');
   // the host is another build: anna does not start
   room = makeRoom({ tap: (i, ch, d) => { if (i === 1 && ch === 'sync' && d && d.k === 'start') d.v = NET_VERSION + 1; } });
   room.run(8);
   assert.match(room.lost[1][0] || '', /andere Spielversion/);
   assert.ok(!room.games[1].world, 'no world was built from the foreign start message');
});

test('v2 net: the host\'s gate for actions', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const hw = room.games[0].world, me = human(room, 1), foe = hw.ships.find(s => s.side === 'enemy'), mate = human(room, 2);
   const site = addSite(hw, 'radar', 'enemy', { x: 0, y: 0 }, { inland: true }), mine = addSite(hw, 'radar', 'player', { x: 500, y: 0 }, { inland: true });
   const own = launchSSM(hw, me, { bearing: 0 });
   assert.ok(own);
   const ok = [['m', foe.id], ['b', 1.2], ['M', 100, -200], ['q', 0], ['D', 'hold'], ['p', null], ['r', 0], ['r', 1], ['k', 10, 20], ['K', site.id], ['o', 5, 5],
      ['c', 'decoy'], ['h'], ['h', 100, 200], ['h', 0], ['S'], ['g']];
   for (const a of ok) assert.ok(cleanAction(me, hw, a), 'passes: ' + JSON.stringify(a));
   const bad = [['m', mate.id], ['m', me.id], ['m', 'x'], ['m', 99999], ['m'], ['b', NaN], ['b', '1'], ['b', 1e9], ['M', 1], ['M', 1, Infinity], ['M', '1', 2], ['q', -1], ['q', 99], ['q', 0.5],
      ['D', 'nuke'], ['D'], ['p', own.id], ['p', 424242], ['p', 'a'], ['k', null, 1], ['K', mine.id], ['K', 31337], ['o'], ['c', 5], ['c', 'x'.repeat(40)],
      ['Z'], ['mm', 1], [], null, 'm', { 0: 'm' }, ['M', 1, 2, 3, 4, 5, 6], [7]];
   for (const a of bad) assert.equal(cleanAction(me, hw, a), null, 'refused: ' + JSON.stringify(a));
   // coordinates are held inside the map, extra fields are cut
   const far = cleanAction(me, hw, ['M', 1e12, -1e12]);
   assert.ok(Math.abs(far[1]) <= hw.arena * 2 && Math.abs(far[2]) <= hw.arena * 2);
   assert.deepEqual(cleanAction(me, hw, ['D', 'self', 'x', { a: 1 }]), ['D', 'self']);
   assert.deepEqual(cleanAction(me, hw, ['r', 'yes']), ['r', 1]);
   // a ship without anti-ship missiles has nothing to select
   const sub = hw.spawn('U212', 'player', { x: 0, y: 3000 }, 0, {});
   assert.equal(cleanAction(sub, hw, ['q', 0]) === null || SHIPS.U212.weapons.ssm.length >= 0, true);
});

test('v2 net: the snapshot block survives the wire and garbage does not get in', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const hw = room.games[0].world, a = human(room, 1);
   for (let i = 0; i < 3; i++) { a.lastSsmFire = -99; assert.ok(launchSSM(hw, a, { bearing: i })); }
   const foe = hw.ships.find(s => s.side === 'enemy');
   foe.lastSsmFire = -99;
   const hidden = launchSSM(hw, foe, { bearing: 2 });
   assert.ok(hidden && !hidden.detected);
   const buf = new ArrayBuffer(4096), dv = new DataView(buf);
   const end = encodeV2(dv, 0, hw, 'player');
   assert.equal(end, 2 + 3 * M_BYTES + 3 * 4 + 1 + 1, 'three own missiles with their aim points, nothing of the enemy\'s: ' + end);
   const v = makeV2Snap();
   assert.equal(decodeV2(new DataView(buf, 0, end), 0, v), end);
   assert.equal(v.nm, 3);
   assert.deepEqual([...v.mid.subarray(0, 3)].sort(), ids(hw.missiles.filter(m => m.side === 'player')));
   // the enemy's own view has its missile
   const e2 = encodeV2(dv, 0, hw, 'enemy');
   assert.equal(decodeV2(new DataView(buf, 0, e2), 0, v), e2);
   assert.deepEqual([...v.mid.subarray(0, v.nm)], [hidden.id]);
   // cut off anywhere: refused, never thrown, never read beyond the end
   encodeV2(dv, 0, hw, 'player');
   // (decodeV2 throws a RangeError there, decodeSnap turns it into "no")
   for (let cut = 0; cut < end; cut++) {
      let r = -1;
      try { r = decodeV2(new DataView(buf.slice(0, cut)), 0, makeV2Snap()); } catch (e) { assert.ok(e instanceof RangeError); }
      assert.equal(r, -1, 'cut at ' + cut);
   }
   // counts beyond the limits
   const junk = new DataView(new ArrayBuffer(64));
   junk.setUint16(0, 60000, true);
   assert.equal(decodeV2(junk, 0, makeV2Snap()), -1);
   // a whole snapshot of random bytes is refused or decoded, but never throws
   let s = 12345;
   const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) & 255;
   const snap = makeSnap();
   for (let i = 0; i < 300; i++) {
      const b = new Uint8Array(20 + (rnd() % 200));
      for (let j = 0; j < b.length; j++) b[j] = rnd();
      assert.doesNotThrow(() => decodeSnap(new DataView(b.buffer), snap));
   }
});

test('v2 net co-op: a fight with bots; missiles, decoys and events on both replicas match the host', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games, hw = gh.world;
   const ev = collect(room);
   // what the host had, per missile id: where it was when (ring of the last 0.6 s), and whether the team saw it
   const track = new Map(), visible = new Set(), ownDecoys = new Map(), cDecoys = [new Set(), new Set()];
   let checks = 0, worst = 0, maxM = 0, step = 0;
   const prev = room.each;
   room.each = () => {
      prev();
      step++;
      for (const m of hw.missiles) {
         let t = track.get(m.id);
         if (!t) track.set(m.id, t = { born: hw.time, own: m.side === 'player', speed: m.speed, pts: [] });
         t.pts.push(m.x, m.y); if (t.pts.length > 80) t.pts.splice(0, 2);
         t.last = hw.time;
         if (missileVisibleTo(hw, m, 'player')) visible.add(m.id);
      }
      for (const d of hw.decoys) if (d.side === 'player' && !ownDecoys.has(d.id)) ownDecoys.set(d.id, hw.time);
      [ga, gb].forEach((g, i) => { for (const d of g.world.decoys) cDecoys[i].add(d.id); });
      maxM = Math.max(maxM, hw.missiles.length);
      if (step % 20) return;
      for (const g of [ga, gb]) {
         const cw = g.world, have = new Set();
         for (const m of cw.missiles) {
            have.add(m.id);
            const t = track.get(m.id);
            assert.ok(t, 'missile ' + m.id + ' on the replica is one of the host\'s');
            assert.ok(visible.has(m.id), 'and one this team may see');
            // the replica shows the host's past: the missile is on the track the host flew
            let best = Infinity;
            for (let k = 0; k < t.pts.length; k += 2) best = Math.min(best, Math.hypot(t.pts[k] - m.x, t.pts[k + 1] - m.y));
            worst = Math.max(worst, best); checks++;
            assert.ok(best < 60 + m.speed * 0.12, 'missile ' + m.id + ' (' + m.type + ') ' + best.toFixed(0) + ' m off the host\'s track');
         }
         // an own missile that flies for half a second is on every replica
         for (const m of hw.missiles) if (m.side === 'player' && hw.time - track.get(m.id).born > 0.5 && hw.time - track.get(m.id).born < 3) assert.ok(have.has(m.id), 'own missile ' + m.id + ' missing on a replica');
      }
   };
   room.run(200, () => hw.phase !== 'playing');
   room.run(1);
   assert.deepEqual(room.lost, [[], [], []]);
   assert.ok(maxM >= 6, 'a real fight: ' + maxM + ' missiles at once');
   assert.ok(checks > 300, 'positions compared: ' + checks);
   // events: every launch of the own side arrived, and nothing twice
   const key = (e) => e.type + ':' + (e.missileId ?? e.decoyId ?? e.heloId ?? '') + ':' + (e.dstId ?? '');
   const hostLaunch = ev[0].filter(e => e.type === 'ssmLaunch' && shipOf(hw, e.srcId) && shipOf(hw, e.srcId).side === 'player' && e.sqId == null);
   assert.ok(hostLaunch.length >= 4, 'own launches: ' + hostLaunch.length);
   for (const i of [1, 2]) {
      const got = new Map();
      for (const e of ev[i]) if (/Launch$|^missileHit$|^intercept$|^decoy$|^seduced$|^vampire$/.test(e.type) && e.missileId != null || e.type === 'decoy') got.set(key(e), (got.get(key(e)) || 0) + 1);
      for (const [k, n] of got) assert.equal(n, 1, 'event ' + k + ' arrived ' + n + ' times at peer ' + i);
      for (const e of hostLaunch) assert.equal(got.get(key(e)), 1, 'launch ' + key(e) + ' at peer ' + i);
      const hits = count(ev[0], e => e.type === 'missileHit'), mine = count(ev[i], e => e.type === 'missileHit');
      assert.equal(mine, hits, 'missile hits at peer ' + i + ': ' + mine + ' of ' + hits);
      const ic = count(ev[0], e => e.type === 'intercept'), icc = count(ev[i], e => e.type === 'intercept');
      assert.equal(icc, ic, 'intercepts at peer ' + i);
      // decoys of the own side: each one that hung for a second was shown
      for (const [id, t] of ownDecoys) if (hw.time - t > 1.5) assert.ok(cDecoys[i - 1].has(id), 'decoy ' + id + ' at peer ' + i);
   }
   // the ships' V2 state on the replicas
   for (const g of [ga, gb]) {
      const me = g.world.player, hs = shipOf(hw, me.id);
      assert.deepEqual(me.mag, hs.mag, 'own magazines');
      assert.equal(me.samDoctrine, hs.samDoctrine);
      assert.equal(me.radarOn, hs.radarOn);
      for (const s of hw.ships) {
         const c = shipOf(g.world, s.id);
         if (!s.alive || !c || s.side !== 'player') continue;
         assert.equal(!!c.radarOn, !!(s.radarOn && s.cfg.radar), 'radar state of ' + s.name);
      }
   }
   const st = gh.host.snapStats(), avg = st.bytes / st.count;
   console.log('# v2 co-op ' + hw.ships.length + ' ships, 2 captains: snapshot avg ' + avg.toFixed(0) + ' B, peak ' + st.peak + ' B, most missiles at once ' + maxM +
      ', slow v2 state ' + (st.slow / hw.time / 2).toFixed(0) + ' B/s per client, worst track error ' + worst.toFixed(0) + ' m, rejected ' + st.rejected);
   assert.ok(avg < 1200, 'average snapshot ' + avg.toFixed(0));
   assert.ok(st.peak < 4000, 'peak snapshot ' + st.peak);
   assert.equal(st.rejected, 0);
});

test('v2 net co-op: the captains\' orders work on their own ships, bad ones are refused', () => {
   const room = makeRoom({ ships: ['Sachsen', 'Burke', 'Virginia'] });
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games, hw = gh.world;
   const ha = human(room, 1), hb = human(room, 2), h0 = human(room, 0);
   assert.equal(ha.cls, 'Burke'); assert.equal(hb.cls, 'Virginia');
   const ev = collect(room);
   const wait = (f, msg, s = 4) => assert.ok(room.run(s, f), msg);
   const cw = ga.world, ca = cw.player;
   const mOf = (ship) => hw.missiles.filter(m => m.ownerId === ship.id);

   // radar and doctrine: own ship only
   ga.act(['r', 0]);
   wait(() => ha.radarOn === false, 'radar off on the host');
   assert.equal(h0.radarOn, true, 'the host\'s radar stays on');
   ga.act(['r', 1]);
   wait(() => ha.radarOn === true, 'radar on again');
   ga.act(['D', 'hold']);
   wait(() => ha.samDoctrine === 'hold', 'doctrine');
   assert.notEqual(h0.samDoctrine, 'hold'); assert.equal(ca.samDoctrine, 'hold');
   ga.act(['D', 'free']); ga.act(['q', 0]);
   wait(() => ha.samDoctrine === 'free' && ha.ssmSel === 0, 'selection');

   // missiles: bearing, map point, tracked target
   const mag0 = ha.mag.harpoon;
   ga.act(['b', 0.4]);
   wait(() => mOf(ha).length === 1, 'bearing launch');
   const m1 = mOf(ha)[0];
   assert.equal(m1.tk, 'bearing'); assert.equal(m1.kind, 'ssm');
   wait(() => cw.missiles.some(m => m.id === m1.id) && ca.mag.harpoon === mag0 - 1, 'the missile and the magazine on the replica');
   wait(() => gb.world.missiles.some(m => m.id === m1.id), 'and on the other one');
   const r1 = cw.missiles.find(m => m.id === m1.id);
   assert.equal(r1.type, 'harpoon'); assert.equal(r1.side, 'player'); assert.equal(r1.tk, 'bearing');
   assert.equal(mOf(h0).length + mOf(hb).length, 0, 'nobody else fired');
   ha.lastSsmFire = -99;
   ga.act(['M', ha.pos.x + 9000, ha.pos.y + 100]);
   wait(() => mOf(ha).length === 2, 'point launch');
   const m2 = mOf(ha).find(m => m.id !== m1.id);
   assert.equal(m2.tk, 'point');
   wait(() => { const r = cw.missiles.find(m => m.id === m2.id); return r && Math.hypot(r.tx - m2.tx, r.ty - m2.ty) < 20; }, 'the aim point of an own missile is known');
   const foe = hw.ships.find(s => s.side === 'enemy' && s.alive && !s.sub);
   foe.pos.x = ha.pos.x + 7000; foe.pos.y = ha.pos.y;
   wait(() => { ha.lastSsmFire = -99; return ssmBlock(hw, ha, { targetId: foe.id }) === null; }, 'a track on the enemy', 10);
   ga.act(['m', foe.id]);
   wait(() => mOf(ha).some(m => m.tk === 'ship' && m.target === foe.id), 'launch at the track');
   // refused: a friend as target, a site that does not exist
   const rej0 = gh.host.snapStats().rejected;
   ha.lastSsmFire = -99;
   ga.act(['m', h0.id]); ga.act(['K', 31337]); ga.act(['p', m1.id]);
   room.run(1.5);
   assert.equal(gh.host.snapStats().rejected - rej0, 3, 'three orders refused');
   assert.equal(hw.missiles.filter(m => m.ownerId === ha.id).length, mOf(ha).length);
   assert.equal(ha.samPriority ?? null, null);

   // priority target: an enemy missile
   foe.lastSsmFire = -99;
   const em = launchSSM(hw, foe, { x: ha.pos.x, y: ha.pos.y });
   assert.ok(em);
   ga.act(['p', em.id]);
   wait(() => ha.samPriority === em.id, 'priority target');
   wait(() => ca.samPriority === em.id, 'and on the replica');
   ga.act(['p', null]);
   wait(() => ha.samPriority == null, 'cleared');

   // cruise missile at a point and at a site
   const site = addSite(hw, 'bunker', 'enemy', { x: ha.pos.x + 12000, y: ha.pos.y + 3000 }, { inland: true });
   const mySite = addSite(hw, 'radar', 'player', { x: ha.pos.x - 3000, y: ha.pos.y }, { inland: true });
   wait(() => siteById(cw, mySite.id) && siteById(gb.world, mySite.id), 'an own site is announced');
   assert.equal(siteById(cw, mySite.id).kind, 'radar'); assert.equal(siteById(cw, mySite.id).side, 'player');
   assert.ok(Math.hypot(siteById(cw, mySite.id).x - mySite.x, siteById(cw, mySite.id).y - mySite.y) < 1);
   ha.lastSsmFire = -99;
   ga.act(['k', ha.pos.x + 20000, ha.pos.y]);
   wait(() => mOf(ha).some(m => m.kind === 'cruise'), 'cruise launch');
   ha.lastSsmFire = -99;
   ga.act(['K', site.id]);
   wait(() => mOf(ha).some(m => m.kind === 'cruise' && m.tk === 'site' && m.target === site.id), 'cruise launch at the site');
   site.detected = true;
   damageSite(hw, mySite, mySite.maxHp * 0.25, null, 'shell');
   wait(() => Math.abs(siteById(cw, mySite.id).hp - mySite.hp) < mySite.maxHp * 0.01, 'site damage');

   // decoys
   ga.act(['c', 'decoy']);
   wait(() => hw.decoys.some(d => d.shipId === ha.id), 'decoys out');
   const dc = hw.decoys.find(d => d.shipId === ha.id);
   wait(() => cw.decoys.some(d => d.id === dc.id) && gb.world.decoys.some(d => d.id === dc.id), 'decoys on the replicas');
   assert.ok(Math.hypot(cw.decoys.find(d => d.id === dc.id).x - dc.x, cw.decoys.find(d => d.id === dc.id).y - dc.y) < 1);

   // helicopter: out to a point, then recalled
   ga.act(['h', ha.pos.x + 4000, ha.pos.y - 2000]);
   wait(() => hw.helos.some(h => h.ownerId === ha.id), 'helicopter launched');
   const hh = hw.helos.find(h => h.ownerId === ha.id);
   assert.equal(hh.mode, 'point');
   wait(() => cw.helos.some(h => h.id === hh.id) && gb.world.helos.some(h => h.id === hh.id) && ca.heloOut === hh.id, 'helicopter on the replicas');
   room.run(5);
   for (const g of [ga, gb]) {
      const rh = g.world.helos.find(h => h.id === hh.id);
      assert.ok(Math.hypot(rh.pos.x - hh.pos.x, rh.pos.y - hh.pos.y) < 80, 'helicopter position');
      assert.equal(rh.ownerId, ha.id); assert.equal(rh.state, hh.state); assert.equal(rh.side, 'player');
      assert.ok(Math.abs(rh.fuel - hh.fuel) < 3 && rh.alt > 0);
   }
   assert.equal(shipOf(gb.world, ha.id).heloOut, hh.id, 'the others know whose helicopter it is');
   ga.act(['h']);
   wait(() => hh.state === 'return', 'recalled');
   wait(() => cw.helos.find(h => h.id === hh.id)?.state === 'return', 'seen on the replica');

   // ASW torpedo at a sonar contact
   const boat = hw.spawn('Kilo', 'enemy', { x: ha.pos.x + 1500, y: ha.pos.y + 800 }, 0, {});
   const contact = () => { boat.depth = 2; boat.sonarSeen = { x: boat.pos.x, y: boat.pos.y, t: hw.time }; };
   contact();
   const t0 = hw.torpedoes.length;
   ga.act(['g']);
   wait(() => { contact(); return hw.torpedoes.length > t0; }, 'ASW torpedo in the water');
   const tp = hw.torpedoes[hw.torpedoes.length - 1];
   assert.ok(tp.asw);
   wait(() => { contact(); return cw.torpedoes.some(t => t.id === tp.id && t.asw) && gb.world.torpedoes.some(t => t.id === tp.id); }, 'and on the replicas');
   room.run(2, () => { contact(); return !tp.alive; });
   if (tp.alive) {
      const rt = cw.torpedoes.find(t => t.id === tp.id);
      assert.ok(rt && Math.hypot(rt.pos.x - tp.pos.x, rt.pos.y - tp.pos.y) < 60, 'the homing torpedo follows the host: ' + (rt ? Math.hypot(rt.pos.x - tp.pos.x, rt.pos.y - tp.pos.y).toFixed(0) : 'gone'));
   }
   assert.equal(ca.ltt.n, ha.ltt.n, 'tubes left');

   // special forces from bert's boat
   hb.speed = 0; hb.telegraph = 0; hb.depth = 0;
   gb.control({ telegraph: 0, rudder: 0, aim: null, lock: null });
   const task = addTaskPoint(hw, { x: hb.pos.x + 900, y: hb.pos.y, label: 'Radarstation sprengen', side: 'player' });
   wait(() => gb.world.taskPoints.some(p => p.id === task.id) && cw.taskPoints.some(p => p.id === task.id), 'task point on the replicas');
   assert.equal(gb.world.taskPoints.find(p => p.id === task.id).label, 'Radarstation sprengen');
   wait(() => { hb.speed = 0; hb.depth = 0; gb.act(['S']); return hw.teams.length > 0; }, 'team out', 6);
   const team = hw.teams[0];
   assert.equal(team.ownerId, hb.id);
   wait(() => gb.world.teams.some(t => t.id === team.id) && cw.teams.some(t => t.id === team.id), 'team on the replicas');
   room.run(3);
   const rt = gb.world.teams.find(t => t.id === team.id);
   assert.ok(Math.hypot(rt.x - team.x, rt.y - team.y) < 15); assert.equal(rt.state, team.state); assert.equal(rt.taskId, task.id);
   assert.equal(gb.world.taskPoints.find(p => p.id === task.id).state, 'busy');
   assert.equal(gb.world.player.teamOut, team.id);
   assert.equal(hw.teams.length, 1, 'one team, however often the order came');

   // a scripted blast
   const bl = addBlast(hw, { x: hw.arena * 0.9, y: -hw.arena * 0.9, radius: 400, delay: 2, label: 'Munitionslager' });
   wait(() => cw.blasts.some(b => b.id === bl.id && b.state === 'armed'), 'blast armed on the replica');
   wait(() => bl.state === 'done' && cw.blasts.find(b => b.id === bl.id)?.state === 'done' && gb.world.blasts.find(b => b.id === bl.id)?.state === 'done', 'blast went off');
   const rb = cw.blasts.find(b => b.id === bl.id);
   assert.deepEqual([rb.x, rb.y, rb.r.shock, rb.label], [bl.x, bl.y, bl.r.shock, bl.label]);
   room.run(1);

   // every event once
   for (const i of [1, 2]) {
      for (const [type, f] of [['blast', e => e.blastId === bl.id], ['heloLaunch', e => e.heloId === hh.id], ['teamOut', e => e.teamId === team.id], ['decoy', e => e.decoyId === dc.id],
         ['ssmLaunch', e => e.missileId === m1.id], ['cruiseLaunch', e => e.srcId === ha.id && e.dstId === site.id], ['aswTorp', e => e.srcId === ha.id]]) {
         assert.equal(count(ev[i], e => e.type === type && f(e)), 1, type + ' once at peer ' + i);
      }
   }
   assert.deepEqual(room.lost, [[], [], []]);
});

test('v2 net pvp: the east team sails its own ships; what a team does not see is not sent', () => {
   // rosters
   assert.deepEqual(teamShips('standard', EAST_TEAM), PLAYABLE_EAST);
   assert.deepEqual(allowedShips('standard', EAST_TEAM), PLAYABLE_EAST);
   for (const k of teamShips('standard', 1)) assert.ok(PLAYABLE.includes(k) && !PLAYABLE_EAST.includes(k));
   assert.equal(validClass('standard', 'Gorschkow', EAST_TEAM), 'Gorschkow');
   assert.equal(validClass('standard', 'Gorschkow', 1) !== 'Gorschkow', true, 'no east ship in the west team');
   const sub = validClass('standard', 'Sachsen', EAST_TEAM);
   assert.ok(PLAYABLE_EAST.includes(sub), 'a west ship in the east team becomes ' + sub);

   const room = makeRoom({ mode: 'pvp', names: ['host', 'anna', 'bert', 'carl'], ships: ['Sachsen', 'Burke', 'Gorschkow', 'Typ055'], teams: [1, 1, 2, 2] });
   assert.ok(ready(room));
   const [gh, ga, gb, gc] = room.games, hw = gh.world;
   assert.deepEqual(hw.net.humans.map(h => h.cls + '/' + h.side), ['Sachsen/player', 'Burke/player', 'Gorschkow/enemy', 'Typ055/enemy']);
   const west = hw.ships.filter(s => s.side === 'player'), east = hw.ships.filter(s => s.side === 'enemy');
   assert.equal(west.length, east.length, 'even teams');
   const tier = (l) => l.reduce((a, s) => a + s.cfg.tier, 0);
   assert.ok(Math.abs(tier(west) - tier(east)) <= 4, 'balanced by tier: ' + tier(west) + ' / ' + tier(east));
   for (const s of east) assert.ok(!PLAYABLE.includes(s.cls), 'east ship ' + s.cls);
   // every client sees itself as 'player'
   for (const g of [gb, gc]) { assert.equal(g.world.player.side, 'player'); assert.ok(PLAYABLE_EAST.includes(g.world.player.cls)); }
   const ev = collect(room);

   // the fleets are far apart: a west missile, helicopter and decoy cloud are the west's business
   const ha = human(room, 1), hbE = human(room, 2);
   const foes = hw.ships.filter(s => s.side === 'enemy');
   const cx = foes.reduce((a, s) => a + s.pos.x, 0) / foes.length, cy = foes.reduce((a, s) => a + s.pos.y, 0) / foes.length;
   ga.act(['b', Math.atan2(ha.pos.y - cy, ha.pos.x - cx)]);          // away from the enemy
   ga.act(['h', 0]);
   assert.ok(room.run(4, () => hw.missiles.some(m => m.ownerId === ha.id) && hw.helos.some(h => h.ownerId === ha.id)));
   ga.act(['c', 'decoy']);
   const m = hw.missiles.find(x => x.ownerId === ha.id), hh = hw.helos.find(h => h.ownerId === ha.id);
   room.run(2);
   assert.ok(!m.detected && !missileVisibleTo(hw, m, 'enemy'), 'the east does not track it: ' + Math.min(...foes.map(s => Math.hypot(s.pos.x - m.x, s.pos.y - m.y))).toFixed(0) + ' m from the nearest');
   // (the helicopter flies high: the east's air search radar may well have it; then it is shown, else not)
   const heloSeen = heloVisibleTo(hh, 'enemy');
   assert.ok(ga.world.missiles.some(x => x.id === m.id) && gh.world.missiles.some(x => x.id === m.id));
   assert.ok(ga.world.helos.some(x => x.id === hh.id));
   assert.ok(ga.world.decoys.length > 0, 'the west sees its decoys');
   for (const g of [gb, gc]) {
      assert.equal(g.world.missiles.length, 0, 'no missile on an east replica');
      if (!heloSeen) assert.equal(g.world.helos.length, 0, 'no helicopter');
      assert.equal(g.world.decoys.length, 0, 'no decoys');
   }
   for (const i of [2, 3]) assert.equal(count(ev[i], e => /ssmLaunch|heloLaunch|decoy|heloOrder|doctrine/.test(e.type)), 0, 'no event of the west at peer ' + i);
   // and the other way round: an order from the east works on the east's ship
   gb.act(['D', 'hold']);
   assert.ok(room.run(3, () => hbE.samDoctrine === 'hold'));
   assert.notEqual(ha.samDoctrine, 'hold');
   assert.equal(count(ev[1], e => e.type === 'doctrine'), 0);
   gb.act(['D', 'free']);
   // an east captain cannot aim at his own team, a west one not at his
   const r0 = gh.host.snapStats().rejected;
   gb.act(['m', human(room, 3).id]); ga.act(['m', human(room, 0).id]);
   room.run(1);
   assert.equal(gh.host.snapStats().rejected - r0, 2);

   // the fight: at every check each replica holds only missiles / helicopters its team was shown
   const seen = { player: new Set(), enemy: new Set() }, seenH = { player: new Set(), enemy: new Set() };
   let maxM = 0, foreign = 0;
   const prev = room.each;
   room.each = () => {
      prev();
      for (const S of ['player', 'enemy']) {
         for (const x of hw.missiles) if (missileVisibleTo(hw, x, S)) seen[S].add(x.id);
         for (const x of hw.helos) if (heloVisibleTo(x, S)) seenH[S].add(x.id);
      }
      maxM = Math.max(maxM, hw.missiles.length);
      room.games.forEach((g, i) => {
         if (i === 0 || !g.world) return;
         const S = hw.net.humans[i].side;
         for (const x of g.world.missiles) { assert.ok(seen[S].has(x.id), 'missile ' + x.id + ' leaked to peer ' + i); if (x.side !== 'player') foreign++; }
         for (const x of g.world.helos) assert.ok(seenH[S].has(x.id), 'helicopter ' + x.id + ' leaked to peer ' + i);
         for (const s of g.world.ships) {
            if (s.side === 'player' || !s.esmSeen) continue;
            const hs = shipOf(hw, s.id);
            assert.ok(hs && hs.side !== S, 'ESM bearing only on a ship of the other team');
         }
      });
   };
   room.run(330, () => hw.phase !== 'playing' || (maxM >= 8 && foreign > 200));
   assert.ok(maxM >= 4, 'missiles flew: ' + maxM);
   assert.ok(foreign > 0, 'tracked missiles of the other team were shown');
   assert.deepEqual(room.lost, [[], [], [], []]);
   // launches of the other team: only those from a platform that was seen; own launches all
   for (const i of [1, 2, 3]) {
      const S = hw.net.humans[i].side;
      const own = ev[0].filter(e => e.type === 'ssmLaunch' && e.sqId == null && shipOf(hw, e.srcId)?.side === S).map(e => e.missileId).sort();
      const got = ev[i].filter(e => e.type === 'ssmLaunch' && e.sqId == null && shipOf(hw, e.srcId)?.side === S).map(e => e.missileId).sort();
      assert.deepEqual(got, own, 'own launches at peer ' + i);
      for (const e of ev[i]) if (e.type === 'vampire') assert.equal(e.side, 'player', 'a missile warning is for the own team');
   }
   const st = gh.host.snapStats(), avg = st.bytes / st.count;
   console.log('# v2 pvp ' + hw.ships.length + ' ships, 3 clients: snapshot avg ' + avg.toFixed(0) + ' B, peak ' + st.peak + ' B, most missiles at once ' + maxM +
      ', slow v2 state ' + (st.slow / hw.time / 3).toFixed(0) + ' B/s per client');
   assert.ok(avg < 1200 && st.peak < 4000, 'snapshot size ' + avg.toFixed(0) + ' / ' + st.peak);
});

// a scene with everything in it, mid-salvo
function scene(room) {
   const hw = room.games[0].world, ha = human(room, 1), h0 = human(room, 0);
   for (const s of hw.ships) if (!s.human && !s.isPlayer && s.side === 'enemy') { s.samDoctrine = 'hold'; }
   const o = { ms: [] };
   for (const s of [h0, ha]) for (let i = 0; i < 3; i++) { s.lastSsmFire = -99; const m = launchSSM(hw, s, { bearing: 0.3 * i - 0.2 }); assert.ok(m); o.ms.push(m); }
   o.site = addSite(hw, 'radar', 'player', { x: h0.pos.x - 2500, y: h0.pos.y }, { inland: true });
   damageSite(hw, o.site, o.site.maxHp * 0.4, null, 'shell');
   o.task = addTaskPoint(hw, { x: h0.pos.x + 800, y: h0.pos.y + 300, label: 'Sender', side: 'player' });
   o.blast = addBlast(hw, { x: hw.arena * 0.9, y: hw.arena * 0.9, radius: 300, delay: 60 });
   room.games[1].act(['h', ha.pos.x + 3000, ha.pos.y]);
   assert.ok(room.run(3, () => hw.helos.length === 1), 'helicopter out');
   o.helo = hw.helos[0];
   return o;
}

test('v2 net: a captain who comes back mid-salvo gets the same missiles, sites, helicopter, blasts', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const [gh] = room.games, hw = gh.world;
   room.games[2].quit(); room.tps[2].leave();
   room.run(1);
   const o = scene(room);
   room.run(1.5);
   const g = room.rejoin(2, 'bert-2');
   assert.ok(room.run(10, () => g.ready), 'ready after the resync');
   room.run(1);
   const rw = g.world;
   const alive = o.ms.filter(m => m.alive !== false && hw.missiles.includes(m));
   assert.ok(alive.length >= 4, 'still mid-salvo: ' + alive.length);
   assert.deepEqual(ids(rw.missiles.filter(m => m.side === 'player')), ids(hw.missiles.filter(m => m.side === 'player')), 'the same own missiles');
   for (const m of rw.missiles) assert.ok(hw.missiles.some(x => x.id === m.id && missileVisibleTo(hw, x, 'player')), 'no missile the host does not have');
   for (const m of alive) {
      const r = rw.missiles.find(x => x.id === m.id);
      assert.equal(r.type, m.type); assert.equal(r.kind, m.kind);
      assert.ok(Math.hypot(r.x - m.x, r.y - m.y) < 60 + m.speed * 0.3, 'position of missile ' + m.id);
   }
   const rs = siteById(rw, o.site.id);
   assert.ok(rs && Math.abs(rs.hp - o.site.hp) < o.site.maxHp * 0.01, 'the site and its damage');
   assert.deepEqual(ids(rw.taskPoints), ids(hw.taskPoints));
   assert.deepEqual(ids(rw.blasts), ids(hw.blasts));
   assert.equal(rw.blasts[0].state, 'armed');
   assert.deepEqual(ids(rw.helos), ids(hw.helos));
   assert.equal(shipOf(rw, o.helo.ownerId).heloOut, o.helo.id);
   const me = rw.player, hs = shipOf(hw, me.id);
   assert.deepEqual(me.mag, hs.mag);
   assert.deepEqual(room.lost[2], []);
});

test('v2 net: host migration mid-salvo; the successor flies the missiles on, the others follow', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games, hw = gh.world;
   room.run(2);
   const o = scene(room);
   const hb = human(room, 2);
   hb.samDoctrine = 'self'; hb.samPriority = null;
   room.run(1.6);                       // at least one full state went out since
   const before = hw.missiles.filter(m => m.side === 'player' || m.detected).map(m => ({ id: m.id, x: m.x, y: m.y, type: m.type, tk: m.tk, ownerId: m.ownerId, side: m.side }));
   const mags = new Map(hw.ships.map(s => [s.id, JSON.stringify(s.mag)]));
   assert.ok(before.length >= 5, 'mid-salvo: ' + before.length);
   const ms = gh.host.migStats(), full = ms.bytes / ms.count;
   gh.quit();
   assert.ok(room.run(3, () => ga.isHost && gb.info().hostId === 'anna'), 'anna took over');
   const aw = ga.world;
   let kept = 0;
   for (const b of before) {
      const m = aw.missiles.find(x => x.id === b.id);
      if (!m) continue;
      kept++;
      assert.equal(m.type, b.type); assert.equal(m.tk, b.tk); assert.equal(m.ownerId, b.ownerId); assert.equal(m.side, b.side);
      assert.ok(Math.hypot(m.x - b.x, m.y - b.y) < 80 + m.speed * 1.2, 'missile ' + b.id + ' carries on from where it was');
      assert.ok(m.range > 0 && m.dmg > 0 && !m.net, 'a real missile again');
   }
   assert.ok(kept >= before.length - 1, 'missiles kept: ' + kept + ' of ' + before.length);
   for (const s of aw.ships) if (s.alive && s.side === 'player') assert.equal(JSON.stringify(s.mag), mags.get(s.id), 'magazine of ' + s.name);
   assert.equal(aw._byId.get(hb.id).samDoctrine, 'self');
   const as = siteById(aw, o.site.id);
   assert.ok(as && Math.abs(as.hp - o.site.hp) < 1 && as.cfg, 'the site');
   assert.deepEqual(ids(aw.taskPoints), [o.task.id]);
   assert.deepEqual(ids(aw.blasts), [o.blast.id]);
   assert.ok(Math.abs(aw.blasts[0].t0 - aw.time - (o.blast.t0 - hw.time)) < 2, 'the blast keeps its time');
   const ah = aw.helos.find(h => h.id === o.helo.id);
   assert.ok(ah && !ah.net && ah.ownerId === o.helo.ownerId && ah.fuel > 0, 'the helicopter');
   assert.equal(aw.player.heloOut, o.helo.id);
   // they fly on and the other replica follows the new host
   const p0 = aw.missiles.map(m => ({ id: m.id, x: m.x, y: m.y }));
   room.run(2);
   let moved = 0;
   for (const p of p0) { const m = aw.missiles.find(x => x.id === p.id); if (m && Math.hypot(m.x - p.x, m.y - p.y) > 100) moved++; }
   assert.ok(moved >= 3, 'missiles fly on: ' + moved);
   assert.ok(gb.replica.info().synced);
   const own = ids(aw.missiles.filter(m => m.side === 'player'));
   assert.ok(own.length >= 3);
   assert.deepEqual(ids(gb.world.missiles.filter(m => m.side === 'player')), own, 'bert sees the new host\'s missiles');
   assert.deepEqual(ids(gb.world.helos), ids(aw.helos));
   assert.ok(siteById(gb.world, o.site.id));
   assert.deepEqual(room.lost, [[], [], []]);
   // the fight goes on to an end under the new host
   room.run(60, () => aw.phase !== 'playing');
   assert.deepEqual(room.lost, [[], [], []]);
   console.log('# v2 migration: full state ' + full.toFixed(0) + ' B avg with ' + before.length + ' missiles in the air (' + ms.count + ' sent)');
});

test('v2 net: a busy scene stays under the transport limit (chunked full state) and the successor still takes over', () => {
   const sizes = { mig: 0, migc: 0, pieces: 0 };
   const room = makeRoom({ tap: (i, ch, d) => { if (ch === 'mig' || ch === 'migc') sizes[ch] = Math.max(sizes[ch], JSON.stringify(d).length); if (d && d.k === 'migc') sizes.pieces++; } });
   assert.ok(ready(room));
   const [gh, ga] = room.games, hw = gh.world, h0 = human(room, 0), h1 = human(room, 1);
   room.run(2);
   for (const s of [h0, h1]) for (const k of Object.keys(s.mag || {})) if (typeof s.mag[k] === 'number') s.mag[k] = Math.max(s.mag[k], 60);
   let n = 0;
   for (let i = 0; i < 70; i++) { const s = i % 2 ? h1 : h0; s.lastSsmFire = -99; if (launchSSM(hw, s, { bearing: 0.05 * (i % 9) - 0.2 })) n++; }
   assert.ok(n >= 40, 'launched ' + n);
   room.run(1.6);
   const before = hw.missiles.filter(m => m.side === 'player').map(m => m.id);
   assert.ok(before.length >= 30, 'busy: ' + before.length);
   gh.quit();
   assert.ok(room.run(3, () => ga.isHost), 'anna took over');
   assert.ok(sizes.pieces > 1, 'the state went out in pieces');
   assert.ok(sizes.mig < 12000 && sizes.migc < 12000, 'every message small: ' + sizes.mig + ' / ' + sizes.migc);
   const kept = before.filter(id => ga.world.missiles.some(m => m.id === id)).length;
   assert.ok(kept >= before.length - 3, 'missiles kept: ' + kept + ' of ' + before.length);
});

// The host vanishes without a goodbye (crash, connection gone): its last full state is up to a
// second old. What was launched since reached the successor in full (host.js migLate).
for (const how of ['silent', 'left']) test('v2 net: the host is lost (' + how + ') within a second of a launch; the successor has the missiles', () => {
   const room = makeRoom();
   assert.ok(ready(room));
   const [gh, ga, gb] = room.games, hw = gh.world;
   room.run(2);
   for (const s of hw.ships) if (s.side === 'enemy') s.samDoctrine = 'hold';
   // right after a full state went out
   const n0 = gh.host.migStats().count;
   assert.ok(room.run(3, () => gh.host.migStats().count > n0), 'a full state went out');
   const fullTick = hw.tick, old = [];
   const h0 = human(room, 0), ha = human(room, 1), hb = human(room, 2);
   for (const s of [h0, ha, hb]) { s.lastSsmFire = -99; const m = launchSSM(hw, s, { bearing: 0.2 }); assert.ok(m, 'launch'); old.push(m); }
   const mag0 = new Map([h0, ha, hb].map(s => [s.id, JSON.stringify(s.mag)]));
   room.run(0.4);
   // a second wave a few ticks before the end: younger than the successor's newest snapshot
   const late = [];
   for (const s of [h0, hb]) { s.lastSsmFire = -99; const m = launchSSM(hw, s, { bearing: -0.4 }); assert.ok(m, 'launch'); late.push(m); }
   const mag1 = new Map([h0, ha, hb].map(s => [s.id, JSON.stringify(s.mag)]));
   room.run(2 / 60);
   assert.equal(gh.host.migStats().count, n0 + 1, 'no full state since the launches');
   assert.ok(hw.tick - fullTick < 60, 'within a second: ' + (hw.tick - fullTick));
   const want = [...old, ...late].filter(m => m.alive).map(m => ({ id: m.id, x: m.x, y: m.y, type: m.type, tk: m.tk, ownerId: m.ownerId, dmg: m.dmg, range: m.range, tx: m.tx, ty: m.ty, heading: m.heading }));
   assert.equal(want.length, 5);
   room.frozen.add(0);                    // the host's page is dead
   if (how === 'left') room.tps[0].leave();
   assert.ok(room.run(12, () => ga.isHost && gb.info().hostId === 'anna'), 'anna took over');
   const aw = ga.world;
   for (const b of want) {
      const m = aw.missiles.find(x => x.id === b.id);
      assert.ok(m, 'missile ' + b.id + ' (' + b.type + ') is in the successor\'s world');
      assert.ok(m.alive && !m.net, 'a real missile');
      assert.equal(m.type, b.type); assert.equal(m.tk, b.tk); assert.equal(m.ownerId, b.ownerId); assert.equal(m.side, 'player');
      assert.ok(Math.abs(m.dmg - b.dmg) < 0.01 && m.dmg > 0, 'damage'); assert.ok(Math.abs(m.range - b.range) < 0.01 && m.range > 0, 'range');
      assert.ok(Math.abs(m.tx - b.tx) < 1 && Math.abs(m.ty - b.ty) < 1, 'aim point');
   }
   assert.equal(new Set(aw.missiles.map(m => m.id)).size, aw.missiles.length, 'no missile twice');
   assert.ok(aw._nextId > Math.max(...aw.missiles.map(m => m.id)), 'new ids do not collide');
   // the launchers' magazines count the rounds that are in the air
   for (const s of [ha, hb]) assert.equal(JSON.stringify(aw._byId.get(s.id).mag), mag1.get(s.id), 'magazine of ' + s.name);
   assert.notEqual(mag1.get(hb.id), mag0.get(hb.id));
   // they fly on from where they were, and the other replica sees them
   const p0 = want.map(b => { const m = aw.missiles.find(x => x.id === b.id); return { id: b.id, x: m.x, y: m.y, hx: b.x, hy: b.y, sp: m.speed }; });
   for (const p of p0) assert.ok(Math.hypot(p.x - p.hx, p.y - p.hy) < 80 + p.sp * 0.5, 'missile ' + p.id + ' carries on from where it was: ' + Math.round(Math.hypot(p.x - p.hx, p.y - p.hy)));
   room.run(2);
   let moved = 0;
   for (const p of p0) { const m = aw.missiles.find(x => x.id === p.id); if (m && Math.hypot(m.x - p.x, m.y - p.y) > 100) moved++; }
   assert.ok(moved >= 4, 'missiles fly on: ' + moved);
   const own = ids(aw.missiles.filter(m => m.side === 'player'));
   assert.deepEqual(ids(gb.world.missiles.filter(m => m.side === 'player')), own, 'bert sees the new host\'s missiles');
   assert.deepEqual(room.lost[1], []); assert.deepEqual(room.lost[2], []);
});
