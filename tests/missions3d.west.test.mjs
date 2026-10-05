// tests/missions3d.west.test.mjs — headless tests for the Atlantic/Mediterranean operations
// (game3d/missions_west.js): each one loads on every difficulty with a valid map, its objectives
// progress, the win and the loss paths are reachable, and an AI-captained run stays free of
// exceptions and NaN.  Run: node --test tests/missions3d.west.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../game3d/state.js';
import { MISSIONS, MISSION_IDS, getMission, opStars } from '../game3d/missions.js';
import { obstacleT } from '../game3d/utils.js';

const DT = 1 / 60;
const OPS = { laplata: 'Fiji', pedestal: 'Fiji', juno: 'Scharnhorst' };
const byName = (w, n) => w.roster.find(s => s.name === n);
const sink = (s, by) => s.takeDamage(s.hp + 1, by, 'citadel');
const obj = (w, id) => w.mission.objectives.find(o => o.id === id);
const world = (id, diff = 'normal', seed = 3) => new World(diff, { mission: id, seed });
function runTo(w, t) { while (w.phase === 'playing' && w.time < t) w.update(DT); }
const put = (s, z) => { s.pos.x = z.x; s.pos.y = z.y; };
const foes = (w) => w.ships.filter(s => s.alive && s.side === 'enemy');
const zoneOf = (w, label) => w.mission.zones.find(z => z.label === label);

test('west ops: in the catalogue, ops stay contiguous, menu data and fixed ships', () => {
   const firstOp = MISSIONS.findIndex(m => m.group === 'ops');
   assert.ok(MISSIONS.slice(firstOp).every(m => m.group === 'ops'), 'ops are contiguous');
   assert.strictEqual(new Set(MISSION_IDS).size, MISSION_IDS.length, 'unique ids');
   for (const [id, cls] of Object.entries(OPS)) {
      assert.ok(MISSION_IDS.includes(id), `${id} missing`);
      const m = getMission(id);
      assert.strictEqual(m.group, 'ops');
      assert.deepStrictEqual(m.playableShips, [cls]);
      assert.strictEqual(m.recommendedShip, cls);
      assert.ok(m.name && m.subtitle && m.timeLimit >= 300 && m.timeLimit <= 900, `${id} menu data`);
      assert.ok(m.briefing.length > 120 && m.debrief.length > 120 && m.fleet.own && m.fleet.foe, `${id} briefing/debrief/fleet`);
      assert.ok(m.stars >= 1 && m.stars <= 3 && ['day', 'dawn', 'dusk', 'night'].includes(m.env.time), `${id} stars/env`);
   }
});

for (const [id, cls] of Object.entries(OPS)) {
   test(`"${id}": valid world on every difficulty (objectives, zones on open water, nobody on land)`, () => {
      for (const diff of ['easy', 'normal', 'hard']) {
         const w = new World(diff, { mission: id, ship: cls, seed: 5 });
         assert.strictEqual(w.player.cls, cls, `${id} player ship`);
         assert.ok(w.mission.objectives.filter(o => !o.optional).length >= 1, `${id} objectives`);
         assert.ok(w.mission.objectives.filter(o => o.optional).length >= 1, `${id} optional objectives`);
         assert.ok(w.mission.objectives.every(o => o.text && !/undefined|NaN/.test(o.text)), `${id} objective text`);
         assert.ok(w.mission.zones.length >= 1, `${id} zones`);
         for (const z of w.mission.zones) {
            assert.ok(Math.abs(z.x) + z.r < w.arena && Math.abs(z.y) + z.r < w.arena, `${id} zone ${z.label} inside the arena`);
            for (const o of w.obstacles) assert.ok(obstacleT(o, z) > 1.05, `${id} zone ${z.label} on open water`);
         }
         for (const s of w.ships) {
            assert.ok(Math.abs(s.pos.x) < w.arena && Math.abs(s.pos.y) < w.arena, `${id} ${s.name} inside the arena`);
            for (const o of w.obstacles) assert.ok(obstacleT(o, s.pos) > 1, `${id} ${s.name} spawned on land`);
         }
         // first contact within about a minute: an enemy inside 10 km of the player's group
         const near = Math.min(...foes(w).map(e => Math.hypot(e.pos.x - w.player.pos.x, e.pos.y - w.player.pos.y)));
         assert.ok(near < 10500, `${id} first enemy ${Math.round(near)} m away`);
      }
   });

   test(`"${id}": full AI-captained run ends without exceptions or NaN, late spawns on open water`, () => {
      const w = world(id, 'normal', 17);
      w.autoPlayer = true;
      const limit = getMission(id).timeLimit;
      runTo(w, limit + 30);
      for (const s of w.roster) {
         assert.ok([s.pos.x, s.pos.y, s.heading, s.speed, s.hp].every(Number.isFinite), `${id} ${s.name} NaN`);
         if (s.alive) for (const o of w.obstacles) assert.ok(obstacleT(o, s.pos) > 0.9, `${id} ${s.name} on land`);
      }
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

   test(`"${id}": a player who does nothing runs out the clock and loses`, () => {
      const w = world(id);
      w.player.setTelegraph(0);
      w.timeLeft = 0; w.update(DT);
      assert.strictEqual(w.phase, 'lost');
      assert.ok(w.mission.objectives.some(o => o.state === 'failed'));
   });
}

test('La Plata: the Graf Spee shoots at the Exeter, hurting her or closing in draws her fire', () => {
   const w = world('laplata');
   const S = w._script, spee = byName(w, 'Admiral Graf Spee'), ex = byName(w, 'HMS Exeter');
   assert.ok(spee && ex && byName(w, 'HMS Achilles') && w.player.name === 'HMS Ajax');
   assert.strictEqual(spee.side, 'enemy');
   runTo(w, 2);
   assert.strictEqual(spee.ai.huntId, ex.id, 'opens on the Exeter');
   // damage credited to the player swings the turrets round
   w.stats.dmg += spee.maxHP * 0.06;
   w.update(DT);
   assert.strictEqual(spee.ai.huntId, w.player.id);
   assert.ok(S.heat > 20);
   // ...and back again once the light cruisers stop hitting (keep them out of the 6 km ring)
   put(w.player, { x: spee.pos.x + 9000, y: spee.pos.y });
   S.heat = 0.01; S.acc = 0;
   w.update(DT); w.update(DT);
   assert.strictEqual(spee.ai.huntId, ex.id);
   // closing inside 6 km does it as well
   put(w.player, { x: spee.pos.x + 4000, y: spee.pos.y });
   w.update(DT);
   assert.strictEqual(spee.ai.huntId, w.player.id);
});

test('La Plata: crossfire from two bearings spoils her gunnery and fills the optional objective', () => {
   const w = world('laplata');
   const S = w._script, spee = S.spee, ex = S.exeter;
   runTo(w, 1);
   // both divisions on the same bearing: full salvo weight
   put(ex, { x: spee.pos.x, y: spee.pos.y + 8000 });
   put(w.player, { x: spee.pos.x + 600, y: spee.pos.y + 9000 });
   w.update(DT);
   assert.strictEqual(spee.dmgMult, S.baseDmg);
   assert.strictEqual(S.crossT, 0);
   // 90 degrees apart
   put(w.player, { x: spee.pos.x + 8500, y: spee.pos.y });
   w.update(DT);
   assert.ok(spee.dmgMult < S.baseDmg * 0.75, 'divided fire control');
   assert.ok(S.crossT > 0);
   S.crossT = 29.99;
   put(ex, { x: spee.pos.x, y: spee.pos.y + 8000 });
   put(w.player, { x: spee.pos.x + 8500, y: spee.pos.y });
   w.update(DT);
   assert.strictEqual(obj(w, 'cross').state, 'done');
});

test('La Plata: shot below the limit she runs for the estuary; keeping touch or the zone wins', () => {
   for (const how of ['shadow', 'zone', 'sunk']) {
      const w = world('laplata');
      const S = w._script, spee = S.spee;
      runTo(w, 1);
      assert.match(obj(w, 'damage').text, /Zustand 100 %/);
      spee.hp = spee.maxHP * (S.limit - 0.02);
      runTo(w, 6);
      assert.strictEqual(w.phase, 'playing');
      assert.ok(spee.ai.retreating, 'she breaks off');
      assert.strictEqual(obj(w, 'damage').state, 'done');
      assert.strictEqual(obj(w, 'port').state, 'active');
      if (how === 'shadow') {
         while (w.phase === 'playing' && w.time < 120) { put(w.player, { x: spee.pos.x + 9000, y: spee.pos.y + 3000 }); w.update(DT); }
         assert.ok(w.time > 60, 'a full minute of shadowing');
      } else if (how === 'zone') {
         put(w.player, { x: 11000, y: 11000 });   // contact lost: only her arrival counts
         put(spee, zoneOf(w, 'Río de la Plata')); w.update(DT);
      } else { sink(spee, w.player); w.update(DT); }
      assert.strictEqual(w.phase, 'won', how);
      assert.strictEqual(obj(w, 'port').state, 'done');
      assert.strictEqual(obj(w, 'exeter').state, 'done');
      assert.ok(opStars(w) >= 1);
   }
});

test('La Plata: the Exeter retires when shot up, her loss fails the optional objective; timeout loses', () => {
   let w = world('laplata');
   let S = w._script;
   runTo(w, 1);
   S.exeter.hp = S.exeter.maxHP * 0.2;
   runTo(w, 8);
   assert.ok(S.exeter.ai.retreating && S.exOut);
   assert.strictEqual(S.spee.ai.huntId, w.player.id, 'all her fire on the light cruisers now');
   w = world('laplata');
   S = w._script;
   runTo(w, 1);
   sink(S.exeter, S.spee); w.update(DT);
   assert.strictEqual(obj(w, 'exeter').state, 'failed');
   assert.strictEqual(w.phase, 'playing');
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(obj(w, 'damage').state, 'failed');
   // the clock running out while she is already fleeing is still the historical outcome
   w = world('laplata');
   S = w._script;
   runTo(w, 1);
   S.spee.hp = S.spee.maxHP * 0.3;
   runTo(w, 4);
   put(w.player, { x: 11000, y: 11000 });
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'won');
});

test('Pedestal: the convoy steams east; submarine, air raids and fast boats arrive in that order', () => {
   const w = world('pedestal');
   const S = w._script, ohio = byName(w, 'SS Ohio');
   assert.ok(ohio && S.freighters.length === 3 && S.escort.length === 3);
   assert.strictEqual(w.squadrons.length, 0);
   const x0 = ohio.pos.x;
   runTo(w, 40);
   assert.ok(S.sub.alive && S.sub.depth >= 1, 'Axum is submerged before the convoy reaches her');
   assert.ok(ohio.pos.x > x0 + 800, 'the tanker makes way on her own');
   assert.strictEqual(w.squadrons.length, 0, 'no aircraft in the first seconds');
   runTo(w, 60);
   assert.ok(w.squadrons.some(q => q.side === 'enemy' && q.type === 'db'), 'first wave: dive bombers');
   assert.ok(!S.boats, 'no boats before dark');
   runTo(w, 190);
   if (w.phase !== 'playing') return;   // (the tanker can be lost early with an idle player)
   assert.ok(w.roster.length >= 10);
   runTo(w, 272);
   if (w.phase !== 'playing') return;
   assert.strictEqual(S.boats.length, 4);
   for (const b of S.boats) {
      assert.strictEqual(b.side, 'enemy');
      assert.ok(Math.abs(b.pos.x) < w.arena && Math.abs(b.pos.y) < w.arena, `${b.name} inside the arena`);
      for (const o of w.obstacles) assert.ok(obstacleT(o, b.pos) > 1, `${b.name} spawned on land`);
      assert.ok(Math.hypot(b.pos.x - ohio.pos.x, b.pos.y - ohio.pos.y) > 5000, `${b.name} not on top of the convoy`);
   }
});

test('Pedestal: the airfield stand-in stays out of the fight', () => {
   const w = world('pedestal');
   const cv = w._script.cv;
   w.autoPlayer = true;
   runTo(w, 200);
   assert.ok(cv.alive && cv.hp === cv.maxHP, 'never engaged');
   assert.ok(cv.pos.y < -10000, 'stays at the northern edge');
   assert.ok(!cv.detected, 'never sighted');
});

test('Pedestal: only the tanker counts; her state and the freighters decide the optional objectives', () => {
   // Ohio arrives intact with all freighters afloat: everything done
   let w = world('pedestal');
   let S = w._script;
   runTo(w, 1);
   put(S.freighters[0], S.exit); w.update(DT);
   assert.strictEqual(S.arrived, 1);
   assert.strictEqual(w.phase, 'playing', 'a freighter arriving is not the win');
   put(S.ohio, S.exit); w.update(DT);
   assert.strictEqual(w.phase, 'won');
   for (const id of ['ohio', 'threats', 'half', 'freighters']) assert.strictEqual(obj(w, id).state, 'done', id);
   assert.strictEqual(opStars(w), 2);
   // crippled tanker, two freighters lost: still a win, one star
   w = world('pedestal');
   S = w._script;
   runTo(w, 1);
   sink(S.freighters[0], S.sub); w.update(DT);
   assert.match(obj(w, 'freighters').text, /1 verloren/);
   assert.strictEqual(obj(w, 'freighters').state, 'active');
   sink(S.freighters[1], S.sub); w.update(DT);
   assert.strictEqual(obj(w, 'freighters').state, 'failed');
   assert.strictEqual(w.phase, 'playing');
   S.ohio.hp = S.ohio.maxHP * 0.3;
   w.update(DT);
   runTo(w, 2.2);
   assert.match(obj(w, 'ohio').text, /Zustand 30 %/);
   put(S.ohio, S.exit); w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'half').state, 'failed');
   assert.strictEqual(opStars(w), 1);
   // three stars need hard
   w = world('pedestal', 'hard');
   runTo(w, 1);
   put(w._script.ohio, w._script.exit); w.update(DT);
   assert.strictEqual(opStars(w), 3);
});

test('Pedestal: losing the tanker loses at once, the clock loses as well', () => {
   let w = world('pedestal');
   runTo(w, 1);
   sink(w._script.ohio, w._script.sub); w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(obj(w, 'ohio').state, 'failed');
   assert.match(w.result.reason, /Ohio/);
   w = world('pedestal');
   runTo(w, 1);
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
});

test('Juno: the carrier works up speed towards the exit, Ardent attacks, Acasta screens then charges', () => {
   const w = world('juno');
   const S = w._script, g = byName(w, 'HMS Glorious');
   assert.ok(g && byName(w, 'Gneisenau').side === 'player');
   assert.strictEqual(S.ardent.ai.huntId, w.player.id);
   assert.strictEqual(S.acasta.ai.escortId, g.id);
   const d0 = Math.hypot(g.pos.x - S.exit.x, g.pos.y - S.exit.y);
   runTo(w, 30);
   const v30 = g.maxSpeedKn;
   assert.ok(v30 < 12, `slow at first (${v30} kn)`);
   assert.ok(Math.hypot(g.pos.x - S.exit.x, g.pos.y - S.exit.y) < d0 - 100, 'runs for the exit');
   assert.strictEqual(w.squadrons.length, 0, 'no aircraft up at the start');
   runTo(w, 152);
   if (w.phase !== 'playing') return;
   assert.ok(g.maxSpeedKn > v30 + 3, 'boilers coming on line');
   if (S.acasta.alive) {
      assert.ok(S.charge, 'Acasta turns to attack');
      assert.strictEqual(S.acasta.ai.huntId, w.player.id);
      assert.strictEqual(S.acasta.ai.escortId, null);
   }
});

test('Juno: Swordfish fly unless the flight deck is wrecked in time', () => {
   // deck intact: the strike starts on schedule and the optional objective is gone
   let w = world('juno');
   let S = w._script;
   put(w.player, { x: 11000, y: -11000 });   // out of everybody's reach for this check
   w.player.setTelegraph(0);
   runTo(w, S.launchAt + 1);
   assert.ok(w.squadrons.some(q => q.side === 'enemy' && q.type === 'tb'), 'torpedo bombers launched');
   assert.strictEqual(obj(w, 'deck').state, 'failed');
   // deck wrecked first: nothing takes off
   w = world('juno');
   S = w._script;
   put(w.player, { x: 11000, y: -11000 });
   w.player.setTelegraph(0);
   runTo(w, 5);
   S.glo.hp = S.glo.maxHP * (S.deckHP - 0.03);
   runTo(w, 6);
   assert.strictEqual(obj(w, 'deck').state, 'done');
   runTo(w, S.launchAt + 90);
   assert.strictEqual(w.squadrons.filter(q => q.side === 'enemy').length, 0);
});

test('Juno: sinking the carrier wins (two stars with deck and destroyers), her escape loses', () => {
   let w = world('juno');
   let S = w._script;
   runTo(w, 2);
   sink(S.ardent, w.player); w.update(DT);
   assert.match(obj(w, 'dds').text, /1\/2/);
   sink(S.acasta, w.player); w.update(DT);
   assert.strictEqual(obj(w, 'dds').state, 'done');
   assert.strictEqual(w.phase, 'playing');
   sink(S.glo, w.player); w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'sink').state, 'done');
   assert.strictEqual(obj(w, 'deck').state, 'done');
   assert.strictEqual(opStars(w), 2);
   // carrier alone: one star
   w = world('juno');
   S = w._script;
   runTo(w, 2);
   sink(S.glo, w.player); w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'dds').state, 'failed');
   assert.strictEqual(opStars(w), 1);
   // she reaches the exit
   w = world('juno');
   S = w._script;
   runTo(w, 2);
   put(S.glo, S.exit); w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(obj(w, 'sink').state, 'failed');
   assert.match(w.result.reason, /entkommen/);
});
