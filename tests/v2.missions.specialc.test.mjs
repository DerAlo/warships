// Special operations of gamev2/missions_special_d.js (mayday, gunline, airbase): setup for every allowed ship
// and difficulty, objectives, the special rules, win and lose paths, the merchant rule and bot-captain runs.
// Balance table: node tests/v2.missions.speciald.captain.mjs <id> [runs]
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../gamev2/state.js';
import { MISSIONS } from '../gamev2/missions.js';
import { SPECIAL_D_TUNE, MAYDAY } from '../gamev2/missions_special_d.js';
import { islandReliefAt } from '../gamev2/utils.js';
import { damageSite } from '../gamev2/sites.js';
import { sendHelo } from '../gamev2/helo.js';
import { play } from './v2.missions.speciald.captain.mjs';

const IDS = ['mayday', 'gunline', 'airbase'];
const DIFFS = ['easy', 'normal', 'hard'];
const SEEDS = [1000, 8919, 16838, 24757, 32676, 40595];
const def = (id) => MISSIONS.find(m => m.id === id);
const mk = (id, o = {}) => new World(o.diff || 'normal', { mission: id, ship: o.ship || def(id).recommendedShip, seed: o.seed ?? 4711 });
const step = (w, secs, each) => { for (let i = 0, n = Math.round(secs * 60); i < n && w.phase === 'playing'; i++) { w.update(1 / 60); if (each) each(); } };
const onLand = (w, p) => w.obstacles.some(o => islandReliefAt(o, p) > 0);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const obj = (w, id) => w.mission.objectives.find(o => o.id === id);
const said = (w, part) => w.events.some(e => (e.text || '').includes(part));
const site = (w, id) => w.sites.find(s => s.id === id);
const enemies = (w) => w.ships.filter(s => s.alive && s.side === 'enemy');
const clearEnemies = (w) => { for (const s of enemies(w)) w.removeShip(s, 'test'); };

test('specialc: the operations are registered with texts, limits, conditions and tuning', () => {
   const env = new Set();
   for (const id of IDS) {
      const d = def(id);
      assert.ok(d, id);
      assert.equal(d.group, 'ops');
      assert.ok(d.briefing.length > 80 && d.debrief.length > 30, id + ' texts');
      assert.ok(d.timeLimit >= 480 && d.timeLimit <= 720, id + ' 8-12 minutes');
      assert.ok(d.stars >= 1 && d.stars <= 3);
      assert.ok(d.playableShips.includes(d.recommendedShip));
      for (const k of DIFFS) assert.ok(SPECIAL_D_TUNE[id][k], id + ' ' + k);
      env.add(d.env.time + '/' + d.env.weather);
   }
   assert.equal(env.size, 3, 'each operation has its own time and weather');
});

for (const id of IDS) {
   test(`specialc/${id}: sets up for every allowed ship and difficulty, sites on land, zones and ships in the water`, () => {
      for (const ship of def(id).playableShips) for (const diff of DIFFS) {
         const w = mk(id, { ship, diff });
         assert.equal(w.phase, 'playing');
         assert.equal(w.player.cls, ship);
         const main = w.mission.objectives.filter(o => !o.optional), opt = w.mission.objectives.filter(o => o.optional);
         assert.ok(main.length >= 1 && opt.length >= 1 && opt.length <= 3, `${id}/${ship}: objectives`);
         assert.ok(main.some(o => /\(Zeitlimit \d+:\d\d\)/.test(o.text)), `${id}: the objective names the time limit`);
         for (const s of w.ships) {
            assert.ok(!onLand(w, s.pos), `${id}: ${s.name} stands on land`);
            if (s.side === 'enemy') assert.ok(dist(s.pos, w.player.pos) >= 9000, `${id}: ${s.name} starts ${Math.round(dist(s.pos, w.player.pos))} m from the player`);
         }
         for (const s of w.sites) {
            assert.ok(onLand(w, s), `${id}: ${s.name} stands in the water`);
            assert.ok(dist(s, w.player.pos) >= 9000, `${id}: ${s.name} lies close to the player`);
         }
         for (const z of w.mission.zones) if (z.kind !== 'danger') assert.ok(!onLand(w, z), `${id}: zone ${z.label} lies on land`);
      }
   });

   test(`specialc/${id}: the merchants are no target for the enemy, and a hit merchant loses the operation`, () => {
      const w = mk(id), S = w._script;
      assert.ok(S.merch.length >= 1);
      for (const mid of S.merch) {
         const m = w.shipById(mid);
         assert.equal(m.side, 'player', 'protected, on our side');
         m.detected = true;
         assert.equal(m.detected, false, 'never detected by the enemy');
         assert.equal(m.targetable, false);
      }
      step(w, 2);
      const m = w.shipById(S.merch[0]);
      m.takeDamage(m.maxHP * 0.3, w.player, 'test');
      step(w, 1);
      assert.equal(w.phase, 'lost');
      assert.match(w.result.reason, /Frachter|Hallig|Seewind/);
   });

   test(`specialc/${id}: a passive captain loses before the time limit on every difficulty`, () => {
      for (const diff of DIFFS) {
         const w = play(id, { diff, seed: 1000, mode: 'passive' });
         assert.equal(w.phase, 'lost', `${id}/${diff}`);
         assert.ok(w.time < def(id).timeLimit - 30, `${id}/${diff}: lost at ${Math.round(w.time)} s`);
      }
   });

   test(`specialc/${id}: the bot captain wins on easy, can win on normal and can lose on hard`, { timeout: 0 }, () => {
      const e = play(id, { diff: 'easy', seed: 1000 });
      assert.equal(e.phase, 'won', e.result && e.result.reason);
      assert.ok(e.time < def(id).timeLimit);
      const n = SEEDS.map(seed => play(id, { diff: 'normal', seed }).phase);
      assert.ok(n.includes('won'), 'normal can be won: ' + n);
      const h = SEEDS.map(seed => play(id, { diff: 'hard', seed }).phase);
      assert.ok(h.includes('lost'), 'hard is not a walkover: ' + h);
   });
}

// ---------------------------------------------------------------------------------------- mayday
test('specialc/mayday: the raft drifts toward the coast; a boat at the raft takes the crew', () => {
   const w = mk('mayday', { diff: 'normal' }), S = w._script, T = SPECIAL_D_TUNE.mayday.normal;
   const d0 = dist(S.raft, S.coast);
   step(w, 20);
   assert.ok(dist(S.raft, S.coast) < d0 - T.drift * 15, 'drifts toward Kap Korsk');
   step(w, T.boatsAt - 18);
   assert.ok(S.grabbers.length >= 1, 'a boat heads for the raft');
   const b = w.shipById(S.grabbers[0]);
   step(w, T.grab + 5, () => { b.pos.x = S.raft.x + 100; b.pos.y = S.raft.y; b.speed = 0; });
   assert.equal(w.phase, 'lost');
   assert.match(w.result.reason, /an Bord genommen/);
   assert.equal(obj(w, 'rescue').state, 'failed');
});

test('specialc/mayday: alongside at a crawl with no boat near picks the crew up; too fast does not', () => {
   const w = mk('mayday', { diff: 'easy' }), S = w._script, T = SPECIAL_D_TUNE.mayday.easy, p = w.player;
   step(w, 2);
   clearEnemies(w);
   step(w, 4, () => { p.pos.x = S.raft.x + 150; p.pos.y = S.raft.y; p.speed = (MAYDAY.pickKn + 4) * 2.6; });
   assert.equal(S.pick, 0, 'too fast');
   assert.ok(said(w, 'Zu schnell'));
   step(w, T.pick + 2, () => { p.pos.x = S.raft.x + 150; p.pos.y = S.raft.y; p.speed = 0; });
   assert.equal(w.phase, 'won', w.result && w.result.reason);
   assert.equal(obj(w, 'rescue').state, 'done');
   assert.equal(obj(w, 'merch').state, 'done');
});

test('specialc/mayday: the helicopter hoists the crew and wins when it lands on its ship again', { timeout: 0 }, () => {
   const w = mk('mayday', { diff: 'easy' }), S = w._script, p = w.player;
   step(w, 2);
   clearEnemies(w);
   p.pos.x = S.raft.x - 3000; p.pos.y = S.raft.y; p.setTelegraph(0); p.speed = 0;
   assert.ok(p.cfg.helo, 'the recommended ship carries a helicopter');
   sendHelo(w, p, S.raft);
   let helo = false;
   step(w, 300, () => { if (S.crew === 'helo') helo = true; });
   assert.ok(helo, 'the crew was in the helicopter');
   assert.equal(w.phase, 'won', w.result && w.result.reason);
   assert.match(w.result.reason, /Hubschrauber ist gelandet/);
});

// ---------------------------------------------------------------------------------------- gunline
test('specialc/gunline: fire missions open one after the other; a target destroyed in its window counts', () => {
   const w = mk('gunline', { diff: 'easy' }), S = w._script, T = SPECIAL_D_TUNE.gunline.easy;
   for (const id of S.targets) assert.ok(!site(w, id).detected, 'hidden until called');
   step(w, T.first + 1);
   assert.equal(S.k, 0); assert.ok(S.open);
   assert.ok(site(w, S.targets[0]).detected, 'the open target is on the chart');
   assert.ok(said(w, 'Feuerauftrag 1'));
   for (let k = 0; k < T.n; k++) {
      step(w, T.gap + 2, () => { if (!S.open && S.k + 1 < T.n && S.k === k - 1) S.nextT = Math.min(S.nextT, w.time); });
      if (w.phase !== 'playing') break;
      assert.equal(S.k, k); assert.ok(S.open, 'mission ' + k + ' open');
      clearEnemies(w);
      damageSite(w, site(w, S.targets[k]), 1e9, w.player, 'shell');
      step(w, 1);
      assert.equal(S.dead, k + 1);
   }
   step(w, 2);
   assert.equal(w.phase, 'won', w.result && w.result.reason);
   assert.equal(obj(w, 'fire').state, 'done');
   assert.equal(obj(w, 'all').state, 'done');
});

test('specialc/gunline: a closed window is a miss; more misses than allowed lose', () => {
   const w = mk('gunline', { diff: 'normal' }), S = w._script, T = SPECIAL_D_TUNE.gunline.normal;
   step(w, T.first + T.win + 2, () => clearEnemies(w));
   assert.equal(S.missed, 1);
   assert.equal(obj(w, 'all').state, 'failed');
   assert.equal(w.phase, 'playing', 'one miss is allowed on normal');
   step(w, T.gap + T.win + 4, () => clearEnemies(w));
   assert.equal(w.phase, 'lost');
   assert.match(w.result.reason, /verfehlt/);
});

test('specialc/gunline: the coast battery goes on the air with the mission named in the tuning', () => {
   const w = mk('gunline', { diff: 'hard' }), S = w._script, T = SPECIAL_D_TUNE.gunline.hard;
   const bat = site(w, S.batId);
   assert.ok(!bat.detected && !bat.radarOn);
   for (let k = 0; k < T.batAt; k++) {
      step(w, k ? T.gap + 1 : T.first + 1, () => clearEnemies(w));
      damageSite(w, site(w, S.targets[k]), 1e9, w.player, 'shell');
      step(w, 0.6);
   }
   assert.ok(bat.radarOn && bat.detected, 'the battery is up and on the chart');
   damageSite(w, bat, 1e9, w.player, 'shell');
   step(w, 1);
   assert.equal(obj(w, 'bat').state, 'done');
});

// ---------------------------------------------------------------------------------------- airbase
test('specialc/airbase: the airfield destroyed before the raid wins; the deadline loses', () => {
   const w = mk('airbase', { diff: 'normal' }), S = w._script, T = SPECIAL_D_TUNE.airbase.normal;
   assert.equal(w.player.mag.tomahawk, T.tlam, 'the cruise-missile load of the difficulty');
   step(w, 5);
   damageSite(w, site(w, S.depotId), 1e9, w.player, 'cruise');
   damageSite(w, site(w, S.fieldId), 1e9, w.player, 'cruise');
   step(w, 1);
   assert.equal(w.phase, 'won', w.result && w.result.reason);
   assert.equal(obj(w, 'depot').state, 'done');
   const v = mk('airbase', { diff: 'normal' });
   step(v, T.deadline + 2, () => { v.player.hp = v.player.maxHP; const t = v.shipById(v._script.tankId); t.hp = t.maxHP; });
   assert.equal(v.phase, 'lost');
   assert.match(v.result.reason, /Großangriff/);
   assert.ok(said(v, 'zwei Minuten') && said(v, 'einer Minute'), 'countdown on the radio');
});

test('specialc/airbase: a hidden SAM site that fires is located; the tanker lost loses', () => {
   const w = mk('airbase', { diff: 'hard' }), S = w._script;
   const sam = site(w, S.sams[0]);
   assert.ok(!sam.detected);
   sam.mag.hq16 -= 1;
   step(w, 1);
   assert.ok(sam.detected && sam.targetable, 'located');
   assert.ok(said(w, 'hat geschossen'));
   const t = w.shipById(S.tankId);
   t.takeDamage(t.maxHP * 2, w.player, 'test');
   step(w, 1);
   assert.equal(w.phase, 'lost');
   assert.match(w.result.reason, /Versorger/);
});
