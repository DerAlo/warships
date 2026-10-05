// gamev2/blast3d.js — the scripted large detonation of a mission finale (sim: blast.js), seen from
// far away at sea: flash, fireball, rising column and cap cloud that lingers, base surge and the
// shock ring running out over the water. Pure presentation: reads world.blasts (`state`, `age`,
// `pos`, `r`) and never writes to the simulation, so it works from replicated data alone.
//
// Cost model: the whole cloud is ONE instanced draw call of camera-facing "lobes" (soft spheres
// shaded in the fragment shader, premultiplied alpha so the additive flash rides in the same
// batch) and it only exists while a blast is on the map. Lobe count follows GFX.effects
// (14 on low .. 46 on ultra); low takes one noise tap per fragment, the others two. Positions
// are a pure function of the blast age, written into preallocated arrays: no per-frame allocation.
//
// Outputs for the renderer / main3d (read every frame):
//   white     0..1  screen whiteout (DOM overlay)          exposure  extra exposure factor (0 = none)
//   shake     camera shake magnitude while the shock front passes the camera
//   onShock   callback(dist, pos) once when the front arrives (delayed rumble: audio.blast)
import * as THREE from '../vendor/three/three.module.min.js';
import { ATM_GLSL, bindAtm } from './gfxcommon3d.js';
import { GFX } from './gfxquality.js';

const MAX_LOBES = 48, MAX_BLASTS = 3;
const SOUND = 343;                       // m/s: shock ring, shake and rumble travel together
const FADE0 = 84, FADE1 = 116;           // s: the cloud thins out before the sim drops the blast (120 s)
// lobes per role and tier: [core, cap ring, stem, surge, wilson]
const COUNTS = [[1, 5, 4, 4, 0], [2, 7, 6, 6, 0], [3, 10, 9, 10, 1], [4, 14, 12, 14, 1]];
const K_CORE = 0, K_CAP = 1, K_STEM = 2, K_SURGE = 3, K_WILSON = 4, K_FLASH = 5, K_RING = 6;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

const VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iA;     // radius (m), heat 0..1.5, alpha, seed
attribute vec4 iB;     // vertical squash, kind, shade (albedo 0 dark .. 1 white), age (s)
varying vec2 vUv;
varying vec4 vA;
varying vec4 vB;
varying vec3 vWP;
varying vec3 vR;
varying vec3 vU;
varying vec3 vF;
void main() {
   vec2 q = position.xy * 2.0;
   vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
   vec3 U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
   vec3 wp;
   if (iB.y > 5.5) {
      // shock ring: flat on the sea, pulled a little toward the eye so the swell does not cut it
      wp = iPos + vec3(q.x, 0.0, q.y) * iA.x;
      vec3 v = cameraPosition - wp;
      float d = length(v);
      wp += v / max(d, 1.0) * min(d * 0.5, 2.0 + d * 0.004);
      vR = vec3(1.0, 0.0, 0.0); vU = vec3(0.0, 0.0, 1.0);
   } else {
      wp = iPos + R * (q.x * iA.x) + U * (q.y * iA.x * iB.x);
      vR = R; vU = U;
   }
   vF = normalize(cross(vR, vU));
   vUv = q; vA = iA; vB = iB; vWP = wp;
   gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FRAG = /* glsl */`
${ATM_GLSL}
uniform sampler2D uNoise;
uniform vec3 uSunCol;
uniform vec3 uAmb;
uniform float uTime;
varying vec2 vUv;
varying vec4 vA;
varying vec4 vB;
varying vec3 vWP;
varying vec3 vR;
varying vec3 vU;
varying vec3 vF;
void main() {
   float kind = vB.y;
   float r2 = dot(vUv, vUv);
   if (r2 > 1.0) discard;
   float r = sqrt(r2);
   if (kind > 5.5) {
      // ---- shock ring on the water: a bright front with a broken foam trail behind it
      float w = vA.y;                                   // band width as a fraction of the radius
      float x = (1.0 - r) / w;                          // 0 at the front, growing inward
      if (x > 6.0) discard;
      float n = texture2D(uNoise, vWP.xz * 0.0011 + vA.w).a;
      float front = smoothstep(0.0, 0.25, x) * smoothstep(1.3, 0.35, x);
      float trail = smoothstep(6.0, 1.0, x) * smoothstep(0.0, 0.6, x) * smoothstep(0.42, 0.7, n) * 0.5;
      float a = (front * (0.6 + 0.4 * n) + trail) * vA.z;
      vec3 col = atmApply((uAmb * 1.1 + uSunCol * 0.62) * 0.9, vWP);
      gl_FragColor = vec4(col * a, a);
      return;
   }
   if (kind > 4.5) {
      // ---- flash / glow: additive, no haze on it (it is what lights the haze)
      float f = pow(1.0 - r, 2.2) + 0.35 * pow(1.0 - r, 12.0);
      vec3 hot = mix(vec3(1.0, 0.42, 0.12), vec3(1.0, 0.93, 0.82), clamp(vA.y, 0.0, 1.0));
      gl_FragColor = vec4(hot * (f * vA.z), 0.0);
      return;
   }
   float z = sqrt(1.0 - r2);
   vec3 n = normalize(vR * vUv.x + vU * (vUv.y) + vF * z);
   // billowing surface: slow noise that creeps upward with the convection
   vec2 uv = vUv * 0.31 + vec2(vA.w * 7.3, vA.w * 3.1 - uTime * 0.012);
   vec4 t1 = texture2D(uNoise, uv);
   float nz = t1.r;
#ifdef FINE
   vec4 t2 = texture2D(uNoise, uv * 3.1 + vec2(0.37, uTime * 0.02));
   nz = nz * 0.62 + t2.a * 0.38;
   n = normalize(n + (vR * (t2.r - 0.5) + vU * (t2.g - 0.5)) * 0.9);
#endif
   float edge = smoothstep(1.0, 0.5, r + (nz - 0.5) * 0.62);
   if (edge < 0.004) discard;
   float a = edge * vA.z;
   vec3 col;
   if (kind > 3.5) {
      // condensation dome: thin white veil
      col = (uAmb * 1.3 + uSunCol * 0.7) * 0.95;
      a *= 0.5 * smoothstep(0.2, 0.9, r);
   } else {
      float diff = max(dot(n, uSunDir), 0.0);
      float under = 0.5 + 0.5 * n.y;                    // the belly of the cloud is in its own shade
      float cav = 0.55 + 0.75 * nz;                     // creases darker than the bulges
      vec3 alb = mix(vec3(0.085, 0.07, 0.06), vec3(0.86, 0.85, 0.84), vB.z);
      col = alb * cav * (uAmb * (0.55 + 0.75 * under) + uSunCol * (diff * 0.8 + 0.07));
      // heat: the fresh fireball is all fire, the cooling cloud keeps it in the creases
      float heat = vA.y;
      float core = clamp(heat * (0.35 + 1.25 * (1.0 - nz) * (0.55 + 0.45 * z)), 0.0, 1.6);
      vec3 fire = mix(vec3(2.6, 0.32, 0.03), vec3(30.0, 15.0, 5.0), smoothstep(0.35, 1.25, core)) * core;
      col = mix(col, fire, clamp(core * 1.4, 0.0, 1.0));
      // glare of the fire below on the underside of the cap
      col += vec3(1.6, 0.6, 0.16) * vB.w * (1.0 - under) * cav;
   }
   col = atmApply(col, vWP);
   gl_FragColor = vec4(col * a, a);
}`;

export class BlastFX {
   constructor(scene, fx) {
      this.scene = scene; this.fx = fx;
      this.white = 0; this.exposure = 0; this.shake = 0;
      this.onShock = null;
      this.active = 0;                 // blasts drawn this frame
      this.lobes = 0;                  // instances drawn this frame (tests / stats)
      this.recs = Array.from({ length: MAX_BLASTS }, () => ({ on: false, id: null, x: 0, y: 0, age: 0, last: -1, stale: 0, seed: 0, late: false,
         rf: 300, shock: 3000, heard: false, lit: false, dist: 0, seen: 0 }));
      this._q = -1; this._n = 0;
      this._role = new Uint8Array(MAX_LOBES); this._u = new Float32Array(MAX_LOBES); this._v = new Float32Array(MAX_LOBES); this._w = new Float32Array(MAX_LOBES);
      // scratch for one frame: position, params, sort key
      this._p = new Float32Array(MAX_LOBES * 3 + 6); this._a = new Float32Array(MAX_LOBES * 4 + 8); this._b = new Float32Array(MAX_LOBES * 4 + 8);
      this._key = new Float32Array(MAX_LOBES + 2); this._ord = new Uint8Array(MAX_LOBES + 2);
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const N = (MAX_LOBES + 2) * MAX_BLASTS;
      const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(N * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
      this.aPos = mk(3); this.aA = mk(4); this.aB = mk(4);
      g.setAttribute('iPos', this.aPos); g.setAttribute('iA', this.aA); g.setAttribute('iB', this.aB);
      g.instanceCount = 0;
      this.uTime = { value: 0 };
      this.material = new THREE.ShaderMaterial({
         uniforms: bindAtm({ uNoise: { value: fx.noise }, uSunCol: fx.uSunCol, uAmb: fx.uAmb, uTime: this.uTime }),
         vertexShader: VERT, fragmentShader: FRAG, defines: {},
         transparent: true, depthWrite: false,
         blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
         blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      });
      this.mesh = new THREE.Mesh(g, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 22;      // over the smoke pool, under the glow pool
      this.mesh.visible = false;
      scene.add(this.mesh);
   }

   clear() {
      for (const r of this.recs) r.on = false;
      this.white = 0; this.exposure = 0; this.shake = 0; this.active = 0; this.lobes = 0;
      this.mesh.visible = false; this.mesh.geometry.instanceCount = 0;
   }
   dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.material.dispose(); }

   // lobe layout for a tier: role + three fixed random numbers each
   _layout(q) {
      this._q = q;
      const c = COUNTS[q];
      let n = 0;
      for (let role = 0; role < c.length; role++) {
         for (let i = 0; i < c[role] && n < MAX_LOBES; i++, n++) {
            this._role[n] = role;
            this._u[n] = (i + 0.5) / c[role];            // even spread along the role's axis
            this._v[n] = hash(n * 3.7 + role * 11.3);
            this._w[n] = hash(n * 9.1 + role * 5.9 + 2.2);
         }
      }
      this._n = n;
      const fine = q >= 1;
      if (!!this.material.defines.FINE !== fine) {
         if (fine) this.material.defines.FINE = 1; else delete this.material.defines.FINE;
         this.material.needsUpdate = true;
      }
   }

   _rec(b) {
      let free = null;
      for (const r of this.recs) { if (r.on && r.id === b.id) return r; if (!r.on && !free) free = r; }
      if (!free) return null;
      const r = free, d = b.r || {};
      r.on = true; r.id = b.id; r.x = b.pos ? b.pos.x : b.x; r.y = b.pos ? b.pos.y : b.y;
      r.age = +b.age || 0; r.last = r.age; r.stale = 0;
      r.late = r.age > 3;              // joined while the cloud already stands: no flash, no rumble
      r.heard = r.late; r.lit = r.late;
      r.shock = Math.max(600, +d.shock || 3000);
      r.rf = clamp((+d.destroyed || r.shock * 0.25) * 0.55, 140, 900);
      r.seed = hash((Number(b.id) || 1) * 1.37);
      return r;
   }

   update(world, dt, time, camera) {
      const bs = world.blasts;
      let any = false;
      this.white = 0; this.exposure = 0; this.shake = 0; this.active = 0; this.lobes = 0;
      const f = (this._f = (this._f || 0) + 1);
      if (bs && bs.length) {
         for (let i = 0; i < bs.length; i++) {
            const b = bs[i];
            if (!b || b.state !== 'done') continue;
            const r = this._rec(b);
            if (!r) continue;
            r.seen = f;
            // follow the sim clock: stands still while the game is paused, never drifts far from `age`
            const age = +b.age || 0;
            if (age !== r.last) { r.last = age; r.stale = 0; } else r.stale += dt;
            if (r.stale < 0.3) r.age += dt;
            if (r.age < age - 0.3 || r.age > age + 0.3) r.age = age;
            any = true;
         }
      }
      for (const r of this.recs) if (r.on && r.seen !== f) r.on = false;
      if (!any) { if (this.mesh.visible) { this.mesh.visible = false; this.mesh.geometry.instanceCount = 0; } return; }
      const q = clamp(GFX.effects | 0, 0, 3);
      if (q !== this._q) this._layout(q);
      this.uTime.value = time;
      let out = 0;
      for (const r of this.recs) if (r.on) { out = this._blast(r, dt, camera, q, out); this.active++; }
      const g = this.mesh.geometry;
      g.instanceCount = out; this.lobes = out;
      this.mesh.visible = out > 0;
      this.aPos.needsUpdate = true; this.aA.needsUpdate = true; this.aB.needsUpdate = true;
   }

   // one blast: fill the scratch lobes from its age, sort far -> near, append to the batch
   _blast(r, dt, camera, q, out) {
      const t = r.age, rf = r.rf, cx = r.x, cz = r.y;
      const cp = camera.position;
      const dist = Math.hypot(cx - cp.x, cz - cp.z);
      r.dist = dist;
      const fade = 1 - sstep(FADE0, FADE1, t);
      const H = rf * 5.6;                                         // height of the cap when it has risen
      const rise = 1 - Math.exp(-t / 15);
      const grow = 1 - Math.exp(-t / 0.7);
      const capY = rf * 0.55 * grow + (H - rf * 0.55) * rise;
      const capR = rf * (0.95 * grow + 1.75 * (1 - Math.exp(-t / 16)));
      const heat = Math.exp(-t / 7) * (t < 0.4 ? 1.5 : 1.5 - 0.5 * sstep(0.4, 3, t));
      const wx = (this.fx.windX || 0), wz = (this.fx.windZ || 0);
      const drift = Math.max(0, t - 6) * 0.9;                     // the top leans with the wind over time
      const P = this._p, A = this._a, B = this._b;
      let n = 0;
      const put = (x, y, z, rad, ht, al, seed, squash, kind, shade, glare) => {
         P[n * 3] = x; P[n * 3 + 1] = y; P[n * 3 + 2] = z;
         A[n * 4] = rad; A[n * 4 + 1] = ht; A[n * 4 + 2] = al; A[n * 4 + 3] = seed;
         B[n * 4] = squash; B[n * 4 + 1] = kind; B[n * 4 + 2] = shade; B[n * 4 + 3] = glare;
         n++;
      };
      const shadeCap = 0.16 + 0.5 * sstep(4, 40, t);              // dark smoke turning into pale cloud
      const glare = Math.exp(-t / 9) * 0.9;
      for (let i = 0; i < this._n; i++) {
         const role = this._role[i], u = this._u[i], v = this._v[i], w = this._w[i];
         const seed = r.seed + i * 0.173;
         if (role === K_CORE) {
            // the fireball itself, later the crown of the cap
            const a = u * 6.2832 + r.seed * 6, off = (this._n > 14 ? 0.32 : 0) * capR * (i === 0 ? 0 : 1);
            const y = capY + (i === 0 ? capR * 0.12 : capR * 0.2 * (v - 0.3));
            const k = y / H;
            put(cx + Math.cos(a) * off + wx * drift * k, y, cz + Math.sin(a) * off + wz * drift * k,
               capR * (i === 0 ? 0.92 : 0.7), heat, fade, seed, 0.8, K_CORE, shadeCap + 0.08, 0);
         } else if (role === K_CAP) {
            // torus of lobes rolling outward under the crown
            const open = sstep(1.5, 12, t);
            const a = u * 6.2832 + v * 0.7 + r.seed * 3;
            const rr = capR * (0.35 + 0.62 * open) * (0.86 + 0.28 * w);
            const y = capY - capR * (0.1 + 0.22 * w) * open;
            const k = y / H;
            put(cx + Math.cos(a) * rr + wx * drift * k, y, cz + Math.sin(a) * rr + wz * drift * k,
               capR * (0.5 + 0.2 * v), heat * (0.75 + 0.3 * w), fade * sstep(0.2, 1.4, t), seed, 0.74, K_CAP, shadeCap * (0.75 + 0.4 * v), glare);
         } else if (role === K_STEM) {
            // the column: lobes strung from the sea to the cap, a skirt at the foot
            const top = Math.max(rf * 0.3, capY - capR * 0.42);
            const y = top * (0.04 + 0.96 * u);
            if (t < 1.2 + u * 3.5) continue;
            const k = y / H, wob = rf * 0.16;
            const rad = rf * (0.36 + 0.34 * (1 - u) * (1 - u) + 0.12 * v) * (0.7 + 0.3 * sstep(2, 20, t));
            put(cx + (v - 0.5) * wob + wx * drift * k, y, cz + (w - 0.5) * wob + wz * drift * k,
               rad, heat * 0.5 * u, fade * sstep(1.2 + u * 3.5, 3.5 + u * 5, t), seed, 1.25, K_STEM, 0.3 + 0.35 * sstep(6, 45, t) + 0.1 * v, glare * u);
         } else if (role === K_SURGE) {
            // base surge: a low white wall of spray rolling out over the water
            if (t < 0.8) continue;
            const a = u * 6.2832 + v * 0.5;
            const rr = rf * (0.7 + 2.3 * (1 - Math.exp(-(t - 0.8) / 9))) * (0.9 + 0.2 * w);
            const rad = rf * (0.42 + 0.34 * sstep(1, 25, t)) * (0.85 + 0.3 * v);
            put(cx + Math.cos(a) * rr, rad * 0.36, cz + Math.sin(a) * rr,
               rad, 0, fade * sstep(0.8, 3, t) * (1 - 0.55 * sstep(30, 75, t)) * 0.92, seed, 0.6, K_SURGE, 0.78 + 0.2 * v, 0);
         } else if (role === K_WILSON) {
            // condensation dome flashing out behind the shock, gone in two seconds
            const a = sstep(0.25, 0.7, t) * (1 - sstep(1.1, 2.6, t));
            if (a <= 0) continue;
            put(cx, rf * 0.3, cz, Math.min(SOUND * t * 1.6, rf * 4.5), 0, a * 0.7, seed, 0.6, K_WILSON, 1, 0);
         }
      }
      // sort this blast's lobes far -> near (insertion sort over a handful of entries)
      const key = this._key, ord = this._ord;
      for (let i = 0; i < n; i++) {
         const dx = P[i * 3] - cp.x, dy = P[i * 3 + 1] - cp.y, dz = P[i * 3 + 2] - cp.z;
         const k = dx * dx + dy * dy + dz * dz;
         let j = i - 1;
         while (j >= 0 && key[j] < k) { key[j + 1] = key[j]; ord[j + 1] = ord[j]; j--; }
         key[j + 1] = k; ord[j + 1] = i;
      }
      const aP = this.aPos.array, aA = this.aA.array, aB = this.aB.array;
      const emit = (i) => {
         aP[out * 3] = P[i * 3]; aP[out * 3 + 1] = P[i * 3 + 1]; aP[out * 3 + 2] = P[i * 3 + 2];
         aA[out * 4] = A[i * 4]; aA[out * 4 + 1] = A[i * 4 + 1]; aA[out * 4 + 2] = A[i * 4 + 2]; aA[out * 4 + 3] = A[i * 4 + 3];
         aB[out * 4] = B[i * 4]; aB[out * 4 + 1] = B[i * 4 + 1]; aB[out * 4 + 2] = B[i * 4 + 2]; aB[out * 4 + 3] = B[i * 4 + 3];
         out++;
      };
      // the shock ring lies on the sea under everything else
      const ringR = SOUND * t, ringMax = Math.max(r.shock * 4, 9000);
      if (ringR > rf * 0.8 && ringR < ringMax) {
         const al = (1 - sstep(r.shock * 1.2, ringMax, ringR)) * sstep(rf * 0.8, rf * 1.6, ringR) * 0.8;
         const i = n;
         put(cx, 0.4, cz, ringR, clamp(90 / ringR + 0.012, 0.014, 0.2), al, r.seed, 1, K_RING, 0, 0);
         emit(i);
      }
      for (let i = 0; i < n - (ringR > rf * 0.8 && ringR < ringMax ? 1 : 0); i++) emit(ord[i]);
      // flash and afterglow: one additive lobe on top (bloom picks it up)
      const fl = r.late ? 0 : (t < 0.12 ? 1 : Math.exp(-(t - 0.12) / 0.55));
      const glow = fl * 60 + heat * 1.6 * fade;
      if (glow > 0.02) {
         const i = n;
         put(cx, Math.max(capY, rf * 0.4), cz, rf * (2.2 + 9 * fl) + capR * 1.2, fl, glow, 0, 1, K_FLASH, 0, 0);
         emit(i);
      }

      // ---- what the eye and the ear get
      if (!r.late) {
         const near = Math.exp(-dist / (r.shock * 4));
         // facing the burst blinds more than having it astern
         _v.set(cx - cp.x, 0, cz - cp.z).normalize();
         camera.getWorldDirection(_d);
         const facing = 0.62 + 0.38 * clamp(_v.dot(_d) * 1.5 + 0.2, 0, 1);
         const wv = clamp(1.5 * near * facing, 0, 1) * (t < 0.15 ? 1 : Math.exp(-(t - 0.15) / 0.8));
         if (wv > this.white) this.white = wv < 0.004 ? 0 : wv;
         const ex = near * (3.5 * fl + 0.5 * Math.exp(-t / 3));
         if (ex > this.exposure) this.exposure = ex;
         if (!r.lit) {
            r.lit = true;
            this.fx._light(cx, rf, cz, 6e8, 3.2, 1, 0.86, 0.7, false, 60000);
            this.fx.nightFlash = 1;
         }
         const ta = dist / SOUND;
         if (t >= ta) {
            const m = clamp(7 * r.shock / Math.max(dist, r.shock * 0.6), 0.6, 11);
            if (!r.heard) { r.heard = true; if (this.onShock) this.onShock(dist, r, m); }
            const s = m * Math.exp(-(t - ta) / 1.3);
            if (s > 0.05 && s > this.shake) this.shake = s;
         }
      }
      return out;
   }
}
const _v = new THREE.Vector3(), _d = new THREE.Vector3();
