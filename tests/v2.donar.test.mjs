// The cheat-only railgun ship Donar: stats and guide data, and it sails every mission (the menu's cheat
// offers it everywhere) under the autopilot without throwing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../gamev2/state.js';
import { MISSION_IDS } from '../gamev2/missions.js';
import { SHIPS, shipStats, SHIP_STATS, MISSILES } from '../gamev2/config.js';

test('donar: stats — the strongest gun ship afloat, hypersonic missiles, laser close-in', () => {
   const d = SHIPS.Donar, st = shipStats('Donar');
   assert.ok(st && SHIP_STATS.Donar);
   assert.equal(d.name, 'Donar');
   assert.ok(d.className && d.desc.length > 60, 'German class name and guide text');
   assert.ok(d.main.rail && d.main.range >= 40000);
   assert.equal(d.weapons.ciws.type, 'laser');
   assert.ok(d.weapons.ssm.some(s => s.type === 'blitz'));
   assert.ok(MISSILES.zirkon.cheat, 'the ramps\' missile is not issued to any ship');
   for (const k in SHIPS) if (k !== 'Donar' && SHIPS[k].main) assert.ok(SHIPS[k].main.range < d.main.range, k);
});

test('donar: sails every mission for 25 s under the autopilot without errors', () => {
   for (const id of MISSION_IDS) {
      const w = new World('normal', { mission: id, ship: 'Donar', seed: 7 });
      w.autoPlayer = true;
      for (let i = 0; i < 25 * 60 && w.phase === 'playing'; i++) w.update(1 / 60);
      assert.ok(w.player, id);
   }
});
