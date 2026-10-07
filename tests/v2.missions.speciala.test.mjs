// Special operations, set A (gamev2/missions_special_a.js): setup for every allowed ship, objectives,
// the special rule of each mission, win and lose paths, co-op slots and one bot-captain run.
// Balance table:  node tests/v2.missions.speciala.captain.mjs cable 30
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../gamev2/state.js';
import { MISSIONS } from '../gamev2/missions.js';
import { SPECIAL_A_TUNE, CABLE, RIG } from '../gamev2/missions_special_a.js';
import { impactOnSites, damageSite } from '../gamev2/sites.js';
import { islandReliefAt } from '../gamev2/utils.js';
import { missionSlots, missionRoles } from '../gamev2/net/setup.js';
import { sendHelo, heloOf } from '../gamev2/helo.js';
import { captain, play } from './v2.missions.speciala.captain.mjs';

const IDS = ['cable', 'rig'];
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

// ---------------------------------------------------------------- rig
const rigPlat = (w) => w.sites.find(s => s.id === w._script.platId);
const rigBoats = (w) => w._script.boats.map(i => w.shipById(i));
// the player's ship d metres west of the platform, stopped (or at speed v)
const rigAt = (w, d, v = 0) => { const p = w.player; p.pos.x = RIG.x - d; p.pos.y = RIG.y; p.heading = 0; p.speed = v; p.setTelegraph(0); p.setRudder(0); };
const rigPark = (w) => rigBoats(w).forEach((b, k) => { if (b.alive) { b.pos.x = 10500; b.pos.y = -10500 + k * 300; b.ai.anchored = true; } });

test('special A/rig: the platform stands in open water, hidden from every weapon lock; boats moored, launcher on the reef', () => {
   for (const diff of DIFFS) {
      const w = mk('rig', { diff }), S = w._script, T = SPECIAL_A_TUNE.rig[diff], plat = rigPlat(w);
      assert.ok(plat && plat.alive && plat.side === 'enemy' && plat.model === 'platform');
      assert.ok(!onLand(w, plat.pos) && plat.r === RIG.r && Math.abs(dist(plat.pos, { x: RIG.x, y: RIG.y })) < 1);
      assert.equal(plat.detected, false); assert.equal(plat.targetable, false);
      const post = w.sites.find(s => s.id === S.postId);
      assert.ok(post.kind === 'battery' && onLand(w, post.pos), 'the launcher stands on the reef');
      assert.ok(dist(post.pos, plat.pos) > 3000, 'far enough from the platform to be shot at');
      assert.equal(S.boats.length, T.boats);
      for (const b of rigBoats(w)) assert.ok(b.ai.anchored && dist(b.pos, plat.pos) < RIG.r, 'boats lie inside the no-fire radius');
      assert.equal(w.taskPoints.length, 1);
      step(w, 3);
      assert.equal(plat.detected, false, 'still hidden after the sensors ran');
   }
});

test('special A/rig: any hit on the platform loses the mission; the group\'s bot captains hold their guns there', () => {
   let w = mk('rig'), S = w._script;
   w.player.setTelegraph(0);
   assert.equal(S.noFire(w.shipById(S.allyId), { x: RIG.x + 100, y: RIG.y }), true);
   assert.equal(S.noFire(w.shipById(S.allyId), { x: RIG.x + RIG.safe + 50, y: RIG.y }), false);
   assert.equal(S.noFire(rigBoats(w)[0], { x: RIG.x, y: RIG.y }), false);
   impactOnSites(w, { x: RIG.x + RIG.r + 40, y: RIG.y }, 'player', 300, w.player, 'shell');
   step(w, 1);
   assert.equal(w.phase, 'playing', 'a shell beside it is no hit');
   impactOnSites(w, { x: RIG.x + 60, y: RIG.y - 30 }, 'player', 300, w.player, 'shell');
   step(w, 1);
   assert.equal(w.phase, 'lost');
   assert.match(w.result.reason, /Plattform wurde getroffen/);
   // the bot captain's guns: with every boat moored and the ship in gun range nothing is fired
   w = mk('rig'); S = w._script;
   w.autoPlayer = true;
   w.shipById(S.allyId).ai.anchored = true;
   let fired = 0;
   step(w, 20, () => { rigAt(w, 5600); rigBoats(w).forEach(b => { b.ai.anchored = true; }); fired += w.shells.filter(s => s.side === 'player').length; });
   assert.equal(fired, 0, 'no shell at a moored boat');
   assert.equal(w.phase, 'playing');
});

test('special A/rig: the boats leave the platform as a warship closes, the guards last', () => {
   const w = mk('rig'), S = w._script, T = SPECIAL_A_TUNE.rig.normal, out = said(w);
   w.shipById(S.allyId).ai.anchored = true;
   const moored = () => rigBoats(w).filter(b => b.ai.anchored).length;
   step(w, 2, () => rigAt(w, 7000));
   assert.equal(moored(), T.boats);
   step(w, 2, () => rigAt(w, RIG.sortie - 300));
   assert.equal(moored(), T.guards, 'the guards stay');
   assert.ok(out.some(t => t.includes('Feuer erst')), 'the lookout warns not to fire yet');
   assert.ok(rigBoats(w).filter(b => !b.ai.anchored).every(b => b.ai.huntId != null));
   step(w, 2, () => rigAt(w, RIG.guard - 200));
   assert.equal(moored(), 0);
});

test('special A/rig: the team goes over from a slow ship in the circle once no boat is at the platform, and wins the mission', () => {
   const w = mk('rig'), S = w._script, T = SPECIAL_A_TUNE.rig.normal, out = said(w), p = w.player;
   w.shipById(S.allyId).ai.anchored = true;
   // boats at the platform: no team
   step(w, 3, () => { rigAt(w, 1200); rigBoats(w).forEach(b => { b.ai.anchored = true; }); });
   assert.equal(w.teams.length, 0);
   // too fast
   step(w, 3, () => { rigAt(w, 1200, p.maxSpeed * 0.6); rigPark(w); });
   assert.equal(w.teams.length, 0);
   // outside the circle
   step(w, 20, () => { rigAt(w, RIG.launch + 500); rigPark(w); });
   assert.equal(w.teams.length, 0);
   assert.ok(out.some(t => t.includes('zu weit') || t.includes('Zu schnell') || t.includes('an der Plattform')), 'the team says why it does not go');
   // slow inside the circle
   step(w, 2, () => { rigAt(w, 1200); rigPark(w); });
   assert.equal(w.teams.length, 1);
   assert.equal(w.teams[0].state, 'out');
   assert.equal(S.teamsLeft, T.teams - 1);
   assert.match(obj(w, 'board').text, /setzt über/);
   step(w, 1200 / RIG.teamSpeed + 3, () => { rigAt(w, 1200); rigPark(w); });
   assert.equal(w.teams[0].state, 'working');
   assert.match(obj(w, 'board').text, /auf der Plattform/);
   step(w, T.board + 3, () => { rigAt(w, 1200); rigPark(w); });
   assert.equal(w.phase, 'won');
   assert.equal(obj(w, 'board').state, 'done');
   assert.equal(rigPlat(w).hp, rigPlat(w).maxHp);
});

test('special A/rig: a boat beside the team drives it off; the last team lost, the valves and the lost group end the mission', () => {
   let w = mk('rig'), S = w._script; const T = SPECIAL_A_TUNE.rig.normal;
   w.shipById(S.allyId).ai.anchored = true;
   const chase = () => { rigAt(w, 1200); rigPark(w); const t = w.teams.find(x => x.state === 'out'), b = rigBoats(w)[0]; if (t) { b.pos.x = t.x; b.pos.y = t.y + 300; } };
   step(w, 12, chase);
   assert.equal(S.lost, 1);
   assert.equal(obj(w, 'team').state, 'failed');
   assert.equal(w.phase, 'playing');
   step(w, (RIG.relaunch + 14) * T.teams, chase);
   assert.equal(w.phase, 'lost');
   assert.match(w.result.reason, /letzte Boardingteam/);
   // the valves
   w = mk('rig'); const out = said(w);
   w.player.setTelegraph(0);
   step(w, 700);
   assert.equal(w.phase, 'lost');
   assert.ok(Math.abs(w.time - T.valves) < 3, 'the valves open when the tune says: ' + w.time);
   assert.match(w.result.reason, /Ventile geöffnet/);
   assert.ok(out.some(t => t.includes('Hälfte der Frist')) && out.some(t => t.includes('Noch eine Minute')), 'the radio counts the clock down');
   // every warship of the group gone
   w = mk('rig');
   for (const s of w.ships.filter(x => x.side === 'player')) s.takeDamage(1e9, null, 'test');
   step(w, 1);
   assert.equal(w.phase, 'lost');
   // optional objectives: launcher and boats
   w = mk('rig'); S = w._script;
   w.player.setTelegraph(0);
   damageSite(w, w.sites.find(s => s.id === S.postId), 1e9, w.player, 'shell');
   step(w, 1);
   assert.equal(obj(w, 'post').state, 'done');
   for (const b of rigBoats(w)) b.takeDamage(1e9, w.player, 'test');
   step(w, 1);
   assert.equal(obj(w, 'boats').state, 'done');
   assert.equal(w.phase, 'playing');
});

test('special A/rig: co-op takes a second captain on the corvette; a bot captain wins on easy and can lose on hard', () => {
   assert.equal(missionSlots('rig'), 2);
   assert.deepEqual(missionRoles('rig').map(r => r.cls), ['Sachsen', 'Braunschweig']);
   const w = play('rig', 'easy', 1000);
   assert.equal(w.phase, 'won', w.result && w.result.reason);
   assert.ok(w.time < def('rig').timeLimit);
   const res = [1000, 8919, 16838, 24757, 32676, 40595].map(seed => play('rig', 'hard', seed).phase);
   assert.ok(res.includes('lost'), 'hard is not a walkover: ' + res);
});
