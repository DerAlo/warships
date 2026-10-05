// tests/missions3d.pacific.test.mjs — headless tests for the Pacific operations
// (game3d/missions_pacific.js): Samar, Surigao Strait and Savo Island load on every difficulty with
// a valid map, their objectives progress, the win and the loss paths are reachable, and a short
// AI-captained run stays free of exceptions and NaN.  Run: node --test tests/missions3d.pacific.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../game3d/state.js';
import { MISSIONS, MISSION_IDS, getMission, opStars } from '../game3d/missions.js';
import { obstacleT } from '../game3d/utils.js';

const DT = 1 / 60;
const OPS = { samar: ['Fletcher'], surigao: ['Fletcher', 'Washington'], savo: ['Takao'] };
const byName = (w, n) => w.roster.find(s => s.name === n);
const sink = (s, by) => s.takeDamage(s.hp + 1, by, 'citadel');
const obj = (w, id) => w.mission.objectives.find(o => o.id === id);
const world = (id, diff = 'normal', ship, seed = 3) => new World(diff, { mission: id, ship, seed });
function runTo(w, t) { while (w.phase === 'playing' && w.time < t) w.update(DT); }
function runFor(w, sec) { runTo(w, w.time + sec); }
const put = (s, z) => { s.pos.x = z.x; s.pos.y = z.y; };
const foes = (w) => w.ships.filter(s => s.alive && s.side === 'enemy');
const timeout = (w) => { w.timeLeft = 0; w.update(DT); };

test('pacific ops: catalogue, menu data, ships', () => {
   for (const [id, ships] of Object.entries(OPS)) {
      assert.ok(MISSION_IDS.includes(id), `${id} missing`);
      const m = getMission(id);
      assert.strictEqual(m.group, 'ops');
      assert.deepStrictEqual(m.playableShips, ships);
      assert.ok(ships.includes(m.recommendedShip), `${id} recommended ship`);
      assert.ok(m.briefing.length > 200 && m.debrief.length > 200 && m.fleet.own && m.fleet.foe && m.subtitle, `${id} briefing/debrief/fleet`);
      assert.ok(m.timeLimit >= 8 * 60 && m.timeLimit <= 15 * 60, `${id} time limit`);
      assert.ok(m.stars >= 2, `${id} stars`);
   }
   const firstOp = MISSIONS.findIndex(m => m.group === 'ops');
   assert.ok(MISSIONS.slice(firstOp).every(m => m.group === 'ops'), 'ops are contiguous');
   assert.strictEqual(new Set(MISSION_IDS).size, MISSION_IDS.length, 'unique ids');
});

for (const [id, ships] of Object.entries(OPS)) {
   test(`"${id}": valid world on every difficulty (objectives, zones on open water, nobody on land)`, () => {
      for (const diff of ['easy', 'normal', 'hard']) for (const ship of ships) {
         const w = new World(diff, { mission: id, ship, seed: 5 });
         assert.strictEqual(w.player.cls, ship, `${id} player ship`);
         assert.ok(w.mission.objectives.filter(o => !o.optional).length >= 1, `${id} objectives`);
         assert.ok(w.mission.objectives.filter(o => o.optional).length >= 1, `${id} optional objectives`);
         assert.ok(w.mission.objectives.every(o => o.text && !/undefined|NaN/.test(o.text)), `${id} objective text`);
         for (const z of w.mission.zones) {
            assert.ok(Math.abs(z.x) + z.r < w.arena && Math.abs(z.y) + z.r < w.arena, `${id} zone ${z.label} inside the arena`);
            for (const o of w.obstacles) assert.ok(obstacleT(o, z) > 1.05, `${id} zone ${z.label} on open water`);
         }
         for (const s of w.ships) {
            assert.ok(Math.abs(s.pos.x) < w.arena && Math.abs(s.pos.y) < w.arena, `${id} ${s.name} inside the arena`);
            for (const o of w.obstacles) assert.ok(obstacleT(o, s.pos) > 1, `${id} ${s.name} spawned on land`);
         }
         assert.ok(w.ships.some(s => s.side === 'enemy'), `${id} has enemies`);
         assert.strictEqual(new Set(w.ships.map(s => s.name)).size, w.ships.length, `${id} unique ship names`);
      }
   });

   for (const ship of ships) {
      test(`"${id}" (${ship}): 5 min AI-captained run without exceptions or NaN, late spawns on open water`, () => {
         const w = world(id, 'normal', ship, 17);
         w.autoPlayer = true;
         runTo(w, 300);
         for (const s of w.roster) {
            assert.ok([s.pos.x, s.pos.y, s.heading, s.speed, s.hp].every(Number.isFinite), `${id} ${s.name} NaN`);
            if (s.alive) for (const o of w.obstacles) assert.ok(obstacleT(o, s.pos) > 0.9, `${id} ${s.name} on land`);
         }
         assert.ok(w.mission.objectives.every(o => !/undefined|NaN/.test(o.text)), `${id} objective text`);
         assert.ok(['playing', 'won', 'lost'].includes(w.phase));
      });

      test(`"${id}" (${ship}): the player ship sinking loses the mission`, () => {
         const w = world(id, 'normal', ship);
         sink(w.player, foes(w)[0]);
         w.update(DT);
         assert.strictEqual(w.phase, 'lost');
         assert.strictEqual(opStars(w), 0);
      });
   }

   test(`"${id}": hard difficulty runs two minutes with a passive player`, () => {
      const w = world(id, 'hard', undefined, 23);
      runTo(w, 120);
      assert.ok(['playing', 'lost'].includes(w.phase));
      assert.ok(w.roster.every(s => Number.isFinite(s.hp) && Number.isFinite(s.pos.x)));
   });
}

// ------------------------------------------------------------------------------------- Samar
test('Samar: the third carrier lost ends the mission, two lost are survivable', () => {
   const w = world('samar');
   const S = w._script;
   assert.strictEqual(S.cves.length, 5);
   assert.strictEqual(w.player.name, 'USS Johnston');
   sink(S.cves[0], foes(w)[0]); w.update(DT);
   assert.strictEqual(w.phase, 'playing');
   assert.match(obj(w, 'cves').text, /1 verloren/);
   assert.strictEqual(obj(w, 'one').state, 'active');
   sink(S.cves[1], foes(w)[0]); w.update(DT);
   assert.strictEqual(w.phase, 'playing');
   assert.strictEqual(obj(w, 'one').state, 'failed');
   timeout(w);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(opStars(w), 1);

   const l = world('samar');
   for (const c of l._script.cves.slice(0, 3)) sink(c, foes(l)[0]);
   l.update(DT);
   assert.strictEqual(l.phase, 'lost');
   assert.strictEqual(obj(l, 'cves').state, 'failed');
});

test('Samar: holding out wins; the countdown shows in the objective; reinforcements arrive in stages', () => {
   const w = world('samar');
   const S = w._script;
   // keep everybody afloat: this test is about the script, not the gunnery
   const keep = () => { for (const s of w.ships) if (s.side === 'player') s.hp = s.maxHP; };
   const n0 = foes(w).length;
   while (w.phase === 'playing' && w.time < 160) { keep(); w.update(DT); }
   assert.match(obj(w, 'hold').text, /\d:\d\d/);
   assert.ok(S.flankIn, 'flanking cruisers announced');
   assert.strictEqual(S.cruisers.length, 4);
   assert.ok(byName(w, 'Tone') && byName(w, 'Chikuma'));
   while (w.phase === 'playing' && w.time < 310) { keep(); w.update(DT); }
   assert.ok(w.roster.filter(s => s.side === 'enemy').length >= n0 + 4, 'destroyers joined');
   for (const s of foes(w)) for (const o of w.obstacles) assert.ok(obstacleT(o, s.pos) > 1);
   timeout(w);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'hold').state, 'done');
   assert.strictEqual(obj(w, 'cves').state, 'done');
   assert.ok(opStars(w) >= 1);
});

test('Samar: cruisers sunk or driven off count; all four out after the flank attack ends the pursuit', () => {
   const w = world('samar');
   const S = w._script;
   const keep = () => { for (const s of w.ships) if (s.side === 'player') s.hp = s.maxHP; };
   sink(S.cruisers[0], w.player); w.update(DT);
   assert.match(obj(w, 'out').text, /1\/2/);
   assert.strictEqual(w.phase, 'playing', 'no early win before the flank attack');
   // a battered cruiser turns away and leaves
   const c = S.cruisers[1];
   c.hp = c.maxHP * 0.2;
   const t0 = w.time;
   while (w.phase === 'playing' && c.alive && !c.escaped && w.time < t0 + 90) { keep(); c.hp = Math.min(c.hp, c.maxHP * 0.2); w.update(DT); }
   assert.ok(c.escaped || !c.alive, 'the cruiser left the fight');
   assert.strictEqual(obj(w, 'out').state, 'done');
   assert.strictEqual(w.phase, 'playing');
   while (w.phase === 'playing' && w.time < 152) { keep(); w.update(DT); }
   for (const x of S.cruisers) if (x.alive) sink(x, w.player);
   w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'one').state, 'done');
   assert.strictEqual(opStars(w), 2);
});

test('Samar: the Yamato runs north from the player\'s torpedoes and comes back', () => {
   const w = world('samar');
   const S = w._script, y = S.yam;
   // the script only reads position, side and owner of a torpedo: drive its update directly
   w.update(DT);
   const real = w.torpedoes;
   const fish = (ownerId) => [{ pos: { x: y.pos.x + 800, y: y.pos.y + 800 }, side: 'player', ownerId, alive: true }];
   w.torpedoes = fish(S.screen[0].id);
   S.def.update(w, DT, S);
   assert.strictEqual(S.yamT, undefined, 'torpedoes of the other destroyers do not turn her');
   w.torpedoes = fish(w.player.id);
   S.def.update(w, DT, S);
   assert.strictEqual(S.yamT, w.time);
   assert.ok(y.ai.route && y.ai.route.length === 1 && y.ai.route[0].y < y.pos.y, 'route north');
   w.torpedoes = real;
   const keep = () => { for (const s of w.ships) if (s.side === 'player') s.hp = s.maxHP; };
   while (w.phase === 'playing' && w.time < 82) { keep(); w.update(DT); }
   assert.strictEqual(S.yamT, null);
   assert.strictEqual(y.ai.route, null, 'back in the fight');
});

// ------------------------------------------------------------------------------------- Surigao
for (const ship of OPS.surigao) {
   test(`Surigao (${ship}): both battleships sunk brings Shima; driving him off wins`, () => {
      const w = world('surigao', 'normal', ship);
      const S = w._script;
      assert.strictEqual(w.player.name, ship === 'Washington' ? 'USS West Virginia' : 'USS McDermut');
      assert.strictEqual(w.ships.filter(s => s.side === 'player').length, 8);
      assert.ok(!obj(w, 'shima'));
      const keep = () => { for (const s of w.ships) if (s.side === 'player') s.hp = s.maxHP; };
      sink(S.bbs[0], w.player); w.update(DT);
      assert.match(obj(w, 'bbs').text, /1\/2/);
      sink(S.bbs[1], w.player); w.update(DT);
      assert.strictEqual(obj(w, 'bbs').state, 'done');
      assert.strictEqual(w.phase, 'playing', 'Shima still to come');
      const t0 = w.time;
      while (w.phase === 'playing' && w.time < t0 + 25) { keep(); w.update(DT); }
      assert.ok(S.shimaIn && S.shima.length === 2);
      assert.ok(obj(w, 'shima'), 'new objective');
      for (const s of S.shima) for (const o of w.obstacles) assert.ok(obstacleT(o, s.pos) > 1);
      // one turns back damaged, the other is sunk
      const c = S.shima[0];
      c.hp = c.maxHP * 0.3;
      const t1 = w.time;
      while (w.phase === 'playing' && !c.escaped && w.time < t1 + 60) { keep(); w.update(DT); }
      assert.strictEqual(c.escaped, 'retreated');
      assert.match(obj(w, 'shima').text, /1\/2/);
      sink(S.shima[1], w.player); w.update(DT);
      assert.strictEqual(w.phase, 'won');
      assert.strictEqual(obj(w, 'gulf').state, 'done');
      assert.strictEqual(obj(w, 'line').state, 'done');
      assert.strictEqual(opStars(w), 1, 'Mogami still afloat: one star');
   });
}

test('Surigao: both optional objectives give the second star; a lost line ship costs it', () => {
   const w = world('surigao');
   const S = w._script;
   sink(S.mogami, w.player);
   for (const b of S.bbs) sink(b, w.player);
   w.update(DT);
   assert.strictEqual(obj(w, 'mogami').state, 'done');
   const keep = () => { for (const s of w.ships) if (s.side === 'player') s.hp = s.maxHP; };
   while (w.phase === 'playing' && !S.shimaIn) { keep(); w.update(DT); }
   for (const c of S.shima) sink(c, w.player);
   w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(opStars(w), 2);

   const l = world('surigao');
   sink(l._script.line[0], foes(l)[0]); l.update(DT);
   assert.strictEqual(obj(l, 'line').state, 'failed');
   assert.strictEqual(l.phase, 'playing');
});

test('Surigao: a heavy ship in the gulf or daybreak loses', () => {
   let w = world('surigao');
   put(w._script.bbs[1], w._script.gulf); w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(obj(w, 'gulf').state, 'failed');
   assert.match(w.result.reason, /Fusō/);

   w = world('surigao', 'normal', 'Washington');
   for (const b of w._script.bbs) sink(b, w.player);
   const keep = () => { for (const s of w.ships) if (s.side === 'player') s.hp = s.maxHP; };
   while (w.phase === 'playing' && !w._script.shimaIn) { keep(); w.update(DT); }
   put(w._script.shima[0], w._script.gulf); w.update(DT);
   assert.strictEqual(w.phase, 'lost');

   w = world('surigao');
   timeout(w);
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(obj(w, 'bbs').state, 'failed');
});

test('Surigao: Shima arrives on the clock even if Nishimura is still afloat', () => {
   const w = world('surigao', 'normal', 'Washington');
   const S = w._script;
   const keep = () => { for (const s of w.ships) { s.hp = s.maxHP; } for (const b of S.bbs) { b.pos.y = Math.max(b.pos.y, 6000); } };
   while (w.phase === 'playing' && w.time < 220) { keep(); w.update(DT); }
   assert.strictEqual(w.phase, 'playing');
   assert.ok(S.shimaIn);
   assert.match(obj(w, 'shima').text, /0\/2/);
});

// ------------------------------------------------------------------------------------- Savo
test('Savo: the Allied groups sleep until alarmed; cruisers answer late, the northern group later', () => {
   const w = world('savo');
   const S = w._script;
   assert.strictEqual(w.player.name, 'Chōkai');
   assert.strictEqual(S.targets.length, 5);
   assert.ok(foes(w).every(s => s.ai.passive), 'everybody asleep');
   // park the Japanese column so only the script wakes anybody
   const far = { x: -12500, y: -3000 };
   const hold = () => { for (const s of w.ships) if (s.side === 'player') { s.pos.x = far.x; s.pos.y = far.y; s.speed = 0; s.hp = s.maxHP; } };
   while (w.time < 20) { hold(); w.update(DT); }
   assert.ok(!S.south.awake && !S.north.awake);
   S.south.ca[0].hp -= 50;                       // first hit
   while (w.time < 22) { hold(); w.update(DT); }
   assert.ok(S.south.awake);
   assert.ok(S.south.dd.every(s => !s.ai.passive), 'destroyers react at once');
   assert.ok(S.south.ca.every(s => s.ai.passive), 'cruisers still clearing for action');
   assert.ok(!S.north.awake);
   while (w.time < 22 + S.surprise + 1) { hold(); w.update(DT); }
   assert.ok(S.south.ca.every(s => !s.ai.passive));
   while (w.time < 22 + S.northDelay + 1) { hold(); w.update(DT); }
   assert.ok(S.north.awake);
   assert.strictEqual(w.phase, 'playing');
});

test('Savo: the alarm comes by itself after a while', () => {
   const w = world('savo');
   const S = w._script;
   const hold = () => { for (const s of w.ships) if (s.side === 'player') { s.pos.x = -12500; s.pos.y = -3000; s.speed = 0; s.hp = s.maxHP; } };
   while (w.time < 153) { hold(); w.update(DT); }
   assert.ok(S.south.awake);
});

test('Savo: three cruisers sunk start the withdrawal; reaching the Slot wins', () => {
   const w = world('savo');
   const S = w._script;
   sink(S.targets[0], w.player); w.update(DT);
   assert.match(obj(w, 'kills').text, /1\/3/);
   sink(S.targets[1], w.player); w.update(DT);
   assert.ok(!S.phase2 && !obj(w, 'exit'));
   put(w.player, S.exit); w.update(DT);
   assert.strictEqual(w.phase, 'playing', 'no way out before the job is done');
   put(w.player, { x: -8600, y: 2900 });
   sink(S.targets[2], w.player); w.update(DT);
   assert.ok(S.phase2);
   assert.strictEqual(obj(w, 'kills').state, 'done');
   assert.strictEqual(obj(w, 'exit').state, 'active');
   assert.ok(S.picketsUp, 'pickets block the way home');
   put(w.player, S.exit); w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'exit').state, 'done');
   assert.strictEqual(obj(w, 'four').state, 'failed');
   assert.strictEqual(obj(w, 'home').state, 'done');
   assert.strictEqual(opStars(w), 1);
});

test('Savo: four cruisers and no cruiser lost give two stars; a lost cruiser costs one', () => {
   let w = world('savo');
   let S = w._script;
   for (const t of S.targets.slice(0, 4)) sink(t, w.player);
   w.update(DT);
   assert.strictEqual(obj(w, 'four').state, 'done');
   put(w.player, S.exit); w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(opStars(w), 2);

   w = world('savo'); S = w._script;
   sink(S.own[1], foes(w)[0]); w.update(DT);
   assert.strictEqual(obj(w, 'home').state, 'failed');
   for (const t of S.targets.slice(0, 4)) sink(t, w.player);
   put(w.player, S.exit); w.update(DT); w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(opStars(w), 1);
});

test('Savo: the pursuit arrives during the withdrawal (not on easy); daybreak loses in either phase', () => {
   let w = world('savo');
   let S = w._script;
   const hold = () => { for (const s of w.ships) if (s.side === 'player') { s.pos.x = -12500; s.pos.y = 3000; s.speed = 0; s.hp = s.maxHP; } };
   for (const t of S.targets.slice(0, 3)) sink(t, w.player);
   w.update(DT);
   const t0 = w.time;
   while (w.phase === 'playing' && w.time < t0 + 32) { hold(); w.update(DT); }
   assert.ok(byName(w, 'USS San Juan'), 'reinforcement on normal');
   timeout(w);
   assert.strictEqual(w.phase, 'lost');
   assert.match(w.result.reason, /Slot/);

   w = world('savo', 'easy'); S = w._script;
   for (const t of S.targets.slice(0, 3)) sink(t, w.player);
   w.update(DT);
   const t1 = w.time;
   while (w.phase === 'playing' && w.time < t1 + 32) { for (const s of w.ships) if (s.side === 'player') s.hp = s.maxHP; w.update(DT); }
   assert.ok(!byName(w, 'USS San Juan'));

   w = world('savo');
   timeout(w);
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(obj(w, 'kills').state, 'failed');
});
