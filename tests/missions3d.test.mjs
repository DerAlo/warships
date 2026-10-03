// tests/missions3d.test.mjs — headless tests for the second mission batch (game3d/missions_extra.js):
// every mission loads on every difficulty with a valid map, can be won and can be lost, and a
// short AI-captained run stays free of exceptions and NaN.  Run: node --test tests/missions3d.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../game3d/state.js';
import { MISSIONS, MISSION_IDS, getMission, opStars } from '../game3d/missions.js';
import { PLAYABLE } from '../game3d/config.js';
import { obstacleT } from '../game3d/utils.js';

const DT = 1 / 60;
const BATTLES = ['strait', 'rearguard', 'fleet'];
const OPS = { cerberus: 'Scharnhorst', vian: 'Jervis', barents: 'Fiji', narvik: 'Jervis', matapan: 'Warspite', dakar: 'Richelieu', wahoo: 'Gato', spartivento: 'Littorio' };
const NEW = [...BATTLES, ...Object.keys(OPS)];
const byName = (w, n) => w.ships.find(s => s.name === n);
const sink = (s, by) => s.takeDamage(s.hp + 1, by, 'citadel');
const obj = (w, id) => w.mission.objectives.find(o => o.id === id);
const world = (id, diff = 'normal', seed = 3) => new World(diff, { mission: id, seed });
function runTo(w, t) { while (w.phase === 'playing' && w.time < t) w.update(DT); }
const put = (s, z) => { s.pos.x = z.x; s.pos.y = z.y; };
const foes = (w) => w.ships.filter(s => s.alive && s.side === 'enemy');

test('new missions: catalogue order, menu data, fixed ships of the ops', () => {
   for (const id of NEW) assert.ok(MISSION_IDS.includes(id), `${id} missing`);
   // battles stay together, the ops section stays contiguous at the end of the list
   const firstOp = MISSIONS.findIndex(m => m.group === 'ops');
   assert.ok(MISSIONS.slice(firstOp).every(m => m.group === 'ops'), 'ops are contiguous');
   assert.ok(MISSIONS.slice(0, firstOp).every(m => m.group === 'battle'));
   assert.strictEqual(new Set(MISSION_IDS).size, MISSION_IDS.length, 'unique ids');
   for (const id of BATTLES) {
      const m = getMission(id);
      assert.strictEqual(m.group, 'battle');
      assert.deepStrictEqual(m.playableShips, PLAYABLE);
      assert.ok(m.briefing.length > 120 && m.subtitle && m.timeLimit > 0, `${id} menu data`);
   }
   for (const [id, cls] of Object.entries(OPS)) {
      const m = getMission(id);
      assert.strictEqual(m.group, 'ops');
      assert.deepStrictEqual(m.playableShips, [cls]);
      assert.ok(m.briefing.length > 120 && m.debrief.length > 120 && m.fleet.own && m.fleet.foe, `${id} briefing/debrief/fleet`);
   }
});

for (const id of NEW) {
   test(`"${id}": valid world on every difficulty (objectives, zones on open water, nobody on land)`, () => {
      const ships = OPS[id] ? [OPS[id]] : PLAYABLE;
      for (const diff of ['easy', 'normal', 'hard']) for (const ship of ships) {
         const w = new World(diff, { mission: id, ship, seed: 5 });
         assert.strictEqual(w.player.cls, ship, `${id} player ship`);
         assert.ok(w.mission.objectives.filter(o => !o.optional).length >= 1, `${id} objectives`);
         assert.ok(w.mission.objectives.every(o => o.text && !/undefined|NaN/.test(o.text)), `${id} objective text`);
         assert.ok(w.mission.zones.length >= (id === 'fleet' ? 0 : 1), `${id} zones`);
         for (const z of w.mission.zones) {
            assert.ok(Math.abs(z.x) + z.r < w.arena && Math.abs(z.y) + z.r < w.arena, `${id} zone ${z.label} inside the arena`);
            for (const o of w.obstacles) assert.ok(obstacleT(o, z) > 1.05, `${id} zone ${z.label} on open water`);
         }
         for (const s of w.ships) {
            assert.ok(Math.abs(s.pos.x) < w.arena && Math.abs(s.pos.y) < w.arena, `${id} ${s.name} inside the arena`);
            for (const o of w.obstacles) assert.ok(obstacleT(o, s.pos) > 1, `${id} ${s.name} spawned on land`);
         }
         assert.ok(w.ships.some(s => s.side === 'enemy'), `${id} has enemies`);
      }
   });

   test(`"${id}": 4 min AI-captained run without exceptions or NaN, late spawns on open water`, () => {
      const w = world(id, 'normal', 17);
      w.autoPlayer = true;
      runTo(w, 240);
      for (const s of w.roster) {
         assert.ok([s.pos.x, s.pos.y, s.heading, s.speed, s.hp].every(Number.isFinite), `${id} ${s.name} NaN`);
         if (s.alive) for (const o of w.obstacles) assert.ok(obstacleT(o, s.pos) > 0.9, `${id} ${s.name} on land`);
      }
      assert.ok(w.mission.objectives.every(o => !/undefined|NaN/.test(o.text)), `${id} objective text`);
      assert.ok(['playing', 'won', 'lost'].includes(w.phase));
   });

   test(`"${id}": the player ship sinking loses the mission`, () => {
      const w = world(id);
      sink(w.player, foes(w)[0]);
      w.update(DT);
      assert.strictEqual(w.phase, 'lost');
      assert.strictEqual(opStars(w), 0);
   });
}

test('Sperrriegel: three breakthroughs lose, holding out or sinking every wave wins', () => {
   let w = world('strait');
   const h = w.mission.zones[0];
   const runners = w._script.runners.slice(0, 3);
   put(runners[0], h); put(runners[1], h); w.update(DT);
   assert.strictEqual(w.phase, 'playing');
   assert.strictEqual(w._script.broke, 2);
   assert.match(obj(w, 'hold').text, /2 durchgebrochen/);
   assert.strictEqual(obj(w, 'all').state, 'failed');
   put(runners[2], h); w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(obj(w, 'hold').state, 'failed');
   // sink everything as it arrives: three waves, then victory with the optional objective
   w = world('strait');
   const seen = new Set();
   while (w.phase === 'playing' && w.time < 400) {
      for (const s of foes(w)) { seen.add(s.name); sink(s, w.player); }
      w.update(DT);
   }
   assert.strictEqual(w.phase, 'won');
   assert.ok(seen.size >= 8, `only ${seen.size} attackers`);
   assert.ok(w.time > 329, 'the third wave has to arrive first');
   assert.strictEqual(obj(w, 'all').state, 'done');
   // one ship gets through, the clock runs out: still a win, but no full marks
   w = world('strait');
   put(w._script.runners[0], w.mission.zones[0]); w.update(DT);
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.notStrictEqual(obj(w, 'all').state, 'done');
});

test('Rückzugsgefecht: Gneisenau reaching the fjord wins, her loss or the clock loses', () => {
   let w = world('rearguard');
   const g = byName(w, 'Gneisenau');
   assert.ok(g.hp < g.maxHP && g.side === 'player');
   const x0 = g.pos.x;
   runTo(w, 30);
   assert.ok(g.pos.x > x0 + 300, 'Gneisenau steams east on her own');
   put(g, w.mission.zones[0]); w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'cover').state, 'done');
   w = world('rearguard');
   sink(byName(w, 'Gneisenau'), foes(w)[0]);
   assert.strictEqual(w.phase, 'lost');
   w = world('rearguard');
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   // optional: two pursuers
   w = world('rearguard');
   const c = w._script.chasers;
   sink(c[0], w.player); sink(c[1], w.player);
   assert.strictEqual(obj(w, 'kills').state, 'done');
   assert.strictEqual(w.phase, 'playing');
});

test('Flottenschlacht: 8 vs 8, enemy capital ships sunk wins, own line lost loses', () => {
   let w = world('fleet');
   assert.strictEqual(w.ships.filter(s => s.side === 'player').length, 8);
   assert.strictEqual(w.ships.filter(s => s.side === 'enemy').length, 8);
   const S = w._script;
   assert.strictEqual(S.foe.length, 3);
   sink(S.foe[0], w.player); sink(S.foe[1], w.player);
   assert.strictEqual(w.phase, 'playing');
   assert.match(obj(w, 'line').text, /2\/3/);
   sink(S.foe[2], w.player);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'light').state, 'done');
   // player in a cruiser: the battle line is lost when the three battleships are gone
   w = new World('normal', { mission: 'fleet', ship: 'Hipper', seed: 3 });
   assert.strictEqual(w._script.own.length, 3);
   for (const s of w._script.own) sink(s, foes(w)[0]);
   assert.strictEqual(w.phase, 'lost');
   // timeout: decided by what is left of the two battle lines
   w = world('fleet');
   w._script.foe[0].hp *= 0.2; w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'won');
   w = world('fleet');
   w._script.own[1].hp *= 0.2; w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
});

test('Cerberus: mines slow the ship, reaching the North Sea wins, the clock loses', () => {
   let w = world('cerberus');
   const p = w.player, base = p.maxSpeedKn, hp0 = p.hp;
   assert.strictEqual(w._script.mines.length, 2);
   assert.strictEqual(world('cerberus', 'easy')._script.mines.length, 1);
   p.pos.x = w._script.mines[0] + 5; w.update(DT);
   assert.ok(p.hp < hp0 && p.hp > hp0 * 0.85, 'mine damage');
   assert.ok(p.maxSpeedKn < base, 'slowed');
   assert.strictEqual(w._script.mines.length, 1);
   runTo(w, w.time + 32);
   assert.strictEqual(p.maxSpeedKn, base, 'speed restored');
   // a mine never sinks the ship outright
   const w2 = world('cerberus');
   w2.player.hp = 100; w2.player.pos.x = w2._script.mines[0] + 5; w2.update(DT);
   assert.ok(w2.player.alive);
   // destroyers arrive, the exit wins
   runTo(w, 180);
   assert.ok(w._script.dds.length >= 4, 'two destroyer waves');
   put(p, w.mission.zones[0]); w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'break').state, 'done');
   w = world('cerberus');
   sink(byName(w, 'Gneisenau'), null);
   assert.strictEqual(obj(w, 'ships').state, 'failed');
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
});

test('Vians Nachtangriff: torpedo hits win, a wasted night loses', () => {
   let w = world('vian');
   const b = byName(w, 'Bismarck');
   assert.strictEqual(w.env.time, 'night');
   w.stats.torpHits = 2; w.update(DT);
   assert.strictEqual(w.phase, 'playing');
   assert.match(obj(w, 'torp').text, /2\/3/);
   w.stats.torpHits = 3; w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'flot').state, 'done');
   assert.strictEqual(opStars(w), 2);
   assert.strictEqual(world('vian', 'easy')._script.need, 2);
   assert.strictEqual(world('vian', 'hard')._script.need, 4);
   w = world('vian');
   sink(byName(w, 'HMS Zulu'), b);
   assert.strictEqual(obj(w, 'flot').state, 'failed');
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   w = world('vian');
   sink(byName(w, 'Bismarck'), w.player);
   assert.strictEqual(w.phase, 'won');
});

test('Barentssee: Hipper driven off or sunk wins, three freighters lost lose', () => {
   let w = world('barents');
   const h = byName(w, 'Admiral Hipper');
   h.hp = h.maxHP * 0.2;
   runTo(w, 60);
   assert.strictEqual(w.phase, 'won', 'a mauled Hipper breaks off');
   assert.strictEqual(h.escaped, 'retreated');
   assert.strictEqual(obj(w, 'hipper').state, 'done');
   w = world('barents');
   sink(byName(w, 'Friedrich Eckoldt'), w.player);
   assert.strictEqual(obj(w, 'eckoldt').state, 'done');
   sink(byName(w, 'Admiral Hipper'), w.player);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(opStars(w), 2);
   w = world('barents');
   const t = w._script.transports, e = foes(w)[0];
   assert.strictEqual(t.length, 5);
   sink(t[0], e); sink(t[1], e);
   assert.strictEqual(w.phase, 'playing');
   sink(t[2], e);
   assert.strictEqual(w.phase, 'lost');
   w = world('barents');
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
});

test('Narvik: freighters first, then the withdrawal to the Vestfjord wins', () => {
   let w = world('narvik');
   const S = w._script, p = w.player;
   assert.strictEqual(S.ships.length, 6);
   assert.ok(S.berth.every(s => s.ai.passive), 'destroyers asleep at their berths');
   const exit = w.mission.zones.find(z => z.label === 'Vestfjord');
   put(p, exit); w.update(DT);
   assert.strictEqual(w.phase, 'playing', 'the exit does not count before the raid');
   sink(S.ships[0], p);
   assert.ok(S.berth.every(s => !s.ai.passive), 'first sinking wakes the harbour');
   for (let i = 1; i < S.need; i++) sink(S.ships[i], p);
   assert.strictEqual(obj(w, 'sink').state, 'done');
   assert.ok(obj(w, 'out'), 'withdrawal objective appears');
   p.pos.x = 0; p.pos.y = 0;
   const n0 = foes(w).length;
   runTo(w, w.time + 60);
   assert.ok(foes(w).length + w.roster.filter(s => s.side === 'enemy' && !s.alive).length > n0, 'destroyers from the side fjords');
   if (w.phase === 'playing') { put(p, exit); w.update(DT); assert.strictEqual(w.phase, 'won'); }
   // the alarm goes off by itself after a while
   w = world('narvik');
   runTo(w, 72);
   assert.ok(w._script.berth.every(s => !s.ai.passive));
   // too slow: lost
   w = world('narvik');
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(obj(w, 'sink').state, 'failed');
});

test('Matapan: the first hit wakes the Italians, two of three cruisers sunk win, two escaping lose', () => {
   let w = world('matapan');
   const S = w._script, p = w.player;
   assert.strictEqual(S.targets.length, 3);
   assert.ok(S.italians.every(s => s.ai.passive), 'the column steams on unaware');
   S.cruisers[0].takeDamage(100, p, 'he');
   w.update(DT);
   assert.ok(S.dds.every(d => !d.ai.passive), 'the destroyers react at once');
   assert.ok(S.cruisers.every(c => c.ai.passive), 'the cruisers are still surprised');
   runTo(w, w.time + S.surprise + 1);
   assert.ok(S.cruisers.every(c => !c.alive || !c.ai.passive), 'then the cruisers run');
   sink(S.pola, p);
   assert.strictEqual(w.phase, 'playing');
   sink(S.cruisers[1], p);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(obj(w, 'cruisers').state, 'done');
   // the fleet is noticed after a while anyway
   w = world('matapan');
   runTo(w, w._script.wakeT + 1);
   assert.ok(w._script.awake);
   // two cruisers reaching the open sea: lost
   w = world('matapan');
   for (const c of w._script.cruisers) put(c, w._script.exit);
   w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   w = world('matapan');
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
});

test('Dakar: both battleships broken off win, two transports landed lose, the clock wins', () => {
   let w = world('dakar');
   const S = w._script;
   assert.ok(w.player.maxSpeedKn <= 12.5, 'Richelieu cannot leave the roads at speed');
   for (const b of S.bbs) b.hp = b.maxHP * 0.3;
   runTo(w, w.time + 60);
   assert.strictEqual(w.phase, 'won', 'both battleships turn away');
   assert.strictEqual(obj(w, 'bbs').state, 'done');
   w = world('dakar');
   put(w._script.transports[0], w._script.landing); w.update(DT);
   assert.strictEqual(w.phase, 'playing', 'one landing is survivable');
   put(w._script.transports[1], w._script.landing); w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(obj(w, 'landing').state, 'failed');
   // the submarine's torpedo slows the second battleship
   w = world('dakar');
   const r = w._script.bbs[1], hp0 = r.hp;
   runTo(w, w._script.torpT + 1);
   if (r.alive && !r.ai.retreating) assert.ok(r.hp < hp0 && r.maxSpeedKn <= 12);
   w = world('dakar');
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'won');
});

test('Wahoo: the boat alone, enough ships sunk win, the convoy escaping loses', () => {
   let w = world('wahoo');
   const S = w._script, p = w.player;
   assert.strictEqual(p.cls, 'Gato');
   assert.ok(!w.ships.some(s => s.side === 'player' && s !== p), 'no allied ship');
   assert.strictEqual(S.transports.length, 4);
   for (let i = 0; i < S.need - 1; i++) sink(S.transports[i], p);
   assert.strictEqual(w.phase, 'playing');
   sink(S.escorts[0], p);
   assert.strictEqual(obj(w, 'dd').state, 'done');
   sink(S.transports[S.need - 1], p);
   assert.strictEqual(w.phase, 'won');
   w = world('wahoo');
   for (let i = 0; i <= 4 - w._script.need; i++) put(w._script.transports[i], w._script.exit);
   w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   w = world('wahoo');
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
});

test('Spartivento: cruisers sunk, then the withdrawal east wins; a mauled flagship loses', () => {
   let w = world('spartivento');
   const S = w._script, p = w.player;
   put(p, S.exit); w.update(DT);
   assert.strictEqual(w.phase, 'playing', 'no withdrawal before the cruiser screen is broken');
   for (let i = 0; i < S.need; i++) sink(S.cruisers[i], p);
   assert.ok(S.phase2 && obj(w, 'out'), 'withdrawal ordered');
   assert.strictEqual(obj(w, 'berwick').state, 'done');
   w.update(DT);
   assert.strictEqual(w.phase, 'won');
   // the heavy ships come up later
   w = world('spartivento');
   runTo(w, 250);
   assert.ok(w._script.heavy.length >= 1, 'Renown arrives');
   // Supermarina's order: the battleship is not to be risked
   w = world('spartivento');
   w.player.hp = w.player.maxHP * (w._script.limit - 0.01); w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   w = world('spartivento');
   w.timeLeft = 0; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
});
