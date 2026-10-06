// Operations 6-10 (gamev2/missions_east.js): setup for every allowed ship, objectives, win and lose,
// scripted events, co-op setup and one bot-captain run per mission.
// Balance table: EAST_BALANCE=30 node --test tests/v2.missions.east.test.mjs   (runs per mission and difficulty)
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../gamev2/state.js';
import { MISSIONS } from '../gamev2/missions.js';
import { EAST_TUNE } from '../gamev2/missions_east.js';
import { islandReliefAt } from '../gamev2/utils.js';
import { damageSite, siteById } from '../gamev2/sites.js';
import { setRadar } from '../gamev2/sensors.js';
import { launchTeam } from '../gamev2/seal.js';
import { buildNetWorld } from '../gamev2/net/setup.js';
import { captain } from './v2.missions.east.captain.mjs';

const IDS = ['barents', 'reefs', 'strait', 'philsea', 'countdown'];
const DIFFS = ['easy', 'normal', 'hard'];
const SAFE = 12000;              // m: no opponent closer than this to a captain when it appears
const def = (id) => MISSIONS.find(m => m.id === id);
const mk = (id, o = {}) => new World(o.diff || 'normal', { mission: id, ship: o.ship || def(id).recommendedShip, seed: o.seed ?? 4711 });
const step = (w, secs, each) => { for (let i = 0, n = Math.round(secs * 60); i < n && w.phase === 'playing'; i++) { w.update(1 / 60); if (each) each(); } };
const until = (w, secs, cond) => { for (let i = 0, n = Math.round(secs * 60); i < n && w.phase === 'playing' && !cond(); i++) w.update(1 / 60); return cond(); };
const onLand = (w, p) => w.obstacles.some(o => islandReliefAt(o, p) > 0);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const sink = (w, s) => { s.takeDamage(1e9, null, 'test'); w.update(1 / 60); };
const kill = (w, id) => { const s = siteById(w, id); damageSite(w, s, s.hp + 1, w.player, 'test'); };
const obj = (w, id) => w.mission.objectives.find(o => o.id === id);
const radioed = (w, part) => w.events.some(e => e.type === 'objective' && e.text.includes(part));
const captains = (w) => w.ships.filter(s => s.alive && s.side === 'player' && (s.isPlayer || s.human));
// every opponent that appears (at setup or later) is at sea and away from the captains
function checkSpawns(w, seen) {
   for (const s of w.ships) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      assert.ok(!onLand(w, s.pos), `${w.mission.id}: ${s.name} stands on land`);
      if (s.side !== 'enemy') continue;
      for (const c of captains(w)) assert.ok(dist(s.pos, c.pos) >= SAFE, `${w.mission.id}: ${s.name} appears ${Math.round(dist(s.pos, c.pos))} m from ${c.name}`);
   }
}

test('east: the five operations are registered with texts, limits and tuning', () => {
   for (const id of IDS) {
      const d = def(id);
      assert.ok(d, id);
      assert.equal(d.group, 'ops');
      assert.ok(d.briefing.length > 80 && d.debrief.length > 30, id + ' texts');
      assert.ok(d.timeLimit >= 480 && d.timeLimit <= 720, id + ' 8-12 minutes');
      assert.ok(d.playableShips.includes(d.recommendedShip));
      for (const k of DIFFS) assert.ok(EAST_TUNE[id][k], id + ' ' + k);
   }
});

for (const id of IDS) {
   test(`east/${id}: sets up for every allowed ship and difficulty, nothing on land or close to the player`, () => {
      for (const ship of def(id).playableShips) for (const diff of DIFFS) {
         const w = mk(id, { ship, diff });
         assert.equal(w.phase, 'playing');
         assert.equal(w.player.cls, ship);
         const main = w.mission.objectives.filter(o => !o.optional), opt = w.mission.objectives.filter(o => o.optional);
         assert.ok(main.length >= 1 && opt.length >= 1 && opt.length <= 3, `${id}/${ship}: objectives`);
         const seen = new Set();
         checkSpawns(w, seen);
         for (const s of w.sites) if (s.side === 'enemy') assert.ok(dist(s, w.player.pos) >= SAFE, `${id}: ${s.name} close to the player`);
         // civilians are never opponents
         for (const s of w.ships) if (s.type === 'TR') assert.equal(s.side, 'player');
         // the first 20 s are quiet: nobody of the own group is hit
         step(w, 20);
         assert.equal(w.phase, 'playing', `${id}/${ship}/${diff} ended in 20 s`);
         for (const s of w.ships) if (s.side === 'player') assert.ok(s.hp >= s.maxHP * 0.999, `${id}/${ship}/${diff}: ${s.name} hit in the first 20 s`);
      }
   });

   for (const n of [2, 4]) test(`east/${id}: co-op setup with ${n} captains`, () => {
      const d = def(id), solo = mk(id);
      const more = ['Burke', 'Daring', 'Sachsen'].slice(0, n - 1);
      const w = buildNetWorld({ difficulty: 'normal', mission: id, classes: [d.recommendedShip, ...more], loadouts: Array(n).fill(null), seed: 4711 });
      assert.equal(w.net.humans.length, n);
      assert.equal(new Set(w.net.humans.map(h => h.id)).size, n);
      for (const h of w.net.humans) { assert.ok(h.alive && h.side === 'player'); assert.ok(!onLand(w, h.pos)); }
      // captains take the place of allied bots as far as the group has replaceable ones
      const bots = (x) => x.ships.filter(s => s.side === 'player' && s.type !== 'TR' && !s.isPlayer && !s.human).length;
      assert.ok(bots(w) < bots(solo), 'bots replaced');
      const seen = new Set();
      checkSpawns(w, seen);
      // the allied bots hold fire until a captain opens it, whoever of them it is
      step(w, 2);
      const ally = w.ships.find(s => s.side === 'player' && s.type !== 'TR' && !s.isPlayer && !s.human && s.ai);
      // (Barentssee: weapons tight until the salvo is over; Taiwanstraße: the escort is free from the start)
      if (ally && id !== 'barents' && id !== 'strait') {
         assert.equal(ally.ai.passive, true);
         w.net.humans[n - 1].stats.ssmFired = (w.net.humans[n - 1].stats.ssmFired || 0) + 1;
         step(w, 0.1);
         assert.equal(ally.ai.passive, false, 'fire opened by the last captain');
      }
      step(w, 30, () => checkSpawns(w, seen));
      assert.equal(w.phase, 'playing');
   });

   test(`east/${id}: a bot captain finishes inside the time limit, a passive player does not win`, () => {
      const d = def(id);
      for (const mode of ['bot', 'passive']) {
         const w = mk(id, { diff: mode === 'bot' ? 'easy' : 'normal', seed: 101 });
         const cap = captain(w, mode), seen = new Set();
         let n = 0;
         while (w.phase === 'playing' && n++ < (d.timeLimit + 5) * 60) { w.update(1 / 60); cap(); if (n % 30 === 0) checkSpawns(w, seen); }
         assert.notEqual(w.phase, 'playing', `${id}/${mode} still running`);
         assert.ok(w.time <= d.timeLimit + 1, `${id}/${mode} ran ${Math.round(w.time)} s`);
         assert.ok(w.result && w.result.reason.length > 10);
         if (mode === 'passive') assert.equal(w.phase, 'lost');
      }
   });
}

// ------------------------------------------------------------------------------------ 6. Barentssee
test('east/barents: raid and salvo fire, the counter strike opens after the salvo, win and lose', () => {
   const T = EAST_TUNE.barents.normal;
   let w = mk('barents'), S = w._script;
   step(w, T.salvoAt - 38);
   assert.ok(w.squadrons.some(q => q.side === 'enemy'), 'bombers from the airfield');
   assert.ok(radioed(w, 'Startvorbereitungen'));
   step(w, 45);
   assert.equal(S.phase, 1);
   assert.ok(w.missiles.some(m => m.alive && m.kind === 'ssm' && m.side === 'enemy'), 'salvo in the air');
   assert.equal(obj(w, 'strike'), undefined);
   assert.ok(until(w, 200, () => S.phase === 2), 'salvo over');
   assert.equal(obj(w, 'salvo').state, 'done');
   assert.equal(obj(w, 'strike').state, 'active');
   if (w.phase === 'playing') {
      sink(w, w.shipById(S.pjId));
      assert.equal(w.phase, 'won');
      assert.equal(obj(w, 'strike').state, 'done');
   }
   // the carrier is the mission
   w = mk('barents', { ship: 'Burke' }); S = w._script;
   step(w, 1);
   sink(w, w.shipById(S.fordId));
   assert.equal(w.phase, 'lost');
   assert.match(w.result.reason, /Ford/);
   // a lost escort costs the optional objective, the clock ends the operation
   w = mk('barents'); S = w._script;
   step(w, 1);
   sink(w, w.ships.find(s => s.side === 'player' && s.id !== S.fordId));
   assert.equal(obj(w, 'screen').state, 'failed');
   w.timeLeft = 0.01; step(w, 0.1);
   assert.equal(w.phase, 'lost');
});

// ------------------------------------------------------------------------------------ 7. Riffe
test('east/reefs: radar blinds the air defence, boats come out, relief group decides', () => {
   const T = EAST_TUNE.reefs.normal;
   let w = mk('reefs'), S = w._script;
   step(w, 2);
   const boats = S.boats.map(id => w.shipById(id));
   assert.ok(boats.every(b => b.ai.anchored));
   kill(w, S.radarId);
   assert.equal(obj(w, 'radar').state, 'done');
   assert.ok(boats.every(b => !b.ai.anchored && b.ai.huntId != null), 'boats released');
   assert.ok(new Set(boats.map(b => b.ai.huntId)).size > 1, 'boats spread over the group');
   for (const s of w.sites) if (s.kind === 'sam' && s.alive) for (const x of s.cfg.weapons.sam) assert.ok(x.ch <= T.blindCh);
   kill(w, S.bat[0]);
   assert.match(obj(w, 'bat').text, /1\/2/);
   assert.equal(S.relief, undefined);
   kill(w, S.bat[1]);
   assert.equal(obj(w, 'bat').state, 'done');
   assert.equal(S.relief.length, T.relief.length);
   assert.equal(obj(w, 'relief').state, 'active');
   for (const id of S.relief) { const r = w.shipById(id); assert.ok(!onLand(w, r.pos)); assert.ok(dist(r.pos, w.player.pos) >= SAFE); }
   for (const id of S.sam) kill(w, id);
   assert.equal(obj(w, 'sam').state, 'done');
   assert.equal(w.phase, 'playing');
   for (const id of S.relief) sink(w, w.shipById(id));
   assert.equal(w.phase, 'won');
   assert.equal(obj(w, 'screen').state, 'done');
   // the boats also come out by the clock; the clock ends the operation
   w = mk('reefs'); S = w._script;
   step(w, T.boatsAt + 1);
   assert.equal(S.out, true);
   if (w.phase === 'playing') { w.timeLeft = 0.01; step(w, 0.1); assert.equal(w.phase, 'lost'); assert.match(w.result.reason, /Batterien/); }
   // batteries first: the radar is still asked for
   w = mk('reefs'); S = w._script;
   step(w, 1);
   kill(w, S.bat[0]); kill(w, S.bat[1]);
   assert.equal(S.relief, undefined);
   assert.equal(obj(w, 'radar').state, 'active');
   sink(w, w.player);
   assert.equal(w.phase, 'lost');
});

// ------------------------------------------------------------------------------------ 8. Taiwanstraße
test('east/strait: waves, the convoy waits for its escort, arrivals and losses', () => {
   const T = EAST_TUNE.strait.normal;
   let w = mk('strait'), S = w._script;
   const seen = new Set();
   const foes = () => w.ships.filter(s => s.side === 'enemy' && s.alive).length;
   step(w, 20, () => checkSpawns(w, seen));
   const n0 = foes();
   step(w, 15, () => checkSpawns(w, seen));
   assert.equal(foes(), n0 + T.fac1, 'first wave');
   assert.ok(radioed(w, 'Schnellbootrudel'));
   const conv = S.conv.map(id => w.shipById(id));
   assert.ok(conv.every(f => f.type === 'TR' && f.side === 'player'));
   // without a captain close by the freighters stop
   const home = { ...w.player.pos };
   w.player.pos.x = -15000; w.player.pos.y = 14000;
   step(w, 0.5);
   assert.equal(S.held, true);
   assert.ok(conv.every(f => f.ai.anchored));
   assert.ok(radioed(w, 'warten auf Geleit'));
   w.player.pos.x = home.x; w.player.pos.y = home.y;
   step(w, 0.5);
   assert.equal(S.held, false);
   // the submarine is the optional objective
   sink(w, w.shipById(S.subId));
   assert.equal(obj(w, 'sub').state, 'done');
   // two arrive, one is lost: won without the optional objective
   for (const f of conv.slice(0, 2)) { f.pos.x = S.goal.x; f.pos.y = S.goal.y; }
   w.player.pos.x = S.goal.x + 1500; w.player.pos.y = S.goal.y;
   step(w, 0.2);
   assert.match(obj(w, 'conv').text, /2\/2/);
   assert.equal(w.phase, 'playing');
   sink(w, conv[2]);
   step(w, 0.1);
   assert.equal(w.phase, 'won');
   assert.equal(obj(w, 'all').state, 'failed');
   // all three arrive
   w = mk('strait'); S = w._script;
   step(w, 1);
   for (const id of S.conv) { const f = w.shipById(id); f.pos.x = S.goal.x; f.pos.y = S.goal.y; }
   step(w, 0.2);
   assert.equal(w.phase, 'won');
   assert.equal(obj(w, 'all').state, 'done');
   // two lost: failed; the later waves come by the clock
   w = mk('strait'); S = w._script;
   step(w, T.w2 + 1, () => checkSpawns(w, seen));
   assert.ok(radioed(w, 'Überwassereinheiten'));
   if (w.phase === 'playing') {
      const left = S.conv.map(id => w.shipById(id)).filter(f => f && f.alive);
      for (const f of left.slice(0, 2 - S.lost)) sink(w, f);
      assert.equal(w.phase, 'lost');
   }
   w = mk('strait');
   step(w, 1); w.timeLeft = 0.01; step(w, 0.1);
   assert.equal(w.phase, 'lost');
});

// ------------------------------------------------------------------------------------ 9. Philippinensee
test('east/philsea: emission control, bearing report, contact and the deck of the Shandong', () => {
   const T = EAST_TUNE.philsea.normal;
   for (const ship of ['Ford', 'Burke']) {
      const w = mk('philsea', { ship }), S = w._script;
      assert.ok(w.ships.every(s => !s.radarOn), 'both groups silent at the start');
      w.player.setTelegraph(0);
      step(w, 72);
      assert.ok(S.hint && dist(S.hint, S.area) < 4000, 'bearing zone near the group');
      assert.ok(radioed(w, 'Funkpeilung'));
      assert.equal(obj(w, 'strike'), undefined);
      // the player closes in with the radar on: contact, the allied escorts go for the carrier
      const foe = w.shipById(S.foes[1]);
      w.player.pos.x = foe.pos.x - 6000; w.player.pos.y = foe.pos.y;
      setRadar(w, w.player, true);
      assert.ok(until(w, 30, () => S.found), 'group found');
      assert.equal(obj(w, 'find').state, 'done');
      assert.equal(obj(w, 'strike').state, 'active');
      const esc = w.ships.find(s => s.alive && s.side === 'player' && !s.isPlayer && s.id !== S.fordId);
      assert.equal(esc.ai.huntId, S.sdId);
      if (w.phase !== 'playing') continue;
      const sd = w.shipById(S.sdId);
      sd.hp = sd.maxHP * T.out - 1;
      step(w, 0.1);
      assert.equal(w.phase, 'won');
      assert.equal(obj(w, 'strike').state, 'done');
   }
   // found first by the enemy (or by the clock): his radars come on, the optional objective is gone
   let w = mk('philsea'), S = w._script;
   w.player.setTelegraph(0);
   assert.ok(until(w, T.auto + 5, () => S.hot), 'enemy goes active');
   assert.equal(obj(w, 'first').state, 'failed');
   assert.ok(S.foes.map(id => w.shipById(id)).filter(s => s && s.alive).every(s => s.radarOn));
   sink(w, w.shipById(S.fordId));
   assert.equal(w.phase, 'lost');
   w = mk('philsea'); S = w._script;
   step(w, 1);
   sink(w, w.shipById(S.sdId));
   assert.equal(w.phase, 'won');
   w = mk('philsea');
   step(w, 1); w.timeLeft = 0.01; step(w, 0.1);
   assert.equal(w.phase, 'lost');
});

// ------------------------------------------------------------------------------------ 10. Countdown
test('east/countdown: the warning detonation hits nobody and the countdown ends with the launch', () => {
   for (const diff of DIFFS) {
      const w = mk('countdown', { diff }), S = w._script, T = EAST_TUNE.countdown[diff];
      assert.equal(w.timeLeft, T.time);
      w.player.setTelegraph(0);
      step(w, 45);
      const e = w.events.find(x => x.type === 'blast');
      assert.ok(e && e.blastId === S.warnId, 'warning blast');
      assert.equal(e.hit.ships + e.hit.sites, 0, 'nobody inside the blast');
      for (const s of w.ships) assert.ok(dist(s.pos, S.test) > 3200 + 2000, s.name + ' near the test area');
      assert.ok(!onLand(w, S.test), 'test area at sea');
      assert.ok(radioed(w, 'Keine Schiffe, keine Personen'));
      assert.equal(w.phase, 'playing');
      // end of the countdown
      w.timeLeft = 6;
      step(w, 7);
      assert.equal(w.phase, 'lost');
      assert.match(w.result.reason, /Countdown/);
      assert.ok(w.events.some(x => x.type === 'blast' && x.blastId === S.finalId), 'final blast');
      assert.ok(radioed(w, 'Start von der Insel'));
   }
});

test('east/countdown: air defence, drone, launcher; guard boats; out of missiles', () => {
   const T = EAST_TUNE.countdown.normal;
   let w = mk('countdown'), S = w._script;
   step(w, 2);
   const L = siteById(w, S.launcherId);
   assert.equal(L.targetable, false);
   assert.equal(w.player.mag[w.player.cfg.weapons.cruise.type], T.tlam);
   // hits on the hidden launcher do nothing
   damageSite(w, L, 60000, w.player, 'test');
   step(w, 0.1);
   assert.ok(L.alive && w.phase === 'playing');
   const boats = S.boats.map(id => w.shipById(id));
   assert.ok(boats.every(b => b.ai.passive));
   kill(w, S.sam[0]);
   assert.match(obj(w, 'ad').text, /1\/3/);
   assert.ok(boats.every(b => b.ai.huntId != null), 'guard boats come out');
   kill(w, S.radarId); kill(w, S.sam[1]);
   assert.equal(obj(w, 'ad').state, 'done');
   assert.equal(L.targetable, false);
   // act 2: the drone finds the command bunker, the launcher fires at the group
   const B = siteById(w, S.bunkerId);
   assert.equal(B.targetable, false);
   step(w, T.drone + 1);
   assert.equal(B.targetable, true);
   assert.ok(radioed(w, 'zielt auf Ihren Verband'));
   let b = w.blasts.find(x => x.id === S.strikeId);
   assert.ok(b && b.state === 'armed' && Math.abs(b.t0 - w.time - T.fuse) < 2, 'the strike is on its way');
   assert.ok(dist(b, w.player.pos) < 200, 'aimed at the flagship');
   assert.match(obj(w, 'launcher').text, /Gefahrenzone/);
   // the bunker falls before the detonation: no blast, and the drone goes for the launcher
   step(w, 10);
   assert.ok(radioed(w, 'Führungsbunker der Insel erfasst'));
   kill(w, S.bunkerId);
   assert.ok(!w.blasts.some(x => x.id === b.id) && !S.strikeId, 'strike prevented');
   assert.ok(radioed(w, 'Zieldaten verloren'));
   assert.match(obj(w, 'launcher').text, /Startrampe/);
   step(w, T.fuse);
   assert.ok(!w.events.some(e => e.type === 'blast' && e.blastId === b.id));
   assert.equal(L.targetable, true, 'launcher found ' + T.drone2 + ' s after the strike');
   assert.ok(radioed(w, 'Drohne hat die Rampe'));
   assert.equal(L.hp, S.lhp);
   if (w.phase === 'playing') {
      kill(w, S.launcherId);
      assert.equal(w.phase, 'won');
      assert.equal(obj(w, 'launcher').state, 'done');
      assert.equal(obj(w, 'early').state, 'done');
   }
   // the strike is not prevented: who stays is sunk, who leaves at full speed is outside the zone
   for (const run of [false, true]) {
      w = mk('countdown'); S = w._script;
      step(w, 1);
      for (const id of S.screen.concat(S.boats)) sink(w, w.shipById(id));
      kill(w, S.sam[0]); kill(w, S.radarId); kill(w, S.sam[1]);
      w.player.setTelegraph(0);
      step(w, T.drone + 1);
      b = w.blasts.find(x => x.id === S.strikeId);
      assert.ok(b && b.state === 'armed');
      const bots = S.own.map(id => w.shipById(id)).filter(s => !s.isPlayer);
      assert.ok(bots.some(s => dist(s.pos, b) < b.r.shock), 'escorts start inside the zone');
      if (run) w.player.setTelegraph(4);
      step(w, T.fuse + 1);
      const e = w.events.find(x => x.type === 'blast' && x.blastId === b.id);
      assert.ok(e, 'detonation');
      for (const s of bots) assert.ok(s.alive && dist(s.pos, b) > b.r.shock, s.name + ' left the zone');
      if (!run) { assert.equal(w.phase, 'lost'); continue; }
      assert.equal(w.phase, 'playing');
      assert.ok(dist(w.player.pos, b) > b.r.shock && w.player.hp === w.player.maxHP, 'the flagship outran the blast');
      assert.equal(e.hit.ships, 0);
      assert.ok(radioed(w, 'Einschlag in 30 Sekunden') && radioed(w, 'Einschlag in 10 Sekunden') && radioed(w, 'Detonation achteraus'));
      assert.equal(siteById(w, S.launcherId).targetable, false);
      step(w, T.drone2 + 1);
      assert.equal(siteById(w, S.launcherId).targetable, true);
      // the bunker still stands: the launcher fires again
      step(w, T.again - T.drone2);
      assert.ok(S.strikeId && S.struck === 2, 'second strike');
   }
   // without the air defence down the strike still comes, at the latest after strikeAt
   w = mk('countdown'); S = w._script;
   w.player.setTelegraph(0);
   step(w, T.strikeAt - 1);
   assert.ok(!S.strikeId);
   step(w, 2);
   assert.ok(S.strikeId && siteById(w, S.bunkerId).targetable);
   // a submarine run has neither bunker nor strike
   w = mk('countdown', { ship: 'Virginia' });
   assert.ok(w._script.bunkerId == null && !w.sites.some(s => s.kind === 'bunker'));
   // the screen is optional
   w = mk('countdown'); S = w._script;
   step(w, 1);
   for (const id of S.screen) sink(w, w.shipById(id));
   assert.equal(obj(w, 'screen').state, 'done');
   assert.equal(w.phase, 'playing');
   // nothing left to reach the launcher with
   w.player.mag[w.player.cfg.weapons.cruise.type] = 0;
   step(w, 31);
   assert.equal(w.phase, 'lost');
   assert.match(w.result.reason, /Marschflugkörper/);
});

test('east/countdown: a submarine puts the team ashore and the charges destroy the launcher', () => {
   for (const ship of ['U212', 'Virginia']) {
      const w = mk('countdown', { ship, diff: 'easy' }), S = w._script;
      const p = w.player, tp = w.taskPoints[0];
      assert.ok(p.sub && p.cfg.sub.seal, ship + ' carries a team');
      step(w, 1);
      // the boat lies stopped at periscope depth off the launcher
      const C = { x: 9000, y: 0 }, d = dist(tp, C);
      p.pos.x = tp.x + (tp.x - C.x) / d * 1500; p.pos.y = tp.y + (tp.y - C.y) / d * 1500;
      assert.ok(!onLand(w, p.pos));
      p.ai = { ...(p.ai || {}), anchored: true, passive: true };
      w.autoPlayer = true;
      p.setTelegraph(0); p.depthTarget = 1;
      assert.ok(until(w, 60, () => { launchTeam(w, p); return p.teamOut != null; }), ship + ': team launched');
      until(w, 400, () => false);
      assert.equal(w.phase, 'won', ship + ': ' + (w.result && w.result.reason));
      assert.ok(radioed(w, 'Ladungen gezündet'));
   }
});

// ------------------------------------------------------------------------- hold-fire line, time limit
test('east: the escorts\' hold-fire is explained once; the time limit is stated and counted down', () => {
   const said = (w, part) => w.events.filter(e => e.type === 'objective' && e.text.includes(part)).length;
   const lines = { barents: 'halten ihre Seezielflugkörper zurück', reefs: 'wartet auf Ihre Feuereröffnung', philsea: 'hält Feuerdisziplin', countdown: 'warten auf Ihre Freigabe' };
   for (const id in lines) {
      const w = mk(id);
      step(w, 12);
      assert.equal(said(w, lines[id]), 0, id + ': not in the first seconds');
      step(w, 50);
      assert.equal(said(w, lines[id]), 1, id + ': hold-fire line once');
   }
   // a submarine has no escorts to wait for
   const sub = mk('countdown', { ship: 'U212' });
   step(sub, 30);
   assert.equal(said(sub, lines.countdown), 0);
   const mmss = (t) => Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
   for (const id of ['barents', 'reefs', 'strait', 'philsea']) {
      const w = mk(id), S = w._script, limit = 'Zeitlimit ' + mmss(def(id).timeLimit);
      if (id === 'barents') until(w, 400, () => !!obj(w, 'strike'));
      else step(w, 1);
      if (id === 'philsea') { w.shipById(S.foes[0]).detected = true; step(w, 0.1); }
      if (w.phase !== 'playing') continue;
      assert.ok(w.mission.objectives.some(o => !o.optional && o.state !== 'done' && o.text.includes(limit)), id + ': an open objective names the limit');
      w.timeLeft = 120.5; step(w, 2);
      assert.equal(said(w, 'zwei Minuten'), 1, id);
      w.timeLeft = 60.5; step(w, 5);
      assert.equal(said(w, 'zwei Minuten'), 1, id);
      assert.equal(said(w, 'eine Minute'), 1, id);
   }
});

// --------------------------------------------------------------- the enemy forces the decision late
test('east: late in the operation the enemy fires a reloaded salvo at the carrier (barents, philsea)', () => {
   const ssm = (w) => w.missiles.filter(m => m.alive && m.kind === 'ssm' && m.side === 'enemy').length;
   let w = mk('barents'), S = w._script, T = EAST_TUNE.barents.normal;
   step(w, T.again - 1);
   if (w.phase === 'playing' && S.phase === 2 && w.shipById(S.pjId).alive) {
      assert.ok(radioed(w, 'zweite Salve'), 'announced');
      const pj = w.shipById(S.pjId);
      for (const x of pj.cfg.weapons.ssm) pj.mag[x.type] = 0;      // empty cells: the salvo is a reload
      step(w, 12);
      assert.ok(radioed(w, 'Zweite Salve') && ssm(w) > 0, 'second salvo in the air');
   }
   // the salvo comes well before the clock runs out
   for (const k of DIFFS) {
      assert.ok(EAST_TUNE.barents[k].again < def('barents').timeLimit - 120, k);
      assert.ok(EAST_TUNE.philsea[k].salvoAt < def('philsea').timeLimit - 120, k);
   }
   w = mk('philsea'); S = w._script; T = EAST_TUNE.philsea.normal;
   w.player.setTelegraph(0);
   step(w, T.salvoAt + 8);
   const escort = S.foes.some(id => id !== S.sdId && w.shipById(id) && w.shipById(id).alive);
   if (w.phase === 'playing' && escort) assert.ok(radioed(w, 'drehen auf uns ein') && radioed(w, 'Salve vom Verband der Shandong'));
});

// ------------------------------------------------------------------------------------ balance table
test('east: balance table (EAST_BALANCE=<runs>, optional ONLY, SHIP, DIFFS, MODES)', { skip: !process.env.EAST_BALANCE }, () => {
   const runs = +process.env.EAST_BALANCE || 30;
   const only = process.env.ONLY ? process.env.ONLY.split(',') : IDS;
   const diffs = process.env.DIFFS ? process.env.DIFFS.split(',') : DIFFS;
   const modes = process.env.MODES ? process.env.MODES.split(',') : ['bot', 'passive'];
   for (const id of only) for (const ship of (process.env.SHIP ? process.env.SHIP.split(',') : [def(id).recommendedShip])) for (const diff of diffs) for (const mode of modes) {
      const d = def(id);
      let win = 0, tsum = 0, tmax = 0;
      const why = {};
      for (let i = 0; i < runs; i++) {
         const w = mk(id, { diff, ship, seed: 101 + i * 37 });
         const cap = captain(w, mode);
         let n = 0;
         while (w.phase === 'playing' && n++ < (d.timeLimit + 5) * 60) { w.update(1 / 60); cap(); }
         if (w.phase === 'won') win++;
         { const r = (w.phase === 'won' ? 'W ' : 'L ') + (w.result?.reason || ''); why[r] = (why[r] || 0) + 1; }
         tsum += w.time; tmax = Math.max(tmax, w.time);
      }
      console.log(`${id.padEnd(10)} ${ship.padEnd(12)} ${diff.padEnd(6)} ${mode.padEnd(7)} wins ${String(Math.round(100 * win / runs)).padStart(3)} %   t ${Math.round(tsum / runs)} (${Math.round(tmax)}) / ${d.timeLimit}`);
      if (process.env.WHY) for (const k in why) console.log('      ' + String(why[k]).padStart(3) + ' x ' + k);
      assert.ok(tmax <= d.timeLimit + 1);
   }
});
