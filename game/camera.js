// game/camera.js — top-down camera with ONE fixed zoom (no map zoom: sized so the main battery's
// range fits on screen) plus a lean toward the cursor, so aiming far out pulls the view along.
// North-up (compass fixed) — the most readable orientation for naval duels.
import { clamp, lerp, lerpAngle } from './utils.js';
import { TUNE } from './config.js';

export class Camera {
   constructor() {
      this.x = 0; this.y = 0;        // world focus (center of view)
      this.zoom = 0.45;              // pixels per meter — set from the viewport in resize()
      this.rot = 0;                  // screen rotation (0 = north up)
      this.shake = { x: 0, y: 0 };
      this.w = 0; this.h = 0;
      this.follow = true;
      this.lean = { x: 0, y: 0 };    // world-space offset toward the cursor
   }

   // Fixed scale: the shorter screen half spans TUNE.camView metres, so with the cursor lean the
   // player can see (and aim at) targets out to full main-battery range in any direction.
   resize(w, h) {
      this.w = w; this.h = h;
      this.zoom = clamp(Math.min(w, h) / 2 / TUNE.camView, 0.28, 0.7);
   }

   setFollow(obj) {
      this.follow = true;
      this.lean.x = 0; this.lean.y = 0;
      if (obj) { this.x = obj.pos.x; this.y = obj.pos.y; }
   }

   // mouse: cursor in CSS px (optional). Lean is computed from the cursor's SCREEN offset, not its
   // world point, so moving the camera never feeds back into where it wants to go.
   update(dt, target, mouse = null) {
      if (!(this.follow && target)) return;
      let lx = 0, ly = 0;
      if (mouse && this.w) {
         lx = (mouse.x - this.w / 2) / this.zoom * TUNE.camLookMouse;
         ly = (mouse.y - this.h / 2) / this.zoom * TUNE.camLookMouse;
         const m = Math.hypot(lx, ly);
         if (m > TUNE.camLookMax) { lx *= TUNE.camLookMax / m; ly *= TUNE.camLookMax / m; }
      }
      const kl = 1 - Math.exp(-dt / 0.45);
      this.lean.x = lerp(this.lean.x, lx, kl);
      this.lean.y = lerp(this.lean.y, ly, kl);
      // a small bias along the heading so you see where the ship is going
      const tx = target.pos.x + Math.cos(target.heading) * TUNE.camLookHeading + this.lean.x;
      const ty = target.pos.y + Math.sin(target.heading) * TUNE.camLookHeading + this.lean.y;
      const k = 1 - Math.exp(-dt / 0.28);
      this.x = lerp(this.x, tx, k);
      this.y = lerp(this.y, ty, k);
      this.rot = lerpAngle(this.rot, 0, 1 - Math.exp(-dt / 0.35));
   }

   // world -> screen
   w2s(p) {
      let dx = p.x - this.x;
      let dy = p.y - this.y;
      if (this.rot) {
         const c = Math.cos(this.rot), s = Math.sin(this.rot);
         const rx = dx * c - dy * s;
         const ry = dx * s + dy * c;
         dx = rx; dy = ry;
      }
      return { x: this.w / 2 + dx * this.zoom + this.shake.x, y: this.h / 2 + dy * this.zoom + this.shake.y };
   }

   // screen -> world
   s2w(sx, sy) {
      let dx = sx - this.w / 2 - this.shake.x;
      let dy = sy - this.h / 2 - this.shake.y;
      if (this.rot) {
         const c = Math.cos(-this.rot), s = Math.sin(-this.rot);
         const rx = dx * c - dy * s;
         const ry = dx * s + dy * c;
         dx = rx; dy = ry;
      }
      return { x: this.x + dx / this.zoom, y: this.y + dy / this.zoom };
   }

   // is world point within the visible rectangle (with margin)?
   visible(p, margin = 0) {
      const s = this.w2s(p);
      return s.x > -margin && s.x < this.w + margin && s.y > -margin && s.y < this.h + margin;
   }

   addShake(m) { this.shake.x += (Math.random() - 0.5) * m; this.shake.y += (Math.random() - 0.5) * m; }
   decayShake(dt) { this.shake.x *= Math.exp(-dt / 0.12); this.shake.y *= Math.exp(-dt / 0.12); }
}
