// Proximity fuse against fast boats (gamev2/combat.js): a 13 m hull has to be hittable with a
// well-aimed gun, and the fuse must not touch anything bigger than a boat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHIPS, WORLD } from '../gamev2/config.js';
import { makeShell, resolveShells } from '../gamev2/combat.js';

function volley(shooterKey, targetKey, R, hdg, n = 600) {
   let seed = 4711;
   const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
   const hits = [];
   const tgt = { id: 2, alive: true, side: 'enemy', depth: 0, pos: { x: R, y: 0 }, heading: hdg, cfg: SHIPS[targetKey],
      takeDamage(d) { hits.push(d); }, ignite() {}, damageModule() {} };
   const shooter = { id: 1, alive: true, side: 'player', heading: 0, pos: { x: 0, y: 0 }, cfg: SHIPS[shooterKey], dmgMult: 1 };
   const world = { rng, ships: [tgt], shells: [], obstacles: [], sites: [], _maxTerrainH: 0, _nextId: 1, env: null, stats: { potential: 0 }, player: null, net: null,
      addEffect() {}, onHit() {}, pushEvent() {}, shakeAdd() {}, shipById() { return shooter; } };
   for (let i = 0; i < n; i++) {
      world.shells.push(makeShell(world, shooter, { x: 0, y: 0 }, { x: R, y: 0 }, shooter.cfg.main, 'main', 'HE'));
      for (let g = 0; world.shells.length && g < 2000; g++) resolveShells(world, WORLD.SIM_DT);
   }
   return { rate: hits.length / n, hits };
}

test('a well-aimed gun hits a fast boat', () => {
   for (const key of ['Sachsen', 'Burke', 'Daring']) {
      for (const hdg of [0, Math.PI / 2]) {
         const { rate } = volley(key, 'Boghammar', 3000, hdg);
         assert.ok(rate > 0.3 && rate < 0.8, `${key} at 3 km, heading ${hdg.toFixed(1)}: ${(rate * 100).toFixed(0)} %`);
      }
   }
});

test('a burst beside the boat does half the damage of a direct hit', () => {
   const { hits } = volley('Burke', 'Boghammar', 3000, Math.PI / 2);
   const full = SHIPS.Burke.main.he.dmg / 3;
   const kinds = new Set(hits.map(d => Math.round(d)));
   assert.deepEqual([...kinds].sort((a, b) => a - b), [Math.round(full / 2), Math.round(full)]);
});

test('the fuse leaves larger hulls alone', () => {
   const { hits } = volley('Burke', 'Mowdsch', 3000, Math.PI / 2, 300);
   const full = Math.round(SHIPS.Burke.main.he.dmg / 3);
   assert.ok(hits.length > 0);
   for (const d of hits) assert.equal(Math.round(d), full);
});
