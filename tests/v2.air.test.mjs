// V2 aircraft: model selection per nation / kind, tolerant of unknown values, instancing per
// airframe, and the triangle budget of the phone tiers against the WW2 plane (72 triangles).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/three.module.min.js';
import { AirModels, AIR_MODELS, airModelFor, airKind, airModelTris } from '../gamev2/air3d.js';
import { GFX } from '../gamev2/gfxquality.js';
import { airFixtures } from './v2.airfixtures.mjs';

test('airframe per nation and kind', () => {
   assert.equal(airModelFor({ kind: 'strike', nation: 'us' }), 'fa18');
   assert.equal(airModelFor({ kind: 'fighter', nation: 'us' }), 'f35');
   assert.equal(airModelFor({ kind: 'fighter', nation: 'ru' }), 'su33');
   assert.equal(airModelFor({ kind: 'strike', nation: 'ru' }), 'mig29k');
   assert.equal(airModelFor({ kind: 'strike', nation: 'cn' }), 'j15');
   assert.equal(airModelFor({ kind: 'fighter', nation: 'cn' }), 'j15');
   for (const n of ['us', 'ru', 'cn', 'de', 'uk', 'ir', 'xx', undefined]) assert.equal(airModelFor({ kind: 'helo', nation: n }), 'helo');
   // nation of the owning ship as fallback, explicit model wins, legacy types still work
   assert.equal(airModelFor({ kind: 'fighter' }, 'ru'), 'su33');
   assert.equal(airModelFor({ kind: 'fighter', nation: 'us', model: 'mig29k' }), 'mig29k');
   assert.equal(airModelFor({ model: 'Flanker' }), 'su33');
   assert.equal(airModelFor({ type: 'ft' }, 'us'), 'f35');
   assert.equal(airModelFor({ type: 'tb' }, 'us'), 'fa18');
   assert.equal(airModelFor({ type: 'asw' }, 'us'), 'helo');
});

test('unknown values fall back instead of throwing', () => {
   assert.equal(airModelFor({}), 'fa18');
   assert.equal(airModelFor(null), 'fa18');
   assert.equal(airModelFor({ kind: 'bomber', nation: 'zz', model: 'b52' }), 'fa18');
   assert.equal(airKind({ kind: 42 }), 'strike');
   assert.equal(airKind({ type: 'heli' }), 'helo');
   for (const k in AIR_MODELS) assert.ok(['hornet', 'flanker', 'stealth', 'helo'].includes(AIR_MODELS[k].mesh));
});

test('squadrons land in the instanced mesh of their airframe', () => {
   for (const det of [0, 3]) {
      GFX.detail = det;
      const scene = new THREE.Scene();
      const air = new AirModels(scene, {});
      const sqs = airFixtures();
      sqs.push({ id: 9, n: 4, visible: true, pos: { x: 0, y: 500 }, alt: 300, heading: 1, speed: 250, want: 1.4, prev: { alt: 299 }, type: 'weird', ownerId: 7 });
      sqs.push({ id: 10, n: 3, visible: false, pos: { x: 0, y: 0 }, alt: 300, heading: 0, kind: 'fighter', nation: 'us' });
      const world = { squadrons: sqs, bombs: [], effects: [], shipById: (id) => (id === 7 ? { cfg: { hull: { nation: 'cn' } } } : null) };
      air.update(world, 0.016, 1);
      const st = air.stats();
      assert.equal(st.drawn, 6 + 4);
      assert.equal(air.meshes.hornet.count, 1);
      assert.equal(air.meshes.stealth.count, 1);
      assert.equal(air.meshes.flanker.count, 3 + 4);
      assert.equal(air.meshes.helo.count, 1);
      assert.equal(st.calls, 4);
      for (const M of air.list) {
         for (const a of ['position', 'normal', 'aPart']) for (const v of M.geometry.attributes[a].array) assert.ok(Number.isFinite(v));
         for (let i = 0; i < M.count * 16; i++) assert.ok(Number.isFinite(M.instanceMatrix.array[i]));
         M.geometry.computeBoundingBox();
         const s = M.geometry.boundingBox.getSize(new THREE.Vector3());
         assert.ok(s.x > 15 && s.x < 40 && s.z > 5 && s.z < 30 && s.y > 3, `${M.userData.name} size ${s.toArray()}`);
      }
      // only the airframes in use are drawn
      world.squadrons = [sqs[0]];
      air.update(world, 0.016, 2);
      assert.equal(air.stats().calls, 1);
      assert.equal(air.meshes.flanker.visible, false);
      air.clear();
      assert.equal(air.stats().calls, 0);
   }
});

test('ordnance flag and rotor phase reach the instance attribute', () => {
   GFX.detail = 2;
   const air = new AirModels(new THREE.Scene(), {});
   const sq = { id: 1, n: 1, visible: true, pos: { x: 0, y: 0 }, alt: 100, heading: 0, speed: 60, kind: 'helo', nation: 'ru', armed: 0 };
   const jet = { id: 2, n: 1, visible: true, pos: { x: 0, y: 0 }, alt: 100, heading: 0, speed: 250, kind: 'fighter', nation: 'ru', armed: 0 };
   air.update({ squadrons: [sq, jet] }, 0.016, 1);
   const hi = air.meshes.helo.userData.inst, ji = air.meshes.flanker.userData.inst;
   assert.equal(hi.getX(0), 1); assert.equal(hi.getY(0), 0);
   const ph = hi.getZ(0);
   assert.equal(ji.getY(0), 1, 'fighters keep their missiles');
   sq.armed = 2;
   air.update({ squadrons: [sq, jet] }, 0.016, 1.1);
   assert.equal(hi.getY(0), 1);
   assert.notEqual(hi.getZ(0), ph);
});

test('budget: phone-tier airframes are not heavier than the WW2 plane', () => {
   for (const m of ['hornet', 'flanker', 'stealth', 'helo']) {
      const lo = airModelTris(m, true), hi = airModelTris(m, false);
      assert.ok(lo <= 72, `${m} low: ${lo} triangles`);
      assert.ok(hi > lo && hi < 900, `${m} fine: ${hi} triangles`);
      if (process.env.V2_MODEL_STATS) console.log(`${m.padEnd(8)} low ${lo} fine ${hi}`);
   }
});
