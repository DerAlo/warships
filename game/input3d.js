// game/input3d.js — keyboard identical to the 2D game (game/input.js), but mouse now
// orbits a third-person camera instead of picking a flat screen->world point directly.
// The aim RAY comes from screen center (crosshair-style, like a turret sight) through
// Renderer3D.screenToWorld(), not from the cursor position.
export class Input3D {
   constructor(canvas) {
      this.canvas = canvas;
      this.gameActive = false;
      this.keys = new Set();
      this.pressed = new Set();
      this.mouse = { down: false, right: false, rightPressed: false, dx: 0, dy: 0 };
      this._pointerLocked = false;
      this._bind();
   }

   _bind() {
      const onKey = (e, down) => {
         const k = this._norm(e.key, e.code);
         if (down) { if (!this.keys.has(k)) this.pressed.add(k); this.keys.add(k); }
         else this.keys.delete(k);
         if (this.gameActive && [' ', 'w', 'a', 's', 'd', 'q', 'e', 'r', 't', 'f', 'm', 'p', 'escape', 'shift'].includes((e.key || '').toLowerCase()))
            e.preventDefault();
      };
      window.addEventListener('keydown', (e) => onKey(e, true));
      window.addEventListener('keyup', (e) => onKey(e, false));
      window.addEventListener('blur', () => { this.keys.clear(); this.mouse.down = false; this.mouse.right = false; });

      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      // Drag-to-orbit: no pointer lock (keeps it simple + works without a user gesture
      // quirk on some browsers) -- hold left/right mouse and drag to orbit the camera.
      let dragging = false, lastX = 0, lastY = 0;
      this.canvas.addEventListener('mousedown', (e) => {
         if (e.button === 0) this.mouse.down = true;
         if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
         dragging = true; lastX = e.clientX; lastY = e.clientY;
      });
      window.addEventListener('mousemove', (e) => {
         if (!dragging) return;
         this.mouse.dx += e.clientX - lastX;
         this.mouse.dy += e.clientY - lastY;
         lastX = e.clientX; lastY = e.clientY;
      });
      window.addEventListener('mouseup', (e) => {
         if (e.button === 0) this.mouse.down = false;
         if (e.button === 2) this.mouse.right = false;
         dragging = false;
      });
      this.canvas.addEventListener('touchstart', (e) => {
         const t = e.touches[0];
         lastX = t.clientX; lastY = t.clientY;
         this.mouse.down = true; dragging = true;
      }, { passive: true });
      this.canvas.addEventListener('touchmove', (e) => {
         const t = e.touches[0];
         this.mouse.dx += t.clientX - lastX; this.mouse.dy += t.clientY - lastY;
         lastX = t.clientX; lastY = t.clientY;
      }, { passive: true });
      this.canvas.addEventListener('touchend', () => { this.mouse.down = false; dragging = false; });
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

   endFrame() { this.pressed.clear(); this.mouse.rightPressed = false; this.mouse.dx = 0; this.mouse.dy = 0; }

   down(k) { return this.keys.has(k); }
   tapped(k) { return this.pressed.has(k); }
   helmAxis() { let h = 0; if (this.down('A') || this.down('Q')) h -= 1; if (this.down('D') || this.down('E')) h += 1; return h; }
   throttleAxis() { let t = 0; if (this.down('W')) t += 1; if (this.down('S')) t -= 1; return t; }
}
