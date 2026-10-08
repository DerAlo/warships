// Co-op, historical operations: a human captain takes over the very ship the mission built for an
// allied bot. Missions strip those bots (east: empty cruise-missile cells, Red Sea: a thin air-defence
// magazine, reduced damage) so that the bots do not decide the battle; a captain gets the full load
// of his class, on every peer, and the AI holds the cruise missiles back again when he leaves.
// Exception: in the countdown the group shares the mission's allotment of cruise missiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNetWorld, missionSlots } from '../gamev2/net/setup.js';
import { MISSIONS, getMission } from '../gamev2/missions.js';
import { SHIPS } from '../gamev2/config.js';
import { EAST_TUNE } from '../gamev2/missions_east.js';
import { WEST_TUNE } from '../gamev2/missions_west.js';
import { damageSite, siteById } from '../gamev2/sites.js';
import { makeRoom, ready, shipOf, DT } from './v2.netutil.mjs';

const EAST = ['barents', 'reefs', 'strait', 'philsea', 'countdown'];
const build = (id, n, self = 0, difficulty = 'normal') => {
   const def = getMission(id), rec = def.recommendedShip, classes = Array(n).fill(rec);
   return buildNetWorld({ mission: id, difficulty, seed: 101, classes, loadouts: classes.map(() => null), self });
};
const cruise = (s) => { const cw = s.cfg.weapons.cruise; return cw ? s.mag[cw.type] || 0 : null; };

test('co-op operations: every further captain sails with the full magazines of his class and full damage', () => {
   let cells = 0, stripped = 0;
   for (const def of MISSIONS) {
      if (!def.fixedShips) continue;
      const n = missionSlots(def.id);
      if (n < 2) continue;
      for (const difficulty of ['easy', 'normal', 'hard']) {
         const w = build(def.id, n, 0, difficulty);
         assert.equal(w.net.humans.length, n, def.id);
         // countdown: the group shares the mission's allotment of cruise missiles (coop() of the mission), dealt
         // evenly over the captains with cells; every other magazine is the full one of the class
         const shared = def.id === 'countdown' ? w.net.humans.filter(h => cruise(h) != null) : [];
         if (shared.length) {
            const T = EAST_TUNE.countdown[difficulty], sum = shared.reduce((a, h) => a + cruise(h), 0);
            // coopTlam: one value or [two, three, four captains]; a fraction is one missile more in that share of the games
            const c = Array.isArray(T.coopTlam) ? T.coopTlam[n - 2] : T.coopTlam;
            assert.ok(c >= 0 && c <= 3, `countdown ${difficulty}: coopTlam ${c}`);
            assert.ok(sum >= T.tlam + Math.floor(c) && sum <= T.tlam + Math.ceil(c), `countdown ${difficulty}: cruise missiles of the group: ${sum}`);
            for (const h of shared) assert.ok(cruise(h) >= Math.floor(sum / shared.length) && cruise(h) <= Math.ceil(sum / shared.length) && cruise(h) > 0, `countdown ${difficulty}: share of captain ${h.slot}: ${cruise(h)}`);
         }
         for (const h of w.net.humans.slice(1)) {
            const full = { ...(SHIPS[h.cls].mag || {}) };
            if (shared.includes(h)) full[h.cfg.weapons.cruise.type] = cruise(h);
            assert.deepEqual(h.mag, full, `${def.id} ${difficulty}: ${h.cls} of captain ${h.slot}`);
            assert.equal(h.dmgMult, 1, `${def.id} ${difficulty}: damage of ${h.cls}`);
            assert.equal(h.maxHP, SHIPS[h.cls].hp, `${def.id} ${difficulty}: hull of ${h.cls}`);
            if (cruise(h) != null) cells++;
         }
         // the allied bots that stay bots keep what the mission gave them: no cruise missiles in the east
         if (EAST.includes(def.id)) for (const b of w.bots) {
            if (b.side !== 'player' || w.net.humans.includes(b) || cruise(b) == null) continue;
            assert.equal(cruise(b), 0, `${def.id}: the bot ${b.cls} holds no cruise missiles`);
            stripped++;
         }
      }
   }
   assert.ok(cells >= 20, 'captains with cruise-missile cells were checked: ' + cells);
   // with two captains one cruise-missile bot is left in the reefs: the mission still strips it
   for (const b of build('reefs', 2).bots) if (b.side === 'player' && !b.human && cruise(b) != null) { assert.equal(cruise(b), 0); stripped++; }
   assert.ok(stripped > 0, 'a bot with empty cells was seen');
});

test('co-op operations: host and clients build the same ships', () => {
   for (const id of EAST) {
      const n = missionSlots(id), worlds = Array.from({ length: n }, (_, self) => build(id, n, self));
      for (let k = 0; k < n; k++) {
         const a = worlds[0].net.humans[k];
         for (const w of worlds) {
            const b = w.net.humans[k];
            assert.equal(b.id, a.id); assert.equal(b.cls, a.cls);
            assert.deepEqual(b.mag, a.mag, `${id}: captain ${k} as seen by another peer`);
            assert.equal(b.dmgMult, a.dmgMult);
         }
      }
   }
});

test('co-op countdown: the cruise missiles of a further captain count, the mission does not end with the flagship\'s last one', () => {
   const empty = (w) => { const p = w.net.humans[0]; p.mag[p.cfg.weapons.cruise.type] = 0; for (let i = 0; i < 40 * 60 && w.phase === 'playing'; i++) w.update(DT); return w; };
   const solo = empty(build('countdown', 1));
   assert.equal(solo.phase, 'lost');
   assert.match(solo.result.reason, /Keine Marschflugkörper/);
   const duo = empty(build('countdown', 2));
   assert.ok(cruise(duo.net.humans[1]) > 0);
   assert.equal(duo.phase, 'playing', duo.result?.reason);
});

test('co-op reefs over the net: the clients see the full cells; a captain who leaves hands the ship to an AI that holds them back', () => {
   const room = makeRoom({ mission: 'reefs', ships: ['Burke', 'Burke', 'Burke'] });
   assert.ok(ready(room));
   const hw = room.games[0].world;
   room.run(1);
   for (const k of [1, 2]) {
      const hs = hw.net.humans[k], full = SHIPS[hs.cls].mag.tomahawk;
      assert.ok(full > 0, hs.cls);
      for (const g of room.games) assert.equal(shipOf(g.world, hs.id).mag.tomahawk, full, `captain ${k} (${hs.cls}) on a peer`);
   }
   // every site known and in reach: an AI with missiles in the cells would open fire (ai_missile.js)
   for (const s of hw.sites) if (s.side === 'enemy') s.detected = s.targetable = true;
   let launches = 0;
   const push = hw.pushEvent.bind(hw);
   hw.pushEvent = (type, d) => { if (type === 'cruiseLaunch') launches++; return push(type, d); };
   const gone = hw.net.humans[2], before = gone.mag.tomahawk;
   room.games[2].quit(); room.tps[2].leave();
   room.run(2);
   assert.equal(gone.human, false, 'the AI has the ship');
   // the captains who stay hold their fire, so the allied bots stay weapons tight too; the cells of the
   // ship without a captain must stay shut even when the group is free to fire
   hw._script.freeT = 1e9;
   room.run(75);
   assert.equal(hw.phase, 'playing');
   assert.ok(gone.alive);
   assert.equal(gone.ai.passive, false, 'weapons free');
   assert.equal(launches, 0, 'no cruise missile left the group');
   assert.equal(gone.mag.tomahawk, before, 'the cells of the ship without a captain are untouched');
   // he comes back and finds his missiles
   const g = room.rejoin(2, 'bert-2');
   assert.ok(room.run(10, () => g.ready), 'ready after the resync');
   room.run(1);
   assert.equal(gone.human, true);
   assert.equal(shipOf(g.world, gone.id).mag.tomahawk, before);
});

// Balance levers of the co-op game: each is nothing for one captain (tests/v2.coop.balance.mjs measures them).
const heard = (w, re, until) => {
   let at = null;
   const say = w.message.bind(w);
   w.message = (text, level) => { if (at == null && re.test(text)) at = w.time; return say(text, level); };
   for (let i = 0; i < until / DT && w.phase === 'playing' && at == null; i++) w.update(DT);
   return at;
};

test('co-op philsea: the escorts of the Shandong fire earlier at a group of three or more captains', () => {
   for (const difficulty of ['normal', 'hard']) {
      const T = EAST_TUNE.philsea[difficulty];
      assert.ok(T.coopEarly > 0 && T.coopEarly < T.salvoAt - 60, difficulty);
      for (const n of [1, 2, 3, 4]) {
         const at = heard(build('philsea', n, 0, difficulty), /Salve vom Verband der Shandong/, T.salvoAt + 5);
         assert.ok(at != null, `${difficulty}, ${n} captains: the salvo came`);
         assert.ok(Math.abs(at - (T.salvoAt - (n >= 3 ? T.coopEarly : 0))) < 1, `${difficulty}, ${n} captains: salvo at ${at}`);
      }
   }
});

test('co-op reefs: the relief group grows by coopFrig frigates at most from coopFrigFrom captains on, by none for one captain', () => {
   for (const difficulty of ['easy', 'normal', 'hard']) {
      const T = EAST_TUNE.reefs[difficulty];
      assert.ok(T.coopFrig >= 0 && T.coopFrig <= 2 && T.coopFrigHp > 0 && T.coopFrigHp <= 1 && T.coopFrigFrom >= 2 && T.coopFrigFrom <= 4, difficulty);
      for (const n of [1, 2, 3, 4]) {
         const w = build('reefs', n, 0, difficulty), S = w._script;
         for (const id of [S.radarId, ...S.bat]) { const site = siteById(w, id); damageSite(w, site, site.hp + 1, w.player, 'test'); }
         const group = S.relief.map(id => w.shipById(id)), extra = group.slice(T.relief.length);
         assert.equal(extra.length, Math.max(0, Math.min(T.coopFrig, n + 1 - T.coopFrigFrom)), `${difficulty}, ${n} captains: frigates with the relief group`);
         assert.deepEqual(group.slice(0, T.relief.length).map(s => s.cls), T.relief);
         for (const s of extra) { assert.equal(s.cls, 'Typ054A'); assert.ok(s.maxHP < SHIPS.Typ054A.hp * (T.coopFrigHp + 0.01) * w.difficulty.botHP + 1); }
      }
   }
});

test('co-op barents: the battle cruiser has the coopHp hull of the group (two / three / four captains), a single captain the full one', () => {
   for (const difficulty of ['easy', 'normal', 'hard']) {
      const T = EAST_TUNE.barents[difficulty], hull = (n) => { const w = build('barents', n, 0, difficulty), pj = w.shipById(w._script.pjId); assert.equal(pj.hp, pj.maxHP); return pj.maxHP; };
      assert.ok(T.coopHp.length === 3 && T.coopHp.every(k => k > 0.5 && k <= 1.5), difficulty);
      const solo = hull(1);
      for (const n of [2, 3, 4]) assert.equal(hull(n), Math.round(solo * T.coopHp[n - 2]), `${difficulty}: ${n} captains`);
   }
   assert.ok(EAST_TUNE.barents.normal.coopHp[1] < 1);
});

test('co-op strait: the second pack has coopFac boats more against three or more captains only', () => {
   for (const difficulty of ['easy', 'normal', 'hard']) {
      const T = EAST_TUNE.strait[difficulty];
      assert.ok(T.coopFac >= 0 && T.coopFac <= 2, difficulty);
      const pack = (n) => {
         const w = build('strait', n, 0, difficulty), boats = () => w.ships.filter(x => x.side === 'enemy' && x.cls === 'Typ022').length;
         while (w.time < T.w3 - 0.05) w.update(1 / 30);
         const before = boats();
         while (w.time < T.w3 + 0.1) w.update(1 / 30);
         return boats() - before;
      };
      for (const n of [1, 2]) assert.equal(pack(n), T.fac2, `${difficulty}, ${n} captains`);
      assert.equal(pack(3), T.fac2 + T.coopFac, `${difficulty}, 3 captains`);
   }
   assert.ok(EAST_TUNE.strait.normal.coopFac > 0);
});

test('co-op redsea: from wave coopFrom on every launcher fires one missile more at a destroyer with a captain', () => {
   // missiles a wave puts into the launch queue
   const queued = (n, difficulty, k) => { const w = build('redsea', n, 0, difficulty), S = w._script; S.queue.length = 0; S.def.wave(w, S, k); return S.queue.length; };
   for (const difficulty of ['easy', 'normal', 'hard']) {
      const T = WEST_TUNE.redsea[difficulty];
      assert.ok(difficulty === 'easy' ? T.coopFrom >= 9 : T.coopFrom >= 0 && T.coopFrom < 9, difficulty);
      for (let k = 0; k < 9; k++) {
         const solo = queued(1, difficulty, k);
         assert.ok(solo >= 6, `${difficulty}, wave ${k}: ${solo} missiles for one captain`);
         assert.equal(queued(2, difficulty, k) - solo, k >= T.coopFrom ? 3 : 0, `${difficulty}, wave ${k}`);
      }
   }
});

test('co-op special operations (second set): missile boats of the hijack pack, the hull of the ferry, the bastion meter; nothing for one captain', async () => {
   const { SPECIAL_B_TUNE: B } = await import('../gamev2/missions_special_b.js');
   const { World } = await import('../gamev2/state.js');
   const { buildNetWorld } = await import('../gamev2/net/setup.js');
   const net = (mission, difficulty, seed) => buildNetWorld({ mission, difficulty, seed, classes: ['Sachsen', 'Braunschweig'], loadouts: [null, null], self: 0 });
   const armed = (w) => w._script.boats.filter(id => w.shipById(id).mag.kowsar > 0).length;
   for (const difficulty of ['easy', 'normal', 'hard']) {
      const H = B.hijack[difficulty], E = B.evac[difficulty], T = B.bastion[difficulty];
      assert.ok(H.coopMsl >= 0 && H.coopMsl <= H.msl && H.coopWave >= 0, 'hijack ' + difficulty);
      assert.ok(E.coopWave >= 0 && E.coopFerry >= 1 && E.coopFerry <= 1.5, 'evac ' + difficulty);
      assert.ok(T.coop > -0.5 && T.coop < 0.5, 'bastion ' + difficulty);
      for (const seed of [3, 77, 4711]) {
         const solo = new World(difficulty, { mission: 'hijack', ship: 'Sachsen', seed }), duo = net('hijack', difficulty, seed);
         assert.equal(armed(solo), Math.min(H.msl, H.boats), `hijack ${difficulty}: one captain meets every missile boat`);
         const less = armed(solo) - armed(duo);
         assert.ok(less === Math.floor(H.coopMsl) || less === Math.ceil(H.coopMsl), `hijack ${difficulty}: ${less} boats lose their missile`);
         const hull = (w) => w.shipById(w._script.ferryId).maxHP, e1 = new World(difficulty, { mission: 'evac', ship: 'Sachsen', seed });
         assert.equal(hull(net('evac', difficulty, seed)), Math.round(hull(e1) * E.coopFerry), `evac ${difficulty}: hull of the ferry`);
         assert.equal(e1._script.ferryHP, hull(e1));
      }
   }
   // the ship row: only the named flagship class, only inside the table
   for (const difficulty of ['normal', 'hard']) {
      const H = B.hijack[difficulty], n = (ship) => new World(difficulty, { mission: 'hijack', ship, seed: 5 })._script.boats.length;
      assert.equal(n('Sachsen'), H.boats); assert.equal(n('Burke'), H.boats);
      assert.equal(n('Daring'), H.ship.Daring.boats);
      assert.ok(H.ship.Daring.boats - H.boats <= 2 && Object.keys(H.ship).length === 1, difficulty);
   }
});
