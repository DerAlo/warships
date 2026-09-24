// game3d/gfxcommon3d.js — shared graphics plumbing for the 3D renderer modules:
//  * ATM: one set of atmosphere uniforms (sun, sky gradient, fog) shared BY REFERENCE with
//    every material, so distant ships/islands/sea all melt into exactly the sky colour
//    behind them (no "grey fog wall" in front of a blue horizon).
//  * patchAtmosphere(): injects that fog into stock MeshStandardMaterials.
//  * CPU noise (seeded), a small geometry builder that merges primitives into ONE
//    vertex-coloured BufferGeometry (we have no BufferGeometryUtils addon), and helpers.
import * as THREE from '../vendor/three/three.module.min.js';

export const ATM = {
   uSunDir: { value: new THREE.Vector3(0.6, 0.35, -0.3).normalize() },
   uZenith: { value: new THREE.Color(0.085, 0.22, 0.55) },
   uHorizon: { value: new THREE.Color(0.5, 0.63, 0.8) },
   uGlow: { value: new THREE.Color(0.7, 0.55, 0.38) },
   uSunUp: { value: 1 },          // 0 when the sun is below the horizon (night)
   uFogDist: { value: 28000 },    // 1/e optical-depth distance at sea level (m)
   uFogHeight: { value: 1400 },   // exponential height falloff of the haze (m)
};

// GLSL shared by sky, sea, terrain, ships, particles. skyBase() is the cloudless sky; the
// fog colour is skyBase() evaluated ON the horizon in the view azimuth, so the sky dome's
// horizon row and a fully fogged object are the same colour by construction.
export const ATM_GLSL = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform float uSunUp;
uniform float uFogDist;
uniform float uFogHeight;

vec3 skyBase(vec3 d) {
   float y = clamp(d.y, 0.0, 1.0);
   float hz = pow(1.0 - y, 4.0);
   vec3 col = mix(uZenith, uHorizon, hz);
   vec2 dh = normalize(d.xz + vec2(1e-5));
   vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
   float muH = dot(dh, sh);
   // horizon band warmer on the sun side, cooler opposite (cheap Rayleigh asymmetry)
   col *= 1.0 + 0.22 * muH * hz * uSunUp;
   float m = max(dot(d, uSunDir), 0.0);
   col += uGlow * (0.22 * pow(m, 4.0) * hz + 0.45 * pow(m, 28.0) + 1.6 * pow(m, 420.0));
   return col;
}
vec3 atmFogColor(vec3 V) {
   return skyBase(normalize(vec3(V.x, 0.0, V.z) + vec3(0.0, 1e-4, 0.0)));
}
float atmFogAmount(float d, float hc, float hp) {
   float a = max(hc, 0.0), b = max(hp, 0.0);
   float dh = b - a;
   float ea = exp(-a / uFogHeight);
   float k = abs(dh) < 1.0 ? ea : (ea - exp(-b / uFogHeight)) * uFogHeight / dh;
   return 1.0 - exp(-d * k / uFogDist);
}
vec3 atmApply(vec3 col, vec3 wp) {
   vec3 V = wp - cameraPosition;
   float d = length(V);
   float f = atmFogAmount(d, cameraPosition.y, wp.y);
   return mix(col, atmFogColor(V), f);
}
`;

export function bindAtm(uniforms) {
   for (const k in ATM) uniforms[k] = ATM[k];
   return uniforms;
}

// Patch a stock MeshStandardMaterial: fog is applied in linear HDR right before tone
// mapping (three applies its own fog AFTER tone mapping + sRGB, which could never match a
// custom sky). `extra` lets callers add their own snippets (e.g. terrain detail noise).
export function patchAtmosphere(mat, extra = null) {
   mat.fog = false;
   mat.onBeforeCompile = (shader) => {
      bindAtm(shader.uniforms);
      if (extra && extra.uniforms) Object.assign(shader.uniforms, extra.uniforms);
      shader.vertexShader = shader.vertexShader
         .replace('#include <common>', '#include <common>\nvarying vec3 vAtmWP;\n' + (extra?.vertexPars || ''))
         .replace('#include <fog_vertex>', `#include <fog_vertex>
            vec4 atmWp = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
               atmWp = instanceMatrix * atmWp;
            #endif
            vAtmWP = (modelMatrix * atmWp).xyz;
            ${extra?.vertexMain || ''}`);
      shader.fragmentShader = shader.fragmentShader
         .replace('#include <common>', '#include <common>\nvarying vec3 vAtmWP;\n' + ATM_GLSL + (extra?.fragmentPars || ''))
         .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb = atmApply(gl_FragColor.rgb, vAtmWP);\n#include <tonemapping_fragment>');
      if (extra?.fragmentReplace) {
         for (const [a, b] of extra.fragmentReplace) shader.fragmentShader = shader.fragmentShader.replace(a, b);
      }
   };
   const key = 'atm:' + (extra?.key || 'std');
   mat.customProgramCacheKey = () => key;
   return mat;
}

// ---------------- seeded CPU noise ----------------
export function mulberry32(seed) {
   let a = (seed >>> 0) || 0x9e3779b9;
   return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
   };
}

const GRAD = new Float32Array([1, 0, -1, 0, 0, 1, 0, -1, 0.7071, 0.7071, -0.7071, 0.7071, 0.7071, -0.7071, -0.7071, -0.7071]);
// 2D gradient noise in [-1, 1] with its own permutation table.
export function makeNoise2D(seed) {
   const rnd = mulberry32(seed);
   const p = new Uint8Array(256);
   for (let i = 0; i < 256; i++) p[i] = i;
   for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
   const perm = new Uint8Array(512);
   for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
   return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const X = xi & 255, Y = yi & 255;
      const g00 = (perm[X + perm[Y]] & 7) * 2, g10 = (perm[X + 1 + perm[Y]] & 7) * 2;
      const g01 = (perm[X + perm[Y + 1]] & 7) * 2, g11 = (perm[X + 1 + perm[Y + 1]] & 7) * 2;
      const n00 = GRAD[g00] * xf + GRAD[g00 + 1] * yf;
      const n10 = GRAD[g10] * (xf - 1) + GRAD[g10 + 1] * yf;
      const n01 = GRAD[g01] * xf + GRAD[g01 + 1] * (yf - 1);
      const n11 = GRAD[g11] * (xf - 1) + GRAD[g11 + 1] * (yf - 1);
      const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
      const a = n00 + u * (n10 - n00), b = n01 + u * (n11 - n01);
      return (a + v * (b - a)) * 1.414;
   };
}
export function fbm(n, x, y, oct = 5, lac = 2.03, gain = 0.5) {
   let s = 0, a = 1, f = 1, norm = 0;
   for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); norm += a; a *= gain; f *= lac; }
   return s / norm;
}
// Ridged multifractal in [0, 1]: sharp crests (mountain ridges / cliffs).
export function ridged(n, x, y, oct = 4, lac = 2.1, gain = 0.5) {
   let s = 0, a = 1, f = 1, norm = 0, w = 1;
   for (let i = 0; i < oct; i++) {
      let r = 1 - Math.abs(n(x * f, y * f));
      r *= r;
      s += r * a * w; norm += a;
      w = Math.min(1, Math.max(0, r * 1.4));
      a *= gain; f *= lac;
   }
   return s / norm;
}

export const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Linear-space colour from an sRGB hex (vertex colours bypass three's colour management).
const _c = new THREE.Color();
export function lin(hex) { _c.set(hex); return [_c.r, _c.g, _c.b]; }
export function shade(rgb, k) { return [rgb[0] * k, rgb[1] * k, rgb[2] * k]; }

// ---------------- geometry builder ----------------
// Collects transformed primitives (three's own Box/Cylinder/... geometries) into one
// indexed, vertex-coloured BufferGeometry: a whole ship superstructure = one draw call.
const _m = new THREE.Matrix4(), _nm = new THREE.Matrix3(), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3();
export class GeoBuilder {
   // band: per-vertex material tag for the ship shader (0 = plain, 1 = hull side with
   // waterline stripes, 2 = planked deck); set b.band before adding a primitive.
   constructor() { this.pos = []; this.nrm = []; this.col = []; this.idx = []; this.bands = []; this.band = 0; }
   get vertexCount() { return this.pos.length / 3; }
   // color: [r,g,b] (linear) or fn(x, y, z) -> [r,g,b] evaluated in builder space
   add(geo, matrix, color) {
      const g = geo.index ? geo : geo;
      const P = g.attributes.position, N = g.attributes.normal;
      const base = this.vertexCount;
      _nm.getNormalMatrix(matrix);
      for (let i = 0; i < P.count; i++) {
         _v.fromBufferAttribute(P, i).applyMatrix4(matrix);
         this.pos.push(_v.x, _v.y, _v.z);
         const c = typeof color === 'function' ? color(_v.x, _v.y, _v.z) : color;
         this.col.push(c[0], c[1], c[2]);
         this.bands.push(this.band);
         if (N) { _v.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize(); this.nrm.push(_v.x, _v.y, _v.z); }
         else this.nrm.push(0, 1, 0);
      }
      if (g.index) { const I = g.index.array; for (let i = 0; i < I.length; i++) this.idx.push(base + I[i]); }
      else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
      geo.dispose();
      return this;
   }
   // convenience: position + euler rotation (+ optional non-uniform scale)
   put(geo, x, y, z, color, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
      _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e); _s.set(sx, sy, sz); _v.set(x, y, z);
      _m.compose(_v, _q, _s);
      return this.add(geo, _m, color);
   }
   box(w, h, d, x, y, z, color, ry = 0, rz = 0, rx = 0) { return this.put(new THREE.BoxGeometry(w, h, d), x, y, z, color, rx, ry, rz); }
   // vertical cylinder standing on (x, y, z)
   cyl(rt, rb, h, x, y, z, color, seg = 10, rz = 0, rx = 0) {
      const g = new THREE.CylinderGeometry(rt, rb, h, seg);
      g.translate(0, h / 2, 0);
      return this.put(g, x, y, z, color, rx, 0, rz);
   }
   // cylinder lying along +X starting at (x,y,z)
   tubeX(r0, r1, len, x, y, z, color, seg = 8) {
      const g = new THREE.CylinderGeometry(r1, r0, len, seg);
      g.translate(0, len / 2, 0);
      g.rotateZ(-Math.PI / 2);
      return this.put(g, x, y, z, color);
   }
   // Raw triangles (positions flat array, CCW), flat-shaded, single colour.
   tris(arr, color) {
      const base = this.vertexCount;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
      for (let i = 0; i < arr.length; i += 9) {
         a.set(arr[i], arr[i + 1], arr[i + 2]); b.set(arr[i + 3], arr[i + 4], arr[i + 5]); c.set(arr[i + 6], arr[i + 7], arr[i + 8]);
         n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
         for (const p of [a, b, c]) {
            this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z);
            const cc = typeof color === 'function' ? color(p.x, p.y, p.z) : color;
            this.col.push(cc[0], cc[1], cc[2]);
            this.bands.push(this.band);
         }
      }
      const cnt = this.vertexCount - base;
      for (let i = 0; i < cnt; i++) this.idx.push(base + i);
      return this;
   }
   // Pre-built indexed mesh data (positions/normals flat arrays) with a colour (fn) per vertex.
   raw(posArr, nrmArr, idxArr, color) {
      const base = this.vertexCount;
      for (let i = 0; i < posArr.length; i += 3) {
         const x = posArr[i], y = posArr[i + 1], z = posArr[i + 2];
         this.pos.push(x, y, z); this.nrm.push(nrmArr[i], nrmArr[i + 1], nrmArr[i + 2]);
         const c = typeof color === 'function' ? color(x, y, z) : color;
         this.col.push(c[0], c[1], c[2]);
         this.bands.push(this.band);
      }
      for (let i = 0; i < idxArr.length; i++) this.idx.push(base + idxArr[i]);
      return this;
   }
   build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      if (this.bands.some(v => v !== 0)) g.setAttribute('aBand', new THREE.Float32BufferAttribute(this.bands, 1));
      const n = this.vertexCount;
      g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      return g;
   }
}

// Dispose every geometry/material/texture below an object (used on rebuild/restart).
export function disposeTree(obj) {
   obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
         for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
            for (const k in m) { const v = m[k]; if (v && v.isTexture && !v.userData?.shared) v.dispose(); }
            m.dispose();
         }
      }
   });
}
