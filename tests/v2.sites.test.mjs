// V2 land positions: placement, damage, the weapons that hit them, what each kind does.
import { test } from 'node:test';
import assert from 'node:assert';
import { emptySea, put, island, run } from './v2.util.mjs';
import { World } from '../gamev2/state.js';
import { MISSILES } from '../gamev2/config.js';
import { obstacleT } from '../gamev2/utils.js';
import { addSite, damageSite, impactOnSites, siteById, SITE_KINDS } from '../gamev2/sites.js';
import { launchCruise, launchSSM, fireRockets, setDoctrine, samStatus } from '../gamev2/missile.js';
import { execAction } from '../gamev2/net/command.js';

const still = { ai: { passive: true, anchored: true } };
const ev = (w, type) => w.events.filter(e => e.type === type);

test('addSite: every kind, plain data, on the coast of its island', () => {
   const w = emptySea({ ship: 'Burke' });
   const isl = island(w, 12000, 0, 1500, 200);
   for (const kind of Object.keys(SITE_KINDS)) {
      const s = addSite(w, kind, 'enemy', { x: 12000, y: 0 });
      assert.ok(s.isSite && s.alive && s.kind === kind && s.side === 'enemy' && s.hp === s.maxHp && s.hp > 0);
      assert.ok(s.pos.x === s.x && s.pos.y === s.y);
      assert.strictEqual(siteById(w, s.id), s);
      const t = obstacleT(isl, s.pos);
      assert.ok(t > 0.9 && t <= 1, kind + ' stands at the shore (t ' + t.toFixed(2) + ')');
   }
   assert.strictEqual(w.sites.length, 6);
   assert.throws(() => addSite(w, 'castle', 'enemy', { x: 0, y: 0 }));
   const inland = addSite(w, 'bunker', 'enemy', { x: 12000, y: 0 }, { inland: true, hp: 100, name: 'Stab' });
   assert.ok(inland.x === 12000 && inland.maxHp === 100 && inland.name === 'Stab');
   JSON.stringify(w.sites.filter(s => s.kind !== 'airfield'));       // plain data
   run(w, 2);
});

test('damageSite: events, destruction, stats and the mission hook', () => {
   const w = emptySea({ ship: 'Burke' });
   const s = addSite(w, 'radar', 'enemy', { x: 5000, y: 0 });
   let hook = null;
   w._script.onSiteDestroyed = (ww, site, by) => { hook = [site.id, by && by.id]; };
   assert.strictEqual(damageSite(w, s, 1000, w.player, 'shell'), 1000);
   assert.strictEqual(s.hp, s.maxHp - 1000);
   assert.strictEqual(ev(w, 'siteHit')[0].dstId, s.id);
   assert.strictEqual(ev(w, 'siteHit')[0].by, 'shell');
   assert.strictEqual(damageSite(w, s, 1e6, w.player, 'cruise'), s.maxHp - 1000);
   assert.ok(!s.alive && s.hp === 0 && !s.radarOn);
   assert.strictEqual(ev(w, 'siteDestroyed').length, 1);
   assert.deepStrictEqual(hook, [s.id, w.player.id]);
   assert.strictEqual(w.player.stats.sitesDown, 1);
   assert.strictEqual(w.player.stats.siteDmg, s.maxHp);
   assert.strictEqual(damageSite(w, s, 500, w.player), 0, 'a destroyed site takes nothing');
   assert.strictEqual(impactOnSites(w, s.pos, 'player', 500, w.player, 'bomb'), null);
});

test('a cruise missile flies over the island and destroys a site (command K)', () => {
   const w = emptySea({ ship: 'Burke' });
   island(w, 14000, 0, 1800, 240);
   const s = addSite(w, 'bunker', 'enemy', { x: 15200, y: 0 }, { hp: 5000 });       // far shore, behind the hill
   assert.ok(s.x > 14000);
   assert.strictEqual(execAction(w.player, w, ['K', s.id]), true);
   const m = w.missiles[0];
   assert.ok(m.kind === 'cruise' && m.target === s.id && m.tk === 'site');
   run(w, 60, () => m.alive);
   assert.ok(!s.alive, 'one Tomahawk for a 5000-hp position');
   assert.strictEqual(ev(w, 'siteHit')[0].by, 'cruise');
   assert.ok(w.time > 20 && w.time < 45);
   // out of range / dead site
   assert.strictEqual(launchCruise(w, w.player, { siteId: s.id }), null);
   assert.strictEqual(launchCruise(w, w.player, { x: MISSILES.tomahawk.range + 5000, y: 0 }), null);
});

test('shells, bombs and rockets that come down on a site damage it', () => {
   const w = emptySea({ ship: 'Boghammar', seed: 5 });
   const s = addSite(w, 'launcher', 'enemy', { x: 1800, y: 0 });
   assert.strictEqual(impactOnSites(w, { x: s.x + 20, y: s.y - 10 }, 'player', 400, w.player, 'shell'), s);
   assert.strictEqual(impactOnSites(w, { x: s.x + s.r + 30, y: s.y }, 'player', 400, w.player, 'shell'), null, 'a miss');
   assert.strictEqual(impactOnSites(w, s.pos, 'enemy', 400, null, 'shell'), null, 'own side');
   const hp = s.hp;
   assert.strictEqual(fireRockets(w, w.player, { x: s.x, y: s.y }), 12);
   run(w, 10);
   assert.ok(s.hp < hp, 'rockets: ' + (hp - s.hp) + ' damage');
   assert.ok(ev(w, 'siteHit').some(e => e.by === 'rocket'));
});

test('main guns: a salvo aimed at a site on the coast hits it', () => {
   const w = emptySea({ ship: 'Burke', seed: 2 });
   island(w, 9000, 0, 1500, 60);
   const s = addSite(w, 'bunker', 'enemy', { x: 7000, y: 0 });
   const p = w.player;
   p.aimPoint = { x: s.x, y: s.y };
   let shots = 0;
   run(w, 90, () => { p.aimPoint = { x: s.x, y: s.y }; shots += p.fireMain(w, p.aimPoint) || 0; });
   assert.ok(shots > 5, shots + ' shells fired');
   assert.ok(ev(w, 'siteHit').some(e => e.by === 'shell'), 'at least one shell came down inside the position');
   assert.ok(s.hp < s.maxHp);
});

test('coastal battery: fires anti-ship missiles at a ship its side tracks, salvo by salvo', () => {
   const w = emptySea({ ship: 'Sachsen', seed: 3 });
   island(w, 13000, 0, 1500, 200);
   const b = addSite(w, 'battery', 'enemy', { x: 11000, y: 0 });
   assert.ok(b.x < 12000, 'on the near shore');
   const n0 = b.mag.noor;
   run(w, 25, () => ev(w, 'ssmLaunch').length < b.salvo);
   const ls = ev(w, 'ssmLaunch');
   assert.strictEqual(ls.length, 2, 'a salvo of two');
   assert.ok(ls.every(e => e.srcId === b.id && e.dstId === w.player.id));
   assert.strictEqual(b.mag.noor, n0 - 2);
   run(w, 45);
   assert.ok(ev(w, 'vampire').length >= 2, 'the frigate sees them coming');
   assert.ok(ev(w, 'intercept').length + ev(w, 'missileHit').length + ev(w, 'missileLost').length >= 2, 'the first salvo is resolved');
   // a destroyed battery is silent
   damageSite(w, b, 1e6, w.player, 'cruise');
   const n = ev(w, 'ssmLaunch').length;
   run(w, 40);
   assert.strictEqual(ev(w, 'ssmLaunch').length, n);
});

test('a battery holds fire without a track (radar off, ship beyond visual range)', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const b = addSite(w, 'battery', 'enemy', { x: 13000, y: 0 }, { radarOn: false });
   w.player.radarOn = false;
   run(w, 30);
   assert.strictEqual(ev(w, 'ssmLaunch').length, 0);
   assert.ok(b.mag.noor === 8);
});

test('radar station: its side sees far while it stands', () => {
   const w = emptySea({ ship: 'Typ022' });
   const r = addSite(w, 'radar', 'enemy', { x: 10000, y: 0 });
   w._updateSpotting();
   assert.ok(w.player.detected, 'the station holds the stealthy boat at 10 km');
   damageSite(w, r, 1e6, null, 'cruise');
   w._updateSpotting();
   assert.ok(!w.player.detected);
});

test('SAM site: shoots down a cruise missile bound for its neighbour', () => {
   let down = 0;
   for (let seed = 1; seed <= 4; seed++) {
      const w = emptySea({ ship: 'Burke', seed });
      const sam = addSite(w, 'sam', 'enemy', { x: 20000, y: 0 });
      const bunker = addSite(w, 'bunker', 'enemy', { x: 20000, y: 700 });
      assert.strictEqual(samStatus(sam).layers[0].ch, 2);
      const m = launchCruise(w, w.player, { siteId: bunker.id });
      run(w, 70, () => m.alive);
      assert.ok(ev(w, 'samLaunch').some(e => e.srcId === sam.id), 'the site fired');
      down += ev(w, 'intercept').length;
      assert.strictEqual(ev(w, 'intercept').length + ev(w, 'siteHit').length, 1);
   }
   assert.ok(down >= 2, down + ' of 4 single missiles stopped');
   // doctrine hold: nothing leaves the rails
   const w = emptySea({ ship: 'Burke' });
   const sam = addSite(w, 'sam', 'enemy', { x: 20000, y: 0 });
   setDoctrine(w, sam, 'hold');
   const m = launchCruise(w, w.player, { siteId: sam.id });
   run(w, 70, () => m.alive);
   assert.strictEqual(ev(w, 'samLaunch').length, 0);
   assert.ok(sam.hp < sam.maxHp);
});

test('airfield: launches a strike at a tracked ship and can be destroyed', () => {
   const w = emptySea({ ship: 'Tanker' });      // falls back to a default ship if not playable
   const f = addSite(w, 'airfield', 'enemy', { x: 15000, y: 0 });
   assert.ok(f.air && f.cfg.air);
   w.player.detected = w.player.targetable = true;
   run(w, 30, () => { w.player.detected = w.player.targetable = true; return !w.squadrons.length; });
   assert.ok(w.squadrons.length >= 1, 'a squadron is in the air');
   assert.strictEqual(w.squadrons[0].side, 'enemy');
   run(w, 60);
   damageSite(w, f, 1e6, w.player, 'cruise');
   const n = w.squadrons.length;
   run(w, 120);
   assert.ok(w.squadrons.length <= n, 'no new launches from a destroyed field');
});

test('training mission: the sandbox has two land positions; a moored ship stays put', () => {
   const w = new World('normal', { mission: 'training', ship: 'Burke', seed: 1 });
   assert.strictEqual(w.sites.length, 2);
   assert.deepStrictEqual(w.sites.map(s => s.kind).sort(), ['bunker', 'radar']);
   const hulk = w.spawn('Container', 'enemy', { x: 9800, y: -4200 }, 1, { telegraph: 0, ai: { passive: true, anchored: true } });
   const p0 = { ...hulk.pos };
   run(w, 20);
   assert.ok(Math.hypot(hulk.pos.x - p0.x, hulk.pos.y - p0.y) < 5, 'the hulk stays at anchor');
   for (const s of w.sites) damageSite(w, s, 1e6, w.player, 'cruise');
   assert.strictEqual(w.mission.objectives.find(o => o.id === 'sites').state, 'done');
   assert.strictEqual(w.phase, 'playing', 'the optional objective does not end the exercise');
});
