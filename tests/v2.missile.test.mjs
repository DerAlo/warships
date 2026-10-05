// V2 missiles and ship defences: launch rules, flight, seeker, decoys, SAM channels, doctrine,
// CIWS, cruise missiles, rockets, fighters' AAMs, the command kinds.
import { test } from 'node:test';
import assert from 'node:assert';
import { emptySea, put, island, run } from './v2.util.mjs';
import { SHIPS, MISSILES, DEFENCE } from '../gamev2/config.js';
import { launchSSM, ssmBlock, launchCruise, fireRockets, rocketState, setDoctrine, setPriorityTarget, deployDecoys,
   inbound, threatsTo, samStatus, samInterval, selectSsm, ssmType } from '../gamev2/missile.js';
import { setRadar } from '../gamev2/sensors.js';
import { execAction } from '../gamev2/net/command.js';
import { launchSquadron } from '../gamev2/air.js';

const still = { ai: { passive: true, anchored: true } };
const ev = (w, type) => w.events.filter(e => e.type === type);
// A launcher that is not a ship (no defences, no AI): only rounds of one type.
const launcher = (type, x, y, side = 'enemy') => ({ id: 900000, side, pos: { x, y }, alive: true, cfg: { weapons: { ssm: [{ type }] } }, mag: { [type]: 99 }, lastSsmFire: -999, dmgMult: 1 });
const track = (T) => { T.detected = T.targetable = true; };
function withDefence(over, fn) {
   const old = { ...DEFENCE };
   Object.assign(DEFENCE, over);
   try { return fn(); } finally { Object.assign(DEFENCE, old); }
}

test('launch rules: fire-control track, range, magazine, launch interval', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const p = w.player;
   const foe = put(w, 'Typ022', 'enemy', 15000, 0, Math.PI, still);
   foe.detected = true; foe.targetable = false;
   assert.strictEqual(ssmBlock(w, p, { targetId: foe.id }), 'notrack');
   assert.strictEqual(launchSSM(w, p, { targetId: foe.id }), null);
   track(foe);
   const n0 = p.mag.harpoon;
   const m = launchSSM(w, p, { targetId: foe.id });
   assert.ok(m && m.kind === 'ssm' && m.type === 'harpoon' && m.target === foe.id && m.ownerId === p.id);
   assert.strictEqual(p.mag.harpoon, n0 - 1);
   assert.strictEqual(p.stats.ssmFired, 1);
   assert.strictEqual(ev(w, 'ssmLaunch').length, 1);
   assert.strictEqual(ssmBlock(w, p, { targetId: foe.id }), 'reload');
   run(w, DEFENCE.launchGap + 0.1);
   track(foe);
   assert.strictEqual(ssmBlock(w, p, { targetId: foe.id }), null);
   foe.pos.x = MISSILES.harpoon.range + 2000;
   assert.strictEqual(ssmBlock(w, p, { targetId: foe.id }), 'range');
   p.mag.harpoon = 0;
   assert.strictEqual(ssmBlock(w, p, { bearing: 0 }), 'empty');
   assert.strictEqual(ssmBlock(w, put(w, 'Ford', 'player', 0, 5000, 0, still), { bearing: 0 }), 'none');
});

test('an anti-ship missile flies sea-skimming to a ship without defences and hits it', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const foe = put(w, 'Tanker', 'enemy', 14000, 0, Math.PI / 2, still);
   track(foe);
   const hp = foe.hp;
   const m = launchSSM(w, w.player, { targetId: foe.id });
   run(w, 2);
   assert.ok(m.alt < 30 && Math.abs(m.speed - MISSILES.harpoon.speed) < 1);
   run(w, 40, () => m.alive);
   const hit = ev(w, 'missileHit');
   assert.strictEqual(hit.length, 1);
   assert.strictEqual(hit[0].dstId, foe.id);
   assert.ok(foe.hp < hp - 1000, 'the tanker took the warhead');
   assert.strictEqual(w.player.stats.ssmHits, 1);
   assert.ok(w.player.stats.ssmDmg > 1000);
   assert.ok(w.time > 20 && w.time < 45, 'launch to impact ' + w.time.toFixed(1) + ' s');
   assert.strictEqual(w.missiles.length, 0);
});

test('sea-skimmers cannot cross an island, cruise missiles can', () => {
   const w = emptySea({ ship: 'Burke' });
   const foe = put(w, 'Tanker', 'enemy', 14000, 0, Math.PI / 2, still);
   island(w, 7000, 0, 1500, 220);
   track(foe);
   const m = launchSSM(w, w.player, { targetId: foe.id });
   run(w, 40, () => m.alive);
   assert.strictEqual(ev(w, 'missileHit').length, 0);
   assert.strictEqual(ev(w, 'missileLost')[0].reason, 'terrain');
   const c = launchCruise(w, w.player, { x: foe.pos.x, y: foe.pos.y });
   assert.ok(c && c.kind === 'cruise');
   assert.strictEqual(ev(w, 'cruiseLaunch').length, 1);
   run(w, 60, () => c.alive);
   const hit = ev(w, 'missileHit');
   assert.strictEqual(hit.length, 1, 'the cruise missile crossed the island and hit the anchored ship');
   assert.strictEqual(hit[0].kind, 'cruise');
});

test('bearing-only launch: the seeker takes what it finds in its cone, nothing outside', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const inCone = put(w, 'Tanker', 'enemy', 12000, 600, Math.PI / 2, still);
   const m = launchSSM(w, w.player, { bearing: 0 });
   assert.ok(m && m.tk === 'bearing' && m.target == null);
   run(w, 40, () => m.alive);
   assert.strictEqual(ev(w, 'missileHit')[0]?.dstId, inCone.id);
   const w2 = emptySea({ ship: 'Sachsen' });
   put(w2, 'Tanker', 'enemy', 9000, 9000, 0, still);
   const m2 = launchSSM(w2, w2.player, { bearing: 0 });
   run(w2, 70, () => m2.alive);
   assert.strictEqual(ev(w2, 'missileHit').length, 0);
   assert.ok(['nolock', 'fuel'].includes(ev(w2, 'missileLost')[0].reason));
});

test('the seeker prefers the designated target over a bigger neighbour', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const a = put(w, 'Tanker', 'enemy', 13000, 0, Math.PI / 2, still);
   const b = put(w, 'Container', 'enemy', 13000, 900, Math.PI / 2, still);
   track(a);
   const m = launchSSM(w, w.player, { targetId: a.id });
   run(w, 40, () => m.alive);
   assert.strictEqual(ev(w, 'missileHit')[0].dstId, a.id);
   assert.ok(b.hp === b.maxHP);
});

test('decoys seduce a seeker (consumable -> decoy cloud -> seduced, no hit)', () => {
   withDefence({ decoyPk: 1 }, () => {
      const w = emptySea({ ship: 'Typ022' });
      const T = w.player;
      const L = launcher('harpoon', 14000, 0);
      track(T);
      const m = launchSSM(w, L, { targetId: T.id });
      let thrown = false;
      run(w, 40, () => {
         if (!thrown && m.seekerOn) { thrown = true; assert.ok(T.useConsumable(w, 'decoy')); }
         return m.alive;
      });
      assert.ok(thrown);
      assert.strictEqual(ev(w, 'decoy').length, 1);
      assert.strictEqual(ev(w, 'seduced').length, 1);
      assert.strictEqual(ev(w, 'missileHit').length, 0);
      assert.strictEqual(ev(w, 'missileLost')[0].reason, 'seduced');
      assert.strictEqual(T.hp, T.maxHP);
   });
   // a seeker that does not fall for the cloud keeps its target
   withDefence({ decoyPk: 0 }, () => {
      const w = emptySea({ ship: 'Typ022' });
      const L = launcher('harpoon', 14000, 0);
      track(w.player);
      const m = launchSSM(w, L, { targetId: w.player.id });
      deployDecoys(w, w.player);
      run(w, 2);
      run(w, 40, () => { if (m.seekerOn && !w.decoys.length) deployDecoys(w, w.player); return m.alive; });
      assert.strictEqual(ev(w, 'missileHit').length, 1);
   });
});

test('SAMs engage automatically: an alert air-defence ship stops single missiles', () => {
   let fired = 0, down = 0;
   for (let seed = 1; seed <= 6; seed++) {
      const w = emptySea({ ship: 'Sachsen', seed });
      const T = w.player;
      const L = launcher('harpoon', 20000, 0);
      track(T);
      const m = launchSSM(w, L, { targetId: T.id });
      run(w, 60, () => m.alive);
      assert.strictEqual(ev(w, 'missileHit').length, 0, 'seed ' + seed);
      const ic = ev(w, 'intercept');
      assert.strictEqual(ic.length, 1);
      assert.ok(ic[0].by === 'sam' && ic[0].missileId === m.id);
      assert.ok(ev(w, 'vampire').length === 1, 'the incoming missile was announced once');
      assert.ok(ev(w, 'samLaunch').length >= 1);
      fired += T.stats.samFired; down += T.stats.missilesDown;
      const used = SHIPS.Sachsen.weapons.sam.reduce((s, x) => s + x.n - T.mag[x.type], 0);
      assert.strictEqual(used, T.stats.samFired, 'every SAM came out of a magazine');
   }
   assert.strictEqual(down, 6);
   assert.ok(fired >= 6 && fired <= 30);
});

test('shoot-look-shoot and limited channels: never more interceptors in flight than channels', () => {
   const w = emptySea({ ship: 'Braunschweig', seed: 4 });
   const T = w.player;
   T.hp = T.maxHP = 1e9;
   const L = launcher('harpoon', 20000, 0);
   const chN = SHIPS.Braunschweig.weapons.sam.reduce((s, x) => s + x.ch, 0);
   let n = 0, maxFlight = 0, maxPer = 0;
   run(w, 80, () => {
      if (n < 6) { track(T); if (launchSSM(w, L, { targetId: T.id })) n++; }
      const sams = w.missiles.filter(m => m.kind === 'sam');
      maxFlight = Math.max(maxFlight, sams.length);
      for (const m of w.missiles) if (m.kind === 'ssm') maxPer = Math.max(maxPer, m.eng);
      const st = samStatus(T);
      assert.ok(st.layers.every(l => l.busy <= l.ch));
      return n < 6 || w.missiles.length > 0;
   });
   assert.ok(maxFlight >= 1 && maxFlight <= chN, 'in flight ' + maxFlight + ' of ' + chN);
   assert.ok(maxPer <= DEFENCE.salvoClose);
   assert.ok(ev(w, 'missileHit').length >= 1, 'six missiles saturate a corvette');
   assert.ok(ev(w, 'intercept').length >= 1);
   assert.ok(samInterval(T) > samInterval(put(w, 'Daring', 'player', 0, 9000, 0, still)), 'more channels fire faster');
});

test('doctrine: hold fires nothing, self-defence ignores missiles bound for another ship', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const T = w.player;
   assert.ok(setDoctrine(w, T, 'hold'));
   assert.ok(!setDoctrine(w, T, 'nonsense'));
   const L = launcher('harpoon', 16000, 0);
   track(T);
   const m = launchSSM(w, L, { targetId: T.id });
   run(w, 50, () => m.alive);
   assert.strictEqual(ev(w, 'samLaunch').length, 0);
   assert.strictEqual(ev(w, 'missileHit').length, 1);

   for (const [doc, expect] of [['self', false], ['free', true]]) {
      const w2 = emptySea({ ship: 'Sachsen' });
      setDoctrine(w2, w2.player, doc);
      const mate = put(w2, 'Tanker', 'player', 0, 6000, 0, still);
      const L2 = launcher('harpoon', 15000, 6000);
      track(mate);
      const m2 = launchSSM(w2, L2, { targetId: mate.id });
      run(w2, 50, () => m2.alive);
      assert.strictEqual(ev(w2, 'samLaunch').length > 0, expect, doc);
   }
});

test('radar off: only passive (IR) SAMs fire, at short range', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const T = w.player;
   T.hp = T.maxHP = 1e9;
   setRadar(w, T, false);
   const L = launcher('harpoon', 16000, 0);
   track(T);
   const m = launchSSM(w, L, { targetId: T.id });
   run(w, 50, () => m.alive);
   const types = new Set(ev(w, 'samLaunch').map(e => e.mtype));
   assert.ok(!types.has('sm2') && !types.has('essm'), 'radar-guided SAMs stay in their cells');
});

test('priority target: the SAMs take the designated missile first', () => {
   const w = emptySea({ ship: 'Braunschweig', seed: 2 });
   const T = w.player;
   T.hp = T.maxHP = 1e9;
   // two missiles from the same distance on different bearings: without a priority the first one wins the tie
   track(T);
   const a = launchSSM(w, launcher('harpoon', 12000, 0), { targetId: T.id });
   const b = launchSSM(w, launcher('harpoon', 0, 12000), { targetId: T.id });
   assert.ok(a && b);
   setPriorityTarget(w, T, b.id);
   assert.strictEqual(samStatus(T).priority, b.id);
   run(w, 30, () => !ev(w, 'samLaunch').length);
   assert.strictEqual(ev(w, 'samLaunch')[0].dstId, b.id, 'the designated missile is engaged first');
});

test('CIWS is the last layer', () => {
   let by = 0, hits = 0;
   for (let seed = 1; seed <= 12; seed++) {
      const w = emptySea({ ship: 'Kusnezow', seed });
      const T = w.player;
      setDoctrine(w, T, 'hold');
      const L = launcher('harpoon', 14000, 0);
      track(T);
      const m = launchSSM(w, L, { targetId: T.id });
      run(w, 40, () => m.alive);
      by += ev(w, 'intercept').filter(e => e.by === 'ciws').length;
      hits += ev(w, 'missileHit').length;
      assert.strictEqual(ev(w, 'samLaunch').length, 0);
   }
   assert.strictEqual(by + hits, 12);
   assert.ok(by >= 3, 'four gun mounts stop a fair share: ' + by + ' of 12');
});

test('rockets: an unguided salvo with scatter, then a reload', () => {
   const w = emptySea({ ship: 'Boghammar', seed: 3 });
   const p = w.player;
   const foe = put(w, 'Tanker', 'enemy', 1500, 0, Math.PI / 2, still);
   const n = fireRockets(w, p, { x: foe.pos.x, y: foe.pos.y });
   assert.strictEqual(n, SHIPS.Boghammar.weapons.rockets.salvo);
   assert.strictEqual(ev(w, 'rockets').length, 1);
   assert.strictEqual(fireRockets(w, p, { x: foe.pos.x, y: foe.pos.y }), 0, 'reloading');
   assert.ok(rocketState(p).readyT > w.time);
   run(w, 12);
   const hit = ev(w, 'missileHit');
   assert.ok(hit.length >= 1 && hit.length < n, hit.length + ' of ' + n + ' rockets hit a tanker at 1.5 km');
   assert.ok(foe.hp < foe.maxHP);
   assert.strictEqual(w.missiles.length, 0);
});

test('fighters shoot air-to-air missiles at opposing squadrons', () => {
   const w = emptySea({ ship: 'Ford' });
   const foe = put(w, 'Kusnezow', 'enemy', 16000, 0, Math.PI, still);
   setDoctrine(w, foe, 'hold'); setDoctrine(w, w.player, 'hold');
   const mine = launchSquadron(w, w.player, 'ft', { kind: 'patrol', pos: { x: 8000, y: 0 } });
   const theirs = launchSquadron(w, foe, 'tb', { kind: 'patrol', pos: { x: 8000, y: 500 } });
   assert.ok(mine && theirs);
   run(w, 90, () => !ev(w, 'intercept').some(e => e.by === 'aam') && !ev(w, 'aamLaunch').length);
   assert.ok(ev(w, 'aamLaunch').length >= 1, 'an AAM left the rail');
   const n0 = theirs.n;
   run(w, 20);
   assert.ok(ev(w, 'intercept').some(e => e.by === 'aam') || ev(w, 'samMiss').length > 0 || theirs.n <= n0, 'the shot was resolved');
   assert.ok(!w.missiles.some(m => m.kind === 'aam' && m.t > 15), 'no AAM flies on for ever');
});

test('inbound / threatsTo list the tracked missiles for the HUD', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const T = w.player;
   setDoctrine(w, T, 'hold');
   const L = launcher('oniks', 15000, 0);
   track(T);
   launchSSM(w, L, { targetId: T.id });
   run(w, 1);
   assert.strictEqual(inbound(w, 'player').length, 0, 'not yet inside the radar horizon');
   run(w, 9, () => !inbound(w, 'player').length);
   const list = threatsTo(w, T);
   assert.strictEqual(list.length, 1);
   assert.ok(list[0].supersonic && list[0].targetId === T.id && list[0].tti > 0 && list[0].tti < 15 && list[0].name === MISSILES.oniks.name);
   assert.strictEqual(inbound(w, 'enemy').length, 0);
});

test('command kinds: missile launch, type, doctrine, priority, radar, cruise, rockets', () => {
   const w = emptySea({ ship: 'Burke' });
   const p = w.player;
   const foe = put(w, 'Tanker', 'enemy', 12000, 0, 0, still);
   track(foe);
   assert.strictEqual(execAction(p, w, ['m', foe.id]), true);
   assert.strictEqual(execAction(p, w, ['m', foe.id]), false, 'launch interval');
   assert.strictEqual(execAction(p, w, ['m', 'x']), false);
   run(w, 1.3);
   assert.strictEqual(execAction(p, w, ['b', 0.1]), true);
   run(w, 1.3);
   assert.strictEqual(execAction(p, w, ['k', 9000, 4000]), true);
   assert.strictEqual(w.missiles.filter(m => m.kind === 'cruise').length, 1);
   assert.strictEqual(execAction(p, w, ['K', 12345]), false, 'no such site');
   assert.strictEqual(execAction(p, w, ['D', 'self']), true);
   assert.strictEqual(p.samDoctrine, 'self');
   assert.strictEqual(execAction(p, w, ['D', 'bogus']), false);
   execAction(p, w, ['p', 77]); assert.strictEqual(p.samPriority, 77);
   execAction(p, w, ['p', null]); assert.strictEqual(p.samPriority, null);
   execAction(p, w, ['r', 0]); assert.strictEqual(p.radarOn, false);
   execAction(p, w, ['r', 1]); assert.strictEqual(p.radarOn, true);
   assert.strictEqual(execAction(p, w, ['q', 0]), true);
   assert.strictEqual(ssmType(p), 'harpoon');
   assert.ok(selectSsm(p, 5) && p.ssmSel === 0);
   assert.strictEqual(execAction(p, w, ['o', 500, 0]), 0, 'a destroyer has no rockets');
   const boat = put(w, 'Boghammar', 'player', 0, 3000, 0, still);
   assert.strictEqual(execAction(boat, w, ['o', 1500, 3000]), 12);
   assert.ok(execAction(p, w, ['c', 'decoy']) !== undefined);
});

test('bots: fire a salvo at a tracked enemy, throw decoys when a seeker is heard', () => {
   const w = emptySea({ ship: 'Sachsen', seed: 5 });
   const p = w.player;
   setDoctrine(w, p, 'hold');
   p.hp = p.maxHP = 1e9;
   const bot = put(w, 'Typ054A', 'enemy', 14000, 0, Math.PI);
   run(w, 40, () => ev(w, 'ssmLaunch').length < 2);
   const ls = ev(w, 'ssmLaunch').filter(e => e.srcId === bot.id);
   assert.ok(ls.length >= 2 && ls.every(e => e.dstId === p.id), 'the frigate fires a salvo at the player');
   // now the player shoots back (the bot's SAMs held so the seeker gets to switch on): a decoy cloud answers
   setDoctrine(w, bot, 'hold');
   run(w, 30, () => { if (bot.targetable && !ev(w, 'ssmLaunch').some(e => e.srcId === p.id)) launchSSM(w, p, { targetId: bot.id }); return !ev(w, 'decoy').some(e => e.srcId === bot.id); });
   assert.ok(ev(w, 'ssmLaunch').some(e => e.srcId === p.id));
   assert.ok(ev(w, 'decoy').some(e => e.srcId === bot.id), 'decoys out');
   // a passive bot never launches
   const w2 = emptySea({ ship: 'Sachsen' });
   put(w2, 'Typ054A', 'enemy', 14000, 0, Math.PI, { ai: { passive: true } });
   run(w2, 40);
   assert.strictEqual(ev(w2, 'ssmLaunch').length, 0);
});

test('determinism: the same seed gives the same engagement', () => {
   const once = () => {
      const w = emptySea({ ship: 'Burke', seed: 9 });
      const T = w.player;
      const L = launcher('oniks', 20000, 0);
      let n = 0;
      run(w, 60, () => { if (n < 6) { track(T); if (launchSSM(w, L, { targetId: T.id })) n++; } });
      return w.events.filter(e => /intercept|missileHit|samLaunch/.test(e.type)).map(e => e.type + '@' + e.t.toFixed(3)).join(',') + '|' + T.hp;
   };
   assert.strictEqual(once(), once());
});
