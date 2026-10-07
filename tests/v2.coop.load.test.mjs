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
            assert.equal(sum, T.tlam + T.coopTlam, `countdown ${difficulty}: cruise missiles of the group`);
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
