// game/input3d.js — keyboard identical to the 2D game (game/input.js), but the mouse now
// works like World of Warships instead of a drag-to-orbit scheme:
//
//   • The CURSOR POSITION is the aim. We track the raw pointer in NDC (-1..1) every move
//     (regardless of any button) and main3d.js raycasts it onto the sea plane -- exactly
//     how WoWs points your guns at whatever the crosshair is over. The on-screen reticle
//     follows the cursor, there is no fixed screen-center crosshair.
//   • LEFT mouse (hold) fires the SELECTED weapon (still gated by turret traverse for the
//     main battery in main3d). Weapon selection is on the NUMBER ROW: 1 = main battery,
//     2 = secondaries, 3 = AA -- so aiming/looking never accidentally fires anything.
//   • RIGHT mouse (hold + drag) is PURE FREE-LOOK: it orbits the camera around the ship.
//     The offset is PERSISTENT -- it stays where you left it (no spring-back), so you can
//     pick your own perspective. It does NOT fire anything.
//   • MOUSE WHEEL zooms the camera in/out.
//   • WASD/QE only steer the ship -- they never move the camera.
export class Input3D {
   constructor(canvas) {
      this.canvas = canvas;
      this.gameActive = false;
      this.keys = new Set();
      this.pressed = new Set();
      // x/y are the live cursor in NDC space (the aim point); mx/my are the same point in
      // raw pixels (so main3d.js can park the on-screen reticle under the cursor);
      // down/right are button states; dx/dy are free-look deltas (only meaningful while
      // `right` is held); wheel is a per-frame zoom accumulator consumed by main3d.js.
      this.mouse = { x: 0, y: 0, mx: 0, my: 0, down: false, right: false, dx: 0, dy: 0, wheel: 0 };
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
      window.addEventListener('blur', () => { this.keys.clear(); this.pressed.clear(); this.mouse.down = false; this.mouse.right = false; });

      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      // Cursor position -> NDC, updated on EVERY move (this is the aim signal).
      const setNdc = (clientX, clientY) => {
         const w = window.innerWidth || 1, h = window.innerHeight || 1;
         this.mouse.x = (clientX / w) * 2 - 1;
         this.mouse.y = -((clientY / h) * 2 - 1);
         this.mouse.mx = clientX; this.mouse.my = clientY;
      };

      // Right-mouse free-look: only accumulate orbit deltas while the button is held.
      let lastX = 0, lastY = 0;
      this.canvas.addEventListener('mousedown', (e) => {
         if (e.button === 0) this.mouse.down = true;
         if (e.button === 2) { this.mouse.right = true; lastX = e.clientX; lastY = e.clientY; }
      });
      window.addEventListener('mousemove', (e) => {
         setNdc(e.clientX, e.clientY);
         if (this.mouse.right) {
            this.mouse.dx += e.clientX - lastX;
            this.mouse.dy += e.clientY - lastY;
            lastX = e.clientX; lastY = e.clientY;
         }
      });
      window.addEventListener('mouseup', (e) => {
         if (e.button === 0) this.mouse.down = false;
         if (e.button === 2) this.mouse.right = false;
      });
      // Wheel zoom: sign of deltaY, consumed each frame by main3d.js.
      this.canvas.addEventListener('wheel', (e) => {
         e.preventDefault();
         this.mouse.wheel += Math.sign(e.deltaY);
      }, { passive: false });

      // Touch: single finger aims + fires (sets cursor NDC + left-down). No free-look.
      this.canvas.addEventListener('touchstart', (e) => {
         const t = e.touches[0];
         setNdc(t.clientX, t.clientY);
         this.mouse.down = true;
      }, { passive: true });
      this.canvas.addEventListener('touchmove', (e) => {
         const t = e.touches[0];
         setNdc(t.clientX, t.clientY);
      }, { passive: true });
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
