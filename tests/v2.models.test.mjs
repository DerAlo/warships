// V2 modern ship models: every model builds through the real ShipModels builder at every detail
// tier, has sane bounds, the anchors the contract promises, working gun mounts, and stays within
// the triangle / draw-call budget of the WW2 reference ships on the phone tiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/three.module.min.js';
import { ShipModels } from '../gamev2/ships3d.js';
import { MODELS, modernGunSlots, isModernModel } from '../gamev2/ships3d_modern.js';
import { GFX } from '../gamev2/gfxquality.js';
import { FIXTURES, MODEL_KEYS, WW2_REF, mkModernShip, mkWW2Ship, recStats } from './v2.modelfixtures.mjs';

const mk = () => new ShipModels(new THREE.Scene(), { heightAt: () => 0 }, null);
const build = (ship, detail) => { GFX.detail = detail; const sm = mk(); const r = sm._build(ship); return { sm, r, st: recStats(r) }; };
const ROSTER = ['k130', 'f124', 'burke', 'tico', 'type45', 'ford', 'u212', 'virginia', 'buyan', 'gorshkov', 'slava', 'kirovn', 'kuznetsov', 'kilo',
   'type022', 'type054', 'type052d', 'type055', 'shandong', 'yuan', 'fac', 'moudge', 'ghadir', 'tanker', 'container', 'lng'];
const SUBS = ['u212', 'virginia', 'kilo', 'yuan', 'ghadir'], CVS = ['ford', 'kuznetsov', 'shandong'], MERCH = ['tanker', 'container', 'lng'];

test('every roster key has a model and a fixture', () => {
   for (const k of ROSTER) { assert.ok(isModernModel(k), k); assert.ok(FIXTURES[k], 'fixture ' + k); }
   assert.equal(MODEL_KEYS.length, ROSTER.length);
   assert.equal(isModernModel('Bismarck'), false);
   assert.equal(isModernModel(undefined), false);
   assert.equal(isModernModel('toString'), false);
});

test('all models build at every detail tier with finite, plausible bounds', () => {
   for (const key of ROSTER) for (const det of [0, 1, 2, 3]) {
      const { r, st } = build(mkModernShip(key), det);
      const h = FIXTURES[key].hull;
      assert.equal(st.bad, 0, `${key}@${det} NaN`);
      assert.ok(st.tris > 50, `${key}@${det} empty`);
      assert.ok(Math.abs(st.size[0] - h.L) < h.L * 0.12, `${key}@${det} length ${st.size[0].toFixed(1)} vs ${h.L}`);
      assert.ok(st.size[2] >= h.beam * 0.9 && st.size[2] < h.beam * 2.2, `${key}@${det} beam ${st.size[2].toFixed(1)} vs ${h.beam}`);
      assert.ok(st.size[1] > 1 && st.size[1] < h.L * 0.6, `${key}@${det} height ${st.size[1].toFixed(1)}`);
      assert.equal(r.modern, key);
      assert.ok(r.d.L === h.L && r.d.B === h.beam);
      for (const x of [-h.L * 0.4, 0, h.L * 0.4]) { assert.ok(Number.isFinite(r.S.deckAt(x))); assert.ok(r.S.halfDeckAt(x) > 0); }
   }
});

test('anchors promised by the contract exist and lie on the ship', () => {
   GFX.detail = 2;
   for (const key of ROSTER) {
      const { r, sm } = build(mkModernShip(key), 2);
      const A = r.anchors, h = FIXTURES[key].hull;
      assert.ok(A.mastTop?.length >= 1, key + ' mastTop');
      for (const n in A) for (const a of A[n]) {
         assert.ok(Number.isFinite(a.x + a.y + a.z), `${key}.${n}`);
         assert.ok(Math.abs(a.x) <= h.L * 0.56 && Math.abs(a.z) <= h.beam * 1.1, `${key}.${n} off the ship: ${a.x.toFixed(1)}, ${a.z.toFixed(1)}`);
      }
      if (SUBS.includes(key)) { assert.ok(A.sail, key + ' sail'); continue; }
      if (MERCH.includes(key)) continue;
      if (CVS.includes(key)) { assert.ok(A.flightDeck && A.cat?.length >= 2 && A.ciws, key + ' carrier anchors'); continue; }
      assert.ok(A.ssm || A.vlsFore || A.vlsAft, key + ' has no missile launcher anchor');
      if (!['fac', 'type022'].includes(key)) assert.ok(A.ciws || A.pdms, key + ' has no point defence anchor');
      if (!['fac', 'type022', 'buyan'].includes(key)) assert.ok(A.heloDeck, key + ' heloDeck');
      const v = sm.anchorWorld(r, 'mastTop', 0);
      assert.ok(v && Number.isFinite(v.x + v.y + v.z));
      assert.equal(sm.anchorWorld(r, 'nope'), null);
   }
   const b = build(mkModernShip('burke'), 2).r.anchors;
   assert.ok(b.vlsFore && b.vlsAft && b.ssm.length === 2 && b.ciws.length === 2 && b.decoy.length === 2 && b.heloDeck);
   assert.equal(build(mkModernShip('slava'), 2).r.anchors.ssm.reduce((n, a) => n + a.n, 0), 16);
});

test('gun mounts follow the sim turrets (bearing, elevation, muzzle flash)', () => {
   for (const key of ['burke', 'tico', 'slava', 'kirovn', 'k130', 'fac', 'type022']) {
      const ship = mkModernShip(key);
      const slots = modernGunSlots(key, FIXTURES[key].hull.L);
      assert.equal(ship.turrets.length, slots.length);
      GFX.detail = 1;
      const shots = [];
      const sm = new ShipModels(new THREE.Scene(), { heightAt: () => 0 }, { muzzle: (p, d, cal) => shots.push({ p: p.clone(), d: d.clone(), cal }), sinkBurst() {} });
      const world = { ships: [ship] }, cam = { position: new THREE.Vector3(0, 50, 200) };
      sm.sync(world, 0.016, 0, cam);
      const r = sm.recs.get(ship);
      assert.equal(r.turrets.length, slots.length, key);
      ship.turrets[0].bearing = 0.7; ship.turrets[0].elev = 0.3;
      for (let i = 0; i < 200; i++) sm.sync(world, 0.05, i * 0.05, cam);
      assert.ok(Math.abs(r.turrets[0].yaw.rotation.y + 0.7) < 1e-6, key + ' yaw');
      assert.ok(Math.abs(r.turrets[0].pitch.rotation.z - 0.3) < 0.01, key + ' pitch');
      ship.turrets[0].reload = 3;
      sm.sync(world, 0.05, 11, cam);
      assert.equal(shots.length, r.turrets[0].offs.length, key + ' muzzle flashes');
      // the shell leaves along the trained bearing: ship heading 0, bearing 0.7 to starboard (+z)
      const s0 = shots[0];
      assert.ok(s0.d.x > 0.5 && s0.d.z > 0.4 && s0.d.y > 0.2, `${key} muzzle dir ${s0.d.toArray().map(v => v.toFixed(2))}`);
      assert.ok(Number.isFinite(s0.p.x + s0.p.y + s0.p.z) && s0.p.y > 0.5, key + ' muzzle pos');
   }
   assert.equal(modernGunSlots('tico', 173).length, 2);
   assert.ok(modernGunSlots('tico', 173)[1].aft);
   assert.equal(modernGunSlots('burke', 310)[0].x, 110);
   assert.deepEqual(modernGunSlots('nope', 100), []);
});

test('radars turn from detail 1 up and are baked into the hull at detail 0', () => {
   const ship = mkModernShip('type45');
   const a = build(ship, 0), b = build(ship, 2);
   assert.equal(a.r.spinners.length, 0);
   assert.ok(b.r.spinners.length >= 1);
   const sm = b.sm; sm.recs.set(ship, b.r);
   const y0 = b.r.spinners[0].obj.rotation.y;
   sm.sync({ ships: [ship] }, 0.1, 0, { position: new THREE.Vector3() });
   assert.notEqual(b.r.spinners[0].obj.rotation.y, y0);
});

test('submarine periscopes end 1.9 m above the water at periscope depth', () => {
   for (const key of SUBS) {
      const { r, st } = build(mkModernShip(key), 2);
      const h = FIXTURES[key].hull, peri = h.deckH + h.sup.h + 1.5;
      assert.ok(Math.abs(r.anchors.mastTop[0].y - (peri + 1.9)) < 0.05, `${key} mast top ${r.anchors.mastTop[0].y}`);
      assert.ok(Math.abs(st.box.max[1] - (peri + 1.9)) < 0.3, `${key} highest point ${st.box.max[1]}`);
      assert.equal(r.smoke.length, 0);
   }
});

test('scaling: a longer, beamier hull scales the model, anchors and gun slots', () => {
   const a = build(mkModernShip('burke'), 2), b = build(mkModernShip('burke_scaled'), 2);
   const k = 170 / 155;
   assert.ok(Math.abs(b.st.size[0] / a.st.size[0] - k) < 0.01);
   assert.ok(Math.abs(b.r.anchors.vlsFore[0].x / a.r.anchors.vlsFore[0].x - k) < 1e-6);
   assert.ok(Math.abs(b.r.turrets[0].yaw.position.x / a.r.turrets[0].yaw.position.x - k) < 1e-6);
   assert.ok(b.st.tris > a.st.tris, 'three-digit pennant has more segments');
});

test('ships without cfg.model still take the WW2 path', () => {
   const { r } = build(mkWW2Ship('Fletcher'), 1);
   assert.equal(r.modern, undefined);
   assert.equal(r.turrets.length, 5);
});

test('budget: phone tiers are not heavier than the WW2 reference ships', () => {
   const rows = [];
   const ref = {};
   for (const det of [0, 1, 2, 3]) {
      ref[det] = {};
      for (const k of WW2_REF) { const st = build(mkWW2Ship(k), det).st; ref[det][k] = st; rows.push(`${k.padEnd(12)} d${det} tris ${String(st.tris).padStart(6)} meshes ${st.meshes}`); }
   }
   for (const key of ROSTER) for (const det of [0, 1, 2, 3]) {
      const st = build(mkModernShip(key), det).st;
      rows.push(`${key.padEnd(12)} d${det} tris ${String(st.tris).padStart(6)} meshes ${st.meshes}`);
      const L = FIXTURES[key].hull.L;
      const big = L > 135 ? ref[det].Bismarck : ref[det].Fletcher;
      if (det <= 1) {
         assert.ok(st.tris <= big.tris, `${key}@${det}: ${st.tris} tris > ${big.tris}`);
         assert.ok(st.meshes <= ref[det].Fletcher.meshes, `${key}@${det}: ${st.meshes} draw calls > Fletcher ${ref[det].Fletcher.meshes}`);
      } else {
         assert.ok(st.tris <= ref[det].Bismarck.tris, `${key}@${det}: ${st.tris} tris > Bismarck ${ref[det].Bismarck.tris}`);
      }
   }
   if (process.env.V2_MODEL_STATS) console.log('\n' + rows.join('\n'));
});
