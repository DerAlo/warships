// game3d/fx3d.js — every transient effect, pooled and instanced (fixed draw-call count, no
// per-frame allocation): shell tracers, muzzle flashes + blast smoke, caliber-scaled splash
// columns, hit fireballs/sparks, citadel detonations, ship fires with drifting black smoke,
// funnel smoke, smoke screens, Kelvin wakes + bow waves + torpedo tracks that ride the swell,
// capture-zone rings, and a few pooled point lights for flashes.
// Impacts are derived from what the sim exposes, whichever sim is running: a shell/torpedo
// that disappears is an impact at its last position (extrapolated to the water); new
// world.effects of kind splash/explosion, when present, override the guessed impact type;
// world.events 'citadel' upgrades the hit. See ARCHITECTURE.md for the contract fields.
import * as THREE from '../vendor/three/three.module.min.js';
import { ATM_GLSL, bindAtm, clamp, lerp, mulberry32 } from './gfxcommon3d.js';
import { WAVES_GLSL } from './water3d.js';

const TAU = Math.PI * 2;
const rnd = Math.random;   // cosmetic only
const rr = (a, b) => a + (b - a) * rnd();

// ---------------- procedural tileable noise (RGBA: fbm, fbm, vertical streaks, fine fbm) ----------------
function makeNoiseTexture(N = 128) {
   const lat = (px, py, seed) => { const r = mulberry32(seed), a = new Float32Array(px * py); for (let i = 0; i < a.length; i++) a[i] = r(); return { a, px, py }; };
   const vn = (L, u, v) => {
      const x = u * L.px, y = v * L.py, x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const i0 = x0 % L.px, i1 = (x0 + 1) % L.px, j0 = y0 % L.py, j1 = (y0 + 1) % L.py;
      const a = L.a[j0 * L.px + i0], b = L.a[j0 * L.px + i1], c = L.a[j1 * L.px + i0], d = L.a[j1 * L.px + i1];
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
   };
   const oct = (base, n, seed, stretchY = 1) => Array.from({ length: n }, (_, i) => lat(base << i, Math.max(1, (base << i) / stretchY | 0), seed + i * 13));
   const A = oct(4, 5, 11), B = oct(4, 5, 57), C = oct(16, 3, 91, 8), D = oct(16, 4, 133);
   const fbm = (Ls, u, v) => { let s = 0, amp = 0.5, t = 0; for (const L of Ls) { s += vn(L, u, v) * amp; t += amp; amp *= 0.5; } return s / t; };
   const data = new Uint8Array(N * N * 4);
   const st = (x) => clamp((x - 0.5) * 1.9 + 0.5, 0, 1) * 255;
   for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = i / N, v = j / N, k = (j * N + i) * 4;
      data[k] = st(fbm(A, u, v)); data[k + 1] = st(fbm(B, u, v)); data[k + 2] = st(fbm(C, u, v)); data[k + 3] = st(fbm(D, u, v));
   }
   const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
   t.wrapS = t.wrapT = THREE.RepeatWrapping;
   t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
   t.generateMipmaps = true; t.needsUpdate = true;
   return t;
}

// ---------------- water surface placement (same swell + damping as the ocean) ----------------
const SURF_GLSL = /* glsl */`
${WAVES_GLSL}
uniform sampler2D uDepthTex;
uniform vec4 uDepthRect;
uniform vec4 uHullA[16];
uniform vec4 uHullB[16];
uniform int uHullN;
float fxDepthAt(vec2 p) {
   vec2 uv = (p - uDepthRect.xy) * uDepthRect.zw;
   if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 50.0;
   return texture2D(uDepthTex, uv).r * 50.0;
}
// plane point -> displaced surface point, lifted with distance to stay above the depth-buffer noise
vec3 surfPoint(vec2 p) {
   float dist = length(vec3(p.x, 0.0, p.y) - cameraPosition);
   float damp = mix(0.15, 1.0, smoothstep(0.5, 14.0, fxDepthAt(p)));
   for (int i = 0; i < 16; i++) {
      if (i >= uHullN) break;
      vec2 d = p - uHullA[i].xy;
      vec2 l = vec2(d.x * uHullA[i].z + d.y * uHullA[i].w, -d.x * uHullA[i].w + d.y * uHullA[i].z) * uHullB[i].xy;
      damp *= mix(0.3, 1.0, smoothstep(0.85, 1.25, length(l)));
   }
   vec3 o = waveDisp(p, dist, damp);
   return vec3(p.x + o.x, o.y + 0.15 + dist * 0.0006, p.y + o.z);
}
// Pure depth bias: slide the point along its own view ray toward the camera (same pixel, nearer
// depth). The coarse strips interpolate the swell linearly between sparse vertices, so the finely
// tessellated ocean poked through them as dark crest-shaped holes; at grazing angles a 1 m
// height error is several metres along the ray, hence the distance term.
vec3 toCam(vec3 wp) {
   vec3 v = cameraPosition - wp;
   float d = length(v);
   return wp + v / max(d, 1.0) * min(d * 0.5, 1.5 + d * 0.004);
}
`;

// ---------------- billboard particles ----------------
const PART_VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iCol;
attribute vec4 iSz;    // width, height, rotation, shape
attribute vec4 iAx;    // axis xyz, mode (0 facing, 1 axis centred, 2 axis base-anchored)
attribute vec4 iMs;    // lit, seed, age fraction, -
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vMs;
varying float vShape;
varying vec3 vWP;
varying vec3 vRight;
varying vec3 vUp;
varying float vNear;
void main() {
   vec2 q = position.xy;
   vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
   vec3 U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
   vec3 wp;
   if (iAx.w > 0.5) {
      vec3 ax = iAx.xyz;
      vec3 side = cross(ax, cameraPosition - iPos);
      float sl = length(side);
      side = sl > 1e-4 ? side / sl : R;
      float yy = iAx.w > 1.5 ? q.y + 0.5 : q.y;
      wp = iPos + side * (q.x * iSz.x) + ax * (yy * iSz.y);
      vRight = side; vUp = ax;
   } else {
      float c = cos(iSz.z), s = sin(iSz.z);
      vec2 r = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
      wp = iPos + R * (r.x * iSz.x) + U * (r.y * iSz.y);
      vRight = R * c + U * s; vUp = U * c - R * s;
   }
   vUv = q + 0.5;
   vCol = iCol; vMs = iMs; vShape = iSz.w; vWP = wp;
   // fade billboards the camera is about to pass through (they would clip at the near plane)
   float sz = max(iSz.x, iSz.y * 0.5);
   vNear = clamp((length(iPos - cameraPosition) - sz * 0.3) / (sz * 0.7 + 1.0), 0.0, 1.0);
   gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const PART_FRAG = /* glsl */`
${ATM_GLSL}
uniform sampler2D uNoise;
uniform vec3 uSunCol;
uniform vec3 uAmb;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vMs;
varying float vShape;
varying vec3 vWP;
varying vec3 vRight;
varying vec3 vUp;
varying float vNear;
void main() {
   vec2 c = vUv * 2.0 - 1.0;
   float d2 = dot(c, c);
   float u = vMs.z, seed = vMs.y;
   vec3 col = vCol.rgb;
   float a;
   if (vShape < 0.5) {              // soft glow
      a = pow(max(0.0, 1.0 - d2), 2.0);
#ifdef ADD
      col *= 1.0 + 1.2 * pow(max(0.0, 1.0 - d2 * 3.0), 3.0);
#endif
   } else if (vShape < 1.5) {       // puff: noise-eroded sphere that frays with age
      vec4 n = texture2D(uNoise, vUv * 0.5 + vec2(seed, seed * 1.73));
      float nn = n.r * 0.6 + n.a * 0.4;
      float den = 1.0 - smoothstep(0.25, 1.0, sqrt(d2));
      a = clamp((den * 1.3 - (1.0 - nn) * (0.5 + 0.4 * u)) * 2.0, 0.0, 1.0);
   } else if (vShape < 2.5) {       // splash column: streaky, narrowing, ragged top
      float n = texture2D(uNoise, vec2(vUv.x * 0.7 + seed, vUv.y * 0.3 - u * 0.15)).b;
      float w = mix(1.0, 0.45, vUv.y);
      float edge = 1.0 - smoothstep(w * 0.45, w, abs(c.x) + (n - 0.5) * 0.45);
      float top = 1.0 - smoothstep(0.5, 1.0, vUv.y + (n - 0.5) * 0.45);
      a = edge * top * (0.5 + 0.7 * n);
   } else {                         // streak: thin core, bright head at the top
      float ac = 1.0 - abs(c.x);
      a = ac * ac * smoothstep(0.0, 0.3, vUv.y) * (0.3 + 0.7 * vUv.y) * (1.0 - smoothstep(0.92, 1.0, vUv.y));
#ifdef ADD
      col *= 1.0 + 3.0 * pow(ac, 6.0) * smoothstep(0.55, 0.95, vUv.y);
#endif
   }
   a *= vCol.a * vNear;
   if (a < 0.004) discard;
   vec3 V = vWP - cameraPosition;
   float dist = length(V);
   float f = atmFogAmount(dist, cameraPosition.y, max(vWP.y, 0.0));
#ifdef ADD
   gl_FragColor = vec4(col * a * (1.0 - f), 1.0);
#else
   vec3 Vn = -V / max(dist, 1e-3);
   vec3 N = normalize(vRight * c.x + vUp * c.y + Vn * sqrt(max(0.0, 1.0 - d2)));
   float diff = clamp(dot(N, uSunDir) * 0.6 + 0.4, 0.0, 1.0);
   float fwd = pow(max(dot(-Vn, uSunDir), 0.0), 6.0) * (1.0 - a) * 0.8;   // thin edges glow against the sun
   vec3 L = uAmb + uSunCol * (diff * 0.85 + fwd);
   vec3 lc = mix(col, col * L, vMs.x);
   lc = mix(lc, atmFogColor(V), f);
   gl_FragColor = vec4(lc, a);
#endif
}`;

// particle record layout (floats)
const S = 31;
const X = 0, Y = 1, Z = 2, VX = 3, VY = 4, VZ = 5, AGE = 6, LIFE = 7, S0 = 8, S1 = 9, GROW = 10,
   R0 = 11, G0 = 12, B0 = 13, R1 = 14, G1 = 15, B1 = 16, A0 = 17, FIN = 18, DRAG = 19, GRAV = 20,
   STR = 21, ROT = 22, SPIN = 23, SHAPE = 24, LIT = 25, SEED = 26, ASP = 27, WIND = 28, FOUT = 29, HGT = 30;

const TPL_DEFAULT = {
   x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, s0: 1, s1: 1, grow: 1,
   r: 1, g: 1, b: 1, r1: -1, g1: -1, b1: -1, a: 1, fin: 0.05, fout: 0.4, drag: 0, grav: 0,
   stretch: 0, rot: 0, spin: 0, shape: 0, lit: 0, aspect: 0, wind: 0, h: 0, axX: 0, axY: 0, axZ: 0,
};

class ParticlePool {
   constructor(max, additive, noiseTex, atmUniforms) {
      this.max = max;
      this.additive = additive;
      this.d = new Float32Array(max * S);
      this.ax = new Float32Array(max * 3);   // explicit axis for immediate streaks
      this.imm = new Uint8Array(max);
      this.n = 0;
      this.keys = new Float64Array(max);
      this.ord = new Uint32Array(max);
      this.p = Object.assign({}, TPL_DEFAULT);
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
      this.aPos = mk(3); this.aCol = mk(4); this.aSz = mk(4); this.aAx = mk(4); this.aMs = mk(4);
      g.setAttribute('iPos', this.aPos); g.setAttribute('iCol', this.aCol); g.setAttribute('iSz', this.aSz);
      g.setAttribute('iAx', this.aAx); g.setAttribute('iMs', this.aMs);
      g.instanceCount = 0;
      this.geometry = g;
      this.material = new THREE.ShaderMaterial({
         uniforms: Object.assign(atmUniforms, { uNoise: { value: noiseTex } }),
         vertexShader: PART_VERT, fragmentShader: PART_FRAG,
         defines: additive ? { ADD: 1 } : {},
         transparent: true, depthWrite: false,
         blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      this.mesh = new THREE.Mesh(g, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = additive ? 30 : 20;
   }

   // returns the reset spawn template; fill it, then call emit()
   t() { return Object.assign(this.p, TPL_DEFAULT); }

   emit(immediate = false) {
      if (this.n >= this.max) return -1;
      const i = this.n++, o = i * S, p = this.p, d = this.d;
      d[o + X] = p.x; d[o + Y] = p.y; d[o + Z] = p.z; d[o + VX] = p.vx; d[o + VY] = p.vy; d[o + VZ] = p.vz;
      d[o + AGE] = 0; d[o + LIFE] = Math.max(p.life, 1e-3); d[o + S0] = p.s0; d[o + S1] = p.s1; d[o + GROW] = p.grow;
      d[o + R0] = p.r; d[o + G0] = p.g; d[o + B0] = p.b;
      d[o + R1] = p.r1 < 0 ? p.r : p.r1; d[o + G1] = p.g1 < 0 ? p.g : p.g1; d[o + B1] = p.b1 < 0 ? p.b : p.b1;
      d[o + A0] = p.a; d[o + FIN] = p.fin; d[o + FOUT] = p.fout; d[o + DRAG] = p.drag; d[o + GRAV] = p.grav;
      d[o + STR] = p.stretch; d[o + ROT] = p.rot; d[o + SPIN] = p.spin; d[o + SHAPE] = p.shape; d[o + LIT] = p.lit;
      d[o + SEED] = rnd(); d[o + ASP] = p.aspect; d[o + WIND] = p.wind; d[o + HGT] = p.h;
      this.ax[i * 3] = p.axX; this.ax[i * 3 + 1] = p.axY; this.ax[i * 3 + 2] = p.axZ;
      this.imm[i] = immediate ? 1 : 0;
      return i;
   }

   _kill(i) {
      const last = --this.n;
      if (i !== last) {
         this.d.copyWithin(i * S, last * S, last * S + S);
         this.ax.copyWithin(i * 3, last * 3, last * 3 + 3);
         this.imm[i] = this.imm[last];
      }
   }

   update(dt, cam, windX, windZ) {
      const d = this.d;
      // integrate + retire (immediate instances are drawn once, then dropped below)
      for (let i = this.n - 1; i >= 0; i--) {
         if (this.imm[i]) continue;
         const o = i * S;
         const age = d[o + AGE] + dt;
         if (age >= d[o + LIFE]) { this._kill(i); continue; }
         d[o + AGE] = age;
         const k = Math.exp(-d[o + DRAG] * dt);
         d[o + VX] *= k; d[o + VZ] *= k; d[o + VY] = d[o + VY] * k - d[o + GRAV] * dt;
         const w = d[o + WIND];
         d[o + X] += (d[o + VX] + windX * w) * dt;
         d[o + Y] += d[o + VY] * dt;
         d[o + Z] += (d[o + VZ] + windZ * w) * dt;
         d[o + ROT] += d[o + SPIN] * dt;
      }
      const n = this.n;
      const ord = this.ord;
      if (!this.additive && n > 1) {
         // back to front: (depth, index) packed into one double for the native numeric sort -- a
         // comparator sort copies the whole array onto the JS heap every frame
         const keys = this.keys, cx = cam.x, cy = cam.y, cz = cam.z;
         for (let i = 0; i < n; i++) { const o = i * S; const dx = d[o] - cx, dy = d[o + 1] - cy, dz = d[o + 2] - cz; keys[i] = Math.floor(Math.min(1e10, dx * dx + dy * dy + dz * dz)) * 65536 + i; }
         const v = keys.subarray(0, n);
         v.sort();
         for (let j = 0; j < n; j++) ord[j] = v[n - 1 - j] % 65536;
      } else for (let i = 0; i < n; i++) ord[i] = i;
      const P = this.aPos.array, C = this.aCol.array, SZ = this.aSz.array, AX = this.aAx.array, M = this.aMs.array;
      for (let j = 0; j < n; j++) {
         const i = ord[j], o = i * S;
         const u = this.imm[i] ? 0 : d[o + AGE] / d[o + LIFE];
         const fin = d[o + FIN], fout = d[o + FOUT];
         let a = d[o + A0];
         if (fin > 0 && u < fin) a *= u / fin;
         if (u > fout) a *= Math.max(0, 1 - (u - fout) / Math.max(1e-3, 1 - fout));
         const sz = d[o + S0] + (d[o + S1] - d[o + S0]) * (1 - Math.pow(1 - u, d[o + GROW]));
         let w = sz, h = sz, mode = 0, axx = 0, axy = 0, axz = 0;
         const asp = d[o + ASP], str = d[o + STR], hg = d[o + HGT];
         if (asp > 0) {          // vertical column anchored at its base
            mode = 2; axy = 1; h = sz * asp * (1 - 0.3 * Math.max(0, (u - 0.5) * 2));
         } else if (hg > 0) {    // explicit axis + height (tracers)
            mode = 1; axx = this.ax[i * 3]; axy = this.ax[i * 3 + 1]; axz = this.ax[i * 3 + 2]; h = hg;
         } else if (str > 0) {   // stretched along velocity (sparks, spray)
            const vx = d[o + VX], vy = d[o + VY], vz = d[o + VZ], vl = Math.hypot(vx, vy, vz);
            if (vl > 0.5) { mode = 1; axx = vx / vl; axy = vy / vl; axz = vz / vl; h = sz + vl * str; }
         }
         P[j * 3] = d[o + X]; P[j * 3 + 1] = d[o + Y]; P[j * 3 + 2] = d[o + Z];
         C[j * 4] = lerp(d[o + R0], d[o + R1], u); C[j * 4 + 1] = lerp(d[o + G0], d[o + G1], u); C[j * 4 + 2] = lerp(d[o + B0], d[o + B1], u); C[j * 4 + 3] = a;
         SZ[j * 4] = w; SZ[j * 4 + 1] = h; SZ[j * 4 + 2] = d[o + ROT]; SZ[j * 4 + 3] = d[o + SHAPE];
         AX[j * 4] = axx; AX[j * 4 + 1] = axy; AX[j * 4 + 2] = axz; AX[j * 4 + 3] = mode;
         M[j * 4] = d[o + LIT]; M[j * 4 + 1] = d[o + SEED]; M[j * 4 + 2] = u; M[j * 4 + 3] = 0;
      }
      for (let i = this.n - 1; i >= 0; i--) if (this.imm[i]) this._kill(i);
      this.geometry.instanceCount = n;
      if (n > 0) for (const at of [this.aPos, this.aCol, this.aSz, this.aAx, this.aMs]) { at.clearUpdateRanges(); at.addUpdateRange(0, n * at.itemSize); at.needsUpdate = true; }
   }

   clear() { this.n = 0; this.geometry.instanceCount = 0; }
   dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------- flat water decals (foam rings, blast rings, slicks, bow waves) ----------------
const DECAL_VERT = /* glsl */`
${SURF_GLSL}
attribute vec4 iA;   // x, z, rotation, type
attribute vec4 iB;   // size x (along), size z (across), age fraction, seed
attribute float iC;  // alpha
varying vec2 vUv;
varying vec3 vWP;
varying vec2 vPlane;
varying vec4 vB;
varying float vType;
varying float vAlpha;
void main() {
   vec2 l = position.xz * iB.xy;
   float c = cos(iA.z), s = sin(iA.z);
   vec2 p = iA.xy + vec2(c * l.x - s * l.y, s * l.x + c * l.y);
   vec3 wp = toCam(surfPoint(p));
   vUv = position.xz + 0.5;
   vWP = wp; vPlane = p; vB = iB; vType = iA.w; vAlpha = iC;
   gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const DECAL_FRAG = /* glsl */`
${ATM_GLSL}
uniform sampler2D uNoise;
uniform vec3 uFoamCol;
varying vec2 vUv;
varying vec3 vWP;
varying vec2 vPlane;
varying vec4 vB;
varying float vType;
varying float vAlpha;
void main() {
   vec2 c = vUv * 2.0 - 1.0;
   float r = length(c);
   float u = vB.z, seed = vB.w;
   float n = texture2D(uNoise, vPlane / 13.0 + seed).a * 0.6 + texture2D(uNoise, vPlane / 41.0 - seed).r * 0.4;
   float a = 0.0;
   vec3 col = uFoamCol;
   if (vType < 0.5) {            // splash foam ring + fill, dissolving
      float ring = exp(-pow((r - 0.78) / 0.12, 2.0));
      float fill = (1.0 - smoothstep(0.1, 0.8, r)) * (1.0 - u) * 0.8;
      a = (ring + fill) * smoothstep(0.3 + 0.45 * u, 0.75 + 0.2 * u, n + 0.15);
      a *= 1.0 - smoothstep(0.6, 1.0, u);
   } else if (vType < 1.5) {     // muzzle blast ring on the water
      float ring = exp(-pow((r - 0.85) / 0.08, 2.0));
      a = ring * (1.0 - u) * (1.0 - u) * smoothstep(0.2, 0.6, n + 0.2);
      a += (1.0 - smoothstep(0.0, 0.85, r)) * (1.0 - u) * 0.25 * n;
   } else if (vType < 2.5) {     // sinking slick: churned foam over a dark oily patch
      float rr = r + (n - 0.5) * 0.5;
      float m = 1.0 - smoothstep(0.55, 1.0, rr);
      float foam = smoothstep(0.55, 0.8, n) * (1.0 - u);
      col = mix(vec3(0.012, 0.014, 0.016), uFoamCol, foam);
      a = m * (0.45 + 0.4 * foam) * (1.0 - smoothstep(0.7, 1.0, u));
   } else {                      // bow wave: foam hugging the hull sides from the stem aft
      float x = vUv.x;           // 0 = aft end of the decal, 1 = stem
      float y = abs(c.y);
      float prof = 0.34 * sqrt(clamp((1.0 - x) / 0.85, 0.0, 1.0)) + 0.02;
      float band = exp(-pow((y - prof) / (0.05 + 0.18 * (1.0 - x)), 2.0));
      float stem = exp(-pow((1.0 - x) / 0.08, 2.0)) * (1.0 - smoothstep(0.0, 0.3, y));
      float fadeAft = smoothstep(0.0, 0.45, x);
      a = (band * fadeAft + stem) * smoothstep(0.25, 0.7, n + 0.25 * x);
   }
   a *= vAlpha;
   if (a < 0.004) discard;
   vec3 V = vWP - cameraPosition;
   float f = atmFogAmount(length(V), cameraPosition.y, max(vWP.y, 0.0));
   gl_FragColor = vec4(mix(col, atmFogColor(V), f), clamp(a, 0.0, 1.0));
}`;

const DS = 16;
const DX = 0, DZ = 1, DROT = 2, DAGE = 3, DLIFE = 4, DS0 = 5, DS1 = 6, DGROW = 7, DA = 8, DTYPE = 9, DSEED = 10, DASP = 11, DIMM = 12, DFOUT = 13;

class DecalPool {
   constructor(max, noiseTex, uniforms) {
      this.max = max;
      this.d = new Float32Array(max * DS);
      this.n = 0;
      const plane = new THREE.PlaneGeometry(1, 1, 8, 8);
      plane.rotateX(-Math.PI / 2);
      const g = new THREE.InstancedBufferGeometry();
      g.index = plane.index;
      g.setAttribute('position', plane.getAttribute('position'));
      const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
      this.aA = mk(4); this.aB = mk(4); this.aC = mk(1);
      g.setAttribute('iA', this.aA); g.setAttribute('iB', this.aB); g.setAttribute('iC', this.aC);
      g.instanceCount = 0;
      this.geometry = g;
      this.material = new THREE.ShaderMaterial({
         uniforms: Object.assign(uniforms, { uNoise: { value: noiseTex } }),
         vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG,
         transparent: true, depthWrite: false,
      });
      this.mesh = new THREE.Mesh(g, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 12;
   }

   // size = full extent across (m); aspect = along/across
   add(type, x, z, rot, s0, s1, life, alpha, grow = 2, aspect = 1, immediate = false, fout = 0.5) {
      if (this.n >= this.max) return;
      const o = this.n++ * DS, d = this.d;
      d[o + DX] = x; d[o + DZ] = z; d[o + DROT] = rot; d[o + DAGE] = 0; d[o + DLIFE] = Math.max(life, 1e-3);
      d[o + DS0] = s0; d[o + DS1] = s1; d[o + DGROW] = grow; d[o + DA] = alpha; d[o + DTYPE] = type;
      d[o + DSEED] = rnd(); d[o + DASP] = aspect; d[o + DIMM] = immediate ? 1 : 0; d[o + DFOUT] = fout;
   }

   _kill(i) { const last = --this.n; if (i !== last) this.d.copyWithin(i * DS, last * DS, last * DS + DS); }

   update(dt) {
      const d = this.d;
      for (let i = this.n - 1; i >= 0; i--) {
         const o = i * DS;
         if (d[o + DIMM]) continue;
         d[o + DAGE] += dt;
         if (d[o + DAGE] >= d[o + DLIFE]) this._kill(i);
      }
      const A = this.aA.array, B = this.aB.array, C = this.aC.array;
      const n = this.n;
      for (let i = 0; i < n; i++) {
         const o = i * DS;
         const u = d[o + DIMM] ? 0 : d[o + DAGE] / d[o + DLIFE];
         const sz = d[o + DS0] + (d[o + DS1] - d[o + DS0]) * (1 - Math.pow(1 - u, d[o + DGROW]));
         A[i * 4] = d[o + DX]; A[i * 4 + 1] = d[o + DZ]; A[i * 4 + 2] = d[o + DROT]; A[i * 4 + 3] = d[o + DTYPE];
         B[i * 4] = sz * d[o + DASP]; B[i * 4 + 1] = sz; B[i * 4 + 2] = u; B[i * 4 + 3] = d[o + DSEED];
         C[i] = d[o + DA];
      }
      for (let i = this.n - 1; i >= 0; i--) if (d[i * DS + DIMM]) this._kill(i);
      this.geometry.instanceCount = n;
      if (n > 0) for (const at of [this.aA, this.aB, this.aC]) { at.clearUpdateRanges(); at.addUpdateRange(0, n * at.itemSize); at.needsUpdate = true; }
   }

   clear() { this.n = 0; this.geometry.instanceCount = 0; }
   dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------- wakes: one dynamic strip mesh for every ship + torpedo track ----------------
const WAKE_VERT = /* glsl */`
${SURF_GLSL}
attribute vec4 aA;   // side (-1..1), half width (m), age fraction, kind (0 ship, 1 torpedo)
attribute vec3 aB;   // beam (m), intensity, distance along the track from the emitter (m)
varying vec4 vA;
varying vec3 vB;
varying vec3 vWP;
varying vec2 vPlane;
void main() {
   vec3 wp = toCam(surfPoint(position.xz));
   vA = aA; vB = aB; vWP = wp; vPlane = position.xz;
   gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const WAKE_FRAG = /* glsl */`
${ATM_GLSL}
uniform sampler2D uNoise;
uniform vec3 uFoamCol;
uniform float uTime;
varying vec4 vA;
varying vec3 vB;
varying vec3 vWP;
varying vec2 vPlane;
void main() {
   float as = abs(vA.x), u = vA.z;
   float m = as * vA.y;                     // metres from the track centre line
   // track-aligned coordinates stretch the noise into streaks that follow the ship's path
   vec2 tc = vec2(vA.x * vA.y, vB.z);
   float n = texture2D(uNoise, tc / vec2(9.0, 70.0)).a * 0.45 + texture2D(uNoise, tc / vec2(3.0, 16.0) + 0.37).r * 0.55;
   float foam, aer;
   if (vA.w < 0.5) {
      // turbulent band about a beam wide that widens slowly; foam breaks up into streaks with age
      float washW = vB.x * (0.42 + 0.55 * u);
      float band = 1.0 - smoothstep(washW * 0.35, washW, m);
      float thr = 0.42 + 0.42 * u;
      float wash = band * smoothstep(thr, thr + 0.25, n) * pow(1.0 - u, 1.8);
      // white water at the stern: broken up by the noise and faded well inside the strip edge (a
      // solid full-width churn read as a white slab glued to the transom)
      float churn = (1.0 - smoothstep(0.0, 0.08, u)) * (1.0 - smoothstep(0.05, 0.42, m / max(vB.x, 1.0)))
         * smoothstep(0.2, 0.6, n + 0.25 * (1.0 - u / 0.08));
      // screw-race foam line down the centre: outlasts the wash so the track reads from far off
      float centre = (1.0 - smoothstep(0.08, 0.5, m / max(washW, 1.0))) * pow(1.0 - u, 1.25) * smoothstep(0.22, 0.55, n + 0.35 * (1.0 - u));
      float arm = exp(-pow((as - 0.9) / 0.06, 2.0)) * (1.0 - smoothstep(0.03, 0.4, u)) * smoothstep(0.3, 0.7, n);
      foam = (wash * 0.75 + churn * 0.7 + arm * 0.45 + centre * 0.45) * vB.y;
      aer = band * (1.0 - u) * vB.y;           // aerated, lighter water under the foam
   } else {
      float core = 1.0 - smoothstep(0.15, 1.0, as);
      foam = core * (1.0 - u) * smoothstep(0.25, 0.65, n + 0.25 * (1.0 - u)) * vB.y;
      aer = core * (1.0 - u) * vB.y * 0.6;
   }
   foam = 1.0 - exp(-1.5 * foam);          // soft saturation: overlapping terms no longer merge into a flat white slab
   float a = max(foam, aer * 0.22);
   if (a < 0.004) discard;
   vec3 col = mix(uFoamCol * vec3(0.5, 0.82, 0.84), uFoamCol, foam / a);
   vec3 V = vWP - cameraPosition;
   float f = atmFogAmount(length(V), cameraPosition.y, max(vWP.y, 0.0));
   gl_FragColor = vec4(mix(col, atmFogColor(V), f), a);
}`;

const MAXT = 64, MAXP = 80;

class Wakes {
   constructor(noiseTex, uniforms) {
      this.trails = new Map();
      this.free = [];
      const nv = MAXT * (MAXP + 1) * 2;
      this.pos = new Float32Array(nv * 3);
      this.aA = new Float32Array(nv * 4);
      this.aB = new Float32Array(nv * 3);
      this.idx = new Uint16Array(MAXT * MAXP * 6);
      const g = new THREE.BufferGeometry();
      const dyn = (arr, n) => { const a = new THREE.BufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
      this.gPos = dyn(this.pos, 3); this.gA = dyn(this.aA, 4); this.gB = dyn(this.aB, 3); this.gIdx = dyn(this.idx, 1);
      g.setAttribute('position', this.gPos); g.setAttribute('aA', this.gA); g.setAttribute('aB', this.gB);
      g.setIndex(this.gIdx);
      g.setDrawRange(0, 0);
      this.geometry = g;
      this.material = new THREE.ShaderMaterial({
         uniforms: Object.assign(uniforms, { uNoise: { value: noiseTex } }),
         vertexShader: WAKE_VERT, fragmentShader: WAKE_FRAG,
         transparent: true, depthWrite: false, side: THREE.DoubleSide,   // strips fold over in tight turns; culling punched holes
      });
      this.mesh = new THREE.Mesh(g, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 11;
   }

   _new(kind) {
      const t = this.free.pop() || { px: new Float32Array(MAXP), pz: new Float32Array(MAXP), pt: new Float32Array(MAXP), ps: new Float32Array(MAXP), pd: new Float32Array(MAXP), head: 0, count: 0 };
      t.head = 0; t.count = 0; t.kind = kind; t.tk = 0; t.live = false; t.fed = false; t.odo = 0; t.hx = NaN;
      return t;
   }

   // x,z: emitter (stern / torpedo) position this frame; spd m/s; inten 0..1
   feed(key, kind, x, z, spd, beam, inten, time) {
      let t = this.trails.get(key);
      if (!t) {
         if (this.trails.size >= MAXT) return;
         t = this._new(kind); this.trails.set(key, t);
      }
      // odometer gives the foam streaks a world-fixed along-track coordinate
      if (t.hx === t.hx) t.odo += Math.min(200, Math.hypot(x - t.hx, z - t.hz));
      t.fed = true; t.live = true; t.hx = x; t.hz = z; t.beam = beam; t.inten = inten; t.spd = spd;
      // The look was tuned at real-time speeds; the sim runs ~5x time-compressed (2.6 m/s per knot).
      // tk ages the trail faster in proportion so wake LENGTH, Kelvin spread and stern churn stay
      // true to distance instead of turning into a 2 km white carpet.
      const tk = clamp(spd / (kind === 0 ? 15 : 25), 1, 6);
      t.tk = t.tk ? t.tk + (tk - t.tk) * 0.05 : tk;
      const last = t.count ? (t.head + MAXP - 1) % MAXP : -1;
      const spacing = (kind === 0 ? Math.max(5, spd * 0.4) : Math.max(4, spd * 0.25)) / Math.max(1, t.tk * 0.6);   // denser points: the trail is shorter now
      if (last < 0 || Math.hypot(x - t.px[last], z - t.pz[last]) >= spacing) {
         t.px[t.head] = x; t.pz[t.head] = z; t.pt[t.head] = time; t.ps[t.head] = spd * inten; t.pd[t.head] = t.odo;
         t.head = (t.head + 1) % MAXP;
         t.count = Math.min(MAXP, t.count + 1);
      }
   }

   update(time) {
      const P = this.pos, A = this.aA, B = this.aB, I = this.idx;
      let v = 0, ic = 0;
      for (const [key, t] of this.trails) {
         if (!t.fed) t.live = false;
         t.fed = false;
         const life = t.kind === 0 ? 26 : 11, tk = t.tk || 1;
         // retire points older than the lifetime
         while (t.count && (time - t.pt[(t.head + MAXP - t.count) % MAXP]) * tk > life) t.count--;
         if (!t.count && !t.live) { this.trails.delete(key); this.free.push(t); continue; }
         const n = t.count + (t.live ? 1 : 0);
         if (n < 2) continue;
         const v0 = v;
         for (let k = 0; k < n; k++) {
            // k = 0 newest (live head if present)
            let x, z, pt, sp, od;
            const lv = t.live ? 1 : 0;
            if (t.live && k === 0) { x = t.hx; z = t.hz; pt = time; sp = t.spd * t.inten; od = t.odo; }
            else { const q = (t.head + MAXP - 1 - (k - lv)) % MAXP; x = t.px[q]; z = t.pz[q]; pt = t.pt[q]; sp = t.ps[q]; od = t.pd[q]; }
            // tangent from neighbours
            let ax, az, bx, bz;
            if (k === 0) { ax = x; az = z; } else if (t.live && k === 1) { ax = t.hx; az = t.hz; } else { const q = (t.head + MAXP - k + lv) % MAXP; ax = t.px[q]; az = t.pz[q]; }
            if (k === n - 1) { bx = x; bz = z; } else { const q = (t.head + MAXP - 2 - k + lv) % MAXP; bx = t.px[q]; bz = t.pz[q]; }
            let dx = ax - bx, dz = az - bz;
            const dl = Math.hypot(dx, dz) || 1;
            dx /= dl; dz /= dl;
            const age = Math.max(0, time - pt) * tk;
            sp /= tk;
            const u = Math.min(1, age / life);
            // Kelvin spread, capped: past ~12 s the arms have faded and a huge fan only folds over itself in turns
            const hw = t.kind === 0 ? t.beam * 0.75 + Math.min(age, 12) * Math.max(sp, 2) * 0.3 : 1.0 + Math.min(age, 8) * 0.45;
            const nx = -dz, nz = dx;
            for (let s = -1; s <= 1; s += 2) {
               P[v * 3] = x + nx * hw * s; P[v * 3 + 1] = 0; P[v * 3 + 2] = z + nz * hw * s;
               A[v * 4] = s; A[v * 4 + 1] = hw; A[v * 4 + 2] = u; A[v * 4 + 3] = t.kind;
               B[v * 3] = t.beam; B[v * 3 + 1] = clamp(sp / (t.kind === 0 ? 12 : 20), 0, 1) * (t.kind === 0 ? 1 : 0.9); B[v * 3 + 2] = od;
               v++;
            }
         }
         for (let k = 0; k < n - 1; k++) {
            const a = v0 + k * 2, b = a + 1, c = a + 2, d = a + 3;
            I[ic++] = a; I[ic++] = c; I[ic++] = b;
            I[ic++] = b; I[ic++] = c; I[ic++] = d;
         }
      }
      this.geometry.setDrawRange(0, ic);
      if (ic > 0) {
         for (const [at, n] of [[this.gPos, v * 3], [this.gA, v * 4], [this.gB, v * 3], [this.gIdx, ic]]) { at.clearUpdateRanges(); at.addUpdateRange(0, n); at.needsUpdate = true; }
      }
   }

   clear() { for (const t of this.trails.values()) this.free.push(t); this.trails.clear(); this.geometry.setDrawRange(0, 0); }
   dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------- rain: world-anchored streaks wrapped in a box around the camera ----------------
// All motion is in the vertex shader, so rain costs one static draw call and zero CPU.
const RAIN_VERT = /* glsl */`
attribute vec2 aK;   // 0 = streak head / 1 = tail, speed variation
uniform float uTime;
uniform float uBox;
uniform vec3 uWindV;
varying float vA;
void main() {
   vec3 vel = vec3(uWindV.x, -uWindV.y * aK.y, uWindV.z);
   vec3 hb = vec3(uBox * 0.5, uBox * 0.35, uBox * 0.5);
   vec3 size = hb * 2.0;
   vec3 rel = mod(position * size + vel * uTime - cameraPosition + hb, size) - hb;
   vec3 wp = cameraPosition + rel - normalize(vel) * aK.x * (1.1 + aK.y * 0.6);
   float d = length(rel);
   vA = smoothstep(1.5, 5.0, d) * (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, d));
   gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const RAIN_FRAG = /* glsl */`
uniform vec3 uCol;
uniform float uAlpha;
varying float vA;
void main() {
   float a = vA * uAlpha;
   if (a < 0.003) discard;
   gl_FragColor = vec4(uCol, a);
}`;

class Rain {
   constructor(n = 5000) {
      const rnd = mulberry32(4242);
      const pos = new Float32Array(n * 6), k = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
         const x = rnd(), y = rnd(), z = rnd(), s = 0.8 + rnd() * 0.4;
         pos.set([x, y, z, x, y, z], i * 6);
         k.set([0, s, 1, s], i * 4);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aK', new THREE.BufferAttribute(k, 2));
      this.uniforms = {
         uTime: { value: 0 }, uBox: { value: 70 }, uWindV: { value: new THREE.Vector3(2, 11, 1) },
         uCol: { value: new THREE.Color(0.6, 0.65, 0.7) }, uAlpha: { value: 0 },
      };
      this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false });
      this.geometry = g;
      this.mesh = new THREE.LineSegments(g, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 40;
      this.mesh.visible = false;
   }
   setEnv(rain, amb) {
      this.mesh.visible = rain > 0.01;
      this.uniforms.uAlpha.value = 0.28 * rain;
      this.uniforms.uCol.value.copy(amb).multiplyScalar(0.9);
   }
   update(time, wx, wz) {
      this.uniforms.uTime.value = time;
      this.uniforms.uWindV.value.set(wx * 1.6, 11, wz * 1.6);
   }
   dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------- capture zones: ring on the water + letter marker ----------------
const capSide = (v) => v === 'player' || v === 'friendly' || v === 'ally' ? 'player' : v === 'enemy' ? 'enemy' : null;
const CAP_VERT = /* glsl */`
${SURF_GLSL}
uniform vec2 uC;
uniform float uR;
uniform float uW;
varying float vAng;
varying float vK;
varying vec3 vWP;
void main() {
   float ang = position.x, k = position.y;
   float rad = k < 0.5 ? uR + uW * 0.5 : k < 1.5 ? uR - uW * 0.5 : uR - uW * 0.5 - min(90.0, uR * 0.3);
   vec2 p = uC + vec2(cos(ang), sin(ang)) * rad;
   vec3 wp = toCam(surfPoint(p));
   vAng = ang; vK = k; vWP = wp;
   gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const CAP_FRAG = /* glsl */`
${ATM_GLSL}
uniform vec3 uCol;
uniform vec3 uProgCol;
uniform float uProg;
uniform float uR;
uniform float uDash;
uniform float uTime;
varying float vAng;
varying float vK;
varying vec3 vWP;
void main() {
   float fr = fract(vAng / 6.2831853 + 0.25);   // progress sweeps clockwise from north
   vec3 col = fr < uProg ? uProgCol : uCol;
   float a;
   if (vK < 1.0) {
      a = 0.9;
      if (uDash > 0.5 && fr >= uProg) a *= step(0.45, fract(vAng * uR / 26.0 - uTime * 0.3));
   } else {
      a = (1.0 - smoothstep(1.0, 2.0, vK)) * 0.22;
   }
   if (a < 0.004) discard;
   vec3 V = vWP - cameraPosition;
   float f = atmFogAmount(length(V), cameraPosition.y, max(vWP.y, 0.0)) * 0.6;
   gl_FragColor = vec4(mix(col, atmFogColor(V), f), a);
}`;

const CAP_COL = { player: [0.25, 0.85, 1.6], enemy: [1.7, 0.32, 0.24], neutral: [1.25, 1.25, 1.25] };

class CapMarkers {
   constructor(scene, surfUniforms) {
      this.scene = scene;
      this.surf = surfUniforms;
      this.recs = new Map();
      const SEG = 192, pos = [], idx = [];
      for (let i = 0; i <= SEG; i++) for (let k = 0; k < 3; k++) pos.push(i / SEG * TAU, k, 0);
      for (let i = 0; i < SEG; i++) for (let k = 0; k < 2; k++) {
         const a = i * 3 + k, b = a + 1, c = a + 3, d = a + 4;
         idx.push(a, b, c, b, d, c);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      this.geometry = g;
   }

   _make(cap) {
      const uniforms = Object.assign({}, this.surf, {
         uC: { value: new THREE.Vector2() }, uR: { value: 100 }, uW: { value: 6 },
         uCol: { value: new THREE.Color() }, uProgCol: { value: new THREE.Color() }, uProg: { value: 0 }, uDash: { value: 1 },
      });
      const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: CAP_VERT, fragmentShader: CAP_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 13;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sm = new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true });
      const sprite = new THREE.Sprite(sm);
      sprite.scale.set(0.055, 0.055, 1);
      sprite.renderOrder = 60;
      this.scene.add(mesh, sprite);
      return { mesh, mat, sprite, sm, tex, canvas, key: '' };
   }

   _draw(r, id, owner, contested) {
      const g = r.canvas.getContext('2d');
      const col = owner === 'player' ? '#5ed0ff' : owner === 'enemy' ? '#ff5a4a' : '#f2f2f2';
      g.clearRect(0, 0, 128, 128);
      g.beginPath(); g.arc(64, 64, 52, 0, TAU);
      g.fillStyle = 'rgba(8,14,22,0.55)'; g.fill();
      g.lineWidth = 8; g.strokeStyle = contested ? '#ffd24a' : col; g.stroke();
      g.fillStyle = col;
      g.font = 'bold 64px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(id).slice(0, 2), 64, 68);
      r.tex.needsUpdate = true;
   }

   update(caps, time, camera) {
      // non-attenuated sprites still scale with the projection: undo the binocular zoom
      const zk = camera?.fov ? Math.tan(camera.fov * Math.PI / 360) / Math.tan(55 * Math.PI / 360) : 1;
      const seen = this._seen || (this._seen = new Set());
      seen.clear();
      if (Array.isArray(caps)) {
         for (let i = 0; i < caps.length; i++) {
            const cap = caps[i];
            if (!cap || !cap.pos) continue;
            const id = cap.id ?? String.fromCharCode(65 + i);
            seen.add(id);
            let r = this.recs.get(id);
            if (!r) { r = this._make(cap); this.recs.set(id, r); }
            const R = Number(cap.r) || 250;
            const owner = capSide(cap.owner);
            const U = r.mat.uniforms;
            U.uC.value.set(cap.pos.x, cap.pos.y);
            U.uR.value = R; U.uW.value = clamp(R * 0.025, 4, 14);
            U.uCol.value.setRGB(...CAP_COL[owner || 'neutral']);
            const capper = capSide(cap.capper);
            U.uProgCol.value.setRGB(...CAP_COL[capper || owner || 'neutral']);
            U.uProg.value = capper ? clamp(Number(cap.progress) || 0, 0, 1) : 0;
            U.uDash.value = owner ? 0 : 1;
            r.sprite.position.set(cap.pos.x, 40 + R * 0.06, cap.pos.y);
            r.sprite.scale.set(0.055 * zk, 0.055 * zk, 1);
            const key = `${id}|${owner}|${!!cap.contested}`;
            if (key !== r.key) { r.key = key; this._draw(r, id, owner, !!cap.contested); }
         }
      }
      for (const [id, r] of this.recs) if (!seen.has(id)) this._remove(id, r);
   }

   _remove(id, r) {
      this.scene.remove(r.mesh, r.sprite);
      r.mat.dispose(); r.sm.dispose(); r.tex.dispose();
      this.recs.delete(id);
   }

   clear() { for (const [id, r] of this.recs) this._remove(id, r); }
   dispose() { this.clear(); this.geometry.dispose(); }
}

// ---------------- the effects manager ----------------
const _p = new THREE.Vector3(), _q2 = new THREE.Vector3();
const TOPS = [];

export class FX {
   constructor(scene, ocean, terrain) {
      this.scene = scene;
      this.ocean = ocean;
      this.terrain = terrain;
      this.noise = makeNoiseTexture(128);
      const OU = ocean.uniforms;
      const surf = () => ({ uWaveA: OU.uWaveA, uWaveB: OU.uWaveB, uWTime: OU.uWTime, uDepthTex: OU.uDepthTex, uDepthRect: OU.uDepthRect, uHullA: OU.uHullA, uHullB: OU.uHullB, uHullN: OU.uHullN });
      this.uSunCol = { value: new THREE.Color(3, 3, 3) };
      this.uAmb = { value: new THREE.Color(0.4, 0.45, 0.5) };
      this.uFoamCol = { value: new THREE.Color(1, 1, 1) };
      this.uTime = { value: 0 };
      this.glow = new ParticlePool(2048, true, this.noise, bindAtm({ uSunCol: this.uSunCol, uAmb: this.uAmb }));
      this.puff = new ParticlePool(3072, false, this.noise, bindAtm({ uSunCol: this.uSunCol, uAmb: this.uAmb }));
      this.decals = new DecalPool(512, this.noise, bindAtm(Object.assign(surf(), { uFoamCol: this.uFoamCol })));
      this.wakes = new Wakes(this.noise, bindAtm(Object.assign(surf(), { uFoamCol: this.uFoamCol, uTime: this.uTime })));
      this.caps = new CapMarkers(scene, bindAtm(Object.assign(surf(), { uTime: this.uTime })));
      this.rain = new Rain();
      scene.add(this.wakes.mesh, this.decals.mesh, this.puff.mesh, this.glow.mesh, this.rain.mesh);
      // flash lights: a constant count so no material ever recompiles
      this.lights = [];
      for (let i = 0; i < 4; i++) {
         const l = new THREE.PointLight(0xffaa66, 0, 450, 2);
         l.userData = { t: 0, dur: 1, peak: 0, hold: false };
         scene.add(l);
         this.lights.push(l);
      }
      // delayed spawns (staggered salvos, secondary detonations)
      this.queue = Array.from({ length: 128 }, () => ({ on: false, t: 0, type: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, cal: 0 }));
      this.shellState = new Map();
      this.torpState = new Map();
      this._recFree = [];
      this.impacts = Array.from({ length: 96 }, () => ({ x: 0, y: 0, z: 0, cal: 0, ammo: 'HE', kind: 'water', ship: null, along: 0, across: 0, matched: false, big: false }));
      this.nImp = 0;
      this.citMarks = [];
      this._seenFx = new WeakSet();
      this._clouds = new WeakMap();
      this.lastSeq = -1;
      this._evInit = false;
      this.frame = 0;
      this.timeScale = 1;
      this.windX = 3; this.windZ = 1;
      this.night = false;
      this.nightFlash = 0; this._camX = 0; this._camZ = 0;
   }

   setEnv(env) {
      const sc = env.sunColor, si = env.sunIntensity;
      this.uSunCol.value.setRGB(sc[0] * si * 0.3, sc[1] * si * 0.3, sc[2] * si * 0.3);
      const hz = env.horizon, zn = env.zenith;
      this.uAmb.value.setRGB((hz[0] + zn[0]) * 0.55, (hz[1] + zn[1]) * 0.55, (hz[2] + zn[2]) * 0.55);
      const up = Math.max(env.sunDir?.y ?? 0.3, 0);
      const k = si * (0.2 + 0.6 * up) * (env.night ? 0.25 : 1);
      this.uFoamCol.value.setRGB(0.86 * (sc[0] * k + this.uAmb.value.r * 1.5), 0.9 * (sc[1] * k + this.uAmb.value.g * 1.5), 0.93 * (sc[2] * k + this.uAmb.value.b * 1.5));
      const ws = (env.windSpeed || 6) * 0.5, wd = env.windDir ?? 0.8;
      this.windX = Math.cos(wd) * ws; this.windZ = Math.sin(wd) * ws;
      this.night = !!env.night;
      this.foamK = this.uFoamCol.value.r;
      this.rain.setEnv(Number(env.rain) || 0, this.uAmb.value);
   }

   // ---------- public spawners (also used by ships3d) ----------
   muzzle(pos, dir, cal, delay = 0) {
      if (delay > 0.001) { this._enqueue(0, delay, pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, cal); return; }
      this._muzzleNow(pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, cal);
   }

   sinkBurst(x, z, L, B, heading) {
      const ch = Math.cos(heading), sh = Math.sin(heading);
      this._explosion(x, 8, z, 460, true, 2.2);
      for (let i = 0; i < 5; i++) {
         const a = rr(-0.45, 0.45) * L;
         this._enqueue(1, 0.35 + i * rr(0.35, 0.8), x + ch * a, rr(4, 10), z + sh * a, 0, 0, 0, 300);
      }
      // towering smoke column + oily slick
      const P = this.puff;
      for (let i = 0; i < 14; i++) {
         const p = P.t();
         p.x = x + rr(-0.3, 0.3) * L * ch; p.y = rr(5, 25); p.z = z + rr(-0.3, 0.3) * L * sh;
         p.vx = rr(-3, 3); p.vy = rr(10, 22); p.vz = rr(-3, 3); p.drag = 0.25; p.grav = -1.2;
         p.life = rr(12, 18); p.s0 = rr(15, 25); p.s1 = rr(70, 110); p.grow = 2;
         p.r = 0.05; p.g = 0.045; p.b = 0.042; p.r1 = 0.14; p.g1 = 0.13; p.b1 = 0.125;
         p.a = 0.85; p.fin = 0.04; p.fout = 0.55; p.shape = 1; p.lit = 0.7; p.wind = 0.8; p.rot = rr(0, TAU); p.spin = rr(-0.2, 0.2);
         P.emit();
      }
      this.decals.add(2, x, z, heading, Math.max(B * 2.5, 40), Math.max(B * 5, 90), 45, 0.9, 2, clamp(L / B * 0.45, 1, 4));
      // wide oil sheen that spreads and fades long after the wreck is gone (pooled decal)
      this.decals.add(2, x, z, heading + 0.3, Math.max(B * 3, 50), Math.max(B * 9, 160), 120, 0.4, 1.4, clamp(L / B * 0.35, 1, 3), false, 0.7);
      this._light(x, 20, z, 6e6, 1.4, 1, 0.6, 0.3);
   }

   _enqueue(type, t, x, y, z, dx, dy, dz, cal) {
      for (const q of this.queue) {
         if (q.on) continue;
         q.on = true; q.t = t; q.type = type; q.x = x; q.y = y; q.z = z; q.dx = dx; q.dy = dy; q.dz = dz; q.cal = cal;
         return;
      }
   }

   // hold: flat-topped profile (star shells) instead of a quick quadratic fade; range: cutoff (m)
   _light(x, y, z, peak, dur, r, g, b, hold = false, range = 0) {
      let best = this.lights[0];
      for (const l of this.lights) if (l.intensity < best.intensity) best = l;
      if (best.intensity > peak) return;
      best.position.set(x, y, z);
      best.color.setRGB(r, g, b);
      best.userData.t = 0; best.userData.dur = dur; best.userData.peak = peak; best.userData.hold = hold;
      best.intensity = peak;
      best.distance = range || Math.sqrt(peak) * 0.9;
   }

   // Illumination round: a parachute flare drifting down over (x, z) for ~9 s, lighting a
   // ~1 km disc through the shared light pool (constant light count -> no shader recompiles).
   starShell(x, z) {
      const G = this.glow, H = 320, life = 9;
      for (let i = 0; i < 2; i++) {
         const p = G.t();
         p.x = x; p.y = H; p.z = z; p.vx = 0; p.vy = -9; p.vz = 0; p.drag = 0; p.grav = 0;
         p.life = life; p.s0 = i ? 60 : 14; p.s1 = i ? 45 : 10; p.grow = 1;
         p.r = i ? 1.4 : 9; p.g = i ? 1.2 : 8; p.b = i ? 0.9 : 6; p.r1 = p.r * 0.6; p.g1 = p.g * 0.6; p.b1 = p.b * 0.5;
         p.a = i ? 0.35 : 1; p.fin = 0.03; p.fout = 0.15; p.shape = 0;
         G.emit();
      }
      this._light(x, H - 50, z, 6e5, life, 1, 0.93, 0.8, true, 1500);
   }

   _muzzleNow(x, y, z, dx, dy, dz, cal) {
      const G = this.glow, P = this.puff;
      const k = clamp(cal / 380, 0.25, 1.4);
      const len = 8 + cal * 0.11;
      // fireball glow + flame tongue along the bore
      let p = G.t();
      p.x = x + dx * len * 0.25; p.y = y + dy * len * 0.25; p.z = z + dz * len * 0.25;
      p.life = 0.14 + 0.06 * k; p.s0 = 4 + cal * 0.03; p.s1 = 7 + cal * 0.05; p.grow = 2;
      p.r = 6; p.g = 2.6; p.b = 0.7; p.r1 = 1.5; p.g1 = 0.4; p.b1 = 0.08; p.a = 1; p.fin = 0; p.fout = 0.2; p.shape = 0;
      G.emit();
      p = G.t();
      p.x = x + dx * len * 0.5; p.y = y + dy * len * 0.5; p.z = z + dz * len * 0.5;
      p.axX = dx; p.axY = dy; p.axZ = dz; p.h = len; p.life = 0.1 + 0.04 * k; p.s0 = 2.5 + cal * 0.022; p.s1 = p.s0 * 1.6;
      p.r = 7; p.g = 3; p.b = 0.8; p.r1 = 2; p.g1 = 0.5; p.b1 = 0.1; p.a = 1; p.fin = 0; p.fout = 0.3; p.shape = 3;
      G.emit();
      for (let i = 0; i < 3 + 4 * k; i++) {
         p = G.t();
         const sp = rr(60, 160);
         p.x = x; p.y = y; p.z = z;
         p.vx = (dx + rr(-0.25, 0.25)) * sp; p.vy = (dy + rr(-0.1, 0.3)) * sp; p.vz = (dz + rr(-0.25, 0.25)) * sp;
         p.drag = 2.5; p.grav = 9.8; p.life = rr(0.2, 0.45); p.s0 = 0.6 + k * 0.6; p.s1 = 0.3; p.stretch = 0.05;
         p.r = 20; p.g = 9; p.b = 2.5; p.r1 = 5; p.g1 = 1.2; p.b1 = 0.2; p.fin = 0; p.fout = 0.5; p.shape = 3;
         G.emit();
      }
      // blast smoke rolling out of the muzzle
      const nS = Math.round(2 + 5 * k);
      for (let i = 0; i < nS; i++) {
         p = P.t();
         const sp = rr(20, 70) * (0.6 + k * 0.5);
         const fwd = rr(0.2, 1);
         p.x = x + dx * len * fwd; p.y = y + dy * len * fwd; p.z = z + dz * len * fwd;
         p.vx = dx * sp + rr(-6, 6); p.vy = dy * sp + rr(0, 5); p.vz = dz * sp + rr(-6, 6);
         p.drag = 1.6; p.grav = -0.6; p.life = rr(3, 5.5) * (0.6 + k * 0.5);
         p.s0 = 3 + cal * 0.02; p.s1 = 10 + cal * 0.075; p.grow = 3;
         p.r = 0.42; p.g = 0.39; p.b = 0.35; p.r1 = 0.62; p.g1 = 0.6; p.b1 = 0.58;
         p.a = 0.62; p.fin = 0.03; p.fout = 0.35; p.shape = 1; p.lit = 1; p.wind = 0.9; p.rot = rr(0, TAU); p.spin = rr(-0.5, 0.5);
         P.emit();
      }
      // pressure ring on the water under heavy guns
      if (cal >= 200 && y < 40) {
         const rx = x + dx * len * 0.6, rz = z + dz * len * 0.6;
         this.decals.add(1, rx, rz, 0, cal * 0.04, cal * 0.2, 1.3, 0.8, 3);
      }
      // at night the flash lights up the own ship and the sea around it
      if (this.night) {
         this._light(x + dx * 10, y + 10, z + dz * 10, 1.1e5 * k * k + 1.5e4, 0.24, 1, 0.6, 0.28);
         // a nearby salvo also briefly brightens the whole (hazy) night scene
         const cd = Math.hypot(x - this._camX, z - this._camZ);
         if (cd < 2500) this.nightFlash = Math.min(1, this.nightFlash + 0.35 * k * (1 - cd / 2500));
      }
      else this._light(x + dx * 8, y + 3, z + dz * 8, 1.4e4 * k * k + 2e3, 0.16, 1, 0.62, 0.3);
   }

   _splash(x, z, cal, big = false) {
      const P = this.puff;
      const k = clamp(cal / 380, 0.2, 1.8);
      // column height ~ caliber: 380 mm ~65 m, 203 mm ~38 m, 127 mm ~27 m
      const H = (8 + cal * 0.15) * (big ? 1.35 : 1);
      const W = 3 + cal * 0.03;
      const y0 = this.ocean.heightAt(x, z, null);
      const fc = this.uFoamCol.value;
      const lum = this.night ? 0.35 : 1;
      const nC = cal >= 250 ? 4 : cal >= 150 ? 3 : 2;
      for (let i = 0; i < nC; i++) {
         const p = P.t();
         // first column is the narrow, tallest core; the others are wider and shorter around it
         const core = i === 0;
         p.x = x + (core ? 0 : rr(-0.45, 0.45) * W); p.y = y0 - 1; p.z = z + (core ? 0 : rr(-0.45, 0.45) * W);
         p.life = rr(2.4, 3.4) * (0.7 + k * 0.3); p.s0 = W * 0.5; p.s1 = W * (core ? 0.8 : rr(0.95, 1.3)); p.grow = 4;
         p.aspect = H / p.s1 * (core ? 1.1 : rr(0.55, 0.9));
         p.r = p.g = p.b = lum; p.a = 1; p.fin = 0.02; p.fout = 0.3; p.shape = 2; p.lit = 1;
         P.emit();
      }
      // spray thrown up and out, then falling back
      const nSp = Math.round(7 + 10 * k);
      const v0 = Math.sqrt(2 * 9.8 * H);
      for (let i = 0; i < nSp; i++) {
         const p = P.t();
         const a = rr(0, TAU), out = rr(0.05, 0.3);
         p.x = x; p.y = y0 + 1; p.z = z;
         const vu = v0 * rr(0.55, 1.0);
         p.vx = Math.cos(a) * vu * out; p.vy = vu; p.vz = Math.sin(a) * vu * out;
         p.drag = 0.35; p.grav = 11; p.life = rr(1.6, 2.6) * (0.7 + 0.3 * k);
         p.s0 = W * 0.35; p.s1 = W * rr(0.9, 1.5); p.grow = 2; p.stretch = 0.05;
         p.r = p.g = p.b = 0.95 * lum; p.a = 0.8; p.fin = 0.02; p.fout = 0.45; p.shape = 1; p.lit = 1; p.rot = rr(0, TAU); p.wind = 0.4;
         P.emit();
      }
      // base mist
      for (let i = 0; i < 2 + k * 2; i++) {
         const p = P.t();
         p.x = x + rr(-1, 1) * W; p.y = y0 + W * 0.3; p.z = z + rr(-1, 1) * W;
         p.vx = rr(-2, 2); p.vy = rr(0.5, 2); p.vz = rr(-2, 2); p.drag = 0.8;
         p.life = rr(3, 5); p.s0 = W; p.s1 = W * 3.5; p.grow = 2;
         p.r = p.g = p.b = 0.9 * lum; p.a = 0.45; p.fin = 0.08; p.fout = 0.3; p.shape = 1; p.lit = 1; p.wind = 1; p.rot = rr(0, TAU);
         P.emit();
      }
      this.decals.add(0, x, z, rr(0, TAU), W * 1.5, W * 5.5, 7 + k * 3, 0.9, 3);
      void fc;
   }

   _explosion(x, y, z, cal, citadel = false, scale = 1) {
      const G = this.glow, P = this.puff;
      const k = clamp(cal / 380, 0.3, 1.6) * scale * (citadel ? 1.6 : 1);
      let p = G.t();
      p.x = x; p.y = y; p.z = z; p.life = 0.22 + 0.1 * k; p.s0 = 8 * k + 4; p.s1 = 22 * k + 6; p.grow = 3;
      p.r = 50; p.g = 22; p.b = 7; p.r1 = 8; p.g1 = 2; p.b1 = 0.3; p.fin = 0; p.fout = 0.15; p.shape = 0;
      G.emit();
      for (let i = 0; i < 2 + 3 * k; i++) {
         p = G.t();
         p.x = x + rr(-3, 3) * k; p.y = y + rr(0, 4) * k; p.z = z + rr(-3, 3) * k;
         p.vx = rr(-8, 8) * k; p.vy = rr(4, 16) * k; p.vz = rr(-8, 8) * k; p.drag = 2.2;
         p.life = rr(0.45, 0.8) * (0.7 + 0.4 * k); p.s0 = 4 * k + 2; p.s1 = 14 * k + 4; p.grow = 3;
         p.r = 14; p.g = 5.5; p.b = 1.4; p.r1 = 2.2; p.g1 = 0.45; p.b1 = 0.08; p.fin = 0.05; p.fout = 0.3; p.shape = 1; p.rot = rr(0, TAU); p.spin = rr(-2, 2);
         G.emit();
      }
      const nsp = Math.round(8 + 18 * k);
      for (let i = 0; i < nsp; i++) {
         p = G.t();
         const a = rr(0, TAU), el = rr(0.1, 1.2), sp = rr(25, 90) * Math.sqrt(k);
         p.x = x; p.y = y; p.z = z;
         p.vx = Math.cos(a) * Math.cos(el) * sp; p.vy = Math.sin(el) * sp; p.vz = Math.sin(a) * Math.cos(el) * sp;
         p.grav = 9.8; p.drag = 0.6; p.life = rr(0.5, 1.3); p.s0 = 0.7; p.s1 = 0.35; p.stretch = 0.06;
         p.r = 18; p.g = 8; p.b = 2; p.r1 = 5; p.g1 = 1; p.b1 = 0.15; p.fin = 0; p.fout = 0.6; p.shape = 3;
         G.emit();
      }
      for (let i = 0; i < 2 + 3 * k; i++) {
         p = P.t();
         p.x = x + rr(-2, 2) * k; p.y = y + rr(1, 5) * k; p.z = z + rr(-2, 2) * k;
         p.vx = rr(-4, 4); p.vy = rr(4, 10); p.vz = rr(-4, 4); p.drag = 0.6; p.grav = -0.8;
         p.life = rr(4, 7) * (0.6 + 0.4 * k); p.s0 = 5 * k + 3; p.s1 = 26 * k + 8; p.grow = 2.5;
         p.r = 0.06; p.g = 0.055; p.b = 0.05; p.r1 = 0.2; p.g1 = 0.19; p.b1 = 0.18;
         p.a = 0.8; p.fin = 0.06; p.fout = 0.4; p.shape = 1; p.lit = 0.7; p.wind = 1; p.rot = rr(0, TAU); p.spin = rr(-0.4, 0.4);
         P.emit();
      }
      this._light(x, y + 4, z, (citadel ? 3e5 : 8e4) * k * k, citadel ? 0.5 : 0.25, 1, 0.55, 0.25);
   }

   _landHit(x, y, z, cal) {
      const P = this.puff;
      const k = clamp(cal / 380, 0.3, 1.5);
      this._explosion(x, y + 1, z, cal * 0.6);
      for (let i = 0; i < 4 + 6 * k; i++) {
         const p = P.t();
         p.x = x; p.y = y + 1; p.z = z;
         p.vx = rr(-10, 10) * k; p.vy = rr(8, 26) * k; p.vz = rr(-10, 10) * k; p.drag = 0.7; p.grav = 6;
         p.life = rr(2.5, 4.5); p.s0 = 3 * k + 2; p.s1 = 16 * k + 6; p.grow = 2;
         p.r = 0.3; p.g = 0.26; p.b = 0.2; p.r1 = 0.42; p.g1 = 0.38; p.b1 = 0.32;
         p.a = 0.8; p.fin = 0.03; p.fout = 0.35; p.shape = 1; p.lit = 1; p.wind = 0.8; p.rot = rr(0, TAU);
         P.emit();
      }
   }

   _torpHit(x, z, big) {
      this._splash(x, z, 700, true);
      this._explosion(x, 6, z, 420, big);
   }

   // ---------- per-frame ----------
   update(world, dt, time, camera, ships) {
      this._camX = camera.position.x; this._camZ = camera.position.z;
      this.nightFlash *= Math.exp(-dt * 10);
      this.frame++;
      this.time = time;
      this.shipsRef = ships;
      dt *= this.timeScale;   // test hook: 0 freezes every effect in place
      this.uTime.value = time;
      this.rain.update(time, this.windX, this.windZ);
      const cam = camera.position;
      // zoom factor: pixel-size floors (tracers) must not balloon 16x in the binoculars
      this._zk = camera.fov ? Math.tan(camera.fov * Math.PI / 360) / Math.tan(55 * Math.PI / 360) : 1;
      this.nImp = 0;
      this.citMarks.length = 0;

      this._events(world);
      this._shells(world, dt, cam, ships);
      this._torpedoes(world, time, ships);
      this._effects(world);
      this._resolveImpacts();

      for (const q of this.queue) {
         if (!q.on) continue;
         q.t -= dt;
         if (q.t > 0) continue;
         q.on = false;
         if (q.type === 0) this._muzzleNow(q.x, q.y, q.z, q.dx, q.dy, q.dz, q.cal);
         else this._explosion(q.x, q.y, q.z, q.cal, false, 1.3);
      }

      this._ships(world, dt, time, cam, ships);
      this._smokeScreens(world, cam);
      this.caps.update(world.caps, time, camera);

      for (const l of this.lights) {
         const u = l.userData;
         if (l.intensity <= 0) continue;
         u.t += dt;
         const f = u.t / u.dur;
         l.intensity = f >= 1 ? 0 : u.hold ? u.peak * (1 - f * f * f) * (0.9 + 0.1 * Math.sin(u.t * 23)) : u.peak * (1 - f) * (1 - f);
      }
      this.glow.update(dt, cam, this.windX, this.windZ);
      this.puff.update(dt, cam, this.windX, this.windZ);
      this.decals.update(dt);
      this.wakes.update(time);
   }

   _events(world) {
      const ev = world.events;
      if (!Array.isArray(ev) || !ev.length) return;
      if (!this._evInit) {
         this._evInit = true;
         for (const e of ev) if (Number.isFinite(e?.seq) && e.seq > this.lastSeq) this.lastSeq = e.seq;
         return;
      }
      let max = this.lastSeq;
      for (const e of ev) {
         if (!e || !Number.isFinite(e.seq) || e.seq <= this.lastSeq) continue;
         if (e.seq > max) max = e.seq;
         if (e.type === 'citadel' && e.pos) this.citMarks.push(e.pos);
      }
      this.lastSeq = max;
   }

   _imp() { return this.nImp < this.impacts.length ? this.impacts[this.nImp++] : null; }

   _shellCal(s) {
      if (Number.isFinite(s.caliber)) return s.caliber;
      if (Number.isFinite(s.gun?.caliber)) return s.gun.caliber;
      const sh = s.shooter;
      if (s.kind === 'sec') return 127;
      const c = sh?.cfg?.main?.caliber;
      if (Number.isFinite(c)) return c;
      return sh && (sh.cls === 'Bismarck' || sh.cls === 'EB') ? 380 : 203;
   }

   _shells(world, dt, cam, ships) {
      const shells = Array.isArray(world.shells) ? world.shells : [];
      const G = this.glow;
      const f = this.frame;
      for (const s of shells) {
         if (!s || !s.pos) continue;
         let h;
         if (Number.isFinite(s.alt)) h = s.alt;
         else {
            const t = Math.min(1, s.arc || 0);
            const R = (s.arcDur || 1) * (s.gun?.vShell || 650);
            const H = Math.max(25, R * 0.10);
            h = 4 * H * t * (1 - t) + 18 * (1 - t);
         }
         let st = this.shellState.get(s);
         if (!st) {
            st = this._recFree.pop() || {};
            st.x = s.pos.x; st.y = h; st.z = s.pos.y; st.vx = 0; st.vy = 0; st.vz = 0; st.n = 0;
            st.cal = this._shellCal(s);
            st.ammo = s.ammo || s.type || s.shooter?.ammo || 'HE';
            this.shellState.set(s, st);
         } else if (dt > 0) {
            const ivx = (s.pos.x - st.x) / dt, ivy = (h - st.y) / dt, ivz = (s.pos.y - st.z) / dt;
            const kk = st.n ? 0.5 : 1;
            st.vx += (ivx - st.vx) * kk; st.vy += (ivy - st.vy) * kk; st.vz += (ivz - st.vz) * kk;
            st.x = s.pos.x; st.y = h; st.z = s.pos.y; st.n++;
         }
         st.frame = f;
         // tracer: bright head + streak along the flight path, kept >= ~1.5 px wide at range
         const dist = Math.hypot(st.x - cam.x, st.y - cam.y, st.z - cam.z);
         const ap = st.ammo === 'AP';
         const ck = clamp(st.cal / 380, 0.3, 1.3);
         const w = Math.max(0.7 + st.cal * 0.0045, dist * 0.0016 * Math.max(this._zk, 0.12));
         const spd = Math.hypot(st.vx, st.vy, st.vz);
         const cr = ap ? 7 : 16, cg = ap ? 8.5 : 7, cb = ap ? 14 : 2.2;
         const fade = clamp(dist / 120, 0.25, 1);   // don't blind a close camera
         if (spd > 1) {
            const len = clamp(spd * 0.05, 8, 55) * (0.7 + 0.3 * ck) + dist * 0.004 * this._zk;
            const ax = st.vx / spd, ay = st.vy / spd, az = st.vz / spd;
            const p = G.t();
            p.x = st.x - ax * len * 0.5; p.y = st.y - ay * len * 0.5; p.z = st.z - az * len * 0.5;
            p.axX = ax; p.axY = ay; p.axZ = az; p.h = len; p.s0 = p.s1 = w * 1.3;
            p.r = cr; p.g = cg; p.b = cb; p.a = 0.9 * fade; p.fin = 0; p.fout = 1; p.shape = 3;
            G.emit(true);
         }
         const p = G.t();
         p.x = st.x; p.y = st.y; p.z = st.z; p.s0 = p.s1 = w * 3.2;
         p.r = cr * 0.5; p.g = cg * 0.5; p.b = cb * 0.5; p.a = 0.8 * fade; p.fin = 0; p.fout = 1; p.shape = 0;
         G.emit(true);
      }
      for (const [s, st] of this.shellState) {
         if (st.frame === f) continue;
         this.shellState.delete(s);
         this._recFree.push(st);
         if (st.y > 60) continue;   // vanished mid-flight (no impact)
         // extrapolate to the water line
         let x = st.x, z = st.z;
         if (st.vy < -1) { const th = clamp(st.y / -st.vy, 0, 0.12); x += st.vx * th; z += st.vz * th; }
         const im = this._imp();
         if (!im) continue;
         im.x = x; im.z = z; im.y = 0; im.cal = st.cal; im.ammo = st.ammo; im.matched = false; im.big = false; im.torp = false;
         this._classify(im, ships, 8);
      }
   }

   _classify(im, ships, margin) {
      im.ship = null; im.kind = 'water';
      let best = null, bd = 1e9;
      for (const r of ships.list) {
         const dx = im.x - r.x, dz = im.z - r.z;
         const ch = Math.cos(r.hd), sh = Math.sin(r.hd);
         const al = dx * ch + dz * sh, ac = -dx * sh + dz * ch;
         const ex = Math.abs(al) - r.d.L * 0.5, ey = Math.abs(ac) - r.d.B * 0.5;
         if (ex < margin && ey < margin) {
            const dd = Math.max(ex, ey);
            if (dd < bd) { bd = dd; best = r; im.along = clamp(al, -r.d.L * 0.48, r.d.L * 0.48); im.across = clamp(ac, -r.d.B * 0.5, r.d.B * 0.5); }
         }
      }
      if (best) { im.ship = best; im.kind = 'hit'; return; }
      const th = this.terrain.heightAt(im.x, im.z);
      if (th > 0.8) { im.kind = 'land'; im.y = th; }
   }

   _torpedoes(world, time, ships) {
      const torps = Array.isArray(world.torpedoes) ? world.torpedoes : [];
      const f = this.frame;
      for (const t of torps) {
         if (!t || !t.pos) continue;
         let st = this.torpState.get(t);
         if (!st) { st = this._recFree.pop() || {}; this.torpState.set(t, st); }
         st.x = t.pos.x; st.z = t.pos.y; st.frame = f;
         const vis = t.spotted !== false || t.side === 'player' || t.owner === 'player';
         const hd = Number.isFinite(t.heading) ? t.heading : (t.dir || 0);
         if (vis) this.wakes.feed(t, 1, t.pos.x - Math.cos(hd) * 4, t.pos.y - Math.sin(hd) * 4, Number(t.speed) || 30, 2, 1, time);
      }
      for (const [t, st] of this.torpState) {
         if (st.frame === f) continue;
         this.torpState.delete(t);
         this._recFree.push(st);
         const im = this._imp();
         if (!im) continue;
         im.x = st.x; im.z = st.z; im.y = 0; im.cal = 600; im.ammo = 'HE'; im.matched = false; im.big = false; im.torp = true;
         this._classify(im, ships, 18);
         if (im.kind !== 'hit') { this.nImp--; }   // ran out of fuel / hit land: no show
      }
   }

   _effects(world) {
      const fx = world.effects;
      if (!Array.isArray(fx)) return;
      for (const e of fx) {
         if (!e || typeof e !== 'object' || this._seenFx.has(e)) continue;
         this._seenFx.add(e);
         const kind = e.kind;
         if ((kind !== 'splash' && kind !== 'explosion' && kind !== 'hit') || !e.pos) continue;
         // match the impact we derived from the vanished projectile (same frame, close by)
         let best = null, bd = 70 * 70;
         for (let i = 0; i < this.nImp; i++) {
            const im = this.impacts[i];
            if (im.matched) continue;
            const d = (im.x - e.pos.x) ** 2 + (im.z - e.pos.y) ** 2;
            if (d < bd) { bd = d; best = im; }
         }
         if (best) {
            best.matched = true;
            if (kind === 'splash' && best.kind === 'hit' && !best.torp) best.kind = 'water';
            else if (kind !== 'splash' && best.kind === 'water') best.kind = 'hitfree';
            if (e.big) best.big = true;
            continue;
         }
         const im = this._imp();
         if (!im) continue;
         im.x = e.pos.x; im.z = e.pos.y; im.y = 0; im.matched = true; im.torp = false; im.ship = null;
         im.cal = Number(e.size) > 0 ? clamp(e.size * 8, 100, 460) : e.big ? 380 : 180;
         im.big = !!e.big; im.ammo = 'HE';
         // legacy sim resolves hits in 2D at any shell altitude: put the blast on the hull / rock
         this._classify(im, this.shipsRef, 6);
         if (kind === 'splash') im.kind = 'water';
         else if (im.kind === 'water') im.kind = 'hitfree';
      }
   }

   _resolveImpacts() {
      for (let i = 0; i < this.nImp; i++) {
         const im = this.impacts[i];
         let cit = false;
         for (const c of this.citMarks) if ((c.x - im.x) ** 2 + (c.y - im.z) ** 2 < 60 * 60) cit = true;
         if (im.kind === 'water') {
            this._splash(im.x, im.z, im.cal, im.big);
         } else if (im.kind === 'land') {
            this._landHit(im.x, im.y, im.z, im.cal);
         } else if (im.kind === 'hit' && im.ship) {
            const r = im.ship;
            const side = Math.abs(im.across) > r.d.B * 0.38;
            const ly = r.S.deckAt(im.along) * (side ? 0.55 : 1) + 1;
            this.shipsRef.worldPoint(r, im.along, ly, im.across, _p);
            if (im.torp) this._torpHit(_p.x, _p.z, cit || im.big);
            else this._explosion(_p.x, _p.y, _p.z, im.cal * (im.ammo === 'AP' ? 0.8 : 1), cit || (im.big && im.cal >= 300));
         } else {
            // effect said "explosion" but we found no hull: burst at deck height
            if (im.torp) this._torpHit(im.x, im.z, im.big);
            else this._explosion(im.x, 8, im.z, im.cal, cit);
         }
      }
      // citadel events with no matching projectile still get their detonation
      for (const c of this.citMarks) {
         let near = false;
         for (let i = 0; i < this.nImp; i++) { const im = this.impacts[i]; if ((c.x - im.x) ** 2 + (c.y - im.z) ** 2 < 60 * 60) near = true; }
         if (!near) this._explosion(c.x, 8, c.y, 380, true);
      }
   }

   _ships(world, dt, time, cam, ships) {
      this.shipsRef = ships;
      const G = this.glow, P = this.puff;
      for (const r of ships.list) {
         const s = r.ship, d = r.d;
         const camD = Math.hypot(r.x - cam.x, r.z - cam.z);
         const ch = Math.cos(r.hd), sh = Math.sin(r.hd);
         // ---- wake + bow wave ----
         // unspotted ships leave no wake either (it would give their position away); the trail
         // is dropped once the model has faded so a re-spot starts a fresh one instead of a jump
         if (!r.visible) { const t = this.wakes.trails.get(s); if (t) { this.wakes.trails.delete(s); this.wakes.free.push(t); } }
         else if (r.sinkT < 0.3) {
            const inten = clamp(r.kn / 26, 0, 1) * (r.alive ? 1 : 1 - r.sinkT * 3) * r.opacity;
            this.wakes.feed(s, 0, r.x - ch * d.L * 0.47, r.z - sh * d.L * 0.47, r.spd, d.B, inten, time);
            if (r.visible && r.kn > 3 && inten > 0.05) {
               this.decals.add(3, r.x + ch * d.L * 0.3, r.z + sh * d.L * 0.3, r.hd, d.B * 3, d.B * 3, 1, clamp(r.kn / 22, 0.2, 1) * r.opacity, 1, d.L * 0.46 / (d.B * 3), true);
            }
         }
         if (!r.visible) continue;
         // ---- fires ----
         let nf = Array.isArray(s.fires) ? s.fires.length : (s.burning ? 1 : 0);
         if (!r.alive && r.sinkT < 0.8) nf = Math.max(nf, 3);
         nf = Math.min(nf, r.fireSpots.length);
         if (nf > 0) {
            const lod = camD > 9000 ? 0.4 : 1;
            r.fxFlame = (r.fxFlame || 0) + dt * nf * 16 * lod;
            r.fxSmoke = (r.fxSmoke || 0) + dt * nf * 3.2 * lod;
            while (r.fxFlame >= 1) {
               r.fxFlame -= 1;
               const sp = r.fireSpots[(r.fxFlameI = ((r.fxFlameI || 0) + 1) % nf)];
               ships.worldPoint(r, sp.x + rr(-2, 2), r.S.deckAt(sp.x) + 0.5, sp.z + rr(-1.5, 1.5), _p);
               const p = G.t();
               p.x = _p.x; p.y = _p.y; p.z = _p.z;
               // flame tongues sized to the ship: a battleship fire must read at 10+ km
               const fk = clamp(d.B / 22, 0.7, 1.5);
               p.vx = rr(-1.5, 1.5); p.vy = rr(5, 11) * fk; p.vz = rr(-1.5, 1.5); p.drag = 0.5; p.grav = -2;
               p.life = rr(0.55, 1.05); p.s0 = rr(6, 10) * fk; p.s1 = rr(2.5, 4) * fk; p.grow = 1;
               p.r = 9; p.g = 3.6; p.b = 0.8; p.r1 = 3; p.g1 = 0.5; p.b1 = 0.08; p.fin = 0.12; p.fout = 0.4; p.shape = 1; p.rot = rr(0, TAU); p.spin = rr(-2, 2); p.wind = 0.3;
               G.emit();
            }
            while (r.fxSmoke >= 1) {
               r.fxSmoke -= 1;
               const sp = r.fireSpots[(r.fxSmokeI = ((r.fxSmokeI || 0) + 1) % nf)];
               // smoke starts above the flames so it does not smother them
               ships.worldPoint(r, sp.x, r.S.deckAt(sp.x) + 7, sp.z, _p);
               const p = P.t();
               p.x = _p.x; p.y = _p.y; p.z = _p.z;
               p.vx = rr(-1, 1); p.vy = rr(6, 10); p.vz = rr(-1, 1); p.drag = 0.35; p.grav = -1.0;
               p.life = rr(8, 12); p.s0 = rr(5, 8); p.s1 = rr(38, 60); p.grow = 2;
               p.r = 0.035; p.g = 0.032; p.b = 0.03; p.r1 = 0.16; p.g1 = 0.155; p.b1 = 0.15;
               p.a = 0.88; p.fin = 0.03; p.fout = 0.45; p.shape = 1; p.lit = 0.8; p.wind = 1; p.rot = rr(0, TAU); p.spin = rr(-0.3, 0.3);
               P.emit();
            }
         }
         // ---- funnel smoke (close ships only) ----
         if (r.alive && camD < 7000 && r.smoke.length) {
            // dense, faint puffs overlap into one continuous plume instead of a chain of balls
            r.fxFun = (r.fxFun || 0) + dt * (2.6 + r.kn * 0.12) * r.smoke.length;
            if (r.fxFun >= 1) {
               const n = ships.funnelTops(r, TOPS);
               while (r.fxFun >= 1) {
                  r.fxFun -= 1;
                  const t = TOPS[(r.fxFunI = ((r.fxFunI || 0) + 1) % n)];
                  const p = P.t();
                  p.x = t.x; p.y = t.y; p.z = t.z;
                  p.vx = rr(-0.5, 0.5); p.vy = rr(3, 5); p.vz = rr(-0.5, 0.5); p.drag = 0.4; p.grav = -0.3;
                  p.life = rr(6, 9); p.s0 = d.B * 0.16 + 2; p.s1 = d.B * 0.7 + 10; p.grow = 2;
                  p.r = 0.3; p.g = 0.29; p.b = 0.28; p.r1 = 0.52; p.g1 = 0.52; p.b1 = 0.52;
                  p.a = 0.22; p.fin = 0.05; p.fout = 0.3; p.shape = 1; p.lit = 1; p.wind = 1; p.rot = rr(0, TAU); p.spin = rr(-0.3, 0.3);
                  P.emit();
               }
            }
         }
         // ---- sinking: steam + bubbling where the hull meets the sea ----
         if (!r.alive && r.sinkT > 0.05 && r.sinkT < 0.97) {
            r.fxSink = (r.fxSink || 0) + dt * 5;
            while (r.fxSink >= 1) {
               r.fxSink -= 1;
               const a = rr(-0.45, 0.45) * d.L;
               const p = P.t();
               p.x = r.x + ch * a + rr(-1, 1) * d.B; p.y = 1; p.z = r.z + sh * a + rr(-1, 1) * d.B;
               p.vx = rr(-1, 1); p.vy = rr(2, 5); p.vz = rr(-1, 1); p.drag = 0.5; p.grav = -0.4;
               p.life = rr(3, 5); p.s0 = d.B * 0.3; p.s1 = d.B * 1.2; p.grow = 2;
               p.r = p.g = p.b = 0.8; p.a = 0.4; p.fin = 0.1; p.fout = 0.3; p.shape = 1; p.lit = 1; p.wind = 1; p.rot = rr(0, TAU);
               P.emit();
            }
         }
         // ---- heavy damage: thin grey smoke even without fires ----
         const hpk = Number.isFinite(s.hp) && s.maxHP > 0 ? s.hp / s.maxHP : 1;
         if (r.alive && hpk < 0.35 && nf === 0 && camD < 9000) {
            r.fxDmg = (r.fxDmg || 0) + dt * 1.5;
            while (r.fxDmg >= 1) {
               r.fxDmg -= 1;
               const sp = r.fireSpots[0];
               ships.worldPoint(r, sp.x, r.S.deckAt(sp.x) + 2, sp.z, _p);
               const p = P.t();
               p.x = _p.x; p.y = _p.y; p.z = _p.z;
               p.vy = rr(3, 6); p.drag = 0.4; p.grav = -0.5;
               p.life = rr(6, 9); p.s0 = 4; p.s1 = 28; p.grow = 2;
               p.r = 0.14; p.g = 0.135; p.b = 0.13; p.r1 = 0.3; p.g1 = 0.3; p.b1 = 0.3;
               p.a = 0.5; p.fin = 0.05; p.fout = 0.35; p.shape = 1; p.lit = 1; p.wind = 1; p.rot = rr(0, TAU);
               P.emit();
            }
         }
      }
   }

   _smokeScreens(world, cam) {
      const clouds = world.smokeClouds;
      if (!Array.isArray(clouds) || !clouds.length) return;
      const P = this.puff;
      const t = this.time;
      for (const c of clouds) {
         if (!c || !c.c) continue;
         let st = this._clouds.get(c);
         if (!st) {
            const n = 44;
            const rng = mulberry32((Math.abs(Math.round(c.c.x * 7 + c.c.y * 13)) + 1) >>> 0);
            st = { n, ox: new Float32Array(n), oz: new Float32Array(n), h: new Float32Array(n), s: new Float32Array(n), ph: new Float32Array(n) };
            // each cloud is a billowing mound: central puffs stack high, rim puffs hug the water,
            // so a laid trail reads as a chain of heaps instead of one flat-topped wall
            const tall = 0.6 + rng() * 0.4;
            for (let i = 0; i < n; i++) {
               const a = rng() * TAU, rad = Math.sqrt(rng()) * 0.85;
               st.ox[i] = Math.cos(a) * rad; st.oz[i] = Math.sin(a) * rad;
               const mound = 1 - (rad / 0.85) ** 2;
               st.h[i] = 0.08 + 0.92 * tall * mound * (0.45 + 0.55 * rng());
               st.s[i] = 0.55 + rng() * 0.5; st.ph[i] = rng() * TAU;
            }
            this._clouds.set(c, st);
         }
         const R = Math.max(10, Number(c.r) || 100);
         const life = Number.isFinite(c.life) ? c.life : 10;
         const aIn = Number.isFinite(c.age) ? clamp(c.age / 1.5, 0, 1) : 1;
         // camera inside the cloud (own smoke): thin it so the screen is not a grey wall, like WoWs does
         const cd = cam ? Math.hypot(cam.x - c.c.x, cam.z - c.c.y) : 1e9;   // cam = camera position
         const inside = 0.3 + 0.7 * clamp((cd - R * 0.6) / (R * 0.9), 0, 1);
         const alpha = clamp(life / 5, 0, 1) * aIn * 0.7 * inside;
         if (alpha <= 0.01) continue;
         const Hs = clamp(R * 0.36, 18, 165);
         for (let i = 0; i < st.n; i++) {
            const p = P.t();
            const hi = st.h[i];
            const sw = Math.sin(t * 0.13 + st.ph[i]) * 0.04;
            p.x = c.c.x + (st.ox[i] + sw) * R; p.z = c.c.y + (st.oz[i] - sw) * R;
            p.y = Hs * hi + Math.sin(t * 0.09 + st.ph[i] * 2) * 4;
            // big soft base, smaller puffs on top for a lumpy crown
            p.s0 = p.s1 = R * (0.72 - 0.34 * hi) * st.s[i] + 18;
            // underside in its own shadow, sunlit crown
            const g = 0.54 + 0.2 * hi;
            p.r = g; p.g = g + 0.01; p.b = g + 0.025; p.a = alpha; p.fin = 0; p.fout = 1; p.shape = 1; p.lit = 1;
            p.rot = st.ph[i] + t * 0.02 * (i % 2 ? 1 : -1);
            P.emit(true);
         }
      }
      void cam;
   }

   clear() {
      this.glow.clear(); this.puff.clear(); this.decals.clear(); this.wakes.clear(); this.caps.clear();
      for (const q of this.queue) q.on = false;
      this.shellState.clear(); this.torpState.clear();
      this._seenFx = new WeakSet();
      this._clouds = new WeakMap();
      this.lastSeq = -1; this._evInit = false;
      for (const l of this.lights) l.intensity = 0;
   }

   dispose() {
      this.clear();
      this.scene.remove(this.glow.mesh, this.puff.mesh, this.decals.mesh, this.wakes.mesh, this.rain.mesh);
      for (const l of this.lights) this.scene.remove(l);
      this.glow.dispose(); this.puff.dispose(); this.decals.dispose(); this.wakes.dispose(); this.caps.dispose(); this.rain.dispose();
      this.noise.dispose();
   }
}
