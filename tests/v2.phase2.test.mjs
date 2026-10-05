// V2 phase 2: shipboard helicopter, lightweight ASW torpedoes, special-forces teams, scripted
// detonations, and the render fields of the carrier squadrons.
import { test } from 'node:test';
import assert from 'node:assert';
import { emptySea, put, run } from './v2.util.mjs';
import { SHIPS } from '../gamev2/config.js';
import { HELO, sendHelo, recallHelo, heloOf, heloStatus, heloBlock, fireAswTorpedo, aswStatus, aswBlock } from '../gamev2/helo.js';
import { SEAL, addTaskPoint, launchTeam, teamStatus } from '../gamev2/seal.js';
import { addBlast, blastBand } from '../gamev2/blast.js';
import { addSite } from '../gamev2/sites.js';
import { launchSquadron } from '../gamev2/air.js';
import { execAction } from '../gamev2/net/command.js';

const still = { ai: { passive: true, anchored: true } };
const ev = (w, type) => w.events.filter(e => e.type === type);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// an enemy boat, deep and creeping or running
function boat(w, x, y, o = {}) {
   const s = put(w, 'Kilo', 'enemy', x, y, 0, still);
   s.depthTarget = s.depthF = o.depth ?? 2; s.depth = o.depth ?? 2;
   s.hp = s.maxHP = o.hp ?? s.maxHP;
   return s;
}

test('helicopter: command h launches it, it flies to the point and dips', () => {
   const w = emptySea({ ship: 'Burke' });
   const p = w.player;
   assert.strictEqual(heloStatus(w, p).state, 'ready');
   assert.strictEqual(execAction(p, w, ['h', 4000, 1000]), true);
   const h = heloOf(w, p);
   assert.ok(h && w.helos.includes(h));
   assert.strictEqual(h.kind, 'helo'); assert.strictEqual(h.model, 'helo'); assert.strictEqual(h.n, 1);
   assert.strictEqual(ev(w, 'heloLaunch').length, 1);
   assert.strictEqual(p.consumable('helo').charges, SHIPS.Burke.consumables.find(c => c.key === 'helo').charges - 1);
   assert.ok(heloBlock(w, p), 'only one helicopter in the air');
   assert.strictEqual(p.useConsumable(w, 'helo'), false);
   run(w, 90, () => h.state !== 'dip');
   assert.strictEqual(h.state, 'dip');
   assert.ok(dist(h.pos, { x: 4000, y: 1000 }) < 60);
   assert.strictEqual(ev(w, 'heloDip').length, 1);
   // a new point while it is out: no second launch
   assert.strictEqual(execAction(p, w, ['h', 1000, -3000]), true);
   assert.strictEqual(w.helos.length, 1);
   assert.strictEqual(h.state, 'transit');
});

test('helicopter: recall brings it back on deck, the next sortie needs the turn-around', () => {
   const w = emptySea({ ship: 'Burke' });
   const p = w.player;
   sendHelo(w, p, { x: 2500, y: 0 });
   run(w, 20);
   assert.strictEqual(execAction(p, w, ['h']), true);
   assert.strictEqual(heloOf(w, p).state, 'return');
   run(w, 80, () => w.helos.length > 0);
   assert.strictEqual(w.helos.length, 0);
   assert.strictEqual(p.heloOut, null);
   assert.strictEqual(ev(w, 'heloLanded').length, 1);
   assert.strictEqual(heloStatus(w, p).state, 'deck');
   assert.ok(heloStatus(w, p).readyIn > 0);
});

test('helicopter: fuel is limited, it turns home by itself and ditches without a deck', () => {
   const w = emptySea({ ship: 'Burke' });
   const p = w.player;
   const h = sendHelo(w, p, { x: 6000, y: 0 });
   run(w, HELO.fuel + 30, () => w.helos.length > 0);
   assert.strictEqual(ev(w, 'heloLanded').length, 1, 'came home on its own');
   assert.ok(ev(w, 'heloOrder').some(e => e.bingo));
   assert.ok(h.fuel > 0);
   // the deck is gone
   const w2 = emptySea({ ship: 'Burke' });
   const h2 = sendHelo(w2, w2.player, { x: 3000, y: 0 });
   h2.fuel = 20;
   w2.player.heloOut = null; h2.ownerId = 987654;
   run(w2, 30);
   assert.strictEqual(w2.helos.length, 0);
   assert.strictEqual(ev(w2, 'heloLost')[0].reason, 'fuel');
});

test('helicopter: screens ahead when it is launched without a point', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const p = w.player;
   assert.strictEqual(p.useConsumable(w, 'helo'), true);
   const h = heloOf(w, p);
   assert.strictEqual(h.mode, 'screen');
   run(w, 150);
   assert.ok(h.dips >= 2, 'dips, moves on, dips again (' + h.dips + ')');
   assert.ok(h.goal.x > 3000, 'ahead of the bow');
});

test('helicopter: the dipping sonar holds a deep boat and the helicopter drops its torpedoes', () => {
   const w = emptySea({ ship: 'Burke' });
   const p = w.player;
   const s = boat(w, 9000, 500, { hp: 1e9 });
   s.telegraph = 0;
   run(w, 2);
   assert.strictEqual(s.sonarSeen, null, 'far outside the hull sonar');
   const h = sendHelo(w, p, { x: 8200, y: 0 });
   run(w, 200, () => !ev(w, 'torp').length);
   assert.ok(ev(w, 'sonar').some(e => e.helo && e.dstId === s.id));
   assert.ok(ev(w, 'aswTorp').some(e => e.heloId === h.id));
   assert.ok(ev(w, 'torp').some(e => e.dstId === s.id), 'the torpedo found the boat');
   assert.ok(h.torps < HELO.torps && h.armed === h.torps);
});

test('helicopter: an enemy SAM ship shoots it down', () => {
   const w = emptySea({ ship: 'Burke' });
   const p = w.player;
   put(w, 'Typ052D', 'enemy', 16000, 0, Math.PI, still);
   const h = sendHelo(w, p, { x: 11000, y: 0 });
   run(w, 200, () => w.helos.length > 0);
   const lost = ev(w, 'heloLost');
   assert.strictEqual(lost.length, 1);
   assert.strictEqual(lost[0].reason, 'sam');
   assert.strictEqual(h.alive, false);
   assert.strictEqual(p.heloOut, null);
   assert.ok(ev(w, 'samLaunch').some(e => e.dstId === h.id && e.tk === 'squad'));
});

test('lightweight torpedo: needs a contact, homes on the boat, ignores surface ships', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const p = w.player;
   put(w, 'Typ054A', 'enemy', 2500, 600, 0, still);
   assert.ok(aswBlock(w, p));
   assert.strictEqual(fireAswTorpedo(w, p), false, 'no contact');
   const s = boat(w, 1000, -400, { hp: 1e9 });
   run(w, 3);
   assert.ok(s.sonarSeen, 'the hull sonar holds it');
   const n0 = aswStatus(w, p).n;
   assert.strictEqual(aswStatus(w, p).contact, s.id);
   assert.strictEqual(execAction(p, w, ['g']), true);
   assert.strictEqual(aswStatus(w, p).n, n0 - 1);
   assert.ok(aswStatus(w, p).reload > 0);
   assert.strictEqual(fireAswTorpedo(w, p), false, 'reloading');
   const t = w.torpedoes.find(x => x.asw);
   assert.ok(t && t.homeId === s.id);
   run(w, 200, () => !ev(w, 'torp').length);
   const hit = ev(w, 'torp');
   assert.strictEqual(hit.length, 1);
   assert.strictEqual(hit[0].dstId, s.id, 'a deep boat is hit, the frigate next to it is not');
});

test('special forces: out, working, done, recovered', () => {
   const w = emptySea({ ship: 'U212' });
   const p = w.player;
   const site = addSite(w, 'radar', 'enemy', { x: 1500, y: 0 }, { inland: true });
   const tp = addTaskPoint(w, { x: 1500, y: 0, kind: 'sabotage', label: 'Radarstation sprengen', workTime: 20, siteId: site.id });
   assert.deepStrictEqual([tp.state, tp.side, w.taskPoints.length], ['open', 'player', 1]);
   assert.strictEqual(teamStatus(w, p).can, true);
   assert.strictEqual(execAction(p, w, ['S']), true);
   const t = w.teams[0];
   assert.strictEqual(t.state, 'out');
   assert.strictEqual(teamStatus(w, p).can, false);
   assert.strictEqual(execAction(p, w, ['S']), false, 'one team');
   const seen = [];
   run(w, 500, () => { if (seen[seen.length - 1] !== t.state) seen.push(t.state); return t.state !== 'recovered' && t.state !== 'lost'; });
   assert.deepStrictEqual(seen, ['out', 'working', 'returning', 'recovered']);
   assert.strictEqual(tp.state, 'done');
   assert.strictEqual(site.alive, false, 'the sabotage point took its site with it');
   for (const k of ['teamOut', 'teamWork', 'teamDone', 'teamRecovered']) assert.strictEqual(ev(w, k).length, 1, k);
   assert.strictEqual(ev(w, 'teamDone')[0].taskId, tp.id);
   assert.strictEqual(p.teamOut, null);
   assert.strictEqual(teamStatus(w, p).left, 0);
});

test('special forces: conditions to launch, and the ways to lose the team', () => {
   const w = emptySea({ ship: 'U212' });
   const p = w.player;
   assert.strictEqual(launchTeam(w, p), null, 'no task point');
   const far = addTaskPoint(w, { x: SEAL.range + 800, y: 0, label: 'fern' });
   assert.match(teamStatus(w, p).why, /zu weit/);
   far.x = far.pos.x = 1200;
   p.depth = p.depthF = p.depthTarget = 2;
   assert.match(teamStatus(w, p).why, /tief/);
   p.depth = p.depthF = p.depthTarget = 1;
   assert.ok(launchTeam(w, p), 'periscope depth is fine');
   // an enemy ship sits on the point
   put(w, 'Typ022', 'enemy', 1200, 200, 0, still);
   run(w, 200, () => w.teams[0].state !== 'lost');
   assert.strictEqual(ev(w, 'teamLost')[0].reason, 'spotted');
   assert.strictEqual(far.state, 'open', 'the point can be tried again');
   // the boat leaves: nobody picks the team up
   const w2 = emptySea({ ship: 'U212' });
   addTaskPoint(w2, { x: 800, y: 0, workTime: 5 });
   const t2 = launchTeam(w2, w2.player);
   run(w2, 200, () => t2.state !== 'returning');
   w2.player.pos.x = -30000;
   run(w2, SEAL.endurance + 20, () => t2.state === 'returning');
   assert.strictEqual(t2.state, 'lost'); assert.strictEqual(t2.reason, 'stranded');
   // surface ships carry no team
   const w3 = emptySea({ ship: 'Burke' });
   addTaskPoint(w3, { x: 500, y: 0 });
   assert.strictEqual(execAction(w3.player, w3, ['S']), false);
});

test('blast: three bands, applied once, to ships, sites and aircraft', () => {
   const w = emptySea({ ship: 'Burke' });
   const p = w.player;
   p.pos.x = -20000;
   const a = put(w, 'Typ054A', 'enemy', 500, 0, 0, still), b = put(w, 'Typ054A', 'enemy', 2500, 0, 0, still),
      c = put(w, 'Typ054A', 'enemy', 5000, 0, 0, still), d = put(w, 'Typ054A', 'enemy', 9000, 0, 0, still);
   const s1 = addSite(w, 'bunker', 'enemy', { x: 0, y: 800 }, { inland: true }), s2 = addSite(w, 'bunker', 'enemy', { x: 0, y: 5200 }, { inland: true });
   const cv = put(w, 'Shandong', 'enemy', 2000, 14000, 0, still);
   const sq = launchSquadron(w, cv, 'ft', { kind: 'patrol', pos: { x: 0, y: 2000 } });
   run(w, 6);
   sq.pos.x = 0; sq.pos.y = 2000;
   const bl = addBlast(w, { x: 0, y: 0, r: { destroyed: 1000, heavy: 3000, shock: 6000 }, delay: 5, label: 'Munitionslager explodiert' });
   assert.strictEqual(bl.state, 'armed');
   assert.deepStrictEqual([blastBand(bl, a.pos), blastBand(bl, b.pos), blastBand(bl, c.pos), blastBand(bl, d.pos)], [3, 2, 1, 0]);
   run(w, 4);
   assert.ok(a.alive && !ev(w, 'blast').length, 'not before the delay');
   const hpB = b.hp, hpC = c.hp, hpD = d.hp;
   run(w, 2);
   const e = ev(w, 'blast');
   assert.strictEqual(e.length, 1);
   assert.strictEqual(bl.state, 'done');
   assert.strictEqual(a.alive, false);
   assert.ok(b.alive && b.hp < hpB - b.maxHP * 0.5 && b.modules.engine > 0, 'heavy');
   assert.ok(c.alive && c.hp < hpC - c.maxHP * 0.1 && c.hp > hpC - c.maxHP * 0.3 && c.radarOn === false, 'shock');
   assert.strictEqual(d.hp, hpD);
   assert.strictEqual(s1.alive, false); assert.ok(s2.alive && s2.hp < s2.maxHp);
   assert.strictEqual(sq.n, 0, 'the flight inside the heavy radius is gone');
   assert.deepStrictEqual([e[0].hit.ships, e[0].hit.sunk, e[0].hit.sites], [3, 1, 2]);
   assert.ok(e[0].hit.air >= 1);
   assert.deepStrictEqual(e[0].r, { destroyed: 1000, heavy: 3000, shock: 6000 });
   const hp2 = c.hp;
   run(w, 20);
   assert.strictEqual(ev(w, 'blast').length, 1, 'once');
   assert.ok(c.hp >= hp2 - 1 || c.fires.length > 0);
   assert.ok(bl.age > 15);
   // one number is enough
   const b2 = addBlast(w, { x: 0, y: 0, radius: 4000 });
   assert.deepStrictEqual(b2.r, { destroyed: 1000, heavy: 2200, shock: 4000 });
});

test('carrier squadrons carry the render fields: kind, model, nation', () => {
   for (const [cls, strike, fighter, nation] of [['Ford', 'fa18', 'f35', 'us'], ['Kusnezow', 'mig29k', 'su33', 'ru'], ['Shandong', 'j15', 'j15', 'cn']]) {
      const w = emptySea({ ship: cls });
      const a = launchSquadron(w, w.player, 'tb', null, true);
      assert.deepStrictEqual([a.kind, a.model, a.nation], ['strike', strike, nation], cls);
      run(w, 30);
      const f = launchSquadron(w, w.player, 'ft', { kind: 'patrol', pos: { x: 3000, y: 0 } });
      assert.ok(f, cls + ' fighters');
      assert.strictEqual(f.kind, 'fighter');
      assert.ok(f.model === fighter || f.model === null, cls + ' ' + f.model);
   }
});
