// game/camera.js — 2.5D camera: follow target with look-ahead, smooth zoom, optional rotation.
// North-up by default (compass fixed) — the most readable orientation for naval duels.
import { clamp, lerp, lerpAngle, approach, fromAngle } from './utils.js';

export class Camera {
   constructor() {
      this.x = 0; this.y = 0;        // world focus (center of view)
      this.zoom = 0.42;             // pixels per meter
      this.targetZoom = 0.42;
      this.minZoom = 0.12;
      this.maxZoom = 0.9;
      this.rot = 0;                 // screen rotation (0 = north up)
      this.targetRot = 0;
      this.lookAhead = 260;           // world-distance the camera leans toward heading
      this.shake = { x: 0, y: 0 };  // added by render shake
      this.w = 0; this.h = 0;
      this.follow = true;
      this.headingUp = false;       // if true, rotate so player heading points up
   }

    resize(w, h) { this.w = w; this.h = h; }

   setFollow(obj, opt = {}) {
      this.follow = true;
      this.lookAhead = opt.lookAhead ?? 0;
      this.headingUp = opt.headingUp ?? false;
      this.targetZoom = opt.zoom ?? this.targetZoom;
      if (obj) { this.x = obj.pos.x; this.y = obj.pos.y; }
   }

   update(dt, target) {
      if (this.follow && target) {
         // look ahead a fixed distance along the heading so the ship sits off-center
         // and you can see where it's going (not velocity*time — that overshoots wildly)
         const la = this.lookAhead;
         const c = Math.cos(target.heading), s = Math.sin(target.heading);
         const tx = target.pos.x + c * la;
         const ty = target.pos.y + s * la;
         // smooth follow (exp smoothing)
         const k = 1 - Math.exp(-dt / 0.28);
         this.x = lerp(this.x, tx, k);
         this.y = lerp(this.y, ty, k);
      }
      this.zoom = lerp(this.zoom, this.targetZoom, 1 - Math.exp(-dt / 0.25));
      if (this.headingUp && target) {
         this.targetRot = -target.heading - Math.PI / 2; // heading points up on screen
         this.rot = lerpAngle(this.rot, this.targetRot, 1 - Math.exp(-dt / 0.35));
      } else {
         this.rot = lerpAngle(this.rot, 0, 1 - Math.exp(-dt / 0.35));
      }
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
      // cheap: transform and check bounds
      const s = this.w2s(p);
      return s.x > -margin && s.x < this.w + margin && s.y > -margin && s.y < this.h + margin;
    }

    addShake(m) { this.shake.x += (Math.random() - 0.5) * m; this.shake.y += (Math.random() - 0.5) * m; }
    decayShake(dt) { this.shake.x *= Math.exp(-dt / 0.12); this.shake.y *= Math.exp(-dt / 0.12); }
}
