// gamev2/air3d.js — aircraft in the 3D view of the modern mode: carrier jets and ship helicopters.
// Every aircraft is one instance of a small merged mesh; there is one InstancedMesh per airframe
// (hornet, flanker, stealth, helo) and only the ones in use are drawn, so a scene costs 1-4 draw
// calls for all aircraft. Falling bombs are a further instanced mesh and shot-down aircraft another
// (smoke trail, splash on impact). No shadows: they fly hundreds of metres up.
// Reads world.squadrons / world.bombs / 'planeDown' effects; squads carry render positions
// sq.rx / ry / ralt / rh set by main3d's interpolation (falls back to the sim position).
//
// ---- contract: squadron fields this file reads ------------------------------------------------
//   sq.n, sq.visible, sq.pos {x, y}, sq.alt, sq.heading, sq.speed, sq.id   as in the WW2 game
//   sq.want       optional wanted heading (banks into the turn), sq.prev.alt optional (pitch)
//   sq.kind       'fighter' | 'strike' | 'helo'      what the flight does (see airKind)
//   sq.type       fallback when kind is missing: 'ft' -> fighter, 'tb' / 'db' -> strike,
//                 'helo' / 'heli' / 'asw' -> helo; anything unknown counts as strike
//   sq.nation     'us' | 'ru' | 'cn' | 'uk' | 'de' | 'ir'; missing -> the nation of the owning
//                 ship (world.shipById(sq.ownerId).cfg.hull.nation); unknown -> western grey
//   sq.model      optional explicit airframe: one of the AIR_MODELS keys ('fa18', 'f35', 'su33',
//                 'mig29k', 'j15', 'helo') — wins over the nation / kind table below
//   sq.armed      strike aircraft and helicopters show their ordnance while armed > 0 (or true,
//                 or undefined); fighters always carry their missiles
// Airframe chosen when sq.model is not set (airModelFor):
//   helo -> 'helo' for every nation
//   us: fighter -> 'f35' (F-35C), strike -> 'fa18' (F/A-18E)      uk: 'f35'
//   ru: fighter -> 'su33', strike -> 'mig29k'                      cn: 'j15'      ir: 'mig29k'
//   anything else -> 'fa18'
// Model-local axes: x toward the nose, y up, z to starboard; sizes in metres, drawn SCALE times
// larger than life so a pair of jets still reads at 3-5 km.
import * as THREE from '../vendor/three/three.module.min.js';
import { patchAtmosphere } from './gfxcommon3d.js';
import { GFX } from './gfxquality.js';

const MAX_PER_MODEL = 96, MAX_WRECKS = 32, MAX_BOMBS = 48;
const SCALE = 1.4;
// formation slots (local: x ahead, z right) for up to 8 aircraft: a V, then a second V behind
const SLOT = [[0, 0], [-34, -30], [-34, 30], [-68, -60], [-68, 60], [-102, -90], [-102, 90], [-136, 0]];
const MESHES = ['hornet', 'flanker', 'stealth', 'helo'];
export const AIR_MODELS = {
   fa18: { mesh: 'hornet', scale: 1, name: 'F/A-18E Super Hornet' },
   f35: { mesh: 'stealth', scale: 1, name: 'F-35C Lightning II' },
   su33: { mesh: 'flanker', scale: 1, name: 'Su-33' },
   j15: { mesh: 'flanker', scale: 1, name: 'J-15' },
   mig29k: { mesh: 'flanker', scale: 0.82, name: 'MiG-29K' },
   helo: { mesh: 'helo', scale: 1, name: 'Bordhubschrauber' },
};
const ALIAS = { hornet: 'fa18', f18: 'fa18', 'f/a-18e': 'fa18', fa18e: 'fa18', f35c: 'f35', stealth: 'f35', flanker: 'su33', su27: 'su33', mig29: 'mig29k', heli: 'helo', helicopter: 'helo' };
const NATION_IDX = { us: 0, ru: 1, su: 1, cn: 2, uk: 3, de: 4, ir: 5 };
const JET_COL = { us: 0x8b939b, ru: 0x6f8799, cn: 0x8f959a, uk: 0x7d858c, de: 0x7c878b, ir: 0x9c9379 };
const HELO_COL = { us: 0x7b8389, ru: 0x5f717d, cn: 0xa3a9ab, uk: 0x6f787e, de: 0x6c777d, ir: 0x8f8b78 };

export function airKind(sq) {
   const k = String(sq?.kind ?? '').toLowerCase();
   if (k === 'fighter' || k === 'strike' || k === 'helo') return k;
   const t = String(sq?.type ?? '').toLowerCase();
   if (t === 'ft' || t === 'fighter' || t === 'cap') return 'fighter';
   if (t === 'helo' || t === 'heli' || t === 'asw' || k === 'heli' || k === 'asw') return 'helo';
   return 'strike';
}
// AIR_MODELS key for a squadron; nation is the fallback when the squadron carries none
export function airModelFor(sq, nation = null) {
   const m = String(sq?.model ?? '').toLowerCase();
   if (AIR_MODELS[m]) return m;
   if (ALIAS[m]) return ALIAS[m];
   const kind = airKind(sq);
   if (kind === 'helo') return 'helo';
   switch (sq?.nation || nation) {
      case 'us': return kind === 'fighter' ? 'f35' : 'fa18';
      case 'uk': return 'f35';
      case 'ru': case 'su': return kind === 'fighter' ? 'su33' : 'mig29k';
      case 'cn': return 'j15';
      case 'ir': return 'mig29k';
      default: return 'fa18';
   }
}
export function airColor(model, nation) {
   if (model === 'helo') return HELO_COL[nation] ?? 0x7a8287;
   if (model === 'f35') return nation === 'uk' ? 0x6a7178 : 0x666d75;
   return JET_COL[nation] ?? 0x868d93;
}

// ---- geometry: flat-shaded triangle soup with a part id per vertex ----
// part: 0 airframe, 2 canopy, 3 dark (intakes, nozzles), 4 / 5 insignia ring / centre, 6 main rotor
// disc, 7 / 8 port / starboard light, 9 ordnance (gone once dropped), 10 engine glow, 11 tail rotor
class AB {
   constructor() { this.p = []; this.n = []; this.part = []; }
   // triangle facing away from ref
   tri(a, b, c, part, ref) {
      let ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-9) return;
      nx /= l; ny /= l; nz /= l;
      if (ref && nx * ((a[0] + b[0] + c[0]) / 3 - ref[0]) + ny * ((a[1] + b[1] + c[1]) / 3 - ref[1]) + nz * ((a[2] + b[2] + c[2]) / 3 - ref[2]) < 0) {
         const t = b; b = c; c = t; nx = -nx; ny = -ny; nz = -nz;
      }
      this.p.push(...a, ...b, ...c);
      this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      this.part.push(part, part, part);
   }
   quad(a, b, c, d, part, ref) { this.tri(a, b, c, part, ref); this.tri(a, c, d, part, ref); }
   // convex plan polygon [[x, z], ...] as a plate of thickness t at height y (+ dih per metre of |z|)
   plate(pts, y, t, part = 0, dih = 0, edges = true) {
      const n = pts.length;
      let cx = 0, cz = 0;
      for (const q of pts) { cx += q[0] / n; cz += q[1] / n; }
      const yy = (q) => y + Math.abs(q[1]) * dih;
      const ref = [cx, y + Math.abs(cz) * dih, cz];
      const top = pts.map(q => [q[0], yy(q) + t / 2, q[1]]), bot = pts.map(q => [q[0], yy(q) - t / 2, q[1]]);
      for (let i = 1; i < n - 1; i++) { this.tri(top[0], top[i], top[i + 1], part, ref); this.tri(bot[0], bot[i], bot[i + 1], part, ref); }
      if (edges) for (let i = 0; i < n; i++) { const j = (i + 1) % n; this.quad(top[i], top[j], bot[j], bot[i], part, ref); }
   }
   // the same plate on both sides of the centreline (pts given for starboard, z > 0)
   wings(pts, y, t, part = 0, dih = 0, edges = true) {
      this.plate(pts, y, t, part, dih, edges);
      this.plate(pts.map(q => [q[0], -q[1]]), y, t, part, dih, edges);
   }
   // upright plate [[x, y], ...] at z, leaning outboard by cant (radians) about its root
   fin(pts, z, t, cant = 0, part = 0, edges = true) {
      const n = pts.length, y0 = Math.min(...pts.map(q => q[1])), sg = z < 0 ? -1 : 1, tc = Math.tan(cant);
      let cx = 0, cy = 0;
      for (const q of pts) { cx += q[0] / n; cy += q[1] / n; }
      const zz = (q) => z + sg * (q[1] - y0) * tc;
      const ref = [cx, cy, z + sg * (cy - y0) * tc];
      const a = pts.map(q => [q[0], q[1], zz(q) + t / 2]), b = pts.map(q => [q[0], q[1], zz(q) - t / 2]);
      for (let i = 1; i < n - 1; i++) { this.tri(a[0], a[i], a[i + 1], part, ref); this.tri(b[0], b[i], b[i + 1], part, ref); }
      if (edges) for (let i = 0; i < n; i++) { const j = (i + 1) % n; this.quad(a[i], a[j], b[j], b[i], part, ref); }
   }
   // body lofted through elliptical sections [x, halfWidth, halfHeight, yCentre], nose first
   loft(secs, part = 0, seg = 8, z = 0, flatBelly = 1) {
      const ring = (s) => {
         const r = [];
         for (let k = 0; k < seg; k++) {
            const a = (k + 0.5) / seg * Math.PI * 2, sn = Math.sin(a);
            r.push([s[0], s[3] + (sn < 0 ? sn * flatBelly : sn) * s[2], z + Math.cos(a) * s[1]]);
         }
         return r;
      };
      const R = secs.map(ring);
      for (let i = 0; i < R.length - 1; i++) {
         const ref = [(secs[i][0] + secs[i + 1][0]) / 2, (secs[i][3] + secs[i + 1][3]) / 2, z];
         for (let k = 0; k < seg; k++) { const j = (k + 1) % seg; this.quad(R[i][k], R[i][j], R[i + 1][j], R[i + 1][k], part, ref); }
      }
      for (const e of [0, R.length - 1]) {
         const s = secs[e];
         if (s[1] < 0.12) continue;   // pointed end: no cap needed
         const ref = [s[0] + (e ? 1 : -1), s[3], z];
         for (let k = 1; k < seg - 1; k++) this.tri(R[e][0], R[e][k], R[e][k + 1], part, ref);
      }
   }
   box(w, h, d, x, y, z, part = 0) {
      const X = [x - w / 2, x + w / 2], Y = [y - h / 2, y + h / 2], Z = [z - d / 2, z + d / 2], ref = [x, y, z];
      const v = (i, j, k) => [X[i], Y[j], Z[k]];
      this.quad(v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0), part, ref); this.quad(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1), part, ref);
      this.quad(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0), part, ref); this.quad(v(1, 0, 0), v(1, 0, 1), v(1, 1, 1), v(1, 1, 0), part, ref);
      this.quad(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1), part, ref); this.quad(v(0, 1, 0), v(1, 1, 0), v(1, 1, 1), v(0, 1, 1), part, ref);
   }
   // flat disc (single-sided; the material is double-sided); axis 'x' | 'y' | 'z' is its normal
   disc(r, x, y, z, axis, part, seg = 10) {
      const pt = (k) => {
         const a = k / seg * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
         return axis === 'y' ? [x + c, y, z + s] : axis === 'x' ? [x, y + c, z + s] : [x + c, y + s, z];
      };
      const ref = axis === 'y' ? [x, y - 1, z] : axis === 'x' ? [x + 1, y, z] : [x, y, z - Math.sign(z || 1)];
      for (let k = 0; k < seg; k++) this.tri([x, y, z], pt(k), pt(k + 1), part, ref);
   }
   // slim store along x (missile / torpedo / tank)
   store(r, len, x, y, z, seg = 4) { this.loft([[x + len / 2, 0.02, 0.02, y], [x + len / 2 - r * 3, r, r, y], [x - len / 2, r, r, y]], 9, seg, z); }
   build(scale) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n), 3));
      g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(this.part), 1));
      g.scale(scale, scale, scale);
      g.userData.tris = this.p.length / 9;
      return g;
   }
}
// insignia on both wings (top) and both flanks, plus wingtip lights
function insignia(b, wx, wy, wz, r, fx, fy, fz, tx, ty, tz) {
   for (const s of [1, -1]) {
      b.disc(r, wx, wy + 0.02, s * wz, 'y', 4, 8); b.disc(r * 0.55, wx, wy + 0.05, s * wz, 'y', 5, 8);
      b.disc(r * 0.8, fx, fy, s * fz, 'z', 4, 8); b.disc(r * 0.45, fx, fy, s * (fz + 0.03), 'z', 5, 8);
      b.box(0.3, 0.14, 0.22, tx, ty, s * tz, s > 0 ? 8 : 7);
   }
}
const BUILD = {
   // F/A-18E: long nose, big leading-edge extensions, moderately swept wing, twin canted fins
   hornet(b, lo) {
      const sg = lo ? 4 : 8, e = !lo;
      b.loft(lo ? [[9.2, 0.05, 0.05, 0], [4.5, 0.8, 0.85, 0.15], [-3, 1.5, 0.8, 0], [-8.8, 1.0, 0.5, 0]]
         : [[9.2, 0.05, 0.05, 0], [7.2, 0.42, 0.46, 0.05], [4.5, 0.75, 0.85, 0.15], [1.5, 1.15, 0.9, 0.1], [-3, 1.5, 0.8, 0], [-7.5, 1.3, 0.62, 0], [-8.6, 1.05, 0.5, 0]], 0, sg, 0, 0.75);
      b.wings([[5.4, 0.55], [0.6, 2.1], [0.6, 0.9]], 0.3, 0.12, 0, 0, false);             // LERX
      b.wings([[1.0, 1.2], [-0.9, 6.8], [-2.3, 6.8], [-3.5, 1.2]], 0.25, 0.2, 0, 0, e);
      b.wings([[-5.6, 1.2], [-7.7, 3.7], [-8.9, 3.7], [-8.5, 1.2]], 0.1, 0.14, 0, -0.03, e);
      for (const s of [1, -1]) b.fin([[-3.7, 0.55], [-6.3, 3.7], [-7.6, 3.7], [-7.3, 0.55]], s * 1.1, 0.14, 0.34, 0, e);
      if (lo) { b.box(2.4, 0.5, 0.7, 4.0, 0.95, 0, 2); return; }
      b.loft([[5.8, 0.05, 0.05, 0.75], [4.7, 0.4, 0.42, 0.82], [3.1, 0.42, 0.4, 0.88], [1.5, 0.1, 0.1, 0.8]], 2, 6);
      for (const s of [1, -1]) {
         b.box(0.25, 0.75, 0.85, 2.3, -0.3, s * 1.15, 3);                                  // intake mouth
         b.loft([[-8.5, 0.52, 0.52, 0], [-9.5, 0.44, 0.44, 0]], 3, 8, s * 0.62);
         b.disc(0.4, -9.52, 0, s * 0.62, 'x', 10, 8);
         b.store(0.16, 3.4, -1.4, -0.12, s * 4.2); b.store(0.13, 2.8, -1.7, 0.25, s * 6.95);
      }
      b.store(0.36, 5.2, -1.2, -0.95, 0, 6);                                               // centreline tank
      insignia(b, -1.3, 0.36, 4.3, 0.55, 3.2, 0.25, 0.98, -1.7, 0.27, 6.8);
   },
   // Su-33 / J-15 (and, scaled down, MiG-29K): drooped nose and humped cockpit ahead of a flat
   // lifting body, two widely spaced engine nacelles underneath, canards, twin upright fins, a
   // tail sting between the nozzles
   flanker(b, lo) {
      const sg = lo ? 4 : 8, e = !lo;
      b.loft(lo ? [[10.8, 0.05, 0.05, 0.1], [5.6, 0.7, 0.95, 0.7], [-1, 0.6, 0.5, 0.55], [-10.6, 0.15, 0.15, 0.4]]
         : [[10.8, 0.05, 0.05, 0.1], [8.2, 0.46, 0.5, 0.4], [5.6, 0.7, 0.95, 0.72], [2.6, 0.75, 0.8, 0.7], [-1, 0.6, 0.5, 0.55], [-7, 0.34, 0.3, 0.42], [-10.6, 0.14, 0.14, 0.4]], 0, sg);
      b.plate([[6.2, 0.45], [2.4, 2.3], [-6.6, 2.3], [-6.6, -2.3], [2.4, -2.3], [6.2, -0.45]], 0.35, 0.45, 0, 0, e);   // LERX + centre body
      b.wings([[1.6, 2.3], [-3.7, 7.35], [-5.1, 7.35], [-5.7, 2.3]], 0.38, 0.2, 0, 0, e);
      b.wings([[-6.3, 2.3], [-8.7, 4.9], [-9.9, 4.9], [-9.5, 2.3]], 0.2, 0.14, 0, 0, e);
      for (const s of [1, -1]) b.fin([[-4.6, 0.55], [-7.5, 4.5], [-8.9, 4.5], [-8.7, 0.55]], s * 2.2, 0.16, 0, 0, e);
      if (lo) { b.box(12, 1.0, 4.2, -2.9, -0.35, 0, 0); return; }   // both nacelles as one slab
      for (const s of [1, -1]) b.loft([[3.1, 0.6, 0.55, -0.4], [-2, 0.76, 0.7, -0.4], [-7, 0.72, 0.7, -0.25], [-8.8, 0.58, 0.58, -0.2]], 0, 8, s * 1.5);
      b.wings([[5.3, 1.0], [3.7, 3.1], [3.0, 3.1], [3.2, 1.0]], 0.62, 0.1, 0, 0, false);   // canards
      b.loft([[6.6, 0.05, 0.05, 1.5], [5.4, 0.42, 0.42, 1.62], [3.6, 0.44, 0.42, 1.6], [1.8, 0.1, 0.1, 1.35]], 2, 6);
      for (const s of [1, -1]) {
         b.box(0.2, 0.9, 1.0, 3.18, -0.42, s * 1.5, 3);
         b.loft([[-8.8, 0.6, 0.6, -0.2], [-9.9, 0.5, 0.5, -0.2]], 3, 8, s * 1.5);
         b.disc(0.45, -9.92, -0.2, s * 1.5, 'x', 10, 8);
         b.store(0.17, 3.8, -2.6, 0.02, s * 4.4); b.store(0.14, 3.0, -4.0, 0.1, s * 6.4); b.store(0.14, 2.9, -4.3, 0.38, s * 7.5);
      }
      b.store(0.3, 5.6, -1.5, -0.55, 0, 6);                                                // heavy anti-ship missile on the centreline
      insignia(b, -2.6, 0.5, 5.0, 0.6, -6.7, 2.6, 2.3, -4.4, 0.4, 7.35);
   },
   // F-35C: short deep body, chined nose, big wing, canted fins, one engine, nothing hung outside
   stealth(b, lo) {
      const sg = lo ? 4 : 8, e = !lo;
      b.loft(lo ? [[7.8, 0.05, 0.05, 0], [3.5, 1.1, 0.95, 0.15], [-4, 1.5, 0.85, 0.05], [-6.8, 0.8, 0.6, 0.05]]
         : [[7.8, 0.05, 0.05, 0], [6.1, 0.62, 0.48, 0.1], [3.5, 1.1, 0.95, 0.15], [0, 1.65, 1.0, 0.1], [-4, 1.5, 0.85, 0.05], [-6.7, 0.8, 0.62, 0.05]], 0, sg, 0, 0.8);
      b.wings([[2.2, 1.5], [-1.7, 6.55], [-2.9, 6.55], [-4.1, 1.5]], 0.2, 0.22, 0, 0, e);
      b.wings([[-4.1, 1.4], [-6.7, 4.0], [-7.9, 3.9], [-7.3, 1.4]], 0.12, 0.14, 0, 0, e);
      for (const s of [1, -1]) b.fin([[-2.6, 0.7], [-5.3, 3.4], [-6.5, 3.4], [-6.7, 0.7]], s * 1.3, 0.14, 0.42, 0, e);
      if (lo) { b.box(2.2, 0.5, 0.8, 3.6, 1.05, 0, 2); return; }
      b.wings([[5.6, 0.6], [2.2, 1.9], [2.2, 0.9]], 0.2, 0.1, 0, 0, false);                // chine
      b.loft([[5.9, 0.05, 0.05, 0.75], [4.8, 0.45, 0.42, 0.9], [3.2, 0.46, 0.4, 0.98], [1.9, 0.1, 0.1, 0.9]], 2, 6);
      for (const s of [1, -1]) b.box(0.25, 0.8, 0.7, 2.6, 0.1, s * 1.45, 3);
      b.loft([[-6.6, 0.66, 0.66, 0.05], [-7.7, 0.55, 0.55, 0.05]], 3, 8);
      b.disc(0.5, -7.72, 0.05, 0, 'x', 10, 8);
      insignia(b, -1.5, 0.33, 4.0, 0.5, 3.4, 0.3, 1.12, -2.3, 0.2, 6.55);
   },
   // ship helicopter (Seahawk / Ka-27 sized): the rotor hub sits on the model origin in x / z so the
   // fragment shader can paint turning blades from the local position
   helo(b, lo) {
      const sg = lo ? 4 : 8, e = !lo;
      b.loft(lo ? [[6.4, 0.1, 0.15, -0.3], [4.6, 1.05, 1.0, -0.05], [-2.6, 1.15, 1.1, 0], [-10.6, 0.18, 0.25, 0.9]]
         : [[6.4, 0.1, 0.15, -0.35], [5.3, 0.85, 0.75, -0.15], [3.2, 1.15, 1.15, 0], [-2.6, 1.15, 1.1, 0], [-4.6, 0.5, 0.55, 0.42], [-10.6, 0.18, 0.25, 0.9]], 0, sg);
      b.fin([[-9.5, 0.8], [-11.3, 3.5], [-12.1, 3.5], [-10.9, 0.8]], 0, 0.2, 0, 0, e);
      b.box(4.6, 0.75, 1.5, -0.2, 1.4, 0, 0);                                              // engine fairing
      b.disc(8.2, 0, 2.3, 0, 'y', 6, lo ? 10 : 16);
      b.disc(1.6, -11.6, 3.1, 0.32, 'z', 11, lo ? 6 : 10);
      if (lo) { b.box(1.3, 0.6, 1.5, 4.7, 0.5, 0, 2); return; }
      b.loft([[5.9, 0.1, 0.1, 0.25], [5.0, 0.8, 0.5, 0.42], [3.6, 0.95, 0.5, 0.6], [3.0, 0.3, 0.2, 0.9]], 2, 6);
      b.box(0.5, 0.6, 0.5, 0, 1.95, 0, 3);                                                 // rotor mast
      b.plate([[-9.4, -1.6], [-9.4, 1.6], [-10.4, 1.6], [-10.4, -1.6]], 1.0, 0.1, 0, 0, false);
      for (const s of [1, -1]) {
         b.box(1.0, 0.8, 0.35, 2.2, -1.25, s * 1.25, 3);                                   // main wheels
         b.box(0.3, 0.14, 0.22, 1.0, 0.2, s * 1.2, s > 0 ? 8 : 7);
         b.disc(0.42, -6.5, 0.75, s * 0.4, 'z', 4, 8); b.disc(0.22, -6.5, 0.75, s * 0.43, 'z', 5, 8);
      }
      b.store(0.17, 2.7, 0.2, -0.75, 1.42);                                                // lightweight torpedo
      b.store(0.17, 2.7, 0.2, -0.75, -1.42);
   },
};
function modelGeometry(name, lo, scale = SCALE) {
   const b = new AB();
   BUILD[name](b, lo);
   return b.build(scale);
}
const AIR_SHADER = {
   key: 'air-v2',
   vertexPars: 'attribute float aPart;\nattribute vec3 aInst;\nvarying float vPart;\nvarying vec3 vRot;',
   vertexMain: `
      vPart = aPart;
      vRot = vec3(position.xz, aInst.z);
      if (aPart > 8.5 && aPart < 9.5 && aInst.y < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // ordnance gone
      vec3 pc = vColor;
      if (aPart < 0.5) pc = mix(pc, pc * 1.18 + 0.03, smoothstep(0.35, 0.8, -objectNormal.y) * 0.6);   // lighter belly
      else if (aPart < 2.5) pc = vec3(0.16, 0.13, 0.07);                                              // tinted canopy
      else if (aPart < 3.5) pc *= 0.3;
      else if (aPart < 5.5) {
         bool inner = aPart > 4.5;
         vec3 W = vec3(0.72), R = vec3(0.5, 0.03, 0.03), Bl = vec3(0.03, 0.06, 0.2);
         float nt = aInst.x;
         if (nt < 0.5) pc = inner ? vColor * 0.55 : vColor * 0.4;             // us: low-visibility grey
         else if (nt < 1.5) pc = inner ? R : W;                                // ru
         else if (nt < 2.5) pc = inner ? vec3(0.75, 0.6, 0.05) : R;            // cn
         else if (nt < 3.5) pc = inner ? R * 0.8 : Bl;                         // uk
         else if (nt < 4.5) pc = inner ? vec3(0.03) : W;                       // de
         else if (nt < 5.5) pc = inner ? R : vec3(0.05, 0.35, 0.1);            // ir
         else pc = vColor * 0.5;
      }
      else if (aPart < 6.5) pc = vec3(0.05);
      else if (aPart < 7.5) pc = vec3(0.7, 0.02, 0.02);
      else if (aPart < 8.5) pc = vec3(0.02, 0.6, 0.1);
      else if (aPart < 9.5) pc = vec3(0.62, 0.64, 0.66);
      else if (aPart < 10.5) pc = vec3(1.0, 0.45, 0.12);
      else pc = vec3(0.05);
      vColor = pc;`,
   fragmentPars: 'varying float vPart;\nvarying vec3 vRot;\nfloat airHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
   fragmentReplace: [
      // rotors are dithered blur discs; the main one carries four darker, slowly wandering blades
      ['#include <color_fragment>', `#include <color_fragment>
         if (vPart > 5.5 && vPart < 6.5) {
            float ang = atan(vRot.y, vRot.x) + vRot.z;
            float blade = smoothstep(0.34, 0.5, abs(fract(ang * 0.63662) - 0.5));
            if (airHash(gl_FragCoord.xy) > mix(0.12, 0.7, blade)) discard;
         } else if (vPart > 10.5 && airHash(gl_FragCoord.xy) > 0.3) discard;`],
      ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
         if (vPart > 6.5 && vPart < 8.5) totalEmissiveRadiance += diffuseColor.rgb * 2.5;
         else if (vPart > 9.5 && vPart < 10.5) totalEmissiveRadiance += diffuseColor.rgb * 1.6;`],
   ],
};

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YZX');
const _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color();

export class AirModels {
   constructor(scene, fx) {
      this.fx = fx;
      this.fine = GFX.detail >= 2;
      // one material for every airframe (double-sided: plates and rotor discs are seen from both sides)
      const mat = patchAtmosphere(new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide }), AIR_SHADER);
      this.meshes = {};
      this.list = [];
      for (const name of MESHES) {
         const M = new THREE.InstancedMesh(modelGeometry(name, !this.fine), mat, MAX_PER_MODEL);
         M.userData.inst = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_MODEL * 3), 3);   // nation, armed, rotor phase
         M.userData.inst.setUsage(THREE.DynamicDrawUsage);
         M.geometry.setAttribute('aInst', M.userData.inst);
         M.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
         M.setColorAt(0, _c.set(0xffffff));
         M.instanceColor.setUsage(THREE.DynamicDrawUsage);
         M.count = 0; M.visible = false; M.frustumCulled = false;
         M.userData.k = 0; M.userData.name = name;
         this.meshes[name] = M;
         this.list.push(M);
         scene.add(M);
      }
      this.planes = this.meshes.hornet;   // legacy handle
      const wmat = patchAtmosphere(new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.9, metalness: 0.1, side: THREE.DoubleSide }), { key: 'air' });
      this.wreckMesh = new THREE.InstancedMesh(modelGeometry('hornet', true), wmat, MAX_WRECKS);
      this.wreckMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.wreckMesh.count = 0;
      this.wreckMesh.frustumCulled = false;
      const bg = new THREE.CylinderGeometry(0.35, 0.35, 3.2, 6).rotateZ(Math.PI / 2);
      bg.scale(SCALE, SCALE, SCALE);
      this.bombMesh = new THREE.InstancedMesh(bg, patchAtmosphere(new THREE.MeshStandardMaterial({ color: 0x33352f, roughness: 0.6 }), { key: 'air' }), MAX_BOMBS);
      this.bombMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.bombMesh.count = 0;
      this.bombMesh.frustumCulled = false;
      this.wreckMesh.visible = this.bombMesh.visible = false;
      scene.add(this.wreckMesh, this.bombMesh);
      // shot-down planes: fixed pool, no per-frame allocation
      this.wrecks = Array.from({ length: MAX_WRECKS }, () => ({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, h: 0, roll: 0, spin: 0, smokeT: 0 }));
      this._seen = new WeakSet();
      this.drawn = 0;   // aircraft drawn last frame (perf hook)
   }

   clear() {
      for (const w of this.wrecks) w.on = false;
      this._seen = new WeakSet();
      for (const M of this.list) { M.count = 0; M.visible = false; }
      this.wreckMesh.count = this.bombMesh.count = 0;
      this.wreckMesh.visible = this.bombMesh.visible = false;
   }

   // perf / test hook: what the aircraft cost last frame
   stats() {
      const per = {};
      let calls = 0, tris = 0;
      for (const M of this.list) {
         per[M.userData.name] = M.geometry.userData.tris;
         if (M.visible) { calls++; tris += M.count * M.geometry.userData.tris; }
      }
      return { drawn: this.drawn, calls, tris, trisPerModel: per };
   }

   update(world, dt, time) {
      this._planes(world, time);
      this._bombs(world);
      this._wrecks(world, dt);
   }

   _planes(world, time) {
      const sqs = world.squadrons || [];
      for (const M of this.list) M.userData.k = 0;
      let total = 0;
      for (let i = 0; i < sqs.length; i++) {
         const sq = sqs[i];
         if (!(sq.n > 0) || !sq.visible) continue;
         if (sq._air == null) {
            const owner = world.shipById?.(sq.ownerId);
            const nation = sq.nation || owner?.cfg?.hull?.nation || null;
            const key = airModelFor(sq, nation), def = AIR_MODELS[key];
            const kind = airKind(sq);
            sq._air = { mesh: this.meshes[def.mesh], scale: def.scale, col: airColor(key, nation), nat: NATION_IDX[nation] ?? 6, helo: def.mesh === 'helo', fighter: kind === 'fighter' };
         }
         const A = sq._air, M = A.mesh, inst = M.userData.inst;
         const armed = A.fighter || sq.armed == null || sq.armed === true || sq.armed > 0 ? 1 : 0;
         _c.set(A.col);
         const x = sq.rx ?? sq.pos.x, y = sq.ry ?? sq.pos.y, alt = sq.ralt ?? sq.alt, h = sq.rh ?? sq.heading;
         const dh = sq.want != null ? Math.atan2(Math.sin(sq.want - sq.heading), Math.cos(sq.want - sq.heading)) : 0;
         const lim = A.helo ? 0.3 : 1.0;
         const bank = Math.max(-lim, Math.min(lim, dh * (A.helo ? 0.8 : 2.2)));
         const climb = sq.prev ? (sq.alt - sq.prev.alt) * 60 : 0;
         // helicopters fly nose-down in proportion to their speed; jets pitch with the climb rate
         const pitch = A.helo ? -Math.min(0.16, (sq.speed || 0) / 400)
            : Math.max(-1.0, Math.min(0.5, Math.atan2(climb, Math.max(120, sq.speed || 0))));
         const c = Math.cos(h), s = Math.sin(h);
         const n = Math.min(sq.n, SLOT.length), sp = A.helo ? 0.6 : 1;
         _s.setScalar(A.scale);
         for (let j = 0; j < n && M.userData.k < MAX_PER_MODEL; j++) {
            const fx = SLOT[j][0] * sp, fz = SLOT[j][1] * sp;
            const id = Number(sq.id) || 0;
            const bob = Math.sin(time * 1.3 + j * 1.7 + id) * (A.helo ? 0.8 : 2.0);
            // formation offset in sim (x ahead, z right of the heading) -> world
            _p.set(x + fx * c - fz * s, alt + bob - Math.abs(fz) * 0.06, y + fx * s + fz * c);
            _e.set(bank, -h, pitch, 'YZX');
            _q.setFromEuler(_e);
            _m.compose(_p, _q, _s);
            const k = M.userData.k++;
            M.setMatrixAt(k, _m);
            M.setColorAt(k, _c);
            inst.setXYZ(k, A.nat, armed, A.helo ? (time * 7 + j * 1.3 + id) % 6.2832 : 0);
            total++;
         }
      }
      for (const M of this.list) {
         const k = M.userData.k;
         M.count = k; M.visible = k > 0;
         if (k) { M.instanceMatrix.needsUpdate = true; M.instanceColor.needsUpdate = true; M.userData.inst.needsUpdate = true; }
      }
      _s.setScalar(1);
      this.drawn = total;
   }

   _bombs(world) {
      const bs = world.bombs || [];
      const M = this.bombMesh;
      let k = 0;
      for (let i = 0; i < bs.length && k < MAX_BOMBS; i++) {
         const b = bs[i];
         if (!b.alive || b.t < 0) continue;
         const f = Math.min(1, b.t / b.fall);
         _p.set(b.sx + (b.x - b.sx) * f, b.salt * (1 - f * f) + 2, b.sy + (b.y - b.sy) * f);
         _e.set(0, -b.heading, -0.4 - f * 0.9, 'YZX');
         _q.setFromEuler(_e);
         _m.compose(_p, _q, _s);
         M.setMatrixAt(k++, _m);
      }
      M.count = k; M.visible = k > 0;
      if (k) M.instanceMatrix.needsUpdate = true;
   }

   _wrecks(world, dt) {
      const fxs = world.effects;
      if (Array.isArray(fxs)) {
         for (let i = fxs.length - 1; i >= 0; i--) {
            const e = fxs[i];
            if (e.kind !== 'planeDown') continue;
            if (this._seen.has(e)) break;   // effects are appended: everything older was handled
            this._seen.add(e);
            let w = null;
            for (const o of this.wrecks) if (!o.on) { w = o; break; }
            if (!w) continue;
            const sp = Number(e.speed) || 200, h = Number(e.heading) || 0;
            w.on = true; w.x = e.pos.x; w.z = e.pos.y; w.y = Number(e.alt) || 200;
            w.vx = Math.cos(h) * sp; w.vz = Math.sin(h) * sp; w.vy = -5; w.h = h;
            w.roll = 0; w.spin = (Math.floor(e.pos.x) & 1 ? 1 : -1) * (1.5 + (w.y % 7) * 0.3); w.smokeT = 0;
            this._burst(w.x, w.y, w.z);
         }
      }
      const M = this.wreckMesh;
      let k = 0;
      for (const w of this.wrecks) {
         if (!w.on) continue;
         w.vy -= 9.8 * dt; w.vx *= 1 - 0.25 * dt; w.vz *= 1 - 0.25 * dt;
         w.x += w.vx * dt; w.y += w.vy * dt; w.z += w.vz * dt; w.roll += w.spin * dt;
         if ((w.smokeT -= dt) <= 0) { w.smokeT = 0.07; this._trail(w.x, w.y, w.z); }
         if (w.y <= 0) {
            w.on = false;
            this.fx._splash?.(w.x, w.z, 150, false);
            continue;
         }
         const pitch = Math.atan2(w.vy, Math.hypot(w.vx, w.vz));
         _p.set(w.x, w.y, w.z);
         _e.set(w.roll, -w.h, pitch, 'YZX');
         _q.setFromEuler(_e);
         _m.compose(_p, _q, _s);
         M.setMatrixAt(k++, _m);
      }
      M.count = k; M.visible = k > 0;
      if (k) M.instanceMatrix.needsUpdate = true;
   }

   _burst(x, y, z) {
      const G = this.fx?.glow;
      if (!G) return;
      const p = G.t();
      p.x = x; p.y = y; p.z = z; p.life = 0.35; p.s0 = 8; p.s1 = 22; p.grow = 3;
      p.r = 45; p.g = 20; p.b = 5; p.r1 = 8; p.g1 = 2; p.b1 = 0.2; p.fin = 0; p.fout = 0.3; p.shape = 0;
      G.emit();
   }
   _trail(x, y, z) {
      const P = this.fx?.puff, G = this.fx?.glow;
      if (!P) return;
      let p = P.t();
      p.x = x; p.y = y; p.z = z; p.vx = 0; p.vy = 1; p.vz = 0; p.drag = 0.5; p.grav = 0;
      p.life = 3.2; p.s0 = 3; p.s1 = 12; p.grow = 2.5;
      p.r = 0.04; p.g = 0.038; p.b = 0.035; p.r1 = 0.16; p.g1 = 0.155; p.b1 = 0.15;
      p.a = 0.75; p.fin = 0.05; p.fout = 0.5; p.shape = 1; p.lit = 0.6; p.wind = 1; p.rot = 0; p.spin = 0.2;
      P.emit();
      if (G) {
         p = G.t();
         p.x = x; p.y = y; p.z = z; p.life = 0.25; p.s0 = 3; p.s1 = 1.5; p.grow = 1;
         p.r = 30; p.g = 12; p.b = 3; p.r1 = 8; p.g1 = 2; p.b1 = 0.3; p.fin = 0; p.fout = 0.4; p.shape = 0;
         G.emit();
      }
   }
}
// test hook: triangle count of an airframe mesh
export function airModelTris(mesh, lo) { const g = modelGeometry(mesh, lo); const n = g.userData.tris; g.dispose(); return n; }
