// Unit tests for the pure lead-marker logic (game3d/lead3d.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveLead, solveIntercept, leadState, edgeClamp, pickTarget } from '../game3d/lead3d.js';

const FRAME = { l: 36, t: 100, r: 36, b: 250 };
const W = 1440, H = 810;
const inside = (o) => o.x >= FRAME.l - 1e-6 && o.x <= W - FRAME.r + 1e-6 && o.y >= FRAME.t - 1e-6 && o.y <= H - FRAME.b + 1e-6;

test('edgeClamp keeps a point inside the frame untouched', () => {
   const o = edgeClamp(700, 300, false, 0, W, H, FRAME, {});
   assert.deepEqual(o, { x: 700, y: 300, off: false, ang: 0 });
});

test('edgeClamp pushes off-screen points onto the frame border, arrow pointing outwards', () => {
   const right = edgeClamp(5000, H / 2, false, 1, W, H, FRAME, {});
   assert.equal(right.off, true);
   assert.ok(Math.abs(right.x - (W - FRAME.r)) < 1e-6);
   assert.ok(Math.abs(right.ang) < 0.05, 'arrow points right');
   const left = edgeClamp(-900, 380, false, -1, W, H, FRAME, {});
   assert.ok(Math.abs(left.x - FRAME.l) < 1e-6);
   assert.ok(Math.abs(Math.abs(left.ang) - Math.PI) < 0.1, 'arrow points left');
   const up = edgeClamp(W / 2, -4000, false, 0, W, H, FRAME, {});
   assert.ok(Math.abs(up.y - FRAME.t) < 1e-6);
   assert.ok(Math.abs(up.ang + Math.PI / 2) < 1e-6, 'arrow points up');
   // on screen but under the HUD panels (bottom) counts as outside the frame
   const low = edgeClamp(W / 2, H - 40, false, 0, W, H, FRAME, {});
   assert.equal(low.off, true);
   assert.ok(Math.abs(low.y - (H - FRAME.b)) < 1e-6);
});

test('edgeClamp: a point behind the camera goes to the left / right edge by side', () => {
   const l = edgeClamp(123, 456, true, -5, W, H, FRAME, {});
   assert.equal(l.off, true);
   assert.ok(Math.abs(l.x - FRAME.l) < 1e-6);
   const r = edgeClamp(123, 456, true, 5, W, H, FRAME, {});
   assert.ok(Math.abs(r.x - (W - FRAME.r)) < 1e-6);
   assert.equal(r.ang, 0);
});

test('edgeClamp result is always finite and inside the frame', () => {
   const o = {};
   const vals = [-1e7, -500, 0, 36, 700, 1404, 1440, 9000, 1e7, NaN, Infinity, -Infinity];
   for (const [w, h] of [[1440, 810], [1920, 1080], [640, 360], [300, 200]]) {
      for (const x of vals) for (const y of vals) for (const behind of [false, true]) {
         edgeClamp(x, y, behind, x, w, h, FRAME, o);
         assert.ok(Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.ang), `finite for ${x},${y},${behind}`);
         const x1 = Math.max(FRAME.l + 1, w - FRAME.r), y1 = Math.max(FRAME.t + 1, h - FRAME.b);
         assert.ok(o.x >= FRAME.l - 1e-6 && o.x <= x1 + 1e-6 && o.y >= FRAME.t - 1e-6 && o.y <= y1 + 1e-6, `in frame for ${x},${y},${behind} @${w}x${h}`);
      }
   }
   assert.ok(inside(edgeClamp(720, 405, false, 0, W, H, FRAME, {})));
});

test('edgeClamp reuses the out object (no allocation)', () => {
   const o = { x: 0, y: 0, off: false, ang: 0, extra: 7 };
   assert.equal(edgeClamp(-50, -50, false, 0, W, H, FRAME, o), o);
   assert.equal(o.extra, 7);
});

test('solveLead: stationary target = target position, moving target is led by v * t', () => {
   const ft = (R) => R / 800;
   const a = solveLead(0, 0, 8000, 0, 0, 0, ft, {});
   assert.deepEqual([a.x, a.y, a.t], [8000, 0, 10]);
   const b = solveLead(0, 0, 8000, 0, 0, 20, ft, {});
   assert.equal(b.x, 8000);
   assert.ok(Math.abs(b.y - 20 * b.t) < 1e-9);
   assert.ok(Math.abs(b.t - Math.hypot(b.x, b.y) / 800) < 0.01, 'flight time consistent with the lead range');
});

test('solveIntercept: torpedo meets the target, impossible chase returns false', () => {
   const o = {};
   assert.equal(solveIntercept(0, 0, 4000, 0, 0, 15, 30, o), true);
   assert.ok(Math.abs(Math.hypot(o.x, o.y) - 30 * o.t) < 1e-6, 'torpedo run = speed * t');
   assert.ok(Math.abs(o.y - 15 * o.t) < 1e-9 && o.x === 4000);
   const keep = { x: 1, y: 2, t: 3 };
   assert.equal(solveIntercept(0, 0, 4000, 0, 40, 0, 30, keep), false, 'target runs away faster');
   assert.deepEqual(keep, { x: 1, y: 2, t: 3 });
   assert.equal(solveIntercept(0, 0, 4000, 0, -30, 0, 30, o), true, 'equal speeds, closing target (linear case)');
   assert.ok(Math.abs(o.t - 4000 / 60) < 1e-6);
   assert.equal(solveIntercept(0, 0, 4000, 0, 0, 30, 30, o), false, 'equal speeds, crossing target: never caught');
});

test('leadState', () => {
   assert.equal(leadState(true, 9000, 12000), 'ok');
   assert.equal(leadState(true, 12001, 12000), 'range');
   assert.equal(leadState(false, 9000, 12000), 'lost');
   assert.equal(leadState(false, 99000, 12000), 'lost');
});

test('pickTarget: nearest wins, the previous target is sticky, empty list = -1', () => {
   const c = [{ id: 1, score: 300 }, { id: 2, score: 250 }, { id: 3, score: 900 }];
   assert.equal(pickTarget(c, 3, null), 1);
   assert.equal(pickTarget(c, 3, 1), 0, 'previous target kept while about equally close');
   c[1].score = 100;
   assert.equal(pickTarget(c, 3, 1), 1, 'clearly closer candidate takes over');
   assert.equal(pickTarget(c, 0, 1), -1);
   assert.equal(pickTarget(c, 1, 3), 0, 'only the first n entries count');
});
