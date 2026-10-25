// tests/missions3d.coast.test.mjs — headless tests for the coastal operations (game3d/missions_coast.js)
// and the land targets they use (game3d/sites.js): each one loads on every difficulty with a valid map,
// land targets stand on land, the win and loss paths are reachable, shells hurt the sites, and an
// AI-captained run stays free of exceptions and NaN.  Run: node --test tests/missions3d.coast.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../game3d/state.js';
import { MISSIONS, MISSION_IDS, getMission, opStars } from '../game3d/missions.js';
import { obstacleT } from '../game3d/utils.js';
import { shellOnSite, damageSite, siteById } from '../game3d/sites.js';

const DT = 1 / 60;
const OPS = { vwaffe: 'Warspite', nachtdock: 'Jervis', fjord: 'Bismarck', sturmgeleit: 'Norfolk' };
const byName = (w, n) => w.roster.find(s => s.name === n);
const sink = (s, by) => s.takeDamage(s.hp + 1, by, 'citadel');
const obj = (w, id) => w.mission.objectives.find(o => o.id === id);
const world = (id, diff = 'normal', seed = 3) => new World(diff, { mission: id, seed });
function runTo(w, t) { while (w.phase === 'playing' && w.time < t) w.update(DT); }
const put = (s, z) => { s.pos.x = z.x; s.pos.y = z.y; };
const foes = (w) => w.ships.filter(s => s.alive && s.side === 'enemy');
const onLand = (w, p) => w.obstacles.some(o => obstacleT(o, p) < 1);

test('coast ops: in the catalogue, ops stay contiguous, menu data and fixed ships', () => {
   const firstOp = MISSIONS.findIndex(m => m.group === 'ops');
   assert.ok(MISSIONS.slice(firstOp).every(m => m.group === 'ops'), 'ops are contiguous');
   assert.strictEqual(new Set(MISSION_IDS).size, MISSION_IDS.length, 'unique ids');
   const envs = new Set();
   for (const [id, cls] of Object.entries(OPS)) {
      assert.ok(MISSION_IDS.includes(id), `${id} missing`);
      const m = getMission(id);
      assert.strictEqual(m.group, 'ops');
      assert.deepStrictEqual(m.playableShips, [cls]);
      assert.strictEqual(m.recommendedShip, cls);
      assert.ok(m.name && m.subtitle && m.timeLimit >= 300 && m.timeLimit <= 900, `${id} menu data`);
      assert.ok(m.briefing.length > 120 && m.debrief.length > 120 && m.fleet.own && m.fleet.foe, `${id} briefing/debrief/fleet`);
      assert.ok(m.stars >= 1 && m.stars <= 3 && ['day', 'dawn', 'dusk', 'night'].includes(m.env.time), `${id} stars/env`);
      envs.add(m.env.time + '/' + m.env.weather);
   }
   assert.strictEqual(envs.size, 4, 'every coastal op has its own light and weather');
});

for (const [id, cls] of Object.entries(OPS)) {
   test(`"${id}": valid world on every difficulty (objectives, zones in the arena, ships afloat, sites ashore)`, () => {
      for (const diff of ['easy', 'normal', 'hard']) {
         const w = new World(diff, { mission: id, ship: cls, seed: 5 });
         assert.strictEqual(w.player.cls, cls, `${id} player ship`);
         assert.ok(w.mission.objectives.filter(o => !o.optional).length >= 1, `${id} objectives`);
         assert.ok(w.mission.objectives.filter(o => o.optional).length >= 1, `${id} optional objectives`);
         assert.ok(w.mission.objectives.every(o => o.text && !/undefined|NaN/.test(o.text)), `${id} objective text`);
         for (const z of w.mission.zones) {
            assert.ok(Math.abs(z.x) < w.arena && Math.abs(z.y) < w.arena, `${id} zone ${z.label} inside the arena`);
         }
         for (const s of w.ships) {
            if (s.offMap) continue;
            assert.ok(Math.abs(s.pos.x) < w.arena && Math.abs(s.pos.y) < w.arena, `${id} ${s.name} inside the arena`);
            assert.ok(!onLand(w, s.pos), `${id} ${s.name} spawned on land`);
         }
         for (const S of w.sites) {
            assert.ok(Math.abs(S.x) < w.arena && Math.abs(S.y) < w.arena, `${id} ${S.name} inside the arena`);
            if (S.kind !== 'gate') assert.ok(onLand(w, S), `${id} ${S.name} stands on land`);
            assert.ok(S.h >= 0 && S.hp > 0 && Number.isFinite(S.hp), `${id} ${S.name} ground/hp`);
         }
      }
   });

   test(`"${id}": full AI-captained run ends without exceptions or NaN`, () => {
      const w = world(id, 'normal', 17);
      w.autoPlayer = true;
      const limit = getMission(id).timeLimit;
      runTo(w, limit + 30);
      for (const s of w.roster) {
         assert.ok([s.pos.x, s.pos.y, s.heading, s.speed, s.hp].every(Number.isFinite), `${id} ${s.name} NaN`);
         if (s.alive && !s.offMap) assert.ok(w.obstacles.every(o => obstacleT(o, s.pos) > 0.9), `${id} ${s.name} on land`);
      }
      for (const S of w.sites) assert.ok(Number.isFinite(S.hp), `${id} ${S.name} hp NaN`);
      assert.ok(w.mission.objectives.every(o => !/undefined|NaN/.test(o.text)), `${id} objective text`);
      assert.ok(['won', 'lost'].includes(w.phase), `${id} still ${w.phase} after the time limit`);
      assert.ok(w.result && w.result.reason, `${id} result reason`);
      assert.ok(w.mission.objectives.every(o => o.state !== 'active'), `${id} objectives resolved at the end`);
   });

   test(`"${id}": the player ship sinking loses the mission`, () => {
      const w = world(id);
      sink(w.player, foes(w)[0]);
      w.update(DT);
      assert.strictEqual(w.phase, 'lost');
      assert.strictEqual(opStars(w), 0);
   });
}

for (const id of ['vwaffe', 'nachtdock', 'fjord']) {
   test(`"${id}": a player who does nothing runs out the clock and loses`, () => {
      const w = world(id);
      w.player.setTelegraph(0);
      w.timeLeft = 0; w.update(DT);
      assert.strictEqual(w.phase, 'lost');
      assert.ok(w.mission.objectives.some(o => o.state === 'failed'));
   });
}

test('sites: HE wrecks a ramp, AP is mostly wasted, near misses count less, own side is safe', () => {
   const w = world('vwaffe');
   const ramp = w._script.ramps[0], me = w.player;
   const shell = (ammo, dmg = 3000) => ({ ammo, dmg, side: 'player', ownerId: me.id, shooter: me, kind: 'main' });
   const h0 = ramp.hp;
   assert.strictEqual(shellOnSite(w, shell('HE'), ramp.pos), ramp);
   const he = h0 - ramp.hp;
   assert.ok(Math.abs(he - 1000) < 1, `HE full share (${he})`);
   const h1 = ramp.hp;
   shellOnSite(w, shell('AP'), ramp.pos);
   assert.ok(Math.abs((h1 - ramp.hp) - 300) < 1, 'AP 30 %');
   const h2 = ramp.hp;
   shellOnSite(w, shell('HE'), { x: ramp.x + ramp.r * 1.5, y: ramp.y });
   assert.ok(Math.abs((h2 - ramp.hp) - 400) < 1, 'outer ring 40 %');
   assert.strictEqual(shellOnSite(w, shell('HE'), { x: ramp.x + ramp.r * 3, y: ramp.y }), null, 'a clean miss');
   assert.strictEqual(shellOnSite(w, { ...shell('HE'), side: 'enemy' }, ramp.pos), null, 'no damage to own sites');
   assert.ok(me.stats.dmg > 0, 'credited to the shooter');
   assert.strictEqual(siteById(w, ramp.id), ramp);
});

test('V-2: a launch over the allowance loses, each launch fails the clean sheet', () => {
   const w = world('vwaffe');
   const S = w._script;
   runTo(w, 1);
   const armed = S.ramps.filter(r => r.armed);
   armed[0].countdown = 0.01;
   w.update(DT);
   assert.strictEqual(S.launched, 1);
   assert.strictEqual(obj(w, 'clean').state, 'failed');
   assert.ok(w.events.some(e => e.type === 'rocket'), 'rocket event for the renderer');
   assert.strictEqual(w.phase, 'playing');
   assert.ok(armed[0].armed && armed[0].countdown > 100, `the ramp is fuelled again (${armed[0].armed} ${armed[0].countdown})`);
   for (let i = 0; i < S.maxLaunch; i++) { armed[1 + i].countdown = 0.01; w.update(DT); }
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(obj(w, 'launch').state, 'failed');
});

test('V-2: wrecking every ramp before a launch wins with the clean-sheet star; batteries optional', () => {
   const w = world('vwaffe');
   const S = w._script;
   runTo(w, 1);
   for (const b of S.batteries) damageSite(w, b, b.hp + 1, w.player);
   assert.strictEqual(obj(w, 'batteries').state, 'done');
   for (const r of S.ramps) damageSite(w, r, r.hp + 1, w.player);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'ramps').state, 'done');
   assert.strictEqual(obj(w, 'clean').state, 'done');
   assert.strictEqual(opStars(w), 2, "normal: all optional objectives = 2 stars");
});

test('V-2: hidden ramps are revealed during the operation', () => {
   const w = world('vwaffe');
   const S = w._script;
   const hidden = S.ramps.filter(r => r.hidden);
   assert.strictEqual(hidden.length, 2);
   for (const r of S.ramps) r.countdown = 9999;
   w.player.takeDamage = () => 0;
   runTo(w, 270);
   assert.ok(hidden.every(r => !r.hidden || !r.alive), 'all ramps known by 4:30');
});

test('Dock gate: too slow bounces, a ram at speed sets the fuse and the charge wins (even if she sinks)', () => {
   for (const sinkAfter of [false, true]) {
      const w = world('nachtdock');
      const S = w._script, me = w.player;
      runTo(w, 1);
      put(me, S.front); me.speed = 0;
      w.update(DT);
      assert.ok(!S.rammed, 'no ram when slow');
      me.speed = 20 * 2.6;
      w.update(DT);
      assert.ok(S.rammed, 'rammed at speed');
      assert.strictEqual(obj(w, 'ram').state, 'done');
      assert.ok(S.gate.alive && S.gate.hp < S.gate.maxHp, 'the gate is dented, not gone');
      if (sinkAfter) { sink(me, foes(w)[0]); w.update(DT); }
      else { S.blowT = w.time; w.update(DT); }
      assert.strictEqual(w.phase, 'won', sinkAfter ? 'charge still blows' : 'charge blows');
      assert.ok(!S.gate.alive);
      assert.strictEqual(obj(w, 'blow').state, 'done');
   }
});

test('Fjord: reaching open sea wins, the screen engages when the Tirpitz nears the mouth', () => {
   const w = world('fjord');
   const S = w._script, me = w.player;
   assert.strictEqual(me.name, 'Tirpitz');
   runTo(w, 1);
   assert.ok(!S.engaged);
   put(me, { x: 500, y: 0 });
   w.update(DT); runTo(w, w.time + 1.1);
   assert.ok(S.engaged, 'cruisers attack');
   assert.ok(S.screen.every(s => !s.alive || s.ai.huntId === me.id));
   put(me, S.exit);
   runTo(w, w.time + 1.1);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'escape').state, 'done');
});

test('Storm convoy: the Valiant afloat at the time limit wins, her loss loses, sinking the Hipper scores', () => {
   const w = world('sturmgeleit');
   const S = w._script, bb = byName(w, 'HMS Valiant');
   assert.ok(bb && bb === S.bb && bb.side === 'player');
   runTo(w, 340);
   const hipper = byName(w, 'Admiral Hipper');
   assert.ok(hipper && hipper.alive, 'Hipper wave arrived');
   sink(hipper, w.player);
   w.update(DT);
   assert.strictEqual(obj(w, 'hipper').state, 'done');
   if (w.phase === 'playing') { w.timeLeft = 0; w.update(DT); }
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'valiant').state, 'done');

   const w2 = world('sturmgeleit');
   runTo(w2, 2);
   sink(w2._script.bb, foes(w2)[0] || null);
   w2.update(DT);
   assert.strictEqual(w2.phase, 'lost');
   assert.strictEqual(obj(w2, 'valiant').state, 'failed');
});
