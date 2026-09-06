// game/utils.js — math, RNG, geometry helpers. Spec-independent foundation.
// All world units: meters, radians, m/s, seconds.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

// ---------- vector helpers (2D, {x,y}) ----------
export const v2 = (x = 0, y = 0) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = (a) => Math.hypot(a.x, a.y);
export const len2 = (a) => a.x * a.x + a.y * a.y;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };
export const norm = (a) => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };
export const fromAngle = (a, l = 1) => ({ x: Math.cos(a) * l, y: Math.sin(a) * l });
export const angleOf = (a) => Math.atan2(a.y, a.x);
export const lerpVec = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------- scalar helpers ----------
export const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;
export const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
export const lerpClamped = (a, b, t) => a + (b - a) * clamp01(t);
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };
export const approach = (cur, target, step) =>
   cur < target ? Math.min(cur + step, target) : cur > target ? Math.max(cur - step, target) : cur;
export const approachAngle = (cur, target, step) => {
   let d = angleDelta(cur, target);
   if (Math.abs(d) <= step) return target;
   return cur + Math.sign(d) * step;
};
export const angleDelta = (a, b) => {
   let d = (b - a) % TAU;
   if (d < -Math.PI) d += TAU;
   if (d > Math.PI) d -= TAU;
   return d;
};
export const lerpAngle = (a, b, t) => a + angleDelta(a, b) * clamp01(t);

// ---------- geometry ----------
// Smallest distance from point p to segment ab.
export function pointSegDist(p, a, b) {
   const abx = b.x - a.x, aby = b.y - a.y;
   const apx = p.x - a.x, apy = p.y - a.y;
   const l2 = abx * abx + aby * aby || 1e-6;
   let t = (apx * abx + apy * aby) / l2;
   t = clamp01(t);
   const cx = a.x + abx * t, cy = a.y + aby * t;
   return Math.hypot(p.x - cx, p.y - cy);
}
export function angleOfSeg(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }
// Is point inside a convex-ish polygon? (ray cast) — used for citadel/hull hit tests.
export function pointInPoly(p, poly) {
   let inside = false;
   for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const hit = (yi > p.y) !== (yj > p.y) &&
         p.x < ((xj - xi) * (p.y - yi)) / (yj - yi || 1e-6) + xi;
      if (hit) inside = !inside;
   }
   return inside;
}
// Intersection of segment p1p2 with circle center c radius r; returns nearest t in [0,1] or null.
export function segCircle(p1, p2, c, r) {
   const d = sub(p2, p1);
   const f = sub(p1, c);
   const a = dot(d, d);
   const b = 2 * dot(f, d);
   const cc = dot(f, f) - r * r;
   let disc = b * b - 4 * a * cc;
   if (disc < 0) return null;
   disc = Math.sqrt(disc);
   const t1 = (-b - disc) / (2 * a);
   if (t1 >= 0 && t1 <= 1) return t1;
   return null;
}

// ---------- misc ----------
export const now = () => (performance.now() / 1000); // seconds
export const rand = (a = 1, b = 1) => a + Math.random() * (b - a); // uniform [a,b)
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const chance = (p) => Math.random() < p;

// Gaussian-ish (Box-Muller) for shell dispersion.
export function randn() {
   let u = 0, w = 0;
   while (u === 0) u = Math.random();
   while (w === 0) w = Math.random();
   return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * w);
}

// Deterministic small PRNG (mulberry32) for repeatable test scenarios.
export function makeRng(seed) {
   let a = seed >>> 0;
   return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
   };
}

// fixed-point-ish formatting
export const fmt = (n, d = 0) => Number(n).toFixed(d);
export const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(Math.round(n));

// Screen shake accumulation
export class Shake {
   constructor() { this.x = 0; this.y = 0; this.mag = 0; this.life = 0; this.max = 0; }
   add(m) { this.mag = Math.max(this.mag, m); if (this.mag > 0.001) { this.life = 0.4; this.max = this.mag; } }
   update(dt) {
      if (this.life <= 0) { this.mag = 0; this.x = 0; this.y = 0; return; }
      this.life -= dt;
      const k = this.life > 0 ? smoothstep(this.life / 0.4) : 0;
      const m = this.mag * k;
      this.x = Math.cos(now() * 90) * m * (Math.random() - 0.5) * 2;
      this.y = Math.sin(now() * 80) * m * (Math.random() - 0.5) * 2;
      if (this.life <= 0) this.mag = 0;
   }
}

// Object pool for particles / effects.
export class Pool {
   constructor(factory, reset) { this.factory = factory; this.reset = reset; this.free = []; this.active = []; }
   obtain() {
      const o = this.free.pop() || this.factory();
      this.active.push(o);
      return o;
   }
   release(o) {
      const i = this.active.indexOf(o);
      if (i >= 0) { this.active.splice(i, 1); this.reset(o); this.free.push(o); }
   }
   clear() { for (const o of this.active) this.reset(o); this.free.push(...this.active); this.active.length = 0; }
}
