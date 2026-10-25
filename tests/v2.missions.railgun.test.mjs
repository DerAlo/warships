// Operation "Unternehmen Donnerkeil" (gamev2/missions_special_c.js) and the cheat-only railgun ship Donar:
// registration, ship choice, the moving ramps, the railgun's reach on every ramp position, lose and win paths.
// Balance table: node tests/v2.missions.railgun.captain.mjs 20
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../gamev2/state.js';
import { MISSIONS } from '../gamev2/missions.js';
import { SHIPS, PLAYABLE, PLAYABLE_EAST, BOT_POOLS, CHEAT_SHIPS } from '../gamev2/config.js';
import { RAIL_TUNE } from '../gamev2/missions_special_c.js';
import { NO_COOP, missionSlots } from '../gamev2/net/setup.js';
import { runOnce } from './v2.missions.railgun.captain.mjs';

const def = () => MISSIONS.find(m => m.id === 'railgun');
const mk = (diff = 'normal', seed = 4711, ship = 'Donar', mission = 'railgun') => new World(diff, { mission, ship, seed });
const step = (w, secs) => { for (let i = 0, n = Math.round(secs * 60); i < n && w.phase === 'playing'; i++) w.update(1 / 60); };

test('railgun: the operation is registered for the Donar alone, with texts and tuning', () => {
   const d = def();
   assert.ok(d);
   assert.equal(d.group, 'ops');
   assert.deepEqual(d.playableShips, ['Donar']);
   assert.ok(d.briefing.length > 80 && d.debrief.length > 30);
   for (const k of ['easy', 'normal', 'hard']) assert.ok(RAIL_TUNE.railgun[k], k);
   assert.ok(NO_COOP.railgun, 'no co-op: there is only one Donar');
   assert.equal(missionSlots('railgun'), 0);
});

test('railgun: the Donar is a cheat ship, never in the player lists or bot pools', () => {
   assert.deepEqual(CHEAT_SHIPS, ['Donar']);
   assert.ok(SHIPS.Donar.cheat && SHIPS.Donar.main.rail);
   assert.ok(!PLAYABLE.includes('Donar') && !PLAYABLE_EAST.includes('Donar'));
   assert.ok(!SHIPS.Donar.playable);
   for (const pool of Object.values(BOT_POOLS)) assert.ok(!JSON.stringify(pool).includes('Donar'));
});

test('railgun: the cheat ship sails any mission, except a submarine operation keeps its boat', () => {
   assert.equal(mk('normal', 7, 'Donar', 'hijack').player.cls, 'Donar');
   const sub = MISSIONS.find(m => m.playableShips && m.playableShips.every(k => SHIPS[k].hull.type === 'SS'));
   if (sub) assert.notEqual(mk('normal', 7, 'Donar', sub.id).player.cls, 'Donar');
   // any other ship is replaced by the Donar in its own operation
   assert.equal(mk('normal', 7, 'Sachsen').player.cls, 'Donar');
});

test('railgun: setup — three hidden ramps on the coast, fortress, SAMs, objectives', () => {
   const w = mk();
   const S = w._script;
   assert.equal(w.phase, 'playing');
   assert.equal(S.ramps.length, 3);
   for (const id of S.ramps) {
      const L = w.sites.find(s => s.id === id);
      assert.equal(L.kind, 'launcher');
      assert.ok(!L.detected && !L.targetable, L.name + ' hidden');
   }
   assert.equal(S.fort.length, 4);
   assert.deepEqual(w.mission.objectives.map(o => o.id), ['ramps', 'fort', 'tf', 'ally', 'bunker']);
});

test('railgun: a ramp that fires is located, then changes its position and hides again', () => {
   const w = mk();
   const S = w._script;
   let located = null;
   for (let i = 0; i < 260 * 60 && w.phase === 'playing' && !located; i++) {
      w.update(1 / 60);
      located = S.ramps.map(id => w.sites.find(s => s.id === id)).find(L => L.alive && L.detected) || null;
   }
   assert.ok(located, 'a ramp is located after firing');
   const x0 = located.x, y0 = located.y, i = S.ramps.indexOf(located.id);
   const sp = S.spot[i];
   step(w, RAIL_TUNE.railgun.normal.dwell + 2);
   if (!located.alive || w.phase !== 'playing') return;
   assert.notEqual(S.spot[i], sp, 'next spot');
   assert.ok(Math.hypot(located.x - x0, located.y - y0) > 300, 'moved');
   assert.ok(!located.detected || located.locating, 'hidden after the move (or already firing again)');
});

test('railgun: the railgun reaches every ramp position from the stand-off point', () => {
   for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const w = mk('normal', 11 + i * 3 + j);
      const S = w._script, p = w.player;
      S.timers = []; S.queue = [];
      for (const s of w.ships) if (s !== p) s.alive = false;
      const L = w.sites.find(s => s.id === S.ramps[i]);
      for (const s of w.sites) if (s !== L) s.alive = false;
      const q = S.spots[i][j];
      L.x = L.pos.x = q.x; L.y = L.pos.y = q.y; L.detected = L.targetable = true;
      p.pos.x = -20500; p.pos.y = 2500; p.setTelegraph(0);
      const hp0 = L.hp;
      for (let k = 0; k < 90 * 60 && L.alive && L.hp === hp0; k++) { w.update(1 / 60); p.fireMain(w, { x: L.x, y: L.y }); }
      assert.ok(!L.alive || L.hp < hp0, `ramp ${i} spot ${j} hit`);
   }
});

test('railgun: a passive captain loses', () => {
   const r = runOnce('normal', 1000, 'passive');
   assert.equal(r.win, false, r.reason);
});

test('railgun: a competent captain wins on normal', () => {
   const rs = [1001, 1002, 1003].map(seed => runOnce('normal', seed, 'bot'));
   assert.ok(rs.filter(r => r.win).length >= 2, rs.map(r => `${r.reason} ${r.objs}`).join(' / '));
});
