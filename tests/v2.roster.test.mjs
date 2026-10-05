// V2 (modern mode): roster, config and the two base missions. Run: node --test tests/v2.roster.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../gamev2/state.js';
import { SHIPS, SHIP_STATS, PLAYABLE, PLAYABLE_EAST, NEUTRAL_SHIPS, BOT_POOLS, BOT_SUBS, BOT_CVS, MISSILES, CIWS, CONSUMABLES,
   CLASS_NAMES, NATIONS, NATION_BLOC, shipStats } from '../gamev2/config.js';
import { MISSIONS, MISSION_IDS, getMission } from '../gamev2/missions.js';
import { isUnlocked, defaultProfile } from '../gamev2/progress3d.js';

// the spec roster: key -> [class, nation, model]
const ROSTER = {
   Braunschweig: ['CO', 'de', 'k130'], Sachsen: ['FF', 'de', 'f124'], Burke: ['DD', 'us', 'burke'], Ticonderoga: ['CG', 'us', 'tico'],
   Daring: ['DD', 'uk', 'type45'], Ford: ['CV', 'us', 'ford'], U212: ['SS', 'de', 'u212'], Virginia: ['SS', 'us', 'virginia'],
   BuyanM: ['CO', 'ru', 'buyan'], Gorschkow: ['FF', 'ru', 'gorshkov'], Slawa: ['CG', 'ru', 'slava'], PjotrWeliki: ['CG', 'ru', 'kirovn'],
   Kusnezow: ['CV', 'ru', 'kuznetsov'], Kilo: ['SS', 'ru', 'kilo'], Typ022: ['FAC', 'cn', 'type022'], Typ054A: ['FF', 'cn', 'type054'],
   Typ052D: ['DD', 'cn', 'type052d'], Typ055: ['CG', 'cn', 'type055'], Shandong: ['CV', 'cn', 'shandong'], Yuan: ['SS', 'cn', 'yuan'],
   Boghammar: ['FAC', 'ir', 'fac'], Mowdsch: ['FF', 'ir', 'moudge'], Ghadir: ['SS', 'ir', 'ghadir'],
   Tanker: ['TR', 'nt', 'tanker'], Container: ['TR', 'nt', 'container'], LNG: ['TR', 'nt', 'lng'],
};

test('roster: every spec ship exists with class, nation, bloc and model', () => {
   assert.deepStrictEqual(Object.keys(SHIPS).sort(), Object.keys(ROSTER).sort());
   for (const [key, [type, nation, model]] of Object.entries(ROSTER)) {
      const c = SHIPS[key];
      assert.strictEqual(c.key, key);
      assert.strictEqual(c.hull.type, type, key);
      assert.strictEqual(c.hull.nation, nation, key);
      assert.strictEqual(c.model, model, key);
      assert.strictEqual(c.bloc, NATION_BLOC[nation], key);
      assert.ok(CLASS_NAMES[type], key);
   }
   assert.deepStrictEqual(PLAYABLE.map(k => SHIPS[k].bloc), PLAYABLE.map(() => 'west'));
   assert.ok(PLAYABLE_EAST.every(k => SHIPS[k].bloc === 'east'));
   assert.ok(NEUTRAL_SHIPS.every(k => SHIPS[k].bloc === 'neutral'));
   assert.deepStrictEqual(NATIONS, ['de', 'us', 'uk', 'ru', 'cn', 'ir']);
});

test('roster: plausible hulls, sensors and weapons', () => {
   for (const [key, c] of Object.entries(SHIPS)) {
      assert.ok(c.hull.L > 10 && c.hull.L < 340 && c.hull.beam > 2 && c.hull.beam < 50, key + ' dimensions');
      assert.ok(c.speedKn >= 10 && c.speedKn <= 46 && c.hp > 0 && c.turnR > 0, key + ' mobility');
      assert.ok(c.stealth > 0.1 && c.stealth <= 1.5, key + ' stealth');
      assert.ok(c.detect.surface > 2000, key + ' detect');
      if (c.radar) assert.ok(c.radar.horizon < c.radar.range && c.radar.air >= c.radar.range, key + ' radar');
      const w = c.weapons;
      for (const s of w.ssm) { assert.strictEqual(MISSILES[s.type].kind, 'ssm', key); assert.strictEqual(c.mag[s.type], s.n); }
      for (const s of w.sam) { assert.strictEqual(MISSILES[s.type].kind, 'sam', key); assert.ok(s.ch >= 1 && s.n > 0, key); }
      if (w.cruise) assert.strictEqual(MISSILES[w.cruise.type].kind, 'cruise', key);
      if (w.ciws) assert.ok(CIWS[w.ciws.type], key);
      for (const k of c.consumables) assert.ok(CONSUMABLES[k.key], key + ' consumable ' + k.key);
      if (c.helo) assert.ok(c.consumables.some(k => k.key === 'helo'), key + ' helo consumable');
      if (c.hull.type === 'SS') assert.ok(c.sub && c.torp, key + ' sub');
      if (c.hull.type === 'CV') assert.ok(c.air && MISSILES[c.air.tb.weapon.missile] && MISSILES[c.air.ft.aam.type], key + ' air wing');
      const st = shipStats(key);
      assert.strictEqual(st.model, c.model);
      for (const r of Object.values(st.ratings)) assert.ok(r >= 0 && r <= 100 && Number.isFinite(r), key + ' rating');
      assert.ok(SHIP_STATS[key]);
   }
});

test('roster: the range ladder  gun < point SAM < area SAM < SSM < cruise', () => {
   const of = (f) => Object.values(MISSILES).filter(f).map(m => m.range);
   const guns = Math.max(...Object.values(SHIPS).map(c => c.main.range));
   const point = of(m => m.cls === 'point'), area = of(m => m.cls === 'area');
   const ssm = of(m => m.kind === 'ssm' && m.range > 10000), cruise = of(m => m.kind === 'cruise');
   assert.ok(guns <= Math.max(...point));
   assert.ok(Math.max(...point) < Math.min(...area));
   assert.ok(Math.max(...area) <= Math.min(...ssm));
   assert.ok(Math.max(...ssm) < Math.min(...cruise));
   // flight time over a typical engagement distance is 20-45 s
   for (const m of Object.values(MISSILES)) if (m.kind === 'ssm' && m.range > 10000) {
      const t = 18000 / m.speed;
      assert.ok(t >= 17 && t <= 45, m.name + ' ' + t.toFixed(1));
   }
});

test('roster: bot pools reference existing ships of the right bloc', () => {
   for (const bloc of ['west', 'east']) {
      assert.strictEqual(BOT_POOLS[bloc].length, BOT_POOLS.west.length);
      for (const [pool] of BOT_POOLS[bloc]) for (const k of pool) assert.strictEqual(SHIPS[k].bloc, bloc, k);
      for (const k of BOT_SUBS[bloc]) assert.strictEqual(SHIPS[k].hull.type, 'SS');
      for (const k of BOT_CVS[bloc]) assert.strictEqual(SHIPS[k].hull.type, 'CV');
   }
});

test('progression: every west ship is unlocked in a fresh profile', () => {
   const p = defaultProfile();
   for (const k of PLAYABLE) assert.ok(isUnlocked(p, k), k);
});

test('missions: exactly the two base missions, with menu data', () => {
   assert.deepStrictEqual(MISSION_IDS, ['training', 'standard']);
   assert.strictEqual(getMission('training').name, 'Gefechtsübung');
   assert.strictEqual(getMission('standard').name, 'Begegnungsgefecht');
   for (const m of MISSIONS) {
      assert.deepStrictEqual(m.playableShips, PLAYABLE);
      assert.ok(SHIPS[m.recommendedShip] && m.briefing.length > 40 && m.arena >= 12000);
   }
});

test('missions: both start with every playable ship and run 90 s without throwing', () => {
   for (const id of MISSION_IDS) for (const ship of [...PLAYABLE, 'Slawa', 'Kilo', 'Shandong', 'Boghammar']) {
      const w = new World('normal', { mission: id, ship, seed: 5 });
      assert.strictEqual(w.player.cls, ship, id);
      assert.strictEqual(w.player.side, 'player');
      for (const s of w.ships) assert.ok(Math.abs(s.pos.x) < w.arena && Math.abs(s.pos.y) < w.arena, s.name + ' inside the arena');
      for (let i = 0; i < 90 * 60 && w.phase === 'playing'; i++) w.update(1 / 60);
      for (const s of w.ships) assert.ok(Number.isFinite(s.pos.x) && Number.isFinite(s.hp), s.name + ' finite');
   }
});

test('skirmish: west against east, the player bloc decides the sides, deterministic line-up', () => {
   const names = (w, side) => w.ships.filter(s => s.side === side).map(s => s.cls);
   const a = new World('normal', { mission: 'standard', ship: 'Burke', seed: 11 });
   const b = new World('normal', { mission: 'standard', ship: 'Burke', seed: 11 });
   assert.deepStrictEqual(names(a, 'enemy'), names(b, 'enemy'));
   assert.ok(a.ships.filter(s => s.side === 'player').every(s => s.cfg.bloc === 'west'));
   assert.ok(a.ships.filter(s => s.side === 'enemy').every(s => s.cfg.bloc === 'east'));
   assert.strictEqual(names(a, 'player').length, names(a, 'enemy').length);
   const e = new World('normal', { mission: 'standard', ship: 'Typ052D', seed: 11 });
   assert.ok(e.ships.filter(s => s.side === 'player').every(s => s.cfg.bloc === 'east'));
   assert.ok(e.ships.filter(s => s.side === 'enemy').every(s => s.cfg.bloc === 'west'));
   // a player submarine / carrier meets a counterpart
   const s = new World('normal', { mission: 'standard', ship: 'U212', seed: 2 });
   assert.ok(s.ships.some(x => x.side === 'enemy' && x.type === 'SS'));
   const c = new World('normal', { mission: 'standard', ship: 'Ford', seed: 2 });
   assert.ok(c.ships.some(x => x.side === 'enemy' && x.type === 'CV'));
});

test('training: sinking the three hulks calls the missile boats, sinking those wins', () => {
   const w = new World('normal', { mission: 'training', ship: 'Sachsen', seed: 3 });
   const hulks = w.ships.filter(s => s.side === 'enemy');
   assert.strictEqual(hulks.length, 3);
   for (const h of hulks) h.takeDamage(1e9, w.player, 'he');
   for (let i = 0; i < 20 * 60; i++) w.update(1 / 60);
   const boats = w.ships.filter(s => s.side === 'enemy' && s.alive);
   assert.strictEqual(boats.length, 2);
   assert.ok(boats.every(s => s.cls === 'Typ022'));
   for (const b of boats) b.takeDamage(1e9, w.player, 'he');
   for (let i = 0; i < 60 && w.phase === 'playing'; i++) w.update(1 / 60);
   assert.strictEqual(w.phase, 'won');
});
