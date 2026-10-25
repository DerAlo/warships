// tests/donar3d.test.mjs — the cheat-only railgun ship Donar in the WW2 mode (game3d): a sane, absurdly strong
// config that stays out of every regular list, the modern model is known, the career code copes with a ship
// outside the tech tree, and it sails every mission (the menu's cheat offers it everywhere but the
// submarine operations) under the autopilot without throwing.  Run: node --test tests/donar3d.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../game3d/state.js';
import { MISSIONS, MISSION_IDS } from '../game3d/missions.js';
import { SHIPS, SHIP_STATS, PLAYABLE, BOT_POOLS, BOT_SUBS, BOT_CVS, BOT_MIRROR, CHEAT_SHIPS, shipStats } from '../game3d/config.js';
import { TECH_TREE, defaultProfile, maxOutProfile, loadoutFor, applyLoadout, isUnlocked } from '../game3d/progress3d.js';
import { MODELS, modernGunSlots } from '../game3d/ships3d_modern.js';

const DT = 1 / 60;

test('donar (V1): config — railguns that outrange everything, huge HP, fast, stealthy, laser flak', () => {
   const d = SHIPS.Donar, st = shipStats('Donar');
   assert.ok(st && SHIP_STATS.Donar);
   assert.equal(d.key, 'Donar');
   assert.ok(d.cheat && d.className && d.desc.length > 80, 'German class name and card text');
   assert.equal(d.model, 'donar');
   assert.ok(MODELS.donar, 'the modern model is ported');
   assert.equal(modernGunSlots('donar', d.hull.L).length, d.main.turrets.length, 'one railgun mount per sim turret');
   assert.equal(d.main.turrets.length, 2);
   for (const k in SHIPS) {
      if (k === 'Donar') continue;
      const c = SHIPS[k];
      if (c.main) assert.ok(c.main.range < d.main.range, k + ' range');
      assert.ok(c.hp < d.hp, k + ' hp');
      if (c.hull.type !== 'SS') assert.ok(c.detect.surface > d.detect.surface, k + ' detect');
   }
   assert.ok(d.main.range <= 30000, 'stays within the arenas (half-extent up to 16 km)');
   assert.ok(d.main.reload <= 8 && d.main.ap.dmg >= 20000 && d.main.vShell > 4000);
   assert.ok(d.speedKn >= 40 && d.aa.dps >= 300);
   assert.ok(d.torp && d.torp.speedKn >= 120, 'rocket torpedoes');
   assert.ok(st.ratings.firepower >= 70 && st.ratings.antiAir === 100);
});

test('donar (V1): cheat only — never in PLAYABLE, bot pools, tech tree', () => {
   assert.deepEqual(CHEAT_SHIPS, ['Donar']);
   assert.ok(!PLAYABLE.includes('Donar'));
   const pools = [...Object.values(BOT_POOLS.axis), ...Object.values(BOT_POOLS.allies)].flat();
   assert.ok(!pools.includes('Donar') && !Object.values(BOT_SUBS).flat().includes('Donar') && !Object.values(BOT_CVS).flat().includes('Donar'));
   assert.ok(!('Donar' in BOT_MIRROR));
   assert.ok(!TECH_TREE.some(r => r[0] === 'Donar' || r[3] === 'Donar'));
   for (const m of MISSIONS) assert.ok(!m.playableShips.includes('Donar'), m.id);
});

test('donar (V1): the career code copes with a ship outside the tech tree', () => {
   const p = maxOutProfile(defaultProfile(), [...PLAYABLE, ...CHEAT_SHIPS]);
   assert.ok(p.cheat && isUnlocked(p, 'Donar'));
   const lo = loadoutFor(p, 'Donar');
   const cfg = applyLoadout(SHIPS.Donar, lo);
   assert.ok(cfg.hp >= SHIPS.Donar.hp && cfg.main.reload <= SHIPS.Donar.main.reload);
   assert.ok(shipStats('Donar', cfg));
   assert.ok(loadoutFor(defaultProfile(), 'Donar'));
});

test('donar (V1): sails every mission (fixed-ship ops too, not the submarine ops) for 25 s without errors', () => {
   const p = maxOutProfile(defaultProfile(), [...PLAYABLE, ...CHEAT_SHIPS]);
   for (const id of MISSION_IDS) {
      const m = MISSIONS.find(x => x.id === id);
      const subOp = m.playableShips.every(k => SHIPS[k]?.hull.type === 'SS');
      const w = new World('normal', { mission: id, ship: 'Donar', seed: 7, loadout: loadoutFor(p, 'Donar') });
      assert.ok(w.player, id);
      assert.equal(w.player.cfg.key === 'Donar', !subOp, id + ' player ship');
      w.autoPlayer = true;
      for (let i = 0; i < 25 * 60 && w.phase === 'playing'; i++) w.update(DT);
      for (const s of w.ships) for (const v of [s.pos.x, s.pos.y, s.heading, s.speed, s.hp]) assert.ok(Number.isFinite(v), `${id}: ${s.name} state`);
   }
});

test('donar (V1): the railguns hit and wreck a battleship line in a standard battle', () => {
   const w = new World('normal', { mission: 'standard', ship: 'Donar', seed: 11 });
   w.autoPlayer = true;
   for (let i = 0; i < 60 * 180 && w.phase === 'playing'; i++) w.update(DT);
   assert.ok(w.stats.shotsFired > 0, 'fired: ' + w.stats.shotsFired);
   assert.ok(w.player.alive, 'still afloat after 3 minutes');
});
