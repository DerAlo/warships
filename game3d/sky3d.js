// game3d/sky3d.js — procedural sky dome (gradient, sun, clouds, moon, stars, lightning),
// environment presets (world.env -> colours/light/fog), and the sky reflection cubemap that
// feeds both the ocean reflection and scene.environment (image-based lighting via PMREM).
import * as THREE from '../vendor/three/three.module.min.js';
import { ATM, ATM_GLSL, bindAtm, clamp, lerp, smoothstep } from './gfxcommon3d.js';

// ---------------- environment presets ----------------
const TIME_PRESET = {
   day:   { zen: [0.090, 0.235, 0.58], hor: [0.50, 0.65, 0.84], glow: [1.00, 0.82, 0.60], sun: [1.0, 0.95, 0.88], sunI: 3.6, el: 0.62, az: -0.46, exposure: 0.92 },
   dawn:  { zen: [0.070, 0.115, 0.30], hor: [0.96, 0.60, 0.40], glow: [1.90, 0.85, 0.40], sun: [1.0, 0.62, 0.36], sunI: 2.5, el: 0.07, az: 0.25, exposure: 1.05 },
   dusk:  { zen: [0.055, 0.065, 0.21], hor: [0.92, 0.45, 0.33], glow: [2.00, 0.72, 0.34], sun: [1.0, 0.50, 0.28], sunI: 2.3, el: 0.05, az: Math.PI - 0.3, exposure: 1.08 },
   night: { zen: [0.004, 0.008, 0.020], hor: [0.020, 0.034, 0.060], glow: [0.04, 0.05, 0.07], sun: [0.55, 0.66, 0.92], sunI: 0.5, el: -0.35, az: 0.8, exposure: 2.2 },
};
const WEATHER = {
   clear:    { cover: 0.36, sunK: 1.00, grey: 0.00, dark: 1.00, glowK: 1.0, fogK: 1.00, rain: 0, sea: 0.35, vis: 0.9, disk: 1 },
   overcast: { cover: 0.90, sunK: 0.28, grey: 0.70, dark: 0.80, glowK: 0.25, fogK: 0.55, rain: 0, sea: 0.5, vis: 0.65, disk: 0 },
   rain:     { cover: 0.97, sunK: 0.16, grey: 0.85, dark: 0.55, glowK: 0.12, fogK: 0.36, rain: 0.6, sea: 0.65, vis: 0.45, disk: 0 },
   storm:    { cover: 1.00, sunK: 0.10, grey: 0.92, dark: 0.36, glowK: 0.06, fogK: 0.28, rain: 1.0, sea: 0.95, vis: 0.35, disk: 0 },
};

// Turns the (possibly partial or missing) world.env into everything the renderer needs.
// No env at all (current sim / menu) = bright day, scattered clouds, a fairly low sun.
export function resolveEnv(env) {
   const e = env || {};
   const time = TIME_PRESET[e.time] ? e.time : 'day';
   const weather = WEATHER[e.weather] ? e.weather : 'clear';
   const T = TIME_PRESET[time], W = WEATHER[weather];
   let el = Number.isFinite(e.sunElevation) ? e.sunElevation : (env ? T.el : 0.38);
   const az = Number.isFinite(e.sunAzimuth) ? e.sunAzimuth : T.az;
   const night = time === 'night' || el < -0.05;
   const seaState = clamp(Number.isFinite(e.seaState) ? e.seaState : W.sea, 0, 1);
   const vis = clamp(Number.isFinite(e.visibility) ? e.visibility : W.vis, 0, 1);

   // light direction: the sun, or the moon at night (so night still has shape + shadows)
   const lightEl = night ? 0.55 : Math.max(el, 0.035);
   const lightAz = night ? az + 2.2 : az;
   const ce = Math.cos(lightEl);
   const lightDir = new THREE.Vector3(Math.cos(lightAz) * ce, Math.sin(lightEl), Math.sin(lightAz) * ce).normalize();
   const sunDir = night ? new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize() : lightDir.clone();

   // a low day sun warms up continuously instead of snapping between presets
   let sunCol = T.sun.slice(), hor = T.hor.slice(), glow = T.glow.slice(), zen = T.zen.slice();
   if (time === 'day') {
      const warm = 1 - smoothstep(0.08, 0.7, el);
      sunCol = mixA(sunCol, [1.0, 0.72, 0.48], warm * 0.75);
      hor = mixA(hor, [0.72, 0.66, 0.66], warm * 0.35);
      glow = mixA(glow, [1.5, 0.85, 0.5], warm * 0.6);
   }
   const greyify = (c, k, dark) => { const l = c[0] * 0.3 + c[1] * 0.55 + c[2] * 0.15; return mixA(c, [l * 0.98, l * 1.0, l * 1.04], k).map(v => v * dark); };
   zen = greyify(zen, W.grey, W.dark);
   hor = greyify(hor, W.grey, W.dark);
   glow = glow.map(v => v * W.glowK);
   const sunI = T.sunI * W.sunK * (night ? 1 : smoothstep(-0.02, 0.12, el) * 0.8 + 0.2);

   // visual haze distance (m at which 50% of contrast is gone)
   const d50 = Math.max(night ? 3500 : 6000, (3000 + 23000 * vis) * W.fogK * (night ? 0.55 : 1));
   return {
      time, weather, night, seaState, visibility: vis,
      sunEl: el, sunAz: az, sunDir, lightDir,
      zenith: zen, horizon: hor, glow, sunColor: sunCol, sunIntensity: sunI,
      cloudCover: W.cover, cloudDark: W.dark, sunDisk: night ? 0 : W.disk, stars: night ? (weather === 'clear' ? 1 : weather === 'overcast' ? 0.15 : 0) : 0,
      moon: night && weather !== 'rain' && weather !== 'storm' ? 1 : 0,
      rain: W.rain, lightning: weather === 'storm', fogD50: d50,
      exposure: T.exposure * (weather === 'storm' ? 1.15 : weather === 'rain' ? 1.08 : 1),
      windDir: Number.isFinite(e.windDir) ? e.windDir : az + 2.4,
      windSpeed: 4 + seaState * 12,
      key: [time, weather, seaState.toFixed(2), vis.toFixed(2), el.toFixed(3), az.toFixed(3)].join('|'),
   };
}
function mixA(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

// ---------------- sky shader ----------------
const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
   vDir = position;
   gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */`
${ATM_GLSL}
uniform float uTime;
uniform float uCloudCover;
uniform float uCloudDark;
uniform float uStars;
uniform float uMoon;
uniform float uSunDisk;
uniform float uLightning;
uniform vec3 uSunColor;
uniform float uSunI;
uniform vec3 uMoonDir;
uniform vec2 uCamXZ;
uniform vec2 uWind;
varying vec3 vDir;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
   vec2 i = floor(p), f = fract(p);
   vec2 u = f * f * (3.0 - 2.0 * f);
   return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float cloudFbm(vec2 p) {
   float s = 0.0, a = 0.5;
   mat2 R = mat2(0.8, -0.6, 0.6, 0.8);
   for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = R * p * 2.03 + 11.7; a *= 0.5; }
   return s;
}
void main() {
   vec3 d = normalize(vDir);
   float dy = d.y;
   vec3 dh = vec3(d.x, max(dy, 0.0), d.z);
   vec3 col = skyBase(normalize(dh + vec3(0.0, 1e-4, 0.0)));

   float mu = dot(d, uSunDir);
   // stars (hashed cells on the unit sphere), hidden by the horizon haze
   if (uStars > 0.0 && dy > 0.0) {
      vec3 sp = d * 220.0;
      vec3 cell = floor(sp);
      float h = hash13(cell);
      if (h > 0.985) {
         vec3 c = vec3(hash13(cell + 1.7), hash13(cell + 5.3), hash13(cell + 9.1));
         float dd = length(fract(sp) - c);
         float tw = 0.65 + 0.35 * sin(uTime * (1.5 + 3.0 * h) + h * 90.0);
         col += vec3(0.9, 0.95, 1.0) * smoothstep(0.12, 0.0, dd) * (h - 0.985) * 180.0 * tw * uStars * smoothstep(0.0, 0.25, dy);
      }
      // faint milky band
      col += vec3(0.010, 0.012, 0.018) * uStars * smoothstep(0.35, 0.0, abs(dot(d, normalize(vec3(0.3, 0.2, 0.93))))) * vnoise(d.xz * 30.0);
   }
   // moon
   if (uMoon > 0.0) {
      float mm = dot(d, uMoonDir);
      float disk = smoothstep(0.99955, 0.99965, mm);
      vec3 mcol = vec3(1.4, 1.45, 1.55) * (0.8 + 0.2 * vnoise(d.xy * 900.0));
      col = mix(col, mcol, disk * uMoon);
      col += vec3(0.05, 0.06, 0.09) * pow(max(mm, 0.0), 300.0) * uMoon + vec3(0.02, 0.025, 0.04) * pow(max(mm, 0.0), 12.0) * uMoon;
   }
#ifndef REFLECTION
   // sun disk with limb darkening -- HDR so the bloom pass catches it
   float sd = smoothstep(0.99985, 0.99992, mu);
   col += uSunColor * sd * uSunDisk * 60.0 * (0.6 + 0.4 * smoothstep(0.99985, 1.0, mu));
#endif

   // clouds: an fBm layer on a plane ~2 km up, world-anchored under the moving camera
   if (dy > 0.0 && uCloudCover > 0.0) {
      float t = 2200.0 / max(dy, 0.02);
      vec2 p = (uCamXZ + d.xz * t) * 0.00016 + uWind * uTime;
      float n = cloudFbm(p);
      float thr = mix(0.78, 0.18, uCloudCover);
      float dens = smoothstep(thr, thr + 0.28, n);
      // self-shadowing: density a little way toward the sun
      float n2 = cloudFbm(p + normalize(uSunDir.xz + 1e-4) * 0.06);
      float shadow = clamp((n2 - n) * 3.2, 0.0, 1.0);
      vec3 amb = mix(uHorizon, uZenith, 0.35) * 0.9 + vec3(0.05) * uCloudDark;
      vec3 lit = uSunColor * uSunI * 0.21 * uSunUp + amb * 0.55;
      vec3 shade = amb * mix(0.45, 0.8, uCloudDark);
      vec3 ccol = mix(lit, shade, shadow * 0.85 + dens * 0.25 * (1.0 - uCloudDark));
      // thick overcast is darker underneath
      ccol *= mix(1.0, 0.62, smoothstep(0.6, 1.0, uCloudCover) * dens);
      // silver lining / forward scattering around the sun
      ccol += uGlow * pow(max(mu, 0.0), 10.0) * (1.0 - dens * 0.7) * 0.6;
      ccol += vec3(1.3, 1.35, 1.5) * uLightning * (0.6 + n);
      float far = exp(-t / 55000.0);
      float a = dens * smoothstep(0.0, 0.10, dy) * mix(0.25, 1.0, far);
      col = mix(col, mix(col, ccol, far * 0.85 + 0.15), a);
   }
   col += vec3(0.25, 0.27, 0.32) * uLightning * 0.35;
   gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
   constructor(renderer) {
      this.renderer = renderer;
      this.uniforms = bindAtm({
         uTime: { value: 0 },
         uCloudCover: { value: 0.35 },
         uCloudDark: { value: 1 },
         uStars: { value: 0 },
         uMoon: { value: 0 },
         uSunDisk: { value: 1 },
         uLightning: { value: 0 },
         uSunColor: { value: new THREE.Color(1, 0.95, 0.88) },
         uSunI: { value: 3.6 },
         uMoonDir: { value: new THREE.Vector3(0, 0.5, 1).normalize() },
         uCamXZ: { value: new THREE.Vector2() },
         uWind: { value: new THREE.Vector2(0.004, 0.0015) },
      });
      const geo = new THREE.SphereGeometry(1000, 48, 24);
      this.material = new THREE.ShaderMaterial({
         uniforms: this.uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
         side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      });
      this.mesh = new THREE.Mesh(geo, this.material);
      this.mesh.renderOrder = -100;
      this.mesh.frustumCulled = false;

      // reflection copy (no sun disk: the ocean draws its own GGX sun glint)
      this.reflMaterial = new THREE.ShaderMaterial({
         uniforms: this.uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
         defines: { REFLECTION: 1 }, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      });
      this.skyScene = new THREE.Scene();
      this.reflMesh = new THREE.Mesh(geo, this.reflMaterial);
      this.reflMesh.frustumCulled = false;
      this.skyScene.add(this.reflMesh);
      this.cubeRT = new THREE.WebGLCubeRenderTarget(192, {
         type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      });
      this.cubeCam = new THREE.CubeCamera(1, 5000, this.cubeRT);
      this.skyScene.add(this.cubeCam);
      this.pmrem = new THREE.PMREMGenerator(renderer);
      this.envRT = null;
      this._cubeT = 1e9;
      this._lightningT = 0; this._nextBolt = 4;
      this.env = null;
   }

   get cubeTexture() { return this.cubeRT.texture; }

   apply(env) {
      this.env = env;
      const U = this.uniforms;
      ATM.uSunDir.value.copy(env.night ? env.lightDir : env.sunDir);
      ATM.uZenith.value.setRGB(...env.zenith);
      ATM.uHorizon.value.setRGB(...env.horizon);
      ATM.uGlow.value.setRGB(...env.glow);
      ATM.uSunUp.value = env.night ? 0.15 : smoothstep(-0.05, 0.1, env.sunEl);
      ATM.uFogDist.value = env.fogD50 / Math.LN2;
      U.uCloudCover.value = env.cloudCover;
      U.uCloudDark.value = env.cloudDark;
      U.uStars.value = env.stars;
      U.uMoon.value = env.moon;
      U.uSunDisk.value = env.sunDisk;
      U.uSunColor.value.setRGB(...env.sunColor);
      U.uSunI.value = env.night ? 0.3 : env.sunIntensity / Math.max(0.2, env.night ? 1 : 1);
      U.uMoonDir.value.copy(env.lightDir);
      const w = env.windDir;
      U.uWind.value.set(Math.cos(w), Math.sin(w)).multiplyScalar(0.0012 + env.windSpeed * 0.00022);
      this._envDirty = true;
      this._cubeT = 1e9;
   }

   // returns the current lightning flash (0..1) so the renderer can boost exposure/light
   update(dt, time, camera) {
      const U = this.uniforms;
      U.uTime.value = time;
      U.uCamXZ.value.set(camera.position.x, camera.position.z);
      this.mesh.position.copy(camera.position);
      let flash = 0;
      if (this.env && this.env.lightning) {
         this._nextBolt -= dt;
         if (this._nextBolt <= 0) { this._lightningT = 0.55; this._nextBolt = 5 + Math.random() * 11; }
         if (this._lightningT > 0) {
            this._lightningT -= dt;
            const k = this._lightningT;
            // double flicker
            flash = k > 0.4 ? (k - 0.4) / 0.15 : k > 0.25 ? 0.15 : k > 0.1 ? (k - 0.1) / 0.15 * 0.7 : 0;
         }
      }
      U.uLightning.value = flash;
      // refresh the reflection cube a few times per second (moving clouds), IBL only on change
      this._cubeT += dt;
      if (this._cubeT > 0.25 || flash > 0) {
         this._cubeT = 0;
         this.cubeCam.update(this.renderer, this.skyScene);
         if (this._envDirty) {
            this._envDirty = false;
            const old = this.envRT;
            this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture);
            if (old) old.dispose();
         }
      }
      return flash;
   }

   dispose() {
      this.mesh.geometry.dispose();
      this.material.dispose(); this.reflMaterial.dispose();
      this.cubeRT.dispose();
      if (this.envRT) this.envRT.dispose();
      this.pmrem.dispose();
   }
}
