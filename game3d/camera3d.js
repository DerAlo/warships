// game3d/camera3d.js — WoWs-style camera rig: third-person orbit + binocular view.
//
// The controller (main3d.js) owns the aim: a world BEARING (camState.yaw) and an aim RANGE
// (camState.range). The aim point is simply A = ship + range * (cos yaw, sin yaw) on the sea.
// This rig only has to put the camera somewhere sensible and look EXACTLY at A, so the fixed
// screen-centre crosshair is always on the aim point by construction (no raycast round trip,
// no drift between what you see and where the guns point).
//
// Renderer3D constructs it as `new ChaseCamera(camera, sun)` and calls update(world, dt,
// camState) inside render(); main3d reads `pose`, `scopeT`, `project()` afterwards.
import * as THREE from '../vendor/three/three.module.min.js';

export const BASE_FOV = 55;            // vertical FOV of the third-person view (deg)
const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;
const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
const smooth = (t) => t * t * (3 - 2 * t);

// Vertical FOV (deg) for a binocular magnification.
export function fovForZoom(zoom) {
   return 2 * Math.atan(Math.tan(BASE_FOV * DEG / 2) / Math.max(1, zoom)) / DEG;
}

// Ship length/deck height with graceful fallbacks (contract: cfg.hull.L / deckH).
function hullDims(ship) {
   const h = ship?.cfg?.hull;
   const L = h?.L || ship?.cfg?.L || ship?.L || ({ DD: 120, LC: 170, HC: 205, EB: 251, Bismarck: 251 }[ship?.cls]) || 200;
   const deckH = h?.deckH || Math.max(8, L * 0.075);
   return { L, deckH };
}

export class ChaseCamera {
   constructor(camera, sun) {
      this.camera = camera;
      this.sun = sun || null;
      this.scopeT = 0;           // 0 = third person, 1 = binoculars (smoothed blend)
      this._zoomS = 1;           // smoothed magnification
      this._shakeMag = 0;
      this._ray = new THREE.Raycaster();
      this._v = new THREE.Vector3();
      this._specT = 0;
      // Legacy pose (setCameraPose) -- only used if no camState is supplied.
      this._legacy = { yaw: 0, pitch: 0.42, dist: 420 };
      // Resolved pose of the last update: main3d uses it for the target-snap ray.
      this.pose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: BASE_FOV, yaw: 0, hfov: 90 * DEG };
   }

   setCameraPose(yaw, pitch, dist) { this._legacy = { yaw, pitch, dist }; }

   update(world, dt, camState) {
      const cam = this.camera;
      dt = Math.min(0.1, Math.max(0, dt || 0));
      this._shakeMag = Math.max(this._shakeMag * Math.exp(-dt / 0.15), world?._shake || 0);
      const p = world?.player;
      const cs = camState && typeof camState.range === 'number' ? camState : null;

      if (!p || !cs || (!p.alive && !p.sinking && !cs.spectate)) { this._spectator(world, dt, cs); return; }

      // ---- binocular blend + zoom smoothing (log space: 2x->16x feels even) ----
      this.scopeT = clamp01(this.scopeT + (cs.bino ? 1 : -1) * dt / 0.16);
      const s = smooth(this.scopeT);
      const zTarget = cs.bino ? (cs.zoom || 4) : 1;
      this._zoomS = Math.exp(lerp(Math.log(this._zoomS), Math.log(zTarget), 1 - Math.exp(-dt / 0.09)));
      const fov = fovForZoom(lerp(1, this._zoomS, s));
      if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }

      const { L, deckH } = hullDims(p);
      const yaw = cs.yaw, R = Math.max(50, cs.range);
      const cx = Math.cos(yaw), cz = Math.sin(yaw);
      const px = p.pos.x, pz = p.pos.y;
      const Ax = px + cx * R, Az = pz + cz * R;

      // ---- third-person: orbit behind the ship on the aim bearing. Elevation falls as the
      // aim range grows (steep at 1 km, shallow near max range) so the own ship always sits
      // in the lower part of the screen and the horizon is visible for long shots.
      const rMin = cs.rangeMin || 1000, rMax = cs.rangeMax || 20000;
      const tR = clamp01(Math.log(R / rMin) / Math.log(Math.max(1.5, rMax / rMin)));
      const elev = lerp(20, 8.5, tR) * DEG;
      const D = Math.max(cs.dist || L * 2, L * 0.6 + 40);
      const pivotH = deckH * 1.4 + 6;
      const tpX = px - cx * Math.cos(elev) * D, tpZ = pz - cz * Math.cos(elev) * D;
      const tpY = pivotH + Math.sin(elev) * D;

      // ---- binoculars: in front of the bow on the aim bearing (the own hull stays behind
      // the lens, WoWs hides it too) and raised with range so the sea at the aim point is
      // seen at >= ~1 deg depression -- splashes stay readable in depth at 15+ km.
      const fwd = L * 0.5 + 25;
      const biY = Math.max(deckH * 2.6 + 12, (R - fwd) * Math.tan(1.0 * DEG));
      const biX = px + cx * fwd, biZ = pz + cz * fwd;

      let camX = lerp(tpX, biX, s), camY = lerp(tpY, biY, s), camZ = lerp(tpZ, biZ, s);

      // ---- collision: stay above the swell and above any island the camera drifts over.
      camY = Math.max(camY, 12);
      for (const o of world.obstacles || []) {
         if (o.kind !== 'island') continue;
         const d = Math.hypot(camX - o.c.x, camZ - o.c.y);
         const r = (o.r || 0) * 1.25 + 40;
         if (d < r) {
            const top = (o.height ?? Math.max(40, (o.r || 0) * 0.12)) + 30;
            camY = Math.max(camY, lerp(top, 12, clamp01((d - o.r) / (r - o.r))));
         }
      }

      // Shake as a small ANGULAR wobble scaled by FOV: the recoil reads the same in both views
      // instead of becoming a 10-metre earthquake at 16x.
      const fovK = Math.tan(fov * DEG / 2) / Math.tan(BASE_FOV * DEG / 2);
      const sh = Math.min(14, this._shakeMag) * 0.0007 * fovK * R;
      const jx = (Math.random() - 0.5) * sh, jz = (Math.random() - 0.5) * sh, jy = (Math.random() - 0.5) * sh * 0.5;

      cam.position.set(camX, camY, camZ);
      const hA = cs.aimH || 0;
      cam.lookAt(Ax + jx, hA + jy, Az + jz);
      cam.updateMatrixWorld();

      // Long aim ranges need a far plane that reaches them (never shrink what the renderer set).
      const needFar = Math.max(8000, R * 1.6 + D, (world.arena || 0) * 3);
      if (cam.far < needFar) { cam.far = needFar; cam.updateProjectionMatrix(); }

      this._storePose(camX, camY, camZ, Ax, hA, Az, fov, yaw);
      if (this.sun?.target) { this.sun.target.position.set(px, 0, pz); this.sun.target.updateMatrixWorld(); }
   }

   // No live player (menu background / sunk): slow cinematic orbit.
   _spectator(world, dt, cs) {
      const cam = this.camera;
      this.scopeT = Math.max(0, this.scopeT - dt / 0.16);
      this._specT += dt;
      const p = world?.player;
      const c = p ? p.pos : { x: 0, y: 0 };
      const R = p ? 900 : 1600;
      const a = this._specT * 0.05 + (cs?.yaw || 0);
      const x = c.x - Math.cos(a) * R, z = c.y - Math.sin(a) * R, y = p ? 380 : 420;
      if (Math.abs(cam.fov - BASE_FOV) > 1e-3) { cam.fov = BASE_FOV; cam.updateProjectionMatrix(); }
      cam.position.set(x, y, z);
      cam.lookAt(c.x, 0, c.y);
      cam.updateMatrixWorld();
      this._storePose(x, y, z, c.x, 0, c.y, BASE_FOV, a);
      if (this.sun?.target) { this.sun.target.position.set(c.x, 0, c.y); this.sun.target.updateMatrixWorld(); }
   }

   _storePose(x, y, z, tx, ty, tz, fov, yaw) {
      this.pose.pos.set(x, y, z);
      this.pose.target.set(tx, ty, tz);
      this.pose.fov = fov;
      this.pose.yaw = yaw;
      const aspect = this.camera.aspect || 16 / 9;
      this.pose.hfov = 2 * Math.atan(Math.tan(fov * DEG / 2) * aspect);
   }

   // Screen point (nx, ny in [-1,1]) -> world point on the sea plane, or null above the horizon.
   screenToWorld(nx, ny) {
      this._ray.setFromCamera({ x: nx, y: ny }, this.camera);
      const o = this._ray.ray.origin, d = this._ray.ray.direction;
      if (d.y > -1e-6) return null;
      const t = -o.y / d.y;
      return { x: o.x + d.x * t, y: o.z + d.z * t };
   }

   // World (sim x, height, sim y) -> CSS pixels on the canvas. Fallback for renderer.project().
   project(x, h, y, w, hgt) {
      const v = this._v.set(x, h, y);
      // Behind-camera test in view space (projected z flips sign ambiguously behind the lens).
      const e = this.camera.matrixWorldInverse.elements;
      const vz = e[2] * x + e[6] * h + e[10] * y + e[14];
      v.project(this.camera);
      const W = w || this.camera.userData?.cssW || window.innerWidth;
      const H = hgt || this.camera.userData?.cssH || window.innerHeight;
      return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, visible: vz < 0 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2 };
   }
}
