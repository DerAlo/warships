// V2 lethality levers and the bot captains' strike coordination (phase 2): decoy capacity, the global
// SAM / CIWS factors, magazines that can run dry, joined salvos, closing to gun range without missiles.
import { test } from 'node:test';
import assert from 'node:assert';
import { emptySea, put, run } from './v2.util.mjs';
import { SHIPS, MISSILES, DEFENCE } from '../gamev2/config.js';
import { launchSSM, deployDecoys } from '../gamev2/missile.js';
import { salvoFor } from '../gamev2/ai_missile.js';

const still = { ai: { passive: true, anchored: true } };
const ev = (w, type) => w.events.filter(e => e.type === type);
const launcher = (type, x, y, side = 'enemy') => ({ id: 900000, side, pos: { x, y }, alive: true, cfg: { weapons: { ssm: [{ type }] } }, mag: { [type]: 99 }, lastSsmFire: -999, dmgMult: 1 });
function withDefence(o, fn) {
   const old = {};
   for (const k in o) { old[k] = DEFENCE[k]; DEFENCE[k] = o[k]; }
   try { fn(); } finally { Object.assign(DEFENCE, old); }
}
// n missiles of `type` from 12 km at the player ship; returns the world after they are all gone
function volley(cls, type, n, each, seed = 4) {
   const w = emptySea({ ship: cls, seed });
   const T = w.player, L = launcher(type, 12000, 0);
   T.hp = T.maxHP = 1e9;
   let fired = 0;
   run(w, 90, () => {
      if (fired < n) { T.targetable = T.detected = true; if (launchSSM(w, L, { targetId: T.id })) fired++; }
      if (each) each(w, T);
      return fired < n || w.missiles.some(m => m.kind === 'ssm');
   });
   return w;
}

test('a decoy cloud seduces at most DEFENCE.decoyCap seekers', () => {
   withDefence({ decoyPk: 1, decoyCap: 2 }, () => {
      let thrown = false;
      const w = volley('Typ022', 'harpoon', 6, (w, T) => {
         if (!thrown && w.missiles.some(m => m.seekerOn)) { thrown = true; assert.ok(deployDecoys(w, T)); }
      });
      assert.strictEqual(ev(w, 'seduced').length, 2);
      assert.strictEqual(ev(w, 'missileHit').length, 4);
      assert.strictEqual(w.decoys.length ? w.decoys[0].n : 2, 2);
   });
});

test('missilePk and ciwsK scale the hard kill: at 0 nothing is shot down', () => {
   withDefence({ missilePk: 0, ciwsK: 0 }, () => {
      const w = volley('Ticonderoga', 'harpoon', 3);
      assert.ok(ev(w, 'samLaunch').length > 0, 'the SAMs did fire');
      assert.strictEqual(ev(w, 'intercept').length, 0);
      assert.strictEqual(ev(w, 'missileHit').length, 3);
   });
   const w = volley('Ticonderoga', 'harpoon', 1);
   assert.strictEqual(ev(w, 'intercept').length + ev(w, 'missileHit').length, 1);
});

test('saturation: a salvo of eight leaks more than a salvo of two against a cruiser', () => {
   let two = 0, eight = 0;
   for (let i = 0; i < 6; i++) {
      two += ev(volley('Ticonderoga', 'harpoon', 2, null, 20 + i), 'missileHit').length / 2;
      eight += ev(volley('Ticonderoga', 'harpoon', 8, null, 20 + i), 'missileHit').length / 8;
   }
   assert.ok(eight >= two, `share of 8: ${eight / 6}, of 2: ${two / 6}`);
   assert.ok(eight > 0, 'eight missiles get at least one leaker in six volleys');
});

test('magazines: SAM loads are small enough to run dry, every class keeps its roles', () => {
   for (const k in SHIPS) {
      const w = SHIPS[k].weapons;
      const sam = w.sam.reduce((a, s) => a + s.n, 0);
      assert.ok(sam <= 64, k + ' carries ' + sam + ' SAMs');
      for (const s of w.sam) assert.ok(s.n >= 4 && s.ch >= 1, k + ' ' + s.type);
   }
   // the air-defence ships still out-range and out-number the others in channels
   const ch = (k) => SHIPS[k].weapons.sam.reduce((a, s) => a + s.ch, 0);
   assert.ok(ch('Daring') > ch('Sachsen') && ch('Sachsen') > ch('Braunschweig'));
});

test('bot salvo size follows the defences of the target', () => {
   const w = emptySea({ ship: 'Burke' });
   const boat = put(w, 'Typ022', 'enemy', 9000, 0, 0, still), ad = put(w, 'Daring', 'enemy', 9000, 3000, 0, still);
   assert.ok(salvoFor(ad) > salvoFor(boat));
   assert.ok(salvoFor(ad) <= 8 && salvoFor(boat) >= 2);
});

test('bots join a called strike: two captains fire at the same ship within seconds', () => {
   const w = emptySea({ ship: 'Daring', seed: 9 });
   const p = w.player;
   p.hp = p.maxHP = 1e9;
   const a = put(w, 'Typ054A', 'enemy', 12000, -1500, Math.PI), b = put(w, 'Typ054A', 'enemy', 12000, 1500, Math.PI);
   let first = null, second = null;
   run(w, 60, () => {
      for (const e of ev(w, 'ssmLaunch')) {
         if (first == null) first = e;
         else if (second == null && e.srcId !== first.srcId) second = e;
      }
      return second == null;
   });
   assert.ok(first && second, 'both frigates fired');
   assert.strictEqual(first.dstId, p.id);
   assert.strictEqual(second.dstId, p.id);
   assert.ok(second.t - first.t < 6, 'joined after ' + (second.t - first.t).toFixed(1) + ' s');
   assert.deepStrictEqual(Object.keys(w.strike.enemy).sort(), ['id', 't']);
   assert.strictEqual(w.strike.enemy.id, p.id);
   assert.ok(a.alive && b.alive);
});

test('a bot without anti-ship missiles closes to gun range', () => {
   // distance to the target after `secs`; the armed ship holds its stand-off band while it has rounds
   const dist = (dry, secs) => {
      const w = emptySea({ ship: 'Sachsen', seed: 3 });   // not a boat: boats are closed on anyway
      const p = w.player;
      p.hp = p.maxHP = 1e9;
      const b = put(w, 'Burke', 'enemy', 9000, 0, Math.PI, { telegraph: 3 });
      b.hp = b.maxHP = 1e9;
      if (dry) b.mag.harpoon = 0;
      run(w, secs);
      return Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y);
   };
   const dry = dist(true, 45), armed = dist(false, 45);
   assert.ok(armed > dry + 800, 'after 45 s: armed ' + Math.round(armed) + ' m, dry ' + Math.round(dry) + ' m');
   const late = dist(true, 100);
   assert.ok(late < SHIPS.Burke.ai.prefRange[0] - 500, 'dry: inside the stand-off band (' + Math.round(late) + ' m)');
});

test('supersonic missiles stay harder to stop than subsonic ones', () => {
   assert.ok(MISSILES.oniks.evade < MISSILES.harpoon.evade);
   assert.ok(DEFENCE.decoyPkSuper < DEFENCE.decoyPk && DEFENCE.decoyCap >= 1);
});
