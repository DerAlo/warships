// Special operations, set A (gamev2/missions_special_a.js): setup for every allowed ship, objectives,
// the special rule of each mission, win and lose paths, co-op slots and one bot-captain run.
// Balance table:  node tests/v2.missions.speciala.captain.mjs cable 30
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../gamev2/state.js';
import { MISSIONS } from '../gamev2/missions.js';
import { SPECIAL_A_TUNE, CABLE } from '../gamev2/missions_special_a.js';
import { islandReliefAt } from '../gamev2/utils.js';
import { missionSlots, missionRoles } from '../gamev2/net/setup.js';
import { sendHelo, heloOf } from '../gamev2/helo.js';
import { captain, play } from './v2.missions.speciala.captain.mjs';

const IDS = ['cable'];
const DIFFS = ['easy', 'normal', 'hard'];
const def = (id) => MISSIONS.find(m => m.id === id);
const mk = (id, o = {}) => new World(o.diff || 'normal', { mission: id, ship: o.ship || def(id).recommendedShip, seed: o.seed ?? 4711 });
const step = (w, secs, each) => { for (let i = 0, n = Math.round(secs * 60); i < n && w.phase === 'playing'; i++) { w.update(1 / 60); if (each) each(); } };
const onLand = (w, p) => w.obstacles.some(o => islandReliefAt(o, p) > 0);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const obj = (w, id) => w.mission.objectives.find(o => o.id === id);
const radioed = (w, part) => w.events.some(e => e.type === 'objective' || e.type === 'message' ? String(e.text).includes(part) : false) || w.feed?.some?.(f => String(f.text).includes(part));
// put ship s beside ship m (d metres abeam), same course and speed
const alongside = (s, m, d) => { s.pos.x = m.pos.x - Math.sin(m.heading) * d; s.pos.y = m.pos.y + Math.cos(m.heading) * d; s.heading = m.heading; s.speed = m.speed; s.setTelegraph(2); s.setRudder(0); };
const said = (w) => { const out = []; const msg = w.message.bind(w); w.message = (t, l) => { out.push(t); return msg(t, l); }; return out; };

test('special A: the operations are registered with texts, limits and tuning', () => {
   for (const id of IDS) {
      const d = def(id);
      assert.ok(d, id);
      assert.equal(d.group, 'ops');
      assert.ok(d.briefing.length > 80 && d.debrief.length > 30, id + ' texts');
      assert.ok(d.timeLimit >= 480 && d.timeLimit <= 720, id + ' 8-12 minutes');
      assert.ok(d.stars >= 1 && d.stars <= 3);
      assert.ok(d.fixedShips && d.playableShips.includes(d.recommendedShip));
      for (const k of DIFFS) assert.ok(SPECIAL_A_TUNE[id][k], id + ' ' + k);
   }
});

for (const id of IDS) {
   test(`special A/${id}: sets up for every allowed ship and difficulty, nothing on land, no opponent close to the player`, () => {
      for (const ship of def(id).playableShips) for (const diff of DIFFS) {
         const w = mk(id, { ship, diff });
         assert.equal(w.phase, 'playing');
         assert.equal(w.player.cls, ship);
         const main = w.mission.objectives.filter(o => !o.optional), opt = w.mission.objectives.filter(o => o.optional);
         assert.ok(main.length >= 1 && opt.length >= 1 && opt.length <= 3, `${id}/${ship}: objectives`);
         for (const s of w.ships) {
            assert.ok(!onLand(w, s.pos), `${id}: ${s.name} stands on land`);
            if (s.side === 'enemy') assert.ok(dist(s.pos, w.player.pos) >= 9000, `${id}: ${s.name} starts ${Math.round(dist(s.pos, w.player.pos))} m from the player`);
         }
      }
   });
   test(`special A/${id}: a passive player loses to the mission's rule before the time limit`, () => {
      const w = mk(id);
      captain(w, 'passive');
      step(w, def(id).timeLimit + 5);
      assert.equal(w.phase, 'lost');
      assert.ok(w.time < def(id).timeLimit - 30, 'lost at ' + Math.round(w.time) + ' s, not on the clock');
   });
}

// ---------------------------------------------------------------- cable
test('special A/cable: one merchant drags its anchor, the opponent cannot aim at merchants, state is kept by id', () => {
   for (const diff of DIFFS) for (const seed of [1, 77, 4711, 90210]) {
      const w = mk('cable', { diff, seed }), S = w._script, T = SPECIAL_A_TUNE.cable[diff];
      assert.equal(S.merch.length, T.ships);
      assert.ok(S.merch.includes(S.susId));
      assert.equal(S.boats.length, T.boats);
      for (const k of ['merch', 'boats']) assert.ok(S[k].every(x => typeof x === 'number'), k + ' holds ids');
      const sus = w.shipById(S.susId), kn = S.merch.map(i => w.shipById(i).cfg.speedKn ?? w.shipById(i).maxSpeed);
      assert.equal(S.merch.filter(i => w.shipById(i).maxSpeed <= sus.maxSpeed + 0.01).length, 1 + T.decoys, 'slow ships: the dragging one and the decoys ' + kn);
      for (const i of S.merch) { const m = w.shipById(i); assert.equal(m.side, 'player'); assert.equal(m.type, 'TR'); m.detected = true; assert.equal(w.canSee('enemy', m), false); }
   }
   // the dragging ship differs with the seed
   assert.ok(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(seed => mk('cable', { seed })._script.susName)).size >= 3);
});

test('special A/cable: a merchant is identified from close by or by the helicopter, the last one by elimination', () => {
   const w = mk('cable'), S = w._script, p = w.player, out = said(w);
   p.setTelegraph(0);
   const clean = S.merch.filter(i => i !== S.susId).map(i => w.shipById(i));
   step(w, 5);
   assert.equal(S.clean, 0, 'nothing is identified from 14 km');
   // ship close to a clean merchant (the lanes lie further apart than the visual range)
   alongside(p, clean[0], 200);
   step(w, 6, () => alongside(p, clean[0], 200));
   assert.equal(S.clean, 1);
   assert.ok(out.some(t => t.includes(clean[0].name) && t.includes('Unauffällig')), 'the lookout reports the ship as clean');
   assert.match(obj(w, 'find').text, /1\/5 geprüft/);
   // helicopter over the next one
   p.pos.x = -9000; p.pos.y = -9000;
   const h = sendHelo(w, p, clean[1].pos);
   assert.ok(h, 'helicopter launched');
   step(w, 8, () => { h.pos.x = clean[1].pos.x; h.pos.y = clean[1].pos.y + 200; });
   assert.equal(S.clean, 2, 'the helicopter identifies a merchant');
   assert.equal(S.found, false);
   // the dragging ship itself
   const sus = w.shipById(S.susId);
   step(w, 6, () => { h.pos.x = sus.pos.x; h.pos.y = sus.pos.y + 200; });
   assert.equal(S.found, true);
   assert.equal(obj(w, 'find').state, 'done');
   assert.ok(out.some(t => t.includes('Ankerschlepper') && t.includes('500 m')), 'the radio says what to do next');
   assert.ok(S.boats.every(i => w.shipById(i).ai.escortId === S.susId), 'the boats close round the merchant');
   // elimination: all but one cleared
   const w2 = mk('cable', { seed: 5 }), S2 = w2._script;
   w2.player.setTelegraph(0);
   for (const m of S2.merch.filter(i => i !== S2.susId).map(i => w2.shipById(i))) step(w2, 5, () => alongside(w2.player, m, 200));
   assert.equal(S2.found, true, 'four clean ships leave the fifth');
});

test('special A/cable: boarding needs distance, low speed and no boat beside the merchant; then the mission is won', () => {
   const w = mk('cable'), S = w._script, p = w.player, sus = w.shipById(S.susId), out = said(w);
   const boats = S.boats.map(i => w.shipById(i));
   const park = () => boats.forEach((b, k) => { if (b.alive) { b.pos.x = 9000; b.pos.y = -9000 + k * 300; } });
   park();
   step(w, 5, () => { alongside(p, sus, 300); park(); });
   assert.equal(S.found, true);
   const b0 = S.board;
   assert.ok(b0 > 0, 'the boarding team is on its way');
   assert.ok(out.some(t => t.includes('Boardingteam') && t.includes('Wir setzen über')));
   // too fast
   step(w, 4, () => { alongside(p, sus, 300); p.speed = p.maxSpeed * 0.9; park(); });
   assert.ok(S.board < b0 + 1, 'no progress at high speed: ' + S.board);
   // a boat beside the merchant
   const b1 = S.board;
   step(w, 3, () => { alongside(p, sus, 300); park(); boats[0].pos.x = sus.pos.x; boats[0].pos.y = sus.pos.y - 400; });
   assert.ok(S.board <= b1, 'no progress while a boat covers the merchant');
   // too far
   step(w, 18, () => { alongside(p, sus, 1500); park(); });
   assert.equal(S.board, 0, 'the team falls back');
   assert.ok(out.some(t => t.includes('Zu schnell') || t.includes('Boot steht neben') || t.includes('Abstand zu groß')), 'the team says why it cannot board');
   assert.equal(w.phase, 'playing');
   // held: won
   step(w, S.need + 3, () => { alongside(p, sus, 300); park(); });
   assert.equal(w.phase, 'won');
   assert.equal(obj(w, 'stop').state, 'done');
   assert.equal(obj(w, 'cable50').state, 'done');
   assert.match(w.result.reason, /gestoppt/);
});

test('special A/cable: lose paths - the cable parts, a merchant is hit, the group is lost', () => {
   // the cable: warnings on the radio, then the loss
   let w = mk('cable'), out = said(w);
   w.player.setTelegraph(0);
   step(w, 700);
   assert.equal(w.phase, 'lost');
   assert.ok(Math.abs(w.time - SPECIAL_A_TUNE.cable.normal.cable) < 3, 'the cable holds as long as the tune says: ' + w.time);
   assert.match(w.result.reason, /Seekabel ist durchtrennt/);
   assert.ok(out.some(t => t.includes('Hälfte seiner Tragfähigkeit')) && out.some(t => t.includes('reißt in einer Minute')), 'the radio counts the cable down');
   assert.equal(obj(w, 'cable50').state, 'failed');
   // a merchant badly damaged
   w = mk('cable');
   const m = w.shipById(w._script.merch.find(i => i !== w._script.susId));
   m.takeDamage(m.maxHP * 0.2, null, 'test'); step(w, 1);
   assert.equal(w.phase, 'playing', 'light damage is not yet the end');
   m.takeDamage(m.maxHP * 0.15, null, 'test'); step(w, 1);
   assert.equal(w.phase, 'lost');
   assert.match(w.result.reason, /schwer beschädigt/);
   // a merchant sunk
   w = mk('cable');
   w.shipById(w._script.susId).takeDamage(1e9, null, 'test'); w.update(1 / 60);
   assert.equal(w.phase, 'lost');
   // every warship of the group gone
   w = mk('cable');
   for (const s of w.ships.filter(x => x.side === 'player' && x.type !== 'TR')) s.takeDamage(1e9, null, 'test');
   w.update(1 / 60);
   assert.equal(w.phase, 'lost');
});

test('special A/cable: boats sunk complete the optional objective, the corvette arrives far from the player', () => {
   const w = mk('cable'), S = w._script, T = SPECIAL_A_TUNE.cable.normal;
   w.player.setTelegraph(0);
   for (const i of S.boats) w.shipById(i).takeDamage(1e9, w.player, 'test');
   w.update(1 / 60);
   assert.equal(obj(w, 'boats').state, 'done');
   assert.equal(w.phase, 'playing');
   const wh = mk('cable', { diff: 'hard' }), Th = SPECIAL_A_TUNE.cable.hard;
   wh.player.setTelegraph(0);
   step(wh, Th.corvette + 1);
   const c = wh.shipById(wh._script.corvId);
   assert.ok(c && c.alive && c.side === 'enemy', 'corvette arrived');
   assert.ok(dist(c.pos, wh.player.pos) >= 12000, 'corvette appears ' + Math.round(dist(c.pos, wh.player.pos)) + ' m away');
   assert.ok(!onLand(wh, c.pos));
   assert.equal(mk('cable', { diff: 'easy' })._script.corvId, undefined);
   assert.equal(T.corvette > 0, true);
});

test('special A/cable: co-op takes a second captain on the corvette', () => {
   assert.equal(missionSlots('cable'), 2);
   const roles = missionRoles('cable');
   assert.deepEqual(roles.map(r => r.cls), ['Sachsen', 'Braunschweig']);
});

test('special A/cable: a bot captain wins on easy inside the time limit and can lose on hard', () => {
   const w = play('cable', 'easy', 1000);
   assert.equal(w.phase, 'won', w.result && w.result.reason);
   assert.ok(w.time < def('cable').timeLimit);
   const res = [1000, 8919, 16838, 24757].map(seed => play('cable', 'hard', seed).phase);
   assert.ok(res.includes('lost'), 'hard is not a walkover: ' + res);
});
