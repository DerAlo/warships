// game3d/water3d.js — the ocean: 8 Gerstner waves (scaled by env.seaState) displaced on a
// camera-centred radial grid that reaches the horizon (60 km) with no seams or LOD pops;
// per-pixel analytic wave normals + a scrolling tileable detail normal map, Fresnel sky
// reflection from the sky cubemap, GGX sun glint, deep/shallow colour from a baked depth map
// (islands + reefs), crest + shore foam, backlit subsurface glow. A CPU mirror of the wave
// function lets ships bob/pitch/roll on the same surface the GPU draws.
import * as THREE from '../vendor/three/three.module.min.js';
import { ATM, ATM_GLSL, bindAtm, mulberry32, clamp } from './gfxcommon3d.js';

export const NW = 8;
export const OCEAN_R = 60000;

// Shared by the ocean, wakes and flat particles so they all ride the same swell.
export const WAVES_GLSL = /* glsl */`
#define NW ${NW}
uniform vec4 uWaveA[NW];   // dir.x, dir.z, k, omega
uniform vec4 uWaveB[NW];   // amplitude, Q (choppiness), phase, 0
uniform float uWTime;
vec3 waveDisp(vec2 p, float dist, float damp) {
   vec3 o = vec3(0.0);
   for (int i = 0; i < NW; i++) {
      vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
      float lam = 6.2831853 / a.z;
      float fade = (1.0 - smoothstep(lam * 9.0, lam * 16.0, dist)) * damp;
      float th = a.z * dot(a.xy, p) - a.w * uWTime + b.z;
      float A = b.x * fade;
      float c = cos(th);
      o.xz += b.y * A * a.xy * c;
      o.y += A * sin(th);
   }
   return o;
}
float waveHeight(vec2 p, float dist) { return waveDisp(p, dist, 1.0).y; }
`;

export function makeWaves(seaState, windDir) {
   const s = clamp(seaState, 0, 1);
   const rnd = mulberry32(1337);
   const L0 = 30 + 90 * s;
   const steep = 0.10 + 0.14 * s;
   const ratios = [1.0, 0.77, 0.61, 0.47, 0.36, 0.27, 0.2, 0.14];
   const spread = [0, 0.45, -0.38, 0.8, -0.7, 1.2, -1.05, 0.25];
   const wts = [0.55, 0.5, 0.45, 0.4, 0.36, 0.32, 0.28, 0.24];
   const chop = 0.45 + 0.4 * s;
   const waves = [];
   for (let i = 0; i < NW; i++) {
      const lam = L0 * ratios[i] * (0.92 + 0.16 * rnd());
      const k = 2 * Math.PI / lam;
      const w = Math.sqrt(9.81 * k);
      const dir = windDir + spread[i] * (0.8 + 0.4 * rnd());
      const A = steep * wts[i] / k;
      const Q = Math.min(1, chop / (k * A * NW));
      waves.push({ dx: Math.cos(dir), dz: Math.sin(dir), k, w, A, Q, ph: rnd() * Math.PI * 2, lam });
   }
   return waves;
}

// Tileable detail normal map (sum of integer-frequency sines => wraps seamlessly); alpha = foam noise.
function makeDetailTexture(size = 256) {
   const rnd = mulberry32(99);
   const comps = [];
   for (let i = 0; i < 48; i++) {
      const f = 2 + Math.floor(rnd() * 22);
      const a = rnd() * Math.PI * 2;
      const m = Math.round(Math.cos(a) * f), n = Math.round(Math.sin(a) * f);
      if (m === 0 && n === 0) continue;
      const fr = Math.hypot(m, n);
      comps.push({ m, n, amp: 1 / Math.pow(fr, 1.35), ph: rnd() * Math.PI * 2 });
   }
   const foamComps = [];
   for (let i = 0; i < 40; i++) {
      const f = 3 + Math.floor(rnd() * 30);
      const a = rnd() * Math.PI * 2;
      foamComps.push({ m: Math.round(Math.cos(a) * f), n: Math.round(Math.sin(a) * f), amp: 1 / Math.sqrt(f), ph: rnd() * Math.PI * 2 });
   }
   const data = new Uint8Array(size * size * 4);
   const TAU = Math.PI * 2;
   let maxS = 0;
   const tmp = new Float32Array(size * size * 3);
   for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
         const u = x / size, v = y / size;
         let dx = 0, dy = 0, fo = 0;
         for (const c of comps) {
            const th = TAU * (c.m * u + c.n * v) + c.ph;
            const cs = Math.cos(th) * c.amp;
            dx += cs * c.m; dy += cs * c.n;
         }
         for (const c of foamComps) fo += Math.sin(TAU * (c.m * u + c.n * v) + c.ph) * c.amp;
         const i = (y * size + x) * 3;
         tmp[i] = dx; tmp[i + 1] = dy; tmp[i + 2] = fo;
         maxS = Math.max(maxS, Math.abs(dx), Math.abs(dy));
      }
   }
   let fmin = 1e9, fmax = -1e9;
   for (let i = 0; i < size * size; i++) { fmin = Math.min(fmin, tmp[i * 3 + 2]); fmax = Math.max(fmax, tmp[i * 3 + 2]); }
   for (let i = 0; i < size * size; i++) {
      const nx = -tmp[i * 3] / maxS, nz = -tmp[i * 3 + 1] / maxS;
      data[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i * 4 + 1] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i * 4 + 2] = 255;
      const f = (tmp[i * 3 + 2] - fmin) / (fmax - fmin);
      data[i * 4 + 3] = Math.round(f * 255);
   }
   const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
   tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
   tex.magFilter = THREE.LinearFilter;
   tex.minFilter = THREE.LinearMipmapLinearFilter;
   tex.generateMipmaps = true;
   tex.anisotropy = 4;
   tex.needsUpdate = true;
   return tex;
}

// Radial grid: rings spaced exponentially so cells stay ~square (dr ~ r * dTheta) from ~1.5 m
// at the camera out to OCEAN_R. The mesh follows the camera; displacement uses world coords.
function makeRadialGrid(segs, b) {
   const a = 1.5 / b;
   const rings = Math.ceil(Math.log(OCEAN_R / a + 1) / b);
   const pos = new Float32Array((1 + rings * segs) * 3);
   pos[0] = 0; pos[1] = 0; pos[2] = 0;
   let p = 3;
   for (let i = 1; i <= rings; i++) {
      const r = Math.min(OCEAN_R, a * (Math.exp(b * i) - 1));
      for (let j = 0; j < segs; j++) {
         const t = (j / segs) * Math.PI * 2 + (i & 1) * (Math.PI / segs);
         pos[p++] = Math.cos(t) * r; pos[p++] = 0; pos[p++] = Math.sin(t) * r;
      }
   }
   const idx = [];
   for (let j = 0; j < segs; j++) idx.push(0, 1 + (j + 1) % segs, 1 + j);
   for (let i = 1; i < rings; i++) {
      const r0 = 1 + (i - 1) * segs, r1 = 1 + i * segs;
      for (let j = 0; j < segs; j++) {
         const j1 = (j + 1) % segs;
         if (i & 1) {
            idx.push(r0 + j, r0 + j1, r1 + j1);
            idx.push(r0 + j, r1 + j1, r1 + j);
         } else {
            idx.push(r0 + j, r0 + j1, r1 + j);
            idx.push(r0 + j1, r1 + j1, r1 + j);
         }
      }
   }
   const g = new THREE.BufferGeometry();
   g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
   g.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
   g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), OCEAN_R);
   return g;
}

const OCEAN_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
${WAVES_GLSL}
uniform sampler2D uDepthTex;
uniform vec4 uDepthRect;     // minX, minZ, 1/sizeX, 1/sizeZ
uniform vec4 uHullA[16];     // x, z, cos(h), sin(h)
uniform vec4 uHullB[16];     // 1/halfL, 1/halfB, 0, 0
uniform int uHullN;
varying vec3 vWP;
varying vec2 vPlane;
varying float vCrest;
float depthAt(vec2 p) {
   vec2 uv = (p - uDepthRect.xy) * uDepthRect.zw;
   if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 50.0;
   return texture2D(uDepthTex, uv).r * 50.0;
}
void main() {
   vec4 wp = modelMatrix * vec4(position, 1.0);
   vec2 p = wp.xz;
   float dist = length(vec3(p.x, 0.0, p.y) - cameraPosition);
   float depth = depthAt(p);
   float damp = mix(0.15, 1.0, smoothstep(0.5, 14.0, depth));
   // calm the water inside ship hulls so swell never pokes through a low deck
   for (int i = 0; i < 16; i++) {
      if (i >= uHullN) break;
      vec2 d = p - uHullA[i].xy;
      vec2 l = vec2(d.x * uHullA[i].z + d.y * uHullA[i].w, -d.x * uHullA[i].w + d.y * uHullA[i].z) * uHullB[i].xy;
      damp *= mix(0.3, 1.0, smoothstep(0.85, 1.25, length(l)));
   }
   vec3 o = waveDisp(p, dist, damp);
   wp.xyz += o;
   vCrest = o.y;
   vWP = wp.xyz;
   vPlane = p;
   gl_Position = projectionMatrix * viewMatrix * wp;
   #include <logdepthbuf_vertex>
}`;

const OCEAN_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${ATM_GLSL}
${WAVES_GLSL}
uniform samplerCube uEnvCube;
uniform sampler2D uDetail;
uniform sampler2D uDepthTex;
uniform vec4 uDepthRect;
uniform vec3 uSunColor;
uniform float uSunI;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSand;
uniform vec3 uSkyAmb;
uniform float uSea;
uniform float uAmpSum;
uniform float uLightning;
uniform vec2 uDetailFlow1;
uniform vec2 uDetailFlow2;
varying vec3 vWP;
varying vec2 vPlane;
varying float vCrest;

float depthAt(vec2 p) {
   vec2 uv = (p - uDepthRect.xy) * uDepthRect.zw;
   if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 50.0;
   return texture2D(uDepthTex, uv).r * 50.0;
}
vec3 waveNormal(vec2 p, float fp, out float jac) {
   vec3 n = vec3(0.0, 1.0, 0.0);
   jac = 1.0;
   for (int i = 0; i < NW; i++) {
      vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
      float lam = 6.2831853 / a.z;
      float fade = 1.0 - smoothstep(0.12 * lam, 0.45 * lam, fp);
      float th = a.z * dot(a.xy, p) - a.w * uWTime + b.z;
      float wa = a.z * b.x * fade;
      float c = cos(th), s = sin(th);
      n.x -= a.x * wa * c;
      n.z -= a.y * wa * c;
      n.y -= b.y * wa * s;
      jac -= b.y * wa * s;
   }
   return normalize(n);
}
void main() {
   #include <logdepthbuf_fragment>
   vec3 toCam = cameraPosition - vWP;
   float dist = length(toCam);
   vec3 V = toCam / dist;
   vec3 L = uSunDir;
   float fp = length(fwidth(vPlane));
   float jac;
   vec3 N = waveNormal(vPlane, fp, jac);

   // detail ripples: two scrolling scales, fading once they'd shimmer
   float dFade = 1.0 - smoothstep(0.35, 3.5, fp);
   vec4 t1 = texture2D(uDetail, vPlane / 61.0 + uDetailFlow1 * uWTime);
   vec4 t2 = texture2D(uDetail, vPlane / 19.0 + uDetailFlow2 * uWTime);
   vec4 t3 = texture2D(uDetail, vPlane / 240.0 - uDetailFlow1 * uWTime * 0.3);
   vec2 dn = (t1.xy * 2.0 - 1.0) * 0.55 + (t2.xy * 2.0 - 1.0) * 0.35 * dFade;
   vec2 dn3 = (t3.xy * 2.0 - 1.0) * 0.35;
   float detK = (0.28 + 0.35 * uSea);
   N = normalize(N + vec3(dn.x + dn3.x, 0.0, dn.y + dn3.y) * detK);
   // far away the mean normal flattens; keep a little tilt for a living horizon
   N = normalize(mix(N, vec3(0.0, 1.0, 0.0), smoothstep(4000.0, 30000.0, dist) * 0.5));

   float NdV = max(dot(N, V), 0.001);
   vec3 R = reflect(-V, N);
   R.y = abs(R.y);
   float rough = mix(0.05, 0.22, smoothstep(20.0, 9000.0, dist)) + 0.06 * uSea;
   vec3 refl = textureLod(uEnvCube, R, rough * 6.0).rgb;
   float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
   F = min(F, 0.9);

   // GGX sun glint
   vec3 H = normalize(V + L);
   float NdH = max(dot(N, H), 0.0), NdL = max(dot(N, L), 0.0);
   float a2 = rough * rough * rough * rough;
   float dd = NdH * NdH * (a2 - 1.0) + 1.0;
   float D = a2 / (3.14159 * dd * dd);
   float k = rough * rough * 0.5;
   float G = NdL / (NdL * (1.0 - k) + k) * NdV / (NdV * (1.0 - k) + k);
   float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
   vec3 spec = uSunColor * uSunI * min(D * G * Fs / (4.0 * NdV + 1e-3), 60.0) * uSunUp;

   // water body: deep/shallow from the baked depth map, sand showing through very shallow water
   float depth = depthAt(vPlane);
   float shallow = exp(-depth / 10.0);
   vec3 body = mix(uDeep, uShallow, shallow);
   body = mix(body, uSand * 0.6, exp(-depth / 2.8) * 0.6);
   float sunUp = max(L.y, 0.0);
   vec3 illum = uSunColor * uSunI * (0.12 + 0.45 * sunUp) * uSunUp + uSkyAmb;
   vec3 col = body * illum;
   // backlit crests glow green-blue (light through thin water)
   float crest = clamp(vCrest / max(uAmpSum, 0.05), -1.0, 1.0);
   float back = pow(max(dot(-V, vec3(L.x, 0.0, L.z) * 0.9 + vec3(0.0, 0.25, 0.0)), 0.0), 3.0);
   col += uShallow * uSunColor * uSunI * 0.35 * back * max(crest + 0.2, 0.0) * uSunUp * (1.0 - smoothstep(800.0, 5000.0, dist));

   col = mix(col, refl, F) + spec;

   // foam: wave crests (Jacobian < ~0 means the surface is folding) + animated shore bands
   float foamTex = texture2D(uDetail, vPlane / 23.0 + uDetailFlow2 * uWTime * 0.5).a;
   float foamTex2 = texture2D(uDetail, vPlane / 7.0 - uDetailFlow1 * uWTime).a;
   float ft = foamTex * 0.65 + foamTex2 * 0.35;
   float crestFoam = smoothstep(0.55, 0.05, jac) * smoothstep(0.35, 0.8, ft) * smoothstep(0.1, 0.6, uSea);
   crestFoam += smoothstep(0.62, 0.95, crest) * smoothstep(0.5, 0.75, ft) * uSea * 0.8;
   float band = sin(depth * 1.6 - uWTime * 1.7 + ft * 4.0) * 0.5 + 0.5;
   // surf bands only close to the waterline, lace thins out over wide flats (reefs stay turquoise)
   float shoreFoam = smoothstep(2.2, 0.2, depth) * smoothstep(0.55, 0.95, band * ft + 0.2) * 0.8 + smoothstep(0.5, 0.02, depth) * (0.35 + 0.5 * ft);
   float foam = clamp((crestFoam + shoreFoam) * (1.0 - smoothstep(1500.0, 6000.0, dist) * 0.8), 0.0, 1.0);
   vec3 foamCol = vec3(0.86, 0.9, 0.93) * (uSunColor * uSunI * (0.2 + 0.6 * sunUp) * uSunUp + uSkyAmb * 1.6);
   col = mix(col, foamCol, foam);
   col += vec3(0.3, 0.33, 0.4) * uLightning * 0.4;

   // fog; the ring edge is forced fully into the sky colour so the disc never shows
   float f = atmFogAmount(dist, cameraPosition.y, max(vWP.y, 0.0));
   f = max(f, smoothstep(${(OCEAN_R * 0.55).toFixed(1)}, ${(OCEAN_R * 0.97).toFixed(1)}, dist));
   col = mix(col, atmFogColor(-toCam), f);
   gl_FragColor = vec4(col, 1.0);
}`;

export class Ocean {
   constructor({ segs = 256 } = {}) {
      const b = (Math.PI * 2) / segs;
      this.geometry = makeRadialGrid(segs, b);
      this.detail = makeDetailTexture(256);
      const empty = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
      empty.needsUpdate = true;
      this._emptyDepth = empty;
      const wa = [], wb = [];
      for (let i = 0; i < NW; i++) { wa.push(new THREE.Vector4()); wb.push(new THREE.Vector4()); }
      this.waveUniforms = { uWaveA: { value: wa }, uWaveB: { value: wb }, uWTime: { value: 0 } };
      const hullA = [], hullB = [];
      for (let i = 0; i < 16; i++) { hullA.push(new THREE.Vector4()); hullB.push(new THREE.Vector4()); }
      this.uniforms = bindAtm({
         ...this.waveUniforms,
         uEnvCube: { value: null },
         uDetail: { value: this.detail },
         uDepthTex: { value: empty },
         uDepthRect: { value: new THREE.Vector4(-1e6, -1e6, 1e-9, 1e-9) },
         uHullA: { value: hullA }, uHullB: { value: hullB }, uHullN: { value: 0 },
         uSunColor: { value: new THREE.Color(1, 1, 1) },
         uSunI: { value: 3 },
         uDeep: { value: new THREE.Color(0.006, 0.05, 0.085) },
         uShallow: { value: new THREE.Color(0.03, 0.32, 0.30) },
         uSand: { value: new THREE.Color(0.75, 0.66, 0.46) },
         uSkyAmb: { value: new THREE.Color(0.3, 0.35, 0.45) },
         uSea: { value: 0.35 },
         uAmpSum: { value: 1 },
         uLightning: { value: 0 },
         uDetailFlow1: { value: new THREE.Vector2(0.01, 0.004) },
         uDetailFlow2: { value: new THREE.Vector2(-0.006, 0.013) },
      });
      this.material = new THREE.ShaderMaterial({
         uniforms: this.uniforms, vertexShader: OCEAN_VERT, fragmentShader: OCEAN_FRAG, fog: false,
      });
      this.material.extensions = { derivatives: true };
      this.mesh = new THREE.Mesh(this.geometry, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 10; // after ships/terrain: early-z rejects hidden water pixels
      this.waves = [];
      this.time = 0;
      this.setSea(0.35, 0.9);
   }

   setSea(seaState, windDir) {
      this.seaState = seaState;
      this.waves = makeWaves(seaState, windDir);
      let sum = 0;
      this.waves.forEach((w, i) => {
         this.uniforms.uWaveA.value[i].set(w.dx, w.dz, w.k, w.w);
         this.uniforms.uWaveB.value[i].set(w.A, w.Q, w.ph, 0);
         sum += w.A;
      });
      this.ampSum = sum;
      this.uniforms.uAmpSum.value = sum * 0.6;
      this.uniforms.uSea.value = seaState;
      const f1 = 0.004 + 0.01 * seaState;
      this.uniforms.uDetailFlow1.value.set(Math.cos(windDir) * f1, Math.sin(windDir) * f1);
      this.uniforms.uDetailFlow2.value.set(Math.cos(windDir + 1.1) * f1 * 1.6, Math.sin(windDir + 1.1) * f1 * 1.6);
   }

   applyEnv(env, cubeTex) {
      const U = this.uniforms;
      U.uEnvCube.value = cubeTex;
      U.uSunColor.value.setRGB(...env.sunColor);
      U.uSunI.value = env.sunIntensity;
      const hz = env.horizon, zn = env.zenith;
      U.uSkyAmb.value.setRGB((hz[0] + zn[0]) * 0.5, (hz[1] + zn[1]) * 0.5, (hz[2] + zn[2]) * 0.5).multiplyScalar(0.75);
      // storms: greyer, greener water; night: nearly black body colour (reflections carry it)
      const g = env.weather === 'storm' ? 0.6 : env.weather === 'rain' ? 0.4 : env.weather === 'overcast' ? 0.25 : 0;
      U.uDeep.value.setRGB(0.006 + 0.01 * g, 0.05 - 0.005 * g, 0.085 - 0.03 * g);
      U.uShallow.value.setRGB(0.03 + 0.02 * g, 0.32 - 0.1 * g, 0.30 - 0.12 * g);
      if (env.seaState !== this.seaState || env.windDir !== this._wind) { this._wind = env.windDir; this.setSea(env.seaState, env.windDir); }
   }

   setDepthMap(tex, rect) {
      this.uniforms.uDepthTex.value = tex || this._emptyDepth;
      if (rect) this.uniforms.uDepthRect.value.set(rect.minX, rect.minZ, 1 / rect.size, 1 / rect.size);
      else this.uniforms.uDepthRect.value.set(-1e6, -1e6, 1e-9, 1e-9);
   }

   // hulls: [{x, z, heading, halfL, halfB}]
   setHulls(hulls) {
      const n = Math.min(16, hulls.length);
      const A = this.uniforms.uHullA.value, B = this.uniforms.uHullB.value;
      for (let i = 0; i < n; i++) {
         const h = hulls[i];
         A[i].set(h.x, h.z, Math.cos(h.heading), Math.sin(h.heading));
         B[i].set(1 / h.halfL, 1 / h.halfB, 0, 0);
      }
      this.uniforms.uHullN.value = n;
   }

   update(time, camera, lightning = 0) {
      this.time = time;
      this.uniforms.uWTime.value = time;
      this.uniforms.uLightning.value = lightning;
      this.mesh.position.set(camera.position.x, 0, camera.position.z);
   }

   // CPU mirror of the (vertical) wave displacement, same distance fade as the GPU.
   heightAt(x, z, camPos) {
      const dist = camPos ? Math.hypot(x - camPos.x, camPos.y, z - camPos.z) : 0;
      let h = 0;
      const t = this.time;
      for (const w of this.waves) {
         const fade = 1 - smoothstep01(w.lam * 9, w.lam * 16, dist);
         if (fade <= 0) continue;
         h += w.A * fade * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t + w.ph);
      }
      return h;
   }

   dispose() {
      this.geometry.dispose();
      this.material.dispose();
      this.detail.dispose();
      this._emptyDepth.dispose();
   }
}
function smoothstep01(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
