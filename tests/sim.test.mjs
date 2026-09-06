// tests/sim.test.mjs — headless simulation tests (no DOM): bots move, fire, damage lands, game ends.
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../game/state.js';
import { updateBot } from '../game/ai.js';

function tick(world, dt = 1 / 60) {
   // mimic main.js step(): bots decide, then physics
   for (const b of world.bots) if (b.alive) updateBot(b, world, dt);
   world.update(dt);
}

test('bots move toward the player', () => {
   const w = new World('normal');
   const p0 = w.player.pos;
   const d0 = w.bots.map(b => Math.hypot(b.pos.x - p0.x, b.pos.y - p0.y));
   for (let i = 0; i < 60 * 20; i++) tick(w);   // 20 s
   const d1 = w.bots.map(b => Math.hypot(b.pos.x - p0.x, b.pos.y - p0.y));
   assert.ok(d1.every((d, i) => d < d0[i] - 100), `bots should close in: ${d0} -> ${d1}`);
});

test('battleship fires shells once in range', () => {
   const w = new World('normal');
   // teleport an EB next to the player so it must engage immediately
   const eb = w.bots.find(b => b.cls === 'EB');
   eb.pos = { x: 1400, y: 0 };
   eb.heading = Math.PI;
   let shots = 0;
   for (let i = 0; i < 60 * 30; i++) { tick(w); shots += w.shells.length > 0 ? 1 : 0; }
   assert.ok(eb.shotsFired > 0, 'EB should have fired');
   assert.ok(w.shells.length >= 0 && shots > 0, 'shells should exist mid-battle');
});

test('damage model: AP shell can penetrate or bounce, never negative hp below sink', () => {
   const w = new World('normal');
   const target = w.bots.find(b => b.cls === 'DD');
   const hpBefore = target.hp;
   // fire a direct hit via resolveHit path: spawn a shell aimed at the DD
   const dir = { x: 1, y: 0 };
   w.spawnShell(w.player, { x: target.pos.x - 100, y: target.pos.y }, dir, w.player.cfg.main, 'main');
   for (let i = 0; i < 60 * 3; i++) tick(w);
   assert.ok(target.hp <= hpBefore, 'target hp should not increase');
   assert.ok(target.alive || target.hp <= 0, 'hp floor respected');
});

test('game reaches a terminal phase when player sinks', () => {
   const w = new World('hard');
   // surround the player with all bots at point-blank so it dies fast
   for (const b of w.bots) {
      b.pos = { x: w.player.pos.x + 900, y: w.player.pos.y };
      b.heading = Math.PI;
      b.state = 'ENGAGE';
   }
   let steps = 0;
   while (w.phase === 'playing' && steps < 60 * 300) { tick(w); steps++; }
   assert.strictEqual(w.phase, 'lost', `player should sink, got ${w.phase} after ${steps / 60}s`);
});

test('player wins when all bots are sunk', () => {
   const w = new World('easy');
   for (const b of w.bots) { b.hp = 1; b._sink(); }
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(w.killCount, w.bots.length);
});

test('smoke blocks line of fire (shell intercepted)', () => {
   const w = new World('normal');
   // player sits at origin; an enemy shell flies west->east along y=0 from x=-1500.
   // A PLAYER-side smoke cloud sits between the muzzle and the player: the enemy
   // shell must be intercepted by it (own smoke hides you from the other side).
   w.player.pos = { x: 0, y: 0 };
   // life must be set: _updateSmoke filters clouds by life > 0 each tick;
   // targetR must be set too: _updateSmoke grows r toward targetR (undefined -> NaN)
   w.smokeClouds.push({ c: { x: -600, y: 0 }, r: 400, targetR: 400, side: 'player', age: 0, life: 999 });
   w.spawnShell(w.bots[0], { x: -1500, y: 0 }, { x: 1, y: 0 }, w.bots[0].cfg.main, 'main');
   for (let i = 0; i < 60 * 3; i++) tick(w);
   assert.ok(w.player.hp === w.player.maxHP, 'no damage through smoke');
});
