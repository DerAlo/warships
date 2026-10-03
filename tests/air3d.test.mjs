// tests/air3d.test.mjs — carriers, squadrons and anti-aircraft fire (game3d/air.js, ai_air.js):
// carrier data, launch and deck time, the aiming gate, aerial torpedoes (arming) and bombs, AA
// losses and the AA focus, spotting from the air, servicing and restock, fuel and ditching, bot
// strikes, random-battle carriers (never in co-op) and the Midway operation.
// Run: node --test tests/air3d.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { World } from '../game3d/state.js';
import { SHIPS, PLAYABLE, BOT_CVS, CLASS_NAMES, aaProfile, SHIP_STATS } from '../game3d/config.js';
import {
   AIR, AIR_TYPES, planeCount, canLaunch, launchSquadron, recallSquadron, dropWeapons, cycleAaFocus, updateAir,
} from '../game3d/air.js';
import { TECH_TREE } from '../game3d/progress3d.js';
import { getMission } from '../game3d/missions.js';
import { buildNetWorld } from '../game3d/net/setup.js';

const DT = 1 / 60;
const CVS = ['GrafZeppelin', 'Akagi', 'Shokaku', 'ArkRoyal', 'Illustrious', 'Enterprise', 'Essex', 'Bearn'];

function blank(seed = 1) {
   const w = new World('normal', { mission: 'standard', seed });
   w.ships = []; w.roster = []; w.bots = []; w._byId.clear(); w.player = null;
   w.obstacles = []; w.caps = []; w.smokeClouds = []; w.shells = []; w.torpedoes = [];
   w.squadrons = []; w.bombs = [];
   w._maxTerrainH = 0; w._script = null; w.timeLeft = null;
   w.setEnv({ time: 'day', weather: 'clear' });
   return w;
}
const P = (x, y) => ({ x, y });
function run(w, s, fn) { for (let i = 0; i < s * 60; i++) { w.update(DT); if (fn && fn(i) === false) break; } }
function hold(ship) { ship.ai = { _init: true, passive: true, desired: ship.heading, tel: 0, dodged: new Set(), dodgeT: 0, reverseT: 99999, stuckT: 0 }; ship.telegraph = 0; ship.speed = 0; return ship; }
// a launched squadron, airborne and under "player" control (no bot steering) at pos / heading
function airborne(w, cv, type, pos, heading) {
   cv.air.deckT = 0;
   const q = launchSquadron(w, cv, type, null, true);
   assert.ok(q, 'launched');
   q.state = 'fly'; q.t = 0; q.pos.x = pos.x; q.pos.y = pos.y; q.heading = q.want = heading;
   q.speed = q.cfg.speed; q.alt = type === 'db' ? AIR.dbAlt : AIR.cruiseAlt;
   return q;
}
const planeDmg = (q) => (q.n0 - q.n) * q.cfg.hp + (q.cfg.hp - q.hp);

test('carrier class: eight carriers of five navies, playable, in the tech tree, with air groups', () => {
   assert.strictEqual(CLASS_NAMES.CV, 'Flugzeugträger');
   const nations = new Set();
   for (const k of CVS) {
      const c = SHIPS[k];
      assert.ok(c && c.hull.type === 'CV' && PLAYABLE.includes(k), k);
      for (const t of AIR_TYPES) {
         const a = c.air[t];
         assert.ok(a.name && a.hangar >= a.squad && a.squad >= 4 && a.speed > 100 && a.hp > 0 && a.restock > 0, k + ' ' + t);
         if (t !== 'ft') assert.ok(a.flight > 0 && a.flight <= a.squad && a.weapon.dmg > 0, k + ' ' + t + ' weapon');
      }
      assert.ok(c.air.service > 0 && c.air.fuel > 60, k + ' service / fuel');
      assert.ok(c.ai.role === 'cv', k + ' bot role');
      assert.ok(TECH_TREE.find(r => (r.key || r[0]) === k), k + ' in tech tree');
      assert.ok(SHIP_STATS[k].air && SHIP_STATS[k].ratings.antiAir >= 0, k + ' port stats');
      nations.add(c.hull.nation);
   }
   assert.ok(nations.size >= 5, 'navies: ' + [...nations]);
   for (const side of ['axis', 'allies']) for (const k of BOT_CVS[side]) assert.ok(CVS.includes(k), k);
   assert.ok(!PLAYABLE.includes('Hiryu'), 'Hiryū is op-only');
   assert.strictEqual(SHIPS.Hiryu.air.tb.name, SHIPS.Akagi.air.tb.name, 'Hiryū flies the 1942 types');
});

test('every ship has flak by class and era; submarines and transports barely any', () => {
   const dps = (k) => aaProfile(SHIPS[k]).dps;
   for (const k of Object.keys(SHIPS)) {
      const a = aaProfile(SHIPS[k]);
      if (SHIPS[k].hull.type === 'TR') continue;
      if (a.range) assert.ok(a.bands.length === 3 && a.bands[0].r >= a.bands[1].r && a.bands[1].r >= a.bands[2].r, k + ' bands');
   }
   assert.ok(dps('Iowa') > dps('Bismarck'), 'US navy and later tier: more flak');
   assert.ok(dps('Cleveland') > dps('Fletcher'), 'cruiser > destroyer');
   assert.ok(dps('Bismarck') > dps('U96'), 'battleship > submarine');
});

test('launch: hangar, deck time, one squadron per type, climbs out and flies', () => {
   const w = blank();
   const cv = hold(w.spawn('Enterprise', 'player', P(0, 0), 0, { isPlayer: true }));
   const h0 = cv.air.tb.hangar;
   assert.ok(canLaunch(w, cv, 'tb'));
   const q = launchSquadron(w, cv, 'tb', null, true);          // player-flown: no bot recall
   assert.ok(q && q.n === cv.cfg.air.tb.squad && q.state === 'launch');
   assert.strictEqual(cv.air.tb.hangar, h0 - q.n);
   assert.ok(cv.air.deckT > 0 && !canLaunch(w, cv, 'db'), 'deck busy');
   assert.ok(w.events.some(e => e.type === 'airLaunch'));
   run(w, cv.air.deckT + 0.1);
   assert.ok(!canLaunch(w, cv, 'tb'), 'only one torpedo squadron at a time');
   assert.ok(canLaunch(w, cv, 'db'), 'deck free again');
   run(w, 2);
   assert.ok(q.state !== 'launch', q.state);
   assert.ok(q.alt > 100, 'climbing: ' + q.alt);
   const c = planeCount(w, cv, 'tb');
   assert.strictEqual(c.air, q.n);
   assert.strictEqual(c.total, h0);
});

test('aiming gate: a snap drop is refused, a held run drops one flight and the rest stays', () => {
   const w = blank();
   const cv = hold(w.spawn('Enterprise', 'player', P(-15000, 0), 0, { isPlayer: true }));
   const q = airborne(w, cv, 'tb', P(0, 0), 0);
   q.aiming = true;
   run(w, AIR.tbAimMin * 0.5);
   assert.strictEqual(dropWeapons(w, q), 0, 'too short');
   const t0 = w.torpedoes.length;
   q.aiming = true;
   run(w, AIR.tbAimFull + 0.1);
   assert.ok(q.spread < AIR.tbSpread[0], 'fan narrows');
   const k = dropWeapons(w, q);
   assert.strictEqual(k, q.cfg.flight);
   assert.strictEqual(w.torpedoes.length - t0, k);
   assert.ok(w.torpedoes.slice(t0).every(t => t.air && t.arm === AIR.tbArm));
   assert.strictEqual(q.armed, q.n0 - k, 'second flight still armed');
   assert.ok(w.squadrons.some(s => s !== q && s.state === 'return' && s.armed === 0), 'the spent flight turns home');
});

test('aerial torpedoes: hit a target in their path, but not before they are armed', () => {
   for (const [gap, hits] of [[1700, true], [AIR.tbDrop + AIR.tbArm * 0.4, false]]) {
      const w = blank(3);
      const cv = hold(w.spawn('Enterprise', 'player', P(-15000, 0), 0, { isPlayer: true }));
      const bb = hold(w.spawn('KGV', 'enemy', P(0, 0), Math.PI / 2, {}));
      bb.aa = { range: 0, dps: 0, bands: [] };                // no flak: only the torpedo rule is tested
      const q = airborne(w, cv, 'tb', P(-gap - cv.cfg.air.tb.speed * 1.1, 0), 0);
      q.aiming = true;
      run(w, 1.1);
      const hp0 = bb.hp;
      assert.ok(dropWeapons(w, q) > 0);
      run(w, 25);
      assert.strictEqual(bb.hp < hp0, hits, `gap ${gap}: hp ${hp0} -> ${bb.hp}`);
   }
});

test('dive bombers: bombs land in the ellipse ahead and damage a ship under it', () => {
   const w = blank(5);
   const cv = hold(w.spawn('Enterprise', 'player', P(-15000, 0), 0, { isPlayer: true }));
   const ca = hold(w.spawn('Hipper', 'enemy', P(0, 0), 0, {}));
   ca.aa = { range: 0, dps: 0, bands: [] };
   const aim = AIR.dbAimFull;
   // start so that after the full aim time the ellipse centre sits on the target
   const speed = cv.cfg.air.db.speed;
   const q = airborne(w, cv, 'db', P(-AIR.dbAim - speed * aim, 0), 0);
   q.aiming = true;
   run(w, aim);
   const hp0 = ca.hp;
   assert.ok(q.ellipse < AIR.dbEllipse[0] * 0.5, 'ellipse shrinks');
   assert.strictEqual(dropWeapons(w, q), q.cfg.flight);
   assert.ok(w.bombs.filter(b => b.alive).length === q.cfg.flight);
   run(w, AIR.bombFall + 0.5);
   assert.ok(ca.hp < hp0, `hp ${hp0} -> ${ca.hp}`);
   assert.ok(w.bombs.every(b => !b.alive), 'pool entries freed');
   const pool = w.bombs.length;
   q.aiming = true; run(w, aim); dropWeapons(w, q); run(w, 2);
   assert.strictEqual(w.bombs.length, pool, 'bomb pool reused');
});

test('AA: a strike over a battleship loses planes one at a time, focus shifts the flak', () => {
   const lost = [];
   for (const focus of [0, -1, 1]) {
      const w = blank(7);
      const cv = hold(w.spawn('Enterprise', 'player', P(-15000, 0), 0, { isPlayer: true }));
      const bb = hold(w.spawn('Iowa', 'enemy', P(0, 0), 0, {}));
      bb.aaFocus = focus;
      const q = airborne(w, cv, 'tb', P(0, -1200), 0);        // north = port side of an east-bound ship
      const downs = [];
      run(w, 30, () => { q.pos.x = 0; q.pos.y = -1200; for (const e of w.events) if (e.type === 'planeDown' && !downs.includes(e)) downs.push(e); });
      assert.ok(q.n < q.n0, 'focus ' + focus + ': no losses');
      assert.ok(downs.length >= 1 && downs.every(e => e.srcId === bb.id && e.dstId === cv.id));
      lost.push(planeDmg(q));
   }
   const [even, port, stbd] = lost;
   assert.ok(port > even && even > stbd, `even ${even} port ${port} starboard ${stbd}`);
});

test('AA focus key: off -> port -> starboard -> off, with an event', () => {
   const w = blank();
   const s = w.spawn('Bismarck', 'player', P(0, 0), 0, { isPlayer: true });
   assert.strictEqual(s.aaFocus, 0);
   assert.strictEqual(cycleAaFocus(w, s), -1);
   assert.strictEqual(cycleAaFocus(w, s), 1);
   assert.strictEqual(cycleAaFocus(w, s), 0);
   assert.ok(w.events.filter(e => e.type === 'aaFocus').length === 3);
});

test('spotting: a squadron overhead spots a ship no ship can see', () => {
   const w = blank(9);
   const cv = hold(w.spawn('Enterprise', 'player', P(-14000, 0), 0, { isPlayer: true }));
   const foe = hold(w.spawn('Hipper', 'enemy', P(6000, 0), 0, {}));
   run(w, 0.5);
   assert.ok(!foe.spotted, 'out of sight of the carrier');
   const q = airborne(w, cv, 'ft', P(6000 - 2500, 0), 0);
   run(w, 0.5, () => { q.pos.x = 3500; q.pos.y = 0; });
   assert.ok(foe.spotted && foe.spottedByPlayer, 'spotted by the own squadron');
   assert.ok(foe.lastSeen, 'last-seen record for the bots');
});

test('landing, servicing and restock', () => {
   const w = blank();
   const cv = hold(w.spawn('Enterprise', 'player', P(0, 0), 0, { isPlayer: true }));
   const h0 = cv.air.db.hangar;
   const q = airborne(w, cv, 'db', P(1500, 0), 0);
   recallSquadron(w, q);
   assert.strictEqual(q.state, 'return');
   run(w, 30, () => !(q.state === 'land'));
   assert.strictEqual(q.state, 'land');
   assert.ok(w.events.some(e => e.type === 'airLand'));
   assert.strictEqual(cv.air.db.hangar, h0 - q.n0, 'in service, not ready yet');
   assert.strictEqual(planeCount(w, cv, 'db').service, q.n0);
   run(w, cv.cfg.air.service + 0.5);
   assert.strictEqual(cv.air.db.hangar, h0, 'serviced');
   // two planes lost: replaced one by one
   cv.air.db.hangar -= 2;
   run(w, cv.cfg.air.db.restock + 0.5);
   assert.strictEqual(cv.air.db.hangar, h0 - 1);
   run(w, cv.cfg.air.db.restock);
   assert.strictEqual(cv.air.db.hangar, h0);
   run(w, cv.cfg.air.db.restock * 2);
   assert.strictEqual(cv.air.db.hangar, h0, 'never above the hangar size');
});

test('fuel runs out: the squadron turns home; carrier lost: the planes ditch', () => {
   const w = blank();
   hold(w.spawn('Bismarck', 'player', P(0, 9000), 0, { isPlayer: true }));
   const cv = hold(w.spawn('Enterprise', 'player', P(0, 0), 0, {}));
   const q = airborne(w, cv, 'tb', P(3000, 0), 0);
   q.fuel = 0.5;
   run(w, 1);
   assert.strictEqual(q.state, 'return');
   const f = airborne(w, cv, 'ft', P(-3000, 0), Math.PI);
   cv.hp = 0; cv.alive = false;
   run(w, AIR.ditchT + 3);
   assert.ok(w.squadrons.every(s => s.n === 0 || s.state !== 'return'), 'ditched');
   assert.ok(!w.squadrons.includes(f));
});

test('updateAir runs on the host of a net world (squadrons go out in the snapshot)', () => {
   const w = blank();
   const cv = hold(w.spawn('Enterprise', 'player', P(0, 0), 0, { isPlayer: true }));
   const q = airborne(w, cv, 'tb', P(3000, 0), 0);
   const x = q.pos.x;
   w.net = { humans: [cv] };
   updateAir(w, 1);
   assert.notStrictEqual(q.pos.x, x);
});

test('bot carrier: launches a strike at a spotted enemy and hurts it', () => {
   const w = blank(11);
   const me = hold(w.spawn('Bismarck', 'player', P(0, 0), 0, { isPlayer: true }));
   const cv = w.spawn('Essex', 'enemy', P(14000, 0), Math.PI, {});
   const hp0 = me.hp;
   let launched = false;
   run(w, 240, () => { if (w.squadrons.some(s => s.side === 'enemy' && s.type !== 'ft')) launched = true; if (launched && me.hp < hp0) return false; });
   assert.ok(launched, 'strike launched');
   assert.ok(me.hp < hp0, 'damage: ' + hp0 + ' -> ' + me.hp);
   void cv;
});

test('random battles: carriers on both sides in some battles, always with a player carrier, co-op too', () => {
   const cvs = (w) => w.ships.filter(s => s.air);
   let some = 0, seedWith = -1;
   for (let seed = 1; seed <= 30; seed++) {
      const w = new World('normal', { mission: 'standard', ship: 'Bismarck', seed });
      const c = cvs(w);
      if (c.length) {
         some++; if (seedWith < 0) seedWith = seed;
         assert.ok(c.some(s => s.side === 'player') && c.some(s => s.side === 'enemy'), 'one per side');
      }
   }
   assert.ok(some >= 3 && some <= 18, 'carrier battles in 30: ' + some);
   // net games build the very same World (setup.buildNetWorld): carriers are part of co-op now
   const coop = buildNetWorld({ mission: 'standard', difficulty: 'normal', seed: seedWith, classes: ['Bismarck', 'Hipper'], loadouts: [], self: 0 });
   assert.ok(cvs(coop).some(s => s.side === 'player') && cvs(coop).some(s => s.side === 'enemy'), 'co-op: carriers as in singleplayer');
   for (const seed of [2, 3, 4]) {
      const w = new World('normal', { mission: 'standard', ship: 'Enterprise', seed });
      assert.ok(w.player.air && cvs(w).some(s => s.side === 'enemy'), 'player carrier meets an enemy carrier');
   }
});

test('Midway: Enterprise only, four Japanese carriers, US carriers on the own side', () => {
   const m = getMission('midway');
   assert.ok(m && m.group === 'ops' && m.fixedShips);
   assert.deepStrictEqual(m.playableShips, ['Enterprise']);
   const w = new World('normal', { mission: 'midway', ship: 'Enterprise', seed: 5 });
   assert.strictEqual(w.player.cfg.name, SHIPS.Enterprise.name);
   assert.strictEqual(w.ships.filter(s => s.air && s.side === 'enemy').length, 4);
   assert.ok(w.ships.filter(s => s.air && s.side === 'player').length >= 2);
   run(w, 5);
   assert.ok(w.squadrons.every(s => s.side === 'player'), 'the Kido Butai is still rearming');
});
