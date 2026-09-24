// tests/sim.test.mjs — headless simulation tests (no DOM): bots move, fire, damage lands, game ends.
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../game/state.js';
import { updateBot } from '../game/ai.js';
import { buildDaily, seedFor, recordDaily, loadBoard, saveBoard, bestOf, shiftKey } from '../game/daily.js';
import { bossPhaseIndex } from '../game/boss.js';
import { SHIPS } from '../game/config.js';

function tick(world, dt = 1 / 60) {
   // mimic main.js step(): bots decide, then physics
   for (const b of world.bots) if (b.alive) updateBot(b, world, dt);
   world.update(dt);
}

test('bots move toward the player', () => {
   const w = new World('normal');
   // this test is about movement: a stationary Bismarck would be sunk before the 40 s are up,
   // after which the bots (correctly) lose interest and wander off
   w.player.maxHP = w.player.hp = 1e9;
   const p0 = w.player.pos;
   const d0 = w.bots.map(b => Math.hypot(b.pos.x - p0.x, b.pos.y - p0.y));
   // 40s, not 20s: at the current (much higher) ship speeds a bot may have to curve around
   // an obstacle it approaches early on, which can transiently increase its distance to the
   // player before it closes back in -- 20s was tuned for a slower era and could catch a
   // bot still mid-detour. 40s reliably gives every class time to complete the approach.
   // closest approach, not the final snapshot: bots now kite around their preferred range and
   // DDs peel off to repair/smoke, so the distance at t=40 s oscillates by design
   const dMin = d0.slice();
   for (let i = 0; i < 60 * 40; i++) {   // 40 s
      tick(w);
      w.bots.forEach((b, j) => { dMin[j] = Math.min(dMin[j], Math.hypot(b.pos.x - p0.x, b.pos.y - p0.y)); });
   }
   assert.ok(dMin.every((d, i) => d < d0[i] - 100), `bots should close in: ${d0} -> ${dMin}`);
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

// ---- smoke: blocks SIGHT, not projectiles ----
function smokeCloud(w, pos, r = 400) {
   const c = { c: { x: pos.x, y: pos.y }, r, targetR: r, age: 0, life: 999, side: 'player', ship: null, fresh: false };
   w.smokeClouds.push(c);
   return c;
}
// a world with only the player and one bot, so nobody else wanders into proximity range
function duel(cls = 'EB', botPos = { x: 1400, y: 0 }) {
   const w = new World('normal');
   const bot = w.bots.find(b => b.cls === cls);
   w.bots = [bot];
   w.ships = [w.player, bot];
   w.mission.pressure = [];
   bot.pos = { ...botPos };
   bot.heading = Math.PI;
   return { w, bot };
}

test('smoke hides but does not stop shells: a shell through a cloud still hits', () => {
   const w = new World('normal');
   w.player.pos = { x: 0, y: 0 };
   w.player.heading = Math.PI / 2; // broadside to the shell
   smokeCloud(w, { x: -600, y: 0 });
   const gun = { ...w.bots[0].cfg.main, type: 'HE', ap: 0, fire: 0 };
   w.spawnShell(w.bots[0], { x: -1500, y: 0 }, { x: 1, y: 0 }, gun, 'main', 1500);
   const hp0 = w.player.hp;
   for (let i = 0; i < 60 * 4; i++) w.update(1 / 60);
   assert.ok(w.player.hp < hp0, 'a shell flying through smoke must still be able to hit');
});

test('plunging fire: shells arc over ships in the first part of their flight', () => {
   const w = new World('normal');
   const dd = w.bots.find(b => b.cls === 'DD');
   dd.pos = { x: 0, y: 3000 }; dd.heading = Math.PI / 2; dd.throttleIn = 0; dd.speed = 0;
   const gun = { ...w.player.cfg.main, type: 'HE' };
   // aimed at 1500 m; the DD sits at 300 m on the line, far outside the descending hit window
   w.spawnShell(w.player, { x: 0, y: 2700 }, { x: 0, y: 1 }, gun, 'main', 1500);
   const hp0 = dd.hp;
   for (let i = 0; i < 60 * 4; i++) w.update(1 / 60);
   assert.strictEqual(dd.hp, hp0, 'the shell must fly over a ship it was not aimed at');
   assert.strictEqual(w.shells.length, 0, 'the shell splashes down near its aimed range');
});

test('smoke hides a ship beyond proximity range and reveals it inside it', () => {
   const { w, bot } = duel('EB', { x: 1400, y: 0 });
   smokeCloud(w, { x: 0, y: 0 });
   w.update(1 / 60);
   assert.strictEqual(w.player.visible, false, 'player in smoke at 1400 m must be unspotted');
   bot.pos = { x: w.proxRange(w.player) - 50, y: 0 };
   w.update(1 / 60);
   assert.strictEqual(w.player.visible, true, 'inside proximity range smoke does not help');
   assert.strictEqual(w.player.visReason, 'prox');
});

test('AI cannot lock a smoked target: only blind area fire at its last known position', () => {
   const { w, bot } = duel('EB', { x: 1400, y: 0 });
   for (let i = 0; i < 30; i++) tick(w);   // spotted: last known position recorded
   assert.ok(w.player.lastKnown, 'last known position recorded while spotted');
   smokeCloud(w, { x: 0, y: 0 });
   const shots0 = bot.shotsFired, blind0 = bot.blindShots;
   for (let i = 0; i < 60 * 10; i++) {
      tick(w);
      assert.ok(!w.player.visible || w.player.visReason !== 'sight', 'no clear sight line through smoke');
   }
   const shots = bot.shotsFired - shots0, blind = bot.blindShots - blind0;
   assert.ok(shots > 0, 'the bot area-fires at the smoke');
   assert.strictEqual(blind, shots, 'every shot at a smoked target is a blind shot');
});

test('gun bloom: firing the main battery from smoke reveals the shooter for a few seconds', async () => {
   const { VISION } = await import('../game/config.js');
   const { w, bot } = duel('EB', { x: 1400, y: 0 });
   const p = w.player;
   // anchored: ships otherwise creep at minimum throttle and the bot would drift into prox range
   p.anchorOut = bot.anchorOut = true;
   smokeCloud(w, { x: 0, y: 0 });
   w.update(1 / 60);
   assert.strictEqual(p.visible, false);
   // let the turrets train on the bot, then fire
   p.aimBearing = 0;
   for (let i = 0; i < 60 * 8; i++) p.update(1 / 60);
   const n = p.fireMain(w, null, { x: 1, y: 0 }, { aimPoint: bot.pos });
   assert.ok(n > 0, 'player salvo fired');
   w.update(1 / 60);
   assert.ok(p.bloomRange > 1400, `bloom range ${p.bloomRange} covers the bot`);
   assert.strictEqual(p.visible, true, 'salvo from smoke reveals the shooter');
   assert.strictEqual(p.visReason, 'bloom');
   for (let i = 0; i < 60 * (VISION.bloomTime + 0.5); i++) { w.update(1 / 60); w.shells.length = 0; }
   assert.strictEqual(p.visible, false, 'hidden again once the bloom has faded');
});

test('gun bloom only reaches medium range', () => {
   const { w, bot } = duel('EB', { x: 0, y: 0 });
   const p = w.player;
   bot.pos = { x: p.bloomRange + 200, y: 0 };
   smokeCloud(w, { x: 0, y: 0 });
   p.bloomT = 5;
   w.update(1 / 60);
   assert.strictEqual(p.visible, false, 'a bot beyond bloom range does not see the muzzle flash through smoke');
});

// ---- damage model ----
test('AP: broadside penetrates / citadels, bow-on ricochets, destroyers get over-penetrated', async () => {
   const { rollHit } = await import('../game/combat.js');
   const w = new World('normal');
   const hc = w.bots.find(b => b.cls === 'HC');
   const dd = w.bots.find(b => b.cls === 'DD');
   const ap = { ...w.player.cfg.main, ...w.player.cfg.main.ammo.AP, kind: 'main' };
   const count = (ship, heading, vel, along = 0) => {
      ship.heading = heading;
      const out = {};
      for (let i = 0; i < 400; i++) {
         const r = rollHit(ship, { ...ap, vel }, { along, across: 0 });
         out[r.outcome] = (out[r.outcome] || 0) + 1;
      }
      return out;
   };
   const broadside = count(hc, Math.PI / 2, { x: 650, y: 0 });
   assert.ok((broadside.CITADEL || 0) > 250, `broadside cruiser citadel hits: ${JSON.stringify(broadside)}`);
   const bowOn = count(hc, 0, { x: 650, y: 0 });
   assert.ok((bowOn.RICOCHET || 0) > 300, `bow-on cruiser bounces AP: ${JSON.stringify(bowOn)}`);
   const vsDD = count(dd, Math.PI / 2, { x: 650, y: 0 });
   assert.ok((vsDD.OVERPEN || 0) > 300, `AP over-pens a destroyer: ${JSON.stringify(vsDD)}`);
   // HE never bounces and beats AP against a destroyer
   const he = { ...w.player.cfg.main, ...w.player.cfg.main.ammo.HE, kind: 'main', vel: { x: 650, y: 0 } };
   const r = rollHit(dd, he, { along: 0, across: 0 });
   assert.strictEqual(r.outcome, 'HE');
   assert.ok(r.dmg > ap.dmg * 0.4, 'HE damage vs DD beats an over-pen');
});

test('ammo switch: 1/2 swaps shell type and costs reload on loaded turrets', () => {
   const w = new World('normal');
   const p = w.player;
   assert.strictEqual(p.ammo, 'AP');
   for (const t of p.turrets) t.cd = 0;
   assert.ok(p.setAmmo('HE'));
   assert.strictEqual(p.mainShell().type, 'HE');
   assert.ok(p.turrets.every(t => t.cd >= p.cfg.main.switchTime - 1e-9), 'switch penalty applied');
   assert.strictEqual(p.setAmmo('HE'), false, 'no-op when already loaded');
});

test('per-turret reload: firing one turret leaves the others loaded', () => {
   const w = new World('normal');
   const p = w.player;
   p.aimBearing = 0;
   for (let i = 0; i < 60 * 3; i++) p.update(1 / 60);
   const n = p.fireMain(w, null, { x: 1, y: 0 }, { aimPoint: { x: 1500, y: 0 }, maxTurrets: 1 });
   assert.ok(n > 0);
   const loaded = p.turrets.filter(t => t.cd <= 0).length;
   assert.strictEqual(loaded, p.turrets.length - 1, 'ripple fire: exactly one turret reloading');
});

// ---- consumables ----
test('consumables: damage control clears fires and grants immunity; charges and cooldowns', () => {
   const w = new World('normal');
   const p = w.player;
   p.ignite(1); p.flood(2);
   assert.ok(p.fires.length && p.floods.length);
   assert.ok(p.useConsumable('dc'));
   assert.strictEqual(p.fires.length + p.floods.length, 0, 'dc clears fires + floods');
   p.ignite(3);
   assert.strictEqual(p.fires.length, 0, 'no new fires while dc is active');
   assert.strictEqual(p.useConsumable('dc'), false, 'cannot re-use while active');
   const smoke0 = p.cons.smoke.charges;
   assert.ok(p.useConsumable('smoke'));
   assert.strictEqual(p.cons.smoke.charges, smoke0 - 1, 'smoke uses a charge');
   for (let i = 0; i < 60 * (p.cons.smoke.cfg.dur + 0.5); i++) p.update(1 / 60);
   assert.strictEqual(p.consState('smoke'), 'cd', 'smoke goes on cooldown after its active phase');
   assert.ok(w.smokeClouds.some(c => c.ship === p), 'smoke laid while active');
});

test('repair party heals only the restorable part of the damage', () => {
   const w = new World('normal');
   const p = w.player;
   assert.strictEqual(p.useConsumable('repair'), false, 'nothing to repair at full HP');
   p._damage(2000, { source: 'citadel' });
   p._damage(1000, { source: 'main' });
   const hurt = p.hp;
   const pool = p.healable;
   assert.ok(pool > 0 && pool < 3000, `restorable pool ${pool}`);
   assert.ok(p.useConsumable('repair'));
   for (let i = 0; i < 60 * (p.cons.repair.cfg.dur + 1); i++) p.update(1 / 60);
   assert.ok(p.hp > hurt, 'repair healed');
   assert.ok(p.hp <= hurt + pool + 1, 'but never more than the restorable pool');
});

// ---- torpedoes ----
test('torpedoes: side launchers only fire into their beam arc, fan width toggles', () => {
   const w = new World('normal');
   const p = w.player;
   p.heading = 0;
   assert.strictEqual(p.launcherFor(0), null, 'no launcher bears dead ahead');
   assert.strictEqual(p.launcherFor(Math.PI / 2).id, 'stbd');
   assert.strictEqual(p.launcherFor(-Math.PI / 2).id, 'port');
   const narrow = p.torpFan(Math.PI / 2);
   p.toggleTorpSpread();
   const wide = p.torpFan(Math.PI / 2);
   const width = (f) => f[f.length - 1] - f[0];
   assert.ok(width(wide) > width(narrow) * 2, 'wide fan is much wider');
   const n = p.fireTorpedo(w, null, { x: 0, y: 1 });
   assert.strictEqual(n, p.cfg.torp.salvo);
   assert.ok(p.launchers.find(l => l.id === 'stbd').cd > 0, 'starboard launcher reloading');
   assert.strictEqual(p.launchers.find(l => l.id === 'port').cd, 0, 'port launcher still loaded');
});

test('reload events drive the audio cues: turret reloaded + launcher ready', () => {
   const w = new World('normal');
   const p = w.player;
   p.anchorOut = true;
   w.bots.forEach(b => { b.alive = false; });  // nothing to interfere; we only watch the player's own events
   p.heading = 0;
   assert.ok(p.fireTorpedo(w, null, { x: 0, y: 1 }) > 0);
   p.fireMain(w, null, { x: 1, y: 0 }, { aimPoint: { x: p.pos.x + 900, y: p.pos.y } });
   const seen = new Set();
   for (let i = 0; i < 60 * (p.cfg.torp.cd + 2); i++) {
      w.update(1 / 60);
      for (const ev of w.events) if (ev.ship === p) seen.add(ev.kind);
      w.events.length = 0;
   }
   assert.ok(seen.has('reloaded'), 'turret reload emitted');
   assert.ok(seen.has('torpReady'), 'launcher ready emitted');
});

test('hit events carry ribbon outcomes for the HUD', () => {
   const w = new World('normal');
   const dd = w.bots.find(b => b.cls === 'DD');
   dd.pos = { x: 0, y: 1500 }; dd.heading = 0; dd.speed = 0; dd.throttleIn = 0;
   dd.anchorOut = true;   // no minimum-throttle creep out of the shell's path
   w.obstacles.length = 0;   // an island sits on this line in the default layout
   const gun = { ...w.player.cfg.main, ...w.player.cfg.main.ammo.HE };
   w.spawnShell(w.player, { x: 0, y: 0 }, { x: 0, y: 1 }, gun, 'main', 1500);
   for (let i = 0; i < 60 * 4; i++) w.update(1 / 60);
   const hit = w.events.find(e => e.kind === 'hit' && e.target === dd);
   assert.ok(hit, 'hit event emitted');
   assert.strictEqual(hit.outcome, 'HE');
   assert.strictEqual(hit.shooter, w.player);
   assert.ok(w.player.dmgDealt > 0 && Math.abs(w.player.dmgDealt - dd.dmgTaken) < 1e-6, 'damage credited exactly once');   // dmgTaken, not maxHP-hp: bots self-repair
});

test('RETREAT->REPAIR gate: damaged bot repairs once out of danger', () => {
   const w = new World('normal');
   const eb = w.bots.find(b => b.cls === 'EB');
   // park it in a far corner at 30% HP, mid-retreat — the realistic entry point, since
   // bots only enter RETREAT below 40%. Pre-fix, the RETREAT->REPAIR gate required
   // hp > 50%, which a retreating bot can never satisfy: the state was unreachable and
   // bots limped back into fights permanently damaged. Post-fix it flips within seconds.
   eb.pos = { x: -3000, y: -3000 };
   eb.hp = eb.maxHP * 0.3;
   eb.state = 'RETREAT'; eb.stateTime = 0;
   let sawRepair = false;
   for (let i = 0; i < 60 * 10; i++) { tick(w); if (eb.state === 'REPAIR') { sawRepair = true; break; } }
   assert.ok(sawRepair, 'bot should enter REPAIR shortly after retreating out of danger');
});

test('passive self-repair: hurt bot left alone heals its hull back up', () => {
   const w = new World('normal');
   const eb = w.bots.find(b => b.cls === 'EB');
   // Drive ship.update() directly (no AI ticks) so nothing wanders into danger and there
   // are no modules ticking DoT — this isolates the passive hull-heal path, which is fully
   // deterministic (REPAIR_RATE * 0.35 fraction/s while nearestThreat >= 600).
   eb.pos = { x: -3000, y: -3000 };
   eb.hp = eb.maxHP * 0.4;
   for (let i = 0; i < 60 * 60; i++) eb.update(1 / 60);
   assert.ok(eb.hp > eb.maxHP * 0.85, `bot should heal back up, got ${(eb.hp / eb.maxHP).toFixed(2)} of max`);
});

test('passive self-repair: damage control clears fires and floods while safe', async () => {
   const w = new World('normal');
   const eb = w.bots.find(b => b.cls === 'EB');
   // Seed one fire + one flood and let the ship sit safely out of range. Damage control
   // clears each module at ~12%/s, so both are gone long before 120s (P(still present)
   // ~1e-7). Fire spread is disabled so the seeded fire can't cascade into more modules.
   const { COMBAT } = await import('../game/config.js');
   const savedSpreadP = COMBAT.fire.spreadP;
   COMBAT.fire.spreadP = 0;
   try {
      eb.pos = { x: -3000, y: -3000 };
      eb.fires.push({ mod: 1, heat: 0, spreadT: 0, t: 0, dmgMult: 1 });
      eb.floods.push({ mod: 2, t: 0, dmgMult: 1 });
      for (let i = 0; i < 60 * 120; i++) eb.update(1 / 60);
   } finally {
      COMBAT.fire.spreadP = savedSpreadP;
   }
   assert.strictEqual(eb.fires.length, 0, 'fires should be cleared while safe');
   assert.strictEqual(eb.floods.length, 0, 'floods should be pumped out while safe');
});

// ---------- daily challenge ----------
const setupOf = (m) => JSON.stringify({ mod: m.mod.id, obstacles: m.obstacles, player: m.player, bots: m.bots, waves: m.waves });

test('daily: same date -> identical battle, different date -> different battle', () => {
   const a = buildDaily('2026-09-24'), b = buildDaily('2026-09-24');
   assert.strictEqual(setupOf(a), setupOf(b));
   assert.strictEqual(a.seed, seedFor('2026-09-24'));
   const c = buildDaily('2026-09-25');
   assert.notStrictEqual(setupOf(a), setupOf(c));
   assert.ok(a.bots.length > 0 && a.waves.length === 2 && a.obstacles.length >= 5);
   // over two weeks the modifier list is actually exercised
   const mods = new Set();
   for (let i = 0; i < 14; i++) mods.add(buildDaily(shiftKey('2026-09-24', i)).mod.id);
   assert.ok(mods.size >= 3, `only ${[...mods]} in 14 days`);
});

// the generator (map, modifier, waves) is fully seeded; the combat sim itself keeps its dice
// (dispersion, AI jitter) -- the player's own inputs make every run differ anyway
test('daily: generator never touches Math.random, and the spawned battle starts identically', () => {
   const rnd = Math.random;
   Math.random = () => { throw new Error('Math.random used in daily generator'); };
   let m;
   try { m = buildDaily('2027-01-03'); } finally { Math.random = rnd; }
   const start = () => {
      const w = new World('normal', m.seed, buildDaily('2027-01-03'));
      return w.bots.map(b => `${b.cls}:${Math.round(b.pos.x)},${Math.round(b.pos.y)}:${Math.round(b.maxHP)}`).join('|')
         + `#${w.obstacles.length}#${Math.round(w.player.heading * 1000)}`;
   };
   assert.strictEqual(start(), start());
});

test('daily leaderboard: top 10 per day, sorted, survives missing/broken storage', () => {
   const mem = {}; const store = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } };
   const b = loadBoard(store);
   assert.strictEqual(b.name, 'Kapitän');
   for (let i = 0; i < 12; i++) recordDaily(b, '2026-09-24', { name: 'Bot' + i, score: i * 100, time: 300, id: i });
   const rank = recordDaily(b, '2026-09-24', { name: 'Kapitän', score: 650, time: 200, id: 99 });
   assert.strictEqual(rank, 5);
   assert.ok(saveBoard(b, store));
   const b2 = loadBoard(store);
   const list = b2.days['2026-09-24'];
   assert.strictEqual(list.length, 10);
   assert.ok(list.every((e, i) => i === 0 || list[i - 1].score >= e.score));
   assert.strictEqual(bestOf(b2, '2026-09-24').id, 99);
   assert.strictEqual(recordDaily(b2, '2026-09-24', { score: 1, time: 1 }), -1);
   const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
   assert.deepStrictEqual(loadBoard(broken).days, {});
   assert.strictEqual(saveBoard(b2, broken), false);
   assert.deepStrictEqual(loadBoard(null).days, {});
});

// ---------- boss phases ----------
test('boss: phase index follows the hull thresholds', () => {
   const ph = SHIPS.HOOD.bossPhases;
   assert.strictEqual(bossPhaseIndex(ph, 1), 0);
   assert.strictEqual(bossPhaseIndex(ph, 0.7), 0);
   assert.strictEqual(bossPhaseIndex(ph, 0.6), 1);
   assert.strictEqual(bossPhaseIndex(ph, 0.2), 2);
   assert.strictEqual(bossPhaseIndex(undefined, 0.1), 0);
   for (const k of ['BOSS', 'HOOD', 'RODNEY']) assert.ok(SHIPS[k].bossPhases.length >= 3, k);
});

test('boss: phases only advance, announce themselves, and the torpedo fan is telegraphed first', () => {
   const mission = {
      id: 'test-boss', title: 'Test', player: { cls: 'Bismarck', pos: { x: 0, y: 0 }, heading: 0 },
      bots: [{ cls: 'HOOD', pos: { x: 1300, y: 0 }, heading: Math.PI, tag: 'boss' }],
      objectives: [{ type: 'sinkAll', text: 'x' }], stars: [],
   };
   const w = new World('normal', 5, mission);
   w.player.maxHP = w.player.hp = 1e9;
   const boss = w.bots.find(b => b.cls === 'HOOD');
   for (let i = 0; i < 60 * 2; i++) tick(w);
   assert.strictEqual(boss.bossPhase, 0);
   boss.hp = boss.maxHP * 0.6;
   tick(w);
   assert.strictEqual(boss.bossPhase, 1);
   assert.ok(w.events.some(e => e.kind === 'bossPhase' && e.phase === 1));
   // fan: warning lanes first, torpedoes only after the warning ran out
   let warned = false, torpsAtWarn = -1;
   for (let i = 0; i < 60 * 12 && !(warned && !boss.fanWarn); i++) {
      tick(w);
      if (boss.fanWarn && !warned) { warned = true; torpsAtWarn = w.torpedoes.length; assert.ok(boss.fanWarn.angles.length >= 3); }
   }
   assert.ok(warned, 'fan was never telegraphed');
   assert.ok(w.torpedoes.length >= torpsAtWarn + 3, 'fan did not launch after the warning');
   // healing back up never reverts the phase; dropping further skips straight to the last one
   boss.hp = boss.maxHP;
   tick(w);
   assert.strictEqual(boss.bossPhase, 1);
   boss.hp = boss.maxHP * 0.2;
   tick(w);
   assert.strictEqual(boss.bossPhase, 2);
   assert.ok(boss.rapidCd > 0);
});
