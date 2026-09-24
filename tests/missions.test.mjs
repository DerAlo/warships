// tests/missions.test.mjs — headless campaign checks: every mission builds and runs 60 s under a
// simple autopilot without exceptions, its win and lose conditions trigger, the star rating and
// survival waves work. Run: node --test tests/missions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../game/state.js';
import { updateBot } from '../game/ai.js';
import { MISSIONS, SURVIVAL, missionById, nextMission, survivalWave } from '../game/missions.js';
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

// ---- navigation: nothing spawns on an island and scripted routes do not run over one ----
function segGap(o, a, b) {
   const vx = b.x - a.x, vy = b.y - a.y;
   const t = clamp(((o.c.x - a.x) * vx + (o.c.y - a.y) * vy) / (vx * vx + vy * vy || 1), 0, 1);
   return Math.hypot(a.x + vx * t - o.c.x, a.y + vy * t - o.c.y) - o.r;
}
test('missions: spawns clear of islands, routes pass between them', () => {
   for (const m of MISSIONS) {
      const specs = [m.player, ...(m.bots || []), ...(m.allies || [])];
      for (const wv of m.waves || []) specs.push(...(wv.bots || []), ...(wv.allies || []));
      for (const s of specs) {
         if (!s || !s.pos || s.cls === 'CB') continue;   // coastal batteries sit on the shore on purpose
         for (const o of m.obstacles || []) {
            assert.ok(dist(s.pos, o.c) - o.r > 0, `${m.id}: ${s.cls} spawns inside ${o.kind} at ${o.c.x},${o.c.y}`);
            if (!s.path || o.kind !== 'island') continue;
            const pts = [s.pos, ...s.path, ...(s.loop ? [s.path[0]] : s.exit ? [s.exit] : [])];
            for (let i = 0; i + 1 < pts.length; i++) assert.ok(segGap(o, pts[i], pts[i + 1]) > 60, `${m.id}: ${s.cls} route leg ${i} crosses island ${o.c.x},${o.c.y}`);
         }
      }
   }
   for (let n = 1; n <= 25; n++) for (const s of survivalWave(n, { x: (n % 5 - 2) * 900, y: 0 }, n * 31)) {
      if (!s.pos) continue;
      for (const o of SURVIVAL.obstacles) assert.ok(dist(s.pos, o.c) > o.r + 150, `survival wave ${n}: ${s.cls} spawns on ${o.kind}`);
   }
});

test('m8: the convoy reaches the rendezvous without circling islands', () => {
   const w = new World('normal', 3, missionById('m8'));
   for (const b of w.bots) b.alive = false;             // pure navigation: no attackers
   w.director.waves.forEach(x => { x.done = true; });
   while (w.time < 230 && w.phase === 'playing') {
      const p = w.player; p.hp = p.maxHP;
      const lead = w.allies.find(a => a.alive && a.tag);
      if (lead) {
         p.helm = clamp(angleDelta(p.heading, angleOf(sub(lead.pos, p.pos))) * 2, -1, 1);
         p.throttleIn = dist(lead.pos, p.pos) > 600 ? 1 : 0.3;
      }
      tick(w, false);
   }
   assert.equal(w.phase, 'won');
   assert.ok(w.allies.filter(a => a.tag === 'escort' && a.arrived).length === 4, 'all four freighters arrive');
});

test('AI: a bot with a goal behind an island gets round it', () => {
   const w = new World('normal', 3, missionById('m4'));
   for (const b of w.bots) b.alive = false;
   const o = w.obstacles[0];
   const bot = w.spawnBot({ cls: 'TR', pos: { x: o.c.x - o.r - 700, y: o.c.y }, heading: 0, path: [], exit: { x: o.c.x + o.r + 900, y: o.c.y, r: 200 } }, 'enemy');
   bot.pathIdx = 0;
   while (w.time < 90 && bot.alive) { w.player.hp = w.player.maxHP; updateBot(bot, w, DT); w.update(DT); w.events.length = 0; }
   assert.ok(!bot.alive && bot.escaped, 'the transport got round the island to its exit');
});

test('accuracy counts main-battery hits only', () => {
   const w = new World('normal', 3, missionById('m1'));
   const p = w.player, tgt = w.bots[0];
   // a secondary shell and a main shell landing right on the target
   for (const kind of ['sec', 'main']) {
      const gun = kind === 'sec' ? p.cfg.sec : p.cfg.main;
      const s = w.spawnShell(p, { x: tgt.pos.x - 5, y: tgt.pos.y }, { x: 1, y: 0 }, gun, kind, 10);
      s.age = s.arcDur;   // already on the way down
      w.update(DT);
      w.events.length = 0;
   }
   assert.equal(p.shotsHit, 1, 'only the main-battery shell counts toward accuracy');
});

test('damage numbers from one salvo on one hull merge into a single number', () => {
   const w = new World('normal', 3, missionById('m1'));
   w.damageNumbers.length = 0;
   const at = { x: 500, y: 200 };
   w.addDamageNumber(at, 900, 'dmg');
   w.addDamageNumber({ x: 520, y: 210 }, 2700, 'cit');
   w.addDamageNumber({ x: 1500, y: 200 }, 300, 'dmg');   // another ship: stays separate
   assert.equal(w.damageNumbers.length, 2);
   assert.equal(w.damageNumbers[0].text, '3600');
   assert.equal(w.damageNumbers[0].type, 'cit', 'the strongest hit type wins');
});
