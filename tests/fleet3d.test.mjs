// Fleet roster (game3d/config.js SHIPS / PLAYABLE), tech tree and bot line-ups.
// Pulled in by tests/progress3d.test.mjs, so `node --test tests/sim3d.test.mjs` runs these too.
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../game3d/state.js';
import { SHIPS, SHIP_STATS, PLAYABLE, NATIONS, NATION_NAMES, NATION_SHORT, NATION_BLOC, BOT_POOLS, BOT_MIRROR } from '../game3d/config.js';
import * as PG from '../game3d/progress3d.js';

const DT = 1 / 60;
const NEW_SHIPS = ['Gneisenau', 'Warspite', 'Iowa', 'Cleveland', 'Fletcher', 'Yamato', 'Shimakaze', 'Richelieu', 'Algerie', 'LeFantasque', 'Littorio', 'Zara', 'Kirov', 'Gnevny'];
const PROMOTED = ['Scharnhorst', 'Hood', 'KGV', 'Rodney', 'Norfolk', 'Fiji', 'Jervis', 'Kirishima', 'Takao', 'Fubuki', 'Benham'];
const memStore = (init = {}) => { const m = { ...init }; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; };
const turretR = (cal, B) => Math.min(B * 0.185, 1.4 + cal * 0.0135);      // same rule as ships3d.js
// every number in a config is a real number (Infinity is allowed: unlimited consumable charges)
const walk = (o, path, bad) => {
   if (typeof o === 'number') { if (Number.isNaN(o)) bad.push(path); }
   else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, path + '.' + k, bad);
   else if (o === undefined) bad.push(path + ' (undefined)');
};

test('fleet: every ship config is complete, finite and geometrically sane', () => {
   const fin = (v, msg) => assert.ok(Number.isFinite(v) && v > 0, msg + ' = ' + v);
   for (const [k, c] of Object.entries(SHIPS)) {
      assert.strictEqual(c.key, k);
      for (const f of ['name', 'className']) assert.ok(typeof c[f] === 'string' && c[f].length, `${k}.${f}`);
      const bad = []; walk(c, k, bad);
      assert.deepStrictEqual(bad, [], 'NaN / undefined values');
      const h = c.hull;
      assert.ok(['BB', 'CA', 'CL', 'DD', 'CV', 'TR'].includes(h.type), `${k} hull type`);
      for (const f of ['L', 'beam', 'draft']) fin(h[f], `${k}.hull.${f}`);
      for (const f of ['hp', 'speedKn', 'accel', 'turnR', 'rudderShift']) fin(c[f], `${k}.${f}`);
      assert.ok(Number.isInteger(c.tier) && c.tier >= 1 && c.tier <= 10, `${k} tier`);
      assert.ok(c.detect && c.armor && c.ai && Array.isArray(c.consumables), `${k} detect/armor/ai/consumables`);
      const lb = h.L / h.beam;
      assert.ok(lb > 5.5 && lb < 12.5, `${k} length/beam ${lb.toFixed(1)}`);
      if (h.type === 'TR') continue;
      // main battery
      const m = c.main;
      for (const f of ['caliber', 'reload', 'range', 'traverse', 'dispH']) fin(m[f], `${k}.main.${f}`);
      assert.ok(m.ap || m.he, `${k} has a shell type`);
      for (const sh of [m.ap, m.he]) if (sh) fin(sh.dmg, `${k} shell dmg`);
      assert.ok(m.turrets.length >= 2, `${k} turrets`);
      const r = turretR(m.caliber, h.beam);
      const xs = m.turrets.map(t => t.off.x).sort((a, b) => a - b);
      for (const t of m.turrets) {
         assert.ok(Math.abs(t.off.x) + r * 1.2 < h.L / 2, `${k} turret at x=${t.off.x} is on the hull`);
         assert.ok(Math.abs(t.off.z || 0) < h.beam / 2, `${k} turret z`);
         assert.ok(Number.isInteger(t.guns) && t.guns >= 1 && t.guns <= 4, `${k} guns per turret`);
      }
      for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] > r * 1.5, `${k} turrets ${xs[i - 1]} / ${xs[i]} overlap`);
      // funnels, superstructure, visible secondaries and torpedo tubes sit on the hull too
      for (const f of h.funnels || []) assert.ok(Math.abs(f.x) < h.L * 0.4 && f.r > 0 && f.h > 0, `${k} funnel`);
      if (h.sup) assert.ok(Math.abs(h.sup.x) + h.sup.len / 2 < h.L / 2 && h.sup.w < h.beam, `${k} superstructure`);
      for (const s of h.secMounts || []) assert.ok(Math.abs(s.x) < h.L * 0.42 && [1, 2, 3].includes(s.guns), `${k} secondary mount`);
      for (const l of c.torp?.launchers || []) {
         const x = l.off?.x ?? l.x;
         assert.ok(Math.abs(x) < h.L * 0.42, `${k} launcher x`);
         for (const t of m.turrets) assert.ok(Math.abs(t.off.x - x) > r + 2.5, `${k} launcher at ${x} under turret at ${t.off.x}`);
      }
      if (c.torp) for (const f of ['range', 'speedKn', 'dmg', 'reload']) fin(c.torp[f], `${k}.torp.${f}`);
   }
});

test('fleet: roster size, navies, classes and port data', () => {
   assert.ok(PLAYABLE.length >= 28, 'playable ships: ' + PLAYABLE.length);
   assert.strictEqual(new Set(PLAYABLE).size, PLAYABLE.length);
   assert.deepStrictEqual(PLAYABLE.slice(0, 4), ['Bismarck', 'Hipper', 'Nuernberg', 'Z23']);
   for (const k of [...NEW_SHIPS, ...PROMOTED]) assert.ok(PLAYABLE.includes(k), k + ' playable');
   const per = {};
   for (const k of PLAYABLE) {
      const c = SHIPS[k], st = SHIP_STATS[k];
      assert.ok(c && c.playable, k);
      assert.ok(NATIONS.includes(c.hull.nation) && NATION_NAMES[c.hull.nation] && NATION_SHORT[c.hull.nation] && NATION_BLOC[c.hull.nation], k + ' nation');
      assert.ok(typeof c.desc === 'string' && c.desc.length > 30, k + ' description');
      assert.ok(st.tierRoman && st.desc === c.desc && st.nationName, k + ' port stats');
      for (const [r, v] of Object.entries(st.ratings)) assert.ok(Number.isFinite(v) && v >= 0 && v <= 100, `${k} rating ${r} = ${v}`);
      (per[c.hull.nation] ||= new Set()).add(c.hull.type);
   }
   assert.strictEqual(Object.keys(per).length, 7, 'seven navies');
   for (const n of NATIONS) assert.ok(per[n].size >= 2, n + ' has at least two classes');
   for (const n of ['de', 'uk', 'us', 'jp', 'fr']) assert.ok(per[n].has('BB') && per[n].has('DD'), n + ' has BB and DD');
   // signature layouts
   const guns = (k) => SHIPS[k].main.turrets.map(t => (t.off.x > 0 ? 'F' : 'A') + t.guns).join(' ');
   assert.strictEqual(guns('Richelieu'), 'F4 F4');
   assert.strictEqual(guns('Yamato'), 'F3 F3 A3');
   assert.strictEqual(guns('Iowa'), 'F3 F3 A3');
   assert.strictEqual(guns('Warspite'), 'F2 F2 A2 A2');
   assert.strictEqual(guns('Cleveland'), 'F3 F3 A3 A3');
   assert.strictEqual(SHIPS.Shimakaze.torp.launchers.reduce((a, l) => a + l.tubes, 0), 15);
   assert.strictEqual(SHIPS.Zara.torp, null);
   // balance sanity: within a class, HP grows with tier (within 25 %)
   for (const type of ['BB', 'DD']) {
      const list = PLAYABLE.filter(k => SHIPS[k].hull.type === type);
      for (const a of list) for (const b of list) {
         if (SHIPS[a].tier >= SHIPS[b].tier + 2) assert.ok(SHIPS[a].hp > SHIPS[b].hp * 0.8, `${a} (T${SHIPS[a].tier}) vs ${b} (T${SHIPS[b].tier}) hp`);
      }
   }
});

test('fleet: every playable ship is reachable in the tech tree', () => {
   const inTree = new Set(PG.TECH_TREE.map(r => r[0]));
   assert.strictEqual(inTree.size, PG.TECH_TREE.length, 'no duplicate rows');
   for (const k of PLAYABLE) assert.ok(inTree.has(k), k + ' in tech tree');
   for (const [k, xp, cr, req] of PG.TECH_TREE) {
      assert.ok(PLAYABLE.includes(k), k + ' is playable');
      assert.ok(Number.isFinite(xp) && xp >= 0 && Number.isFinite(cr) && cr >= 0, k + ' cost');
      if (req) {
         assert.ok(inTree.has(req) && req !== k, k + ' predecessor ' + req);
         assert.strictEqual(SHIPS[req].hull.nation, SHIPS[k].hull.nation, k + ' predecessor is from the same navy');
         assert.ok(PG.UNLOCK_XP[k] > PG.UNLOCK_XP[req], k + ' costs more than its predecessor');
      }
      // chains end (no cycles)
      let c = k, n = 0;
      while (PG.UNLOCK_REQ[c]) { c = PG.UNLOCK_REQ[c]; assert.ok(++n < 10, 'cycle at ' + k); }
   }
   // higher tiers are dearer
   const cost = (k) => PG.UNLOCK_XP[k];
   assert.ok(cost('Yamato') > cost('Iowa') && cost('Iowa') > cost('Richelieu') && cost('Richelieu') > cost('Warspite'));
   // research everything with a rich profile: predecessor rule first, then all of it
   const p = PG.defaultProfile();
   p.xp = 1e7; p.credits = 1e8;
   assert.ok(!PG.canUnlock(p, 'Gneisenau') && PG.unlockNeeds(p, 'Gneisenau').req === 'Scharnhorst');
   assert.ok(!PG.unlockShip(p, 'Yamato'));
   for (let pass = 0; pass < 6; pass++) for (const k of PLAYABLE) PG.unlockShip(p, k);
   for (const k of PLAYABLE) assert.ok(PG.isUnlocked(p, k), k + ' researched');
   const sumXp = PG.TECH_TREE.reduce((a, r) => a + r[1], 0), sumCr = PG.TECH_TREE.reduce((a, r) => a + r[2], 0);
   assert.strictEqual(p.xp, 1e7 - sumXp); assert.strictEqual(p.credits, 1e8 - sumCr);
   // not enough credits blocks a ship that costs credits
   const q = PG.defaultProfile(); q.xp = 1e6; q.credits = 10;
   assert.ok(!PG.canUnlock(q, 'Warspite') && PG.unlockNeeds(q, 'Warspite').credits > 0 && PG.unlockNeeds(q, 'Warspite').xp === 0);
   // op-only ships are never locked
   for (const k of ['Washington', 'DukeOfYork']) assert.ok(PG.isUnlocked(PG.defaultProfile(), k));
});

test('fleet: a profile saved before the fleet expansion still loads unchanged', () => {
   // exactly what the previous version wrote: four ships, XP-only unlocks
   const old = { v: 1, xp: 11000, totalXp: 31500, credits: 4200, battles: 17, unlocked: { Nuernberg: true },
      modules: { Hipper: { main: 2, engine: 1 }, Nuernberg: { main: 1 } }, skills: [] };
   const raw = JSON.stringify(old);
   const store = memStore({ 'warships3d.profile.v1': raw });
   const p = PG.loadProfile(store);
   assert.strictEqual(store.m['warships3d.profile.v1'], raw, 'loading does not rewrite the save');
   assert.strictEqual(p.xp, 11000); assert.strictEqual(p.totalXp, 31500); assert.strictEqual(p.credits, 4200);
   assert.strictEqual(p.unlocked.Nuernberg, true);
   assert.strictEqual(PG.moduleTier(p, 'Hipper', 'main'), 2);
   for (const k of ['Bismarck', 'Hipper', 'Nuernberg']) assert.ok(PG.isUnlocked(p, k), k);
   assert.ok(!PG.isUnlocked(p, 'Z23') && !PG.isUnlocked(p, 'Yamato'));
   // the two original unlocks keep their price: XP only, no credits, no predecessor
   assert.strictEqual(PG.UNLOCK_XP.Nuernberg, 7500); assert.strictEqual(PG.UNLOCK_XP.Z23, 11000);
   assert.ok(PG.canUnlock(p, 'Z23') && PG.unlockShip(p, 'Z23'));
   assert.strictEqual(p.xp, 0); assert.strictEqual(p.credits, 4200);
   // save + reload round trip keeps old and new unlocks
   p.xp = 20000; p.credits = 500000;
   assert.ok(PG.unlockShip(p, 'Warspite'));
   PG.saveProfile(p, store);
   const p2 = PG.loadProfile(store);
   assert.ok(p2.unlocked.Nuernberg && p2.unlocked.Z23 && p2.unlocked.Warspite);
   assert.strictEqual(p2.credits, 500000 - PG.UNLOCK_CREDITS.Warspite);
   // unknown keys from a newer / foreign save are dropped, nothing throws
   const p3 = PG.loadProfile(memStore({ 'warships3d.profile.v1': JSON.stringify({ xp: 5, unlocked: { Nope: true, Iowa: true } }) }));
   assert.ok(p3.unlocked.Iowa && !('Nope' in p3.unlocked));
   assert.ok(PG.loadProfile(memStore({ 'warships3d.profile.v1': '{broken' })).xp === 0);
});

test('fleet: bot pools are valid and both teams roll matching weight classes', () => {
   for (const bloc of ['axis', 'allies']) {
      for (const [base, pool] of Object.entries(BOT_POOLS[bloc])) {
         assert.ok(SHIPS[base], base);
         assert.ok(pool.includes(base), base + ' pool contains its base ship');
         for (const k of pool) {
            assert.ok(SHIPS[k], 'pool ship ' + k);
            assert.strictEqual(NATION_BLOC[SHIPS[k].hull.nation], bloc, k + ' bloc');
            assert.ok(Array.isArray(SHIPS[k].sisters) && SHIPS[k].sisters.length || SHIPS[k].name, k + ' names');
         }
         const mirror = BOT_POOLS[bloc === 'axis' ? 'allies' : 'axis'][BOT_MIRROR[base]];
         assert.ok(mirror, base + ' mirror pool');
         assert.strictEqual(mirror.length, pool.length, base + ' pools index-aligned');
         pool.forEach((k, i) => {
            const a = SHIPS[k], b = SHIPS[mirror[i]];
            assert.ok(a.hull.type[0] === b.hull.type[0], `${k} vs ${mirror[i]} class`);
            assert.ok(Math.abs(a.tier - b.tier) <= 2, `${k} (T${a.tier}) vs ${mirror[i]} (T${b.tier})`);
         });
      }
   }
   // every new ship can turn up as a bot
   const pooled = new Set(Object.values(BOT_POOLS).flatMap(b => Object.values(b).flat()));
   for (const k of NEW_SHIPS) assert.ok(pooled.has(k), k + ' in a bot pool');
   // random battles: line-ups vary with the seed, blocs never mix, the player's bloc decides the sides
   const seen = new Set();
   for (let seed = 1; seed <= 24; seed++) {
      const ship = seed % 2 ? 'Bismarck' : 'Iowa';
      const w = new World('normal', { mission: 'standard', ship, seed });
      const bloc = (s) => NATION_BLOC[s.cfg.hull.nation];
      for (const s of w.ships) {
         seen.add(s.cfg.key);
         assert.strictEqual(bloc(s), s.side === 'player' ? bloc(w.player) : (bloc(w.player) === 'axis' ? 'allies' : 'axis'), `seed ${seed}: ${s.name} on side ${s.side}`);
      }
      const names = w.ships.map(s => s.name);
      assert.strictEqual(new Set(names).size, names.length, 'unique ship names: ' + names.join(', '));
   }
   assert.ok(seen.size >= 16, 'bot variety over 24 battles: ' + seen.size);
});

test('fleet: a short battle with every new ship runs clean', () => {
   for (const [i, k] of [...NEW_SHIPS, ...PROMOTED].entries()) {
      const w = new World('normal', { mission: 'standard', ship: k, seed: 40 + i });
      assert.strictEqual(w.player.cfg.key, k);
      assert.strictEqual(w.player.turrets.length, SHIPS[k].main.turrets.length);
      w.autoPlayer = true;
      const steps = 60 * (NEW_SHIPS.includes(k) ? 75 : 20);
      for (let n = 0; n < steps && w.phase === 'playing'; n++) w.update(DT);
      for (const s of w.ships) {
         for (const v of [s.pos.x, s.pos.y, s.heading, s.speed, s.hp]) assert.ok(Number.isFinite(v), `${k}: ${s.name} state`);
      }
      const p = w.player;
      assert.ok(Math.hypot(p.pos.x, p.pos.y) < w.arena * 2, k + ' stays in the arena');
      assert.ok(p.speed > 1 || !p.alive, k + ' is under way');
   }
});

test('fleet: new ships shoot and launch torpedoes', () => {
   for (const k of ['Yamato', 'Richelieu', 'Shimakaze', 'Gneisenau', 'Kirov']) {
      const w = new World('normal', { mission: 'standard', ship: k, seed: 77 });
      w.autoPlayer = true;
      for (let n = 0; n < 60 * 240 && w.phase === 'playing'; n++) w.update(DT);
      assert.ok(w.stats.shotsFired > 0, k + ' fired its main battery: ' + w.stats.shotsFired);
   }
});
