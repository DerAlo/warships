// game3d/terrain3d.js — islands with real relief. Each island is a heightfield whose h=0
// contour follows the obstacle's lobes (the sim coastline); the interior is seeded fBm +
// ridged noise scaled to obstacle.height (fallback ~0.34 * radius). The coast alternates
// between cliffs and beaches, an underwater slope feeds the ocean's shallow-water colour,
// slope/height drive the colouring (wet sand, sand, grass, forest, rock, snow), sun shadows
// are baked per vertex (islands far outside the real-time shadow box keep their form),
// forests are instanced clumps. Reefs are sandbanks with rocks breaking the surface.
import * as THREE from '../vendor/three/three.module.min.js';
import {
   patchAtmosphere, makeNoise2D, fbm, ridged, mulberry32, clamp, smoothstep, lerp, lin, GeoBuilder, disposeTree,
} from './gfxcommon3d.js';

const DEEP = -60;

const PAL = {
   wet: lin(0x6f6148), sand: lin(0xcdb68a), sandDry: lin(0xd9c79c),
   grass: lin(0x5d7a36), grassDry: lin(0x8c8a4c), forest: lin(0x3b5626),
   rock: lin(0x77716a), rockDark: lin(0x4d4943), rockWarm: lin(0x8a7963), snow: lin(0xe9edf0),
   under: lin(0x857656),
};

function hashSeed(x, y, i) {
   let h = (Math.imul(Math.round(x) | 0, 73856093) ^ Math.imul(Math.round(y) | 0, 19349663) ^ Math.imul(i + 1, 83492791)) >>> 0;
   return h || 1;
}

// ---------------- height fields ----------------
function makeIslandField(o, idx) {
   const seed = Number.isFinite(o.seed) ? o.seed : hashSeed(o.c.x, o.c.y, idx);
   const n1 = makeNoise2D(seed), n2 = makeNoise2D(seed + 101), n3 = makeNoise2D(seed + 202), n4 = makeNoise2D(seed + 303);
   const R0 = o.r;
   const BINS = 720;
   const Rt = new Float32Array(BINS);
   const lobes = Array.isArray(o.lobes) && o.lobes.length >= 3 ? o.lobes.slice().sort((a, b) => a.a - b.a) : null;
   for (let i = 0; i < BINS; i++) {
      const th = (i / BINS) * Math.PI * 2;
      let R = R0;
      if (lobes) R = lobeRadius(lobes, th);
      // small natural wiggle on top of the sim outline (few % => ships never visibly clip land)
      R *= 1 + 0.025 * fbm(n4, Math.cos(th) * 2.5 + 7, Math.sin(th) * 2.5 + 7, 3);
      Rt[i] = R;
   }
   let Rmax = 0;
   for (let i = 0; i < BINS; i++) Rmax = Math.max(Rmax, Rt[i]);
   const Hp = Number.isFinite(o.height) && o.height > 0 ? o.height : clamp(R0 * 0.34, 40, 400);
   const cliffH = clamp(Hp * 0.22, 8, 60);
   const cx = o.c.x, cz = o.c.y;
   const f = {
      kind: 'island', cx, cz, Rmax, Hp, seed, reach: Rmax * 1.45, scale: 1,
      coastR(th) {
         const t = ((th / (Math.PI * 2)) % 1 + 1) % 1 * BINS;
         const i0 = Math.floor(t) % BINS, i1 = (i0 + 1) % BINS, fr = t - Math.floor(t);
         return Rt[i0] + (Rt[i1] - Rt[i0]) * fr;
      },
      cliffAt(th) { return smoothstep(-0.12, 0.3, n3(Math.cos(th) * 1.4 + 5, Math.sin(th) * 1.4 + 5)); },
      raw(x, z) {
         const dx = x - cx, dz = z - cz;
         const d = Math.hypot(dx, dz);
         const th = Math.atan2(dz, dx);
         const R = this.coastR(th);
         const din = R - d;
         const cl = this.cliffAt(th);
         if (din < 0) {
            const slope = lerp(0.075, 0.5, cl);
            return Math.max(DEEP, -(-din) * slope - 0.4 * Math.abs(n2(x * 0.02, z * 0.02)));
         }
         const u = dx / R0, v = dz / R0;
         const e = din / R;
         const dome = Math.pow(smoothstep(0, 0.85, e), 0.85);
         const rid = ridged(n1, u * 1.7 + 10, v * 1.7 + 10, 5);
         const bulk = fbm(n2, u * 1.2, v * 1.2, 4) * 0.5 + 0.5;
         let hIn = dome * (0.18 + 0.62 * rid * rid + 0.38 * bulk) * this.scale * Hp;
         hIn += Hp * 0.035 * fbm(n3, u * 9, v * 9, 3) * smoothstep(0, 0.2, e);
         const plateau = cl * cliffH * (0.75 + 0.25 * n4(u * 4, v * 4)) * smoothstep(0, 45, din);
         const hLand = Math.max(hIn, plateau);
         const ramp = lerp(din * 0.055, din * 2.4, cl);
         return Math.min(hLand, ramp);
      },
   };
   return f;
}

function lobeRadius(lobes, th) {
   const n = lobes.length;
   const TAU = Math.PI * 2;
   th = ((th % TAU) + TAU) % TAU;
   let i1 = lobes.findIndex(l => (((l.a % TAU) + TAU) % TAU) >= th);
   if (i1 < 0) i1 = 0;
   const i0 = (i1 - 1 + n) % n;
   const a0 = ((lobes[i0].a % TAU) + TAU) % TAU;
   let a1 = ((lobes[i1].a % TAU) + TAU) % TAU;
   let span = a1 - a0; if (span <= 0) span += TAU;
   let t = th - a0; if (t < 0) t += TAU;
   const fr = clamp(t / span, 0, 1);
   const s = fr * fr * (3 - 2 * fr);
   return lobes[i0].r + (lobes[i1].r - lobes[i0].r) * s;
}

function makeReefField(o, idx) {
   const seed = Number.isFinite(o.seed) ? o.seed : hashSeed(o.c.x, o.c.y, idx + 50);
   const n1 = makeNoise2D(seed), n2 = makeNoise2D(seed + 7);
   const R = o.r, cx = o.c.x, cz = o.c.y;
   return {
      kind: 'reef', cx, cz, Rmax: R, Hp: 3, seed, reach: R * 1.45,
      raw(x, z) {
         const dx = x - cx, dz = z - cz;
         const u = dx / R, v = dz / R;
         const s = Math.hypot(u, v) * (1 + 0.18 * fbm(n2, u * 2 + 3, v * 2 + 3, 3));
         const n = fbm(n1, u * 3.5, v * 3.5, 4);
         const core = 1 - smoothstep(0.35, 1.2, s);
         return Math.max(DEEP, -11 + core * (9.3 + 3.4 * n) - smoothstep(0.9, 1.45, s) * 26);
      },
   };
}

// ---------------- grid sampling ----------------
function buildGrid(field) {
   const half = field.reach;
   const sp = field.kind === 'reef' ? clamp(field.Rmax / 45, 3, 14) : clamp(field.Rmax / 95, 3.5, 20);
   const n = Math.min(360, Math.ceil((half * 2) / sp) + 1);
   const step = (half * 2) / (n - 1);
   const x0 = field.cx - half, z0 = field.cz - half;
   const H = new Float32Array(n * n);
   let maxH = -1e9;
   for (let j = 0; j < n; j++) {
      const z = z0 + j * step;
      for (let i = 0; i < n; i++) {
         const h = field.raw(x0 + i * step, z);
         H[j * n + i] = h;
         if (h > maxH) maxH = h;
      }
   }
   // islands: rescale land so the real summit equals the requested peak height
   if (field.kind === 'island' && maxH > 1) {
      const k = field.Hp / maxH;
      if (Math.abs(k - 1) > 0.02) for (let q = 0; q < H.length; q++) if (H[q] > 0) H[q] *= k;
      maxH = field.Hp;
   }
   return { n, step, x0, z0, H, maxH };
}
function gridH(g, x, z) {
   const fx = (x - g.x0) / g.step, fz = (z - g.z0) / g.step;
   if (fx < 0 || fz < 0 || fx > g.n - 1 || fz > g.n - 1) return DEEP;
   const i = Math.min(g.n - 2, Math.floor(fx)), j = Math.min(g.n - 2, Math.floor(fz));
   const tx = fx - i, tz = fz - j;
   const H = g.H, n = g.n;
   const a = H[j * n + i], b = H[j * n + i + 1], c = H[(j + 1) * n + i], d = H[(j + 1) * n + i + 1];
   return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

// ---------------- materials ----------------
const TERRAIN_FRAG_PARS = /* glsl */`
varying float vSunVis;
float tHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float tNoise(vec2 p) {
   vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
   return mix(mix(tHash(i), tHash(i + vec2(1, 0)), u.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), u.x), u.y);
}
`;
function terrainMaterial() {
   const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.75 });
   patchAtmosphere(mat, {
      key: 'terrain',
      vertexPars: 'attribute float aSunVis;\nvarying float vSunVis;\n',
      vertexMain: 'vSunVis = aSunVis;',
      fragmentPars: TERRAIN_FRAG_PARS,
      fragmentReplace: [
         ['#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
            'getDirectionalLightInfo( directionalLight, directLight );',
            'getDirectionalLightInfo( directionalLight, directLight );\n directLight.color *= vSunVis;')],
         ['#include <color_fragment>', `#include <color_fragment>
            {
               vec3 wp = vAtmWP;
               float dn = tNoise(wp.xz * 0.11) * 0.55 + tNoise(wp.xz * 0.45) * 0.3 + tNoise(wp.xz * 1.7) * 0.15;
               float strata = tNoise(vec2((wp.x + wp.z) * 0.05, wp.y * 0.55));
               diffuseColor.rgb *= 0.8 + 0.4 * dn;
               diffuseColor.rgb *= mix(1.0, 0.8 + 0.4 * strata, clamp((1.0 - vNormal.y) * 0.0 + 0.0, 0.0, 1.0));
            }`],
      ],
   });
   return mat;
}
function plainAtmMaterial(opts, key) {
   const m = new THREE.MeshStandardMaterial(opts);
   patchAtmosphere(m, { key });
   return m;
}

// ---------------- tree / rock geometry ----------------
function conferClump() {
   const b = new GeoBuilder();
   const rnd = mulberry32(5);
   for (let i = 0; i < 6; i++) {
      const a = rnd() * Math.PI * 2, r = i === 0 ? 0 : 2.5 + rnd() * 4;
      const h = 9 + rnd() * 7, w = 2.2 + rnd() * 1.4;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const top = lin(0x3f6a34), bot = lin(0x22381c);
      const g = new THREE.ConeGeometry(w, h, 7, 1, true);
      g.translate(0, h / 2 + 1.2, 0);
      b.put(g, x, 0, z, (px, py) => { const t = clamp(py / (h + 1.2), 0, 1); return [lerp(bot[0], top[0], t), lerp(bot[1], top[1], t), lerp(bot[2], top[2], t)]; });
   }
   return b.build();
}
function broadleafClump() {
   const b = new GeoBuilder();
   const rnd = mulberry32(9);
   for (let i = 0; i < 5; i++) {
      const a = rnd() * Math.PI * 2, r = i === 0 ? 0 : 3 + rnd() * 4;
      const s = 3.5 + rnd() * 2.5;
      const g = new THREE.IcosahedronGeometry(s, 0);
      const top = lin(0x5b7f38), bot = lin(0x2d4a1f);
      const y = s * 0.9 + 1 + rnd() * 2;
      b.put(g, Math.cos(a) * r, y, Math.sin(a) * r, (px, py) => { const t = clamp(py / (y + s), 0, 1); return [lerp(bot[0], top[0], t), lerp(bot[1], top[1], t), lerp(bot[2], top[2], t)]; }, rnd(), rnd() * 3, 0, 1, 0.8 + rnd() * 0.4, 1);
   }
   return b.build();
}
function rockGeometry() {
   const g = new THREE.IcosahedronGeometry(1, 1);
   const p = g.attributes.position;
   const n = makeNoise2D(77);
   for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + 0.28 * n(x * 1.7 + z, y * 1.7 - z);
      p.setXYZ(i, x * k, y * k * 0.7, z * k);
   }
   g.computeVertexNormals();
   const b = new GeoBuilder();
   b.put(g, 0, 0, 0, (x, y) => y > 0.2 ? lin(0x6a655e) : lin(0x3e3a35));
   return b.build();
}

// ---------------- the terrain ----------------
export class Terrain {
   constructor() {
      this.group = new THREE.Group();
      this.fields = [];
      this.grids = [];
      this.depthTex = null;
      this.rect = null;
      this.mat = terrainMaterial();
      this.treeMat = plainAtmMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.6 }, 'tree');
      this.rockMat = plainAtmMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.7 }, 'rock');
      this.buildingMat = plainAtmMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05, envMapIntensity: 0.7 }, 'bld');
      this.conifer = conferClump();
      this.broadleaf = broadleafClump();
      this.rockGeo = rockGeometry();
   }

   clear() {
      for (const c of this.group.children.slice()) {
         this.group.remove(c);
         if (c.isInstancedMesh) { c.dispose(); continue; }
         if (c.geometry && c.geometry !== this.conifer && c.geometry !== this.broadleaf && c.geometry !== this.rockGeo) c.geometry.dispose();
      }
      if (this.depthTex) { this.depthTex.dispose(); this.depthTex = null; }
      this.fields = []; this.grids = [];
   }

   build(obstacles, env, arena) {
      this.clear();
      const obs = Array.isArray(obstacles) ? obstacles : [];
      obs.forEach((o, i) => {
         if (!o || !o.c || !(o.r > 0)) return;
         this.fields.push(o.kind === 'reef' ? makeReefField(o, i) : makeIslandField(o, i));
      });
      const L = env ? env.lightDir : new THREE.Vector3(0.5, 0.5, 0.2).normalize();
      const trees = { con: [], broad: [] }, rocks = [];
      for (const f of this.fields) {
         const g = buildGrid(f);
         this.grids.push(g);
         const mesh = this._meshFromGrid(f, g, L, trees, rocks);
         if (mesh) this.group.add(mesh);
      }
      this._instances(trees, rocks);
      this._buildDepthMap(arena || 4000);
      return { depthTex: this.depthTex, rect: this.rect };
   }

   heightAt(x, z) {
      let h = DEEP;
      for (const g of this.grids) {
         if (x < g.x0 || z < g.z0 || x > g.x0 + g.step * (g.n - 1) || z > g.z0 + g.step * (g.n - 1)) continue;
         h = Math.max(h, gridH(g, x, z));
      }
      return h;
   }

   _meshFromGrid(f, g, L, trees, rocks) {
      const { n, step, x0, z0, H } = g;
      const N = n * n;
      const nrm = new Float32Array(N * 3);
      for (let j = 0; j < n; j++) {
         for (let i = 0; i < n; i++) {
            const hl = H[j * n + Math.max(0, i - 1)], hr = H[j * n + Math.min(n - 1, i + 1)];
            const hd = H[Math.max(0, j - 1) * n + i], hu = H[Math.min(n - 1, j + 1) * n + i];
            const nx = (hl - hr) / (2 * step), nz = (hd - hu) / (2 * step);
            const il = 1 / Math.hypot(nx, 1, nz);
            const q = (j * n + i) * 3;
            nrm[q] = nx * il; nrm[q + 1] = il; nrm[q + 2] = nz * il;
         }
      }
      // sun visibility: march the heightfield toward the light
      const vis = new Float32Array(N);
      const Lh = Math.hypot(L.x, L.z) || 1e-4;
      const lx = L.x / Lh, lz = L.z / Lh, tanE = L.y / Lh;
      const maxH = g.maxH;
      for (let j = 0; j < n; j++) {
         for (let i = 0; i < n; i++) {
            const h0 = H[j * n + i];
            if (h0 < -8) { vis[j * n + i] = 1; continue; }
            const x = x0 + i * step, z = z0 + j * step;
            let v = 1, t = step * 0.8;
            const tMax = Math.min(f.reach * 2, (maxH - h0) / Math.max(tanE, 0.02) + step);
            for (let s = 0; s < 40 && t < tMax; s++) {
               const hh = gridH(g, x + lx * t, z + lz * t);
               const ray = h0 + 0.6 + t * tanE;
               const pen = (ray - hh) / (0.04 * t + 1.2);
               if (pen < v) { v = pen; if (v <= 0) { v = 0; break; } }
               t += step * (0.7 + s * 0.22);
            }
            vis[j * n + i] = clamp(v, 0, 1);
         }
      }
      // colours + index (drop quads that are entirely deep underwater -- never visible)
      const noise = makeNoise2D(f.seed + 999), noise2 = makeNoise2D(f.seed + 1999);
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), sv = new Float32Array(N);
      const Hp = f.Hp;
      const rnd = mulberry32(f.seed + 5);
      for (let j = 0; j < n; j++) {
         for (let i = 0; i < n; i++) {
            const k = j * n + i, q = k * 3;
            const x = x0 + i * step, z = z0 + j * step, h = H[k];
            pos[q] = x; pos[q + 1] = h; pos[q + 2] = z;
            const ny = nrm[q + 1], slope = 1 - ny;
            const nv = noise(x * 0.012, z * 0.012), nv2 = noise2(x * 0.05, z * 0.05);
            let c;
            if (f.kind === 'reef') {
               c = h < -0.2 ? PAL.under : mixc(PAL.sand, PAL.rockDark, smoothstep(0.1, 0.6, nv2 + slope));
               if (h > -0.2 && h < 0.5) c = mixc(c, PAL.wet, 0.6);
            } else if (h < 0.7 + nv * 0.35) {
               c = h < -0.5 ? PAL.under : PAL.wet;
               c = mixc(c, PAL.rockDark, smoothstep(0.35, 0.7, slope));
            } else if (h < 3.2 + nv * 1.8 && slope < 0.3) {
               c = mixc(PAL.sand, PAL.sandDry, smoothstep(1, 3, h));
            } else {
               const hN = h / Hp;
               const dry = smoothstep(-0.2, 0.6, nv2);
               let veg = mixc(PAL.grass, PAL.grassDry, dry * 0.7);
               const forestN = smoothstep(-0.05, 0.3, nv);
               veg = mixc(veg, PAL.forest, forestN * 0.75 * (1 - smoothstep(0.55, 0.85, hN)));
               const rockK = Math.max(smoothstep(0.34, 0.58, slope + nv2 * 0.08), smoothstep(0.72, 0.95, hN + nv * 0.12));
               const rockC = mixc(PAL.rockWarm, PAL.rock, smoothstep(-0.3, 0.3, nv2));
               c = mixc(veg, rockC, rockK);
               c = mixc(c, PAL.rockDark, smoothstep(0.62, 0.85, slope) * 0.6);
               if (h > 260 + nv * 50) c = mixc(c, PAL.snow, smoothstep(260, 320, h + nv * 50) * (1 - smoothstep(0.45, 0.7, slope)));
               // coastal sand transitions into grass
               c = mixc(PAL.sandDry, c, smoothstep(2.5, 6, h + nv * 2));
               // forest clumps on gentle, green, not-too-high ground
               if (f.kind === 'island' && ((i + j * 3) % 2 === 0) && slope < 0.42 && h > 5 && hN < 0.82 && h < 300) {
                  const dens = forestN * (1 - rockK);
                  if (rnd() < dens * 0.55 * (step / 7) * (step / 7)) {
                     const jx = x + (rnd() - 0.5) * step, jz = z + (rnd() - 0.5) * step;
                     const rec = { x: jx, y: gridH(g, jx, jz) - 1.2, z: jz, s: 0.7 + rnd() * 0.6, r: rnd() * Math.PI * 2, vis: vis[k] };
                     (hN > 0.35 || rnd() < 0.35 ? trees.con : trees.broad).push(rec);
                  }
               }
            }
            // ambient occlusion from local concavity
            const hc = h;
            const lap = (H[j * n + Math.max(0, i - 2)] + H[j * n + Math.min(n - 1, i + 2)] + H[Math.max(0, j - 2) * n + i] + H[Math.min(n - 1, j + 2) * n + i]) * 0.25 - hc;
            const ao = clamp(1 - lap * 0.035, 0.6, 1.08);
            col[q] = c[0] * ao; col[q + 1] = c[1] * ao; col[q + 2] = c[2] * ao;
            sv[k] = vis[k];
            // rocks on reefs where the bank breaks the surface, and at cliff feet
            if (f.kind === 'reef' && h > -2.4 && rnd() < 0.06) rocks.push({ x, y: h - 0.5, z, s: 1.5 + rnd() * 4, r: rnd() * 6 });
            else if (f.kind === 'island' && h > -1 && h < 2.5 && slope > 0.35 && rnd() < 0.05) rocks.push({ x, y: h - 0.6, z, s: 2 + rnd() * 5, r: rnd() * 6 });
         }
      }
      const idx = [];
      for (let j = 0; j < n - 1; j++) {
         for (let i = 0; i < n - 1; i++) {
            const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
            if (H[a] < -7 && H[b] < -7 && H[c] < -7 && H[d] < -7) continue;
            // flip the diagonal to follow ridges (less "staircase" on cliffs)
            if (Math.abs(H[a] - H[d]) < Math.abs(H[b] - H[c])) { idx.push(a, c, d, a, d, b); }
            else { idx.push(a, c, b, b, c, d); }
         }
      }
      if (!idx.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aSunVis', new THREE.BufferAttribute(sv, 1));
      geo.setIndex(N > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (f.kind === 'island' && f.Rmax > 180) this._landmarks(f, g, mesh);
      return mesh;
   }

   // a lighthouse on a prominent coastal point: scale reference + WoWs flavour
   _landmarks(f, g, parentMesh) {
      const rnd = mulberry32(f.seed + 31);
      let best = null;
      for (let k = 0; k < 24; k++) {
         const th = rnd() * Math.PI * 2;
         const R = f.coastR(th) - 22;
         const x = f.cx + Math.cos(th) * R, z = f.cz + Math.sin(th) * R;
         const h = gridH(g, x, z);
         const h2 = gridH(g, x + 6, z), h3 = gridH(g, x, z + 6);
         const flat = Math.abs(h2 - h) + Math.abs(h3 - h);
         if (h > 3 && flat < 4 && (!best || h - flat * 3 > best.score)) best = { x, z, h, score: h - flat * 3 };
      }
      if (!best) return;
      const b = new GeoBuilder();
      const white = lin(0xe8e4dc), red = lin(0xa3322a), dark = lin(0x34383c), glass = [2.5, 2.2, 1.6];
      b.cyl(3.2, 4.2, 22, 0, 0, 0, (x, y) => (Math.floor(y / 5.5) % 2 ? red : white), 14);
      b.cyl(4.6, 4.6, 0.8, 0, 22, 0, dark, 14);
      b.cyl(2.4, 2.4, 3, 0, 22.8, 0, glass, 12);
      b.cyl(0.1, 3.0, 2.2, 0, 25.8, 0, red, 12);
      b.box(9, 4.5, 7, 7, 0, 5, white); b.box(9.4, 0.6, 7.4, 7, 4.5, 5, red);
      const geo = b.build();
      const m = new THREE.Mesh(geo, this.buildingMat);
      m.position.set(best.x, best.h - 0.3, best.z);
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
   }

   _instances(trees, rocks) {
      const MAXT = 7000;
      const mk = (geo, mat, list, cap, sBase) => {
         if (!list.length) return;
         const cnt = Math.min(cap, list.length);
         const im = new THREE.InstancedMesh(geo, mat, cnt);
         const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
         const c = new THREE.Color();
         const stride = list.length / cnt;
         for (let i = 0; i < cnt; i++) {
            const t = list[Math.floor(i * stride)];
            e.set(0, t.r, 0); q.setFromEuler(e);
            s.set(t.s * sBase, t.s * sBase * (0.9 + (i % 5) * 0.06), t.s * sBase);
            p.set(t.x, t.y, t.z);
            m.compose(p, q, s);
            im.setMatrixAt(i, m);
            const v = t.vis === undefined ? 1 : 0.55 + 0.45 * t.vis;
            const tint = 0.85 + ((i * 7919) % 100) / 100 * 0.3;
            c.setRGB(v * tint, v * (0.95 + ((i * 104729) % 100) / 1000), v * tint * 0.95);
            im.setColorAt(i, c);
         }
         im.instanceMatrix.needsUpdate = true;
         if (im.instanceColor) im.instanceColor.needsUpdate = true;
         im.castShadow = true; im.receiveShadow = true;
         im.computeBoundingSphere();
         this.group.add(im);
      };
      const total = trees.con.length + trees.broad.length;
      const k = total > MAXT ? MAXT / total : 1;
      mk(this.conifer, this.treeMat, trees.con, Math.floor(trees.con.length * k), 1);
      mk(this.broadleaf, this.treeMat, trees.broad, Math.floor(trees.broad.length * k), 1);
      mk(this.rockGeo, this.rockMat, rocks, 1500, 1);
   }

   _buildDepthMap(arena) {
      let minX = -arena * 1.15, minZ = -arena * 1.15, maxX = arena * 1.15, maxZ = arena * 1.15;
      for (const g of this.grids) {
         minX = Math.min(minX, g.x0); minZ = Math.min(minZ, g.z0);
         maxX = Math.max(maxX, g.x0 + g.step * (g.n - 1)); maxZ = Math.max(maxZ, g.z0 + g.step * (g.n - 1));
      }
      const size = Math.max(maxX - minX, maxZ - minZ);
      const R = 2048;
      const data = new Uint8Array(R * R).fill(255);
      const texel = size / R;
      for (const g of this.grids) {
         const gx1 = g.x0 + g.step * (g.n - 1), gz1 = g.z0 + g.step * (g.n - 1);
         const i0 = Math.max(0, Math.floor((g.x0 - minX) / texel)), i1 = Math.min(R - 1, Math.ceil((gx1 - minX) / texel));
         const j0 = Math.max(0, Math.floor((g.z0 - minZ) / texel)), j1 = Math.min(R - 1, Math.ceil((gz1 - minZ) / texel));
         for (let j = j0; j <= j1; j++) {
            const z = minZ + (j + 0.5) * texel;
            for (let i = i0; i <= i1; i++) {
               const x = minX + (i + 0.5) * texel;
               const h = gridH(g, x, z);
               // fade to deep water before the grid border, otherwise every island sits in a
               // visible square of shallow tint (the seabed is still ~10 m deep at the edge)
               // radial (not per-edge) so shoals read as round banks, not soft rectangles
               const rr = Math.hypot(x - (g.x0 + gx1) * 0.5, z - (g.z0 + gz1) * 0.5) / ((gx1 - g.x0) * 0.5);
               const w = 1 - smoothstep(0.72, 0.99, rr);
               const d = 1 - (1 - clamp(-h / 50, 0, 1)) * w;
               const v = Math.round(d * 255);
               const q = j * R + i;
               if (v < data[q]) data[q] = v;
            }
         }
      }
      const tex = new THREE.DataTexture(data, R, R, THREE.RedFormat, THREE.UnsignedByteType);
      tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      this.depthTex = tex;
      this.rect = { minX, minZ, size };
   }

   dispose() {
      this.clear();
      this.mat.dispose(); this.treeMat.dispose(); this.rockMat.dispose(); this.buildingMat.dispose();
      this.conifer.dispose(); this.broadleaf.dispose(); this.rockGeo.dispose();
   }
}
function mixc(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
