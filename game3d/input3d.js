// game/input3d.js — keyboard identical to the 2D game (game/input.js), but the mouse now
// works like World of Warships instead of a drag-to-orbit scheme:
//
//   • The mouse ALWAYS steers the camera/turrets, no button held -- exactly like WoWs: the
//     reticle sits fixed at screen centre, moving the mouse turns the view (and the guns
//     track wherever the reticle points), and the ship keeps sailing under that view. We
//     accumulate raw `movementX/Y` deltas every frame (works with or without Pointer Lock)
//     instead of tracking absolute cursor position, so the look never runs out of screen.
//   • Pointer Lock is requested on the first click so the OS cursor disappears and the deltas
//     stay unbounded (no clamping at the screen edge). It's opportunistic: browsers reject it
//     without a preceding user gesture, and headless test runners don't grant it at all --
//     both are silently ignored (movementX/Y still arrive from plain mousemove either way).
//   • LEFT mouse (hold) fires the SELECTED weapon (still gated by turret traverse for the
//     main battery in main3d). Weapon selection is on the NUMBER ROW: 1 = main battery,
//     2 = secondaries, 3 = AA -- so aiming/looking never accidentally fires anything.
//   • MOUSE WHEEL zooms the camera in/out; scrolled all the way in it engages the sniper
//     scope (main3d.js decides the threshold -- this module only reports the raw zoom axis).
//   • WASD/QE only steer the ship -- they never move the camera.
export class Input3D {
   constructor(canvas) {
      this.canvas = canvas;
      this.gameActive = false;
      this.keys = new Set();
      this.pressed = new Set();
      // dx/dy: raw look deltas accumulated since the last endFrame() (movementX/Y sum, NOT
      // cursor position -- there is no meaningful "cursor position" once the look is
      // unbounded and the aim is always screen-centre, see main3d.js). down: left mouse
      // (fire). wheel: per-frame zoom accumulator.
      this.mouse = { dx: 0, dy: 0, down: false, wheel: 0 };
      this._locked = false;
      this._bind();
   }

   _bind() {
      const onKey = (e, down) => {
         const k = this._norm(e.key, e.code);
         if (down) { if (!this.keys.has(k)) this.pressed.add(k); this.keys.add(k); }
         else this.keys.delete(k);
         if (this.gameActive && [' ', 'w', 'a', 's', 'd', 'q', 'e', 'r', 't', 'f', 'm', 'p', 'x', 'escape', 'shift', '1', '2', '3'].includes((e.key || '').toLowerCase()))
            e.preventDefault();
      };
      window.addEventListener('keydown', (e) => onKey(e, true));
      window.addEventListener('keyup', (e) => onKey(e, false));
      window.addEventListener('blur', () => { this.keys.clear(); this.pressed.clear(); this.mouse.down = false; });

      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      const requestLockSafe = () => {
         if (!this.gameActive || document.pointerLockElement === this.canvas) return;
         try {
            const ret = this.canvas.requestPointerLock({ unadjustedMovement: true });
            if (ret && typeof ret.catch === 'function') ret.catch(() => {}); // rejected without a user gesture -- fine, deltas still flow
         } catch (e) { /* older browsers throw synchronously instead of rejecting -- same story */ }
      };
      document.addEventListener('pointerlockchange', () => { this._locked = document.pointerLockElement === this.canvas; });
      document.addEventListener('pointerlockerror', () => {});

      this.canvas.addEventListener('mousedown', (e) => {
         if (e.button === 0) { this.mouse.down = true; requestLockSafe(); }
      });
      window.addEventListener('mousemove', (e) => {
         this.mouse.dx += e.movementX || 0;
         this.mouse.dy += e.movementY || 0;
      });
      window.addEventListener('mouseup', (e) => {
         if (e.button === 0) this.mouse.down = false;
      });
      // Wheel zoom: sign of deltaY, consumed each frame by main3d.js.
      this.canvas.addEventListener('wheel', (e) => {
         e.preventDefault();
         this.mouse.wheel += Math.sign(e.deltaY);
      }, { passive: false });

      // Touch: single finger fires (no look-around on touch -- there's no analogue for
      // relative mouse deltas without a drag gesture, and drag is reserved for nothing here
      // since look no longer needs a held button. Touch users get tap-to-fire only.)
      this.canvas.addEventListener('touchstart', () => { this.mouse.down = true; }, { passive: true });
      this.canvas.addEventListener('touchend', () => { this.mouse.down = false; });
   }

   _norm(key, code) {
      if (code) {
         if (code === 'KeyW') return 'W';
         if (code === 'KeyA') return 'A';
         if (code === 'KeyD') return 'D';
         if (code === 'KeyS') return 'S';
         if (code === 'KeyQ') return 'Q';
         if (code === 'KeyE') return 'E';
         if (code === 'KeyF') return 'F';
         if (code === 'KeyT') return 'T';
         if (code === 'KeyR') return 'R';
         if (code === 'KeyM') return 'M';
         if (code === 'KeyX') return 'X';
         if (code === 'Digit1') return '1';
         if (code === 'Digit2') return '2';
         if (code === 'Digit3') return '3';
         if (code === 'KeyP' || code === 'Escape') return 'P';
         if (code === 'ShiftLeft' || code === 'ShiftRight') return 'SHIFT';
         if (code === 'Space') return 'SPACE';
         if (code === 'ArrowUp') return 'W';
         if (code === 'ArrowDown') return 'S';
         if (code === 'ArrowLeft') return 'A';
         if (code === 'ArrowRight') return 'D';
      }
      return key.toUpperCase();
   }

   // Clear ONLY the edge-triggered tap set. main3d.js calls this after EACH fixed sim step so
   // a key pressed once fires exactly once per step instead of re-firing on every step of a
   // multi-step frame (the old bug: P double-toggled, SPACE logged "Anker fällt!" twice).
   // endFrame() still clears dx/dy/wheel once per animation frame as before.
   consumeTaps() { this.pressed.clear(); }

   endFrame() { this.pressed.clear(); this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0; }

   down(k) { return this.keys.has(k); }
   tapped(k) { return this.pressed.has(k); }
   helmAxis() { let h = 0; if (this.down('A') || this.down('Q')) h -= 1; if (this.down('D') || this.down('E')) h += 1; return h; }
   throttleAxis() { let t = 0; if (this.down('W')) t += 1; if (this.down('S')) t -= 1; return t; }
}
