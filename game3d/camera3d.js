// game3d/camera3d.js — chase/orbit camera rig + sniper-scope blend + screen->sea raycast.
// Extracted from render3d.js so camera/aiming work can evolve independently of scene graphics.
// Renderer3D owns one ChaseCamera (renderer.cam) and delegates setCameraPose/screenToWorld/scopeT.
import * as THREE from '../vendor/three/three.module.min.js';

// ---- sniper scope (WoWs-style rangefinder view) ----
// Scrolling the wheel all the way in (main3d.js clamps zoom/orbit-distance to [ZOOM_MIN,
// ZOOM_MAX]) blends smoothly into a fixed bridge-anchored view with a narrow FOV, instead of
// just dollying the chase cam closer to the hull (which at low `dist` looked straight into
// your own ship's geometry -- not remotely a rangefinder view). Below SCOPE_ENTER_DIST the
// EFFECTIVE orbit distance and FOV both blend toward the scoped values as zoom keeps
// decreasing to ZOOM_MIN, so there's no mode switch/state machine, just a continuous blend.
const SCOPE_ENTER_DIST = 260, SCOPE_FULL_DIST = 140; // matches main3d.js's ZOOM_MIN
// SCOPE_CAM_DIST used to be 22 -- well INSIDE the Bismarck's own superstructure footprint
// (the bridge/funnel/deckhouse blocks span roughly [-32, +12] metres along the hull's long
// axis, centred on the ship). Looking fore or aft while scoped put the camera physically
// inside that geometry, filling the whole screen with the ship's own hull colour -- exactly
// the "sieht man nur seine eigenen Schornsteine" complaint. 85m clears the funnel/bridge/
// superstructure horizontally from any yaw, so the scope now always looks OUT past the ship
// instead of through it. SCOPE_LOOK_Y raised from 34 to 46 (just above the highest
// superstructure point, the bridge top) for the same reason -- the old height sat inside the
// bridge block vertically too.
const SCOPE_CAM_DIST = 85;   // effective orbit distance once fully scoped -- clears the ship's own superstructure
const SCOPE_LOOK_Y = 46;     // look-target height when scoped -- above the bridge roofline
const BASE_FOV = 58, SCOPE_FOV = 9;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;

export class ChaseCamera {
   constructor(camera, sun) {
      this.camera = camera;
      this.sun = sun;
      this.camYaw = 0;      // world-space camera bearing (free-look, set by main3d) -- NOT tied to ship heading
      this.camPitch = 0.42; // radians above horizon
      this.camDist = 420;   // camera distance from the ship (wheel zoom, set by main3d)
      this.scopeT = 0;
      this._ray = new THREE.Raycaster();
      this._shakeMag = 0;
   }

   // Set by main3d.js each frame with the resolved chase-camera pose (base over-the-shoulder
   // pose + free-look offsets + wheel zoom). Stored here so _syncCamera can consume it and so
   // screenToWorld() raycasts against the exact camera the player is looking through.
   setCameraPose(yaw, pitch, dist) {
      this.camYaw = yaw;
      this.camPitch = pitch;
      this.camDist = dist;
   }

   // Third-person orbit camera: follows the player ship's POSITION at a fixed offset
   // (camYaw/camPitch/camDist set via setCameraPose), always looking at the ship. The
   // orientation is a WORLD-SPACE pose owned entirely by the player (right-mouse drag in
   // main3d.js) -- it deliberately does NOT track the ship's heading, so steering with
   // A/D moves the ship under a stable view instead of spinning the whole screen.
   update(world, dt, camState) {
      const p = world.player;
      // world._shake is set by combat.js on hits/explosions (same convention the 2D
      // renderer's camera consumes) -- pick it up directly instead of a separate API.
      this._shakeMag = Math.max(this._shakeMag * Math.exp(-dt / 0.15), world._shake || 0);
      if (!p || !p.alive) {
         this.camera.position.set(0, 900, 1400);
         this.camera.lookAt(0, 0, 0);
         return;
      }
      const dist = this.camDist || 420;
      // Sniper scope: a continuous blend, not a mode switch. Scrolling in past
      // SCOPE_ENTER_DIST (260m) ramps scopeT from 0->1 as dist keeps shrinking to
      // SCOPE_FULL_DIST (140m, = main3d.js's ZOOM_MIN) -- both the effective orbit distance
      // and the FOV blend toward their scoped values over that same range, so it reads as
      // "leaning into the rangefinder" rather than a jarring cut.
      this.scopeT = clamp01((SCOPE_ENTER_DIST - dist) / (SCOPE_ENTER_DIST - SCOPE_FULL_DIST));
      const effDist = lerp(dist, SCOPE_CAM_DIST, this.scopeT);
      const fov = lerp(BASE_FOV, SCOPE_FOV, this.scopeT);
      if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
      // PURE ORBIT for POSITION: the camera sits on a sphere of radius `effDist` around a
      // look-target a few metres above the deck, so pitch alone sets how high the camera
      // rises as you look down (steeper pitch = higher camera, like leaning back to look
      // down at your own ship). World-space bearing -- deliberately NOT derived from
      // p.heading, so rudder input never rotates the view. The ship turns under a stable
      // camera instead.
      const yaw = this.camYaw;
      const pitch = this.camPitch;
      const tx = p.pos.x, tz = p.pos.y;
      const ty = lerp(20, SCOPE_LOOK_Y, this.scopeT); // orbit-centre height rises toward bridge level when scoped
      const cx = tx - Math.cos(yaw) * Math.cos(pitch) * effDist;
      const cz = tz - Math.sin(yaw) * Math.cos(pitch) * effDist;
      const cy = ty + Math.sin(pitch) * effDist;
      // Recoil shake reads as camera SWAY in the chase view, but a scope is bolted to the
      // ship's optics -- full sway there would be nauseating at a 9deg FOV. Dampen it instead
      // of zeroing it: the player should still feel the guns firing, just less violently.
      const shakeMag = this._shakeMag * lerp(1, 0.3, this.scopeT);
      const shakeX = (Math.random() - 0.5) * shakeMag, shakeY = (Math.random() - 0.5) * shakeMag;
      // Clamp just above the waterline (sea is at y=0) so a below-horizon pitch can't dip
      // the camera under the waves.
      const camX = cx + shakeX, camY = Math.max(8, cy), camZ = cz + shakeY;
      this.camera.position.set(camX, camY, camZ);
      // ORIENTATION: aim at a point whose DISTANCE is an explicitly designed function of
      // pitch, not derived from the orbit-position geometry above. The previous code did
      // `camera.lookAt(tx, ty, tz)` -- always the fixed point 20m above the ship -- which
      // made the screen-centre aim raycast land at EXACTLY ty/tan(pitch) from the ship no
      // matter how far the camera was zoomed (the zoom term cancels out of that ratio
      // entirely -- verified numerically: aim distance was ~36m at every zoom level tested
      // from 140 to 1500 at the default pitch). That squeezed the whole 200-1800m useful
      // firing range into roughly 6 degrees of pitch out of ~130 degrees of slider travel,
      // which is why long shots felt "impossible" even once the camera itself could go flat.
      // A first attempt pointed the camera along the raw orbit yaw/pitch direction instead of
      // at the fixed point -- but that direction is BY CONSTRUCTION the reverse of the vector
      // from camera to the same fixed orbit target, so it produced the identical curve.
      // Instead, design the mapping directly: pitch linearly controls aim distance across the
      // pitch slider's full travel (PITCH_MIN/MAX mirror main3d.js's pitchOff clamp of
      // [-0.55, 0.75] plus CAM_BASE_PITCH 0.5), flattest pitch -> AIM_DIST_MAX, steepest pitch
      // -> AIM_DIST_MIN, and aim the camera at that exact point on the sea. This deliberately
      // avoids trig blow-up (no tan() anywhere) so every part of the slider is usable, and it
      // guarantees the visual crosshair always lands exactly where the sim's aim point is,
      // since both are the same computed point.
      const AIM_DIST_MIN = 150, AIM_DIST_MAX = 2000;
      const PITCH_MIN = -0.05, PITCH_MAX = 1.25; // CAM_BASE_PITCH(0.5) + pitchOff range [-0.55,0.75]
      const aimT = clamp01((PITCH_MAX - pitch) / (PITCH_MAX - PITCH_MIN));
      const aimDist = lerp(AIM_DIST_MIN, AIM_DIST_MAX, aimT);
      const aimX = tx + Math.cos(yaw) * aimDist, aimZ = tz + Math.sin(yaw) * aimDist;
      this.camera.lookAt(aimX, 0, aimZ);
      this.sun.target.position.set(p.pos.x, 0, p.pos.y);
      this.sun.target.updateMatrixWorld();
   }

   // raycast helper for input3d.js: screen (nx,ny in [-1,1]) -> world point on sea plane
   screenToWorld(nx, ny) {
      // Reuse the instance Raycaster (set up in the constructor) -- no per-call allocation.
      this._ray.setFromCamera({ x: nx, y: ny }, this.camera);
      const planeY = 0;
      const dirY = this._ray.ray.direction.y;
      if (Math.abs(dirY) < 1e-6) return null;
      const t = (planeY - this._ray.ray.origin.y) / dirY;
      if (t < 0) return null;
      const p = this._ray.ray.origin.clone().addScaledVector(this._ray.ray.direction, t);
      return { x: p.x, y: p.z };
   }

}
