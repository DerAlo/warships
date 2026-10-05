// Co-op takeover: in a historical operation joining captains get the mission's allied warships,
// ranked by V2 hull types (CG, CV, DD, FF, CO, FAC, SS); transports and scripted ships stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNetWorld, historicShips, RANK } from '../gamev2/net/setup.js';
import { MISSIONS } from '../gamev2/missions.js';
import { SHIPS } from '../gamev2/config.js';

test('RANK covers the V2 warship hull types and not the transport', () => {
   for (const t of ['CG', 'CV', 'DD', 'FF', 'CO', 'FAC', 'SS']) assert.notEqual(RANK[t], undefined, t);
   assert.equal(RANK.TR, undefined);
   assert.ok(RANK.CG < RANK.DD && RANK.DD < RANK.FF && RANK.FF < RANK.CO && RANK.CO < RANK.FAC && RANK.FAC < RANK.SS);
});

test('historicShips: sorted, no transports, no scripted ships (all fixed-ship missions)', () => {
   let withAllies = 0;
   for (const m of Object.values(MISSIONS || {})) {
      if (!m.fixedShips) continue;
      const w = buildNetWorld({ mission: m.id, difficulty: 'normal', seed: 1, classes: [m.playableShips?.[0] || 'Sachsen'], loadouts: [null], names: ['a'], self: 0 });
      const list = historicShips(w);
      for (const b of list) assert.ok(RANK[b.type] !== undefined && b.type !== 'TR' && !(b.ai && (b.ai.passive || b.ai.route)), m.id + ' ' + b.cls);
      for (let i = 1; i < list.length; i++) assert.ok(RANK[list[i - 1].type] <= RANK[list[i].type], m.id + ' order');
      if (list.length) withAllies++;
   }
   assert.ok(withAllies > 0, 'at least one operation has allied warships to hand over');
});
