// game3d/post3d.js — HDR pipeline: the scene renders linear HDR into a multisampled half-float
// target; a bloom chain (bright pass -> downsample pyramid -> tent upsample) makes sun glint,
// muzzle flashes, tracers and fires glow; the composite applies grading, ACES tone mapping
// (three's own chunk, exposure per environment), sRGB output and a vignette.
import * as THREE from '../vendor/three/three.module.min.js';

const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BRIGHT_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
void main() {
   // 4-tap box downsample + soft-knee threshold
   vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb
          + texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb;
   c *= 0.25;
   c = min(c, vec3(60.0));
   float l = max(c.r, max(c.g, c.b));
   float knee = uThreshold * 0.6;
   float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
   soft = soft * soft / (4.0 * knee + 1e-4);
   float w = max(soft, l - uThreshold) / max(l, 1e-4);
   gl_FragColor = vec4(c * w, 1.0);
}`;

const DOWN_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
   // 13-tap "dual filter" style downsample, stable under motion
   vec3 a = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
   vec3 b = texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
   vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
   vec3 d = texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
   vec3 e = texture2D(tSrc, vUv).rgb;
   vec3 f = texture2D(tSrc, vUv + uTexel * vec2(-2.0, 0.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(2.0, 0.0)).rgb
          + texture2D(tSrc, vUv + uTexel * vec2(0.0, -2.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.0, 2.0)).rgb;
   gl_FragColor = vec4(e * 0.25 + (a + b + c + d) * 0.125 + f * 0.0625, 1.0);
}`;

const UP_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uWeight;
varying vec2 vUv;
void main() {
   vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
   s += (texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb
       + texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb) * 2.0;
   s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
      + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
   gl_FragColor = vec4(s / 16.0 * uWeight, 1.0);
}`;

const COMP_FRAG = /* glsl */`
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uSat;
uniform float uContrast;
uniform float uVignette;
uniform vec3 uTint;
uniform float uTime;
varying vec2 vUv;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
   vec3 c = texture2D(tScene, vUv).rgb;
   c += texture2D(tBloom, vUv).rgb * uBloom;
   c *= uTint;
   float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
   c = max(mix(vec3(l), c, uSat), 0.0);
   // gentle contrast around mid-grey in log space
   c = pow(c / 0.18, vec3(uContrast)) * 0.18;
   gl_FragColor = vec4(c, 1.0);
   #include <tonemapping_fragment>
   #include <colorspace_fragment>
   vec2 q = vUv - 0.5;
   float vig = 1.0 - uVignette * dot(q, q) * 2.2;
   gl_FragColor.rgb *= vig;
   // 1-bit dither against banding in the sky gradient
   gl_FragColor.rgb += (hash12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) / 255.0;
}`;

export class Post {
   constructor(renderer, { samples = 4, bloomLevels = 5 } = {}) {
      this.renderer = renderer;
      this.samples = samples;
      this.levels = bloomLevels;
      this.sceneRT = new THREE.WebGLRenderTarget(4, 4, {
         type: THREE.HalfFloatType, samples, depthBuffer: true, stencilBuffer: false,
         minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
      this.bloomRTs = [];
      for (let i = 0; i < bloomLevels; i++) {
         this.bloomRTs.push(new THREE.WebGLRenderTarget(4, 4, {
            type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
         }));
      }
      const mk = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({
         uniforms, vertexShader: FS_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, toneMapped: false, ...extra,
      });
      this.brightMat = mk(BRIGHT_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.6 } });
      this.downMat = mk(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
      this.upMat = mk(UP_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } },
         { blending: THREE.AdditiveBlending, transparent: true });
      this.compMat = mk(COMP_FRAG, {
         tScene: { value: this.sceneRT.texture }, tBloom: { value: null },
         uBloom: { value: 0.12 }, uSat: { value: 1.1 }, uContrast: { value: 1.06 }, uVignette: { value: 0.28 },
         uTint: { value: new THREE.Color(1, 1, 1) }, uTime: { value: 0 },
      }, { toneMapped: true });
      const tri = new THREE.BufferGeometry();
      tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      this.quad = new THREE.Mesh(tri, this.brightMat);
      this.quad.frustumCulled = false;
      this.fsScene = new THREE.Scene();
      this.fsScene.add(this.quad);
      this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.w = 0; this.h = 0;
   }

   setSize(w, h) {
      w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
      if (w === this.w && h === this.h) return;
      this.w = w; this.h = h;
      this.sceneRT.setSize(w, h);
      let bw = w, bh = h;
      for (const rt of this.bloomRTs) { bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1); rt.setSize(bw, bh); }
   }

   _pass(mat, target) {
      this.quad.material = mat;
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.fsScene, this.fsCam);
   }

   render(scene, camera, p) {
      const r = this.renderer;
      r.setRenderTarget(this.sceneRT);
      r.clear(true, true, false);
      r.render(scene, camera);

      // bloom chain
      const rts = this.bloomRTs;
      this.brightMat.uniforms.tSrc.value = this.sceneRT.texture;
      this.brightMat.uniforms.uTexel.value.set(1 / this.w, 1 / this.h);
      this.brightMat.uniforms.uThreshold.value = p.bloomThreshold ?? 1.6;
      this._pass(this.brightMat, rts[0]);
      for (let i = 1; i < rts.length; i++) {
         this.downMat.uniforms.tSrc.value = rts[i - 1].texture;
         this.downMat.uniforms.uTexel.value.set(1 / rts[i - 1].width, 1 / rts[i - 1].height);
         this._pass(this.downMat, rts[i]);
      }
      const ac = r.autoClear;
      r.autoClear = false;
      for (let i = rts.length - 1; i > 0; i--) {
         this.upMat.uniforms.tSrc.value = rts[i].texture;
         this.upMat.uniforms.uTexel.value.set(1 / rts[i].width, 1 / rts[i].height);
         this.upMat.uniforms.uWeight.value = 1.0;
         this._pass(this.upMat, rts[i - 1]);
      }
      r.autoClear = ac;

      const U = this.compMat.uniforms;
      U.tBloom.value = rts[0].texture;
      U.uBloom.value = p.bloom ?? 0.12;
      U.uSat.value = p.saturation ?? 1.1;
      U.uContrast.value = p.contrast ?? 1.06;
      U.uVignette.value = p.vignette ?? 0.28;
      U.uTime.value = p.time || 0;
      if (p.tint) U.uTint.value.setRGB(p.tint[0], p.tint[1], p.tint[2]); else U.uTint.value.setRGB(1, 1, 1);
      r.toneMappingExposure = p.exposure ?? 1;
      this._pass(this.compMat, null);
   }

   dispose() {
      this.sceneRT.dispose();
      for (const rt of this.bloomRTs) rt.dispose();
      this.brightMat.dispose(); this.downMat.dispose(); this.upMat.dispose(); this.compMat.dispose();
      this.quad.geometry.dispose();
   }
}
