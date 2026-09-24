// tests/zoom3d.test.mjs -- unit tests for the 3D wheel zoom ladder (game3d/zoom3d.js).
// Run: node --test tests/zoom3d.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ZoomLadder, MAGS, TP_STEPS, distRange } from '../game3d/zoom3d.js';

const IN = -1, OUT = 1;            // Input3D sign: + = toward the user = zoom out
const L = 202;                     // Hipper-sized hull
const settle = (z, t = 0.5) => { for (let i = 0; i < t * 60; i++) z.update(1 / 60); };

test('default: third person, near two hull lengths, 4x remembered for Shift', () => {
   const z = new ZoomLadder(L);
   assert.equal(z.bino, false);
   assert.ok(Number.isInteger(z.tp) && z.tp > 0 && z.tp < TP_STEPS);
   assert.ok(z.dist > L * 1.4 && z.dist < L * 2.6, 'dist ' + z.dist);
   assert.equal(z.zoom, 4);
   const r = distRange(L);
   assert.ok(Math.abs(z.distAt(0) - r.max) < 1e-6 && Math.abs(z.distAt(TP_STEPS) - r.min) < 1e-6);
});

test('full ladder sweep in and out, one notch = one rung', () => {
   const z = new ZoomLadder(L);
   for (let i = 0; i < 12; i++) z.wheel(OUT);
   assert.equal(z.level, 0);
   const seq = [];
   for (let i = 0; i < 12; i++) { z.wheel(IN); seq.push(z.bino ? z.zoom + 'x' : z.tp); }
   assert.deepEqual(seq, [1, 2, 3, 4, 5, '2x', '4x', '8x', '16x', '16x', '16x', '16x']);
   const back = [];
   for (let i = 0; i < 12; i++) { z.wheel(OUT); back.push(z.bino ? z.zoom + 'x' : z.tp); }
   assert.deepEqual(back, ['8x', '4x', '2x', 5, 4, 3, 2, 1, 0, 0, 0, 0]);
   // third-person rungs: distance strictly shrinks towards the ship
   for (let i = 1; i <= TP_STEPS; i++) assert.ok(z.distAt(i) < z.distAt(i - 1));
});

test('bursts are clamped at both ends (no runaway)', () => {
   const z = new ZoomLadder(L);
   z.wheel(IN * 40);
   assert.equal(z.bino, true); assert.equal(z.zoom, 16); assert.equal(z.acc, 0);
   z.wheel(OUT);
   assert.equal(z.zoom, 8, 'one notch back after a huge burst');
   z.wheel(OUT * 40);
   assert.equal(z.bino, false); assert.equal(z.tp, 0);
   z.wheel(IN);
   assert.equal(z.tp, 1, 'one notch in after a huge out-burst');
   // a burst summed in one frame lands on the same rung as single notches
   const a = new ZoomLadder(L), b = new ZoomLadder(L);
   a.wheel(IN * 4);
   for (let i = 0; i < 4; i++) b.wheel(IN);
   assert.equal(a.level, b.level);
});

test('touchpad: fractional deltas glide in third person, detent at the scope boundary', () => {
   const z = new ZoomLadder(L);
   const tp0 = z.tp;
   for (let i = 0; i < 10; i++) z.wheel(IN * 0.05);
   assert.ok(Math.abs(z.tp - (tp0 + 0.5)) < 1e-9, 'continuous glide ' + z.tp);
   while (z.tp < TP_STEPS) z.wheel(IN * 0.05);
   // at the closest distance: small pushes do not enter until the detent is passed
   z.wheel(IN * 0.3);
   assert.equal(z.bino, false);
   z.wheel(IN * 0.35);
   assert.equal(z.bino, true); assert.equal(z.zoom, 2);
   // jitter around the boundary never flips back and forth
   let flips = 0, was = z.bino;
   for (let i = 0; i < 200; i++) { z.wheel((i % 2 ? 1 : -1) * 0.25); if (z.bino !== was) { flips++; was = z.bino; } }
   assert.equal(flips, 0);
   // a deliberate push out leaves at the closest distance
   for (let i = 0; i < 12 && z.bino; i++) z.wheel(OUT * 0.1);
   assert.equal(z.bino, false); assert.equal(z.tp, TP_STEPS);
   // a pending half push fades when the user stops scrolling
   z.wheel(IN * 0.4);
   settle(z, 0.7);
   z.wheel(IN * 0.4);
   assert.equal(z.bino, false);
});

test('Shift and wheel share one state', () => {
   const z = new ZoomLadder(L);
   z.wheel(OUT); z.wheel(OUT);
   const tpWide = z.tp;
   z.toggle();                                     // Shift in: last power (4x default)
   assert.equal(z.bino, true); assert.equal(z.zoom, 4);
   z.wheel(IN);                                    // 8x
   z.toggle();                                     // Shift out: back to the old distance
   assert.equal(z.bino, false); assert.equal(z.tp, tpWide);
   z.toggle();
   assert.equal(z.zoom, 8, 'Shift remembers the last power');
   z.wheel(OUT); z.wheel(OUT); z.wheel(OUT);       // 4x, 2x, out
   assert.equal(z.bino, false); assert.equal(z.tp, TP_STEPS, 'wheel exit lands at the closest view');
   z.wheel(IN);                                    // wheel entry always 2x
   assert.equal(z.zoom, 2);
   z.toggle(); z.toggle();
   assert.equal(z.zoom, 2);
});

test('distance ease: monotonic, no overshoot, settles within 0.3 s', () => {
   const z = new ZoomLadder(L);
   for (let i = 0; i < 6; i++) z.wheel(OUT);
   settle(z);
   for (const dir of [IN, OUT]) {
      for (let k = 0; k < TP_STEPS; k++) {
         const from = z.dist; z.wheel(dir); const to = z.distTarget;
         let prev = from, t = 0;
         while (t < 0.3) {
            z.update(1 / 60); t += 1 / 60;
            assert.ok((z.dist - prev) * (to - from) >= -1e-9, 'monotonic');
            assert.ok((z.dist - to) * (from - to) >= -1e-9, 'no overshoot');
            prev = z.dist;
         }
         assert.ok(Math.abs(Math.log(z.dist / to)) < 0.01, 'settled ' + z.dist + ' vs ' + to);
         settle(z);
      }
   }
   // fast repeated notches re-target without overshoot
   const from = z.dist;
   for (let i = 0; i < 5; i++) { z.wheel(IN); z.update(1 / 60); z.update(1 / 60); }
   const to = z.distTarget;
   let prev = z.dist;
   for (let i = 0; i < 60; i++) {
      z.update(1 / 60);
      assert.ok(z.dist <= prev + 1e-9 && z.dist >= to - 1e-9);
      prev = z.dist;
   }
   assert.ok(from > to);
});

test('reset returns to the default view', () => {
   const z = new ZoomLadder(L);
   const d0 = z.dist, tp0 = z.tp;
   z.wheel(IN * 20); z.toggle(); z.wheel(OUT * 3); settle(z);
   z.reset(L);
   assert.equal(z.bino, false); assert.equal(z.tp, tp0); assert.equal(z.dist, d0); assert.equal(z.zoom, 4); assert.equal(z.acc, 0);
   assert.equal(MAGS.length, 4);
});
