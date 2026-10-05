// game3d/render3d.js — the 3D scene: procedural sky + IBL, Gerstner ocean, relief islands,
// detailed ship models, effects, HDR post (bloom + ACES). Reads sim state only; every
// contract field is read with a fallback so this runs against both the small legacy arena
// and the WoWs-scale sim (see game3d/ARCHITECTURE.md).
// Mapping: sim {x, y} -> THREE.Vector3(x, height, y); ship groups use rotation.y = -heading.
import * as THREE from '../vendor/three/three.module.min.js';
import { ChaseCamera } from './camera3d.js';
import { HudCanvases3D } from './minimap3d.js';
import { clamp, ATM } from './gfxcommon3d.js';
import { Sky, resolveEnv } from './sky3d.js';
import { Ocean } from './water3d.js';
import { Terrain } from './terrain3d.js';
import { ShipModels } from './ships3d.js';
import { Post } from './post3d.js';
import { FX } from './fx3d.js';
import { AirModels } from './air3d.js';
import { MissileFX } from './missiles3d.js';
import { TIERS, GFX, OPTION_KEYS, tierOptions, applyGfx, startTier, gfxCustom, lowerTier, rememberFallback, frameLooksBlank, PROBES, gpuInfo } from './gfxquality.js';

const _v = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();

export class Renderer3D {
   constructor(canvas) {
      this.canvas = canvas;
      const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
      // quality: a tier, or single options the player set on top of one (this.custom)
      const custom = gfxCustom();
      this.tier = custom ? custom.base : startTier();
      this.custom = !!custom;
      const tq = this.opts = tierOptions(this.tier, custom);
      applyGfx(this.tier, tq);
      this.onGfxChange = null;   // main3d: keeps the pause menu in step (tier switch, watchdog step-down)
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      r.info.autoReset = false;
      // GPU facts once, while the context is alive (a lost context answers null to everything)
      this._gpu = gpuInfo(r.getContext());
      this.pixelRatio = this._pixelRatio(tq);
      r.setPixelRatio(this.pixelRatio);
      // a lost context (mobile GPU out of memory / reset) would leave the canvas white for good:
      // three.js keeps it restorable; here the tier steps down for this and every later visit
      this.lost = 0;
      this.onContextLost = null; this.onContextRestored = null;   // main3d: the veil over the battle
      canvas.addEventListener('webglcontextlost', () => {
         this.lost++;
         const next = lowerTier(this.tier);
         rememberFallback(next);
         console.warn(`[gfx] WebGL context lost on tier ${this.tier}, next tier ${next}`);
         this.onContextLost?.();
      });
      canvas.addEventListener('webglcontextrestored', () => {
         this.setTier(lowerTier(this.tier));
         if (this.env) this.sky.apply(this.env);   // re-render the reflection cube and the IBL
         console.warn(`[gfx] WebGL context restored, tier ${this.tier}`);
         this.onContextRestored?.();
      });

      this.scene = new THREE.Scene();
      // near 3 m keeps depth precision usable at 20 km (shorelines would z-fight with 0.5);
      // far covers the 60 km ocean disc so the horizon is real geometry, not a clear colour.
      this.camera = new THREE.PerspectiveCamera(58, 1, 3, 62000);

      this._buildLights();
      this.cam = new ChaseCamera(this.camera, this.sun); // orbit/scope rig -- see camera3d.js

      this.sky = new Sky(r);
      this.scene.add(this.sky.mesh);
      this.ocean = new Ocean({ segs: tq.oceanSegs });
      this._oceanSegs = tq.oceanSegs;
      this.scene.add(this.ocean.mesh);
      this.terrain = new Terrain();
      this.scene.add(this.terrain.group);
      this.cam.terrain = this.terrain;   // camera collision samples the real relief
      this.fx =new FX(this.scene, this.ocean, this.terrain);
      this.ships = new ShipModels(this.scene, this.ocean, this.fx);
      this.air = new AirModels(this.scene, this.fx);
      this.missiles = new MissileFX(this.scene, this.fx, this.terrain);
      this.simAlpha = 1;            // interpolation factor between two sim steps (main3d sets it every frame)
      this.focus = null;   // {x, y}: shadow box centre while the camera follows a squadron (main3d)
      this.post = new Post(r, { samples: this._samples(tq), bloomLevels: tq.bloomLevels });
      this.post.setQuality({ bloom: tq.bloom });
      this._wd = { frames: 0, checks: 0, strikes: 0, blank: false, px: new Uint8Array(4) };

      this.hudCanvases = new HudCanvases3D();
      this.time = 0;
      this._cssW = 1; this._cssH = 1;
      this._envKey = '';
      this._applyEnv(resolveEnv(null));

      this.debugView = null;   // test hook: { pos:[x,y,z], look:[x,y,z], fov }
      window.__renderer3d = this;
   }

   setHudCanvases(minimap, compass) {
      this.hudCanvases.setCanvases(minimap, compass);
   }

   resize(w, h) {
      this._cssW = w; this._cssH = h;
      this.renderer.setSize(w, h, false);
      this.post.setSize(w * this.pixelRatio, h * this.pixelRatio);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
   }

   _buildLights() {
      const sun = new THREE.DirectionalLight(0xffffff, 3);
      sun.castShadow = true;
      const maxTex = this.renderer.capabilities.maxTextureSize || 4096;
      const sm = Math.min(maxTex >= 8192 ? 4096 : 2048, this.opts.shadow);
      sun.shadow.mapSize.set(sm, sm);
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.6;
      sun.shadow.camera.near = 50;
      sun.shadow.camera.far = 9000;
      this.scene.add(sun, sun.target);
      this.sun = sun;
      this._shadowHalf = 0;
      // weak fill so shadowed sides never go pitch black before the IBL cube is ready
      this.hemi = new THREE.HemisphereLight(0xbcd8ff, 0x0b2233, 0.25);
      this.scene.add(this.hemi);
   }

   _applyEnv(env) {
      this.env = env;
      this.sky.apply(env);
      this.ocean.applyEnv(env, this.sky.cubeTexture);
      const sc = env.sunColor;
      this.sun.color.setRGB(sc[0], sc[1], sc[2]);
      this.sun.intensity = env.sunIntensity;
      const hz = env.horizon, zn = env.zenith;
      this.hemi.color.setRGB(zn[0] + hz[0], zn[1] + hz[1], zn[2] + hz[2]).multiplyScalar(0.5);
      this.hemi.groundColor.setRGB(0.02, 0.06, 0.08);
      this.hemi.intensity = env.night ? 0.35 : 0.22;
      this.fx.setEnv(env);
      this._envKey = env.key;
   }

   _envFrom(world) {
      const e = world.env;
      const key = e ? `${e.time}|${e.weather}|${e.frontK || 0}|${e.seaState}|${e.visibility}|${e.sunAzimuth}|${e.sunElevation}` : '';
      if (key !== this._rawEnvKey) {
         this._rawEnvKey = key;
         const env = resolveEnv(e);
         if (env.key !== this._envKey) this._applyEnv(env);
      }
   }

   // ================= WORLD =================
   buildWorld(world) {
      this._rawEnvKey = null;
      this._envFrom(world);
      const arena = Number(world.arena) || 4000;
      const res = this.terrain.build(world.obstacles || [], this.env, arena);
      this.ocean.setDepthMap(res.depthTex, res.rect);
      this.ships.clear();
      this.fx.clear();
      this.air.clear();
      this.missiles.clear();
      this.arena = arena;
   }
   buildObstacles(world) { this.buildWorld(world); }

   // ================= MAIN FRAME =================
   render(world, dt, camState) {
      dt = Math.min(Math.max(dt || 0, 0), 0.1);
      this.renderer.info.reset();
      this.time += dt;
      this._envFrom(world);
      this.cam.update(world, dt, camState);
      // optics cut through the haze (as in WoWs): the clearer air scales with magnification
      // (2x: 2x clearer, 4x: 2.5x, 16x: 3.5x), otherwise targets at gun range dissolve into the grey exactly when
      // the player zooms in to find them
      if (this.env?.fogD50) {
         const zk = 0.5 + 0.5 * Math.log2(Math.max(1, this.cam._zoomS || 1));
         ATM.uFogDist.value = this.env.fogD50 / Math.LN2 * (1 + zk * clamp(this.cam.scopeT || 0, 0, 1));
      }
      if (this.debugView) this._applyDebugView();
      this.camera.updateMatrixWorld();
      this.terrain.update(this.camera);
      const flash = this.sky.update(dt, this.time, this.camera);
      if (this.sky.envRT && this.scene.environment !== this.sky.envRT.texture) this.scene.environment = this.sky.envRT.texture;
      this.ocean.update(this.time, this.camera, flash);
      this.ships.sync(world, dt, this.time, this.camera);
      this.ocean.setHulls(this.ships.hulls);
      this._updateShadow(world);
      this.missiles.alpha = this.simAlpha;
      this.missiles.update(world, dt, this.time, this.camera, this.ships);
      this.fx.update(world, dt, this.time, this.camera, this.ships);
      this.air.update(world, dt, this.time);

      const env = this.env;
      this.post.render(this.scene, this.camera, {
         exposure: env.exposure * (1 + flash * 0.8 + this.fx.nightFlash * 0.35),
         bloom: env.night ? 0.2 : 0.12,
         bloomThreshold: env.night ? 1.0 : 1.6,
         saturation: env.frontK > 0 ? 1.08 - Math.max(0, (env.waterGrey ?? 0) - 0.25) * 0.66 : env.weather === 'storm' ? 0.85 : env.weather === 'rain' ? 0.92 : 1.08,
         contrast: 1.05,
         vignette: 0.3,
         time: this.time,
      });
      if (this._wd.checks < 12 && ++this._wd.frames % 40 === 0) this._probeFrame();
      this.hudCanvases.draw(world);
   }

   // ================= QUALITY =================
   // switch tier live: pixel ratio, MSAA, bloom, shadow map (ocean mesh density waits for a reload,
   // model detail for the next battle). Single options the player had set are dropped.
   setTier(name) {
      if (!TIERS[name]) return;
      this.tier = name;
      this.custom = false;
      this._applyOpts(tierOptions(name));
   }

   // single options on top of the current tier ("Benutzerdefiniert"), applied live like a tier
   setOptions(patch) {
      const o = tierOptions(this.tier, { ...this.opts, ...patch });
      if (OPTION_KEYS.every(k => o[k] === this.opts[k])) return;
      this.custom = true;
      this._applyOpts(o);
   }

   // pixel ratio: never above the device's own, nor beyond the largest buffer the GPU takes
   _pixelRatio(o) {
      const side = Math.max(this._cssW || 1, this._cssH || 1, window.innerWidth || 1, window.innerHeight || 1);
      return Math.min(window.devicePixelRatio || 1, o.pr, Math.max(0.5, (this._gpu.maxTex || 4096) / side));
   }

   // MSAA: what the GPU offers; above 4 only while the multisampled HDR target stays affordable
   // (8 samples at 4K are ~0.8 GB with depth)
   _samples(o) {
      let s = Math.min(o.samples, this._gpu.maxSamples || 4);
      const px = (this._cssW > 1 ? this._cssW * this._cssH : window.innerWidth * window.innerHeight) * this.pixelRatio * this.pixelRatio;
      while (s > 4 && px * s > 68e6) s >>= 1;
      return s;
   }

   _applyOpts(o) {
      this.opts = o;
      applyGfx(this.tier, o);
      this.pixelRatio = this._pixelRatio(o);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize(this._cssW, this._cssH);
      this.post.setQuality({ samples: this._samples(o), bloom: o.bloom, bloomLevels: o.bloomLevels });
      const maxTex = this.renderer.capabilities.maxTextureSize || 4096;
      const sm = Math.min(maxTex >= 8192 ? 4096 : 2048, o.shadow);
      const sh = this.sun.shadow;
      if (sh.mapSize.x !== sm) {
         sh.mapSize.set(sm, sm);
         if (sh.map) { sh.map.dispose(); sh.map = null; }
      }
      this._wd.frames = 0; this._wd.checks = 0; this._wd.strikes = 0;
      this.onGfxChange?.();
   }

   // blank-frame watchdog: read a few pixels of the finished frame (same task, so the drawing
   // buffer is still valid); two white readings in a row step the tier down
   _probeFrame() {
      const wd = this._wd, gl = this.renderer.getContext();
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      if (W < 8 || H < 8 || gl.isContextLost()) return;
      wd.checks++;
      const px = new Uint8Array(PROBES.length * 4);
      for (let i = 0; i < PROBES.length; i++) {
         gl.readPixels(Math.floor(PROBES[i][0] * W), Math.floor(PROBES[i][1] * H), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, wd.px);
         px.set(wd.px, i * 4);
      }
      wd.last = Array.from(px);
      if (!frameLooksBlank(px)) { wd.strikes = 0; return; }
      if (++wd.strikes < 2) return;
      if (this.tier !== 'low') {
         const next = lowerTier(this.tier);
         console.warn(`[gfx] white frame on tier ${this.tier}, falling back to ${next}`);
         rememberFallback(next);
         this.setTier(next);
      } else if (!wd.blank) {
         wd.blank = true;
         console.warn('[gfx] frame still white on the lowest tier');
      }
   }

   gfxState() {
      // what is in effect now (clamped to the GPU); options = what was asked for (tier or custom)
      return { tier: this.tier, custom: this.custom, pixelRatio: this.pixelRatio, samples: this.post.sceneRT.samples, bloom: this.post.bloomOn,
         bloomLevels: this.post.levels, shadow: this.sun.shadow.mapSize.x, shadowFit: this.opts.shadowFit,
         oceanSegs: this._oceanSegs, detail: GFX.detail, effects: GFX.effects, options: { ...this.opts }, ...this._gpu,
         contextLost: this.renderer.getContext().isContextLost(), losses: this.lost, probes: this._wd.checks, blankStrikes: this._wd.strikes, stillBlank: this._wd.blank, lastProbe: this._wd.last };
   }

   _applyDebugView() {
      const d = this.debugView;
      if (d.fov && this.camera.fov !== d.fov) { this.camera.fov = d.fov; this.camera.updateProjectionMatrix(); }
      this.camera.position.set(d.pos[0], d.pos[1], d.pos[2]);
      this.camera.lookAt(d.look[0], d.look[1], d.look[2]);
   }

   // Shadow box follows the player (or the camera focus), sized to the orbit distance and
   // snapped to shadow texels in light space so edges don't crawl as the ship moves.
   _updateShadow(world) {
      const p = world.player;
      const cp = this.camera.position;
      let cx, cz;
      if (this.focus) { cx = this.focus.x; cz = this.focus.y; }
      else if (p && p.pos && p.alive !== false) { cx = p.pos.x; cz = p.pos.y; }
      else { this.camera.getWorldDirection(_f); const t = clamp(cp.y / Math.max(0.05, -_f.y), 0, 3000); cx = cp.x + _f.x * t; cz = cp.z + _f.z * t; }
      const camD = Math.hypot(cp.x - cx, cp.y, cp.z - cz);
      let half = clamp(camD * 1.15 + 220, 380, 1800);
      if (this.debugView) half = clamp(camD * 0.9 + 300, 380, 2400);
      half *= this.opts.shadowFit;   // ultra: a tighter box, so the same map gives sharper shadows
      const sh = this.sun.shadow;
      if (Math.abs(half - this._shadowHalf) > this._shadowHalf * 0.08) {
         this._shadowHalf = half;
         const c = sh.camera;
         c.left = -half; c.right = half; c.top = half; c.bottom = -half;
         c.updateProjectionMatrix();
      }
      half = this._shadowHalf;
      const L = this.env.lightDir;
      _f.copy(L).negate();
      _r.set(0, 1, 0).cross(_f).normalize();
      _u.crossVectors(_f, _r);
      const texel = (half * 2) / sh.mapSize.x;
      _v.set(cx, 0, cz);
      const a = Math.round(_v.dot(_r) / texel) * texel, b = Math.round(_v.dot(_u) / texel) * texel, c = _v.dot(_f);
      _v.copy(_r).multiplyScalar(a).addScaledVector(_u, b).addScaledVector(_f, c);
      this.sun.target.position.copy(_v);
      this.sun.position.copy(_v).addScaledVector(L, 4500);
      this.sun.target.updateMatrixWorld();
      this.sun.updateMatrixWorld();
   }

   // ================= HUD helpers =================
   // World point -> CSS pixels for floating HUD markers (names/HP bars over ships).
   project(x, h, y, out = {}) {
      _v.set(x, h, y).applyMatrix4(this.camera.matrixWorldInverse);
      const inFront = _v.z < -this.camera.near;
      _v.applyMatrix4(this.camera.projectionMatrix);
      out.x = (_v.x * 0.5 + 0.5) * this._cssW;
      out.y = (0.5 - _v.y * 0.5) * this._cssH;
      out.visible = inFront && _v.x > -1.1 && _v.x < 1.1 && _v.y > -1.1 && _v.y < 1.1;
      return out;
   }

   // Full teardown (page-level restarts may create a fresh renderer on the same canvas).
   dispose() {
      this.fx.dispose(); this.ships.dispose(); this.terrain.dispose();
      this.ocean.dispose(); this.sky.dispose(); this.post.dispose();
      this.scene.environment = null;
      this.renderer.dispose();
      if (window.__renderer3d === this) window.__renderer3d = null;
   }

   // ================= CAMERA (delegated to camera3d.js) =================
   setCameraPose(yaw, pitch, dist) { this.cam.setCameraPose(yaw, pitch, dist); }
   screenToWorld(nx, ny) { return this.cam.screenToWorld(nx, ny); }
   get scopeT() { return this.cam.scopeT; }
}
