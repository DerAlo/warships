// tests/missions.test.mjs — headless campaign checks: every mission builds and runs 60 s under a
// simple autopilot without exceptions, its win and lose conditions trigger, the star rating and
// survival waves work. Run: node --test tests/missions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../game/state.js';
import { updateBot } from '../game/ai.js';
import { MISSIONS, SURVIVAL, missionById, nextMission } from '../game/missions.js';
import { angleOf, sub, dist, fromAngle, angleDelta, clamp } from '../game/utils.js';

const DT = 1 / 60;
const ALL = [...MISSIONS, SURVIVAL];

function tick(w, pilot = true) {
   if (pilot) autopilot(w);
   for (const b of w.bots) if (b.alive) updateBot(b, w, DT);
   for (const a of w.allies) if (a.alive) updateBot(a, w, DT);
   w.update(DT);
   w.events.length = 0;
}

// Minimal player: head for the nearest visible enemy, hold ~1500 m, fire everything that bears.
function autopilot(w) {
   const p = w.player;
   if (!p.alive) return;
   let tgt = null, bd = Infinity;
   for (const b of w.bots) {
      if (!b.alive || !b.visible) continue;
      const d = dist(b.pos, p.pos);
      if (d < bd) { bd = d; tgt = b; }
   }
   const goal = tgt ? tgt.pos : { x: 0, y: 0 };
   let want = angleOf(sub(goal, p.pos));
   if (tgt && bd < 1500) want += Math.PI / 2;
   p.helm = clamp(angleDelta(p.heading, want) * 2, -1, 1);
   p.throttleIn = 0.8;
   if (!tgt) return;
   p.aim = fromAngle(angleOf(sub(tgt.pos, p.pos)));
   p.aimBearing = angleOf(p.aim);
   w._aimPoint = tgt.pos;
   if (bd < p.cfg.main.range && p.fireTimer <= 0) p.fireMain(w, null, p.aim, { aimPoint: tgt.pos });
   if (p.cfg.torp && bd < 900) p.fireTorpedo(w, null, p.aim);
   if (bd < 700 && tgt.cfg.sub && p.canUse('dcharge')) p.useConsumable('dcharge');
}

// Kill every enemy on the map (and bring escorted ships home) until the mission resolves.
function forceWin(w, maxSec = 900) {
   while (w.phase === 'playing' && w.time < maxSec) {
      w.player.hp = w.player.maxHP;
      for (const b of w.bots) if (b.alive && !b.exit) b._damage(1e9, {});
      // convoy targets: sink them before they can escape
      for (const b of w.bots) if (b.alive) b._damage(1e9, {});
      for (const a of w.allies) if (a.alive && a.exit) { a.pos = { x: a.exit.x, y: a.exit.y }; }
      tick(w, false);
   }
   return w.phase;
}

for (const m of ALL) {
   test(`${m.id} ${m.title}: builds and runs 60 s without exceptions`, () => {
      const w = new World('normal', 7, m);
      assert.ok(w.director, 'campaign mission has a director');
      assert.ok(m.survival || w.bots.length + w.director.pendingWaves().length > 0, 'mission has enemies');
      while (w.time < 60 && w.phase === 'playing') tick(w);
      assert.ok(w.time > 1);
      const v = w.director.view();
      assert.equal(v.title, m.title);
      assert.ok(v.objectives.length >= 1);
      for (const s of w.ships) assert.ok(Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y), `${s.name} position finite`);
   });

   test(`${m.id}: player sinking loses the mission`, () => {
      const w = new World('normal', 3, m);
      for (let i = 0; i < 30; i++) tick(w, false);
      w.player._damage(1e9, {});
      assert.equal(w.phase, 'lost');
      assert.ok(w.endReason && w.endReason.length > 5);
      assert.equal(w.director.stars(), 0);
   });

   if (!m.survival) {
      test(`${m.id}: clearing the objective wins with at least one star`, () => {
         const w = new World('hard', 5, m);
         assert.equal(forceWin(w), 'won', `${m.id} should be winnable`);
         const s = w.director.stars();
         assert.ok(s >= 1 && s <= 3, `stars ${s}`);
         assert.equal(w.director.criteria().length, (m.stars || []).length);
      });
   }
}

test('m2: too many escaped transports fails the intercept', () => {
   const m = missionById('m2');
   const w = new World('normal', 1, m);
   for (let i = 0; i < 10 && w.phase === 'playing'; i++) {
      for (const b of w.bots) if (b.alive && b.tag === 'convoy' && b.exit) b.pos = { x: b.exit.x, y: b.exit.y };
      tick(w, false);
   }
   assert.equal(w.phase, 'lost');
   assert.match(w.endReason, /entkommen/);
});

test('m8: losing the escorted transports fails the mission', () => {
   const w = new World('normal', 1, missionById('m8'));
   for (let i = 0; i < 10 && w.phase === 'playing'; i++) {
      for (const a of w.allies) if (a.alive && a.tag === 'escort') a._damage(1e9, {});
      tick(w, false);
   }
   assert.equal(w.phase, 'lost');
   assert.match(w.endReason, /verloren/);
});

test('survival: waves escalate and score counts', () => {
   const w = new World('normal', 2, SURVIVAL);
   const d = w.director;
   let lastCount = 0;
   for (let wave = 1; wave <= 4; wave++) {
      while (d.wave < wave && w.time < 200) tick(w, false);
      assert.equal(d.wave, wave);
      const n = w.bots.filter(b => b.alive).length;
      assert.ok(n >= 1);
      if (wave > 1) assert.ok(n >= lastCount - 1, 'waves do not shrink');
      lastCount = n;
      for (const b of w.bots) if (b.alive) b._damage(1e9, {});
      tick(w, false);
   }
   assert.ok(d.score > 0);
   assert.equal(w.phase, 'playing', 'survival never ends by itself');
});

test('submarine: dived = invisible and immune to main guns', () => {
   const w = new World('normal', 1, missionById('m3'));
   const s = w.bots.find(b => b.cfg.sub) || w.spawnBot({ cls: 'SUB', pos: { x: w.player.pos.x + 900, y: w.player.pos.y } });
   s.pos = { x: w.player.pos.x + 900, y: w.player.pos.y };
   s.depth = s.depthTarget = 1.6;
   w._updateVision(0);
   assert.equal(s.visible, false);
   assert.equal(w.canSee(w.player, s), null);
   s.depth = 0;
   assert.ok(w.canSee(w.player, s));
});

test('mine detonates under a surface ship and counts for stars', () => {
   const w = new World('normal', 1, missionById('m1'));
   const p = w.player;
   w.addMine({ x: p.pos.x, y: p.pos.y }, 'enemy', true);
   const hp = p.hp;
   tick(w, false);
   assert.ok(p.hp < hp, 'mine damaged the player');
   assert.equal(w.stats.mineHits, 1);
   assert.equal(w.mines.length, 0);
});

test('mission chain: next mission follows in order', () => {
   assert.equal(nextMission('m1').id, 'm2');
   assert.equal(nextMission(MISSIONS[MISSIONS.length - 1].id), null);
   assert.ok(MISSIONS.length >= 8);
});
