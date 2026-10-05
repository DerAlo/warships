// Operations 1-5 of the modern mode (gamev2/missions_west.js): catalogue, setup for every allowed
// ship and difficulty, nothing on land or inside weapon range at the start, scripted events,
// objectives, win and lose, co-op setup with 2 and 4 captains.
//
// Balance table (not part of the pass/fail suite):
//    BALANCE=30 node tests/v2.missions.west.test.mjs            30 seeded runs per mission, difficulty and captain
//    BALANCE=30 ONLY=hormus,giuk DIFFS=normal node tests/v2.missions.west.test.mjs
// Captains: 'bot' = the sim's AI captain on the player ship with the mission hint a sensible player
// follows (stay with the convoy, ...), 'passive' = the player ship lies stopped and does nothing.
// The stealth mission (pipeline) is flown by a scripted route instead of the combat AI.
import { test } from 'node:test';
import { damageSite } from '../gamev2/sites.js';
import assert from 'node:assert/strict';
import { World } from '../gamev2/state.js';
import { MISSIONS, getMission, opStars } from '../gamev2/missions.js';
import { SHIPS, MISSILES } from '../gamev2/config.js';
import { obstacleT } from '../gamev2/utils.js';
import { buildNetWorld } from '../gamev2/net/setup.js';
import { orderDepth } from '../gamev2/submarine.js';
import { launchTeam, teamStatus } from '../gamev2/seal.js';

const IDS = ['hormus', 'redsea', 'pipeline', 'blacksea', 'giuk'].filter(id => getMission(id));
const DIFFS = ['easy', 'normal', 'hard'];
const DT = 1 / 30;

// ---------------------------------------------------------------- captains
const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Steer ship p towards point `to` at telegraph `tel`.
function steerTo(p, to, tel) {
   const want = Math.atan2(to.y - p.pos.y, to.x - p.pos.x);
   const d = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
   p.setRudder(Math.abs(d) < 0.03 ? 0 : d > 0 ? (Math.abs(d) > 0.3 ? 2 : 1) : (Math.abs(d) > 0.3 ? -2 : -1));
   p.setTelegraph(tel);
}
// What a sensible player does beyond fighting: the hint the AI captain gets per mission.
const HINT = {
   hormus(w) { w.player.ai = { escortId: w._script.convoy[1].id }; },
   redsea(w) { w.player.ai = { escortId: w._script.convoy[1].id }; },
   giuk(w) { w.player.ai = { escortId: w._script.convoy[1].id }; },
};
// Scripted captains (a function called every step) for missions the combat AI cannot play.
const SCRIPTED = {
   pipeline(w) { return w._script.def.testRoute(w, { steerTo, orderDepth, launchTeam, teamStatus, hyp }); },
};
export function play(id, diff, seed, mode = 'bot', ship = null) {
   const w = new World(diff, { mission: id, ship, seed });
   const def = getMission(id);
   let step = null;
   if (mode === 'passive') { w.autoPlayer = true; w.player.ai = { passive: true, anchored: true }; }
   else if (SCRIPTED[id]) step = SCRIPTED[id](w);
   else { w.autoPlayer = true; if (HINT[id]) HINT[id](w); }
   const n = Math.round((def.timeLimit + 20) / DT);
   for (let i = 0; i < n && w.phase === 'playing'; i++) { if (step) step(w); w.update(DT); }
   return w;
}

// ---------------------------------------------------------------- balance table
if (process.env.BALANCE) {
   const RUNS = +process.env.BALANCE || 30;
   const only = process.env.ONLY ? process.env.ONLY.split(',') : IDS;
   const diffs = process.env.DIFFS ? process.env.DIFFS.split(',') : DIFFS;
   const modes = process.env.MODES ? process.env.MODES.split(',') : ['bot', 'passive'];
   console.log(`Operations west, ${RUNS} seeded runs per cell: wins %, mean end time (longest) in s, optional objectives done %, stars`);
   for (const id of only) {
      const def = getMission(id);
      const ships = process.env.SHIP ? process.env.SHIP.split(',') : [def.recommendedShip];
      for (const ship of ships) for (const diff of diffs) for (const mode of modes) {
         let wins = 0, tSum = 0, tMax = 0, opt = 0, optN = 0, stars = 0;
         const why = {};
         for (let i = 0; i < RUNS; i++) {
            const w = play(id, diff, 1000 + i * 37, mode, ship);
            if (w.phase === 'won') wins++;
            tSum += w.time; tMax = Math.max(tMax, w.time);
            for (const o of w.mission.objectives) if (o.optional) { optN++; if (o.state === 'done') opt++; }
            stars += opStars(w);
            const r = (w.phase === 'won' ? 'W ' : w.phase === 'lost' ? 'L ' : '? ') + (w.result?.reason || '');
            why[r] = (why[r] || 0) + 1;
         }
         console.log(`${id.padEnd(9)} ${ship.padEnd(12)} ${diff.padEnd(6)} ${mode.padEnd(7)} wins ${String(Math.round(100 * wins / RUNS)).padStart(3)} %   t ${Math.round(tSum / RUNS)} (${Math.round(tMax)}) / ${def.timeLimit}   opt ${optN ? Math.round(100 * opt / optN) : '-'} %   stars ${(stars / RUNS).toFixed(1)}`);
         if (process.env.WHY) for (const k in why) console.log('      ' + String(why[k]).padStart(3) + ' x ' + k);
      }
   }
   process.exit(0);
}

// ---------------------------------------------------------------- catalogue
test('west operations: catalogue and menu data', () => {
   assert.ok(IDS.length >= 1 && IDS[0] === 'hormus');
   for (const id of IDS) {
      const m = getMission(id);
      assert.equal(m.group, 'ops', id);
      for (const k of ['name', 'subtitle', 'briefing', 'debrief']) assert.ok(typeof m[k] === 'string' && m[k].length > 3 && !/undefined|NaN/.test(m[k]), id + ' ' + k);
      assert.ok(m.briefing.length < 700, id + ' briefing is short');
      assert.ok(m.stars >= 1 && m.stars <= 3, id + ' stars');
      assert.ok(m.fixedShips && m.playableShips.length >= 1, id + ' prescribes its ships');
      assert.ok(m.playableShips.includes(m.recommendedShip), id + ' recommended ship is allowed');
      for (const s of m.playableShips) assert.ok(SHIPS[s] && SHIPS[s].bloc === 'west', id + ' ship ' + s);
      assert.ok(m.timeLimit >= 8 * 60 && m.timeLimit <= 12 * 60, id + ' lasts 8 to 12 minutes');
      assert.ok(m.fleet && m.fleet.own && m.fleet.foe, id + ' fleet lines');
   }
   assert.equal(new Set(MISSIONS.map(m => m.id)).size, MISSIONS.length, 'mission ids are unique');
});

// The reach of everything a ship can throw at a surface ship at the first second.
function reach(s) {
   let r = s.cfg.main ? s.cfg.main.range : 0;
   if (s.cfg.torp) r = Math.max(r, s.cfg.torp.range);
   for (const x of s.cfg.weapons?.ssm || []) r = Math.max(r, MISSILES[x.type].range);
   if (s.cfg.weapons?.rockets) r = Math.max(r, s.cfg.weapons.rockets.range);
   return r;
}
for (const id of IDS) {
   test(`${id}: sets up for every allowed ship and difficulty, nobody on land, nothing in weapon range`, () => {
      const m = getMission(id);
      for (const ship of m.playableShips) for (const diff of DIFFS) {
         const w = new World(diff, { mission: id, ship, seed: 7 });
         const tag = `${id}/${ship}/${diff}`;
         assert.equal(w.player.cls, ship, tag);
         assert.equal(w.mission.id, id);
         assert.ok(w.mission.objectives.some(o => !o.optional), tag + ' main objective');
         const nOpt = w.mission.objectives.filter(o => o.optional).length;
         assert.ok(nOpt >= 1 && nOpt <= 2, tag + ' one or two optional objectives');
         for (const o of w.mission.objectives) assert.ok(o.text && !/undefined|NaN/.test(o.text), tag + ' objective text');
         for (const s of w.ships) {
            assert.ok(Math.abs(s.pos.x) < w.arena && Math.abs(s.pos.y) < w.arena, tag + ' inside the arena: ' + s.name);
            for (const o of w.obstacles) assert.ok(obstacleT(o, s.pos) > 1.05, `${tag}: ${s.name} on land`);
         }
         for (const z of w.mission.zones) for (const o of w.obstacles) assert.ok(obstacleT(o, z) > 1.05, tag + ' zone on land: ' + z.label);
         for (const t of w.taskPoints) for (const o of w.obstacles) assert.ok(obstacleT(o, t) > 1.02, tag + ' task point on land');
         // the player (and every ship of his side) is outside the reach of every enemy ship and
         // of every enemy land position that is switched on at the start
         for (const e of w.ships) {
            if (e.side !== 'enemy') continue;
            const d = hyp(e.pos, w.player.pos);
            assert.ok(d > reach(e) * 1.02, `${tag}: ${e.name} starts ${Math.round(d)} m from the player, reach ${reach(e)}`);
         }
         for (const s of w.sites) {
            if (s.side !== 'enemy') continue;
            const live = s.kind === 'battery' && s.nextT < 600;
            for (const x of s.cfg.weapons.ssm) if (live) assert.ok(hyp(s.pos, w.player.pos) > MISSILES[x.type].range, `${tag}: ${s.name} has the player in range at the start`);
         }
         // first seconds: runs, nobody is hit
         for (let i = 0; i < 5 / DT; i++) w.update(DT);
         assert.equal(w.phase, 'playing', tag);
         assert.ok(w.player.hp === w.player.maxHP, tag + ' player unhurt after 5 s');
      }
   });

   test(`${id}: co-op setup with 2 and 4 captains`, () => {
      const m = getMission(id);
      for (const n of [2, 4]) {
         const classes = Array.from({ length: n }, (_, i) => m.playableShips[i % m.playableShips.length]);
         const w = buildNetWorld({ mission: id, difficulty: 'normal', seed: 99, classes, loadouts: classes.map(() => null), names: classes.map((_, i) => 'Kpt' + i), self: 0 });
         assert.equal(w.net.humans.length, n, id + ' humans');
         assert.equal(new Set(w.net.humans).size, n);
         for (const h of w.net.humans) {
            assert.ok(h.alive && h.side === 'player', id + ' human ship');
            for (const o of w.obstacles) assert.ok(obstacleT(o, h.pos) > 1.02, `${id}: ${h.name} on land`);
         }
         for (let i = 0; i < 20 / DT; i++) w.update(DT);
         assert.notEqual(w.phase, 'lost', id + ' co-op survives the first 20 s');
      }
   });

   test(`${id}: a passive player loses, the time limit ends the mission`, () => {
      const w = play(id, 'normal', 5, 'passive');
      assert.equal(w.phase, 'lost', id + ' passive: ' + w.phase);
      assert.ok(w.time <= getMission(id).timeLimit + 1, id + ' ends inside the time limit');
      assert.equal(opStars(w), 0);
   });
}

// ---------------------------------------------------------------- 1. Hormus
const obj = (w, id) => w.mission.objectives.find(o => o.id === id);
const fast = (w, secs) => { for (let i = 0; i < secs / DT && w.phase === 'playing'; i++) w.update(DT); };

test('hormus: boat waves, the batteries switch on late, the convoy arrives and wins', () => {
   const w = new World('normal', { mission: 'hormus', ship: 'Sachsen', seed: 3 });
   const S = w._script;
   assert.equal(S.convoy.length, 3);
   assert.ok(S.batteries.every(b => !b.radarOn && !b.detected), 'batteries silent at the start');
   assert.equal(w.ships.filter(s => s.cls === 'Boghammar').length, 0);
   // peaceful run: no enemy acts, only the script
   const calm = () => { for (const s of w.ships) if (s.side === 'enemy') s.ai.passive = true; for (const b of S.batteries) b.mag.noor = 0; };
   const peace = (secs) => { for (let t = 0; t < secs && w.phase === 'playing'; t++) { calm(); fast(w, 1); } };
   w.player.ai = { passive: true, anchored: true }; w.autoPlayer = true;
   peace(60);
   assert.ok(w.roster.filter(s => s.cls === 'Boghammar').length >= 4, 'first wave');
   for (const b of w.ships) if (b.cls === 'Boghammar') assert.ok(hyp(b.pos, w.player.pos) > 3300, 'a wave does not appear inside rocket range');
   peace(180);
   assert.ok(w.roster.filter(s => s.cls === 'Boghammar').length >= 9, 'second wave');
   peace(100);
   assert.ok(S.batteries.every(b => b.radarOn && b.detected), 'batteries switched on');
   peace(400);
   assert.equal(w.phase, 'won');
   assert.equal(S.arrived, 3);
   assert.equal(obj(w, 'convoy').state, 'done');
   assert.equal(obj(w, 'all').state, 'done');
   assert.ok(w.time < 700, 'convoy is through before the limit: ' + w.time);
});
test('hormus: two tankers lost = defeat, the sub objective counts', () => {
   const w = new World('normal', { mission: 'hormus', ship: 'Burke', seed: 4 });
   const S = w._script;
   S.sub.takeDamage(1e9, w.player, 'he');
   fast(w, 1);
   assert.equal(obj(w, 'sub').state, 'done');
   S.convoy[0].takeDamage(1e9, null, 'he');
   fast(w, 1);
   assert.equal(w.phase, 'playing');
   assert.equal(obj(w, 'all').state, 'failed');
   S.convoy[1].takeDamage(1e9, null, 'he');
   fast(w, 1);
   assert.equal(w.phase, 'lost');
});

// ---------------------------------------------------------------- 2. Rotes Meer
test('redsea: waves are launched from hidden ramps, a ramp that fired is located, the magazines run down', () => {
   const w = new World('normal', { mission: 'redsea', ship: 'Burke', seed: 3 });
   const S = w._script;
   assert.equal(S.launchers.length, 3);
   assert.ok(S.launchers.every(L => !L.detected && !L.targetable), 'ramps unknown at the start');
   assert.ok(S.ally.mag.aster30 < SHIPS.Daring.mag.aster30, 'the ally starts with depleted magazines');
   w.autoPlayer = true; w.player.ai = { escortId: S.convoy[1].id };
   const sam0 = w.player.mag.sm2 + w.player.mag.essm;
   fast(w, 28);
   assert.equal(w.events.filter(e => e.type === 'ssmLaunch' && S.launchers.some(L => L.id === e.srcId)).length, 0, 'quiet before the first wave');
   fast(w, 22);
   assert.ok(S.launched >= 6, 'first wave: ' + S.launched);
   assert.ok(S.launchers.every(L => L.detected && L.targetable), 'ramps located after firing');
   fast(w, 150);
   assert.ok(S.wave >= 3);
   assert.ok(w.player.mag.sm2 + w.player.mag.essm < sam0, 'defence costs missiles');
   assert.equal(w.phase, 'playing');
});
test('redsea: destroyed ramps stop firing and complete the optional objective, the convoy then arrives', () => {
   const w = new World('normal', { mission: 'redsea', ship: 'Ticonderoga', seed: 4 });
   const S = w._script;
   w.autoPlayer = true; w.player.ai = { passive: true, anchored: true };
   fast(w, 5);
   damageSite(w, S.launchers[0], 1e9, w.player, 'cruise');
   assert.match(obj(w, 'sites').text, /1\/3/);
   damageSite(w, S.radar, 1e9, w.player, 'cruise');
   for (const L of S.launchers) damageSite(w, L, 1e9, w.player, 'cruise');
   assert.equal(obj(w, 'sites').state, 'done');
   fast(w, 640);
   assert.equal(S.launched, 0, 'no ramp, no launch');
   assert.equal(w.phase, 'won');
   assert.equal(S.arrived, 3);
   assert.equal(obj(w, 'all').state, 'done');
   assert.ok(w.time < 640, 'through before the limit: ' + w.time);
   assert.equal(opStars(w), 2);
});
test('redsea: two container ships lost = defeat', () => {
   const w = new World('normal', { mission: 'redsea', ship: 'Burke', seed: 4 });
   const S = w._script;
   S.convoy[0].takeDamage(1e9, null, 'he');
   fast(w, 1);
   assert.equal(w.phase, 'playing');
   assert.equal(obj(w, 'all').state, 'failed');
   S.convoy[2].takeDamage(1e9, null, 'he');
   fast(w, 1);
   assert.equal(w.phase, 'lost');
});
