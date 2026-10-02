// tests/sub3d.test.mjs — submarines (game3d/submarine.js, ai_sub.js): depth states, battery,
// visibility, hit rules, torpedo gates, depth charges, sonar, bot behaviour, tech tree, mission.
// Run: node --test tests/sub3d.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../game3d/state.js';
import { SHIPS, PLAYABLE, BOT_SUBS, CLASS_NAMES, WORLD } from '../game3d/config.js';
import { makeShell, resolveShells } from '../game3d/combat.js';
import {
   DEPTH, DEPTH_NAMES, orderDepth, diveDeeper, diveUp, dropDepthCharges, hydrophoneContacts, periDepthM,
   PERI_PROX, SUB_BLOOM_T, SUB_TUBE_ARC, DC,
} from '../game3d/submarine.js';
import { TECH_TREE, PROFILE_KEY, defaultProfile, loadProfile, sanitizeProfile, isUnlocked, canUnlock, unlockShip } from '../game3d/progress3d.js';
import { MISSIONS, getMission } from '../game3d/missions.js';

const DT = 1 / 60;
const SUBS = ['U96', 'U505', 'Triton', 'Gato', 'I19', 'S13'];

function blank(seed = 1) {
   const w = new World('normal', { mission: 'standard', seed });
   w.ships = []; w.roster = []; w.bots = []; w._byId.clear(); w.player = null;
   w.obstacles = []; w.caps = []; w.smokeClouds = []; w.shells = []; w.torpedoes = [];
   w._maxTerrainH = 0; w._script = null; w.timeLeft = null;
   w.setEnv({ time: 'day', weather: 'clear' });
   return w;
}
const P = (x, y) => ({ x, y });
// passive ships: the AI keeps its hands off so a single rule can be tested
const still = { passive: true, patrol: [P(0, 0)] };
function run(w, s, fn) { for (let i = 0; i < s * 60; i++) { w.update(DT); if (fn && fn(i) === false) break; } }
function hold(ship) { ship.ai = { _init: true, passive: true, desired: ship.heading, tel: 0, dodged: new Set(), dodgeT: 0, reverseT: 99999, stuckT: 0 }; ship.telegraph = 0; ship.speed = 0; return ship; }

test('submarine class: six boats, playable, complete sub data, in the tech tree', () => {
   assert.strictEqual(CLASS_NAMES.SS, 'U-Boot');
   const nations = new Set();
   for (const k of SUBS) {
      const c = SHIPS[k];
      assert.ok(c && c.hull.type === 'SS' && c.playable && PLAYABLE.includes(k), k);
      assert.ok(c.sub && c.sub.diveT > 2 && c.sub.battery.peri > c.sub.battery.deep && c.sub.periSpeed > c.sub.deepSpeed, k + ' sub block');
      assert.ok(c.torp.launchers.some(l => l.side === 'bow'), k + ' bow tubes');
      assert.ok(c.torp.launchers.every(l => l.side === 'bow' || l.side === 'stern'), k + ' tube sides');
      assert.ok(typeof c.desc === 'string' && c.desc.length > 20, k + ' description');
      assert.ok(c.ai.role === 'ss' && c.ai.prefRange && c.main.range > 0, k + ' ai data');
      const row = TECH_TREE.find(r => (r.key || r[0]) === k);
      assert.ok(row, k + ' in tech tree');
      nations.add(c.hull.nation);
   }
   assert.ok(nations.size >= 4, 'navies: ' + [...nations]);
   for (const side of ['axis', 'allies']) for (const k of BOT_SUBS[side]) assert.ok(SUBS.includes(k));
});

test('old profiles still load and boats are reachable through the tree', () => {
   // a profile saved before the boats existed
   const old = { v: 1, xp: 40000, totalXp: 90000, credits: 600000, battles: 31, unlocked: { Bismarck: true, Hipper: true }, modules: { Hipper: { guns: 2 } }, skills: [] };
   const p = loadProfile({ getItem: (k) => (k === PROFILE_KEY ? JSON.stringify(old) : null), setItem() {} });
   assert.strictEqual(p.xp, 40000); assert.strictEqual(p.credits, 600000); assert.strictEqual(p.battles, 31);
   assert.ok(isUnlocked(p, 'Hipper'));
   for (const k of SUBS) assert.ok(!isUnlocked(p, k), k + ' starts locked');
   assert.ok(!canUnlock(p, 'U505'), 'Typ IX needs Typ VII first');
   assert.ok(unlockShip(p, 'U96'));
   assert.ok(unlockShip(p, 'U505'));
   assert.ok(isUnlocked(p, 'U505') && p.xp === 40000 - 7000 - 15000);
   const again = sanitizeProfile(JSON.parse(JSON.stringify(p)));
   assert.ok(again.unlocked.U96 && again.unlocked.U505);
   assert.deepStrictEqual(defaultProfile().unlocked, {});
});

test('depth states: two keys step through three states, each change takes diveT seconds', () => {
   const w = blank();
   const u = hold(w.spawn('U96', 'player', P(0, 0), 0, { isPlayer: true }));
   w.player = u;
   assert.deepStrictEqual(DEPTH_NAMES, ['Aufgetaucht', 'Sehrohrtiefe', 'Getaucht']);
   assert.strictEqual(u.depth, DEPTH.SURFACE);
   assert.ok(diveDeeper(u, w));
   run(w, u.sub.diveT * 0.4);
   assert.strictEqual(u.depth, 0, 'still on the way down');
   assert.ok(u.depthM > 0 && u.depthM < periDepthM(u.cfg));
   run(w, u.sub.diveT * 0.7);
   assert.strictEqual(u.depth, DEPTH.PERISCOPE);
   assert.ok(Math.abs(u.depthM - periDepthM(u.cfg)) < 0.01);
   assert.ok(diveDeeper(u, w));
   assert.ok(!diveDeeper(u, w), 'no fourth state');
   run(w, u.sub.diveT + 0.5);
   assert.strictEqual(u.depth, DEPTH.DEEP);
   assert.ok(u.depthM > periDepthM(u.cfg) + 15);
   assert.ok(diveUp(u, w)); assert.ok(diveUp(u, w)); assert.ok(!diveUp(u, w));
   run(w, u.sub.diveT * 2 + 0.5);
   assert.strictEqual(u.depth, DEPTH.SURFACE);
   assert.strictEqual(u.depthM, 0);
   assert.ok(w.events.some(e => e.type === 'depth'));
   // a surface ship has no depth to order
   const z = w.spawn('Z23', 'player', P(0, 900), 0, { ai: still });
   assert.ok(!orderDepth(z, 1, w));
   assert.strictEqual(z.depth, 0);
});

test('speed: surfaced > periscope depth > deep', () => {
   const w = blank();
   const u = w.spawn('U96', 'player', P(0, 0), 0, { ai: still });
   const v0 = u.maxSpeed;
   u.depthF = 1; const v1 = u.maxSpeed;
   u.depthF = 2; const v2 = u.maxSpeed;
   assert.ok(v0 > v1 && v1 > v2 && v2 > 0, `${v0} ${v1} ${v2}`);
});

test('battery: drains under water (faster deep), forces the boat up when empty, recharges on the surface', () => {
   const w = blank();
   const u = hold(w.spawn('U96', 'player', P(0, 0), 0, {}));
   orderDepth(u, 1, w);
   run(w, 30);
   const peri = 1 - u.battery;
   assert.ok(peri > 0 && peri < 0.15, 'periscope drain ' + peri);
   orderDepth(u, 2, w);
   run(w, u.sub.diveT + 1);
   const b0 = u.battery;
   run(w, 30);
   assert.ok(b0 - u.battery > peri * 1.8, 'deep drains much faster');
   u.battery = 0.01;
   run(w, 5);
   assert.strictEqual(u.depthTarget, 0, 'forced surfacing');
   assert.ok(w.events.some(e => e.type === 'depth' && e.forced));
   assert.ok(!orderDepth(u, 1, w), 'cannot dive on an empty battery');
   run(w, u.sub.diveT * 2 + 2);
   assert.strictEqual(u.depth, 0);
   const low = u.battery;
   run(w, 30);
   assert.ok(u.battery > low + 0.2, 'recharging');
   assert.ok(orderDepth(u, 1, w), 'can dive again');
});

test('visibility per depth state', () => {
   const w = blank();
   const u = hold(w.spawn('U96', 'player', P(0, 0), 0, {}));
   const far = hold(w.spawn('KGV', 'enemy', P(4000, 0), Math.PI, {}));
   run(w, 1);
   assert.ok(u.detected, 'surfaced boat is seen like a small destroyer');
   assert.ok(u.detectRange > 4000 && u.detectRange < SHIPS.Z23.detect.surface);
   orderDepth(u, 1, w);
   run(w, u.sub.diveT + 1);
   assert.ok(!u.detected, 'periscope depth: unseen at 4 km');
   assert.ok(far.detected, 'the periscope sees');
   assert.ok(u.detectRange > PERI_PROX && u.detectRange <= u.sub.periDetect);
   const near = hold(w.spawn('KGV', 'enemy', P(0, u.detectRange - 200), 0, {}));
   run(w, 1);
   assert.ok(u.detected, 'periscope seen at short range');
   orderDepth(u, 2, w);
   run(w, u.sub.diveT + 1);
   assert.ok(!u.detected, 'deep: never seen');
   assert.strictEqual(u.detectRange, 0);
   assert.ok(!far.detected, 'deep: blind');
   const hc = [];
   far.speed = 10;
   assert.ok(hydrophoneContacts(w, u, hc) >= 1, 'but the hydrophone hears a ship under way');
   assert.ok(Math.abs(hc.find(c => c.id === far.id).brg) < 0.01);
   near.alive = false;
});

test('a torpedo salvo from periscope depth gives the boat away for a while', () => {
   const w = blank();
   const u = hold(w.spawn('U96', 'player', P(0, 0), 0, { depth: 1 }));
   hold(w.spawn('KGV', 'enemy', P(3500, 0), Math.PI, {}));
   run(w, 1);
   assert.ok(!u.detected);
   assert.ok(u.fireTorpedoes(w, 0) > 0);
   run(w, 1);
   assert.ok(u.detected, 'bloom');
   run(w, SUB_BLOOM_T + 1);
   assert.ok(!u.detected, 'bloom over');
});

test('weapons: torpedoes from the surface and periscope depth only, inside the tube arcs; deck gun only surfaced', () => {
   const w = blank();
   const u = hold(w.spawn('U96', 'player', P(0, 0), 0, {}));
   assert.strictEqual(u.fireTorpedoes(w, Math.PI / 2), 0, 'no beam shots from fixed tubes');
   assert.ok(u.torpLauncherFor(SUB_TUBE_ARC * 0.9));
   assert.ok(!u.torpLauncherFor(SUB_TUBE_ARC * 1.3));
   assert.strictEqual(u.fireTorpedoes(w, Math.PI), 1, 'stern tube');
   u.aimPoint = P(3000, 0);
   run(w, 8);
   assert.ok(u.fireMain(w, P(3000, 0)) > 0, 'deck gun surfaced');
   orderDepth(u, 1, w); run(w, u.sub.diveT + 1);
   for (const t of u.turrets) t.reload = 0;
   assert.strictEqual(u.fireMain(w, P(3000, 0)), 0, 'no deck gun under water');
   assert.strictEqual(u.fireTorpedoes(w, 0), 4, 'bow salvo from periscope depth');
   orderDepth(u, 2, w); run(w, u.sub.diveT + 1);
   for (const l of u.torps.launchers) l.reload = 0;
   assert.strictEqual(u.fireTorpedoes(w, 0), 0, 'no torpedoes from deep');
   assert.ok(!u.torpLauncherFor(0));
});

function shellAt(w, shooter, target) {
   const s = makeShell(w, shooter, P(shooter.pos.x, shooter.pos.y), P(target.pos.x, target.pos.y), shooter.cfg.main, 'main', 'HE');
   w.addShell(s);
}
test('hit rules: shells and torpedoes pass a deep boat, hit one at periscope depth (shells for half)', () => {
   const dmgAt = (depth) => {
      const w = blank(7);
      const u = hold(w.spawn('U96', 'player', P(0, 0), Math.PI / 2, { depth }));
      const e = hold(w.spawn('Fiji', 'enemy', P(5000, 0), Math.PI, {}));
      w.addShell = (s) => { s.target = { x: s.target.x, y: s.target.y }; w.shells.push(s); };
      for (let k = 0; k < 40; k++) { const s = makeShell(w, e, P(4950, 0), P((k % 5 - 2) * 3, (k % 7 - 3) * 6), e.cfg.main, 'main', 'HE'); s.target && 0; w.shells.push(s); }
      for (let i = 0; i < 40 * 60 && w.shells.length; i++) resolveShells(w, DT);
      return u.dmgTaken;
   };
   const d0 = dmgAt(0), d1 = dmgAt(1), d2 = dmgAt(2);
   assert.ok(d0 > 0, 'surfaced boat takes shell hits');
   assert.ok(d1 > 0 && d1 < d0 * 0.75, `periscope depth: reduced damage (${d1} vs ${d0})`);
   assert.strictEqual(d2, 0, 'deep: no shell damage');
   const torp = (depth) => {
      const w = blank(3);
      const u = hold(w.spawn('U96', 'player', P(0, 0), Math.PI / 2, { depth }));
      const e = hold(w.spawn('Jervis', 'enemy', P(1500, 0), Math.PI / 2, {}));
      e.fireTorpedoes(w, Math.PI);
      run(w, 60, () => w.torpedoes.length > 0);
      return u.dmgTaken;
   };
   assert.ok(torp(0) > 0, 'torpedo hits a surfaced boat');
   assert.ok(torp(1) > 0, 'torpedo hits at periscope depth');
   assert.strictEqual(torp(2), 0, 'torpedo runs over a deep boat');
});

test('depth charges hit a deep boat, are pooled, and spare surface ships', () => {
   const w = blank(5);
   const u = hold(w.spawn('U96', 'player', P(0, 0), 0, { depth: 2 }));
   const friend = hold(w.spawn('Nuernberg', 'player', P(0, 60), 0, {}));
   const dd = hold(w.spawn('Jervis', 'enemy', P(40, 0), 0, {}));
   assert.ok(dd.asw && friend.asw && !u.asw && !w.spawn('KGV', 'enemy', P(9000, 9000), 0, { ai: still }).asw);
   assert.ok(dropDepthCharges(dd, w));
   assert.ok(!dropDepthCharges(dd, w), 'racks reloading');
   run(w, 6);
   assert.ok(u.dmgTaken > 0, 'deep boat damaged');
   assert.ok(u.alive, 'one pattern does not kill a healthy boat');
   assert.strictEqual(friend.dmgTaken, 0, 'surface ships are not hurt');
   assert.ok(w.events.some(e => e.type === 'depthCharge') && w.events.some(e => e.type === 'dc' && e.dstId === u.id));
   const n = w.depthCharges.length;
   assert.ok(n > 0 && n <= DC.max && w.depthCharges.every(c => !c.alive));
   dd.asw.reload = 0;
   dropDepthCharges(dd, w); run(w, 6);
   assert.strictEqual(w.depthCharges.length, n, 'pool slots are reused');
   assert.ok(u.depth === 2 && !u.detected);
});

test('sonar: a destroyer holds a submerged boat at short range, a battleship only very close; ramming hurts', () => {
   const w = blank(9);
   const u = hold(w.spawn('U96', 'player', P(0, 0), 0, { depth: 2 }));
   const dd = hold(w.spawn('Jervis', 'enemy', P(1100, 0), 0, {}));     // a stopped deep boat is quiet: 3 km sonar shrinks to ~1.3 km
   run(w, 2);
   assert.ok(u.sonarSeen && w.time - u.sonarSeen.t < 1 && w.time - u.pingT < 1, 'destroyer sonar');
   assert.ok(Math.hypot(u.sonarSeen.x, u.sonarSeen.y) < 150, 'contact is close to the boat');
   assert.ok(w.events.some(e => e.type === 'sonar' && e.dstId === u.id));
   assert.ok(!u.detected, 'a sonar contact is no visual detection');
   dd.pos.x = 9000;
   const bb = hold(w.spawn('KGV', 'enemy', P(2000, 0), 0, {}));
   run(w, 10);
   assert.ok(!u.sonarSeen, 'battleship hears nothing at 2 km and the old contact fades');
   // ramming at periscope depth
   bb.pos.x = 9000;
   u.depthTarget = u.depthF = 1; run(w, 0.5);
   dd.pos.x = 0; dd.pos.y = 0; dd.heading = Math.PI / 2; dd.speed = 12;
   const hp = u.hp;
   run(w, 0.3);
   assert.ok(hp - u.hp > u.maxHP * 0.15, 'rammed');
   assert.ok(w.events.some(e => e.type === 'ram'));
   // a deep boat is passed over
   const w2 = blank(9);
   const u2 = hold(w2.spawn('U96', 'player', P(0, 0), 0, { depth: 2 }));
   const d2 = hold(w2.spawn('Jervis', 'enemy', P(0, 0), Math.PI / 2, {}));
   run(w2, 1);
   assert.strictEqual(u2.dmgTaken, 0);
   assert.ok(Math.hypot(d2.pos.x, d2.pos.y) < 1, 'no shove either');
});

test('bot destroyer hunts a sonar contact and drops depth charges on it', () => {
   const w = blank(21);
   const u = hold(w.spawn('U96', 'player', P(0, 0), 0, { depth: 2 }));
   u.battery = 1; u.sub = { ...u.sub, battery: { peri: 1e6, deep: 1e6, charge: 80 } };
   w.spawn('Jervis', 'enemy', P(2500, 300), Math.PI, {});
   run(w, 240, () => u.alive);
   assert.ok(w.events.some(e => e.type === 'dc' && e.dstId === u.id) || !u.alive, 'boat was depth-charged');
   assert.ok(u.dmgTaken > 0);
});

test('bot boat dives for the attack, torpedoes a battleship and goes deep when hunted', () => {
   const w = blank(4);
   const u = w.spawn('U96', 'player', P(0, 0), 0, {});
   const bb = w.spawn('KGV', 'enemy', P(6500, 800), Math.PI, { ai: { patrol: [P(-6000, 800), P(6500, 800)], passive: true } });
   let dived = false, fired = false;
   run(w, 300, () => { if (u.depth === 1) dived = true; if (w.torpedoes.some(t => t.ownerId === u.id)) fired = true; return bb.alive && u.alive; });
   assert.ok(dived, 'went to periscope depth');
   assert.ok(fired, 'fired torpedoes');
   const w2 = blank(4);
   const u2 = w2.spawn('U96', 'player', P(0, 0), 0, { depth: 1 });
   w2.spawn('Jervis', 'enemy', P(1800, 0), Math.PI, {});
   let deep = false;
   run(w2, 40, () => { if (u2.depthTarget === 2) deep = true; return !deep; });
   assert.ok(deep, 'goes deep with a destroyer on top');
});

for (const [name, a, b] of [['boat vs destroyer', 'U96', 'Jervis'], ['boat vs battleship', 'U505', 'KGV'], ['boat vs boat', 'Gato', 'I19']]) {
   test(`bot battle runs clean: ${name}`, () => {
      const w = blank(31);
      w.spawn(a, 'player', P(-4500, 0), 0, {});
      w.spawn(b, 'enemy', P(4500, 500), Math.PI, {});
      run(w, 420, (i) => {
         if (i % 60 === 0) for (const s of w.ships) assert.ok([s.pos.x, s.pos.y, s.hp, s.heading, s.speed, s.detectRange, s.depthF, s.battery].every(Number.isFinite), 'NaN on ' + s.name);
         return w.ships.filter(s => s.alive).length === 2;
      });
      for (const s of w.ships) if (s.sub) assert.ok(s.battery >= 0 && s.battery <= 1 && s.depthF >= 0 && s.depthF <= 2);
   });
}

test('random battles: at most one boat per side, a player boat takes a destroyer slot', () => {
   let withSubs = 0;
   for (let seed = 1; seed <= 30; seed++) {
      const w = new World('normal', { mission: 'standard', seed });
      for (const side of ['player', 'enemy']) {
         const n = w.ships.filter(s => s.side === side && s.type === 'SS').length;
         assert.ok(n <= 1, `seed ${seed}: ${n} boats on ${side}`);
      }
      assert.strictEqual(w.ships.filter(s => s.side === 'player').length, w.ships.filter(s => s.side === 'enemy').length);
      if (w.ships.some(s => s.type === 'SS')) withSubs++;
   }
   assert.ok(withSubs >= 4 && withSubs <= 22, 'battles with boats: ' + withSubs + '/30');
   for (const k of SUBS) {
      const w = new World('normal', { mission: 'standard', ship: k, seed: 5 });
      assert.strictEqual(w.player.cls, k);
      assert.strictEqual(w.ships.filter(s => s.side === 'player' && s.type === 'SS').length, 1);
      assert.strictEqual(w.ships.filter(s => s.side === 'enemy' && s.type === 'SS').length, 1);
      assert.strictEqual(w.ships.filter(s => s.side === 'player').length, 7);
   }
});

test('mixed battle with boats on both sides runs 3 minutes without errors', () => {
   const w = new World('normal', { mission: 'standard', ship: 'U96', seed: 12 });
   w.autoPlayer = true;
   run(w, 180, (i) => {
      if (i % 120 === 0) for (const s of w.ships) assert.ok([s.pos.x, s.pos.y, s.hp, s.heading, s.depthF, s.battery].every(Number.isFinite));
      return w.phase === 'playing';
   });
   assert.ok(w.time > 100);
});

test('mission "Geleitzugschlacht": listed, can be won and lost', () => {
   const m = getMission('wolfpack');
   assert.ok(m, 'mission exists');
   assert.ok(m.briefing.length > 80 && m.playableShips.every(k => SHIPS[k].hull.type === 'SS'));
   assert.ok(MISSIONS.includes(m));
   // win: sink the freighters
   const w = new World('normal', { mission: 'wolfpack', seed: 3 });
   assert.strictEqual(w.player.type, 'SS');
   const tr = w.ships.filter(s => s.side === 'enemy' && s.type === 'TR');
   assert.ok(tr.length >= 4, 'freighters: ' + tr.length);
   assert.ok(w.ships.some(s => s.side === 'enemy' && s.asw), 'escorts with depth charges');
   run(w, 2);
   for (const t of tr) { t.takeDamage(1e9, w.player, 'torp'); if (w.phase !== 'playing') break; }
   run(w, 1);
   assert.strictEqual(w.phase, 'won');
   assert.ok(w.result.xp > 0 && w.result.credits > 0);
   // lose: the boat is sunk
   const l = new World('normal', { mission: 'wolfpack', seed: 3 });
   run(l, 1);
   l.player.takeDamage(1e9, null, 'dc');
   assert.strictEqual(l.phase, 'lost');
   // lose: the convoy gets away
   const e = new World('normal', { mission: 'wolfpack', seed: 3 });
   e.timeLeft = 0.5;
   run(e, 2);
   assert.strictEqual(e.phase, 'lost');
   // and it plays through headless
   const a = new World('normal', { mission: 'wolfpack', seed: 8 });
   a.autoPlayer = true;
   run(a, 200, () => a.phase === 'playing');
   assert.ok(a.time > 5);
});
