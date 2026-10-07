// Special operations of gamev2/missions_special_b.js: setup for every allowed ship, objectives, the
// special rule, win and lose paths, co-op setup and one bot-captain run.
// Balance table: SPECIALB_BALANCE=30 node --test tests/v2.missions.specialb.test.mjs   (runs per difficulty)
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../gamev2/state.js';
import { MISSIONS } from '../gamev2/missions.js';
import { SPECIAL_B_TUNE, BOARD, EVAC } from '../gamev2/missions_special_b.js';
import { islandReliefAt } from '../gamev2/utils.js';
import { buildNetWorld, missionSlots } from '../gamev2/net/setup.js';
import { captain, play } from './v2.missions.specialb.captain.mjs';

const IDS = ['hijack', 'evac'];
const DIFFS = ['easy', 'normal', 'hard'];
const def = (id) => MISSIONS.find(m => m.id === id);
const mk = (id, o = {}) => new World(o.diff || 'normal', { mission: id, ship: o.ship || def(id).recommendedShip, seed: o.seed ?? 4711 });
const step = (w, secs, each) => { for (let i = 0, n = Math.round(secs * 60); i < n && w.phase === 'playing'; i++) { w.update(1 / 60); if (each) each(); } };
const onLand = (w, p) => w.obstacles.some(o => islandReliefAt(o, p) > 0);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const obj = (w, id) => w.mission.objectives.find(o => o.id === id);
const said = (w, part) => w.events.some(e => (e.text || '').includes(part));

test('specialb: the operations are registered with texts, limits and tuning', () => {
   for (const id of IDS) {
      const d = def(id);
      assert.ok(d, id);
      assert.equal(d.group, 'ops');
      assert.ok(d.briefing.length > 80 && d.debrief.length > 30, id + ' texts');
      assert.ok(d.timeLimit >= 480 && d.timeLimit <= 720, id + ' 8-12 minutes');
      assert.ok(d.playableShips.includes(d.recommendedShip));
      for (const k of DIFFS) assert.ok(SPECIAL_B_TUNE[id][k], id + ' ' + k);
   }
});

for (const id of IDS) {
   test(`specialb/${id}: sets up for every allowed ship and difficulty, nothing on land or close to the player`, () => {
      for (const ship of def(id).playableShips) for (const diff of DIFFS) {
         const w = mk(id, { ship, diff });
         assert.equal(w.phase, 'playing');
         assert.equal(w.player.cls, ship);
         const main = w.mission.objectives.filter(o => !o.optional), opt = w.mission.objectives.filter(o => o.optional);
         assert.ok(main.length >= 1 && opt.length >= 1 && opt.length <= 3, `${id}/${ship}: objectives`);
         assert.ok(main.some(o => /Zeitlimit \d+:\d\d/.test(o.text)), `${id}: the objective names the time limit`);
         for (const s of w.ships) {
            assert.ok(!onLand(w, s.pos), `${id}: ${s.name} stands on land`);
            if (s.side === 'enemy') assert.ok(dist(s.pos, w.player.pos) >= 12000, `${id}: ${s.name} starts ${Math.round(dist(s.pos, w.player.pos))} m from the player`);
         }
         for (const s of w.sites) assert.ok(onLand(w, s), `${id}: ${s.name} stands in the water`);
         for (const z of w.mission.zones) assert.ok(!onLand(w, z), `${id}: zone ${z.label} lies on land`);
      }
   });
}

// ---------------------------------------------------------------------------------------- hijack
const tanker = (w) => w.shipById(w._script.tankId);
// put ship p alongside the tanker at its speed (the test's stand-in for the helm work)
function alongside(w, p, off = 350) {
   const t = tanker(w);
   p.pos.x = t.pos.x - Math.sin(t.heading) * off; p.pos.y = t.pos.y + Math.cos(t.heading) * off;
   p.heading = t.heading; p.speed = t.speed;
}
const clearBoats = (w) => { for (const s of w.ships.slice()) if (s.alive && s.side === 'enemy' && s !== tanker(w)) w.removeShip(s, 'test'); };

test('specialb/hijack: the tanker is no target for any AI and the player is told the rule before he is near', () => {
   const w = mk('hijack');
   const t = tanker(w);
   assert.equal(t.cls, 'LNG');
   assert.ok(t.noTarget, 'protected');
   assert.ok(/explodiert/.test(def('hijack').briefing), 'the briefing states the rule');
   step(w, 30);
   assert.ok(said(w, 'Waffenbeschränkung'), 'radio: weapons restriction');
   assert.ok(said(w, 'längsseits'), 'radio: how to board');
   assert.ok(dist(w.player.pos, t.pos) > 9000, 'the rule is on the radio long before the tanker is in gun range');
   // an AI captain with the tanker in front of his guns does not fire at it
   w.autoPlayer = true;
   clearBoats(w);
   alongside(w, w.player, 2500);
   step(w, 40, () => { alongside(w, w.player, 2500); });
   assert.equal(t.hp, t.maxHP, 'no AI fire on the tanker');
});

test('specialb/hijack: boarding needs distance, matched speed and no boat at the tanker; then the mission is won', () => {
   const w = mk('hijack', { diff: 'easy' }), S = w._script, T = SPECIAL_B_TUNE.hijack.easy, p = w.player;
   step(w, 2);
   // boats at the tanker: no progress
   alongside(w, p);
   step(w, 3, () => alongside(w, p));
   assert.equal(S.board, 0, 'blocked by the boats');
   assert.ok(said(w, 'Wir können nicht übersetzen'), 'radio says why');
   clearBoats(w);
   // too far
   step(w, 3, () => alongside(w, p, BOARD.near + 200));
   assert.equal(S.board, 0, 'too far');
   // too fast
   step(w, 3, () => { alongside(w, p); p.speed = tanker(w).speed + (BOARD.dv + 3) * 2.6; });
   assert.equal(S.board, 0, 'too fast');
   assert.ok(said(w, 'Zu schnell'), 'radio says why');
   // alongside at matched speed
   step(w, T.board + 2, () => alongside(w, p));
   assert.equal(w.phase, 'won');
   assert.equal(obj(w, 'board').state, 'done');
   assert.equal(obj(w, 'clean').state, 'done');
   assert.ok(tanker(w).alive, 'the tanker is afloat');
});

test('specialb/hijack: heavy hits make the tanker explode, with warnings first; the blast hurts what is near', () => {
   const w = mk('hijack'), S = w._script, T = SPECIAL_B_TUNE.hijack.normal, p = w.player, t = tanker(w);
   step(w, 1);
   t.takeDamage(t.maxHP * 0.1, p, 'test');
   step(w, 0.2);
   assert.equal(w.phase, 'playing');
   assert.equal(obj(w, 'clean').state, 'failed');
   assert.ok(said(w, 'Treffer auf dem Tanker'), 'first warning');
   assert.ok(/Schaden 10 %/.test(obj(w, 'gas').text), 'the objective shows the damage');
   t.takeDamage(t.maxHP * (T.boom * 0.7 - 0.1), p, 'test');
   step(w, 0.2);
   assert.ok(said(w, 'Letzte Warnung'), 'last warning');
   alongside(w, p, 800);
   const hp = p.hp;
   t.takeDamage(t.maxHP * T.boom * 0.4, p, 'test');
   step(w, 5, () => { if (w.blasts.some(b => b.state === 'armed')) alongside(w, p, 800); });
   assert.equal(w.phase, 'lost');
   assert.ok(/explodiert/.test(w.result.reason));
   assert.ok(!t.alive, 'the tanker is gone');
   assert.ok(p.hp < hp, 'the blast hurt the ship beside it');
   assert.ok(S.boomId != null);
});

test('specialb/hijack: a passive captain loses when the tanker reaches the territorial waters, not on the clock', () => {
   for (const diff of DIFFS) {
      const w = mk('hijack', { diff });
      captain(w, 'passive');
      // far out of the way, so the loss comes from the tanker's arrival alone
      step(w, 730, () => { w.player.hp = w.player.maxHP; });
      assert.equal(w.phase, 'lost', diff);
      assert.ok(/Hoheitsgewässer erreicht/.test(w.result.reason), diff + ': ' + w.result.reason);
      assert.ok(w.timeLeft > 20, diff + ': the tanker arrives before the time limit');
      assert.ok(said(w, 'in zwei Minuten'), 'the radio counts the arrival down');
      if (diff !== 'easy') assert.ok(said(w, 'Küstenbatterie von Ras Dhahab'), 'the shore battery opens up');
   }
});

test('specialb/hijack: co-op takes two captains, the second sails the corvette and may board too', () => {
   assert.equal(missionSlots('hijack'), 2);
   const classes = ['Sachsen', 'Braunschweig'];
   const w = buildNetWorld({ mission: 'hijack', difficulty: 'easy', seed: 7, classes, loadouts: [null, null], self: 0 });
   const S = w._script, two = w.net.humans[1];
   assert.ok(two && two.human && S.own.includes(two.id), 'the second captain has the mission\'s corvette');
   step(w, 2);
   clearBoats(w);
   step(w, SPECIAL_B_TUNE.hijack.easy.board + 2, () => alongside(w, two));
   assert.equal(w.phase, 'won', 'the second captain boarded');
});

test('specialb/hijack: the bot captain wins on easy', () => {
   const w = play('hijack', { diff: 'easy', seed: 1000 });
   assert.equal(w.phase, 'won', w.result && w.result.reason);
});

// ---------------------------------------------------------------------------------------- evac
// put ship p on station in the pickup zone at `kn` knots
const station = (w, p, kn = 0, off = 0) => { const z = w._script.zone; p.pos.x = z.x - off; p.pos.y = z.y; p.speed = kn * 2.6; p.setTelegraph(0); };

test('specialb/evac: people come aboard only on station, slow and with no boat near; the rule is announced', () => {
   const w = mk('evac', { diff: 'easy' }), S = w._script, T = SPECIAL_B_TUNE.evac.easy, p = w.player;
   assert.ok(/Aufnahmezone/.test(def('evac').briefing) && /verpasst/.test(def('evac').briefing) && /Fähre sinkt/.test(def('evac').briefing), 'briefing: rule and loss conditions');
   assert.equal(w.shipById(S.ferryId).side, 'player', 'the ferry is a ship to protect');
   step(w, T.first + 1, () => { p.hp = p.maxHP; });
   assert.ok(said(w, 'höchstens 6 Knoten'), 'radio: the rule before the first window');
   assert.equal(S.stage, 1, 'window open');
   for (const s of w.ships.slice()) if (s.side === 'enemy') w.removeShip(s, 'test');
   step(w, 3, () => station(w, p, 0, EVAC.r + 300));
   assert.equal(S.load, 0, 'outside the zone');
   step(w, 3, () => station(w, p, EVAC.slowKn + 4));
   assert.equal(S.load, 0, 'too fast');
   step(w, 5, () => station(w, p));
   assert.ok(S.load > 4, 'loading on station');
   assert.ok(/Transport 1\/3: \d+\/40 an Bord/.test(obj(w, 'lifts').text), obj(w, 'lifts').text);
   step(w, T.load, () => station(w, p));
   assert.equal(S.done, 1);
   assert.equal(S.aboard, EVAC.people);
});

test('specialb/evac: a passive captain loses on missed lifts, not on the clock; a sunk ferry loses at once', () => {
   for (const diff of DIFFS) {
      const w = mk('evac', { diff }), f = w.shipById(w._script.ferryId);
      captain(w, 'passive');
      step(w, 720, () => { w.player.hp = w.player.maxHP; f.hp = f.maxHP; });
      assert.equal(w.phase, 'lost', diff);
      assert.ok(/Zu viele Transporte verpasst/.test(w.result.reason), diff + ': ' + w.result.reason);
      assert.ok(w.timeLeft > 60, diff + ': before the time limit');
   }
   const w = mk('evac'), f = w.shipById(w._script.ferryId);
   step(w, 1);
   f.takeDamage(f.maxHP * 2, null, 'test');
   step(w, 0.2);
   assert.equal(w.phase, 'lost');
   assert.ok(/Fähre Calvera Star ist gesunken/.test(w.result.reason));
});

test('specialb/evac: after the last lift the ferry sails and the mission is won when it is out; co-op has two captains', () => {
   const w = mk('evac', { diff: 'easy' }), S = w._script, p = w.player, f = w.shipById(S.ferryId);
   const calm = () => { station(w, p); p.hp = p.maxHP; f.hp = f.maxHP; for (const s of w.ships.slice()) if (s.alive && s.side === 'enemy') w.removeShip(s, 'test'); };
   step(w, 700, () => { calm(); if (S.stage === 2) { f.pos.x = S.exit.x; f.pos.y = S.exit.y; } });
   assert.equal(w.phase, 'won', w.result && w.result.reason);
   assert.equal(S.done, 3);
   assert.equal(obj(w, 'all').state, 'done');
   assert.equal(obj(w, 'hull').state, 'done');
   assert.equal(missionSlots('evac'), 2);
});

test('specialb/evac: the bot captain wins on easy', () => {
   const w = play('evac', { diff: 'easy', seed: 1000 });
   assert.equal(w.phase, 'won', w.result && w.result.reason);
});

if (process.env.SPECIALB_BALANCE) {
   test('specialb: balance table', { timeout: 0 }, () => {
      const runs = +process.env.SPECIALB_BALANCE;
      for (const id of IDS) for (const diff of DIFFS) {
         let wins = 0; const why = {};
         for (let i = 0; i < runs; i++) { const w = play(id, { diff, seed: 1000 + i * 7919 }); if (w.phase === 'won') wins++; else { const r = w.result.reason.slice(0, 50); why[r] = (why[r] || 0) + 1; } }
         console.log(`${id.padEnd(10)} ${diff.padEnd(6)} ${wins}/${runs} = ${Math.round(wins / runs * 100)} %  ${JSON.stringify(why)}`);
      }
   });
}
