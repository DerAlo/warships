// game3d/utils.js — math, RNG, geometry helpers (3D-mode fork: adds island/hull geometry).
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

// ---------- 3D-mode geometry (islands, hulls, ballistics) ----------
// Truncated gaussian in [-1, 1]: WoWs-style dispersion draws N(0,1) truncated at +-sigma and
// scales that window onto the max dispersion radius -- higher sigma = tighter centre grouping.
export function truncGauss(rng, sigma) {
   for (let i = 0; i < 8; i++) {
      let u = 0, w = 0;
      while (u === 0) u = rng();
      while (w === 0) w = rng();
      const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * w);
      if (Math.abs(g) <= sigma) return g / sigma;
   }
   return 0;
}

// Irregular island outline: `lobes` is an array of {a, r} sampled at equal angles (absolute
// metres). Renderer and sim both use obstacleRadiusAt so the visible coast = the collision coast.
// o.lobes (number) = how many harmonic bumps, o.elong/o.rot stretch it into a long island.
export function makeLobes(o, n = 64) {
   const rng = makeRng((o.seed || 1) * 7919 + 13);
   const bumps = Math.max(2, (typeof o.lobes === 'number' ? o.lobes : 5) | 0);
   const terms = [];
   for (let k = 0; k < bumps; k++) {
      terms.push({ f: 2 + Math.floor(rng() * (k + 3)), amp: (0.2 / (1 + k * 0.6)) * (0.5 + rng()), ph: rng() * TAU });
   }
   const el = o.elong || 1, rot = o.rot || 0;
   const out = [];
   for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      let m = 1;
      for (const t of terms) m += t.amp * Math.sin(a * t.f + t.ph);
      // elongation: ellipse radius in the island's rotated frame
      const ca = Math.cos(a - rot), sa = Math.sin(a - rot);
      const ell = el === 1 ? 1 : el / Math.sqrt(ca * ca + el * el * sa * sa);
      out.push({ a, r: Math.max(o.r * 0.35, o.r * m * ell) });
   }
   return out;
}
export function obstacleRadiusAt(o, a) {
   const L = o.lobes;
   if (!L || !L.length || typeof L === 'number') return o.r;
   const t = ((((a % TAU) + TAU) % TAU) / TAU) * L.length;
   const i = Math.floor(t) % L.length, j = (i + 1) % L.length, f = t - Math.floor(t);
   return L[i].r * (1 - f) + L[j].r * f;
}
// Normalised distance from the island centre: < 1 inside the coastline.
export function obstacleT(o, p) {
   const dx = p.x - o.c.x, dy = p.y - o.c.y;
   const d = Math.hypot(dx, dy);
   const rMax = o.rMax || o.r * 1.6;
   if (d > rMax * 1.05) return d / rMax;
   return d / obstacleRadiusAt(o, Math.atan2(dy, dx));
}
// Terrain height (m) of an island at p: smooth dome that reaches 0 exactly at the coastline.
export function islandHeightAt(o, p) {
   if (o.kind !== 'island') return 0;
   const t = obstacleT(o, p);
   if (t >= 1) return 0;
   return (o.height || 150) * Math.pow(1 - t * t, 0.8);
}

// Ship-local frame: +x = bow, +y = starboard (sim +y side when heading east).
export function toLocal(ship, p) {
   const dx = p.x - ship.pos.x, dy = p.y - ship.pos.y;
   const c = Math.cos(ship.heading), s = Math.sin(ship.heading);
   return { x: dx * c + dy * s, y: -dx * s + dy * c };
}
export function toWorld(ship, off) {
   const c = Math.cos(ship.heading), s = Math.sin(ship.heading);
   return { x: ship.pos.x + off.x * c - off.y * s, y: ship.pos.y + off.x * s + off.y * c };
}
// Half-beam of a hull at local x: parallel midbody, tapering to a narrow bow / fuller stern.
export function halfBeamAt(hull, lx) {
   const u = Math.abs(lx) / (hull.L / 2);
   if (u >= 1) return 0;
   const b = hull.beam / 2;
   if (u < 0.4) return b;
   const k = (u - 0.4) / 0.6;
   return b * (1 - (lx > 0 ? 0.85 : 0.6) * Math.pow(k, 1.6));
}
export function insideHull(hull, lp, margin = 0) {
   if (Math.abs(lp.x) > hull.L / 2 + margin) return false;
   return Math.abs(lp.y) <= halfBeamAt(hull, lp.x) + margin;
}
