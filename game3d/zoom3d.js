// game3d/zoom3d.js — World-of-Warships mouse-wheel zoom: the third-person camera distance and
// the binocular magnifications form ONE ladder. Pure state (no DOM / THREE): main3d.js feeds wheel
// notches, Shift toggles and dt, then copies dist / bino / zoom into the camera state.
//
// Ladder: tp 0..TP_STEPS = third person (0 widest, TP_STEPS closest), then MAGS in the scope.
// Third person glides continuously (touchpads move the camera smoothly); scope entry/exit and the
// magnification steps are discrete: a step needs DETENT notches of scroll, and what is left after
// a step never points back, so a touchpad hovering at the boundary cannot flicker in and out.
// The aim (bearing + range) is not touched here at all: zooming never moves the gun solution.

export const MAGS = [2, 4, 8, 16];
export const TP_STEPS = 5;               // 6 third-person distances
export const LADDER_LEN = TP_STEPS + 1 + MAGS.length;
const DETENT = 0.6;                      // notches to cross a discrete step (a wheel click = 1)
const ACC_IDLE = 0.5;                    // s without scroll: a half-finished touchpad push is dropped
const SPRING_W = 26;                     // 1/s, critically damped distance ease: settles in ~0.3 s
const SHIFT_MAG0 = 1;                    // Shift opens at 4x until the player uses another power

const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;

// Third-person arm range (m) for a hull length: close enough to see the deck, far enough for
// the whole formation.
export function distRange(L) { return { min: Math.max(150, L * 0.9), max: Math.max(600, L * 5) }; }

export class ZoomLadder {
   constructor(L = 200) { this.reset(L); }

   // New match: default third-person distance (the ladder step nearest two hull lengths), no scope.
   reset(L = 200) {
      const r = distRange(L);
      this.dMin = r.min; this.dMax = r.max;
      this.tp = Math.round(clamp(this._levelOf(Math.max(150, L * 2)), 0, TP_STEPS));
      this.bino = false;
      this.magIdx = SHIFT_MAG0;           // current power in the scope, last used one outside
      this.acc = 0;                       // pending discrete-zone scroll (+ = in)
      this.idle = 0;
      this.dist = this.distAt(this.tp);   // eased third-person distance
      this.vel = 0;                       // d ln(dist) / dt
      this.sinceChange = 1e9;             // s since the last ladder change (HUD cue)
   }

   distAt(level) { return this.dMax * Math.pow(this.dMin / this.dMax, level / TP_STEPS); }
   _levelOf(d) { return Math.log(this.dMax / d) / Math.log(this.dMax / this.dMin) * TP_STEPS; }
   get distTarget() { return this.distAt(this.tp); }
   get zoom() { return MAGS[this.magIdx]; }
   // Unified ladder position: 0..TP_STEPS third person, TP_STEPS+1.. scope (2x, 4x, 8x, 16x).
   get level() { return this.bino ? TP_STEPS + 1 + this.magIdx : this.tp; }

   // n = wheel notches as Input3D reports them (+ = toward the user = zoom OUT, fractional for
   // touchpads). Returns true when the scope was entered or left (main3d plays a click).
   wheel(n) {
      if (!n) return false;
      this.idle = 0;
      const lv0 = this.level, bino0 = this.bino;
      let d = -n;                          // + = in
      if (!this.bino) {
         if (d > 0) {
            const m = Math.min(TP_STEPS - this.tp, d);
            this.tp += m; d -= m;
            this.acc += d;                 // pressing on past the closest distance
         } else {
            const back = Math.min(this.acc, -d); // retract a pending scope entry first
            this.acc -= back; d += back;
            this.tp = Math.max(0, this.tp + d);  // past the widest view: dropped
         }
      } else this.acc += d;
      // discrete zone: each step eats one notch; the rest keeps its sign, is clamped at the ends
      while (Math.abs(this.acc) >= DETENT) {
         const dir = this.acc > 0 ? 1 : -1;
         const rest = Math.max(0, dir * this.acc - 1);
         if (!this.bino) {                 // (acc < 0 cannot occur in third person)
            this.bino = true; this.magIdx = 0;
         } else if (dir > 0) {
            if (this.magIdx >= MAGS.length - 1) { this.acc = 0; break; }
            this.magIdx++;
         } else if (this.magIdx > 0) this.magIdx--;
         else {                            // out of the scope: back to the closest view, then glide
            this.bino = false;
            this.tp = Math.max(0, TP_STEPS - rest);
            this.acc = 0;
            break;
         }
         this.acc = dir * rest;
      }
      if (this.level !== lv0) this.sinceChange = 0;
      return this.bino !== bino0;
   }

   // Shift: straight into the scope at the last power / back to the last third-person distance.
   toggle() {
      this.bino = !this.bino;
      this.acc = 0;
      this.sinceChange = 0;
      return this.bino;
   }

   // Eases the distance (critically damped in log space: no overshoot, re-targets smoothly).
   update(dt) {
      dt = clamp(dt || 0, 0, 0.1);
      this.sinceChange += dt;
      this.idle += dt;
      if (this.idle > ACC_IDLE) this.acc = 0;
      const e = Math.log(this.dist / this.distTarget);
      if (Math.abs(e) < 2e-4 && Math.abs(this.vel) < 2e-3) { this.dist = this.distTarget; this.vel = 0; return; }
      const w = SPRING_W, k = Math.exp(-w * dt), tmp = (this.vel + w * e) * dt;
      this.vel = (this.vel - w * tmp) * k;
      this.dist = this.distTarget * Math.exp((e + tmp) * k);
   }
}
