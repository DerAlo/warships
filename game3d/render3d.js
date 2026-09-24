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

const _v = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();

export class Renderer3D {
   constructor(canvas) {
      this.canvas = canvas;
      const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
      this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      r.setPixelRatio(this.pixelRatio);
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      r.info.autoReset = false;

      this.scene = new THREE.Scene();
      // near 3 m keeps depth precision usable at 20 km (shorelines would z-fight with 0.5);
      // far covers the 60 km ocean disc so the horizon is real geometry, not a clear colour.
      this.camera = new THREE.PerspectiveCamera(58, 1, 3, 62000);

      this._buildLights();
      this.cam = new ChaseCamera(this.camera, this.sun); // orbit/scope rig -- see camera3d.js

      this.sky = new Sky(r);
      this.scene.add(this.sky.mesh);
      this.ocean = new Ocean({ segs: 256 });
      this.scene.add(this.ocean.mesh);
      this.terrain = new Terrain();
      this.scene.add(this.terrain.group);
      this.fx = new FX(this.scene, this.ocean, this.terrain);
      this.ships = new ShipModels(this.scene, this.ocean, this.fx);
      this.post = new Post(r, { samples: 4, bloomLevels: 5 });

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
      const sm = maxTex >= 8192 ? 4096 : 2048;
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
      const key = e ? `${e.time}|${e.weather}|${e.seaState}|${e.visibility}|${e.sunAzimuth}|${e.sunElevation}` : '';
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
      // optics cut through the haze (as in WoWs): at full binocular zoom the air is ~2.5x clearer,
      // otherwise targets at gun range dissolve into the grey exactly when the player looks for them
      if (this.env?.fogD50) ATM.uFogDist.value = this.env.fogD50 / Math.LN2 * (1 + 1.5 * clamp(this.cam.scopeT || 0, 0, 1));
      if (this.debugView) this._applyDebugView();
      this.camera.updateMatrixWorld();
      this.terrain.update(this.camera);
      const flash = this.sky.update(dt, this.time, this.camera);
      if (this.sky.envRT && this.scene.environment !== this.sky.envRT.texture) this.scene.environment = this.sky.envRT.texture;
      this.ocean.update(this.time, this.camera, flash);
      this.ships.sync(world, dt, this.time, this.camera);
      this.ocean.setHulls(this.ships.hulls);
      this._updateShadow(world);
      this.fx.update(world, dt, this.time, this.camera, this.ships);

      const env = this.env;
      this.post.render(this.scene, this.camera, {
         exposure: env.exposure * (1 + flash * 0.8),
         bloom: env.night ? 0.2 : 0.12,
         bloomThreshold: env.night ? 1.0 : 1.6,
         saturation: env.weather === 'storm' ? 0.85 : env.weather === 'rain' ? 0.92 : 1.08,
         contrast: 1.05,
         vignette: 0.3,
         time: this.time,
      });
      this.hudCanvases.draw(world);
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
      if (p && p.pos && p.alive !== false) { cx = p.pos.x; cz = p.pos.y; }
      else { this.camera.getWorldDirection(_f); const t = clamp(cp.y / Math.max(0.05, -_f.y), 0, 3000); cx = cp.x + _f.x * t; cz = cp.z + _f.z * t; }
      const camD = Math.hypot(cp.x - cx, cp.y, cp.z - cz);
      let half = clamp(camD * 1.15 + 220, 380, 1800);
      if (this.debugView) half = clamp(camD * 0.9 + 300, 380, 2400);
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
