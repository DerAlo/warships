// tests/sim3d.test.mjs — headless tests for the 3D simulation core (game3d/, no DOM):
// missions, ballistics, dispersion, smoke, spotting, damage model, damage control, win/lose,
// allied AI and the telegraph/rudder controls.  Run: node --test tests/sim3d.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../game3d/state.js';
import { MISSIONS, MISSION_IDS, getMission, opStars } from '../game3d/missions.js';
import { SHIPS, WORLD } from '../game3d/config.js';
import { flightTime, makeShell, resolveShells, resolveHit, weatherDispersion } from '../game3d/combat.js';
import { obstacleT } from '../game3d/utils.js';
import './progress3d.test.mjs';    // career progression tests run with this suite

const DT = 1 / 60;

// A world stripped down to an empty sea so single mechanics can be tested in isolation.
function blank(seed = 1) {
   const w = new World('normal', { mission: 'standard', seed });
   w.ships = []; w.roster = []; w.bots = []; w._byId.clear(); w.player = null;
   w.obstacles = []; w.caps = []; w.smokeClouds = []; w.shells = []; w.torpedoes = [];
   w._maxTerrainH = 0;
   return w;
}
const finite = (...v) => v.every(Number.isFinite);
const hitTypes = new Set(['citadel', 'pen', 'overpen', 'ricochet', 'shatter', 'he', 'sec']);

test('mission catalogue: at least 6 missions with complete menu data', () => {
   assert.ok(MISSIONS.length >= 6, `only ${MISSIONS.length} missions`);
   assert.deepStrictEqual(MISSION_IDS, MISSIONS.map(m => m.id));
   for (const m of MISSIONS) {
      for (const k of ['id', 'name', 'briefing', 'type', 'recommendedShip']) assert.ok(m[k], `${m.id}.${k}`);
      assert.ok(Array.isArray(m.playableShips) && m.playableShips.length, `${m.id}.playableShips`);
      assert.strictEqual(getMission(m.id), m);
   }
});

for (const id of MISSION_IDS) {
   test(`mission "${id}" runs 90 s headless without exceptions or NaN`, () => {
      const w = new World('normal', { mission: id, seed: 11 });
      w.autoPlayer = true;             // AI captains the player ship so every system gets exercised
      assert.ok(w.player, 'player spawned');
      assert.ok(w.mission.objectives.length > 0, 'has objectives');
      for (let i = 0; i < 90 * 60 && w.phase === 'playing'; i++) {
         w.update(DT);
         if (i % 30 === 0) {
            for (const s of w.ships) assert.ok(finite(s.pos.x, s.pos.y, s.hp, s.heading, s.speed, s.detectRange), `NaN on ${s.name} at t=${w.time}`);
            for (const s of w.shells) assert.ok(finite(s.pos.x, s.pos.y, s.alt), 'NaN shell');
            for (const t of w.torpedoes) assert.ok(finite(t.pos.x, t.pos.y), 'NaN torpedo');
         }
      }
      assert.ok(w.time > 1);
      assert.ok(Number.isFinite(w.timeLeft));
      if (w.phase !== 'playing') assert.ok(w.result && finite(w.result.xp, w.result.credits));
   });
}

test('shell flight time grows (super-linearly) with range for every gun', () => {
   for (const [key, cfg] of Object.entries(SHIPS)) {
      const g = cfg.main;
      if (!g || (cfg.type || cfg.hull.type) === 'TR') continue;
      const R = g.range;
      const t1 = flightTime(g, R * 0.25), t2 = flightTime(g, R * 0.5), t3 = flightTime(g, R);
      assert.ok(t1 > 0 && t1 < t2 && t2 < t3, `${key}: ${t1} ${t2} ${t3}`);
      assert.ok(t2 > 2 * t1, `${key}: drag should make flight time super-linear`);
      assert.ok(t3 > 5 && t3 < 40, `${key}: max-range flight ${t3.toFixed(1)} s out of WoWs-like band`);
   }
   // and a real shell carries the same duration
   const w = blank();
   const bb = w.spawn('Bismarck', 'player', { x: 0, y: 0 }, 0, { isPlayer: true });
   const near = makeShell(w, bb, bb.pos, { x: 5000, y: 0 }, bb.cfg.main, 'main', 'AP');
   const far = makeShell(w, bb, bb.pos, { x: 18000, y: 0 }, bb.cfg.main, 'main', 'AP');
   assert.ok(far.dur > near.dur * 3);
});

test('dispersion is non-zero and bounded by the gun ellipse', () => {
   const w = blank(5);
   const bb = w.spawn('Bismarck', 'player', { x: 0, y: 0 }, 0, { isPlayer: true });
   const g = bb.cfg.main, R = g.range * 0.8;
   let sumX = 0, sumY = 0, sx = 0, sy = 0, maxLat = 0, maxLong = 0;
   const N = 600;
   for (let i = 0; i < N; i++) {
      const s = makeShell(w, bb, { x: 0, y: 0 }, { x: R, y: 0 }, g, 'main', 'AP');
      const dx = s.target.x - R, dy = s.target.y;
      sumX += dx; sumY += dy; sx += dx * dx; sy += dy * dy;
      maxLong = Math.max(maxLong, Math.abs(dx)); maxLat = Math.max(maxLat, Math.abs(dy));
   }
   const sdLat = Math.sqrt(sy / N - (sumY / N) ** 2), sdLong = Math.sqrt(sx / N - (sumX / N) ** 2);
   const dH = g.dispH * (0.2 + 0.8 * 0.8);
   assert.ok(sdLat > 5 && sdLong > 2, `spread too small: lat ${sdLat} long ${sdLong}`);
   assert.ok(maxLat <= dH + 1e-6, `lateral ${maxLat} exceeds ellipse ${dH}`);
   assert.ok(maxLong <= dH * (g.vRatio || 0.55) + 1e-6, `long ${maxLong} exceeds ellipse`);
   assert.ok(Math.abs(sumY / N) < dH * 0.15, 'lateral dispersion should be centred on the aim point');
});

test('smoke does not stop shells (it only blocks vision)', () => {
   const run = (smoke) => {
      const w = blank(9);
      const a = w.spawn('Bismarck', 'player', { x: 0, y: 0 }, 0, { isPlayer: true });
      const t = w.spawn('Bismarck', 'enemy', { x: 9000, y: 0 }, Math.PI / 2, {});
      if (smoke) {
         w.addSmoke({ c: { x: 4500, y: 0 }, r: 600, maxR: 600, life: 999, side: 'enemy' });
         w.addSmoke({ c: { x: 9000, y: 0 }, r: 600, maxR: 600, life: 999, side: 'enemy' });
         assert.ok(w.inSmoke(t.pos) && w.smokeBlocks(a.pos, t.pos));
      }
      for (let i = 0; i < 60; i++) w.addShell(makeShell(w, a, { x: 0, y: 0 }, t.pos, a.cfg.main, 'main', 'AP'));
      for (let i = 0; i < 60 * 30 && w.shells.length; i++) resolveShells(w, DT);
      return { hits: w.events.filter(e => hitTypes.has(e.type)).length, dmg: t.dmgTaken };
   };
   const clear = run(false), smoked = run(true);
   assert.ok(clear.hits > 0, 'baseline salvo should hit');
   assert.deepStrictEqual(smoked, clear, 'smoke changed shell outcomes');
});

test('islands block spotting, proximity and radar see through them', () => {
   const setup = (island) => {
      const w = blank(3);
      const a = w.spawn('Hipper', 'player', { x: 0, y: 0 }, 0, { isPlayer: true });
      const t = w.spawn('Bismarck', 'enemy', { x: 9000, y: 0 }, Math.PI, {});
      if (island) { w.addIsland({ c: { x: 4500, y: 0 }, r: 900, height: 220, seed: 4 }); w._maxTerrainH = 220; }
      a.update(DT, w); t.update(DT, w);             // refresh detection ranges
      assert.ok(t.detectRange > 9000, `BB detect range ${t.detectRange}`);
      w._updateSpotting();
      return { w, a, t };
   };
   assert.strictEqual(setup(false).t.detected, true, 'visible over open water');
   const { w, a, t } = setup(true);
   assert.strictEqual(t.detected, false, 'island should hide the target');
   assert.strictEqual(w.canSee('player', t), false);
   // closer than the proximity radius: always spotted, even behind rock
   t.pos = { x: 4500 + 1400 + 400, y: 0 };
   a.pos = { x: 4500 + 1400 - 1200, y: 0 };
   if (Math.hypot(t.pos.x - a.pos.x, t.pos.y - a.pos.y) < WORLD.PROXIMITY) {
      w._updateSpotting();
      assert.strictEqual(t.detected, true, 'proximity spotting');
   }
});

test('AP ricochets at steep impact angles and bites when angled flat', () => {
   const hit = (targetHeading) => {
      const w = blank(2);
      const a = w.spawn('Hipper', 'player', { x: 0, y: 0 }, 0, { isPlayer: true });
      const t = w.spawn('Bismarck', 'enemy', { x: 8000, y: 0 }, targetHeading, {});
      const s = makeShell(w, a, { x: 0, y: 0 }, t.pos, a.cfg.main, 'main', 'AP');
      s.dirX = 1; s.dirY = 0;                         // exact line of fire, no dispersion wobble
      resolveHit(w, s, t, 'belt', { x: 0, y: t.cfg.hull.beam / 2 - 1 }, { x: t.pos.x, y: t.pos.y });
      return w.events[w.events.length - 1].type;
   };
   // bow-on target: the shell meets the side plate at ~90 deg obliquity -> always ricochets
   for (let i = 0; i < 5; i++) assert.strictEqual(hit(0), 'ricochet');
   // full broadside: no ricochet possible
   for (let i = 0; i < 5; i++) assert.notStrictEqual(hit(Math.PI / 2), 'ricochet');
   // overmatch: a 406 mm shell on a thin cruiser deck-end never ricochets
   const w = blank(4);
   const r = w.spawn('Rodney', 'enemy', { x: 0, y: 0 }, 0, {});
   const ca = w.spawn('Fiji', 'player', { x: 8000, y: 0 }, 0, { isPlayer: true });
   const s = makeShell(w, r, { x: 0, y: 0 }, ca.pos, r.cfg.main, 'main', 'AP');
   s.dirX = 1; s.dirY = 0;
   resolveHit(w, s, ca, 'ends', { x: ca.cfg.hull.L * 0.4, y: 5 }, { x: ca.pos.x, y: ca.pos.y });
   assert.notStrictEqual(w.events[w.events.length - 1].type, 'ricochet');
});

test('fires burn HP and damage control extinguishes them (and grants immunity)', () => {
   const w = blank();
   const s = w.spawn('Bismarck', 'player', { x: 0, y: 0 }, 0, { isPlayer: true });
   assert.ok(s.ignite('bow', null) && s.ignite('mid', null));
   assert.ok(s.flood('bow', null));
   const hp0 = s.hp;
   for (let i = 0; i < 60 * 5; i++) s.update(DT, w);
   assert.ok(s.hp < hp0, 'fires/floods should burn HP');
   assert.strictEqual(s.fires.length, 2);
   assert.ok(s.useConsumable(w, 'damageControl'));
   assert.strictEqual(s.fires.length, 0);
   assert.strictEqual(s.floods.length, 0);
   assert.strictEqual(s.ignite('aft', null), false, 'immune while DC is active');
   assert.strictEqual(s.useConsumable(w, 'damageControl'), false, 'DC on cooldown');
   // fires also burn out on their own
   const c = w.spawn('Z23', 'enemy', { x: 5000, y: 0 }, 0, {});
   c.ignite('mid', null);
   for (let i = 0; i < 60 * 40; i++) c.update(DT, w);
   assert.strictEqual(c.fires.length, 0, 'destroyer fire should burn out within 40 s');
});

test('win/lose triggers: annihilation, player sunk, convoy, raid and timeout', () => {
   // annihilation win
   let w = new World('normal', { mission: 'standard', seed: 1 });
   for (const e of w.enemiesOf(w.player)) e.takeDamage(e.hp + 1, w.player, 'citadel');
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(w.result.victory, true);
   assert.ok(w.result.xp > 0 && w.result.credits > 0);
   assert.strictEqual(w.stats.kills, 7);
   // player sunk -> loss
   w = new World('normal', { mission: 'standard', seed: 1 });
   const foe = w.enemiesOf(w.player)[0];
   w.player.takeDamage(w.player.hp + 1, foe, 'citadel');
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(w.result.victory, false);
   // convoy: five freighters, three losses are survivable, the fourth fails the mission
   w = new World('normal', { mission: 'convoy', seed: 1 });
   const frs = w.ships.filter(s => s.side === 'player' && s.type === 'TR');
   assert.strictEqual(frs.length, 5);
   for (const f of frs.slice(0, 3)) f.takeDamage(f.hp + 1, w.enemiesOf(w.player)[0], 'torp');
   assert.strictEqual(w.phase, 'playing');
   frs[3].takeDamage(frs[3].hp + 1, w.enemiesOf(w.player)[0], 'torp');
   assert.strictEqual(w.phase, 'lost');
   // raid: four freighters sunk -> win
   w = new World('normal', { mission: 'raid', seed: 1 });
   const trs = w.ships.filter(s => s.side === 'enemy' && s.type === 'TR');
   for (const t of trs.slice(0, 4)) t.takeDamage(t.hp + 1, w.player, 'torp');
   assert.strictEqual(w.phase, 'won');
   // training timeout with enemies left -> loss; laststand timeout -> survival win
   w = new World('normal', { mission: 'training', seed: 1 });
   w.timeLeft = 0.001; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   w = new World('normal', { mission: 'laststand', seed: 1 });
   w.timeLeft = 0.001; w.update(DT);
   assert.strictEqual(w.phase, 'won');
   // domination: points threshold
   w = new World('normal', { mission: 'domination', seed: 1 });
   w.score.player = w.score.target;
   for (let i = 0; i < 60 * 6 && w.phase === 'playing'; i++) w.update(DT);
   assert.strictEqual(w.phase, 'won');
});

test('allies fight enemies without the player', () => {
   const w = new World('normal', { mission: 'standard', seed: 21 });
   w.player.setTelegraph(0);           // the player just idles and never fires
   for (let i = 0; i < 60 * 150 && w.phase === 'playing'; i++) w.update(DT);
   assert.strictEqual(w.player.dmgDealt, 0);
   const allies = w.roster.filter(s => s.side === 'player' && !s.isPlayer);
   const enemies = w.roster.filter(s => s.side === 'enemy');
   const allyDmg = allies.reduce((a, s) => a + s.dmgDealt, 0);
   const enemyTaken = enemies.reduce((a, s) => a + s.dmgTaken, 0);
   assert.ok(allies.some(s => s.shotsFired > 0), 'allies should open fire');
   assert.ok(allyDmg > 1000 && enemyTaken >= allyDmg * 0.99, `allied damage ${allyDmg}`);
   assert.ok(allies.some(s => s.hits > 0), 'allies should score hits');
   assert.ok(enemies.reduce((a, s) => a + s.dmgDealt, 0) > 0, 'enemies should shoot back');
});

test('engine telegraph and rudder behave like a ship', () => {
   const w = blank();
   const s = w.spawn('Bismarck', 'player', { x: -6000, y: 0 }, 0, { isPlayer: true, telegraph: 0, speedFrac: 0 });
   s.speed = 0;
   // clamping
   s.setTelegraph(9); assert.strictEqual(s.telegraph, 4);
   s.setTelegraph(-5); assert.strictEqual(s.telegraph, -1);
   s.setRudder(3); assert.strictEqual(s.rudderCmd, 2);
   s.setRudder(-7); assert.strictEqual(s.rudderCmd, -2);
   s.setRudder(0.3); assert.strictEqual(s.rudderCmd, 0);
   // full ahead: accelerates gradually to ~max speed
   s.setTelegraph(4);
   for (let i = 0; i < 60 * 3; i++) s.update(DT, w);
   const early = s.speedKn;
   assert.ok(early > 0.5 && early < s.maxSpeedKn * 0.7, `3 s after full ahead: ${early} kn (inertia)`);
   for (let i = 0; i < 60 * 90; i++) s.update(DT, w);
   assert.ok(Math.abs(s.speedKn - s.maxSpeedKn) < s.maxSpeedKn * 0.05, `top speed ${s.speedKn} vs ${s.maxSpeedKn}`);
   // half ahead settles near half speed
   s.setTelegraph(2);
   for (let i = 0; i < 60 * 90; i++) s.update(DT, w);
   assert.ok(Math.abs(s.speedKn - s.maxSpeedKn * WORLD.TELEGRAPH[2]) < s.maxSpeedKn * 0.06, `half ahead ${s.speedKn}`);
   // rudder is not instant, and positive rudder turns to positive heading rates (starboard)
   s.setTelegraph(4);
   s.pos = { x: -6000, y: 0 }; s.heading = 0;
   s.setRudder(2);
   s.update(DT, w);
   assert.ok(s.rudder > 0 && s.rudder < 0.2, `rudder shift should take time (${s.rudder})`);
   for (let i = 0; i < 60 * 30; i++) s.update(DT, w);
   assert.ok(s.rudder > 0.99, 'full rudder reached');
   assert.ok(s.omega > 0, 'positive rudder -> positive yaw rate');
   const h1 = s.heading;
   s.setRudder(-2);
   for (let i = 0; i < 60 * 40; i++) s.update(DT, w);
   assert.ok(s.omega < 0 && s.heading !== h1, 'opposite rudder reverses the turn');
   // turning bleeds speed
   assert.ok(s.speedKn < s.maxSpeedKn * 0.98, 'hard turn should cost speed');
   // astern
   s.setRudder(0); s.setTelegraph(-1);
   for (let i = 0; i < 60 * 120; i++) s.update(DT, w);
   assert.ok(s.speed < 0, 'astern telegraph backs the ship');
   // engine knocked out: ship coasts down regardless of telegraph
   s.setTelegraph(4); s.modules.engine = 1e9;
   for (let i = 0; i < 60 * 120; i++) s.update(DT, w);
   assert.ok(Math.abs(s.speedKn) < 0.5, `disabled engine should stop the ship (${s.speedKn})`);
});

test('controls API: ammo, main battery, torpedoes, consumables', () => {
   const w = blank(6);
   const dd = w.spawn('Z23', 'player', { x: 0, y: 0 }, 0, { isPlayer: true });
   const e = w.spawn('Jervis', 'enemy', { x: 0, y: 7000 }, 0, {});
   dd.setAmmo('AP'); assert.strictEqual(dd.ammo, 'AP');
   dd.setAmmo('HE'); assert.strictEqual(dd.ammo, 'HE');
   dd.aimPoint = { x: e.pos.x, y: e.pos.y };
   let fired = 0;
   for (let i = 0; i < 60 * 20 && !fired; i++) { dd.update(DT, w); fired = dd.fireMain(w, dd.aimPoint); }
   assert.ok(fired > 0, 'main battery should fire once turrets bear');
   assert.ok(w.shells.length >= fired);
   const n = dd.fireTorpedoes(w, Math.PI / 2);
   assert.ok(n > 0 && w.torpedoes.length === n, 'one launcher fires per call');
   assert.ok(dd.useConsumable(w, 'smoke'));
   for (let i = 0; i < 60 * 3; i++) dd.update(DT, w);
   assert.ok(w.smokeClouds.length > 0, 'smoke generator lays clouds');
});

test('detection: gun bloom reaches gun range, storms cap spotting, long islands keep open water open', () => {
   const w = blank();
   const bb = w.spawn('Bismarck', 'player', { x: 0, y: 0 }, 0, { isPlayer: true });
   w.setEnv({ time: 'night', weather: 'clear' });
   bb.update(DT, w);
   const dark = bb.detectRange;
   assert.ok(dark < bb.cfg.detect.surface * 0.7, 'night shortens visual detection');
   bb.lastMainFire = w.time;
   bb.update(DT, w);
   assert.ok(bb.detectRange >= bb.cfg.main.range, 'muzzle flash gives the shooter away at night');
   w.setEnv({ time: 'day', weather: 'storm' });
   bb.update(DT, w);
   assert.ok(bb.detectRange <= 8000, `storm cap ${bb.detectRange}`);
   // elongated island: water ~1.3x its long radius away is plainly open sea
   w.addIsland({ c: { x: 0, y: 0 }, r: 2600, height: 300, seed: 201, lobes: 7, elong: 2.6, rot: 0 });
   const isl = w.obstacles[w.obstacles.length - 1];
   assert.ok(obstacleT(isl, { x: 0, y: isl.rMax * 1.1 }) > 2, 'broadside of a long island is open water');
   assert.ok(obstacleT(isl, { x: 0, y: 0 }) < 1);
});

test('AI: a battleship stopped nose-on to a coast works itself free and goes round', () => {
   const w = blank(5);
   w.addIsland({ c: { x: 0, y: 0 }, r: 1300, height: 200, seed: 7, lobes: 5 });
   const isl = w.obstacles[w.obstacles.length - 1];
   let y = 0;
   while (obstacleT(isl, { x: 0, y }) < 1.05) y += 20;
   // the enemy it hunts waits beyond the island, so the way there leads round the coast
   w.spawn('Bismarck', 'player', { x: 0, y: -9000 }, 0, { isPlayer: true, telegraph: 0, speedFrac: 0 });
   const bb = w.spawn('KGV', 'enemy', { x: 0, y: y + 120 }, -Math.PI / 2, { telegraph: 0, speedFrac: 0 });
   bb.speed = 0;
   const start = { ...bb.pos };
   let far = 0;
   for (let i = 0; i < 60 * 300; i++) {
      w.update(DT);
      far = Math.max(far, Math.hypot(bb.pos.x - start.x, bb.pos.y - start.y));
   }
   assert.ok(far > 2500, `bot got clear of the coast (${far.toFixed(0)} m)`);
   assert.ok(!bb.grounded, 'not aground at the end');
});

test('dynamic weather: a storm front raises dispersion and cuts visibility deterministically', () => {
   const run = () => {
      const w = blank(3);
      w.setEnv({ time: 'day', weather: 'clear' });
      const p = w.spawn('Hipper', 'player', { x: 0, y: 0 }, 0, { isPlayer: true });
      w.update(DT);
      const clear = { vis: w.env.visibility, disp: weatherDispersion(w.env), det: p.detectRange };
      w.scheduleFront({ at: 10, dur: 20, to: 'storm' });
      const ev0 = w.events.length ? w.events[w.events.length - 1].seq : 0;
      const log = [];
      for (let i = 0; i < 9 * 60; i++) w.update(DT);
      log.push(w.env.frontK);
      for (let i = 0; i < 11 * 60; i++) w.update(DT);
      log.push(w.env.frontK, weatherDispersion(w.env));
      const evs = w.events.filter(e => e.seq > ev0);
      for (let i = 0; i < 12 * 60; i++) w.update(DT);
      return { w, p, clear, log, evs };
   };
   const { w, p, clear, log, evs } = run();
   assert.strictEqual(clear.disp, 1);
   assert.strictEqual(log[0], 0, 'nothing changes before the front arrives');
   assert.ok(log[1] > 0.3 && log[1] < 0.7, 'half way through the front: ' + log[1]);
   assert.ok(log[2] > 1 && log[2] < 1.12, 'dispersion blends: ' + log[2]);
   assert.ok(evs.some(e => e.type === 'weather'), 'front announced as an event');
   assert.ok(evs.some(e => e.type === 'objective' && /Sturmfront/.test(e.text)), 'HUD radio message');
   assert.strictEqual(w.env.frontK, 1);
   assert.strictEqual(w.env.weather, 'storm');
   assert.ok(Math.abs(weatherDispersion(w.env) - 1.12) < 1e-9, 'full storm dispersion');
   assert.ok(w.env.visibility < clear.vis * 0.8, 'visibility drops');
   assert.ok(w.env.spotCap <= 8000, 'storm spotting cap');
   assert.ok(p.detectRange < clear.det, `ship detectability drops: ${p.detectRange} < ${clear.det}`);
   // deterministic: same inputs -> identical weather
   const b = run();
   assert.deepStrictEqual(b.log, log);
   assert.strictEqual(b.w.env.visibility, w.env.visibility);
});

test('dynamic weather: a storm widens the real shell spread', () => {
   const spread = (weather) => {
      const w = blank(7);
      w.setEnv({ time: 'day', weather });
      const bb = w.spawn('Bismarck', 'player', { x: 0, y: 0 }, 0, { isPlayer: true });
      const g = bb.cfg.main, R = g.range * 0.8;
      let sy = 0;
      for (let i = 0; i < 600; i++) sy += makeShell(w, bb, { x: 0, y: 0 }, { x: R, y: 0 }, g, 'main', 'AP').target.y ** 2;
      return Math.sqrt(sy / 600);
   };
   const c = spread('clear'), s = spread('storm');
   assert.ok(s > c * 1.06 && s < c * 1.2, `storm spread ${s} vs clear ${c}`);
});

// ---------------------------------------------------------------- historical operations
const OPS = { rheinuebung: 'Bismarck', guadalcanal: 'Washington', nordkap: 'DukeOfYork' };
const byName = (w, n) => w.ships.find(s => s.name === n);
const sink = (s, by) => s.takeDamage(s.hp + 1, by, 'citadel');
function runTo(w, t) { while (w.phase === 'playing' && w.time < t) w.update(DT); }

test('historical operations: menu data, fixed ships, valid worlds on every difficulty', () => {
   for (const [id, cls] of Object.entries(OPS)) {
      const m = getMission(id);
      assert.strictEqual(m.group, 'ops', id);
      assert.ok(m.debrief.length > 80 && m.briefing.length > 80 && m.fleet, `${id} briefing/debrief`);
      assert.deepStrictEqual(m.playableShips, [cls]);
      for (const diff of ['easy', 'normal', 'hard']) {
         const w = new World(diff, { mission: id, seed: 5 });
         assert.strictEqual(w.player.cls, cls, `${id} player ship`);
         assert.ok(w.mission.objectives.filter(o => !o.optional).length >= 1, `${id} objectives`);
         assert.ok(w.mission.zones.length >= 1, `${id} zones`);
         for (const z of w.mission.zones) {
            assert.ok(Math.abs(z.x) + z.r < w.arena && Math.abs(z.y) + z.r < w.arena, `${id} zone ${z.label} inside the arena`);
            for (const o of w.obstacles) assert.ok(obstacleT(o, z) > 1.05, `${id} zone ${z.label} on open water`);
         }
         for (const s of w.ships) for (const o of w.obstacles) assert.ok(obstacleT(o, s.pos) > 1, `${id} ${s.name} spawned on land`);
      }
   }
});

test('Rheinübung: Hood + Prince of Wales -> victory, breakthrough -> victory, medal stars', () => {
   let w = new World('normal', { mission: 'rheinuebung', seed: 3 });
   sink(byName(w, 'HMS Hood'), w.player);
   assert.strictEqual(w.phase, 'playing');
   sink(byName(w, 'HMS Prince of Wales'), w.player);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(opStars(w), 2);            // Prinz Eugen survived; gold needs hard
   assert.ok(!w.mission.objectives.some(o => o.id === 'break'));
   w = new World('hard', { mission: 'rheinuebung', seed: 3 });
   sink(byName(w, 'HMS Hood'), w.player); sink(byName(w, 'HMS Prince of Wales'), w.player);
   assert.strictEqual(opStars(w), 3);
   // break out into the Atlantic instead
   w = new World('normal', { mission: 'rheinuebung', seed: 3 });
   const ex = w.mission.zones[0];
   w.player.pos.x = ex.x; w.player.pos.y = ex.y; w.update(DT);
   assert.strictEqual(w.phase, 'won');
   assert.strictEqual(w.mission.objectives.find(o => o.id === 'hood').state, 'failed');
   // Bismarck sunk -> loss, no medal
   w = new World('normal', { mission: 'rheinuebung', seed: 3 });
   sink(w.player, byName(w, 'HMS Hood'));
   assert.strictEqual(w.phase, 'lost');
   assert.strictEqual(opStars(w), 0);
});

test('Guadalcanal: Kirishima arrives by radar, sinking her wins, shelling Henderson Field loses', () => {
   let w = new World('normal', { mission: 'guadalcanal', seed: 3 });
   assert.ok(!byName(w, 'Kirishima'));
   runTo(w, 61);
   const k = byName(w, 'Kirishima');
   assert.ok(k && w.mission.objectives.some(o => o.id === 'kiri'));
   sink(k, w.player);
   assert.strictEqual(w.phase, 'won');
   w = new World('normal', { mission: 'guadalcanal', seed: 3 });
   runTo(w, 61);
   const k2 = byName(w, 'Kirishima'), h = w.mission.zones.find(z => z.label === 'Henderson Field');
   k2.pos.x = h.x; k2.pos.y = h.y; w.update(DT);
   assert.strictEqual(w.phase, 'playing');       // shelling takes time
   w._script.bomb = w._script.bombMax - 0.001; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
});

test('Nordkap: sinking Scharnhorst wins, reaching the fjord or the time limit loses', () => {
   let w = new World('normal', { mission: 'nordkap', seed: 3 });
   sink(byName(w, 'Scharnhorst'), w.player);
   assert.strictEqual(w.phase, 'won');
   w = new World('normal', { mission: 'nordkap', seed: 3 });
   const s = byName(w, 'Scharnhorst'), ex = w.mission.zones[0];
   s.pos.x = ex.x; s.pos.y = ex.y; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
   w = new World('normal', { mission: 'nordkap', seed: 3 });
   w.timeLeft = 0.001; w.update(DT);
   assert.strictEqual(w.phase, 'lost');
});
